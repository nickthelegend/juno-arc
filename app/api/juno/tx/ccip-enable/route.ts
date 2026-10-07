import { buildCcipEnable } from "@/lib/juno/ccip";
import { junoHandler, junoJson, junoOptions, readJson, requireString, retryWhenBusy } from "@/lib/juno/api";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /tx/ccip-enable { token, creator }` → `{ steps }`:
 * `JunoCrossChain.enable(token, <Chainlink's BurnMintTokenPool 2.0.0 code>, [])`.
 * Creator only, after graduation. Wire remote chains afterwards with
 * `tx/ccip-chains`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;
    const body = await readJson<Record<string, unknown>>(request);
    const token = requireAddress(requireString(body.token, "token"), "token");
    const creator = requireAddress(requireString(body.creator, "creator"), "creator");
    return junoJson({ steps: await retryWhenBusy(() => buildCcipEnable({ token, creator })) });
  });
}
