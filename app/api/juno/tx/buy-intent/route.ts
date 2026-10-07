import { buildBuyIntent } from "@/lib/juno/gasless";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireNumber, requireString, retryWhenBusy } from "@/lib/juno/api";
import { getPool } from "@/lib/juno/registry";
import { launchpadMissing, requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * A gasless buy, step one: what the buyer signs.
 *
 * `POST { token, owner, amountIn (USDC), slippageBps? }` →
 * `{ typedData, intent, quote, relayer }`. `typedData` is an EIP-712
 * `ReceiveWithAuthorization` on Circle USDC that lets only the launchpad pull
 * exactly this buy's USDC, with a nonce bound to the whole trade. The wallet
 * signs it (no transaction, no gas) and posts it to `tx/buy-relayed`.
 * 409 when the wallet lacks the USDC.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const missing = launchpadMissing();
    if (missing) return missing;
    const body = await readJson<Record<string, unknown>>(request);
    const token = requireAddress(requireString(body.token, "token"), "token");
    const owner = requireAddress(requireString(body.owner, "owner"), "owner");
    const amountIn = requireNumber(body.amountIn, "amountIn");
    let slippageBps: number | undefined;
    if (body.slippageBps !== undefined && body.slippageBps !== null) {
      slippageBps = requireNumber(body.slippageBps, "slippageBps");
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
        throw new CallerError('"slippageBps" must be a whole number from 0 to 5000');
      }
    }
    if (!(await getPool(token))) throw new CallerError("Coin not found", 404);
    return junoJson(await retryWhenBusy(() => buildBuyIntent({ token, owner, amountIn, slippageBps })));
  });
}
