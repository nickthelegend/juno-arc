# Juno — Vercel / Live testnet

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted.mjs
node scripts/check-hosted-storage.mjs
node scripts/seed-hosted-storage.mjs
```

Frontend: https://juno-arc.vercel.app (Expo web static export, project `juno-arc`, directory `juno-expo`).
API: https://juno-arc-api.vercel.app (Next.js request/response functions, project `juno-arc-api`, repo root).
Deployment manifest: `deployments/arc-testnet.json`, chain 5042002. No daemon or always-on server is required.
Graduation is a permissionless transaction; optional history indexing is on demand. No transaction was sent in this hosting pass.

Existing Atlas is isolated as `arc_juno_testnet`. Social/media records use Mongo collections. When `DATABASE_URL` is absent, Drizzle queries run in PGlite and the SQL corpus is stored as a compressed, versioned Atlas document.
Writes compare versions and retry on conflict; each instance serializes SQL work. SQL reads use a read-only transaction. A 12 MiB compressed cap makes this a small testnet store; configure managed Postgres for growth.
The migration is applied on first use. Local real-Atlas testing passed eight simultaneous updates, cold reload and mutation rejection in a read-only query. Typecheck and both remote builds pass.
Four existing launches were verified against live receipts and indexed locally into the same managed database; no synthetic trades or new launches were created. Demo media is served from `/demo/` and remains labelled demonstration content.

**External blocker:** Vercel cannot reach the existing Atlas cluster (TLS alert 80; same credentials work locally). The live config endpoint works, but database-dependent catalogue/social APIs fail until Atlas Network Access is corrected for Vercel. This is not a working hosted purchase flow yet.
Mainnet reference feeds are unavailable in the hosted testnet build; the code only permits reference reads through a local mainnet fork. No direct mainnet requests or broadcasts are needed.

API env: `NEXT_PUBLIC_ARC_NETWORK=testnet`, `ARC_RPC_URL`, `NEXT_PUBLIC_ARC_RPC_URL`, `MONGODB_URI`, `MONGODB_DB=arc_juno_testnet`, `JUNO_RELAYER_PRIVATE_KEY`, `JUNO_API_URL`, `JUNO_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `JUNO_MEDIA_BACKEND=mongo`, `PINATA_JWT`, `FAUCET_AMOUNT_USDC`.
Frontend env: `EXPO_PUBLIC_API_URL=https://juno-arc-api.vercel.app`.
Values are read from gitignored files and uploaded via stdin; source database and Pinata credentials are reused without logging. No new database or paid resource was created.
Deploy each linked directory with `vercel deploy --prod --yes`; API and frontend have separate `.vercelignore` files.
Production navigation returned HTTP 200 on 10/10 routes; six routes recorded console errors from unavailable storage. Onboarding navigation works, but does not prove catalogue readiness.
Production browser evidence is saved under `docs/screens/hosted/`; storage errors are retained in the results, not hidden.
