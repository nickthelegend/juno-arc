import { buildLaunch } from "@/lib/juno/tx";
import { CURVE_PRESETS } from "@/lib/juno/curves";
import { isFeedName } from "@/lib/juno/chainlink";
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
import type { CurvePresetId } from "@/lib/juno/types";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Ticker conventions, enforced here so a launch cannot create an unusable ticker.
 *
 * The contract would take up to sixteen bytes of anything; this is the app's
 * rule, not the chain's, and it is stricter on purpose — a ticker is typed into
 * search boxes and printed as `$SYMBOL`.
 */
const SYMBOL = /^[A-Z0-9]{2,10}$/;
const MAX_NAME = 64;
/** An `ipfs://` URI is about 60 characters; this leaves room for a gateway URL. */
const MAX_URI = 256;

/**
 * Build the one unsigned transaction that opens a coin.
 *
 * On Arc a launch is a single `JunoLaunchpad.launch` call: the ERC-20, its
 * curve, its AMM pair and the creator's optional first buy are created
 * atomically, so there is no half-launched state to recover from. The token's
 * address is predicted by the launchpad before anything is signed and comes
 * back as `token` — the app can show the coin's address on the confirm sheet.
 *
 * Every coin is quoted in USDC; a first buy needs a USDC approval first, so
 * the answer is `steps`, in order, like every other build route. The launch
 * call of a launch with a first buy goes through Arc's Memo when it runs
 * (`memo.tagged`).
 *
 * A tracker (`preset: "tight-nav"`, `tracker: { feed: "BTC/USD", unitsPerToken }`)
 * opens its curve at Chainlink's price × unitsPerToken; where this network's
 * `JunoTrackers` has the feed registered (Arc mainnet), a second step
 * `track(token, feedId, unitsPerTokenE18, bandBps)` is appended, and otherwise
 * the ratio is recorded off chain when the launch is indexed (`POST pools`).
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;

    const body = await readJson<Record<string, unknown>>(request);

    const creator = requireAddress(requireString(body.creator, "creator"), "creator");
    const name = requireString(body.name, "name");
    const symbol = requireString(body.symbol, "symbol").toUpperCase();
    const preset = requireString(body.preset, "preset") as CurvePresetId;

    if (!SYMBOL.test(symbol)) {
      throw new CallerError("Symbol must be 2-10 characters, letters and digits only");
    }
    if (name.length > MAX_NAME) throw new CallerError(`Name must be ${MAX_NAME} characters or fewer`);
    if (!CURVE_PRESETS[preset]) {
      throw new CallerError(
        `Unknown preset "${preset}". One of: ${Object.keys(CURVE_PRESETS).join(", ")}`,
      );
    }

    // The contract accepts an empty URI; metadata is pinned separately and a
    // launch without it is still a valid token.
    const uri = typeof body.uri === "string" ? body.uri.trim() : "";
    if (uri.length > MAX_URI) throw new CallerError(`"uri" must be ${MAX_URI} characters or fewer`);

    // USDC is the only quote token on Arc (and the gas token).
    const quote =
      body.quoteToken === undefined || body.quoteToken === null ? undefined : requireAddress(body.quoteToken, "quoteToken");

    const initialMarketCap =
      body.initialMarketCap === undefined || body.initialMarketCap === null
        ? undefined
        : requireNumber(body.initialMarketCap, "initialMarketCap");
    const migrationMarketCap =
      body.migrationMarketCap === undefined || body.migrationMarketCap === null
        ? undefined
        : requireNumber(body.migrationMarketCap, "migrationMarketCap");

    for (const [field, value] of [
      ["initialMarketCap", initialMarketCap],
      ["migrationMarketCap", migrationMarketCap],
    ] as const) {
      if (value !== undefined && !(value > 0)) {
        throw new CallerError(`"${field}" must be greater than zero`);
      }
    }
    if (
      initialMarketCap !== undefined &&
      migrationMarketCap !== undefined &&
      migrationMarketCap <= initialMarketCap
    ) {
      throw new CallerError("Migration market cap must be above the initial market cap");
    }

    const firstBuy =
      body.firstBuy === undefined || body.firstBuy === null
        ? undefined
        : requireNumber(body.firstBuy, "firstBuy");
    if (firstBuy !== undefined && firstBuy < 0) {
      throw new CallerError('"firstBuy" cannot be negative');
    }

    // Where the curve graduates: its Uniswap v2 pair (the only venue on Arc).
    const venue = body.venue === undefined || body.venue === null ? undefined : body.venue;
    if (venue !== undefined && venue !== "uniswap-v2") {
      throw new CallerError('"venue" must be "uniswap-v2"');
    }

    let tracker: { feed: string; unitsPerToken: number } | undefined;
    if (body.tracker !== undefined && body.tracker !== null) {
      const raw = body.tracker as Record<string, unknown>;
      const feed = requireString(raw.feed, "tracker.feed");
      if (!isFeedName(feed)) throw new CallerError(`"tracker.feed" must be a Chainlink feed Juno tracks, like "BTC/USD"`);
      const unitsPerToken = requireNumber(raw.unitsPerToken, "tracker.unitsPerToken");
      if (!(unitsPerToken > 0)) throw new CallerError('"tracker.unitsPerToken" must be greater than zero');
      tracker = { feed, unitsPerToken };
    }

    const result = await retryWhenBusy(() =>
      buildLaunch({
        creator,
        name,
        symbol,
        uri,
        preset,
        quote,
        initialMarketCap,
        migrationMarketCap,
        firstBuy,
        venue,
        tracker,
      }),
    );

    return junoJson(result);
  });
}
