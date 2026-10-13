import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";

import { juno } from "../lib/api";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * Arc's heartbeat: how fast blocks arrive, and how fast Juno's own trades
 * were final, both measured.
 *
 * The block interval comes from the chain's own timestamps over a window of
 * blocks. The confirmations are the submit-to-receipt times this server timed
 * for the trades it submitted; on Arc a receipt is final, so they are
 * finality. A figure that could not be read is left out. On a local fork the
 * caption says the cadence is the fork's, not Arc's.
 */
export function Heartbeat({ compact = false }: { compact?: boolean }) {
  const beat = useApi(() => juno.heartbeat(), []);
  const { refresh } = beat;
  useEffect(() => {
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const data = beat.data;
  if (!data) return compact ? null : <View style={styles.wrap} />;
  const confirmations = data.confirmations;

  return (
    <View style={styles.wrap} accessibilityLabel="Arc heartbeat" testID="heartbeat">
      <View style={styles.head}>
        <View style={[styles.liveDot, { backgroundColor: theme.colors.pos }]} />
        <Text style={styles.title}>{data.localFork ? "Local Arc fork" : "Arc"} · live</Text>
        <View style={{ flex: 1 }} />
        {/* The landing's grid already shows the block and the median. */}
        {compact ? null : (
          <Text style={styles.headline} testID="heartbeat-block">
            #{data.latestBlock.toLocaleString("en-US")}
          </Text>
        )}
      </View>
      <View style={styles.cells}>
        <Cell
          value={data.blockMs === null ? "—" : `${data.blockMs.toLocaleString("en-US")} ms`}
          label={`per block, over ${data.window}`}
          testID="heartbeat-block-ms"
        />
        {confirmations && !compact ? (
          <Cell
            value={`${confirmations.medianMs.toLocaleString("en-US")} ms`}
            label={confirmations.samples === 1 ? "to final, last trade" : `to final, median of ${confirmations.samples}`}
            testID="heartbeat-final"
          />
        ) : null}
      </View>
      <Text style={styles.caption}>
        {data.localFork
          ? "A fork of Arc testnet: this cadence is the fork's, not Arc's. A receipt is final here as it is on Arc."
          : "Final when produced: a receipt on Arc is deterministic, with no reorgs and no confirmation count."}
      </Text>
    </View>
  );
}

function Cell({ value, label, testID }: { value: string; label: string; testID: string }) {
  return (
    <View style={styles.cell}>
      <Text style={styles.value} testID={testID}>
        {value}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  title: { fontSize: 12, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", color: theme.colors.muted },
  headline: { fontSize: 12, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  cells: { flexDirection: "row", gap: 12 },
  cell: { flex: 1, gap: 2 },
  value: { fontSize: 18, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  label: { fontSize: 11, color: theme.colors.muted },
  caption: { fontSize: 11, lineHeight: 15, color: theme.colors.muted },
});
