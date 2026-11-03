import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { trackDatabaseRecord } from "./capacityCore";
import { ARCHIVE_TABLES, isArchiveFence } from "./coldArchiveCore";

export { firstCreation, firstId, originFor } from "./coldArchiveOrigin";

/** What the ID map may name: a rehydrated row of a non-fence archived table, or a stored file. */
export function mappableTable(table: string): boolean {
  return (
    table === "_storage" ||
    ((ARCHIVE_TABLES as readonly string[]).includes(table) && !isArchiveFence(table))
  );
}

export type ArchiveIdEntry = {
  organizationId: Id<"organizations">;
  runId: Id<"coldArchiveRuns">;
  table: string;
  previousId: string;
  previousCreationTime: number;
  newId: string;
};

/**
 * Records one entry of the ID map (ADR 0009, §6). The rehydration (PR 6) calls it in the SAME
 * transaction that inserts the new row, so a repeated batch finds the entry and never duplicates
 * the row. Idempotent by run and previous ID: the same entry returns the existing one; a
 * different new ID, table or creation for the same previous ID, or a new ID already mapped from
 * another one, is refused.
 *
 * Only while the run of this organization is `restoring`. The entry counts as the
 * organization's database stock, in inventory mode: the rehydration's admission (§5, item 1)
 * already checked that the whole package and the map fit the plan, so it never fails halfway for
 * quota.
 */
export async function recordArchiveId(
  ctx: MutationCtx,
  entry: ArchiveIdEntry,
): Promise<Id<"coldArchiveIdMap">> {
  const run = await ctx.db.get("coldArchiveRuns", entry.runId);
  if (!run || run.organizationId !== entry.organizationId)
    throw new Error("ARCHIVE_MAP_RUN_MISMATCH");
  if (run.state !== "restoring") throw new Error("ARCHIVE_MAP_NOT_RESTORING");
  if (
    !mappableTable(entry.table) ||
    !/^[A-Za-z0-9_-]+$/.test(entry.previousId) ||
    entry.previousId === entry.newId ||
    !Number.isFinite(entry.previousCreationTime)
  )
    throw new Error("ARCHIVE_MAP_INVALID");
  const prior = await ctx.db
    .query("coldArchiveIdMap")
    .withIndex("by_runId_and_previousId", (q) =>
      q.eq("runId", entry.runId).eq("previousId", entry.previousId),
    )
    .unique();
  if (prior) {
    if (
      prior.table !== entry.table ||
      prior.newId !== entry.newId ||
      prior.previousCreationTime !== entry.previousCreationTime
    )
      throw new Error("ARCHIVE_MAP_CONFLICT");
    return prior._id;
  }
  if (
    await ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_newId", (q) => q.eq("newId", entry.newId))
      .first()
  )
    throw new Error("ARCHIVE_MAP_CONFLICT");
  if (!(await currentExists(ctx, entry.table, entry.newId))) throw new Error("ARCHIVE_MAP_MISSING");
  const id = await ctx.db.insert("coldArchiveIdMap", entry);
  const row = (await ctx.db.get("coldArchiveIdMap", id))!;
  await trackDatabaseRecord(ctx, entry.organizationId, "coldArchiveIdMap", id, row, false, true);
  return id;
}

async function currentExists(ctx: QueryCtx, table: string, id: string) {
  if (table === "_storage") {
    const storageId = ctx.db.system.normalizeId("_storage", id);
    return !!storageId && !!(await ctx.db.system.get("_storage", storageId));
  }
  const rowId = ctx.db.normalizeId(table as TableNames, id);
  return !!rowId && !!(await ctx.db.get(rowId));
}

/**
 * One hop of the map for an ID the caller's organization once had (ADR 0009, §6). An ID of
 * another organization never resolves. The routes resolve the whole chain across cycles with
 * `currentRow` (`lib/coldArchiveCurrent.ts`).
 */
export async function archivedIdEntry(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  previousId: string,
): Promise<Doc<"coldArchiveIdMap"> | null> {
  return ctx.db
    .query("coldArchiveIdMap")
    .withIndex("by_organizationId_and_previousId", (q) =>
      q.eq("organizationId", organizationId).eq("previousId", previousId),
    )
    .first();
}
