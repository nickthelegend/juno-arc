import { createPublicClient, http, keccak256, parseAbi, stringToBytes, type Address, type Hex, type PublicClient } from "viem";

import { junoTrackersAbi } from "./abi";
import { publicClient } from "./client";
import { arcMainnetChain, mainnetRpcEndpoint, trackersAddress } from "./network";
import { ttlCache, withRetry } from "./rpc";

/**
 * Chainlink Data Feeds on Arc.
 *
 * Chainlink's feeds are registered on **Arc mainnet** (AggregatorV3, 8
 * decimals, 24-hour heartbeat / 0.5% deviation). There is no Chainlink feed on
 * Arc testnet, so the server reads them from Arc mainnet (`ARC_MAINNET_RPC_URL`)
 * even when the app runs on testnet — read-only `eth_call`s, no key, no
 * transaction — and labels them that way ("Chainlink BTC/USD on Arc mainnet").
 *
 * Two uses:
 *  - tracker coins (`tight-nav`): a coin that stands for a fixed amount of BTC,
 *    gold (PAXG), EUR… opens its curve at the feed's price, and on a network
 *    whose `JunoTrackers` has the feed registered the band is enforced and
 *    marked on chain (`JunoTrackers.mark`);
 *  - the USDC/USD peg shown beside every dollar figure (`/api/juno/peg`).
 *
 * Every read checks `answer > 0` and staleness (updated within 25 hours: the
 * heartbeat plus an hour). A stale feed is reported as stale, never as live.
 */

export type FeedName =
  | "BTC/USD"
  | "ETH/USD"
  | "SOL/USD"
  | "LINK/USD"
  | "PAXG/USD"
  | "EUR/USD"
  | "JPY/USD"
  | "AVAX/USD"
  | "XRP/USD"
  | "BNB/USD";

/** Chainlink proxies on Arc mainnet (reference-data-directory, feeds-arc-mainnet.json). */
export const ARC_MAINNET_FEEDS: Record<FeedName, Address> = {
  "BTC/USD": "0xa109B535C70C8Be9995be64Bb6751AcDB27e03De",
  "ETH/USD": "0x50FCDD99D6762D1C170DC6A9111db944AEE6D364",
  "SOL/USD": "0x2d04D354f5fDaE3De723df475745B0a9B4edf90C",
  "LINK/USD": "0xD37600AB06758356F0f5eE607299204785bF8c3a",
  "PAXG/USD": "0xD7a3C3E82867e606f21A1fEa9b38cF4f34B96D2a",
  "EUR/USD": "0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D",
  "JPY/USD": "0xF9Fc1C20C82d774A3787845E73E41BCbF7F38F25",
  "AVAX/USD": "0xf17C0EdcAA28371e9c8012D7699bF40ECF0F58d1",
  "XRP/USD": "0xFFb04Fba8384e0a53Ee9975F9164905030F5ea29",
  "BNB/USD": "0x00d1516C06e030Ef2142478ce14CEbce2De81771",
};

export const USDC_USD_FEED: Address = "0x84EA90AC252Dc437031461836DB5164219147905";

/** Heartbeat (24 h) plus an hour of grace. */
export const MAX_FEED_AGE_SECONDS = 25 * 60 * 60;

export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/** `JunoTrackers` keys feeds by keccak256 of the pair's name. */
export function feedIdOf(name: string): Hex {
  return keccak256(stringToBytes(name));
}

export function isFeedName(name: string): name is FeedName {
  return Object.hasOwn(ARC_MAINNET_FEEDS, name);
}

/** The feed name for a stored id or name ("BTC/USD" or its keccak). */
export function feedNameOf(idOrName: string): FeedName | null {
  if (isFeedName(idOrName)) return idOrName;
  const lower = idOrName.toLowerCase();
  return (Object.keys(ARC_MAINNET_FEEDS) as FeedName[]).find((name) => feedIdOf(name) === lower) ?? null;
}

export type FeedReading = {
  id: string;
  feedId: Hex;
  address: Address;
  priceUsd: number;
  /** ISO time the feed was last updated on chain. */
  updatedAt: string;
  ageSeconds: number;
  stale: boolean;
};

/** One `latestRoundData` answer, checked. Pure — the RPC is the caller's. */
export function readingFrom(
  id: string,
  address: Address,
  round: readonly [bigint, bigint, bigint, bigint, bigint],
  decimals: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): FeedReading | null {
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId) return null;
  const ageSeconds = Math.max(0, nowSeconds - Number(updatedAt));
  return {
    id,
    feedId: feedIdOf(id),
    address,
    priceUsd: Number(answer) / 10 ** decimals,
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    ageSeconds,
    stale: ageSeconds > MAX_FEED_AGE_SECONDS,
  };
}

let mainnet: PublicClient | null = null;
function mainnetClient(): PublicClient {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(mainnetRpcEndpoint())) throw Error("Reference feeds require a local Arc mainnet fork; unavailable on hosted testnet");
  mainnet ??= createPublicClient({
    chain: arcMainnetChain,
    transport: http(mainnetRpcEndpoint(), { retryCount: 0, timeout: 15_000 }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
  return mainnet;
}

async function readFeed(id: string, address: Address): Promise<FeedReading | null> {
  const client = mainnetClient();
  const [round, decimals] = await withRetry(() =>
    Promise.all([
      client.readContract({ address, abi: aggregatorAbi, functionName: "latestRoundData" }),
      client.readContract({ address, abi: aggregatorAbi, functionName: "decimals" }),
    ]),
  );
  return readingFrom(id, address, round, decimals);
}

const feedCache = ttlCache<FeedReading[]>(30_000);

/** Every tracker feed, read from Arc mainnet, cached 30 s. Feeds that fail a check are left out. */
export function listFeeds(): Promise<FeedReading[]> {
  return feedCache.get(
    "all",
    async () => {
      const entries = Object.entries(ARC_MAINNET_FEEDS) as Array<[FeedName, Address]>;
      const readings = await Promise.all(entries.map(([id, address]) => readFeed(id, address).catch(() => null)));
      return readings.filter((r): r is FeedReading => r !== null);
    },
    (list) => (list.length === entries().length ? 30_000 : 5_000),
  );
}

function entries() {
  return Object.keys(ARC_MAINNET_FEEDS);
}

export async function fetchFeed(name: string): Promise<FeedReading | null> {
  const feed = feedNameOf(name);
  if (!feed) return null;
  const all = await listFeeds().catch(() => [] as FeedReading[]);
  return all.find((r) => r.id === feed) ?? (await readFeed(feed, ARC_MAINNET_FEEDS[feed]).catch(() => null));
}

const pegCache = ttlCache<FeedReading | null>(30_000);

/** Chainlink USDC/USD on Arc mainnet. */
export function usdcPeg(): Promise<FeedReading | null> {
  return pegCache.get("usdc", () => readFeed("USDC/USD", USDC_USD_FEED).catch(() => null), (r) => (r ? 30_000 : 5_000));
}

/* ------------------------------------------------------------------ */
/* JunoTrackers on this network                                        */
/* ------------------------------------------------------------------ */

/** Whether this network's `JunoTrackers` has `feed` registered (it is, on mainnet only). */
export async function trackerFeedRegistered(feed: string): Promise<boolean> {
  const trackers = trackersAddress();
  if (!trackers) return false;
  const [, , allowed] = await withRetry(() =>
    publicClient().readContract({ address: trackers, abi: junoTrackersAbi, functionName: "feeds", args: [feedIdOf(feed)] }),
  );
  return allowed;
}

export type OnchainMark = {
  feedId: Hex;
  navUsd: number;
  impliedUsd: number;
  premiumBps: number;
  updatedAt: string;
  stale: boolean;
  withinBand: boolean;
  bandBps: number;
  unitsPerToken: number;
};

/** `JunoTrackers.mark(token)` when the coin is tracked on chain, else null. */
export async function onchainMark(token: Address): Promise<OnchainMark | null> {
  const trackers = trackersAddress();
  if (!trackers) return null;
  const client = publicClient();
  const [feedId, unitsPerTokenE18, bandBps] = await withRetry(() =>
    client.readContract({ address: trackers, abi: junoTrackersAbi, functionName: "trackers", args: [token] }),
  );
  if (/^0x0+$/.test(feedId)) return null;
  const m = await withRetry(() => client.readContract({ address: trackers, abi: junoTrackersAbi, functionName: "mark", args: [token] }));
  return {
    feedId: m.feedId,
    navUsd: Number(m.navUsdE18) / 1e18,
    impliedUsd: Number(m.impliedUsdE18) / 1e18,
    premiumBps: Number(m.premiumBps),
    updatedAt: new Date(Number(m.updatedAt) * 1000).toISOString(),
    stale: m.stale,
    withinBand: m.withinBand,
    bandBps: Number(bandBps),
    unitsPerToken: Number(unitsPerTokenE18) / 1e18,
  };
}
