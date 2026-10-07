import "server-only";

import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  pad,
  parseAbi,
  recoverTypedDataAddress,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";

import { CallerError } from "./api";
import { gatewayApiUrl, gatewaySources, type GatewaySource } from "./arc";
import { publicClient } from "./client";
import { uiToWei, weiToUi, type ContractCall } from "./launchpad";
import { ARC_CCTP_DOMAIN, deployment, explorer, network, usdcAddress } from "./network";
import { relay, relayerAccount } from "./relayer";
import { withRetry } from "./rpc";
import { prepare, type UnsignedTransaction } from "./tx";

/**
 * Circle Gateway: one USDC balance across chains, spent on Arc instantly.
 *
 * Someone deposits USDC once into Circle's GatewayWallet on any chain Gateway
 * runs on (Base, Ethereum, Arbitrum… or Arc itself). To buy on Juno they sign
 * one EIP-712 burn intent — no gas, no chain switch — "burn `value` of my
 * Gateway balance on domain N and mint it on Arc to me". This server sends the
 * signed intent to Circle's Gateway API, which answers with an attestation, and
 * Juno's relayer calls `GatewayMinter.gatewayMint(attestation, signature)` on
 * Arc, paying the USDC gas. The USDC lands in their wallet on Arc, ready for a
 * buy (or a gasless buy).
 *
 * The relayer can't redirect a cent: the recipient is in the intent the
 * depositor signed, Circle's operator signs the attestation, and gatewayMint
 * mints only to the recipient it names.
 */

export type GatewayNetwork = {
  apiUrl: string;
  wallet: Address;
  minter: Address;
  arcDomain: number;
  arcUsdc: Address;
  sources: GatewaySource[];
};

export function gatewayNetwork(): GatewayNetwork | null {
  const d = deployment();
  if (!d.gatewayWallet || !d.gatewayMinter) return null;
  return {
    apiUrl: gatewayApiUrl(network()),
    wallet: d.gatewayWallet,
    minter: d.gatewayMinter,
    arcDomain: ARC_CCTP_DOMAIN,
    arcUsdc: usdcAddress(),
    sources: gatewaySources(network()),
  };
}

function requireGateway(): GatewayNetwork {
  const g = gatewayNetwork();
  if (!g) throw new CallerError("Circle Gateway isn't available on this network", 503);
  return g;
}

/** Circle's gas fee per source domain, USDC base units (developers.circle.com/gateway/references/fees). */
const BASE_FEE: Record<number, bigint> = { 0: 1_000_000n, 6: 10_000n, 26: 3_500n, 3: 10_000n, 2: 10_000n, 1: 20_000n, 7: 10_000n };

/**
 * The most the depositor lets Gateway take for a transfer of `value` from
 * `domain`: the source's gas fee with a quarter of headroom, plus the 0.005%
 * transfer fee rounded up, plus a cent. Circle charges the actual fee. Pure.
 */
export function maxFeeFor(domain: number, value: bigint): bigint {
  const base = BASE_FEE[domain] ?? 1_000_000n;
  return (base * 5n) / 4n + (value * 5n + 99_999n) / 100_000n + 10_000n;
}

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export const BURN_INTENT_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

const MAX_UINT256 = (1n << 256n) - 1n;
/** Per transfer. Juno buys are small; this caps what one signature can move. */
const MAX_VALUE = 10_000_000_000n;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const b32 = (a: Address) => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;
const addr = (b: Hex) => getAddress(slice(b, 12));

export type BurnIntent = {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
};

/** The burn intent that moves `value` of `depositor`'s Gateway balance on `sourceDomain` to `recipient` on Arc. Pure. */
export function buildBurnIntent(
  g: GatewayNetwork,
  input: { sourceDomain: number; depositor: Address; recipient: Address; value: bigint; salt: Hex },
): BurnIntent {
  const source = g.sources.find((s) => s.domain === input.sourceDomain);
  if (!source) throw new CallerError(`sourceDomain must be one of ${g.sources.map((s) => `${s.domain} (${s.name})`).join(", ")}`);
  if (input.value <= 0n || input.value > MAX_VALUE) throw new CallerError("amount must be more than 0 and at most 10,000 USDC");
  return {
    maxBlockHeight: MAX_UINT256,
    maxFee: maxFeeFor(input.sourceDomain, input.value),
    spec: {
      version: 1,
      sourceDomain: input.sourceDomain,
      destinationDomain: g.arcDomain,
      // GatewayWallet and GatewayMinter have the same address on every chain of a network.
      sourceContract: b32(g.wallet),
      destinationContract: b32(g.minter),
      sourceToken: b32(source.usdc),
      destinationToken: b32(g.arcUsdc),
      sourceDepositor: b32(input.depositor),
      destinationRecipient: b32(input.recipient),
      sourceSigner: b32(input.depositor),
      destinationCaller: ZERO32,
      value: input.value,
      salt: input.salt,
      hookData: "0x",
    },
  };
}

/** The intent as JSON (uint256 as decimal strings), the shape the Gateway API and the app's signer take. */
export function intentToJson(i: BurnIntent) {
  return { maxBlockHeight: i.maxBlockHeight.toString(), maxFee: i.maxFee.toString(), spec: { ...i.spec, value: i.spec.value.toString() } };
}

/** Read an intent back from JSON, checking every field Juno relies on. Pure. */
export function intentFromJson(g: GatewayNetwork, raw: unknown): BurnIntent {
  const bad = (what: string): never => {
    throw new CallerError(`burnIntent: ${what}`);
  };
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (o.spec ?? {}) as Record<string, unknown>;
  const big = (v: unknown, name: string) => {
    if (typeof v !== "string" && typeof v !== "number") return bad(`${name} must be a decimal string`);
    try {
      return BigInt(v);
    } catch {
      return bad(`${name} must be a decimal string`);
    }
  };
  const h32 = (v: unknown, name: string) =>
    typeof v === "string" && isHex(v) && v.length === 66 ? (v.toLowerCase() as Hex) : bad(`${name} must be bytes32`);
  const intent: BurnIntent = {
    maxBlockHeight: big(o.maxBlockHeight, "maxBlockHeight"),
    maxFee: big(o.maxFee, "maxFee"),
    spec: {
      version: Number(s.version),
      sourceDomain: Number(s.sourceDomain),
      destinationDomain: Number(s.destinationDomain),
      sourceContract: h32(s.sourceContract, "sourceContract"),
      destinationContract: h32(s.destinationContract, "destinationContract"),
      sourceToken: h32(s.sourceToken, "sourceToken"),
      destinationToken: h32(s.destinationToken, "destinationToken"),
      sourceDepositor: h32(s.sourceDepositor, "sourceDepositor"),
      destinationRecipient: h32(s.destinationRecipient, "destinationRecipient"),
      sourceSigner: h32(s.sourceSigner, "sourceSigner"),
      destinationCaller: h32(s.destinationCaller, "destinationCaller"),
      value: big(s.value, "value"),
      salt: h32(s.salt, "salt"),
      hookData: typeof s.hookData === "string" && isHex(s.hookData) ? (s.hookData as Hex) : "0x",
    },
  };
  // Only what Juno would have built: to Arc, through Circle's minter, as Arc's USDC, minted to the named recipient.
  const expected = buildBurnIntent(g, {
    sourceDomain: intent.spec.sourceDomain,
    depositor: addr(intent.spec.sourceDepositor),
    recipient: addr(intent.spec.destinationRecipient),
    value: intent.spec.value,
    salt: intent.spec.salt,
  });
  for (const k of [
    "version",
    "destinationDomain",
    "sourceContract",
    "destinationContract",
    "sourceToken",
    "destinationToken",
    "sourceSigner",
    "destinationCaller",
    "hookData",
  ] as const) {
    if (String(intent.spec[k]).toLowerCase() !== String(expected.spec[k]).toLowerCase()) {
      bad(`${k} isn't Juno's (Arc, Circle's GatewayMinter, USDC, signer = depositor, no destination caller)`);
    }
  }
  if (intent.maxFee > expected.maxFee) bad(`maxFee is above ${weiToUi(expected.maxFee, 6)} USDC`);
  return intent;
}

let fetchImpl: typeof fetch | null = null;
/** Tests: replace the network the Gateway API is called over. */
export function configureGatewayForTests(impl: typeof fetch | null): void {
  fetchImpl = impl;
  minted.clear();
}

async function api(g: GatewayNetwork, path: string, body: unknown): Promise<unknown> {
  const res = await (fetchImpl ?? fetch)(`${g.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const message = typeof json?.message === "string" ? json.message : `Circle Gateway answered ${res.status}`;
    throw new CallerError(message, res.status >= 500 ? 502 : 400);
  }
  return json;
}

export type GatewayBalances = {
  available: boolean;
  depositor: Address | null;
  total: number;
  totalUnits: string;
  balances: Array<{ domain: number; name: string; balance: number; balanceUnits: string }>;
  wallet: Address | null;
  minter: Address | null;
  sources: GatewaySource[];
};

/** A depositor's unified balance, per source chain (Circle's `/v1/balances`). */
export async function gatewayBalances(depositorRaw: string | null): Promise<GatewayBalances> {
  const g = gatewayNetwork();
  const none: GatewayBalances = { available: false, depositor: null, total: 0, totalUnits: "0", balances: [], wallet: null, minter: null, sources: [] };
  if (!g) return none;
  const base = { ...none, available: true, wallet: g.wallet, minter: g.minter, sources: g.sources };
  if (!depositorRaw) return base;
  if (!isAddress(depositorRaw)) throw new CallerError("depositor must be an address");
  const depositor = getAddress(depositorRaw);
  const json = (await api(g, "/v1/balances", {
    token: "USDC",
    sources: g.sources.map((s) => ({ domain: s.domain, depositor })),
  })) as { balances?: Array<{ domain: number; balance: string }> };
  const balances = (json.balances ?? []).map((b) => {
    // The API answers in USDC with decimals ("12.5"); keep base units for the app.
    const units = uiToWei(Number(b.balance), 6);
    return {
      domain: b.domain,
      name: g.sources.find((s) => s.domain === b.domain)?.name ?? `domain ${b.domain}`,
      balanceUnits: units.toString(),
      balance: weiToUi(units, 6),
    };
  });
  const total = balances.reduce((t, b) => t + BigInt(b.balanceUnits), 0n);
  return { ...base, depositor, totalUnits: total.toString(), total: weiToUi(total, 6), balances };
}

/** The typed data a depositor signs to move `amount` USDC of their Gateway balance to `recipient` on Arc. */
export function gatewayIntent(input: { depositor: Address; recipient: Address; sourceDomain: number; amount: number; salt?: Hex }) {
  const g = requireGateway();
  const value = uiToWei(input.amount, 6);
  const salt = input.salt ?? keccak256(toHex(`${input.depositor}:${input.recipient}:${value}:${Date.now()}:${Math.random()}`));
  const intent = buildBurnIntent(g, { sourceDomain: input.sourceDomain, depositor: input.depositor, recipient: input.recipient, value, salt });
  return {
    typedData: { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent" as const, message: intentToJson(intent) },
    maxFee: weiToUi(intent.maxFee, 6),
    maxFeeUnits: intent.maxFee.toString(),
  };
}

export type GatewayMint = {
  status: "minted";
  recipient: Address;
  amount: number;
  amountUnits: string;
  transferId: string | null;
  mintTxHash: Hex;
  explorerUrl: string;
  confirmMs: number;
};

/** Transfers this process has minted: salt → result. The chain is the record; this only makes a retry idempotent. */
const minted = new Map<string, GatewayMint>();

export const gatewayMinterAbi = parseAbi(["function gatewayMint(bytes attestation, bytes signature)"]);
export const gatewayWalletAbi = parseAbi([
  "function deposit(address token, uint256 value)",
  "function availableBalance(address token, address depositor) view returns (uint256)",
]);

/** Circle attests the signed intent; the relayer mints on Arc. */
export async function gatewayMint(body: { burnIntent: unknown; signature: unknown }): Promise<GatewayMint> {
  const g = requireGateway();
  if (!relayerAccount()) throw new CallerError("Juno's relayer is not configured on this server", 503);
  const intent = intentFromJson(g, body.burnIntent);
  const signature = typeof body.signature === "string" && isHex(body.signature) ? (body.signature as Hex) : null;
  if (!signature) throw new CallerError("signature must be the depositor's signature of the burn intent");
  const seen = minted.get(intent.spec.salt);
  if (seen) return seen;
  // Check the signature here first: a bad one never reaches Circle or costs the relayer anything.
  const signer = await recoverTypedDataAddress({
    domain: BURN_INTENT_DOMAIN,
    types: BURN_INTENT_TYPES,
    primaryType: "BurnIntent",
    message: intent,
    signature,
  }).catch(() => null);
  if (!signer || b32(signer) !== intent.spec.sourceSigner) throw new CallerError("The burn intent isn't signed by its depositor");

  const res = (await api(g, "/v1/transfer", [{ burnIntent: intentToJson(intent), signature }])) as {
    transferId?: string;
    attestation?: Hex;
    signature?: Hex;
  };
  if (!res.attestation || !res.signature) throw new CallerError("Circle Gateway returned no attestation", 502);
  const sent = await relay({
    to: g.minter,
    data: encodeFunctionData({ abi: gatewayMinterAbi, functionName: "gatewayMint", args: [res.attestation, res.signature] }),
  });
  if (sent.receipt.status !== "success") throw new CallerError(`The Gateway mint reverted. It is on-chain as ${sent.hash}.`, 502);
  const out: GatewayMint = {
    status: "minted",
    recipient: addr(intent.spec.destinationRecipient),
    amountUnits: intent.spec.value.toString(),
    amount: weiToUi(intent.spec.value, 6),
    transferId: res.transferId ?? null,
    mintTxHash: sent.hash,
    explorerUrl: explorer.tx(sent.hash),
    confirmMs: sent.confirmMs,
  };
  minted.set(intent.spec.salt, out);
  return out;
}

/** Deposit from Arc: approve the GatewayWallet, then `deposit(USDC, value)`. */
export async function buildGatewayDeposit(request: { owner: Address; amount: number }): Promise<UnsignedTransaction[]> {
  const g = requireGateway();
  if (!(request.amount > 0)) throw new CallerError("Amount must be greater than zero");
  const value = uiToWei(request.amount, 6);
  const usdc = usdcAddress();
  const client = publicClient();
  const [balance, allowance] = await Promise.all([
    withRetry(() => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [request.owner] })),
    withRetry(() => client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [request.owner, g.wallet] })),
  ]);
  if (balance < value) throw new CallerError(`This wallet holds ${weiToUi(balance, 6)} USDC on Arc`, 409);
  const calls: ContractCall[] = [];
  if (allowance < value) {
    calls.push({
      to: usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [g.wallet, value] }),
      value: 0n,
      label: "Allowing Circle Gateway to take the USDC",
    });
  }
  calls.push({
    to: g.wallet,
    data: encodeFunctionData({ abi: gatewayWalletAbi, functionName: "deposit", args: [usdc, value] }),
    value: 0n,
    label: "Depositing into your Circle Gateway balance",
  });
  return prepare(request.owner, calls);
}
