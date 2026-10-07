import { junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { gatewayMint } from "@/lib/juno/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST /gateway/mint { burnIntent, signature }` →
 * `{ status, mintTxHash, explorerUrl, amount, recipient, confirmMs }`: Circle's
 * Gateway API attests the signed intent and Juno's relayer calls
 * `GatewayMinter.gatewayMint` on Arc, paying the USDC gas. The USDC is minted
 * to the recipient the depositor signed for, and nobody else.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<{ burnIntent?: unknown; signature?: unknown }>(request);
    return junoJson(await gatewayMint({ burnIntent: body.burnIntent, signature: body.signature }));
  });
}
