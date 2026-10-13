# Juno on Arc testnet: live end-to-end run

Real transactions on **Arc testnet (chain 5042002)**, sent through the Juno API (`scripts/e2e-testnet.mjs`) against
`https://rpc.testnet.arc.io` and the contracts in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).
Three throwaway accounts were funded from the shared deployer (0.65 testnet USDC), used, and the leftovers swept back.
Every link opens on [explorer.testnet.arc.io](https://explorer.testnet.arc.io). Raw data: [`e2e-testnet.json`](e2e-testnet.json).

Run it yourself (needs the API running against testnet, see the README):

```bash
ARC_RPC_URL=https://rpc.testnet.arc.io JUNO_API_URL=http://127.0.0.1:8911 node scripts/e2e-testnet.mjs
```

## What the run covers

| Flow | Result |
|---|---|
| Upload an image + token metadata (demo storage: no Pinata key) | passed |
| **Launch a post coin** with a 0.10 USDC first buy (Memo-tagged) | passed |
| **Buy** 0.10 USDC (Memo-tagged) | passed |
| **Gasless relayed buy** (EIP-3009; the relayer paid the gas) | passed: the buyer paid exactly 0.05 USDC and no gas |
| **Sell** half of the buyer's coins (Memo-tagged) | passed |
| Creator fee claim on Arc | passed |
| **CCTP V2 burn** to Base Sepolia (`claimCreatorFeesCrossChain`) | burn on Arc passed; Circle's Iris sandbox attested it (`complete`); **the mint on Base Sepolia was not run** (needs a Base Sepolia transaction) |
| **Circle Gateway deposit** from Arc (0.02 USDC) | passed, `availableBalance` read back from the GatewayWallet; **attestation + mint on Arc were not run** |
| A browser (Playwright, 390 px wide) creating a device wallet, taking testnet USDC from the faucet, uploading a photo and launching | passed: see [UI launch](#ui-launch) |

## Not run live (and why)

| Piece | Status | Why |
|---|---|---|
| **Graduation** into Uniswap v2 and trading on the pair | **fork-proven only** | Filling the curve needs about $28 of buys, which is outside the 2 USDC test budget. It is covered by the Foundry fork suite and `scripts/e2e-fork.mjs`. |
| **CCIP enable / `ccipSend`** | **fork-proven only** | A coin must graduate first. The CCIP contracts are deployed on testnet; enable and send run against a fork of Arc testnet's real factory, registries and OnRamp. Delivery to Base Sepolia is user-run. |
| **Chainlink Data Feeds / trackers** | **display-only on testnet** | Arc testnet has no Chainlink feeds (`feedsRegistered: 0`). The app shows Arc **mainnet** prices and labels them so; nothing is marked on chain. Fork-proven against Arc mainnet state. |
| **CCTP mint** on Base Sepolia, **Gateway attestation + mint** | **not run** | Need gas / balances on other chains. |
| Anything on **Arc mainnet** | **not run** | This phase is testnet only. |

## Run 2 (final code): coin JTN8113

Coin: [`0x8A9f1266C4D0EF2337848107FbEd736AC9e25Cb4`](https://explorer.testnet.arc.io/token/0x8A9f1266C4D0EF2337848107FbEd736AC9e25Cb4). Run at 2026-10-13T18:37:23.826Z.

| Step | Transaction | Block | Submit to receipt (ms, via the API) | Status | Gas paid (USDC) |
|---|---|---|---|---|---|
| fund 0x133447… 0.30 USDC | [`0xeec4d78e…aa6a83`](https://explorer.testnet.arc.io/tx/0xeec4d78e8f847a933d65faf341a2aea0230441d6daafa3f623be4daf33aa6a83) | 67032174 | n/a (funding) | success | 0.0005 |
| fund 0xc8f4B1… 0.20 USDC | [`0x36cf3550…03fad1`](https://explorer.testnet.arc.io/tx/0x36cf3550ca8f20608014cc8a40dfa12f9eced35ceaaeac48822e013cd303fad1) | 67032183 | n/a (funding) | success | 0.0005 |
| fund 0x89f4B6… 0.15 USDC | [`0x9a909ad3…bef123`](https://explorer.testnet.arc.io/tx/0x9a909ad394ad2ee6cf3011bf20f35e7e93cdba85937437a91ca57bb17dbef123) | 67032185 | n/a (funding) | success | 0.0005 |
| approve USDC | [`0xb7a55523…4b7652`](https://explorer.testnet.arc.io/tx/0xb7a55523312c9a1b6f3f428ade03f76498e915b81e79d09d67534ca9274b7652) | 67032194 | 1126 | success | 0.0014 |
| launch (JunoLaunchpad.create + first buy) | [`0xa304ba01…24904e`](https://explorer.testnet.arc.io/tx/0xa304ba01528ce0962cf52c0aa771904a0f0bac08584e9c48d3c27c7bdb24904e) | 67032196 | 1325 | success | 0.0625 |
| approve USDC | [`0xb1386166…871bc6`](https://explorer.testnet.arc.io/tx/0xb13861662cc5a317a9df23b36b118103cbc46025911a08cda9d73be2a2871bc6) | 67032205 | 1116 | success | 0.0014 |
| buy (memo) | [`0x07fba537…f1af14`](https://explorer.testnet.arc.io/tx/0x07fba5374ffdffc9d60dc26965f74bd2528a1aad872eae5045b5d3b2d7f1af14) | 67032207 | 1270 | success | 0.0040 |
| gasless buy (relayed, memo) | [`0x9809b28d…75d004`](https://explorer.testnet.arc.io/tx/0x9809b28d49fb1d24cf573229c113d35cbcdad0eb140c244be28f4db30e75d004) | 67032212 | 1129 | success | 0.0049 |
| sell (memo) | [`0x74360374…18e6a2`](https://explorer.testnet.arc.io/tx/0x74360374bc154cb624675d70ba3191a05d927e19d2a6b0c945eab13c1a18e6a2) | 67032219 | 1130 | success | 0.0042 |
| claimCreatorFees | [`0xe953eb33…d0ea50`](https://explorer.testnet.arc.io/tx/0xe953eb33943af8b2780a166006085ce4864768a71a2530f26871b0396cd0ea50) | 67032223 | 1121 | success | 0.0020 |
| claimCreatorFeesCrossChain (CCTP depositForBurn) | [`0x50bce220…6572da`](https://explorer.testnet.arc.io/tx/0x50bce220df1e32b6433b5cbd857b6fa2338d8ae111d80565da7d73f7046572da) | 67032235 | 1146 | success | 0.0037 |
| approve GatewayWallet | [`0x236ca567…df6afb`](https://explorer.testnet.arc.io/tx/0x236ca567f3b9a7ba5c70d9fd53dd226d19214abf48e479e6be62414481df6afb) | 67032251 | 1963 | success | 0.0014 |
| GatewayWallet.deposit | [`0xb74d4649…d32231`](https://explorer.testnet.arc.io/tx/0xb74d4649cc9177e4b2c1df89f7d3670c1301c4d728682db55ff94eeadfd32231) | 67032255 | 1273 | success | 0.0022 |

## Run 1 (earlier code, same flow): coin JTN8302

Coin: [`0xeb50856C8453e6873D67A6F2C30D41Ce44f4c4Ea`](https://explorer.testnet.arc.io/token/0xeb50856C8453e6873D67A6F2C30D41Ce44f4c4Ea). Run at 2026-10-13T18:22:16.506Z. Iris status when first polled: `pending`.

| Step | Transaction | Block | Submit to receipt (ms, via the API) | Status | Gas paid (USDC) |
|---|---|---|---|---|---|
| fund 0xE3dbF7… 0.30 USDC | [`0x54ca9e36…ee6944`](https://explorer.testnet.arc.io/tx/0x54ca9e3695ab09d0429aef9e256ef090433f2be08909772304ba64b387ee6944) | 67030407 | n/a (funding) | success | 0.0005 |
| fund 0x7F2509… 0.20 USDC | [`0xd7746b83…04e8e4`](https://explorer.testnet.arc.io/tx/0xd7746b83b51caf6066c33b760d25d3634e3509e361b5a95a91fff8ee8f04e8e4) | 67030409 | n/a (funding) | success | 0.0005 |
| fund 0x845cfC… 0.15 USDC | [`0xc806d445…ebf069`](https://explorer.testnet.arc.io/tx/0xc806d445b96389a0e8484311f2fa8903aee6871f055dc59091126e50cfebf069) | 67030411 | n/a (funding) | success | 0.0005 |
| approve USDC | [`0x58fc6406…a94841`](https://explorer.testnet.arc.io/tx/0x58fc640619a82d55731a17ec8d1dc2a34efe76277a8c374e962a0c2b17a94841) | 67030419 | 1144 | success | 0.0014 |
| launch (JunoLaunchpad.create + first buy) | [`0x1209e055…a90ff8`](https://explorer.testnet.arc.io/tx/0x1209e055ad781b79e1301a074e2d63366ce3268f7e28bea899bb67fc67a90ff8) | 67030422 | 1276 | success | 0.0633 |
| approve USDC | [`0x4d77ebd2…5a3179`](https://explorer.testnet.arc.io/tx/0x4d77ebd2700357ac80e3d02f53dcc0f0e66fa1c7387564378d13ddaa145a3179) | 67030431 | 1122 | success | 0.0014 |
| buy (memo) | [`0x3e98e9b3…58e46a`](https://explorer.testnet.arc.io/tx/0x3e98e9b362b345d8d6883500d111a34c9de286fb782dc8e6cfe14b54db58e46a) | 67030433 | 1284 | success | 0.0040 |
| gasless buy (relayed, memo) | [`0xb5dbf363…ac11c6`](https://explorer.testnet.arc.io/tx/0xb5dbf3636a4747748287e7f223be5cda242f3d4e805ac6c1e9f0bbfb02ac11c6) | 67030439 | 1137 | success | 0.0049 |
| sell (memo) | [`0x672b8d8f…bf7450`](https://explorer.testnet.arc.io/tx/0x672b8d8f9f0d3d099d7b060c6ca31f8dda4a899ddef8e4047594609629bf7450) | 67030444 | 1123 | success | 0.0042 |
| claimCreatorFees | [`0x7b0fed18…6b51e3`](https://explorer.testnet.arc.io/tx/0x7b0fed18203be718c6a300e91a10a474af66cf9b050244cb4252fd57d06b51e3) | 67030449 | 1135 | success | 0.0020 |
| claimCreatorFeesCrossChain (CCTP depositForBurn) | [`0x9798bbf0…f0ea27`](https://explorer.testnet.arc.io/tx/0x9798bbf0f947eb20a5431dea2c40f77ca46b68f852f7d2b76cd4604efdf0ea27) | 67030460 | 1126 | success | 0.0037 |
| approve GatewayWallet | [`0x93b76a5c…ee35a5`](https://explorer.testnet.arc.io/tx/0x93b76a5c101155a923713bb7b5aedb06f209969ecd5a4e325185bac134ee35a5) | 67030466 | 1927 | success | 0.0014 |
| GatewayWallet.deposit | [`0x92e29d31…db4285`](https://explorer.testnet.arc.io/tx/0x92e29d3118b37fa0d709f3ad84cffbb45674b550982fe3634099bb849fdb4285) | 67030470 | 1265 | success | 0.0022 |

## UI launch

A headless Chromium (Playwright, 390 × 844) against the web export pointed at this API on Arc testnet: "Create wallet" (a key made in
the browser), "Get testnet USDC" (the faucet sent 0.12 USDC from the relayer), pick a photo, name + ticker, "Launch post". The launch
transaction was [`0x188fcc56…e7dfcd`](https://explorer.testnet.arc.io/tx/0x188fcc561c45c6985a788a7720b5aef75fbcfa7708833c46bdf0cb98c5e7dfcd)
and the coin [`0x8800…114f`](https://explorer.testnet.arc.io/token/0x88007908ee4211cedF78bfF2F138E8Eb5339114f). Screens:
[`docs/screens/testnet/flow-*.png`](screens/testnet/).

## Measured, not claimed

- **Finality.** Arc testnet blocks land about every 0.5 s (two blocks per second in a sample of recent blocks). Submit-to-receipt through
  the API was 1.1–1.3 s per transaction here, which includes RPC round trips and polling. The app says "about a second", not "under a second".
- **Gas.** A curve buy cost about 0.004 USDC (159k gas at 25 gwei), a gasless relayed buy 0.005 USDC (the relayer paid it), a launch about
  0.06 USDC (2.5M gas). The app's "about \$0.004 a trade" comes from these.
- **Image storage.** No Pinata key was set, so uploads were kept by the API server under their real IPFS content address (CIDv1, raw, sha2-256),
  served from `/api/ipfs/<cid>`. They are **not pinned to the IPFS network**; the launch screen and `/api/juno/config` (`storage: "local"`) say so.
