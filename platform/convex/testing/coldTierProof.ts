import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireLocalProof, requireReadProof } from "./operationProof";
import { readStoredContent } from "../lib/documentContentRead";
import { originalSourceOf, readOriginal } from "../lib/documentOriginalRead";
import { coldObjects, sha256Hex } from "../lib/coldObjects";
import { storedRef } from "../lib/documentContentPlan";

/**
 * Synthetic fixtures of the real-path proof of the cold tier (#689, ADR 0010, C and C2): a hosted
 * preview with the bucket (`scripts/cold-tier/prove-cold-tier-hosted.mjs`) and the local backend of a
 * worktree with the same bucket (`scripts/cold-tier/prove-cold-rehydration-local.mjs`). Every function
 * acts only on an organization whose slug starts with `cold689-`, made by
 * `operationProof:prepare`; the hosted ones run under the marker of `requireReadProof`, the
 * archive ones only locally. Sandbox data, no fiscal validity.
 */
const SLUG = "cold689-";
const DAY = 86_400_000;

async function proofOrganization(ctx: Pick<QueryCtx, "db">, organizationId: Id<"organizations">) {
  const org = await ctx.db.get("organizations", organizationId);
  if (!org?.slug.startsWith(SLUG)) throw new Error("COLD_PROOF_SCOPE");
  return org;
}
const hexOf = (base64: string) =>
  [...Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

/**
 * One Sandbox note that entered the platform `ageDays` ago: operation, note, original (the stored
 * XML, its own file) and a complete version with the parsed `result` and `items`, not yet
 * published, the note's key in place of the fixture's. The runner
 * publishes it by `importProcessing:published`, whose writer stores the phase B blob, and audits
 * it with the B7 audit (`contentMigration:start`).
 */
export const seed = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    storageId: v.id("_storage"),
    ageDays: v.number(),
    fiscalKey: v.string(),
    result: v.string(),
    items: v.array(v.string()),
  },
  returns: v.object({
    operationId: v.id("operations"),
    documentId: v.id("fiscalDocuments"),
    versionId: v.id("documentVersions"),
    artifactId: v.id("documentArtifacts"),
  }),
  handler: async (ctx, args) => {
    requireReadProof();
    const org = await proofOrganization(ctx, args.organizationId);
    const project = await ctx.db.get("projects", args.projectId);
    const company = await ctx.db.get("companies", args.companyId);
    if (
      project?.organizationId !== org._id ||
      company?.organizationId !== org._id ||
      !Number.isInteger(args.ageDays) ||
      args.ageDays < 1 ||
      args.ageDays > 2000 ||
      !/^\d{20}55\d{22}$/.test(args.fiscalKey) ||
      args.items.length > 16 ||
      args.result.length > 200_000
    )
      throw new Error("COLD_PROOF_SCOPE");
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    // Each note has its own file: a shared original stays hot (`coldTier.noteOriginals`).
    const held = await ctx.db
      .query("documentArtifacts")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (!metadata || held) throw new Error("COLD_PROOF_FILE");
    const createdAt = Date.now() - args.ageDays * DAY;
    const scope = {
      organizationId: org._id,
      projectId: args.projectId,
      companyId: args.companyId,
      environment: "sandbox" as const,
    };
    const operationId = await ctx.db.insert("operations", {
      ...scope,
      task: {
        name: "synthetic.cold",
        workload: "import",
        scope: "documents:import",
        executor: "testing/operationProof",
      },
      request: "{}",
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "succeeded",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 1,
      leaseUntil: 0,
      nextAttemptAt: 0,
      backoffMs: 1,
      jitterMs: 0,
      uncertain: false,
      createdAt,
      updatedAt: createdAt,
    });
    const documentId = await ctx.db.insert("fiscalDocuments", {
      organizationId: org._id,
      companyId: args.companyId,
      environment: "sandbox",
      model: "55",
      fiscalKey: args.fiscalKey,
      completeness: 1,
      createdAt,
    });
    const artifactId = await ctx.db.insert("documentArtifacts", {
      ...scope,
      documentId,
      storageId: args.storageId,
      sha256: hexOf(metadata.sha256),
      size: metadata.size,
      source: "imported-xml",
      importedAt: createdAt,
    });
    // The real parser's output for the stored XML (`platform/convex/testing/coldTierProof.test.ts`), with
    // the note's own key, so the readers project it as they would an imported note.
    const result = JSON.parse(args.result) as { document?: { kind?: string; key?: string } };
    if (result.document?.kind !== "invoice") throw new Error("COLD_PROOF_FIXTURE");
    result.document.key = args.fiscalKey;
    for (const item of args.items) JSON.parse(item);
    const versionId = await ctx.db.insert("documentVersions", {
      artifactId,
      operationId,
      documentId,
      state: "complete",
      code: "SYNTHETIC",
      kind: "invoice",
      completeness: 1,
      schema: null,
      parserVersion: "synthetic/1",
      normalizerVersion: null,
      processorVersion: "synthetic/1",
      result: JSON.stringify(result),
      itemCount: args.items.length,
      writtenItems: args.items.length,
      createdAt,
    });
    for (const [position, data] of args.items.entries())
      await ctx.db.insert("documentItems", { versionId, position, data });
    return { operationId, documentId, versionId, artifactId };
  },
});

const noteView = async (ctx: QueryCtx, documentId: Id<"fiscalDocuments">) => {
  const doc = await ctx.db.get("fiscalDocuments", documentId);
  if (!doc) return null;
  const versions = await ctx.db
    .query("documentVersions")
    .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
    .take(16);
  const artifacts = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
    .take(16);
  const stored = async (id: Id<"_storage"> | undefined) =>
    id === undefined ? null : (await ctx.db.system.get("_storage", id)) !== null;
  return {
    documentId: doc._id,
    organizationId: doc.organizationId,
    fiscalKey: doc.fiscalKey,
    createdAt: doc.createdAt,
    coldState: doc.coldState ?? null,
    coldAt: doc.coldAt ?? null,
    publishedVersionId: doc.publishedVersionId ?? null,
    versions: await Promise.all(
      versions.map(async (row) => ({
        versionId: row._id,
        publishedAt: row.publishedAt ?? null,
        verified: row.contentVerifiedAt !== undefined,
        contentStorageId: row.contentStorageId ?? null,
        contentStored: await stored(row.contentStorageId),
        contentObjectKey: row.contentObjectKey ?? null,
        contentObjectSha256: row.contentObjectSha256 ?? null,
        contentObjectSize: row.contentObjectSize ?? null,
        contentSha256: row.contentSha256 ?? null,
        contentSize: row.contentSize ?? null,
      })),
    ),
    artifacts: await Promise.all(
      artifacts.map(async (row) => ({
        artifactId: row._id,
        storageId: row.storageId ?? null,
        stored: await stored(row.storageId),
        objectKey: row.objectKey ?? null,
        objectSha256: row.objectSha256 ?? null,
        objectSize: row.objectSize ?? null,
        sha256: row.sha256,
        size: row.size,
      })),
    ),
    listings: (
      await ctx.db
        .query("documentListings")
        .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
        .take(8)
    ).length,
    dedup: (
      await ctx.db
        .query("fiscalDocuments")
        .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
          q
            .eq("organizationId", doc.organizationId)
            .eq("companyId", doc.companyId)
            .eq("environment", doc.environment)
            .eq("model", doc.model)
            .eq("fiscalKey", doc.fiscalKey),
        )
        .take(8)
    ).length,
  };
};

/** The notes of the proof organization, as rows say: tier, keys, hashes and files still stored. */
export const inspect = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireReadProof();
    const org = await proofOrganization(ctx, args.organizationId);
    const docs = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_coldState", (q) => q.eq("organizationId", org._id))
      .take(64);
    const mine = <T extends { organizationId: Id<"organizations"> }>(rows: T[]) =>
      rows.filter((row) => row.organizationId === org._id);
    const sweep = await ctx.db.query("coldTierSweeps").first();
    const audit = await ctx.db
      .query("contentMigrations")
      .withIndex("by_kind", (q) => q.eq("kind", "audit"))
      .unique();
    return JSON.stringify({
      notes: await Promise.all(docs.map((doc) => noteView(ctx, doc._id))),
      uploads: mine(await ctx.db.query("coldObjectUploads").take(256)).map((row) => ({
        objectKey: row.objectKey,
        collecting: row.collecting ?? false,
      })),
      deletions: mine(await ctx.db.query("coldObjectDeletions").take(256)).map(
        (row) => row.objectKey,
      ),
      sweep: sweep && { state: sweep.state, counts: sweep.counts },
      audit: audit && { state: audit.state, counts: audit.counts },
    });
  },
});

/** Whether each file is still in storage: the hot files of moved notes, during and after grace. */
export const stored = internalQuery({
  args: { organizationId: v.id("organizations"), storageIds: v.array(v.id("_storage")) },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireReadProof();
    await proofOrganization(ctx, args.organizationId);
    if (args.storageIds.length > 16) throw new Error("COLD_PROOF_SCOPE");
    return JSON.stringify(
      await Promise.all(
        args.storageIds.map(async (id) => (await ctx.db.system.get("_storage", id)) !== null),
      ),
    );
  },
});

export const note = internalQuery({
  args: { documentId: v.id("fiscalDocuments") },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireReadProof();
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc) throw new Error("COLD_PROOF_SCOPE");
    await proofOrganization(ctx, doc.organizationId);
    const version = doc.publishedVersionId
      ? await ctx.db.get("documentVersions", doc.publishedVersionId)
      : null;
    const artifact = version && (await ctx.db.get("documentArtifacts", version.artifactId));
    if (!version || !artifact) throw new Error("COLD_PROOF_SCOPE");
    const ref = storedRef(version);
    const original = originalSourceOf(artifact);
    if (!ref || !original) throw new Error("COLD_PROOF_SCOPE");
    return { ref, original, artifactId: artifact._id };
  },
});

/**
 * The note's published content and XML original through the readers every route uses
 * (`readStoredContent`, `readOriginal`), from whichever tier the rows point at. Only hashes and
 * sizes come back.
 */
export const read = internalAction({
  args: { documentId: v.id("fiscalDocuments") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireReadProof();
    const { ref, original } = await ctx.runQuery(internal.testing.coldTierProof.note, args);
    const content = await readStoredContent(
      ctx.storage,
      "objectKey" in ref ? { objectKey: ref.objectKey } : { storageId: ref.storageId },
      ref,
    );
    const raw = await readOriginal(ctx.storage, original);
    if (!raw) throw new Error("ORIGINAL_MISSING");
    return JSON.stringify({
      contentTier: "objectKey" in ref ? "cold" : "hot",
      originalTier: "objectKey" in original ? "cold" : "hot",
      contentSha256: await sha256Hex(
        JSON.stringify({ result: content.result, items: content.items }),
      ),
      items: content.items.length,
      originalSha256: await sha256Hex(raw),
      originalSize: raw.length,
    });
  },
});

/**
 * The fiscal guard's effect on a cold note, minus the guard's deadline: the note's rows go and the
 * objects they named are queued in `coldObjectDeletions`, in the same transaction, as
 * `fiscalGuard.ts` queues them. `coldTierWorker:collect` then deletes them from the bucket.
 */
export const purge = internalMutation({
  args: { documentId: v.id("fiscalDocuments") },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireReadProof();
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc || doc.coldState !== "cold") throw new Error("COLD_PROOF_SCOPE");
    await proofOrganization(ctx, doc.organizationId);
    const queued: string[] = [];
    const queue = async (objectKey: string | undefined) => {
      if (objectKey === undefined) return;
      await ctx.db.insert("coldObjectDeletions", {
        organizationId: doc.organizationId,
        objectKey,
        requestedAt: Date.now(),
      });
      queued.push(objectKey);
    };
    for (const version of await ctx.db
      .query("documentVersions")
      .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
      .take(16)) {
      for (const item of await ctx.db
        .query("documentItems")
        .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
        .take(64))
        await ctx.db.delete("documentItems", item._id);
      await queue(version.contentObjectKey);
      await ctx.db.delete("documentVersions", version._id);
    }
    for (const artifact of await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
      .take(16)) {
      await queue(artifact.objectKey);
      await ctx.db.delete("documentArtifacts", artifact._id);
    }
    for (const listing of await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
      .take(8))
      await ctx.db.delete("documentListings", listing._id);
    await ctx.db.delete("fiscalDocuments", doc._id);
    return queued;
  },
});

/**
 * An orphan as a lost action leaves it: an object in the bucket under the organization's Sandbox
 * prefix with an intent past `retryAt` and no row holding the key.
 */
export const orphan = internalAction({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireReadProof();
    const bytes = new TextEncoder().encode(`órfão sintético 689 ${crypto.randomUUID()}`);
    const name = (await sha256Hex(crypto.randomUUID())).slice(0, 24);
    const objectKey = `documents/sandbox/${args.organizationId}/${name}/content-${await sha256Hex(bytes)}.gz`;
    await ctx.runMutation(internal.testing.coldTierProof.orphanIntent, {
      organizationId: args.organizationId,
      objectKey,
    });
    await coldObjects().put(objectKey, bytes, "application/gzip");
    return objectKey;
  },
});
export const orphanIntent = internalMutation({
  args: { organizationId: v.id("organizations"), objectKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireReadProof();
    const org = await proofOrganization(ctx, args.organizationId);
    if (!args.objectKey.startsWith(`documents/sandbox/${org._id}/`))
      throw new Error("COLD_PROOF_SCOPE");
    await ctx.db.insert("coldObjectUploads", {
      organizationId: org._id,
      objectKey: args.objectKey,
      retryAt: Date.now() - 1,
    });
    return null;
  },
});

/**
 * Local only (ADR 0009 runs need the platform profile): makes the proof organization an inactive
 * Free one that had Production, as the archive's eligibility asks, and backdates its activity.
 */
export const age = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await proofOrganization(ctx, args.organizationId);
    const old = Date.now() - 100 * DAY;
    await ctx.db.patch("organizations", org._id, { updatedAt: old });
    const plan = await ctx.db
      .query("usagePlans")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", org._id))
      .unique();
    if (plan) await ctx.db.patch("usagePlans", plan._id, { updatedAt: old });
    else
      await ctx.db.insert("usagePlans", {
        organizationId: org._id,
        catalogTier: "free",
        name: "Gratuito",
        startsAt: old,
        endsAt: null,
        limits: { imports: null, captures: null, registry: null, bytes: null, deliveries: null },
        concurrency: 1,
        version: 1,
        updatedAt: old,
      });
    if (
      !(await ctx.db
        .query("usageTotals")
        .withIndex("by_organizationId_and_environment", (q) =>
          q.eq("organizationId", org._id).eq("environment", "production"),
        )
        .first())
    )
      await ctx.db.insert("usageTotals", {
        organizationId: org._id,
        environment: "production",
        period: "2026-01",
        metric: "imports",
        committed: 1,
        reserved: 0,
        updatedAt: old,
        startedAt: old,
      });
    for (const table of ["usageEvents", "capacityEvents"] as const)
      for (const row of await ctx.db
        .query(table)
        .withIndex("by_organizationId_and_updatedAt", (q) => q.eq("organizationId", org._id))
        .take(256))
        if (row.updatedAt > old) await ctx.db.patch(table, row._id, { updatedAt: old });
    return null;
  },
});
/** Local only: ends the notice of the proof organization's run, never another's. */
export const elapse = internalMutation({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run || run.state !== "notice") throw new Error("COLD_PROOF_SCOPE");
    await proofOrganization(ctx, run.organizationId);
    await ctx.db.patch("coldArchiveRuns", run._id, {
      noticeAt: Date.now() - 31 * DAY,
      eligibleAt: Date.now() - DAY,
    });
    return null;
  },
});
/** Local only: the note of the proof organization that has `fiscalKey`, under its current ID. */
export const byKey = internalQuery({
  args: { organizationId: v.id("organizations"), fiscalKey: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireReadProof();
    const org = await proofOrganization(ctx, args.organizationId);
    const docs = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_coldState", (q) => q.eq("organizationId", org._id))
      .take(64);
    const doc = docs.find((row) => row.fiscalKey === args.fiscalKey);
    return JSON.stringify(doc ? await noteView(ctx, doc._id) : null);
  },
});
