import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { OutLink, StatusLine, arcStyles, useArcConfig } from "./ArcKit";
import { Tappable } from "./Press";
import { Button } from "./kit";
import { juno, type CircleChain, type Coin } from "../lib/api";
import { money } from "../lib/useApi";
import { useWallet } from "../lib/wallet";
import { theme } from "../theme";

/**
 * CCTP V2 destinations, used only until the server's config names its own
 * (`config.arc.cctp.destinations`). Circle's domain numbers.
 */
const FALLBACK: CircleChain[] = [
  { domain: 6, name: "Base" },
  { domain: 0, name: "Ethereum" },
  { domain: 3, name: "Arbitrum" },
  { domain: 2, name: "OP" },
  { domain: 7, name: "Polygon PoS" },
  { domain: 5, name: "Solana" },
];

type Burn = {
  symbol: string;
  hash: string;
  amount: number | null;
  explorerUrl?: string;
  status: "pending" | "complete" | "unknown" | "error";
};

/**
 * "Withdraw fees to…": a creator's trading fees, sent straight to another
 * chain as native USDC through Circle CCTP V2.
 *
 * `claimCreatorFeesCrossChain` burns the accrued USDC on Arc through
 * TokenMessengerV2; Circle attests the burn and the USDC is minted on the
 * chosen chain to the creator's address there (or another recipient). Arc is
 * final at once, so the attestation is not waiting on Arc. "Fast" pays Circle's
 * fast-transfer fee (finality threshold 1000); standard costs no fee (2000).
 * Each burn's attestation is polled from Circle's Iris API until it is
 * complete; the mint on the destination is then for anyone to relay.
 */
export function WithdrawFees({ creator, coins, onDone }: { creator: string; coins: Coin[]; onDone: () => void }) {
  const wallet = useWallet();
  const config = useArcConfig();
  const destinations = config?.arc?.cctp?.destinations?.length ? config.arc.cctp.destinations : FALLBACK;
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState<number>(destinations[0]?.domain ?? 6);
  const [recipient, setRecipient] = useState("");
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [burns, setBurns] = useState<Burn[]>([]);
  const owed = coins.filter((coin) => coin.creatorRewards > 0);
  const total = owed.reduce((sum, coin) => sum + coin.creatorRewards, 0);
  const destination = destinations.find((d) => d.domain === domain) ?? destinations[0];
  const toSolana = /solana/i.test(destination?.name ?? "");
  const needsRecipient = toSolana && !recipient.trim();

  // Poll Iris for every burn still pending: every 5 s, for up to 20 minutes.
  const startedAt = useRef(0);
  const pending = burns.filter((burn) => burn.status === "pending");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-armed only when the number of pending burns changes
  useEffect(() => {
    if (pending.length === 0) return;
    if (!startedAt.current) startedAt.current = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt.current > 20 * 60_000) return clearInterval(timer);
      const updates = await Promise.all(
        pending.map((burn) =>
          juno
            .cctpStatus(burn.hash)
            .then((answer) => ({ hash: burn.hash, status: answer.status }))
            .catch(() => ({ hash: burn.hash, status: "pending" as const })),
        ),
      );
      setBurns((current) =>
        current.map((burn) => {
          const update = updates.find((u) => u.hash === burn.hash);
          return update && update.status !== "unknown" ? { ...burn, status: update.status } : burn;
        }),
      );
    }, 5_000);
    return () => clearInterval(timer);
  }, [pending.length]);

  const withdraw = async () => {
    if (owed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    startedAt.current = 0;
    try {
      for (const coin of owed) {
        const built = await juno.claim({
          creator,
          token: coin.address,
          destinationDomain: domain,
          recipient: recipient.trim() || undefined,
          fast,
        });
        const results = await wallet.signAndSubmit(built.steps);
        const last = results[results.length - 1];
        setBurns((current) => [
          ...current,
          {
            symbol: coin.symbol,
            hash: last.hash,
            amount: built.cctp?.amount ?? coin.creatorRewards,
            explorerUrl: last.explorerUrl,
            status: "pending",
          },
        ]);
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The withdrawal did not go through.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        label="Withdraw fees to…"
        variant="quiet"
        onPress={() => setOpen(true)}
        disabled={owed.length === 0}
        style={{ alignSelf: "stretch", marginTop: 8 }}
      />
    );
  }

  return (
    <View style={[arcStyles.well, { marginTop: 10 }]} testID="cctp-withdraw">
      <View style={arcStyles.row}>
        <Text style={arcStyles.strong}>Withdraw fees to another chain</Text>
        <Text style={styles.tag}>CIRCLE CCTP V2</Text>
      </View>
      <Text style={arcStyles.body}>
        Burns your {money(total, "USD", { compact: false })} of fees on Arc and mints native USDC on {destination?.name ?? "the destination"}{" "}
        — no wrapped token, no bridge pool.
      </Text>
      <View style={styles.chips}>
        {destinations.map((d) => (
          <Tappable key={d.domain} onPress={() => setDomain(d.domain)} to={0.95} accessibilityRole="button" aria-selected={domain === d.domain}>
            <View style={[arcStyles.chip, domain === d.domain ? arcStyles.chipOn : null]}>
              <Text style={[arcStyles.chipText, domain === d.domain ? arcStyles.chipTextOn : null]}>{d.name}</Text>
            </View>
          </Tappable>
        ))}
      </View>
      <TextInput
        value={recipient}
        onChangeText={setRecipient}
        placeholder={toSolana ? "Solana recipient address (required)" : "Recipient (default: your address)"}
        placeholderTextColor={theme.colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={[arcStyles.input, { fontSize: 13 }]}
        accessibilityLabel="Recipient address"
      />
      <Tappable onPress={() => setFast((on) => !on)} to={0.97} accessibilityRole="switch" aria-checked={fast}>
        <View style={arcStyles.row}>
          <Text style={styles.option}>{fast ? "Fast transfer — pays Circle's fast fee" : "Standard transfer — no Circle fee"}</Text>
          <Text style={styles.toggle}>{fast ? "On" : "Off"}</Text>
        </View>
      </Tappable>
      <Button
        label={owed.length === 0 ? "Nothing to withdraw" : `Withdraw ${money(total, "USD", { compact: false })} to ${destination?.name ?? "…"}`}
        onPress={() => void withdraw()}
        loading={busy}
        disabled={owed.length === 0 || needsRecipient}
      />
      {error ? <StatusLine tone="neg">{error}</StatusLine> : null}
      {burns.map((burn) => (
        <View key={burn.hash} style={{ gap: 2 }}>
          <StatusLine tone={burn.status === "complete" ? "pos" : burn.status === "error" ? "neg" : "muted"}>
            ${burn.symbol}: {burn.amount !== null ? money(burn.amount, "USD", { compact: false }) : ""} burned on Arc ·{" "}
            {burn.status === "complete"
              ? `Circle attested it — USDC mints on ${destination?.name ?? "the destination"}.`
              : "waiting for Circle's attestation…"}
          </StatusLine>
          {burn.explorerUrl || juno.explorable() ? (
            <OutLink label="The burn on Arc's explorer" url={burn.explorerUrl ?? juno.explorer("tx", burn.hash)} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tag: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5, color: theme.colors.muted },
  option: { flex: 1, fontSize: 13, fontWeight: "700", color: theme.colors.text },
  toggle: { fontSize: 13, fontWeight: "800", color: theme.colors.focus },
});
