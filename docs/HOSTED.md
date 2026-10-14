# Hosted Arc testnet

Railway project: `juno-arc-testnet` (`eb5ca4d9-9e82-49af-b865-b4180b98d6ee`).

| Service | URL / storage | Purpose |
|---|---|---|
| app | https://app-production-1427a.up.railway.app | Expo web export served by nginx with SPA routing |
| api | https://api-production-6371.up.railway.app | Next API and testnet relayer; media volume `/data` |
| Postgres | private Railway database | Pools, posts and trades; Drizzle migrations on API startup |
| MongoDB | private Railway database | Comments, likes and names |

The API reads `deployments/arc-testnet.json` on chain 5042002. The Expo build uses
`EXPO_PUBLIC_API_URL`; public API CORS allows the app. The testnet faucet is capped
at 0.10 USDC per request, with the existing per-address/day restriction.
The relayer key comes from the gitignored env file and is only a Railway runtime variable.
No env files, keys, dependencies, local database state or build output are uploaded.

No Pinata credential was available: media persists on the API volume and is labelled
local storage, not pinned IPFS. No indexer is hosted; receipts and RPC supply chain data.
Graduation and cross-chain sends retain their existing Fork / Not run labels.
Screenshots, HTTP responses and bounded launch evidence live in `docs/screens/hosted/`.
Redeploy from the repository root with `railway up --service api|app --detach`;
`RAILWAY_DOCKERFILE_PATH` selects `Dockerfile` or `docker/app.Dockerfile`.

Verified 2026-10-14: app, API, Postgres and MongoDB reached SUCCESS. Migrations applied.
All nine public navigation routes plus the created coin page returned 200; config,
pools, stats, feed and heartbeat returned 200. Browser Playwright checks captured no errors.
Media upload persisted to the volume. A real launch with a 0.01 USDC first buy had an
estimated maximum including gas of 0.099413467 USDC:
`0xcca72929df1c01b0d7fe465db4cc734af77796a95e481f57d093bc6c033f4098`.
Coin: `0xC003A6aE83e76922D6470a9f2822750980407Cab` (HOSTARC), visible in the public feed.
