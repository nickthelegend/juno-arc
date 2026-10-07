import { isHash, type Hex } from "viem";

import { CallerError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { ccipMessageStatus } from "@/lib/juno/ccip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /ccip/message?id=0x…` — a CCIP message's state from Chainlink's CCIP
 * explorer (best effort; `state: null` when the explorer has nothing yet), with
 * its `https://ccip.chain.link/msg/<id>` link.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!isHash(id)) throw new CallerError("id is not a CCIP message id");
    return junoJson(await ccipMessageStatus(id as Hex));
  });
}
