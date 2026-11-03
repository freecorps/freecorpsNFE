import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery, type QueryCtx } from "./_generated/server";
import { storageHolders } from "./lib/storageHolders";

const inventoryItem = v.object({
  metadata: v.object({
    _id: v.id("_storage"),
    _creationTime: v.number(),
    sha256: v.string(),
    size: v.number(),
    contentType: v.optional(v.string()),
  }),
  url: v.union(v.string(), v.null()),
  exportPart: v.boolean(),
});

/** Admin-only inventory. No public function or URL is exposed to console/API callers. */
export const page = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(inventoryItem),
  handler: async (ctx, args) => {
    const result = await ctx.db.system.query("_storage").paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (metadata) => ({
          metadata,
          url: await ctx.storage.getUrl(metadata._id),
          // This is only a hint for preflight. Snapshot references decide what may be omitted.
          exportPart: !!(await ctx.db
            .query("exportParts")
            .withIndex("by_storageId", (q) => q.eq("storageId", metadata._id))
            .first()),
        })),
      ),
    };
  },
});

/** Resolve files committed after the first inventory, using the IDs in the DB snapshot. */
export const resolve = internalQuery({
  args: { ids: v.array(v.id("_storage")) },
  returns: v.array(v.union(inventoryItem, v.null())),
  handler: async (ctx, { ids }) => {
    if (ids.length > 128) throw new Error("Backup: lote acima de 128 arquivos");
    return Promise.all(
      ids.map(async (id) => {
        const metadata = await ctx.db.system.get("_storage", id);
        return metadata ? { metadata, url: await ctx.storage.getUrl(id), exportPart: false } : null;
      }),
    );
  },
});

const auditTotals = {
  blobs: v.number(),
  bytes: v.number(),
  held: v.number(),
  /** Held only by `capacityFiles`: counted in the quota, read by no flow. */
  accountingOnly: v.number(),
  accountingOnlyBytes: v.number(),
  orphans: v.number(),
  orphanBytes: v.number(),
};
type AuditTotals = { [K in keyof typeof auditTotals]: number };
const emptyTotals = (): AuditTotals => ({
  blobs: 0,
  bytes: 0,
  held: 0,
  accountingOnly: 0,
  accountingOnlyBytes: 0,
  orphans: 0,
  orphanBytes: 0,
});

/** Tables holding the file, by the inventory the cold archive and the fiscal guard also use. */
async function holdersOf(ctx: QueryCtx, storageId: Id<"_storage">) {
  const tables: string[] = [];
  for (const { table, query } of storageHolders(ctx, storageId))
    if (await query.first()) tables.push(table);
  // A rehydration upload intent holds its file until recorded, as `held` does in the
  // rehydration's own orphan collection.
  if (
    await ctx.db
      .query("coldArchiveUploads")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first()
  )
    tables.push("coldArchiveUploads");
  return tables;
}

/** A page of the audit holds 1 to 128 files; anything else is refused before reading. */
function auditPageSize(size: number) {
  if (!Number.isInteger(size) || size < 1 || size > 128)
    throw new Error("STORAGE_AUDIT_PAGE_LIMIT");
  return size;
}

/**
 * Read-only audit of one page of `_storage` for the baseline of phase B (ADR 0010): totals only,
 * with no ID, organization or name. Each file costs one indexed read per table of
 * `storageHolders` plus one for the upload intents (twelve today), so `numItems`
 * stays at or below 128; `storageAudit` walks every page.
 */
export const storageAuditPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    ...auditTotals,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    auditPageSize(args.paginationOpts.numItems);
    // An end cursor would make the page run to it, past `numItems`.
    if (args.paginationOpts.endCursor != null) throw new Error("STORAGE_AUDIT_PAGE_LIMIT");
    const result = await ctx.db.system.query("_storage").paginate(args.paginationOpts);
    const sum = emptyTotals();
    for (const file of result.page) {
      const holders = await holdersOf(ctx, file._id);
      sum.blobs++;
      sum.bytes += file.size;
      if (!holders.length) {
        sum.orphans++;
        sum.orphanBytes += file.size;
        continue;
      }
      sum.held++;
      if (holders.every((table) => table === "capacityFiles")) {
        sum.accountingOnly++;
        sum.accountingOnlyBytes += file.size;
      }
    }
    return { ...sum, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

/**
 * Every page of `storageAuditPage`, summed. Each page is its own transaction: a file stored or
 * deleted during the walk may be counted or missed, so on a live deployment the totals are an
 * estimate; `orphans` includes uploads not yet recorded by their flow.
 */
export const storageAudit = internalAction({
  args: { pageSize: v.optional(v.number()) },
  returns: v.object({ ...auditTotals, pages: v.number() }),
  handler: async (ctx, args) => {
    const numItems = auditPageSize(args.pageSize ?? 128);
    const sum = { ...emptyTotals(), pages: 0 };
    let cursor: string | null = null;
    for (;;) {
      const page: AuditTotals & { isDone: boolean; continueCursor: string } = await ctx.runQuery(
        internal.backupInventory.storageAuditPage,
        { paginationOpts: { numItems, cursor } },
      );
      for (const key of Object.keys(auditTotals) as Array<keyof AuditTotals>) sum[key] += page[key];
      sum.pages++;
      if (page.isDone) return sum;
      cursor = page.continueCursor;
    }
  },
});
