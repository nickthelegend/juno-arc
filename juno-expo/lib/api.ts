import Constants from "expo-constants";

/**
 * The Juno API client.
 *
 * Every read and every transaction comes from the Next.js app. The app never
 * builds an Arc transaction itself — it asks for unsigned EIP-1559 requests, signs
 * them with the key in its secure store, and posts the signed bytes back. See
 * `lib/juno/tx.ts` on the server and `docs/API.md` for the contract.
 *
 * ## Finding the server from a simulator
 *
 * `localhost` inside an iOS Simulator is the simulator, not the Mac running the
 * dev server, so a hardcoded localhost fails in exactly the environment this
 * app is demoed in. Expo already knows the host it was served from
 * (`hostUri`), which is the machine running Metro — and that is the same
 * machine running Next (on :8911 in development). So the default is derived
 * rather than guessed, and `EXPO_PUBLIC_API_URL` overrides it for a deployed
 * backend — and must be set at export time for the web build.
 */

function inferredHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older/dev-client shapes keep it in different places.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  if (!hostUri) return null;
  const host = hostUri.split(":")[0];
  if (!host) return null;
  return `http://${host}:${DEV_API_PORT}`;
}

/** Where Juno's API listens in development (the Next.js server at the repo root). */
const DEV_API_PORT = 8911;

/*
 * `||`, not `??`: eas.json sets the variable to an empty string so a build
 * never inherits a stale deployment's URL, and an empty base URL would send
 * every request to a relative path — which on a phone is nowhere.
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "") ||
  inferredHost() ||
  `http://localhost:${DEV_API_PORT}`;

export class ApiError extends Error {
  readonly status: number;
  /** A request abandoned at its timeout, as opposed to one that never connected. */
  timedOut = false;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * One request.
 *
 * A phone loses its network mid-request far more often than a browser does, so
 * a timeout is mandatory rather than optional: without one a dropped connection
 * leaves a spinner on screen forever with nothing to cancel it.
 */
async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await attempt<T>(path, init);
  } catch (error) {
    /*
     * One quiet retry for a read that never got an answer.
     *
     * A dropped connection — a proxy recycling, a phone changing networks —
     * surfaces as a fetch that throws before any response, and the coin page a
     * launch lands on said "Could not reach Juno" for a server that answered
     * the retry in under a second. Reads only: a POST may have reached the
     * server, and sending a transaction twice is not a retry. A timeout is not
     * retried either: the server was reached and is slow, and a second wait of
     * the same length helps nobody.
     */
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" || !(error instanceof ApiError) || error.status !== 0 || error.timedOut) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    return attempt<T>(path, init);
  }
}

async function attempt<T>(path: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 45_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...rest.headers,
      },
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from a 500 is still worth surfacing as a message.
      if (!response.ok) throw new ApiError(text.slice(0, 200) || "Request failed", response.status);
      throw new ApiError("The server sent something that was not JSON", response.status);
    }

    if (!response.ok) {
      const message =
        (body as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
      throw new ApiError(message, response.status);
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      const timedOut = new ApiError("The request timed out. Check your connection.", 0);
      timedOut.timedOut = true;
      throw timedOut;
    }
    throw new ApiError(
      `Could not reach Juno at ${API_URL}. Is the server running?`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, { timeoutMs }),
  post: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), timeoutMs }),
  patch: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), timeoutMs }),
  delete: <T>(path: string, timeoutMs?: number) => request<T>(path, { method: "DELETE", timeoutMs }),
  /** A DELETE whose request is signed, so its proof travels in the body rather than the URL. */
  del: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body), timeoutMs }),
};

/* ------------------------------------------------------------------ */
/* Chain constants                                                     */
/* ------------------------------------------------------------------ */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * Which Arc network a row belongs to. Every server row is scoped to one.
 * Typed loosely: the server names it ("testnet", "mainnet"), and an unknown
 * value is shown as itself rather than guessed at.
 */
export type Network = string;

/** Arc's chain ids. */
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;

/**
 * USDC on Arc — the quote token of every Juno curve, and the gas token.
 *
 * Arc has one money: the native balance *is* USDC (18 decimals, what gas is
 * paid from) and the ERC-20 at 0x3600… is a 6-decimal view of the very same
 * balance. They are never added together.
 */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

/** Arc's explorers. Fallbacks only: `config.explorer` wins once read. */
const EXPLORERS = {
  testnet: "https://explorer.testnet.arc.io",
  mainnet: "https://explorer.arc.io",
} as const;

/** Circle's public testnet faucet: USDC on Arc testnet and other chains. */
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";

/** Chainlink's CCIP explorer: a message's page is `${CCIP_EXPLORER}/msg/<messageId>`. */
export const CCIP_EXPLORER = "https://ccip.chain.link";

function isMainnet(config: { network?: string; chainId?: number } | null | undefined): boolean {
  if (!config) return false;
  if (config.chainId === ARC_MAINNET_CHAIN_ID) return true;
  if (config.chainId === ARC_TESTNET_CHAIN_ID) return false;
  return /mainnet/i.test(config.network ?? "") || config.network === "arc";
}

/** "Arc testnet", for a details row. */
export function networkLabel(network?: string | null): string {
  const config = configLoaded;
  const name =
    config || network
      ? isMainnet(config ?? { network: network ?? undefined })
        ? "Arc mainnet"
        : "Arc testnet"
      : "Arc";
  // A local fork has the testnet's chain id and state, but it is not the
  // network, and a label that said so would pass one off as the other.
  return config?.localFork ? `${name} (local fork)` : name;
}

/** Whether the app is on Arc testnet (or a fork of it): faucets exist only there. */
export function onTestnet(): boolean {
  return !isMainnet(configLoaded);
}

/**
 * The address the API used for "no ERC-20" on the previous chain. Arc has no
 * separate native coin to trade — USDC is both — so nothing is quoted in it;
 * kept only so an old row that says so is recognised.
 */
export function isNative(address: string | null | undefined): boolean {
  return !!address && /^0x0{40}$/i.test(address);
}

/* ------------------------------------------------------------------ */
/* Shapes, mirroring the server's own types                            */
/* ------------------------------------------------------------------ */

export type QuoteToken = {
  /** ERC-20 address: USDC at 0x3600… on Arc. */
  address: Address;
  symbol: string;
  decimals: number;
  /** Always false on Arc: every curve is quoted in the USDC ERC-20 and buys need an approval. */
  native: boolean;
  icon?: string;
};

/** A chain Circle's Gateway or CCTP can reach, by its CCTP domain. */
export type CircleChain = { domain: number; name: string };

/** A CCIP lane from Arc, by its chain selector (a uint64 as a decimal string). */
export type CcipLane = { selector: string; name: string };

/**
 * The Arc stack as this server has it wired: what each piece is, and whether
 * it is live here. Every part may be absent on a server that predates it, and
 * the UI says "unavailable" rather than guessing.
 */
export type ArcStack = {
  finality?: string;
  memo?: { address: string; live: boolean };
  gateway?: { available: boolean; wallet: string; minter: string; domain: number; sources: CircleChain[] };
  cctp?: { domain: number; tokenMessenger: string; destinations: CircleChain[] };
  ccip?: { router: string; chainSelector: string; crossChain: string; lanes: CcipLane[]; explorer: string };
  feeds?: { network: string; count: number };
  relayer?: { available: boolean; address: string | null };
};

/** What `GET config` answers: which chain, and where to look things up on it. */
export type ChainConfig = {
  network: Network;
  chainId: number;
  rpcUrl: string;
  /**
   * The server's RPC is a local fork of Arc testnet, so a measured
   * confirmation time is the fork's. Absent on an older server.
   */
  localFork?: boolean;
  launchpad?: string | null;
  /** The explorer's base URL. Links are `${explorer}/tx/${hash}` and so on. */
  explorer: string;
  /** USDC's ERC-20 address on this network. */
  usdc?: string;
  contracts?: {
    launchpad?: string;
    swapRouter?: string;
    crossChain?: string;
    trackers?: string;
    uniswapV2Factory?: string;
    uniswapV2Router02?: string;
  };
  quoteTokens?: QuoteToken[];
  /** Whether `POST faucet` will answer — testnet only. */
  faucet?: boolean;
  /**
   * Whether a coin that graduated into Uniswap v2 can be traded in the app
   * (the deployment has Juno's swap router). Absent on an older server.
   */
  v2Trading?: boolean;
  arc?: ArcStack;
};

/** Where a curve graduates: a Uniswap v2 TOKEN/USDC pair, locked for good. */
export type Venue = "uniswap-v2";

export type CurveState = {
  progress: number;
  raisedUsd: number;
  thresholdUsd: number;
  /**
   * The curve has filled and trading on it is closed, but nobody has sent the
   * graduation transaction yet. Anyone may; until someone does, neither the
   * curve nor the pair will take a trade.
   */
  complete: boolean;
  graduated: boolean;
};

export type NavReference = {
  /** The Chainlink feed, "BTC/USD". */
  feed: string;
  priceUsd: number;
  /** Null when the curve and the reference cannot be compared — see `unitsPerToken`. */
  deviation: number | null;
  updatedAt: string;
  bandBps: number;
  withinBand: boolean | null;
  /** The curve's price restated in the reference's units. Null without a ratio. */
  impliedUsd: number | null;
  /** How much of the reference one token stands for, fixed at launch. */
  unitsPerToken: number | null;
  /** "stale" once the feed is past its heartbeat (24 h) plus an hour. */
  state: "live" | "stale" | "closed" | "mark";
  ageSeconds: number | null;
  /** Chainlink Data Feeds, read from Arc mainnet. */
  source: "chainlink" | string;
  /**
   * The same comparison as `JunoTrackers.mark` computes it on chain, when the
   * coin is tracked on chain on this network; null when the ratio is only
   * recorded off chain.
   */
  attested?: {
    trackers?: string;
    oracle?: string;
    navUsd: number;
    impliedUsd: number;
    premium?: number;
    premiumBps?: number;
    withinBand: boolean;
    stale?: boolean;
    bandBps?: number;
    observedAt?: string;
    updatedAt?: string;
  } | null;
};

export type Coin = {
  /** The token's address — the coin's id, and the `/coin/[token]` route. */
  address: string;
  format: "post" | "reel";
  name: string;
  symbol: string;
  description?: string;
  media: { kind: "image" | "video"; url: string; posterUrl?: string; width: number; height: number };
  creator: { handle: string; displayName: string; avatarUrl: string; wallet: string };
  createdAt: string;
  /** A pool is keyed by its token inside the launchpad, so this equals `address`. */
  pool: string;
  /** The launchpad contract holding the curve. */
  launchpad: string;
  quote: QuoteToken;
  /**
   * USD price of one quote token, or null when no feed answered.
   *
   * Quote-denominated figures — a recurring-buy amount, a contribution — are
   * signed for in quote units; this is what converts them for display, and
   * null has to stay null rather than collapsing to one-to-one.
   */
  quoteUsdRate: number | null;
  marketCap: number;
  marketCapCurrency: string;
  marketCapChangePct: number | null;
  volume24h: number | null;
  totalVolume: number | null;
  /**
   * What the creator can claim right now, in `marketCapCurrency`.
   *
   * Read from the pool's own fee balance, so it drops to zero after a claim —
   * a lifetime total would invite someone to press Claim for money already in
   * their wallet.
   */
  creatorRewards: number;
  /** Creator fees already claimed, in `marketCapCurrency`. With `creatorRewards`, the lifetime total. */
  creatorRewardsClaimed?: number;
  /** Fills in the coin's history; null when unread. */
  tradeCount?: number | null;
  holders: number | null;
  priceUsd: number;
  priceHistory?: Array<{ t: string; price: number; volume: number; side: "buy" | "sell" }>;
  /** The swap read was cut short — the ticks above are a prefix, not the history. */
  priceHistoryPartial?: boolean;
  nav?: NavReference | null;
  curve: CurveState;
  curvePreset: string;
  /**
   * What the market is marked against, from the registry. Null for a post or
   * reel; undefined from a server that predates the field.
   */
  reference?: { source: "chainlink" | string; id: string } | null;
  /**
   * The Uniswap v2 pair this coin graduates into.
   *
   * Created at launch and locked until graduation, so it is known — and
   * linkable — before the curve fills. Null or absent when the server could
   * not say, which is not the same as there being no pair.
   */
  pair?: string | null;
  /** Where the curve graduates. Always a Uniswap v2 pair on Arc. */
  venue?: Venue;
  /** Present when the list was asked for `social=1`. */
  likes?: number;
  commentCount?: number;
  viewerLiked?: boolean | null;
};

export type Activity = {
  id: string;
  side: "buy" | "sell";
  actor: { handle: string; avatarUrl: string };
  /** Who signed it. The handle is a shortened form of this, not a key. */
  wallet: string;
  amount: number;
  valueUsd: number;
  timestamp: string;
  /** The transaction that made the trade. */
  txHash?: string;
};

export type Holder = {
  rank: number;
  actor: { handle: string; avatarUrl: string };
  wallet: string;
  balance: number;
  share: number;
};

export type FeedItem =
  | {
      kind: "trade";
      id: string;
      timestamp: string;
      side: "buy" | "sell";
      amount: number;
      valueUsd: number;
      price: number;
      priceNow: number | null;
      currency: string;
      txHash?: string;
      /** What the trader said about this fill when they signed it, if anything. */
      note: string | null;
      actor: { wallet: string; handle: string; avatarUrl: string };
      coin: {
        address: string;
        name: string;
        symbol: string;
        mediaUrl: string | null;
        mediaKind: string;
        posterUrl: string | null;
      };
    }
  | {
      kind: "post";
      id: string;
      timestamp: string;
      body: string;
      author: { wallet: string; handle: string; avatarUrl: string };
      mediaUrl: string | null;
      mediaKind: string | null;
      replyCount: number;
      /** The market this post is about, priced. Price is null when unread. */
      coin: {
        address: string;
        name: string;
        symbol: string;
        priceUsd: number | null;
        currency: string;
        changePct: number | null;
        progress: number | null;
        graduated: boolean;
        /** Null when the holder read was refused — not "held by nobody". */
        holders: number | null;
      } | null;
    };

export type PositionTrade = {
  t: string;
  side: "buy" | "sell";
  base: number;
  /** The mark right after the trade — what the value chart plots, not what was paid. */
  price: number;
  /** What was paid (buy, fee included) or received (sell). Absent on an older server. */
  quote?: number;
};

export type Position = {
  /** The coin's token address. */
  token: string;
  name: string;
  symbol: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  /** A reel's poster frame. Absent from a server older than 7 Oct. */
  posterUrl?: string | null;
  curvePreset: string;
  balance: number;
  price: number;
  value: number;
  averageCost: number | null;
  unrealisedPnl: number | null;
  unrealisedPnlPct: number | null;
  realisedPnl: number;
  currency: string;
  graduated: boolean;
  trades: PositionTrade[];
};

export type Portfolio = {
  wallet: string;
  positions: Position[];
  /** Null when the pool walk did not finish and found nothing — not "$0". */
  totalValue: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
  currency: string;
  partial: boolean;
  /** What the wallet was worth at each moment it traded, oldest first. */
  history: Array<{ t: string; value: number }>;
};

export type PostDetail = {
  id: string;
  body: string;
  timestamp: string;
  author: { wallet: string; handle: string; avatarUrl: string };
  mediaUrl: string | null;
  mediaKind: string | null;
};

/** A comment on a coin. `side` and `txHash` are set when it came with a trade. */
export type CoinComment = {
  id: string;
  token: string;
  wallet: string;
  body: string;
  side?: "buy" | "sell";
  txHash?: string;
  createdAt: string;
};

/** Who else is in this market, derived from the fills the chart is drawn from. */
export type Crowd = {
  /** USD per quote token, or 1 when no feed answered. Flow figures are in quote units. */
  quoteUsdRate: number;
  traders: number;
  holdersStill: number;
  firstBuyer: {
    wallet: string;
    price: number;
    timestamp: string;
    multiple: number | null;
  } | null;
  netFlow24h: number;
  netFlow7d: number;
  fills24h: number;
  biggestBuy: number | null;
  /** The swap walk was cut short — these are floors, not totals. */
  partial: boolean;
};

export type DepthPoint = {
  amountIn: number;
  amountOut: number;
  averagePrice: number;
  /** Total shortfall against spot, fee included. */
  priceImpact: number;
  /** The part the curve caused, fee excluded. */
  curveImpact: number;
  fee: number;
};

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

/**
 * One EIP-1559 transaction the server built and the device signs.
 *
 * Every number is hex so it survives JSON; the wallet turns them back into
 * bigints before signing (see `lib/wallet.tsx`). Nonces across a batch are
 * consecutive, which is what lets every step be signed up front.
 */
export type UnsignedTransaction = {
  /** "Buying", "Approving USDC", "Opening its market" — said while it runs. */
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

/** What `POST tx/submit` (and `tx/buy-relayed`) answers once the receipt is in. */
export type SubmitResult = {
  hash: Hex;
  blockNumber: number;
  from: Address;
  status?: "success" | "reverted" | string;
  /** Trades the transaction made, as the server recorded them. */
  trades: number;
  /** Set when the transaction launched a token. */
  launched?: { token: Address; pair: Address | null; creator: Address };
  /** Set when the transaction graduated a curve. */
  graduated?: { token: Address; venue: Address };
  /** Set when a buy filled a curve to its top. */
  completed?: Address[];
  /** Milliseconds from submit to receipt, as the server measured it. On Arc a receipt is final. */
  confirmMs?: number;
  /** The same figure under its older name. */
  confirmedInMs?: number;
  /** The explorer page for this transaction. */
  explorerUrl?: string;
  /** Set when the transaction sent a CCIP message (a cross-chain token transfer). */
  ccipMessageId?: Hex;
  /** Set on a relayed (gasless) buy: who paid the gas. */
  relayer?: Address;
  /** Arc Memo, when the call was tagged. */
  memo?: MemoTag;
};

/** How a curve trade was tagged with its post through Arc's Memo contract. */
export type MemoTag = { id: Hex; tagged: boolean; data?: string };

/** The measured submit-to-receipt time, whichever name the server used. */
export function confirmMsOf(result: Pick<SubmitResult, "confirmMs" | "confirmedInMs"> | null | undefined): number | null {
  return result?.confirmMs ?? result?.confirmedInMs ?? null;
}

export type SwapBuild = {
  /** In order. Usually one; an approval first when a USDC buy needs one. */
  steps: UnsignedTransaction[];
  /**
   * When the built swap stops being valid, in unix seconds. Signed after it,
   * the swap reverts on-chain with `Expired` — so the app re-quotes instead of
   * submitting something stale.
   */
  window: { deadline: number };
  quote: {
    amountOut: number;
    minimumAmountOut: number;
    amountUsed: number;
    fee: number;
    priceImpact: number;
    curveImpact: number;
    /** Exact-out buys only: the expected cost, and the most the transaction may spend. */
    amountIn?: number;
    maximumAmountIn?: number;
  };
  quoteSymbol: string;
  quoteUsdRate: number | null;
  /** Where the order goes: the curve, or after graduation the coin's Uniswap v2 pair. */
  venue?: "curve" | "uniswap-v2";
  pair?: string;
  /** Curve trades are wrapped in Arc Memo when it is live on this RPC. */
  memo?: MemoTag;
};

/* ------------------------------------------------------------------ */
/* The Arc stack                                                       */
/* ------------------------------------------------------------------ */

/** EIP-712 typed data as the server hands it over: numbers that overflow JSON arrive as strings. */
export type TypedDataPayload = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** `POST tx/buy-intent`: an EIP-3009 authorisation for a relayed, gasless buy. */
export type BuyIntent = {
  typedData: TypedDataPayload;
  intent: {
    token: Address;
    buyer: Address;
    quoteIn: string;
    minBaseOut: string;
    deadline: number;
    salt: Hex;
  };
  quote: { amountOut: number; price: number; fee: number };
  relayer: Address;
};

/** `GET gateway?depositor=`: Circle Gateway's unified USDC balance. */
export type GatewayBalances = {
  available: boolean;
  depositor: string;
  total: number;
  totalUnits?: string;
  balances: Array<{ domain: number; name: string; balance: number; balanceUnits?: string }>;
  wallet?: string;
  minter?: string;
  sources?: CircleChain[];
  /** Why the balance could not be read, when it could not. */
  error?: string;
};

export type GatewayMint = {
  status: string;
  mintTxHash: Hex;
  explorerUrl?: string;
  amount: number;
  recipient: string;
};

/** `POST tx/claim` with a destination: fees burned through CCTP V2 to another chain. */
export type ClaimBuild = {
  steps: UnsignedTransaction[];
  cctp?: {
    destinationDomain: number;
    destination: string;
    amount: number;
    maxFee: number;
    finalityThreshold: number;
  };
};

export type CctpStatus = {
  status: "pending" | "complete" | "unknown";
  attestation?: Hex;
  message?: Hex;
  destinationDomain?: number;
};

/** One rate limiter on a CCIP token pool, as the pool reports it. */
export type CcipBucket = { tokens: number | string; capacity: number | string; rate: number | string; isEnabled: boolean };

/** `GET ccip/<token>`: the coin as a Chainlink CCIP Cross-Chain Token. */
export type CcipView = {
  enabled: boolean;
  pool: string | null;
  handedOver: boolean;
  chains: Array<{
    selector: string;
    name: string;
    remoteToken: string | null;
    remotePools: string[];
    outbound: CcipBucket | null;
    inbound: CcipBucket | null;
  }>;
  /** Tokens burned on Arc and minted elsewhere, net of what came back. */
  bridgedOut: number | string;
  ccipAdmin: string | null;
  registryPool: string | null;
  /** Graduated and not yet enabled: the creator can make it cross-chain. */
  canEnable: boolean;
  lanes: CcipLane[];
};

export type CcipSendBuild = {
  steps: UnsignedTransaction[];
  /** The CCIP fee, paid in native USDC alongside the send. */
  fee: { usdc: number; wei: string };
  lane: CcipLane;
};

/** `GET trackers`: Chainlink Data Feeds, read from Arc mainnet. */
export type TrackerFeed = {
  /** "BTC/USD". */
  id: string;
  feedId: Hex;
  address: string;
  priceUsd: number;
  updatedAt: string | number;
  ageSeconds: number;
  stale: boolean;
};

export type Peg = { usdcUsd: number; updatedAt: string | number; source: string; stale: boolean };

export type LaunchBuild = {
  steps: UnsignedTransaction[];
  /** Where the token will be deployed — predicted by the launchpad before it exists. */
  token: Address;
  launchpad: Address;
  /** What the curve raises before it graduates, in quote units. */
  migrationQuoteThreshold: number;
};

/* ------------------------------------------------------------------ */
/* Social trading and savings                                          */
/* ------------------------------------------------------------------ */

export type Trader = {
  wallet: string;
  /** Profit already taken. The rank is on this and nothing else. */
  realised: number;
  /** Open position against cost. Null when the buys predate the read window. */
  unrealised: number | null;
  trades: number;
  coins: number;
  /** Null when no sell had a cost to compare against — unmeasured, not zero. */
  winRate: number | null;
  bestExit: number | null;
  holding: number;
  isCreator: boolean;
  followers: number;
};

/** One notification, built from something that already happened (see lib/juno/inbox.ts). */
export type InboxItem =
  | { id: string; kind: "trade"; at: string; actor: string; token: string; symbol: string; side: "buy" | "sell"; base: number; quote: number; quoteSymbol: string; txHash: string }
  | { id: string; kind: "follow"; at: string; actor: string }
  | { id: string; kind: "comment"; at: string; actor: string; token: string; symbol: string; body: string }
  | { id: string; kind: "like"; at: string; actor: string; token: string; symbol: string }
  | { id: string; kind: "alert"; at: string; token: string; symbol: string; direction: "up" | "down"; alertPrice: number; priceNow: number }
  | { id: string; kind: "plan"; at: string; token: string; symbol: string; amount: number; cadence: string };

/** `GET /api/juno/notifications?wallet=`. */
export type Inbox = { items: InboxItem[]; unread: number; seenAt: string | null };

/** `GET /api/juno/stats`. */
export type JunoStats = {
  network: string;
  localFork: boolean;
  coins: number | null;
  trades24h: number | null;
  traders24h: number | null;
  block: { number: number; timestamp: number } | null;
  /** Confirmation times the server measured; null before it has submitted anything. */
  confirmation: { lastMs: number; lastAt: string; medianMs: number; samples: number } | null;
  /** How many of the feed's pictures the server holds in memory, of how many. */
  pictures: { held: number; total: number } | null;
  at: string;
};

/**
 * `GET /api/juno/tx/cost?hash=`: what a confirmed transaction cost in gas,
 * which on Arc is paid in USDC. Typed loosely, because the figures live under
 * the chain's own key; `txFee` reads them.
 */
export type TxCost = {
  hash: string;
  blockNumber: number;
  localFork: boolean;
  [chain: string]: unknown;
};

/** The gas a transaction paid, in USDC, from a `TxCost`. Null when the server did not say. */
export function txFee(cost: TxCost | null | undefined): { gasUsed: number; feeUsdc: number; gasPriceGwei: number | null } | null {
  if (!cost) return null;
  const block = (cost.arc ?? cost.chain ?? cost.fee ?? null) as Record<string, unknown> | null;
  if (!block) return null;
  const fee = Number(block.feeUsdc ?? block.feeUsd ?? block.fee);
  const gasUsed = Number(block.gasUsed);
  if (!Number.isFinite(fee) || !Number.isFinite(gasUsed)) return null;
  const price = Number(block.gasPriceGwei);
  return { gasUsed, feeUsdc: fee, gasPriceGwei: Number.isFinite(price) ? price : null };
}

/** `GET /api/juno/profiles/<wallet>`. */
export type CreatorProfile = {
  network: Network;
  wallet: string;
  /** Each null when never set. */
  name: string | null;
  bio: string | null;
  link: string | null;
  followers: number;
  following: number;
  /** Null when no viewer was given. */
  viewerFollows: boolean | null;
  /** Every listed coin this wallet launched, newest first. */
  coins: Coin[];
  /** Coins the chain read could not price: the list is short by this many. */
  missing: number;
};

export type WatchItem = {
  token: string;
  watchedAt: string;
  alertPrice: number | null;
  /** Null when the coin could not be priced: an alert cannot be judged against a price nobody read. */
  alertCrossed: "up" | "down" | null;
  coin: {
    address: string;
    name: string;
    symbol: string;
    priceUsd: number;
    marketCap: number;
    currency: string;
    changePct: number | null;
    progress: number;
    graduated: boolean;
    media: { kind: "image" | "video"; url: string; posterUrl?: string };
  } | null;
};

export type Plan = {
  id: string;
  token: string;
  amount: number;
  cadence: "daily" | "weekly" | "monthly";
  target: number | null;
  /** Only moves when a swap confirms — a record of transactions, not intentions. */
  contributed: number;
  fills: number;
  lastFilledAt: string | null;
  nextDueAt: string;
  due: boolean;
  active: boolean;
  /**
   * `amount`, `target` and `contributed` are **quote-token units** — USDC,
   * because that is what a buy is signed for. `quoteSymbol` labels them; `quoteUsdRate` converts them, and
   * is null when no feed answered.
   */
  coin: {
    address: string;
    name: string;
    symbol: string;
    priceUsd: number;
    currency: string;
    quoteSymbol: string;
    quoteUsdRate: number | null;
    media?: { kind: "image" | "video"; url: string; posterUrl?: string };
  } | null;
};

/* ------------------------------------------------------------------ */
/* Configuration, read once                                            */
/* ------------------------------------------------------------------ */

/**
 * `GET config`, shared for the life of the app.
 *
 * It names the network, the explorer and the quote tokens — facts that do not
 * change while the app is open, so one read serves every screen. A failed read
 * is not kept: the next caller asks again rather than inheriting the failure.
 */
let configRead: Promise<ChainConfig> | null = null;
let configLoaded: ChainConfig | null = null;

function readConfig(): Promise<ChainConfig> {
  if (configRead) return configRead;
  const value = api.get<ChainConfig>("/api/juno/config").then((config) => {
    configLoaded = config;
    return config;
  });
  configRead = value;
  value.catch(() => {
    if (configRead === value) configRead = null;
  });
  return value;
}

/** The explorer to link to: the server's, once known; Arc testnet's until then. */
function explorerBase(): string {
  return (configLoaded?.explorer ?? EXPLORERS[isMainnet(configLoaded) ? "mainnet" : "testnet"]).replace(/\/$/, "");
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export const juno = {
  /** Which chain the server is on, its explorer, and the quote tokens it accepts. */
  config: readConfig,

  /** The config if it has already been read, without waiting. */
  loadedConfig: (): ChainConfig | null => configLoaded,

  /** USDC, the quote token of every curve: from the config when read, the constant until then. */
  usdc: (): QuoteToken => {
    const listed = configLoaded?.quoteTokens?.find((token) => token.symbol === "USDC");
    if (listed) return listed;
    return { address: (configLoaded?.usdc as Address | undefined) ?? USDC_ADDRESS, symbol: "USDC", decimals: 6, native: false };
  },

  /** The Arc stack as the server has it wired, once the config has been read. */
  arc: (): ArcStack | null => configLoaded?.arc ?? null,

  /** Traders ranked by profit taken. `partial` when the walk came back short. */
  leaderboard: (limit = 20) =>
    api.get<{
      network: Network;
      partial: boolean;
      poolsRead: number;
      /** What the registry holds, so `poolsRead` can be read against something. */
      poolsTotal: number;
      traders: Trader[];
    }>(
      `/api/juno/leaderboard?limit=${limit}`,
    ),

  followStats: (wallet: string, viewer?: string | null) =>
    api.get<{
      wallet: string;
      followers: number;
      following: number;
      /** Null when there is no viewer — different from "does not follow". */
      viewerFollows: boolean | null;
      followingList: string[];
    }>(`/api/juno/follow?wallet=${wallet}${viewer ? `&viewer=${viewer}` : ""}`),

  setFollow: (follower: string, target: string, on: boolean) =>
    api.post<{ target: string; isFollowing: boolean; followers: number; following: number }>(
      "/api/juno/follow",
      { follower, target, following: on },
    ),

  /**
   * This wallet's relationship to one coin — watching, alert, plans.
   *
   * Postgres only. The list endpoints answer the same questions but hydrate
   * every pool from the chain to do it, which the coin screen cannot afford to
   * wait for just to decide what a button says.
   */
  saved: (wallet: string, token: string) =>
    api.get<{
      wallet: string;
      token: string;
      watching: boolean;
      alertPrice: number | null;
      /** The price when the alert was set — the direction is derived from it. */
      alertSetAtPrice: number | null;
      plans: Omit<Plan, "coin">[];
    }>(`/api/juno/saved?wallet=${wallet}&token=${token}`),

  watchlist: (wallet: string) =>
    api.get<{ wallet: string; items: WatchItem[]; missing: number }>(
      `/api/juno/watchlist?wallet=${wallet}`,
    ),

  setWatch: (input: {
    wallet: string;
    token: string;
    watch: boolean;
    alertPrice?: number;
    priceNow?: number;
  }) => api.post<{ token: string; watching: boolean }>("/api/juno/watchlist", input),

  plans: (wallet: string) =>
    api.get<{ wallet: string; plans: Plan[]; missing: number }>(`/api/juno/plans?wallet=${wallet}`),

  createPlan: (input: {
    wallet: string;
    token: string;
    amount: number;
    cadence: "daily" | "weekly" | "monthly";
    target?: number | null;
  }) => api.post<{ id: string }>("/api/juno/plans", input),

  /**
   * Called only after a swap confirms, so progress records real transactions.
   * The hash goes with it so the server can check the fill it is being told about.
   */
  recordContribution: (id: string, contributed: number, txHash: string) =>
    api.patch<{ plan: Plan }>("/api/juno/plans", { id, contributed, txHash }),

  setPlanActive: (id: string, active: boolean) =>
    api.patch<{ id: string; active: boolean }>("/api/juno/plans", { id, active }),

  removePlan: (id: string) =>
    api.delete<{ id: string; deleted: boolean }>(`/api/juno/plans?id=${encodeURIComponent(id)}`),

  /**
   * The feed, optionally narrowed to wallets `following` follows.
   *
   * Filtered server-side: a client cannot know how many rows to ask for to be
   * sure the filter has something to work with.
   */
  feed: (limit = 40, following?: string) =>
    api.get<{
      network: Network;
      items: FeedItem[];
      /** The trade half was walked against a refusing endpoint — not the whole network. */
      tradesPartial: boolean;
      scope: "everyone" | "following";
      /** How many wallets the following feed covers. Null on the everyone feed. */
      followingCount: number | null;
    }>(
      `/api/juno/feed?limit=${limit}${following ? `&following=${following}` : ""}`,
    ),

  coins: (
    sort?: "marketCap" | "graduating",
    extra?: {
      /** Likes and comment counts too, and whether `viewer` liked each. */
      social?: boolean;
      viewer?: string | null;
      /** Each tracker's reference price — a Chainlink feed read per tracker. */
      nav?: boolean;
    },
  ) =>
    api.get<{
      network: Network;
      coins: Coin[];
      /** Registry rows the server could not price — the list is short by this many. */
      missing: number;
    }>(
      `/api/juno/coins?limit=40${sort ? `&sort=${sort}` : ""}${
        extra?.social ? `&social=1${extra.viewer ? `&viewer=${extra.viewer}` : ""}` : ""
      }${extra?.nav ? "&nav=1" : ""}`,
    ),

  /** Like counts for a page of coins, and whether `viewer` liked each. */
  likes: (coins: string[], viewer?: string | null) =>
    api.get<{ counts: Record<string, { likes: number; comments: number; viewerLiked: boolean | null }> }>(
      `/api/juno/likes?coins=${coins.join(",")}${viewer ? `&viewer=${viewer}` : ""}`,
    ),

  setLike: (input: { token: string; wallet: string; liked: boolean }) =>
    api.post<{ token: string; likes: number; liked: boolean }>("/api/juno/likes", input),

  coin: (token: string) =>
    api.get<{
      network: Network;
      coin: Coin;
      activity: Activity[];
      /** The swap walk was cut short — an empty `activity` is not "no trades". */
      activityPartial: boolean;
      holders: Holder[];
      /** The holder read was refused — an empty `holders` is not "no holders". */
      holdersUnreadable: boolean;
      /** How the holder list was derived. Null when it could not be. */
      holdersSource: string | null;
      /** How current the indexer is, when the holders came from it. */
      indexer?: { progressBlock: number; behind: number } | null;
      /** Null when the history could not be read at all — not "nobody traded". */
      crowd: Crowd | null;
      /** The transaction that launched this coin. */
      launchTx: string | null;
    }>(`/api/juno/coins/${token}`),

  portfolio: (wallet: string) => api.get<Portfolio>(`/api/juno/portfolio/${wallet}`),

  /** The wallet's notifications, newest first, and how many are new since its last visit. */
  notifications: (wallet: string) => api.get<Inbox>(`/api/juno/notifications?wallet=${wallet}`),
  /** The inbox was opened: everything in it is read. */
  markNotificationsSeen: (wallet: string) => api.post<{ seenAt: string }>("/api/juno/notifications", { wallet }),

  /** The landing's live figures. Each part is null when its read failed. */
  stats: () => api.get<JunoStats>("/api/juno/stats"),

  /** What a confirmed transaction cost in gas, paid in USDC on Arc. */
  txCost: (hash: string) => api.get<TxCost>(`/api/juno/tx/cost?hash=${hash}`),

  /** A creator's profile page: who they are, their follow graph, and every coin they launched. */
  profile: (wallet: string, viewer?: string | null) =>
    api.get<CreatorProfile>(`/api/juno/profiles/${wallet}${viewer ? `?viewer=${viewer}` : ""}`),

  /** Set a bio and link, signed by the wallet (see `detailsMessage` in lib/names). */
  saveProfileDetails: (input: { wallet: string; bio: string; link: string; issuedAt: string; signature: string }) =>
    api.post<{ wallet: string; bio: string; link: string }>(`/api/juno/profiles/${input.wallet}`, input),

  /** Comments on a coin, newest first. */
  comments: (token: string) =>
    api.get<{ comments: CoinComment[] }>(`/api/juno/comments?coin=${token}`),

  /**
   * Say something about a coin — optionally alongside a trade you just made.
   *
   * `side` and `txHash` are what turn a comment into an announcement: the
   * row then carries which way you went and the transaction that proves it,
   * so the claim is checkable rather than asserted.
   */
  addComment: (input: {
    token: string;
    wallet: string;
    body: string;
    side?: "buy" | "sell";
    txHash?: string;
  }) => api.post<{ comment: CoinComment }>("/api/juno/comments", input),

  /**
   * What this curve can absorb, and the largest trade inside an impact budget.
   *
   * `impact` is a ratio measured on curve movement with the fee excluded —
   * the fee does not grow with size, so including it would make the answer
   * mostly a constant.
   */
  depth: (token: string, side: "buy" | "sell" = "buy", impact?: number) =>
    api.get<{
      token: string;
      side: "buy" | "sell";
      spot: number;
      quoteSymbol: string;
      quoteUsdRate: number | null;
      max: number;
      points: DepthPoint[];
      suggestion:
        | (DepthPoint & { ceilingReached: boolean })
        | null;
    }>(
      `/api/juno/depth?token=${token}&side=${side}${impact ? `&impact=${impact}` : ""}`,
      60_000,
    ),

  createPost: (input: {
    author: string;
    body: string;
    token?: string | null;
    /** Set to reply. A comment is a post with a parent. */
    parentId?: string | null;
    mediaUrl?: string | null;
    mediaMime?: string | null;
  }) => api.post<{ post: { id: string } }>("/api/juno/posts", input),

  post: (id: string) =>
    api.get<{
      post: PostDetail;
      replies: PostDetail[];
      replyCount: number;
      coin: {
        address: string;
        name: string;
        symbol: string;
        priceUsd: number;
        marketCap: number;
        currency: string;
        changePct: number | null;
        progress: number;
        graduated: boolean;
      } | null;
    }>(`/api/juno/posts/${id}`),

  /**
   * Index a launch after its transaction has confirmed.
   *
   * The server re-reads the pool from chain and checks the creator and the
   * launch transaction before writing the row, so this cannot be used to
   * claim a pool that does not exist — or someone else's.
   */
  recordLaunch: (input: {
    token: string;
    name: string;
    symbol: string;
    format: "post" | "reel";
    curvePreset: string;
    /** The launch transaction's hash. */
    createTx: string;
    description?: string | null;
    mediaUrl?: string | null;
    posterUrl?: string | null;
    mediaMime?: string | null;
    mediaWidth?: number | null;
    mediaHeight?: number | null;
    navFeedId?: string | null;
  }) => api.post<{ pool: unknown }>("/api/juno/pools", input),

  /**
   * Pin a photo or video to IPFS. A video comes back with a poster frame.
   *
   * Multipart, so it bypasses the JSON helper. `file` is a web `File` in the
   * browser and the `{ uri, name, type }` shape React Native's fetch uploads
   * from on a phone.
   */
  upload: async (file: Blob | { uri: string; name: string; type: string }) => {
    const form = new FormData();
    form.append("file", file as Blob);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${API_URL}/api/juno/upload`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | {
            uri: string;
            url: string;
            mimeType: string;
            posterUri?: string;
            posterUrl?: string;
            width: number | null;
            height: number | null;
            error?: string;
          }
        | null;
      if (!response.ok || !body) {
        throw new ApiError(body?.error ?? `Upload failed (${response.status})`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError("The upload timed out. Try a shorter clip or a better connection.", 0);
      }
      throw new ApiError("Could not upload the file. Check your connection.", 0);
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Testnet USDC for this wallet, sent by Juno's relayer (once a day per
   * address). Testnet only. `externalFaucet` is Circle's, for when ours is dry.
   */
  faucet: (address: string) =>
    api.post<{ hash: string; amount: number; symbol?: string; explorerUrl?: string; externalFaucet?: string }>(
      "/api/juno/faucet",
      // `wallet` too, for a server that still reads the older field name.
      { address, wallet: address },
      90_000,
    ),

  /** Pin the token's metadata, which its `tokenURI` points at forever. */
  pinMetadata: (input: {
    name: string;
    symbol: string;
    description?: string;
    curvePreset: string;
    imageUrl?: string;
    mimeType?: string;
  }) => api.post<{ uri: string }>("/api/juno/metadata", input),

  buildSwap: (
    input: {
      token: string;
      owner: string;
      side: "buy" | "sell";
      /** What to spend (quote on a buy, tokens on a sell)… */
      amountIn?: number;
      /** …or, on a curve buy, exactly how many tokens to receive… */
      amountOut?: number;
      /** …or, on a sell, a share of the holding (0 < f ≤ 1), made exact by the server. */
      sellFraction?: number;
      slippageBps?: number;
    },
    /** Shorter than the default when the caller has a usable quote to fall back on. */
    timeoutMs?: number,
  ) => api.post<SwapBuild>("/api/juno/tx/swap", input, timeoutMs),

  buildLaunch: (input: {
    creator: string;
    name: string;
    symbol: string;
    preset: string;
    uri?: string;
    /** Quote token address: USDC. */
    quoteToken?: string;
    initialMarketCap?: number;
    migrationMarketCap?: number;
    /** The creator's own first buy, in quote units, made in the launch transaction. */
    firstBuy?: number;
    /** A tracker coin (preset `tight-nav`): the Chainlink feed it follows, and how much of it one token stands for. */
    tracker?: { feed: string; unitsPerToken: number };
  }) => api.post<LaunchBuild>("/api/juno/tx/launch", input),

  /**
   * Pay the creator the trading fees their coin has accrued. Creator only.
   * With `destinationDomain`, the fees are burned through Circle CCTP V2 and
   * minted as USDC on that chain (to `recipient`, default the creator).
   */
  claim: (input: { creator: string; token: string; destinationDomain?: number; recipient?: string; fast?: boolean }) =>
    api.post<ClaimBuild>("/api/juno/tx/claim", input),

  /** Where a CCTP burn has got to: Circle's attestation, from Iris. */
  cctpStatus: (hash: string) => api.get<CctpStatus>(`/api/juno/cctp/status?hash=${hash}`, 20_000),

  /** A gasless buy: the EIP-3009 authorisation to sign, and the quote it buys at. */
  buyIntent: (input: { token: string; owner: string; amountIn: number; slippageBps?: number }) =>
    api.post<BuyIntent>("/api/juno/tx/buy-intent", input),

  /** Juno's relayer submits the signed authorisation as `buyWithAuthorization` and pays the gas. */
  buyRelayed: (input: { intent: BuyIntent["intent"]; signature: Hex }) =>
    api.post<SubmitResult>("/api/juno/tx/buy-relayed", input, 90_000),

  /** Circle Gateway: this wallet's unified USDC balance, per chain. */
  gateway: (depositor: string) => api.get<GatewayBalances>(`/api/juno/gateway?depositor=${depositor}`, 20_000),
  /** Approve + deposit USDC from Arc into the Gateway Wallet. */
  gatewayDeposit: (input: { owner: string; amount: number }) =>
    api.post<{ steps: UnsignedTransaction[] }>("/api/juno/gateway/deposit", input),
  /** The burn intent to sign for spending Gateway USDC held on `sourceDomain` on Arc. */
  gatewayIntent: (input: { depositor: string; sourceDomain: number; recipient: string; amount: number }) =>
    api.post<{ typedData: TypedDataPayload; maxFee: number }>("/api/juno/gateway/intent", input),
  /** Hand the signed burn intent to Circle; the relayer mints the USDC on Arc. */
  gatewayMint: (input: { burnIntent: unknown; signature: Hex }) =>
    api.post<GatewayMint>("/api/juno/gateway/mint", input, 90_000),

  /** The coin as a Chainlink CCIP Cross-Chain Token: pool, lanes, rate limits, bridged-out supply. */
  ccip: (token: string) => api.get<CcipView>(`/api/juno/ccip/${token}`),
  /** Creator only, after graduation: deploy the coin's CCIP token pool and register it (one transaction). */
  ccipEnable: (input: { token: string; creator: string }) =>
    api.post<{ steps: UnsignedTransaction[] }>("/api/juno/tx/ccip-enable", input),
  /** Send tokens across a CCIP lane: approve the router, then `ccipSend` with the fee in native USDC. */
  ccipSend: (input: { token: string; owner: string; amount: number; destination: string; receiver?: string }) =>
    api.post<CcipSendBuild>("/api/juno/tx/ccip-send", input),

  /** Chainlink Data Feeds on Arc mainnet, live: price and age per feed. */
  trackers: () => api.get<{ network: string; feeds: TrackerFeed[] }>("/api/juno/trackers"),
  /** USDC's own peg, from Chainlink's USDC/USD feed on Arc mainnet. */
  peg: () => api.get<Peg>("/api/juno/peg"),

  /** Move a filled curve into its Uniswap v2 pair. Anyone may send it. */
  graduate: (input: { from: string; token: string }) =>
    api.post<{ steps: UnsignedTransaction[] }>("/api/juno/tx/graduate", input),

  /**
   * What this wallet holds of one token (USDC: the 6-decimal ERC-20). `balance`
   * is null when the read failed: not zero, which would grey out a button over
   * a network hiccup.
   */
  balance: (wallet: string, token: string) =>
    api.get<{
      wallet: string;
      token: string;
      symbol: string;
      decimals: number;
      balance: number | null;
      /** Exact, in the smallest unit, as a decimal string. */
      raw: string | null;
    }>(`/api/juno/tx/balance?wallet=${wallet}&token=${token}`),

  /** Broadcast one signed transaction and wait for its receipt. */
  submit: (input: { signed: Hex }) =>
    // Submitting waits for the receipt, which is slower than a read.
    api.post<SubmitResult>("/api/juno/tx/submit", input, 90_000),

  /**
   * A URL the native `<Image>` can actually load, or null.
   *
   * Null is not just "absent" here — it also covers media the platform cannot
   * render, and the caller is expected to draw its own glyph instead. The
   * server falls back to an identicon encoded as `data:image/svg+xml`, which
   * renders fine in a browser and makes iOS throw "URI parsing error" out of
   * RCTImageManager, taking the whole screen down with a redbox. SVG data URIs
   * are therefore filtered out here rather than at each of the four call sites.
   */
  media: (url: string | null | undefined): string | null => {
    if (!url) return null;
    if (url.startsWith("data:image/svg")) return null;
    return url.startsWith("http") ? url : `${API_URL}${url}`;
  },

  /**
   * The best *still* image for a coin, for a list row or a thumbnail.
   *
   * Reel coins carry a video in `media.url` and a real poster frame beside it.
   * Handing the video to `<Image>` renders nothing at all, which is why the
   * market list showed a grey square for every reel while the coins with no
   * media at all were fine. A still context wants the poster; only if there
   * isn't one does the video's own url get a try, and a video url that is its
   * own poster is refused rather than silently failing to draw.
   */
  still: (media: {
    kind: "image" | "video";
    url: string;
    posterUrl?: string;
  }): string | null => {
    const poster = media.posterUrl && media.posterUrl !== media.url ? media.posterUrl : null;
    if (poster) return juno.media(poster);
    return media.kind === "video" ? null : juno.media(media.url);
  },

  /** An Arc explorer link to a transaction, a wallet or a token. */
  explorer: (kind: "tx" | "address" | "token", id: string) => `${explorerBase()}/${kind}/${id}`,
  /**
   * Whether the Arc explorer can show what this server made. Not on a local fork:
   * its transactions, tokens and pairs exist on no public chain, and every
   * "View the transaction" there opened a page that said "not found".
   */
  explorable: () => !configLoaded?.localFork,
};
