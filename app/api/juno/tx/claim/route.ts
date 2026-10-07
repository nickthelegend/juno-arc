import { buildCrossChainClaim } from "@/lib/juno/cctp";
import { buildClaim } from "@/lib/juno/tx";
import {
  CallerError,
  junoHandler,
  junoJson,
  junoOptions,
  readJson,
  requireNumber,
  requireString,
  retryWhenBusy,
} from "@/lib/juno/api";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Build the transaction that pays a creator their trading fees.
 *
 * `POST { creator, token }` → `{ steps }`: the fees, in USDC, to the creator
 * on Arc (`claimCreatorFees`).
 *
 * `POST { creator, token, destinationDomain, recipient?, fast? }` →
 * `{ steps, cctp: { destinationDomain, destination, amount, maxFee,
 * finalityThreshold, mintRecipient } }`: the fees burned on Arc through Circle
 * CCTP V2 and minted to `recipient` (default: the creator's own address) on the
 * other chain once Circle attests. `fast: true` uses CCTP's fast transfer
 * (threshold 1000, `maxFee` from Iris); otherwise standard (2000).
 *
 * Only the creator can claim — checked against the chain before building — and
 * a claim with nothing in it is refused with a sentence.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;

    const body = await readJson<Record<string, unknown>>(request);
    const creator = requireAddress(requireString(body.creator, "creator"), "creator");
    const token = requireAddress(requireString(body.token, "token"), "token");

    if (body.destinationDomain === undefined || body.destinationDomain === null) {
      const steps = await retryWhenBusy(() => buildClaim({ creator, token }));
      return junoJson({ steps });
    }
    const destinationDomain = requireNumber(body.destinationDomain, "destinationDomain");
    if (!Number.isInteger(destinationDomain) || destinationDomain < 0) throw new CallerError('"destinationDomain" must be a CCTP domain number');
    const recipient = body.recipient === undefined || body.recipient === null ? undefined : requireString(body.recipient, "recipient");
    const fast = body.fast === true;
    return junoJson(await retryWhenBusy(() => buildCrossChainClaim({ creator, token, destinationDomain, recipient, fast })));
  });
}
