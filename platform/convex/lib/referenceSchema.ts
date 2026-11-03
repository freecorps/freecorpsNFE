import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dataset = v.union(v.literal("municipalities"), v.literal("ncm"));
export const entryFields = {
  code: v.string(),
  description: v.string(),
  state: v.union(v.string(), v.null()),
  validFrom: v.union(v.string(), v.null()),
  validTo: v.union(v.string(), v.null()),
};
const status = [
  v.literal("valid"),
  v.literal("out_of_validity"),
  v.literal("validity_unknown"),
] as const;
/** Mirrors `referenceManifest` of the public contract, so reads return the object itself. */
const manifest = v.object({
  dataset,
  version: v.string(),
  source: v.string(),
  sourceUrl: v.string(),
  sourceVersion: v.string(),
  retrievedAt: v.string(),
  asOf: v.string(),
  coverage: v.union(v.literal("snapshot"), v.literal("intervals")),
  sourceSha256: v.string(),
  contentSha256: v.string(),
  count: v.number(),
  termsUrl: v.string(),
  redistribution: v.union(
    v.literal("synthetic"),
    v.literal("review-required"),
    v.literal("permitted-with-attribution"),
  ),
  terms: v.string(),
});
/** A search returns a page; a lookup by `code` returns the entry (`referencePage`/`referenceLookup`). */
export const referenceResult = v.union(
  v.object({
    manifest,
    date: v.string(),
    page: v.array(v.object({ ...entryFields, status: v.union(...status) })),
    nextCursor: v.union(v.string(), v.null()),
  }),
  v.object({
    manifest,
    date: v.string(),
    status: v.union(...status, v.literal("not_found")),
    entry: v.union(v.object(entryFields), v.null()),
  }),
);
export const referenceTables = {
  referenceVersions: defineTable({
    storageId: v.optional(v.id("_storage")),
    dataset,
    version: v.string(),
    manifest: v.string(),
    count: v.number(),
    imported: v.number(),
    lastCode: v.string(),
    state: v.union(v.literal("candidate"), v.literal("ready")),
    publishedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
  })
    .index("by_dataset_and_version", ["dataset", "version"])
    .index("by_storageId", ["storageId"]),
  referenceEntries: defineTable({
    versionId: v.id("referenceVersions"),
    ...entryFields,
    nameKey: v.string(),
  })
    .index("by_versionId_and_code", ["versionId", "code"])
    .index("by_versionId_and_nameKey", ["versionId", "nameKey"]),
  referenceActive: defineTable({
    dataset,
    versionId: v.id("referenceVersions"),
    generation: v.number(),
  }).index("by_dataset", ["dataset"]),
  referenceAudit: defineTable({
    dataset,
    versionId: v.id("referenceVersions"),
    previousVersionId: v.union(v.id("referenceVersions"), v.null()),
    generation: v.number(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_dataset", ["dataset"]),
};
