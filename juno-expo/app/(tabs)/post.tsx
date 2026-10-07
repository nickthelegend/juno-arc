import { Image as ExpoImage } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CurvePreview } from "../../components/CurvePreview";
import { Button, Card, Pill } from "../../components/kit";
import { confirmMsOf, juno, onTestnet, type TrackerFeed } from "../../lib/api";
import { feedChanged } from "../../lib/refresh";
import { useTabBarHeight } from "../../lib/tabbar";
import { tokens, useApi } from "../../lib/useApi";
import { useWallet } from "../../lib/wallet";
import { theme } from "../../theme";

/**
 * Post — which here means launching a real market.
 *
 * This is Juno's whole claim in one screen. Publishing does not create a row in
 * a table; it deploys a token on Arc with a sixteen-segment bonding curve
 * chosen from a preset, priced in USDC, and the post *is* that market.
 *
 * ## Trackers
 *
 * The `tight-nav` preset launches a tracker: a coin that follows a Chainlink
 * Data Feed (BTC/USD, PAXG/USD gold, EUR/USD…). The creator picks the feed and
 * how much of it one token stands for; the curve opens at the feed's price
 * times that ratio, and where `JunoTrackers` has the feed on this network the
 * launch also records it on chain so the coin's NAV, premium and band are
 * computed there.
 *
 * ## One transaction
 *
 * The launchpad deploys the token, opens its curve and locks the address of the
 * Uniswap v2 pair it will graduate into, all in one call — so there is no
 * half-launched state to explain. The server builds it as a list of steps anyway, because a
 * launch that opens with a first buy in USDC needs an approval first; the
 * wallet signs every step and submits them in order.
 *
 * ## Listing is a second, separate act
 *
 * Once the transaction confirms, the coin exists on-chain whether or not Juno
 * has indexed it. Indexing can fail on its own — a database blip — and when it
 * does the screen keeps everything needed to retry it without signing again,
 * rather than leaving a creator with a live market that appears nowhere.
 */

const PRESETS = [
  {
    id: "content",
    label: "Content",
    blurb: "Back-loaded. Cheap to enter, steepens as attention arrives.",
  },
  {
    id: "thin-name",
    label: "Thin name",
    blurb: "Front-loaded. Deep at the issue price so early size fills.",
  },
  {
    id: "ipo-book",
    label: "IPO book",
    blurb: "Deep at both ends, thin in the middle. Book-building.",
  },
  {
    id: "tight-nav",
    label: "Tight NAV",
    blurb: "Uniform. A tracker: follows a Chainlink feed like a spread, not a launch.",
  },
] as const;

export default function PostScreen() {
  const router = useRouter();
  const wallet = useWallet();
  /*
   * Which kind of thing is being launched, chosen in the create sheet.
   *
   * It was hardcoded to "post", so the phone could not launch a reel at all
   * while the web could — and a reel is a different object in the feed, not a
   * cosmetic label: it decides whether this lands in the grid or the swipe
   * feed. Defaulting to "post" keeps a direct visit to this route working.
   */
  const { format, tracker: trackerParam } = useLocalSearchParams<{ format?: string; tracker?: string }>();
  const kind: "post" | "reel" = format === "reel" ? "reel" : "post";

  const [media, setMedia] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [caption, setCaption] = useState("");
  /** A launch that confirmed on-chain but could not be listed yet — kept so listing can be retried. */
  const [unlisted, setUnlisted] = useState<Parameters<typeof juno.recordLaunch>[0] | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [preset, setPreset] = useState<string>(trackerParam ? "tight-nav" : "content");
  /** USDC the creator buys in the launch transaction itself. Zero for none. */
  const [firstBuy, setFirstBuy] = useState(0);
  /** A tracker launch: the Chainlink feed, and how much of it one token stands for. */
  const [trackerFeed, setTrackerFeed] = useState<string | null>(trackerParam ?? null);
  const [unitsText, setUnitsText] = useState("");
  useEffect(() => {
    if (trackerParam) {
      setPreset("tight-nav");
      setTrackerFeed(trackerParam);
    }
  }, [trackerParam]);
  const isTracker = preset === "tight-nav";
  const feeds = useApi(() => (isTracker ? juno.trackers() : Promise.resolve(null)), [isTracker]);
  const feed: TrackerFeed | null = feeds.data?.feeds.find((f) => f.id === trackerFeed) ?? null;
  /** Default: a token worth a millionth of a dollar at the open, like any post. */
  const defaultUnits = feed && feed.priceUsd > 0 ? Number((1e-6 / feed.priceUsd).toPrecision(2)) : null;
  const units = unitsText ? Number(unitsText) : defaultUnits;
  const unitsOk = !isTracker || (units !== null && Number.isFinite(units) && units > 0 && !!trackerFeed);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * What has actually happened, as it happens: each step with its receipt —
   * an IPFS address, a transaction hash, the token's address — and the time
   * it landed. Shown while the launch runs, so the chain's answers are on
   * screen rather than a spinner that says "trust me".
   */
  const [log, setLog] = useState<LogEntry[]>([]);
  const note = (entry: Omit<LogEntry, "at">) => setLog((current) => [...current, { ...entry, at: new Date() }]);
  // The log grows under the fold, beneath the tab bar; keep its newest row in
  // view, the way a terminal follows its output.
  const scroller = useRef<ScrollView>(null);
  const TAB_H = useTabBarHeight().height;
  useEffect(() => {
    if (log.length > 0) setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
  }, [log.length]);

  // A different format wants a different file: a photo for a post, a video
  // for a reel. Switching formats clears a pick of the wrong kind.
  useEffect(() => {
    if (media && (media.type === "video") !== (kind === "reel")) setMedia(null);
  }, [kind, media]);

  /*
   * USDC for gas (and the first buy), checked before anything is uploaded or
   * signed. On Arc gas is paid in USDC, so one balance covers both.
   *
   * The balance is read up front (and again whenever the tab comes back into
   * view, since USDC usually arrives from the profile's faucet in between), and
   * the exact cost is checked again once the transaction is built. Null means
   * the read failed: that is not zero, and it does not block.
   */
  const usdcBalance = useApi(
    () => (wallet.address ? juno.balance(wallet.address, juno.usdc().address) : Promise.resolve(null)),
    [wallet.address],
  );
  const pollBalance = usdcBalance.poll;
  useFocusEffect(
    useCallback(() => {
      pollBalance();
    }, [pollBalance]),
  );
  const usdc = usdcBalance.data?.balance ?? null;
  const testnet = onTestnet();
  const unfunded = wallet.address === null || (usdc !== null && usdc < firstBuy + LAUNCH_GAS_USDC);

  const symbolOk = /^[A-Z0-9]{2,10}$/.test(symbol.trim().toUpperCase());
  const captionOk = caption.trim().length <= MAX_CAPTION;
  /*
   * Media is required. Every post in the feed is a picture and every reel is
   * a video; a launch without one produced a coin that drew as a placeholder
   * in the feed and — for a reel — never appeared in Reels at all.
   */
  const canLaunch = !!media && name.trim().length > 0 && symbolOk && captionOk && unitsOk && !unfunded && !busy;
  const missing = !media
    ? kind === "reel"
      ? "Add a video to launch"
      : "Add a photo to launch"
    : !name.trim()
      ? "Name it to launch"
      : !symbolOk
        ? // Said by which rule it breaks: "DAWN!" is within 2–10 characters,
          // and a hint about length left no clue what was wrong with it.
          /[^A-Za-z0-9]/.test(symbol.trim())
          ? "Tickers are letters and digits only"
          : "Add a 2–10 character ticker"
        : !captionOk
          ? "Caption is too long"
          : !unitsOk
            ? "Pick the Chainlink feed this tracker follows"
            : wallet.address === null
              ? `Launching needs a wallet with a little USDC for gas.${testnet ? " Make one and get testnet USDC on your profile." : ""}`
              : unfunded
                ? `This needs about ${firstBuy > 0 ? `$${firstBuy} for the first buy plus ` : ""}$${LAUNCH_GAS_USDC} of USDC for gas, and the wallet has ${
                    usdc === null ? "less" : `$${tokens(usdc)}`
                  }.${testnet ? " Get testnet USDC on your profile." : ""}`
                : null;

  async function pick() {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: kind === "reel" ? ["videos"] : ["images"],
        // A JPEG, not the library's HEIC original: an iPhone photo is HEIC,
        // which a browser viewing the post cannot draw. A quality below 1
        // already makes iOS re-encode; `Compatible` says so explicitly.
        quality: 0.9,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        videoMaxDuration: 90,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (asset.fileSize && asset.fileSize > MAX_BYTES) {
        setError("That file is over 25MB. Pick a smaller one.");
        return;
      }
      setMedia(asset);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open your library");
    }
  }

  /** Index a confirmed launch. Throws with a reason the screen can show. */
  async function list(record: Parameters<typeof juno.recordLaunch>[0]) {
    setStatus("Listing it on Juno…");
    try {
      await juno.recordLaunch(record);
      setUnlisted(null);
      note({ label: "Listed on Juno", receipt: record.token, link: "token" });
      setStatus("Live");
      feedChanged();
      // A beat on the finished log: every receipt is on screen at once, which
      // is the proof, before the coin page replaces it.
      await new Promise((resolve) => setTimeout(resolve, 3500));
      setStatus(null);
      // A blank composer for the next one. The tab stays mounted, so coming
      // back to it showed the last post filled in — one tap from launching a
      // duplicate coin.
      setMedia(null);
      setName("");
      setSymbol("");
      setCaption("");
      setPreset("content");
      setTrackerFeed(null);
      setUnitsText("");
      setFirstBuy(0);
      setLog([]);
      router.push(`/coin/${record.token}`);
    } catch (caught) {
      setUnlisted(record);
      setStatus(null);
      throw new Error(
        `Your coin is live on-chain, but Juno could not list it yet: ${
          caught instanceof Error ? caught.message : "unknown error"
        }. Tap "Retry listing" — nothing needs signing again.`,
      );
    }
  }

  async function retryListing() {
    if (!unlisted) return;
    setBusy(true);
    setError(null);
    try {
      await list(unlisted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing failed");
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!media) return;
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      const address = wallet.address ?? (await wallet.connect());

      setStatus(kind === "reel" ? "Uploading your video…" : "Uploading your photo…");
      const uploaded = await juno.upload(
        media.file ?? {
          uri: media.uri,
          name: media.fileName ?? (media.type === "video" ? "reel.mp4" : "post.jpg"),
          type: media.mimeType ?? (media.type === "video" ? "video/mp4" : "image/jpeg"),
        },
      );

      note({ label: kind === "reel" ? "Video pinned to IPFS" : "Photo pinned to IPFS", receipt: uploaded.uri });
      if (uploaded.posterUri) note({ label: "Poster frame pinned", receipt: uploaded.posterUri });

      setStatus("Pinning the token metadata…");
      const metadata = await juno.pinMetadata({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: caption.trim() || undefined,
        curvePreset: preset,
        // Wallets and explorers want a still; a reel's is its poster.
        imageUrl: uploaded.posterUrl ?? uploaded.url,
        mimeType: uploaded.posterUrl ? "image/jpeg" : uploaded.mimeType,
      });

      note({ label: "Token metadata pinned", receipt: metadata.uri });

      setStatus("Building the launch…");
      const built = await juno.buildLaunch({
        creator: address,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        preset,
        uri: metadata.uri,
        // Every curve on Arc is priced in USDC — the same money as the gas.
        quoteToken: juno.usdc().address,
        firstBuy: firstBuy > 0 ? firstBuy : undefined,
        tracker: isTracker && trackerFeed && units ? { feed: trackerFeed, unitsPerToken: units } : undefined,
      });

      // The exact cost, now that it is known: every step's gas at its fee
      // cap (18-decimal USDC wei), plus the first buy. Said before signing
      // rather than learned from the node's refusal after it.
      const gasWei = built.steps.reduce(
        (sum, step) => sum + BigInt(step.request.gas) * BigInt(step.request.maxFeePerGas) + BigInt(step.request.value),
        0n,
      );
      const need = Number(gasWei) / 1e18 + firstBuy;
      const held = await juno.balance(address, juno.usdc().address).catch(() => null);
      if (held?.balance !== null && held?.balance !== undefined && held.balance < need) {
        throw new Error(
          `This launch needs up to $${tokens(need)} of USDC with gas, and the wallet has $${tokens(held.balance)}.${
            testnet ? " Get testnet USDC on your profile." : ""
          } Nothing was signed.`,
        );
      }

      const results = await wallet.signAndSubmit(
        built.steps,
        (step) =>
          setStatus(step.total > 1 ? `${step.label}… (${step.index + 1}/${step.total})` : `${step.label}…`),
        (result, step) =>
          note({
            // The last step is the launch itself; an earlier one is an approval.
            label:
              step.index === step.total - 1
                ? `Market opened on ${juno.loadedConfig()?.localFork ? "a local Arc fork" : "Arc"}`
                : step.label,
            receipt: result.hash,
            link: "tx",
            confirmedInMs: confirmMsOf(result) ?? undefined,
          }),
      );
      // The launch is the last step, and its hash is the receipt a judge
      // clicks. The token address comes from the chain's own `Launched`
      // event; the launchpad's prediction is the fallback, and they agree.
      const launch = results[results.length - 1];
      const token = results.find((result) => result.launched)?.launched?.token ?? built.token;

      /*
       * The coin exists on-chain from here on. Listing it used to fail
       * silently, which left a creator with a live market that appeared
       * nowhere in the app and no idea why. Now a failure says so and keeps
       * everything needed to retry without signing again.
       */
      await list({
        token,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        format: kind,
        curvePreset: preset,
        createTx: launch.hash,
        description: caption.trim() || null,
        mediaUrl: uploaded.uri,
        posterUrl: uploaded.posterUri ?? uploaded.uri,
        mediaMime: uploaded.mimeType,
        mediaWidth: uploaded.width,
        mediaHeight: uploaded.height,
        navFeedId: isTracker ? trackerFeed : null,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Launch failed");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          ref={scroller}
          contentContainerStyle={[styles.body, { paddingBottom: TAB_H + 24 }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>
            {kind === "reel" ? "Post a reel" : "Post a photo"}
          </Text>
          <Text style={styles.lede}>
            {kind === "reel"
              ? "A vertical video with a real bonding curve behind it on Arc, priced in USDC. It lands in the swipe feed."
              : "Publishing opens a real bonding curve on Arc, priced in USDC. The post is the market."}
          </Text>

          <MediaPicker kind={kind} media={media} onPick={pick} disabled={busy} />

          <Card style={styles.form}>
            <Field label="Name">
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Night Market"
                placeholderTextColor={theme.colors.faint}
                style={styles.input}
                maxLength={64}
              />
            </Field>

            <Field label="Ticker" hint={symbol.length > 0 && !symbolOk ? "2–10 letters or digits" : undefined}>
              <TextInput
                value={symbol}
                onChangeText={(next) => setSymbol(next.toUpperCase())}
                placeholder="NIGHT"
                placeholderTextColor={theme.colors.faint}
                autoCapitalize="characters"
                style={styles.input}
                maxLength={10}
              />
            </Field>

            <Field
              label="Caption"
              hint={!captionOk ? `${caption.trim().length - MAX_CAPTION} over the limit` : undefined}
            >
              <TextInput
                value={caption}
                onChangeText={setCaption}
                placeholder={kind === "reel" ? "Street level, 2am." : "Say what this is"}
                placeholderTextColor={theme.colors.faint}
                multiline
                style={[styles.input, styles.caption]}
                maxLength={MAX_CAPTION + 20}
              />
            </Field>
          </Card>

          <Text style={styles.sectionTitle}>Curve</Text>
          <Text style={styles.sectionLede}>
            Sixteen liquidity-weighted segments. The weights decide how the price
            behaves, not just where it starts.
          </Text>

          {/* Radios in a group, so a screen reader says which curve is chosen
              and that the four are one choice; the cards had no role at all. */}
          <View style={styles.presets} role="radiogroup" aria-label="Curve">
            {PRESETS.map((option) => {
              const on = preset === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => setPreset(option.id)}
                  role="radio"
                  aria-checked={on}
                  aria-label={`${option.label}. ${option.blurb}`}
                >
                  <Card style={[styles.preset, on && styles.presetOn]}>
                    <View style={styles.presetRow}>
                      <View style={styles.presetText}>
                        <View style={styles.presetHead}>
                          <Text style={styles.presetLabel}>{option.label}</Text>
                          {on && <Pill label="Selected" tone="lime" />}
                        </View>
                        <Text style={styles.presetBlurb}>{option.blurb}</Text>
                      </View>
                      {/* The curve itself, drawn from the same sixteen weights
                          the launch uses. The weights are the whole decision. */}
                      <CurvePreview preset={option.id} active={on} />
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>

          {isTracker ? (
            <>
              <Text style={styles.sectionTitle}>What it tracks</Text>
              <Text style={styles.sectionLede}>
                A Chainlink Data Feed on Arc mainnet. The curve opens at the feed&apos;s price times what one token stands
                for, and the coin page shows its NAV, premium and band against the feed.
              </Text>
              {feeds.loading ? (
                <Text style={styles.sectionLede}>Reading Chainlink feeds…</Text>
              ) : feeds.error ? (
                <Text style={[styles.sectionLede, { color: theme.colors.neg }]}>Chainlink feeds could not be read: {feeds.error.replace(/[.!?]?$/, ".")}</Text>
              ) : (
                <View style={styles.chips} role="radiogroup" aria-label="Chainlink feed">
                  {(feeds.data?.feeds ?? []).filter((f) => f.id !== "USDC/USD").map((f) => {
                    const on = trackerFeed === f.id;
                    return (
                      <Pressable
                        key={f.id}
                        onPress={() => {
                          setTrackerFeed(f.id);
                          setUnitsText("");
                        }}
                        role="radio"
                        aria-checked={on}
                        style={[styles.chip, on && styles.chipOn]}
                      >
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>
                          {f.id.split("/")[0]}
                          {f.stale ? " · stale" : ""}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {feed ? (
                <Card style={{ gap: 8 }}>
                  <Text style={styles.fieldLabel}>
                    One token = how many {feed.id.split("/")[0]} (Chainlink {feed.id} ${feed.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 4 })})
                  </Text>
                  <TextInput
                    value={unitsText}
                    onChangeText={(next) => setUnitsText(next.replace(/[^0-9.eE-]/g, ""))}
                    placeholder={defaultUnits !== null ? String(defaultUnits) : "0.000001"}
                    placeholderTextColor={theme.colors.faint}
                    keyboardType="decimal-pad"
                    style={styles.input}
                    accessibilityLabel="Units of the feed per token"
                  />
                  {units ? (
                    <Text style={styles.sectionLede}>
                      Opens at ${(feed.priceUsd * units).toPrecision(3)} a token — about $
                      {Math.round(feed.priceUsd * units * 1e9).toLocaleString("en-US")} for the billion-token supply.
                    </Text>
                  ) : null}
                </Card>
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Your first buy</Text>
          <Text style={styles.sectionLede}>
            Bought in the launch transaction itself, at the opening price, so nobody can get in ahead of you.
          </Text>
          <View style={styles.chips} role="radiogroup" aria-label="First buy">
            {FIRST_BUYS.map((amount) => {
              const on = firstBuy === amount;
              return (
                <Pressable
                  key={amount}
                  onPress={() => setFirstBuy(amount)}
                  role="radio"
                  aria-checked={on}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {amount === 0 ? "None" : `$${amount}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {error && (
            <Card style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </Card>
          )}

          {log.length > 0 ? <LaunchLog entries={log} /> : null}

          {unlisted ? (
            <Button label={status ?? "Retry listing"} tall onPress={retryListing} loading={busy} />
          ) : (
            <Button
              label={status ?? (kind === "reel" ? "Launch reel" : "Launch post")}
              tall
              onPress={launch}
              loading={busy}
              disabled={!canLaunch}
            />
          )}
          {/* Why the button is off, instead of a dead button and a guess. */}
          {!busy && !unlisted && missing ? <Text style={styles.missing}>{missing}</Text> : null}
          {busy && status ? <Text style={styles.missing}>{status}</Text> : null}
          <Text style={styles.footnote}>
            {`One transaction${firstBuy > 0 ? " (after a USDC approval for the first buy)" : ""}: it deploys the token, opens its USDC curve, and reserves the Uniswap v2 TOKEN/USDC pair the curve graduates into — locked until then. Gas is paid in USDC and is final on Arc in under a second.`}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const MAX_CAPTION = 280;
/**
 * USDC a launch is allowed to need for gas, checked before anything is pinned.
 * A launch uses about 2M gas, paid in USDC on Arc; the exact figure is checked
 * again once the transaction is built.
 */
const LAUNCH_GAS_USDC = 0.1;
/** First-buy sizes offered at launch, in USDC. */
const FIRST_BUYS = [0, 1, 5, 10] as const;
/** Matches the upload route's own limit, so a doomed upload is refused before it starts. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * The photo or video, picked from the library and previewed at its own shape.
 *
 * A reel previews playing and muted, the way it will sit in the feed, so the
 * creator sees what everyone else will before they sign for it.
 */
function MediaPicker({
  kind,
  media,
  onPick,
  disabled,
}: {
  kind: "post" | "reel";
  media: ImagePicker.ImagePickerAsset | null;
  onPick: () => void;
  disabled: boolean;
}) {
  if (!media) {
    return (
      <Pressable onPress={onPick} disabled={disabled} accessibilityRole="button">
        <View style={[styles.drop, { aspectRatio: kind === "reel" ? 4 / 5 : 1 }]}>
          <View style={styles.dropDisc}>
            <Text style={styles.dropPlus}>+</Text>
          </View>
          <Text style={styles.dropTitle}>{kind === "reel" ? "Add a video" : "Add a photo"}</Text>
          <Text style={styles.dropBlurb}>
            {kind === "reel" ? "Vertical works best. Up to 25MB." : "Square works best. Up to 25MB."}
          </Text>
        </View>
      </Pressable>
    );
  }

  const ratio =
    media.width && media.height ? Math.max(0.56, Math.min(1.25, media.width / media.height)) : 1;

  return (
    <View style={[styles.preview, { aspectRatio: ratio }]}>
      {media.type === "video" ? (
        <VideoPreview uri={media.uri} />
      ) : (
        <ExpoImage source={{ uri: media.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      )}
      <Pressable onPress={onPick} disabled={disabled} style={styles.change} accessibilityRole="button">
        <Text style={styles.changeText}>Change</Text>
      </Pressable>
    </View>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

type LogEntry = {
  label: string;
  receipt: string;
  /** What the receipt opens on Arc's explorer, if anything. */
  link?: "tx" | "token";
  /** Broadcast to receipt, as the server measured it. */
  confirmedInMs?: number;
  at: Date;
};

function shorten(value: string): string {
  const bare = value.replace(/^ipfs:\/\//, "");
  return bare.length > 14 ? `${bare.slice(0, 6)}…${bare.slice(-6)}` : bare;
}

/** The launch, step by step, with each receipt and the second it landed. */
function LaunchLog({ entries }: { entries: LogEntry[] }) {
  return (
    <View style={styles.log}>
      {entries.map((entry, index) => (
        <Pressable
          key={`${entry.label}-${index}`}
          disabled={!entry.link || !juno.explorable()}
          onPress={() => entry.link && void Linking.openURL(juno.explorer(entry.link, entry.receipt))}
          style={styles.logRow}
          accessibilityRole={entry.link && juno.explorable() ? "link" : undefined}
        >
          <Text style={styles.logTick}>✓</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.logLabel}>{entry.label}</Text>
            <Text style={styles.logReceipt} numberOfLines={1}>
              {entry.link === "tx" ? "tx " : entry.link === "token" ? "token " : "ipfs "}
              {shorten(entry.receipt)}
              {entry.confirmedInMs !== undefined ? ` · ${(entry.confirmedInMs / 1000).toFixed(1)}s` : ""}
            </Text>
          </View>
          <Text style={styles.logTime}>
            {entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.bg },
  body: { paddingHorizontal: 16, paddingBottom: 140, gap: 12 },
  log: {
    backgroundColor: theme.colors.ink,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  logRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  logTick: { color: theme.colors.lime, fontSize: 14, fontWeight: "900" },
  logLabel: { color: theme.colors.onInk, fontSize: 14, fontWeight: "700" },
  logReceipt: { color: "#9FB09A", fontSize: 12, fontFamily: MONO, marginTop: 2 },
  logTime: { color: "#9FB09A", fontSize: 12, fontFamily: MONO },
  title: { fontSize: theme.type.screen.size, fontWeight: "800", color: theme.colors.ink },
  lede: { fontSize: theme.type.body.size, color: theme.colors.muted, lineHeight: 21 },
  form: { gap: 16 },
  fieldLabel: { fontSize: theme.type.label.size, fontWeight: "500", color: theme.colors.muted },
  fieldHint: { fontSize: theme.type.micro.size, fontWeight: "500", color: theme.colors.neg },
  input: {
    height: 48,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 16,
    fontSize: theme.type.body.size,
    color: theme.colors.text,
  },
  sectionTitle: { fontSize: theme.type.title.size, fontWeight: "700", color: theme.colors.text, marginTop: 8 },
  sectionLede: { fontSize: theme.type.label.size, fontWeight: "500", color: theme.colors.muted, lineHeight: 19 },
  presets: { gap: 8 },
  preset: { gap: 6, padding: 16 },
  presetOn: { borderWidth: 2, borderColor: theme.colors.lime },
  presetRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  presetText: { flex: 1, gap: 6 },
  presetHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  presetLabel: { fontSize: theme.type.body.size, fontWeight: "600", color: theme.colors.ink },
  presetBlurb: { fontSize: theme.type.label.size, fontWeight: "500", color: theme.colors.muted, lineHeight: 19 },
  chips: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chip: {
    paddingHorizontal: 16,
    height: 40,
    borderRadius: 999,
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipOn: { backgroundColor: theme.colors.ink },
  chipText: { fontSize: theme.type.label.size, fontWeight: "700", color: theme.colors.text },
  chipTextOn: { color: theme.colors.onInk },
  errorCard: { backgroundColor: "rgba(217,45,32,0.08)" },
  errorText: { fontSize: theme.type.body.size, color: theme.colors.neg, lineHeight: 21 },
  caption: { height: 88, paddingTop: 12, textAlignVertical: "top" },
  missing: { fontSize: theme.type.label.size, fontWeight: "600", color: theme.colors.muted, textAlign: "center" },
  drop: {
    width: "100%",
    borderRadius: theme.radius.lg,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: theme.colors.lineStrong,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  dropDisc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
  },
  dropPlus: { fontSize: 30, fontWeight: "600", color: theme.colors.onLime, marginTop: -3 },
  dropTitle: { fontSize: theme.type.body.size, fontWeight: "800", color: theme.colors.text },
  dropBlurb: { fontSize: theme.type.label.size, color: theme.colors.muted },
  preview: {
    width: "100%",
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.ink,
  },
  change: {
    position: "absolute",
    right: 12,
    bottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  changeText: { fontSize: 13, fontWeight: "700", color: "#FFFFFF" },
  footnote: { fontSize: theme.type.micro.size, fontWeight: "500", color: theme.colors.faint, lineHeight: 16, marginTop: 8 },
});
