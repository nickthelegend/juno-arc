import "server-only";

import { createWalletClient, http, isHex, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { publicClient } from "./client";
import { chain, rpcEndpoint } from "./network";
import { gatedFetch } from "./rpc";

/**
 * Juno's relayer: the one key the server holds (`JUNO_RELAYER_PRIVATE_KEY`).
 *
 * It pays the USDC gas — on Arc, gas *is* USDC — for three things a user should
 * not need a funded wallet for:
 *  - gasless buys: it submits `buyWithAuthorization` with the buyer's EIP-3009
 *    signature; the buyer's USDC pays for the coin, the relayer for the gas,
 *    and the coin can only go to the buyer;
 *  - Circle Gateway mints: `GatewayMinter.gatewayMint(attestation, signature)`,
 *    which mints only to the recipient the depositor signed for;
 *  - the testnet faucet.
 * It can't move anyone's money anywhere they didn't sign for.
 */

let cached: PrivateKeyAccount | null | undefined;

export function relayerAccount(): PrivateKeyAccount | null {
  if (cached !== undefined) return cached;
  const raw = process.env.JUNO_RELAYER_PRIVATE_KEY?.trim();
  const key = raw && !raw.startsWith("0x") ? `0x${raw}` : raw;
  cached = key && isHex(key) && key.length === 66 ? privateKeyToAccount(key as Hex) : null;
  return cached;
}

export function relayerAddress(): Address | null {
  return relayerAccount()?.address ?? null;
}

/** One send at a time: two requests reading the same pending nonce would collide. */
let queue: Promise<unknown> = Promise.resolve();
export function serialRelay<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export type RelayResult = { hash: Hex; receipt: TransactionReceipt; confirmMs: number };

const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Send a call from the relayer and wait for its receipt — which on Arc is
 * final (deterministic sub-second finality). `confirmMs` is broadcast to
 * receipt, measured here.
 */
export async function relay(call: { to: Address; data: Hex; value?: bigint; gas?: bigint }): Promise<RelayResult> {
  const account = relayerAccount();
  if (!account) throw new Error("JUNO_RELAYER_PRIVATE_KEY is not set");
  return serialRelay(async () => {
    const wallet = createWalletClient({
      account,
      chain: chain(),
      transport: http(rpcEndpoint(), { fetchFn: gatedFetch, retryCount: 0, timeout: 20_000 }),
    });
    // Margin over the estimate: a call that goes through a precompile (Memo's
    // CallFrom) or a nested call loses 1/64 of its gas at each hop, and a bare
    // estimate ran a relayed buy out of gas on the fork. Unused gas is not charged.
    const gas =
      call.gas ??
      ((await publicClient().estimateGas({ account: account.address, to: call.to, data: call.data, value: call.value ?? 0n })) * 13n) / 10n +
        30_000n;
    const started = performance.now();
    const hash = await wallet.sendTransaction({
      account,
      chain: chain(),
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
      gas,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 100 });
    return { hash, receipt, confirmMs: Math.round(performance.now() - started) };
  });
}
