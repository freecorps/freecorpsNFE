import { defineTable } from "convex/server";
import { v } from "convex/values";
import { archiveOriginFields } from "./coldArchiveSchema";
import { scopeFields } from "./operationValues";
import { captureAlertDelivery, captureAlertKind, captureMode, captureState } from "./captureValues";
export const captureTables = {
  captureProofResponses: defineTable({
    ...archiveOriginFields,
    streamId: v.id("captureStreams"),
    xml: v.string(),
    calls: v.number(),
  }).index("by_streamId", ["streamId"]),
  captureStreams: defineTable({
    ...scopeFields,
    identity: v.string(),
    service: v.literal("nfe-distribution"),
    state: captureState,
    version: v.number(),
    checkpoint: v.string(),
    sourceCursor: v.optional(v.string()),
    /**
     * The last NSU the source holds for the company (`maxNSU`), from the newest committed answer
     * (#494): the console tells a queue still being read from one already caught up. Absent until
     * an answer with it commits, including on streams from before the field.
     */
    sourceMaxNsu: v.optional(v.string()),
    mode: captureMode,
    nextAllowedAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    operationId: v.optional(v.id("operations")),
    code: v.optional(v.string()),
    /**
     * The attention was the Freecorps cut by variable (#601): the stream stopped with
     * `FISCAL_TRANSPORT_DISABLED` or `ACCESS_REVOKED` while `FNFE_CAPTURE_TRANSPORT` or
     * `FNFE_CAPTURE_FISCAL` was missing (`lib/captureAttention.ts`, `cutByVariable`). Written on
     * every move to attention; the console reads it only for the attention it was written with.
     * Not part of the REST connection.
     */
    freecorpsCut: v.optional(v.boolean()),
    /**
     * A gap in the sequence the stream is recovering (#419), from the `distNSU` response that
     * revealed it until the checkpoint reaches the source cursor (`lib/captureGap.ts`).
     */
    recovery: v.optional(
      v.object({
        /** When the gap was found, and the last answered query before it: the quiet period. */
        detectedAt: v.number(),
        quietSince: v.optional(v.number()),
        /** The response that revealed the gap still had a queue (`ultNSU < maxNSU`). */
        queuePending: v.boolean(),
        /** The highest NSU of the gap the source answered 137 for with `consNSU`. */
        unavailableTo: v.optional(v.string()),
        /** The NSU the next `consNSU` asks for; the one after the checkpoint when absent. */
        probe: v.optional(v.string()),
      }),
    ),
    received: v.number(),
    /**
     * Consecutive 999 the stream is retrying (#195), 1 or 2; absent otherwise. The third stops
     * the stream in attention with `SOURCE_999` (`captureProcessing.checkpoint`).
     */
    sourceErrors: v.optional(v.number()),
    transferHash: v.optional(v.string()),
    transferExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_identity_environment_service", ["identity", "environment", "service"])
    .index("by_companyId_environment", ["companyId", "environment"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  captureBatches: defineTable({
    ...archiveOriginFields,
    usageKey: v.optional(v.string()),
    storedBytes: v.optional(v.number()),
    streamId: v.id("captureStreams"),
    operationId: v.id("operations"),
    ownerVersion: v.number(),
    requestNsu: v.string(),
    mode: captureMode,
    rawId: v.id("_storage"),
    rawHash: v.string(),
    status: v.optional(v.string()),
    lastNsu: v.optional(v.string()),
    maxNsu: v.optional(v.string()),
    envelopeCount: v.optional(v.number()),
    saved: v.number(),
    committed: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_rawId", ["rawId"])
    .index("by_operationId", ["operationId"])
    .index("by_streamId_and_status_and_lastNsu", ["streamId", "status", "lastNsu"]),
  captureEnvelopes: defineTable({
    ...archiveOriginFields,
    streamId: v.id("captureStreams"),
    nsu: v.string(),
    batchId: v.id("captureBatches"),
    artifactId: v.id("documentArtifacts"),
    schema: v.string(),
    sha256: v.string(),
    operationId: v.optional(v.id("operations")),
  }).index("by_streamId_nsu", ["streamId", "nsu"]),
  captureBatchEntries: defineTable({
    ...archiveOriginFields,
    batchId: v.id("captureBatches"),
    position: v.number(),
    envelopeId: v.id("captureEnvelopes"),
  }).index("by_batchId_position", ["batchId", "position"]),
  captureAudit: defineTable({
    ...archiveOriginFields,
    streamId: v.id("captureStreams"),
    organizationId: v.id("organizations"),
    action: v.string(),
    actor: v.string(),
    checkpoint: v.string(),
    batchId: v.optional(v.id("captureBatches")),
    /**
     * `history_limited` (#419): the NSU range a person accepted to lose, the stream version the
     * confirmation named, so a retry of the same confirmation is recognized, and the owner's
     * reason (#442). Losses accepted before the reason was required have none.
     */
    lost: v.optional(
      v.object({
        from: v.string(),
        to: v.string(),
        confirmedVersion: v.number(),
        reason: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_streamId", ["streamId"])
    .index("by_streamId_and_action_and_createdAt", ["streamId", "action", "createdAt"]),
  /**
   * Current fiscal capture release per company on a sandbox-based deployment (ADR 0007, §2 and
   * amendment of 22/10/2026), derived from its last `captureReleaseEvents` row in the same
   * transaction. `released` opens production for the capture; otherwise only the reading of what
   * was captured remains. `blocked` is set by the Freecorps emergency and stops the company from
   * releasing again until Freecorps unblocks it.
   */
  captureReleases: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    released: v.boolean(),
    /** Released at least once: only then is a withdrawn company read as `withdrawn`. */
    releasedBefore: v.boolean(),
    blocked: v.boolean(),
    /** Minimum hours between queries at the end of the queue, 1 to 24. */
    minIntervalHours: v.number(),
    /** `member:<membershipId>` for the company's manager, `operator:freecorps` for Freecorps. */
    actor: v.string(),
    reason: v.string(),
    /**
     * Version of the release itself: the event that last released, withdrew, blocked or unblocked
     * it. The queued queries pin it (`releaseAccessVersion`), so an interval change, recorded as
     * its own event, keeps it.
     */
    version: v.number(),
    updatedAt: v.number(),
    eventId: v.id("captureReleaseEvents"),
    /**
     * The last acceptance of new terms of a release that holds (`console_terms`, #428). Without
     * it, the release's own event names the terms.
     */
    termsEventId: v.optional(v.id("captureReleaseEvents")),
  })
    .index("by_companyId", ["companyId"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * Append-only history of the fiscal capture release: the company's manager who released or
   * withdrew it in the console, with the accepted terms, or the Freecorps person who withdrew or
   * unblocked it by workflow, with run and attempt. Kept like the NFS-e gate history (retention
   * class `commercial`).
   */
  captureReleaseEvents: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    version: v.number(),
    kind: v.union(
      v.literal("console_release"),
      v.literal("console_withdraw"),
      /** The manager changed the minimum interval of a release that holds (#432). */
      v.literal("console_interval"),
      /** The manager accepted a new version of the terms for a release that holds (#428). */
      v.literal("console_terms"),
      v.literal("emergency_withdraw"),
      v.literal("unblock"),
    ),
    released: v.boolean(),
    blocked: v.boolean(),
    minIntervalHours: v.number(),
    /**
     * Console changes: the manager and, on release or new terms, the version of the accepted
     * terms and the SHA-256 of their archived text. Releases before #428 have the version only;
     * the version still names the text (`CAPTURE_TERMS_ARCHIVE`).
     */
    membershipId: v.optional(v.id("memberships")),
    terms: v.optional(v.string()),
    termsSha256: v.optional(v.string()),
    /** Production API keys of the company revoked by this release. */
    revokedKeys: v.number(),
    /** Workflow changes: GitHub logins, run and attempt. */
    operator: v.optional(v.string()),
    actor: v.optional(v.string()),
    reason: v.string(),
    runId: v.optional(v.string()),
    runAttempt: v.optional(v.number()),
    buildSha: v.union(v.string(), v.null()),
    deployment: v.string(),
    createdAt: v.number(),
  })
    .index("by_companyId_and_version", ["companyId", "version"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * Supervision of a released company's production capture on the site (#422): the generation
   * of its next scheduled check (`captureSupervisor.check`) and when it last ran. One row per
   * company, armed by the release, by each audited transition of the stream and by
   * `captureSupervisor.survey`; the check stops by itself once the release is withdrawn. It never
   * queries the source.
   */
  captureSupervision: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    generation: v.number(),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    checkedAt: v.optional(v.number()),
    /** The generation whose check first failed, while the following ones keep failing. */
    failingSince: v.optional(v.number()),
  }).index("by_companyId", ["companyId"]),
  /**
   * Freecorps alerts of the site's production capture (#422), once per `key`: an attention of the
   * stream or what the supervisor found. Each one is logged and, with a destination configured,
   * e-mailed to the Freecorps operational address once.
   */
  captureAlerts: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    streamId: v.optional(v.id("captureStreams")),
    kind: captureAlertKind,
    /** What makes the alert unique: a repeated finding finds the same key and adds nothing. */
    key: v.string(),
    /** The attention code, or the code of the stopped operation. */
    code: v.optional(v.string()),
    /** The threshold reached: days without a query, of the gap, or left on the A1. */
    days: v.optional(v.number()),
    streamState: v.optional(captureState),
    delivery: captureAlertDelivery,
    /** When the e-mail was handed to the provider, for the hourly ceiling. */
    sentAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_companyId_and_createdAt", ["companyId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_sentAt", ["sentAt"]),
  /**
   * General stop of the hosted site's fiscal capture, persisted (#424): an append-only history
   * whose last row decides. `halted` refuses every production capture query in the gate
   * (`lib/siteCapture.ts`), like removing `FNFE_CAPTURE_TRANSPORT`, without editing a variable.
   * Only the Freecorps workflows write it, with logins, run and attempt. No organization: one
   * switch for the whole deployment (retention class `control`).
   */
  captureFiscalHalts: defineTable({
    version: v.number(),
    kind: v.union(v.literal("halt"), v.literal("resume")),
    halted: v.boolean(),
    operator: v.string(),
    actor: v.optional(v.string()),
    reason: v.string(),
    runId: v.string(),
    runAttempt: v.number(),
    buildSha: v.union(v.string(), v.null()),
    deployment: v.string(),
    createdAt: v.number(),
  }).index("by_version", ["version"]),
};
