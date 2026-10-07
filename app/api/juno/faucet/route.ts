import { CallerError, junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { publicClient } from "@/lib/juno/client";
import { uiToWei, weiToUi } from "@/lib/juno/launchpad";
import { explorer, network } from "@/lib/juno/network";
import { relay, relayerAccount } from "@/lib/juno/relayer";
import { explainFailure } from "@/lib/juno/tx";
import { check, clientIp } from "@/lib/rate-limit";
import { requireAddress } from "../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** Circle's public testnet faucet, for when Juno's is empty. */
const EXTERNAL_FAUCET = "https://faucet.circle.com";

/** USDC sent per request (`FAUCET_AMOUNT_USDC`, default 1): a launch and many buys, gas included. */
function amountUsdc(): number {
  const raw = Number(process.env.FAUCET_AMOUNT_USDC ?? 1);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 1;
}

const DAY_MS = 24 * 60 * 60_000;
/** Addresses served in the last day, in this process. */
const served = new Map<string, number>();

function refusal(error: string, status: number, extra: Record<string, unknown> = {}) {
  return junoJson({ error, externalFaucet: EXTERNAL_FAUCET, ...extra }, { status });
}

/**
 * Testnet USDC for a new wallet, from Juno's relayer.
 *
 * On Arc, USDC *is* the gas token: a wallet with 1 USDC can launch and trade.
 * The relayer (`JUNO_RELAYER_PRIVATE_KEY`) sends native USDC — the same money
 * the ERC-20 at 0x3600… shows, in 18 decimals — once per address per day. When
 * it is empty or unset, the answer names Circle's public faucet instead; it
 * never reports a balance that isn't there. Testnet only.
 *
 * `GET` → `{ address, balance, amount, symbol, externalFaucet }`.
 */
export async function GET() {
  return junoHandler(async () => {
    if (network() !== "testnet") return refusal("The faucet only runs on Arc testnet.", 404);
    const account = relayerAccount();
    if (!account) return refusal(`Juno's faucet is not set up on this server. Get testnet USDC at ${EXTERNAL_FAUCET}.`, 503);
    const wei = await publicClient().getBalance({ address: account.address });
    return junoJson({
      address: account.address,
      balance: weiToUi(wei, 18),
      amount: amountUsdc(),
      symbol: "USDC",
      externalFaucet: EXTERNAL_FAUCET,
    });
  });
}

/** `POST { address }` → `{ hash, amount, explorerUrl, confirmMs, externalFaucet }`. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    if (network() !== "testnet") return refusal("The faucet only runs on Arc testnet.", 404);
    const body = await readJson<{ address?: unknown; wallet?: unknown }>(request);
    const address = requireAddress(body.address ?? body.wallet, "address");

    const last = served.get(address);
    if (last !== undefined && Date.now() - last < DAY_MS) {
      const hours = Math.ceil((DAY_MS - (Date.now() - last)) / 3_600_000);
      return refusal(`This address already got testnet USDC today. Try again in about ${hours} h, or use ${EXTERNAL_FAUCET}.`, 429);
    }
    const limited = check(`faucet-ip:${clientIp(request.headers)}`, 6, 60 * 60_000);
    if (!limited.ok) {
      return junoJson(
        { error: `Too many faucet requests. Try again in ${Math.ceil(limited.retryAfter / 60)} min.`, externalFaucet: EXTERNAL_FAUCET },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } },
      );
    }

    const account = relayerAccount();
    if (!account) return refusal(`Juno's faucet is not set up on this server. Get testnet USDC at ${EXTERNAL_FAUCET}.`, 503);

    const amount = amountUsdc();
    const value = uiToWei(amount, 18);
    const client = publicClient();
    const [balance, fees] = await Promise.all([client.getBalance({ address: account.address }), client.estimateFeesPerGas()]);
    if (balance < value + 21_000n * fees.maxFeePerGas) {
      return refusal(`Juno's faucet is empty. Get testnet USDC at ${EXTERNAL_FAUCET} with your address.`, 503, {
        faucetAddress: account.address,
        faucetBalance: weiToUi(balance, 18),
      });
    }

    let sent: Awaited<ReturnType<typeof relay>>;
    try {
      sent = await relay({ to: address, data: "0x", value, gas: 21_000n });
    } catch (error) {
      if (error instanceof CallerError) throw error;
      return refusal(`The faucet could not send: ${explainFailure(error)}`, 503);
    }
    if (sent.receipt.status !== "success") {
      return refusal(`The faucet's transfer reverted. It is on-chain as ${sent.hash}.`, 503);
    }
    served.set(address, Date.now());
    return junoJson({
      hash: sent.hash,
      amount,
      symbol: "USDC",
      explorerUrl: explorer.tx(sent.hash),
      confirmMs: sent.confirmMs,
      externalFaucet: EXTERNAL_FAUCET,
    });
  });
}
