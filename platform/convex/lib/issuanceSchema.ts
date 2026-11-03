import { defineTable } from "convex/server";
import { v } from "convex/values";
import { archiveOriginFields } from "./coldArchiveSchema";
import { environment } from "./projectValues";
import {
  artifactKind,
  cancelReason,
  cancellationState,
  exchangeFields,
  issuanceEventKind,
  issuanceState,
  rejectionItem,
  transportMode,
} from "./issuanceValues";

const scope = {
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  companyId: v.id("companies"),
  environment,
};

export const issuanceTables = {
  /**
   * One row per accepted request and per reserved DPS number: the row is also the ledger of the
   * number (`series` + `number`), created in the transaction that reserves it.
   */
  issuances: defineTable({
    ...archiveOriginFields,
    ...scope,
    operationId: v.id("operations"),
    state: issuanceState,
    transport: transportMode,
    target: v.string(),
    series: v.string(),
    number: v.number(),
    dpsId: v.string(),
    /** Canonical JSON of the frozen fiscal snapshot (profile + request), never rewritten. */
    snapshot: v.string(),
    snapshotSha256: v.string(),
    exchange: v.optional(exchangeFields),
    /** Times the persisted DPS may have reached the tax authority. */
    submissions: v.number(),
    accessKey: v.optional(v.string()),
    nfseNumber: v.optional(v.string()),
    authorizedAt: v.optional(v.number()),
    recoveredByConsult: v.optional(v.boolean()),
    documentId: v.optional(v.id("fiscalDocuments")),
    code: v.optional(v.string()),
    rejections: v.optional(v.array(rejectionItem)),
    cancellationId: v.optional(v.id("issuanceCancellations")),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    // No reader today: the "number ledger" lookup of an issuance by series and
    // number, for incidents and reconciliation (docs/plataforma/ISSUANCE.md,
    // docs/operacao/emissao-nfse.md). It does not enforce uniqueness;
    // `dpsSequences` does.
    .index("by_companyId_and_environment_and_series_and_number", [
      "companyId",
      "environment",
      "series",
      "number",
    ])
    .index("by_organizationId_and_companyId_and_environment_and_createdAt", [
      "organizationId",
      "companyId",
      "environment",
      "createdAt",
    ])
    .index("by_projectId_and_companyId_and_environment_and_createdAt", [
      "projectId",
      "companyId",
      "environment",
      "createdAt",
    ])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  /**
   * Last DPS number handed out per company, environment and series. Never decreases once a
   * number is reserved. `start` is the first number of the series (1 when absent); an owner or
   * admin may set it while no number was reserved (`last < start`), with `last = start - 1`.
   */
  dpsSequences: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    environment,
    series: v.string(),
    last: v.number(),
    start: v.optional(v.number()),
    startSetBy: v.optional(v.string()),
    startSetAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_companyId_and_environment_and_series", ["companyId", "environment", "series"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
  issuanceCancellations: defineTable({
    ...archiveOriginFields,
    ...scope,
    issuanceId: v.id("issuances"),
    operationId: v.id("operations"),
    /**
     * 1 for the first request on the invoice, +1 after each rejection. Internal order only: the
     * event XML no longer carries it, because `nPedRegEvento` is not in the official XSD.
     */
    sequence: v.number(),
    reasonCode: cancelReason,
    reason: v.string(),
    /** dhEvento frozen at acceptance. */
    requestedAt: v.string(),
    state: cancellationState,
    submissions: v.number(),
    alreadyRegistered: v.optional(v.boolean()),
    code: v.optional(v.string()),
    rejections: v.optional(v.array(rejectionItem)),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_issuanceId", ["issuanceId"]),
  /** Preserved XML of the issuance: signed DPS, authorized NFS-e and cancellation event. */
  issuanceArtifacts: defineTable({
    ...archiveOriginFields,
    organizationId: v.id("organizations"),
    issuanceId: v.id("issuances"),
    cancellationId: v.optional(v.id("issuanceCancellations")),
    kind: artifactKind,
    storageId: v.id("_storage"),
    sha256: v.string(),
    size: v.number(),
    signed: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_issuanceId_and_kind", ["issuanceId", "kind"])
    .index("by_storageId", ["storageId"]),
  issuanceEvents: defineTable({
    ...archiveOriginFields,
    organizationId: v.id("organizations"),
    issuanceId: v.id("issuances"),
    kind: issuanceEventKind,
    operationId: v.optional(v.id("operations")),
    code: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_issuanceId", ["issuanceId"]),
  /**
   * Current production gate per company, derived from its last `issuanceGateEvents` row and
   * written in the same transaction. `actor` is the generic `operator:freecorps`: the logins
   * stay in the history. Off unless an operator turns it on
   * (`issuance.setProductionGate`).
   */
  issuanceGates: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    production: v.boolean(),
    actor: v.string(),
    reason: v.string(),
    version: v.number(),
    updatedAt: v.number(),
    /** Event that produced this state; absent on rows written before the event history. */
    eventId: v.optional(v.id("issuanceGateEvents")),
  })
    .index("by_companyId", ["companyId"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * Append-only history of the production gate: who changed it, approved by whom, why, from which
   * workflow run and when. Never patched nor deleted while the organization exists; kept until the
   * end of the fiscal guard (retention class `commercial`).
   */
  issuanceGateEvents: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    version: v.number(),
    /** `enable`: the approved workflow. `emergency_disable`: the separate one, without approval. */
    kind: v.union(v.literal("enable"), v.literal("emergency_disable")),
    production: v.boolean(),
    /** GitHub login of whoever triggered this run or attempt (`github.triggering_actor`). */
    operator: v.string(),
    /**
     * `github.actor`, who dispatched the original run, when it differs from the operator (a
     * re-run triggered by someone else).
     */
    actor: v.optional(v.string()),
    /** GitHub login of the reviewer who approved the run; always present for `enable`. */
    approver: v.optional(v.string()),
    reason: v.string(),
    /** GitHub Actions run id and attempt. */
    runId: v.string(),
    runAttempt: v.number(),
    /** Published revision of the backend (`buildSha`), `null` when unpublished. */
    buildSha: v.union(v.string(), v.null()),
    /** `CONVEX_CLOUD_URL` of the deployment that recorded the change. */
    deployment: v.string(),
    createdAt: v.number(),
  })
    .index("by_companyId_and_version", ["companyId", "version"])
    .index("by_organizationId", ["organizationId"]),
  /**
   * Append-only history of the operator probes of the NFS-e transport (`issuanceProbe.verify` and
   * `issuanceProbe.verifyIssued`): who ran each one with the company's A1, why, against which
   * environment and with what result. A record of Freecorps itself, outside the audit the customer
   * sees (which keeps `operator:freecorps`), retention class `commercial` like the gate history.
   * Each run writes an `authorized` or `denied` row and, once it ends, a row that points to it.
   */
  issuanceProbeEvents: defineTable({
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    /** `probe`: mTLS, adhesion and parameters. `verify-issued`: the reading of an issuance. */
    kind: v.union(v.literal("probe"), v.literal("verify-issued")),
    /** Fiscal environment the reads go to. */
    environment: v.union(v.literal("producao-restrita"), v.literal("producao")),
    result: v.union(
      v.literal("authorized"),
      v.literal("denied"),
      v.literal("success"),
      v.literal("failed"),
      v.literal("stale"),
    ),
    /** GitHub login of whoever ran it, and why. */
    operator: v.string(),
    reason: v.string(),
    /** The issuance read by `verify-issued`. */
    issuanceId: v.optional(v.id("issuances")),
    /** Why a `denied` row was refused (`NOT_FOUND`, `ISSUANCE_PROBE_DISABLED`...). */
    code: v.optional(v.string()),
    /** The `authorized` row this result closes. */
    startedId: v.optional(v.id("issuanceProbeEvents")),
    /** Outcome of each read (target, host, outcome, HTTP status); never a body. */
    reads: v.optional(
      v.array(
        v.object({
          target: v.string(),
          host: v.string(),
          outcome: v.string(),
          httpStatus: v.union(v.number(), v.null()),
        }),
      ),
    ),
    /**
     * `verify-issued`: `true` when a single NFS-e, the recorded one, answers for the DPS Id;
     * `false` when the authority answered another one; `null` when the reads were not
     * conclusive.
     */
    single: v.optional(v.union(v.boolean(), v.null())),
    buildSha: v.union(v.string(), v.null()),
    deployment: v.string(),
    createdAt: v.number(),
  })
    .index("by_startedId", ["startedId"])
    .index("by_organizationId", ["organizationId"]),
  /** State of the synthetic tax authority used by the simulated sandbox transport. */
  issuanceSimulations: defineTable({
    ...archiveOriginFields,
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    environment,
    dpsId: v.string(),
    posts: v.number(),
    /** Consultations that still answer 404 (scenario `duplicada`). */
    lag: v.number(),
    accessKey: v.optional(v.string()),
    nfseXml: v.optional(v.string()),
    cancelled: v.boolean(),
    eventPosts: v.number(),
  })
    .index("by_companyId_and_environment_and_dpsId", ["companyId", "environment", "dpsId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_environment", ["organizationId", "environment"]),
};
