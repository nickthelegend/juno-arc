/**
 * Give the exported web build a title, a description and a link preview.
 *
 * `expo export --platform web` writes an index.html titled "Juno" with no
 * description and no Open Graph tags, so the demo link pasted anywhere — a
 * submission form, a DM to a judge — unfurled as a bare URL. This runs after
 * the export and adds them. A share image is added when EXPO_PUBLIC_OG_IMAGE
 * names one.
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../dist/index.html", import.meta.url);
// No default: a guessed URL would point every unfurl at some other deployment.
// Without one the page simply carries no og:url, which crawlers handle fine.
const app = process.env.EXPO_PUBLIC_APP_URL?.replace(/\/$/, "") || null;
const title = "Juno on Arc — every post is a market";
const description =
  "Post a photo or a reel and it launches its own USDC bonding curve on Arc. Buy into posts you believe in — final before you scroll on; creators earn the fees. Trackers follow Chainlink feeds; coins go cross-chain with CCIP.";
const image = process.env.EXPO_PUBLIC_OG_IMAGE?.trim() || null;

const tags = [
  `<meta name="description" content="${description}" />`,
  `<meta name="theme-color" content="#DCE7D5" />`,
  `<meta name="application-name" content="Juno on Arc" />`,
  `<meta property="og:type" content="website" />`,
  ...(app ? [`<meta property="og:url" content="${app}" />`] : []),
  `<meta property="og:title" content="${title}" />`,
  `<meta property="og:description" content="${description}" />`,
  ...(image ? [`<meta property="og:image" content="${image}" />`] : []),
  `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
  `<meta name="twitter:title" content="${title}" />`,
  `<meta name="twitter:description" content="${description}" />`,
  ...(image ? [`<meta name="twitter:image" content="${image}" />`] : []),
].join("\n    ");

let html = readFileSync(file, "utf8");
html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
if (!html.includes('property="og:title"')) html = html.replace("</head>", `    ${tags}\n  </head>`);
writeFileSync(file, html);
console.log("web meta written");
