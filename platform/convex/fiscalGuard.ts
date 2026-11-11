import { paginationOptsValidator, paginationResultValidator, type IndexRange } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { deny } from "./lib/organizationAccess";
import { purger, type Budget } from "./lib/purge";
import { purgePlanRecords } from "./lib/planCore";
import { storageHolders } from "./lib/storageHolders";
import { GUARD_RECHECK, decisionGuardUntil, fiscalGuardUntil } from "./lib/retentionClasses";

// Rows removed per transaction, as in the closure purge.
const BATCH = 200;
const TEXT = 200;
// Holders of one stored file read per table before deleting it; more keeps the file.
const SHARED = 20;
// Release, gate and probe events read to prove an organization never had Production; also the
// imported originals without a document and without a mark, and the versions of each one.
const EVENTS = 100;
const VERSIONS = 10;
// Parser outcomes of a file whose root is not an NF-e one: the only refusals known to hold no note.
const NOT_NFE = new Set(["XML_NAMESPACE_UNSUPPORTED", "XML_SOURCE_INVALID"]);
// About half of a mutation's limits for one early batch; the rest stays for the guard check.
const EARLY_LIMITS = {
  documentsRead: 16_000,
  documentsWritten: 8_000,
  bytesRead: 8 * 1024 * 1024,
  bytesWritten: 8 * 1024 * 1024,
  databaseQueries: 2_000,
  functionsScheduled: 500,
};

export function guardOf(closure: Doc<"organizationClosures">) {
  return fiscalGuardUntil(closure.requestedAt);
}

/** The fiscal guard first; once it ended, the `decision` class. Not settled yet: check now. */
function deadlineOf(closure: Doc<"organizationClosures">) {
  if (closure.expiredAt === undefined) return guardOf(closure);
  return closure.decisionUntil ?? Date.now();
}

/** Schedules the next check of the guard, at most `GUARD_RECHECK` ahead. */
export async function armGuard(
  ctx: MutationCtx,
  closure: Doc<"organizationClosures">,
  at = deadlineOf(closure),
) {
  const now = Date.now();
  const when = Math.min(Math.max(now, at), now + GUARD_RECHECK);
  const job = { closureId: closure._id, generation: closure.generation + 1 };
  const scheduledId =
    closure.expiredAt === undefined
      ? await ctx.scheduler.runAt(when, internal.fiscalGuard.expire, job)
      : await ctx.scheduler.runAt(when, internal.fiscalGuard.forget, job);
  await ctx.db.patch("organizationClosures", closure._id, {
    generation: job.generation,
    scheduledId,
  });
}

async function activeHolds(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const holds: Doc<"retentionHolds">[] = [];
  for await (const hold of ctx.db
    .query("retentionHolds")
    .withIndex("by_organizationId_and_reference", (q) => q.eq("organizationId", organizationId)))
    if (hold.releasedAt === undefined) holds.push(hold);
  return holds;
}
/** While a hold is active nothing goes; the next check is the earliest review still ahead. */
async function waitForHolds(
  ctx: MutationCtx,
  closure: Doc<"organizationClosures">,
  holds: Doc<"retentionHolds">[],
  now: number,
) {
  for (const hold of holds)
    if (hold.reviewAt <= now)
      console.warn(
        JSON.stringify({
          type: "retention.hold-review-due",
          organizationId: closure.organizationId,
          reference: hold.reference,
          reviewAt: hold.reviewAt,
        }),
      );
  const next = Math.min(...holds.map((h) => (h.reviewAt > now ? h.reviewAt : Infinity)));
  await armGuard(ctx, closure, next);
}

/**
 * The fiscal guard ends at its nominal deadline, or when the last hold that outlived it was
 * released; the `decision` class counts its year from there.
 */
async function decisionUntilOf(ctx: QueryCtx, closure: Doc<"organizationClosures">) {
  let end = guardOf(closure);
  for await (const hold of ctx.db
    .query("retentionHolds")
    .withIndex("by_organizationId_and_reference", (q) =>
      q.eq("organizationId", closure.organizationId),
    ))
    if (hold.releasedAt !== undefined && hold.releasedAt > end) end = hold.releasedAt;
  return decisionGuardUntil(end);
}
/** What the closure row no longer needs once the fiscal guard ended: requester, flag, counts. */
const MINIMUM = {
  requestedBy: undefined,
  revoked: undefined,
  removed: undefined,
  expired: undefined,
  sandboxOnly: undefined,
};

/**
 * The classes kept after the closure: fiscal documents and their originals, imports, capture,
 * operations with attempts and original audit, certificate audit, usage, plans, receipts and
 * idempotency. Files go with the last tree that holds them, unless another organization may hold
 * them too. Access records keep their own 184 days and are not touched here.
 */
async function expireBatch(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  b: Budget,
  early = false,
) {
  const { del, drain, all, parent, blob } = purger(ctx, b);
  /**
   * A stored file goes only when no row of another organization holds it, read over the same
   * holders as cold archive (`storageHolders`). Rows of this one go with it; reference data never
   * belongs to it. More than `SHARED` holders in one table keep the file; the
   * row goes anyway and the kept file is logged. A holder whose owner cannot be read keeps the
   * file too; in the early removal it throws instead, so the batch is undone and retried at the
   * next check. At the deadline it must not stop the guard.
   */
  const ownerOf = async (table: string, row: Record<string, unknown>) => {
    if (table === "importFiles")
      return (await ctx.db.get("imports", row.importId as Id<"imports">))?.organizationId;
    // The operation outlives its batches; the stream may already be gone.
    // Same for a version: on the operations path its artifact is already gone.
    if (table === "captureBatches" || table === "documentVersions")
      return (await ctx.db.get("operations", row.operationId as Id<"operations">))?.organizationId;
    if (table === "exportParts")
      return (await ctx.db.get("documentExports", row.exportId as Id<"documentExports">))
        ?.organizationId;
    if (
      ["documentArtifacts", "issuanceArtifacts", "capacityFiles", "documentDanfes"].includes(table)
    )
      return row.organizationId;
    return null;
  };
  const release = async (storageId: Id<"_storage"> | undefined) => {
    if (!storageId) return;
    let keep = false;
    for (const { table, query } of storageHolders(ctx, storageId)) {
      const rows = (await query.take(SHARED + 1)) as unknown as Record<string, unknown>[];
      if (rows.length > SHARED) keep = true;
      else
        for (const row of rows) {
          const owner = await ownerOf(table, row);
          if (early && owner === undefined) throw new Error("Unreadable file holder");
          if (owner !== organizationId) keep = true;
        }
    }
    if (!keep) return blob(storageId);
    console.warn(JSON.stringify({ type: "organization.file-kept", organizationId, storageId }));
  };
  const artifact = async (row: Doc<"documentArtifacts">): Promise<boolean> => {
    // A tree that crossed organizations would be a bug. Throwing rolls the batch back and leaves
    // no next job, so the guard stops visibly (failed function, `missing` in the recovery check)
    // until someone investigates. Returning false would re-arm and hit the same row forever.
    if (row.organizationId !== organizationId) throw new Error("Cross-organization artifact");
    const done = await drain<"documentArtifacts">(
      (n) =>
        ctx.db
          .query("documentArtifacts")
          .withIndex("by_parentArtifactId_entryIndex", (q) => q.eq("parentArtifactId", row._id))
          .take(n),
      artifact,
    );
    if (!done) return false;
    await release(row.storageId);
    // A cold original (ADR 0010, decision 8) is in the bucket: its deletion is queued in the same
    // transaction that deletes the artifact, as for a cold version.
    if (row.objectKey !== undefined)
      await ctx.db.insert("coldObjectDeletions", {
        organizationId,
        objectKey: row.objectKey,
        requestedAt: Date.now(),
      });
    return del("documentArtifacts")(row);
  };
  const version = parent("documentVersions", (row) => [
    () =>
      drain<"documentItems">(
        (n) =>
          ctx.db
            .query("documentItems")
            .withIndex("by_versionId_and_position", (q) => q.eq("versionId", row._id))
            .take(n),
        del("documentItems"),
      ),
    // The content blob (ADR 0010, phase B) goes with the version, which still holds it here.
    // A cold one (phase C) is in the bucket, out of reach of a mutation: its deletion is queued
    // for the cold tier's sweep, in the same transaction that deletes the version.
    async () => {
      await release(row.contentStorageId);
      if (row.contentObjectKey !== undefined)
        await ctx.db.insert("coldObjectDeletions", {
          organizationId,
          objectKey: row.contentObjectKey,
          requestedAt: Date.now(),
        });
      return true;
    },
  ]);
  const file = async (row: Doc<"importFiles">) => {
    const done = await drain<"documentArtifacts">(
      (n) =>
        ctx.db
          .query("documentArtifacts")
          .withIndex("by_fileId", (q) => q.eq("fileId", row._id))
          .take(n),
      artifact,
    );
    if (!done) return false;
    await release(row.storageId);
    return del("importFiles")(row);
  };
  const batch = async (row: Doc<"captureBatches">) => {
    const done = await drain<"captureBatchEntries">(
      (n) =>
        ctx.db
          .query("captureBatchEntries")
          .withIndex("by_batchId_position", (q) => q.eq("batchId", row._id))
          .take(n),
      del("captureBatchEntries"),
    );
    if (!done) return false;
    await release(row.rawId);
    return del("captureBatches")(row);
  };

  return all(
    () =>
      drain<"fiscalDocuments">(
        (n) =>
          ctx.db
            .query("fiscalDocuments")
            .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        parent("fiscalDocuments", (document) => [
          () =>
            drain<"documentListings">(
              (n) =>
                ctx.db
                  .query("documentListings")
                  .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
                  .take(n),
              del("documentListings"),
            ),
          () =>
            drain<"documentFiscalEvidence">(
              (n) =>
                ctx.db
                  .query("documentFiscalEvidence")
                  .withIndex("by_documentId_ruleVersion", (q) => q.eq("documentId", document._id))
                  .take(n),
              del("documentFiscalEvidence"),
            ),
          () =>
            drain<"documentVersions">(
              (n) =>
                ctx.db
                  .query("documentVersions")
                  .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
                  .take(n),
              version,
            ),
          () =>
            drain<"documentArtifacts">(
              (n) =>
                ctx.db
                  .query("documentArtifacts")
                  .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
                  .take(n),
              artifact,
            ),
        ]),
      ),
    () =>
      drain<"imports">(
        (n) =>
          ctx.db
            .query("imports")
            .withIndex("by_organizationId_and_projectId_and_key", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        parent("imports", (row) => [
          () =>
            drain<"importFiles">(
              (n) =>
                ctx.db
                  .query("importFiles")
                  .withIndex("by_importId", (q) => q.eq("importId", row._id))
                  .take(n),
              file,
            ),
        ]),
      ),
    () =>
      drain<"captureStreams">(
        (n) =>
          ctx.db
            .query("captureStreams")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        parent("captureStreams", (stream) => [
          () =>
            drain<"captureEnvelopes">(
              (n) =>
                ctx.db
                  .query("captureEnvelopes")
                  .withIndex("by_streamId_nsu", (q) => q.eq("streamId", stream._id))
                  .take(n),
              parent("captureEnvelopes", (envelope) => [
                async () => {
                  const row = await ctx.db.get("documentArtifacts", envelope.artifactId);
                  return row ? artifact(row) : true;
                },
              ]),
            ),
          () =>
            drain<"captureAudit">(
              (n) =>
                ctx.db
                  .query("captureAudit")
                  .withIndex("by_streamId", (q) => q.eq("streamId", stream._id))
                  .take(n),
              del("captureAudit"),
            ),
          () =>
            drain<"captureProofResponses">(
              (n) =>
                ctx.db
                  .query("captureProofResponses")
                  .withIndex("by_streamId", (q) => q.eq("streamId", stream._id))
                  .take(n),
              del("captureProofResponses"),
            ),
        ]),
      ),
    () =>
      drain<"issuances">(
        (n) =>
          ctx.db
            .query("issuances")
            .withIndex("by_organizationId_and_companyId_and_environment_and_createdAt", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        parent("issuances", (issuance) => [
          () =>
            drain<"issuanceArtifacts">(
              (n) =>
                ctx.db
                  .query("issuanceArtifacts")
                  .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuance._id))
                  .take(n),
              async (row) => {
                if (row.organizationId !== organizationId)
                  throw new Error("Cross-organization artifact");
                await release(row.storageId);
                return del("issuanceArtifacts")(row);
              },
            ),
          () =>
            drain<"issuanceEvents">(
              (n) =>
                ctx.db
                  .query("issuanceEvents")
                  .withIndex("by_issuanceId", (q) => q.eq("issuanceId", issuance._id))
                  .take(n),
              del("issuanceEvents"),
            ),
          () =>
            drain<"issuanceCancellations">(
              (n) =>
                ctx.db
                  .query("issuanceCancellations")
                  .withIndex("by_issuanceId", (q) => q.eq("issuanceId", issuance._id))
                  .take(n),
              del("issuanceCancellations"),
            ),
        ]),
      ),
    () =>
      drain<"dpsSequences">(
        (n) =>
          ctx.db
            .query("dpsSequences")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("dpsSequences"),
      ),
    () =>
      drain<"issuanceGateEvents">(
        (n) =>
          ctx.db
            .query("issuanceGateEvents")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("issuanceGateEvents"),
      ),
    () =>
      drain<"captureReleaseEvents">(
        (n) =>
          ctx.db
            .query("captureReleaseEvents")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("captureReleaseEvents"),
      ),
    () =>
      drain<"issuanceProbeEvents">(
        (n) =>
          ctx.db
            .query("issuanceProbeEvents")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("issuanceProbeEvents"),
      ),
    () =>
      drain<"issuanceSimulations">(
        (n) =>
          ctx.db
            .query("issuanceSimulations")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("issuanceSimulations"),
      ),
    // The ID map (ADR 0009, §6) goes with the fiscal rows it resolves; its stock with the capacity.
    () =>
      drain<"coldArchiveIdMap">(
        (n) =>
          ctx.db
            .query("coldArchiveIdMap")
            .withIndex("by_organizationId_and_previousId", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("coldArchiveIdMap"),
      ),
    () =>
      drain<"operations">(
        (n) =>
          ctx.db
            .query("operations")
            .withIndex("by_organizationId_and_projectId_and_environment", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        parent("operations", (operation) => [
          () =>
            drain<"operationAttempts">(
              (n) =>
                ctx.db
                  .query("operationAttempts")
                  .withIndex("by_operationId_and_generation_and_fence", (q) =>
                    q.eq("operationId", operation._id),
                  )
                  .take(n),
              del("operationAttempts"),
            ),
          () =>
            drain<"operationReceipts">(
              (n) =>
                ctx.db
                  .query("operationReceipts")
                  .withIndex("by_operationId_and_kind", (q) => q.eq("operationId", operation._id))
                  .take(n),
              del("operationReceipts"),
            ),
          () =>
            drain<"operationAudit">(
              (n) =>
                ctx.db
                  .query("operationAudit")
                  .withIndex("by_operationId", (q) => q.eq("operationId", operation._id))
                  .take(n),
              del("operationAudit"),
            ),
          () =>
            drain<"operationProofDocuments">(
              (n) =>
                ctx.db
                  .query("operationProofDocuments")
                  .withIndex("by_operationId", (q) => q.eq("operationId", operation._id))
                  .take(n),
              del("operationProofDocuments"),
            ),
          () =>
            drain<"registryCalls">(
              (n) =>
                ctx.db
                  .query("registryCalls")
                  .withIndex("by_operationId", (q) => q.eq("operationId", operation._id))
                  .take(n),
              del("registryCalls"),
            ),
          () =>
            drain<"documentVersions">(
              (n) =>
                ctx.db
                  .query("documentVersions")
                  .withIndex("by_operationId", (q) => q.eq("operationId", operation._id))
                  .take(n),
              version,
            ),
          () =>
            drain<"captureBatches">(
              (n) =>
                ctx.db
                  .query("captureBatches")
                  .withIndex("by_operationId", (q) => q.eq("operationId", operation._id))
                  .take(n),
              batch,
            ),
        ]),
      ),
    () =>
      drain<"idempotencyRecords">(
        (n) =>
          ctx.db
            .query("idempotencyRecords")
            .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("idempotencyRecords"),
      ),
    () =>
      drain<"certificateAudit">(
        (n) =>
          ctx.db
            .query("certificateAudit")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("certificateAudit"),
      ),
    () =>
      drain<"usageEvents">(
        (n) =>
          ctx.db
            .query("usageEvents")
            .withIndex("by_organizationId_and_metric_and_key", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("usageEvents"),
      ),
    () =>
      drain<"usageTotals">(
        (n) =>
          ctx.db
            .query("usageTotals")
            .withIndex("by_organizationId_and_period_and_metric_and_environment", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("usageTotals"),
      ),
    // Plans, payments, capacity and the accepted terms are Freecorps' own records: never removed early.
    async () => early || purgePlanRecords(ctx, organizationId, b),
    async () =>
      early ||
      drain<"usagePlans">(
        (n) =>
          ctx.db
            .query("usagePlans")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("usagePlans"),
      ),
    async () =>
      early ||
      drain<"termsOfUseAcceptances">(
        (n) =>
          ctx.db
            .query("termsOfUseAcceptances")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("termsOfUseAcceptances"),
      ),
    async () =>
      early ||
      drain<"usagePlanAudit">(
        (n) =>
          ctx.db
            .query("usagePlanAudit")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("usagePlanAudit"),
      ),
    () =>
      drain<"apiUsageEvents">(
        (n) =>
          ctx.db
            .query("apiUsageEvents")
            .withIndex("by_organizationId_and_day_and_shard", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("apiUsageEvents"),
      ),
    () =>
      drain<"apiUsageTotals">(
        (n) =>
          ctx.db
            .query("apiUsageTotals")
            .withIndex("by_organizationId_and_projectId_and_environment_and_route", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("apiUsageTotals"),
      ),
    () =>
      drain<"operationalRetention">(
        (n) =>
          ctx.db
            .query("operationalRetention")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        async (row) => {
          // Nothing is left for the compaction job to read.
          const job = await ctx.db.system.get("_scheduled_functions", row.scheduledId);
          if (job?.state.kind === "pending") await ctx.scheduler.cancel(row.scheduledId);
          return del("operationalRetention")(row);
        },
      ),
  );
}

/**
 * #108, decided on 04/11/2026: a received note counts as Production unless its own XML says
 * homologação (`tpAmb` "2"). The Sandbox environment only means the platform did not reach the
 * fisco: an imported NF-e of `tpAmb` 1 is real wherever it is stored, and a note without the mark
 * (a summary, a version from before #108, an ABRASF NFS-e) is not known to be a test one. Emitted
 * NFS-e of a Sandbox come from the simulator; those of Production have a Production row.
 */
async function realDocument(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const received = (tpAmb: "1" | undefined) =>
    ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_direction_and_tpAmb", (q) =>
        q.eq("organizationId", organizationId).eq("direction", undefined).eq("tpAmb", tpAmb),
      )
      .first();
  const found = await Promise.all([received("1"), received(undefined)]);
  return found.some((row) => row !== null) || (await realOriginal(ctx, organizationId));
}

/**
 * The same rule for an imported file refused without a document: its original is real when the
 * XML says Produção (`documentArtifacts.tpAmb` "1"). One without the mark is not known to be a test
 * one (a summary, a file refused before the mark, one the parser could not read) unless every
 * version found a root outside the NF-e namespace (`NOT_NFE`), and neither is one whose
 * processing never wrote a version. An accepted NFS-e batch, whose notes have documents, and a
 * captured original, which comes only through a capture release, are left to those reads.
 * Bounded: more unmarked originals than `EVENTS`, of any source, or versions of one than
 * `VERSIONS`, count as real.
 */
async function realOriginal(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const refused = (tpAmb: "1" | undefined) =>
    ctx.db
      .query("documentArtifacts")
      .withIndex("by_organizationId_and_documentId_and_tpAmb", (q) =>
        q.eq("organizationId", organizationId).eq("documentId", undefined).eq("tpAmb", tpAmb),
      );
  if (await refused("1").first()) return true;
  const unmarked = await refused(undefined).take(EVENTS + 1);
  if (unmarked.length > EVENTS) return true;
  for (const artifact of unmarked) {
    if (artifact.source !== "imported-xml" || artifact.nfseBatch) continue;
    const versions = await ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifact._id))
      .take(VERSIONS + 1);
    if (versions.length === 0 || versions.length > VERSIONS) return true;
    if (versions.some((version) => !NOT_NFE.has(version.code))) return true;
  }
  return false;
}

/**
 * The tables whose Production row is Production for `neverProduction`, read by
 * `by_organizationId_and_environment`. Every other table with an `environment` field has its
 * reason to stay out in `fiscalGuard.test.ts`, which fails on a table in neither list.
 */
export const PRODUCTION_TABLES = [
  "fiscalDocuments",
  "imports",
  "captureStreams",
  "issuances",
  "dpsSequences",
  "issuanceSimulations",
  "operations",
  "usageEvents",
  "usageTotals",
  "apiUsageEvents",
  "apiUsageTotals",
] as const;

/**
 * Decision of 27/10/2026, narrowed by #108: an organization that never had Production holds
 * nothing the guard exists for, since nothing it holds has fiscal validity. No table of
 * `PRODUCTION_TABLES` has a Production row; every received note says homologação
 * (`realDocument`); no capture release was ever granted and the issuance gate and the probe never
 * reached production (bounded: more events than `EVENTS` count as Production). A Production
 * Stripe connection issues only through the issuance gate, so the gate history covers it.
 */
async function neverProduction(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const found = await Promise.all(
    PRODUCTION_TABLES.map((table) =>
      ctx.db
        .query(table)
        .withIndex("by_organizationId_and_environment", (q) =>
          q.eq("organizationId", organizationId).eq("environment", "production"),
        )
        .first(),
    ),
  );
  if (found.some((row) => row !== null) || (await realDocument(ctx, organizationId))) return false;
  const org = (q: { eq(f: "organizationId", v: Id<"organizations">): IndexRange }) =>
    q.eq("organizationId", organizationId);
  const [released, gated, probed] = await Promise.all([
    ctx.db
      .query("captureReleaseEvents")
      .withIndex("by_organizationId", org)
      .take(EVENTS + 1),
    ctx.db
      .query("issuanceGateEvents")
      .withIndex("by_organizationId", org)
      .take(EVENTS + 1),
    ctx.db
      .query("issuanceProbeEvents")
      .withIndex("by_organizationId", org)
      .take(EVENTS + 1),
  ]);
  if ([released, gated, probed].some((rows) => rows.length > EVENTS)) return false;
  return !(
    released.some((row) => row.released) ||
    gated.some((row) => row.production) ||
    probed.some((row) => row.environment === "producao")
  );
}

/**
 * Decided once per closure, while its data is still in place (`organizationClosure.purge`). Cold
 * archive moves rows out of the tables read here, so any archive run counts as Production.
 */
export async function sandboxOnly(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const archived = await ctx.db
    .query("coldArchiveRuns")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .first();
  return archived === null && (await neverProduction(ctx, organizationId));
}

/**
 * One batch of the early removal, as a subtransaction of the guard check: the guarded set of a
 * purged organization that never had Production, with no active hold, as at the deadline, except
 * plans, payments and capacity. Anything else removes nothing. A closure purged before
 * 27/10/2026 has no decision yet: it is taken here, once.
 */
export const early = internalMutation({
  args: { closureId: v.id("organizationClosures") },
  returns: v.object({ done: v.boolean(), removed: v.number() }),
  handler: async (ctx, args) => {
    const closure = await ctx.db.get("organizationClosures", args.closureId);
    const idle = { done: true, removed: 0 };
    if (!closure || closure.state !== "purged" || closure.expiredAt !== undefined) return idle;
    const organizationId = closure.organizationId;
    if (await ctx.db.get("organizations", organizationId)) return idle;
    let only = closure.sandboxOnly;
    if (only === undefined) {
      only = await sandboxOnly(ctx, organizationId);
      await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: only });
    }
    if (!only) return idle;
    // A cold archive started after the decision moves rows away, and a decision taken before
    // #108 did not read the notes' own `tpAmb`, nor one taken before the mark of refused originals
    // (`realOriginal`) read those: stop, once, and leave the rest to the deadline.
    // Nothing writes notes of a purged organization, so a decision of today passes every batch.
    const archived = await ctx.db
      .query("coldArchiveRuns")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .first();
    const real = !archived && (await realDocument(ctx, organizationId));
    if (archived || real) {
      await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: false });
      console.warn(
        JSON.stringify({
          type: "organization.sandbox-purge-stopped",
          organizationId,
          reason: archived ? "cold-archive" : "fiscal-document",
        }),
      );
      return idle;
    }
    if ((await activeHolds(ctx, organizationId)).length) return idle;
    const budget = { left: BATCH };
    const done = await expireBatch(ctx, organizationId, budget, true);
    return { done, removed: BATCH - budget.left };
  },
});

/**
 * D01: ends the guard of a purged organization. Before the deadline it only removes an
 * organization that never had Production (`early`) and checks again later; while a hold is
 * active, it only checks again. Each batch continues through the scheduler until nothing is left.
 */
export const expire = internalMutation({
  args: { closureId: v.id("organizationClosures"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const closure = await ctx.db.get("organizationClosures", args.closureId);
    if (
      !closure ||
      closure.generation !== args.generation ||
      closure.state !== "purged" ||
      closure.expiredAt !== undefined
    )
      return null;
    const now = Date.now();
    const guardUntil = guardOf(closure);
    if (now < guardUntil) {
      let done = true;
      try {
        // Capped below the transaction's own limits, so this check can still re-arm the guard.
        const result: { done: boolean; removed: number } = await ctx.runMutation(
          internal.fiscalGuard.early,
          { closureId: closure._id },
          { transactionLimits: EARLY_LIMITS },
        );
        done = result.done;
        if (result.removed) {
          await ctx.db.patch("organizationClosures", closure._id, {
            expired: (closure.expired ?? 0) + result.removed,
          });
          // Copy this line to the restricted register, next to `organization.purged`.
          console.info(
            JSON.stringify({
              type: "organization.sandbox-purged",
              organizationId: closure.organizationId,
              removed: result.removed,
            }),
          );
        }
      } catch (error) {
        // The batch rolled back; the guard keeps everything and its schedule goes on.
        console.warn(
          JSON.stringify({
            type: "organization.sandbox-purge-failed",
            organizationId: closure.organizationId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      await armGuard(ctx, closure, done ? guardUntil : now);
      return null;
    }
    const holds = await activeHolds(ctx, closure.organizationId);
    if (holds.length) {
      await waitForHolds(ctx, closure, holds, now);
      return null;
    }
    const budget = { left: BATCH };
    const done = await expireBatch(ctx, closure.organizationId, budget);
    const expired = (closure.expired ?? 0) + BATCH - budget.left;
    if (!done) {
      await ctx.db.patch("organizationClosures", closure._id, { expired });
      await armGuard(ctx, closure, now);
      return null;
    }
    const decisionUntil = await decisionUntilOf(ctx, closure);
    await ctx.db.patch("organizationClosures", closure._id, {
      ...MINIMUM,
      expiredAt: now,
      decisionUntil,
    });
    // The holds lose their references at once; the decision then waits for its own deadline.
    await armGuard(ctx, (await ctx.db.get("organizationClosures", closure._id))!, now);
    // Copy this line to the restricted register, next to `organization.purged` (D05). The count
    // is not kept in the database.
    console.info(
      JSON.stringify({
        type: "organization.guard-expired",
        organizationId: closure.organizationId,
        requestedAt: closure.requestedAt,
        guardUntil,
        expiredAt: now,
        expired,
        decisionUntil,
      }),
    );
    return null;
  },
});

/**
 * Decision of 19/10/2026: the closure and its holds prove that the purge happened, so they
 * outlive the fiscal guard by the `decision` class, then go too. Meanwhile they keep only ids
 * and dates. An active hold stops it as it stops the guard. Each batch continues through the
 * scheduler; once the closure row is gone, nothing is left to run again.
 */
export const forget = internalMutation({
  args: { closureId: v.id("organizationClosures"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let closure = await ctx.db.get("organizationClosures", args.closureId);
    if (!closure || closure.generation !== args.generation || closure.expiredAt === undefined)
      return null;
    const organizationId = closure.organizationId;
    const now = Date.now();
    // A closure that expired before this version gets the same deadline and the same minimum.
    if (closure.decisionUntil === undefined) {
      await ctx.db.patch("organizationClosures", closure._id, {
        ...MINIMUM,
        decisionUntil: await decisionUntilOf(ctx, closure),
      });
      closure = (await ctx.db.get("organizationClosures", closure._id))!;
    }
    const holds = await activeHolds(ctx, organizationId);
    if (holds.length) {
      await waitForHolds(ctx, closure, holds, now);
      return null;
    }
    // Released holds keep ids and dates; the reference stays in the restricted register of D02.
    const named = await ctx.db
      .query("retentionHolds")
      .withIndex("by_organizationId_and_reference", (q) =>
        q.eq("organizationId", organizationId).gt("reference", ""),
      )
      .take(BATCH);
    for (const hold of named)
      await ctx.db.patch("retentionHolds", hold._id, {
        reference: undefined,
        responsible: undefined,
      });
    if (named.length === BATCH) {
      await armGuard(ctx, closure, now);
      return null;
    }
    const decisionUntil = closure.decisionUntil!;
    if (now < decisionUntil) {
      await armGuard(ctx, closure, decisionUntil);
      return null;
    }
    const rows = await ctx.db
      .query("retentionHolds")
      .withIndex("by_organizationId_and_reference", (q) => q.eq("organizationId", organizationId))
      .take(BATCH);
    for (const hold of rows) await ctx.db.delete("retentionHolds", hold._id);
    if (rows.length === BATCH) {
      await armGuard(ctx, closure, now);
      return null;
    }
    await ctx.db.delete("organizationClosures", closure._id);
    // The last trace of the organization in the database: copy it to the restricted register.
    console.info(
      JSON.stringify({
        type: "organization.decision-expired",
        organizationId,
        requestedAt: closure.requestedAt,
        expiredAt: closure.expiredAt,
        decisionUntil,
        removedAt: now,
      }),
    );
    return null;
  },
});

function text(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TEXT) return deny("INVALID_REQUEST");
  return trimmed;
}
async function closureFor(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
}
async function holdOf(ctx: QueryCtx, organizationId: Id<"organizations">, reference: string) {
  return ctx.db
    .query("retentionHolds")
    .withIndex("by_organizationId_and_reference", (q) =>
      q.eq("organizationId", organizationId).eq("reference", reference),
    )
    .unique();
}

/**
 * Operator only. Keeps the conserved classes of the organization past the guard while a fiscal
 * inspection, lawsuit or formal request of an authority lasts. The same reference again only
 * moves the review date. Register the hold before the guard ends; it does not undo a purge.
 */
export const hold = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    reference: v.string(),
    responsible: v.string(),
    reviewAt: v.number(),
  },
  returns: v.union(v.literal("held"), v.literal("expired")),
  handler: async (ctx, args) => {
    const reference = text(args.reference);
    const responsible = text(args.responsible);
    const now = Date.now();
    if (!Number.isFinite(args.reviewAt) || args.reviewAt <= now) return deny("INVALID_REQUEST");
    const closure = await closureFor(ctx, args.organizationId);
    if (!closure && !(await ctx.db.get("organizations", args.organizationId)))
      return deny("NOT_FOUND");
    if (closure?.expiredAt !== undefined) return "expired";
    const current = await holdOf(ctx, args.organizationId, reference);
    if (current)
      await ctx.db.patch("retentionHolds", current._id, {
        responsible,
        reviewAt: args.reviewAt,
        releasedAt: undefined,
      });
    else
      await ctx.db.insert("retentionHolds", {
        organizationId: args.organizationId,
        reference,
        responsible,
        reviewAt: args.reviewAt,
        createdAt: now,
      });
    return "held";
  },
});

/** Operator only. Ends a hold; with no other hold left, an expired guard purges at once. */
export const release = internalMutation({
  args: { organizationId: v.id("organizations"), reference: v.string() },
  returns: v.object({ active: v.number() }),
  handler: async (ctx, args) => {
    const current = await holdOf(ctx, args.organizationId, text(args.reference));
    if (!current) return deny("NOT_FOUND");
    if (current.releasedAt === undefined)
      await ctx.db.patch("retentionHolds", current._id, { releasedAt: Date.now() });
    const active = (await activeHolds(ctx, args.organizationId)).length;
    const closure = await closureFor(ctx, args.organizationId);
    if (!active && closure?.state === "purged") await armGuard(ctx, closure);
    return { active };
  },
});

const holdRecord = v.object({
  organizationId: v.id("organizations"),
  reference: v.union(v.string(), v.null()),
  responsible: v.union(v.string(), v.null()),
  reviewAt: v.number(),
  createdAt: v.number(),
  releasedAt: v.union(v.number(), v.null()),
});
/** Operator export of the holds for the off-database register; a restore must reapply them. */
export const holds = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(holdRecord),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("retentionHolds").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((h) => ({
        organizationId: h.organizationId,
        reference: h.reference ?? null,
        responsible: h.responsible ?? null,
        reviewAt: h.reviewAt,
        createdAt: h.createdAt,
        releasedAt: h.releasedAt ?? null,
      })),
    };
  },
});
