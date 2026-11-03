import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { archiveStatus } from "./lib/coldArchiveCore";
import { patchFiscal, releaseStoredFile } from "./lib/capacityCore";
import { storageHolders } from "./lib/storageHolders";
import { storedRef } from "./lib/documentContentPlan";
import { coldConfig, contentObjectKey, originalObjectKey } from "./lib/coldObjects";
import { fiscalGuardUntil } from "./lib/retentionClasses";

/**
 * ADR 0010, phase C1: the passage of a note's content to the cold tier. The note stays hot for
 * 3 months on Free and 12 on any other plan, or without one, counted from its entry on the
 * platform (`fiscalDocuments.createdAt`) under the plan in force at the sweep. After that, every
 * published version's blob (phase B) moves, byte for byte, to the cold tier's bucket
 * (`lib/coldObjects.ts`) and leaves file storage. The note's row, listing, card and dedup key
 * stay hot, so the listing and the deduplication do not change; readers follow the version's
 * reference to either tier and check the hash (`lib/documentContentRead.ts`). The note's XML
 * originals go with it (decision 8, `noteOriginals`), as the gzip of the raw XML, read through
 * `lib/documentOriginalRead.ts`.
 *
 * Gate: `FNFE_COLD_TIER=enabled` and the bucket configured. Off, nothing runs: `start` and every
 * scheduled step read the gate first and stop. The ADR 0009 package references cold objects by
 * hash; an organization with a note still moving takes no archive run (`coldArchive.eligible`),
 * and the sweep skips one with a run: the passage and a run never meet.
 */
export function coldTierEnabled() {
  return process.env.FNFE_COLD_TIER === "enabled" && coldConfig() !== null;
}

/** A claim older than this is taken again: the action that held it is gone. */
export const CLAIM_TTL = 6 * 60 * 60 * 1000;
/** Readers that selected the hot reference before the passage still find the file this long. */
export const HOT_GRACE = 60 * 60 * 1000;
/** Bounded work per step, and room between steps, so a sweep never bursts calls. */
const STEP_DOCUMENTS = 16;
const MOVE_SPACING_MS = 2_000;
const STEP_SPACING_MS = 60_000;
/** A finished sweep starts the next one this much later. */
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A note with more versions than this stays hot; none is near it. */
export const MAX_VERSIONS = 64;

/** The months a note stays hot: 3 on Free, 12 on any paid or custom plan, and without a plan. */
export async function hotMonths(ctx: Pick<QueryCtx, "db">, organizationId: Id<"organizations">) {
  const plan = await ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  return plan?.catalogTier === "free" ? 3 : 12;
}
/** The same instant `months` calendar months before, in UTC; the day is capped at month end. */
export function monthsBefore(now: number, months: number) {
  const date = new Date(now);
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1, 0, 0, 0, 0),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  target.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
  return target.getTime() + date.getUTCMilliseconds();
}

/**
 * The window rule, in one place for the sweep and the rehydration (ADR 0010, decisions 3 and 5):
 * a note whose entry on the platform (`fiscalDocuments.createdAt`) is before this instant is
 * outside the hot window of the organization's plan in force at `now`.
 */
export async function hotWindowCutoff(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
  now: number,
) {
  return monthsBefore(now, await hotMonths(ctx, organizationId));
}

/** Whether the organization has an active legal hold, which keeps its notes hot (pending 6). */
export async function legalHoldActive(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
) {
  // Every hold is read, as the fiscal guard does: one active hold anywhere keeps the notes hot.
  for await (const hold of ctx.db
    .query("retentionHolds")
    .withIndex("by_organizationId_and_reference", (q) => q.eq("organizationId", organizationId)))
    if (hold.releasedAt === undefined) return true;
  return false;
}

/**
 * Why an organization's notes stay hot now, or `null`. An archive run of ADR 0009 in any state
 * but `hot` (the passage and a run never meet), or an active legal hold: a hold forbids moving
 * to the cold tier (ADR 0010, pending 6, decided on 02/11/2026). The one exception is the run
 * `rehydration` itself in its cold stage (ADR 0010, C2): the passage it drives is the rehydration's
 * own step, never the sweep's, which passes no run.
 */
export async function organizationBlock(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
  rehydration?: Id<"coldArchiveRuns">,
) {
  const run = await archiveStatus(ctx, organizationId);
  if (
    run &&
    run.state !== "hot" &&
    !(
      rehydration !== undefined &&
      run._id === rehydration &&
      run.state === "restoring" &&
      run.rehydration?.stage === "cold"
    )
  )
    return "archive";
  return (await legalHoldActive(ctx, organizationId)) ? "legalHold" : null;
}

/** Whether an organization has a note on its way to the cold tier: no archive run takes it. */
export async function hasMovingNotes(
  ctx: Pick<QueryCtx, "db">,
  organizationId: Id<"organizations">,
) {
  return !!(await ctx.db
    .query("fiscalDocuments")
    .withIndex("by_organizationId_and_coldState", (q) =>
      q.eq("organizationId", organizationId).eq("coldState", "moving"),
    )
    .first());
}

/**
 * Starts a sweep, unless one is alive. The operator runs it once after turning the gate on
 * (`npx convex run coldTier:start`); each finished sweep schedules the next one a day later, so
 * the passage runs daily with no cron registered (the release smoke requires zero crons). With
 * the gate off, it returns without scheduling anything, and the chain ends.
 */
export const start = internalMutation({
  args: {},
  returns: v.union(v.literal("disabled"), v.literal("running"), v.literal("started")),
  handler: async (ctx) => {
    if (!coldTierEnabled()) return "disabled";
    const now = Date.now();
    const sweep = await ctx.db.query("coldTierSweeps").first();
    if (sweep?.state === "running" && sweep.updatedAt > now - CLAIM_TTL) return "running";
    // One chain only: a manual start replaces the next sweep already scheduled.
    if (sweep?.next) await ctx.scheduler.cancel(sweep.next);
    const generation = (sweep?.generation ?? 0) + 1;
    const fields = {
      generation,
      state: "running" as const,
      phase: 0,
      cursor: null,
      counts: {},
      startedAt: now,
      updatedAt: now,
    };
    if (sweep) await ctx.db.replace("coldTierSweeps", sweep._id, fields);
    else await ctx.db.insert("coldTierSweeps", fields);
    await ctx.scheduler.runAfter(0, internal.coldTier.step, { generation, phase: 0, cursor: null });
    if (
      (await ctx.db.query("coldObjectDeletions").first()) ||
      (await ctx.db
        .query("coldObjectUploads")
        .withIndex("by_retryAt", (q) => q.lt("retryAt", now))
        .first())
    )
      await ctx.scheduler.runAfter(0, internal.coldTierWorker.collect, {});
    return "started";
  },
});

/**
 * One page of the sweep. Phase 0 takes back stale claims; phase 1 reads the hot notes older than
 * the shortest window (3 months), oldest first, so a sweep goes over each of them once. A note
 * whose organization keeps it hot, or that cannot move yet, is left as it is and read again by
 * the next sweep.
 */
export const step = internalMutation({
  args: { generation: v.number(), phase: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sweep = await ctx.db.query("coldTierSweeps").first();
    if (
      !sweep ||
      sweep.generation !== args.generation ||
      sweep.state !== "running" ||
      sweep.phase !== args.phase ||
      sweep.cursor !== args.cursor ||
      !coldTierEnabled()
    )
      return null;
    const now = Date.now();
    const counts = { ...sweep.counts };
    const add = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
    const state = args.phase === 0 ? ("moving" as const) : undefined;
    const page = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_coldState_and_createdAt", (q) =>
        q.eq("coldState", state).lt("createdAt", monthsBefore(now, 3)),
      )
      .paginate({ cursor: args.cursor, numItems: STEP_DOCUMENTS });
    const verdicts = new Map<Id<"organizations">, { block: string | null; cutoff: number }>();
    let moves = 0;
    for (const doc of page.page) {
      if (doc.direction !== undefined) continue;
      if (state === "moving" && (doc.coldClaimedAt ?? 0) > now - CLAIM_TTL) continue;
      let verdict = verdicts.get(doc.organizationId);
      if (!verdict) {
        verdict = {
          block: await organizationBlock(ctx, doc.organizationId),
          cutoff: await hotWindowCutoff(ctx, doc.organizationId, now),
        };
        verdicts.set(doc.organizationId, verdict);
      }
      if (verdict.block) {
        add(verdict.block);
        continue;
      }
      if (doc.createdAt >= verdict.cutoff) {
        add("hotWindow");
        continue;
      }
      await patchFiscal(
        ctx,
        "fiscalDocuments",
        doc._id,
        { coldState: "moving", coldClaimedAt: now },
        false,
      );
      await ctx.scheduler.runAfter(moves++ * MOVE_SPACING_MS, internal.coldTierWorker.move, {
        documentId: doc._id,
        claimedAt: now,
      });
      add("claimed");
    }
    const next = page.isDone
      ? args.phase === 0
        ? { phase: 1, cursor: null }
        : null
      : { phase: args.phase, cursor: page.continueCursor };
    await ctx.db.patch("coldTierSweeps", sweep._id, {
      counts,
      phase: next?.phase ?? args.phase,
      cursor: next?.cursor ?? null,
      updatedAt: now,
      ...(next
        ? {}
        : {
            state: "done" as const,
            next: await ctx.scheduler.runAfter(SWEEP_INTERVAL_MS, internal.coldTier.start, {}),
          }),
    });
    if (next)
      await ctx.scheduler.runAfter(
        Math.max(STEP_SPACING_MS, moves * MOVE_SPACING_MS),
        internal.coldTier.step,
        { generation: args.generation, ...next },
      );
    return null;
  },
});

/**
 * The last guard year whose lock rule the operator confirmed in the bucket
 * (`FNFE_COLD_LOCKED_THROUGH`, written after `scripts/cold-tier-locks.mjs`). A Production note
 * whose guard ends later stays hot: no object goes to the bucket without its lock.
 */
export function lockedThrough() {
  const value = Number(process.env.FNFE_COLD_LOCKED_THROUGH);
  return Number.isSafeInteger(value) && value > 2000 ? value : null;
}
/**
 * Where a version's object goes. The guard of a Production note ends on 31/12 of the fifth year
 * after its fact (D01): the version's issue date from its card or, without one, the note's entry,
 * which is later and so never locks for less.
 */
export function objectPlace(doc: Doc<"fiscalDocuments">, version: Doc<"documentVersions">) {
  if (version.contentSha256 === undefined) return null;
  const guardYear = guardYearOf(doc, version);
  return {
    guardYear,
    key: contentObjectKey({
      environment: doc.environment,
      guardYear,
      organizationId: doc.organizationId,
      versionId: version._id,
      contentSha256: version.contentSha256,
    }),
  };
}
export function guardYearOf(doc: Doc<"fiscalDocuments">, version: Doc<"documentVersions">) {
  if (doc.environment !== "production") return null;
  const issued = Date.parse(version.card?.issuedAt ?? "");
  const fact = Number.isFinite(issued) ? issued : doc.createdAt;
  return new Date(fiscalGuardUntil(fact)).getUTCFullYear() - 1;
}
/** Whether an object of this guard year must wait for its lock rule (`lockedThrough`). */
function lockPending(guardYear: number | null) {
  const locked = lockedThrough();
  return guardYear !== null && (locked === null || guardYear > locked);
}

/**
 * The XML originals that go cold with a note (ADR 0010, decision 8), each with the key it takes.
 * `movePlan`, `attachOriginal`, `finish` and `giveBack` all read this one rule, so they agree on
 * what "the note is cold" means. An original goes when it is the note's own:
 *
 * - an artifact named by a version of the note, whose `documentId` is the note;
 * - not an entry of an NFS-e batch (`parentArtifactId`), whose file is the batch's, nor the batch
 *   (or any container) itself, which has no `documentId`;
 * - read by no version of another document (`by_artifactId`). The import and the reprocessing
 *   always stage a version for the document the artifact names, so none exists today; the check
 *   keeps the rule true if that ever changes;
 * - while hot, its file held by no other row than the artifact and its own import file
 *   (`storageHolders`): a shared file would stay in storage anyway.
 *
 * Any other artifact simply stays hot and never blocks the note. The guard year is the latest of
 * the versions that read the original, so its lock lasts at least as long as theirs.
 */
export async function noteOriginals(
  ctx: QueryCtx,
  doc: Doc<"fiscalDocuments">,
  versions: Doc<"documentVersions">[],
) {
  const out = [];
  for (const artifactId of new Set(versions.map((version) => version.artifactId))) {
    const artifact = await ctx.db.get("documentArtifacts", artifactId);
    if (
      !artifact ||
      artifact.documentId !== doc._id ||
      artifact.organizationId !== doc.organizationId ||
      artifact.parentArtifactId !== undefined
    )
      continue;
    const readers = await ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .take(MAX_VERSIONS + 1);
    if (
      readers.length > MAX_VERSIONS ||
      readers.some((reader) => reader.documentId !== undefined && reader.documentId !== doc._id)
    )
      continue;
    if (artifact.objectKey === undefined) {
      if (artifact.storageId === undefined) continue;
      if (!(await soleHolder(ctx, artifact, artifact.storageId))) continue;
    }
    let guardYear: number | null = null;
    for (const reader of readers) {
      const year = guardYearOf(doc, reader);
      if (year !== null) guardYear = Math.max(guardYear ?? year, year);
    }
    out.push({
      artifact,
      guardYear,
      key: originalObjectKey({
        environment: doc.environment,
        guardYear,
        organizationId: doc.organizationId,
        artifactId: artifact._id,
        sha256: artifact.sha256,
      }),
    });
  }
  return out;
}
/** Whether only the artifact, its import file and the capacity inventory hold its stored file. */
async function soleHolder(
  ctx: QueryCtx,
  artifact: Doc<"documentArtifacts">,
  storageId: Id<"_storage">,
) {
  for (const { table, query } of storageHolders(ctx, storageId)) {
    if (table === "capacityFiles") continue;
    for (const row of await query.take(2)) {
      if (table === "documentArtifacts" && row._id === artifact._id) continue;
      if (table === "importFiles" && row._id === artifact.fileId) continue;
      return false;
    }
  }
  return true;
}

async function claimed(
  ctx: Pick<QueryCtx, "db">,
  documentId: Id<"fiscalDocuments">,
  claimedAt: number,
) {
  const doc = await ctx.db.get("fiscalDocuments", documentId);
  return doc?.coldState === "moving" && doc.coldClaimedAt === claimedAt ? doc : null;
}
async function documentVersions(ctx: Pick<QueryCtx, "db">, documentId: Id<"fiscalDocuments">) {
  return ctx.db
    .query("documentVersions")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .take(MAX_VERSIONS + 1);
}

const moveVersion = v.object({
  versionId: v.id("documentVersions"),
  objectKey: v.string(),
  storageId: v.id("_storage"),
  contentSha256: v.string(),
  contentSize: v.number(),
  format: v.string(),
});
const moveOriginal = v.object({
  artifactId: v.id("documentArtifacts"),
  objectKey: v.string(),
  storageId: v.id("_storage"),
  sha256: v.string(),
  size: v.number(),
});
/**
 * The rehydration run whose cold stage drives a passage (ADR 0010, C2), or absent for the sweep's.
 * With it, the note's organization may be `restoring` in that run, the writes are tracked as the
 * rehydration's inventory, and each hot file leaves storage at once: no reader selected it, since
 * admissions and reads stay refused until the run is back to `hot`.
 */
const rehydrationRun = v.optional(v.id("coldArchiveRuns"));
type Ready = {
  state: "ready";
  versions: Array<{
    versionId: Id<"documentVersions">;
    objectKey: string;
    storageId: Id<"_storage">;
    contentSha256: string;
    contentSize: number;
    format: string;
  }>;
  originals: Array<{
    artifactId: Id<"documentArtifacts">;
    objectKey: string;
    storageId: Id<"_storage">;
    sha256: string;
    size: number;
  }>;
};

/**
 * What a passage of the note would move, from its rows alone: every published version with a
 * verified hot blob, then the note's hot XML originals (`noteOriginals`). A note with a version in
 * flight, published without a blob or with a blob not yet verified (B7), with no published version,
 * or with an object whose guard year has no confirmed lock rule (`lockPending`) is skipped and
 * stays hot. The sweep's `movePlan` and the rehydration's cold stage both read this one rule.
 */
export async function notePlan(
  ctx: QueryCtx,
  doc: Doc<"fiscalDocuments">,
): Promise<{ state: "skip"; reason: string } | Ready> {
  const skip = (reason: string) => ({ state: "skip" as const, reason });
  const versions = await documentVersions(ctx, doc._id);
  if (versions.length > MAX_VERSIONS) return skip("versions");
  const hot: Ready["versions"] = [];
  let published = 0;
  for (const version of versions) {
    if (version.state === "staging") return skip("staging");
    if (version.publishedAt === undefined) continue;
    published++;
    let ref;
    try {
      ref = storedRef(version);
    } catch {
      return skip("corrupt");
    }
    if (!ref) return skip("inlineOnly");
    if ("objectKey" in ref) continue;
    if (version.contentVerifiedAt === undefined) return skip("unverified");
    const place = objectPlace(doc, version);
    if (!place) return skip("corrupt");
    if (lockPending(place.guardYear)) return skip("lockPending");
    hot.push({
      versionId: version._id,
      objectKey: place.key,
      storageId: ref.storageId,
      contentSha256: ref.contentSha256,
      contentSize: ref.contentSize,
      format: ref.format,
    });
  }
  // Without a published version the note never turns cold (`finish`): nothing to claim.
  if (published === 0) return skip("unpublished");
  const originals: Ready["originals"] = [];
  for (const original of await noteOriginals(ctx, doc, versions)) {
    const { artifact } = original;
    if (artifact.objectKey !== undefined || artifact.storageId === undefined) continue;
    if (lockPending(original.guardYear)) return skip("lockPending");
    originals.push({
      artifactId: artifact._id,
      objectKey: original.key,
      storageId: artifact.storageId,
      sha256: artifact.sha256,
      size: artifact.size,
    });
  }
  return { state: "ready", versions: hot, originals };
}

/** What the action moves for a claimed note: `notePlan`, under the gate and the claim. */
export const movePlan = internalQuery({
  args: { documentId: v.id("fiscalDocuments"), claimedAt: v.number(), runId: rehydrationRun },
  returns: v.union(
    v.object({ state: v.literal("skip"), reason: v.string() }),
    v.object({
      state: v.literal("ready"),
      organizationId: v.id("organizations"),
      versions: v.array(moveVersion),
      originals: v.array(moveOriginal),
    }),
  ),
  handler: async (ctx, args) => {
    const skip = (reason: string) => ({ state: "skip" as const, reason });
    if (!coldTierEnabled()) return skip("disabled");
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc) return skip("claim");
    const block = await organizationBlock(ctx, doc.organizationId, args.runId);
    if (block) return skip(block);
    const plan = await notePlan(ctx, doc);
    if (plan.state === "skip") return plan;
    return { ...plan, organizationId: doc.organizationId };
  },
});

/**
 * The rehydration's intent of the file a passage just moved (ADR 0010, C2): every file of a
 * rehydrated note came back through one (`coldArchiveRehydration.beginUpload`). `null` when the
 * file is not this run's, and the attach is refused.
 */
async function rehydratedUpload(
  ctx: MutationCtx,
  runId: Id<"coldArchiveRuns">,
  storageId: Id<"_storage">,
) {
  for (const intent of await ctx.db
    .query("coldArchiveUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .take(8))
    if (intent.runId === runId) return intent;
  return null;
}

/**
 * Points one version at its object in the bucket, which the action wrote and read back with the
 * same bytes. The hot file stays for `HOT_GRACE`, for readers that selected it before; in a
 * rehydration it leaves at once, and the run's intent records where it went, so the canonical
 * check can map the version back to the package's form.
 */
export const attach = internalMutation({
  args: {
    documentId: v.id("fiscalDocuments"),
    claimedAt: v.number(),
    runId: rehydrationRun,
    versionId: v.id("documentVersions"),
    storageId: v.id("_storage"),
    objectKey: v.string(),
    objectSha256: v.string(),
    objectSize: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!coldTierEnabled()) return false;
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc || (await organizationBlock(ctx, doc.organizationId, args.runId))) return false;
    const version = await ctx.db.get("documentVersions", args.versionId);
    if (
      !version ||
      version.documentId !== doc._id ||
      version.contentStorageId !== args.storageId ||
      version.contentObjectKey !== undefined ||
      version.contentSha256 === undefined ||
      !/^[a-f0-9]{64}$/.test(args.objectSha256) ||
      !Number.isSafeInteger(args.objectSize) ||
      args.objectSize <= 0 ||
      args.objectKey !== objectPlace(doc, version)?.key
    )
      return false;
    const upload = args.runId ? await rehydratedUpload(ctx, args.runId, args.storageId) : null;
    if (args.runId && !upload) return false;
    await patchFiscal(
      ctx,
      "documentVersions",
      version._id,
      {
        contentStorageId: undefined,
        contentObjectKey: args.objectKey,
        contentObjectSha256: args.objectSha256,
        contentObjectSize: args.objectSize,
      },
      false,
      !!args.runId,
    );
    await settleIntent(ctx, args.objectKey);
    if (upload) {
      await ctx.db.patch("coldArchiveUploads", upload._id, {
        objectKey: args.objectKey,
        objectSha256: args.objectSha256,
        objectSize: args.objectSize,
      });
      await dropHotFile(ctx, doc.organizationId, args.storageId);
    } else
      await ctx.scheduler.runAfter(HOT_GRACE, internal.coldTier.dropHot, {
        organizationId: doc.organizationId,
        storageId: args.storageId,
      });
    return true;
  },
});

/** The passage's own intent of an object goes once a row points at its key. */
async function settleIntent(ctx: MutationCtx, objectKey: string) {
  const intent = await ctx.db
    .query("coldObjectUploads")
    .withIndex("by_objectKey", (q) => q.eq("objectKey", objectKey))
    .unique();
  if (intent) await ctx.db.delete("coldObjectUploads", intent._id);
}

/**
 * Points one XML original at its object in the bucket (ADR 0010, decision 8): the gzip of the raw
 * XML, which the action wrote, read back and checked against `artifact.sha256`. Same checks as
 * `attach`, and the original must still be one the note takes (`noteOriginals`), under the same
 * key. The import file of an imported XML holds the same stored file; it lets go of it here, so
 * the file leaves storage after `HOT_GRACE` like a version's blob (at once in a rehydration, with
 * the import file recorded on the run's intent for the canonical check).
 */
export const attachOriginal = internalMutation({
  args: {
    documentId: v.id("fiscalDocuments"),
    claimedAt: v.number(),
    runId: rehydrationRun,
    artifactId: v.id("documentArtifacts"),
    storageId: v.id("_storage"),
    objectKey: v.string(),
    objectSha256: v.string(),
    objectSize: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!coldTierEnabled()) return false;
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc || (await organizationBlock(ctx, doc.organizationId, args.runId))) return false;
    const versions = await documentVersions(ctx, doc._id);
    if (versions.length > MAX_VERSIONS) return false;
    const original = (await noteOriginals(ctx, doc, versions)).find(
      (entry) => entry.artifact._id === args.artifactId,
    );
    const artifact = original?.artifact;
    if (
      !original ||
      !artifact ||
      artifact.storageId !== args.storageId ||
      artifact.objectKey !== undefined ||
      !/^[a-f0-9]{64}$/.test(args.objectSha256) ||
      !Number.isSafeInteger(args.objectSize) ||
      args.objectSize <= 0 ||
      args.objectKey !== original.key ||
      lockPending(original.guardYear)
    )
      return false;
    const upload = args.runId ? await rehydratedUpload(ctx, args.runId, args.storageId) : null;
    if (args.runId && !upload) return false;
    await patchFiscal(
      ctx,
      "documentArtifacts",
      artifact._id,
      {
        storageId: undefined,
        objectKey: args.objectKey,
        objectSha256: args.objectSha256,
        objectSize: args.objectSize,
      },
      false,
      !!args.runId,
    );
    const file = artifact.fileId ? await ctx.db.get("importFiles", artifact.fileId) : null;
    const released = file?.storageId === args.storageId;
    if (released) await ctx.db.patch("importFiles", file._id, { storageId: undefined });
    await settleIntent(ctx, args.objectKey);
    if (upload) {
      await ctx.db.patch("coldArchiveUploads", upload._id, {
        objectKey: args.objectKey,
        objectSha256: args.objectSha256,
        objectSize: args.objectSize,
        ...(released ? { importFileId: file._id } : {}),
      });
      await dropHotFile(ctx, doc.organizationId, args.storageId);
    } else
      await ctx.scheduler.runAfter(HOT_GRACE, internal.coldTier.dropHot, {
        organizationId: doc.organizationId,
        storageId: args.storageId,
      });
    return true;
  },
});

/**
 * Ends a claim: the note is cold when every published version and every original it takes
 * (`noteOriginals`) are; otherwise it waits. A note that turns cold drops its DANFE cache: the
 * PDF is rendered again from the cold original on the next download.
 */
export const finish = internalMutation({
  args: { documentId: v.id("fiscalDocuments"), claimedAt: v.number(), runId: rehydrationRun },
  returns: v.union(v.literal("cold"), v.literal("released"), v.literal("stale")),
  handler: async (ctx, args) => {
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc) return "stale";
    const restoring = args.runId !== undefined;
    const versions = await documentVersions(ctx, doc._id);
    const published = versions.filter((version) => version.publishedAt !== undefined);
    const cold = published.filter((version) => version.contentObjectKey !== undefined);
    const originals =
      versions.length <= MAX_VERSIONS ? await noteOriginals(ctx, doc, versions) : [];
    const coldOriginals = originals.filter((entry) => entry.artifact.objectKey !== undefined);
    if (
      versions.length <= MAX_VERSIONS &&
      published.length > 0 &&
      cold.length === published.length &&
      coldOriginals.length === originals.length
    ) {
      await patchFiscal(
        ctx,
        "fiscalDocuments",
        doc._id,
        { coldState: "cold", coldAt: Date.now(), coldClaimedAt: undefined },
        false,
        restoring,
      );
      await dropDanfeCache(ctx, doc);
      return "cold";
    }
    await release(ctx, doc, cold.length > 0 || coldOriginals.length > 0, restoring);
    return "released";
  },
});

/**
 * Gives a claim back. A note with a version or an original already cold stays `moving`, retried
 * after the TTL (in a rehydration, by the cold stage's next step).
 */
export const giveBack = internalMutation({
  args: { documentId: v.id("fiscalDocuments"), claimedAt: v.number(), runId: rehydrationRun },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc) return null;
    const versions = await documentVersions(ctx, doc._id);
    await release(
      ctx,
      doc,
      versions.some((version) => version.contentObjectKey !== undefined) ||
        (versions.length <= MAX_VERSIONS &&
          (await noteOriginals(ctx, doc, versions)).some(
            (entry) => entry.artifact.objectKey !== undefined,
          )),
      args.runId !== undefined,
    );
    return null;
  },
});

/**
 * The DANFE cache of a note that turned cold: the row and, after `HOT_GRACE` (`dropHot`, which
 * releases its capacity), the PDF. A remembered refusal has no file and stays, so a cold note is
 * not rendered again only to be refused.
 */
async function dropDanfeCache(ctx: MutationCtx, doc: Doc<"fiscalDocuments">) {
  const row = await ctx.db
    .query("documentDanfes")
    .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
    .unique();
  if (!row?.storageId) return;
  await ctx.db.delete("documentDanfes", row._id);
  await ctx.scheduler.runAfter(HOT_GRACE, internal.coldTier.dropHot, {
    organizationId: doc.organizationId,
    storageId: row.storageId,
  });
}
async function release(
  ctx: MutationCtx,
  doc: Doc<"fiscalDocuments">,
  partlyCold: boolean,
  restoring = false,
) {
  // Partly cold: still `moving`, so no archive run takes the organization, and the claim is
  // stale for phase 0 of the next sweep.
  await patchFiscal(
    ctx,
    "fiscalDocuments",
    doc._id,
    partlyCold
      ? { coldClaimedAt: 0, coldAt: undefined }
      : { coldState: undefined, coldClaimedAt: undefined, coldAt: undefined },
    false,
    restoring,
  );
}

/**
 * Deletes a hot file once no row holds it any more and releases its capacity row; any other
 * holder keeps the file.
 */
async function dropHotFile(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  storageId: Id<"_storage">,
) {
  for (const { table, query } of storageHolders(ctx, storageId))
    if (table !== "capacityFiles" && (await query.take(1)).length) return;
  if (await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId);
  await releaseStoredFile(ctx, organizationId, storageId);
}

/** Deletes the hot file of a moved version once no row holds it any more. */
export const dropHot = internalMutation({
  args: { organizationId: v.id("organizations"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await dropHotFile(ctx, args.organizationId, args.storageId);
    return null;
  },
});

/**
 * A new blob attached to a version of a cold note (a later event or the full XML after the
 * summary): the note goes back to `moving` with a stale claim, so the next sweep moves the new
 * version too, and no archive run takes the organization meanwhile.
 */
export async function reopenColdNote(ctx: MutationCtx, documentId: Id<"fiscalDocuments">) {
  const doc = await ctx.db.get("fiscalDocuments", documentId);
  if (doc?.coldState === "cold")
    await patchFiscal(
      ctx,
      "fiscalDocuments",
      doc._id,
      { coldState: "moving", coldClaimedAt: 0, coldAt: undefined },
      false,
    );
}

/**
 * An intent older than this, with no version or original on its key, is an orphan of a lost
 * action.
 */
export const ORPHAN_AFTER = 24 * 60 * 60 * 1000;
/** Until when the bucket's lock keeps a key: the end of its guard year, or none (Sandbox). */
export function keyLockedUntil(key: string) {
  const match = /^documents\/production\/guard-(\d{4})\//.exec(key);
  return match ? Date.UTC(Number(match[1]) + 1, 0, 1, 3) : 0;
}

/**
 * Records the object a claimed passage is about to write, before the write. Refused while the
 * collection deletes the same key, so a deletion never races an upload.
 */
export const intend = internalMutation({
  args: { documentId: v.id("fiscalDocuments"), claimedAt: v.number(), objectKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await claimed(ctx, args.documentId, args.claimedAt);
    if (!doc || !args.objectKey.startsWith("documents/")) return false;
    const intent = await ctx.db
      .query("coldObjectUploads")
      .withIndex("by_objectKey", (q) => q.eq("objectKey", args.objectKey))
      .unique();
    const retryAt = Date.now() + ORPHAN_AFTER;
    if (intent?.collecting) return false;
    if (intent) await ctx.db.patch("coldObjectUploads", intent._id, { retryAt });
    else
      await ctx.db.insert("coldObjectUploads", {
        organizationId: doc.organizationId,
        objectKey: args.objectKey,
        retryAt,
      });
    return true;
  },
});

/**
 * Takes the next orphan candidates for deletion: intents past `retryAt`. One whose key a version
 * or an original (`documentArtifacts.objectKey`) holds is simply dropped; one still under the
 * bucket's lock waits for the lock's end; the rest are fenced (`collecting`) and returned.
 */
export const orphans = internalMutation({
  args: {},
  returns: v.array(v.object({ id: v.id("coldObjectUploads"), objectKey: v.string() })),
  handler: async (ctx) => {
    const now = Date.now();
    const out = [];
    for (const intent of await ctx.db
      .query("coldObjectUploads")
      .withIndex("by_retryAt", (q) => q.lt("retryAt", now))
      .take(32)) {
      const held =
        (await ctx.db
          .query("documentVersions")
          .withIndex("by_contentObjectKey", (q) => q.eq("contentObjectKey", intent.objectKey))
          .first()) ??
        (await ctx.db
          .query("documentArtifacts")
          .withIndex("by_objectKey", (q) => q.eq("objectKey", intent.objectKey))
          .first());
      if (held) {
        await ctx.db.delete("coldObjectUploads", intent._id);
        continue;
      }
      const lockedUntil = keyLockedUntil(intent.objectKey);
      if (lockedUntil > now) {
        await ctx.db.patch("coldObjectUploads", intent._id, { retryAt: lockedUntil });
        continue;
      }
      await ctx.db.patch("coldObjectUploads", intent._id, { collecting: true, retryAt: now });
      out.push({ id: intent._id, objectKey: intent.objectKey });
    }
    return out;
  },
});
/** Ends a collected intent once its object is gone, or puts it back for later after a failure. */
export const orphanDone = internalMutation({
  args: { id: v.id("coldObjectUploads"), deleted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get("coldObjectUploads", args.id);
    if (!intent) return null;
    if (args.deleted) await ctx.db.delete("coldObjectUploads", intent._id);
    else
      await ctx.db.patch("coldObjectUploads", intent._id, {
        collecting: undefined,
        retryAt: Date.now() + ORPHAN_AFTER,
      });
    return null;
  },
});

/** The queued deletions of the bucket, a page at a time (`coldTierWorker.collect`). */
export const deletions = internalQuery({
  args: {},
  returns: v.array(v.object({ id: v.id("coldObjectDeletions"), objectKey: v.string() })),
  handler: async (ctx) =>
    (await ctx.db.query("coldObjectDeletions").withIndex("by_requestedAt").take(32)).map((row) => ({
      id: row._id,
      objectKey: row.objectKey,
    })),
});
export const deleted = internalMutation({
  args: { id: v.id("coldObjectDeletions"), failed: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("coldObjectDeletions", args.id);
    if (!row) return null;
    // A deletion the bucket refused (a lock still in force) goes to the end of the queue.
    if (args.failed)
      await ctx.db.patch("coldObjectDeletions", row._id, {
        requestedAt: Math.max(Date.now(), keyLockedUntil(row.objectKey)),
      });
    else await ctx.db.delete("coldObjectDeletions", row._id);
    return null;
  },
});
