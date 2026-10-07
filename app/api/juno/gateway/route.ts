import { junoHandler, junoJson, junoOptions } from "@/lib/juno/api";
import { gatewayBalances } from "@/lib/juno/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET /gateway?depositor=0x…` — a depositor's Circle Gateway unified USDC
 * balance, per source chain, from Circle's `/v1/balances`:
 * `{ available, depositor, total, totalUnits, balances: [{domain, name,
 * balance, balanceUnits}], wallet, minter, sources }`. Without `depositor`,
 * just whether Gateway is available and where.
 */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const depositor = new URL(request.url).searchParams.get("depositor");
    return junoJson(await gatewayBalances(depositor));
  });
}
