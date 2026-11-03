import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { patchFiscal } from "./lib/capacityCore";
import { cardOf } from "./lib/documentCore";
import { storedRef } from "./lib/documentContentPlan";
import { inlineContentRef, scheduleVersionContent } from "./lib/documentContentWriter";
import { clearInlineContent, markVerified } from "./lib/documentContentCleanup";

/**
 * Phase B migration of ADR 0010 (B7), run once per deployment after the release, each kind with
 * `contentMigration:start` and watched with `contentMigration:status`:
 *
 * - `backfill` walks every version and queues the B4 writer (`importProcessing.storeContent`)
 *   for each published version without a blob. Over the cap or with item gaps, the writer leaves
 *   it inline, a normal state. It also rewrites a card written before B5, which lacks
 *   `cancellation` on an event.
 * - `audit` (`contentMigrationNode.auditStep`) reads every blob back through the codec and
 *   compares its hash with the hash of the inline content encoded now. Equal, the version gets
 *   `contentVerifiedAt`, the only versions B8 may clear.
 *
 * Each step is one bounded transaction that records its cursor and counts and schedules the next
 * step in the same commit. A run that stopped (a failed step, a deploy) resumes from its cursor
 * with `start` again; `restart` begins at the first version. Nothing here deletes data.
 */
const kind = v.union(v.literal("backfill"), v.literal("audit"), v.literal("cleanup"));
type Kind = Doc<"contentMigrations">["kind"];
const BACKFILL_PAGE = 50;
/**
 * The time each queued writer is given before the next page, so the scan never runs far ahead of
 * the content pool (`scheduleVersionContent`), which runs two writers at a time.
 */
const WRITER_SPACING_MS = 250;

/** The run a step belongs to: still running, of its generation and at its cursor. */
async function stepRun(ctx: QueryCtx, kind: Kind, generation: number, from: string | null) {
  const run = await runOf(ctx, kind);
  return run?.state === "running" && run.generation === generation && run.cursor === from
    ? run
    : null;
}
async function runOf(ctx: QueryCtx, kind: Kind) {
  return ctx.db
    .query("contentMigrations")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .unique();
}

/** Starts or resumes a run. A finished run starts again only with `restart`. */
export const start = internalMutation({
  args: { kind, restart: v.optional(v.boolean()) },
  returns: v.object({ state: v.string(), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let run = await runOf(ctx, args.kind);
    if (args.kind === "cleanup") await requireAudited(ctx);
    if (run?.state === "done" && !args.restart) return { state: "done", cursor: run.cursor };
    const generation = (run?.generation ?? 0) + 1;
    if (!run || args.restart) {
      if (run) await ctx.db.delete("contentMigrations", run._id);
      const id = await ctx.db.insert("contentMigrations", {
        kind: args.kind,
        state: "running",
        generation,
        cursor: null,
        counts: {},
        startedAt: now,
        updatedAt: now,
      });
      run = (await ctx.db.get("contentMigrations", id))!;
    } else
      await ctx.db.patch("contentMigrations", run._id, {
        state: "running",
        generation,
        error: undefined,
        updatedAt: now,
      });
    await scheduleStep(ctx, run.kind, run.cursor, generation);
    return { state: "running", cursor: run.cursor };
  },
});

async function scheduleStep(
  ctx: MutationCtx,
  kind: Kind,
  cursor: string | null,
  generation: number,
  delay = 0,
) {
  const args = { cursor, generation };
  if (kind === "backfill")
    await ctx.scheduler.runAfter(delay, internal.contentMigration.backfillStep, args);
  else if (kind === "audit")
    await ctx.scheduler.runAfter(delay, internal.contentMigrationNode.auditStep, args);
  else await ctx.scheduler.runAfter(delay, internal.contentMigration.cleanupStep, args);
}

/**
 * Records a step's cursor and counts and schedules the next, only if the run is still at `from`:
 * a step repeated or overtaken changes nothing, so two chains never run side by side.
 */
export async function advance(
  ctx: MutationCtx,
  args: {
    kind: Kind;
    generation: number;
    from: string | null;
    cursor: string;
    isDone: boolean;
    counts: Record<string, number>;
    delay?: number;
  },
) {
  const run = await stepRun(ctx, args.kind, args.generation, args.from);
  if (!run) return false;
  const counts = { ...run.counts };
  for (const [name, value] of Object.entries(args.counts))
    counts[name] = (counts[name] ?? 0) + value;
  const now = Date.now();
  await ctx.db.patch("contentMigrations", run._id, {
    cursor: args.cursor,
    counts,
    updatedAt: now,
    ...(args.isDone ? { state: "done" as const, finishedAt: now } : {}),
  });
  if (!args.isDone)
    await scheduleStep(ctx, args.kind, args.cursor, args.generation, args.delay ?? 0);
  return true;
}

const stepArgs = { cursor: v.union(v.string(), v.null()), generation: v.number() };
export const backfillStep = internalMutation({
  args: stepArgs,
  returns: v.null(),
  handler: async (ctx, { cursor, generation }) => {
    if (!(await stepRun(ctx, "backfill", generation, cursor))) return null;
    const page = await ctx.db.query("documentVersions").paginate({
      cursor,
      numItems: BACKFILL_PAGE,
      maximumBytesRead: 4 * 1024 * 1024,
    });
    const counts: Record<string, number> = { scanned: page.page.length };
    let scheduled = 0;
    const add = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
    for (const version of page.page) {
      if (version.state !== "complete" || version.publishedAt === undefined) {
        add("unpublished");
        continue;
      }
      let ref: ReturnType<typeof storedRef>;
      try {
        ref = storedRef(version);
      } catch {
        // A partial reference: counted, never written over; the audit blocks B8 on it.
        add("corrupt");
        continue;
      }
      if (!ref) {
        // The writer stores and attaches the blob, or leaves the version inline with a reason.
        await scheduleVersionContent(ctx, version._id);
        scheduled++;
        add("scheduled");
        continue;
      }
      add("withBlob");
      // A card written before B5 has no `cancellation` on an event (`documentDanfe.ts`).
      if (
        version.kind === "event" &&
        version.card &&
        version.card.cancellation === undefined &&
        version.result !== undefined &&
        version.documentId
      ) {
        const doc = await ctx.db.get("fiscalDocuments", version.documentId);
        if (doc) {
          await patchFiscal(ctx, "documentVersions", version._id, { card: cardOf(doc, version) });
          add("cardRefreshed");
        }
      }
    }
    await advance(ctx, {
      kind: "backfill",
      generation,
      from: cursor,
      cursor: page.continueCursor,
      isDone: page.isDone,
      counts,
      // The next page waits for this page's writers, so the scan never runs far ahead.
      delay: scheduled * WRITER_SPACING_MS,
    });
    return null;
  },
});

/**
 * One version per cleanup step: it re-reads the whole inline content (up to the cap) to compare it
 * with the blob, and deletes up to its item rows (990 in an NF-e).
 */
const CLEANUP_PAGE = 1;
/**
 * B8: removes the inline copy of every verified version (`clearInlineContent`). Counts each
 * outcome: `cleared`, `already`, and the versions that keep it, `noBlob` (a normal state),
 * `changed` (the inline content no longer equals the blob: audit again), `corrupt`,
 * `unverified` (written or attached after the audit, verified by the next audit or by the
 * writer's own read-back) and `cardPending` (an event card from before B5: run `backfill`).
 */
export const cleanupStep = internalMutation({
  args: stepArgs,
  returns: v.null(),
  handler: async (ctx, { cursor, generation }) => {
    if (!(await stepRun(ctx, "cleanup", generation, cursor))) return null;
    const page = await ctx.db.query("documentVersions").paginate({
      cursor,
      numItems: CLEANUP_PAGE,
      maximumBytesRead: 4 * 1024 * 1024,
    });
    const counts: Record<string, number> = { scanned: page.page.length };
    for (const version of page.page) {
      const outcome =
        version.state === "complete" && version.publishedAt !== undefined
          ? await clearInlineContent(ctx, version)
          : "unpublished";
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    await advance(ctx, {
      kind: "cleanup",
      generation,
      from: cursor,
      cursor: page.continueCursor,
      isDone: page.isDone,
      counts,
    });
    return null;
  },
});

/**
 * What the audit needs of the next version: its blob reference and the identity of its inline
 * content, encoded now as the writer would. One version per call: its items can weigh up to the
 * cap, and a query reads them all.
 */
export const auditPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    version: v.union(
      v.null(),
      v.object({
        id: v.id("documentVersions"),
        published: v.boolean(),
        ref: v.union(
          v.null(),
          v.object({
            storageId: v.id("_storage"),
            contentSha256: v.string(),
            contentSize: v.number(),
            format: v.string(),
          }),
          // A cold version (ADR 0010, phase C): the audit reads it from the bucket.
          v.object({
            objectKey: v.string(),
            contentSha256: v.string(),
            contentSize: v.number(),
            format: v.string(),
          }),
        ),
        inline: v.union(v.null(), v.object({ contentSha256: v.string(), contentSize: v.number() })),
        inlineGone: v.boolean(),
        partial: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("documentVersions").paginate({ cursor, numItems: 1 });
    const version = page.page[0];
    if (!version) return { cursor: page.continueCursor, isDone: page.isDone, version: null };
    const inlineGone = version.result === undefined;
    const inline = inlineGone ? null : await inlineContentRef(ctx, version);
    let ref: ReturnType<typeof storedRef> = null,
      partial = false;
    try {
      ref = storedRef(version);
    } catch {
      partial = true;
    }
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      version: {
        id: version._id,
        published: version.state === "complete" && version.publishedAt !== undefined,
        ref,
        inline: inline && { contentSha256: inline.contentSha256, contentSize: inline.contentSize },
        inlineGone,
        partial,
      },
    };
  },
});

export const auditProgress = internalMutation({
  args: {
    generation: v.number(),
    from: v.union(v.string(), v.null()),
    cursor: v.string(),
    isDone: v.boolean(),
    counts: v.record(v.string(), v.number()),
    verified: v.array(v.object({ id: v.id("documentVersions"), contentSha256: v.string() })),
    failed: v.array(v.id("documentVersions")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await stepRun(ctx, "audit", args.generation, args.from))) return false;
    let lost = 0;
    for (const entry of args.verified)
      if (!(await markVerified(ctx, entry.id, entry.contentSha256))) lost++;
    for (const id of args.failed) {
      const version = await ctx.db.get("documentVersions", id);
      if (version?.contentVerifiedAt !== undefined)
        await patchFiscal(ctx, "documentVersions", id, { contentVerifiedAt: undefined }, false);
    }
    return advance(ctx, {
      kind: "audit",
      generation: args.generation,
      from: args.from,
      cursor: args.cursor,
      isDone: args.isDone,
      counts: { ...args.counts, ...(lost ? { changedDuringAudit: lost } : {}) },
    });
  },
});

/** A step that failed: the run stops where it was, to resume with `start`. */
export const fail = internalMutation({
  args: { kind, generation: v.number(), from: v.union(v.string(), v.null()), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await stepRun(ctx, args.kind, args.generation, args.from);
    if (!run) return null;
    await ctx.db.patch("contentMigrations", run._id, {
      state: "failed",
      error: args.error.slice(0, 200),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The audit counts that let B8 clear inline copies: a finished audit with no blob missing,
 * damaged or different from its inline content, and no version left without its blob verified.
 */
export const AUDIT_BLOCKERS = [
  "mismatch",
  "missing",
  "corrupt",
  "unverified",
  "changedDuringAudit",
] as const;
async function requireAudited(ctx: QueryCtx) {
  const audit = await runOf(ctx, "audit");
  if (audit?.state !== "done" || AUDIT_BLOCKERS.some((name) => (audit.counts[name] ?? 0) > 0))
    throw new Error("CONTENT_AUDIT_REQUIRED");
}

export const status = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      kind: v.string(),
      state: v.string(),
      counts: v.record(v.string(), v.number()),
      error: v.union(v.string(), v.null()),
      startedAt: v.number(),
      updatedAt: v.number(),
      finishedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) =>
    (await ctx.db.query("contentMigrations").collect()).map((run) => ({
      kind: run.kind,
      state: run.state,
      counts: run.counts,
      error: run.error ?? null,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt ?? null,
    })),
});
