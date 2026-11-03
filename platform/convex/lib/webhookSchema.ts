import { defineTable } from "convex/server";
import { v } from "convex/values";
import { scopeFields } from "./operationValues";
import { eventType, subscriptionType, deliveryState } from "./webhookValues";
export const webhookTables = {
  webhookEndpoints: defineTable({
    ...scopeFields,
    name: v.string(),
    url: v.string(),
    events: v.array(subscriptionType),
    active: v.boolean(),
    version: v.number(),
    secretVersion: v.number(),
    secret: v.string(),
    previousSecret: v.optional(v.string()),
    previousVersion: v.optional(v.number()),
    previousUntil: v.optional(v.number()),
    projectEpoch: v.number(),
    grantEpoch: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_companyId_and_environment", ["companyId", "environment"])
    .index("by_projectId_and_companyId_and_environment", ["projectId", "companyId", "environment"]),
  outboxEvents: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    environment: scopeFields.environment,
    projectId: v.optional(v.id("projects")),
    logicalKey: v.string(),
    eventId: v.string(),
    type: eventType,
    resourceType: v.union(
      v.literal("document"),
      v.literal("import"),
      v.literal("endpoint"),
      v.literal("connection"),
      v.literal("issuance"),
    ),
    resourceId: v.string(),
    resourceVersion: v.number(),
    body: v.string(),
    createdAt: v.number(),
  })
    .index("by_logicalKey", ["logicalKey"])
    .index("by_organizationId", ["organizationId"]),
  webhookDeliveries: defineTable({
    endpointId: v.id("webhookEndpoints"),
    eventId: v.id("outboxEvents"),
    state: deliveryState,
    generation: v.number(),
    attempts: v.number(),
    resends: v.number(),
    cycleAttempts: v.number(),
    nextAttemptAt: v.number(),
    leaseUntil: v.number(),
    createdAt: v.number(),
    code: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    response: v.optional(v.string()),
    lastRetryKey: v.optional(v.string()),
    recoveries: v.optional(v.number()),
  })
    .index("by_endpointId", ["endpointId"])
    .index("by_endpointId_and_state_and_createdAt", ["endpointId", "state", "createdAt"])
    // No reader today: reserved for a redelivery sweep. Recreating it later
    // would require a backfill of the whole table, so it stays declared.
    .index("by_state_and_nextAttemptAt", ["state", "nextAttemptAt"]),
  webhookAttempts: defineTable({
    deliveryId: v.id("webhookDeliveries"),
    generation: v.number(),
    number: v.number(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    code: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    response: v.optional(v.string()),
  })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_deliveryId_and_generation", ["deliveryId", "generation"]),
};
