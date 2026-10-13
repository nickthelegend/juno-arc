import { isHash, type Hash } from "viem";

import { CallerError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { readTxCost } from "@/lib/juno/tx-cost-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /tx/cost?hash=0x…` — what a confirmed transaction cost on Arc (in USDC,
 * the gas token), and what the same gas would cost on Ethereum mainnet now.
 *
 * `ethereum` is null when Ethereum's gas price could not be read, and its
 * dollar figure is null when Chainlink's ETH/USD (Arc mainnet) could not be.
 * On a local fork the Arc figures are the fork's.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const hash = new URL(request.url).searchParams.get("hash") ?? "";
    if (!isHash(hash)) throw new CallerError("hash is not a transaction hash");
    const cost = await readTxCost(hash as Hash);
    if (!cost) throw new CallerError("No confirmed transaction with that hash", 404);
    return junoJson(cost);
  });
}
