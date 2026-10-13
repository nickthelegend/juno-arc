import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, Text, TextInput, View } from "react-native";

import { Tappable } from "./Press";
import { Button } from "./kit";
import { api, CIRCLE_FAUCET_URL, juno, networkLabel, onTestnet } from "../lib/api";
import { rememberName, useName } from "../lib/names";
import { useWallet } from "../lib/wallet";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * The wallet itself: its address, what it holds, how to fund it, and how to
 * back up its key.
 *
 * On Arc the wallet holds one thing: USDC. It is what every curve is priced
 * in and what gas is paid in, so there is one balance to show — the 6-decimal
 * ERC-20 view of the same money the chain's native balance counts in 18
 * decimals (never both added together).
 *
 * Balances are read from chain and shown as a dash when the read fails, never
 * as zero: "$0" on a throttled read would tell someone to go and fund a wallet
 * that is already funded.
 *
 * ## Funding
 *
 * On testnet Juno's relayer sends a little USDC on request (once a day per
 * address). Circle's faucet is one tap away for more, or when Juno's is dry.
 * On mainnet there is no faucet and the card offers none.
 */
export function WalletCard({ address }: { address: string }) {
  const config = useApi(() => juno.config(), []);
  const testnet = onTestnet();

  // Which USDC depends on the network, so it waits for the config — and falls
  // back to the known address when an older server has no config to give.
  const usdc = useApi(async () => {
    await juno.config().catch(() => null);
    return juno.balance(address, juno.usdc().address);
  }, [address]);
  // The balance keeps itself current: USDC from Circle's faucet in another
  // tab, or a trade elsewhere, shows here without a reload. Silent reads, so a
  // failed one leaves the figure that is on screen.
  const poll = useRef(usdc.poll);
  poll.current = usdc.poll;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the poll is read through a ref; a new address restarts the timer
  useEffect(() => {
    const id = setInterval(() => poll.current(), 10_000);
    return () => clearInterval(id);
  }, [address]);
  const [copied, setCopied] = useState(false);
  const [funding, setFunding] = useState(false);
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string; url?: string } | null>(null);

  const copy = async () => {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const fund = async () => {
    setFunding(true);
    setMessage(null);
    try {
      const result = await juno.faucet(address);
      setMessage({
        tone: "pos",
        text: `$${result.amount} of testnet USDC received — final on Arc already.`,
        url: juno.explorable() ? result.explorerUrl : undefined,
      });
      usdc.refresh();
    } catch (error) {
      const text = (error instanceof Error ? error.message : "The faucet did not answer.").trim().replace(/[.!]?$/, ".");
      setMessage({ tone: "neg", text: `${text} Circle's faucet works too.`, url: CIRCLE_FAUCET_URL });
    } finally {
      setFunding(false);
    }
  };

  const balance = usdc.data?.balance ?? null;
  const figure = usdc.loading ? "…" : balance === null || usdc.error ? "—" : `$${balance.toFixed(balance < 1 ? 4 : 2)}`;
  const empty = balance === 0;
  // Unknown is not "no faucet": only a config that says so hides Juno's.
  const serverFaucet = testnet && config.data?.faucet !== false;

  return (
    <View style={styles.card}>
      <NameEditor address={address} />
      <View style={styles.head}>
        <Text style={styles.label}>Wallet · {networkLabel(config.data?.network)}</Text>
        <Tappable onPress={() => void copy()} to={0.95} accessibilityRole="button" accessibilityLabel="Copy address">
          <View style={styles.copy}>
            <Text style={styles.copyText}>{copied ? "Copied" : "Copy address"}</Text>
          </View>
        </Tappable>
      </View>
      <Text style={styles.address} selectable numberOfLines={1} ellipsizeMode="middle">
        {address}
      </Text>

      <View style={styles.balances}>
        <View style={styles.balance}>
          <Text style={styles.amount} testID="wallet-usdc">
            {figure}
          </Text>
          <Text style={styles.unit}>USDC on Arc</Text>
        </View>
        <Text style={styles.gas}>pays gas too</Text>
      </View>

      {empty ? (
        <Text style={styles.hint}>
          Every buy and launch pays gas in USDC (about $0.004 a trade). Fund this wallet to start.
        </Text>
      ) : null}

      {serverFaucet ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            label={funding ? "Asking…" : "Get testnet USDC"}
            variant={empty ? "lime" : "quiet"}
            loading={funding}
            onPress={() => void fund()}
            style={{ flex: 1 }}
          />
          <Button label="Circle faucet" variant="quiet" onPress={() => void Linking.openURL(CIRCLE_FAUCET_URL)} style={{ flex: 1 }} />
        </View>
      ) : testnet ? (
        <Button
          label="Open Circle's faucet"
          variant={empty ? "lime" : "quiet"}
          onPress={() => void Linking.openURL(CIRCLE_FAUCET_URL)}
        />
      ) : null}

      {message ? (
        <Text style={[styles.message, { color: message.tone === "pos" ? theme.colors.pos : theme.colors.neg }]}>
          {message.text}
          {message.url ? (
            <Text style={styles.link} onPress={() => void Linking.openURL(message.url!)}>
              {"  "}
              {message.tone === "pos" ? "View" : "Open faucet"}
            </Text>
          ) : null}
        </Text>
      ) : null}

      <KeyBackup />
    </View>
  );
}

/**
 * Export and import the device key.
 *
 * The key lives only on this device (the keychain on a phone, this browser's
 * storage on the web). Exporting shows it once, to copy somewhere safe;
 * importing replaces it — the current key is gone unless it was exported
 * first, and the screen says so before it happens. A testnet convenience,
 * not a custody story.
 */
function KeyBackup() {
  const wallet = useWallet();
  const [mode, setMode] = useState<"idle" | "export" | "import">("idle");
  const [shown, setShown] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reveal = async () => {
    setError(null);
    try {
      setShown(await wallet.exportKey());
      setMode("export");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No key to export.");
    }
  };

  const save = async () => {
    setError(null);
    try {
      const address = await wallet.importKey(draft);
      setDraft("");
      setMode("idle");
      setDone(`Imported. This device now signs as ${address.slice(0, 6)}…${address.slice(-4)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That key could not be imported.");
    }
  };

  return (
    <View style={styles.backup} testID="key-backup">
      <View style={styles.head}>
        <Text style={styles.label}>Device key</Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Tappable onPress={() => {
              if (mode === "export") {
                setMode("idle");
                setShown(null);
              } else {
                void reveal();
              }
            }} to={0.95} accessibilityRole="button">
            <View style={styles.copy}>
              <Text style={styles.copyText}>{mode === "export" ? "Hide" : "Export"}</Text>
            </View>
          </Tappable>
          <Tappable onPress={() => setMode(mode === "import" ? "idle" : "import")} to={0.95} accessibilityRole="button">
            <View style={styles.copy}>
              <Text style={styles.copyText}>{mode === "import" ? "Cancel" : "Import"}</Text>
            </View>
          </Tappable>
        </View>
      </View>
      <Text style={styles.hint}>
        {Platform.OS === "web" ? "Kept in this browser only." : "Kept in this device's keychain only."} Export it to keep
        this wallet; anyone with the key controls the wallet.
      </Text>
      {mode === "export" && shown ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.secret} selectable>
            {shown}
          </Text>
          <Button label="Copy key" variant="quiet" onPress={() => void Clipboard.setStringAsync(shown)} />
        </View>
      ) : null}
      {mode === "import" ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="0x… private key"
            placeholderTextColor={theme.colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={[styles.nameRow, styles.nameInput]}
            accessibilityLabel="Private key to import"
          />
          <Text style={[styles.hint, { color: theme.colors.neg }]}>
            This replaces the key on this device. Export the current one first if you want to keep it.
          </Text>
          <Button label="Import key" onPress={() => void save()} disabled={draft.trim().length < 64} />
        </View>
      ) : null}
      {error ? <Text style={[styles.hint, { color: theme.colors.neg }]}>{error}</Text> : null}
      {done ? <Text style={[styles.hint, { color: theme.colors.pos }]}>{done}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 12,
    ...theme.shadow.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 12, fontWeight: "700", color: theme.colors.muted, letterSpacing: 0.2 },
  copy: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.surfaceAlt },
  copyText: { fontSize: 12, fontWeight: "700", color: theme.colors.text },
  address: { fontSize: 13, fontWeight: "600", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  balances: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  balance: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
  gas: { fontSize: 11, fontWeight: "700", color: theme.colors.faint },
  backup: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
  secret: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    color: theme.colors.text,
    padding: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  amount: { fontSize: 20, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  unit: { fontSize: 12, fontWeight: "700", color: theme.colors.muted },
  rule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.colors.lineStrong, marginHorizontal: 12 },
  hint: { fontSize: 13, lineHeight: 18, color: theme.colors.muted },
  message: { fontSize: 13, lineHeight: 18 },
  link: { fontWeight: "800", color: theme.colors.focus },
  name: { fontSize: 17, fontWeight: "800", color: theme.colors.text, marginTop: 2 },
  choose: { backgroundColor: theme.colors.lime },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 46,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  at: { fontSize: 16, fontWeight: "800", color: theme.colors.muted, marginRight: 2 },
  nameInput: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.text },
});

/**
 * Claim a name. Signed by this wallet, so nobody can take yours or rename
 * you; checked and stored by the server, so everyone sees the same one.
 */
function NameEditor({ address }: { address: string }) {
  const wallet = useWallet();
  const current = useName(address);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = draft.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,20}$/.test(cleaned);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const issuedAt = new Date().toISOString();
      // Exactly the text the server rebuilds and verifies — see
      // `nameMessage` in lib/juno/profiles.ts. It rebuilds it from the
      // `wallet` sent below, character for character, so both use `address`.
      const message = `Juno name: ${cleaned}\nWallet: ${address}\nIssued: ${issuedAt}`;
      // EIP-191 `personal_sign`: the server recovers the signer from this and
      // compares it with `wallet`.
      const signature = await wallet.signMessage(message);
      const result = await api.post<{ name: string }>("/api/juno/profiles", {
        wallet: address,
        name: cleaned,
        issuedAt,
        signature,
      });
      rememberName(address, result.name);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That name could not be saved");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Name</Text>
          <Text style={styles.name}>{current ? `@${current}` : "No name yet"}</Text>
        </View>
        <Tappable
          onPress={() => {
            setDraft(current ?? "");
            setEditing(true);
          }}
          to={0.95}
          accessibilityRole="button"
          accessibilityLabel={current ? "Change your name" : "Choose a name"}
        >
          <View style={[styles.copy, !current ? styles.choose : null]}>
            <Text style={styles.copyText}>{current ? "Change" : "Choose a name"}</Text>
          </View>
        </Tappable>
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>Name</Text>
      <View style={styles.nameRow}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={draft}
          onChangeText={(next) => setDraft(next.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20))}
          placeholder="yourname"
          placeholderTextColor={theme.colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={styles.nameInput}
          onSubmitEditing={() => void save()}
        />
      </View>
      <Text style={[styles.hint, error ? { color: theme.colors.neg } : null]}>
        {error ?? (draft && !valid ? "3–20 letters, digits or underscores." : "Your wallet signs to claim it. Free, no transaction.")}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} style={{ flex: 1 }} />
        <Button label="Save" onPress={() => void save()} loading={saving} disabled={!valid} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
