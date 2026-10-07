/**
 * At server start: warm the feed's pictures in the background.
 *
 * `register` must finish before the server takes requests, so the warm-up is
 * only scheduled here, never awaited. The landing page also asks for it
 * (`/api/juno/stats`); this covers someone whose first visit is a deep link
 * into the feed. Node.js only, and never during `next build`.
 */
export async function register() {
  // The import sits inside the `nodejs` branch (not after an early return) so the
  // edge compile of this file drops it: media-warm reaches pg and node:fs.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { warmListedMedia } = await import("./lib/juno/media-warm");
    const timer = setTimeout(() => warmListedMedia(), 3_000);
    timer.unref?.();
  }
}
