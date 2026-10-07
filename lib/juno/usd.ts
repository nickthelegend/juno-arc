import { getAddress, isAddress } from "viem";

import { usdcAddress } from "./network";

/**
 * The dollar value of one unit of a pool's quote token.
 *
 * On Arc every Juno pool is quoted in Circle USDC, and Juno states prices,
 * market caps and volumes in USD with USDC as the unit (1 USDC = $1). That is a
 * convention, stated as one: the live USDC/USD peg is read separately from
 * Chainlink's feed on Arc mainnet (`/api/juno/peg`) and shown beside it, never
 * silently folded into every figure. Anything that isn't USDC has no rate here,
 * and null stays null — the figure is then labelled in its own token.
 */
export async function quoteTokenUsdPrice(quote: string): Promise<number | null> {
  if (!isAddress(quote)) return null;
  return getAddress(quote) === usdcAddress() ? 1 : null;
}
