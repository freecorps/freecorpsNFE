import type { GenericValidator } from "convex/values";
import { ARCHIVE_TABLES, isArchiveFence } from "./coldArchiveCore";

/**
 * The reference inventory of the rehydration under new IDs (ADR 0009, §5, item 5). The list of
 * fields comes from the schema, never from a hand-written enumeration: every `v.id` pointing to a
 * table of `ARCHIVE_TABLES` or to `_storage`, in any table, at any depth (objects, arrays,
 * records, unions, optionals). `ARCHIVE_ID_REFERENCES` then classifies each of them, and
 * `archiveReferenceCoverage` fails when the schema has a field without classification or the
 * classification names a field the schema no longer has, as the `satisfies` of
 * `retentionClasses.ts` fails for a table without class.
 */
export type ArchiveReference = {
  table: string;
  /** Dotted path; `[]` marks an array element and `{}` a record value (`{key}` its key). */
  path: string;
  target: string;
};
type SchemaLike = { tables: Record<string, { validator: GenericValidator }> };

const referencedTables = new Set<string>([...ARCHIVE_TABLES, "_storage"]);

/** Calls `found` for every leaf validator with its path, through objects, arrays, records, unions. */
function walk(
  validator: GenericValidator,
  path: string,
  found: (path: string, leaf: GenericValidator) => void,
) {
  switch (validator.kind) {
    case "object":
      for (const [name, field] of Object.entries(validator.fields))
        walk(field, path ? `${path}.${name}` : name, found);
      return;
    case "array":
      walk(validator.element, `${path}[]`, found);
      return;
    case "record":
      walk(validator.key, `${path}{key}`, found);
      walk(validator.value, `${path}{}`, found);
      return;
    case "union":
      for (const member of validator.members) walk(member, path, found);
      return;
    default:
      found(path, validator);
  }
}

/**
 * Every field path of the schema whose validator is `v.id(T)`, with `T` an archived table or
 * `_storage`, sorted by table and path. A path found in several members of a union appears once
 * per target.
 */
export function archiveReferences(schema: SchemaLike): ArchiveReference[] {
  const seen = new Map<string, ArchiveReference>();
  for (const [table, definition] of Object.entries(schema.tables))
    walk(definition.validator, "", (path, leaf) => {
      if (leaf.kind !== "id" || !referencedTables.has(leaf.tableName)) return;
      seen.set(`${table}.${path}\u0000${leaf.tableName}`, {
        table,
        path,
        target: leaf.tableName,
      });
    });
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value);
}

/**
 * - `rewritten`: the rehydration's second pass replaces the original ID with the new one from the
 *   ID map, in rehydrated rows and in the organization's hot rows alike.
 * - `kept`: never rewritten. References to the fence (`ARCHIVE_FENCE_TABLES`) keep resolving
 *   because the fence never leaves; files outside the package keep their storage ID.
 * - `recreated`: capacity inventory. `removeHotBatch` deletes it with the rows and files, and the
 *   rehydration tracks the new IDs again (`trackDatabaseRecord`, `trackStoredFile`).
 */
export type ReferenceAction = "rewritten" | "kept" | "recreated";

/**
 * Classification of every schema reference to an archived table or to a stored file, keyed by
 * `table.path`. A reference to the fence is always `kept`.
 */
export const ARCHIVE_ID_REFERENCES = {
  // Capacity inventory is recreated for the new storage IDs, never rewritten (§5, item 5).
  "capacityFiles.storageId": "recreated",
  // References to the fence: same ID before and after.
  "captureAlerts.streamId": "kept",
  "captureAudit.streamId": "kept",
  "captureBatches.streamId": "kept",
  "captureEnvelopes.streamId": "kept",
  "captureProofResponses.streamId": "kept",
  "documentArtifacts.captureStreamId": "kept",
  // Temporary export files, global reference data and privacy mail never enter a package.
  "exportParts.storageId": "kept",
  "privacyIntakes.raw": "kept",
  "privacyMessages.raw": "kept",
  "referenceVersions.storageId": "kept",
  // Archived rows and stored originals.
  "captureAudit.batchId": "rewritten",
  "captureBatchEntries.batchId": "rewritten",
  "captureBatchEntries.envelopeId": "rewritten",
  "captureBatches.operationId": "rewritten",
  "captureBatches.rawId": "rewritten",
  "captureEnvelopes.artifactId": "rewritten",
  "captureEnvelopes.batchId": "rewritten",
  "captureEnvelopes.operationId": "rewritten",
  // A fence row stays hot but may point to an archived operation (empty when quiescent).
  "captureStreams.operationId": "rewritten",
  "certificateAudit.operationId": "rewritten",
  "documentArtifacts.documentId": "rewritten",
  "documentArtifacts.fileId": "rewritten",
  "documentArtifacts.parentArtifactId": "rewritten",
  "documentArtifacts.processingOperationId": "rewritten",
  // Absent on a cold original (ADR 0010, decision 8): nothing to rewrite, the row is kept as is.
  "documentArtifacts.storageId": "rewritten",
  "documentFiscalEvidence.documentId": "rewritten",
  "documentFiscalEvidence.versionId": "rewritten",
  "documentItems.versionId": "rewritten",
  "documentListings.documentId": "rewritten",
  "documentVersions.artifactId": "rewritten",
  // The content blob (ADR 0010, phase B) gets a new storage ID; the blob itself is never
  // rewritten: IDs inside it stay `kept`, like those of `documentVersions.result`, so its
  // `contentSha256` still holds.
  "documentVersions.contentStorageId": "rewritten",
  "documentVersions.documentId": "rewritten",
  "documentVersions.operationId": "rewritten",
  "documentVersions.parentVersionId": "rewritten",
  "fiscalDocuments.publishedVersionId": "rewritten",
  "importFiles.importId": "rewritten",
  "importFiles.operationId": "rewritten",
  "importFiles.processingOperationId": "rewritten",
  "importFiles.storageId": "rewritten",
  "issuanceArtifacts.cancellationId": "rewritten",
  "issuanceArtifacts.issuanceId": "rewritten",
  "issuanceArtifacts.storageId": "rewritten",
  "issuanceCancellations.issuanceId": "rewritten",
  "issuanceCancellations.operationId": "rewritten",
  "issuanceEvents.issuanceId": "rewritten",
  "issuanceEvents.operationId": "rewritten",
  "issuances.cancellationId": "rewritten",
  "issuances.documentId": "rewritten",
  "issuances.operationId": "rewritten",
  "operationAttempts.operationId": "rewritten",
  "operationAudit.operationId": "rewritten",
  "operationProofDocuments.operationId": "rewritten",
  // Hot rows of the organization (closure, commercial and control classes) pointing into the archive.
  "documentDownloads.artifactId": "rewritten",
  // The DANFE cache stays hot; its document is rewritten, its PDF is not in the package.
  "documentDanfes.documentId": "rewritten",
  "documentDanfes.storageId": "kept",
  "documentExports.selection.documentId": "rewritten",
  "idempotencyRecords.operationId": "rewritten",
  "issuanceProbeEvents.issuanceId": "rewritten",
  "operationReceipts.operationId": "rewritten",
  "operationalAudit.operationId": "rewritten",
  "operationalFailures.operationId": "rewritten",
  // A global row (by CNPJ, no organization index). The pointer only matters until `pendingUntil`,
  // the operation's lease, and the freeze proves no operation of the organization is running, so
  // it can only name an operation that already ended; `registryStore` ignores it then.
  "registryCache.pendingOperationId": "kept",
  "registryCalls.operationId": "rewritten",
  "stripeEvents.issuanceId": "rewritten",
} as const satisfies Record<string, ReferenceAction>;

/**
 * Text fields that hold, or may hold, the ID of an archived row. The schema cannot tell them
 * apart from any other string, so this list is explicit (§5, item 5):
 *
 * - `recreated`: `capacityRecords.key` (`table:id`) is rebuilt for the new ID with the inventory,
 *   outside the rewritten fields;
 * - `kept`: records of what already happened keep the old ID, and whoever reads them after the
 *   rehydration resolves it through the ID map. Text inside an archived row enters the canonical
 *   hash check as it is;
 * - `firstId`: deduplication keys composed by code with IDs of archived rows. They are not
 *   rewritten; the code that composes them uses each row's first ID (`firstId`), so a repetition
 *   after a reactivation finds the same key and never redoes the effect.
 */
export type TextReferenceAction = "recreated" | "kept" | "firstId";
export const ARCHIVE_TEXT_REFERENCES = {
  "capacityRecords.key": "recreated",
  "capacityEvents.key": "kept",
  "outboxEvents.resourceId": "kept",
  "outboxEvents.logicalKey": "kept",
  "outboxEvents.body": "kept",
  "operations.request": "kept",
  "operations.response": "kept",
  "idempotencyRecords.key": "firstId",
  // Usage keys: imported file, document, issuance and operation IDs (`recordUsage`).
  "usageEvents.key": "firstId",
  // `${operationId}:${fence}` in archived rows; never pending in a quiescent organization.
  "operations.usageCaptureKey": "kept",
  "captureBatches.usageKey": "kept",
  // The operation's lease; expired before the freeze.
  "usageLeases.key": "kept",
  // Alert deduplication keys with the operation ID (`captureSupervision.ts`).
  "captureAlerts.key": "kept",
  // The audited target: an imported file, a document, an export.
  "operationalAudit.target": "kept",
  // JSON of archived rows: processing results and proof responses.
  "documentVersions.result": "kept",
  "operationProofDocuments.response": "kept",
  // The catalogue of a past cycle and its fence snapshots name the IDs that cycle archived.
  "coldArchiveEntries.originalId": "kept",
  "coldArchiveEntries.snapshot": "kept",
  // The ID map itself: one cycle's previous and new IDs, composed by the chain, never rewritten.
  "coldArchiveIdMap.previousId": "kept",
  "coldArchiveIdMap.newId": "kept",
  // The upload intent: the original storage ID of its cycle, like the map's previous ID, and the
  // new one it recorded.
  "coldArchiveUploads.previousId": "kept",
  "coldArchiveUploads.storageId": "kept",
  // ADR 0010, C2: the cold object a rehydrated original went to, and the import file that let go
  // of it, as that cycle wrote them; the canonical check of the same cycle reads them.
  "coldArchiveUploads.objectKey": "kept",
  "coldArchiveUploads.importFileId": "kept",
  // The notes of the batch under way of a rehydration's cold stage: this cycle's IDs.
  "coldArchiveRuns.rehydration.cold.batch.documentIds": "kept",
  // ADR 0010, phase C: the cold object's key names the organization and the version that wrote
  // it. It is a pointer to bytes checked by hash, never resolved as an ID, so it stays as written.
  "documentVersions.contentObjectKey": "kept",
  // Decision 8: the same for a cold XML original, keyed by its artifact and raw hash.
  "documentArtifacts.objectKey": "kept",
  "coldObjectDeletions.objectKey": "kept",
  "coldObjectUploads.objectKey": "kept",
} as const satisfies Record<string, TextReferenceAction>;

/**
 * Candidate string fields checked to hold no ID of an archived row: identifiers of the tax
 * authority, Stripe, GitHub, Better Auth, workpool and requests, client keys, hashes, and IDs of
 * tables that are never archived (companies, projects, keys, memberships, invitations, runs).
 */
export const ARCHIVE_TEXT_UNRELATED = [
  "apiUsageEvents.requestId",
  // Assisted export requests (ADR 0009, §7): the support ticket and the Better Auth user.
  "assistedExports.authUserId",
  "assistedExports.key",
  "billingAccounts.customerId",
  "billingAccounts.openInvoice.id",
  "billingAccounts.subscription.id",
  "billingCheckouts.key",
  "billingCheckouts.sessionId",
  "billingCheckouts.subscriptionId",
  "billingEvents.chargeId",
  "billingEvents.customerId",
  "billingEvents.objectId",
  "billingEvents.stripeEventId",
  "billingGrants.invoiceId",
  "captureReleaseEvents.runId",
  "certificateAudit.result",
  "certificates.uploaderId",
  "coldArchiveRuns.key",
  "coldArchiveRuns.verifierRunId",
  "companyAudit.actorUserId",
  "documentExports.key",
  "documentFiscalEvidence.snapshot",
  "documentItems.data",
  "documentListings.filterKey",
  "fiscalDocuments.fiscalKey",
  "fiscalDocuments.fiscalSituation.evidenceIds",
  "fiscalDocuments.fiscalSituation.excluded.id",
  "fiscalDocuments.fiscalSituation.key",
  "imports.key",
  "integrationAudit.actorUserId",
  "integrationAudit.target",
  "issuanceGateEvents.runId",
  "issuanceProbeEvents.reads.target",
  "issuanceSimulations.accessKey",
  "issuanceSimulations.dpsId",
  "issuances.accessKey",
  "issuances.dpsId",
  "issuances.snapshot",
  "issuances.target",
  "memberships.authUserId",
  "operationAttempts.diagnostic.body",
  "operationalAlerts.target",
  "operationalAudit.eventId",
  "operationalAudit.requestId",
  "operationalMonitors.metrics.target",
  "operations.workId",
  "organizationAudit.actorUserId",
  "organizationAudit.target",
  "outboxEvents.eventId",
  "platformFreeClaims.authUserId",
  "platformPlanRequests.key",
  // The operator's idempotency keys of a rescission and of a withdrawn upgrade (ADR 0010, D3).
  "platformPlanTerms.rescission.key",
  "platformPlanTerms.stripeSubscriptionId",
  "platformPlanTerms.undoneUpgrades.key",
  "privacyIntakes.key",
  "privacyMessages.actorId",
  "privacyMessages.messageId",
  "privacyMessages.requestId",
  "registryApplications.actorUserId",
  // A pre-creation lookup: the Better Auth user and the client's idempotency key.
  "registryLookups.actorUserId",
  "registryLookups.key",
  "sandboxClosureNotices.key",
  "stripeEvents.charge.id",
  "stripeEvents.charge.paymentIntentId",
  "stripeEvents.chargeId",
  "stripeEvents.paymentIntentId",
  "stripeEvents.reversal.id",
  "stripeEvents.reversal.paymentIntentId",
  "stripeEvents.stripeEventId",
] as const;

/** Field names that suggest an ID, a key composed with IDs or a JSON payload that may carry one. */
const TEXT_ID_NAME =
  /(?:^|\.)(?:id|key|body|request|response|target|snapshot|data|result)$|Ids?$|Key$/;

/**
 * String fields the text guard inspects: in tables of an organization (with `organizationId`),
 * archived tables and tables that reference them, a `v.string()` whose name ends in `Id`, `Ids`,
 * `Key` or is `id`, `key`, `body`, `request`, `response`, `target`, `snapshot`, `data` or `result`.
 * Array markers are dropped from the path. The schema cannot prove a string holds no ID, so each
 * one needs an explicit decision in `ARCHIVE_TEXT_REFERENCES` or `ARCHIVE_TEXT_UNRELATED`.
 */
export function archiveTextCandidates(schema: SchemaLike): string[] {
  const related = new Set<string>([
    ...ARCHIVE_TABLES,
    ...archiveReferences(schema).map((reference) => reference.table),
  ]);
  const found = new Set<string>();
  for (const [table, definition] of Object.entries(schema.tables)) {
    const strings: string[] = [];
    let organization = false;
    walk(definition.validator, "", (path, leaf) => {
      if (path === "organizationId" && leaf.kind === "id") organization = true;
      if (leaf.kind === "string") strings.push(path.replaceAll("[]", ""));
    });
    if (!organization && !related.has(table)) continue;
    // `originId` is the first ID of the row itself (§5, item 6): written once, never rewritten.
    for (const path of strings)
      if (path !== "originId" && TEXT_ID_NAME.test(path)) found.add(`${table}.${path}`);
  }
  return [...found].sort();
}

/**
 * Coverage of both classifications against a schema. Every list is empty when the schema and
 * the classifications agree:
 *
 * - `unclassified`: `v.id` references without an entry in `ids`;
 * - `stale`: entries of `ids` the schema no longer has;
 * - `fenceRewritten`: a reference to the fence classified as anything but `kept`;
 * - `textUnclassified`: candidate strings in neither text list;
 * - `textStale`: text entries naming a field the schema does not have as a string.
 */
export function archiveReferenceCoverage(
  schema: SchemaLike,
  ids: Record<string, ReferenceAction> = ARCHIVE_ID_REFERENCES,
  text: Record<string, TextReferenceAction> = ARCHIVE_TEXT_REFERENCES,
  unrelated: readonly string[] = ARCHIVE_TEXT_UNRELATED,
) {
  const references = archiveReferences(schema);
  const fields = new Set(references.map(({ table, path }) => `${table}.${path}`));
  const strings = new Set<string>();
  for (const [table, definition] of Object.entries(schema.tables))
    walk(definition.validator, "", (path, leaf) => {
      if (leaf.kind === "string") strings.add(`${table}.${path.replaceAll("[]", "")}`);
    });
  const decided = new Set([...Object.keys(text), ...unrelated]);
  return {
    unclassified: [...fields].filter((field) => !(field in ids)),
    stale: Object.keys(ids).filter((field) => !fields.has(field)),
    fenceRewritten: references
      .filter(({ target }) => isArchiveFence(target))
      .map(({ table, path }) => `${table}.${path}`)
      .filter((field) => ids[field] !== undefined && ids[field] !== "kept"),
    textUnclassified: archiveTextCandidates(schema).filter((field) => !decided.has(field)),
    textStale: [...decided].filter((field) => !strings.has(field)),
  };
}
