import "server-only";

import type { Hash } from "viem";

import { fetchFeed } from "./chainlink";
import { publicClient } from "./client";
import { localFork } from "./network";
import { arcFee, ethereumFee, ethereumGasPrice } from "./tx-cost";

/**
 * A confirmed transaction's cost on Arc (in USDC, the gas token), and the same
 * gas on Ethereum mainnet now (`tx-cost.ts` has the rules). Shared by
 * `GET /tx/cost` and the receipt card. Null when there is no confirmed
 * transaction with that hash.
 *
 * `ethereum` is null when Ethereum's gas price could not be read, and its
 * dollar figure is null when Chainlink's ETH/USD (Arc mainnet) could not be.
 * On a local fork the Arc figures are the fork's.
 */
export async function readTxCost(hash: Hash) {
  const client = publicClient();
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash }).catch(() => null),
    client.getTransactionReceipt({ hash }).catch(() => null),
  ]);
  if (!transaction || !receipt) return null;

  const [gasPrice, eth] = await Promise.all([ethereumGasPrice(), fetchFeed("ETH/USD").catch(() => null)]);
  const arc = arcFee({ gasUsed: receipt.gasUsed, gasLimit: transaction.gas, effectiveGasPrice: receipt.effectiveGasPrice });
  const ethereum = gasPrice
    ? {
        ...ethereumFee({ gasUsed: receipt.gasUsed, gasPriceWei: gasPrice.wei, ethUsd: eth && !eth.stale ? eth.priceUsd : null }),
        gasPriceSource: gasPrice.source,
        ethUsdSource: "Chainlink ETH/USD on Arc mainnet",
        ethUsdAgeSeconds: eth?.ageSeconds ?? null,
      }
    : null;

  return { hash, blockNumber: Number(receipt.blockNumber), localFork: localFork(), arc, ethereum };
}
