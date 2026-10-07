import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireNumber, requireString } from "@/lib/juno/api";
import { gatewayIntent } from "@/lib/juno/gateway";
import { requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /gateway/intent { depositor, sourceDomain, recipient?, amount }` →
 * `{ typedData, maxFee, maxFeeUnits }`: the EIP-712 burn intent the depositor
 * signs to move `amount` USDC of their Gateway balance on `sourceDomain` to
 * `recipient` (default: themselves) on Arc. Signing costs nothing; post it to
 * `gateway/mint`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const depositor = requireAddress(requireString(body.depositor, "depositor"), "depositor");
    const recipient = body.recipient === undefined || body.recipient === null ? depositor : requireAddress(body.recipient, "recipient");
    const sourceDomain = requireNumber(body.sourceDomain, "sourceDomain");
    if (!Number.isInteger(sourceDomain)) throw new CallerError('"sourceDomain" must be a Gateway domain number');
    const amount = requireNumber(body.amount, "amount");
    return junoJson(gatewayIntent({ depositor, recipient, sourceDomain, amount }));
  });
}
