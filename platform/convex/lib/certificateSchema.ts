import { defineTable } from "convex/server";
import { v } from "convex/values";
import { archiveOriginFields } from "./coldArchiveSchema";
import { certificateScope, certificateState, certificateMeta, envelope } from "./certificateValues";

export const certificateTables = {
  certificateHeads: defineTable({
    ...certificateScope,
    nextVersion: v.number(),
    latestId: v.optional(v.id("certificates")),
    activeId: v.optional(v.id("certificates")),
  }).index("by_companyId", ["companyId"]),
  certificates: defineTable({
    ...certificateScope,
    version: v.number(),
    state: certificateState,
    uploaderId: v.string(),
    membershipId: v.id("memberships"),
    membershipVersion: v.number(),
    metadata: v.optional(certificateMeta),
    envelope: v.optional(envelope),
    envelopeRevision: v.number(),
    code: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_companyId", ["companyId"]),
  certificateAudit: defineTable({
    ...archiveOriginFields,
    ...certificateScope,
    certificateId: v.id("certificates"),
    version: v.number(),
    actor: v.string(),
    operationId: v.optional(v.id("operations")),
    action: v.string(),
    result: v.string(),
    keyVersion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_companyId", ["companyId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_certificateId_and_action_and_result", ["certificateId", "action", "result"])
    // The hourly ceiling of the site capture counts per company, across certificate swaps.
    .index("by_companyId_and_action_and_result", ["companyId", "action", "result"]),
};
