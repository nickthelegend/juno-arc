# Arc mainnet on Vercel

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted-mainnet.mjs
```

Live: https://juno-arc.vercel.app (Arc mainnet, chain 5042).
Production reads `deployments/arc-mainnet.json` with RPC `https://rpc.mainnet.arc.io` and explorer `https://explorer.arc.io`.
Network configuration, contract bytecode, routes, rendered wording and explorer links are checked by the script. Detailed outcomes are in `docs/screens/mainnet/*/results.json`; failures remain failures.

The API uses an isolated mainnet database; storage readiness remains separately reported. The faucet is disabled on mainnet.

Service credentials were supplied to Vercel via stdin from the ignored `.deployer/mainnet/` files. Read-only broker/executor/studio frontends do not receive signing keys. Mainnet databases have separate names from historical data. No new database, Railway or paid resource was provisioned.

The previous production artifacts were retained at `https://juno-arc-testnet.vercel.app` (Vercel aliases, no extra build). These are frozen historical builds, not a freshly verified preview environment; shared backend URLs may now resolve to mainnet. Do not use them for transaction rehearsals without checking the displayed chain.

This migration performs reads only: no wallet connection, signature, deposit, payment, withdrawal or chain broadcast. Mainnet contract/deployment transaction evidence is recorded separately in the repository. Local executors remain an on-demand demo requirement, not an always-on hosting service provisioned here.

Current backend check: `/api/juno/config` reports mainnet, but `/api/juno/coins` returns 500 while durable storage is unavailable.

Production environment: API: NEXT_PUBLIC_ARC_NETWORK=mainnet; ARC_RPC_URL=NEXT_PUBLIC_ARC_RPC_URL=https://rpc.mainnet.arc.io; JUNO_DEPLOYMENT_FILE=deployments/arc-mainnet.json; MONGODB_DB=arc_juno_mainnet; JUNO_RELAYER_PRIVATE_KEY from mainnet roles. Expo: EXPO_PUBLIC_API_URL=https://juno-arc-api.vercel.app.

Verified: 9 routes returned HTTP 200 with no rendered testnet wording, wrong Arc explorer link or uncaught page exception. Network APIs and RPC reported chain 5042; expected mainnet contract bytecode was present. Screenshots and machine-readable results are saved beside this report.
