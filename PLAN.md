# Juno on Arc — plan and status

**Updated:** 8 Oct 2026. **Arc Microgrants deadline:** 14 Oct 2026, 23:59 ET.

Phase gate (from the porting brief): Arc **testnet** only for now; mainnet is
one command (`MAINNET.md`) that the lead runs after the deployer is funded.
Everything is verified on Circle's Arc Foundry forks and Chainlink Local until then.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Contracts on Arc: USDC curves, raise cap, EIP-3009 relayed buys, CCTP V2 fee claims, published Uniswap v2, CCIP CCT (`JunoCrossChain`), Chainlink trackers | DONE | `forge test` 85/85; fork suites 10/10; Slither clean at medium+ |
| 2 | Deploy script for testnet and mainnet (`scripts/deploy.sh`), local fork rehearsal (`scripts/arc-fork.sh`) | DONE | testnet simulation 21.4M gas (≈0.92 USDC); fork deploy |
| 3 | Testnet deploy | **BLOCKED** | deployer `0x0648…1FBd` holds 0 USDC; fund ~1 USDC (40 for the full demo) and run `sh scripts/deploy.sh testnet` |
| 4 | Server on Arc: Memo-tagged trades, gasless buys, Gateway, CCTP, CCIP, Chainlink feeds, USDC faucet | DONE | vitest 388/388; integration 11 (+1 skipped); `scripts/e2e-fork.mjs` 20 txs |
| 5 | Web app on Arc (juno-expo web build) with the Arc stack visible | DONE | tsc clean, export OK, browser pass on the fork (`docs/screens/arc/`) |
| 6 | README (Arc stack table), SUBMISSION, MAINNET, JUNO deep dive | DONE | — |
| 7 | Live testnet proofs: CCTP attestation + mint on Base Sepolia, Gateway mint from a real balance, CCIP delivery to Base Sepolia (`npm run ccip:remote`, `ccip:send`) | AWAITING FUNDS | user-run after item 3 |
| 8 | Mainnet deploy + hosting (API, web, DB) | LEAD | `MAINNET.md` |

Known limits: Arc testnet has no Chainlink feeds (trackers are mainnet-only on
chain; testnet shows mainnet prices, labelled); the Envio indexer is optional and
not verified on Arc; the mobile builds and the MetaMask plugin were not ported.
