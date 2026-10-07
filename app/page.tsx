import { chainId, deploymentFile, explorer, launchpadAddress, networkKey } from "@/lib/juno/network";

// Read per request: the deployment record is runtime configuration, not build input.
export const dynamic = "force-dynamic";

/**
 * What someone sees when they open the API's own domain.
 *
 * In production `proxy.ts` sends every page to the app, so this only renders
 * without `JUNO_APP_URL` — local development, or a judge poking at the API
 * directly. It says what this is, which network it is pointed at, and where
 * the contract lives, because those are the first three questions.
 */
export default function Home() {
  const launchpad = launchpadAddress();
  return (
    <main>
      <h1>Juno API</h1>
      <p>Every post is a market. This server builds transactions for the Juno app and reads Arc for it — USDC is the quote and the gas, and a receipt is final.</p>
      <dl>
        <dt>Network</dt>
        <dd>
          {networkKey()} (chain {chainId()})
        </dd>
        <dt>Launchpad</dt>
        <dd>
          {launchpad ? <a href={explorer.address(launchpad)}>{launchpad}</a> : `not configured — no launchpad in ${deploymentFile()}`}
        </dd>
        <dt>Endpoints</dt>
        <dd>
          <a href="/api/juno/config">/api/juno/config</a>, <a href="/api/juno/coins">/api/juno/coins</a> — see docs/API.md
        </dd>
      </dl>
    </main>
  );
}
