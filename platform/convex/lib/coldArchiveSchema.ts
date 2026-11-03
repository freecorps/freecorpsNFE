import { defineTable } from "convex/server";
import { v } from "convex/values";

export const archiveState = v.union(
  ...["notice", "frozen", "sealed", "verified", "deleting", "archived", "restoring", "hot"].map(
    (state) =>
      v.literal(
        state as
          | "notice"
          | "frozen"
          | "sealed"
          | "verified"
          | "deleting"
          | "archived"
          | "restoring"
          | "hot",
      ),
  ),
);
/** The single e-mail of an open organization's notice (ADR 0009, §1), as in `termsOfUseNotices`. */
export const archiveNoticeMailState = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("partial"),
  v.literal("unconfirmed"),
  v.literal("skipped"),
);
/**
 * The single e-mail of a notice, written with it before anything is sent and claimed once by its
 * send: never sent again. Holds no address, only counts: `recipients` handed to the provider,
 * `confirmed` by it and `withheld` outside `ACCOUNT_EMAIL_RECIPIENTS`. Also the e-mail of the
 * Sandbox-only closure notice (`sandboxClosureNotices`).
 */
export const noticeMail = v.object({
  state: archiveNoticeMailState,
  recipients: v.number(),
  confirmed: v.number(),
  withheld: v.number(),
  claimedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
});
/**
 * The compacted catalogue of an `archived` run (ADR 0009, §4): its entries as one age object in R2,
 * described by an immutable catalogue manifest. `verified` records that the executor downloaded,
 * decrypted and compared the object with every hot entry; only then `compactCatalogBatch` deletes
 * them, counting in `removed`, until `compacted`.
 */
export const archiveCatalog = v.object({
  state: v.union(v.literal("verified"), v.literal("compacting"), v.literal("compacted")),
  /** SHA-256 of the canonical catalogue manifest, published next to the package. */
  manifestSha256: v.string(),
  /** Entries in the object: the run's `rows` plus `files`. */
  entries: v.number(),
  /** Hot entries deleted so far. Never exceeds `entries`. */
  removed: v.number(),
  verifiedAt: v.number(),
  compactedAt: v.optional(v.number()),
});
/**
 * The "first ID / first creation" pair of ADR 0009, §5, item 6, on every archived table except the
 * fence (`ARCHIVE_FENCE_TABLES`, whose rows keep their IDs): the `_id` and `_creationTime` the row
 * had before its first archiving. The rehydration writes them once, in the first cycle, and never
 * changes them; absent on a row never rehydrated, so its JSON and hash are those of before.
 * `firstId` and `firstCreation` (`lib/coldArchiveIdMap.ts`) read them.
 */
export const archiveOriginFields = {
  originId: v.optional(v.string()),
  originCreationTime: v.optional(v.number()),
};
/**
 * The cold stage of a rehydration (ADR 0010, decision 5, phase C2), fixed at `begin`:
 *
 * - `cutoff`: a note entered before it is outside the hot window (`coldTier.hotWindowCutoff`, the
 *   sweep's rule, at `begin`); `lockedThrough`: the lock year the executor's plan assumed;
 * - `files` and `bytes`: the originals the executor left out of the files stage, uploaded only in
 *   a batch of this stage; `batchBytes`: the most one batch may hold in file storage at once,
 *   admitted on top of the hot files;
 * - `cursor` and `passDone`: the server's own pass over the organization's notes, after the
 *   executor's batches, so every note outside the window that can move does;
 * - `batch`: the batch under way: its claim, the notes claimed for the passage, the deferred
 *   originals still to upload (`files`, previous storage IDs), whether the moves were scheduled
 *   and how many times this batch was claimed;
 * - `moved` and `kept`: notes that went cold, and notes outside the window that stayed hot.
 */
export const archiveRehydrationCold = v.object({
  cutoff: v.number(),
  lockedThrough: v.union(v.number(), v.null()),
  files: v.number(),
  bytes: v.number(),
  batchBytes: v.number(),
  cursor: v.union(v.string(), v.null()),
  passDone: v.boolean(),
  batch: v.optional(
    v.object({
      claimedAt: v.number(),
      documentIds: v.array(v.string()),
      files: v.array(v.string()),
      scheduled: v.boolean(),
      attempt: v.number(),
    }),
  ),
  moved: v.number(),
  kept: v.number(),
});
/**
 * Progress of the rehydration under new IDs (ADR 0009, §5) of a run in `restoring`, written by
 * `coldArchiveRehydration.ts` in the same transaction as each batch, so a repeated or resumed
 * batch finds its offset and never applies twice:
 *
 * - `files`: originals uploaded through an intent and recorded (`coldArchiveUploads`);
 * - `rows`: first pass, package rows in catalogue order, fence included, with their hash chain
 *   (`digest`), which must end equal to the scan's `digest`;
 * - `references`: second pass, `phase` 0 the rehydrated rows through the ID map, then each hot
 *   source of `HOT_REFERENCE_SOURCES`, with the page `cursor`;
 * - `cold` (ADR 0010, C2, only with `cold` set): the notes outside the plan's hot window go to the
 *   cold tier in batches (`coldBatch`, `coldStep`), their deferred files uploaded only then;
 * - `check`: canonical check of every catalogue entry in order (`checked`, `checkDigest`,
 *   `checkedFiles`); `checked` once everything matched, before `finishRehydration`.
 */
export const archiveRehydration = v.object({
  stage: v.union(
    v.literal("files"),
    v.literal("rows"),
    v.literal("references"),
    v.literal("cold"),
    v.literal("check"),
    v.literal("checked"),
  ),
  cold: v.optional(archiveRehydrationCold),
  startedAt: v.number(),
  files: v.number(),
  rows: v.number(),
  digest: v.string(),
  phase: v.number(),
  cursor: v.union(v.string(), v.null()),
  checked: v.number(),
  checkDigest: v.string(),
  checkedFiles: v.number(),
  finishedAt: v.optional(v.number()),
});
export const coldArchiveTables = {
  /**
   * Upload intents of the rehydration (ADR 0009, §5, item 4), one row per attempt: written before
   * the executor sends an original, with the bytes it must have, and completed with the new
   * storage ID in the transaction that maps it. A retry reuses only the storage ID recorded here.
   * An attempt never completed may have left an orphan blob, created inside its window, that
   * `collectUploadOrphans` deletes once nothing holds it. Retention class `control`.
   */
  coldArchiveUploads: defineTable({
    organizationId: v.id("organizations"),
    runId: v.id("coldArchiveRuns"),
    /** The original storage ID, as the package and the catalogue name it. */
    previousId: v.string(),
    /** The original's `_creationTime`, which its ID map entry keeps. */
    previousCreationTime: v.number(),
    attempt: v.number(),
    /** What the upload must have: `_storage` hash (base64), size and content type. */
    sha256: v.string(),
    size: v.number(),
    contentType: v.optional(v.string()),
    startedAt: v.number(),
    /**
     * The new storage ID, once recorded. Text, not `v.id("_storage")`: the intent is no holder
     * of the file (`storageHolders`, the backup inventory); its capacity record is
     * (`capacityFiles`), written in the same transaction, and then the row the second pass
     * points at it.
     */
    storageId: v.optional(v.string()),
    /** The upload had other bytes; the blob was deleted and the rehydration stops. */
    rejected: v.optional(v.boolean()),
    /**
     * Orphan collection cursor: `_creationTime` of the last blob of the window already judged,
     * and the IDs judged at exactly that instant (`orphanScanStep`), at most `ORPHAN_SCAN_TIES`.
     */
    scannedThrough: v.optional(v.number()),
    scannedIdsAtThrough: v.optional(v.array(v.string())),
    /** No orphan left to look for: completed, rejected, or its window already collected. */
    collectedAt: v.optional(v.number()),
    /** The canonical check already compared this original. */
    checkedAt: v.optional(v.number()),
    /**
     * ADR 0010, C2: the cold object this original went to during the rehydration's cold stage,
     * with the object's SHA-256 and size as the row that points at it records them. The blob was
     * deleted then; the canonical check maps the row back to its package form through this.
     */
    objectKey: v.optional(v.string()),
    objectSha256: v.optional(v.string()),
    objectSize: v.optional(v.number()),
    /** The import file that let go of this original when it went cold, as text. */
    importFileId: v.optional(v.string()),
  })
    .index("by_runId_and_previousId_and_attempt", ["runId", "previousId", "attempt"])
    .index("by_runId_and_collectedAt", ["runId", "collectedAt"])
    .index("by_runId_and_objectKey", ["runId", "objectKey"])
    .index("by_runId_and_importFileId", ["runId", "importFileId"])
    // An uploaded original is held by its intent until the second pass points a row at it.
    .index("by_storageId", ["storageId"]),
  /**
   * The ID map of ADR 0009, §6: one entry per rehydrated row (or stored file, `table` `_storage`),
   * with the cycle (`runId`), the previous `_id` and `_creationTime` and the new ID. Written in the
   * same transaction as the new row (`recordArchiveId`), kept hot while the organization and its
   * fiscal guard exist, and counted as the organization's database stock.
   */
  coldArchiveIdMap: defineTable({
    organizationId: v.id("organizations"),
    runId: v.id("coldArchiveRuns"),
    table: v.string(),
    previousId: v.string(),
    previousCreationTime: v.number(),
    newId: v.string(),
  })
    // A REST route resolves an old ID of the caller's organization (ADR 0009, §6).
    .index("by_organizationId_and_previousId", ["organizationId", "previousId"])
    // The rehydration finds the entry of a row already recreated when it repeats a batch.
    .index("by_runId_and_previousId", ["runId", "previousId"])
    // The inverse map of the canonical check: the new ID back to the previous one.
    .index("by_newId", ["newId"]),
  coldArchiveRuns: defineTable({
    organizationId: v.id("organizations"),
    key: v.string(),
    version: v.number(),
    state: archiveState,
    reason: v.union(v.literal("closed"), v.literal("paid_expired"), v.literal("free_inactive")),
    planVersion: v.optional(v.number()),
    noticeAt: v.number(),
    eligibleAt: v.number(),
    retainUntil: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
    rows: v.number(),
    files: v.number(),
    bytes: v.number(),
    digest: v.string(),
    manifest: v.optional(v.string()),
    manifestSha256: v.optional(v.string()),
    verifierRunId: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    restoredAt: v.optional(v.number()),
    /** Last renewal of `retainUntil` and of the R2 lock while archived (ADR 0009, §2). */
    retentionRenewedAt: v.optional(v.number()),
    /** The catalogue compacted to R2 after `archived` (ADR 0009, §4). */
    catalog: v.optional(archiveCatalog),
    /** The rehydration under new IDs of an open organization (ADR 0009, §5). */
    rehydration: v.optional(archiveRehydration),
    /** Open organizations only: the notice's single e-mail. */
    noticeMail: v.optional(noticeMail),
    /** How the notice of an open organization ended before freezing: kept active or a new plan. */
    noticeEnded: v.optional(
      v.object({ by: v.union(v.literal("keep_active"), v.literal("plan")), at: v.number() }),
    ),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_key", ["key"])
    // The operator's list of packages to renew (`coldArchive:renewalDue`, ADR 0009, §2).
    .index("by_state_and_retainUntil", ["state", "retainUntil"])
    // The operator's view of notice e-mails without an outcome (`archiveNotice:mailStatus`).
    .index("by_noticeMail_state_and_noticeAt", ["noticeMail.state", "noticeAt"]),
  coldArchiveEntries: defineTable({
    runId: v.id("coldArchiveRuns"),
    organizationId: v.id("organizations"),
    kind: v.union(v.literal("row"), v.literal("file")),
    table: v.string(),
    originalId: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    metadata: v.optional(v.string()),
    /**
     * Fence rows only (`ARCHIVE_FENCE_TABLES`): the row's JSON as the scan read it, which the
     * package carries. The hot row may change afterwards; the snapshot never does.
     */
    snapshot: v.optional(v.string()),
    /**
     * The removal handled this entry. For a fence row, the row itself stays hot with its ID.
     */
    removed: v.boolean(),
  })
    .index("by_runId", ["runId"])
    .index("by_runId_and_originalId", ["runId", "originalId"])
    .index("by_runId_and_removed", ["runId", "removed"])
    .index("by_runId_and_kind_and_removed", ["runId", "kind", "removed"])
    .index("by_originalId", ["originalId"]),
};
