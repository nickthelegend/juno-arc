#!/usr/bin/env node
// Juno end to end on the REAL Arc testnet (chain 5042002), through the API, with real signed transactions.
//
//   node scripts/e2e-testnet.mjs
//
// Needs the API running against https://rpc.testnet.arc.io (JUNO_API_URL, default http://127.0.0.1:8911) with a
// funded relayer, and the shared deployer key file (DEPLOYER_ENV_FILE, default ../.deployer/deployer.env), which is
// read here and never printed. Budget: the deployer sends ~0.65 testnet USDC to three fresh throwaway accounts
// (under the shared lock so nonces don't collide); whatever is left is swept back at the end.
//
//   1. upload a generated image + token metadata (Pinata, or the server's demo storage when no key is set)
//   2. launch a post coin with a 0.1 USDC first buy        (Memo-tagged)
//   3. buy                                                  (Memo-tagged)
//   4. gasless relayed buy (EIP-3009; the relayer pays gas, the buyer pays exactly the trade)
//   5. sell half
//   6. creator-fee claim on Arc, then (best effort) the same fees out through CCTP V2 -> Base Sepolia (a real
//      Arc burn, attested by Circle's Iris; the Base Sepolia mint is user-run)
//   7. Circle Gateway deposit from Arc (best effort, 0.02 USDC)
// NOT exercised live (see docs/E2E-TESTNET.md): graduation (needs ~$28 locked: fork-proven), CCIP enable/send
// (needs a graduated coin), Chainlink feeds (mainnet only).
//
// Writes docs/e2e-testnet.json (every hash, with its explorer link) and exits non-zero on a failed step.

import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";

import { API, RPC, freshAccount, get, post, signAndSubmit, signTyped } from "./lib/fork-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DEPLOYER_ENV = process.env.DEPLOYER_ENV_FILE || resolve(ROOT, "../.deployer/deployer.env");
const LOCK = process.env.DEPLOYER_LOCK || resolve(dirname(DEPLOYER_ENV), "lock");
const EXPLORER = "https://explorer.testnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000";
const BASE_SEPOLIA_CCTP = 6;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
});
const chain = createPublicClient({ chain: arcTestnet, transport: http(RPC, { timeout: 60_000 }) });

const results = [];
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const link = (hash) => `${EXPLORER}/tx/${hash}`;

function rec(step, r, extra = "") {
  console.log(`  ✓ ${step.padEnd(36)} ${r.hash}  ${String(r.confirmMs ?? "—").padStart(5)} ms  ${link(r.hash)}${extra ? `  ${extra}` : ""}`);
  results.push({ step, hash: r.hash, confirmMs: r.confirmMs ?? null, block: r.blockNumber ?? null, explorer: link(r.hash), note: extra });
}

async function run(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    return await fn();
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
    results.push({ step: name, failed: String(error?.message ?? error) });
    return null;
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

/** The deployer key from its env file, held in memory only. */
function deployerAccount() {
  const text = readFileSync(DEPLOYER_ENV, "utf8");
  const line = text.split("\n").find((l) => l.startsWith("DEPLOYER_PRIVATE_KEY="));
  must(line, `no DEPLOYER_PRIVATE_KEY in ${DEPLOYER_ENV}`);
  const key = line.slice("DEPLOYER_PRIVATE_KEY=".length).trim().replace(/^["']|["']$/g, "");
  return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
}

async function withLock(fn) {
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      await sleep(3000);
    }
  }
  try {
    return await fn();
  } finally {
    rmdirSync(LOCK);
  }
}

/** Native USDC transfer (Arc's gas token is USDC; 18 decimals natively). */
async function sendNative(account, to, wei) {
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });
  const hash = await wallet.sendTransaction({ to, value: wei });
  await chain.waitForTransactionReceipt({ hash });
  return hash;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const launchpadAbi = parseAbi([
  "function buyNonce(address token, address buyer, uint256 quoteIn, uint256 minBaseOut, uint256 deadline, bytes32 salt) view returns (bytes32)",
]);
const gatewayAbi = parseAbi(["function availableBalance(address token, address depositor) view returns (uint256)"]);

async function postImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#3b5bdb"/></linearGradient></defs><rect width="800" height="800" fill="url(#g)"/><circle cx="560" cy="250" r="120" fill="#ffd43b" opacity=".9"/><text x="60" y="690" font-family="Helvetica" font-size="54" fill="#fff">Juno on Arc testnet</text><text x="60" y="745" font-family="Helvetica" font-size="30" fill="#c5d0ff">e2e launch ${new Date().toISOString().slice(0, 10)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const chainId = await chain.getChainId();
  must(chainId === 5042002, `${RPC} is chain ${chainId}, not Arc testnet`);
  must(!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(RPC), `${RPC} is a local node: this script is for the real testnet (use e2e-fork.mjs for a fork)`);
  const config = await get("/api/juno/config");
  const deployment = JSON.parse(readFileSync(resolve(ROOT, "deployments/arc-testnet.json"), "utf8").replace(/:\s*(\d{16,})/g, ':"$1"'));
  must(getAddress(config.launchpad) === getAddress(deployment.launchpad), "the API is not pointed at deployments/arc-testnet.json");
  must(!config.localFork, "the API says it is on a local fork");
  console.log(`Juno e2e on Arc TESTNET — API ${API}, RPC ${RPC} (chain ${chainId})`);
  console.log(`launchpad ${config.launchpad}  memo live: ${config.arc.memo.live}  relayer: ${config.arc.relayer.address ?? "none"}  storage: ${config.storage}`);

  const creator = freshAccount();
  const buyer = freshAccount();
  const gasless = freshAccount();
  const deployer = deployerAccount();
  console.log(`deployer ${deployer.address}\ncreator  ${creator.address}\nbuyer    ${buyer.address}\ngasless  ${gasless.address}`);

  await run("Fund three throwaway accounts from the deployer (0.30 + 0.20 + 0.15 USDC)", async () => {
    await withLock(async () => {
      for (const [who, usdc] of [[creator, "0.30"], [buyer, "0.20"], [gasless, "0.15"]]) {
        const hash = await sendNative(deployer, who.address, parseEther(usdc));
        rec(`fund ${who.address.slice(0, 8)}… ${usdc} USDC`, { hash });
      }
    });
  });

  // 1-2. Upload + metadata + launch with a first buy.
  const symbol = `JTN${Math.floor(Math.random() * 9000 + 1000)}`;
  const token = await run("Launch a post coin (image upload, metadata, 0.1 USDC first buy)", async () => {
    const png = await postImage();
    const form = new FormData();
    form.append("file", new File([png], "juno-testnet.png", { type: "image/png" }));
    const upRes = await fetch(`${API}/api/juno/upload`, { method: "POST", body: form });
    const up = await upRes.json();
    must(upRes.ok, `upload: ${up.error ?? upRes.status}`);
    console.log(`  image ${up.uri} (${up.storage}) ${up.width}x${up.height}`);
    const meta = await post("/api/juno/metadata", {
      name: "Juno testnet sunset",
      symbol,
      description: "Posted by scripts/e2e-testnet.mjs on Arc testnet.",
      curvePreset: "content",
      imageUrl: up.url,
      mimeType: up.mimeType,
    });
    console.log(`  metadata ${meta.uri} (${meta.storage})`);
    const built = await post("/api/juno/tx/launch", {
      creator: creator.address,
      name: "Juno testnet sunset",
      symbol,
      preset: "content",
      uri: meta.uri,
      firstBuy: 0.1,
    });
    console.log(`  steps: ${built.steps.map((s) => s.label).join(" -> ")}; memo ${built.memo.tagged ? "tagged" : "plain"}`);
    const out = await signAndSubmit(creator, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? "launch (JunoLaunchpad.create + first buy)" : "approve USDC", r, i === out.length - 1 && r.memo ? `memo "${r.memo.line}"` : ""));
    const launched = out.at(-1).launched;
    must(launched?.token === built.token, "the launch receipt names a different token");
    if (built.memo.tagged) must(out.at(-1).memo?.id === built.memo.id, "launch was meant to be Memo-tagged, no Memo event came back");
    const pool = await post("/api/juno/pools", {
      token: launched.token,
      createTx: out.at(-1).hash,
      name: "Juno testnet sunset",
      symbol,
      description: "Posted by scripts/e2e-testnet.mjs on Arc testnet.",
      format: "post",
      curvePreset: "content",
      mediaUrl: up.uri,
      mediaMime: up.mimeType,
      mediaWidth: up.width,
      mediaHeight: up.height,
    });
    must(pool.pool?.token === launched.token, "the pool was not recorded");
    const read = await get(`/api/juno/coins/${launched.token}`);
    must(read.coin ?? read.pool ?? read, "the coin page returned nothing");
    console.log(`  coin ${launched.token}  ${EXPLORER}/token/${launched.token}`);
    results.push({ step: "coin", token: launched.token, explorer: `${EXPLORER}/token/${launched.token}`, symbol });
    return launched.token;
  });
  if (!token) throw new Error("no coin, nothing else can run");

  // 3. Buy.
  await run("Buy 0.10 USDC (Memo-tagged)", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "buy", amountIn: 0.1 });
    console.log(`  venue ${built.venue}; memo ${built.memo.tagged ? "TAGGED" : "PLAIN"}; quote ${built.quote.amountOut.toFixed(0)} tokens`);
    const out = await signAndSubmit(buyer, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? `buy (${built.memo.tagged ? "memo" : "plain"})` : "approve USDC", r, r.memo ? `memo "${r.memo.line}"` : ""));
    must(out.at(-1).trade?.side === "buy", "no buy recorded from the receipt");
  });

  // 4. Gasless relayed buy.
  await run("Gasless buy (EIP-3009, relayer pays gas)", async () => {
    must(config.arc.relayer.available, "no relayer configured");
    const intent = await post("/api/juno/tx/buy-intent", { token, owner: gasless.address, amountIn: 0.05 });
    const onchainNonce = await chain.readContract({
      address: config.launchpad,
      abi: launchpadAbi,
      functionName: "buyNonce",
      args: [token, gasless.address, BigInt(intent.intent.quoteIn), BigInt(intent.intent.minBaseOut), BigInt(intent.intent.deadline), intent.intent.salt],
    });
    must(onchainNonce === intent.typedData.message.nonce, "buy-intent nonce differs from launchpad.buyNonce");
    const signature = await signTyped(gasless, intent.typedData);
    const before = await chain.getBalance({ address: gasless.address });
    const r = await post("/api/juno/tx/buy-relayed", { intent: intent.intent, signature });
    rec(`gasless buy (relayed${r.memoTagged ? ", memo" : ""})`, r, `relayer ${r.relayer.slice(0, 10)}…`);
    const after = await chain.getBalance({ address: gasless.address });
    const held = await chain.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [gasless.address] });
    must(held > 0n, "the gasless buyer got no tokens");
    must(before - after === 50_000_000_000_000_000n, `the buyer paid ${before - after} wei, expected exactly 0.05 USDC and no gas`);
    console.log(`  buyer paid exactly 0.05 USDC, no gas; holds ${Number(held) / 1e18} tokens`);
  });

  // 5. Sell.
  await run("Sell half of the buyer's coins", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "sell", sellFraction: 0.5 });
    const out = await signAndSubmit(buyer, built.steps);
    rec(`sell (${built.memo.tagged ? "memo" : "plain"})`, out.at(-1), `${built.quote.amountOut.toFixed(4)} USDC out`);
    must(out.at(-1).trade?.side === "sell", "no sell recorded");
  });

  // 6a. Creator fees on Arc.
  await run("Creator fee claim on Arc", async () => {
    const built = await post("/api/juno/tx/claim", { creator: creator.address, token });
    const out = await signAndSubmit(creator, built.steps);
    rec("claimCreatorFees", out[0]);
  });

  // 6b. Best effort: more trades, then the creator's fees out through CCTP V2 (a real Arc burn).
  await run("Creator fees cross-chain: CCTP V2 burn on Arc -> Base Sepolia (best effort)", async () => {
    const more = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "buy", amountIn: 0.05 });
    await signAndSubmit(buyer, more.steps);
    const built = await post("/api/juno/tx/claim", { creator: creator.address, token, destinationDomain: BASE_SEPOLIA_CCTP });
    console.log(`  ${built.cctp.amount} USDC to ${built.cctp.destination} (domain ${built.cctp.destinationDomain}), maxFee ${built.cctp.maxFee}`);
    const out = await signAndSubmit(creator, built.steps);
    rec("claimCreatorFeesCrossChain (CCTP depositForBurn)", out[0], `burned ${out[0].cctp?.amount} USDC`);
    must(out[0].cctp?.destinationDomain === BASE_SEPOLIA_CCTP, "no CreatorFeesBridged in the receipt");
    // Circle's Iris (sandbox) attests an Arc burn within seconds; poll up to 2 minutes.
    let status = await get(`/api/juno/cctp/status?hash=${out[0].hash}`);
    for (let i = 0; i < 24 && status.status !== "complete"; i += 1) {
      await sleep(5000);
      status = await get(`/api/juno/cctp/status?hash=${out[0].hash}`);
    }
    console.log(`  Iris status: ${status.status}${status.note ? ` — ${status.note}` : ""} (the mint on ${built.cctp.destination} needs a ${built.cctp.destination} transaction and is user-run)`);
    results.push({ step: "cctp-iris-status", status: status.status, note: status.note ?? null, attested: status.status === "complete", destination: built.cctp.destination });
  });

  // 7. Gateway deposit from Arc.
  await run("Circle Gateway deposit from Arc (best effort, 0.02 USDC)", async () => {
    const built = await post("/api/juno/gateway/deposit", { owner: gasless.address, amount: 0.02 });
    const out = await signAndSubmit(gasless, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? "GatewayWallet.deposit" : "approve GatewayWallet", r));
    const available = await chain.readContract({ address: config.arc.gateway.wallet, abi: gatewayAbi, functionName: "availableBalance", args: [USDC, gasless.address] });
    console.log(`  GatewayWallet.availableBalance on Arc testnet: ${Number(available) / 1e6} USDC`);
    results.push({ step: "gateway-balance", usdc: Number(available) / 1e6 });
  });

  // Reads a judge would hit.
  await run("Feed, coin page and trade tape show the launch", async () => {
    const feed = await get("/api/juno/feed");
    const items = feed.items ?? feed.posts ?? feed.pools ?? [];
    console.log(`  feed has ${items.length} item(s); ours listed: ${JSON.stringify(items).includes(token.toLowerCase()) || JSON.stringify(items).includes(token)}`);
    const coin = await get(`/api/juno/coins/${token}`);
    console.log(`  coin: ${JSON.stringify(coin).slice(0, 160)}…`);
  });

  // Sweep what is left back to the deployer.
  await run("Sweep leftovers back to the deployer", async () => {
    const fees = await chain.estimateFeesPerGas();
    const reserve = fees.maxFeePerGas * 21_000n * 2n;
    let returned = 0n;
    for (const who of [creator, buyer, gasless]) {
      const bal = await chain.getBalance({ address: who.address });
      const value = bal - reserve;
      if (value <= 0n) continue;
      await sendNative(who, deployer.address, value);
      returned += value;
    }
    console.log(`  returned ${Number(returned) / 1e18} USDC to the deployer`);
    results.push({ step: "sweep", returnedUsdc: Number(returned) / 1e18 });
  });

  const out = resolve(ROOT, "docs/e2e-testnet.json");
  writeFileSync(out, `${JSON.stringify({ network: "arc-testnet", chainId, at: new Date().toISOString(), api: "local", launchpad: config.launchpad, results }, null, 2)}\n`);
  console.log(`\nWrote ${out}`);
  if (failures > 0) {
    console.log(`${failures} step(s) FAILED`);
    process.exit(1);
  }
  console.log("All steps passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

void erc20;
