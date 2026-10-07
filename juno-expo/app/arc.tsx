import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { OutLink, PegChip, useArcConfig } from "../components/ArcKit";
import { ChevronLeft } from "../components/kit";
import { useSvgId } from "../components/svg-id";
import { CCIP_EXPLORER, networkLabel, type ChainConfig } from "../lib/api";
import { theme } from "../theme";

type Piece = {
  name: string;
  what: string;
  inJuno: string;
  where: string;
  /** Live on this server, unavailable, or not reported. */
  status: (config: ChainConfig | null) => { live: boolean | null; detail?: string };
};

/**
 * The Arc stack, on one screen: each piece, what it does in Juno, where to
 * find it in the app, and whether this server has it live — read from
 * `GET config`, so a piece that is not wired here says so rather than being
 * listed as if it were.
 */
const PIECES: Piece[] = [
  {
    name: "USDC as gas",
    what: "Arc's native gas token is USDC.",
    inJuno:
      "Your wallet holds one token. Every price, fee, balance and gas cost is in dollars — a trade's gas is about a tenth of a cent.",
    where: "Everywhere: the trade sheet, your wallet, every receipt.",
    status: (c) => ({ live: c ? true : null, detail: c?.usdc ? `USDC ${short(c.usdc)}` : undefined }),
  },
  {
    name: "Sub-second finality",
    what: "Deterministic finality in under a second, no reorgs.",
    inJuno:
      "A buy is final before you scroll to the next post. The receipt leads with the measured time from submit to final.",
    where: "Trade receipt · landing figures",
    status: (c) => ({ live: c ? true : null, detail: c?.arc?.finality }),
  },
  {
    name: "Memo",
    what: "Arc's Memo contract makes a call as your wallet and logs a reference beside it.",
    inJuno: "Each curve buy and sell is tagged with its post's id, so trades are findable by post on chain.",
    where: "Trade receipt: “Tagged with this post via Arc Memo”",
    status: (c) =>
      c?.arc?.memo
        ? { live: c.arc.memo.live, detail: c.arc.memo.live ? short(c.arc.memo.address) : "not executed by this RPC — plain calls" }
        : { live: null },
  },
  {
    name: "Gasless buys (EIP-3009)",
    what: "USDC's receiveWithAuthorization: a signature moves the money, someone else pays the gas.",
    inJuno: "“Pay with signature — no gas”: you sign, Juno's relayer submits the buy and pays the USDC gas.",
    where: "Trade sheet",
    status: (c) =>
      c?.arc?.relayer
        ? { live: c.arc.relayer.available, detail: c.arc.relayer.available ? "relayer funded" : "no relayer on this server" }
        : { live: null },
  },
  {
    name: "Circle Gateway",
    what: "A unified USDC balance across chains, spendable on Arc in seconds.",
    inJuno: "Deposit once on Base or Ethereum, spend it here; top up a buy from Gateway when Arc USDC is short.",
    where: "Profile → wallet · trade sheet “Top up from Gateway”",
    status: (c) =>
      c?.arc?.gateway
        ? {
            live: c.arc.gateway.available,
            detail: c.arc.gateway.sources?.length ? `${c.arc.gateway.sources.length} source chains` : undefined,
          }
        : { live: null },
  },
  {
    name: "Circle CCTP V2",
    what: "Native USDC burned on one chain, minted on another.",
    inJuno: "Creators withdraw trading fees straight to Base, Ethereum, Arbitrum, Solana… as native USDC.",
    where: "Creator earnings · coin page “Withdraw fees to…”",
    status: (c) =>
      c?.arc?.cctp
        ? { live: true, detail: `domain ${c.arc.cctp.domain} · ${c.arc.cctp.destinations?.length ?? 0} destinations` }
        : { live: null },
  },
  {
    name: "Chainlink CCIP Cross-Chain Tokens",
    what: "A token pool per coin: burned on Arc, minted on the destination, rate-limited per lane.",
    inJuno:
      "A graduated coin's creator makes it cross-chain in one transaction; holders send it to Base Sepolia or Ethereum Sepolia, fee in USDC. Arc's supply can never exceed the launch supply.",
    where: "Graduated coin page → Cross-chain",
    status: (c) =>
      c?.arc?.ccip
        ? { live: true, detail: `${c.arc.ccip.lanes?.length ?? 0} lanes · router ${short(c.arc.ccip.router)}` }
        : { live: null },
  },
  {
    name: "Chainlink Data Feeds",
    what: "Decentralised price feeds — BTC, ETH, SOL, LINK, gold, EUR, JPY… — read from Arc mainnet.",
    inJuno:
      "Trackers follow a feed: the coin page shows NAV, what the curve implies, the premium and the band. USDC's own peg is shown beside prices.",
    where: "Trade → Trackers · tracker coin pages · the peg chip",
    status: (c) =>
      c?.arc?.feeds
        ? { live: c.arc.feeds.count > 0, detail: `${c.arc.feeds.count} feeds on Arc ${c.arc.feeds.network}` }
        : { live: null },
  },
];

export default function ArcScreen() {
  const router = useRouter();
  const config = useArcConfig();
  const glow = useSvgId("arcGlow");
  const back = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)/social" as never));

  return (
    <SafeAreaView edges={["top"]} style={styles.page}>
      <View style={styles.nav}>
        <Pressable onPress={back} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <ChevronLeft />
        </Pressable>
        <Text style={styles.navTitle}>Juno on Arc</Text>
        <View style={{ width: 36 }} />
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
            <Defs>
              <LinearGradient id={glow} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={theme.colors.lime} stopOpacity={0.24} />
                <Stop offset="0.65" stopColor={theme.colors.lime} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#${glow})`} />
          </Svg>
          <Text style={styles.heroPill}>{config ? networkLabel(config.network) : "Arc"}</Text>
          <Text style={styles.heroTitle}>What runs on Arc.</Text>
          <Text style={styles.heroBody}>
            Juno is a social app where every post is a market. Arc is Circle&rsquo;s chain for stablecoin finance: here is
            each piece of it Juno uses, what it does for you, and whether this server has it live.
          </Text>
          <PegChip dark style={{ marginTop: 4 }} />
        </View>

        {PIECES.map((piece, index) => {
          const status = piece.status(config);
          return (
            <View key={piece.name} style={styles.piece} testID="arc-piece">
              <View style={styles.pieceHead}>
                <Text style={styles.index}>{String(index + 1).padStart(2, "0")}</Text>
                <Text style={styles.pieceName}>{piece.name}</Text>
                <View
                  style={[
                    styles.badge,
                    status.live === true ? styles.badgeLive : status.live === false ? styles.badgeOff : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.badgeText,
                      status.live === true ? styles.badgeLiveText : status.live === false ? styles.badgeOffText : null,
                    ]}
                  >
                    {status.live === true ? "LIVE" : status.live === false ? "UNAVAILABLE" : "NOT REPORTED"}
                  </Text>
                </View>
              </View>
              <Text style={styles.what}>{piece.what}</Text>
              <Text style={styles.inJuno}>{piece.inJuno}</Text>
              <Text style={styles.where}>
                {piece.where}
                {status.detail ? ` · ${status.detail}` : ""}
              </Text>
            </View>
          );
        })}

        <View style={{ gap: 8, paddingHorizontal: 4 }}>
          {config?.explorer ? <OutLink label="Arc's explorer" url={config.explorer} /> : null}
          <OutLink label="Chainlink CCIP Explorer" url={CCIP_EXPLORER} />
          <OutLink label="Arc docs" url="https://docs.arc.io" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function short(address: string | undefined | null): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.bg },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.surface, alignItems: "center", justifyContent: "center" },
  navTitle: { fontSize: theme.type.lead.size, fontWeight: "800", color: theme.colors.text },
  body: { paddingHorizontal: 16, paddingBottom: 48, gap: 12 },
  hero: { borderRadius: theme.radius.lg, padding: 18, gap: 8, backgroundColor: theme.colors.ink, overflow: "hidden" },
  heroPill: {
    alignSelf: "flex-start",
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.lime,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(214,255,61,0.14)",
    overflow: "hidden",
  },
  heroTitle: { fontSize: 28, lineHeight: 32, fontWeight: "900", letterSpacing: -0.9, color: theme.colors.onInk },
  heroBody: { fontSize: 14, lineHeight: 20, color: "rgba(243,247,238,0.74)" },
  piece: { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface, padding: 16, gap: 6, ...theme.shadow.card },
  pieceHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  index: { fontSize: 12, fontWeight: "900", color: theme.colors.faint, fontVariant: ["tabular-nums"] },
  pieceName: { flex: 1, fontSize: 16, fontWeight: "900", letterSpacing: -0.3, color: theme.colors.text },
  badge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: theme.colors.surfaceAlt },
  badgeLive: { backgroundColor: theme.colors.limeSoft },
  badgeOff: { backgroundColor: theme.colors.negSoft },
  badgeText: { fontSize: 9, fontWeight: "900", letterSpacing: 0.5, color: theme.colors.muted },
  badgeLiveText: { color: theme.colors.onLime },
  badgeOffText: { color: theme.colors.neg },
  what: { fontSize: 13, lineHeight: 18, fontWeight: "700", color: theme.colors.text },
  inJuno: { fontSize: 13, lineHeight: 19, color: theme.colors.muted },
  where: { fontSize: 11, lineHeight: 15, fontWeight: "700", color: theme.colors.faint },
});
