import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { ArcCard, OutLink, StatusLine, arcStyles, reason, useArcConfig } from "./ArcKit";
import { Tappable } from "./Press";
import { Button } from "./kit";
import { juno, type GatewayBalances } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useWallet } from "../lib/wallet";
import { theme } from "../theme";

/** Arc's CCTP / Gateway domain. */
const ARC_DOMAIN = 26;

/**
 * Circle Gateway: one USDC balance across chains.
 *
 * USDC deposited into Circle's Gateway Wallet on any supported chain is one
 * unified balance. Spending it on Arc is a signed burn intent: Circle attests
 * it, Juno's relayer calls `GatewayMinter.gatewayMint` on Arc, and the USDC
 * lands in this wallet — ready to buy a post — without bridging by hand.
 *
 * - **Deposit from Arc**: approve + `GatewayWallet.deposit` on Arc (two
 *   transactions this device signs).
 * - **Spend from Base, Ethereum…**: sign the burn intent (EIP-712, domain
 *   "GatewayWallet" v1) → `/gateway/mint` → USDC on Arc.
 *
 * Balances come from Circle's Gateway API (`/v1/balances`) through Juno's
 * server; when it cannot be read the card says so instead of showing $0.
 */
export function GatewayCard({ address }: { address: string }) {
  const config = useArcConfig();
  const gw = config?.arc?.gateway;
  const balances = useApi(() => juno.gateway(address), [address]);

  if (gw && gw.available === false) {
    return (
      <ArcCard title="Unified USDC balance" tag="CIRCLE GATEWAY" testID="gateway-card">
        <StatusLine>Circle Gateway is not available on this server.</StatusLine>
      </ArcCard>
    );
  }

  return (
    <ArcCard title="Unified USDC balance" tag="CIRCLE GATEWAY" testID="gateway-card">
      <Text style={arcStyles.body}>
        USDC you deposit into Circle Gateway on any chain is one balance. Spend it here and it lands on Arc in seconds,
        ready to buy into a post.
      </Text>
      <GatewayPanel address={address} balances={balances} />
    </ArcCard>
  );
}

/**
 * The working part: balances per chain, deposit from Arc, spend to Arc.
 * Used by the wallet card and, compact, by the trade sheet's "Top up".
 */
export function GatewayPanel({
  address,
  balances,
  compact = false,
  suggest,
  onLanded,
}: {
  address: string;
  balances: ReturnType<typeof useApi<GatewayBalances>>;
  compact?: boolean;
  /** An amount to pre-fill: what the trade is short by. */
  suggest?: number;
  /** USDC arrived on Arc (or a deposit landed): re-read balances. */
  onLanded?: () => void;
}) {
  const wallet = useWallet();
  const config = useArcConfig();
  const [amount, setAmount] = useState(suggest ? String(Math.ceil(suggest * 100) / 100) : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string; url?: string } | null>(null);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;
  const data = balances.data;
  const sources = data?.balances ?? [];
  const names = new Map<number, string>([
    ...(config?.arc?.gateway?.sources ?? []).map((s) => [s.domain, s.name] as const),
    ...(data?.sources ?? []).map((s) => [s.domain, s.name] as const),
  ]);
  const funded = sources.filter((b) => b.balance > 0);

  const deposit = async () => {
    if (!valid) return;
    setBusy("deposit");
    setMessage(null);
    try {
      const built = await juno.gatewayDeposit({ owner: address, amount: value });
      const results = await wallet.signAndSubmit(built.steps);
      const last = results[results.length - 1];
      setMessage({
        tone: "pos",
        text: `Deposited $${value} from Arc into Circle Gateway. Circle credits it to your unified balance once it sees the deposit.`,
        url: last?.explorerUrl ?? (juno.explorable() ? juno.explorer("tx", last.hash) : undefined),
      });
      balances.refresh();
      onLanded?.();
    } catch (caught) {
      setMessage({ tone: "neg", text: caught instanceof Error ? caught.message : "The deposit did not go through." });
    } finally {
      setBusy(null);
    }
  };

  const spend = async (domain: number) => {
    if (!valid) return;
    setBusy(`spend-${domain}`);
    setMessage(null);
    try {
      const intent = await juno.gatewayIntent({ depositor: address, sourceDomain: domain, recipient: address, amount: value });
      const signature = await wallet.signTypedData(intent.typedData);
      const minted = await juno.gatewayMint({ burnIntent: intent.typedData.message, signature });
      setMessage({
        tone: "pos",
        text: `$${minted.amount ?? value} USDC from ${names.get(domain) ?? `domain ${domain}`} landed on Arc (Circle fee up to $${intent.maxFee}).`,
        url: minted.explorerUrl ?? (minted.mintTxHash && juno.explorable() ? juno.explorer("tx", minted.mintTxHash) : undefined),
      });
      balances.refresh();
      onLanded?.();
    } catch (caught) {
      setMessage({ tone: "neg", text: caught instanceof Error ? caught.message : "Circle Gateway refused the transfer." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={arcStyles.well}>
        <View style={arcStyles.row}>
          <Text style={arcStyles.micro}>Gateway total</Text>
          <Text style={arcStyles.figure} testID="gateway-total">
            {balances.loading ? "…" : data && data.available !== false && !balances.error ? `$${fmt(data.total)}` : "—"}
          </Text>
        </View>
        {balances.error || data?.available === false || data?.error ? (
          <StatusLine tone="neg">
            {reason(data?.error ?? balances.error, "Circle's Gateway API did not answer")} Balances are read from
            Circle&rsquo;s Gateway API.
          </StatusLine>
        ) : sources.length === 0 && !balances.loading ? (
          <StatusLine>Nothing deposited yet on any chain.</StatusLine>
        ) : (
          sources.map((b) => (
            <View key={b.domain} style={arcStyles.row}>
              <Text style={styles.chain}>
                {b.name || names.get(b.domain) || `Domain ${b.domain}`}
                {b.domain === ARC_DOMAIN ? " (Arc)" : ""}
              </Text>
              <Text style={styles.amount}>${fmt(b.balance)}</Text>
            </View>
          ))
        )}
      </View>

      <TextInput
        value={amount}
        onChangeText={(next) => setAmount(next.replace(/[^0-9.]/g, ""))}
        placeholder="Amount in USDC"
        placeholderTextColor={theme.colors.faint}
        keyboardType="decimal-pad"
        style={arcStyles.input}
        accessibilityLabel="Amount in USDC"
      />

      {funded.length > 0 ? (
        <View style={styles.wrap}>
          {funded.map((b) => (
            <Button
              key={b.domain}
              label={`Spend from ${b.name || names.get(b.domain) || `domain ${b.domain}`}`}
              variant="lime"
              onPress={() => void spend(b.domain)}
              loading={busy === `spend-${b.domain}`}
              disabled={!valid || busy !== null || value > b.balance}
              style={{ flexGrow: 1 }}
            />
          ))}
        </View>
      ) : (
        <StatusLine>
          Deposit USDC into Gateway on Base, Ethereum or another supported chain (or from Arc below), and it can be spent
          here.
        </StatusLine>
      )}

      {compact ? null : (
        <Button
          label="Deposit from Arc"
          variant="quiet"
          onPress={() => void deposit()}
          loading={busy === "deposit"}
          disabled={!valid || busy !== null}
        />
      )}

      {message ? (
        <View style={{ gap: 4 }}>
          <StatusLine tone={message.tone} testID="gateway-message">
            {message.text}
          </StatusLine>
          {message.url ? <OutLink label="View on Arc's explorer" url={message.url} /> : null}
        </View>
      ) : null}

      <Text style={styles.foot}>
        Spending signs a burn intent (EIP-712); Circle attests it and Juno&rsquo;s relayer submits{" "}
        <Text style={{ fontWeight: "800" }}>gatewayMint</Text> on Arc.
      </Text>
    </View>
  );
}

/**
 * The trade sheet's "Top up from Gateway": shown when Arc USDC is short of
 * the buy, it brings the shortfall over from the unified balance.
 */
export function GatewayTopUp({ address, short, onLanded }: { address: string; short: number; onLanded: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Tappable onPress={() => setOpen(true)} to={0.97} accessibilityRole="button" accessibilityLabel="Top up from Circle Gateway">
        <View style={styles.topUp} testID="gateway-topup">
          <Text style={styles.topUpText}>Top up from Gateway</Text>
          <Text style={styles.topUpCaption}>Bring USDC from Base, Ethereum… to Arc in seconds (Circle Gateway)</Text>
        </View>
      </Tappable>
    );
  }
  return <GatewayTopUpOpen address={address} short={short} onLanded={onLanded} />;
}

function GatewayTopUpOpen({ address, short, onLanded }: { address: string; short: number; onLanded: () => void }) {
  const balances = useApi(() => juno.gateway(address), [address]);
  return (
    <View style={[arcStyles.well, styles.topUpOpen]}>
      <Text style={arcStyles.strong}>Top up from Circle Gateway</Text>
      <GatewayPanel address={address} balances={balances} compact suggest={short} onLanded={onLanded} />
    </View>
  );
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value.toFixed(2);
}

const styles = StyleSheet.create({
  chain: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  amount: { fontSize: 13, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  foot: { fontSize: 11, lineHeight: 15, color: theme.colors.faint },
  topUpOpen: { backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.lineStrong },
  topUp: {
    padding: 12,
    gap: 2,
    borderRadius: theme.radius.md,
    borderWidth: 1.5,
    borderColor: theme.colors.ink,
    alignItems: "center",
  },
  topUpText: { fontSize: 14, fontWeight: "800", color: theme.colors.text },
  topUpCaption: { fontSize: 11, color: theme.colors.muted, textAlign: "center" },
});
