import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Every table whose rows may hold a stored file, with the query for one file. Cold archive and
 * the fiscal guard read this same set before deleting a file; a new storage reference goes here.
 */
export function storageHolders(ctx: QueryCtx, storageId: Id<"_storage">) {
  return [
    {
      table: "importFiles",
      query: ctx.db
        .query("importFiles")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "documentArtifacts",
      query: ctx.db
        .query("documentArtifacts")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "issuanceArtifacts",
      query: ctx.db
        .query("issuanceArtifacts")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "documentVersions",
      query: ctx.db
        .query("documentVersions")
        .withIndex("by_contentStorageId", (q) => q.eq("contentStorageId", storageId)),
    },
    {
      table: "captureBatches",
      query: ctx.db.query("captureBatches").withIndex("by_rawId", (q) => q.eq("rawId", storageId)),
    },
    {
      table: "referenceVersions",
      query: ctx.db
        .query("referenceVersions")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "privacyIntakes",
      query: ctx.db.query("privacyIntakes").withIndex("by_raw", (q) => q.eq("raw", storageId)),
    },
    {
      table: "privacyMessages",
      query: ctx.db.query("privacyMessages").withIndex("by_raw", (q) => q.eq("raw", storageId)),
    },
    {
      table: "exportParts",
      query: ctx.db
        .query("exportParts")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "documentDanfes",
      query: ctx.db
        .query("documentDanfes")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
    {
      table: "capacityFiles",
      query: ctx.db
        .query("capacityFiles")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId)),
    },
  ] as const;
}
