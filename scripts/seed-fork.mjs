#!/usr/bin/env node
// Demo content for the local Arc fork, seeded through the API as real signed transactions
// (used by scripts/local-demo.sh). A few creators post photos, a crowd buys and sells, one
// coin fills its curve and graduates into Uniswap v2, and one coin tracks Chainlink's
// BTC/USD. Keys are throwaway, generated per run and funded with anvil_setBalance.
//
//   JUNO_API_URL=http://127.0.0.1:8911 ARC_RPC_URL=http://127.0.0.1:8910 node scripts/seed-fork.mjs

import { assertLocalFork, freshAccount, fund, post, signAndSubmit } from "./lib/fork-client.mjs";

const POSTS = [
  { name: "Sunset over Dubai Marina", symbol: "MARINA", seed: "marina", text: "Golden hour from the Marina walk." },
  { name: "Night market in Satwa", symbol: "SATWA", seed: "satwa", text: "Karak, samosas and a thousand lights." },
  { name: "Desert drive at dawn", symbol: "DUNE", seed: "dune", text: "Liwa before the heat." },
  { name: "Rooftop jazz, Thursday", symbol: "JAZZ", seed: "jazz", text: "The trio that never takes a break." },
  { name: "Abra crossing", symbol: "ABRA", seed: "abra", text: "One dirham, best view in the city." },
];

const say = (...args) => console.log(...args);

async function launch(creator, p, firstBuy) {
  const symbol = `${p.symbol}${Math.floor(Math.random() * 90 + 10)}`;
  const built = await post("/api/juno/tx/launch", { creator: creator.address, name: p.name, symbol, preset: "content", uri: "", firstBuy });
  const out = await signAndSubmit(creator, built.steps);
  const last = out.at(-1);
  await post("/api/juno/pools", {
    token: last.launched.token,
    createTx: last.hash,
    name: p.name,
    symbol,
    description: p.text,
    format: "post",
    curvePreset: "content",
    mediaUrl: `https://picsum.photos/seed/juno-${p.seed}/1000/1000`,
    mediaMime: "image/jpeg",
    mediaWidth: 1000,
    mediaHeight: 1000,
  });
  say(`launched $${symbol} ${last.launched.token} (${last.hash}, ${last.confirmMs} ms${last.memo ? ", memo" : ""})`);
  return last.launched.token;
}

async function trade(account, token, side, amount) {
  const body = side === "buy" ? { token, owner: account.address, side, amountIn: amount } : { token, owner: account.address, side, sellFraction: amount };
  const built = await post("/api/juno/tx/swap", body);
  const out = await signAndSubmit(account, built.steps);
  say(`  ${side} ${side === "buy" ? `${amount} USDC` : `${amount * 100}%`} → ${out.at(-1).hash} (${out.at(-1).confirmMs} ms)`);
}

async function main() {
  await assertLocalFork();
  const creators = [freshAccount(), freshAccount(), freshAccount()];
  const crowd = [freshAccount(), freshAccount(), freshAccount(), freshAccount()];
  for (const a of [...creators, ...crowd]) await fund(a.address, 500);
  const whale = freshAccount();
  await fund(whale.address, 20_000);

  const tokens = [];
  for (const [i, p] of POSTS.entries()) tokens.push(await launch(creators[i % creators.length], p, 2 + i));

  for (const [i, token] of tokens.entries()) {
    for (const [j, buyer] of crowd.entries()) {
      if ((i + j) % 2 === 0) await trade(buyer, token, "buy", 3 + i * 2 + j);
    }
    await trade(crowd[i % crowd.length], token, "sell", 0.5).catch((e) => say(`  (no sell: ${e.message})`));
  }

  // The first post fills its curve and graduates into its Uniswap v2 pair.
  const built = await post("/api/juno/tx/swap", { token: tokens[0], owner: whale.address, side: "buy", amountIn: 12_000 });
  await signAndSubmit(whale, built.steps);
  const grad = await post("/api/juno/tx/graduate", { from: whale.address, token: tokens[0] });
  const g = await signAndSubmit(whale, grad.steps);
  say(`graduated ${tokens[0]} → pair ${g[0].graduated?.venue}`);
  await trade(crowd[0], tokens[0], "buy", 5);

  // A tracker coin: one token stands for 1e-9 BTC, opened at Chainlink's BTC/USD (Arc mainnet).
  const tracker = await post("/api/juno/tx/launch", {
    creator: creators[0].address,
    name: "Bitcoin tracker",
    symbol: `NBTC${Math.floor(Math.random() * 90 + 10)}`,
    preset: "tight-nav",
    uri: "",
    tracker: { feed: "BTC/USD", unitsPerToken: 0.000000001 },
  });
  const t = await signAndSubmit(creators[0], tracker.steps);
  await post("/api/juno/pools", {
    token: t.at(-1).launched.token,
    createTx: t.at(-1).hash,
    name: "Bitcoin tracker",
    symbol: "NBTC",
    description: "One token = 0.000000001 BTC, marked against Chainlink BTC/USD.",
    format: "post",
    curvePreset: "tight-nav",
    navFeedId: "BTC/USD",
    navUnitsPerToken: 0.000000001,
  });
  say(`tracker ${t.at(-1).launched.token} opens at $${tracker.tracker.openingPriceUsd.toFixed(6)} (${tracker.tracker.source})`);
  say(`seeded ${tokens.length + 1} coins`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
