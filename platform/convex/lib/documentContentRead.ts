import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { coldObjects } from "./coldObjects";
import {
  decodeDocumentContent,
  MAX_DOCUMENT_CONTENT_BYTES,
  type DocumentContent,
  type DocumentContentRef,
} from "./documentContent";

/**
 * What a reader needs of the storage of any runtime: the blob, or `null` when it is gone. A
 * cold version (ADR 0010, phase C) is read through `object`; without it, from the cold tier's
 * bucket (`lib/coldObjects.ts`), so `ctx.storage` of any runtime reads both tiers.
 */
export type ContentStorage = {
  get(storageId: Id<"_storage">): Promise<Blob | null>;
  object?(key: string): Promise<Uint8Array | null>;
};

/** Where a version's blob is: in Convex file storage (hot) or in the cold tier's bucket. */
export type ContentLocation = { storageId: Id<"_storage"> } | { objectKey: string };

export type BlobMissing = { code: "BLOB_MISSING" };

/**
 * The one path every reader of the phase B blob takes (ADR 0010): the stored gzip, whole, then the
 * codec, which checks size, hash and canonical form before returning anything. A missing file is
 * `BLOB_MISSING`; a damaged one is `DOCUMENT_CONTENT_CORRUPT`. Neither is ever read as empty.
 * `limit` exists only for the headroom proof; readers keep the cap.
 */
export async function readStoredContent(
  storage: ContentStorage,
  location: Id<"_storage"> | ContentLocation,
  ref: DocumentContentRef,
  limit = MAX_DOCUMENT_CONTENT_BYTES,
): Promise<DocumentContent> {
  const where = typeof location === "string" ? { storageId: location } : location;
  let bytes: Uint8Array | null;
  if ("storageId" in where) {
    const blob = await storage.get(where.storageId);
    bytes = blob && new Uint8Array(await blob.arrayBuffer());
  } else {
    bytes = storage.object
      ? await storage.object(where.objectKey)
      : await coldObjects().get(where.objectKey);
  }
  if (!bytes) throw new ConvexError<BlobMissing>({ code: "BLOB_MISSING" });
  return decodeDocumentContent(bytes, ref, limit);
}
