import { ConvexError, getDocumentSize, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  ARCHIVE_DATABASE_LIMIT,
  ARCHIVE_DAY,
  ARCHIVE_FILE_LIMIT,
  ARCHIVE_ROW_LIMIT,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_TABLES,
  archiveGate,
  archiveHash,
  archiveOwner,
  archiveRowJson,
  archiveStatus,
  archiveStorageIds,
  isArchiveFence,
  lastActivity,
} from "./lib/coldArchiveCore";
import { fiscalGuardUntil } from "./lib/retentionClasses";
import { internal } from "./_generated/api";
import { requirePlatformEnvironment } from "./environment";
import { sandboxOnly } from "./fiscalGuard";
import { releaseDatabaseRecord, releaseStoredFile } from "./lib/capacityCore";
import { storageHolders } from "./lib/storageHolders";
import { activeTerm } from "./lib/planTerms";
import { scheduledPixRenewal } from "./lib/billingCore";
import { hasMovingNotes } from "./coldTier";

const runArgs = { runId: v.id("coldArchiveRuns"), version: v.number() };
async function fenced(
  ctx: MutationCtx,
  id: Id<"coldArchiveRuns">,
  version: number,
  checkHold = true,
) {
  archiveGate();
  const run = await ctx.db.get("coldArchiveRuns", id);
  if (!run || run.version !== version) throw new Error("ARCHIVE_STALE_FENCE");
  const holds = await ctx.db
    .query("retentionHolds")
    .withIndex("by_organizationId_and_reference", (q) => q.eq("organizationId", run.organizationId))
    .take(101);
  if (checkHold && (holds.length > 100 || holds.some((h) => h.releasedAt === undefined)))
    throw new Error("ARCHIVE_LEGAL_HOLD");
  return run;
}
async function eligible(ctx: MutationCtx, orgId: Id<"organizations">) {
  const now = Date.now();
  // ADR 0010, decision 6: the package references a cold note's objects by hash (the executor,
  // `scripts/lib/cold-archive.mjs`), so a cold note is archived like any other. A note still
  // moving is not: the passage and a run never meet. The cold tier skips one with a run.
  if (await hasMovingNotes(ctx, orgId)) throw new Error("ARCHIVE_COLD_TIER_MOVING");
  // A paid annual term, in force or scheduled, keeps the organization hot (ADR 0010, decision 9).
  if (await activeTerm(ctx, orgId, now)) throw new Error("ARCHIVE_PAID_ACTIVE");
  // So does a monthly Pix renewal already paid, scheduled or waiting for the team (ADR 0012).
  if (await scheduledPixRenewal(ctx, orgId, now)) throw new Error("ARCHIVE_PAID_ACTIVE");
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", orgId))
    .unique();
  if (closure) {
    const retainUntil = fiscalGuardUntil(closure.requestedAt);
    if (closure.state !== "purged" || closure.expiredAt !== undefined || retainUntil <= now)
      throw new Error("ARCHIVE_CLOSURE_NOT_ELIGIBLE");
    return { reason: "closed" as const, eligibleAt: now, retainUntil };
  }
  const org = await ctx.db.get("organizations", orgId);
  const plan = await ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", orgId))
    .unique();
  if (!org || !plan) throw new Error("ARCHIVE_NOT_ELIGIBLE");
  if (plan.catalogTier !== "free") {
    // Decision of 29/10/2026: one hot month after the paid period, the notice's, which the
    // custody contribution finances. The notice starts as soon as the period ends.
    if (plan.endsAt === null || plan.endsAt > now) throw new Error("ARCHIVE_PAID_ACTIVE");
    await assertNotSandboxOnly(ctx, orgId);
    return {
      reason: "paid_expired" as const,
      planVersion: plan.version,
      eligibleAt: now + 30 * ARCHIVE_DAY,
      retainUntil: fiscalGuardUntil(now),
    };
  }
  if ((await lastActivity(ctx, org, plan)) + 90 * ARCHIVE_DAY > now)
    throw new Error("ARCHIVE_FREE_ACTIVE");
  await assertNotSandboxOnly(ctx, orgId);
  return {
    reason: "free_inactive" as const,
    planVersion: plan.version,
    eligibleAt: now + 30 * ARCHIVE_DAY,
    retainUntil: fiscalGuardUntil(now),
  };
}
/**
 * Decision of 29/10/2026: an open organization that only ever had Sandbox gets no run, so the
 * early purge of its closure (`fiscalGuard:early`) still reaches it. Same criterion as the closure.
 * Freecorps closes it instead, after its own notice (`sandboxClosure.ts`).
 */
async function assertNotSandboxOnly(ctx: MutationCtx, orgId: Id<"organizations">) {
  if (await sandboxOnly(ctx, orgId)) throw new Error("ARCHIVE_SANDBOX_ONLY");
}
/** Only a deployment administrator can invoke these internal functions. No console/REST proof API. */
export const notice = internalMutation({
  args: { organizationId: v.id("organizations"), key: v.string() },
  returns: v.id("coldArchiveRuns"),
  handler: async (ctx, args) => {
    archiveGate();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.key)) throw new Error("ARCHIVE_INVALID_KEY");
    const eligibility = await eligible(ctx, args.organizationId);
    const existing = await archiveStatus(ctx, args.organizationId);
    if (existing) {
      if (existing.key === args.key) return existing._id;
      if (existing.state !== "hot") throw new Error("ARCHIVE_ALREADY_EXISTS");
    }
    // An open organization is told once, by e-mail to its owners and admins, written here before
    // the send so a repeated notice never sends again. Without the channel, the console notice
    // stands alone.
    let noticeMail;
    if (eligibility.reason !== "closed") {
      const { local, accounts } = requirePlatformEnvironment();
      const state = local || accounts.enabled ? ("pending" as const) : ("skipped" as const);
      noticeMail = { state, recipients: 0, confirmed: 0, withheld: 0 };
    }
    const runId = await ctx.db.insert("coldArchiveRuns", {
      ...args,
      ...eligibility,
      state: "notice",
      version: 1,
      noticeAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
      ...(noticeMail ? { noticeMail } : {}),
    });
    if (noticeMail?.state === "pending")
      await ctx.scheduler.runAfter(0, internal.archiveNotice.deliver, { runId });
    return runId;
  },
});
export const freeze = internalMutation({
  args: runArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    // An open organization comes back by the rehydration under new IDs (ADR 0009, §5,
    // `coldArchiveRehydration.ts`); the whole flow stays behind `FNFE_COLD_ARCHIVE`.
    if (run.state === "frozen") return null;
    if (run.state !== "notice" || Date.now() < run.eligibleAt)
      throw new Error("ARCHIVE_NOTICE_PENDING");
    const current = await eligible(ctx, run.organizationId);
    if (current.reason !== run.reason || current.planVersion !== run.planVersion)
      throw new Error("ARCHIVE_ELIGIBILITY_CHANGED");
    // Never freeze a worker already talking to the tax authority. These range reads and the
    // archive write commit atomically; a racing admission must read this same archive range.
    // A bounded scan which cannot prove quiescence refuses BEFORE changing the state.
    await assertQuiescent(ctx, run.organizationId);
    await ctx.db.patch("coldArchiveRuns", run._id, { state: "frozen", updatedAt: Date.now() });
    return null;
  },
});
export const inspect = internalQuery({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.string(),
  handler: async (ctx, { runId }) => JSON.stringify(await ctx.db.get("coldArchiveRuns", runId)),
});

/** Drain checks use bounded pages, before the fiscal snapshot. Any uncertain response blocks. */
const QUEUES = [
  "operations",
  "webhookDeliveries",
  "documentExports",
  "importFiles",
  "captureStreams",
  "usageLeases",
] as const;
const SCAN_TABLES = [...QUEUES, ...ARCHIVE_TABLES];
async function assertQuiescent(ctx: MutationCtx, orgId: Id<"organizations">) {
  for (const state of ["queued", "running", "retry_wait", "reconciling", "paused"] as const)
    if (
      await ctx.db
        .query("operations")
        .withIndex("by_organizationId_and_state", (q) =>
          q.eq("organizationId", orgId).eq("state", state),
        )
        .first()
    )
      throw new Error("ARCHIVE_IN_FLIGHT");
  if (
    await ctx.db
      .query("operations")
      .withIndex("by_organizationId_and_uncertain", (q) =>
        q.eq("organizationId", orgId).eq("uncertain", true),
      )
      .first()
  )
    throw new Error("ARCHIVE_IN_FLIGHT");
  if (
    await ctx.db
      .query("usageLeases")
      .withIndex("by_organizationId_and_expiresAt", (q) =>
        q.eq("organizationId", orgId).gt("expiresAt", Date.now()),
      )
      .first()
  )
    throw new Error("ARCHIVE_IN_FLIGHT");
  if (
    await ctx.db
      .query("documentExports")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", orgId).eq("state", "running"),
      )
      .first()
  )
    throw new Error("ARCHIVE_IN_FLIGHT");
  const streams = await ctx.db
    .query("captureStreams")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", orgId))
    .take(1001);
  if (streams.length > 1000) throw new Error("ARCHIVE_QUIESCENCE_SCAN_LIMIT");
  if (streams.some((row) => busy("captureStreams", row))) throw new Error("ARCHIVE_IN_FLIGHT");
  for (const state of ["reserved", "uploaded"] as const) {
    const rows = await ctx.db
      .query("importFiles")
      .withIndex("by_state", (q) => q.eq("state", state))
      .take(1001);
    if (rows.length > 1000) throw new Error("ARCHIVE_QUIESCENCE_SCAN_LIMIT");
    for (const row of rows)
      if ((await archiveOwner(ctx, row)) === orgId) throw new Error("ARCHIVE_IN_FLIGHT");
  }
  for (const state of ["queued", "running", "retry_wait", "paused"] as const) {
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_state_and_nextAttemptAt", (q) => q.eq("state", state))
      .take(1001);
    if (rows.length > 1000) throw new Error("ARCHIVE_QUIESCENCE_SCAN_LIMIT");
    for (const row of rows)
      if ((await archiveOwner(ctx, row)) === orgId) throw new Error("ARCHIVE_IN_FLIGHT");
  }
}
function busy(table: string, row: Record<string, unknown>) {
  if (table === "operations")
    return row.uncertain === true || !["succeeded", "failed"].includes(String(row.state));
  if (table === "webhookDeliveries")
    return !["succeeded", "failed", "cancelled", "delivered", "dead"].includes(String(row.state));
  if (table === "documentExports") return ["queued", "running"].includes(String(row.state));
  if (table === "importFiles") return ["reserved", "uploaded"].includes(String(row.state));
  if (table === "captureStreams")
    return !!row.operationId || ["running", "queued", "reconciling"].includes(String(row.state));
  return table === "usageLeases" && Number(row.expiresAt) > Date.now();
}
export const scan = internalMutation({
  args: { ...runArgs, phase: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    if (run.state !== "frozen" || run.phase !== args.phase || run.cursor !== args.cursor)
      throw new Error("ARCHIVE_SCAN_FENCE");
    const table = SCAN_TABLES[run.phase];
    if (!table) return JSON.stringify({ phase: run.phase, cursor: run.cursor, done: true });
    const page = await ctx.db
      .query(table)
      .paginate({ cursor: run.cursor, numItems: 16, maximumBytesRead: 128 * 1024 });
    const rows = [];
    const files = [];
    let digest = run.digest,
      bytes = run.bytes,
      count = run.rows,
      fileCount = run.files;
    for (const row of page.page) {
      if ((await archiveOwner(ctx, row)) !== run.organizationId) continue;
      if (run.phase < QUEUES.length) {
        if (busy(table, row)) throw new Error("ARCHIVE_IN_FLIGHT");
        continue;
      }
      const json = archiveRowJson(row),
        hash = await archiveHash(json),
        size = new TextEncoder().encode(json).length;
      bytes += size;
      count++;
      if (bytes > ARCHIVE_DATABASE_LIMIT || count > ARCHIVE_ROW_LIMIT)
        throw new Error("ARCHIVE_DATABASE_LIMIT");
      await ctx.db.insert("coldArchiveEntries", {
        runId: run._id,
        organizationId: run.organizationId,
        kind: "row",
        table,
        originalId: row._id,
        sha256: hash,
        bytes: size,
        // The fence stays hot and may change after this scan; the package carries this snapshot.
        ...(isArchiveFence(table) ? { snapshot: json } : {}),
        removed: false,
      });
      digest = await archiveHash(`${digest}\n${table}\n${row._id}\n${hash}`);
      rows.push({ table, json });
      for (const storageId of archiveStorageIds(table, row)) {
        const previous = await ctx.db
          .query("coldArchiveEntries")
          .withIndex("by_runId_and_originalId", (q) =>
            q.eq("runId", run._id).eq("originalId", storageId),
          )
          .unique();
        if (previous) continue;
        const id = ctx.db.system.normalizeId("_storage", storageId);
        const metadata = id && (await ctx.db.system.get("_storage", id));
        if (!metadata) throw new Error("ARCHIVE_MISSING_ORIGINAL");
        const encoded = archiveRowJson(metadata);
        await ctx.db.insert("coldArchiveEntries", {
          runId: run._id,
          organizationId: run.organizationId,
          kind: "file",
          table: "_storage",
          originalId: storageId,
          metadata: encoded,
          sha256: await archiveHash(encoded),
          bytes: metadata.size,
          removed: false,
        });
        files.push({ metadata: JSON.parse(encoded), url: await ctx.storage.getUrl(metadata._id) });
        fileCount++;
      }
    }
    const phase = run.phase + (page.isDone ? 1 : 0),
      cursor = page.isDone ? null : page.continueCursor;
    await ctx.db.patch("coldArchiveRuns", run._id, {
      phase,
      cursor,
      rows: count,
      files: fileCount,
      bytes,
      digest,
      updatedAt: Date.now(),
    });
    return JSON.stringify({
      rows,
      files,
      phase,
      cursor,
      done: phase === SCAN_TABLES.length,
      digest,
      count,
    });
  },
});
/**
 * Whether the hot entries of a run may be partial: its catalogue was compacted, or is being, to
 * R2 (ADR 0009, §4). Whoever needs them then reads the decrypted catalogue object, never the DB.
 */
function compacted(run: Doc<"coldArchiveRuns">) {
  return run.catalog !== undefined && run.catalog.state !== "verified";
}
export const entries = internalQuery({
  args: { runId: v.id("coldArchiveRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run) throw new Error("ARCHIVE_NOT_FOUND");
    if (compacted(run)) throw new Error("ARCHIVE_CATALOG_COMPACTED");
    return JSON.stringify(
      await ctx.db
        .query("coldArchiveEntries")
        .withIndex("by_runId", (q) => q.eq("runId", args.runId))
        .paginate({ cursor: args.cursor, numItems: 64, maximumBytesRead: 128 * 1024 }),
    );
  },
});
export const seal = internalMutation({
  args: { ...runArgs, manifest: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    if (run.manifest) {
      if (run.manifest === args.manifest) return null;
      throw new Error("ARCHIVE_MANIFEST_IMMUTABLE");
    }
    if (run.state !== "frozen" || run.phase !== SCAN_TABLES.length || args.manifest.length > 16000)
      throw new Error("ARCHIVE_SCAN_INCOMPLETE");
    const manifest = JSON.parse(args.manifest) as Record<string, unknown>;
    if (
      manifest.runId !== run._id ||
      manifest.organizationId !== run.organizationId ||
      manifest.version !== run.version ||
      manifest.digest !== run.digest ||
      manifest.rows !== run.rows ||
      manifest.files !== run.files ||
      manifest.databaseBytes !== run.bytes ||
      typeof manifest.fileBytes !== "number" ||
      manifest.fileBytes > ARCHIVE_FILE_LIMIT ||
      manifest.retainUntil !== run.retainUntil ||
      // A new package is always made with the current fiscal schema; a manifest published before
      // the version was recorded, and sealed only now after a lost response, is version 1.
      (manifest.schemaVersion ?? 1) !== ARCHIVE_SCHEMA_VERSION
    )
      throw new Error("ARCHIVE_MANIFEST_MISMATCH");
    await ctx.db.patch("coldArchiveRuns", run._id, {
      state: "sealed",
      manifest: args.manifest,
      manifestSha256: await archiveHash(args.manifest),
      updatedAt: Date.now(),
    });
    return null;
  },
});
/** Called exclusively by the administrative executor AFTER reimport + reexport comparison. */
export const verified = internalMutation({
  args: { ...runArgs, manifestSha256: v.string(), verifierRunId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    if (
      args.manifestSha256 !== run.manifestSha256 ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(args.verifierRunId)
    )
      throw new Error("ARCHIVE_PROOF_MISMATCH");
    if (!["sealed", "verified", "deleting"].includes(run.state))
      throw new Error("ARCHIVE_NOT_SEALED");
    await ctx.db.patch("coldArchiveRuns", run._id, {
      state: "verified",
      verifierRunId: args.verifierRunId,
      verifiedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// All root storage references, including nonfiscal data. A missing classification must fail a
// schema coverage test. Bounded full scans participate in OCC; overflow conserves the original.
async function exclusiveFile(ctx: MutationCtx, run: Doc<"coldArchiveRuns">, id: string) {
  const storageId = ctx.db.system.normalizeId("_storage", id);
  if (!storageId) throw new Error("ARCHIVE_STORAGE_ID");
  for (const { table, query } of storageHolders(ctx, storageId)) {
    const rows = await query.take(1001);
    if (rows.length > 1000) throw new Error("ARCHIVE_REFERENCE_SCAN_LIMIT");
    for (const row of rows) {
      if (
        table === "capacityFiles" &&
        (row as Record<string, unknown>).organizationId === run.organizationId
      )
        continue;
      const entry = await ctx.db
        .query("coldArchiveEntries")
        .withIndex("by_runId_and_originalId", (q) =>
          q.eq("runId", run._id).eq("originalId", row._id),
        )
        .unique();
      if (!entry) throw new Error("ARCHIVE_SHARED_FILE");
      if ((await archiveHash(archiveRowJson(row))) !== entry.sha256)
        throw new Error("ARCHIVE_ROW_CHANGED");
    }
  }
}
/**
 * Deletes only what the scan cataloged. A fiscal row created after the scan has no entry, so it
 * is never deleted: the actions kept in custody (ADR 0009, §2) can write such rows, like the
 * `captureAudit` of a withdrawn capture release or the `certificateAudit` of a revocation. They
 * stay hot with their IDs, pointing at rows that stay hot too (the fence stream, the
 * certificate), and the next cycle's scan, which reads every row of the organization, packs them.
 * Refusing `archived` for them would strand the run: a sealed package cannot take new rows.
 */
export const removeHotBatch = internalMutation({
  args: { ...runArgs, kind: v.union(v.literal("file"), v.literal("row")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    if (run.state === "archived") return true;
    // Real local drill: Convex append cannot recreate an ID deleted in the same table. A closed
    // organization is recovered in isolation only, so its closure is read again here: a run that
    // says closed without a purged closure keeps every row. An open organization comes back by
    // the rehydration under new IDs (ADR 0009, §5); from `frozen` on, nothing reopens it by
    // itself, so its eligibility is not read again.
    if (run.reason === "closed" && (await eligible(ctx, run.organizationId)).reason !== "closed")
      throw new Error("ARCHIVE_REACTIVATION_UNPROVEN");
    if (!["verified", "deleting"].includes(run.state) || !run.verifiedAt || !run.manifestSha256)
      throw new Error("ARCHIVE_PROOF_REQUIRED");
    // An administrator must re-run the proof after a long interruption, before deleting more.
    if (Date.now() - run.verifiedAt > ARCHIVE_DAY) throw new Error("ARCHIVE_PROOF_EXPIRED");
    const selected = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId_and_kind_and_removed", (q) =>
        q.eq("runId", run._id).eq("kind", args.kind).eq("removed", false),
      )
      .take(8);
    if (
      args.kind === "row" &&
      (await ctx.db
        .query("coldArchiveEntries")
        .withIndex("by_runId_and_kind_and_removed", (q) =>
          q.eq("runId", run._id).eq("kind", "file").eq("removed", false),
        )
        .first())
    )
      throw new Error("ARCHIVE_FILES_FIRST");
    for (const entry of selected) {
      if (entry.kind === "file") {
        const id = ctx.db.system.normalizeId("_storage", entry.originalId);
        const metadata = id && (await ctx.db.system.get("_storage", id));
        if (!metadata || (await archiveHash(archiveRowJson(metadata))) !== entry.sha256)
          throw new Error("ARCHIVE_ORIGINAL_CHANGED");
        await exclusiveFile(ctx, run, entry.originalId);
        await ctx.storage.delete(metadata._id);
        await releaseStoredFile(ctx, run.organizationId, metadata._id);
      } else {
        if (!ARCHIVE_TABLES.includes(entry.table as (typeof ARCHIVE_TABLES)[number]))
          throw new Error("ARCHIVE_TABLE_INVALID");
        const table = entry.table as (typeof ARCHIVE_TABLES)[number];
        const id = ctx.db.normalizeId(table, entry.originalId);
        const row = id && (await ctx.db.get(table, id));
        if (isArchiveFence(table)) {
          // The fence never leaves (ADR 0009, §3): same ID, same capacity inventory. Its hash may
          // differ from the scan's after a legitimate write in custody; the package has the snapshot.
          if (!row || (row as { organizationId?: unknown }).organizationId !== run.organizationId)
            throw new Error("ARCHIVE_FENCE_MISSING");
        } else {
          if (!row || (await archiveHash(archiveRowJson(row))) !== entry.sha256)
            throw new Error("ARCHIVE_ROW_CHANGED");
          await ctx.db.delete(table, row._id);
          await releaseDatabaseRecord(ctx, run.organizationId, table, row._id);
        }
      }
      await ctx.db.patch("coldArchiveEntries", entry._id, { removed: true });
    }
    const remaining = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId_and_removed", (q) => q.eq("runId", run._id).eq("removed", false))
      .first();
    await ctx.db.patch("coldArchiveRuns", run._id, {
      state: remaining ? "deleting" : "archived",
      updatedAt: Date.now(),
    });
    return !remaining;
  },
});
const CATALOG_BATCH = 64;
const sha256Hex = /^[a-f0-9]{64}$/;
/**
 * Records the compacted catalogue (ADR 0009, §4). Called exclusively by the administrative
 * executor AFTER it published the age object and its immutable manifest with conditional writes,
 * downloaded and decrypted the object and compared it with every hot entry of the run: count,
 * original IDs, hashes, storage metadata and fence snapshots. Only `archived` runs, whose every
 * entry is already handled, and only once: a different manifest never replaces the recorded one.
 */
export const catalogVerified = internalMutation({
  args: { ...runArgs, manifest: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    const manifestSha256 = await archiveHash(args.manifest);
    if (run.catalog) {
      if (run.catalog.manifestSha256 === manifestSha256) return null;
      throw new Error("ARCHIVE_CATALOG_IMMUTABLE");
    }
    if (run.state !== "archived" || !run.manifestSha256) throw new Error("ARCHIVE_NOT_ARCHIVED");
    if (
      await ctx.db
        .query("coldArchiveEntries")
        .withIndex("by_runId_and_removed", (q) => q.eq("runId", run._id).eq("removed", false))
        .first()
    )
      throw new Error("ARCHIVE_NOT_ARCHIVED");
    if (args.manifest.length > 16000) throw new Error("ARCHIVE_CATALOG_MISMATCH");
    const manifest = JSON.parse(args.manifest) as Record<string, unknown>;
    const entries = run.rows + run.files;
    if (
      manifest.format !== "fnfe-cold-archive-catalog/1" ||
      manifest.runId !== run._id ||
      manifest.organizationId !== run.organizationId ||
      manifest.version !== run.version ||
      manifest.packageManifestSha256 !== run.manifestSha256 ||
      manifest.rows !== run.rows ||
      manifest.files !== run.files ||
      manifest.entries !== entries ||
      // The sealed date: a renewal moves the run's `retainUntil` on, never the immutable manifests.
      manifest.retainUntil !==
        (JSON.parse(run.manifest ?? "{}") as { retainUntil?: number }).retainUntil ||
      !["plaintextSha256", "ciphertextSha256", "recipientSetSha256"].every(
        (name) => typeof manifest[name] === "string" && sha256Hex.test(manifest[name]),
      ) ||
      !["plaintextBytes", "ciphertextBytes"].every(
        (name) => Number.isSafeInteger(manifest[name]) && (manifest[name] as number) > 0,
      )
    )
      throw new Error("ARCHIVE_CATALOG_MISMATCH");
    const now = Date.now();
    await ctx.db.patch("coldArchiveRuns", run._id, {
      catalog: { state: "verified", manifestSha256, entries, removed: 0, verifiedAt: now },
      updatedAt: now,
    });
    return null;
  },
});
/** States with a sealed package in R2 while the organization is still archived (ADR 0009, §2). */
const RENEWABLE = ["sealed", "verified", "deleting", "archived", "restoring"] as const;
/**
 * The custody date a sealed run must reach now (ADR 0009, §2, "Prazo do pacote"). An open
 * organization still archived keeps its package for the guard counted from today, so the package
 * never expires while it stays archived. A closure counts from its own date. Only ever extends.
 */
async function retentionTarget(ctx: QueryCtx, run: Doc<"coldArchiveRuns">) {
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", run.organizationId))
    .unique();
  if (closure) return Math.max(run.retainUntil, fiscalGuardUntil(closure.requestedAt));
  if (run.reason === "closed") return run.retainUntil;
  return Math.max(run.retainUntil, fiscalGuardUntil(Date.now()));
}
// A coded refusal: the executor prints only the code to the operator.
function assertRenewable(run: Doc<"coldArchiveRuns">) {
  if (run.state === "hot") throw new ConvexError({ code: "ARCHIVE_ORGANIZATION_HOT" });
  if (!run.manifest || !(RENEWABLE as readonly string[]).includes(run.state))
    throw new ConvexError({ code: "ARCHIVE_NOT_SEALED" });
}
/**
 * What the executor must lock in R2 before `renewRetention` records it: the run's version, its
 * current `retainUntil` and the date to reach. Refuses a run without a package or already `hot`,
 * whose lock is no longer renewed and lapses at the date in force.
 */
export const retention = internalQuery({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.object({ version: v.number(), retainUntil: v.number(), target: v.number() }),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get("coldArchiveRuns", runId);
    if (!run) throw new Error("ARCHIVE_NOT_FOUND");
    assertRenewable(run);
    return {
      version: run.version,
      retainUntil: run.retainUntil,
      target: await retentionTarget(ctx, run),
    };
  },
});
/**
 * Records a renewal the executor already locked in R2 (`scripts/cold-tier/cold-archive.mjs renew`): the
 * run's `retainUntil` moves to `retainUntil`, never back and never past today's target. A legal
 * hold does not stop it; a renewal only keeps the package longer. Idempotent.
 */
export const renewRetention = internalMutation({
  args: { ...runArgs, retainUntil: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version, false);
    assertRenewable(run);
    if (args.retainUntil === run.retainUntil) return null;
    if (args.retainUntil < run.retainUntil || args.retainUntil > (await retentionTarget(ctx, run)))
      throw new ConvexError({ code: "ARCHIVE_RETENTION_MISMATCH" });
    const now = Date.now();
    await ctx.db.patch("coldArchiveRuns", run._id, {
      retainUntil: args.retainUntil,
      retentionRenewedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
/** Runs with a sealed package whose custody ends before `before`, for the operator to renew. */
export const renewalDue = internalQuery({
  args: { before: v.number() },
  returns: v.array(v.object({ runId: v.id("coldArchiveRuns"), retainUntil: v.number() })),
  handler: async (ctx, { before }) => {
    const due = [];
    for (const state of RENEWABLE) {
      const runs = await ctx.db
        .query("coldArchiveRuns")
        .withIndex("by_state_and_retainUntil", (q) =>
          q.eq("state", state).lt("retainUntil", before),
        )
        .take(100);
      due.push(...runs.map((run) => ({ runId: run._id, retainUntil: run.retainUntil })));
    }
    return due;
  },
});
/**
 * Deletes the hot catalogue of an `archived` run in bounded batches, only after `catalogVerified`.
 * Idempotent and resumable: every batch and its count commit together, and a compacted run
 * returns `true` without reading anything. Refuses, deleting nothing of the batch, when the hot
 * entries outnumber the verified object or fall short of it at the end.
 */
export const compactCatalogBatch = internalMutation({
  args: runArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version);
    const catalog = run.catalog;
    if (catalog?.state === "compacted") return true;
    if (run.state !== "archived" || !catalog) throw new Error("ARCHIVE_CATALOG_UNVERIFIED");
    const batch = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .take(CATALOG_BATCH);
    const removed = catalog.removed + batch.length;
    if (removed > catalog.entries) throw new Error("ARCHIVE_CATALOG_COUNT_MISMATCH");
    for (const entry of batch) {
      if (!entry.removed || entry.organizationId !== run.organizationId)
        throw new Error("ARCHIVE_CATALOG_ENTRY_INVALID");
      await ctx.db.delete("coldArchiveEntries", entry._id);
    }
    const remaining = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .first();
    if (!remaining && removed !== catalog.entries)
      throw new Error("ARCHIVE_CATALOG_COUNT_MISMATCH");
    const now = Date.now();
    await ctx.db.patch("coldArchiveRuns", run._id, {
      catalog: {
        ...catalog,
        state: remaining ? "compacting" : "compacted",
        removed,
        ...(remaining ? {} : { compactedAt: now }),
      },
      updatedAt: now,
    });
    return !remaining;
  },
});
export const materialize = internalQuery({
  args: { runId: v.id("coldArchiveRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run || run.state !== "frozen" || run.phase !== SCAN_TABLES.length)
      throw new Error("ARCHIVE_SCAN_INCOMPLETE");
    const page = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .paginate({ cursor: args.cursor, numItems: 16, maximumBytesRead: 128 * 1024 });
    const items = [];
    for (const entry of page.page) {
      if (entry.kind === "file") {
        const id = ctx.db.system.normalizeId("_storage", entry.originalId);
        if (!id || !entry.metadata) throw new Error("ARCHIVE_FILE_INVALID");
        const metadata = await ctx.db.system.get("_storage", id);
        if (!metadata || (await archiveHash(archiveRowJson(metadata))) !== entry.sha256)
          throw new Error("ARCHIVE_ORIGINAL_CHANGED");
        items.push({ ...entry, url: await ctx.storage.getUrl(id) });
      } else if (isArchiveFence(entry.table)) {
        // The fence row may have changed since the scan; the package carries the scan's snapshot.
        const { snapshot, ...rest } = entry;
        if (!snapshot || (await archiveHash(snapshot)) !== entry.sha256)
          throw new Error("ARCHIVE_ROW_CHANGED");
        items.push({ ...rest, json: snapshot });
      } else {
        const id = ctx.db.normalizeId(entry.table as TableNames, entry.originalId);
        const row = id && (await ctx.db.get(id));
        if (!row || (await archiveHash(archiveRowJson(row))) !== entry.sha256)
          throw new Error("ARCHIVE_ROW_CHANGED");
        items.push({ ...entry, json: archiveRowJson(row) });
      }
    }
    return JSON.stringify({ ...page, page: items });
  },
});
export const beginRestore = internalMutation({
  args: runArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await fenced(ctx, args.runId, args.version, false);
    // Actual Convex imports cannot resurrect a deleted ID in the same table.
    throw new Error("ARCHIVE_SAME_ORIGIN_RESTORE_UNSUPPORTED");
  },
});
/** Verify the original IDs really exist again; does not trust a JSON receipt for reactivation. */
export const verifyRestoredBatch = internalMutation({
  args: { ...runArgs, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await fenced(ctx, args.runId, args.version, false);
    if (run.state === "restoring" && run.restoredAt)
      return JSON.stringify({ done: true, cursor: run.cursor });
    if (run.state !== "restoring" || args.cursor !== run.cursor)
      throw new Error("ARCHIVE_RESTORE_FENCE");
    // A compacted catalogue is no longer in the DB: an empty page would read as "all restored".
    if (compacted(run)) throw new Error("ARCHIVE_CATALOG_COMPACTED");
    const page = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .paginate({ cursor: run.cursor, numItems: 32, maximumBytesRead: 128 * 1024 });
    for (const entry of page.page) {
      const id =
        entry.kind === "file"
          ? ctx.db.system.normalizeId("_storage", entry.originalId)
          : ctx.db.normalizeId(entry.table as TableNames, entry.originalId);
      const row =
        id &&
        (entry.kind === "file"
          ? await ctx.db.system.get("_storage", id as Id<"_storage">)
          : await ctx.db.get(id as Id<TableNames>));
      // A fence row never left; only its presence is checked, not the scan's hash.
      if (
        !row ||
        (!isArchiveFence(entry.table) && (await archiveHash(archiveRowJson(row))) !== entry.sha256)
      )
        throw new Error("ARCHIVE_RESTORE_MISMATCH");
    }
    await ctx.db.patch("coldArchiveRuns", run._id, {
      cursor: page.continueCursor,
      ...(page.isDone ? { restoredAt: Date.now() } : {}),
      updatedAt: Date.now(),
    });
    if (page.isDone) {
      const account = await ctx.db
        .query("capacityAccounts")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", run.organizationId))
        .unique();
      if (account)
        await ctx.db.patch("capacityAccounts", account._id, {
          ready: false,
          phase: 0,
          cursor: null,
          updatedAt: Date.now(),
        });
    }
    return JSON.stringify({ done: page.isDone, cursor: page.continueCursor });
  },
});
export const restoreRemaining = internalQuery({
  args: { ...runArgs, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run || run.state !== "restoring" || run.version !== args.version)
      throw new Error("ARCHIVE_RESTORE_FENCE");
    if (compacted(run)) throw new Error("ARCHIVE_CATALOG_COMPACTED");
    const page = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .paginate({ cursor: args.cursor, numItems: 32, maximumBytesRead: 128 * 1024 });
    const missing = [];
    for (const entry of page.page) {
      const row =
        entry.kind === "file"
          ? await ctx.db.system.get("_storage", entry.originalId as Id<"_storage">)
          : await ctx.db.get(entry.originalId as Id<TableNames>);
      if (!row) missing.push(entry.originalId);
      else if (
        // A fence row never left and may have changed since the scan.
        !isArchiveFence(entry.table) &&
        (await archiveHash(archiveRowJson(row))) !== entry.sha256
      )
        throw new Error("ARCHIVE_RESTORE_CONFLICT");
    }
    return JSON.stringify({ missing, isDone: page.isDone, continueCursor: page.continueCursor });
  },
});
// Unfreezing belongs to plans: check replenished capacity/custody in that SAME transaction,
// then set state=hot and increment version. Closed organizations cannot be reopened here.
export const restoreSafety = internalQuery({
  args: {},
  returns: v.string(),
  handler: async () =>
    JSON.stringify({
      cronsOff: process.env.FNFE_CRONS === "off",
      fiscalDisabled: process.env.FISCAL_ENV === "disabled",
      captureDisabled: process.env.FNFE_CAPTURE_FISCAL !== "enabled",
    }),
});
/**
 * Logical document bytes only: indexes, replicas and query bandwidth are additional costs. After
 * the compaction (ADR 0009, §4) the entries live in R2 and `catalogState` says so: zero entry
 * bytes then mean a compacted catalogue, not an empty one.
 */
export const catalogueCost = internalQuery({
  args: { runId: v.id("coldArchiveRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    runBytes: v.number(),
    entryBytes: v.number(),
    rowEntries: v.number(),
    fileEntries: v.number(),
    minimumEntryBytes: v.number(),
    maximumEntryBytes: v.number(),
    catalogState: v.union(
      v.literal("hot"),
      v.literal("verified"),
      v.literal("compacting"),
      v.literal("compacted"),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run) throw new Error("ARCHIVE_NOT_FOUND");
    const page = await ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .paginate({ cursor: args.cursor, numItems: 128, maximumBytesRead: 128 * 1024 });
    const sizes = page.page.map(getDocumentSize);
    return {
      runBytes: getDocumentSize(run),
      entryBytes: sizes.reduce((sum, size) => sum + size, 0),
      rowEntries: page.page.filter((e) => e.kind === "row").length,
      fileEntries: page.page.filter((e) => e.kind === "file").length,
      minimumEntryBytes: sizes.length ? Math.min(...sizes) : 0,
      maximumEntryBytes: sizes.length ? Math.max(...sizes) : 0,
      catalogState: run.catalog?.state ?? ("hot" as const),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
