#!/usr/bin/env node
// Juno end to end on the local Arc fork, through the API, with real signed transactions.
//
//   node scripts/e2e-fork.mjs            # API on :8911 (JUNO_API_URL), fork on :8910 (ARC_RPC_URL)
//
// Fresh keys funded with anvil_setBalance do everything a person would: launch a photo post with a
// first buy, buy (Memo-tagged where Memo runs), a gasless relayed buy (EIP-3009), sell, fill the curve,
// graduate into Uniswap v2, buy on the pair, claim creator fees on Arc and cross-chain through CCTP V2,
// deposit into Circle Gateway, make the coin a Chainlink CCIP Cross-Chain Token and send it toward Base
// Sepolia, launch a Chainlink-tracked coin, and read the trackers and the USDC peg. Each transaction's
// hash and confirmMs is printed. Exits non-zero on any failure. Refuses to run against anything but a
// local node.

import { getAddress, keccak256, parseAbi, stringToBytes } from "viem";

import { API, RPC, assertLocalFork, fork, freshAccount, fund, get, post, signAndSubmit, signTyped } from "./lib/fork-client.mjs";
import { readFileSync } from "node:fs";

const BASE_SEPOLIA = "10344971235874465080";
const BASE_SEPOLIA_CCTP = 6;
const results = [];
let failures = 0;

function rec(step, r, extra = "") {
  const line = `  ✓ ${step.padEnd(34)} ${r.hash}  ${String(r.confirmMs ?? "—").padStart(5)} ms${extra ? `  ${extra}` : ""}`;
  console.log(line);
  results.push({ step, hash: r.hash, confirmMs: r.confirmMs ?? null, block: r.blockNumber ?? null, extra });
}

async function run(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    return await fn();
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
    return null;
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function bridgedOut() view returns (uint256)"]);
const launchpadAbi = parseAbi([
  "function buyNonce(address token, address buyer, uint256 quoteIn, uint256 minBaseOut, uint256 deadline, bytes32 salt) view returns (bytes32)",
]);
const gatewayAbi = parseAbi(["function availableBalance(address token, address depositor) view returns (uint256)"]);
const USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const chainId = await assertLocalFork();
  const config = await get("/api/juno/config");
  const deployment = JSON.parse(readFileSync(".fork/arc-fork.json", "utf8").replace(/:\s*(\d{16,})/g, ':"$1"'));
  must(getAddress(config.launchpad) === getAddress(deployment.launchpad), "the API is not pointed at the fork's deployment");
  console.log(`Juno e2e on the Arc fork — API ${API}, RPC ${RPC} (chain ${chainId})`);
  console.log(`launchpad ${config.launchpad}  memo live: ${config.arc.memo.live}  relayer: ${config.arc.relayer.address ?? "none"}`);

  const creator = freshAccount();
  const buyer = freshAccount();
  const gasless = freshAccount();
  const whale = freshAccount();
  await fund(creator.address, 100);
  await fund(buyer.address, 100);
  await fund(gasless.address, 0); // gets ERC-20 USDC by transfer below; holds nothing for gas
  await fund(whale.address, 20_000);
  console.log(`creator ${creator.address}\nbuyer   ${buyer.address}\ngasless ${gasless.address}\nwhale   ${whale.address}`);

  // 1. Launch a photo post with a first buy.
  const symbol = `MAR${Math.floor(Math.random() * 9000 + 1000)}`;
  const token = await run("Launch a photo post (content preset, 5 USDC first buy)", async () => {
    const built = await post("/api/juno/tx/launch", {
      creator: creator.address,
      name: "Sunset over Dubai Marina",
      symbol,
      preset: "content",
      uri: "",
      firstBuy: 5,
    });
    console.log(`  steps: ${built.steps.map((s) => s.label).join(" → ")}; memo ${built.memo.tagged ? "tagged" : "plain"} ${built.memo.id}`);
    const out = await signAndSubmit(creator, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? "launch" : "approve USDC", r, i === out.length - 1 && r.memo ? `memo "${r.memo.line}"` : ""));
    const launched = out.at(-1).launched;
    must(launched?.token === built.token, "the launch receipt names a different token");
    if (built.memo.tagged) must(out.at(-1).memo?.id === built.memo.id, "the launch was meant to be Memo-tagged but no Memo event came back");
    const pool = await post("/api/juno/pools", {
      token: launched.token,
      createTx: out.at(-1).hash,
      name: "Sunset over Dubai Marina",
      symbol,
      description: "Golden hour from the Marina walk. Every post is a market.",
      format: "post",
      curvePreset: "content",
      mediaUrl: "https://picsum.photos/seed/juno-marina/1000/1000",
      mediaMime: "image/jpeg",
      mediaWidth: 1000,
      mediaHeight: 1000,
    });
    must(pool.pool?.token === launched.token, "the pool was not recorded");
    console.log(`  coin ${launched.token}, pair ${launched.pair}`);
    return launched.token;
  });
  if (!token) throw new Error("no coin, nothing else can run");

  // 2. A buy, Memo-tagged where Memo runs.
  await run("Buy 10 USDC (Memo-tagged when live)", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "buy", amountIn: 10 });
    console.log(`  venue ${built.venue}; memo ${built.memo.tagged ? "TAGGED" : "PLAIN (Memo not live here)"}; quote ${built.quote.amountOut.toFixed(0)} tokens`);
    const out = await signAndSubmit(buyer, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? `buy (${built.memo.tagged ? "memo" : "plain"})` : "approve USDC", r, r.memo ? `memo "${r.memo.line}"` : ""));
    must(out.at(-1).trade?.side === "buy", "no buy recorded from the receipt");
    if (built.memo.tagged) must(out.at(-1).memo?.sender === buyer.address, "Memo event missing or not from the buyer");
  });

  // 3. A gasless relayed buy: the buyer signs EIP-3009, the relayer submits.
  await run("Gasless buy (EIP-3009, relayer pays gas)", async () => {
    must(config.arc.relayer.available, "no relayer configured");
    // The buyer holds ERC-20 USDC only (a transfer in), no gas of its own beyond it: buyer sends 6 USDC.
    const transfer = await signAndSubmit(buyer, [await buildTransfer(buyer.address, gasless.address, 6_000_000n)]);
    rec("fund gasless buyer (6 USDC)", transfer[0]);
    const intent = await post("/api/juno/tx/buy-intent", { token, owner: gasless.address, amountIn: 5 });
    const onchainNonce = await fork.readContract({
      address: config.launchpad,
      abi: launchpadAbi,
      functionName: "buyNonce",
      args: [token, gasless.address, BigInt(intent.intent.quoteIn), BigInt(intent.intent.minBaseOut), BigInt(intent.intent.deadline), intent.intent.salt],
    });
    must(onchainNonce === intent.typedData.message.nonce, `buy-intent nonce ${intent.typedData.message.nonce} != launchpad.buyNonce ${onchainNonce}`);
    console.log(`  typed-data nonce matches launchpad.buyNonce (${onchainNonce.slice(0, 18)}…)`);
    const signature = await signTyped(gasless, intent.typedData);
    const before = await fork.getBalance({ address: gasless.address });
    const r = await post("/api/juno/tx/buy-relayed", { intent: intent.intent, signature });
    rec(`gasless buy (relayed${r.memoTagged ? ", memo" : ""})`, r, `relayer ${r.relayer.slice(0, 10)}…`);
    const after = await fork.getBalance({ address: gasless.address });
    const held = await fork.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [gasless.address] });
    must(held > 0n, "the gasless buyer got no tokens");
    must(before - after === 5_000_000_000_000_000_000n, `the buyer paid ${before - after} wei, expected exactly 5 USDC and no gas`);
    console.log(`  buyer paid exactly 5 USDC, no gas; holds ${Number(held) / 1e18} tokens`);
  });

  // 4. A sell.
  await run("Sell half of the buyer's coins", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "sell", sellFraction: 0.5 });
    const out = await signAndSubmit(buyer, built.steps);
    rec(`sell (${built.memo.tagged ? "memo" : "plain"})`, out.at(-1), `${built.quote.amountOut.toFixed(4)} USDC`);
    must(out.at(-1).trade?.side === "sell", "no sell recorded");
  });

  // 5. Creator fees out through Circle CCTP V2 (burn on the fork; Iris will not attest a fork burn).
  let cctpHash = null;
  await run("Cross-chain creator fee claim (CCTP V2 → Base Sepolia)", async () => {
    const built = await post("/api/juno/tx/claim", { creator: creator.address, token, destinationDomain: BASE_SEPOLIA_CCTP });
    console.log(`  ${built.cctp.amount} USDC to ${built.cctp.destination} (domain ${built.cctp.destinationDomain}), maxFee ${built.cctp.maxFee}, threshold ${built.cctp.finalityThreshold}`);
    const out = await signAndSubmit(creator, built.steps);
    rec("claimCreatorFeesCrossChain", out[0], `burned ${out[0].cctp?.amount} USDC`);
    must(out[0].cctp?.destinationDomain === BASE_SEPOLIA_CCTP, "no CreatorFeesBridged in the receipt");
    cctpHash = out[0].hash;
    const status = await get(`/api/juno/cctp/status?hash=${cctpHash}`);
    console.log(`  Iris status: ${status.status}${status.note ? ` — ${status.note}` : ""}`);
    must(status.status === "pending", `expected pending for a fork burn, got ${status.status}`);
  });

  // 6. Fill the curve, then graduate.
  await run("Fill the curve (whale buy) and graduate", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: whale.address, side: "buy", amountIn: 12_000 });
    const out = await signAndSubmit(whale, built.steps);
    rec("buy that fills the curve", out.at(-1), out.at(-1).completed ? "curve complete" : "");
    must(out.at(-1).completed?.includes(token), "the curve did not complete");
    const grad = await post("/api/juno/tx/graduate", { from: whale.address, token });
    const g = await signAndSubmit(whale, grad.steps);
    rec("graduate → Uniswap v2", g[0], `pair ${g[0].graduated?.venue}`);
    must(g[0].graduated?.token === token, "no Graduated event");
  });

  // 7. Trade on the v2 pair through JunoSwapRouter.
  await run("Buy on the Uniswap v2 pair (router)", async () => {
    const built = await post("/api/juno/tx/swap", { token, owner: buyer.address, side: "buy", amountIn: 5 });
    must(built.venue === "uniswap-v2", `venue is ${built.venue}`);
    const out = await signAndSubmit(buyer, built.steps);
    rec("v2 buy", out.at(-1), `${out.at(-1).trades} trade(s)`);
    must(out.at(-1).trade?.venue === "uniswap-v2", "the v2 fill was not recorded");
  });

  // 8. Same-chain fee claim.
  await run("Creator fee claim on Arc", async () => {
    const built = await post("/api/juno/tx/claim", { creator: creator.address, token });
    const out = await signAndSubmit(creator, built.steps);
    rec("claimCreatorFees", out[0]);
  });

  // 9. Circle Gateway: deposit from Arc, read the unified balance, build and sign a burn intent.
  await run("Circle Gateway deposit from Arc", async () => {
    const built = await post("/api/juno/gateway/deposit", { owner: buyer.address, amount: 2 });
    const out = await signAndSubmit(buyer, built.steps);
    out.forEach((r, i) => rec(i === out.length - 1 ? "GatewayWallet.deposit" : "approve GatewayWallet", r));
    const available = await fork.readContract({ address: config.arc.gateway.wallet, abi: gatewayAbi, functionName: "availableBalance", args: [USDC, buyer.address] });
    must(available === 2_000_000n, `GatewayWallet.availableBalance = ${available}, expected 2 USDC`);
    console.log("  GatewayWallet.availableBalance on the fork: 2 USDC");
    const bal = await get(`/api/juno/gateway?depositor=${buyer.address}`).catch((e) => ({ error: e.message }));
    console.log(`  Circle /v1/balances (real testnet API; the fork deposit is not on testnet): ${bal.error ?? `total ${bal.total} USDC`}`);
    const intent = await post("/api/juno/gateway/intent", { depositor: buyer.address, sourceDomain: 26, amount: 1 });
    const signature = await signTyped(buyer, intent.typedData);
    const mint = await post("/api/juno/gateway/mint", { burnIntent: intent.typedData.message, signature }).then(
      (m) => `minted ${m.mintTxHash}`,
      (e) => `Circle refused (expected: the deposit exists only on the fork): ${e.message}`,
    );
    console.log(`  signed burn intent (maxFee ${intent.maxFee} USDC) → ${mint}`);
  });

  // 10. Chainlink CCIP: enable the coin as a Cross-Chain Token, wire Base Sepolia, send.
  await run("CCIP: enable, wire Base Sepolia, ccipSend", async () => {
    const enable = await post("/api/juno/tx/ccip-enable", { token, creator: creator.address });
    const e = await signAndSubmit(creator, enable.steps);
    rec("JunoCrossChain.enable", e[0], `pool ${e[0].ccipEnabled?.pool}`);
    must(e[0].ccipEnabled?.token === token, "no CrossChainEnabled event");
    // The Base Sepolia side (scripts/ccip-remote.ts) is not deployed from here: placeholders stand in on the fork.
    const wire = await post("/api/juno/tx/ccip-chains", {
      token,
      creator: creator.address,
      add: [{ selector: BASE_SEPOLIA, remotePool: "0x00000000000000000000000000000000ba5e9001", remoteToken: "0x00000000000000000000000000000000ba5e7070" }],
    });
    const w = await signAndSubmit(creator, wire.steps);
    rec("applyChainUpdates (Base Sepolia)", w[0], "remote pool/token: fork placeholders");
    const status = await get(`/api/juno/ccip/${token}`);
    must(status.enabled && status.chains.some((c) => c.selector === BASE_SEPOLIA), "the lane is not on the pool");
    console.log(`  pool ${status.pool}; registry pool ${status.registryPool}; ccipAdmin ${status.ccipAdmin}; outbound cap ${status.chains[0].outbound?.capacity}`);
    const supplyBefore = await fork.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" });
    const send = await post("/api/juno/tx/ccip-send", { token, owner: whale.address, amount: 1_000_000, destination: BASE_SEPOLIA });
    console.log(`  fee ${send.fee.usdc} USDC (native) to ${send.lane.name}`);
    const s = await signAndSubmit(whale, send.steps);
    const last = s.at(-1);
    s.forEach((r, i) => rec(i === s.length - 1 ? "Router.ccipSend" : "approve Router", r, i === s.length - 1 ? `messageId ${r.ccipMessageId}` : ""));
    must(/^0x[0-9a-f]{64}$/i.test(last.ccipMessageId ?? ""), "no CCIP message id decoded from the receipt");
    console.log(`  ${last.ccipExplorerUrl}  (fork message: the explorer won't have it)`);
    const supplyAfter = await fork.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" });
    must(supplyBefore - supplyAfter === 1_000_000n * 10n ** 18n, "the pool did not burn the sent amount on Arc");
    console.log("  1,000,000 tokens burned on Arc by the pool");
  });

  // 11. Chainlink Data Feeds: trackers, the peg, and a tracker coin.
  await run("Chainlink trackers, peg and a BTC tracker launch", async () => {
    const trackers = await get("/api/juno/trackers");
    const btc = trackers.feeds.find((f) => f.id === "BTC/USD");
    must(btc && btc.priceUsd > 0, "no BTC/USD reading");
    console.log(`  ${trackers.feeds.length} feeds from ${trackers.source}; BTC/USD $${btc.priceUsd.toFixed(2)} (${btc.ageSeconds}s old, ${btc.stale ? "STALE" : "live"}); on-chain here: ${btc.onchain}`);
    const peg = await get("/api/juno/peg");
    console.log(`  USDC/USD ${peg.usdcUsd} (${peg.source}, ${peg.stale ? "stale" : "live"})`);
    must(peg.usdcUsd > 0.9 && peg.usdcUsd < 1.1, "peg out of range");
    const ubtc = `UBTC${Math.floor(Math.random() * 90 + 10)}`;
    const built = await post("/api/juno/tx/launch", {
      creator: creator.address,
      name: "Bitcoin tracker",
      symbol: ubtc,
      preset: "tight-nav",
      uri: "",
      tracker: { feed: "BTC/USD", unitsPerToken: 0.000000001 },
    });
    console.log(`  opens at $${built.tracker.openingPriceUsd.toFixed(6)} = ${built.tracker.source} × 0.000000001; JunoTrackers step: ${built.tracker.onchain ? "yes" : "no (feed not registered on this network; ratio recorded off chain)"}`);
    const out = await signAndSubmit(creator, built.steps);
    rec("tracker launch", out.at(-1));
    await post("/api/juno/pools", {
      token: out.at(-1).launched.token,
      createTx: out.at(-1).hash,
      name: "Bitcoin tracker",
      symbol: ubtc,
      format: "post",
      curvePreset: "tight-nav",
      navFeedId: "BTC/USD",
      navUnitsPerToken: 0.000000001,
    });
    const coin = await get(`/api/juno/coins/${out.at(-1).launched.token}`);
    const nav = coin.coin?.nav ?? coin.nav;
    must(nav?.source === "chainlink", "the coin page has no Chainlink NAV");
    console.log(`  coin page NAV: ${nav.sourceLabel} $${nav.priceUsd.toFixed(2)}, implied $${nav.impliedUsd?.toFixed(2)}, deviation ${(nav.deviation * 100).toFixed(3)}%, within band: ${nav.withinBand}`);
  });

  // 12. Faucet (relayer → a fresh address).
  await run("Testnet faucet", async () => {
    const someone = freshAccount();
    const r = await post("/api/juno/faucet", { address: someone.address });
    rec("faucet 1 USDC", { hash: r.hash, confirmMs: r.confirmMs });
    const bal = await fork.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [someone.address] });
    must(bal === BigInt(r.amount * 1e6), `faucet recipient holds ${bal}`);
  });

  console.log("\nSummary");
  for (const r of results) console.log(`  ${r.step.padEnd(34)} ${r.hash}  ${String(r.confirmMs ?? "—").padStart(5)} ms`);
  const times = results.map((r) => r.confirmMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
  if (times.length) console.log(`  ${times.length} transactions; confirmMs median ${times[Math.floor(times.length / 2)]} ms (local fork, 1 s blocks — not Arc's own timing)`);
  if (failures > 0) {
    console.log(`\n${failures} step(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll steps passed.");
}

/** A plain USDC transfer, built here (the API has no transfer route). */
async function buildTransfer(from, to, units) {
  const { encodeFunctionData, toHex } = await import("viem");
  const [nonce, fees, gas] = await Promise.all([
    fork.getTransactionCount({ address: from, blockTag: "pending" }),
    fork.estimateFeesPerGas(),
    fork.estimateGas({
      account: from,
      to: USDC,
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [to, units] }),
    }),
  ]);
  return {
    label: "USDC transfer",
    request: {
      type: "eip1559",
      chainId: 5042002,
      to: USDC,
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [to, units] }),
      value: "0x0",
      nonce,
      gas: toHex((gas * 12n) / 10n),
      maxFeePerGas: toHex(fees.maxFeePerGas),
      maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
    },
  };
}

void keccak256;
void stringToBytes;
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
