
import { junoJson, junoOptions } from "@/lib/juno/api";
import { rateLimit } from "@/lib/rate-limit";
import { rememberContent } from "@/lib/juno/ipfs-cache";
import { localStorageMode, publicOrigin, storeLocal } from "@/lib/juno/local-media";
import { pinFile } from "@/lib/juno/pinata";
import { videoPoster } from "@/lib/juno/poster";
import sharp from "sharp";

export const runtime = "nodejs";
/** The Expo client is a different origin; the preflight has to answer. */
export const OPTIONS = junoOptions;

/** Anything larger is a problem for the pinning step, not a real upload. */
const MAX_BYTES = 25 * 1024 * 1024;
/** Raster images and video only: an SVG is a document that can carry script, and this route serves what it stores. */
const ALLOWED = /^(image\/(jpeg|png|gif|webp|avif|heic|heif)|video\/)/;

export async function POST(request: Request) {
  // With a Pinata key, pins on Juno's account; without one, demo storage on this server's disk
  // (lib/juno/local-media.ts). Either way, for anyone who asks: bounded per address.
  const limited = rateLimit(request, "upload");
  if (limited) return limited;

  /**
   * Only what this route reads.
   *
   * Two incompatible `FormData` types are visible during the production build —
   * the ambient DOM one and the undici one `.formData()` actually returns — and
   * annotating either way fails. `tsc --noEmit` sees only one of them and
   * passes, which is why this only surfaces at build time.
   */
  let form: { get(name: string): unknown };
  try {
    form = (await request.formData()) as unknown as typeof form;
  } catch {
    return junoJson({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return junoJson({ error: "No file" }, { status: 400 });
  }
  if (!ALLOWED.test(file.type)) {
    return junoJson({ error: "Only photos (JPEG, PNG, GIF, WebP, AVIF, HEIC) and video" }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return junoJson({ error: "File is over 25MB" }, { status: 413 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const local = localStorageMode();
    const origin = publicOrigin(request);
    const store = (data: Uint8Array, type: string, name: string, f?: File) =>
      local ? storeLocal(data, type, origin) : pinFile(f ?? new File([new Uint8Array(data)], name, { type }), name);
    const pinned = await store(bytes, file.type, file.name || "upload", file);
    const storage = local ? "local" : "ipfs";
    // The feed asks for this within seconds, before public gateways have it.
    rememberContent(pinned.cid, bytes, file.type);

    /*
     * Dimensions for both kinds, and a poster for video.
     *
     * Neither is optional decoration. A reel without a poster draws as an
     * empty box in every list, and media without dimensions is laid out at a
     * guessed ratio. A failure here fails the upload with a reason rather than
     * handing back a video the rest of the app cannot show.
     */
    if (file.type.startsWith("video/")) {
      const poster = await videoPoster(bytes);
      const pinnedPoster = await store(poster.jpeg, "image/jpeg", `${file.name || "reel"}-poster`);
      rememberContent(pinnedPoster.cid, poster.jpeg, "image/jpeg");
      return junoJson(
        {
          ...pinned,
          storage,
          mimeType: file.type,
          posterUri: pinnedPoster.uri,
          posterUrl: pinnedPoster.url,
          width: poster.width,
          height: poster.height,
        },
        { status: 201 },
      );
    }

    // Dimensions are for layout only. An image the reader cannot parse — an
    // HEIC past libheif's limits, say — is still a pinned file; it gets no
    // size rather than failing an upload that already succeeded.
    const meta = await sharp(bytes)
      .metadata()
      .catch(() => ({ width: undefined, height: undefined }));
    return junoJson(
      { ...pinned, storage, mimeType: file.type, width: meta.width ?? null, height: meta.height ?? null },
      { status: 201 },
    );
  } catch (error) {
    return junoJson(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 502 },
    );
  }
}
