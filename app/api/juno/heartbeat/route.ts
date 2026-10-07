import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { arcHeartbeat } from "@/lib/juno/heartbeat";
import { recentConfirmations } from "@/lib/juno/speed-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /heartbeat` — Arc's block cadence, measured from the chain, beside the
 * confirmation times this server measured for its own submissions
 * (broadcast → final receipt). `localFork` says when both are a fork's.
 */
export async function GET() {
  return junoRead(async () => {
    const beat = await arcHeartbeat();
    return junoJson({ ...beat, confirmations: recentConfirmations() });
  });
}
