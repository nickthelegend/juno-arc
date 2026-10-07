/**
 * Launch a Juno coin on Arc from the command line.
 *
 * Builds the call with `planLaunch` — the same path `POST /api/juno/tx/launch`
 * uses — signs it with the local script key, and records the launch with the
 * running app. The fastest way to prove a curve is accepted on-chain, and it
 * prints the Arc explorer links a submission needs.
 *
 * Every Juno curve is quoted in Circle USDC (6 decimals), which is also Arc's
 * gas, so one balance pays for the launch, its first buy and the gas. A first
 * buy is pulled with `transferFrom`, so it needs a USDC approval first (sent
 * here when missing); nothing is sent as `msg.value`.
 *
 *   npm run juno:launch -- --preset ipo-book --name "Night Market Book" --symbol NIGHTB
 *   npm run juno:launch -- --preset content --name "Night Market" --symbol NIGHT --first-buy 1 --yes
 *
 * Options:
 *   --preset content|thin-name|ipo-book|tight-nav   (default content)
 *   --initial N --migration N   opening / graduation valuations in USDC.
 *                               Default: $1,000 and the preset's own range
 *                               above it (25x for a launch, 1.5x for tight-nav).
 *   --first-buy N               buy N USDC of it in the same transaction
 *   --description, --image <gateway url>, --nav <Chainlink feed, e.g. BTC/USD>,
 *   --format post|reel, --media, --poster, --mime, --width, --height
 *   --no-memo                   don't tag a first buy with Arc's Memo
 *   --yes                       send it (otherwise a dry run: plan + gas estimate)
 *
 * The coin graduates into its TOKEN/USDC pair on Uniswap's published v2
 * factory, the only venue on Arc. Testnet unless NEXT_PUBLIC_ARC_NETWORK=mainnet;
 * addresses come from the deployment record (JUNO_DEPLOYMENT_FILE, else
 * deployments/arc-<network>.json). Signs with JUNO_SCRIPT_PRIVATE_KEY or
 * `.juno/launcher.key` (created on first run).
 *
 * Imports only `lib/juno` modules without `server-only`, which throws outside
 * Next's bundler — see `scripts/lib/cli.ts`.
 */

import { zeroAddress, type Address } from "viem";

import { CURVE_PRESETS, buildPresetParams } from "../lib/juno/curves";
import { sqrtX96ToPrice } from "../lib/juno/curve-math";
import { buildApproveCall, planLaunch, quoteAllowance, uiToWei, usdcQuote } from "../lib/juno/launchpad";
import { memoLine } from "../lib/juno/memo";
import { requireLaunchpad } from "../lib/juno/network";
import { pinTokenMetadata } from "../lib/juno/pinata";
import { quoteTokenUsdPrice } from "../lib/juno/usd";
import type { CurvePresetId } from "../lib/juno/types";
import {
  amount,
  apiBase,
  appBase,
  arg,
  describeError,
  estimate,
  flag,
  header,
  launchpadEvents,
  line,
  links,
  numberArg,
  requireBalance,
  run,
  scriptAccount,
  send,
  tagWithMemo,
} from "./lib/cli";

/** The app's default launch size, in dollars — see `lib/juno/tx.ts`. */
const DEFAULT_INITIAL_USD = 1_000;

/** Gas to keep on top of any first buy, in native (18-dec) USDC: $0.20. A launch costs cents on Arc. */
const GAS_ALLOWANCE = 2n * 10n ** 17n;

async function main() {
  const preset = (arg("preset", "content") ?? "content") as CurvePresetId;
  if (!CURVE_PRESETS[preset]) {
    throw new Error(`Unknown preset "${preset}". One of: ${Object.keys(CURVE_PRESETS).join(", ")}`);
  }
  const name = arg("name", "Juno Test Launch")!;
  const symbol = arg("symbol", "JUNOTEST")!;
  // USDC is the only quote token on Arc, and a Uniswap v2 pair the only venue.
  const quote = usdcQuote();
  if (arg("quote") && arg("quote")!.toLowerCase() !== "usdc") throw new Error("Juno coins on Arc are quoted in USDC only.");
  if (arg("venue") && arg("venue") !== "uniswap-v2") throw new Error("Juno coins on Arc graduate into a Uniswap v2 pair only.");
  const venue = "uniswap-v2" as const;
  const firstBuy = numberArg("first-buy", 0)!;

  const account = scriptAccount();
  header(account.address);
  const launchpad = requireLaunchpad();
  line("launchpad", launchpad);
  line("preset", `${CURVE_PRESETS[preset].label} — ${CURVE_PRESETS[preset].tagline}`);
  line("quote", `${quote.symbol} (${quote.address})`);

  // Valuations: explicit in USDC, or the app's dollar defaults (1 USDC = $1).
  let initialMarketCap = numberArg("initial");
  let migrationMarketCap = numberArg("migration");
  if (initialMarketCap === undefined || migrationMarketCap === undefined) {
    const usd = await quoteTokenUsdPrice(quote.address);
    if (!usd || !(usd > 0)) {
      throw new Error(`No USD price for ${quote.symbol} right now. Pass --initial and --migration in ${quote.symbol}.`);
    }
    initialMarketCap ??= DEFAULT_INITIAL_USD / usd;
    // The preset's own range above the opening: 25x for a launch, 1.5x for tight-nav.
    migrationMarketCap ??= (DEFAULT_INITIAL_USD * CURVE_PRESETS[preset].defaultCapMultiple) / usd;
    line("price", `1 ${quote.symbol} = $${usd}`);
  }

  const curve = buildPresetParams({ preset, initialMarketCap, migrationMarketCap, quoteDecimals: quote.decimals });
  const top = curve.curve[curve.curve.length - 1].sqrtPriceX96;
  line("opens at", `${initialMarketCap.toFixed(2)} ${quote.symbol} FDV (${sqrtX96ToPrice(curve.sqrtStartPriceX96, 18, quote.decimals)} per token)`);
  line("graduates at", `${migrationMarketCap.toFixed(2)} ${quote.symbol} FDV (${sqrtX96ToPrice(top, 18, quote.decimals)} per token)`);
  line("raises", amount(curve.totals.threshold, quote.decimals, quote.symbol));
  line("curve sells", amount(curve.totals.curveBase, 18, symbol));
  line("AMM gets", amount(curve.totals.migrationBase, 18, symbol));
  line("fees", `${curve.startFeeBps / 100}% decaying to ${curve.endFeeBps / 100}% over ${curve.feeDecaySeconds}s`);
  if (firstBuy > 0) line("first buy", `${firstBuy} ${quote.symbol}`);

  const firstBuyRaw = uiToWei(firstBuy, quote.decimals);
  // One balance: the first buy (the 6-dec ERC-20 view) and the gas (the 18-dec
  // native view) are the same USDC, so they are checked as one sum.
  await requireBalance(account.address, GAS_ALLOWANCE, "this launch", firstBuyRaw);

  // A first buy is pulled with transferFrom, so it needs an allowance first.
  const needsApproval = firstBuyRaw > 0n && (await quoteAllowance(account.address, quote, launchpad)) < firstBuyRaw;

  if (!flag("yes")) {
    // A dry run still asks the chain: predict the token and estimate the call.
    const plan = await planLaunch({
      creator: account.address,
      quote,
      name,
      symbol,
      uri: "",
      preset,
      initialMarketCap,
      migrationMarketCap,
      firstBuy,
      venue,
    });
    line(
      "token",
      process.env.PINATA_JWT
        ? `${plan.token} before metadata is pinned — the URI is part of the address, so it moves`
        : plan.token,
    );
    if (needsApproval) {
      line("gas", "not estimated: the USDC approval has to land first");
    } else {
      try {
        line("gas", (await estimate(account.address, plan.call)).toString());
      } catch (error) {
        throw new Error(`The launchpad would refuse this launch: ${describeError(error)}`);
      }
    }
    console.log("\nDry run. Add --yes to send it.");
    return;
  }

  // Pin metadata before building. The URI is permanent once the token exists,
  // and it is part of the address the launchpad deploys to.
  let uri = "";
  if (process.env.PINATA_JWT) {
    const pinned = await pinTokenMetadata({
      name,
      symbol,
      description: arg("description", "") ?? "",
      imageUrl: arg("image") ?? arg("media"),
      mediaMimeType: arg("mime"),
      attributes: [
        { trait_type: "Curve", value: CURVE_PRESETS[preset].label },
        { trait_type: "Launchpad", value: "Juno" },
        { trait_type: "Market", value: "Juno USDC bonding curve on Arc" },
        ...(arg("nav") ? [{ trait_type: "NAV feed", value: arg("nav")! }] : []),
      ],
    });
    uri = pinned.uri;
    line("metadata", pinned.url);
  } else {
    line("metadata", "skipped (PINATA_JWT is not set) — launching with an empty URI");
  }

  const plan = await planLaunch({
    creator: account.address,
    quote,
    name,
    symbol,
    uri,
    preset,
    initialMarketCap,
    migrationMarketCap,
    firstBuy,
    venue,
  });
  line("token", plan.token);

  if (needsApproval) await send(account, buildApproveCall(quote, launchpad));
  // A launch with a first buy moves USDC into the post's market: tag it with Memo, as the app does.
  let call = plan.call;
  if (firstBuyRaw > 0n) {
    const memo = await tagWithMemo(call, plan.token, memoLine({ action: "launch", symbol, amount: `${firstBuy} USDC` }));
    line("memo", memo.tagged ? `tagged ${memo.reason}` : `not tagged: ${memo.reason}`);
    call = memo.call;
  }
  const receipt = await send(account, call);

  const launched = launchpadEvents(receipt, launchpad).find((event) => event.eventName === "Launched");
  if (!launched || launched.eventName !== "Launched") {
    throw new Error(`The transaction confirmed but emitted no Launched event: ${links.tx(receipt.transactionHash)}`);
  }
  const token = launched.args.token as Address;
  const pair = launched.args.venue === zeroAddress ? null : (launched.args.venue as Address);
  if (token !== plan.token) console.warn(`Note: deployed at ${token}, not the predicted ${plan.token}.`);

  console.log("\nLaunched.\n");
  line("tx", links.tx(receipt.transactionHash));
  line("token", links.token(token));
  line("launchpad", links.address(launchpad));
  if (pair) line("AMM pair", links.address(pair));
  line("raises", amount(launched.args.migrationQuoteThreshold, quote.decimals, quote.symbol));
  if (uri) line("metadata", uri);

  // Record it so the app lists it. The same endpoint the phone calls after its
  // own submit; the server re-reads the pool and the transaction before writing.
  const api = apiBase();
  const num = (key: string) => {
    const value = Number(arg(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const record = await fetch(`${api}/api/juno/pools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      creator: account.address,
      name,
      symbol,
      description: arg("description", "") ?? "",
      format: arg("format", "post") ?? "post",
      curvePreset: preset,
      navFeedId: arg("nav") ?? undefined,
      mediaUrl: arg("media") ?? arg("image") ?? undefined,
      posterUrl: arg("poster") ?? arg("media") ?? arg("image") ?? undefined,
      mediaMime: arg("mime") ?? undefined,
      mediaWidth: num("width"),
      mediaHeight: num("height"),
      createTx: receipt.transactionHash,
    }),
  }).catch(() => null);
  // Only the API's own answer counts: a 201 whose row is this coin.
  const body = record ? await record.text() : "";
  let recorded: string | undefined;
  try {
    recorded = (JSON.parse(body) as { pool?: { token?: string } }).pool?.token;
  } catch {
    recorded = undefined;
  }
  if (!record) {
    line("indexed", `no — could not reach the API at ${api} (is it running? set JUNO_API_URL). The coin is live on-chain regardless.`);
  } else if (record.status !== 201 || !recorded || recorded.toLowerCase() !== token.toLowerCase()) {
    line("indexed", `no — ${api} answered ${record.status} ${body.slice(0, 200)}`);
  } else {
    line("indexed", `yes (${record.status}) — ${appBase()}/coin/${token}`);
  }
}

run(main);
