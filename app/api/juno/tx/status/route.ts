import { TransactionReceiptNotFoundError, isHash, type Hex } from "viem";

import { CallerError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { publicClient } from "@/lib/juno/client";
import { explorer, localFork } from "@/lib/juno/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /tx/status?hash=0x…` — where a transaction is.
 *
 * Arc has deterministic sub-second finality, so there are only three answers:
 * `confirmed` (a receipt exists, and on Arc a receipt is final), `reverted`,
 * or `pending` (the node knows the transaction but it is not in a block) —
 * and `unknown` when the node has never seen it.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const hash = new URL(request.url).searchParams.get("hash");
    if (!hash || !isHash(hash)) throw new CallerError("hash is not a transaction hash");
    const client = publicClient();
    const where = localFork() ? "local fork" : "arc";
    try {
      const receipt = await client.getTransactionReceipt({ hash: hash as Hex });
      return junoJson({
        hash,
        where,
        status: receipt.status === "success" ? "confirmed" : "reverted",
        final: true,
        blockNumber: Number(receipt.blockNumber),
        explorerUrl: explorer.tx(hash),
      });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    const tx = await client.getTransaction({ hash: hash as Hex }).catch(() => null);
    return junoJson({ hash, where, status: tx ? "pending" : "unknown", final: false, blockNumber: null, explorerUrl: explorer.tx(hash) });
  });
}
