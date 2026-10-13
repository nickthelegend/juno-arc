import { describe, expect, it } from "vitest";

import { quickBuySizes } from "../../juno-expo/lib/quick-sizes";

/**
 * The buy sheet's quick sizes, in dollars: on Arc the quote is USDC, so a
 * size is a dollar amount with no conversion. The newcomer's first trade is
 * the case that matters — the testnet faucet gives a dollar or so, and a "$5"
 * pill that can only say "Not enough USDC" is no use to them.
 */
describe("quickBuySizes", () => {
  it("offers all four dollar sizes when the wallet covers the largest", () => {
    expect(quickBuySizes({ spendable: 500 }).map((s) => s.label)).toEqual(["$1", "$5", "$10", "$25"]);
  });

  it("offers three dollar sizes and Max when they all fit", () => {
    const sizes = quickBuySizes({ spendable: 12 });
    expect(sizes.map((s) => s.label)).toEqual(["$1", "$5", "$10", "Max"]);
    expect(sizes[3].amount).toBe(12);
  });

  it("switches to shares of what is spendable when a dollar size would not fit", () => {
    const sizes = quickBuySizes({ spendable: 0.4 });
    expect(sizes.map((s) => s.label)).toEqual(["$0.1", "$0.2", "$0.3", "Max"]);
    expect(sizes.every((s) => s.amount !== null && s.amount <= 0.4)).toBe(true);
  });

  it("disables everything when nothing is spendable, rather than offering a size", () => {
    const sizes = quickBuySizes({ spendable: -0.1 });
    expect(sizes.map((s) => s.label)).toEqual(["$1", "$5", "$10", "Max"]);
    expect(sizes.every((s) => s.amount === null)).toBe(true);
  });

  it("keeps the fixed sizes before a balance is known (no wallet yet)", () => {
    expect(quickBuySizes({ spendable: null }).map((s) => s.label)).toEqual(["$1", "$5", "$10", "Max"]);
  });
});
