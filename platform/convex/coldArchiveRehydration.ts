import { ConvexError, jsonToConvex, v, type Value } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  ARCHIVE_DAY,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveTable,
  archiveGate,
  archiveHash,
  archiveRowJson,
  isArchiveFence,
} from "./lib/coldArchiveCore";
import { recordArchiveId } from "./lib/coldArchiveIdMap";
import { originFor } from "./lib/coldArchiveOrigin";
import {
  COLD_BATCH_NOTES,
  COLD_OBJECT_FIELDS,
  HOT_REFERENCE_SOURCES,
  MAP_SIDE_LIMIT,
  REHYDRATION_MARGIN,
  ORPHAN_SCAN_PAGE,
  UPLOAD_ORPHAN_GRACE,
  UPLOAD_WINDOW,
  UPLOAD_WINDOW_SLACK,
  canonicalRow,
  mapSideRows,
  orphanScanStep,
  referencedIds,
  rehydratedTable,
  rewriteReferences,
  trackedTable,
} from "./lib/coldArchiveRehydration";
import {
  capacityPolicy,
  capacityTotal,
  patchFiscal,
  trackDatabaseRecord,
  trackStoredFile,
} from "./lib/capacityCore";
import { planEnded } from "./lib/usageValues";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { storageHolders } from "./lib/storageHolders";
import {
  CLAIM_TTL,
  coldTierEnabled,
  hasMovingNotes,
  hotWindowCutoff,
  legalHoldActive,
  lockedThrough,
  notePlan,
  organizationBlock,
} from "./coldTier";

/**
 * Rehydration of an archived open organization under new IDs (ADR 0009, §5 and §6), driven by the
 * administrative executor (`scripts/cold-archive.mjs rehydrate`), which downloads and decrypts the
 * package and the catalogue and checks both against their manifests. Every function here is
 * internal and needs `FNFE_COLD_ARCHIVE=enabled`. The run stays `restoring` from `begin` until
 * `finish`; admissions stay refused (`assertOrganizationHot`) the whole time.
 *
 * 1. `begin`: admission (paid plan active, capacity of the current plan), `archived` → `restoring`.
 *    With the cold tier on (`coldPolicy`), only the plan's hot window comes back to file storage
 *    (ADR 0010, decision 5): the executor leaves the files of the notes outside it for step 5, and
 *    the admission counts the hot files plus one batch (`cold.batchBytes`).
 * 2. Files: `beginUpload` writes the intent and returns an upload URL, the executor sends the
 *    bytes, `recordUpload` checks them and maps the new storage ID.
 * 3. Rows: `rows` inserts each package row with `insert` (new ID), the origin pair and its map
 *    entry in one transaction, in catalogue order, chaining the hashes as the scan did. Every
 *    note's residue comes back: the rows of all six document tables, whatever the tier.
 * 4. References: `references` rewrites every `rewritten` field, in rehydrated and hot rows. A
 *    deferred file has no map entry yet, so its holders keep the previous storage ID until step 5.
 * 5. Cold (ADR 0010, C2): batch by batch (`coldBatch`, `coldStep`), the deferred files of the notes
 *    outside the window are uploaded through intents as in step 2, their holders pointed at them,
 *    and the cold tier's passage (`coldTierWorker.move` with this run) moves each claimed note to
 *    the bucket and deletes the hot files before the next batch. A note that cannot move (legal
 *    hold, lock year not confirmed, gate off) keeps its files hot, admitted one upload at a time.
 * 6. Check: `check` rebuilds each row as the package carried it (a moved row with its stored file
 *    back in place of the object) and compares its hash with the catalogue entry, in order;
 *    `finish` returns the run to `hot` with a new version.
 */
const runArgs = { runId: v.id("coldArchiveRuns"), version: v.number() };
type Run = Doc<"coldArchiveRuns">;
type Rehydration = NonNullable<Run["rehydration"]>;
type Cold = NonNullable<Rehydration["cold"]>;

async function restoring(ctx: MutationCtx, runId: Id<"coldArchiveRuns">, version: number) {
  archiveGate();
  const run = await ctx.db.get("coldArchiveRuns", runId);
  if (!run || run.version !== version) throw new Error("ARCHIVE_STALE_FENCE");
  if (run.state !== "restoring" || !run.rehydration) throw new Error("ARCHIVE_NOT_RESTORING");
  return { run, rehydration: run.rehydration };
}
async function save(ctx: MutationCtx, run: Run, rehydration: Rehydration) {
  await ctx.db.patch("coldArchiveRuns", run._id, { rehydration, updatedAt: Date.now() });
}
/**
 * Files first, then rows; with nothing left of one, the next stage at once. The files the executor
 * deferred to the cold stage (`cold.files`) are not waited for here.
 */
function advance(run: Run, rehydration: Rehydration): Rehydration {
  if (
    rehydration.stage === "files" &&
    rehydration.files + (rehydration.cold?.files ?? 0) >= run.files
  )
    return advance(run, { ...rehydration, stage: "rows" });
  if (rehydration.stage === "rows" && rehydration.rows === run.rows) {
    // The rows handled are exactly the scan's: same order, same hashes.
    if (rehydration.digest !== run.digest) throw new Error("ARCHIVE_REHYDRATE_DIGEST");
    return { ...rehydration, stage: "references", phase: 0, cursor: null };
  }
  return rehydration;
}
async function closureOf(ctx: MutationCtx, organizationId: Id<"organizations">) {
  return ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
}

/**
 * The admission of ADR 0009, §5, item 1, before anything is written: a paid plan must be active,
 * and the package must fit the current plan's database and file capacity. `databaseBytes` is the
 * executor's measure with `getDocumentSize` of the rows of the six document tables, with the
 * origin pair, plus the ID map; the margin (`REHYDRATION_MARGIN`) goes on top. `fileBytes` is the
 * manifest's, or, with the cold stage (ADR 0010, decision 5), the files of the hot window and of
 * every note that stays hot, plus one batch of the cold stage. A refusal names the smallest
 * catalogue plan that would hold it.
 */
async function admit(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  databaseBytes: number,
  fileBytes: number,
) {
  const plan = await currentPlan(ctx, organizationId);
  if (!plan) throw new ConvexError({ code: "PLAN_REQUIRED" });
  const now = Date.now();
  if (plan.catalogTier !== "free" && (plan.startsAt > now || planEnded(plan, now)))
    throw new ConvexError({ code: "PLAN_INACTIVE" });
  await assertFits(ctx, organizationId, plan, {
    databaseBytes: Math.ceil(databaseBytes * (1 + REHYDRATION_MARGIN)),
    filesBytes: fileBytes,
  });
}
async function currentPlan(ctx: MutationCtx, organizationId: Id<"organizations">) {
  return ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
}
/** The stock plus `need` must fit the plan's capacity, under the capacity policy. */
async function assertFits(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  plan: Doc<"usagePlans"> | null,
  need: Partial<Record<"databaseBytes" | "filesBytes", number>>,
) {
  if (!plan?.capacity || !(await capacityPolicy(ctx))) return;
  const now = Date.now();
  for (const metric of ["databaseBytes", "filesBytes"] as const) {
    if (need[metric] === undefined) continue;
    const total = await capacityTotal(ctx, organizationId, metric, now);
    const required = (total?.committed ?? 0) + (total?.reserved ?? 0) + need[metric];
    if (required > plan.capacity[metric]) {
      const fits = (["free", "intermediate", "large"] as const).find(
        (tier) => PLATFORM_PLANS[tier].capacity[metric] >= required,
      );
      throw new ConvexError({
        code: "QUOTA_EXCEEDED",
        metric,
        period: "stock",
        required,
        plan: fits ?? null,
      });
    }
  }
}

/**
 * Whether the notes outside the hot window go to the cold tier during a rehydration (ADR 0010,
 * decision 5), and under which rule: the gate and the bucket (`coldTierEnabled`), no active legal
 * hold (pending 6), the window's `cutoff` (`hotWindowCutoff`, the sweep's own rule, for the plan in
 * force at `now`) and the confirmed lock year. Off, everything comes back hot, as before C2.
 */
async function coldPolicyOf(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
  now: number,
) {
  if (!coldTierEnabled()) return { enabled: false as const, reason: "disabled" };
  if (await legalHoldActive(ctx, organizationId))
    return { enabled: false as const, reason: "legalHold" };
  return {
    enabled: true as const,
    cutoff: await hotWindowCutoff(ctx, organizationId, now),
    lockedThrough: lockedThrough(),
  };
}

/**
 * The cold policy the executor plans the rehydration with, before `begin` (ADR 0010, C2): it
 * leaves out of the files stage the files of the notes this rule moves, and counts the rest as
 * hot. `begin` refuses a plan made under another rule (`ARCHIVE_REHYDRATE_COLD_POLICY`).
 */
export const coldPolicy = internalQuery({
  args: { runId: v.id("coldArchiveRuns"), now: v.number() },
  returns: v.union(
    v.object({ enabled: v.literal(false), reason: v.string() }),
    v.object({
      enabled: v.literal(true),
      cutoff: v.number(),
      lockedThrough: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    archiveGate();
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run) throw new Error("ARCHIVE_NOT_FOUND");
    return coldPolicyOf(ctx, run.organizationId, args.now);
  },
});
const coldPlanValue = v.object({
  cutoff: v.number(),
  lockedThrough: v.union(v.number(), v.null()),
  files: v.number(),
  bytes: v.number(),
  batchBytes: v.number(),
});

/**
 * `cold`, the executor's plan of the cold stage (ADR 0010, C2): the files it leaves for that stage
 * (`files`, `bytes`) and the slack of one batch (`batchBytes`), made with the `coldPolicy` it read
 * (`cutoff`, `lockedThrough`). It must be the current rule, at most a day older and never
 * newer, and `fileBytes` plus the deferred bytes must be the manifest's; otherwise `begin` refuses
 * before anything is written. Without `cold`, every file comes back in the files stage; the cold
 * stage still moves, with the current cutoff, the notes outside the window, once their files are
 * in. With the policy off, there is no cold stage, as before C2.
 */
export const begin = internalMutation({
  args: {
    ...runArgs,
    databaseBytes: v.number(),
    fileBytes: v.number(),
    cold: v.optional(coldPlanValue),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    archiveGate();
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run || run.version !== args.version) throw new Error("ARCHIVE_STALE_FENCE");
    if (run.state === "restoring" && run.rehydration) return null;
    // A closed organization never reopens; its archive stays the archive of a closed one.
    if (run.reason === "closed" || (await closureOf(ctx, run.organizationId)))
      throw new Error("ARCHIVE_CLOSED_NOT_REACTIVATABLE");
    if (run.state !== "archived" || !run.manifest) throw new Error("ARCHIVE_NOT_ARCHIVED");
    // The executor reads the catalogue from R2; a hot one would be left behind as garbage.
    if (run.catalog?.state !== "compacted") throw new Error("ARCHIVE_CATALOG_NOT_COMPACTED");
    // Packages are made under the current fiscal schema; one from another version would need the
    // package migrations of §5, none of which exists yet.
    const manifest = JSON.parse(run.manifest) as { schemaVersion?: number; fileBytes?: number };
    if ((manifest.schemaVersion ?? 1) !== ARCHIVE_SCHEMA_VERSION)
      throw new Error("ARCHIVE_SCHEMA_MIGRATION_REQUIRED");
    if (
      !Number.isSafeInteger(args.databaseBytes) ||
      !Number.isSafeInteger(args.fileBytes) ||
      args.databaseBytes < 0 ||
      args.fileBytes < 0
    )
      throw new Error("ARCHIVE_REHYDRATE_INVALID");
    const now = Date.now();
    const policy = await coldPolicyOf(ctx, run.organizationId, now);
    const plan = args.cold;
    if (plan) {
      if (
        ![plan.cutoff, plan.files, plan.bytes, plan.batchBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        (plan.lockedThrough !== null && !Number.isSafeInteger(plan.lockedThrough)) ||
        plan.files > run.files ||
        plan.batchBytes > plan.bytes ||
        args.fileBytes + plan.bytes !== manifest.fileBytes
      )
        throw new Error("ARCHIVE_REHYDRATE_INVALID");
      // The plan must be the rule in force: a stale one could defer a file that must come back
      // hot, past what the admission counts.
      if (
        !policy.enabled ||
        plan.lockedThrough !== policy.lockedThrough ||
        plan.cutoff > policy.cutoff ||
        policy.cutoff - plan.cutoff > ARCHIVE_DAY
      )
        throw new ConvexError({ code: "ARCHIVE_REHYDRATE_COLD_POLICY" });
    }
    await admit(
      ctx,
      run.organizationId,
      args.databaseBytes,
      args.fileBytes + (plan?.batchBytes ?? 0),
    );
    const cold: Cold | null = policy.enabled
      ? {
          cutoff: plan?.cutoff ?? policy.cutoff,
          lockedThrough: plan ? plan.lockedThrough : policy.lockedThrough,
          files: plan?.files ?? 0,
          bytes: plan?.bytes ?? 0,
          batchBytes: plan?.batchBytes ?? 0,
          cursor: null,
          passDone: false,
          moved: 0,
          kept: 0,
        }
      : null;
    const rehydration = advance(run, {
      stage: "files",
      ...(cold ? { cold } : {}),
      startedAt: now,
      files: 0,
      rows: 0,
      digest: "",
      phase: 0,
      cursor: null,
      checked: 0,
      checkDigest: "",
      checkedFiles: 0,
    });
    await ctx.db.patch("coldArchiveRuns", run._id, {
      state: "restoring",
      rehydration,
      updatedAt: now,
    });
    return null;
  },
});

const metadataValue = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  sha256: v.string(),
  size: v.number(),
  contentType: v.optional(v.string()),
});
async function attempts(ctx: MutationCtx, runId: Id<"coldArchiveRuns">, previousId: string) {
  return ctx.db
    .query("coldArchiveUploads")
    .withIndex("by_runId_and_previousId_and_attempt", (q) =>
      q.eq("runId", runId).eq("previousId", previousId),
    )
    .order("desc")
    .take(MAX_ATTEMPTS + 1);
}
const MAX_ATTEMPTS = 10;
/** Whether the blob has the bytes the intent expects. */
function sameBytes(
  blob: { sha256: string; size: number; contentType?: string } | null,
  intent: { sha256: string; size: number; contentType?: string },
) {
  return (
    !!blob &&
    blob.sha256 === intent.sha256 &&
    blob.size === intent.size &&
    blob.contentType === intent.contentType
  );
}

/**
 * The intent before an upload (ADR 0009, §5, item 4): run and original storage ID, with the bytes
 * the upload must have. A completed intent whose blob still has them is reused, and nothing is
 * sent; one whose recorded blob is gone or changed stops the rehydration, because the map already
 * names it. Otherwise a new attempt and an upload URL. The executor never picks a file outside
 * the intent nor looks one up by hash.
 */
export const beginUpload = internalMutation({
  args: { ...runArgs, metadata: metadataValue },
  returns: v.union(
    v.object({ storageId: v.id("_storage") }),
    v.object({ attempt: v.number(), uploadUrl: v.string() }),
  ),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    const { metadata } = args;
    if (
      !/^[A-Za-z0-9_-]+$/.test(metadata._id) ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0
    )
      throw new Error("ARCHIVE_UPLOAD_INVALID");
    const prior = await attempts(ctx, run._id, metadata._id);
    const done = prior.find((row) => row.storageId);
    if (done) {
      const storageId = done.storageId as Id<"_storage">;
      if (!sameBytes(await ctx.db.system.get("_storage", storageId), done))
        throw new Error("ARCHIVE_UPLOAD_LOST");
      return { storageId };
    }
    if (rehydration.stage === "cold") {
      // Only a file the batch under way asked for, and only if the stock still fits: a file that
      // must stay hot after all (a hold placed, a lock year withdrawn, the gate turned off) is
      // admitted here, one at a time, and the rehydration stops before overfilling the plan.
      if (!rehydration.cold?.batch?.files.includes(metadata._id))
        throw new Error("ARCHIVE_REHYDRATE_FENCE");
      await assertFits(ctx, run.organizationId, await currentPlan(ctx, run.organizationId), {
        filesBytes: metadata.size,
      });
    } else if (rehydration.stage !== "files") throw new Error("ARCHIVE_REHYDRATE_FENCE");
    if (prior.some((row) => row.rejected)) throw new Error("ARCHIVE_UPLOAD_MISMATCH");
    const attempt = (prior[0]?.attempt ?? 0) + 1;
    if (attempt > MAX_ATTEMPTS) throw new Error("ARCHIVE_UPLOAD_ATTEMPTS");
    await ctx.db.insert("coldArchiveUploads", {
      organizationId: run.organizationId,
      runId: run._id,
      previousId: metadata._id,
      previousCreationTime: metadata._creationTime,
      attempt,
      sha256: metadata.sha256,
      size: metadata.size,
      ...(metadata.contentType !== undefined ? { contentType: metadata.contentType } : {}),
      startedAt: Date.now(),
    });
    return { attempt, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

/** Whether any row of the platform, or another intent, already holds the blob. */
async function held(ctx: MutationCtx, storageId: Id<"_storage">) {
  for (const { query } of storageHolders(ctx, storageId)) if (await query.first()) return true;
  return !!(await ctx.db
    .query("coldArchiveUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first());
}

/**
 * Completes an attempt with the storage ID the upload returned. The blob must be fresh (created
 * inside the attempt's window, held by nothing else, so another organization's file can never be
 * claimed) and have the SHA-256, size and content type of the original. Then, in one transaction:
 * the intent, the ID map entry of the file and its capacity inventory. A blob with other bytes is
 * deleted and the attempt marked rejected; the rehydration stops (`ok: false`).
 */
export const recordUpload = internalMutation({
  args: {
    ...runArgs,
    previousId: v.string(),
    attempt: v.number(),
    storageId: v.id("_storage"),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    const intent = await ctx.db
      .query("coldArchiveUploads")
      .withIndex("by_runId_and_previousId_and_attempt", (q) =>
        q.eq("runId", run._id).eq("previousId", args.previousId).eq("attempt", args.attempt),
      )
      .unique();
    if (!intent) throw new Error("ARCHIVE_UPLOAD_UNKNOWN");
    if (intent.storageId === args.storageId) return { ok: true };
    const latest = (await attempts(ctx, run._id, args.previousId))[0];
    if (intent.storageId || intent.rejected || latest?._id !== intent._id)
      throw new Error("ARCHIVE_UPLOAD_FENCE");
    const blob = await ctx.db.system.get("_storage", args.storageId);
    if (!blob) throw new Error("ARCHIVE_UPLOAD_MISSING");
    if (
      blob._creationTime < intent.startedAt ||
      blob._creationTime > intent.startedAt + UPLOAD_WINDOW ||
      (await held(ctx, blob._id))
    )
      throw new Error("ARCHIVE_UPLOAD_FOREIGN");
    const now = Date.now();
    if (!sameBytes(blob, intent)) {
      await ctx.storage.delete(blob._id);
      await ctx.db.patch("coldArchiveUploads", intent._id, { rejected: true, collectedAt: now });
      return { ok: false };
    }
    await ctx.db.patch("coldArchiveUploads", intent._id, {
      storageId: blob._id,
      collectedAt: now,
    });
    await recordArchiveId(ctx, {
      organizationId: run.organizationId,
      runId: run._id,
      table: "_storage",
      previousId: args.previousId,
      previousCreationTime: intent.previousCreationTime,
      newId: blob._id,
    });
    await trackStoredFile(ctx, run.organizationId, blob._id, undefined, {
      restoringInventory: true,
    });
    // A deferred file arrives after the second pass: its holders still name the previous ID.
    if (rehydration.stage === "cold") await pointHolders(ctx, run, args.previousId);
    await save(ctx, run, advance(run, { ...rehydration, files: rehydration.files + 1 }));
    return { ok: true };
  },
});

/**
 * Points the rows that hold a deferred file (ADR 0010, C2) at its new storage ID, in the
 * transaction that maps it, as the second pass does for the others: only rows this run recreated,
 * found by the previous ID through `storageHolders`.
 */
async function pointHolders(ctx: MutationCtx, run: Run, previousId: string) {
  for (const { table, query } of storageHolders(ctx, previousId as Id<"_storage">)) {
    if (table === "capacityFiles") continue;
    const rows = await query.take(MAP_SIDE_LIMIT + 1);
    if (rows.length > MAP_SIDE_LIMIT) throw new Error("ARCHIVE_REFERENCE_SCAN_LIMIT");
    for (const row of rows) {
      const entry = await ctx.db
        .query("coldArchiveIdMap")
        .withIndex("by_newId", (q) => q.eq("newId", row._id))
        .first();
      if (entry?.runId !== run._id) continue;
      await rewriteRow(ctx, run, table, row as { _id: string } & Record<string, unknown>);
    }
  }
}

/** Rows of a batch: the canonical JSON of the package line and its table. */
const rowValue = v.object({ table: v.string(), json: v.string() });
function archiveTable(table: string): ArchiveTable {
  if (!rehydratedTable(table) && !isArchiveFence(table)) throw new Error("ARCHIVE_TABLE_INVALID");
  return table as ArchiveTable;
}
/** A fence row never left (ADR 0009, §3): it must still be hot and the organization's. */
async function assertFence(ctx: MutationCtx, run: Run, table: string, previousId: string) {
  const fence = table as "captureStreams" | "dpsSequences";
  const id = ctx.db.normalizeId(fence, previousId);
  const row = id && (await ctx.db.get(fence, id));
  if (!row || row.organizationId !== run.organizationId) throw new Error("ARCHIVE_FENCE_MISSING");
}
/**
 * First pass (ADR 0009, §5, item 3), in catalogue order from `offset`. Each row must be the
 * canonical JSON of a package line; its hash joins the chain, which must end equal to the scan's
 * `digest`. A fence row is never recreated: it must still be hot and the organization's. Any
 * other row is inserted as it was, with new `_id` and `_creationTime`, the origin pair and, in the
 * same transaction, its ID map entry and, for the document tables, its capacity inventory. The
 * references still hold the previous IDs until the second pass. No webhook is queued and no
 * monthly usage is counted.
 */
export const rows = internalMutation({
  args: { ...runArgs, offset: v.number(), rows: v.array(rowValue) },
  returns: v.object({ rows: v.number() }),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    // A repeated batch whose response was lost: already applied.
    if (args.offset + args.rows.length <= rehydration.rows && rehydration.stage !== "files")
      return { rows: rehydration.rows };
    if (
      rehydration.stage !== "rows" ||
      args.offset !== rehydration.rows ||
      rehydration.rows + args.rows.length > run.rows
    )
      throw new Error("ARCHIVE_REHYDRATE_FENCE");
    let digest = rehydration.digest;
    for (const { table: name, json } of args.rows) {
      const table = archiveTable(name);
      const value = jsonToConvex(JSON.parse(json)) as Record<string, Value>;
      if (archiveRowJson(value) !== json) throw new Error("ARCHIVE_ROW_NOT_CANONICAL");
      const previousId = value._id;
      const previousCreationTime = value._creationTime;
      if (typeof previousId !== "string" || typeof previousCreationTime !== "number")
        throw new Error("ARCHIVE_ROW_NOT_CANONICAL");
      const hash = await archiveHash(json);
      digest = await archiveHash(`${digest}\n${table}\n${previousId}\n${hash}`);
      if ("organizationId" in value && value.organizationId !== run.organizationId)
        throw new Error("ARCHIVE_ROW_FOREIGN");
      if (isArchiveFence(table)) {
        await assertFence(ctx, run, table, previousId);
        continue;
      }
      const { _id, _creationTime, ...fields } = value;
      const newId = await ctx.db.insert(table, {
        ...fields,
        ...originFor({
          _id: previousId,
          _creationTime: previousCreationTime,
          originId: typeof value.originId === "string" ? value.originId : undefined,
          originCreationTime:
            typeof value.originCreationTime === "number" ? value.originCreationTime : undefined,
        }),
      } as never);
      await recordArchiveId(ctx, {
        organizationId: run.organizationId,
        runId: run._id,
        table,
        previousId,
        previousCreationTime,
        newId,
      });
      if (trackedTable(table)) {
        const row = (await ctx.db.get(table, newId as Id<typeof table>))!;
        await trackDatabaseRecord(ctx, run.organizationId, table, newId, row, false, true);
      }
    }
    const next = advance(run, {
      ...rehydration,
      rows: rehydration.rows + args.rows.length,
      digest,
    });
    await save(ctx, run, next);
    return { rows: next.rows };
  },
});

/** This cycle's new IDs for the given previous ones, checked against the fields' targets. */
async function forward(
  ctx: MutationCtx,
  runId: Id<"coldArchiveRuns">,
  references: { id: string; targets: string[] }[],
) {
  const ids = new Map<string, string>();
  for (const { id, targets } of references) {
    const entry = await ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_runId_and_previousId", (q) => q.eq("runId", runId).eq("previousId", id))
      .unique();
    if (!entry) continue;
    if (!targets.includes(entry.table)) throw new Error("ARCHIVE_REFERENCE_TABLE_MISMATCH");
    ids.set(id, entry.newId);
  }
  return ids;
}
/** Rewrites one row in place; re-tracks the stock of a document table. */
async function rewriteRow(
  ctx: MutationCtx,
  run: Run,
  table: TableNames,
  row: { _id: string } & Record<string, unknown>,
) {
  const ids = await forward(ctx, run._id, referencedIds(table, row));
  if (!ids.size) return;
  const changed = rewriteReferences(table, row, ids);
  if (!Object.keys(changed).length) return;
  await ctx.db.patch(table, row._id as Id<typeof table>, changed as never);
  if (trackedTable(table)) {
    const next = (await ctx.db.get(table, row._id as Id<typeof table>))!;
    await trackDatabaseRecord(ctx, run.organizationId, table, row._id, next, false, true);
  }
}

/**
 * Second pass (ADR 0009, §5, item 5): one page per call, resumable from the run's phase and
 * cursor. Phase 0 walks this cycle's ID map, rewriting each rehydrated row and the hot rows found
 * by the previous ID (receipts and registry calls of an operation); the next phases walk the
 * organization's hot rows of `HOT_REFERENCE_SOURCES`. Every lookup goes through this run's map,
 * so nothing of another organization is ever read or written, and a repeated page finds new IDs,
 * which the map never has as previous ones, and changes nothing.
 */
export const references = internalMutation({
  args: runArgs,
  returns: v.object({ stage: v.string(), phase: v.number() }),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    if (rehydration.stage !== "references")
      return { stage: rehydration.stage, phase: rehydration.phase };
    let page;
    if (rehydration.phase === 0) {
      page = await ctx.db
        .query("coldArchiveIdMap")
        .withIndex("by_runId_and_previousId", (q) => q.eq("runId", run._id))
        .paginate({ cursor: rehydration.cursor, numItems: 32, maximumBytesRead: 512 * 1024 });
      for (const entry of page.page) {
        if (entry.table === "_storage") continue;
        const table = entry.table as TableNames;
        const id = ctx.db.normalizeId(table, entry.newId);
        const row = id && (await ctx.db.get(table, id));
        if (!row) throw new Error("ARCHIVE_MAP_MISSING");
        await rewriteRow(ctx, run, table, row);
        for (const hot of await mapSideRows(ctx, entry.table, entry.previousId))
          if (hot.row.organizationId === run.organizationId)
            await rewriteRow(ctx, run, hot.table, hot.row);
      }
    } else {
      const source = HOT_REFERENCE_SOURCES[rehydration.phase - 1];
      if (!source) throw new Error("ARCHIVE_REHYDRATE_PHASE");
      page = await source.page(ctx, run.organizationId, rehydration.cursor);
      for (const row of page.page) await rewriteRow(ctx, run, source.table, row);
    }
    const last = rehydration.phase === HOT_REFERENCE_SOURCES.length;
    const next: Rehydration = !page.isDone
      ? { ...rehydration, cursor: page.continueCursor }
      : last
        ? { ...rehydration, stage: rehydration.cold ? "cold" : "check", phase: 0, cursor: null }
        : { ...rehydration, phase: rehydration.phase + 1, cursor: null };
    await save(ctx, run, next);
    return { stage: next.stage, phase: next.phase };
  },
});

/**
 * The cold stage's verdict on a note (ADR 0010, C2): `done` if already cold (as the package
 * carried it, or moved earlier in this stage), `cold` if the passage would move it now (cold tier
 * on, no legal hold, outside the window fixed at `begin`, and the sweep's own `notePlan`, with the
 * lock year), `hot` otherwise.
 */
async function coldVerdict(ctx: MutationCtx, run: Run, cold: Cold, doc: Doc<"fiscalDocuments">) {
  if (doc.coldState === "cold") return "done" as const;
  if (!coldTierEnabled() || (await organizationBlock(ctx, doc.organizationId, run._id)))
    return "hot" as const;
  if (doc.direction !== undefined || doc.createdAt >= cold.cutoff) return "hot" as const;
  return (await notePlan(ctx, doc)).state === "ready" ? ("cold" as const) : ("hot" as const);
}

/**
 * The files of a note that the files stage left out (previous storage IDs): held by its versions,
 * their artifacts or the import file, with no blob of this run. A live blob is never asked for.
 * Every version is read, with no `MAX_VERSIONS` cap: a note above it never moves (`notePlan`
 * skips it) and stays hot, but any file the plan deferred must still come back.
 */
async function deferredFiles(ctx: MutationCtx, run: Run, doc: Doc<"fiscalDocuments">) {
  const ids = new Set<string>();
  for await (const version of ctx.db
    .query("documentVersions")
    .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))) {
    if (version.contentStorageId) ids.add(version.contentStorageId);
    const artifact = await ctx.db.get("documentArtifacts", version.artifactId);
    if (artifact?.storageId) ids.add(artifact.storageId);
    const file = artifact?.fileId ? await ctx.db.get("importFiles", artifact.fileId) : null;
    if (file?.storageId) ids.add(file.storageId);
  }
  const out: string[] = [];
  for (const id of ids) {
    const entry = await ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_newId", (q) => q.eq("newId", id))
      .first();
    if (entry?.runId === run._id) continue;
    if (await ctx.db.system.get("_storage", id as Id<"_storage">)) continue;
    out.push(id);
  }
  return out;
}

async function scheduleMoves(ctx: MutationCtx, run: Run, documentIds: string[], claimedAt: number) {
  for (const documentId of documentIds)
    await ctx.scheduler.runAfter(0, internal.coldTierWorker.move, {
      documentId: documentId as Id<"fiscalDocuments">,
      claimedAt,
      runId: run._id,
    });
}
async function claim(ctx: MutationCtx, doc: Doc<"fiscalDocuments">, claimedAt: number) {
  await patchFiscal(
    ctx,
    "fiscalDocuments",
    doc._id,
    { coldState: "moving", coldClaimedAt: claimedAt },
    false,
    true,
  );
}
function inCold(rehydration: Rehydration) {
  if (rehydration.stage !== "cold" || !rehydration.cold) throw new Error("ARCHIVE_REHYDRATE_FENCE");
  return rehydration.cold;
}
/** `cold` without the batch: an optional field is left out, never written as `undefined`. */
function withoutBatch({ batch: _batch, ...cold }: Cold): Cold {
  return cold;
}

/**
 * Starts a batch of the cold stage (ADR 0010, C2). With `documentIds` (the previous IDs of up to
 * `COLD_BATCH_NOTES` notes), the executor's batch: the notes whose files it deferred, sized by its
 * byte budget. Without, the next page of the server's own pass over every note of the
 * organization, which moves what the executor's plan left hot and, once done, ends the stage.
 * Each note gets `coldVerdict`: the ones to move are claimed; the deferred files of every note of
 * the batch, moving or not, go in the batch for upload (`coldStep`). Refused while a batch is under
 * way (`busy`); a repeated call finds its notes cold already and starts nothing (`idle`).
 */
export const coldBatch = internalMutation({
  args: { ...runArgs, documentIds: v.optional(v.array(v.string())) },
  returns: v.object({
    state: v.union(v.literal("started"), v.literal("idle"), v.literal("busy"), v.literal("done")),
  }),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    if (rehydration.stage === "check" || rehydration.stage === "checked")
      return { state: "done" as const };
    let cold = inCold(rehydration);
    if (cold.batch) return { state: "busy" as const };
    const docs: Doc<"fiscalDocuments">[] = [];
    const pass = args.documentIds === undefined;
    if (args.documentIds) {
      if (args.documentIds.length > COLD_BATCH_NOTES) throw new Error("ARCHIVE_REHYDRATE_INVALID");
      for (const previousId of args.documentIds) {
        const entry = await ctx.db
          .query("coldArchiveIdMap")
          .withIndex("by_runId_and_previousId", (q) =>
            q.eq("runId", run._id).eq("previousId", previousId),
          )
          .unique();
        const id =
          entry?.table === "fiscalDocuments"
            ? ctx.db.normalizeId("fiscalDocuments", entry.newId)
            : null;
        const doc = id && (await ctx.db.get("fiscalDocuments", id));
        if (!doc) throw new Error("ARCHIVE_REHYDRATE_COLD_UNKNOWN");
        docs.push(doc);
      }
    } else {
      if (cold.passDone) {
        // Every deferred file came in, and no note is left halfway to the bucket.
        if (rehydration.files < run.files)
          throw new ConvexError({ code: "ARCHIVE_REHYDRATE_COLD_INCOMPLETE" });
        if (await hasMovingNotes(ctx, run.organizationId))
          throw new ConvexError({ code: "ARCHIVE_REHYDRATE_COLD_MOVING" });
        await save(ctx, run, { ...rehydration, stage: "check", phase: 0, cursor: null });
        return { state: "done" as const };
      }
      const page = await ctx.db
        .query("fiscalDocuments")
        .withIndex("by_organizationId_and_environment", (q) =>
          q.eq("organizationId", run.organizationId),
        )
        .paginate({ cursor: cold.cursor, numItems: COLD_BATCH_NOTES });
      docs.push(...page.page);
      cold = { ...cold, cursor: page.continueCursor, passDone: page.isDone };
    }
    const claimedAt = Date.now();
    const documentIds: string[] = [];
    const files = new Set<string>();
    let kept = 0;
    for (const doc of docs) {
      const verdict = await coldVerdict(ctx, run, cold, doc);
      if (verdict === "done") continue;
      for (const id of await deferredFiles(ctx, run, doc)) files.add(id);
      if (verdict === "hot") {
        // Counted once, by the server's pass, which reads every note exactly once.
        if (pass && doc.direction === undefined && doc.createdAt < cold.cutoff) kept++;
        continue;
      }
      await claim(ctx, doc, claimedAt);
      documentIds.push(doc._id);
    }
    cold = { ...cold, kept: cold.kept + kept };
    const started = documentIds.length > 0 || files.size > 0;
    if (started)
      cold = {
        ...cold,
        batch: { claimedAt, documentIds, files: [...files], scheduled: false, attempt: 1 },
      };
    await save(ctx, run, { ...rehydration, cold });
    return { state: started ? ("started" as const) : ("idle" as const) };
  },
});

/**
 * Advances the batch under way, one step per call (ADR 0010, C2):
 *
 * - `upload`: deferred files still to send, which the executor uploads through `beginUpload` and
 *   `recordUpload`, as in the files stage;
 * - `moving`: the passage of the claimed notes is scheduled (`coldTierWorker.move` with this run)
 *   or still running; the executor waits and calls again;
 * - `idle`: the batch ended, every note cold, or hot because it can no longer move, with its files
 *   hot and admitted. Its hot files left storage before this, so the next batch starts from the
 *   same stock.
 *
 * A note whose passage ended without turning it cold (the bucket failed, the claim expired) is
 * claimed again and its move scheduled once more, with `attempt` counting the claims of the batch;
 * the executor gives up after a few and a later run resumes here. Repeating a call does nothing
 * twice: every outcome is read from the notes and the map, never from the call.
 */
export const coldStep = internalMutation({
  args: runArgs,
  returns: v.union(
    v.object({ state: v.literal("idle") }),
    v.object({ state: v.literal("done") }),
    v.object({ state: v.literal("upload"), files: v.array(v.string()) }),
    v.object({ state: v.literal("moving"), attempt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    if (rehydration.stage === "check" || rehydration.stage === "checked")
      return { state: "done" as const };
    const cold = inCold(rehydration);
    const batch = cold.batch;
    if (!batch) return { state: "idle" as const };
    const pending: string[] = [];
    for (const previousId of batch.files)
      if (
        !(await ctx.db
          .query("coldArchiveIdMap")
          .withIndex("by_runId_and_previousId", (q) =>
            q.eq("runId", run._id).eq("previousId", previousId),
          )
          .unique())
      )
        pending.push(previousId);
    if (pending.length) return { state: "upload" as const, files: pending };
    if (!batch.scheduled) {
      await scheduleMoves(ctx, run, batch.documentIds, batch.claimedAt);
      await save(ctx, run, {
        ...rehydration,
        cold: { ...cold, batch: { ...batch, scheduled: true } },
      });
      return { state: "moving" as const, attempt: batch.attempt };
    }
    const now = Date.now();
    let moved = 0;
    let running = false;
    const again: Doc<"fiscalDocuments">[] = [];
    for (const documentId of batch.documentIds) {
      const doc = await ctx.db.get("fiscalDocuments", documentId as Id<"fiscalDocuments">);
      if (!doc) throw new Error("ARCHIVE_MAP_MISSING");
      if (doc.coldState === "cold") moved++;
      else if (
        doc.coldState === "moving" &&
        doc.coldClaimedAt === batch.claimedAt &&
        now - batch.claimedAt < CLAIM_TTL
      )
        running = true;
      else if ((await coldVerdict(ctx, run, cold, doc)) === "cold") again.push(doc);
    }
    if (running) return { state: "moving" as const, attempt: batch.attempt };
    if (again.length) {
      for (const doc of again) await claim(ctx, doc, now);
      const documentIds = again.map((doc) => doc._id as string);
      await scheduleMoves(ctx, run, documentIds, now);
      await save(ctx, run, {
        ...rehydration,
        cold: {
          ...cold,
          moved: cold.moved + moved,
          batch: {
            claimedAt: now,
            documentIds,
            files: [],
            scheduled: true,
            attempt: batch.attempt + 1,
          },
        },
      });
      return { state: "moving" as const, attempt: batch.attempt + 1 };
    }
    await save(ctx, run, {
      ...rehydration,
      cold: { ...withoutBatch(cold), moved: cold.moved + moved },
    });
    return { state: "idle" as const };
  },
});

/**
 * The package's form of a row the cold stage changed (ADR 0010, C2), for the canonical check:
 *
 * - a version or an original moved by this run (its key on this run's intent): the stored file
 *   back in place of the object (the new storage ID, which the inverse map turns into the
 *   previous one), once the object's SHA-256 and size equal what the passage recorded;
 * - the import file that let go of such an original: the stored file back;
 * - a note turned cold by this run (`coldAt` after `begin`): hot again, as the package had it.
 *
 * Any other row, including one already cold in the package, is compared as it is.
 */
async function packageForm(
  ctx: MutationCtx,
  run: Run,
  rehydration: Rehydration,
  table: ArchiveTable,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (table === "fiscalDocuments") {
    if (
      row.coldState === "cold" &&
      typeof row.coldAt === "number" &&
      row.coldAt >= rehydration.startedAt
    ) {
      const { coldState: _state, coldAt: _at, coldClaimedAt: _claim, ...rest } = row;
      return rest;
    }
    return row;
  }
  if (table === "importFiles") {
    if (row.storageId !== undefined) return row;
    const intent = await ctx.db
      .query("coldArchiveUploads")
      .withIndex("by_runId_and_importFileId", (q) =>
        q.eq("runId", run._id).eq("importFileId", String(row._id)),
      )
      .unique();
    return intent?.storageId ? { ...row, storageId: intent.storageId } : row;
  }
  if (table !== "documentVersions" && table !== "documentArtifacts") return row;
  const fields = COLD_OBJECT_FIELDS[table];
  const key = row[fields.key];
  if (typeof key !== "string") return row;
  const intent = await ctx.db
    .query("coldArchiveUploads")
    .withIndex("by_runId_and_objectKey", (q) => q.eq("runId", run._id).eq("objectKey", key))
    .unique();
  if (!intent) return row;
  if (
    !intent.storageId ||
    row[fields.storage] !== undefined ||
    row[fields.sha256] !== intent.objectSha256 ||
    row[fields.size] !== intent.objectSize
  )
    throw new Error("ARCHIVE_CHECK_MISMATCH");
  const { [fields.key]: _key, [fields.sha256]: _sha256, [fields.size]: _size, ...rest } = row;
  return { ...rest, [fields.storage]: intent.storageId };
}

const entryValue = v.object({
  kind: v.union(v.literal("row"), v.literal("file")),
  table: v.string(),
  originalId: v.string(),
  sha256: v.string(),
});
/**
 * The canonical check (ADR 0009, §5, "A conferência final"), over the catalogue entries in order
 * from `offset`. For a rehydrated row, the row is rebuilt as the package carried it
 * (`canonicalRow`) and its SHA-256 must equal the entry's; a fence row must still be hot. For a
 * file, the storage metadata is rebuilt with the previous ID, creation and content type and the
 * new blob's hash and size, and must hash to the entry. The rows' hashes chain as in the scan,
 * so the entries checked are exactly the package's; each file is checked once.
 */
export const check = internalMutation({
  args: { ...runArgs, offset: v.number(), entries: v.array(entryValue) },
  returns: v.object({ checked: v.number() }),
  handler: async (ctx, args) => {
    const { run, rehydration } = await restoring(ctx, args.runId, args.version);
    const total = run.rows + run.files;
    if (
      (rehydration.stage === "check" || rehydration.stage === "checked") &&
      args.offset + args.entries.length <= rehydration.checked
    )
      return { checked: rehydration.checked };
    if (
      rehydration.stage !== "check" ||
      args.offset !== rehydration.checked ||
      rehydration.checked + args.entries.length > total
    )
      throw new Error("ARCHIVE_REHYDRATE_FENCE");
    let checkDigest = rehydration.checkDigest;
    let checkedFiles = rehydration.checkedFiles;
    for (const entry of args.entries) {
      if (entry.kind === "row" && isArchiveFence(entry.table)) {
        await assertFence(ctx, run, entry.table, entry.originalId);
      } else {
        const mapped = await ctx.db
          .query("coldArchiveIdMap")
          .withIndex("by_runId_and_previousId", (q) =>
            q.eq("runId", run._id).eq("previousId", entry.originalId),
          )
          .unique();
        const table = entry.kind === "file" ? "_storage" : entry.table;
        if (!mapped || mapped.table !== table) throw new Error("ARCHIVE_CHECK_MISSING");
        const previous = { id: mapped.previousId, creationTime: mapped.previousCreationTime };
        let json;
        if (entry.kind === "file") {
          const intent = (await attempts(ctx, run._id, entry.originalId)).find(
            (row) => row.storageId === mapped.newId,
          );
          const blob = await ctx.db.system.get("_storage", mapped.newId as Id<"_storage">);
          // A file the cold stage moved left storage on purpose (ADR 0010, C2): its bytes are
          // the ones `recordUpload` checked against the intent, and the row that names its
          // object is checked against the package below.
          if (!intent || (!blob && intent.objectKey === undefined))
            throw new Error("ARCHIVE_CHECK_MISSING");
          if (intent.checkedAt !== undefined) throw new Error("ARCHIVE_CHECK_REPEATED");
          json = archiveRowJson({
            _id: previous.id,
            _creationTime: previous.creationTime,
            sha256: blob ? blob.sha256 : intent.sha256,
            size: blob ? blob.size : intent.size,
            ...(intent.contentType !== undefined ? { contentType: intent.contentType } : {}),
          });
          await ctx.db.patch("coldArchiveUploads", intent._id, { checkedAt: Date.now() });
          checkedFiles++;
        } else {
          const rowTable = archiveTable(entry.table);
          const stored = await ctx.db.get(rowTable, mapped.newId as Id<typeof rowTable>);
          if (!stored) throw new Error("ARCHIVE_CHECK_MISSING");
          const row = await packageForm(ctx, run, rehydration, rowTable, stored);
          const inverse = new Map<string, string>();
          for (const { id } of referencedIds(rowTable, row)) {
            const back = await ctx.db
              .query("coldArchiveIdMap")
              .withIndex("by_newId", (q) => q.eq("newId", id))
              .unique();
            if (back?.runId === run._id) inverse.set(id, back.previousId);
          }
          json = canonicalRow(rowTable, row, previous, inverse);
        }
        if ((await archiveHash(json)) !== entry.sha256) throw new Error("ARCHIVE_CHECK_MISMATCH");
      }
      if (entry.kind === "row")
        checkDigest = await archiveHash(
          `${checkDigest}\n${entry.table}\n${entry.originalId}\n${entry.sha256}`,
        );
    }
    const checked = rehydration.checked + args.entries.length;
    const complete = checked === total;
    if (complete && (checkDigest !== run.digest || checkedFiles !== run.files))
      throw new Error("ARCHIVE_CHECK_INCOMPLETE");
    await save(ctx, run, {
      ...rehydration,
      checked,
      checkDigest,
      checkedFiles,
      stage: complete ? "checked" : "check",
    });
    return { checked };
  },
});

/**
 * Back to `hot` once every row and file matched (ADR 0009, §5): admissions reopen, the version
 * changes so no stale executor acts on the run again, and a later archiving opens a new run.
 * Repeating it does nothing.
 */
export const finish = internalMutation({
  args: runArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    archiveGate();
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (run?.state === "hot" && run.rehydration?.finishedAt !== undefined) return null;
    const { rehydration } = await restoring(ctx, args.runId, args.version);
    if (rehydration.stage !== "checked") throw new Error("ARCHIVE_CHECK_INCOMPLETE");
    const now = Date.now();
    await ctx.db.patch("coldArchiveRuns", args.runId, {
      state: "hot",
      version: args.version + 1,
      restoredAt: now,
      rehydration: { ...rehydration, finishedAt: now },
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Collects the orphans of upload attempts that never completed (ADR 0009, §5, item 4): a crash
 * between the upload and `recordUpload` leaves a blob nothing points to. One attempt and at most
 * `ORPHAN_SCAN_PAGE` blobs of its window per call (a single `paginate`, over the attempts); the
 * position in the window is kept on the attempt (`scannedThrough`), and while the window is not
 * done the same cursor is returned, so the executor calls again until `isDone`. An attempt's window runs from its start to the next attempt of the same original, or to
 * `UPLOAD_WINDOW` without one; it is judged only when the window ended `UPLOAD_ORPHAN_GRACE`
 * ago, longer than any flow takes between storing a blob and recording it. Inside the window, a
 * blob with exactly the original's hash, size and content type, that no table of
 * `storageHolders` and no intent holds, is deleted. Repeating is harmless. Works in any state of
 * the run, so the operator can finish the collection after the run is back to `hot`.
 */
export const collectUploadOrphans = internalMutation({
  args: { runId: v.id("coldArchiveRuns"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    deleted: v.number(),
    pending: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    archiveGate();
    if (!(await ctx.db.get("coldArchiveRuns", args.runId))) throw new Error("ARCHIVE_NOT_FOUND");
    const page = await ctx.db
      .query("coldArchiveUploads")
      .withIndex("by_runId_and_collectedAt", (q) =>
        q.eq("runId", args.runId).eq("collectedAt", undefined),
      )
      .paginate({ cursor: args.cursor, numItems: 1 });
    const now = Date.now();
    let deleted = 0;
    const intent = page.page[0];
    if (intent) {
      const next = await ctx.db
        .query("coldArchiveUploads")
        .withIndex("by_runId_and_previousId_and_attempt", (q) =>
          q
            .eq("runId", intent.runId)
            .eq("previousId", intent.previousId)
            .gt("attempt", intent.attempt),
        )
        .first();
      const end = next ? next.startedAt + UPLOAD_WINDOW_SLACK : intent.startedAt + UPLOAD_WINDOW;
      if (end + UPLOAD_ORPHAN_GRACE > now)
        return { deleted, pending: 1, isDone: page.isDone, continueCursor: page.continueCursor };
      const cursor =
        intent.scannedThrough === undefined
          ? undefined
          : { through: intent.scannedThrough, seenAtThrough: intent.scannedIdsAtThrough ?? [] };
      const read = await ctx.db.system
        .query("_storage")
        .withIndex("by_creation_time", (q) =>
          q.gte("_creationTime", cursor?.through ?? intent.startedAt).lte("_creationTime", end),
        )
        .take(ORPHAN_SCAN_PAGE + (cursor?.seenAtThrough.length ?? 0));
      const { judge, next: resume } = orphanScanStep(read, cursor);
      for (const blob of judge)
        if (sameBytes(blob, intent) && !(await held(ctx, blob._id))) {
          await ctx.storage.delete(blob._id);
          deleted++;
        }
      if (resume) {
        // More of the window remains: the same attempt again, from this cursor.
        await ctx.db.patch("coldArchiveUploads", intent._id, {
          scannedThrough: resume.through,
          scannedIdsAtThrough: resume.seenAtThrough,
        });
        return { deleted, pending: 0, isDone: false, continueCursor: args.cursor };
      }
      await ctx.db.patch("coldArchiveUploads", intent._id, { collectedAt: now });
    }
    return { deleted, pending: 0, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
