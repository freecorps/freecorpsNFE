import type { PaginationResult } from "convex/server";
import type { Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import schema from "../schema";
import { ARCHIVE_TABLES, archiveRowJson, isArchiveFence } from "./coldArchiveCore";
import { ARCHIVE_ID_REFERENCES, archiveReferences } from "./coldArchiveReferences";

/**
 * The reference rewrite of the rehydration under new IDs (ADR 0009, §5, item 5) and its inverse,
 * the canonical check. Both read the same list, derived from the schema and the classification
 * of `coldArchiveReferences.ts`: every field classified `rewritten`, with the tables it targets.
 */
type Step = { field: string } | { each: "array" | "values" | "keys" };
export type RewrittenPath = { path: string; steps: Step[]; targets: string[] };

/** `a.b[]`, `c{}` and `d{key}` into steps: a field, every array element, record values or keys. */
function stepsOf(path: string): Step[] {
  const steps: Step[] = [];
  for (const part of path.split(".")) {
    const field = part.replace(/(?:\[\]|\{\}|\{key\})+$/, "");
    steps.push({ field });
    for (const suffix of part.slice(field.length).match(/\[\]|\{\}|\{key\}/g) ?? [])
      steps.push({ each: suffix === "[]" ? "array" : suffix === "{}" ? "values" : "keys" });
  }
  return steps;
}

function rewrittenPaths(): Map<string, RewrittenPath[]> {
  const byTable = new Map<string, Map<string, RewrittenPath>>();
  for (const { table, path, target } of archiveReferences(schema)) {
    const action = (ARCHIVE_ID_REFERENCES as Record<string, string>)[`${table}.${path}`];
    if (action !== "rewritten") continue;
    const paths = byTable.get(table) ?? new Map<string, RewrittenPath>();
    byTable.set(table, paths);
    const known = paths.get(path) ?? { path, steps: stepsOf(path), targets: [] };
    paths.set(path, known);
    if (!known.targets.includes(target)) known.targets.push(target);
  }
  return new Map([...byTable].map(([table, paths]) => [table, [...paths.values()]]));
}
/** Table → the fields its second pass rewrites, from the schema. */
export const REWRITTEN_PATHS = rewrittenPaths();

/** Applies `change` to every string found at `steps`; returns a new value, or the same one. */
function visit(value: unknown, steps: Step[], change: (id: string) => string): unknown {
  const [step, ...rest] = steps;
  if (!step) return typeof value === "string" ? change(value) : value;
  if ("field" in step) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!(step.field in record)) return value;
    const next = visit(record[step.field], rest, change);
    return next === record[step.field] ? value : { ...record, [step.field]: next };
  }
  if (step.each === "array") {
    if (!Array.isArray(value)) return value;
    const next = value.map((item) => visit(item, rest, change));
    return next.some((item, i) => item !== value[i]) ? next : value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const next = entries.map(([key, item]) =>
    step.each === "keys"
      ? [visit(key, rest, change) as string, item]
      : [key, visit(item, rest, change)],
  );
  return next.some(([key, item], i) => key !== entries[i]![0] || item !== entries[i]![1])
    ? Object.fromEntries(next)
    : value;
}

/** Every ID the rewritten fields of a row of `table` hold, with the tables each field targets. */
export function referencedIds(table: string, row: Record<string, unknown>) {
  const found: { id: string; targets: string[] }[] = [];
  for (const path of REWRITTEN_PATHS.get(table) ?? [])
    visit(row, path.steps, (id) => {
      found.push({ id, targets: path.targets });
      return id;
    });
  return found;
}

/**
 * The row with each rewritten reference replaced through `ids` (an ID absent from it stays):
 * the forward map in the second pass, the inverse one in the canonical check. Returns the changed
 * top-level fields, empty when nothing changed.
 */
export function rewriteReferences(
  table: string,
  row: Record<string, unknown>,
  ids: Map<string, string>,
): Record<string, unknown> {
  let next: Record<string, unknown> = row;
  for (const path of REWRITTEN_PATHS.get(table) ?? [])
    next = visit(next, path.steps, (id) => ids.get(id) ?? id) as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(next))
    if (value !== row[field]) changed[field] = value;
  return changed;
}

/**
 * The canonical form of a rehydrated row (ADR 0009, §5, "A conferência final"): the row as the
 * package of this cycle carried it. Removes only the fields this cycle added (the origin pair in
 * the first cycle, when it names the previous ID itself), turns every reference back into the
 * previous ID with `inverse` (this cycle's new → previous) and gives back the previous `_id` and
 * `_creationTime`. The SHA-256 of the result must equal the catalogue entry's.
 */
export function canonicalRow(
  table: string,
  row: Record<string, unknown>,
  previous: { id: string; creationTime: number },
  inverse: Map<string, string>,
) {
  const restored: Record<string, unknown> = {
    ...row,
    ...rewriteReferences(table, row, inverse),
    _id: previous.id,
    _creationTime: previous.creationTime,
  };
  if (restored.originId === previous.id && restored.originCreationTime === previous.creationTime) {
    delete restored.originId;
    delete restored.originCreationTime;
  }
  return archiveRowJson(restored as Parameters<typeof archiveRowJson>[0]);
}

/** The rows of an organization in one table, a page at a time. */
type HotPage = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  cursor: string | null,
) => Promise<PaginationResult<{ _id: string } & Record<string, unknown>>>;
const page = { numItems: 64, maximumBytesRead: 512 * 1024 };
/**
 * Hot rows of the organization that point into the archive and are found through an index on
 * the organization. The second pass rewrites their references after the rehydrated rows. Rows
 * already rehydrated in these tables (the fence's `captureStreams`, `certificateAudit`) are
 * read again harmlessly: their references already hold new IDs, which the map never has as
 * previous IDs.
 */
export const HOT_REFERENCE_SOURCES: { table: TableNames; page: HotPage }[] = [
  {
    table: "captureStreams",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("captureStreams")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    // Rows written in custody (a certificate revocation) stay hot with their IDs.
    table: "certificateAudit",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("certificateAudit")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "documentDownloads",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("documentDownloads")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "documentDanfes",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("documentDanfes")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "documentExports",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("documentExports")
        .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "idempotencyRecords",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("idempotencyRecords")
        .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
          q.eq("organizationId", organizationId),
        )
        .paginate({ cursor, ...page }),
  },
  {
    table: "issuanceProbeEvents",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("issuanceProbeEvents")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "operationalAudit",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_createdAt", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "operationalFailures",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("operationalFailures")
        .withIndex("by_organizationId_and_expiresAt", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
  {
    table: "stripeEvents",
    page: (ctx, organizationId, cursor) =>
      ctx.db
        .query("stripeEvents")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate({ cursor, ...page }),
  },
];
/**
 * Hot rows found from the other side, by an index on the field itself: for every rehydrated
 * operation, its receipts and registry calls under the previous ID.
 */
export const MAP_SIDE_REFERENCES = ["operationReceipts.operationId", "registryCalls.operationId"];
/**
 * How many receipts or registry calls one operation may have for the second pass to rewrite them
 * all in its transaction. An operation has one receipt per kind (`result`, `usage`) and one
 * registry call, so this is a wide bound; above it the rehydration stops with
 * `ARCHIVE_REFERENCE_SCAN_LIMIT` instead of leaving a row with the previous ID.
 */
export const MAP_SIDE_LIMIT = 256;
export async function mapSideRows(ctx: QueryCtx, table: string, previousId: string) {
  if (table !== "operations") return [];
  const operationId = previousId as Id<"operations">;
  const [receipts, calls] = await Promise.all([
    ctx.db
      .query("operationReceipts")
      .withIndex("by_operationId_and_kind", (q) => q.eq("operationId", operationId))
      .take(MAP_SIDE_LIMIT + 1),
    ctx.db
      .query("registryCalls")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .take(MAP_SIDE_LIMIT + 1),
  ]);
  if (receipts.length > MAP_SIDE_LIMIT || calls.length > MAP_SIDE_LIMIT)
    throw new Error("ARCHIVE_REFERENCE_SCAN_LIMIT");
  return [
    ...receipts.map((row) => ({ table: "operationReceipts" as const, row })),
    ...calls.map((row) => ({ table: "registryCalls" as const, row })),
  ];
}
/**
 * Archived tables with rewritten fields whose hot rows written in custody are not read by the
 * second pass: `captureAudit` has no organization index, and the only audit written in custody
 * (the withdrawal of the capture release) names the stream, which is fence and kept.
 */
export const HOT_CUSTODY_UNREAD = ["captureAudit"];

/** Archived tables whose rows are recreated under new IDs: all but the fence. */
export function rehydratedTable(table: string) {
  return (ARCHIVE_TABLES as readonly string[]).includes(table) && !isArchiveFence(table);
}
/** The six document tables whose rows count as database stock (`capacityCore`, `FiscalTable`). */
export const TRACKED_TABLES = [
  "fiscalDocuments",
  "documentArtifacts",
  "documentVersions",
  "documentItems",
  "documentListings",
  "documentFiscalEvidence",
] as const;
export function trackedTable(table: string): table is (typeof TRACKED_TABLES)[number] {
  return (TRACKED_TABLES as readonly string[]).includes(table);
}
/**
 * Notes per batch of the rehydration's cold stage (ADR 0010, C2), for the executor's batches and
 * the server's own pass alike: the moves of one batch are scheduled together, and every note's
 * versions (at most `MAX_VERSIONS`) are read in one transaction.
 */
export const COLD_BATCH_NOTES = 16;
/**
 * The two tables whose rows point at a cold object, with the stored-file field the object
 * replaced: the canonical check puts the file back in a row moved by the cold stage, so the row
 * hashes as the package carried it (`scripts/lib/incremental-backup.mjs` has the same list).
 */
export const COLD_OBJECT_FIELDS = {
  documentVersions: {
    storage: "contentStorageId",
    key: "contentObjectKey",
    sha256: "contentObjectSha256",
    size: "contentObjectSize",
  },
  documentArtifacts: {
    storage: "storageId",
    key: "objectKey",
    sha256: "objectSha256",
    size: "objectSize",
  },
} as const;
/**
 * Safety margin of the rehydration's capacity admission (ADR 0009, §5, item 1), over the logical
 * bytes the executor measures for the six document tables, with the origin pair, plus the ID map.
 * Documented in docs/plataforma/USAGE.md.
 */
export const REHYDRATION_MARGIN = 0.1;
/**
 * How long after an upload intent its blob may still be created: the upload URL's lifetime
 * (one hour in Convex) plus a margin. `recordUpload` refuses a blob created outside it.
 */
export const UPLOAD_WINDOW = 70 * 60_000;
/**
 * How old a blob must be before the orphan collection judges it: longer than any flow of the
 * platform takes between storing a blob and recording it (an action, at most 10 minutes), as the
 * privacy mail collector does (`ORPHAN_GRACE`).
 */
export const UPLOAD_ORPHAN_GRACE = 60 * 60_000;
/**
 * Slack on the end of an attempt's window when the next attempt closes it. The next attempt's
 * `startedAt` is a mutation's clock and the orphan's `_creationTime` is the storage's: a blob
 * stored just before the next attempt can carry a creation time a little after its `startedAt`.
 * Widening the window is safe: a candidate must still have the original's exact bytes, be held
 * by nothing and be older than the grace.
 */
export const UPLOAD_WINDOW_SLACK = 60_000;
/**
 * Blobs of `_storage` read per call of the orphan collection. `_storage` is global: other
 * organizations' uploads in the same window are read too, so the window goes in pages, with the
 * position kept on the intent (`scannedThrough`), never refused for its size.
 */
export const ORPHAN_SCAN_PAGE = 256;
/**
 * Blobs of the same `_creationTime` the cursor may hold. Far above anything stored in one
 * millisecond; above it the collection stops with `ARCHIVE_ORPHAN_SCAN_TIE` instead of looping.
 */
export const ORPHAN_SCAN_TIES = 1024;
export type OrphanScanCursor = { through: number; seenAtThrough: string[] };
/**
 * One step of the orphan collection over a window of `_storage`, read with
 * `gte("_creationTime", through)` and `take(ORPHAN_SCAN_PAGE + seenAtThrough.length)`. Several
 * blobs may share a `_creationTime`, so the cursor is the instant plus the IDs already judged at
 * exactly that instant: those are skipped, and a page that ends inside a run of equal instants
 * resumes at the same instant without losing the rest. Returns the blobs to judge now and the
 * next cursor, or `null` once the window is read to its end.
 */
export function orphanScanStep<B extends { _id: string; _creationTime: number }>(
  read: B[],
  cursor: OrphanScanCursor | undefined,
  page = ORPHAN_SCAN_PAGE,
): { judge: B[]; next: OrphanScanCursor | null } {
  const seen = new Set(cursor?.seenAtThrough ?? []);
  const fresh = read.filter(
    (blob) => !(cursor && blob._creationTime === cursor.through && seen.has(blob._id)),
  );
  const judge = fresh.slice(0, page);
  const exhausted = read.length < page + seen.size && fresh.length <= page;
  const last = judge[judge.length - 1];
  if (exhausted || !last) return { judge, next: null };
  const carried = cursor && cursor.through === last._creationTime ? cursor.seenAtThrough : [];
  const seenAtThrough = [
    ...carried,
    ...judge.filter((blob) => blob._creationTime === last._creationTime).map((blob) => blob._id),
  ];
  if (seenAtThrough.length > ORPHAN_SCAN_TIES) throw new Error("ARCHIVE_ORPHAN_SCAN_TIE");
  return { judge, next: { through: last._creationTime, seenAtThrough } };
}
