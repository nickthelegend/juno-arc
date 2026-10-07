import { junoHandler, junoJson, junoOptions, readJson, requireNumber, requireString, retryWhenBusy } from "@/lib/juno/api";
import { buildGatewayDeposit } from "@/lib/juno/gateway";
import { requireAddress } from "../../_lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /gateway/deposit { owner, amount }` → `{ steps }`: USDC from the
 * wallet on Arc into its Circle Gateway unified balance — an approval of the
 * GatewayWallet when needed, then `GatewayWallet.deposit(USDC, amount)`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const owner = requireAddress(requireString(body.owner, "owner"), "owner");
    const amount = requireNumber(body.amount, "amount");
    return junoJson({ steps: await retryWhenBusy(() => buildGatewayDeposit({ owner, amount })) });
  });
}
