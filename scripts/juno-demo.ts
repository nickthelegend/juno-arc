/**
 * Demo data for Juno on Arc, made the way the phone makes it.
 *
 * A feed nobody has posted to reads as a broken app, and a market nobody has
 * traded has no chart, no holders and nothing under "Bought by". This gives a
 * deployment its starting content: five reels and four photo posts
 * (free-licence Pexels footage, already on IPFS) across all four curve
 * presets, plus three tracker coins opened at a Chainlink Data Feed price on
 * Arc mainnet (BTC/USD, PAXG/USD, EUR/USD), launched by named `demo_` wallets
 * and traded between them in USDC, with comments. `--round lifecycle` also
 * takes a small coin through a whole life: filled, graduated into its Uniswap
 * v2 TOKEN/USDC pair, traded there, made a Chainlink CCIP Cross-Chain Token,
 * and a creator's fees claimed.
 *
 * Every step goes through the API exactly as the app does — the server builds
 * the unsigned transaction, the demo wallet signs it here, the server submits
 * and records it — so a clean run is also an end-to-end test of the deployed
 * trade path.
 *
 *   npx tsx scripts/juno-demo.ts [--api http://localhost:3100] [--round content|trade|lifecycle|all] [--rpc http://127.0.0.1:8910]
 *
 * Keys are made on first run and kept in `.juno/demo/<network>/` (gitignored).
 * On a local fork the wallets are funded with `anvil_setBalance` (Arc's native
 * balance is USDC); on testnet they are funded from the script key
 * (`JUNO_SCRIPT_PRIVATE_KEY` or `.juno/launcher.key`), which needs about 11
 * USDC for `--round all` (the wallets' trading money plus gas — get it at
 * https://faucet.circle.com). Never runs against mainnet. Idempotent: what
 * already happened is recorded in `progress.json` and skipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { apiBase, arg, run, scriptAccount } from "./lib/cli";

const API = (arg("api") ?? apiBase()).replace(/\/$/, "");
const ROUND = arg("round", "all")!;
const IPFS = "https://gateway.pinata.cloud/ipfs";

type Config = {
  network: string;
  chainId: number;
  rpcUrl: string;
  localFork?: boolean;
  v2Trading?: boolean;
};
type Step = {
  label: string;
  request: {
    chainId: number;
    to: Hex;
    data: Hex;
    value: Hex;
    nonce: number;
    gas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
  };
};

async function call<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}/api/juno${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(`${route} ${response.status}: ${json.error ?? "no body"}`);
  return json;
}

/** Sign each built step here, submit it there, in order. */
async function signAndSubmit(account: PrivateKeyAccount, steps: Step[]) {
  const landed: Array<{ hash: Hex; launched?: { token: Hex }; confirmedInMs?: number }> = [];
  for (const step of steps) {
    const r = step.request;
    const signed = await account.signTransaction({
      type: "eip1559",
      chainId: r.chainId,
      to: r.to,
      data: r.data,
      value: BigInt(r.value),
      nonce: r.nonce,
      gas: BigInt(r.gas),
      maxFeePerGas: BigInt(r.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
    });
    landed.push(await call("/tx/submit", { signed }));
  }
  return landed;
}

/* ------------------------------------------------------------------ */
/* Wallets and progress                                                */
/* ------------------------------------------------------------------ */

const NAMES = ["demo_ana", "demo_kai", "demo_rio", "demo_lena"] as const;
type Name = (typeof NAMES)[number];

function walletDir(config: Config): string {
  const dir = path.join(".juno", "demo", config.localFork ? "fork" : config.network);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function wallet(config: Config, name: Name): PrivateKeyAccount {
  const file = path.join(walletDir(config), `${name}.key`);
  if (!existsSync(file)) writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  return privateKeyToAccount(readFileSync(file, "utf8").trim() as Hex);
}

type Progress = { launched: Record<string, Hex>; done: string[] };

function loadProgress(config: Config): Progress {
  const file = path.join(walletDir(config), "progress.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Progress) : { launched: {}, done: [] };
}

function saveProgress(config: Config, progress: Progress) {
  writeFileSync(path.join(walletDir(config), "progress.json"), JSON.stringify(progress, null, 2));
}

async function balance(rpc: string, address: Hex): Promise<bigint> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  return BigInt(((await response.json()) as { result: Hex }).result);
}

/** Top each demo wallet up to `target` USDC (native, 18 decimals — the same money as the 6-dec ERC-20). */
async function fund(config: Config, rpc: string, accounts: PrivateKeyAccount[], target: bigint) {
  for (const account of accounts) {
    const held = await balance(rpc, account.address);
    if (held >= target) continue;
    if (config.localFork) {
      await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [account.address, `0x${target.toString(16)}`] }),
      });
    } else {
      const funder = scriptAccount();
      const arcChain: Chain = {
        id: config.chainId,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      };
      const client = createWalletClient({ account: funder, transport: http(rpc), chain: arcChain });
      // A plain value transfer moves USDC on Arc: the native balance is USDC.
      const hash = await client.sendTransaction({ to: account.address, value: target - held });
      console.log(`  funded ${account.address} with ${formatEther(target - held)} USDC (${hash})`);
    }
  }
}

async function claimName(account: PrivateKeyAccount, name: string) {
  const issuedAt = new Date().toISOString();
  const message = `Juno name: ${name}\nWallet: ${account.address}\nIssued: ${issuedAt}`;
  const signature = await account.signMessage({ message });
  await call("/profiles", { wallet: account.address, name, issuedAt, signature });
}

/* ------------------------------------------------------------------ */
/* What gets launched                                                  */
/* ------------------------------------------------------------------ */

type Launch = {
  key: string;
  creator: Name;
  name: string;
  symbol: string;
  description: string;
  preset: "content" | "thin-name" | "ipo-book" | "tight-nav";
  format: "post" | "reel";
  media: { cid: string; poster?: string; mime: string; width: number; height: number };
  /** A tracker: opens at the Chainlink feed's price for `unitsPerToken` of the asset (tight-nav only). */
  tracker?: { feed: string; unitsPerToken: number };
  /** Caps in USDC, for the small lifecycle coin; otherwise the app's defaults. */
  caps?: { initial: number; migration: number };
};

/** The Solana demo's own content: Pexels clips and photos, already pinned. */
const CONTENT: Launch[] = [
  { key: "AVE", creator: "demo_ana", name: "Midnight Avenue", symbol: "AVE", description: "The city after hours.", preset: "content", format: "reel", media: { cid: "QmUKAhjqYe35dYpRm4bXEqXaHBdggvQddVv6smkpUt9Xp3", poster: "QmRmKVEcSHCV2tEDA2UZ6JzBAG5CKsUPHPMWdwHiTvEau4", mime: "video/mp4", width: 720, height: 1280 } },
  { key: "NEON", creator: "demo_kai", name: "City After Rain", symbol: "NEON", description: "Neon, wet streets, 2am.", preset: "content", format: "reel", media: { cid: "QmYX6QBEyzHWm5cB4zA97oT5GhBVvnvgDNn3tf9d6r7AmK", poster: "QmY4VuQhFWeReFPrfUAJX3LXASnQHjb7UBAteZ4m4GDcXc", mime: "video/mp4", width: 720, height: 1280 } },
  { key: "KICK", creator: "demo_rio", name: "Park Session", symbol: "KICK", description: "Kickflip practice before the rain.", preset: "content", format: "reel", media: { cid: "Qmb5k2eTcqvu9XJZfEN2wXsgj2Ddq9u5qNjBJ9jRB7pags", poster: "QmeZ89H8eJwqrdaRgH1FWrQebJEk9F6vk4SGPCrf4e2K7u", mime: "video/mp4", width: 720, height: 1280 } },
  { key: "SURF", creator: "demo_lena", name: "Board Check", symbol: "SURF", description: "Wax on, then paddle out.", preset: "content", format: "reel", media: { cid: "QmNT3Cq1za3zNCjYLmtxkyD5RYXknMftBXUiTQZESoa1Bt", poster: "QmaLJFi1Z3zVqAPZhc6rHy1nxGrKrdzM7yJaUi4tXcvbpi", mime: "video/mp4", width: 720, height: 1280 } },
  { key: "TIDE", creator: "demo_ana", name: "Last Light, Low Tide", symbol: "TIDE", description: "Dusk at the beach. One surfer still out.", preset: "content", format: "reel", media: { cid: "QmdXCVRYkZnBDJuPW4KyAQgdbcBJuezY5aW3wsosYtkxhe", poster: "QmUnwbLu1e8gqvqMjuytmcbKdjTAqn55az9ZUcmh1PdW8J", mime: "video/mp4", width: 720, height: 1280 } },
  { key: "BLOOM", creator: "demo_kai", name: "Wild Bloom", symbol: "BLOOM", description: "Spring, all at once.", preset: "content", format: "post", media: { cid: "QmZsvmG3ftAb3dHMMwhLcMzjiGgSGQSLWY4aFEbLHcDPQB", mime: "image/jpeg", width: 4032, height: 3024 } },
  { key: "FALLS", creator: "demo_rio", name: "The Falls", symbol: "FALLS", description: "First light.", preset: "content", format: "post", media: { cid: "QmdPaKD9DuWJ9b2DSPoSQFLaBvKGPcpMs4Lq5XUVTPPd4t", mime: "image/jpeg", width: 3000, height: 2002 } },
  { key: "DUSK", creator: "demo_lena", name: "Dusk Set, Limited Prints", symbol: "DUSK", description: "Twenty prints from the low-tide set. Issued on the ipo-book curve: deep at the open and the close, discovered in the middle.", preset: "ipo-book", format: "post", media: { cid: "QmUnwbLu1e8gqvqMjuytmcbKdjTAqn55az9ZUcmh1PdW8J", mime: "image/jpeg", width: 720, height: 1280 } },
  { key: "RAIN", creator: "demo_kai", name: "Rain Zine No. 1", symbol: "RAIN", description: "A first zine. Thin-name curve: liquidity front-loaded so early buyers fill at the issue price.", preset: "thin-name", format: "post", media: { cid: "QmY4VuQhFWeReFPrfUAJX3LXASnQHjb7UBAteZ4m4GDcXc", mime: "image/jpeg", width: 720, height: 1280 } },
  { key: "BTCX", creator: "demo_rio", name: "Bitcoin Tracker", symbol: "BTCX", description: "One token stands for 0.00000000001 BTC. Opened at Chainlink's BTC/USD on Arc mainnet on a tight-nav curve, and marked against it.", preset: "tight-nav", format: "post", tracker: { feed: "BTC/USD", unitsPerToken: 1e-11 }, media: { cid: "QmeZ89H8eJwqrdaRgH1FWrQebJEk9F6vk4SGPCrf4e2K7u", mime: "image/jpeg", width: 720, height: 1280 } },
  { key: "GOLDX", creator: "demo_ana", name: "Gold Tracker", symbol: "GOLDX", description: "One token stands for a billionth of a troy ounce, priced by Chainlink's PAXG/USD on Arc mainnet.", preset: "tight-nav", format: "post", tracker: { feed: "PAXG/USD", unitsPerToken: 1e-9 }, media: { cid: "QmRmKVEcSHCV2tEDA2UZ6JzBAG5CKsUPHPMWdwHiTvEau4", mime: "image/jpeg", width: 720, height: 1280 } },
  { key: "EURX", creator: "demo_lena", name: "Euro Tracker", symbol: "EURX", description: "A million tokens make one euro, opened at Chainlink's EUR/USD on Arc mainnet.", preset: "tight-nav", format: "post", tracker: { feed: "EUR/USD", unitsPerToken: 1e-6 }, media: { cid: "QmaLJFi1Z3zVqAPZhc6rHy1nxGrKrdzM7yJaUi4tXcvbpi", mime: "image/jpeg", width: 720, height: 1280 } },
];

/** A small coin for a whole life on a budget: filled, graduated, traded after, made cross-chain. */
const LIFECYCLE: Launch[] = [
  { key: "GRADV2", creator: "demo_kai", name: "Graduation, Uniswap v2", symbol: "GRADV2", description: "A deliberately small curve, filled and graduated into its Uniswap v2 USDC pair, traded there, then made a Chainlink CCIP Cross-Chain Token.", preset: "content", format: "post", caps: { initial: 0.5, migration: 12.5 }, media: { cid: "QmdPaKD9DuWJ9b2DSPoSQFLaBvKGPcpMs4Lq5XUVTPPd4t", mime: "image/jpeg", width: 3000, height: 2002 } },
];

async function launch(config: Config, progress: Progress, item: Launch, account: PrivateKeyAccount): Promise<Hex | null> {
  if (progress.launched[item.key]) return progress.launched[item.key];
  const still = item.media.poster ?? item.media.cid;
  // Token metadata is pinned on the API's Pinata key. A server without one (a
  // local demo) answers 503: the coin then launches with no metadata URI, said
  // here, and its media still comes from Juno's own records.
  const metadata = await call<{ uri: string }>("/metadata", {
    name: item.name,
    symbol: item.symbol,
    description: item.description,
    curvePreset: item.preset,
    imageUrl: `${IPFS}/${still}`,
    mimeType: "image/jpeg",
  }).catch((error: Error) => {
    if (!/^\/metadata 503/.test(error.message)) throw error;
    console.log(`  ${item.key}: token metadata not pinned (the API has no PINATA_JWT); launching without a metadata URI`);
    return { uri: "" };
  });
  // Every Juno coin on Arc is quoted in USDC; the server picks it.
  const built = await call<{ steps: Step[]; token: Hex }>("/tx/launch", {
    creator: account.address,
    name: item.name,
    symbol: item.symbol,
    preset: item.preset,
    uri: metadata.uri,
    ...(item.tracker ? { tracker: item.tracker } : {}),
    ...(item.caps ? { initialMarketCap: item.caps.initial, migrationMarketCap: item.caps.migration } : {}),
  }).catch((error: Error) => {
    // A tracker opens at a Chainlink price read from Arc mainnet; without it (offline, stale) it is skipped, said here.
    if (item.tracker && /\/tx\/launch (409|503|400)/.test(error.message)) {
      console.log(`  ${item.key}: skipped — ${error.message}`);
      return null;
    }
    throw error;
  });
  if (!built) return null;
  const landed = await signAndSubmit(account, built.steps);
  const last = landed[landed.length - 1];
  const token = last.launched?.token ?? built.token;
  await call("/pools", {
    token,
    name: item.name,
    symbol: item.symbol,
    format: item.format,
    curvePreset: item.preset,
    createTx: last.hash,
    description: item.description,
    mediaUrl: `ipfs://${item.media.cid}`,
    posterUrl: `ipfs://${still}`,
    mediaMime: item.media.mime,
    mediaWidth: item.media.width,
    mediaHeight: item.media.height,
    navFeedId: item.tracker?.feed,
    navUnitsPerToken: item.tracker?.unitsPerToken,
  });
  progress.launched[item.key] = token;
  saveProgress(config, progress);
  console.log(`  ${item.symbol.padEnd(9)} ${token}  by ${item.creator}  (${last.hash})`);
  return token;
}

/* ------------------------------------------------------------------ */
/* Trades                                                              */
/* ------------------------------------------------------------------ */

type Trade = { who: Name; coin: string; side: "buy" | "sell"; size: number; note?: string };

/** Sizes are in units: USDC on a buy, a share of the wallet's holding on a sell. */
const TRADES: Trade[] = [
  { who: "demo_kai", coin: "AVE", side: "buy", size: 2, note: "The light on that street." },
  { who: "demo_rio", coin: "AVE", side: "buy", size: 1 },
  { who: "demo_lena", coin: "NEON", side: "buy", size: 3, note: "Early on this one." },
  { who: "demo_ana", coin: "KICK", side: "buy", size: 2, note: "That landing though." },
  { who: "demo_kai", coin: "SURF", side: "buy", size: 1.5 },
  { who: "demo_rio", coin: "TIDE", side: "buy", size: 2 },
  { who: "demo_lena", coin: "BLOOM", side: "buy", size: 1 },
  { who: "demo_ana", coin: "FALLS", side: "buy", size: 1.5 },
  { who: "demo_kai", coin: "BTCX", side: "buy", size: 2, note: "Tracking the Chainlink mark closely." },
  { who: "demo_rio", coin: "GOLDX", side: "buy", size: 2 },
  { who: "demo_ana", coin: "EURX", side: "buy", size: 1 },
  { who: "demo_kai", coin: "DUSK", side: "buy", size: 1 },
  { who: "demo_rio", coin: "RAIN", side: "buy", size: 1, note: "Early on the first issue." },
  { who: "demo_rio", coin: "AVE", side: "sell", size: 0.5, note: "Took half off." },
  { who: "demo_ana", coin: "NEON", side: "buy", size: 1 },
];

async function holding(token: Hex, owner: Hex): Promise<number> {
  const { balance: held } = await call<{ balance: number }>(`/tx/balance?wallet=${owner}&token=${token}`);
  return held;
}

async function trade(
  config: Config,
  progress: Progress,
  id: string,
  who: PrivateKeyAccount,
  token: Hex,
  side: "buy" | "sell",
  amount: number,
  note?: string,
) {
  if (progress.done.includes(id)) return;
  if (!(amount > 0)) return;
  const built = await call<{ steps: Step[]; quote: { amountOut: number }; venue?: string }>("/tx/swap", {
    token,
    owner: who.address,
    side,
    amountIn: amount,
    slippageBps: 300,
  });
  const landed = await signAndSubmit(who, built.steps);
  const hash = landed[landed.length - 1].hash;
  if (note) await call("/comments", { token, wallet: who.address, body: note, side, txHash: hash }).catch(() => undefined);
  progress.done.push(id);
  saveProgress(config, progress);
  console.log(`  ${id.padEnd(28)} ${side} ${amount.toFixed(4)} → ${built.quote.amountOut.toFixed(4)}${built.venue && built.venue !== "curve" ? ` on ${built.venue}` : ""}`);
}

/* ------------------------------------------------------------------ */

run(async () => {
  const config = await call<Config>("/config");
  if (config.network === "mainnet" || config.chainId === 5042) {
    throw new Error("Demo data is for Arc testnet or a local fork, never mainnet.");
  }
  const rpc = config.localFork ? (arg("rpc") ?? "http://127.0.0.1:8910") : config.rpcUrl;
  // A unit of trading, in USDC: generous on a fork, small on testnet where the faucet is the budget.
  const unit = config.localFork ? 10 : 0.25;
  console.log(`Juno demo on ${config.localFork ? "a local fork of " : ""}${config.network} via ${API}, round ${ROUND}`);

  const accounts = Object.fromEntries(NAMES.map((name) => [name, wallet(config, name)])) as Record<Name, PrivateKeyAccount>;
  const progress = loadProgress(config);
  const lifecycle = ROUND === "lifecycle" || ROUND === "all";
  // demo_lena fills the lifecycle curve (about 3.5 USDC, sent with 30% to
  // spare and refunded); everyone else only trades small. parseEther is 18
  // decimals, which is exactly Arc's native USDC.
  if (config.localFork) {
    await fund(config, rpc, Object.values(accounts), parseEther("2000"));
  } else {
    await fund(config, rpc, NAMES.filter((name) => name !== "demo_lena").map((name) => accounts[name]), parseEther("1.5"));
    await fund(config, rpc, [accounts.demo_lena], parseEther(lifecycle ? "6" : "1.5"));
  }

  for (const name of NAMES) {
    if (progress.done.includes(`name:${name}`)) continue;
    await claimName(accounts[name], name).catch((error) => console.log(`  name ${name}: ${(error as Error).message}`));
    progress.done.push(`name:${name}`);
    saveProgress(config, progress);
  }

  if (ROUND === "content" || ROUND === "all" || ROUND === "trade") {
    console.log("Launches");
    for (const item of CONTENT) await launch(config, progress, item, accounts[item.creator]);
  }

  if (ROUND === "trade" || ROUND === "all") {
    console.log("Trades");
    for (const [index, step] of TRADES.entries()) {
      const token = progress.launched[step.coin];
      if (!token) continue;
      const who = accounts[step.who];
      const amount = step.side === "buy" ? step.size * unit : (await holding(token, who.address)) * step.size;
      await trade(config, progress, `${index}:${step.who}:${step.side}:${step.coin}`, who, token, step.side, amount, step.note);
    }
  }

  if (lifecycle) {
    console.log("Lifecycle");
    for (const item of LIFECYCLE) {
      const creator = accounts[item.creator];
      const token = await launch(config, progress, item, creator);
      if (!token) continue;
      const { coin } = await call<{
        coin: { curve: { complete: boolean; graduated: boolean; thresholdUsd: number }; quoteUsdRate: number | null };
      }>(`/coins/${token}`);
      const buyer = accounts.demo_lena;
      if (!coin.curve.complete && !coin.curve.graduated) {
        // A buy bigger than what is left fills it and refunds the rest.
        const rate = coin.quoteUsdRate ?? 1; // USDC
        const fill = (coin.curve.thresholdUsd / rate) * 1.3;
        await trade(config, progress, `fill:${item.key}`, buyer, token, "buy", fill);
      }
      if (!progress.done.includes(`graduate:${item.key}`)) {
        const built = await call<{ steps: Step[] }>("/tx/graduate", { from: buyer.address, token });
        const landed = await signAndSubmit(buyer, built.steps);
        progress.done.push(`graduate:${item.key}`);
        saveProgress(config, progress);
        console.log(`  graduate:${item.key.padEnd(20)} ${landed[landed.length - 1].hash}`);
      }
      // Trading carries on where it graduated to.
      await trade(config, progress, `after:${item.key}:buy`, accounts.demo_ana, token, "buy", unit * 0.5, "Bought after it graduated.");
      await trade(config, progress, `after:${item.key}:sell`, accounts.demo_ana, token, "sell", (await holding(token, accounts.demo_ana.address)) * 0.5);
      // The creator makes it a Chainlink CCIP Cross-Chain Token on Arc (lanes are wired once
      // its pool exists on the other chain: scripts/ccip-remote.ts). Best effort.
      if (!progress.done.includes(`ccip:${item.key}`)) {
        try {
          const built = await call<{ steps: Step[] }>("/tx/ccip-enable", { token, creator: creator.address });
          const landed = await signAndSubmit(creator, built.steps);
          progress.done.push(`ccip:${item.key}`);
          saveProgress(config, progress);
          console.log(`  ccip:${item.key.padEnd(25)} ${landed[landed.length - 1].hash}`);
        } catch (error) {
          console.log(`  ccip:${item.key}: not enabled — ${(error as Error).message}`);
        }
      }
    }
    // The creator's payday.
    const bloom = progress.launched.BLOOM;
    if (bloom && !progress.done.includes("claim:BLOOM")) {
      const built = await call<{ steps: Step[] }>("/tx/claim", { creator: accounts.demo_kai.address, token: bloom });
      const landed = await signAndSubmit(accounts.demo_kai, built.steps);
      progress.done.push("claim:BLOOM");
      saveProgress(config, progress);
      console.log(`  claim:BLOOM ${landed[landed.length - 1].hash}`);
    }
  }

  console.log("Done. Progress in", path.join(walletDir(config), "progress.json"));
});
