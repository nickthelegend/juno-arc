import { junoError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { USDC_USD_FEED, usdcPeg } from "@/lib/juno/chainlink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /peg` — Circle USDC against the dollar, from Chainlink's USDC/USD feed
 * on Arc mainnet: `{ usdcUsd, updatedAt, ageSeconds, stale, source, feed }`.
 * Juno states every price in USDC = $1; this is the check on that convention.
 */
export async function GET() {
  return junoRead(async () => {
    const reading = await usdcPeg();
    if (!reading) return junoError("Chainlink USDC/USD on Arc mainnet could not be read right now.", 503);
    return junoJson({
      usdcUsd: reading.priceUsd,
      updatedAt: reading.updatedAt,
      ageSeconds: reading.ageSeconds,
      stale: reading.stale,
      source: "Chainlink USDC/USD on Arc mainnet",
      feed: USDC_USD_FEED,
    });
  });
}
