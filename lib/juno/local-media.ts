import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Demo media when Pinata is not configured. Bytes use a CIDv1 raw SHA-256
 * content address, but are NOT pinned to IPFS. Return an HTTPS URI that a
 * wallet or explorer can actually resolve. Vercel stores bytes in the app's
 * existing Mongo database; local development can use disk or the same backend.
 * `storage: "local"` is retained in the API for existing clients and means
 * app-hosted demo storage, not a promise of local disk persistence on Vercel.
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

/** True when uploads and metadata use app-hosted demo storage instead of Pinata. */
export function localStorageMode(): boolean {
  return !process.env.PINATA_JWT?.trim();
}

/** Vercel instances have no persistent disk. Reuse the app's existing Mongo database. */
export function demoStorageBackend(): "mongo" | "disk" {
  return process.env.VERCEL || process.env.JUNO_MEDIA_BACKEND === "mongo" ? "mongo" : "disk";
}

// Leaves room for multipart headers under Vercel's request body ceiling.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

function dir(): string {
  return path.resolve(process.env.JUNO_MEDIA_DIR?.trim() || ".juno/media");
}

/** The public base URL of this API for links to stored files: `JUNO_API_URL` if set, else the request's own origin. */
export function publicOrigin(request: Request): string {
  return process.env.JUNO_API_URL?.trim() || new URL(request.url).origin;
}

export type LocalPin = { cid: string; uri: string; url: string };

export async function storeLocal(bytes: Uint8Array, type: string, origin: string): Promise<LocalPin> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("File is over 4MB. Pick a smaller photo or a shorter video.");
  const cid = rawCid(bytes);
  if (demoStorageBackend() === "mongo") {
    const { db } = await import("./social");
    const { Binary } = await import("mongodb");
    await (await db()).collection<{ _id: string; bytes: InstanceType<typeof Binary>; type: string }>("demo_media")
      .updateOne({ _id: cid }, { $setOnInsert: { bytes: new Binary(bytes), type } }, { upsert: true });
  } else {
    await mkdir(dir(), { recursive: true });
    await writeFile(path.join(dir(), cid), bytes);
    await writeFile(path.join(dir(), `${cid}.type`), type);
  }
  const url = `${origin.replace(/\/$/, "")}/api/ipfs/${cid}`;
  // An unpinned ipfs:// URI cannot resolve in explorers. The content-addressed
  // HTTPS URL is both honest and usable outside Juno (including tokenURI).
  return { cid, uri: url, url };
}

export async function readLocal(cid: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!/^b[a-z2-7]{58}$/.test(cid)) return null;
  if (demoStorageBackend() === "mongo") {
    const { db } = await import("./social");
    const doc = await (await db()).collection<{ _id: string; bytes: import("mongodb").Binary; type: string }>("demo_media").findOne({ _id: cid });
    return doc ? { bytes: new Uint8Array(doc.bytes.buffer), type: doc.type } : null;
  }
  try {
    const bytes = new Uint8Array(await readFile(path.join(dir(), cid)));
    const type = (await readFile(path.join(dir(), `${cid}.type`), "utf8").catch(() => "application/octet-stream")).trim();
    return { bytes, type };
  } catch {
    return null;
  }
}
