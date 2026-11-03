import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { releaseDatabaseRecord, releaseStoredFile } from "./capacityCore";

export type Budget = { left: number };
type Step = () => Promise<boolean>;

/**
 * Deletes trees of rows inside one transaction budget. Every step returns false as soon as the
 * budget ends; the caller schedules another batch, which finds only what is still left.
 */
export function purger(ctx: MutationCtx, b: Budget) {
  const del =
    <T extends TableNames>(table: T) =>
    async (row: Doc<T>) => {
      const tracked = await ctx.db
        .query("capacityRecords")
        .withIndex("by_key", (q) => q.eq("key", `${table}:${row._id}`))
        .unique();
      if (tracked) await releaseDatabaseRecord(ctx, tracked.organizationId, table, row._id);
      await ctx.db.delete(table, row._id);
      b.left--;
      return b.left > 0;
    };
  /** Removes rows loaded by `load` until it returns none or the budget ends. */
  const drain = async <T extends TableNames>(
    load: (n: number) => Promise<Doc<T>[]>,
    remove: (row: Doc<T>) => Promise<boolean>,
  ) => {
    while (b.left > 0) {
      const rows = await load(Math.min(b.left, 50));
      if (!rows.length) return true;
      for (const row of rows) if (!(await remove(row))) return false;
    }
    return false;
  };
  const all = async (...steps: Step[]) => {
    for (const step of steps) if (!(await step())) return false;
    return true;
  };
  /** Removes the children first; the row goes only once all of them are gone. */
  const parent =
    <T extends TableNames>(table: T, steps: (row: Doc<T>) => Step[]) =>
    async (row: Doc<T>) =>
      (await all(...steps(row))) && del(table)(row);
  /** Files may be shared by rows of the same tree; the first removal deletes them. */
  const blob = async (id: Id<"_storage"> | undefined) => {
    if (id && (await ctx.db.system.get("_storage", id))) await ctx.storage.delete(id);
    if (id) {
      const tracked = await ctx.db
        .query("capacityFiles")
        .withIndex("by_storageId", (q) => q.eq("storageId", id))
        .unique();
      if (tracked) await releaseStoredFile(ctx, tracked.organizationId, id);
    }
  };
  return { del, drain, all, parent, blob };
}
