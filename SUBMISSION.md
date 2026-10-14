Hosted Arc testnet: https://juno-arc.vercel.app · [Vercel checks and storage limitation](docs/HOSTED.md).

# Juno on Arc — DoraHacks submission

Live contracts: Arc testnet. The former hosting was removed; public Vercel hosting is pending.
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
