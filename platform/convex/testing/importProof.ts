import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { IMPORT_MIME } from "../lib/importValues";
import { confirmFile } from "../imports";
import { requireLocalProof } from "./operationProof";

/** Fails before the browser journey if the native backend did not accept this schema/functions push. */
export const ready = internalQuery({
  args: {},
  returns: v.literal("imports-published-history/2"),
  handler: async (ctx) => {
    requireLocalProof();
    await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey")
      .take(1);
    await ctx.db
      .query("imports")
      .withIndex("by_organizationId_and_companyId_and_projectId_and_environment")
      .take(1);
    await ctx.db.query("documentVersions").withIndex("by_artifactId_and_publishedAt").take(1);
    return "imports-published-history/2" as const;
  },
});

/** Replay the first processor, before fiscal-situation projection was added. Same auth/storage contract. */
export const confirmV1 = internalMutation({
  args: { fileId: v.id("importFiles"), keyHash: v.optional(v.string()) },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    requireLocalProof();
    return confirmFile(ctx, args.fileId, args.keyHash, "xml-import/1");
  },
});
export const inspect = internalQuery({
  args: { fileId: v.id("importFiles") },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const artifact = await ctx.db
      .query("documentArtifacts")
      .withIndex("by_fileId", (q) => q.eq("fileId", args.fileId))
      .unique();
    if (!artifact) return "null";
    const document = artifact.documentId
      ? await ctx.db.get("fiscalDocuments", artifact.documentId)
      : null;
    const versions = await ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifact._id))
      .take(10);
    const results = await Promise.all(
      versions.map(async (version) => ({
        ...version,
        items: await ctx.db
          .query("documentItems")
          .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
          .take(990),
      })),
    );
    return JSON.stringify({ artifact, document, versions: results });
  },
});
export const storage = internalQuery({
  args: { storageId: v.id("_storage") },
  returns: v.union(
    v.null(),
    v.object({ contentType: v.union(v.string(), v.null()), size: v.number() }),
  ),
  handler: async (ctx, args) => {
    requireLocalProof();
    const value = await ctx.db.system.get("_storage", args.storageId);
    return value ? { contentType: value.contentType ?? null, size: value.size } : null;
  },
});
export const orphan = internalAction({
  args: {},
  returns: v.id("_storage"),
  handler: async (ctx) => {
    requireLocalProof();
    return ctx.storage.store(new Blob(["<orphan/>"], { type: IMPORT_MIME }));
  },
});
export const original = internalAction({
  args: { fileId: v.id("importFiles") },
  returns: v.object({ sha256: v.string(), size: v.number() }),
  handler: async (ctx, args): Promise<{ sha256: string; size: number }> => {
    requireLocalProof();
    const proof = JSON.parse(await ctx.runQuery(internal.testing.importProof.inspect, args)) as {
      artifact: { storageId: import("../_generated/dataModel").Id<"_storage"> };
    };
    const blob = await ctx.storage.get(proof.artifact.storageId);
    if (!blob) throw new Error("Original unavailable");
    const bytes = await blob.arrayBuffer(),
      digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
      size: bytes.byteLength,
    };
  },
});
