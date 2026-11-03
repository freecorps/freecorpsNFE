import { defineTable } from "convex/server";
import { v } from "convex/values";
import { archiveOriginFields } from "./coldArchiveSchema";
import { scopeFields } from "./operationValues";
import {
  DOCUMENT_CONTENT_FORMAT,
  documentCard,
  fiscalView,
  projectionState,
} from "./documentValues";

export const importTables = {
  importMaintenance: defineTable({
    key: v.literal("storage-cleanup"),
    lastSweptAt: v.number(),
    requestedUntil: v.number(),
    nextAt: v.optional(v.number()),
    cursor: v.optional(v.string()),
    scanBefore: v.optional(v.number()),
  }).index("by_key", ["key"]),
  imports: defineTable({
    ...archiveOriginFields,
    ...scopeFields,
    key: v.string(),
    requestHash: v.string(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_organizationId_and_projectId_and_key", ["organizationId", "projectId", "key"])
    .index("by_organizationId_and_companyId_and_projectId_and_environment", [
      "organizationId",
      "companyId",
      "projectId",
      "environment",
    ])
    .index("by_organizationId_and_companyId_and_environment", [
      "organizationId",
      "companyId",
      "environment",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  importFiles: defineTable({
    ...archiveOriginFields,
    importId: v.id("imports"),
    position: v.number(),
    name: v.string(),
    size: v.number(),
    sha256: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("uploaded"),
      v.literal("accepted"),
      v.literal("expired"),
    ),
    expiresAt: v.number(),
    tokenHash: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    tokenKeyId: v.optional(v.id("apiKeys")),
    tokenMembershipId: v.optional(v.id("memberships")),
    tokenAccessVersion: v.optional(v.string()),
    tokenProjectEpoch: v.optional(v.number()),
    tokenGrantEpoch: v.optional(v.number()),
    storageId: v.optional(v.id("_storage")),
    operationId: v.optional(v.id("operations")),
    processingOperationId: v.optional(v.id("operations")),
    uploadedAt: v.optional(v.number()),
  })
    .index("by_importId", ["importId"])
    .index("by_state", ["state"])
    .index("by_operationId", ["operationId"])
    .index("by_storageId", ["storageId"])
    .index("by_tokenHash", ["tokenHash"]),
  fiscalDocuments: defineTable({
    ...archiveOriginFields,
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    environment: scopeFields.environment,
    model: v.union(v.literal("55"), v.literal("nfse")),
    // Absent: received (imported or captured). `emitted`: NFS-e authorized by the platform,
    // linked from `issuances.documentId`. It has no published `documents/1` version yet, so
    // listings, detail and downloads do not show it until the contract exposes the direction.
    direction: v.optional(v.literal("emitted")),
    fiscalKey: v.string(),
    publishedVersionId: v.optional(v.id("documentVersions")),
    publicVersion: v.optional(v.number()),
    listedAt: v.optional(v.number()),
    projectionGeneration: v.optional(v.number()),
    projectionVerifyOriginals: v.optional(v.boolean()),
    evidenceBackfill: v.optional(v.boolean()),
    historyIndexing: v.optional(v.boolean()),
    projectionState: v.optional(projectionState),
    fiscalSituation: v.optional(fiscalView),
    completeness: v.number(),
    createdAt: v.number(),
    // ADR 0010, phase C: the passage of the note's content to the cold tier (`coldTier.ts`).
    // Absent while hot; `moving` from the claim until every published version is cold; `cold`
    // after. The row itself, its listing and its dedup key always stay hot (the residue).
    coldState: v.optional(v.union(v.literal("moving"), v.literal("cold"))),
    coldClaimedAt: v.optional(v.number()),
    coldAt: v.optional(v.number()),
  })
    .index("by_companyId_environment_listedAt", ["companyId", "environment", "listedAt"])
    .index("by_coldState_and_createdAt", ["coldState", "createdAt"])
    .index("by_organizationId_and_coldState", ["organizationId", "coldState"])
    .index("by_organizationId_companyId_environment_model_fiscalKey", [
      "organizationId",
      "companyId",
      "environment",
      "model",
      "fiscalKey",
    ])
    .index("by_organizationId_and_companyId_and_environment_and_completeness", [
      "organizationId",
      "companyId",
      "environment",
      "completeness",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  documentArtifacts: defineTable({
    ...archiveOriginFields,
    parentArtifactId: v.optional(v.id("documentArtifacts")),
    entryIndex: v.optional(v.number()),
    entrySha256: v.optional(v.string()),
    ...scopeFields,
    documentId: v.optional(v.id("fiscalDocuments")),
    fileId: v.optional(v.id("importFiles")),
    captureStreamId: v.optional(v.id("captureStreams")),
    processingOperationId: v.optional(v.id("operations")),
    // The raw XML in Convex file storage (hot), or, once its note went cold (ADR 0010, decision
    // 8), absent: the original then lives in the cold tier's bucket under `objectKey`, as the
    // gzip of the raw bytes. Exactly one of the two is set; `sha256` and `size` stay those of the
    // raw XML in both, and every read checks them (`lib/documentOriginalRead.ts`).
    storageId: v.optional(v.id("_storage")),
    objectKey: v.optional(v.string()),
    // The SHA-256 and size of the object's bytes (the gzip), so the backup and the ADR 0009
    // package check the bucket without decompressing.
    objectSha256: v.optional(v.string()),
    objectSize: v.optional(v.number()),
    sha256: v.string(),
    size: v.number(),
    source: v.union(v.literal("imported-xml"), v.literal("distribution-xml")),
    importedAt: v.number(),
  })
    .index("by_storageId", ["storageId"])
    .index("by_objectKey", ["objectKey"])
    .index("by_fileId", ["fileId"])
    .index("by_parentArtifactId_entryIndex", ["parentArtifactId", "entryIndex"])
    .index("by_companyId_environment_documentId_importedAt", [
      "companyId",
      "environment",
      "documentId",
      "importedAt",
    ])
    .index("by_documentId", ["documentId"]),
  documentVersions: defineTable({
    ...archiveOriginFields,
    parentVersionId: v.optional(v.id("documentVersions")),
    entryIndex: v.optional(v.number()),
    artifactId: v.id("documentArtifacts"),
    operationId: v.id("operations"),
    documentId: v.optional(v.id("fiscalDocuments")),
    state: v.union(v.literal("staging"), v.literal("complete")),
    code: v.string(),
    kind: v.string(),
    completeness: v.number(),
    schema: v.union(v.string(), v.null()),
    parserVersion: v.string(),
    normalizerVersion: v.union(v.string(), v.null()),
    processorVersion: v.string(),
    // ADR 0010, B8: absent once the content lives only in the verified blob (`contentStorageId`),
    // with `fiscalEvidence` and the version's `documentItems` rows. A version without a blob keeps
    // them inline for good.
    result: v.optional(v.string()),
    // Older complete versions stay readable; staging without a hash cannot resume.
    outputHash: v.optional(v.string()),
    fiscalEvidence: v.optional(v.string()),
    // B8: the SHA-256 of `fiscalEvidence` when the cleanup removed it, so `PROCESSING_CHANGED`
    // still compares a repeated stage with it (`importProcessing.stage`).
    fiscalEvidenceSha256: v.optional(v.string()),
    fiscalFingerprint: v.optional(v.string()),
    // ADR 0010, phase B: the gzip blob of `result`, `fiscalEvidence`, the items and the evidence
    // snapshot (`lib/documentContent.ts`), identified by the SHA-256 and size of its uncompressed
    // JSON, plus the card. Flat, so the storage inventories see the file field. B4 writes them
    // after publication (`lib/documentContentWriter.ts`); nothing reads them yet, and the inline
    // content stays required.
    contentStorageId: v.optional(v.id("_storage")),
    // ADR 0010, phase C: the same blob, byte for byte, once moved to the cold tier's bucket
    // (`lib/coldObjects.ts`). Exactly one of the two locations is set; the hash, size and format
    // below identify the content in both, and every read checks them.
    contentObjectKey: v.optional(v.string()),
    // The SHA-256 and size of the object's bytes (the gzip), so the backup checks the bucket
    // without decompressing (`scripts/lib/incremental-backup.mjs`).
    contentObjectSha256: v.optional(v.string()),
    contentObjectSize: v.optional(v.number()),
    contentSha256: v.optional(v.string()),
    contentSize: v.optional(v.number()),
    contentFormat: v.optional(v.literal(DOCUMENT_CONTENT_FORMAT)),
    card: v.optional(documentCard),
    // B7: when the audit (`contentMigration.ts`) read the blob back with its hash and found it
    // equal to the inline content. B8 clears the inline copy only of a version that has it.
    contentVerifiedAt: v.optional(v.number()),
    itemCount: v.number(),
    writtenItems: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
  })
    .index("by_operationId", ["operationId"])
    .index("by_parentVersionId", ["parentVersionId"])
    .index("by_operationId_entryIndex", ["operationId", "entryIndex"])
    .index("by_documentId", ["documentId"])
    .index("by_documentId_publishedAt", ["documentId", "publishedAt"])
    .index("by_documentId_kind_publishedAt", ["documentId", "kind", "publishedAt"])
    .index("by_artifactId", ["artifactId"])
    .index("by_artifactId_and_publishedAt", ["artifactId", "publishedAt"])
    .index("by_contentStorageId", ["contentStorageId"])
    .index("by_contentObjectKey", ["contentObjectKey"]),
  documentItems: defineTable({
    ...archiveOriginFields,
    versionId: v.id("documentVersions"),
    position: v.number(),
    data: v.string(),
  }).index("by_versionId_and_position", ["versionId", "position"]),
};
