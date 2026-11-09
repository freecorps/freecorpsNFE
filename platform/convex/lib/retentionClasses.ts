import type { TableNames } from "../_generated/dataModel";
import { DAY } from "./operationalAudit";

/**
 * D01, decisions of 07/10/2026. Every table of the platform belongs to one retention class, so a
 * new table cannot ship without a decision: the `satisfies` below fails the typecheck.
 *
 * - `closure`: removed when the export window of a closed organization ends (30 + 7 days).
 * - `fiscal`: fiscal documents, originals, batches, capture and the original audit of the fiscal
 *   operations. Kept for the customer until the fiscal guard ends. An organization that never
 *   had Production loses `fiscal` right after the closure purge, with the `commercial` rows tied
 *   to it (usage, receipts, idempotency, gate, probe and release histories); plans, payments,
 *   capacity and the acceptances of the terms of use stay until the guard ends. Sandbox has no fiscal validity (decision of 27/10/2026,
 *   `fiscalGuard.early`).
 * - `commercial`: records of Freecorps itself as controller. Usage, plans, receipts, the
 *   acceptances of the terms of use and idempotency, for its own obligations; the production gate and probe histories
 *   (`issuanceGateEvents`, `issuanceProbeEvents`), for the defense of its decisions and of its
 *   use of the customer's certificate (regular exercise of rights, pending the fiscal/privacy
 *   review). Same deadline as `fiscal`, on another basis.
 * - `access`: Marco Civil access records, 184 days by their own job, closure or not.
 * - `decision`: the minimum record of closures and holds. Kept until one year after the fiscal
 *   guard, with only ids and dates once that guard ends (decision of 19/10/2026).
 * - `cache`, `control`, `reference`, `local`: global data with their own lifecycle, or rows of
 *   the jobs themselves, or local/validation tables. `operationalRetention` is a control row of
 *   one organization and goes together with the `commercial` receipts it compacts.
 */
export type RetentionClass =
  | "closure"
  | "fiscal"
  | "commercial"
  | "access"
  | "decision"
  | "cache"
  | "control"
  | "reference"
  | "local";

export const retentionClass = {
  coldArchiveRuns: "control",
  coldArchiveEntries: "control",
  // Upload intents of a rehydration (ADR 0009, §5, item 4): rows of the job itself.
  coldArchiveUploads: "control",
  // ADR 0010, phase B: the migration runs themselves (`contentMigration.ts`).
  contentMigrations: "control",
  // ADR 0010, phase C: the cold tier's sweep and its queue of bucket deletions, rows of the job.
  // A deletion outlives the purged version on purpose: it is what removes the cold object.
  coldTierSweeps: "control",
  coldObjectDeletions: "control",
  coldObjectUploads: "control",
  platformPlanSettings: "control",
  platformPlanAllocations: "commercial",
  platformPlanReceipts: "commercial",
  platformPlanTerms: "commercial",
  billingAccounts: "commercial",
  billingCheckouts: "commercial",
  billingGrants: "commercial",
  billingEvents: "commercial",
  platformFreeClaims: "commercial",
  capacityAccounts: "commercial",
  capacityEvents: "commercial",
  capacityTotals: "commercial",
  capacityFiles: "commercial",
  capacityRecords: "commercial",
  organizations: "closure",
  memberships: "closure",
  invitations: "closure",
  termsOfUseNotices: "closure",
  sandboxClosureNotices: "closure",
  organizationAudit: "closure",
  onboarding: "closure",
  companies: "closure",
  companyGrants: "closure",
  companyAudit: "closure",
  registryApplications: "closure",
  registryLookups: "closure",
  projects: "closure",
  projectCompanies: "closure",
  apiKeys: "closure",
  integrationAudit: "closure",
  certificates: "closure",
  certificateHeads: "closure",
  nfseProfiles: "closure",
  issuanceGates: "closure",
  captureReleases: "closure",
  captureSupervision: "closure",
  captureAlerts: "closure",
  webhookEndpoints: "closure",
  webhookDeliveries: "closure",
  webhookAttempts: "closure",
  stripeConnections: "closure",
  stripeEvents: "closure",
  outboxEvents: "closure",
  documentExports: "closure",
  // Assisted export requests (ADR 0009, §7): kept with the organization, gone with the closure.
  assistedExports: "closure",
  exportParts: "closure",
  exportTickets: "closure",
  documentDownloads: "closure",
  // The DANFE PDF is derived from the preserved XML and can be rendered again (#402): a cache
  // of the organization, gone with the closure. The original keeps the `fiscal` guard.
  documentDanfes: "closure",
  operationalAudit: "closure",
  operationalMonitors: "closure",
  operationalAlerts: "closure",
  operationalNotifications: "closure",
  operationalFailures: "closure",
  usageLeases: "closure",

  fiscalDocuments: "fiscal",
  documentArtifacts: "fiscal",
  documentVersions: "fiscal",
  documentItems: "fiscal",
  documentListings: "fiscal",
  documentFiscalEvidence: "fiscal",
  imports: "fiscal",
  importFiles: "fiscal",
  captureStreams: "fiscal",
  captureBatches: "fiscal",
  captureEnvelopes: "fiscal",
  captureBatchEntries: "fiscal",
  captureProofResponses: "fiscal",
  captureAudit: "fiscal",
  certificateAudit: "fiscal",
  operations: "fiscal",
  operationAttempts: "fiscal",
  operationAudit: "fiscal",
  operationProofDocuments: "fiscal",
  issuances: "fiscal",
  dpsSequences: "fiscal",
  issuanceCancellations: "fiscal",
  issuanceArtifacts: "fiscal",
  issuanceEvents: "fiscal",
  issuanceSimulations: "fiscal",
  // The ID map of a rehydrated organization (ADR 0009, §6) lives as long as its fiscal rows.
  coldArchiveIdMap: "fiscal",

  operationReceipts: "commercial",
  idempotencyRecords: "commercial",
  usageEvents: "commercial",
  usageTotals: "commercial",
  usagePlans: "commercial",
  usagePlanAudit: "commercial",
  apiUsageEvents: "commercial",
  apiUsageTotals: "commercial",
  registryCalls: "commercial",
  operationalRetention: "commercial",
  issuanceGateEvents: "commercial",
  captureReleaseEvents: "commercial",
  issuanceProbeEvents: "commercial",
  termsOfUseAcceptances: "commercial",

  accessRecords: "access",
  organizationClosures: "decision",
  retentionHolds: "decision",
  registryCache: "cache",
  captureFiscalHalts: "control",
  registryRestrictions: "control",
  accessRetention: "control",
  emailChanges: "control",
  termsOfUseNoticeRuns: "control",
  privacyIntakes: "control",
  privacyThreads: "control",
  privacyMessages: "control",
  privacyDownloads: "control",
  privacyMaintenance: "control",
  importMaintenance: "control",
  referenceVersions: "reference",
  referenceEntries: "reference",
  referenceActive: "reference",
  referenceAudit: "reference",
  developmentMail: "local",
  validationAccess: "local",
  validationProbes: "local",
} as const satisfies Record<TableNames, RetentionClass>;

// Brasília has had no daylight saving time since 2019: local midnight is 03:00 UTC.
const BRASILIA = 3 * 3_600_000;

/**
 * End of the guard of the classes kept after a closure (CTN art. 173, I): five years counted
 * from 1 January of the year after the fact, so a fact of 2026 is kept until 31/12/2031. A
 * closure stops every new fact in the same transaction, so the closure date bounds all of them
 * and one deadline covers the whole conserved set. Older facts stay until the same date.
 * Returns the first instant after the guard, 1 January of the sixth year, 00:00 in Brasília.
 */
export function fiscalGuardUntil(closedAt: number) {
  const year = new Date(closedAt - BRASILIA).getUTCFullYear();
  return Date.UTC(year + 6, 0, 1) + BRASILIA;
}

/** A pending guard is checked again at least weekly; no job sits scheduled for years. */
export const GUARD_RECHECK = 7 * DAY;

/**
 * End of the `decision` class (decision of 19/10/2026): one year after the end of the fiscal
 * guard, counted in calendar years of Brasília. `guardEnd` is the first instant after the guard,
 * the nominal `fiscalGuardUntil` or the release of a hold that kept it longer. A guard ending on
 * 31/12/2031 keeps the decisions until 31/12/2032; one held until 14/03/2034 keeps them until
 * 31/12/2035, never less than a full year. Returns 1 January of the next year, 00:00 in Brasília.
 */
export function decisionGuardUntil(guardEnd: number) {
  const year = new Date(guardEnd - 1 - BRASILIA).getUTCFullYear();
  return Date.UTC(year + 2, 0, 1) + BRASILIA;
}
