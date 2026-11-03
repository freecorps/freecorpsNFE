import { defineSchema, defineTable } from "convex/server";
import { capacityTables } from "./lib/capacitySchema";
import { planTables } from "./lib/planSchema";
import { billingTables } from "./lib/billingSchema";
import { archiveOriginFields, coldArchiveTables } from "./lib/coldArchiveSchema";
import { privacyTables } from "./lib/privacyMailSchema";
import { usageTables } from "./lib/usageSchema";
import { exportTables } from "./lib/exportSchema";
import { observabilityTables } from "./lib/observabilitySchema";
import { v } from "convex/values";
import { vWorkId } from "@convex-dev/workpool";
import { importTables } from "./lib/importSchema";
import { documentTables } from "./lib/documentSchema";
import { webhookTables } from "./lib/webhookSchema";
import { referenceTables } from "./lib/referenceSchema";
import { registryTables } from "./lib/registrySchema";
import { certificateTables } from "./lib/certificateSchema";
import { captureTables } from "./lib/captureSchema";
import { accessTables } from "./lib/accessSchema";
import { closureTables } from "./lib/closureSchema";
import { sandboxClosureTables } from "./lib/sandboxClosureSchema";
import { nfseProfileTables } from "./lib/nfseProfileSchema";
import { issuanceTables } from "./lib/issuanceSchema";
import { stripeTables } from "./lib/stripeSchema";
import { certificatePin } from "./lib/certificateValues";
import {
  operationState,
  operationStage,
  responseDiagnostic,
  scopeFields,
  taskSpec,
} from "./lib/operationValues";
import { environment, integrationScope, projectState } from "./lib/projectValues";
import { auditAction, invitationStatus, membershipRole } from "./lib/organizationValues";
import {
  companyFields,
  companyKind,
  companyAuditAction,
  onboardingMode,
  fieldSource,
} from "./lib/companyValues";

export default defineSchema({
  ...capacityTables,
  ...planTables,
  ...billingTables,
  ...coldArchiveTables,
  ...privacyTables,
  ...accessTables,
  ...closureTables,
  ...sandboxClosureTables,
  ...exportTables,
  ...observabilityTables,
  ...usageTables,
  ...captureTables,
  ...certificateTables,
  ...nfseProfileTables,
  ...issuanceTables,
  ...stripeTables,
  ...registryTables,
  ...referenceTables,
  ...importTables,
  ...documentTables,
  ...webhookTables,
  operationProofDocuments: defineTable({
    ...archiveOriginFields,
    operationId: v.id("operations"),
    response: v.string(),
  }).index("by_operationId", ["operationId"]),
  operations: defineTable({
    ...archiveOriginFields,
    usageCaptureKey: v.optional(v.string()),
    /**
     * The stream's source window and last attempt as they were before `captureProcessing.prepare`
     * reserved them for the attempt `fence`. A refusal before the request puts them back (#421).
     */
    captureReservation: v.optional(
      v.object({
        fence: v.number(),
        nextAllowedAt: v.number(),
        lastAttemptAt: v.optional(v.number()),
      }),
    ),
    /**
     * Progress of a `documents.reprocess_refusals` sweep (#499): the cursor after the last page
     * committed, the originals sent to reprocessing and those skipped as busy so far, so a lost
     * lease resumes there.
     */
    refusalSweep: v.optional(
      v.object({
        cursor: v.union(v.string(), v.null()),
        requested: v.number(),
        /** Originals skipped because an earlier operation still handles them. */
        busy: v.optional(v.number()),
      }),
    ),
    certificate: v.optional(certificatePin),
    ...scopeFields,
    task: taskSpec,
    request: v.string(),
    requestHash: v.string(),
    sourceKeyId: v.optional(v.id("apiKeys")),
    sourceMembershipId: v.optional(v.id("memberships")),
    /** Stripe connection that asked (ADR 0006); the third source beside keys and members. */
    sourceStripeConnectionId: v.optional(v.id("stripeConnections")),
    /**
     * The company's fiscal capture release (ADR 0007, §4): the source of the automatic queries
     * of a production capture started in the console, after the first one, and of their
     * documents (#418). Its version is pinned in `sourceAccessVersion` as `release:<version>`.
     */
    sourceCaptureReleaseId: v.optional(v.id("captureReleases")),
    sourceAccessVersion: v.optional(v.string()),
    projectEpoch: v.number(),
    grantEpoch: v.number(),
    state: operationState,
    stage: operationStage,
    generation: v.number(),
    fence: v.number(),
    attempts: v.number(),
    maxAttempts: v.number(),
    recoveryAttempts: v.optional(v.number()),
    leaseUntil: v.number(),
    nextAttemptAt: v.number(),
    recoveryAt: v.optional(v.number()),
    backoffMs: v.number(),
    jitterMs: v.number(),
    uncertain: v.boolean(),
    workId: v.optional(vWorkId),
    response: v.optional(v.string()),
    code: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_projectId_companyId_environment_state_nextAttemptAt", [
      "projectId",
      "companyId",
      "environment",
      "state",
      "nextAttemptAt",
    ])
    .index("by_projectId_companyId_environment_state_leaseUntil", [
      "projectId",
      "companyId",
      "environment",
      "state",
      "leaseUntil",
    ])
    .index("by_recoveryAt", ["recoveryAt"])
    .index("by_organizationId_and_state", ["organizationId", "state"])
    .index("by_organizationId_and_uncertain", ["organizationId", "uncertain"])
    .index("by_organizationId_and_projectId_and_environment", [
      "organizationId",
      "projectId",
      "environment",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  idempotencyRecords: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    name: v.string(),
    key: v.string(),
    requestHash: v.string(),
    operationId: v.id("operations"),
  }).index("by_organizationId_and_projectId_and_name_and_key", [
    "organizationId",
    "projectId",
    "name",
    "key",
  ]),
  operationAttempts: defineTable({
    ...archiveOriginFields,
    operationId: v.id("operations"),
    generation: v.number(),
    fence: v.number(),
    mode: v.union(v.literal("execute"), v.literal("reconcile"), v.literal("resume")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    code: v.optional(v.string()),
    /** Metadata of an unreadable authority answer (uncertain outcome); never body values. */
    diagnostic: v.optional(responseDiagnostic),
  }).index("by_operationId_and_generation_and_fence", ["operationId", "generation", "fence"]),
  operationAudit: defineTable({
    ...archiveOriginFields,
    operationId: v.id("operations"),
    generation: v.number(),
    actor: v.string(),
    action: v.string(),
    createdAt: v.number(),
  }).index("by_operationId", ["operationId"]),
  operationReceipts: defineTable({
    operationId: v.id("operations"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    kind: v.union(v.literal("result"), v.literal("usage")),
    createdAt: v.number(),
  }).index("by_operationId_and_kind", ["operationId", "kind"]),
  projects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    externalReference: v.string(),
    state: projectState,
    version: v.number(),
    accessEpoch: v.number(),
    creatorMembershipId: v.id("memberships"),
    creatorEpoch: v.number(),
    /**
     * `console`: the system project that owns what people do in the console (one per
     * organization, see `lib/projectAccess.ts`). Absent on integration projects.
     */
    kind: v.optional(v.literal("console")),
    createdAt: v.number(),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_externalReference", ["organizationId", "externalReference"])
    .index("by_organizationId_and_kind", ["organizationId", "kind"])
    .index("by_creatorMembershipId", ["creatorMembershipId"]),
  projectCompanies: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    scopes: v.array(integrationScope),
    environments: v.array(environment),
    active: v.boolean(),
    version: v.number(),
    accessEpoch: v.number(),
  })
    .index("by_projectId_and_companyId", ["projectId", "companyId"])
    .index("by_projectId_and_active", ["projectId", "active"])
    .index("by_organizationId_and_companyId", ["organizationId", "companyId"]),
  apiKeys: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    projectEpoch: v.number(),
    name: v.string(),
    keyHash: v.string(),
    prefix: v.string(),
    scopes: v.array(integrationScope),
    environment,
    companyIds: v.array(v.id("companies")),
    grantEpochs: v.array(v.number()),
    expiresAt: v.number(),
    revokedAt: v.union(v.number(), v.null()),
    rotatedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    creatorMembershipId: v.id("memberships"),
  })
    .index("by_keyHash", ["keyHash"])
    .index("by_projectId", ["projectId"]),
  integrationAudit: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    actorUserId: v.string(),
    action: v.string(),
    target: v.string(),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),
  apiUsageEvents: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    keyId: v.id("apiKeys"),
    requestId: v.string(),
    route: v.union(v.literal("companies.list"), v.literal("companies.get")),
    environment,
    day: v.string(),
    shard: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_organizationId_and_day_and_shard", ["organizationId", "day", "shard"])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  /** Compacted REST receipts. Cardinality depends on projects/routes, not requests or days. */
  apiUsageTotals: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    environment,
    route: v.union(v.literal("companies.list"), v.literal("companies.get")),
    count: v.number(),
    firstAt: v.number(),
    lastAt: v.number(),
  })
    .index("by_organizationId_and_projectId_and_environment_and_route", [
      "organizationId",
      "projectId",
      "environment",
      "route",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  companies: defineTable({
    organizationId: v.id("organizations"),
    cnpj: v.string(),
    ...companyFields,
    kind: companyKind,
    declaredBy: v.string(),
    declaredAt: v.number(),
    fieldSources: v.object({ name: fieldSource, address: fieldSource }),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_cnpj", ["organizationId", "cnpj"])
    .index("by_organizationId", ["organizationId"])
    // The Freecorps capture workflows find a company by its CNPJ across organizations (#424).
    .index("by_cnpj", ["cnpj"]),
  companyGrants: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    membershipId: v.id("memberships"),
    membershipEpoch: v.number(),
    active: v.boolean(),
    version: v.number(),
    updatedAt: v.number(),
  })
    .index("by_companyId_and_membershipId", ["companyId", "membershipId"])
    .index("by_membershipId_and_membershipEpoch_and_active", [
      "membershipId",
      "membershipEpoch",
      "active",
    ]),
  companyAudit: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    actorUserId: v.string(),
    action: companyAuditAction,
    targetMembershipId: v.optional(v.id("memberships")),
    createdAt: v.number(),
  }).index("by_companyId", ["companyId"]),
  onboarding: defineTable({
    organizationId: v.id("organizations"),
    mode: onboardingMode,
    companyId: v.optional(v.id("companies")),
    guidanceDismissed: v.boolean(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    ownerCount: v.number(),
    memberCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),
  memberships: defineTable({
    organizationId: v.id("organizations"),
    authUserId: v.string(),
    name: v.string(),
    email: v.string(),
    role: membershipRole,
    state: v.union(v.literal("active"), v.literal("removed")),
    version: v.number(),
    companyAccessEpoch: v.optional(v.number()),
    joinedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_authUserId", ["organizationId", "authUserId"])
    .index("by_organizationId_and_state", ["organizationId", "state"])
    // The owners and admins of an organization, without reading its other members (#594).
    .index("by_organizationId_and_state_and_role", ["organizationId", "state", "role"])
    .index("by_authUserId_and_state", ["authUserId", "state"]),
  invitations: defineTable({
    organizationId: v.id("organizations"),
    email: v.string(),
    role: membershipRole,
    tokenHash: v.string(),
    status: invitationStatus,
    expiresAt: v.number(),
    issuerMembershipId: v.id("memberships"),
    issuerVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_email_and_status", ["organizationId", "email", "status"])
    .index("by_email_and_status", ["email", "status"]),
  organizationAudit: defineTable({
    organizationId: v.id("organizations"),
    actorUserId: v.string(),
    action: auditAction,
    target: v.string(),
    beforeRole: v.optional(membershipRole),
    afterRole: v.optional(membershipRole),
    createdAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  /**
   * Each acceptance of the terms of use by an owner (#586): at the organization's creation or in
   * the console after a new version. The server chooses the version and records the SHA-256 of
   * its archived text; the last row is the acceptance that holds.
   */
  termsOfUseAcceptances: defineTable({
    organizationId: v.id("organizations"),
    membershipId: v.id("memberships"),
    version: v.string(),
    sha256: v.string(),
    createdAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  /**
   * The e-mail notice of a new version of the terms of use (#594): one row per organization and
   * version, written before the send, so a retry or a new deploy never sends it again. Holds no
   * address: `recipients` counts the owners and admins handed to the provider, one message each,
   * `confirmed` those the provider accepted and `withheld` those outside `ACCOUNT_EMAIL_RECIPIENTS`.
   * `sending` that never finishes stays uncertain and is not sent again; `pending` that never
   * started is resumed by `resumePending`. A row with `withheld` above zero never reaches those
   * owners and admins, not even after the allowlist is lifted; `status` lists it.
   */
  termsOfUseNotices: defineTable({
    organizationId: v.id("organizations"),
    version: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("partial"),
      v.literal("unconfirmed"),
      v.literal("skipped"),
    ),
    recipients: v.number(),
    confirmed: v.number(),
    withheld: v.number(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_organizationId_and_version", ["organizationId", "version"])
    .index("by_version_and_state_and_createdAt", ["version", "state", "createdAt"])
    .index("by_version_and_withheld", ["version", "withheld"]),
  /**
   * The sweep of the organizations for one version (#594): the cursor of the next batch and the
   * generation that fences a superseded chain. `done` once every organization was visited or the
   * version stopped being current.
   */
  termsOfUseNoticeRuns: defineTable({
    version: v.string(),
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
    state: v.union(v.literal("running"), v.literal("done")),
    organizations: v.number(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_version", ["version"]),
  developmentMail: defineTable({
    email: v.string(),
    otp: v.string(),
    type: v.union(
      v.literal("email-verification"),
      v.literal("forget-password"),
      v.literal("organization-invitation"),
      v.literal("email-change"),
      v.literal("terms-of-use"),
      v.literal("archive-notice"),
      v.literal("sandbox-closure-notice"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_email_and_type", ["email", "type"])
    .index("by_expiresAt", ["expiresAt"]),
  /** A pending e-mail change: the hashed code sent to the new address, for ten minutes. */
  emailChanges: defineTable({
    authUserId: v.string(),
    email: v.string(),
    codeHash: v.string(),
    attempts: v.number(),
    expiresAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_expiresAt", ["expiresAt"]),
  validationAccess: defineTable({
    authUserId: v.string(),
    role: v.union(v.literal("operator"), v.literal("viewer")),
  }).index("by_authUserId", ["authUserId"]),
  validationProbes: defineTable({
    key: v.literal("persistence-v1"),
    nonce: v.string(),
    createdAt: v.number(),
  }).index("by_key", ["key"]),
});
