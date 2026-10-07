import { buildCcipSend } from "@/lib/juno/ccip";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireNumber, requireString, retryWhenBusy } from "@/lib/juno/api";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /tx/ccip-send { token, owner, amount (coin units), destination
 * (chain selector), receiver? }` → `{ steps, fee: { usdc, wei }, lane,
 * receiver, amount, explorer }`: an approval of Chainlink's Router when needed,
 * then `Router.ccipSend` paying the CCIP fee in native USDC. Submitting the
 * last step returns `ccipMessageId` and `ccipExplorerUrl`
 * (`https://ccip.chain.link/msg/<id>`).
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;
    const body = await readJson<Record<string, unknown>>(request);
    const token = requireAddress(requireString(body.token, "token"), "token");
    const owner = requireAddress(requireString(body.owner, "owner"), "owner");
    const amount = requireNumber(body.amount, "amount");
    const destination = requireString(String(body.destination ?? ""), "destination");
    if (!/^\d+$/.test(destination)) throw new CallerError('"destination" must be a CCIP chain selector (decimal string)');
    const receiver = body.receiver === undefined || body.receiver === null ? undefined : requireAddress(body.receiver, "receiver");
    return junoJson(await retryWhenBusy(() => buildCcipSend({ token, owner, amount, destination, receiver })));
  });
}
