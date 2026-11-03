import { defineTable } from "convex/server";
import { v } from "convex/values";
import { archiveOriginFields } from "./coldArchiveSchema";
import { environment } from "./projectValues";
export const documentTables = {
  /**
   * ADR 0010, phase C: the sweep of the passage to the cold tier, one row. A step carries the
   * generation it belongs to; a step of an older generation, delayed or repeated, does nothing.
   */
  coldTierSweeps: defineTable({
    generation: v.number(),
    state: v.union(v.literal("running"), v.literal("done")),
    // 0: stale claims taken back; 1: hot notes past the shortest window.
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
    counts: v.record(v.string(), v.number()),
    startedAt: v.number(),
    updatedAt: v.number(),
    // The next sweep, scheduled a day after this one ended; a manual `start` cancels it.
    next: v.optional(v.id("_scheduled_functions")),
  }),
  /**
   * Objects of the cold tier to delete: written by the fiscal guard when it purges a cold
   * version, consumed by the sweep. Never written for a hot version.
   */
  /**
   * Intents of the passage (ADR 0010, phase C): written before each object goes to the bucket,
   * removed when a version points at it. One left behind past `retryAt` is an orphan candidate:
   * the collection deletes the object unless a version holds the key. `collecting` fences a new
   * upload of the same key while the object is being deleted.
   */
  coldObjectUploads: defineTable({
    organizationId: v.id("organizations"),
    objectKey: v.string(),
    retryAt: v.number(),
    collecting: v.optional(v.boolean()),
  })
    .index("by_objectKey", ["objectKey"])
    .index("by_retryAt", ["retryAt"]),
  coldObjectDeletions: defineTable({
    organizationId: v.id("organizations"),
    objectKey: v.string(),
    requestedAt: v.number(),
  }).index("by_requestedAt", ["requestedAt"]),
  /**
   * The phase B migration runs of ADR 0010 (B7 backfill and audit, B8 cleanup), one row per kind:
   * where the scan is, what it found, and whether it ended. A run resumes from its cursor.
   */
  contentMigrations: defineTable({
    kind: v.union(v.literal("backfill"), v.literal("audit"), v.literal("cleanup")),
    state: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    // Raised by every `start`: a step scheduled before it, delayed or repeated, finds another
    // generation and changes nothing.
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
    counts: v.record(v.string(), v.number()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_kind", ["kind"]),
  documentFiscalEvidence: defineTable({
    ...archiveOriginFields,
    documentId: v.id("fiscalDocuments"),
    // Variant key: the fingerprint defined with nfe-status/1. nfe-status/2 (#395) keeps the same
    // fingerprint and only changes how variants of one original are resolved, so rows are shared.
    ruleVersion: v.literal("nfe-status/1"),
    originalSha256: v.string(),
    fingerprint: v.string(),
    // B8: absent once only the blob of `versionId` holds it, matched by `snapshotSha256`.
    snapshot: v.optional(v.string()),
    // ADR 0010, phase B: the SHA-256 of `snapshot`, to match it with the copy in the blob of
    // `versionId`. A snapshot that does not match it stays inline here.
    snapshotSha256: v.optional(v.string()),
    versionId: v.id("documentVersions"),
  })
    .index("by_documentId_ruleVersion", ["documentId", "ruleVersion"])
    .index("by_variant", ["documentId", "ruleVersion", "originalSha256", "fingerprint"]),
  documentListings: defineTable({
    ...archiveOriginFields,
    documentId: v.id("fiscalDocuments"),
    companyId: v.id("companies"),
    environment,
    filterKey: v.string(),
    date: v.number(),
  })
    .index("by_companyId_environment_filterKey_date", [
      "companyId",
      "environment",
      "filterKey",
      "date",
    ])
    .index("by_documentId", ["documentId"]),
  documentDownloads: defineTable({
    tokenHash: v.string(),
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    projectId: v.id("projects"),
    environment,
    /** Imported original or, from the console issuance, a preserved XML of the issuance. */
    artifactId: v.union(v.id("documentArtifacts"), v.id("issuanceArtifacts")),
    /** The DANFE of the NF-e of `artifactId` instead of its bytes (`documentDanfe.ts`). */
    danfe: v.optional(v.literal(true)),
    membershipId: v.id("memberships"),
    accessVersion: v.string(),
    projectEpoch: v.number(),
    grantEpoch: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * The DANFE PDF of an NF-e 55, derived from its preserved XML (#402). A cache: one row per
   * document, replaced (row and file) when the generator version or the evidence changes. The
   * XML original stays in `documentArtifacts`; nothing here alters it. Retention `closure`.
   */
  documentDanfes: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    environment,
    documentId: v.id("fiscalDocuments"),
    /** Absent when the generator refused this key (`refusal`): retries answer without rendering. */
    storageId: v.optional(v.id("_storage")),
    refusal: v.optional(v.string()),
    generatorVersion: v.string(),
    /** SHA-256 of the NF-e XML original the PDF was rendered from. */
    sourceSha256: v.string(),
    /** SHA-256 of the sorted SHA-256 of the cancellation events passed, with the origin text. */
    evidenceSha256: v.string(),
    eventCount: v.number(),
    origin: v.union(v.string(), v.null()),
    pdfSha256: v.optional(v.string()),
    size: v.optional(v.number()),
    generatedAt: v.number(),
  })
    .index("by_documentId", ["documentId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_storageId", ["storageId"]),
};
