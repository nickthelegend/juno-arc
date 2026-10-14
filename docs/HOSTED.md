# Hosting handoff — 2026-10-14

The earlier Railway deployment was removed by the user. Its old URLs and screenshots are historical, not live evidence.
No hosting resources were created in the round-2 product pass. Current browser evidence is in
[round2](screens/testnet/round2/), using the local app/API against live Arc testnet.

Deploy the Next API and Expo web export to Vercel, using existing managed databases in isolated Arc DBs/schemas.
Set `NEXT_PUBLIC_ARC_NETWORK=testnet`, the testnet RPC, `DATABASE_URL`, `MONGODB_URI`, `MONGODB_DB`, a dedicated funded
`JUNO_RELAYER_PRIVATE_KEY`, and a bounded `FAUCET_AMOUNT_USDC`. Never use the deployer key as the relayer.
Set `JUNO_API_URL` to the API's public origin before launching, and build Expo with `EXPO_PUBLIC_API_URL` pointing there.

Without Pinata, Vercel automatically stores demo media in Mongo's `demo_media` collection. It is labelled app-hosted,
not pinned to IPFS. Uploads are limited to 4MB. `JUNO_MEDIA_BACKEND=mongo` rehearses this locally; process-restart
persistence and byte-range video reads passed. The public deployment itself has not been verified in this pass.

After deployment and database migration:

```sh
JUNO_API_URL=https://<api-origin> node scripts/seed-testnet-feed.mjs
JUNO_API_URL=https://<api-origin> JUNO_WEB_URL=https://<app-origin> node scripts/e2e-browser-juno.mjs
```

The seed restore verifies existing live-testnet creation receipts; it sends no transactions. It makes the media/feed
available on the new server. Existing locally launched tokens retain their immutable local tokenURI origins; new hosted
launches use the public origin. The test-pattern reel is deliberately labelled demonstration footage.

No daemon/indexer is required for the tested request/response flows. Reference-feed reads in this pass came through a
local Arc mainnet fork, while all transactions used testnet. Mainnet deployments and live graduation/CCIP delivery remain untested.
Production needs shared relayer nonce/faucet-rate controls and stronger social attribution; process-local limits are for testnet demos.
