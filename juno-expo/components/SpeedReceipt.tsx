import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";

import { OutLink, seconds } from "./ArcKit";
import { Button } from "./kit";
import { API_URL, juno, txFee, type MemoTag } from "../lib/api";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * The receipt that shows why this runs on Arc, at a glance.
 *
 * One measured figure leads: the time from submit to a receipt in hand, timed
 * by Juno's server. On Arc a receipt *is* final — deterministic, sub-second,
 * no reorgs — so that figure is the finality, not a promise of it. Under it,
 * one comparison: what the gas cost in USDC (the only token the wallet holds)
 * against the same gas on Ethereum right now. Whether the trade was tagged
 * with its post through Arc Memo stays in view; the rest (signing time,
 * block, gas, the explorer link) folds under Details. Every figure is
 * measured or read; one that could not be read is left out rather than
 * estimated.
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
  const [details, setDetails] = useState(false);
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
  const ethereum = (cost.data?.ethereum ?? null) as { feeUsd: number | null; gasPriceGwei: number; blockSeconds: number } | null;
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
          <Text style={styles.heroLead}>Final in {seconds(confirmMs)} on Arc — deterministic, no reorgs.</Text>
          <Text style={styles.heroCaption}>
            Submit to receipt{fork ? " on a local Arc fork" : ""}, measured by Juno&rsquo;s server. On Arc the receipt is
            the finality: nothing to wait for after it.
          </Text>
        </View>
      ) : (
        <Text style={styles.heroLead}>Final on Arc — a receipt there is deterministic, with no reorgs.</Text>
      )}

      <View style={styles.compare}>
        <View style={styles.compareCell}>
          <Text style={styles.compareLabel}>{gasless ? "Gas, to you" : "Paid here"}</Text>
          <Text testID="speed-fee" style={styles.compareValue}>
            {gasless ? "$0" : fee ? usd(fee.feeUsdc) : "≈ $0.004"}
          </Text>
          <Text style={styles.compareCaption}>{gasless ? "paid by Juno's relayer" : "in USDC, the only token held"}</Text>
        </View>
        {!gasless && fee && ethereum?.feeUsd ? (
          <View style={styles.compareCell}>
            <Text style={styles.compareLabel}>Same gas on Ethereum</Text>
            <Text testID="speed-ethereum" style={[styles.compareValue, { color: theme.colors.neg }]}>
              {usd(ethereum.feeUsd)}
            </Text>
            <Text style={styles.compareCaption}>{ethereum.blockSeconds} s blocks, right now</Text>
          </View>
        ) : null}
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

      <Pressable
        onPress={() => setDetails((open) => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: details }}
        style={styles.detailsToggle}
        testID="speed-details-toggle"
      >
        <Text style={styles.detailsToggleText}>{details ? "Hide details" : "Details"}</Text>
      </Pressable>
      {details ? (
        <View style={styles.cost} testID="speed-details">
          <Detail label="Signed here" value={signedInMs === null ? "—" : `${signedInMs} ms`} />
          <Detail label={gasless ? "Relayed" : "Submitted"} value={confirmMs === null ? "—" : seconds(confirmMs)} />
          <Detail label="Block" value={cost.data ? `#${cost.data.blockNumber.toLocaleString("en-US")}` : "—"} />
          <Detail
            label="Gas"
            value={
              gasless
                ? "paid by Juno's relayer (EIP-3009)"
                : fee
                  ? `${fee.gasUsed.toLocaleString("en-US")} used${fee.gasPriceGwei !== null ? ` at ${gwei(fee.gasPriceGwei)} gwei` : ""}, in USDC`
                  : "—"
            }
          />
          {ethereum ? <Detail label="Ethereum" value={`${gwei(ethereum.gasPriceGwei)} gwei${ethereum.feeUsd === null ? "" : ", priced with Chainlink ETH/USD"}`} /> : null}
          {link ? <OutLink label="View on Arc's explorer" url={link} /> : null}
        </View>
      ) : null}

      <ShareCard txHash={txHash} />
    </View>
  );
}

/**
 * The receipt as an image, for posting: `GET /tx/card` draws it on the
 * server from the server's own figures, so what is shared is what was
 * measured. Shown on request, then shared as a file where the browser can
 * (a phone's share sheet), downloaded where it cannot, or copied as a link.
 */
function ShareCard({ txHash }: { txHash: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const url = `${API_URL}/api/juno/tx/card?hash=${txHash}`;

  const share = async () => {
    setNote(null);
    try {
      if (Platform.OS !== "web") {
        await Share.share({ url, message: "My trade on Juno, on Arc" });
        return;
      }
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `juno-receipt-${txHash.slice(2, 10)}.png`, { type: "image/png" });
      const nav = globalThis.navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: "My Juno receipt" });
        return;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(link.href);
      setNote("Saved the image.");
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      setNote("Could not share the image. Copy the link instead.");
    }
  };

  const copy = async () => {
    await Clipboard.setStringAsync(url);
    setNote("Link copied.");
  };

  if (!open) {
    return <Button label="Share this receipt" variant="quiet" onPress={() => setOpen(true)} />;
  }
  return (
    <View style={styles.share} testID="receipt-card">
      <Image source={{ uri: url }} style={styles.card} accessibilityLabel="Your receipt, as an image" resizeMode="contain" />
      <View style={styles.shareRow}>
        <Button label={Platform.OS === "web" ? "Share image" : "Share"} onPress={() => void share()} style={{ flex: 1 }} />
        <Button label="Copy link" variant="quiet" onPress={() => void copy()} style={{ flex: 1 }} />
      </View>
      {note ? <Text style={styles.shareNote}>{note}</Text> : null}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
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
  compare: { flexDirection: "row", gap: 8 },
  compareCell: { flex: 1, backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius.md, padding: 12, alignItems: "center", gap: 2 },
  compareLabel: { fontSize: 12, fontWeight: "700", color: theme.colors.muted, textAlign: "center" },
  compareValue: { fontSize: 20, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  compareCaption: { fontSize: 11, color: theme.colors.muted, textAlign: "center" },
  memo: { borderRadius: theme.radius.md, padding: 12, gap: 4, backgroundColor: theme.colors.surfaceAlt },
  memoOn: { backgroundColor: theme.colors.limeSoft },
  memoTitle: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  memoId: { fontSize: 11, color: theme.colors.muted, fontFamily: "monospace" },
  memoCaption: { fontSize: 11, lineHeight: 15, color: theme.colors.muted },
  detailsToggle: { alignSelf: "center", paddingVertical: 4, paddingHorizontal: 10 },
  detailsToggleText: { fontSize: 13, fontWeight: "700", color: theme.colors.muted, textDecorationLine: "underline" },
  cost: { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius.md, padding: 14, gap: 2 },
  detail: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 3 },
  detailLabel: { fontSize: 12, color: theme.colors.muted },
  detailValue: { fontSize: 12, fontWeight: "700", color: theme.colors.text, flexShrink: 1, textAlign: "right" },
  share: { gap: 8 },
  card: { width: "100%", aspectRatio: 1200 / 630, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceAlt },
  shareRow: { flexDirection: "row", gap: 8 },
  shareNote: { fontSize: 12, color: theme.colors.muted, textAlign: "center" },
});
