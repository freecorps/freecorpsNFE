import { convexToJson, ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const ARCHIVE_DAY = 86_400_000;
export const ARCHIVE_DATABASE_LIMIT = 256 * 1024 * 1024;
export const ARCHIVE_FILE_LIMIT = 2 * 1024 ** 3;
export const ARCHIVE_ROW_LIMIT = 100_000;
/**
 * Version of the fiscal schema a package is made with, recorded in its manifest (ADR 0009, §5,
 * "Mudança de schema durante a guarda"); a manifest without it is version 1. Bump it, with a
 * package migration from the previous version, whenever a row valid under the old schema of an
 * archived table would not be valid, or would mean something else, under the new one: a required
 * field added, a field removed, renamed or retyped, a literal dropped. An optional field that old
 * rows simply lack, like the origin pair of §5, item 6, needs no bump. `scripts/lib/
 * cold-archive.mjs` carries the same number (`ARCHIVE_SCHEMA_VERSION`); a test keeps them equal.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;
export const ARCHIVE_TABLES = [
  "fiscalDocuments",
  "documentArtifacts",
  "documentVersions",
  "documentItems",
  "documentListings",
  "documentFiscalEvidence",
  "imports",
  "importFiles",
  "captureStreams",
  "captureBatches",
  "captureEnvelopes",
  "captureBatchEntries",
  "captureProofResponses",
  "captureAudit",
  "certificateAudit",
  "operations",
  "operationAttempts",
  "operationAudit",
  "operationProofDocuments",
  "issuances",
  "dpsSequences",
  "issuanceCancellations",
  "issuanceArtifacts",
  "issuanceEvents",
  "issuanceSimulations",
] as const satisfies readonly TableNames[];
export type ArchiveTable = (typeof ARCHIVE_TABLES)[number];
/**
 * The minimal fence of ADR 0009, §3 ("Numeração e captura"): the whole rows of these fiscal tables
 * enter the package, with their catalogue entry and hash, but never leave the hot database. They
 * keep their original IDs, so no DPS number is reused and no capture restarts from zero while the
 * organization is archived. At most a thousand streams per organization (`assertQuiescent`).
 *
 * - `scan` stores each fence row's JSON in its entry (`snapshot`); the package carries that
 *   snapshot. Since the rows stay hot, a write after the scan is legitimate (withdrawing the
 *   capture release in custody pauses the stream), so `materialize` never rereads them.
 * - `removeHotBatch` never deletes them nor releases their capacity inventory (§5, item 5): it only
 *   checks that the row is still there and still the organization's, then marks the entry handled.
 * - Contract for the rehydration under new IDs (PR 6) and its reference rewrite: these rows are
 *   never recreated, the ID map has no entry for them, references to them are never rewritten and
 *   their capacity inventory is never rebuilt. A rehydrated row pointing to a fence row keeps the
 *   original ID, which still resolves.
 */
export const ARCHIVE_FENCE_TABLES = [
  "dpsSequences",
  "captureStreams",
] as const satisfies readonly ArchiveTable[];
export function isArchiveFence(table: string): boolean {
  return (ARCHIVE_FENCE_TABLES as readonly string[]).includes(table);
}
/**
 * The stored-file fields (`v.id("_storage")`) of each archived table, as a list per table: the
 * tiered guard (ADR 0010, phase B) adds more than one to a table. The scan packs every file named
 * by any of them; `scripts/cold-archive.test.ts` checks this against the schema.
 */
export const ARCHIVE_STORAGE_FIELDS: Partial<Record<TableNames, readonly string[]>> = {
  importFiles: ["storageId"],
  documentArtifacts: ["storageId"],
  documentVersions: ["contentStorageId"],
  captureBatches: ["rawId"],
  issuanceArtifacts: ["storageId"],
};
/** The stored-file IDs a row of `table` holds, in the order of `ARCHIVE_STORAGE_FIELDS`. */
export function archiveStorageIds(table: string, row: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const field of ARCHIVE_STORAGE_FIELDS[table as TableNames] ?? []) {
    const value = row[field];
    if (typeof value === "string" && !ids.includes(value)) ids.push(value);
  }
  return ids;
}
const parents: Record<string, TableNames> = {
  documentId: "fiscalDocuments",
  versionId: "documentVersions",
  artifactId: "documentArtifacts",
  importId: "imports",
  operationId: "operations",
  streamId: "captureStreams",
  batchId: "captureBatches",
  issuanceId: "issuances",
  endpointId: "webhookEndpoints",
  deliveryId: "webhookDeliveries",
};
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function archiveHash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function archiveRowJson(row: Parameters<typeof convexToJson>[0]) {
  return stableJson(convexToJson(row));
}
export async function archiveStatus(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
) {
  return ctx.db
    .query("coldArchiveRuns")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .first();
}
/**
 * At most one activity mark per organization in this window for the console's reads of fiscal
 * data (`archiveNotice.markFiscalRead`, #641). A day against the 90 of ADR 0009, §1.
 */
export const FISCAL_READ_WINDOW = ARCHIVE_DAY;
/**
 * The last activity of an open organization (ADR 0009, §1): changes to the organization or its
 * plan, usage (`usageEvents`) and REST reads, downloads and exports (`capacityEvents`). The
 * console's reads of fiscal data move `organizations.updatedAt` (`archiveNotice.markFiscalRead`).
 * A login alone does not count. Read in the transaction that decides on it.
 */
export async function lastActivity(
  ctx: Pick<QueryCtx, "db">,
  organization: Doc<"organizations">,
  plan: Doc<"usagePlans"> | null,
) {
  const usage = await ctx.db
    .query("usageEvents")
    .withIndex("by_organizationId_and_updatedAt", (q) => q.eq("organizationId", organization._id))
    .order("desc")
    .first();
  const traffic = await ctx.db
    .query("capacityEvents")
    .withIndex("by_organizationId_and_updatedAt", (q) => q.eq("organizationId", organization._id))
    .order("desc")
    .first();
  return Math.max(
    organization.updatedAt,
    plan?.updatedAt ?? 0,
    usage?.updatedAt ?? 0,
    traffic?.updatedAt ?? 0,
  );
}
/** Read in the SAME transaction as every protected write. The index range participates in OCC. */
export async function assertOrganizationHot(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
) {
  const run = await archiveStatus(ctx, organizationId);
  if (run && !["notice", "hot"].includes(run.state))
    throw new ConvexError({
      code: "ORGANIZATION_ARCHIVED",
      message:
        "Organização em arquivo econômico. Solicite restauração assistida para voltar a operar.",
    });
}
/**
 * Whether the organization's fiscal data is out of reach: a run past the notice, from `frozen` to
 * `restoring`. Only the actions of ADR 0009, §2 continue then; the caller refuses everything else
 * with `assertOrganizationHot`. Read in the transaction of the action it decides.
 */
export async function inCustody(ctx: Pick<QueryCtx, "db">, organizationId: Id<"organizations">) {
  const run = await archiveStatus(ctx, organizationId);
  return !!run && run.state !== "notice" && run.state !== "hot";
}
/**
 * Contracting, renewing or changing the plan (ADR 0009, §2): allowed while hot, in the notice and
 * once archived; refused with `ORGANIZATION_ARCHIVING` while the archiving or the rehydration is
 * under way. The organization tries again when the run reaches `archived` or `hot`.
 */
export async function assertPlanChangeable(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
) {
  const run = await archiveStatus(ctx, organizationId);
  if (run && !["hot", "notice", "archived"].includes(run.state))
    throw new ConvexError({
      code: "ORGANIZATION_ARCHIVING",
      message:
        "O arquivamento ou a reativação da organização está em curso. Tente de novo quando terminar.",
    });
}
/**
 * Ends the pending notice of an open organization (ADR 0009, §1): "Manter ativa" on Free, or any
 * new plan, in the same transaction that records it. The run returns to `hot` with a new version,
 * so `freeze` refuses its fence, and eligibility counts its whole term again. Without a pending
 * notice, nothing changes.
 */
export async function endArchiveNotice(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Id<"organizations">,
  by: "keep_active" | "plan",
) {
  const run = await archiveStatus(ctx, organizationId);
  if (run?.state !== "notice" || run.reason === "closed") return false;
  const now = Date.now();
  await ctx.db.patch("coldArchiveRuns", run._id, {
    state: "hot",
    version: run.version + 1,
    noticeEnded: { by, at: now },
    updatedAt: now,
  });
  return true;
}
/** Resolve children while all parents are still hot. Never guess ownership of an unknown row. */
export async function archiveOwner(
  ctx: Pick<QueryCtx, "db">,
  row: Record<string, unknown>,
  depth = 0,
): Promise<string> {
  if (typeof row.organizationId === "string") return row.organizationId;
  if (depth > 8) throw new Error("ARCHIVE_RELATION_DEPTH");
  for (const [field, table] of Object.entries(parents)) {
    if (typeof row[field] !== "string") continue;
    const id = ctx.db.normalizeId(table, row[field]);
    const parent = id && (await ctx.db.get(table, id));
    if (parent) return archiveOwner(ctx, parent, depth + 1);
  }
  throw new Error("ARCHIVE_UNRESOLVED_OWNER");
}
export function archiveGate() {
  if (process.env.FNFE_COLD_ARCHIVE !== "enabled") throw new Error("ARCHIVE_DISABLED");
}
