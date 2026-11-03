import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { referenceManifest, referenceSearch } from "../../packages/contracts/src/references";
import { dataset, entryFields } from "./lib/referenceSchema";
import { deny } from "./lib/organizationAccess";

export const uploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});
export const begin = internalMutation({
  args: { manifest: v.string(), storageId: v.optional(v.id("_storage")) },
  returns: v.id("referenceVersions"),
  handler: async (ctx, args) => {
    const manifest = referenceManifest.parse(JSON.parse(args.manifest));
    const existing = await ctx.db
      .query("referenceVersions")
      .withIndex("by_dataset_and_version", (q) =>
        q.eq("dataset", manifest.dataset).eq("version", manifest.version),
      )
      .unique();
    if (existing) return deny("REFERENCE_VERSION_EXISTS");
    return ctx.db.insert("referenceVersions", {
      dataset: manifest.dataset,
      version: manifest.version,
      manifest: JSON.stringify(manifest),
      storageId: args.storageId,
      count: manifest.count,
      imported: 0,
      lastCode: "",
      state: "candidate",
      publishedAt: null,
      createdAt: Date.now(),
    });
  },
});
export const append = internalMutation({
  args: {
    versionId: v.id("referenceVersions"),
    offset: v.number(),
    entries: v.array(v.object(entryFields)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const version = await ctx.db.get("referenceVersions", args.versionId);
    if (
      !version ||
      version.state !== "candidate" ||
      version.imported !== args.offset ||
      args.entries.length < 1 ||
      args.entries.length > 100 ||
      version.imported + args.entries.length > version.count
    )
      return deny("REFERENCE_IMPORT_CONFLICT");
    let lastCode = version.lastCode;
    for (const row of args.entries) {
      if (row.code <= lastCode) return deny("REFERENCE_IMPORT_ORDER");
      await ctx.db.insert("referenceEntries", {
        ...row,
        versionId: version._id,
        nameKey: referenceSearch(row.description) + "|" + row.code,
      });
      lastCode = row.code;
    }
    await ctx.db.patch("referenceVersions", version._id, {
      imported: version.imported + args.entries.length,
      lastCode,
    });
    return null;
  },
});
export const finish = internalMutation({
  args: { versionId: v.id("referenceVersions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const version = await ctx.db.get("referenceVersions", args.versionId);
    if (!version || version.state !== "candidate" || version.imported !== version.count)
      return deny("REFERENCE_INCOMPLETE");
    await ctx.db.patch("referenceVersions", version._id, { state: "ready" });
    return null;
  },
});
export const current = internalQuery({
  args: { dataset },
  returns: v.object({ version: v.union(v.string(), v.null()), generation: v.number() }),
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("referenceActive")
      .withIndex("by_dataset", (q) => q.eq("dataset", args.dataset))
      .unique();
    const version = active ? await ctx.db.get("referenceVersions", active.versionId) : null;
    return { version: version?.version ?? null, generation: active?.generation ?? 0 };
  },
});
/** Publication and rollback use the same compare-and-swap. Readers only see complete versions. */
export const publish = internalMutation({
  args: {
    versionId: v.id("referenceVersions"),
    expectedGeneration: v.number(),
    reason: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const version = await ctx.db.get("referenceVersions", args.versionId);
    if (!version || version.state !== "ready" || !args.reason.trim() || args.reason.length > 500)
      return deny("REFERENCE_NOT_READY");
    const active = await ctx.db
      .query("referenceActive")
      .withIndex("by_dataset", (q) => q.eq("dataset", version.dataset))
      .unique();
    if ((active?.generation ?? 0) !== args.expectedGeneration)
      return deny("REFERENCE_PUBLICATION_CONFLICT");
    const generation = args.expectedGeneration + 1;
    if (active)
      await ctx.db.patch("referenceActive", active._id, { versionId: version._id, generation });
    else
      await ctx.db.insert("referenceActive", {
        dataset: version.dataset,
        versionId: version._id,
        generation,
      });
    if (version.publishedAt === null)
      await ctx.db.patch("referenceVersions", version._id, { publishedAt: Date.now() });
    await ctx.db.insert("referenceAudit", {
      dataset: version.dataset,
      versionId: version._id,
      previousVersionId: active?.versionId ?? null,
      generation,
      reason: args.reason.trim(),
      createdAt: Date.now(),
    });
    return generation;
  },
});
