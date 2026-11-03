import { defineTable } from "convex/server";
import { v } from "convex/values";
import { registryDataValue, registryStatus } from "./registryValues";
import { companyFields } from "./companyValues";
import { environment } from "./projectValues";

export const registryTables = {
  // A durable suppression decision must outlive the disposable source cache.
  registryRestrictions: defineTable({
    cnpj: v.string(),
    blocked: v.boolean(),
    reference: v.string(),
    actor: v.string(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_cnpj", ["cnpj"]),
  registryCache: defineTable({
    provider: v.literal("opencnpj"),
    cnpj: v.string(),
    status: registryStatus,
    data: v.union(registryDataValue, v.null()),
    sourceUpdatedAt: v.union(v.number(), v.null()),
    consultedAt: v.union(v.number(), v.null()),
    lastAttemptAt: v.number(),
    expiresAt: v.number(),
    refreshAfter: v.number(),
    retainUntil: v.number(),
    version: v.number(),
    stale: v.boolean(),
    pendingOperationId: v.optional(v.id("operations")),
    pendingLookupId: v.optional(v.id("registryLookups")),
    pendingUntil: v.optional(v.number()),
    expiryJobId: v.optional(v.id("_scheduled_functions")),
    retentionJobId: v.optional(v.id("_scheduled_functions")),
  }).index("by_provider_and_cnpj", ["provider", "cnpj"]),
  // A manager's lookup before the company exists. No cadastral data: the result lives in the cache.
  registryLookups: defineTable({
    organizationId: v.id("organizations"),
    cnpj: v.string(),
    actorUserId: v.string(),
    key: v.string(),
    environment,
    quotaExceeded: v.boolean(),
    call: v.optional(v.union(v.literal("dispatched_or_uncertain"), v.literal("responded"))),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_organizationId_and_key", ["organizationId", "key"]),
  registryCalls: defineTable({
    operationId: v.id("operations"),
    organizationId: v.id("organizations"),
    provider: v.literal("opencnpj"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    state: v.union(v.literal("dispatched_or_uncertain"), v.literal("responded")),
    status: v.optional(registryStatus),
    costMinor: v.literal(0),
  }).index("by_operationId", ["operationId"]),
  registryApplications: defineTable({
    companyId: v.id("companies"),
    organizationId: v.id("organizations"),
    actorUserId: v.string(),
    provider: v.literal("opencnpj"),
    consultedAt: v.number(),
    appliedAt: v.number(),
    sourceUpdatedAt: v.union(v.number(), v.null()),
    fields: v.array(v.union(v.literal("name"), v.literal("address"))),
    before: v.object(companyFields),
    after: v.object(companyFields),
  }).index("by_companyId", ["companyId"]),
};
