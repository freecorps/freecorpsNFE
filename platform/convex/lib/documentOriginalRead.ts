import { ConvexError, v, type Infer } from "convex/values";
import { gunzipSync, gzipSync } from "fflate";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { coldObjects, sha256Hex } from "./coldObjects";

/**
 * The XML original of a document (`documentArtifacts`), wherever it lives (ADR 0010, decision 8):
 * the raw bytes in Convex file storage (hot, `storageId`), or, once its note went cold, the gzip
 * of those bytes in the cold tier's bucket (`objectKey`). `sha256` and `size` always describe the
 * raw XML; `objectSha256` and `objectSize` describe the object, so the backup and the ADR 0009
 * package check the bucket without decompressing.
 *
 * Every reader of an original's bytes goes through `readOriginal`, in any runtime: `fflate` and
 * `lib/coldObjects.ts` run in both, like the phase B codec (`lib/documentContent.ts`, which
 * records why the default runtime has no `CompressionStream`).
 */
export const coldOriginalSource = v.object({
  objectKey: v.string(),
  objectSha256: v.string(),
  objectSize: v.number(),
  sha256: v.string(),
  size: v.number(),
});
export const originalSource = v.union(
  v.object({ storageId: v.id("_storage"), sha256: v.string(), size: v.number() }),
  coldOriginalSource,
);
export type OriginalSource = Infer<typeof originalSource>;
export type ColdOriginalSource = Infer<typeof coldOriginalSource>;

/** Where an artifact's original is, or `null` when it has none (never both, never neither). */
export function originalSourceOf(artifact: Doc<"documentArtifacts">): OriginalSource | null {
  const { sha256, size } = artifact;
  if (artifact.objectKey !== undefined) {
    if (
      artifact.storageId !== undefined ||
      artifact.objectSha256 === undefined ||
      artifact.objectSize === undefined
    )
      return null;
    return {
      objectKey: artifact.objectKey,
      objectSha256: artifact.objectSha256,
      objectSize: artifact.objectSize,
      sha256,
      size,
    };
  }
  return artifact.storageId === undefined ? null : { storageId: artifact.storageId, sha256, size };
}

/** Whether the original can still be read: a cold one always is, as far as the database knows. */
export async function originalAvailable(
  ctx: Pick<QueryCtx, "db">,
  artifact: Doc<"documentArtifacts">,
) {
  const source = originalSourceOf(artifact);
  if (!source) return false;
  if ("objectKey" in source) return true;
  return Boolean(await ctx.db.system.get("_storage", source.storageId));
}

/** Above this, an original is refused when compressed or read back (originals are far smaller). */
export const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;
export const ORIGINAL_OBJECT_MIME = "application/gzip";

/**
 * Deterministic gzip of the raw XML, as the phase B codec writes it: level 9, mtime 0 and OS 255.
 * The same original always gives the same object, so a repeated passage writes the same bytes to
 * the same key.
 */
export async function encodeOriginal(raw: Uint8Array) {
  if (raw.length > MAX_ORIGINAL_BYTES) throw new Error("ORIGINAL_TOO_LARGE");
  const bytes = gzipSync(raw, { level: 9, mtime: 0 });
  bytes[9] = 0xff;
  return { bytes, objectSha256: await sha256Hex(bytes), objectSize: bytes.length };
}

const unavailable = (reason: string): never => {
  throw new ConvexError({ code: "UNAVAILABLE", reason });
};

/**
 * The raw XML from a cold object: the object's hash and size first, then the gunzipped bytes
 * against the original's size and hash. Any mismatch throws `UNAVAILABLE`; nothing partial or
 * unchecked is ever returned.
 */
export async function decodeOriginal(bytes: Uint8Array, source: ColdOriginalSource) {
  if (bytes.length !== source.objectSize || (await sha256Hex(bytes)) !== source.objectSha256)
    return unavailable("cold original object mismatch");
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_ORIGINAL_BYTES)
    return unavailable("cold original size");
  let raw: Uint8Array;
  try {
    raw = gunzipSync(bytes, { out: new Uint8Array(source.size) });
  } catch {
    return unavailable("cold original deflate");
  }
  if (raw.length !== source.size || (await sha256Hex(raw)) !== source.sha256)
    return unavailable("cold original mismatch");
  return raw;
}

/** What a reader needs of the storage of any runtime; `object` stands in for the bucket in tests. */
export type OriginalStorage = {
  get(storageId: Id<"_storage">): Promise<Blob | null>;
  object?(key: string): Promise<Uint8Array | null>;
};

/**
 * The raw bytes of an original. Hot: the stored file as it is, or `null` when it is gone; each
 * caller keeps its own hash check, as before the cold tier. Cold: the object from the bucket,
 * checked by `decodeOriginal`; a missing or damaged object throws `UNAVAILABLE` (503, retryable)
 * and never reads as a lost original.
 */
export async function readOriginal(
  storage: OriginalStorage,
  source: OriginalSource,
): Promise<Uint8Array | null> {
  if ("storageId" in source) {
    const blob = await storage.get(source.storageId);
    return blob && new Uint8Array(await blob.arrayBuffer());
  }
  const bytes = storage.object
    ? await storage.object(source.objectKey)
    : await coldObjects().get(source.objectKey);
  if (!bytes) return unavailable("cold original missing");
  return decodeOriginal(bytes, source);
}

/**
 * The body of a download of the original: the stored blob as before, or the checked raw XML of a
 * cold object. The bytes are the same in both tiers, so the response is too.
 */
export async function originalBody(
  storage: OriginalStorage,
  source: OriginalSource,
): Promise<Blob | null> {
  if ("storageId" in source) return storage.get(source.storageId);
  const bytes = await readOriginal(storage, source);
  return bytes && new Blob([bytes as Uint8Array<ArrayBuffer>]);
}
