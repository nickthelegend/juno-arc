import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mediaCid } from "@/lib/juno/media";
import { localStorageMode, rawCid, readLocal, storeLocal } from "@/lib/juno/local-media";

/**
 * Demo storage: the upload path when no Pinata key is set. Its address must be a
 * real IPFS content address, or "stored under its IPFS CID" would be a lie.
 */
describe("rawCid", () => {
  it("is the CIDv1 (raw, sha2-256) that `ipfs add --cid-version 1 --raw-leaves` prints", () => {
    // The well-known CID of the empty file, and of "hello world\n".
    expect(rawCid(new Uint8Array())).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(rawCid(new TextEncoder().encode("hello world\n"))).toBe("bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4");
  });

  it("is a CID the app's media layer recognises", () => {
    const cid = rawCid(new Uint8Array([1, 2, 3]));
    expect(mediaCid(`ipfs://${cid}`)).toBe(cid);
  });
});

describe("storeLocal / readLocal", () => {
  const previous = process.env.JUNO_MEDIA_DIR;
  let dir: string | undefined;
  afterEach(async () => {
    if (previous === undefined) delete process.env.JUNO_MEDIA_DIR;
    else process.env.JUNO_MEDIA_DIR = previous;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips bytes and type under their content address", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "juno-media-"));
    process.env.JUNO_MEDIA_DIR = dir;
    const bytes = new TextEncoder().encode("a post");
    const pin = await storeLocal(bytes, "image/png", "http://api.example/");
    expect(pin.uri).toBe(`ipfs://${pin.cid}`);
    expect(pin.url).toBe(`http://api.example/api/ipfs/${pin.cid}`);
    const back = await readLocal(pin.cid);
    expect(back?.type).toBe("image/png");
    expect(Buffer.from(back!.bytes).toString()).toBe("a post");
  });

  it("refuses anything that is not a CID (no path traversal)", async () => {
    expect(await readLocal("../../etc/passwd")).toBeNull();
  });
});

describe("localStorageMode", () => {
  it("is on exactly when there is no Pinata key", () => {
    const previous = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;
    expect(localStorageMode()).toBe(true);
    process.env.PINATA_JWT = "jwt";
    expect(localStorageMode()).toBe(false);
    if (previous === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = previous;
  });
});
