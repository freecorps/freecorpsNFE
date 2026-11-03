import { defineTable } from "convex/server";
import { v } from "convex/values";
import { usageMetric, planFields } from "./usageValues";
import { environment } from "./projectValues";

export const usageTables = {
  usagePlans: defineTable({
    organizationId: v.id("organizations"),
    ...planFields,
    version: v.number(),
    updatedAt: v.number(),
    /** The annual term this plan row grants, when it came from one (ADR 0010, decision 9). */
    termId: v.optional(v.id("platformPlanTerms")),
  }).index("by_organizationId", ["organizationId"]),
  usagePlanAudit: defineTable({
    organizationId: v.id("organizations"),
    actor: v.string(),
    reason: v.string(),
    before: v.union(v.string(), v.null()),
    after: v.string(),
    createdAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  usageEvents: defineTable({
    organizationId: v.id("organizations"),
    /**
     * Environment whose balance the event counts (#429). Missing only on events written before
     * it, until `usageMigration.backfillEnvironment` attributes them; then it becomes required.
     */
    environment: v.optional(environment),
    metric: usageMetric,
    key: v.string(),
    period: v.string(),
    quantity: v.number(),
    /** Lane of `usageTotals` that holds the units (#559); missing means lane 0. */
    lane: v.optional(v.number()),
    state: v.union(v.literal("reserved"), v.literal("committed"), v.literal("released")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_metric_and_key", ["organizationId", "metric", "key"])
    .index("by_organizationId_and_updatedAt", ["organizationId", "updatedAt"])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  usageTotals: defineTable({
    organizationId: v.id("organizations"),
    /** As in `usageEvents`: missing only on totals written before #429, until the backfill. */
    environment: v.optional(environment),
    period: v.string(),
    metric: usageMetric,
    /**
     * One of `USAGE_LANES` rows of the environment's balance (#559); missing means lane 0, every
     * total written before the lanes. The balance is the sum of the lanes' units.
     */
    lane: v.optional(v.number()),
    committed: v.number(),
    reserved: v.number(),
    /**
     * Units of the plan limit already set aside for this lane and not yet used, valid only under
     * the plan, version and limit named by `grant`. A reservation spends it without reading the
     * other lanes; see `reserveUsage`.
     */
    allowance: v.optional(v.number()),
    grant: v.optional(v.string()),
    updatedAt: v.number(),
    startedAt: v.number(),
  })
    .index("by_organizationId_and_period_and_metric_and_environment", [
      "organizationId",
      "period",
      "metric",
      "environment",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"])
    .index("by_organizationId_and_period_and_metric_and_environment_and_lane", [
      "organizationId",
      "period",
      "metric",
      "environment",
      "lane",
    ]),
  usageLeases: defineTable({
    organizationId: v.id("organizations"),
    key: v.string(),
    expiresAt: v.number(),
  })
    .index("by_organizationId_and_expiresAt", ["organizationId", "expiresAt"])
    .index("by_organizationId_and_key", ["organizationId", "key"]),
};
