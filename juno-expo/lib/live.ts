import { useEffect, useRef, useState } from "react";

import { api } from "./api";

/**
 * Juno's events as they land on Arc, from `GET /api/juno/live`.
 *
 * Arc finalises deterministically in under a second: a block with a receipt is
 * final, with no stages between and no reorgs. The server follows the
 * launchpad's logs; this polls it. A poll works the same on iOS, Android and
 * the web.
 */

export type LiveEvent = {
  id: string;
  kind: "trade" | "launch" | "graduation" | "complete";
  token: string;
  txHash: string;
  blockNumber: number;
  side?: "buy" | "sell";
  trader?: string;
  /** Raw token units, 18 decimals. */
  baseAmount?: string;
  /** Raw quote units, in the pool's quote decimals. */
  quoteAmount?: string;
  /** Unix ms the server saw it land, when it says. */
  at?: number;
  /** The coin's symbol when this app lists it; null for an unlisted coin. */
  symbol?: string | null;
};

export type LiveSnapshot = {
  connected: boolean;
  endpoint: string;
  lastMessageAt: number | null;
  error: string | null;
  events: LiveEvent[];
};

export function fetchLive(filter: { token?: string; tx?: string } = {}): Promise<LiveSnapshot> {
  const query = new URLSearchParams();
  if (filter.token) query.set("token", filter.token);
  if (filter.tx) query.set("tx", filter.tx);
  const suffix = query.toString();
  return api.get<LiveSnapshot>(`/api/juno/live${suffix ? `?${suffix}` : ""}`, 8_000);
}

/**
 * Poll the live tape while mounted. `until` stops the polling once it returns
 * true.
 */
export function useLive(
  filter: { token?: string; tx?: string } = {},
  options: {
    intervalMs?: number;
    until?: (snapshot: LiveSnapshot) => boolean;
    enabled?: boolean;
    /** Stop polling after this long, whether or not `until` was met. */
    forMs?: number;
  } = {},
): LiveSnapshot | null {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const until = useRef(options.until);
  until.current = options.until;
  const enabled = options.enabled ?? true;
  const interval = options.intervalMs ?? 1_000;
  const forMs = options.forMs ?? Infinity;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is two strings; re-subscribe only when they change
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopAt = Date.now() + forMs;
    const tick = async () => {
      const next = await fetchLive(filter).catch(() => null);
      if (!alive) return;
      if (next) setSnapshot(next);
      if (next && until.current?.(next)) return;
      if (Date.now() >= stopAt) return;
      timer = setTimeout(tick, interval);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [filter.token, filter.tx, interval, enabled, forMs]);

  return snapshot;
}
