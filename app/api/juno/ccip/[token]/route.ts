import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { ccipStatus } from "@/lib/juno/ccip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /ccip/<token>` — the coin as a Chainlink CCIP Cross-Chain Token:
 * `{ enabled, pool, handedOver, chains: [{selector, name, remoteToken,
 * remotePools, outbound, inbound}], bridgedOut, ccipAdmin, registryPool,
 * graduated, canEnable, lanes, crossChain, router, explorer }`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  return junoRead(async () => {
    const { token } = await params;
    return junoJson(await ccipStatus(token));
  });
}
