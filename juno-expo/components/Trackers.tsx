import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";

import { StatusLine } from "./ArcKit";
import { Tappable } from "./Press";
import { Skeleton } from "./kit";
import { juno, type TrackerFeed } from "../lib/api";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/** What each feed is, in a trader's words. */
const NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ether",
  SOL: "Solana",
  LINK: "Chainlink",
  PAXG: "Gold (PAX Gold)",
  EUR: "Euro",
  JPY: "Japanese yen",
  AVAX: "Avalanche",
  XRP: "XRP",
  BNB: "BNB",
  USDC: "USD Coin",
  EURC: "Euro Coin",
};

/** "12m", "6h": how old a feed's last answer is. */
export function age(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.max(1, Math.round(seconds))}s`;
}

export function feedPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(4)}`;
}

/**
 * Chainlink Data Feeds, live: every feed Juno's trackers can follow, with its
 * price and how old the last answer is.
 *
 * Read by the server from **Arc mainnet** (Arc testnet has no Chainlink
 * feeds), and labelled so. Each feed updates on a 24-hour heartbeat or a 0.5%
 * move, so a feed a few hours old is normal; past its heartbeat it is marked
 * stale. Tapping a feed starts a tracker launch on it.
 */
export function FeedBoard({ onLaunch }: { onLaunch: (feed: TrackerFeed) => void }) {
  const feeds = useApi(() => juno.trackers(), []);
  const { poll } = feeds;
  // The figures keep themselves current while the board is open.
  useEffect(() => {
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, [poll]);

  if (feeds.loading) {
    return (
      <View style={styles.board}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} h={44} round={12} />
        ))}
      </View>
    );
  }
  if (feeds.error || !feeds.data) {
    return (
      <View style={styles.board}>
        <StatusLine tone="neg">Chainlink feeds could not be read: {feeds.error ?? "no answer"}.</StatusLine>
      </View>
    );
  }
  return (
    <View style={styles.board} testID="feed-board">
      <View style={styles.boardHead}>
        <Text style={styles.boardTitle}>Chainlink on Arc {feeds.data.network === "testnet" ? "testnet" : "mainnet"}</Text>
        <Text style={styles.boardMeta}>{feeds.data.feeds.length} feeds · live</Text>
      </View>
      {feeds.data.feeds.map((feed, index) => {
        const base = feed.id.split("/")[0];
        return (
          <Tappable
            key={feed.id}
            onPress={() => onLaunch(feed)}
            to={0.98}
            accessibilityRole="button"
            accessibilityLabel={`${feed.id} ${feedPrice(feed.priceUsd)}, launch a tracker`}
          >
            <View style={[styles.row, index > 0 ? styles.rowRule : null]}>
              <View style={styles.tile}>
                <Text style={[styles.tileText, { fontSize: base.length > 3 ? 11 : 13 }]}>{base}</Text>
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {NAMES[base] ?? base}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {feed.id} · updated {age(feed.ageSeconds)} ago
                </Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 1 }}>
                <Text style={styles.price}>{feedPrice(feed.priceUsd)}</Text>
                <Text style={[styles.state, { color: feed.stale ? theme.colors.neg : theme.colors.pos }]}>
                  {feed.stale ? "stale" : "live"}
                </Text>
              </View>
            </View>
          </Tappable>
        );
      })}
      <Text style={styles.foot}>
        Read from Chainlink&rsquo;s AggregatorV3 feeds on Arc mainnet (8 decimals, 24 h heartbeat). Tap one to launch a
        tracker on it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 14,
    gap: 4,
    ...theme.shadow.card,
  },
  boardHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 },
  boardTitle: { fontSize: 15, fontWeight: "900", color: theme.colors.text },
  boardMeta: { fontSize: 11, fontWeight: "700", color: theme.colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.ink,
  },
  tileText: { fontWeight: "900", color: theme.colors.lime, letterSpacing: -0.2 },
  name: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  meta: { fontSize: 11, color: theme.colors.muted },
  price: { fontSize: 15, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  state: { fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  foot: { fontSize: 11, lineHeight: 15, color: theme.colors.faint, marginTop: 6 },
});
