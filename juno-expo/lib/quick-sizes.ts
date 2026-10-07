/**
 * The quick sizes on a buy: the pills under the amount.
 *
 * Dollars, because every Juno curve is priced in USDC and USDC is dollars:
 * $1, $5, $10, $25. Never a size the wallet cannot pay for: when the fixed
 * sizes do not all fit the spendable balance, the pills become 25 / 50 / 75%
 * of it. The fourth pill is Max. A pill whose amount is null is shown disabled.
 */
export type QuickSize = { label: string; amount: number | null; share: number | null };

export const QUICK_USD = [1, 5, 10, 25];
export const QUICK_SHARE = [0.25, 0.5, 0.75];

export function quickBuySizes(input: {
  /** Spendable USDC after the gas held back; null when unknown (no wallet yet, or a failed read). */
  spendable: number | null;
}): QuickSize[] {
  const { spendable } = input;
  const max: QuickSize = { label: "Max", amount: spendable !== null && spendable > 0 ? spendable : null, share: null };
  const sizes: QuickSize[] = QUICK_USD.slice(0, 3).map((dollars) => ({ label: `$${dollars}`, amount: dollars, share: null }));
  if (spendable !== null && spendable >= QUICK_USD[3]) {
    return QUICK_USD.map((dollars) => ({ label: `$${dollars}`, amount: dollars, share: null }));
  }
  if (spendable !== null && sizes.some((size) => (size.amount ?? 0) > spendable)) {
    return [
      ...QUICK_SHARE.map((share) => {
        const amount = spendable > 0 ? spendable * share : null;
        return { label: amount === null ? `${share * 100}%` : `$${Number(amount.toPrecision(2))}`, amount, share: null };
      }),
      max,
    ];
  }
  return [...sizes, max];
}
