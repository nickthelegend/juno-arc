# Product quality round 2 — 2026-10-14

## LEAD: RUN THESE

```sh
npm run build && (cd juno-expo && EXPO_PUBLIC_API_URL=http://127.0.0.1:8911 npm run export:web)
node scripts/e2e-browser-juno-local.mjs
# Explicit opt-in for a fresh funded browser run (0.60 USDC, state/keys stay gitignored):
JUNO_BROWSER_RUN=round3 JUNO_BROWSER_WRITE=1 node scripts/e2e-browser-juno-local.mjs --flow
JUNO_BROWSER_RUN=round3 JUNO_BROWSER_WRITE=1 node scripts/sweep-browser-juno.mjs
# Re-list the four existing real launches on a fresh API; no blockchain writes:
JUNO_API_URL=http://127.0.0.1:8911 node scripts/seed-testnet-feed.mjs
```

The local runner uses the configured Postgres database and Mongo, starts missing services on 8910–8913,
and stops only processes it starts. It requires the existing local dependencies/builds and Circle Arc Foundry.
Do not run it alongside another fork/dev server. Application transactions use **live Arc testnet**; Chainlink
reference prices in this run were read through a **local Arc mainnet fork**. No mainnet broadcasts.

## Scores / 10

Round-1 awarded 8 in all four criteria. Round-2's *before* reassesses the cold-start product and hosting restrictions.

| Criterion | Round-2 before → after | Reason |
|---|---|---|
| Relevance to Arc | 8 → 8 | USDC quotes/gas, Memo and signature buys are product features, exercised live. |
| Technical credibility | 8 → 9 | Browser-signed launch/buy/sell/claim receipts, exact gasless balance proof, durable media after process restart, portable receipt-verified seeds. |
| Build quality | 6 → 8 | Fixed cold-start storage visibility, wallet/funding detours, inaccessible fields, testnet sizing, misleading copy and navigation. Every route at 1440/390; public Vercel deployment is still a hosting handoff. |
| Worth taking further | 7 → 8 | The first session now works and has real content. Mainnet rollout, funding controls and interoperability still need work. |
| Cold-judge usability (extra) | 5 → 8 | Four new real launches, image/video uploads, clear testnet provenance, prominent gasless choice and one-command checks. A public URL is still needed. |

## Findings and fixes

| Severity | Before | After |
|---|---|---|
| P0 | Disk-only demo media is lost or unwritable on Vercel. | Reuses the existing Mongo DB on Vercel, with local opt-in. Uploaded metadata/image survived API process restart; byte ranges returned 206. No paid resources. |
| P1 | Unpinned `ipfs://` token metadata cannot resolve outside the app. | Demo uploads return their actual content-addressed HTTP(S) URL; Pinata mode retains IPFS. Set the public `JUNO_API_URL` before hosted launches. |
| P1 | Cold `/post` often omitted the demo-storage notice because config loading did not re-render it. | Reactive config read; notice visible on direct visits, before upload. |
| P1 | 25MB picker promise exceeds Vercel function request limits. | Client/server share a 4MB limit with a useful rejection message. |
| P1 | New creator had to leave the composer to create/fund a wallet. | Inline Create wallet / Get testnet USDC actions; tested in the browser. |
| P1 | First-buy presets were $1/$5/$10 against a tiny testnet faucet. | Testnet presets None/$0.01/$0.05/$0.10; real launches used $0.01. |
| P1 | Name/ticker/caption had visual text but no accessible input names. | Explicit labels, used by the browser flow. |
| P1 | Gasless choice sat below the long quote breakdown. | Visible near the top; receipt shows gas to buyer $0. Buyer balance changed by exactly 0.01 USDC. |
| P1 | Tracker intro claimed on-chain marking on testnet; feed board said live. | Display-only labels in board, intro and composer; no on-chain NAV/band-enforcement promise. |
| P1 | A direct route visit could look like mainnet. | Persistent Arc testnet / no-real-money strip across deep links. |
| P2 | Trade opened on an empty tracker list. | Opens on the real post markets; Trackers remains explicitly display-only. |
| P2 | Feed had only three older test posts; Reels was empty without an action. | Three photo launches plus one labelled test-pattern reel, all on-chain; empty Reels also has a working Post a reel CTA. |
| P2 | Search Cancel did nothing on a cold deep link; failed reads looked like zero markets. | Cancel returns to feed, and failed reads show Retry. |
| P2 | Creator profile called aggregate market cap “coins worth”. | Explicit “launched market cap”; not wallet wealth or realizable proceeds. |
| P2 | Relayer configuration claimed “funded”; faucet promised enough money unconditionally. | Configured/requires gas wording and conditional faucet copy. |

No simulated transactions, fake holders/volume, or invented prices were introduced. The PNG demonstration cards and
one-second video test pattern are **labelled demonstration media**, attached to real contracts. Existing unit-test mocks
remain confined to tests. Unavailable claims/withdrawals are disabled with their balance state, not presented as working stubs.

## Verification and evidence

- Core flow: browser wallet creation → faucet → upload/metadata → three photo launches with first buys, a reel launch,
  signature buy, signed buy, sell all ONEARC holdings, creator fee claim. All receipts succeeded on chain 5042002.
- Reel: actual video upload, server poster generation, browser playback (`readyState >= 2`).
- Social: profile name/bio save, comment and linked launch announcement; watch, alert creation/removal, schedule creation/pause/removal, reply and follow also passed.
- Read-only browser suite: all route families, including valid/invalid post, unknown route, tracker/reel composer, trader,
  search, inbox, Arc evidence page; desktop 1440 and mobile 390. 36 route/viewport checks plus signed-in tabs passed; checks overflow, browser/console errors, unexpected HTTP errors, broken images and stale-chain copy.
- API/server: 407 unit tests, 11 integration tests passed / 1 skipped. Contracts: 85 passed / 2 fork-gated skipped.
- Root and Expo typechecks, Biome lint, Next production build and Expo web export passed. Fresh local runner startup/cleanup passed. Mechanical design detector: no findings on changed primary surfaces.
- Screens and machine-readable receipts: [round2 evidence](screens/testnet/round2/), [transactions](screens/testnet/round2/transactions.json), [routes](screens/testnet/round2/routes.json).
- [E2E-TESTNET.md](E2E-TESTNET.md) records explorer links and budget. Throwaway key and recovery state remain in gitignored `.juno/browser-round2/`.

## Still weak / explicitly not claimed

1. **Vercel hosting not run in this pass.** The deleted Railway URLs are not proof of a live app. This pass used the local web
   export and API against real testnet. The hosting lead must supply an isolated managed Postgres DB/schema and Mongo DB,
   deploy the API and Expo export to Vercel, and run the included receipt-verified seed restore. No always-on indexer is needed
   for the tested flow. No Railway or other paid resources were created.
2. Local test launches necessarily have local API tokenURI origins. Their images are recoverable through the fixture/seed script,
   but their immutable tokenURI cannot be rewritten for a hosted explorer. Set the public API origin before new hosted launches;
   Pinata is optional, demo storage remains labelled.
3. Graduation and CCIP delivery remain **Fork / Not run live**; CCTP destination mint and Gateway cross-chain mint remain **Not run**.
   Trackers have no registered testnet feeds and cannot enforce the mainnet price on chain.
4. Device-key wallets and process-local faucet/rate limits are testnet conveniences, not production custody or abuse protection.
   Social attribution is still permissive; this round is not a security audit. The seed media is demonstration content, not an organic community.

---

## Archived round-1 report

# Judge report: Juno on Arc

Strict pass as an Arc Microgrants judge (relevance to Arc, technical credibility, quality of what was built, worth taking further),
then the fixes. Run 2026-10-13/14 against the **deployed Arc testnet contracts** (`deployments/arc-testnet.json`, chain 5042002),
with real transactions. Nothing was run on Arc mainnet.

## Scores

| Criterion | Before | After | Why |
|---|---|---|---|
| Relevance to Arc | 8 | 9 | Before: USDC gas/quote, Memo, CCTP, Gateway, EIP-3009, CCIP and Data Feeds, but shown as "LIVE" without anything having run on testnet. After: each piece is tagged *ran on testnet*, *fork-proven* or *display-only*, and the pieces that run on testnet (USDC gas, Memo, gasless EIP-3009, a CCTP burn that Circle's Iris attested, a Gateway deposit) have transactions behind them. CCIP and graduation are still fork-only. |
| Technical credibility | 6 | 8 | Before: the copy contradicted the chain: "final in under a second" (measured 1.1–1.3 s end to end), "gas about a tenth of a cent" (a buy cost 0.4 cent, a launch 6 cents), "LIVE" badges that only meant "configured", Chainlink trackers presented as live on a chain that has no feeds, Gateway "in seconds" never run. Contracts unverified on the explorer. After: every number is measured, every claim is labelled, the launchpad's source is verified on the explorer, two full live runs are recorded. Still missing: live graduation, live CCIP, and the other four contracts' source verification (see below). |
| Quality of what was built | 7 | 8 | Before: a polished app, 24 routes clean at desktop and 390 px, but **Launch did not work without a Pinata key** (upload and metadata returned 503, the launch button dead-ended). After: launch works cold through the browser with a clearly labelled demo-storage fallback; 405 unit tests (5 new, for demo storage), 85 Foundry tests, lint and both typechecks clean. |
| Worth taking further | 7 | 8 | A real product shape with a mainnet path (`MAINNET.md`) and a repeatable live e2e (`scripts/e2e-testnet.mjs`). Weak: no public deployed instance for a judge to open, graduation and CCIP never exercised live, and a judge must run Postgres + Mongo to try it. |

## 1. Claims audit

Sources: README.md, SUBMISSION.md, JUNO.md, docs/API.md, and the app's own copy (landing, `/arc` "What runs on Arc", trade sheet,
receipts, tracker board, wallet and gateway cards, launch screen). `docs/JUDGE-WALKTHROUGH.md` did not exist; it is new.

| Claim (where) | Verified on | Verdict and fix |
|---|---|---|
| USDC is the gas token and the quote; one balance | **Live testnet**: launch, buys, sell, claims all paid gas in USDC | True. |
| "Final in under a second" (README, SUBMISSION, JUNO, landing, trade sheet, launch screen, `/arc`, API config `finality`) | Live testnet: blocks every ~0.5 s, but 1.1–1.3 s from submit to receipt through our server | **Overstated. Reworded** everywhere to "about a second" / "~0.5 s blocks, measured 1.1–1.3 s". The `finality` string in `/api/juno/config` and `/api/juno/heartbeat` is now `deterministic, ~0.5 s blocks`. |
| "Gas about a tenth of a cent" / "≈ $0.001" (trade sheet, wallet card, receipt fallback, `/arc`, README) | Live testnet: buy 0.0040 USDC, relayed buy 0.0049, sell 0.0042, launch 0.0625, approval 0.0014 | **False. Fixed** to "about $0.004" (buy), "under half a cent". |
| `/arc` badges said **LIVE** for every piece | The badge only read "is it configured on this server" | **Misleading. Renamed CONFIGURED** and added a per-piece tag on testnet: *RAN ON TESTNET*, *FORK-PROVEN* or *DISPLAY-ONLY* with the one-line evidence. |
| Arc Memo tags every curve trade | **Live testnet**: launch, buy, sell and relayed buy all Memo-tagged (Memo is live there) | True. |
| Gasless buys (EIP-3009, relayer pays gas) | **Live testnet**: one relayed buy; the buyer paid exactly the trade and no gas | True. |
| CCTP V2 creator-fee withdrawal | **Live testnet**: real `depositForBurn` toward Base Sepolia (0.003472 USDC), attested by Circle's Iris sandbox (`complete`). The Base Sepolia mint was **not** run | True up to the burn + attestation; the mint is user-run. README and SUBMISSION now say exactly that. |
| Circle Gateway "spend it here and it lands on Arc in seconds" | **Live testnet**: deposit from Arc only (0.02 USDC, `availableBalance` read back). Attestation and mint **not run** | **Overstated. Reworded** (removed "in seconds", labelled in the README). |
| Chainlink CCIP Cross-Chain Tokens: enable in one transaction, send to Base/Ethereum | Contracts deployed on testnet; enable and `ccipSend` are **fork-proven** (a coin must graduate first) | Not run live. Labelled **fork-proven** in README, SUBMISSION, JUNO and the app. |
| Graduation into a locked Uniswap v2 pair | Factory/router **deployed** on testnet from published bytecode; graduation (needs about $28 of buys) is **fork-proven** only | Labelled fork-proven. Not run live. |
| Chainlink Data Feeds: trackers "recorded on chain" and "live" | Feeds exist on Arc **mainnet only** (`feedsRegistered: 0` on testnet). The API reads the 10 mainnet feeds; verified in a mainnet fork | **Fixed**: the Trackers tab, tracker board and coin page say *display-only on testnet, mainnet prices, not marked on chain*; "Chainlink on Arc testnet" title removed. |
| "Uploads/pins to IPFS" on launch | Needs Pinata (not configured here) | **Fixed**: demo storage fallback, labelled "stored on this server, not pinned to IPFS" in the launch screen and receipt; `/api/juno/config` reports `storage`. |
| "85 Foundry tests / 388 unit tests" | Re-run: 85 passed + 2 fork-gated skipped; 405 unit tests passed | README counts updated. The fork suites (10) were not re-run in this pass. |
| "Slither: no medium/high" | Not re-run in this pass | Left as dated 2026-10-08. |
| "Verify contracts on the explorer" (brief) | `JunoLaunchpad` now verified on explorer.testnet.arc.io. The other four Juno contracts are scripted (`VERIFY=1 sh scripts/deploy.sh testnet`) but Blockscout's keyless rate limit refused them in this session | Stated in the README table per contract. |
| Slither / audited / production wording | None found in app or docs | No change needed. No "audited" claim anywhere. |

## 2. Mocks audit

`grep` of `app/`, `lib/`, `juno-expo/{app,components,lib}` for mock, stub, fake, placeholder, sample, demo, lorem, TODO, hard-coded and
simulated, minus UI placeholders and code comments: **no mock data, no TODOs, no simulated responses, no stubbed buttons.** Findings:

- "Launch" returned 503 without Pinata: **fixed** with labelled demo storage (`lib/juno/local-media.ts`; CIDv1 raw/sha2-256, verified against the
  known empty-file CID; no SVG uploads; served from `/api/ipfs/<cid>`; 5 new unit tests).
- The `/arc` screen's static "LIVE" semantics: fixed (above).
- Trade sheet, wallet card and receipt fallback carried a hard-coded gas figure ($0.001): now $0.004 from measurement.
- The profile's "Example: a creator on Juno" card shows a real creator read from the feed and is labelled as an example.
- Reels: empty state ("No reels yet") on testnet because no reel has been posted; the video upload path itself (ffmpeg poster, demo storage) was
  exercised through the API but no reel was launched on chain.

## 3. Screens audit (real testnet deployment)

Web export pointed at the API on `https://rpc.testnet.arc.io`, Playwright Chromium, **12 routes × 2 viewports (1280 px and 390 px)**: `/`,
`/social`, `/trade`, `/post`, `/reels`, `/profile`, `/arc`, `/inbox`, `/search`, `/coin/<token>`, `/trader/<wallet>`, an unknown route.
Checks per page: console errors, HTTP ≥ 400 responses, broken images, horizontal overflow, and text matching Monad / MON / AUSD / Kuru / Privy /
Mera / lorem / `undefined` / `[object` / localhost / the old explorer. **Result: 0 problems on all 24** (the only match was the substring "nan"
inside ordinary words). Explorer links resolve to `explorer.testnet.arc.io` (coin Details → "View the token on Arc's explorer"; `/api/juno/config`
`explorer`). Screens: [`docs/screens/testnet/`](screens/testnet/) (`<route>-desktop.png`, `<route>-mobile.png`, `flow-1…4` for the browser launch).

Screen issues found and fixed: the Trackers tab said "Chainlink on Arc mainnet … live" on a testnet app with no note that nothing is marked on
chain; the Create screen had no explanation of where photos go without Pinata; the landing/launch/trade copy contradicted the measured finality
and gas (above).

## 4. Feature check (real transactions)

Budget 2 USDC. Net spend from the deployer is about 1.1 USDC (relayer 0.4 + faucet pool, throwaway accounts funded 0.65 and swept back after each
run). Full tables with explorer links: [E2E-TESTNET.md](E2E-TESTNET.md).

| Flow | Result |
|---|---|
| Launch a post coin (upload + metadata + first buy, Memo-tagged) | passed, twice |
| Buy, Memo-tagged | passed, twice |
| Gasless relayed buy | passed, twice (buyer paid exactly the trade) |
| Sell | passed, twice |
| Creator fee claim on Arc | passed, twice |
| CCTP V2 burn to Base Sepolia | passed; Iris attestation `complete`; the Base Sepolia mint is user-run |
| Gateway deposit from Arc | passed; attestation/mint not run |
| Browser: create wallet → faucet → pick photo → Launch | passed (Playwright, 390 px), coin `0x8800…114f` |
| Graduation, CCIP enable/send | **not run live (fork-proven)** |
| Chainlink feeds on testnet | **display-only (no feeds on testnet)** |

## 5. What changed

- `lib/juno/local-media.ts`, `app/api/juno/upload`, `metadata`, `app/api/ipfs/[cid]`, `config` (`storage`), Create screen note: launch works with no Pinata key.
- App copy: finality, gas, Gateway, trackers, `/arc` badges and proof tags (see the claims table).
- `scripts/e2e-testnet.mjs`, `docs/E2E-TESTNET.md`, `docs/e2e-testnet.json`, `docs/JUDGE-WALKTHROUGH.md`, `docs/screens/testnet/`.
- README / SUBMISSION / JUNO / API docs reworded to what is true; "Deployed on Arc testnet" and "Run it against Arc testnet" sections added.
- `JunoLaunchpad` source verified on the testnet explorer.

## 6. Still weak

1. No public deployed instance: a judge has to run Postgres, MongoDB, the API and the web export locally.
2. Graduation and CCIP enable/send have never run on Arc testnet (the CCIP contracts are deployed; the fork suites are the only proof).
3. The CCTP mint on Base Sepolia and the Gateway attestation + mint are untested live.
4. Four of five Juno contracts are not source-verified on the explorer (rate-limited here); re-run `VERIFY=1 sh scripts/deploy.sh testnet` or
   `forge verify-contract … --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/`.
5. Finality is 1.1–1.3 s end to end as measured through the API; a client talking to the RPC directly was not timed.
6. Demo storage is not IPFS pinning: set `PINATA_JWT` before showing this to anyone who will open the image URL from another machine.
7. The relayer/faucet holds only a few cents of testnet USDC; the faucet will answer "empty" once it is spent.
