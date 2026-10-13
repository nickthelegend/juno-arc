import "server-only";

import {
  BaseError,
  decodeErrorResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  maxUint256,
  isAddress,
  parseAbi,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { recordConfirmation, rememberTiming } from "./speed-log";
import { junoCrossChainAbi, junoLaunchpadAbi, junoSwapRouterAbi, junoTokenAbi, junoTrackersAbi } from "./abi";
import { CallerError } from "./api";
import { ccipMessageIdsIn } from "./ccip-events";
import { feedIdOf, fetchFeed, trackerFeedRegistered } from "./chainlink";
import { publicClient } from "./client";
import { CURVE_PRESETS, DEFAULT_TOTAL_SUPPLY, type CurvePreset } from "./curves";
import {
  InsufficientLiquidityError,
  VenueUnavailableError,
  buildApproveCall,
  buildClaimCreatorFeesCall,
  buildExactOutBuyCall,
  buildGraduateCall,
  buildSwapCall,
  fetchPoolSnapshot,
  invalidatePoolSnapshot,
  planLaunch,
  quoteAllowance,
  quoteExactOutBuy,
  quoteTokenFor,
  quoteTrade,
  tradeDeadline,
  uiToWei,
  usdcQuote,
  weiToUi,
  type ContractCall,
  type PoolSnapshot,
  type TradeQuote,
} from "./launchpad";
import { MEMO_CALL_FAILED, memoAbi, memoAddress, memoLine, memoLive, postMemoId, wrapInMemo } from "./memo";
import { chainId, explorer, launchpadAddress, requireLaunchpad, swapRouterAddress, trackersAddress } from "./network";
import { withRetry } from "./rpc";
import { invalidateSwapHistory, recordReceiptTrades } from "./swaps";
import type { CurvePresetId, TradeSide, Venue } from "./types";
import { quoteTokenUsdPrice } from "./usd";
import { buildV2SwapCalls, quoteV2Trade } from "./v2";

/**
 * Transactions built on the server, signed on the device.
 *
 * The client carries no contract ABIs and no RPC logic. It asks for an
 * unsigned transaction, signs it with its own key, and hands the signed bytes
 * back to be broadcast. The private key never leaves the device and the result
 * is an ordinary Arc transaction anyone can check on the explorer — this is a
 * thin-client split, not a custodial one.
 *
 * ## Steps
 *
 * Every Juno coin is quoted in USDC, so a buy is two steps the first time — a
 * USDC approval, then the buy — built together with consecutive nonces, so the
 * wallet signs twice and the server submits them in order. The buy's gas is
 * estimated as if the approval had landed (a state override of the allowance
 * slot); where that is not possible it carries a fixed ceiling instead.
 *
 * ## Gas on Arc
 *
 * Gas is paid in USDC (the native balance is the same money as the ERC-20 at
 * 0x3600…, in 18 decimals) and a typical Juno transaction costs well under a
 * cent. Arc charges the gas *used*, so the limit carries a comfortable margin.
 *
 * ## Memo
 *
 * Curve buys and sells (and a launch's first buy) go through Arc's Memo
 * contract when the node executes it (`memoLive`), tagged with the post they
 * paid for; approvals stay plain calls.
 */

/** Headroom over an estimate. Unused gas is not charged on Arc. */
const GAS_MARGIN_BPS = 2_000n;

/**
 * Ceiling for a step that cannot be estimated because it depends on an earlier
 * step in the same batch. A buy walks at most sixteen ranges; Memo adds a call.
 */
const FALLBACK_GAS = 700_000n;

/**
 * Where a launch starts and where it graduates, **in US dollars** — which on
 * Arc is USDC, the quote token. The range above it is the preset's
 * (`defaultCapMultiple`): 25x for a post, 1.5x for a tracker.
 */
const DEFAULT_INITIAL_MARKET_CAP_USD = 1_000;

function defaultCaps(preset: CurvePreset): { initial: number; migration: number } {
  return {
    initial: DEFAULT_INITIAL_MARKET_CAP_USD,
    migration: DEFAULT_INITIAL_MARKET_CAP_USD * preset.defaultCapMultiple,
  };
}

/**
 * An EIP-1559 transaction, every number hex-encoded so it survives JSON.
 * The wallet passes these fields straight to viem's `signTransaction`.
 */
export type UnsignedTransaction = {
  label: string;
  request: {
    type: "eip1559";
    chainId: number;
    from: Address;
    to: Address;
    data: Hex;
    value: Hex;
    nonce: number;
    gas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
  };
};

/** When a built trade stops being valid. Past it, the contract refuses it. */
export type TxWindow = {
  /** Unix seconds. */
  deadline: number;
};

/** What a Memo tag on a trade says: the post id it was tagged with, and whether it was. */
export type MemoTag = { id: Hex; tagged: boolean; line?: string };

/**
 * Turn calls into transactions: one nonce each, gas estimated where it can be,
 * one fee quote for the batch.
 *
 * A failed estimate on the *first* step is the chain saying this would revert,
 * so it is explained and thrown. On a later step it is expected — that step
 * depends on the ones before it — and it gets the fixed ceiling.
 */
export async function prepare(from: Address, calls: ContractCall[]): Promise<UnsignedTransaction[]> {
  const client = publicClient();
  const [nonce, fees] = await Promise.all([
    withRetry(() => client.getTransactionCount({ address: from, blockTag: "pending" })),
    withRetry(() => client.estimateFeesPerGas()),
  ]);

  const steps: UnsignedTransaction[] = [];
  // Allowances granted by earlier steps in this batch, as state the estimate
  // of a later step can assume (see `allowanceOverride`).
  const granted: StateOverride = [];
  for (const [index, call] of calls.entries()) {
    let gas: bigint;
    try {
      const estimate = await withRetry(() =>
        client.estimateGas({
          account: from,
          to: call.to,
          data: call.data,
          value: call.value,
          ...(granted.length > 0 ? { stateOverride: granted } : {}),
        }),
      );
      gas = estimate + (estimate * GAS_MARGIN_BPS) / 10_000n + (call.extraGas ?? 0n);
    } catch (error) {
      if (index === 0) throw new CallerError(explainFailure(error), 422);
      gas = FALLBACK_GAS + (call.extraGas ?? 0n);
    }
    const override = await allowanceOverride(from, call).catch(() => null);
    if (override) granted.push(override);
    steps.push({
      label: call.label,
      request: {
        type: "eip1559",
        chainId: chainId(),
        from,
        to: call.to,
        data: call.data,
        value: toHex(call.value),
        nonce: nonce + index,
        gas: toHex(gas),
        maxFeePerGas: toHex(fees.maxFeePerGas),
        maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      },
    });
  }
  return steps;
}

type StateOverride = NonNullable<Parameters<ReturnType<typeof publicClient>["estimateGas"]>[0]["stateOverride"]>;

/**
 * If `call` is an ERC-20 approval, the state it will leave: the allowance
 * set, for estimating the steps after it. A step that depends on an approval in
 * the same batch cannot be estimated against the chain as it is, so it is
 * estimated as if the approval had already landed.
 */
async function allowanceOverride(owner: Address, call: ContractCall): Promise<StateOverride[number] | null> {
  let spender: Address;
  let amount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    if (decoded.functionName !== "approve") return null;
    [spender, amount] = decoded.args as [Address, bigint];
  } catch {
    return null;
  }
  const index = await allowanceMappingSlot(call.to);
  if (index === null) return null;
  return {
    address: call.to,
    stateDiff: [{ slot: allowanceSlot(owner, spender, index), value: toHex(amount, { size: 32 }) }],
  };
}

/** `allowance[owner][spender]` in a mapping declared at storage slot `index`. */
function allowanceSlot(owner: Address, spender: Address, index: number): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(index)]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

const mappingSlots = new Map<Address, number | null>();

/**
 * Where a token keeps its allowances — found, not assumed. OpenZeppelin's
 * ERC-20 (every Juno token) and Circle's USDC lay storage out differently, so
 * each candidate slot is tried with an `eth_call` of `allowance` under an
 * override of that slot, and the one that changes the answer is it.
 */
async function allowanceMappingSlot(token: Address): Promise<number | null> {
  if (mappingSlots.has(token)) return mappingSlots.get(token)!;
  // Lowercase: viem refuses a mixed-case address whose checksum is wrong.
  const probeOwner: Address = "0x000000000000000000000000000000000000beef";
  const probeSpender: Address = "0x000000000000000000000000000000000000cafe";
  const client = publicClient();
  for (let index = 0; index < 16; index++) {
    const value = await client
      .readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [probeOwner, probeSpender],
        stateOverride: [
          {
            address: token,
            stateDiff: [{ slot: allowanceSlot(probeOwner, probeSpender, index), value: toHex(maxUint256, { size: 32 }) }],
          },
        ],
      })
      .catch(() => 0n);
    if (value === maxUint256) {
      mappingSlots.set(token, index);
      return index;
    }
  }
  mappingSlots.set(token, null);
  return null;
}

/**
 * Tag a curve call with its post through Arc's Memo, when the node runs Memo.
 * The call keeps its label and gas headroom; only its address and calldata
 * change. Pure apart from the cached probe.
 */
export async function tagWithMemo(call: ContractCall, token: Address, line: string): Promise<{ call: ContractCall; memo: MemoTag }> {
  const id = postMemoId(token);
  const memo = memoAddress();
  if (!memo || !(await memoLive())) return { call, memo: { id, tagged: false } };
  const wrapped = wrapInMemo({ memo, target: call.to, data: call.data, memoId: id, line });
  return { call: { ...call, to: wrapped.to, data: wrapped.data, extraGas: (call.extraGas ?? 0n) + 30_000n }, memo: { id, tagged: true, line } };
}

/** "25 USDC", "1.5M" — for a memo line. */
function shortAmount(value: number, unit?: string): string {
  const text =
    value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
      : value >= 1_000
        ? `${Math.round(value).toLocaleString("en-US")}`
        : `${Number(value.toPrecision(4))}`;
  return unit ? `${text} ${unit}` : text;
}

function requireWallet(value: string, field: string): Address {
  if (!isAddress(value)) throw new CallerError(`${field} is not an Arc address`);
  return getAddress(value);
}

/* ------------------------------------------------------------------ */
/* Swap                                                                */
/* ------------------------------------------------------------------ */

export type SwapBuildRequest = {
  /** The coin being traded. */
  token: string;
  side: TradeSide;
  /** Input amount in UI units — quote units on a buy, token units on a sell. */
  amountIn: number;
  /**
   * On a buy against the curve, exactly how many tokens to receive instead:
   * the curve names the price and the transaction caps what it may spend.
   * `amountIn` is ignored when this is set.
   */
  amountOut?: number;
  /**
   * On a sell, a share of what the wallet holds (0 < f ≤ 1) instead of an
   * amount: read from the chain here, so 100% is the whole balance to the wei.
   * The app's 25/50/75/100% chips send this; a number the phone rounded left
   * dust behind — "sell everything" kept 0.435 of a token. `amountIn` is
   * ignored when this is set.
   */
  sellFraction?: number;
  /** The wallet that will sign and pay. */
  owner: string;
  slippageBps?: number;
  /** Set by `buildSwap` from `sellFraction`: the exact input in wei. */
  amountInRaw?: bigint;
};

export type SwapBuildResult = {
  /** In order. Usually one; a USDC approval first when a buy needs one. */
  steps: UnsignedTransaction[];
  window: TxWindow;
  /** On an exact-out buy, also `amountIn` (the cost) and `maximumAmountIn` (the cap). */
  quote: Omit<TradeQuote, "raw"> & { amountIn?: number; maximumAmountIn?: number };
  /** What the quote is denominated in, for honest labelling on the client. Always "USDC". */
  quoteSymbol: string;
  /** 1: USDC is the dollar unit (the live peg is `/api/juno/peg`). */
  quoteUsdRate: number | null;
  /** Where the order goes: the curve, or after graduation the coin's Uniswap v2 pair. */
  venue: "curve" | "uniswap-v2";
  /** The v2 pair, when `venue` is "uniswap-v2". */
  pair?: Address;
  /**
   * The Arc Memo tag: `id` is the post's memo id; `tagged` says whether this
   * trade goes through Memo (only curve trades, and only where Memo runs).
   */
  memo: MemoTag;
};

export async function buildSwap(input: SwapBuildRequest): Promise<SwapBuildResult> {
  const request = input.sellFraction === undefined ? input : await resolveSellFraction(input);
  const exactOut = request.amountOut !== undefined;
  const size = exactOut ? request.amountOut! : request.amountIn;
  if (!Number.isFinite(size) || size <= 0) {
    throw new CallerError("Amount must be greater than zero");
  }
  if (exactOut && request.side !== "buy") {
    throw new CallerError('"amountOut" is for buys; a sell already names its token amount');
  }

  const owner = requireWallet(request.owner, "owner");
  const snapshot = await fetchPoolSnapshot(request.token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network");

  if (exactOut && (snapshot.curve.graduated || snapshot.curve.complete)) {
    throw new CallerError("Buying an exact number of tokens is for coins still on their curve");
  }
  // One that graduated into Uniswap v2 trades against its pair, through the router.
  if (snapshot.curve.graduated) {
    if (!swapRouterAddress()) {
      throw new CallerError("This coin has graduated — it trades on its AMM pair now");
    }
    return buildV2Swap(request, owner, snapshot);
  }
  // The contract rejects a trade against a finished curve. Saying so here is a
  // far better error than the one the chain would return after signing.
  if (snapshot.curve.complete) {
    throw new CallerError("This curve is full. It graduates to its AMM pair next.");
  }
  if (exactOut) return buildExactOutSwap(request, owner, snapshot);

  const quote = await quoteTrade({
    snapshot,
    side: request.side,
    amountIn: request.amountIn,
    amountInRaw: request.amountInRaw,
    slippageBps: request.slippageBps ?? 100,
  }).catch((error: unknown) => {
    if (error instanceof InsufficientLiquidityError) {
      throw new CallerError(
        request.side === "sell"
          ? "There is not enough in this pool to buy that back. Try a smaller amount."
          : "This curve cannot fill that size. Try a smaller amount.",
      );
    }
    throw error;
  });
  if (quote.raw.amountOut === 0n) throw new CallerError("That amount is too small to trade");

  const deadline = tradeDeadline();
  const calls: ContractCall[] = [];
  if (request.side === "buy") {
    const allowance = await quoteAllowance(owner, snapshot.quote, snapshot.launchpad);
    if (allowance < quote.raw.amountIn) calls.push(buildApproveCall(snapshot.quote, snapshot.launchpad));
  }
  const symbol = await tokenSymbol(snapshot.token);
  const line = memoLine({
    action: request.side,
    symbol,
    amount: request.side === "buy" ? shortAmount(weiToUi(quote.raw.amountIn, snapshot.quoteDecimals), "USDC") : shortAmount(weiToUi(quote.raw.amountIn, snapshot.baseDecimals)),
  });
  const tagged = await tagWithMemo(buildSwapCall({ snapshot, owner, side: request.side, quote, deadline }), snapshot.token, line);
  calls.push(tagged.call);

  const steps = await prepare(owner, calls);
  const quoteUsdRate = await quoteTokenUsdPrice(snapshot.quote.address).catch(() => null);
  const { raw: _raw, ...publicQuote } = quote;

  return {
    steps,
    window: { deadline: Number(deadline) },
    quote: publicQuote,
    quoteSymbol: snapshot.quote.symbol,
    quoteUsdRate,
    venue: "curve",
    memo: tagged.memo,
  };
}

const symbols = new Map<string, string>();
async function tokenSymbol(token: Address): Promise<string | null> {
  const hit = symbols.get(token);
  if (hit) return hit;
  const symbol = await withRetry(() => publicClient().readContract({ address: token, abi: junoTokenAbi, functionName: "symbol" })).catch(() => null);
  if (symbol) symbols.set(token, symbol);
  return symbol;
}

/** Exactly `amountOut` tokens from the curve, the spend capped by slippage. */
async function buildExactOutSwap(
  request: SwapBuildRequest,
  owner: Address,
  snapshot: PoolSnapshot,
): Promise<SwapBuildResult> {
  const quote = await quoteExactOutBuy({
    snapshot,
    amountOut: request.amountOut!,
    slippageBps: request.slippageBps ?? 100,
  }).catch((error: unknown) => {
    if (error instanceof InsufficientLiquidityError) {
      throw new CallerError("The curve does not hold that many tokens. Ask for fewer.");
    }
    throw error;
  });
  if (quote.raw.amountIn === 0n) throw new CallerError("That amount is too small to trade");

  const deadline = tradeDeadline();
  const calls: ContractCall[] = [];
  const allowance = await quoteAllowance(owner, snapshot.quote, snapshot.launchpad);
  if (allowance < quote.raw.amountIn) calls.push(buildApproveCall(snapshot.quote, snapshot.launchpad));
  const line = memoLine({ action: "buy", symbol: await tokenSymbol(snapshot.token), amount: shortAmount(quote.amountOut) });
  const tagged = await tagWithMemo(buildExactOutBuyCall({ snapshot, owner, quote, deadline }), snapshot.token, line);
  calls.push(tagged.call);

  const steps = await prepare(owner, calls);
  const quoteUsdRate = await quoteTokenUsdPrice(snapshot.quote.address).catch(() => null);
  const { raw: _raw, ...publicQuote } = quote;
  return {
    steps,
    window: { deadline: Number(deadline) },
    quote: publicQuote,
    quoteSymbol: snapshot.quote.symbol,
    quoteUsdRate,
    venue: "curve",
    memo: tagged.memo,
  };
}

/** A share of the holding, as the exact number of wei it names. */
async function resolveSellFraction(request: SwapBuildRequest): Promise<SwapBuildRequest> {
  const fraction = request.sellFraction!;
  if (request.side !== "sell") throw new CallerError('"sellFraction" is for sells');
  if (!(fraction > 0 && fraction <= 1)) throw new CallerError('"sellFraction" must be above 0 and at most 1');
  const owner = requireWallet(request.owner, "owner");
  const token = requireWallet(request.token, "token");
  const held = await withRetry(() =>
    publicClient().readContract({ address: token, abi: junoTokenAbi, functionName: "balanceOf", args: [owner] }),
  );
  // Parts per million, so 0.25 is exact and 1 is the whole balance.
  const raw = fraction === 1 ? held : (held * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (raw === 0n) throw new CallerError("You hold none of this coin");
  return { ...request, amountIn: weiToUi(raw, 18), amountInRaw: raw };
}

/** A graduated coin, against its Uniswap v2 pair. */
async function buildV2Swap(
  request: SwapBuildRequest,
  owner: Address,
  snapshot: PoolSnapshot,
): Promise<SwapBuildResult> {
  const quote = await quoteV2Trade({
    snapshot,
    side: request.side,
    amountIn: request.amountIn,
    amountInRaw: request.amountInRaw,
    slippageBps: request.slippageBps ?? 100,
  }).catch((error: unknown) => {
    if (error instanceof InsufficientLiquidityError) {
      throw new CallerError("This coin's pair cannot fill that size. Try a smaller amount.");
    }
    throw error;
  });
  if (quote.raw.amountOut === 0n) throw new CallerError("That amount is too small to trade");

  const deadline = tradeDeadline();
  const steps = await prepare(
    owner,
    await buildV2SwapCalls({ snapshot, owner, side: request.side, quote, deadline }),
  );
  const quoteUsdRate = await quoteTokenUsdPrice(snapshot.quote.address).catch(() => null);
  const { raw: _raw, ...publicQuote } = quote;
  return {
    steps,
    window: { deadline: Number(deadline) },
    quote: publicQuote,
    quoteSymbol: snapshot.quote.symbol,
    quoteUsdRate,
    venue: "uniswap-v2",
    pair: snapshot.pool.venue,
    // The router pulls from its caller, so a v2 trade stays a plain call.
    memo: { id: postMemoId(snapshot.token), tagged: false },
  };
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

export type LaunchBuildRequest = {
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  preset: CurvePresetId;
  /** Quote token address. USDC is the only one; omitted means USDC. */
  quote?: string;
  initialMarketCap?: number;
  migrationMarketCap?: number;
  /** Optional creator's first buy, in USDC, made in the same transaction. */
  firstBuy?: number;
  /** Where the curve graduates: Uniswap v2 (the only venue on Arc). */
  venue?: Venue;
  /**
   * A tracker coin: one token stands for `unitsPerToken` of the feed's asset
   * (e.g. 0.000001 BTC). The curve opens at feed price × unitsPerToken, with
   * the `tight-nav` preset's narrow range.
   */
  tracker?: { feed: string; unitsPerToken: number };
};

export type LaunchBuildResult = {
  steps: UnsignedTransaction[];
  /** Where the token will be — the launchpad predicted it. */
  token: Address;
  launchpad: Address;
  /** What the curve will raise before graduating, in USDC. */
  migrationQuoteThreshold: number;
  memo: MemoTag;
  /** For a tracker launch: the feed, its price, and whether the band is enforced on chain. */
  tracker?: {
    feed: string;
    feedId: Hex;
    priceUsd: number;
    unitsPerToken: number;
    openingPriceUsd: number;
    /** True when `JunoTrackers.track` is appended (the feed is registered on this network). */
    onchain: boolean;
    source: string;
  };
};

export async function buildLaunch(request: LaunchBuildRequest): Promise<LaunchBuildResult> {
  const preset = CURVE_PRESETS[request.preset];
  if (!preset) {
    throw new CallerError(
      `Unknown preset "${request.preset}". One of: ${Object.keys(CURVE_PRESETS).join(", ")}`,
    );
  }

  const quote = request.quote ? quoteTokenFor(request.quote) : usdcQuote();
  if (!quote) throw new CallerError("Juno coins on Arc are quoted in USDC only");
  const creator = requireWallet(request.creator, "creator");

  // A tracker opens at the feed's price for what one token stands for.
  let tracker: LaunchBuildResult["tracker"];
  let initialMarketCap = request.initialMarketCap;
  let migrationMarketCap = request.migrationMarketCap;
  if (request.tracker) {
    if (request.preset !== "tight-nav") throw new CallerError('A tracker launches with the "tight-nav" preset');
    const { feed, unitsPerToken } = request.tracker;
    if (!(unitsPerToken > 0)) throw new CallerError('"tracker.unitsPerToken" must be greater than zero');
    const reading = await fetchFeed(feed).catch(() => null);
    if (!reading) throw new CallerError(`Chainlink ${feed} on Arc mainnet could not be read. Try again in a moment.`, 503);
    if (reading.stale) throw new CallerError(`Chainlink ${feed} on Arc mainnet is stale (updated ${reading.updatedAt}); a tracker can't open against it.`);
    const openingPriceUsd = reading.priceUsd * unitsPerToken;
    initialMarketCap = openingPriceUsd * DEFAULT_TOTAL_SUPPLY;
    migrationMarketCap = initialMarketCap * preset.defaultCapMultiple;
    const onchain = await trackerFeedRegistered(reading.id).catch(() => false);
    tracker = {
      feed: reading.id,
      feedId: feedIdOf(reading.id),
      priceUsd: reading.priceUsd,
      unitsPerToken,
      openingPriceUsd,
      onchain,
      source: `Chainlink ${reading.id} on Arc mainnet`,
    };
  }

  const caps = initialMarketCap === undefined || migrationMarketCap === undefined ? defaultCaps(preset) : null;

  let plan: Awaited<ReturnType<typeof planLaunch>>;
  try {
    plan = await planLaunch({
      creator,
      quote,
      name: request.name,
      symbol: request.symbol,
      uri: request.uri,
      preset: request.preset,
      initialMarketCap: initialMarketCap ?? caps!.initial,
      migrationMarketCap: migrationMarketCap ?? caps!.migration,
      firstBuy: request.firstBuy,
      venue: request.venue,
    });
  } catch (error) {
    if (error instanceof CallerError) throw error;
    if (error instanceof VenueUnavailableError) throw new CallerError(error.message);
    // The curve builder refuses an impossible valuation pair with a sentence.
    if (error instanceof Error && !(error instanceof BaseError)) throw new CallerError(error.message);
    throw error;
  }

  const calls: ContractCall[] = [];
  let memo: MemoTag = { id: postMemoId(plan.token), tagged: false };
  if (request.firstBuy && request.firstBuy > 0) {
    const allowance = await quoteAllowance(creator, quote);
    if (allowance < uiToWei(request.firstBuy, quote.decimals)) calls.push(buildApproveCall(quote));
    // The launch with a first buy is a payment for the post: tag it.
    const tagged = await tagWithMemo(
      plan.call,
      plan.token,
      memoLine({ action: "launch", symbol: request.symbol, amount: shortAmount(request.firstBuy, "USDC") }),
    );
    calls.push(tagged.call);
    memo = tagged.memo;
  } else {
    calls.push(plan.call);
  }

  const trackers = trackersAddress();
  if (tracker?.onchain && trackers) {
    const bandBps = CURVE_PRESETS["tight-nav"].navBandBps ?? 200;
    calls.push({
      to: trackers,
      data: encodeFunctionData({
        abi: junoTrackersAbi,
        functionName: "track",
        args: [plan.token, tracker.feedId, uiToWei(tracker.unitsPerToken, 18), bandBps],
      }),
      value: 0n,
      label: `Marking it against Chainlink ${tracker.feed}`,
    });
  }

  return {
    steps: await prepare(creator, calls),
    token: plan.token,
    launchpad: requireLaunchpad(),
    migrationQuoteThreshold: Number(plan.params.totals.threshold) / 10 ** quote.decimals,
    memo,
    ...(tracker ? { tracker } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Creator fees and graduation                                         */
/* ------------------------------------------------------------------ */

export async function buildClaim(request: { creator: string; token: string }): Promise<UnsignedTransaction[]> {
  const creator = requireWallet(request.creator, "creator");
  const snapshot = await fetchPoolSnapshot(request.token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network");
  if (snapshot.pool.creator !== creator) throw new CallerError("Only the creator can claim this coin's fees", 403);
  if (snapshot.pool.creatorFees === 0n) throw new CallerError("Nothing to claim yet");
  return prepare(creator, [
    buildClaimCreatorFeesCall({ token: snapshot.token, to: creator, launchpad: snapshot.launchpad }),
  ]);
}

export async function buildGraduate(request: { from: string; token: string }): Promise<UnsignedTransaction[]> {
  const from = requireWallet(request.from, "from");
  const snapshot = await fetchPoolSnapshot(request.token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network");
  if (snapshot.curve.graduated) throw new CallerError("This coin has already graduated");
  if (!snapshot.curve.complete) throw new CallerError("The curve has not filled yet");
  return prepare(from, [
    buildGraduateCall({ token: snapshot.token, launchpad: snapshot.launchpad, venue: snapshot.venue }),
  ]);
}

/* ------------------------------------------------------------------ */
/* Submit                                                              */
/* ------------------------------------------------------------------ */

export type SubmitResult = {
  hash: Hex;
  /** "success": the receipt is in hand, and on Arc a receipt is final. Reverts are errors (422). */
  status: "success";
  blockNumber: number;
  from: Address;
  /** Milliseconds from broadcast to receipt, measured by this server. */
  confirmMs: number;
  /** @deprecated the same figure as `confirmMs`, kept for older clients. */
  confirmedInMs: number;
  /** The transaction on Arc's explorer. */
  explorerUrl: string;
  /** Trades the transaction made, as recorded. */
  trades: number;
  /** The first trade it made, when it made one — what a trade sheet confirms. */
  trade?: { token: Address; side: TradeSide; baseAmount: number; quoteAmount: number; fee: number; price: number; venue: "curve" | "uniswap-v2" };
  /** Set when the transaction launched a token. `pair` is the Uniswap v2 pair it will graduate into. */
  launched?: { token: Address; pair: Address | null; creator: Address };
  /** Set when the transaction graduated a curve. */
  graduated?: { token: Address; venue: Address };
  /** Set when a buy filled the curve to its top. */
  completed?: Address[];
  /** The Arc Memo the transaction emitted, when it went through Memo. */
  memo?: { id: Hex; tagged: true; line: string; sender: Address; target: Address };
  /** Creator fees burned on Arc through CCTP V2 for another chain. */
  cctp?: { token: Address; destinationDomain: number; mintRecipient: Hex; amount: number; maxFee: number };
  /** A Chainlink CCIP message the transaction sent: follow it on ccip.chain.link. */
  ccipMessageId?: Hex;
  ccipExplorerUrl?: string;
  /** A coin enabled as a CCIP Cross-Chain Token. */
  ccipEnabled?: { token: Address; pool: Address };
};

/** How long to wait for a receipt. Arc blocks are sub-second and final. */
const RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Broadcast a transaction the device signed, wait for its receipt, and record
 * what it did.
 *
 * The chain id is checked before anything is sent: a transaction signed for
 * the other network would otherwise fail with an error about a nonce or a
 * balance that has nothing to do with the real problem.
 */
export async function submitSigned(params: { signed: Hex }): Promise<SubmitResult> {
  const client = publicClient();

  let parsed: ReturnType<typeof parseTransaction>;
  let from: Address;
  try {
    parsed = parseTransaction(params.signed);
    from = await recoverTransactionAddress({ serializedTransaction: params.signed as never });
  } catch {
    throw new CallerError("That is not a signed Arc transaction");
  }
  if (parsed.chainId !== undefined && parsed.chainId !== chainId()) {
    throw new CallerError(`This transaction was signed for chain ${parsed.chainId}, not ${chainId()}`);
  }

  /*
   * The hash is the keccak of the signed bytes, known before anything is
   * sent, so a timeout can still hand the person a transaction to look up.
   * Arc has deterministic sub-second finality: the receipt this waits for is
   * final, and the time it took is measured and shown.
   */
  const hash = keccak256(params.signed);
  const started = performance.now();
  let receipt: TransactionReceipt;
  try {
    // One round trip where the node implements it (EIP-7966).
    receipt = await client.sendRawTransactionSync({
      serializedTransaction: params.signed,
      throwOnReceiptRevert: false,
    });
  } catch (error) {
    if (!unsupportedMethod(error)) {
      if (/timed? ?out|timeout/i.test(String((error as Error)?.message ?? ""))) {
        throw new CallerError(
          `The network accepted this transaction but it has not confirmed yet. It is ${hash}.`,
          504,
        );
      }
      // A node refusing *this transaction* is not a fault in this server, and
      // reporting it as one hides the one thing the person can act on.
      throw new CallerError(explainFailure(error), 422);
    }
    // An endpoint without the sync method: broadcast, then wait.
    try {
      await client.sendRawTransaction({ serializedTransaction: params.signed });
    } catch (sendError) {
      throw new CallerError(explainFailure(sendError), 422);
    }
    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 100 });
    } catch {
      throw new CallerError(
        `The network accepted this transaction but it has not confirmed yet. It is ${hash}.`,
        504,
      );
    }
  }
  const confirmMs = Math.round(performance.now() - started);

  if (receipt.status !== "success") {
    const reason = await revertReason(hash, receipt).catch(() => null);
    throw new CallerError(
      `${reason ?? "The transaction reverted."} It is on-chain as ${hash}.`,
      422,
    );
  }

  recordConfirmation(confirmMs, Number(receipt.blockNumber));
  rememberTiming(hash, confirmMs);
  return describeReceipt(receipt, from, confirmMs);
}

/**
 * A transaction the server's relayer broadcast (a gasless buy): its receipt,
 * described like any other. `from` is the wallet it acted for.
 */
export async function settleSent(hash: Hex, from: Address, startedAt = performance.now()): Promise<SubmitResult> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: 100 });
  } catch {
    throw new CallerError(`The network accepted this transaction but it has not confirmed yet. It is ${hash}.`, 504);
  }
  const confirmMs = Math.round(performance.now() - startedAt);
  if (receipt.status !== "success") {
    const reason = await revertReason(hash, receipt).catch(() => null);
    throw new CallerError(`${reason ?? "The transaction reverted."} It is on-chain as ${hash}.`, 422);
  }
  recordConfirmation(confirmMs, Number(receipt.blockNumber));
  rememberTiming(hash, confirmMs);
  return describeReceipt(receipt, from, confirmMs);
}

/**
 * The endpoint does not implement the method, or not in the form it was
 * called — either way the transaction was never broadcast, so falling back to
 * a plain send cannot submit it twice. A refusal of the transaction itself
 * (bad nonce, no funds, a revert) is a different error and is not caught here.
 */
function unsupportedMethod(error: unknown): boolean {
  const text = error instanceof BaseError ? `${error.shortMessage}\n${error.details}` : String(error);
  const code = (error as { code?: number } | null)?.code ?? findCode(error);
  return (
    code === -32601 ||
    code === -32602 ||
    /method (not found|not supported|does not exist)|not implemented|invalid parameters were provided|not available/i.test(text)
  );
}

function findCode(error: unknown): number | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const found = error.walk((cause) => typeof (cause as { code?: unknown }).code === "number");
  return (found as { code?: number } | null)?.code;
}

const creatorFeesBridgedAbi = junoLaunchpadAbi.filter(
  (item) => item.type === "event" && item.name === "CreatorFeesBridged",
);

export async function describeReceipt(receipt: TransactionReceipt, from: Address, confirmMs: number): Promise<SubmitResult> {
  const launchpad = launchpadAddress();
  const result: SubmitResult = {
    hash: receipt.transactionHash,
    status: "success",
    blockNumber: Number(receipt.blockNumber),
    from,
    confirmMs,
    confirmedInMs: confirmMs,
    explorerUrl: explorer.tx(receipt.transactionHash),
    trades: 0,
  };

  // Arc Memo: the tag this payment carried.
  const memo = memoAddress();
  if (memo) {
    const [tag] = parseEventLogs({ abi: memoAbi, eventName: "Memo", logs: receipt.logs.filter((log) => getAddress(log.address) === memo) });
    if (tag) {
      let line = "";
      try {
        line = Buffer.from(tag.args.memo.slice(2), "hex").toString("utf8");
      } catch {
        line = "";
      }
      result.memo = { id: tag.args.memoId, tagged: true, line, sender: getAddress(tag.args.sender), target: getAddress(tag.args.target) };
    }
  }

  // Chainlink CCIP: the message this transaction sent, from the OnRamp's event.
  const [messageId] = ccipMessageIdsIn(receipt.logs);
  if (messageId) {
    result.ccipMessageId = messageId;
    result.ccipExplorerUrl = `https://ccip.chain.link/msg/${messageId}`;
  }

  if (!launchpad) return result;

  const ours = receipt.logs.filter((log) => getAddress(log.address) === launchpad);
  const events = parseEventLogs({ abi: junoLaunchpadAbi, logs: ours });

  const touched = new Set<string>();
  const completed: Address[] = [];
  for (const event of events) {
    if (event.eventName === "Launched") {
      result.launched = {
        token: getAddress(event.args.token),
        pair: /^0x0+$/.test(event.args.venue) ? null : getAddress(event.args.venue),
        creator: getAddress(event.args.creator),
      };
      touched.add(event.args.token);
    } else if (event.eventName === "Graduated") {
      result.graduated = { token: getAddress(event.args.token), venue: getAddress(event.args.venue) };
      touched.add(event.args.token);
    } else if (event.eventName === "CurveCompleted") {
      completed.push(getAddress(event.args.token));
    } else if (event.eventName === "Trade" || event.eventName === "CreatorFeesClaimed") {
      touched.add(event.args.token);
    } else if (event.eventName === "CreatorFeesBridged") {
      const quote = usdcQuote();
      result.cctp = {
        token: getAddress(event.args.token),
        destinationDomain: Number(event.args.destinationDomain),
        mintRecipient: event.args.mintRecipient,
        amount: weiToUi(event.args.amount, quote.decimals),
        maxFee: weiToUi(event.args.maxFee, quote.decimals),
      };
      touched.add(event.args.token);
    }
  }
  void creatorFeesBridgedAbi;
  if (completed.length) result.completed = completed;

  // A coin enabled as a CCIP Cross-Chain Token through JunoCrossChain.
  const enabled = parseEventLogs({ abi: junoCrossChainAbi, eventName: "CrossChainEnabled", logs: receipt.logs });
  if (enabled[0]) result.ccipEnabled = { token: getAddress(enabled[0].args.token), pool: getAddress(enabled[0].args.pool) };

  const trades = await recordReceiptTrades(receipt).catch(() => []);
  result.trades = trades.length;
  const first = trades[0];
  if (first) {
    result.trade = {
      token: getAddress(first.token),
      side: first.side,
      baseAmount: first.baseAmount,
      quoteAmount: first.quoteAmount,
      fee: first.fee,
      price: first.price,
      venue: first.venue ?? "curve",
    };
  }
  // A graduated coin's trades move its pair, not the launchpad: mark them too.
  for (const trade of trades) if (trade.venue === "uniswap-v2") touched.add(trade.token);

  // The price, curve and history all just moved. Drop them so the next read
  // is live rather than a few seconds stale.
  for (const token of touched) {
    invalidatePoolSnapshot(token);
    invalidateSwapHistory(token);
  }
  return result;
}

/**
 * Why a mined transaction reverted, re-derived by replaying it as a call at
 * its own block. Receipts carry no reason; the replay does.
 */
async function revertReason(hash: Hex, receipt: TransactionReceipt): Promise<string | null> {
  const client = publicClient();
  const tx = await client.getTransaction({ hash });
  try {
    await client.call({
      account: tx.from,
      to: tx.to ?? undefined,
      data: tx.input,
      value: tx.value,
      blockNumber: receipt.blockNumber,
    });
    return null;
  } catch (error) {
    return explainFailure(error);
  }
}

/**
 * A transaction the network would not take, said in a sentence.
 *
 * The launchpad reverts with named errors, so most failures decode to exactly
 * what happened. What someone trying to buy $2 of a coin needs is which of the
 * handful of real causes it was. Anything unrecognised keeps its original text
 * rather than being flattened into a friendly non-answer — a wrong specific
 * reason is worse than an unfamiliar true one.
 */
export function explainFailure(error: unknown): string {
  const named = decodeLaunchpadError(error);
  switch (named) {
    case "Slippage":
      return "The price moved past your slippage while this was being signed. Try again for a fresh quote.";
    case "Expired":
      return "This quote expired before it was submitted. Try again for a fresh one.";
    case "CurveComplete":
      return "This curve has filled. It graduates to its Uniswap v2 pair next.";
    case "CurveNotComplete":
      return "The curve has not filled yet, so it cannot graduate.";
    case "AlreadyGraduated":
      return "This coin has already graduated.";
    case "InsufficientLiquidity":
      return "There is not enough in this pool to buy that back. Try a smaller amount.";
    case "QuoteNotAllowed":
      return "The launchpad only takes USDC.";
    case "BadMetadata":
      return "The name, ticker or metadata link is too long or empty.";
    case "SupplyExceeded":
    case "BadCurve":
      return "That curve does not fit the fixed supply. Try a different valuation.";
    case "RaiseTooLarge":
      return "That curve would raise more than this launchpad's cap. Launch at a smaller graduation valuation.";
    case "NotCreator":
      return "Only the creator can do that for this coin.";
    case "ZeroAmount":
      return "That amount is too small to trade.";
    case "PairLocked":
      return "Tokens cannot be sent to the AMM pair until the coin graduates.";
    case "GraduatorNotAllowed":
    case "NoGraduator":
      return "That venue is not offered on this launchpad.";
    case "BadDestination":
      return "CCTP can't send to that domain from Arc (Arc itself, domain 26, is not a destination).";
    case "CrossChainDisabled":
      return "Cross-chain claims are not configured on this launchpad.";
    case "ERC20InsufficientAllowance":
      return "The contract was not allowed to take the tokens. Try again; the approval comes first.";
    case "ERC20InsufficientBalance":
      return "This wallet does not hold enough of that token.";
    // JunoCrossChain (CCIP).
    case "NotGraduated":
      return "A coin goes cross-chain after it graduates.";
    case "AlreadyEnabled":
      return "This coin is already a CCIP Cross-Chain Token.";
    case "NotEnabled":
      return "This coin is not enabled for CCIP yet.";
    case "IsHandedOver":
      return "The creator has taken over this coin's CCIP pool; Juno no longer manages it.";
    case "WrongPoolCode":
      return "The CCIP pool code does not match Chainlink's published BurnMintTokenPool.";
    case "BadRateLimit":
      return "CCIP rate limits must be on, non-zero and at most 100M tokens per bucket.";
    case "BadRemote":
      return "A CCIP remote chain needs both its pool and its token address.";
    case "NotCCIPAdmin":
    case "NotJunoToken":
      return "That token is not a Juno coin this contract can manage.";
    // JunoTrackers (Chainlink).
    case "UnknownFeed":
      return "That Chainlink feed is not registered on this network.";
    case "StaleFeed":
      return "The Chainlink feed is stale, so the tracker can't be marked against it right now.";
    case "OffFeed":
      return "The coin's price is too far from the Chainlink feed to start tracking it.";
    case "AlreadyTracked":
      return "This coin already tracks a feed.";
    case "BadBand":
    case "BadAnswer":
      return "The tracker's band or the feed's answer is out of range.";
    default:
      break;
  }

  const text = error instanceof BaseError ? error.shortMessage + "\n" + error.details : String((error as Error)?.message ?? error);
  if (/insufficient (funds|balance)|exceeds (the )?balance|balance too low|transfer amount exceeds balance/i.test(text)) {
    return "Not enough USDC in this wallet to cover this and its gas (gas on Arc is paid in USDC).";
  }
  if (/nonce too low|already known|replacement transaction/i.test(text)) {
    return "This transaction was already submitted, or a newer one replaced it. Refresh and try again.";
  }
  if (/nonce too high/i.test(text)) {
    return "An earlier transaction from this wallet has not landed yet. Wait a moment and try again.";
  }
  if (/invalid signature|invalid sender/i.test(text)) {
    return "The signature on this transaction did not verify. Try again.";
  }
  if (/authorization is (used|expired|not yet valid)|invalid authorization|FiatToken|EIP3009/i.test(text)) {
    return "The USDC authorization was already used, expired, or signed for something else. Sign a fresh one.";
  }

  const first = error instanceof BaseError ? error.shortMessage : text.split("\n")[0];
  return first && first.trim().length > 0
    ? `The network refused this transaction: ${first.trim()}`
    : "The network refused this transaction.";
}

/** Every custom error a Juno transaction can revert with. */
const JUNO_ERRORS = [
  ...junoLaunchpadAbi,
  ...junoTokenAbi,
  ...junoSwapRouterAbi,
  ...junoCrossChainAbi,
  ...junoTrackersAbi,
  ...parseAbi(["error CallFailed(bytes returnData)"]),
].filter((item) => item.type === "error");

/**
 * The custom error name buried in a viem error, if there is one.
 *
 * Two shapes reach here. A `readContract`/`simulate` failure has already been
 * decoded against an ABI and carries `data.errorName`. An `estimateGas` or
 * `sendRawTransaction` failure carries only the raw revert bytes, somewhere in
 * its cause chain. A call made through Arc's Memo reverts with
 * `CallFailed(bytes)` wrapping the target's own revert, which is unwrapped.
 */
function decodeLaunchpadError(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  let name: string | null = null;
  let raw: Hex | null = null;
  error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    if (data && typeof data === "object" && typeof (data as { errorName?: unknown }).errorName === "string") {
      const decoded = data as { errorName: string; args?: readonly unknown[] };
      if (decoded.errorName === "CallFailed" && typeof decoded.args?.[0] === "string") {
        raw = decoded.args[0] as Hex;
      } else {
        name = decoded.errorName;
      }
      return true;
    }
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      raw = data as Hex;
      return true;
    }
    return false;
  });
  if (name) return name;
  return decodeRevertData(raw);
}

/** A revert's bytes, decoded against every Juno error, through any Memo wrapping. */
export function decodeRevertData(raw: Hex | null, depth = 0): string | null {
  if (!raw || raw.length < 10 || depth > 3) return null;
  try {
    const decoded = decodeErrorResult({ abi: JUNO_ERRORS, data: raw });
    if (decoded.errorName === "CallFailed" && raw.toLowerCase().startsWith(MEMO_CALL_FAILED)) {
      return decodeRevertData((decoded.args?.[0] as Hex) ?? null, depth + 1);
    }
    return decoded.errorName;
  } catch {
    return null;
  }
}
