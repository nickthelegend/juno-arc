LEAD: RUN THESE
- `node scripts/e2e-browser-video-5min.mjs` (from this repo in the shared Arc workspace)
- `node ../video/scripts/render-5min-A.mjs juno-5min`

Five-minute mainnet demo: `../video/out/juno-5min.mp4`, timeline JSON, narration JSON and REVIEW beside it.
300 seconds, 1920×1080, 30 fps; 686 narration words supplied as text. No voice generated.
Post-render check: 14 successful receipts, 0 intentional failures; exact fees verified.
Hosted page and explorer browser checks passed. Receipt proof: [DEMO-5MIN-RECEIPTS.json](DEMO-5MIN-RECEIPTS.json).
- Hosted UI, isolated local API/database/media, same mainnet contracts.
- Photo upload forwarded as original local file bytes after browser proxy omitted multipart content.
- Gasless buyer balance fell by exactly 0.02 USDC.
- Both buyers sold all tokens; available USDC swept.
- No generated voice or paid API.
Hosted feed returned HTTP 500; recording uses isolated local Mongo storage and local-only media URIs.
Existing browser-audit refresh was preserved separately, including its original hosting errors.
