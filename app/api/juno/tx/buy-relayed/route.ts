import { submitRelayedBuy } from "@/lib/juno/gasless";
import { junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { launchpadMissing } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * A gasless buy, step two: Juno's relayer submits it.
 *
 * `POST { intent, signature }` → `SubmitResult` (`hash, status, blockNumber,
 * confirmMs, explorerUrl, trade, memo?` …) plus `gasless: true` and the
 * relayer's address. The signature is checked here before anything is sent;
 * the relayer pays the USDC gas, the coin goes to the buyer, and on Arc the
 * receipt it waits for is final.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;
    const body = await readJson<{ intent?: unknown; signature?: unknown }>(request);
    return junoJson(await submitRelayedBuy({ intent: body.intent, signature: body.signature }));
  });
}
