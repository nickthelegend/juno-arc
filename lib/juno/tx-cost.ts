/**
 * What a transaction cost on Arc, and what the same work would cost on
 * Ethereum mainnet right now.
 *
 * The Arc side is read from the transaction and its receipt. Arc's gas token is
 * USDC — the native balance, in 18 decimals — and it bills the gas used, so the
 * fee is `gasUsed × effectiveGasPrice` wei of USDC: dollars, with no price
 * feed in between.
 *
 * The Ethereum side is the same gas used at Ethereum mainnet's current gas
 * price, read live from an Ethereum RPC, priced in dollars with Chainlink's
 * ETH/USD on Arc mainnet. Any read that fails leaves its figure out: no
 * comparison is better than an invented one.
 */

const WEI_PER_GWEI = 1e9;
const WEI_PER_ETHER = 1e18;
/** Ethereum's slot time since the Merge: a block every 12 seconds. */
export const ETHEREUM_BLOCK_SECONDS = 12;

export type ArcFee = {
  gasUsed: number;
  gasLimit: number;
  /** Arc charges the gas used. */
  billed: "used";
  gasCharged: number;
  /** In gwei of native USDC (1e-9 USDC). */
  gasPriceGwei: number;
  /** The fee in USDC. */
  feeUsdc: number;
  /** The same, in dollars: USDC is the unit. */
  feeUsd: number;
};

export function arcFee(input: { gasUsed: bigint; gasLimit: bigint; effectiveGasPrice: bigint }): ArcFee {
  const feeUsdc = Number(input.gasUsed * input.effectiveGasPrice) / WEI_PER_ETHER;
  return {
    gasUsed: Number(input.gasUsed),
    gasLimit: Number(input.gasLimit),
    billed: "used",
    gasCharged: Number(input.gasUsed),
    gasPriceGwei: Number(input.effectiveGasPrice) / WEI_PER_GWEI,
    feeUsdc,
    feeUsd: feeUsdc,
  };
}

export type EthereumFee = {
  gasPriceGwei: number;
  feeEth: number;
  /** Null when no ETH/USD price was readable. */
  feeUsd: number | null;
  ethUsd: number | null;
  blockSeconds: number;
};

export function ethereumFee(input: { gasUsed: bigint; gasPriceWei: bigint; ethUsd: number | null }): EthereumFee {
  const feeEth = Number(input.gasUsed * input.gasPriceWei) / WEI_PER_ETHER;
  return {
    gasPriceGwei: Number(input.gasPriceWei) / WEI_PER_GWEI,
    feeEth,
    feeUsd: input.ethUsd === null ? null : feeEth * input.ethUsd,
    ethUsd: input.ethUsd,
    blockSeconds: ETHEREUM_BLOCK_SECONDS,
  };
}

/** Public Ethereum mainnet endpoints, tried in order; `ETH_RPC_URL` goes first when set. */
const PUBLIC_ETHEREUM_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"];
const GAS_PRICE_TTL_MS = 60_000;
let cachedGasPrice: { wei: bigint; at: number; source: string } | null = null;

/**
 * Ethereum mainnet's gas price now (`eth_gasPrice`), cached for a minute.
 * Null when no endpoint answered in time.
 */
export async function ethereumGasPrice(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ wei: bigint; source: string } | null> {
  if (cachedGasPrice && now - cachedGasPrice.at < GAS_PRICE_TTL_MS) return cachedGasPrice;
  const configured = process.env.ETH_RPC_URL?.trim();
  for (const url of configured ? [configured, ...PUBLIC_ETHEREUM_RPCS] : PUBLIC_ETHEREUM_RPCS) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { result?: string };
      if (typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) continue;
      const wei = BigInt(body.result);
      if (wei <= 0n) continue;
      cachedGasPrice = { wei, at: now, source: new URL(url).host };
      return cachedGasPrice;
    } catch {
      // The next endpoint.
    }
  }
  return null;
}

/** For tests: forget the cached gas price. */
export function resetEthereumGasPrice() {
  cachedGasPrice = null;
}
