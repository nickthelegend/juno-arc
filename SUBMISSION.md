Live: https://juno-arc.vercel.app (Arc mainnet, chain 5042)

# Juno on Arc — DoraHacks submission

Contracts and production frontend now target Arc mainnet; prior network evidence remains labelled below.
Browser reproduction and current evidence: [docs/JUDGE-REPORT.md](docs/JUDGE-REPORT.md).


## Description (≤150 words)

Juno is a social app where every post is a market. Posting a photo or reel
launches its own token on a USDC bonding curve on Arc; people buy into posts as
they scroll, each buy final in about a second with about half a cent of USDC
gas, and the creator earns the trading fees instead of ad revenue. Full curves
graduate into a Uniswap v2 pair with the liquidity locked forever. Then the
post goes cross-chain: one transaction makes it a Chainlink CCIP Cross-Chain
Token through Arc's own token pool factory, so holders can bridge it to Base or
Ethereum. Buyers on other chains pay from a Circle Gateway unified balance with
a gasless EIP-3009 signature, creators withdraw fees anywhere with CCTP V2,
tracker coins are marked against Chainlink Data Feeds, and every buy is tagged
with its post through Arc's Memo.

## What it uses Arc for

- **USDC as gas and as the quote** — one token for users; every price is in dollars.
- **Deterministic finality, ~0.5 s blocks** — the receipt is the confirmation; the app shows the measured ms (1.1–1.3 s end to end on testnet, through our server).
- **Chainlink CCIP Cross-Chain Tokens** via Arc's TokenPoolFactory / RegistryModuleOwnerCustom / TokenAdminRegistry — post coins bridge to Base/Ethereum, fee paid in USDC. Contracts deployed on testnet; enable/send is fork-proven, not run live.
- **Circle Gateway** — unified USDC balance across chains, minted on Arc for a buy. Deposit from Arc run on testnet; attestation + mint not run.
- **EIP-3009 on Arc USDC** — gasless, approval-free relayed buys bound to the exact trade.
- **CCTP V2** — creator fees out to any chain in one call. A real burn on Arc testnet, attested by Circle's Iris sandbox; the destination mint is user-run.
- **Chainlink Data Feeds** — tracker coins and the USDC peg, with staleness checks. Feeds exist on Arc mainnet only: display-only on testnet.
- **Arc Memo** — buys tagged with the post id.
- **Uniswap v2 on Arc** — deployed on testnet from Uniswap's published bytecode; graduations lock their LP (graduation is fork-proven, not run live).

## Demo (3 minutes)

1. Open the app → Feed. Every post shows its market cap in dollars and a Buy button.
2. Buy $0.10 of a post: the receipt leads with the measured time (about a second), shows the gas in USDC and the Memo tag; open it on the explorer.
3. Buy again with "Pay with signature — no gas": one signature, the relayer submits.
4. Wallet tab → Circle Gateway: unified balance per chain; deposit from Arc, spend into a buy.
5. + → Post a photo → launch (one signature). Profile → earnings → "Withdraw fees to Base" (CCTP V2).
6. A graduated coin → "Make it cross-chain (CCIP)" → one transaction → send 1,000 tokens to Base Sepolia; open the ccip.chain.link link.
7. Trade → Trackers: BTC, ETH, gold, EUR priced from Chainlink's Arc mainnet feeds (display-only on testnet), each tracker's premium to its feed.

Live testnet transactions: docs/E2E-TESTNET.md · judge audit: docs/JUDGE-REPORT.md
Repo: see README.md (Arc stack table) · runbook: MAINNET.md · deep dive: JUNO.md.

<!-- MAINNET-ADDRESSES -->
## Addresses — live mainnet and testnet

Mainnet **5042: Live**, deployed 2026-10-14. [All mainnet addresses and transaction receipts](docs/MAINNET-DEPLOYMENT.md).
Testnet **5042002: Live**; [testnet deployment](deployments/arc-testnet.json) and [testnet evidence](docs/E2E-TESTNET.md).

- ccipRegistryModuleOwnerCustom: [0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F](https://explorer.arc.io/address/0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F).
- ccipRouter: [0xB79791184973589c38e114D43Eb8E4588C283A18](https://explorer.arc.io/address/0xB79791184973589c38e114D43Eb8E4588C283A18).
- ccipTokenAdminRegistry: [0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29](https://explorer.arc.io/address/0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29).
- ccipTokenPoolFactory: [0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a](https://explorer.arc.io/address/0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a).
- crossChain: [0xeBFD4d58972e5231FB816515198fC4E63593091b](https://explorer.arc.io/address/0xeBFD4d58972e5231FB816515198fC4E63593091b).
- gatewayMinter: [0x2222222d7164433c4C09B0b0D809a9b52C04C205](https://explorer.arc.io/address/0x2222222d7164433c4C09B0b0D809a9b52C04C205).
- gatewayWallet: [0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE](https://explorer.arc.io/address/0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE).
- graduator: [0x524874735655963a82F160Cb741153F50CdebcF6](https://explorer.arc.io/address/0x524874735655963a82F160Cb741153F50CdebcF6).
- launchpad: [0x52D364dF075CEC807f854d2f7D7ff8485dedf641](https://explorer.arc.io/address/0x52D364dF075CEC807f854d2f7D7ff8485dedf641).
- memo: [0x5294E9927c3306DcBaDb03fe70b92e01cCede505](https://explorer.arc.io/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505).
- swapRouter: [0x90948fda347bBF1fb6f2A6F7Cd4765D6ffD7cfBe](https://explorer.arc.io/address/0x90948fda347bBF1fb6f2A6F7Cd4765D6ffD7cfBe).
- tokenMessengerV2: [0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d](https://explorer.arc.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d).
- trackers: [0x05Ff7d5cfd43b714e4abA00493459A600320a406](https://explorer.arc.io/address/0x05Ff7d5cfd43b714e4abA00493459A600320a406).
- uniswapV2Factory: [0x1294aF729364c40F43A891e92E9A2196D3385c77](https://explorer.arc.io/address/0x1294aF729364c40F43A891e92E9A2196D3385c77).
- uniswapV2Router02: [0x29CAa1fa4a9456d5B511e4607033026FE512CD09](https://explorer.arc.io/address/0x29CAa1fa4a9456d5B511e4607033026FE512CD09).

Mainnet smoke: [Smoke: launch content coin with zero purchase](https://explorer.arc.io/tx/0xfde385889cc303e46ee7c132b2c5cfd1f33ef9e6d396448210a51ebd6e688143).
<!-- /MAINNET-ADDRESSES -->

## Production network

Live: https://juno-arc.vercel.app (Arc mainnet, chain 5042). [Hosted mainnet checks](docs/HOSTED-MAINNET.md). The API uses an isolated mainnet database; storage readiness remains separately reported. The faucet is disabled on mainnet. No mainnet transactions were sent during the hosting migration. Historical **Live (testnet)** and **Fork** results elsewhere in this document are separate evidence, not production smoke results.
