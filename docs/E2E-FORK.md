# Juno end to end on a local Arc fork

`scripts/e2e-fork.mjs` drives the API exactly as the app does — the API builds
unsigned transactions, a local key signs them, the API submits them — against a
local fork of **Arc testnet** (chain 5042002) with Juno deployed by the real
deploy script (`scripts/arc-fork.sh` → `.fork/arc-fork.json`). Circle's USDC,
CCTP V2 TokenMessengerV2, Gateway and Memo, and Chainlink's CCIP Router /
OnRamp / TokenPoolFactory / TokenAdminRegistry are the real Arc testnet
contracts, forked. Fresh keys are funded with `anvil_setBalance` (Arc's native
balance is USDC). Nothing is mocked; nothing is sent to Arc testnet or mainnet.

```bash
npm run demo:local            # fork (reused if up) + Postgres + mongod :8913 + API :8911 (production build) + seed + web :8912
node scripts/e2e-fork.mjs     # JUNO_API_URL=http://127.0.0.1:8911 ARC_RPC_URL=http://127.0.0.1:8910
npm run demo:local -- stop
```

The script refuses any RPC that isn't a local node on chain 5042002, prints
each transaction's hash and `confirmMs` (broadcast → receipt, measured by the
API), and exits non-zero if any step fails.

## Last run — 2026-10-08, production build (`next start`) on :8911

All 12 sections passed, 20 transactions. Launchpad `0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E`
(fork deploy block 66009538). Relayer `0x7b0F…D5E7` (a fork-only key).
`confirmMs` are the **fork's** (anvil, 1-second blocks), not Arc's own timing.

| # | Step | Tx | confirmMs | Checked |
|---|---|---|---|---|
| 1 | approve USDC | `0x88c5930ab20c132ff3c6d005ad4113ac0c7c9e5cc3ea43a75b6fe4ebf4ff944a` | 538 | |
| 1 | launch photo post, 5 USDC first buy (Memo) | `0x328cd736274172ad6b56ca5b18c0977b09578b7112f5d5cb830df97f6914bc1d` | 938 | `Launched` token = predicted; Memo event `"juno launch $MAR9701 5 USDC"`; `POST pools` recorded coin `0x96b2…afb5` |
| 2 | approve USDC | `0xa60fea6c67049e4050bebf45ef6aeae968638ad59541fe7412cf12ec32f657cb` | 1310 | |
| 2 | buy 10 USDC (**Memo-tagged**) | `0x452b074928a7c0559414ff2030f904225d85e527a6faa30966116d042088c920` | 939 | `Trade` recorded; Memo `sender` = the buyer (CallFrom) |
| 3 | fund gasless buyer (6 USDC transfer) | `0x822c3759166e299ea1eda5c976c496b91e7d9625e3f3f6ca4c4e5fc9817e4470` | 418 | |
| 3 | **gasless buy** (EIP-3009, relayed, Memo) | `0x9e569ada1602a94911d671633a2b057259b0285e48df9280bee83cfcc4a1e47e` | 714 | typed-data nonce == `launchpad.buyNonce(…)` on chain; buyer paid exactly 5 USDC and **no gas**; received 3,990,850.75 tokens |
| 4 | sell half (Memo) | `0x80b7b7398cc5035d89cb4e84cfe5f3d9f59add3fea97f087c79d0f042fc1142b` | 615 | 4.3721 USDC out |
| 5 | **CCTP V2** creator fees → Base Sepolia (domain 6) | `0xde6f32c57eb6c268ee118b9e23d63b1973259f663c9654161a534885b11a32f1` | 875 | `CreatorFeesBridged` 1.785924 USDC burned through TokenMessengerV2, maxFee 0, threshold 2000; `cctp/status` → `pending` (Iris never attests a fork burn) |
| 6 | whale buy fills the curve | `0x4c511dcfc3b9d97cf87af82d093c60a53fe84eeca4d09932d5f39eefb0e8cde9` | 1010 | `CurveCompleted` |
| 6 | graduate → Uniswap v2 | `0x1db70fac176c92b0259291285bbf002ea31dbdc10f3a03d1be9cc5cd29965c8f` | 1397 | pair `0xA1b0…4AA1` (Uniswap's published v2 factory bytecode) |
| 7 | buy on the v2 pair (JunoSwapRouter) | `0xf645cae1ab7979f2b31c206f72706e39fa0c004c3d9cc3afbcf65929e79c5ba0` | 1230 | `venue: "uniswap-v2"`, fill recorded |
| 8 | creator fee claim on Arc | `0x0b913d0c1d7c36cced221c9b12e07a48196f83350d5a5b933b41fd84f822ca91` | 576 | |
| 9 | approve GatewayWallet | `0xd025b7313ff63310787eaff1613a266309c687702d2c34e96c0adfd60a550db7` | 702 | |
| 9 | **Circle Gateway** `deposit(USDC, 2)` | `0xb41257c383a737c66af5720e5cde3c3e14e330a3c18ba263bd59017788892678` | 1178 | `GatewayWallet.availableBalance` = 2 USDC on the fork; burn intent built and signed; Circle's real testnet API refused the mint ("available 0") — expected, the deposit exists only on the fork |
| 10 | **CCIP** `JunoCrossChain.enable` | `0xeb58e72993ec21fa1943e10fc76ab56c455a9f7af7e5a5c05fcf0d72cfd501f2` | 1197 | BurnMintTokenPool 2.0.0 `0xEA29…4C9d` deployed by Arc's TokenPoolFactory, registered in the TokenAdminRegistry |
| 10 | `applyChainUpdates` (Base Sepolia) | `0x0fba7bbb11615c94f8939da027a8fc94785415f69d0a9e952f930f7208a8b616` | 1388 | lane on the pool, 50M-token buckets; remote pool/token are **placeholders** on the fork |
| 10 | approve Router | `0x4882bacd9398a439a88b304d2878538d53fd36fbc686c6e3fb7352f3b333d820` | 935 | |
| 10 | `Router.ccipSend` → Base Sepolia | `0xa2c537dcae25aa9dbb8bf0faa73e7fccec28f60546d5994bbf15e8c4a9b31ebd` | 1023 | fee 0.2626 USDC (native); messageId `0xdf99bc5f1af294ac3f0949436ffd77ba6696f31770da8c9044de6174b7afadbb` decoded from OnRamp 2.0's `CCIPMessageSent`; 1,000,000 tokens burned on Arc |
| 11 | BTC tracker launch (`tight-nav`, 1e-9 BTC/token) | `0x7e995fe897444989b249eca6543b9e580912808bd464a972c3169825ef219f16` | 821 | opened at $0.000083 = Chainlink BTC/USD ($83,061.76, Arc mainnet) × 1e-9; coin page NAV deviation 0.000%, within band; `/trackers` 10 live feeds; `/peg` USDC/USD 0.99983677 |
| 12 | faucet 1 USDC (relayer) | `0x4b17373e256e98bba931e6ed09cc06b29e6433c7de29c01c2dd64dbe96de0812` | 1047 | recipient's ERC-20 USDC balance = 1,000,000 units |

Median `confirmMs` 939 ms on the fork.

## What the fork shows, and what it can't

- **Memo runs on this fork.** Circle's Arc Foundry anvil executes the CallFrom
  precompile in `eth_call` and in transactions, so the API's probe reports
  `memo.live: true` and every curve trade, relayed buy and first-buy launch
  went through Memo with the wallet as the caller. The plain-call fallback is
  covered by the probe logic and its unit test, not by this run.
- **Gas margin found by this run.** A relayed buy through Memo first went out
  with viem's bare estimate and ran out of gas (194,637 of 196,388 used); the
  relayer now adds 30% + 30k gas. Unused gas is not charged on Arc.
- **CCTP:** the burn is real (Circle's TokenMessengerV2 on the fork); the
  attestation and the mint on Base Sepolia need real testnet funds and are not
  exercised. `cctp/status` correctly answers `pending`.
- **Gateway:** the deposit is real on the fork; Circle's Gateway API is real
  but only sees Arc testnet, so the mint is refused. The full mint path needs a
  real testnet deposit.
- **CCIP:** enable, registry, lane wiring and `ccipSend` are real Chainlink
  2.0 contracts on the fork; delivery to Base Sepolia needs the remote side
  (`scripts/ccip-remote.ts`, user-run) and a real testnet send.
- **Chainlink Data Feeds** are read live from Arc mainnet (read-only). On
  testnet `JunoTrackers` has no feeds registered, so the tracker's ratio is
  recorded off chain and `attested` is null; on mainnet the `track` step is
  appended.
- **Media:** the photo is an `https://` image URL; the IPFS upload route
  (Pinata) was not exercised.
