import { Linking, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { Tappable } from "./Press";
import { ExternalGlyph } from "./kit";
import { juno, type ChainConfig } from "../lib/api";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * Small pieces the Arc-stack surfaces share: the config they read, a card
 * frame, a status line, a link, and the USDC peg chip.
 *
 * Every Arc-stack card says where its figures come from and says plainly when
 * a piece is not available on this server, rather than hiding it or showing a
 * figure nobody measured.
 */

/** `GET config`, shared: the same promise every caller reads. */
export function useArcConfig(): ChainConfig | null {
  const config = useApi(() => juno.config(), []);
  return config.data ?? juno.loadedConfig();
}

/** A titled card with a small "what this is" tag on the right. */
export function ArcCard({
  title,
  tag,
  children,
  style,
  dark = false,
  testID,
}: {
  title: string;
  tag?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  dark?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.card, dark ? styles.cardDark : null, style]} testID={testID}>
      <View style={styles.head}>
        <Text style={[styles.title, dark ? styles.titleDark : null]} numberOfLines={2}>
          {title}
        </Text>
        {tag ? (
          <View style={[styles.tag, dark ? styles.tagDark : null]}>
            <Text style={[styles.tagText, dark ? styles.tagTextDark : null]} numberOfLines={1}>
              {tag}
            </Text>
          </View>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** One line of status: what happened, in its tone. */
export function StatusLine({ tone = "muted", children, testID }: { tone?: "pos" | "neg" | "muted"; children: React.ReactNode; testID?: string }) {
  return (
    <Text
      testID={testID}
      style={[styles.status, { color: tone === "pos" ? theme.colors.pos : tone === "neg" ? theme.colors.neg : theme.colors.muted }]}
    >
      {children}
    </Text>
  );
}

/** A link out — the explorer, CCIP Explorer, Circle's faucet. */
export function OutLink({ label, url, dark = false }: { label: string; url: string; dark?: boolean }) {
  return (
    <Tappable onPress={() => void Linking.openURL(url)} to={0.96} accessibilityRole="link" accessibilityLabel={label}>
      <View style={styles.link}>
        <Text style={[styles.linkText, dark ? { color: theme.colors.lime } : null]}>{label}</Text>
        <ExternalGlyph color={dark ? theme.colors.lime : theme.colors.focus} />
      </View>
    </Tappable>
  );
}

/**
 * "USDC $1.000 (Chainlink)": USDC's own peg, from Chainlink's USDC/USD feed on
 * Arc mainnet, beside wherever prices are shown in dollars. Every price in
 * Juno is in USDC, and this is the one line that says USDC is a dollar —
 * measured, not assumed. Renders nothing when the feed could not be read.
 */
export function PegChip({ style, dark = false }: { style?: StyleProp<ViewStyle>; dark?: boolean }) {
  const peg = useApi(() => juno.peg(), []);
  const data = peg.data;
  if (!data || !Number.isFinite(data.usdcUsd) || data.usdcUsd <= 0) return null;
  const off = Math.abs(data.usdcUsd - 1) > 0.005;
  return (
    <View
      style={[styles.peg, dark ? styles.pegDark : null, style]}
      accessibilityLabel={`USDC is ${data.usdcUsd.toFixed(3)} dollars, from ${data.source}${data.stale ? ", stale" : ""}`}
      testID="peg-chip"
    >
      <View style={[styles.pegDot, { backgroundColor: data.stale ? theme.colors.faint : off ? theme.colors.neg : theme.colors.pos }]} />
      <Text style={[styles.pegText, dark ? { color: theme.colors.onInk } : null]} numberOfLines={1}>
        USDC ${data.usdcUsd.toFixed(3)}
        <Text style={[styles.pegSource, dark ? { color: "rgba(243,247,238,0.6)" } : null]}>
          {data.stale ? " · Chainlink, stale" : " · Chainlink"}
        </Text>
      </Text>
    </View>
  );
}

/** An error message as the end of a sentence: one full stop, never "?." */
export function reason(text: string | null | undefined, fallback = "no answer"): string {
  const body = (text ?? "").trim() || fallback;
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

/** "0.42 s" from milliseconds: seconds once it is over a tenth, milliseconds under. */
export function seconds(ms: number): string {
  if (ms < 100) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export const arcStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  well: { borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceAlt, padding: 12, gap: 8 },
  body: { fontSize: 13, lineHeight: 19, color: theme.colors.muted },
  strong: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  figure: { fontSize: 22, fontWeight: "900", letterSpacing: -0.6, color: theme.colors.text, fontVariant: ["tabular-nums"] },
  micro: { fontSize: 11, fontWeight: "700", color: theme.colors.muted, letterSpacing: 0.3, textTransform: "uppercase" },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.lineStrong,
    backgroundColor: theme.colors.surface,
  },
  chipOn: { backgroundColor: theme.colors.ink, borderColor: theme.colors.ink },
  chipText: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  chipTextOn: { color: theme.colors.lime },
  input: {
    height: 46,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.text,
  },
});

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 12,
    ...theme.shadow.card,
  },
  cardDark: { backgroundColor: theme.colors.ink },
  head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  title: { flex: 1, fontSize: 17, fontWeight: "900", letterSpacing: -0.4, color: theme.colors.text },
  titleDark: { color: theme.colors.onInk },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: theme.colors.limeSoft, maxWidth: "50%" },
  tagDark: { backgroundColor: "rgba(214,255,61,0.14)" },
  tagText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5, color: theme.colors.onLime },
  tagTextDark: { color: theme.colors.lime },
  status: { fontSize: 13, lineHeight: 18 },
  link: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  linkText: { fontSize: 13, fontWeight: "800", color: theme.colors.focus },
  peg: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
  },
  pegDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  pegDot: { width: 6, height: 6, borderRadius: 3 },
  pegText: { fontSize: 11, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  pegSource: { fontWeight: "600", color: theme.colors.muted },
});
