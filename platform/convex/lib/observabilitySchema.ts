import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeFields } from "./operationValues";

export const metricKind = v.union(
  v.literal("queue"),
  v.literal("lease"),
  v.literal("cursor"),
  v.literal("source"),
  v.literal("webhook"),
  v.literal("certificate"),
);
export const auditFields = {
  organizationId: v.id("organizations"),
  projectId: v.optional(v.id("projects")),
  companyId: v.optional(v.id("companies")),
  environment: v.optional(scopeFields.environment),
  actor: v.string(),
  action: v.string(),
  target: v.string(),
  requestId: v.optional(v.string()),
  operationId: v.optional(v.id("operations")),
  eventId: v.optional(v.string()),
  code: v.optional(v.string()),
  status: v.optional(v.number()),
  durationMs: v.optional(v.number()),
};
export const thresholds = v.object({
  queue: v.number(),
  lease: v.number(),
  cursor: v.number(),
  source: v.number(),
  webhook: v.number(),
  certificate: v.number(),
});
export const sourceFailures = v.object({
  source: v.string(),
  count: v.number(),
  capped: v.boolean(),
});
export const metric = v.object({
  kind: metricKind,
  value: v.union(v.number(), v.null()),
  capped: v.boolean(),
  target: v.string(),
  sources: v.optional(v.array(sourceFailures)),
});
export const observabilityTables = {
  operationalRetention: defineTable({
    organizationId: v.id("organizations"),
    nextAt: v.number(),
    generation: v.number(),
    scheduledId: v.id("_scheduled_functions"),
  }).index("by_organizationId", ["organizationId"]),
  operationalFailures: defineTable({
    ...scopeFields,
    operationId: v.id("operations"),
    source: v.string(),
    code: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_projectId_companyId_environment_source_createdAt", [
      "projectId",
      "companyId",
      "environment",
      "source",
      "createdAt",
    ])
    .index("by_organizationId_and_expiresAt", ["organizationId", "expiresAt"]),
  operationalAudit: defineTable({ ...auditFields, createdAt: v.number(), expiresAt: v.number() })
    .index("by_organizationId_and_createdAt", ["organizationId", "createdAt"])
    .index("by_organizationId_and_actor_and_createdAt", ["organizationId", "actor", "createdAt"])
    .index("by_organizationId_and_action_and_createdAt", ["organizationId", "action", "createdAt"])
    .index("by_organizationId_and_actor_and_action_and_createdAt", [
      "organizationId",
      "actor",
      "action",
      "createdAt",
    ])
    .index("by_organizationId_and_requestId", ["organizationId", "requestId"])
    .index("by_organizationId_and_operationId", ["organizationId", "operationId"])
    .index("by_organizationId_and_eventId", ["organizationId", "eventId"])
    .index("by_organizationId_and_target", ["organizationId", "target"])
    .index("by_organizationId_and_expiresAt", ["organizationId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),
  operationalMonitors: defineTable({
    ...scopeFields,
    ownerMembershipId: v.id("memberships"),
    enabled: v.boolean(),
    notify: v.boolean(),
    thresholds,
    generation: v.number(),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    checkedAt: v.optional(v.number()),
    metrics: v.array(metric),
    /**
     * Why the evaluation turned the monitor off by itself, for the panel (#422):
     * `CAPTURE_RELEASE_WITHDRAWN` when production stopped being served because the company's
     * fiscal capture was withdrawn, `ACCESS_REVOKED` for any other loss of access. Cleared when a
     * manager configures the monitor again.
     */
    stopped: v.optional(v.object({ code: v.string(), at: v.number() })),
    createdAt: v.number(),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_projectId_and_companyId_and_environment", ["projectId", "companyId", "environment"]),
  operationalAlerts: defineTable({
    monitorId: v.id("operationalMonitors"),
    organizationId: v.id("organizations"),
    kind: metricKind,
    state: v.union(v.literal("open"), v.literal("recovered")),
    value: v.number(),
    threshold: v.number(),
    target: v.string(),
    openedAt: v.number(),
    recoveredAt: v.optional(v.number()),
    lastNotifiedAt: v.number(),
    notifiedOpen: v.optional(v.boolean()),
    occurrences: v.number(),
  })
    .index("by_monitorId_and_kind", ["monitorId", "kind"])
    .index("by_organizationId_and_state", ["organizationId", "state"]),
  operationalNotifications: defineTable({
    organizationId: v.id("organizations"),
    monitorId: v.id("operationalMonitors"),
    alertId: v.id("operationalAlerts"),
    transition: v.union(v.literal("open"), v.literal("recovered")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_expiresAt", ["organizationId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),
};
