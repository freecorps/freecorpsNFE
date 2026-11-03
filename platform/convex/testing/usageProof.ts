import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireLocalProof } from "./operationProof";
import { scopeFields } from "../lib/operationValues";
import { updateListings } from "../lib/documentCore";
import {
  acquireUsageLease,
  eventFor,
  recordUsage,
  releaseUsageLease,
  laneTotal,
} from "../lib/usageCore";
import { usagePeriod } from "../lib/usageValues";
import { environment } from "../lib/projectValues";

export const lease = internalMutation({
  args: { organizationId: v.id("organizations"), key: v.string(), release: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireLocalProof();
    if (args.release) {
      await releaseUsageLease(ctx, args.organizationId, args.key);
      return true;
    }
    return acquireUsageLease(ctx, args.organizationId, args.key, Date.now() + 60000);
  },
});

/**
 * Writes usage as it was before #429, without environment: a committed `bytes` event whose key
 * names an import file of the organization, and the same units on the period's unattributed
 * total, so events and totals agree as the backfill expects. The browser journey shows the notice
 * of usage still unattributed and then runs `usageMigration.backfillEnvironment`. Local proof only.
 */
export const legacy = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    fileId: v.id("importFiles"),
    quantity: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const file = await ctx.db.get("importFiles", args.fileId);
    const batch = file ? await ctx.db.get("imports", file.importId) : null;
    if (!batch || batch.organizationId !== args.organizationId)
      throw new Error("File outside the organization");
    if (!Number.isSafeInteger(args.quantity) || args.quantity < 1)
      throw new Error("Invalid synthetic quantity");
    const key = `usage-proof-legacy:${args.fileId}`;
    if (await eventFor(ctx, args.organizationId, "bytes", key)) return null;
    const now = Date.now();
    const period = usagePeriod(now);
    await ctx.db.insert("usageEvents", {
      organizationId: args.organizationId,
      metric: "bytes",
      key,
      period,
      quantity: args.quantity,
      state: "committed",
      createdAt: now,
      updatedAt: now,
    });
    const total = await laneTotal(ctx, args.organizationId, undefined, period, "bytes", undefined);
    if (total)
      await ctx.db.patch("usageTotals", total._id, {
        committed: total.committed + args.quantity,
        updatedAt: now,
      });
    else
      await ctx.db.insert("usageTotals", {
        organizationId: args.organizationId,
        period,
        metric: "bytes",
        committed: args.quantity,
        reserved: 0,
        startedAt: now,
        updatedAt: now,
      });
    return null;
  },
});

/**
 * Records synthetic committed units in one environment (#429), for the browser journey to show
 * a balance of production beside the sandbox's. Local proof only; never a domain effect.
 */
export const record = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    environment,
    metric: v.union(v.literal("captures"), v.literal("bytes")),
    key: v.string(),
    quantity: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    await recordUsage(
      ctx,
      args.organizationId,
      args.environment,
      args.metric,
      `usage-proof:${args.key}`,
      args.quantity,
    );
    return null;
  },
});

/** Synthetic metadata only. Never a fiscal import or a measurement of XML processing throughput. */
export const seed = internalMutation({
  args: {
    ...scopeFields,
    sourceId: v.id("fiscalDocuments"),
    offset: v.number(),
    count: v.number(),
  },
  returns: v.object({ count: v.number(), logicalBytes: v.number() }),
  handler: async (ctx, args) => {
    requireLocalProof();
    if (
      !Number.isSafeInteger(args.count) ||
      args.count < 1 ||
      args.count > 200 ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0
    )
      throw new Error("Invalid synthetic batch");
    const source = await ctx.db.get("fiscalDocuments", args.sourceId);
    if (!source?.publishedVersionId)
      throw new Error("Source must be a published synthetic document");
    const version = (await ctx.db.get("documentVersions", source.publishedVersionId))!;
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    const {
      _id: artifactId,
      _creationTime: artifactTime,
      fileId,
      captureStreamId,
      processingOperationId,
      documentId,
      ...artifactFields
    } = artifact;
    void artifactId;
    void artifactTime;
    void fileId;
    void captureStreamId;
    void processingOperationId;
    void documentId;
    const copyArtifact = await ctx.db.insert("documentArtifacts", {
      ...artifactFields,
      organizationId: args.organizationId,
      companyId: args.companyId,
      projectId: args.projectId,
    });
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .first();
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", args.projectId).eq("companyId", args.companyId),
      )
      .unique();
    if (!key || !grant) throw new Error("Synthetic scope absent");
    if (!key.scopes.includes("documents:read"))
      await ctx.db.patch("apiKeys", key._id, {
        scopes: [...key.scopes, "documents:read"],
        expiresAt: Date.now() + 86400000,
      });
    if (!grant.scopes.includes("documents:read"))
      await ctx.db.patch("projectCompanies", grant._id, {
        scopes: [...grant.scopes, "documents:read"],
      });
    const { _id: versionId, _creationTime: versionTime, ...versionFields } = version;
    void versionId;
    void versionTime;
    let logicalBytes = 0;
    for (let i = 0; i < args.count; i++) {
      const data = {
        organizationId: args.organizationId,
        companyId: args.companyId,
        environment: args.environment,
        model: "55" as const,
        fiscalKey: source.fiscalKey.slice(0, 22) + String(args.offset + i).padStart(22, "0"),
        completeness: source.completeness,
        createdAt: Date.now() + args.offset + i,
        projectionState: "ready" as const,
        projectionGeneration: source.projectionGeneration ?? 1,
        publicVersion: source.publicVersion ?? 1,
        ...(source.fiscalSituation ? { fiscalSituation: source.fiscalSituation } : {}),
      };
      const id = await ctx.db.insert("fiscalDocuments", data);
      const version = { ...versionFields, artifactId: copyArtifact, documentId: id };
      const publishedVersionId = await ctx.db.insert("documentVersions", version);
      await ctx.db.patch("fiscalDocuments", id, { publishedVersionId });
      await updateListings(ctx, (await ctx.db.get("fiscalDocuments", id))!);
      logicalBytes += new TextEncoder().encode(
        JSON.stringify(data) + JSON.stringify(version),
      ).byteLength;
    }
    return { count: args.count, logicalBytes };
  },
});
export const boundedRead = internalQuery({
  args: { keyHash: v.string(), company: v.string(), cursor: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireLocalProof();
    return ctx.runQuery(
      internal.documentRest.dispatch,
      {
        keyHash: args.keyHash,
        company: args.company,
        environment: "sandbox",
        path: "/v1/documents",
        search: new URLSearchParams({
          companyId: args.company,
          limit: "50",
          ...(args.cursor ? { cursor: args.cursor } : {}),
        }).toString(),
      },
      { transactionLimits: { documentsRead: 1000, bytesRead: 4 * 1024 * 1024 } },
    );
  },
});
