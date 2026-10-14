These are demonstration assets, not user activity or mock market data.
The three typographic PNGs and the one-second video test pattern were uploaded
through Playwright and launched as real Arc testnet tokens. Their verified
creation receipts are in testnet-launches.json and docs/screens/testnet/round2/transactions.json.

`node scripts/seed-testnet-feed.mjs` uploads these assets and lists the existing
contracts on a fresh API. The API checks each Launched event and creator on Arc
testnet; it does not manufacture contracts, holders, prices, or trades.
