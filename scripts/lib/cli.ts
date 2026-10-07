/**
 * Shared plumbing for the juno:* CLI scripts.
 *
 * ## Why no script imports a `server-only` module
 *
 * `server-only` resolves to a module that throws on import unless the
 * `react-server` export condition is set, which only Next's bundler does. tsx
 * is not a bundler, so the scripts — and this file — only reach `lib/juno`
 * modules that do not carry it: `network`, `client`, `rpc`, `abi`, `curves`,
 * `curve-math`, `economics`, `launchpad`, `mark`, `v2`, `memo`, `usd`, `arc`,
 * `ccip-events`, `ccip-pool-code`, `pinata`, `format`. That set is exactly what
 * building, quoting and sending a launchpad or CCIP call needs. What is
 * `server-only` (the registry, posts, the trade store, `ccip.ts`) is reached
 * over HTTP through the running app, which is also the path the phone takes;
 * the few pure CCIP helpers the scripts need are in `./ccip.ts`.
 *
 * ## Money on Arc
 *
 * Arc's gas token is USDC. `eth_getBalance` reports it with 18 decimals; the
 * ERC-20 at 0x3600…0000 is the *same balance* seen with 6. The scripts show
 * the native balance as USDC and never add the two views together.
 *
 * ## Signing
 *
 * A local key (see `./key.ts`) signs with a viem wallet client. Calls are built
 * by the same `lib/juno/launchpad.ts` functions the API uses, so a script run is
 * a faithful rehearsal of what the app sends.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { junoCrossChainAbi, junoLaunchpadAbi, junoSwapRouterAbi, junoTokenAbi } from "../../lib/juno/abi";
import type { ContractCall } from "../../lib/juno/launchpad";
import { memoAddress, memoLive, postMemoId, wrapInMemo } from "../../lib/juno/memo";
import { chain, explorer, isMainnet, launchpadAddress, localFork, network, rpcEndpoint } from "../../lib/juno/network";
import { KEY_PATH, readScriptKey } from "./key";

/** Circle's faucet: testnet USDC on Arc (which is also the gas). */
export const FAUCET_URL = "https://faucet.circle.com";

/** Native balances are 18-decimal USDC; the ERC-20 view is 6. 10^12 converts one to the other. */
export const NATIVE_PER_USDC_UNIT = 10n ** 12n;

/**
 * Where the Juno API answers: `JUNO_API_URL`, else the API's dev port.
 *
 * Not `NEXT_PUBLIC_SITE_URL`. That is the web app's origin, and on a local
 * stack the web app (Expo, :3000) and the API (Next, :3100) are two servers —
 * Expo answers any path, `/api/juno/pools` included, with its page and a 200,
 * so a script that posted there reported a coin recorded that was not.
 */
export function apiBase(): string {
  return (process.env.JUNO_API_URL?.trim() || "http://localhost:3100").replace(/\/$/, "");
}

/** The web app's origin, for the coin links a script prints. */
export function appBase(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Explorer links for what a script prints. On a local fork everything a
 * script sends or deploys exists only on the fork, so an explorer link would
 * open on nothing: print the bare hash or address and say where it lives.
 */
const onFork = (value: string) => `${value} (local fork, not on the Arc explorer)`;
export const links = {
  tx: (hash: string) => (localFork() ? onFork(hash) : explorer.tx(hash)),
  address: (address: string) => (localFork() ? onFork(address) : explorer.address(address)),
  token: (address: string) => (localFork() ? onFork(address) : explorer.token(address)),
};

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** A numeric flag, refused with a sentence rather than becoming NaN downstream. */
export function numberArg(name: string, fallback?: number): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(16)}${String(value)}`);
}

export function amount(value: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(value, decimals)} ${symbol}`;
}

export function header(account?: Address): void {
  line("network", `Arc ${network()} (chain ${chain().id})${localFork() ? ", local fork" : ""}`);
  line("rpc", rpcEndpoint());
  if (account) line("wallet", account);
}

/* ------------------------------------------------------------------ */
/* Clients                                                             */
/* ------------------------------------------------------------------ */

/**
 * A reader of its own for sending and waiting.
 *
 * The app's shared client turns transport retries off and retries per call
 * instead. A script waiting on a receipt has no such wrapper around it, and a
 * single throttled poll should not abandon a transaction that is about to land.
 */
let reader: PublicClient | null = null;

export function scriptReader(): PublicClient {
  reader ??= createPublicClient({
    chain: chain(),
    transport: http(rpcEndpoint(), { retryCount: 4, retryDelay: 500, timeout: 20_000 }),
  }) as PublicClient;
  return reader;
}

/**
 * The script's signing account.
 *
 * `JUNO_SCRIPT_PRIVATE_KEY`, else `.juno/launcher.key`, else a fresh key
 * written there (mode 600) so repeated runs reuse one funded wallet. A fresh
 * key has no USDC, so its address is printed with the faucet to fund it from.
 * The private key itself is never printed.
 */
export function scriptAccount(): PrivateKeyAccount {
  const existing = readScriptKey();
  if (existing) return privateKeyToAccount(existing);

  const key = generatePrivateKey();
  mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, `${key}\n`, { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  const account = privateKeyToAccount(key);
  console.log(`Generated a new script key at ${KEY_PATH} (gitignored; keep it private).`);
  console.log(`Its address is ${account.address}.`);
  if (!isMainnet()) console.log(`Fund it with testnet USDC (Arc's gas) at ${FAUCET_URL} and re-run.\n`);
  return account;
}

/** A native (18-decimal) USDC amount, for printing. */
export function nativeUsdc(value: bigint): string {
  return amount(value, 18, "USDC");
}

/**
 * Stop with a funding hint when the wallet cannot pay for what comes next.
 *
 * One balance pays for both: `gas` is native (18-dec) USDC kept for gas, and
 * `spendUnits` is what the call itself moves through the 6-dec ERC-20 (a buy,
 * a first buy). They are the same money, so the check is one sum in native
 * units — never the native balance plus the ERC-20 balance.
 */
export async function requireBalance(account: Address, gas: bigint, what: string, spendUnits = 0n): Promise<bigint> {
  const balance = await scriptReader().getBalance({ address: account });
  line("balance", `${nativeUsdc(balance)} (gas and spending money are one balance on Arc)`);
  const needed = gas + spendUnits * NATIVE_PER_USDC_UNIT;
  if (balance < needed) {
    const hint = isMainnet() ? "Fund it and re-run." : `Get testnet USDC at ${FAUCET_URL} and re-run.`;
    throw new Error(
      `${account} has ${formatUnits(balance, 18)} USDC; ${what} needs about ${formatUnits(needed, 18)} USDC including gas. ${hint}`,
    );
  }
  return balance;
}

/**
 * Refuse Arc mainnet unless `--allow-mainnet` was passed. Scripts that move
 * money across chains are rehearsed on testnet and a local fork first.
 */
export function refuseMainnetWithoutFlag(what: string): void {
  if (isMainnet() && !flag("allow-mainnet")) {
    throw new Error(`${what} on Arc mainnet moves real money. Pass --allow-mainnet if you mean it.`);
  }
}

/** `--token 0x…`, or `--latest` for the launchpad's newest token. */
export async function resolveToken(): Promise<Address> {
  const raw = arg("token");
  if (raw) {
    if (!isAddress(raw)) throw new Error(`--token ${raw} is not an address`);
    return getAddress(raw);
  }
  if (flag("latest")) {
    const launchpad = launchpadAddress();
    if (!launchpad) throw new Error(`No launchpad is recorded for Arc ${network()} (JUNO_DEPLOYMENT_FILE or deployments/arc-${network()}.json).`);
    const count = await scriptReader().readContract({
      address: launchpad,
      abi: junoLaunchpadAbi,
      functionName: "tokenCount",
    });
    if (count === 0n) throw new Error("The launchpad has no tokens yet. Launch one with npm run juno:launch.");
    return scriptReader().readContract({
      address: launchpad,
      abi: junoLaunchpadAbi,
      functionName: "tokens",
      args: [count - 1n],
    });
  }
  throw new Error("Pass --token <address>, or --latest for the newest launch.");
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

/**
 * Headroom over a gas estimate. Arc charges the gas a transaction uses, not
 * its limit, so a margin costs nothing when it is not needed; 20% covers
 * state that moves between the estimate and the block.
 */
const GAS_MARGIN_BPS = 2_000n;

export async function estimate(account: Address, call: ContractCall): Promise<bigint> {
  const gas = await scriptReader().estimateGas({ account, to: call.to, data: call.data, value: call.value });
  // `extraGas` is gas the estimate cannot see, e.g. a v2 pair's first swap
  // after graduation (see V2_SWAP_HEADROOM); the API adds it the same way.
  return gas + (gas * GAS_MARGIN_BPS) / 10_000n + (call.extraGas ?? 0n);
}

/**
 * Sign and send one call, wait for its receipt, and fail loudly on a revert.
 *
 * The estimate runs first, so a call the chain would refuse is explained
 * before anything is signed.
 */
export async function send(account: PrivateKeyAccount, call: ContractCall): Promise<TransactionReceipt> {
  const client = scriptReader();
  let gas: bigint;
  try {
    gas = await estimate(account.address, call);
  } catch (error) {
    throw new Error(`${call.label}: ${describeError(error)}`);
  }
  const fees = await client.estimateFeesPerGas();

  const wallet = createWalletClient({
    account,
    chain: chain(),
    transport: http(rpcEndpoint(), { retryCount: 2, retryDelay: 500 }),
  });

  console.log(`\n${call.label}…`);
  const hash = await wallet
    .sendTransaction({
      account,
      chain: chain(),
      to: call.to,
      data: call.data,
      value: call.value,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    .catch((error: unknown) => {
      throw new Error(`${call.label}: ${describeError(error)}`);
    });
  line("sent", links.tx(hash));

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") {
    throw new Error(`${call.label} reverted in block ${receipt.blockNumber}: ${links.tx(hash)}`);
  }
  const paid = receipt.gasUsed * receipt.effectiveGasPrice;
  // A receipt on Arc is final: finality is deterministic and sub-second.
  line("confirmed", `block ${receipt.blockNumber} (final), gas ${receipt.gasUsed} of ${gas}, cost ${formatUnits(paid, 18)} USDC`);
  return receipt;
}

/** The launchpad's events in a receipt, decoded. */
export function launchpadEvents(receipt: TransactionReceipt, launchpad: Address) {
  return parseEventLogs({
    abi: junoLaunchpadAbi,
    logs: receipt.logs.filter((log) => getAddress(log.address) === launchpad),
  });
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

type DecodedError = { errorName: string; args?: readonly unknown[] };

/** Revert data or an already-decoded error buried somewhere in a viem error. */
function customError(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  // A holder rather than two `let`s: assignments inside the walk callback are
  // invisible to TypeScript's narrowing.
  const found: { raw?: Hex; decoded?: DecodedError } = {};
  error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    if (data && typeof data === "object" && "errorName" in data) {
      found.decoded = data as DecodedError;
      return true;
    }
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      found.raw = data as Hex;
      return true;
    }
    return false;
  });
  if (!found.decoded && found.raw) {
    for (const abi of [junoLaunchpadAbi, junoTokenAbi, junoCrossChainAbi, junoSwapRouterAbi] as const) {
      try {
        found.decoded = decodeErrorResult({ abi, data: found.raw }) as DecodedError;
        break;
      } catch {
        // Not this contract's error; try the next.
      }
    }
  }
  if (!found.decoded) return null;
  const { errorName, args } = found.decoded;
  return args?.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
}

/**
 * A failure as a script user needs it: the contract's own error name when
 * there is one, a funding hint when that is the problem, the node's words
 * otherwise.
 */
export function describeError(error: unknown): string {
  const named = customError(error);
  const text =
    error instanceof BaseError
      ? [error.shortMessage, error.details].filter(Boolean).join(" — ")
      : error instanceof Error
        ? error.message
        : String(error);
  if (named) return `the contract refused with ${named}`;
  if (/insufficient (funds|balance)|exceeds (the )?balance/i.test(text)) {
    return `not enough USDC for this and its gas (gas is paid in USDC on Arc).${isMainnet() ? "" : ` Get testnet USDC at ${FAUCET_URL}.`}`;
  }
  if (/returned no data/i.test(text)) {
    return `${text} Is there a contract at that address on Arc ${network()}? Check JUNO_DEPLOYMENT_FILE and --token.`;
  }
  return text;
}

/** Run a script's `main`, printing a one-line failure instead of a stack. */
export function run(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // viem's own messages run to a screenful; its short message is the sentence.
      const message = error instanceof BaseError || !(error instanceof Error) ? describeError(error) : error.message;
      console.error(`\nError: ${message}`);
      process.exit(1);
    });
}

/* ------------------------------------------------------------------ */
/* Arc Memo                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tag a curve trade with Arc's Memo, as the app does: the call goes through
 * `Memo.memo(target, data, keccak256("juno:post:" + token), line)`, which runs
 * it as this wallet (CallFrom) and records which post the money went to.
 *
 * Only when the node executes CallFrom (`memoLive`, probed once) — a local
 * fork's anvil does not, and the call then goes out plain and says so.
 * `--no-memo` skips it.
 */
export async function tagWithMemo(
  call: ContractCall,
  token: Address,
  text: string,
): Promise<{ call: ContractCall; tagged: boolean; reason: string }> {
  if (flag("no-memo")) return { call, tagged: false, reason: "--no-memo" };
  const memo = memoAddress();
  if (!memo) return { call, tagged: false, reason: "no Memo address recorded" };
  if (!(await memoLive())) {
    return { call, tagged: false, reason: "this node does not execute Arc's CallFrom precompile (a local fork); sent plain" };
  }
  const wrapped = wrapInMemo({ memo, target: call.to, data: call.data, memoId: postMemoId(token), line: text });
  return { call: { ...call, ...wrapped }, tagged: true, reason: `"${text}", memo id ${postMemoId(token)}` };
}
