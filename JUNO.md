# Juno on Arc — the deep dive

**A social app where every post is a live market, settled in USDC on Arc.**

Publishing a photo or a reel launches a token for it, sold on a sixteen-range
bonding curve quoted in USDC by Juno's own launchpad contract. People buy into
the post as they scroll; every buy is final in under a second and costs a
fraction of a cent of USDC gas. The creator earns the trading fees and can
withdraw them to Base, Ethereum or Solana in one call through Circle CCTP. When
the curve fills, its reserves graduate into a Uniswap v2 TOKEN/USDC pair with
the liquidity locked for good — and the coin can then become a Chainlink CCIP
Cross-Chain Token that its holders bridge to other chains.

This file covers the contracts and the mechanics. `README.md` is the overview;
`MAINNET.md` the deploy runbook.

---

## Contracts

| Contract | What it does |
|---|---|
| `JunoLaunchpad` | Sixteen-range concentrated-liquidity curves in USDC; exponential fee decay; creator and protocol fee accrual; partial fills at the top; permissionless graduation; a per-curve raise cap (`maxRaise`, ≤ 10M USDC); relayed EIP-3009 buys; creator fees out through CCTP V2. |
| `JunoToken` | Fixed one-billion supply (18 decimals), EIP-2612 permit, pinned metadata, transfers into its pair locked until graduation, no approval needed to sell to its own launchpad; after graduation a CCIP burn/mint hook bounded by `ccipMinted ≤ ccipBurned`. |
| `UniswapV2Graduator` | Fixes the TOKEN/USDC pair's CREATE2 address at launch, deploys the pair only at graduation, seeds it with the curve's reserves and mints the LP to the dead address. Survives a pair someone has donated to and `sync`ed. |
| `JunoSwapRouter` | Trades a graduated coin against its pair in one transaction; its `Swapped` event names the trader for the app's history. |
| `JunoCrossChain` | Makes a graduated coin a CCIP Cross-Chain Token in one call by its creator, through Arc's TokenPoolFactory, RegistryModuleOwnerCustom and TokenAdminRegistry, with Chainlink's published BurnMintTokenPool 2.0.0 and always-on, capped rate limits. |
| `JunoTrackers` | Tracker coins marked against Chainlink Data Feeds on Arc, with answer, round and staleness checks; the coin's premium to the feed as an on-chain view. |
| Uniswap v2 | Arc has no Uniswap deployment, so the deploy script puts Uniswap's own **published** `UniswapV2Factory` and `UniswapV2Router02` (npm `@uniswap/v2-core` 1.0.1 and `@uniswap/v2-periphery` build artifacts) on Arc byte for byte. Pairs carry the canonical init code hash `0x96e8ac42…845f`, so any v2 tooling finds them. Router02's WETH slot is zero: on Arc, USDC is both the gas token and the ERC-20 at `0x3600…0000`, so there is nothing to wrap. |

### USDC on Arc, and why there is no native path

On Arc the native balance *is* USDC with 18 decimals (`msg.value`,
`eth_getBalance`), and the ERC-20 at `0x3600…0000` is the same money with 6
decimals. Arc's own guidance is never to pair the two faces in one pool. So
the launchpad takes the ERC-20 face only: nothing is `payable`, every quote is
6-decimal USDC, and every curve in the app is priced in dollars. The curve math
is unit-agnostic (raw quote units per raw base unit), so the switch from an
18-decimal quote to a 6-decimal one changes no arithmetic — but the presets'
sizes, the fee-rounding tolerances and every test's amounts were rechecked in
USDC (a USDC base unit is $0.000001, which is a visible share of a one-token
order, so exact-out parity is now checked from $1 orders up).

### Relayed buys (EIP-3009)

`buyWithAuthorization` lets a buyer who holds only USDC — say, USDC that just
arrived through Circle Gateway — buy without gas and without an approval. They
sign one `ReceiveWithAuthorization` on Arc's USDC (EIP-712 domain `"USDC"` /
`"2"`) whose nonce is `buyNonce(token, buyer, quoteIn, minBaseOut, deadline,
salt)`. The nonce binds the coin, the size, the minimum out and the deadline,
so the relayer can only submit exactly that trade, once; USDC's
`receiveWithAuthorization` can only be called by the payee (the launchpad), so
nobody can redirect the money. Tokens and any refund from a partial fill go to
the buyer, never to the relayer.

### Creator fees to any chain (CCTP V2)

`claimCreatorFeesCrossChain(token, destinationDomain, mintRecipient, maxFee,
minFinalityThreshold)` pays a creator's accrued fees straight into Circle's
TokenMessengerV2, which burns them on Arc and mints them to the creator's
wallet on Base, Ethereum, Arbitrum, Solana… Arc's deterministic finality means a
standard transfer is attested as soon as Circle sees the block.

### CCIP Cross-Chain Tokens

A graduated coin can leave Arc as a Chainlink CCIP Cross-Chain Token (CCT):

1. Every coin is launched with `JunoCrossChain` as its `getCCIPAdmin()`.
2. The creator calls `JunoCrossChain.enable(token, poolInitCode, remotes)`. It
   checks the init code's hash against Chainlink's published BurnMintTokenPool
   2.0.0 bytecode, has Arc's TokenPoolFactory deploy the pool, names the pool
   on the token, registers the token in Arc's TokenAdminRegistry through
   RegistryModuleOwnerCustom, and sets the pool there. One transaction.
3. Remote chains are wired with rate limits that are always on and capped at
   10% of supply per bucket; the remote side (a CrossChainToken and its own
   BurnMintTokenPool on Base Sepolia or Ethereum Sepolia) is deployed by
   `scripts/ccip-remote.ts`.
4. Holders send the coin with the CCIP router, paying the fee in native USDC.
   The pool burns on Arc; the remote pool mints. Coming back, the token only
   lets the pool re-mint on Arc what was burned on Arc (`ccipMinted ≤
   ccipBurned`), so Arc's supply can never exceed the billion minted at launch,
   whatever happens on another chain.
5. `handOver` passes the pool, the registry admin role and the token's CCIP
   admin to the creator outright. `JunoCrossChain` has no owner and holds no funds.

Verified: Chainlink Local plus Chainlink's published CCIP bytecode drive a full
Arc → Base → Arc round trip in `test/JunoCrossChain.t.sol`, and
`test/fork/ArcTestnetFork.t.sol` enables a coin through Arc testnet's *real*
factory and registries and sends it to Base Sepolia through the real router
and OnRamp 2.0 (fee ≈ 0.26 USDC).

### Trackers on Chainlink Data Feeds

A tracker is a coin on the flat `tight-nav` curve that follows an asset
Chainlink prices on Arc (BTC, ETH, SOL, LINK, PAXG, EUR, JPY…). Its creator
records once, on chain, which feed it follows and how many units of the asset
one token stands for; `track` refuses a tracker opened more than 25% away from
the feed. `JunoTrackers.mark(token)` returns the feed's price, what the coin
implies, the premium in basis points and whether it is in band — or `stale`,
never a stale number presented as a price. The Monad build attested this
comparison off chain with Chainlink CRE; CRE does not run on Arc mainnet, so it
is now a plain view over Chainlink's own feed. Arc testnet has no feeds, so
trackers are a mainnet feature; the app reads mainnet feeds for display on
testnet and says so. Equity and pre-IPO trackers (Pyth, Tessera) were dropped:
there is no Chainlink feed for them on Arc.

### Memo

Curve trades sent from the app go through Arc's Memo predeploy
(`0x5294…e505`) tagged `keccak256("juno:post:<token>")`, so any explorer or
wallet can reconcile a payment to the post it bought into. Memo keeps the
buyer as `msg.sender` (Arc's CallFrom), so the launchpad needs no changes. The
server probes Memo once per process and falls back to a plain call on a node
that doesn't execute CallFrom; Circle's Arc Foundry anvil does, so the local
fork runs the real Memo path (API e2e and browser pass), as does
`forge test --network arc`.

---

## The curve

A Juno curve is a start price and sixteen ranges above it. Inside one range the
curve is a Uniswap v3 position with constant liquidity `L`:

```
quote between √a and √b  =  L · (√b − √a)
base  between √a and √b  =  L · (√b − √a) / (√a · √b)
```

Prices are square roots in Q64.96 of the raw price, quote wei per base wei.
The liquidity in a range sets how much supply that stretch absorbs per unit of
price — **more liquidity, flatter curve** — so the sixteen weights are the
character of a launch:

| Preset | Weights | For |
|---|---|---|
| `content` | back-loaded `1.2^i` | a post or reel; cheap entry, steepens with attention |
| `thin-name` | **front-loaded** `0.82^i` | a newly tokenized low-float stock — deep book at the issue price so early size fills instead of gapping the print |
| `ipo-book` | deep at both ends, thin in the middle | book-building: absorb the open, discover price mid-curve, flatten near the target cap |
| `tight-nav` | uniform | an asset meant to track an underlying; behaves like a spread, not a launch |

### The solve

Given an opening and a graduation valuation, the builder places the sixteen
range boundaries geometrically between the two prices, then solves for the one
liquidity scale at which

```
supply sold on the curve  +  supply reserved for the AMM  =  99% of supply
```

where the AMM's share is the quote the curve raises, **priced at the curve's
top**. That clause is what makes graduation continuous: the pair opens at
exactly the price the curve finished on, so nobody can buy the last token on
the curve and sell it into the pair at a guaranteed profit. The last 1% is a
rounding buffer, burned at graduation.

This is the same solve Meteora's `buildCurveWithLiquidityWeights` performs for
its Dynamic Bonding Curve. On Arc the contract enforces it: `launch` recomputes the supply the curve sells and the quote it
raises from the ranges themselves, and reverts if they do not fit.

### The presets, measured

`npm run juno:compare-presets` builds all four with the launch route's own
builder, opening at $1k FDV in USDC, and reads each off its ranges. No RPC and
no transaction, so it is reproducible anywhere:

| preset | range | raises | 1% at open | at 25% | at 50% | at 75% | at close | spread | to double |
|---|---|---|---|---|---|---|---|---|---|
| content | 25x | $7.0k | $1.17 | $27 | $49 | $68 | $90 | 76.89x | $127 |
| thin-name | 25x | $2.2k | $12 | $10 | $7.63 | $5.19 | $3.11 | 4.75x | $793 |
| ipo-book | 25x | $4.1k | $9.25 | $4.91 | $18 | $33 | $46 | 9.64x | $589 |
| tight-nav | 1.5x | $667 | $15 | $16 | $16 | $17 | $18 | 1.22x | — |
| tight-nav | 3x | $1.1k | $7.41 | $8.76 | $10 | $11 | $13 | 1.73x | $615 |

*1% at …* is the USDC that moves the price 1% once that share of the
graduation raise has come in. *Spread* is the most expensive 1% move along the
curve over the cheapest. *To double* is the USDC from the open to twice the
opening price.

What it shows:

- `thin-name` is **10x deeper than `content` at the issue price** ($12 against
  $1.17 to move it 1%), and gets thinner as it rises, which is what a newly
  listed low-float name needs.
- `content` is the reverse, cheap to enter and 77x more expensive to move at
  the top than at the open.
- **Weights cannot make a wide range flat.** A uniform curve's 1% cost grows
  with √price, so over a 25x run it would vary 5x. `tight-nav` therefore owns
  its range: 1.5x by default (spread 1.22x, which is √1.5), and the builder
  refuses more than 3x. Before 29 Sep it launched at 25x like the others, and
  "near-flat" was not true.

### Rounding

Every rounding choice in `CurveMath.sol` favours the pool: amounts a trader pays
round up, amounts a trader receives round down. After every holder sells back,
the price rests a few wei *above* where it started, never below.

### Fees

Charged in the quote token on both sides. The launch fee decays exponentially
to a resting fee over sixty periods — `content` goes from 9% to 1% over ten
minutes — which blunts snipers without taxing the post's audience forever. A
protocol share (20% by default, fixed per pool at launch) goes to the protocol;
the rest accrues to the creator and is claimable any time.

### Graduation

When a buy reaches the top of the last range, the curve is **complete**: it
fills what it can, refunds the rest in the same transaction, and closes to
trading. Anyone may then call `graduate`, which moves the quote reserve and the
reserved base into the token's TOKEN/USDC Uniswap v2 pair and mints the LP to
the dead address.

The pair's address is fixed at launch — a Uniswap v2 pair lives at a CREATE2
address derived from the factory, the two tokens and the pair's init code
hash — and the token refuses transfers into it until graduation. The pair is
only deployed when the curve graduates, so a launch costs about 2.06M gas
rather than 4.57M: most posts never fill, and they no longer pay for a pair
they will not use. Without that lock, anyone could seed the pair at a price of their
choosing before the curve's reserves arrive, and the migration's liquidity
would be minted against that ratio — donating the difference to whoever got
there first.

---


---

## Trade history on Arc

Trades made in the app are recorded from their receipts the moment they land
(a receipt on Arc is final), a single log cursor tails the launchpad for
everything else, and the optional Envio indexer serves full history. A history
the tail has not caught up on is reported as partial.

## Admin powers (all of them)

- `JunoLaunchpad` owner (Ownable2Step): allow a quote token (USDC by default;
  EURC is the only other sensible one), set the default graduator and the
  graduators creators may choose, set the protocol's fee share (≤ 50%, fixed
  per pool at launch), set `maxRaise` (≤ 10M USDC, applies to new launches),
  set the CCIP admin new tokens get, claim protocol fees. It cannot touch a
  pool's reserves, a creator's fees, or a launched curve.
- `JunoTrackers` owner: curate which Chainlink feeds trackers may follow.
- `JunoCrossChain`: no owner. Each coin's creator controls their coin's pool.
- Uniswap v2 factory `feeToSetter`: the Juno owner; the v2 protocol fee stays off.
