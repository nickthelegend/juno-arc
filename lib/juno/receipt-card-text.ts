/**
 * The receipt card's sentences and number formats: what it says about a trade
 * and its cost. Pure, so they can be tested without a server.
 */
export type ReceiptCardTrade = {
  side: "buy" | "sell";
  baseAmount: number;
  quoteAmount: number;
  quoteSymbol: string;
  venue: "curve" | "uniswap-v2";
  symbol: string;
  name: string;
};

export function compactAmount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return value.toPrecision(2);
}

/** Two significant figures past the zeros: 0.0063, 0.000052. */
export function smallAmount(value: number): string {
  if (value === 0) return "0";
  if (value >= 1) return value.toFixed(3);
  const decimals = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(value))));
  return value.toFixed(decimals);
}

export function usd(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value === 0) return "$0";
  return `$${smallAmount(value)}`;
}

/** The sentence for the trade: "Bought 1.23M $COIN for 0.10 USDC". */
export function tradeLine(trade: ReceiptCardTrade): string {
  const base = `${compactAmount(trade.baseAmount)} $${trade.symbol}`;
  const quote = `${smallAmount(trade.quoteAmount)} ${trade.quoteSymbol}`;
  return trade.side === "buy" ? `Bought ${base} for ${quote}` : `Sold ${base} for ${quote}`;
}

export const VENUE_LABEL: Record<ReceiptCardTrade["venue"], string> = {
  curve: "on its bonding curve",
  "uniswap-v2": "on its Uniswap v2 pair",
};
