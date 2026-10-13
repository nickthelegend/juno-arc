import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Demo storage: the upload path when no Pinata key is configured.
 *
 * Pinning to IPFS needs a Pinata account (`PINATA_JWT`). Without one the app
 * used to refuse every launch. Instead, the server keeps the bytes itself,
 * on disk, under their real IPFS content address: a CIDv1 (raw codec,
 * sha2-256) — the CID `ipfs add --cid-version 1 --raw-leaves` prints for a
 * file this size. So the address is honest and the content is verifiable, but
 * **nothing is pinned to the IPFS network**: only this server serves it (at
 * `/api/ipfs/<cid>`). The app says so wherever it shows the receipt, and
 * `/api/juno/config` reports `storage: "local"`.
 */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1, raw codec (0x55), sha2-256, base32 — `bafkrei…`. */
export function rawCid(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

/** True when uploads and metadata go to this server's own disk instead of Pinata. */
export function localStorageMode(): boolean {
  return !process.env.PINATA_JWT?.trim();
}

function dir(): string {
  return path.resolve(process.env.JUNO_MEDIA_DIR?.trim() || ".juno/media");
}

/** The public base URL of this API for links to stored files: `JUNO_API_URL` if set, else the request's own origin. */
export function publicOrigin(request: Request): string {
  return process.env.JUNO_API_URL?.trim() || new URL(request.url).origin;
}

export type LocalPin = { cid: string; uri: string; url: string };

export async function storeLocal(bytes: Uint8Array, type: string, origin: string): Promise<LocalPin> {
  const cid = rawCid(bytes);
  await mkdir(dir(), { recursive: true });
  await writeFile(path.join(dir(), cid), bytes);
  await writeFile(path.join(dir(), `${cid}.type`), type);
  return { cid, uri: `ipfs://${cid}`, url: `${origin.replace(/\/$/, "")}/api/ipfs/${cid}` };
}

export async function readLocal(cid: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!/^b[a-z2-7]{58}$/.test(cid)) return null;
  try {
    const bytes = new Uint8Array(await readFile(path.join(dir(), cid)));
    const type = (await readFile(path.join(dir(), `${cid}.type`), "utf8").catch(() => "application/octet-stream")).trim();
    return { bytes, type };
  } catch {
    return null;
  }
}
