import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";

import { OutLink, seconds } from "./ArcKit";
import { juno, txFee, type MemoTag } from "../lib/api";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * The receipt that shows why this runs on Arc.
 *
 * One measured figure leads: the time from submit to a receipt in hand, timed
 * by Juno's server. On Arc a receipt *is* final — deterministic, sub-second,
 * no reorgs — so that figure is the finality, not a promise of it. Under it:
 * whether the trade was tagged with its post through Arc Memo, what the gas
 * cost in USDC (the only token the wallet holds), and the explorer link.
 * Every figure is measured or read; one that could not be read is left out
 * rather than estimated.
 */
export function SpeedReceipt({
  txHash,
  confirmMs,
  signedInMs,
  memo,
  explorerUrl,
  gasless = false,
  curveTrade = true,
}: {
  txHash: string;
  /** Submit to receipt, as the server measured it. */
  confirmMs: number | null;
  /** Signing on this device, as the sheet measured it. Null when not measured. */
  signedInMs: number | null;
  /** How the trade was tagged through Arc Memo; null when the server did not say. */
  memo?: MemoTag | null;
  explorerUrl?: string | null;
  /** Relayed with an EIP-3009 signature: Juno's relayer paid the gas. */
  gasless?: boolean;
  /** A curve buy or sell — the trades Memo tags. */
  curveTrade?: boolean;
}) {
  const cost = useApi(() => juno.txCost(txHash), [txHash]);
  const fork = juno.loadedConfig()?.localFork ?? false;
  // The cost is read from the receipt the server just recorded; a read that
  // lands a moment too early is asked again a few times, quietly.
  const tries = useRef(0);
  const { poll } = cost;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new error is what asks for the next retry.
  useEffect(() => {
    if (cost.data || cost.loading || tries.current >= 4) return;
    const timer = setTimeout(() => {
      tries.current += 1;
      poll();
    }, 1200);
    return () => clearTimeout(timer);
  }, [cost.data, cost.loading, cost.error, poll]);
  const fee = txFee(cost.data);
  const ethereum = (cost.data?.ethereum ?? null) as { feeUsd: number | null; blockSeconds: number } | null;
  // A local fork's transactions exist on no public explorer: no link there.
  const link = juno.explorable() ? (explorerUrl ?? juno.explorer("tx", txHash)) : null;

  return (
    <View style={styles.wrap}>
      {confirmMs !== null ? (
        <View style={styles.hero} accessibilityLabel={`Final in ${seconds(confirmMs)} on Arc`} testID="receipt-final">
          <Text style={styles.timerLabel}>Final</Text>
          <View style={styles.heroRow}>
            <Text testID="speed-ms" style={styles.ms}>
              {confirmMs < 100 ? Math.max(1, Math.round(confirmMs)) : (confirmMs / 1000).toFixed(confirmMs < 10_000 ? 1 : 0)}
            </Text>
            <Text style={styles.unit}>{confirmMs < 100 ? "ms" : "s"}</Text>
          </View>
          <Text style={styles.heroLead}>
            Final in {seconds(confirmMs)} on Arc — deterministic, no reorgs.
          </Text>
          <Text style={styles.heroCaption}>
            Submit to receipt{fork ? " on a local Arc fork" : ""}, measured by Juno&rsquo;s server. On Arc the receipt is
            the finality: nothing to wait for after it.
          </Text>
        </View>
      ) : (
        <Text style={styles.heroLead}>Final on Arc — a receipt there is deterministic, with no reorgs.</Text>
      )}

      <View style={styles.steps}>
        <Step label="Signed here" value={signedInMs === null ? null : `${signedInMs} ms`} />
        <View style={styles.link} />
        <Step label={gasless ? "Relayed" : "Submitted"} value={confirmMs === null ? null : seconds(confirmMs)} />
        <View style={styles.link} />
        <Step label="Block" value={cost.data ? `#${cost.data.blockNumber.toLocaleString("en-US")}` : null} />
      </View>

      {curveTrade ? (
        memo ? (
          <View style={[styles.memo, memo.tagged ? styles.memoOn : null]} testID="receipt-memo">
            <Text style={styles.memoTitle}>
              {memo.tagged ? "Tagged with this post via Arc Memo" : "Memo not live on this RPC — sent as a plain call"}
            </Text>
            <Text style={styles.memoId} numberOfLines={1} ellipsizeMode="middle" selectable>
              memo id {memo.id}
            </Text>
            {memo.tagged ? (
              <Text style={styles.memoCaption}>
                Arc&rsquo;s Memo contract made the call as your wallet and logged this post&rsquo;s id beside it, so the
                trade is findable by post on chain.
              </Text>
            ) : null}
          </View>
        ) : null
      ) : null}

      <View style={styles.cost}>
        <View style={styles.costRow}>
          <Text style={styles.costLabel}>Gas</Text>
          <Text testID="speed-fee" style={styles.costValue}>
            {gasless ? "$0 to you — paid by Juno's relayer" : fee ? `${usd(fee.feeUsdc)} in USDC` : "≈ $0.001, paid in USDC"}
          </Text>
        </View>
        <Text style={styles.costCaption}>
          {gasless
            ? "You signed an EIP-3009 authorisation; the relayer submitted it and paid the USDC gas."
            : fee
              ? `${fee.gasUsed.toLocaleString("en-US")} gas${fee.gasPriceGwei !== null ? ` at ${gwei(fee.gasPriceGwei)} gwei` : ""}. Arc charges gas in USDC — no second token to hold.`
              : "Arc charges gas in USDC — the same balance you trade with."}
        </Text>
        {!gasless && fee && ethereum?.feeUsd ? (
          <Text style={styles.costCaption} testID="speed-ethereum">
            The same gas on Ethereum mainnet right now: {usd(ethereum.feeUsd)}, with {ethereum.blockSeconds} s blocks.
          </Text>
        ) : null}
      </View>

      {link ? <OutLink label="View on Arc's explorer" url={link} /> : null}
    </View>
  );
}

function Step({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.step}>
      <View style={[styles.dot, value !== null ? styles.dotOn : null]} />
      <Text style={styles.stepLabel}>{label}</Text>
      <Text style={styles.stepValue}>{value ?? "—"}</Text>
    </View>
  );
}

function usd(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value === 0) return "$0";
  const decimals = Math.min(12, 1 - Math.floor(Math.log10(value)));
  return `$${value.toFixed(decimals)}`;
}

function gwei(value: number): string {
  return value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toPrecision(2);
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", gap: 14, marginTop: 6 },
  hero: { alignItems: "center", gap: 2 },
  timerLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", color: theme.colors.muted },
  heroRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  ms: {
    fontSize: 48,
    lineHeight: 54,
    fontWeight: "800",
    letterSpacing: -2,
    color: theme.colors.text,
    fontVariant: ["tabular-nums"],
  },
  unit: { fontSize: 22, fontWeight: "800", color: theme.colors.pos },
  heroLead: { fontSize: 14, lineHeight: 19, fontWeight: "800", color: theme.colors.text, textAlign: "center" },
  heroCaption: { fontSize: 12, lineHeight: 16, color: theme.colors.muted, textAlign: "center", maxWidth: 320, marginTop: 2 },
  steps: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center" },
  step: { alignItems: "center", gap: 4, minWidth: 78 },
  link: { height: 2, width: 18, backgroundColor: theme.colors.lime, marginTop: 5 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.line },
  dotOn: { backgroundColor: theme.colors.pos },
  stepLabel: { fontSize: 11, fontWeight: "700", color: theme.colors.muted },
  stepValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  memo: { borderRadius: theme.radius.md, padding: 12, gap: 4, backgroundColor: theme.colors.surfaceAlt },
  memoOn: { backgroundColor: theme.colors.limeSoft },
  memoTitle: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  memoId: { fontSize: 11, color: theme.colors.muted, fontFamily: "monospace" },
  memoCaption: { fontSize: 11, lineHeight: 15, color: theme.colors.muted },
  cost: { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius.md, padding: 14 },
  costRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  costLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.text, flexShrink: 1 },
  costValue: { fontSize: 13, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" },
  costCaption: { fontSize: 11, lineHeight: 15, color: theme.colors.muted, marginTop: 4 },
});
