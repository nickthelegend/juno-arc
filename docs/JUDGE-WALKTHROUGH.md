# Judge walkthrough (Arc testnet, about 5 minutes)

Everything below runs against the **deployed Arc testnet contracts** (`deployments/arc-testnet.json`), not a fork. Status of each piece is
labelled in the app (Profile → "What runs on Arc") and in [E2E-TESTNET.md](E2E-TESTNET.md).

## Without running anything

1. Open [E2E-TESTNET.md](E2E-TESTNET.md): every transaction of the live run (launch, buy, relayed gasless buy, sell, fee claim, CCTP burn,
   Gateway deposit) links to explorer.testnet.arc.io, with the gas each one paid in USDC.
2. Open the launchpad on the explorer:
   [`0xcE806E4b…0141`](https://explorer.testnet.arc.io/address/0xcE806E4bf02ef60bd960D25a170E97BEc9870141) (see the README for which contracts show verified source).
3. Screens from the real testnet deployment: [`docs/screens/testnet/`](screens/testnet/) (desktop 1280 px and phone 390 px of every route,
   plus the browser launch flow `flow-*.png`).

## Running it (needs Node 22, Postgres, MongoDB; see the README)

1. Start the API against `https://rpc.testnet.arc.io` and serve the web export (README, "Run it against Arc testnet").
2. **Feed** (home): a post with its market cap and a Buy button. Tap **Buy** to open the trade sheet: gas is shown in USDC; after the buy the
   receipt shows the measured submit-to-receipt time (about a second), the gas, the Memo tag and the explorer link.
3. **Profile → Create wallet → Get testnet USDC** (the faucet pays 0.12 USDC from the relayer). One balance is both money and gas.
4. **+ → Post a photo → Launch post**. One transaction deploys the token and opens its USDC curve. With no Pinata key the screen says
   the photo is kept by this server (demo storage), not pinned to IPFS.
5. **Trade → Trackers**: Chainlink prices read from Arc **mainnet**; labelled display-only on testnet (testnet has no feeds).
6. **Profile → What runs on Arc**: each Arc/Circle/Chainlink piece with a tag: *Ran on testnet*, *Fork-proven*, or *Display-only*.

## What you will not see live on testnet

Graduation into Uniswap v2 and CCIP enable/send (a coin needs about $28 of buys to graduate: fork-proven), the Base Sepolia mint of the CCTP
burn, and the Gateway attestation + mint. They are covered by the fork suites and labelled as such everywhere.
