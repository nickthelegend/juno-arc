import { isHash, type Hex } from "viem";

import { CallerError, junoHandler, junoJson, junoOptions } from "@/lib/juno/api";
import { cctpStatus } from "@/lib/juno/cctp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /cctp/status?hash=0x…` — a CCTP burn from Arc, as Circle's Iris sees it:
 * `{ status: "pending" | "complete" | "unknown", attestation?, message?,
 * destinationDomain, destination, note? }`. "pending" covers a burn Arc has
 * and Iris has not attested yet.
 */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const hash = new URL(request.url).searchParams.get("hash") ?? "";
    if (!isHash(hash)) throw new CallerError("hash is not a transaction hash");
    return junoJson(await cctpStatus(hash as Hex));
  });
}
