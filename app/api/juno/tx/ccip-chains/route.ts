import { buildCcipChains, type LaneUpdate } from "@/lib/juno/ccip";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireString, retryWhenBusy } from "@/lib/juno/api";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /tx/ccip-chains { token, creator, add: [{ selector, remotePool,
 * remoteToken, capacity?, rate? }], remove?: [selector] }` → `{ steps }`:
 * `JunoCrossChain.applyChainUpdates` — wires the coin's Arc pool to its pool on
 * another chain (deployed there with `scripts/ccip-remote.ts`). Rate limits
 * are always on; default 50M tokens capacity refilling at 13k/s, and
 * JunoCrossChain caps any bucket at 100M.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;
    const body = await readJson<Record<string, unknown>>(request);
    const token = requireAddress(requireString(body.token, "token"), "token");
    const creator = requireAddress(requireString(body.creator, "creator"), "creator");
    if (!Array.isArray(body.add)) throw new CallerError('"add" must be a list of lanes');
    const add: LaneUpdate[] = body.add.map((raw, i) => {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const selector = requireString(String(entry.selector ?? ""), `add[${i}].selector`);
      if (!/^\d+$/.test(selector)) throw new CallerError(`add[${i}].selector must be a decimal chain selector`);
      const capacity = entry.capacity === undefined ? undefined : Number(entry.capacity);
      const rate = entry.rate === undefined ? undefined : Number(entry.rate);
      return {
        selector,
        remotePool: requireAddress(entry.remotePool, `add[${i}].remotePool`),
        remoteToken: requireAddress(entry.remoteToken, `add[${i}].remoteToken`),
        ...(capacity !== undefined && rate !== undefined ? { capacity, rate } : {}),
      };
    });
    const remove = Array.isArray(body.remove) ? body.remove.map((s) => String(s)) : [];
    return junoJson({ steps: await retryWhenBusy(() => buildCcipChains({ token, creator, add, remove })) });
  });
}
