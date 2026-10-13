import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { CoinArt, Identicon } from "./art";
import { Button, Caption } from "./kit";
import { api, juno, onTestnet } from "../lib/api";
import { topCreatorOf } from "../lib/discover";
import { loadMarkets } from "../lib/markets";
import { useApi } from "../lib/useApi";
import { useWallet } from "../lib/wallet";
import { theme } from "../theme";

/**
 * Profile, before there is a wallet: what you get, and one tap to get it.
 *
 * The empty profile used to be a heading and a button, a weak second screen
 * for anyone who opened it first. It now shows:
 * - what a profile is, with a real one from the feed to open as the example
 *   (the creator with the most posts, and their own figures);
 * - what starting costs, read from the server: the faucet's USDC on testnet,
 *   and that USDC is also the gas;
 * - one button that makes the account: a key on this device, no sign-up.
 */
export function WalletPreview() {
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testnet = onTestnet();
  const faucet = useApi(() => (testnet ? api.get<{ amount: number }>("/api/juno/faucet").catch(() => null) : Promise.resolve(null)), [testnet]);
  const markets = useApi(() => loadMarkets(), []);
  const example = useMemo(() => topCreatorOf(markets.data?.posts ?? []), [markets.data?.posts]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await wallet.connect();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap} testID="wallet-preview">
      <Text style={styles.kicker}>Your profile</Text>
      <Text style={styles.title}>Post a photo. It becomes a coin. You earn its trading fees.</Text>

      <View style={styles.card}>
        <Point n="1" title="Every post is a market" detail="A photo or a reel launches its own bonding curve on Arc, in one transaction." />
        <Point
          n="2"
          title="Creators earn the fees"
          detail="Your coins' trading fees are yours to claim. Your profile adds them up, from the chain."
        />
        <Point
          n="3"
          title={testnet ? (faucet.data ? `${faucet.data.amount} USDC to start` : "Testnet USDC to start") : "USDC is the only token"}
          detail={
            testnet
              ? "Juno's faucet pays a new wallet testnet USDC, enough for a launch and a few buys. USDC is also the gas."
              : "It is what you trade with and what pays the gas. There is no second token to hold."
          }
        />
      </View>

      {example ? (
        <Pressable
          style={styles.example}
          onPress={() => router.push(`/trader/${example.wallet}` as never)}
          accessibilityRole="link"
          accessibilityLabel={`Open ${example.name}'s profile`}
          testID="preview-example"
        >
          <Identicon seed={example.wallet} size={40} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.exampleName} numberOfLines={1}>
              {example.name}
            </Text>
            <Caption numberOfLines={1}>
              Example: a creator on Juno · {example.posts} {example.posts === 1 ? "post" : "posts"}
              {example.holders > 0 ? ` · ${example.holders.toLocaleString("en-US")} holders` : ""}
            </Caption>
          </View>
          <View style={styles.thumbs}>
            {example.coins.slice(0, 3).map((coin) => (
              <CoinArt key={coin.address} uri={juno.still(coin.media)} seed={coin.address} size={34} radius={8} />
            ))}
          </View>
        </Pressable>
      ) : null}

      <View style={styles.actions}>
        {/* Not `.then(portfolio.refresh)`: the address change re-reads on its
            own, and a refresh captured before the wallet existed lands last
            with "Holdings could not be read". */}
        <Button
          label={busy ? "Making a key…" : "Create wallet"}
          variant="lime"
          tall
          loading={busy}
          onPress={() => void create()}
          style={{ alignSelf: "stretch" }}
        />
        <Text style={styles.note}>No sign-up: a key made on this device, holding USDC on Arc.</Text>
        <View style={styles.links}>
          <Pressable onPress={() => router.push("/arc" as never)} accessibilityRole="link">
            <Text style={styles.link}>What runs on Arc</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

function Point({ n, title, detail }: { n: string; title: string; detail: string }) {
  return (
    <View style={styles.point}>
      <View style={styles.pointMark}>
        <Text style={styles.pointN}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.pointTitle}>{title}</Text>
        <Caption>{detail}</Caption>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 140 },
  kicker: { fontSize: 12, fontWeight: "800", letterSpacing: 0.4, textTransform: "uppercase", color: theme.colors.muted },
  title: { fontSize: 24, lineHeight: 29, fontWeight: "800", letterSpacing: -0.6, color: theme.colors.text },
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: 16, gap: 14, ...theme.shadow.card },
  point: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  pointMark: { width: 26, height: 26, borderRadius: 13, backgroundColor: theme.colors.lime, alignItems: "center", justifyContent: "center" },
  pointN: { fontSize: 13, fontWeight: "900", color: theme.colors.onLime },
  pointTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  example: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  exampleName: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  thumbs: { flexDirection: "row", gap: 4 },
  actions: { gap: 8, marginTop: 4 },
  note: { fontSize: 12, color: theme.colors.muted, textAlign: "center" },
  links: { flexDirection: "row", justifyContent: "center", gap: 18, marginTop: 4 },
  link: { fontSize: 14, fontWeight: "700", color: theme.colors.muted, textDecorationLine: "underline" },
  error: { color: theme.colors.neg, fontSize: 13, fontWeight: "600", textAlign: "center" },
});
