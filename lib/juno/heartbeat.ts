import "server-only";

import { publicClient } from "./client";
import { ARC_FINALITY, localFork, networkKey } from "./network";
import { ttlCache, withRetry } from "./rpc";

/**
 * Arc's heartbeat: how fast blocks are arriving, measured, not quoted.
 *
 * Arc commits blocks with deterministic finality — a block is final when it is
 * produced, so a receipt is final and there is no confirmation count. The
 * cadence is read from the chain itself: the head and the block `WINDOW`
 * blocks earlier, their timestamps' difference over the count. Block
 * timestamps are whole seconds, so over a short window the figure is coarse;
 * fifty blocks keeps the error within a few percent.
 */

const WINDOW = 50n;

export type Heartbeat = {
  network: string;
  latestBlock: number;
  /** Mean block interval over the window, in milliseconds. Null when the window could not be read. */
  blockMs: number | null;
  window: number;
  finality: string;
  /** Measured on a local fork: the fork's cadence, not Arc's. */
  localFork: boolean;
  at: string;
};

/** The interval from two block timestamps (seconds) `count` blocks apart. Pure. */
export function meanBlockMs(newer: bigint, older: bigint, count: bigint): number | null {
  if (count <= 0n || newer < older) return null;
  return Math.round((Number(newer - older) * 1000) / Number(count));
}

const cache = ttlCache<Heartbeat>(5_000);

export function arcHeartbeat(): Promise<Heartbeat> {
  return cache.get("hb", async () => {
    const client = publicClient();
    const head = await withRetry(() => client.getBlock({ blockTag: "latest" }));
    const from = head.number > WINDOW ? head.number - WINDOW : 0n;
    const older = await withRetry(() => client.getBlock({ blockNumber: from })).catch(() => null);
    return {
      network: networkKey(),
      latestBlock: Number(head.number),
      blockMs: older ? meanBlockMs(head.timestamp, older.timestamp, head.number - from) : null,
      window: Number(head.number - from),
      finality: ARC_FINALITY,
      localFork: localFork(),
      at: new Date().toISOString(),
    };
  });
}
