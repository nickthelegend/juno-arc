import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { ArcCard, OutLink, StatusLine, arcStyles, useArcConfig } from "./ArcKit";
import { Tappable } from "./Press";
import { Button } from "./kit";
import { CCIP_EXPLORER, juno, type CcipBucket, type CcipLane, type CcipSendBuild, type Coin } from "../lib/api";
import { tokens, useApi } from "../lib/useApi";
import { useWallet } from "../lib/wallet";
import { theme } from "../theme";

/**
 * A graduated coin as a Chainlink CCIP Cross-Chain Token.
 *
 * Once a curve has graduated, its creator can make the coin cross-chain in
 * one transaction: `JunoCrossChain.enable` deploys Chainlink's own
 * BurnMintTokenPool for it and registers it with CCIP's token admin registry.
 * From then on anyone holding the coin can send it over a CCIP lane — Base
 * Sepolia, Ethereum Sepolia — where it is **burned on Arc and minted on the
 * destination**. Arc's supply can only go down when it leaves and back up when
 * it returns, so it can never exceed the launch supply. Every pool lane carries
 * a rate limit, shown here as the pool reports it.
 *
 * The CCIP fee is paid in native USDC with the send, so the holder still needs
 * nothing but USDC. Each send links to Chainlink's CCIP Explorer.
 */
export function CrossChainCard({ coin }: { coin: Coin }) {
  const wallet = useWallet();
  const config = useArcConfig();
  const view = useApi(() => juno.ccip(coin.address), [coin.address]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string } | null>(null);
  const isCreator = !!wallet.address && wallet.address.toLowerCase() === coin.creator.wallet.toLowerCase();
  const data = view.data;

  const enable = async () => {
    if (!wallet.address) return;
    setBusy(true);
    setMessage(null);
    try {
      const built = await juno.ccipEnable({ token: coin.address, creator: wallet.address });
      await wallet.signAndSubmit(built.steps);
      setMessage({ tone: "pos", text: `$${coin.symbol} is now a CCIP Cross-Chain Token.` });
      view.refresh();
    } catch (caught) {
      setMessage({ tone: "neg", text: caught instanceof Error ? caught.message : "Enabling CCIP did not go through." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ArcCard title="Cross-chain" tag="CHAINLINK CCIP" testID="ccip-card">
      <Text style={arcStyles.body}>
        Sent over Chainlink CCIP, ${coin.symbol} is burned on Arc and minted on the destination. Arc&rsquo;s supply can
        never exceed the launch supply — what leaves is burned, what returns is re-minted.
      </Text>

      {view.loading ? (
        <StatusLine>Reading its CCIP pool…</StatusLine>
      ) : view.error || !data ? (
        <StatusLine tone="neg">CCIP status could not be read: {view.error ?? "no answer"}.</StatusLine>
      ) : !data.enabled ? (
        <View style={{ gap: 10 }}>
          <StatusLine>Not cross-chain yet.</StatusLine>
          {isCreator && data.canEnable ? (
            <>
              <Button label="Make it cross-chain (CCIP)" onPress={() => void enable()} loading={busy} />
              <Text style={styles.foot}>
                One transaction: deploys Chainlink&rsquo;s BurnMintTokenPool for ${coin.symbol}, registers it with CCIP and
                wires the lanes. Gas in USDC.
              </Text>
            </>
          ) : isCreator ? (
            <StatusLine>It can be made cross-chain once its curve graduates.</StatusLine>
          ) : (
            <StatusLine>Its creator can make it a CCIP Cross-Chain Token in one transaction.</StatusLine>
          )}
        </View>
      ) : (
        <Enabled coin={coin} view={data} lanes={data.lanes.length ? data.lanes : (config?.arc?.ccip?.lanes ?? [])} onSent={view.refresh} />
      )}

      {message ? <StatusLine tone={message.tone}>{message.text}</StatusLine> : null}
    </ArcCard>
  );
}

function Enabled({
  coin,
  view,
  lanes,
  onSent,
}: {
  coin: Coin;
  view: NonNullable<ReturnType<typeof useApi<import("../lib/api").CcipView>>["data"]>;
  lanes: CcipLane[];
  onSent: () => void;
}) {
  const wallet = useWallet();
  const [lane, setLane] = useState<string | null>(lanes[0]?.selector ?? null);
  const [amount, setAmount] = useState("");
  const [built, setBuilt] = useState<CcipSendBuild | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ messageId: string | null; hash: string; explorerUrl?: string; lane: string } | null>(null);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;
  const laneName = lanes.find((l) => l.selector === lane)?.name ?? "the destination";

  // The fee depends on the lane, so the send is built (and its USDC fee shown) before it is signed.
  useEffect(() => {
    setBuilt(null);
    setError(null);
    if (!valid || !lane || !wallet.address) return;
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const next = await juno.ccipSend({ token: coin.address, owner: wallet.address!, amount: value, destination: lane });
        if (!cancelled) setBuilt(next);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not build the transfer.");
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [valid, value, lane, coin.address, wallet.address]);

  const send = async () => {
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      const results = await wallet.signAndSubmit(built.steps);
      const last = results[results.length - 1];
      setSent({ messageId: last.ccipMessageId ?? null, hash: last.hash, explorerUrl: last.explorerUrl, lane: built.lane?.name ?? laneName });
      setAmount("");
      onSent();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transfer did not go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={arcStyles.well}>
        <View style={arcStyles.row}>
          <Text style={arcStyles.micro}>Bridged out</Text>
          <Text style={arcStyles.strong} testID="ccip-bridged">
            {tokens(amountOf(view.bridgedOut))} ${coin.symbol}
          </Text>
        </View>
        {view.chains.length === 0 ? (
          <StatusLine>No lanes wired on its pool yet.</StatusLine>
        ) : (
          view.chains.map((chain) => (
            <View key={chain.selector} style={{ gap: 2 }}>
              <View style={arcStyles.row}>
                <Text style={styles.chain}>{chain.name}</Text>
                <Text style={styles.wired}>{chain.remoteToken ? "wired" : "lane open"}</Text>
              </View>
              <Text style={styles.limit}>{limitLine("Out", chain.outbound)} · {limitLine("In", chain.inbound)}</Text>
            </View>
          ))
        )}
        {view.pool ? (
          <Text style={styles.foot} numberOfLines={1} ellipsizeMode="middle">
            Pool {view.pool}
            {view.handedOver ? " · admin handed to the creator" : ""}
          </Text>
        ) : null}
      </View>

      {lanes.length > 0 ? (
        <View style={styles.chips}>
          {lanes.map((l) => (
            <Tappable key={l.selector} onPress={() => setLane(l.selector)} to={0.95} accessibilityRole="button" aria-selected={lane === l.selector}>
              <View style={[arcStyles.chip, lane === l.selector ? arcStyles.chipOn : null]}>
                <Text style={[arcStyles.chipText, lane === l.selector ? arcStyles.chipTextOn : null]}>{l.name}</Text>
              </View>
            </Tappable>
          ))}
        </View>
      ) : null}

      <TextInput
        value={amount}
        onChangeText={(next) => setAmount(next.replace(/[^0-9.]/g, ""))}
        placeholder={`Amount of $${coin.symbol}`}
        placeholderTextColor={theme.colors.faint}
        keyboardType="decimal-pad"
        style={arcStyles.input}
        accessibilityLabel={`Amount of ${coin.symbol} to send`}
      />
      {wallet.address ? (
        <Button
          label={busy ? "Sending…" : `Send to ${laneName}`}
          onPress={() => void send()}
          loading={busy}
          disabled={!built || quoting || busy}
        />
      ) : (
        <Button label="Create a wallet to send" onPress={() => void wallet.connect()} />
      )}
      {quoting ? (
        <StatusLine>Quoting the CCIP fee…</StatusLine>
      ) : built ? (
        <StatusLine testID="ccip-fee">
          CCIP fee ${built.fee.usdc < 0.01 ? built.fee.usdc.toPrecision(2) : built.fee.usdc.toFixed(2)}, paid in USDC with
          the send. Delivery takes minutes (source-chain finality plus Chainlink&rsquo;s DON).
        </StatusLine>
      ) : null}
      {error ? <StatusLine tone="neg">{error}</StatusLine> : null}
      {sent ? (
        <View style={{ gap: 4 }}>
          <StatusLine tone="pos">Sent to {sent.lane}: burned on Arc; Chainlink mints it on the destination.</StatusLine>
          {sent.messageId ? (
            <OutLink label="Track it on CCIP Explorer" url={`${CCIP_EXPLORER}/msg/${sent.messageId}`} />
          ) : (
            <StatusLine>The receipt carried no CCIP message id.</StatusLine>
          )}
          {sent.explorerUrl ? <OutLink label="View on Arc's explorer" url={sent.explorerUrl} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A pool figure: a token count, or 18-decimal base units as a string. */
function amountOf(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return typeof value === "string" && /^\d{16,}$/.test(value) ? n / 1e18 : n;
}

function limitLine(direction: string, bucket: CcipBucket | null): string {
  if (!bucket || !bucket.isEnabled) return `${direction}: no limit set`;
  return `${direction}: ${tokens(amountOf(bucket.tokens))} of ${tokens(amountOf(bucket.capacity))} available, refills ${tokens(amountOf(bucket.rate))}/s`;
}

const styles = StyleSheet.create({
  chain: { fontSize: 13, fontWeight: "800", color: theme.colors.text },
  wired: { fontSize: 11, fontWeight: "800", color: theme.colors.pos },
  limit: { fontSize: 11, lineHeight: 15, color: theme.colors.muted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  foot: { fontSize: 11, lineHeight: 15, color: theme.colors.faint },
});
