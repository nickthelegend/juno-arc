import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { listFeeds, trackerFeedRegistered } from "@/lib/juno/chainlink";
import { network, trackersAddress } from "@/lib/juno/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /trackers` — the Chainlink Data Feeds a tracker coin can follow, read
 * live from Arc mainnet (cached 30 s): `{ network: "mainnet", source, feeds:
 * [{ id, feedId, address, priceUsd, updatedAt, ageSeconds, stale, onchain }] }`.
 * `onchain` says whether this network's `JunoTrackers` has the feed registered
 * (so a launch can be marked on chain); feeds are registered on mainnet only.
 */
export async function GET() {
  return junoRead(async () => {
    const feeds = await listFeeds();
    const registered = trackersAddress()
      ? await Promise.all(feeds.map((feed) => trackerFeedRegistered(feed.id).catch(() => false)))
      : feeds.map(() => false);
    return junoJson({
      network: "mainnet",
      appNetwork: network(),
      source: "Chainlink Data Feeds on Arc mainnet",
      trackers: trackersAddress(),
      feeds: feeds.map((feed, i) => ({ ...feed, onchain: registered[i] })),
    });
  });
}
