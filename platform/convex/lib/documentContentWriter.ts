import type { ProcessedNfe } from "@freecorps/fiscal-nfe";
import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { patchFiscal, trackStoredFile } from "./capacityCore";
import {
  documentContentRef,
  MAX_DOCUMENT_CONTENT_BYTES,
  sha256,
  type DocumentContent,
} from "./documentContent";
import { cardOf } from "./documentCore";
import { requestCleanup } from "./importCore";
import { inCustody } from "./coldArchiveCore";
import { DOCUMENT_CONTENT_FORMAT } from "./documentValues";
import { storageHash, UPLOAD_TTL } from "./importValues";
import { storageHolders } from "./storageHolders";

/**
 * The dual write of ADR 0010, phase B (B4): every version a publication completes also gets its
 * content as one `document-content/1` blob, while the inline fields stay as they are. Publishing
 * schedules `importProcessing.storeContent`, which reads the content here, encodes and stores it
 * and asks `attachVersionContent` to point the version at the blob. Readers do not change.
 *
 * A version can still change after its operation stages it: `stage` adds a missing
 * `fiscalEvidence` on a retry and publication writes the evidence row. Once published, nothing
 * rewrites `result`, the items or the evidence of that version, so the content read after
 * publication is final. The attach re-derives the content's hash in its own transaction anyway
 * and refuses a blob encoded from content that no longer matches.
 */
/** Tries of one version's writer, counting the re-encodes of `changed` and the failures. */
export const MAX_ATTEMPTS = 3;
/**
 * When the writer tries again after a failure of try `attempt`: spread out, with jitter, so the
 * writers of one organization stop colliding on its capacity totals. `null` after the last try.
 */
export function writerRetryDelay(attempt: number) {
  return attempt < MAX_ATTEMPTS ? 2_000 * 2 ** attempt + Math.floor(Math.random() * 1_000) : null;
}

/**
 * The queue of the content writers. Each attach and verification rewrites the organization's
 * stock totals (`capacityTotals`), one row per metric, so a batch import or the backfill that
 * started one writer per version at once collided on those rows until the writes failed for good
 * (OCC). Two at a time keeps the writers of one organization from piling on the same rows, in a
 * pool of their own so imports never wait behind content blobs. The writer retries itself
 * (`writerRetryDelay`), so the pool does not.
 */
const contentPool = new Workpool(components.contentPool, {
  maxParallelism: 2,
  retryActionsByDefault: false,
});

/**
 * Queues the content writer of a version: once per publication, again after a writer failure or a
 * `changed` refusal (`attempt`), and by the backfill. `runAfter` spreads a retry out.
 */
export async function scheduleVersionContent(
  ctx: MutationCtx | ActionCtx,
  versionId: Id<"documentVersions">,
  attempt = 1,
  runAfter = 0,
) {
  await contentPool.enqueueAction(
    ctx,
    internal.importProcessing.storeContent,
    { versionId, attempt },
    { runAfter },
  );
}

/**
 * Called right before each store. The storage sweep only scans the window imports and exports
 * asked for; a capture publishes without either, and an action may run late, so the writer asks
 * for the window of the blob it is about to store.
 */
export async function requestContentWindow(ctx: MutationCtx) {
  await requestCleanup(ctx, Date.now() + UPLOAD_TTL);
}

/** A published version without a blob yet; the only ones the writer encodes. */
const pending = (version: Doc<"documentVersions"> | null): version is Doc<"documentVersions"> =>
  version?.state === "complete" &&
  version.publishedAt !== undefined &&
  version.contentStorageId === undefined &&
  // A version already moved to the cold tier (ADR 0010, phase C) has its blob there.
  version.contentObjectKey === undefined;

/** The evidence row this version wrote at publication, found as `recordEvidence` keys it. */
export async function writtenEvidence(ctx: QueryCtx, version: Doc<"documentVersions">) {
  if (!version.documentId || !version.fiscalEvidence || !version.fiscalFingerprint) return null;
  const evidence = JSON.parse(version.fiscalEvidence) as ProcessedNfe;
  const originalSha256 = evidence.metadata?.originalSha256;
  if (!originalSha256) return null;
  const row = await ctx.db
    .query("documentFiscalEvidence")
    .withIndex("by_variant", (q) =>
      q
        .eq("documentId", version.documentId!)
        .eq("ruleVersion", "nfe-status/1")
        .eq("originalSha256", originalSha256)
        .eq("fingerprint", version.fiscalFingerprint!),
    )
    .unique();
  return row?.versionId === version._id ? row : null;
}

type ContentRead =
  | { content: DocumentContent; evidence: Doc<"documentFiscalEvidence"> | null }
  | { skip: "TOO_LARGE" | "ITEM_POSITIONS" | "INLINE_GONE" };

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * The version's content as the codec takes it. Items are positional (B2): their positions must
 * run 0, 1, 2… up to `itemCount` without gaps. The UTF-8 size of the strings is a lower bound of
 * the canonical JSON, so content past the cap stops being read early; the codec enforces the
 * exact cap, which JSON escapes can still cross.
 */
async function readContent(ctx: QueryCtx, version: Doc<"documentVersions">): Promise<ContentRead> {
  // After B8 the content lives only in the blob: nothing inline to encode or compare.
  if (version.result === undefined) return { skip: "INLINE_GONE" };
  const result = version.result;
  let size = utf8(result) + utf8(version.fiscalEvidence ?? "");
  const items: string[] = [];
  for await (const item of ctx.db
    .query("documentItems")
    .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))) {
    if (item.position !== items.length) return { skip: "ITEM_POSITIONS" };
    size += utf8(item.data);
    if (size > MAX_DOCUMENT_CONTENT_BYTES) return { skip: "TOO_LARGE" };
    items.push(item.data);
  }
  if (items.length !== version.itemCount) return { skip: "ITEM_POSITIONS" };
  const evidence = await writtenEvidence(ctx, version);
  if (size + utf8(evidence?.snapshot ?? "") > MAX_DOCUMENT_CONTENT_BYTES)
    return { skip: "TOO_LARGE" };
  return {
    content: {
      result,
      ...(version.fiscalEvidence === undefined ? {} : { fiscalEvidence: version.fiscalEvidence }),
      items,
      ...(evidence?.snapshot !== undefined ? { snapshot: evidence.snapshot } : {}),
    },
    evidence,
  };
}

/**
 * The identity of a version's inline content, as the writer would encode it now (B7 audit): the
 * same reading as `storeContent`, so a blob and its inline source are compared exactly. `null`
 * when the inline copy cannot be encoded (over the cap or with item gaps).
 */
export async function inlineContentRef(ctx: QueryCtx, version: Doc<"documentVersions">) {
  const read = await readContent(ctx, version);
  return "skip" in read ? null : documentContentRef(read.content).catch(() => null);
}

/** What `storeContent` encodes: null when the version is gone, unpublished or already holds one. */
export async function versionContentSource(ctx: QueryCtx, versionId: Id<"documentVersions">) {
  const version = await ctx.db.get("documentVersions", versionId);
  if (!pending(version)) return null;
  const read = await readContent(ctx, version);
  return "skip" in read ? read : read.content;
}

/** The card `summary()` gives the version; a version without a document is never listed. */
async function versionCard(ctx: QueryCtx, version: Doc<"documentVersions">) {
  const doc = version.documentId ? await ctx.db.get("fiscalDocuments", version.documentId) : null;
  if (!doc) return {};
  return { card: cardOf(doc, version) };
}

export type AttachArgs = {
  versionId: Id<"documentVersions">;
  storageId: Id<"_storage">;
  contentSha256: string;
  contentSize: number;
  storedSha256: string;
  storedSize: number;
  attempt: number;
};
export type AttachOutcome =
  | "attached"
  | "already"
  | "duplicate"
  | "foreign"
  | "mismatch"
  | "gone"
  | "changed"
  | "archived";

/**
 * Points the version at the blob `storeContent` stored, once. Repeating it with the same blob is
 * a no-op; any other refusal deletes the blob, which then no row holds, except a blob another
 * version already holds, which stays where it is. Capacity counts the blob in the organization's
 * files at its compressed size and never refuses it (owner decision 10 of 30/10/2026).
 */
export async function attachVersionContent(
  ctx: MutationCtx,
  args: AttachArgs,
): Promise<AttachOutcome> {
  const blob = await ctx.db.system.get("_storage", args.storageId);
  if (!blob) return "mismatch";
  // Only a blob no row holds, and no rehydration intent, is this action's to keep or delete.
  for (const { table, query } of storageHolders(ctx, args.storageId)) {
    const holder = await query.first();
    if (!holder) continue;
    return table === "documentVersions" && holder._id === args.versionId ? "already" : "foreign";
  }
  const intent = await ctx.db
    .query("coldArchiveUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
    .first();
  if (intent) return "foreign";
  const refuse = async (outcome: AttachOutcome) => {
    await ctx.storage.delete(args.storageId);
    return outcome;
  };
  if (blob.size !== args.storedSize || storageHash(blob.sha256) !== args.storedSha256)
    return refuse("mismatch");
  const version = await ctx.db.get("documentVersions", args.versionId);
  const operation = version ? await ctx.db.get("operations", version.operationId) : null;
  if (!version || !operation || version.state !== "complete" || version.publishedAt === undefined)
    return refuse("gone");
  // A second blob for the same version (a repeated action): the first one stays.
  if (version.contentStorageId !== undefined || version.contentObjectKey !== undefined)
    return refuse("duplicate");
  const read = await readContent(ctx, version);
  const ref = "skip" in read ? null : await documentContentRef(read.content).catch(() => null);
  if (!ref || ref.contentSha256 !== args.contentSha256 || ref.contentSize !== args.contentSize) {
    if (args.attempt < MAX_ATTEMPTS)
      await scheduleVersionContent(ctx, version._id, args.attempt + 1);
    else console.warn(`document content of ${version._id} kept changing; stays inline`);
    return refuse("changed");
  }
  // An organization past the archive notice takes no new file (`trackStoredFile` refuses it):
  // the version stays inline-only, a normal state, and the sweep collects the blob.
  if (await inCustody(ctx, operation.organizationId)) return "archived";
  // The operation names the organization, as the fiscal guard finds the version's owner.
  await trackStoredFile(ctx, operation.organizationId, args.storageId);
  await patchFiscal(
    ctx,
    "documentVersions",
    version._id,
    {
      contentStorageId: args.storageId,
      contentSha256: ref.contentSha256,
      contentSize: ref.contentSize,
      contentFormat: DOCUMENT_CONTENT_FORMAT,
      ...(await versionCard(ctx, version)),
    },
    false,
  );
  // A new version of a cold note goes to the cold tier too, at the next sweep (ADR 0010, C1).
  if (version.documentId) await reopenColdNote(ctx, version.documentId);
  // The evidence row names the snapshot it shares with the blob (B3).
  if (!("skip" in read) && read.evidence?.snapshot !== undefined)
    await patchFiscal(
      ctx,
      "documentFiscalEvidence",
      read.evidence._id,
      { snapshotSha256: await sha256(new TextEncoder().encode(read.evidence.snapshot!)) },
      false,
    );
  return "attached";
}

/**
 * A new blob attached to a version of a cold note (a later event or the full XML after the
 * summary): the note goes back to `moving` with a stale claim, so the next sweep moves the new
 * version too, and no archive run takes the organization meanwhile.
 */
async function reopenColdNote(ctx: MutationCtx, documentId: Id<"fiscalDocuments">) {
  const doc = await ctx.db.get("fiscalDocuments", documentId);
  if (doc?.coldState === "cold")
    await patchFiscal(
      ctx,
      "fiscalDocuments",
      doc._id,
      { coldState: "moving", coldClaimedAt: 0, coldAt: undefined },
      false,
    );
}
