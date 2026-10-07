import "server-only";

import { decodeEventLog, getAddress, type DecodeEventLogReturnType, type Hex } from "viem";

import { junoLaunchpadAbi, junoSwapRouterAbi } from "./abi";
import { quoteTokenFor } from "./launchpad";
import { launchpadAddress, localFork, rpcEndpoint, swapRouterAddress } from "./network";

/**
 * Juno's events as Arc commits them, live.
 *
 * Arc has deterministic, sub-second finality: a block is final the moment it is
 * produced — there is no proposed/voted stage to wait through and no reorg to
 * hedge. So a trade on the tape is final as soon as it appears, and each event
 * records the moment its block's log arrived over the node's WebSocket
 * (`eth_subscribe` `logs` / `newHeads`).
 *
 * One connection per server process, opened on first use and kept. Events are
 * held in a small ring — this is a live tape, not history; `lib/juno/swaps.ts`
 * owns history. Nothing here is persisted and nothing here is guessed.
 */

export type CommitState = "Proposed" | "Voted" | "Finalized" | "Verified";

const STATES: CommitState[] = ["Proposed", "Voted", "Finalized", "Verified"];

export type LiveEvent = {
  /** `${txHash}:${logIndex}`. */
  id: string;
  kind: "trade" | "launch" | "graduation" | "complete";
  token: string;
  txHash: string;
  blockNumber: number;
  /** For trades. */
  side?: "buy" | "sell";
  trader?: string;
  baseAmount?: string;
  quoteAmount?: string;
  /** The block's furthest stage so far. */
  state: CommitState;
  /** Unix ms each stage arrived, relative stages derive from these. */
  stages: Partial<Record<CommitState, number>>;
};

const MAX_EVENTS = 60;

type LiveState = {
  socket: WebSocket | null;
  connecting: boolean;
  events: LiveEvent[];
  /** blockId → stage timestamps, so a log that arrives late inherits them. */
  blocks: Map<string, Partial<Record<CommitState, number>>>;
  lastMessageAt: number;
  error: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __junoLive: LiveState | undefined;
}

function state(): LiveState {
  globalThis.__junoLive ??= {
    socket: null,
    connecting: false,
    events: [],
    blocks: new Map(),
    lastMessageAt: 0,
    error: null,
  };
  return globalThis.__junoLive;
}

/**
 * The WebSocket to follow: `ARC_WS_URL`, else the RPC's own endpoint with a
 * ws scheme (Arc's public RPC and a local fork both answer `eth_subscribe`
 * there).
 */
export function wsEndpoint(): string {
  const configured = process.env.ARC_WS_URL?.trim();
  if (configured) return configured;
  return rpcEndpoint().replace(/^http/, "ws");
}

/**
 * Whether blocks here are committed in stages. Never on Arc: a block is final
 * when produced, so every head and log is recorded as Finalized when it arrives.
 * (The staged path stays for a node that reports `commitState`.)
 */
export function stagedCommits(): boolean {
  return false;
}

/**
 * Fold one subscription message in.
 *
 * Staged, the node tags every head and log with its `commitState` and a
 * `blockId`. Unstaged — a local node's plain `newHeads` / `logs` — neither
 * field exists: a mined block is final, so its head and its logs are recorded
 * as Finalized, keyed by the block hash, at the moment they arrive.
 */
export function applyMessage(live: LiveState, result: Record<string, unknown>, at: number, staged: boolean): void {
  if (staged) {
    if (typeof result.commitState !== "string") return;
    const commit = result.commitState as CommitState;
    if (typeof result.transactionHash === "string") {
      applyLog(live, result as Parameters<typeof applyLog>[1], at);
    } else if (typeof result.blockId === "string") {
      applyHead(live, result.blockId, commit, at);
    }
    return;
  }
  if (typeof result.transactionHash === "string" && typeof result.blockHash === "string") {
    if (result.removed === true) return;
    applyLog(
      live,
      { ...(result as Parameters<typeof applyLog>[1]), blockId: result.blockHash, commitState: "Finalized" },
      at,
    );
  } else if (typeof result.hash === "string" && typeof result.number === "string") {
    applyHead(live, result.hash, "Finalized", at);
  }
}

function later(a: CommitState, b: CommitState): CommitState {
  return STATES.indexOf(a) >= STATES.indexOf(b) ? a : b;
}

/** Fold one head into the block table and every event in it. */
export function applyHead(live: LiveState, blockId: string, commit: CommitState, at: number): void {
  const stages = live.blocks.get(blockId) ?? {};
  stages[commit] ??= at;
  live.blocks.set(blockId, stages);
  if (live.blocks.size > 400) {
    const oldest = live.blocks.keys().next().value;
    if (oldest) live.blocks.delete(oldest);
  }
  for (const event of live.events) {
    if ((event as LiveEvent & { blockId?: string }).blockId !== blockId) continue;
    event.stages[commit] ??= at;
    event.state = later(event.state, commit);
  }
}

/** Fold one log notification in. Returns the event it touched, if any. */
export function applyLog(
  live: LiveState,
  log: {
    address: string;
    topics: Hex[];
    data: Hex;
    transactionHash: string;
    logIndex: string;
    blockNumber: string;
    blockId: string;
    commitState: CommitState;
  },
  at: number,
): LiveEvent | null {
  let decoded: DecodeEventLogReturnType<typeof junoLaunchpadAbi>;
  try {
    decoded = decodeEventLog({ abi: junoLaunchpadAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    // After graduation a coin trades on its v2 pair through Juno's router.
    return applyRouterSwap(live, log, at);
  }
  const kind =
    decoded.eventName === "Trade"
      ? "trade"
      : decoded.eventName === "Launched"
        ? "launch"
        : decoded.eventName === "Graduated"
          ? "graduation"
          : decoded.eventName === "CurveCompleted"
            ? "complete"
            : null;
  if (!kind) return null;

  const id = `${log.transactionHash}:${Number(log.logIndex)}`;
  let event = live.events.find((existing) => existing.id === id) as (LiveEvent & { blockId?: string }) | undefined;
  if (!event) {
    const args = decoded.args as Record<string, unknown>;
    event = {
      id,
      kind,
      token: getAddress(String(args.token)),
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      state: log.commitState,
      // A log can first arrive at a later stage than Proposed; the block
      // table may already know when the earlier ones happened.
      stages: { ...(live.blocks.get(log.blockId) ?? {}) },
      blockId: log.blockId,
      ...(kind === "trade"
        ? {
            side: args.isBuy ? "buy" : "sell",
            trader: getAddress(String(args.trader)),
            baseAmount: String(args.baseAmount),
            quoteAmount: String(args.quoteAmount),
          }
        : {}),
    } as LiveEvent & { blockId: string };
    live.events.unshift(event);
    if (live.events.length > MAX_EVENTS) live.events.length = MAX_EVENTS;
  }
  event.stages[log.commitState] ??= at;
  event.state = later(event.state, log.commitState);
  return event;
}

/**
 * A graduated coin's trade, from the router's `Swapped`. The quote side is the
 * known quote token, USDC — so USDC in is a buy of the other token, and out
 * is a sell. As in `routerSwapsIn`, the trader is whose
 * position changed: the buyer's recipient, or the seller.
 */
function applyRouterSwap(live: LiveState, log: Parameters<typeof applyLog>[1], at: number): LiveEvent | null {
  let decoded: DecodeEventLogReturnType<typeof junoSwapRouterAbi, "Swapped">;
  try {
    decoded = decodeEventLog({ abi: junoSwapRouterAbi, eventName: "Swapped", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    return null;
  }
  const { trader, tokenIn, tokenOut, amountIn, amountOut, to } = decoded.args;
  const buy = quoteTokenFor(tokenIn) !== null;
  if (!buy && quoteTokenFor(tokenOut) === null) return null;
  const id = `${log.transactionHash}:${Number(log.logIndex)}`;
  let event = live.events.find((existing) => existing.id === id) as (LiveEvent & { blockId?: string }) | undefined;
  if (!event) {
    event = {
      id,
      kind: "trade",
      token: getAddress(buy ? tokenOut : tokenIn),
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      state: log.commitState,
      stages: { ...(live.blocks.get(log.blockId) ?? {}) },
      blockId: log.blockId,
      side: buy ? "buy" : "sell",
      trader: getAddress(buy ? to : trader),
      baseAmount: String(buy ? amountOut : amountIn),
      quoteAmount: String(buy ? amountIn : amountOut),
    } as LiveEvent & { blockId: string };
    live.events.unshift(event);
    if (live.events.length > MAX_EVENTS) live.events.length = MAX_EVENTS;
  }
  event.stages[log.commitState] ??= at;
  event.state = later(event.state, log.commitState);
  return event;
}

/**
 * Open the subscription if it is not open. Safe to call on every request:
 * it returns at once, and a dropped socket is reopened on the next call.
 */
export function ensureLive(): void {
  const live = state();
  const launchpad = launchpadAddress();
  if (!launchpad || live.socket || live.connecting) return;
  if (typeof WebSocket === "undefined") {
    live.error = "This server runtime has no WebSocket client.";
    return;
  }
  live.connecting = true;
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsEndpoint());
  } catch (error) {
    live.connecting = false;
    live.error = error instanceof Error ? error.message : String(error);
    return;
  }
  socket.onopen = () => {
    live.connecting = false;
    live.socket = socket;
    live.error = null;
    const staged = stagedCommits();
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }),
    );
    // The launchpad's events, and the router's: a graduated coin trades there.
    // Two subscriptions rather than an address list, which not every node's
    // log filter takes.
    const router = swapRouterAddress();
    [launchpad, ...(router ? [router] : [])].forEach((address, index) => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2 + index,
          method: "eth_subscribe",
          params: ["logs", { address }],
        }),
      );
    });
  };
  socket.onmessage = (message) => {
    const at = Date.now();
    live.lastMessageAt = at;
    let body: { id?: number; error?: { message?: string }; params?: { result?: Record<string, unknown> } };
    try {
      body = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (body.error) {
      live.error = body.error.message ?? "The node refused the subscription.";
      return;
    }
    const result = body.params?.result;
    if (!result) return;
    applyMessage(live, result, at, stagedCommits());
  };
  const drop = (reason: string) => {
    live.socket = null;
    live.connecting = false;
    live.error = reason;
  };
  const node = localFork() ? "The local node's WebSocket" : "The Arc WebSocket";
  socket.onerror = () => drop(`${node} connection failed.`);
  socket.onclose = () => drop(`${node} connection closed; it reopens on the next request.`);
}

export type LiveSnapshot = {
  connected: boolean;
  endpoint: string;
  /** Null until the first message; lets the app tell "quiet" from "not listening". */
  lastMessageAt: number | null;
  error: string | null;
  /**
   * False on a single-node chain (a local fork): every event is final when
   * its block is mined, and there are no stages between.
   */
  staged: boolean;
  events: Array<Omit<LiveEvent, "stages"> & { stages: Partial<Record<CommitState, number>> }>;
};

export function liveSnapshot(filter?: { token?: string; txHash?: string }): LiveSnapshot {
  ensureLive();
  const live = state();
  const token = filter?.token ? getAddress(filter.token) : null;
  const events = live.events
    .filter((event) => (!token || event.token === token) && (!filter?.txHash || event.txHash === filter.txHash))
    .map(({ ...event }) => {
      delete (event as { blockId?: string }).blockId;
      return event;
    });
  return {
    connected: live.socket !== null,
    endpoint: wsEndpoint().replace(/\/\/([^/]*@)/, "//"),
    lastMessageAt: live.lastMessageAt || null,
    error: live.error,
    staged: stagedCommits(),
    events,
  };
}

/** For tests: a fresh, unconnected state. */
export function emptyLiveState(): LiveState {
  return { socket: null, connecting: false, events: [], blocks: new Map(), lastMessageAt: 0, error: null };
}
