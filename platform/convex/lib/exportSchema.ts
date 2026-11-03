import { defineTable } from "convex/server";
import { v } from "convex/values";
import { environment } from "./projectValues";

export const exportSelection = v.union(
  v.object({ kind: v.literal("organization") }),
  v.object({
    kind: v.literal("document"),
    documentId: v.id("fiscalDocuments"),
    companyId: v.id("companies"),
    projectId: v.id("projects"),
  }),
);
export const exportState = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("revoked"),
  v.literal("expired"),
);
export const exportSummary = v.object({
  id: v.id("documentExports"),
  selection: exportSelection,
  environment,
  state: exportState,
  createdAt: v.number(),
  expiresAt: v.number(),
  parts: v.number(),
  bytes: v.number(),
  code: v.union(v.string(), v.null()),
});
export const partSummary = v.object({
  id: v.id("exportParts"),
  sequence: v.number(),
  sha256: v.string(),
  size: v.number(),
});
/**
 * What the isolated destination of an assisted export cannot read by itself (ADR 0009, §7): the
 * package holds only the `fiscal` class, so the companies (`closure`) come from the origin, as
 * the normal export would read them, with whether the origin serves the export's environment to
 * each one (`environmentServed`).
 */
export const assistedCompany = v.object({
  id: v.id("companies"),
  cnpj: v.string(),
  name: v.string(),
  createdAt: v.number(),
  served: v.boolean(),
});
export const assistedSource = v.object({
  // The origin's export: the manifest names it, so the file is the one the owner downloads.
  exportId: v.id("documentExports"),
  companies: v.array(assistedCompany),
});
export const exportTables = {
  /**
   * Assisted export requests of archived organizations (ADR 0009, §7, decisions of 30/10/2026),
   * recorded by the operator's command after checking the owner's account. An owner's request
   * counts for the limit of one each 30 days per organization; a data subject's request under
   * RIGHTS.md (`basis: "rights"`) does not.
   */
  assistedExports: defineTable({
    organizationId: v.id("organizations"),
    runId: v.id("coldArchiveRuns"),
    // The support ticket: repeating it returns the same request.
    key: v.string(),
    basis: v.union(v.literal("owner"), v.literal("rights")),
    rightsReference: v.optional(v.string()),
    authUserId: v.string(),
    membershipId: v.id("memberships"),
    environments: v.array(environment),
    createdAt: v.number(),
  })
    .index("by_organizationId_and_key", ["organizationId", "key"])
    .index("by_organizationId_and_basis_and_createdAt", ["organizationId", "basis", "createdAt"]),
  documentExports: defineTable({
    organizationId: v.id("organizations"),
    environment,
    selection: exportSelection,
    actor: v.string(),
    membershipId: v.optional(v.id("memberships")),
    membershipVersion: v.optional(v.number()),
    keyId: v.optional(v.id("apiKeys")),
    accessVersion: v.optional(v.string()),
    projectEpoch: v.optional(v.number()),
    grantEpoch: v.optional(v.number()),
    key: v.string(),
    state: exportState,
    checkpoint: v.string(),
    sequence: v.number(),
    bytes: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
    // The pending expiry job, so a restore can tell which deadlines lost their job.
    expireJobId: v.optional(v.id("_scheduled_functions")),
    code: v.optional(v.string()),
    // Origin side of an assisted export (ADR 0009, §7): the request it delivers. The operator
    // attaches the parts generated in the isolated destination; no worker runs here.
    assistedRequestId: v.optional(v.id("assistedExports")),
    // Destination side: the job that generates those parts in the isolated destination.
    assisted: v.optional(assistedSource),
  })
    .index("by_organizationId_and_actor_and_key", ["organizationId", "actor", "key"])
    .index("by_organizationId_and_state", ["organizationId", "state"])
    .index("by_organizationId_and_actor", ["organizationId", "actor"])
    .index("by_assistedRequestId_and_environment", ["assistedRequestId", "environment"]),
  exportParts: defineTable({
    exportId: v.id("documentExports"),
    sequence: v.number(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    size: v.number(),
  })
    .index("by_exportId_and_sequence", ["exportId", "sequence"])
    .index("by_storageId", ["storageId"]),
  exportTickets: defineTable({
    exportId: v.id("documentExports"),
    partId: v.id("exportParts"),
    tokenHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_exportId", ["exportId"]),
};
