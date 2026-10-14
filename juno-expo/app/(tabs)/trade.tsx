import { useRouter } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import styled from "styled-components/native";

import { PegChip } from "../../components/ArcKit";
import { Button, Caption, Col, Entry, Label, Ledger, Mono, Pill, Placeholder, RETRY_HINT, Row, Segmented, Skeleton, Title } from "../../components/kit";
import { CoinArt, Identicon } from "../../components/art";
import { Handle } from "../../components/Handle";
import { Tappable } from "../../components/Press";
import { QuickTrade } from "../../components/QuickTrade";
import { FeedBoard, age, feedPrice } from "../../components/Trackers";
import { useRefreshOnFocus } from "../../lib/focus";
import { juno, onTestnet, type Coin, type Trader } from "../../lib/api";
import { useLinkedState } from "../../lib/linked";
import { count, invalidateMarkets, loadMarkets, progressLabel, tradesInApp } from "../../lib/markets";
import { money, useApi } from "../../lib/useApi";
import { useViewerOnce } from "../../lib/social";
import { theme } from "../../theme";
import { useSvgId } from "../../components/svg-id";

type Sort = "trackers" | "posts" | "traders";

const SORTS = [
  { id: "trackers" as const, label: "Trackers" },
  { id: "posts" as const, label: "Posts" },
  { id: "traders" as const, label: "Traders" },
];

/**
 * Trade: the markets as lists, rather than a feed.
 *
 * **Trackers lead.** A tracker is a `tight-nav` curve that follows a Chainlink
 * Data Feed — Bitcoin, Ether, gold, the euro — marked against it: the feed's
 * live price, what the curve implies, the premium and whether it sits inside
 * its band. Above them, every Chainlink feed on Arc mainnet with its price and
 * age; tapping one starts a tracker launch on it.
 *
 * **Posts** are the feed's coins as a list, for someone who wants to compare
 * curves instead of scrolling pictures. **Traders** ranks the people.
 *
 * Every Trade button opens the same sheet the coin screen uses, over this
 * screen — quoting against the live curve is the same act wherever it starts.
 */
export default function TradeScreen() {
  const router = useRouter();
  // Addressable, so a deep link or a demo can land on a specific list.
  const [sort, setSort] = useLinkedState<Sort>(
    "sort",
    SORTS.map((option) => option.id),
    "posts",
  );
  const onTraders = sort === "traders";

  // Read with the same viewer as the feed and the reels, so all three share one walk.
  const once = useViewerOnce();
  const markets = useApi(
    () => (onTraders || !once.ready ? Promise.resolve(null) : loadMarkets(once.viewer())),
    [onTraders, once.ready],
  );
  const board = useApi(() => (onTraders ? juno.leaderboard(25) : Promise.resolve(null)), [onTraders]);
  const [trade, setTrade] = useState<Coin | null>(null);

  const refresh = () => {
    invalidateMarkets();
    markets.refresh();
  };
  useRefreshOnFocus(() => {
    refresh();
    board.refresh();
  });

  const refreshControl = (
    <RefreshControl refreshing={markets.refreshing} onRefresh={refresh} tintColor={theme.colors.muted} />
  );

  const list = sort === "trackers" ? (markets.data?.trackers ?? []) : (markets.data?.posts ?? []);

  return (
    <Page edges={["top"]}>
      <Header>
        <Row justify="space-between" align="center">
          <Title>Trade</Title>
          <PegChip />
        </Row>
        <Segmented items={SORTS} value={sort} onChange={setSort} />
      </Header>

      {onTraders ? (
        <TraderBoard board={board} onOpen={(wallet) => router.push(`/trader/${wallet}` as never)} />
      ) : (
        <ScrollView
          contentContainerStyle={{ width: "100%", paddingHorizontal: 16, paddingBottom: 130, gap: 14 }}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          {sort === "trackers" ? (
            <>
              <Intro
                pill={onTestnet() ? "Display-only on testnet · mainnet prices" : "Chainlink on Arc mainnet"}
                title="Track anything with a feed."
                body={onTestnet()
                  ? "Compare a USDC bonding curve with Chainlink prices from Arc mainnet. Testnet trackers show the reference price only; no on-chain NAV marks or price-band enforcement."
                  : "Bitcoin, Ether, gold, the euro: each tracker is a USDC bonding curve on Arc marked against a Chainlink Data Feed, with its premium and band shown against the feed price."}
              />
              <FeedBoard onLaunch={(feed) => router.push(`/post?tracker=${encodeURIComponent(feed.id)}` as never)} />
            </>
          ) : (
            <Intro
              pill="Launched on Arc"
              title="Every post is a market."
              body="Posts and reels launched as coins, priced in USDC. Early buyers ride the curve; creators earn the fees; every buy is final on Arc in about a second."
            />
          )}

          {(markets.data?.missing ?? 0) > 0 ? (
            <Footnote>
              {markets.data!.missing} more {markets.data!.missing === 1 ? "market is" : "markets are"} listed but could
              not be priced just now. They are asked again when you come back to this tab.
            </Footnote>
          ) : null}

          {markets.error ? (
            <Placeholder
              title="Could not load the market"
              detail={markets.error}
              action={<Button label="Try again" onPress={markets.refresh} />}
            />
          ) : markets.loading || markets.data === null ? (
            <Ledger>
              {[0, 1, 2].map((i) => (
                <Entry key={i} $first={i === 0}>
                  <Row gap={12}>
                    <Skeleton h={44} w={44} round={14} />
                    <Col gap={8} style={{ flex: 1 }}>
                      <Skeleton h={14} w="55%" />
                      <Skeleton h={11} w="35%" />
                    </Col>
                    <Skeleton h={36} w={72} round={12} />
                  </Row>
                </Entry>
              ))}
            </Ledger>
          ) : list.length === 0 ? (
            <Placeholder
              title={sort === "trackers" ? "No trackers yet" : "No posts yet"}
              detail={sort === "trackers" ? "Tap a feed above to launch the first one." : "Post something with +."}
            />
          ) : (
            list.map((coin) => (
              <MarketCard
                key={coin.address}
                coin={coin}
                tracker={sort === "trackers"}
                onOpen={() => router.push(`/coin/${coin.address}`)}
                onTrade={() => setTrade(coin)}
              />
            ))
          )}
        </ScrollView>
      )}

      {trade ? (
        <QuickTrade
          coin={trade}
          side="buy"
          onClose={() => setTrade(null)}
          onDone={() => {
            setTrade(null);
            invalidateMarkets();
            markets.refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** What this list is, once, in the app's one dark panel. */
function Intro({
  pill,
  title,
  body,
}: {
  pill: string;
  title: string;
  body: string;
}) {
  const introGlowId = useSvgId("introGlow");
  return (
    <View style={styles.intro}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id={introGlowId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={theme.colors.lime} stopOpacity={0.22} />
            <Stop offset="0.6" stopColor={theme.colors.lime} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${introGlowId})`} />
      </Svg>
      <View style={styles.introPill}>
        <View style={styles.introDot} />
        <Text style={styles.introPillText}>{pill}</Text>
      </View>
      <Text style={styles.introTitle}>{title}</Text>
      <Text style={styles.introBody}>{body}</Text>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <Text
        style={[styles.statValue, tone ? { color: tone === "pos" ? theme.colors.pos : theme.colors.neg } : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * One market, as a card.
 *
 * A tracker card leads with the thing it follows: the Chainlink feed, its
 * live price and age, and how far the curve sits from it. A post card leads
 * with the post: its art, who made it, and the social numbers that are the
 * only fundamentals a meme has. Both end on the curve and the Trade button,
 * because that part is the same product either way.
 */
function MarketCard({
  coin,
  tracker,
  onOpen,
  onTrade,
}: {
  coin: Coin;
  tracker: boolean;
  onOpen: () => void;
  onTrade: () => void;
}) {
  const pct = coin.curve.progress * 100;
  const nav = coin.nav ?? null;
  const feed = nav?.feed ?? coin.reference?.id ?? null;
  const base = feed ? feed.split("/")[0] : coin.symbol;
  const deviation = nav?.deviation ?? null;

  // The head and figures open the coin; the Trade button beside the progress
  // trades it. Siblings, not nested: a button inside a button is invalid on
  // the web and unreachable to a screen reader.
  return (
    <View style={styles.company}>
      <Tappable onPress={onOpen} to={0.985}>
        <View style={{ gap: 14 }}>
          <View style={styles.companyHead}>
            {tracker ? (
              <View style={styles.tickerTile}>
                <Text style={[styles.tickerTileText, { fontSize: base.length > 3 ? 12 : 15 }]} numberOfLines={1}>
                  {base.slice(0, 4)}
                </Text>
              </View>
            ) : (
              <CoinArt uri={juno.still(coin.media)} seed={coin.address} size={48} radius={14} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.companyName} numberOfLines={1}>
                {coin.name}
              </Text>
              <Text style={styles.companySector} numberOfLines={1}>
                {tracker ? (
                  `Tracks ${feed ?? "a feed"} · Chainlink`
                ) : (
                  <>
                    by <Handle wallet={coin.creator.wallet} /> · {coin.format === "reel" ? "reel" : "post"}
                  </>
                )}
              </Text>
            </View>
            <View style={[styles.preBadge, tracker ? styles.badgeInk : styles.badgeHeart]}>
              <Text style={[styles.preBadgeText, tracker ? styles.badgeInkText : styles.badgeHeartText]}>
                {tracker ? "TRACKER" : coin.format === "reel" ? "REEL" : "POST"}
              </Text>
            </View>
          </View>

          <View style={styles.stats}>
            {tracker ? (
              <>
                {/* Said with its age when it is not live: a Chainlink feed
                    updates on a 24 h heartbeat or a 0.5% move. */}
                <Stat
                  label={
                    nav?.state === "stale"
                      ? `Chainlink, ${nav.ageSeconds === null ? "stale" : `${age(nav.ageSeconds)} old`}`
                      : "Chainlink price"
                  }
                  value={nav ? feedPrice(nav.priceUsd) : "—"}
                />
                <View style={styles.statRule} />
                <Stat label="Market cap" value={money(coin.marketCap, "USD")} />
                <View style={styles.statRule} />
                <Stat
                  label="Premium"
                  value={deviation === null ? "—" : `${deviation >= 0 ? "+" : ""}${(deviation * 100).toFixed(2)}%`}
                  // Against a stale feed the gap is a fact about the past, not
                  // a signal; it is shown uncoloured.
                  tone={deviation === null || nav?.state === "stale" ? undefined : nav?.withinBand ? "pos" : "neg"}
                />
              </>
            ) : (
              <>
                <Stat label="Market cap" value={money(coin.marketCap, "USD")} />
                <View style={styles.statRule} />
                <Stat label="Likes" value={coin.likes === undefined ? "—" : count(coin.likes) || "0"} />
                <View style={styles.statRule} />
                <Stat label="Replies" value={coin.commentCount === undefined ? "—" : count(coin.commentCount) || "0"} />
              </>
            )}
          </View>
          {tracker && nav && nav.impliedUsd !== null ? (
            <Text
              style={[styles.marketMeta, { color: nav.withinBand ? theme.colors.pos : theme.colors.neg, fontWeight: "700" }]}
              numberOfLines={2}
            >
              Curve implies {feedPrice(nav.impliedUsd)} per {base} · {nav.withinBand ? "inside" : "outside"} its ±
              {nav.bandBps / 100}% band
            </Text>
          ) : null}
        </View>
      </Tappable>

      <View style={styles.market}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={styles.marketName} numberOfLines={1}>
            ${coin.symbol} <Text style={styles.marketPreset}>{coin.curvePreset}</Text>
          </Text>
          <View style={styles.rowCurve}>
            <View style={styles.rowTrack}>
              <View
                style={[
                  styles.rowFill,
                  { width: `${coin.curve.graduated ? 100 : pct > 0 ? Math.max(2, Math.min(100, pct)) : 0}%` },
                ]}
              />
            </View>
            <Text style={styles.marketMeta}>
              {coin.curve.graduated ? "Graduated" : coin.curve.complete ? "Full" : progressLabel(pct)}
            </Text>
          </View>
        </View>
        {tradesInApp(coin) ? (
          <Tappable onPress={onTrade} to={0.94} accessibilityLabel={`Trade $${coin.symbol}`}>
            <View style={styles.tradeButton}>
              <Text style={styles.tradeText}>Trade</Text>
            </View>
          </Tappable>
        ) : coin.curve.graduated ? (
          // A pair this API has no router for: traded outside the app.
          <Pill label="On Uniswap v2" />
        ) : (
          // Full and waiting to graduate: nothing to trade until it does.
          <Pill label="Curve full" tone="lime" />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: {
    borderRadius: theme.radius.lg,
    padding: 18,
    gap: 8,
    backgroundColor: theme.colors.ink,
    overflow: "hidden",
  },
  introPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(214,255,61,0.14)",
  },
  introDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.lime },
  introPillText: { fontSize: 11, fontWeight: "700", color: theme.colors.lime },
  introTitle: { fontSize: 24, lineHeight: 28, fontWeight: "900", letterSpacing: -0.8, color: theme.colors.onInk },
  introBody: { fontSize: 14, lineHeight: 20, color: "rgba(243,247,238,0.72)" },

  company: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 14,
    ...theme.shadow.card,
  },
  companyHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  companyName: { fontSize: 20, fontWeight: "900", letterSpacing: -0.5, color: theme.colors.text },
  companySector: { fontSize: 12, color: theme.colors.muted },
  preBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: theme.colors.limeSoft,
  },
  preBadgeText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.6, color: theme.colors.onLime },
  badgeInk: { backgroundColor: theme.colors.ink },
  badgeInkText: { color: theme.colors.lime },
  badgeHeart: { backgroundColor: "rgba(255,45,111,0.12)" },
  badgeHeartText: { color: theme.colors.heart },

  stats: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  statRule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.colors.lineStrong, marginHorizontal: 10 },
  statValue: { fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: theme.colors.text, fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: 11, fontWeight: "600", color: theme.colors.muted },

  market: { flexDirection: "row", alignItems: "center", gap: 12 },
  marketName: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  marketPreset: { fontSize: 12, fontWeight: "600", color: theme.colors.muted },
  marketMeta: { fontSize: 12, color: theme.colors.muted, fontVariant: ["tabular-nums"] },

  tradeButton: {
    height: 38,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
  },
  tradeText: { fontSize: 14, fontWeight: "800", color: theme.colors.onLime },

  tickerTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    padding: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.ink,
  },
  tickerTileText: { fontSize: 13, fontWeight: "900", color: theme.colors.lime, letterSpacing: -0.2 },

  rowCurve: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.line, overflow: "hidden" },
  rowFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.pos },
});

const Footnote = styled.Text`
  margin-bottom: ${(p) => p.theme.space(3)}px;
  padding-horizontal: ${(p) => p.theme.space(2)}px;
  font-size: ${(p) => p.theme.type.caption.size}px;
  line-height: ${(p) => p.theme.type.caption.height}px;
  color: ${(p) => p.theme.colors.muted};
`;

/**
 * Traders, ranked by profit they have taken.
 *
 * Ranked on **realised** only. A wallet that bought and never sold has taken no
 * risk off the table, and ranking on paper gains would order the board by who
 * bought earliest rather than who traded well. The open position is shown
 * beside the rank so the picture is complete, and it never decides the order.
 *
 * `—` on a win rate is not a zero. It means no sell had a cost inside the read
 * window to compare against, which is unmeasured rather than bad.
 */
function TraderBoard({
  board,
  onOpen,
}: {
  board: ReturnType<typeof useApi<{ partial: boolean; poolsRead: number; poolsTotal: number; traders: Trader[] } | null>>;
  onOpen: (wallet: string) => void;
}) {
  if (board.loading) {
    return (
      <Loading>
        <Ledger>
          {[0, 1, 2, 3].map((i) => (
            <Entry key={i} $first={i === 0}>
              <Row gap={12}>
                <Skeleton h={26} w={26} round={13} />
                <Skeleton h={14} w="40%" />
                <Col style={{ flex: 1 }} />
                <Skeleton h={16} w={64} />
              </Row>
            </Entry>
          ))}
        </Ledger>
      </Loading>
    );
  }

  if (board.error) {
    return (
      <Placeholder
        title="Could not rank traders"
        detail={board.error}
        action={<Button label="Try again" onPress={board.refresh} />}
      />
    );
  }

  const traders = board.data?.traders ?? [];

  return (
    <ScrollView
      contentContainerStyle={{ width: "100%", paddingHorizontal: 16, paddingBottom: 130 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={board.refreshing}
          onRefresh={board.refresh}
          tintColor={theme.colors.muted}
        />
      }
    >
      {/* A rank built from a short read is short. Saying so costs one line and
          is the difference between a board and a claim. */}
      {board.data?.partial ? (
        <Footnote>
          Ranked from {board.data.poolsRead}{" "}
          {board.data.poolsRead === 1 ? "pool" : "pools"} — some histories would not
          load, so this is not every trade on the network. {RETRY_HINT}
        </Footnote>
      ) : board.data && traders.length > 0 ? (
        // Complete is a claim too, and worth the same line: a board that only
        // speaks up when it is short leaves "complete" to be guessed.
        <Footnote>
          Every trade on all {board.data.poolsTotal} {board.data.poolsTotal === 1 ? "pool" : "pools"}, ranked by
          profit taken.
        </Footnote>
      ) : null}

      {traders.length === 0 ? (
        <Placeholder
          title={board.data?.partial ? "Could not read the network" : "Nobody has traded yet"}
          detail={
            board.data?.partial
              ? `The RPC is rate-limiting, so no pool history could be walked. ${RETRY_HINT}`
              : "The board fills in as soon as the first swap lands."
          }
        />
      ) : (
        <Ledger>
          {traders.map((trader, index) => (
            <Tappable key={trader.wallet} onPress={() => onOpen(trader.wallet)} to={0.985}>
              <Entry $first={index === 0}>
                <Row gap={12}>
                  <Rank>{index + 1}</Rank>
                  <Identicon seed={trader.wallet} size={28} />
                  <Col gap={2} style={{ flex: 1 }}>
                    <Row gap={6}>
                      <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                        <Handle wallet={trader.wallet} />
                      </Label>
                      {trader.isCreator ? <Pill label="Creator" tone="lime" /> : null}
                    </Row>
                    <Caption>
                      {trader.trades} {trader.trades === 1 ? "fill" : "fills"} ·{" "}
                      {trader.coins} {trader.coins === 1 ? "coin" : "coins"}
                      {trader.followers > 0
                        ? ` · ${trader.followers} ${trader.followers === 1 ? "follower" : "followers"}`
                        : ""}
                    </Caption>
                  </Col>
                  <Col gap={2} style={{ alignItems: "flex-end" }}>
                    <Mono
                      style={{
                        color:
                          trader.realised > 0
                            ? theme.colors.pos
                            : trader.realised < 0
                              ? theme.colors.neg
                              : theme.colors.text,
                      }}
                    >
                      {trader.realised > 0 ? "+" : ""}
                      {money(trader.realised, "USD")}
                    </Mono>
                    <Caption>taken</Caption>
                  </Col>
                </Row>

                <Row gap={16} style={{ marginTop: 12 }}>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>
                      {trader.unrealised === null ? "—" : money(trader.unrealised, "USD")}
                    </Mono>
                    <Caption>Open</Caption>
                  </Col>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>{money(trader.holding, "USD")}</Mono>
                    <Caption>Holding</Caption>
                  </Col>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>
                      {trader.winRate === null ? "—" : `${Math.round(trader.winRate * 100)}%`}
                    </Mono>
                    <Caption>Win rate</Caption>
                  </Col>
                </Row>
              </Entry>
            </Tappable>
          ))}
        </Ledger>
      )}
    </ScrollView>
  );
}

const Rank = styled.Text`
  width: 18px;
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.faint};
`;

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

const Header = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(3)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;

const Loading = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;
