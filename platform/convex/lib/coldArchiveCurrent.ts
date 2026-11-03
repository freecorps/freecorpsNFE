import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Most hops a chain of the ID map follows, one per archiving cycle (ADR 0009, §6). A chain this
 * long never happens; the bound only keeps a corrupt map from looping.
 */
export const MAX_ARCHIVE_HOPS = 32;

/**
 * The current row of `table` named by `value`, an ID the caller sent (ADR 0009, §6). The row
 * itself first; not finding it, the ID map of `organizationId`, the organization of the key or
 * the person, following the chain old → new1 → new2 until the current ID, without stopping at an
 * intermediate one. An old ID of another organization never resolves, and the caller still checks
 * access, scope and grant on the row returned, so NOT_FOUND keeps meaning "not this
 * organization's" in both places.
 *
 * Only the lookup translates: an idempotency hash is always computed over the ID exactly as the
 * caller sent it, never over the resolved one.
 */
export async function currentRow<T extends TableNames>(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
  table: T,
  value: string,
): Promise<Doc<T> | null> {
  const id = ctx.db.normalizeId(table, value);
  const row = id ? await ctx.db.get(table, id) : null;
  if (row) return row as Doc<T>;
  let previous = value;
  for (let hop = 0; hop < MAX_ARCHIVE_HOPS; hop++) {
    const entry = await ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_organizationId_and_previousId", (q) =>
        q.eq("organizationId", organizationId).eq("previousId", previous),
      )
      .first();
    if (!entry || entry.table !== table) return null;
    const next = ctx.db.normalizeId(table, entry.newId);
    const current = next ? await ctx.db.get(table, next) : null;
    if (current) return current as Doc<T>;
    previous = entry.newId;
  }
  return null;
}
