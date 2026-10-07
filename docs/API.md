# Juno API (Arc)

The Next.js server at the repo root is the API for the Expo app in `juno-expo/`.
Every route lives under `/api/juno/`, answers JSON, allows any origin (the app's
web build is served from a different host), and answers `OPTIONS`.

Errors are `{ "error": "<a sentence a person can act on>" }` with a 4xx for a
caller problem (409 when the wallet or the coin's state says no), 503 when the
RPC or a dependency is refusing or a feature is not configured, 500 otherwise.

## Conventions

- **Chain.** Circle's Arc: testnet chain id `5042002` (default), mainnet `5042`
  (`NEXT_PUBLIC_ARC_NETWORK`). Addresses come from the deployment record
  (`deployments/arc-<network>.json`, or `JUNO_DEPLOYMENT_FILE`; the local fork's
  is `.fork/arc-fork.json`).
- **USDC is the only quote** — Circle USDC, the ERC-20 at
  `0x3600000000000000000000000000000000000000`, **6 decimals**. It is also the
  gas token: an account's native balance is the same USDC in **18 decimals**.
  Never add the two. Nothing Juno builds is payable except a CCIP send's fee.
- **Prices, market caps and volumes are in USD = USDC** (`quoteUsdRate: 1`).
  The live USDC/USD peg is reported separately (`GET peg`).
- **`network`** in rows and answers is `"arc-testnet"` or `"arc"` (`config`
  also answers `network: "testnet" | "mainnet"` and `networkKey`).
- **Amounts** are UI units (`1.5` USDC, not base units) unless a field says
  `…Units`, `wei` or `raw`.
- A **coin's id is its token address**; `coin.pool === coin.address`.
- **Finality.** Arc has deterministic sub-second finality: a receipt is final.
  `submit` and every relayed send answer once the receipt is in hand.
- **Honesty.** A figure the server could not measure is `null`, never `0`.

## Transactions

The server builds, the wallet signs, the server submits. Keys never leave the
device.

```ts
type UnsignedTransaction = {
  label: string;               // "Buying", "Allowing Juno to spend USDC", …
  request: {
    type: "eip1559";
    chainId: number;           // 5042002 testnet, 5042 mainnet
    from: `0x${string}`;
    to: `0x${string}`;         // the launchpad, or Arc's Memo contract for a tagged trade
    data: `0x${string}`;
    value: `0x${string}`;      // hex wei (18-dec native USDC); 0x0 except a CCIP fee
    nonce: number;
    gas: `0x${string}`;
    maxFeePerGas: `0x${string}`;
    maxPriorityFeePerGas: `0x${string}`;
  };
};
```

Build routes return `steps: UnsignedTransaction[]` with consecutive nonces:
sign every step, then submit them **in order**, each after the previous
`submit` answered. A first buy is two steps (USDC `approve`, then the buy).

```ts
type SubmitResult = {
  hash: `0x${string}`;
  status: "success";            // a revert is a 422 with the decoded reason
  blockNumber: number;
  from: `0x${string}`;
  confirmMs: number;            // broadcast → final receipt, measured by the server
  confirmedInMs: number;        // same figure (older clients)
  explorerUrl: string;          // https://explorer.testnet.arc.io/tx/<hash>
  trades: number;
  trade?: { token, side, baseAmount, quoteAmount, fee, price, venue: "curve" | "uniswap-v2" };
  launched?: { token, pair, creator };
  graduated?: { token, venue };
  completed?: string[];         // curves this transaction filled
  memo?: { id, line, sender, target };          // the Arc Memo the tx emitted
  cctp?: { token, destinationDomain, mintRecipient, amount, maxFee };  // CCTP fee burn
  ccipMessageId?: `0x${string}`;                // Chainlink CCIP send
  ccipExplorerUrl?: string;                     // https://ccip.chain.link/msg/<id>
  ccipEnabled?: { token, pool };                // coin made a CCIP Cross-Chain Token
};
```

### Arc Memo

Curve buys and sells, and the launch call of a launch with a first buy, are
sent through Arc's Memo contract (`0x5294…e505`) when the node runs it: the
launchpad still sees the wallet as the caller, and the chain records
`Memo(sender, target, callDataHash, memoId, memo, memoIndex)` with
`memoId = keccak256("juno:post:" + lowercase token)` and a line such as
`"juno buy $MARINA 25 USDC"`. Whether Memo runs is probed once per process
(`config.arc.memo.live`); where it doesn't, the same call goes out plain and
`memo.tagged` is `false`. Approvals and router (v2) trades are always plain.

| Route | Body | Answer |
|---|---|---|
| `POST tx/swap` | `{ token, owner, side: "buy"\|"sell", amountIn, slippageBps? }`; a curve buy may send `amountOut` (exact tokens) instead; a sell may send `sellFraction` (0–1 of the holding) | `{ steps, window: { deadline }, quote: { amountOut, minimumAmountOut, amountUsed, fee, priceImpact, curveImpact, amountIn?, maximumAmountIn? }, quoteSymbol: "USDC", quoteUsdRate: 1, venue: "curve"\|"uniswap-v2", pair?, memo: { id, tagged, line? }, token, symbol }`. A graduated coin trades against its TOKEN/USDC pair through `JunoSwapRouter.swapExactTokens` |
| `POST tx/buy-intent` | `{ token, owner, amountIn, slippageBps? }` | `{ typedData: { domain: { name: "USDC", version: "2", chainId, verifyingContract: USDC }, types, primaryType: "ReceiveWithAuthorization", message: { from, to: launchpad, value, validAfter: "0", validBefore, nonce } }, intent: { token, buyer, quoteIn, minBaseOut, deadline, salt }, quote: { amountOut, minimumAmountOut, price, fee, priceImpact }, relayer }` — 409 when the wallet lacks the USDC, or the buy would fill the curve. `nonce = launchpad.buyNonce(token, buyer, quoteIn, minBaseOut, deadline, salt)`; uint256s are decimal strings |
| `POST tx/buy-relayed` | `{ intent, signature }` | `SubmitResult` + `{ gasless: true, relayer, memoTagged }` — the signature is checked first; Juno's relayer submits `buyWithAuthorization` (Memo-wrapped when live) and pays the gas; the coin goes to the buyer |
| `POST tx/launch` | `{ creator, name, symbol, preset, uri?, initialMarketCap?, migrationMarketCap?, firstBuy?, tracker?: { feed: "BTC/USD", unitsPerToken } }` — caps are USD; default $1k opening × the preset's range | `{ steps, token, launchpad, migrationQuoteThreshold, memo, tracker?: { feed, feedId, priceUsd, unitsPerToken, openingPriceUsd, onchain, source } }`. A tracker uses `preset: "tight-nav"` and opens at Chainlink price × unitsPerToken; when this network's `JunoTrackers` has the feed (mainnet), a `track(token, feedId, unitsPerTokenE18, bandBps)` step is appended |
| `POST tx/claim` | `{ creator, token }` | `{ steps }` — fees to the creator on Arc |
| `POST tx/claim` | `{ creator, token, destinationDomain, recipient?, fast? }` | `{ steps, cctp: { destinationDomain, destination, amount, maxFee, finalityThreshold, mintRecipient, tokenMessenger } }` — `claimCreatorFeesCrossChain` through Circle CCTP V2; `recipient` defaults to the creator (EVM address; for Solana a base58 account or 32-byte hex); `fast` → threshold 1000 and `maxFee` from Iris, else 2000 |
| `POST tx/graduate` | `{ from, token }` | `{ steps }` — anyone may graduate a filled curve |
| `POST tx/ccip-enable` | `{ token, creator }` | `{ steps }` — `JunoCrossChain.enable(token, <BurnMintTokenPool 2.0.0 code>, [])`; creator only, after graduation |
| `POST tx/ccip-chains` | `{ token, creator, add: [{ selector, remotePool, remoteToken, capacity?, rate? }], remove?: [selector] }` | `{ steps }` — `JunoCrossChain.applyChainUpdates`; limits always on (default 50M tokens, 13k/s; capped at 100M) |
| `POST tx/ccip-send` | `{ token, owner, amount, destination: "<selector>", receiver? }` | `{ steps, fee: { usdc, wei }, lane: { selector, name, evm }, receiver, amount, explorer }` — Router approval when needed, then `ccipSend` with the fee as `value` (native USDC, 1% over the quote). 409 if the coin isn't enabled or the lane isn't wired |
| `POST tx/submit` | `{ signed: "0x…" }` | `SubmitResult` |
| `GET tx/balance` | `?wallet=&token=` | `{ wallet, token, symbol, decimals, balance, raw }`; `token=0x000…0` is the native USDC balance (18 decimals, `native: true`) |
| `GET tx/status` | `?hash=` | `{ hash, status: "confirmed"\|"reverted"\|"pending"\|"unknown", final, blockNumber, explorerUrl }` |
| `GET tx/cost` | `?hash=` | `{ hash, blockNumber, localFork, arc: { gasUsed, gasLimit, billed: "used", gasPriceGwei, feeUsdc, feeUsd }, ethereum: { gasPriceGwei, feeEth, feeUsd, ethUsd, ethUsdSource, … } \| null }` |

`window.deadline` is unix seconds; a swap signed after it reverts with
`Expired`, so the app re-quotes.

## Circle Gateway, CCTP and the faucet

| Route | Body / query | Answer |
|---|---|---|
| `GET gateway` | `?depositor=` | `{ available, depositor, total, totalUnits, balances: [{ domain, name, balance, balanceUnits }], wallet, minter, sources: [{ domain, name, usdc }] }` from Circle's `/v1/balances` |
| `POST gateway/deposit` | `{ owner, amount }` | `{ steps }` — `USDC.approve(GatewayWallet)` when needed + `GatewayWallet.deposit(USDC, amount)` on Arc |
| `POST gateway/intent` | `{ depositor, sourceDomain, recipient?, amount }` | `{ typedData: { domain: { name: "GatewayWallet", version: "1" }, types, primaryType: "BurnIntent", message }, maxFee, maxFeeUnits }` |
| `POST gateway/mint` | `{ burnIntent: typedData.message, signature }` | `{ status: "minted", mintTxHash, explorerUrl, amount, amountUnits, recipient, transferId, confirmMs }` — Circle attests, the relayer calls `GatewayMinter.gatewayMint` |
| `GET cctp/status` | `?hash=` | `{ status: "pending"\|"complete"\|"unknown", attestation?, message?, destinationDomain, destination, note?, iris }` from Iris; a burn on Arc that Iris hasn't attested is `pending` |
| `GET faucet` | — | `{ address, balance, amount, symbol: "USDC", externalFaucet }` (testnet only) |
| `POST faucet` | `{ address }` (or `{ wallet }`) | `{ hash, amount, symbol, explorerUrl, confirmMs, externalFaucet }` — `FAUCET_AMOUNT_USDC` from the relayer, once per address per day; every answer, refusals included, carries `externalFaucet: "https://faucet.circle.com"` |

## Chainlink

| Route | Answer |
|---|---|
| `GET trackers` | `{ network: "mainnet", appNetwork, source: "Chainlink Data Feeds on Arc mainnet", trackers, feeds: [{ id: "BTC/USD", feedId, address, priceUsd, updatedAt, ageSeconds, stale, onchain }] }` — 10 feeds (BTC, ETH, SOL, LINK, PAXG, EUR, JPY, AVAX, XRP, BNB), cached 30 s; `stale` past 25 h |
| `GET peg` | `{ usdcUsd, updatedAt, ageSeconds, stale, source: "Chainlink USDC/USD on Arc mainnet", feed }` |
| `GET ccip/{token}` | `{ token, enabled, pool, handedOver, chains: [{ selector, name, remoteToken, remotePools, outbound: { tokens, capacity, rate, isEnabled }, inbound }], bridgedOut, ccipAdmin, registryPool, graduated, canEnable, lanes, crossChain, router, explorer }` |
| `GET ccip/message` | `?id=` → `{ messageId, state, sourceChain, destChain, receiptTransactionHash, url }` (Chainlink's CCIP explorer, best effort) |

A tracker coin's `coin.nav` is a `NavReference`: `{ feed, priceUsd, deviation,
updatedAt, bandBps, withinBand, impliedUsd, unitsPerToken, state: "live" |
"stale", ageSeconds, source: "chainlink", sourceLabel: "Chainlink BTC/USD on Arc
mainnet", feedAddress, attested }`, where `attested` is `JunoTrackers.mark` when
the coin is tracked on chain (else null). `coin.reference` is
`{ source: "chainlink", id: "BTC/USD" }` or null.

## Configuration

`GET config` →

```json
{ "network": "testnet", "networkKey": "arc-testnet", "chainId": 5042002, "rpcUrl": "…", "localFork": false,
  "explorer": "https://explorer.testnet.arc.io", "usdc": "0x3600…", "launchpad": "0x…",
  "contracts": { "launchpad", "swapRouter", "crossChain", "trackers", "graduator", "uniswapV2Factory", "uniswapV2Router02" },
  "deployBlock": 0, "quoteTokens": [{ "address": "0x3600…", "symbol": "USDC", "decimals": 6, "native": false }],
  "faucet": true, "v2Trading": true, "venues": [{ "id": "uniswap-v2", "name": "Uniswap v2", "quotes": ["0x3600…"] }],
  "arc": {
    "finality": "sub-second, deterministic", "gasToken": "USDC",
    "memo": { "address": "0x5294…", "live": true },
    "gateway": { "available": true, "wallet": "0x…", "minter": "0x…", "domain": 26, "sources": [{ "domain": 6, "name": "Base Sepolia" }] },
    "cctp": { "domain": 26, "tokenMessenger": "0x…", "destinations": [{ "domain": 6, "name": "Base Sepolia" }] },
    "ccip": { "router": "0x…", "chainSelector": "3034092155422581607", "crossChain": "0x…",
              "lanes": [{ "selector": "10344971235874465080", "name": "Base Sepolia" }], "explorer": "https://ccip.chain.link" },
    "feeds": { "network": "mainnet", "count": 10 },
    "relayer": { "available": true, "address": "0x…" } } }
```

`localFork` is true when the server's RPC is a node on its own machine: timings
measured there are the fork's, and the app says so rather than crediting Arc.

## Coins

| Route | Notes |
|---|---|
| `GET coins` | `?limit&sort=marketCap\|graduating\|memes&social=1&viewer=&nav=1` → `{ network, coins: Coin[] }` |
| `GET coins/{token}` | `{ network, coin, activity, holders, holdersSource, crowd, launchTx }` |
| `GET depth` | `?token=&side=&impact=` |
| `POST pools` | Index a launch after `submit` confirmed it: `{ token, name, symbol, description?, format, curvePreset, mediaUrl?, posterUrl?, mediaMime?, mediaWidth?, mediaHeight?, navFeedId?: "BTC/USD", navUnitsPerToken?, createTx }`. The server re-reads the pool and the launch receipt before recording anything; a tracker's ratio is taken from `JunoTrackers` when tracked on chain, else checked against the curve's opening price |
| `GET pools` | The registry. |
| `POST metadata` | Pins token metadata JSON to IPFS (`PINATA_JWT`). |
| `POST upload` | Multipart media upload to IPFS. Video gets a poster frame. |
| `GET live` | `?token=&tx=` — the live trade tape from the node's WebSocket; every event is final when it appears (`stages.Finalized`) |
| `GET heartbeat` | `{ latestBlock, blockMs, window, finality, localFork, confirmations }` — Arc's block cadence measured from the chain, and the server's own confirmation times |
| `GET stats`, `GET index` | Landing-page figures; one step of the launchpad log tail |

## Social

| Route | Body / query |
|---|---|
| `GET/POST comments` | `?coin={token}` / `{ token, wallet, body, side?, txHash? }` |
| `GET/POST likes` | `?coins=a,b&viewer=` / `{ token, wallet, liked }` |
| `GET/POST follow` | `?wallet=&viewer=` / `{ follower, target, following }` |
| `GET/POST posts` | `{ author, body, token?, parentId?, mediaUrl?, mediaMime? }` |
| `GET posts/{id}` | A post, its replies and its coin. |
| `GET saved` | `?wallet=&token=` |
| `GET/POST watchlist` | `{ wallet, token, alertPrice? }` |
| `GET/POST/PATCH/DELETE plans` | `{ wallet, token, amount, cadence, target? }`; `PATCH { id, contributed, txHash }` (a gasless buy counts: its `Trade` names the buyer) |
| `GET/POST profiles` | `?wallets=` → `{ names }` / `{ wallet, name, issuedAt, signature }` (EIP-191) |
| `GET/POST profiles/{wallet}` | the profile page in one read / `{ bio, link, issuedAt, signature }` |
| `GET notifications` | `?wallet=` |
| `GET feed` | `?limit&following=` |
| `GET leaderboard` | `?limit` |
| `GET portfolio/{wallet}` | Holdings, cost basis and P&L, in USDC. |

Removed from the Monad API: `kuru/*`, `perps/*`, `autopilot/*`, `tessera`,
`staking`, `profiles/privy`, `drafts`; `profiles` no longer answers
`identities`, and `tx/status` no longer reads a txpool.
