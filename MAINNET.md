# Juno on Arc mainnet — runbook

Mainnet holds real money. Nothing in this repository has been broadcast to Arc
mainnet; this is the exact procedure for the lead once the deployer is funded.

## 1. Before you start

- Deployer: `0x0648aDF1967692A0c991d7715b0b588452321FBd`, key in
  `../.deployer/deployer.env` (`DEPLOYER_PRIVATE_KEY`), never copied into this repo.
- Circle's Arc Foundry (`forge`, `cast` with `--network arc`): `export FORGE=… CAST=…`.
- `git submodule update --init --recursive && (cd contracts && npm ci)`.
- Green suites first:
  ```bash
  cd contracts && forge test
  FORK_TESTS=1 forge test --network arc --match-path 'test/fork/*'
  ```
- Optional but recommended: a Safe to own the launchpad and trackers (`JUNO_OWNER`).

## 2. Deploy (one command)

```bash
DRY_RUN=1 sh scripts/deploy.sh mainnet                              # simulate against mainnet, send nothing
JUNO_CONFIRM_MAINNET=yes JUNO_OWNER=0xYourSafe VERIFY=1 sh scripts/deploy.sh mainnet
```

What it sends (≈ 21.4M gas in the testnet simulation): Uniswap's published v2
factory + Router02, `JunoLaunchpad`, `UniswapV2Graduator`, `JunoCrossChain`
(wired to Arc mainnet's CCIP TokenPoolFactory `0x7CcF…668a`,
RegistryModuleOwnerCustom `0x3201…c7F`, TokenAdminRegistry `0x51e2…E29`),
`JunoSwapRouter`, `JunoTrackers` with ten Chainlink feeds registered (BTC, ETH,
SOL, LINK, PAXG, EUR, JPY, AVAX, XRP, BNB), then hands ownership to
`JUNO_OWNER` (it must call `acceptOwnership()` on the launchpad and trackers).
Addresses land in `deployments/arc-mainnet.json`. CCTP TokenMessengerV2
(`0x28b5…cf5d`), Gateway (`0x7777…00eE` / `0x2222…C205`) and Memo are Arc's own.

Defaults worth reviewing: protocol share 20% (`JUNO_PROTOCOL_SHARE_BPS`),
per-curve raise cap 100,000 USDC (`JUNO_MAX_RAISE_USDC`, hard limit 10M).

## 3. USDC needed

| | Testnet | Mainnet |
|---|---|---|
| Contract deploy (21.4M gas) | ≈ 0.93 USDC at 43 gwei | ≈ 0.43 USDC at 20 gwei (2026-10-07) — budget **1 USDC** |
| Short demo: a launch, a few buys and a sell (≈ 3M gas) | ≈ 0.15 | ≈ 0.10 |
| Demo graduation: a small `content` curve ($4 → $100 FDV) raises ≈ $28 that is locked in the v2 pair for good | ≈ 30 | ≈ 30 |
| CCIP enable (≈ 6M gas) + one `ccipSend` (fee ≈ 0.26 USDC on testnet) | ≈ 0.6 | ≈ 1 |
| CCTP fee withdrawal, Gateway deposit, relayer float for gasless buys | ≈ 5 | ≈ 5 |
| **Total to fund** | **≈ 40 USDC** | **≈ 40 USDC** |

The demo graduation is the only real spend; everything else is cents. Skip it
and mainnet needs about 5 USDC.

## 4. Remote chain for the CCIP demo (user-run)

After a coin graduates and its creator enables it (`Make it cross-chain` in the
app, or `JunoCrossChain.enable`):

```bash
# BASE_SEPOLIA_RPC_URL and CCIP_REMOTE_PRIVATE_KEY (a key with Base Sepolia ETH) in .env.local
npm run ccip:remote -- --token 0xCoin --dry-run          # the plan, nothing sent
npm run ccip:remote -- --token 0xCoin --send-arc         # CrossChainToken + BurnMintTokenPool on Base Sepolia, registered, and wired on Arc
npm run ccip:send -- --token 0xCoin --to base-sepolia --amount 1000 --yes
npm run ccip:status -- --id 0x<messageId> --watch        # or https://ccip.chain.link/msg/<id>
```

`--chain ethereum-sepolia` targets Ethereum Sepolia. `ccip-remote` refuses a
mainnet chain without `--allow-mainnet`. **Never send CCIP messages on mainnet
as part of a test.**

## 5. Hosting (lead)

API (Railway or Vercel, Node 22), env:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_ARC_NETWORK` | `mainnet` |
| `ARC_RPC_URL` / `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.mainnet.arc.io` (or a dedicated RPC server-side) |
| `ARC_MAINNET_RPC_URL` | `https://rpc.mainnet.arc.io` |
| `JUNO_DEPLOYMENT_FILE` | `deployments/arc-mainnet.json` (default) |
| `JUNO_RELAYER_PRIVATE_KEY` | a dedicated hot key with a few USDC (gasless buys, Gateway mints) — **not** the deployer |
| `DATABASE_URL`, `MONGODB_URI`, `MONGODB_DB` | Postgres 16 and Mongo 7 |
| `PINATA_JWT`, `NEXT_PUBLIC_IPFS_GATEWAY` | media and token metadata |
| `JUNO_APP_URL`, `NEXT_PUBLIC_SITE_URL` | the web app's origin |
| `ENVIO_GRAPHQL_URL` | optional |
| `FAUCET_AMOUNT_USDC` | leave unset on mainnet (the faucet is testnet-only) |
| `CIRCLE_GATEWAY_API_URL`, `CIRCLE_IRIS_API_URL` | optional overrides; mainnet defaults are Circle's production APIs |

Then `npm run db:migrate`. Web app: `cd juno-expo && EXPO_PUBLIC_API_URL=https://<api> npx expo export --platform web`,
deploy `juno-expo/dist` as a static site (SPA fallback to `index.html`). No
keeper or cron is required: graduation is one permissionless transaction —
the coin page shows a **Graduate** button to anyone once a curve is full
(`POST /api/juno/tx/graduate` builds it; `npm run juno:graduate` from a
terminal) — and tracker marks are read on demand from Chainlink. Optional:
`GET /api/juno/index` on a cron advances the trade-history log tail.

## 6. After deploy

- `sh scripts/deploy.sh mainnet` with `VERIFY=1` verifies Juno's contracts on
  explorer.arc.io (Blockscout); Uniswap's and Chainlink's are their published bytecode.
- Smoke test against mainnet with a small amount: launch, buy $1, sell, check
  the Memo tag on the explorer, `GET /api/juno/trackers`.
