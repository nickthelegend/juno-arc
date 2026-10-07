import type { EvmOnEventContext } from "envio";

import { ZERO_ADDRESS } from "./math";

/**
 * The quote side of every Juno pool on Arc.
 *
 * The launchpad only accepts Circle's USDC as a quote (its constructor allows it
 * and nothing else is ever allowed by Juno's deploy), and USDC on Arc is the
 * ERC-20 at 0x3600…0000 with **6 decimals**. (Arc's native balance is the same
 * money with 18 decimals, but the launchpad never touches it: there is no
 * native-quote path, no wrapped native, no `address(0)` quote.)
 *
 * The address is the same on Arc testnet (5042002) and mainnet (5042).
 */
export const USDC = "0x3600000000000000000000000000000000000000";

/** USDC's ERC-20 decimals — the unit of every quote amount the launchpad emits. */
export const USDC_DECIMALS = 6;

/**
 * Decimals of a pool's quote. Always USDC's 6; a quote other than USDC is not
 * something the deployed launchpad can produce, so it is logged and still read
 * as 6 rather than guessed at.
 */
export function quoteDecimals(context: Pick<EvmOnEventContext, "log">, quote: string): number {
  if (quote.toLowerCase() !== USDC) {
    context.log.warn(`Unexpected quote ${quote}: Juno on Arc only quotes in USDC; reading it as ${USDC_DECIMALS} decimals`);
  }
  return USDC_DECIMALS;
}

/**
 * Whether the address a launch locked is a Uniswap v2 pair: anything but the
 * zero address (which means no graduator was set at launch).
 */
export function isV2Lock(venue: string): boolean {
  return venue.toLowerCase() !== ZERO_ADDRESS;
}

/** The other side of a coin's TOKEN/USDC v2 pair: the pool's quote itself. */
export function pairQuoteAddress(quote: string): string {
  return quote.toLowerCase();
}
