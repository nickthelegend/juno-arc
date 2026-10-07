import { isHash, type Hash } from "viem";

import { CallerError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { fetchFeed } from "@/lib/juno/chainlink";
import { publicClient } from "@/lib/juno/client";
import { localFork } from "@/lib/juno/network";
import { arcFee, ethereumFee, ethereumGasPrice } from "@/lib/juno/tx-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /tx/cost?hash=0x…` — what a confirmed transaction cost on Arc (in USDC,
 * the gas token), and what the same gas would cost on Ethereum mainnet now.
 *
 * `ethereum` is null when Ethereum's gas price could not be read, and its
 * dollar figure is null when Chainlink's ETH/USD (Arc mainnet) could not be.
 * On a local fork the Arc figures are the fork's.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const hash = new URL(request.url).searchParams.get("hash") ?? "";
    if (!isHash(hash)) throw new CallerError("hash is not a transaction hash");
    const client = publicClient();
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: hash as Hash }).catch(() => null),
      client.getTransactionReceipt({ hash: hash as Hash }).catch(() => null),
    ]);
    if (!transaction || !receipt) throw new CallerError("No confirmed transaction with that hash", 404);

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

    return junoJson({ hash, blockNumber: Number(receipt.blockNumber), localFork: localFork(), arc, ethereum });
  });
}
