import { defineTable } from "convex/server";
import { v } from "convex/values";

export const capacityMetric = v.union(
  v.literal("temporaryBytes"),
  v.literal("filesBytes"),
  v.literal("databaseBytes"),
  v.literal("downloadsBytes"),
  v.literal("exportsCount"),
  v.literal("exportsBytes"),
  v.literal("restReads"),
);
export const capacityTables = {
  capacityAccounts: defineTable({
    organizationId: v.id("organizations"),
    ready: v.boolean(),
    revision: v.optional(v.number()),
    recountRevision: v.optional(v.number()),
    countedFiles: v.optional(v.number()),
    countedDatabase: v.optional(v.number()),
    reservedFiles: v.optional(v.number()),
    reservedDatabase: v.optional(v.number()),
    countedTemporary: v.optional(v.number()),
    reservedTemporary: v.optional(v.number()),
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  capacityTotals: defineTable({
    organizationId: v.id("organizations"),
    period: v.string(),
    metric: capacityMetric,
    committed: v.number(),
    reserved: v.number(),
    updatedAt: v.number(),
  }).index("by_organizationId_and_period_and_metric", ["organizationId", "period", "metric"]),
  capacityEvents: defineTable({
    organizationId: v.id("organizations"),
    key: v.string(),
    metric: capacityMetric,
    period: v.string(),
    quantity: v.number(),
    remaining: v.number(),
    state: v.union(v.literal("reserved"), v.literal("committed"), v.literal("released")),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_metric_and_key", ["organizationId", "metric", "key"])
    .index("by_organizationId_and_updatedAt", ["organizationId", "updatedAt"]),
  capacityFiles: defineTable({
    kind: v.optional(v.union(v.literal("original"), v.literal("temporary"))),
    organizationId: v.id("organizations"),
    storageId: v.id("_storage"),
    size: v.number(),
  })
    .index("by_organizationId_and_storageId", ["organizationId", "storageId"])
    .index("by_storageId", ["storageId"]),
  capacityRecords: defineTable({
    organizationId: v.id("organizations"),
    key: v.string(),
    size: v.number(),
  })
    .index("by_organizationId_and_key", ["organizationId", "key"])
    .index("by_key", ["key"]),
};
