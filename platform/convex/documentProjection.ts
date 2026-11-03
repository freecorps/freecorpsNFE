import { insertFiscal, patchFiscal } from "./lib/capacityCore";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ProcessedNfe } from "@freecorps/fiscal-nfe";
import schema from "./schema";
import { fiscalView, projectionState } from "./lib/documentValues";
import { documentAccess, updateListings, type DocumentScope } from "./lib/documentCore";
import { companyScopeFields } from "./lib/operationValues";
import { documentEvent } from "./lib/webhookOutbox";

export async function recordEvidence(
  ctx: MutationCtx,
  version: Doc<"documentVersions">,
  snapshot: string,
  fingerprint: string,
) {
  if (!version.documentId) return;
  const evidence = JSON.parse(snapshot) as ProcessedNfe;
  const originalSha256 = evidence.metadata!.originalSha256;
  const existing = await ctx.db
    .query("documentFiscalEvidence")
    .withIndex("by_variant", (q) =>
      q
        .eq("documentId", version.documentId!)
        .eq("ruleVersion", "nfe-status/1")
        .eq("originalSha256", originalSha256)
        .eq("fingerprint", fingerprint),
    )
    .unique();
  if (!existing) {
    await insertFiscal(ctx, "documentFiscalEvidence", {
      documentId: version.documentId,
      ruleVersion: "nfe-status/1",
      originalSha256,
      fingerprint,
      snapshot,
      versionId: version._id,
    });
    if (version.kind === "event") {
      const doc = (await ctx.db.get("fiscalDocuments", version.documentId))!;
      await documentEvent(
        ctx,
        doc,
        "document.event_received",
        `evidence:${originalSha256}:${fingerprint}`,
        version.operationId,
      );
    }
  }
}
export const record = internalMutation({
  args: { versionId: v.id("documentVersions"), snapshot: v.string(), fingerprint: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const version = await ctx.db.get("documentVersions", args.versionId);
    const op = version ? await ctx.db.get("operations", version.operationId) : null;
    if (version?.state === "complete" && op?.state === "succeeded")
      await recordEvidence(ctx, version, args.snapshot, args.fingerprint);
    return null;
  },
});
export const evidencePage = internalQuery({
  args: {
    documentId: v.id("fiscalDocuments"),
    generation: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.union(
    v.null(),
    v.object({
      rows: v.array(schema.doc("documentFiscalEvidence")),
      verifyOriginals: v.boolean(),
      versions: v.array(schema.doc("documentVersions")),
      artifacts: v.array(schema.doc("documentArtifacts")),
      cursor: v.string(),
      done: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc || doc.projectionGeneration !== args.generation) return null;
    const batch = await ctx.db
      .query("documentFiscalEvidence")
      .withIndex("by_documentId_ruleVersion", (q) =>
        q.eq("documentId", doc._id).eq("ruleVersion", "nfe-status/1"),
      )
      .paginate(args.paginationOpts);
    const versions = (
      await Promise.all(batch.page.map((row) => ctx.db.get("documentVersions", row.versionId)))
    ).filter((v) => v !== null);
    const artifacts = (
      await Promise.all(
        versions.map((version) => ctx.db.get("documentArtifacts", version.artifactId)),
      )
    ).filter((a) => a !== null);
    return {
      rows: batch.page,
      verifyOriginals: doc.projectionVerifyOriginals ?? false,
      versions,
      artifacts,
      cursor: batch.continueCursor,
      done: batch.isDone,
    };
  },
});

export async function requestProjection(
  ctx: MutationCtx,
  documentId: Id<"fiscalDocuments">,
  originals = false,
) {
  const doc = await ctx.db.get("fiscalDocuments", documentId);
  if (!doc?.publishedVersionId) return;
  if (doc.model === "nfse") {
    await patchFiscal(ctx, "fiscalDocuments", doc._id, { projectionState: "ready" });
    await updateListings(ctx, { ...doc, projectionState: "ready" });
    return;
  }
  const generation = (doc.projectionGeneration ?? 0) + 1;
  await patchFiscal(ctx, "fiscalDocuments", doc._id, {
    projectionGeneration: generation,
    projectionVerifyOriginals: originals || doc.projectionVerifyOriginals === true,
    projectionState: "pending",
  });
  await updateListings(ctx, (await ctx.db.get("fiscalDocuments", doc._id))!);
  if (doc.historyIndexing) {
    await ctx.scheduler.runAfter(0, internal.documentProjection.backfillVersions, {
      documentId,
      generation,
      cursor: null,
    });
    return;
  }
  if (doc.evidenceBackfill)
    await ctx.scheduler.runAfter(0, internal.documentProjectionWorker.backfill, {
      documentId,
      generation,
      cursor: null,
    });
  else
    await ctx.scheduler.runAfter(0, internal.documentProjectionWorker.rebuild, {
      documentId,
      generation,
      originals,
    });
}
export const page = internalQuery({
  args: {
    documentId: v.id("fiscalDocuments"),
    generation: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.union(
    v.null(),
    v.object({
      versions: v.array(schema.doc("documentVersions")),
      artifacts: v.array(schema.doc("documentArtifacts")),
      cursor: v.string(),
      done: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc || doc.projectionGeneration !== args.generation) return null;
    const batch = await ctx.db
      .query("documentVersions")
      .withIndex("by_documentId_publishedAt", (q) =>
        q.eq("documentId", doc._id).gt("publishedAt", 0),
      )
      .paginate(args.paginationOpts);
    const artifacts = await Promise.all(
      batch.page.map((version) => ctx.db.get("documentArtifacts", version.artifactId)),
    );
    return {
      versions: batch.page,
      artifacts: artifacts.filter((a) => a !== null),
      cursor: batch.continueCursor,
      done: batch.isDone,
    };
  },
});
export const finish = internalMutation({
  args: {
    documentId: v.id("fiscalDocuments"),
    generation: v.number(),
    state: projectionState,
    situation: v.union(fiscalView, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc || doc.projectionGeneration !== args.generation) return null;
    await patchFiscal(ctx, "fiscalDocuments", doc._id, {
      projectionState: args.state,
      projectionVerifyOriginals: false,
      ...(args.situation ? { fiscalSituation: args.situation } : {}),
    });
    if (
      args.situation &&
      JSON.stringify(doc.fiscalSituation ?? null) !== JSON.stringify(args.situation)
    )
      await documentEvent(ctx, doc, "document.updated", `projection:${args.generation}`);
    await updateListings(ctx, (await ctx.db.get("fiscalDocuments", doc._id))!);
    return null;
  },
});
/** Idempotent bounded backfill. The caller must authorize the company before starting it. */
export async function prepareCompany(ctx: MutationCtx, scope: DocumentScope) {
  const docs = await ctx.db
    .query("fiscalDocuments")
    .withIndex("by_companyId_environment_listedAt", (q) =>
      q
        .eq("companyId", scope.companyId)
        .eq("environment", scope.environment)
        .eq("listedAt", undefined),
    )
    .take(20);
  for (const doc of docs) {
    if (doc.publishedVersionId) {
      const generation = (doc.projectionGeneration ?? 0) + 1;
      await patchFiscal(ctx, "fiscalDocuments", doc._id, {
        evidenceBackfill: true,
        historyIndexing: true,
        projectionGeneration: generation,
        projectionState: "pending",
      });
      await updateListings(ctx, (await ctx.db.get("fiscalDocuments", doc._id))!);
      await ctx.scheduler.runAfter(0, internal.documentProjection.backfillVersions, {
        documentId: doc._id,
        generation,
        cursor: null,
      });
    } else await patchFiscal(ctx, "fiscalDocuments", doc._id, { listedAt: Date.now() });
  }
  if (docs.length === 20)
    await ctx.scheduler.runAfter(0, internal.documentProjection.prepare, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      environment: scope.environment,
    });
}
export const backfillVersions = internalMutation({
  args: {
    documentId: v.id("fiscalDocuments"),
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc?.historyIndexing || doc.projectionGeneration !== args.generation) return null;
    const page = await ctx.db
      .query("documentVersions")
      .withIndex("by_documentId", (q) => q.eq("documentId", args.documentId))
      .paginate({
        cursor: args.cursor,
        numItems: 10,
        maximumRowsRead: 10,
        maximumBytesRead: 1_500_000,
      });
    for (const version of page.page) {
      const op = await ctx.db.get("operations", version.operationId);
      if (
        version.state === "complete" &&
        op?.state === "succeeded" &&
        version.publishedAt === undefined
      )
        await patchFiscal(ctx, "documentVersions", version._id, {
          publishedAt: version.completedAt ?? version.createdAt,
        });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.documentProjection.backfillVersions, {
        documentId: args.documentId,
        generation: args.generation,
        cursor: page.continueCursor,
      });
    else {
      const generation = args.generation + 1;
      await patchFiscal(ctx, "fiscalDocuments", doc._id, {
        projectionGeneration: generation,
        projectionState: "pending",
        historyIndexing: false,
      });
      await ctx.scheduler.runAfter(0, internal.documentProjectionWorker.backfill, {
        documentId: doc._id,
        generation,
        cursor: null,
      });
    }
    return null;
  },
});
export const prepare = internalMutation({
  // `projectId` is ignored; it stays optional for jobs scheduled before the console lost it.
  args: { ...companyScopeFields, projectId: v.optional(v.id("projects")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await prepareCompany(ctx, args);
    return null;
  },
});
export const backfilled = internalMutation({
  args: { documentId: v.id("fiscalDocuments"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc || doc.projectionGeneration !== args.generation) return null;
    await patchFiscal(ctx, "fiscalDocuments", doc._id, { evidenceBackfill: false });
    await ctx.scheduler.runAfter(0, internal.documentProjectionWorker.rebuild, args);
    return null;
  },
});
export const initialize = mutation({
  args: companyScopeFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    await documentAccess(ctx, args);
    await prepareCompany(ctx, args);
    return null;
  },
});
