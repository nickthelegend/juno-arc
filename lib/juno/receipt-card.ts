import "server-only";

import type { Hash } from "viem";

import { recallContent } from "./ipfs-cache";
import { mediaCid } from "./media";
import { isMainnet } from "./network";
import { getPool } from "./registry";
import { timingOf } from "./speed-log";
import { swapsOfTransaction } from "./swap-store";
import { readTxCost } from "./tx-cost-read";
import type { ReceiptCardTrade } from "./receipt-card-text";

export { compactAmount, smallAmount, tradeLine, usd, VENUE_LABEL } from "./receipt-card-text";
export type { ReceiptCardTrade } from "./receipt-card-text";

/**
 * Everything a shareable receipt card says, each figure read or measured:
 * - `finalMs`: submit to receipt, as Juno's server measured it when it
 *   submitted the transaction. On Arc a receipt is final, so this is the
 *   finality. Null for a transaction this server process did not time (it
 *   keeps the last few hundred), and the card leaves it out;
 * - the trade, from the trade table the receipt path writes;
 * - the gas from the receipt, in USDC, and the same gas on Ethereum now.
 * A figure that could not be read is null and the card leaves it out.
 */
export type ReceiptCard = {
  hash: string;
  blockNumber: number;
  localFork: boolean;
  network: "arc" | "arc-testnet";
  finalMs: number | null;
  trade: ReceiptCardTrade | null;
  /** A data URI of the coin's picture when this server holds it; never fetched for the card. */
  image: string | null;
  fee: { usdc: number };
  ethereum: { usd: number | null; eth: number } | null;
};

export async function loadReceiptCard(hash: Hash): Promise<ReceiptCard | null> {
  const [cost, swaps] = await Promise.all([readTxCost(hash), swapsOfTransaction(hash).catch(() => [])]);
  if (!cost) return null;
  const swap = swaps[0] ?? null;
  const pool = swap ? await getPool(swap.token).catch(() => null) : null;

  let image: string | null = null;
  const cid = mediaCid(pool?.posterUrl) ?? (pool?.mediaMime?.startsWith("video") ? null : mediaCid(pool?.mediaUrl));
  const held = cid ? recallContent(cid) : null;
  if (held && /^image\/(png|jpe?g)$/i.test(held.type)) {
    image = `data:${held.type};base64,${Buffer.from(held.bytes).toString("base64")}`;
  }

  return {
    hash,
    blockNumber: cost.blockNumber,
    localFork: cost.localFork,
    network: isMainnet() ? "arc" : "arc-testnet",
    finalMs: timingOf(hash),
    trade:
      swap && pool
        ? {
            side: swap.side,
            baseAmount: swap.baseAmount,
            quoteAmount: swap.quoteAmount,
            quoteSymbol: "USDC",
            venue: swap.venue ?? "curve",
            symbol: pool.symbol,
            name: pool.name,
          }
        : null,
    image,
    fee: { usdc: cost.arc.feeUsdc },
    ethereum: cost.ethereum ? { usd: cost.ethereum.feeUsd, eth: cost.ethereum.feeEth } : null,
  };
}
