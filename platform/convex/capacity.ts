import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { archiveStatus, archiveStorageIds, assertOrganizationHot } from "./lib/coldArchiveCore";
import { resumeOrganizationCaptures } from "./lib/captureAttention";
import {
  capacityAccount,
  ensureCapacityReady,
  trackDatabaseRecord,
  trackStoredFile,
  reserveCapacity,
  capacityEvent,
  releaseCapacity,
} from "./lib/capacityCore";

const tables = [
  "importFiles",
  "documentArtifacts",
  "captureBatches",
  "issuanceArtifacts",
  "exportParts",
  "fiscalDocuments",
  "documentVersions",
  "documentItems",
  "documentListings",
  "documentFiscalEvidence",
  "operations",
  // The ID map of a rehydrated organization counts as database stock (ADR 0009, §6).
  "coldArchiveIdMap",
] as const;
type InventoryRow = Doc<(typeof tables)[number]>;
async function owner(ctx: MutationCtx, row: InventoryRow): Promise<Id<"organizations"> | null> {
  if ("organizationId" in row) return row.organizationId;
  if ("importId" in row) return (await ctx.db.get("imports", row.importId))?.organizationId ?? null;
  if ("exportId" in row)
    return (await ctx.db.get("documentExports", row.exportId))?.organizationId ?? null;
  if ("streamId" in row)
    return (await ctx.db.get("captureStreams", row.streamId))?.organizationId ?? null;
  if ("artifactId" in row)
    return (await ctx.db.get("documentArtifacts", row.artifactId))?.organizationId ?? null;
  if ("versionId" in row) {
    const version = await ctx.db.get("documentVersions", row.versionId);
    return version ? owner(ctx, version) : null;
  }
  if ("documentId" in row && row.documentId)
    return (await ctx.db.get("fiscalDocuments", row.documentId))?.organizationId ?? null;
  return null;
}

/** Operator-driven bounded inventory. Cursor is server-owned, so retrying never skips a page.
 * New admissions fail closed until the final page. Existing originals may still finish and
 * track themselves; storage ids and record ids deduplicate their concurrent inventory reads.
 */
export const inventory = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ ready: v.boolean(), phase: v.number() }),
  handler: async (ctx, { organizationId }) => {
    const restoringInventory = (await archiveStatus(ctx, organizationId))?.state === "restoring";
    if (!restoringInventory) await assertOrganizationHot(ctx, organizationId);
    await ensureCapacityReady(ctx, organizationId);
    const account = (await capacityAccount(ctx, organizationId))!;
    if (account.ready) return { ready: true, phase: account.phase };
    if (account.phase >= tables.length) return reconcile(ctx, account);
    const table = tables[account.phase];
    if (!table) throw new Error("Invalid capacity inventory phase");
    const page = await ctx.db
      .query(table)
      .paginate({ cursor: account.cursor, numItems: 25, maximumBytesRead: 1024 * 1024 });
    for (const row of page.page) {
      if ((await owner(ctx, row)) !== organizationId) continue;
      // Temporary export files never enter a package; every other file field is archived.
      const storageIds =
        table === "exportParts" && "storageId" in row
          ? [row.storageId]
          : archiveStorageIds(table, row);
      for (const storageId of storageIds)
        await trackStoredFile(ctx, organizationId, storageId as Id<"_storage">, undefined, {
          temporary: table === "exportParts",
          restoringInventory,
        });
      if (
        table === "importFiles" &&
        "importId" in row &&
        row.state === "reserved" &&
        !row.storageId &&
        row.expiresAt > Date.now() &&
        !(await capacityEvent(ctx, organizationId, "filesBytes", `import:${row._id}`))
      ) {
        await reserveCapacity(
          ctx,
          organizationId,
          "filesBytes",
          `import:${row._id}`,
          row.size,
          true,
        );
      }
      if (
        table === "operations" &&
        "usageCaptureKey" in row &&
        row.usageCaptureKey &&
        (row.uncertain || (row.state === "running" && row.stage === "calling")) &&
        !(await capacityEvent(ctx, organizationId, "filesBytes", `capture:${row.usageCaptureKey}`))
      ) {
        await reserveCapacity(
          ctx,
          organizationId,
          "filesBytes",
          `capture:${row.usageCaptureKey}`,
          18 * 1024 * 1024,
          true,
        );
      }
      // Payloads materialized as fiscal records, not operational logs or monetary estimates.
      if (table === "documentArtifacts" || (account.phase >= 5 && table !== "operations"))
        await trackDatabaseRecord(
          ctx,
          organizationId,
          table,
          row._id,
          row,
          false,
          restoringInventory,
        );
    }
    const phase = account.phase + (page.isDone ? 1 : 0);
    await ctx.db.patch("capacityAccounts", account._id, {
      phase,
      cursor: page.isDone ? null : page.continueCursor,
      updatedAt: Date.now(),
    });
    return { ready: false, phase };
  },
});

/** Restoration may retain totals while omitting expired blobs. The ledger is reconciled first,
 * then recounted. A stock write during the recount restarts it; a partial sum is never ready.
 */
async function reconcile(
  ctx: MutationCtx,
  account: Doc<"capacityAccounts">,
): Promise<{ ready: boolean; phase: number }> {
  const { organizationId } = account;
  const phase = account.phase - tables.length;
  const pagination = { cursor: account.cursor, numItems: 50, maximumBytesRead: 1024 * 1024 };
  let done: boolean;
  let cursor: string;
  let countedTemporary = account.countedTemporary ?? 0;
  let reservedTemporary = account.reservedTemporary ?? 0;
  let countedFiles = account.countedFiles ?? 0,
    countedDatabase = account.countedDatabase ?? 0;
  let reservedFiles = account.reservedFiles ?? 0,
    reservedDatabase = account.reservedDatabase ?? 0;
  if (phase === 0 || phase === 2) {
    const page = await ctx.db
      .query("capacityFiles")
      .withIndex("by_organizationId_and_storageId", (q) => q.eq("organizationId", organizationId))
      .paginate(pagination);
    for (const row of page.page) {
      if (phase === 0) {
        if (!(await ctx.db.system.get("_storage", row.storageId)))
          await ctx.db.delete("capacityFiles", row._id);
      } else if (row.kind === "temporary") countedTemporary += row.size;
      else countedFiles += row.size;
    }
    done = page.isDone;
    cursor = page.continueCursor;
  } else if (phase === 1 || phase === 3) {
    const page = await ctx.db
      .query("capacityRecords")
      .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
      .paginate(pagination);
    for (const row of page.page) {
      if (phase === 1) {
        const split = row.key.indexOf(":");
        const table = row.key.slice(0, split);
        if (!(table in schema.tables)) throw new Error("Unknown capacity record table");
        const name = table as TableNames;
        const id = ctx.db.normalizeId(name, row.key.slice(split + 1));
        if (!id || !(await ctx.db.get(name, id))) await ctx.db.delete("capacityRecords", row._id);
      } else countedDatabase += row.size;
    }
    done = page.isDone;
    cursor = page.continueCursor;
  } else {
    const page = await ctx.db
      .query("capacityEvents")
      .withIndex("by_organizationId_and_metric_and_key", (q) =>
        q.eq("organizationId", organizationId),
      )
      .paginate(pagination);
    for (const row of page.page) {
      if (row.state !== "reserved") continue;
      // Restores omit temporary exports. Their missing jobs prove these reservations cannot
      // produce another part. Capture uncertainty never expires by this cleanup.
      if (row.key.startsWith("export:")) {
        const id = ctx.db.normalizeId("documentExports", row.key.split(":")[1]!);
        const job = id ? await ctx.db.get("documentExports", id) : null;
        if (!job || job.state !== "running" || job.expiresAt <= Date.now()) {
          await releaseCapacity(ctx, organizationId, row.metric, row.key);
          continue;
        }
      }
      if (row.metric === "filesBytes" && row.key.startsWith("import:")) {
        const id = ctx.db.normalizeId("importFiles", row.key.slice(7));
        const file = id ? await ctx.db.get("importFiles", id) : null;
        if (!file || file.state !== "reserved" || file.expiresAt <= Date.now()) {
          await releaseCapacity(ctx, organizationId, row.metric, row.key);
          continue;
        }
      }
      if (row.metric === "temporaryBytes") reservedTemporary += row.remaining;
      if (row.metric === "filesBytes") reservedFiles += row.remaining;
      if (row.metric === "databaseBytes") reservedDatabase += row.remaining;
    }
    done = page.isDone;
    cursor = page.continueCursor;
  }
  const fresh = (await capacityAccount(ctx, organizationId))!;
  if (phase === 4 && done && account.recountRevision !== (fresh.revision ?? 0)) {
    const restart = tables.length + 2;
    await ctx.db.patch("capacityAccounts", account._id, {
      phase: restart,
      cursor: null,
      recountRevision: fresh.revision ?? 0,
      countedTemporary: 0,
      reservedTemporary: 0,
      countedFiles: 0,
      countedDatabase: 0,
      reservedFiles: 0,
      reservedDatabase: 0,
    });
    return { ready: false, phase: restart };
  }
  const ready = phase === 4 && done;
  if (ready) {
    for (const [metric, committed, reserved] of [
      ["temporaryBytes", countedTemporary, reservedTemporary],
      ["filesBytes", countedFiles, reservedFiles],
      ["databaseBytes", countedDatabase, reservedDatabase],
    ] as const) {
      const total = await ctx.db
        .query("capacityTotals")
        .withIndex("by_organizationId_and_period_and_metric", (q) =>
          q.eq("organizationId", organizationId).eq("period", "stock").eq("metric", metric),
        )
        .unique();
      const values = { committed, reserved, updatedAt: Date.now() };
      if (total) await ctx.db.patch("capacityTotals", total._id, values);
      else
        await ctx.db.insert("capacityTotals", {
          organizationId,
          period: "stock",
          metric,
          ...values,
        });
    }
  }
  const nextPhase = account.phase + (done ? 1 : 0);
  await ctx.db.patch("capacityAccounts", account._id, {
    ready,
    phase: nextPhase,
    cursor: done ? null : cursor,
    countedTemporary,
    reservedTemporary,
    countedFiles,
    countedDatabase,
    reservedFiles,
    reservedDatabase,
    ...(phase === 1 && done
      ? {
          recountRevision: fresh.revision ?? 0,
          countedTemporary: 0,
          reservedTemporary: 0,
          countedFiles: 0,
          countedDatabase: 0,
          reservedFiles: 0,
          reservedDatabase: 0,
        }
      : {}),
  });
  if (ready && (await archiveStatus(ctx, organizationId))?.state !== "restoring")
    await resumeOrganizationCaptures(ctx, organizationId, ["CAPACITY_INVENTORY_REQUIRED"]);
  return { ready, phase: nextPhase };
}
