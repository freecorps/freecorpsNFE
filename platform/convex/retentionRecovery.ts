import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { arm as armAccess } from "./accessRecords";
import { armPurge } from "./organizationClosure";
import { armGuard } from "./fiscalGuard";

/**
 * D05: a Convex snapshot restores the control tables but not their scheduled functions. These
 * functions find each retention deadline whose job no longer exists and schedule it again. They
 * never trust the job ids stored in the restored rows.
 */
const phases = ["closures", "telemetry", "access", "registry", "exports"] as const;
const PAGE = 50;

async function alive(ctx: QueryCtx, id: Id<"_scheduled_functions"> | undefined) {
  if (!id) return false;
  const job = await ctx.db.system.get("_scheduled_functions", id);
  return job?.state.kind === "pending" || job?.state.kind === "inProgress";
}

type Page = { checked: number; missing: number; isDone: boolean; continueCursor: string };
async function scan(
  ctx: MutationCtx | QueryCtx,
  phase: (typeof phases)[number],
  cursor: string | null,
  fix: MutationCtx | null,
): Promise<Page> {
  const now = Date.now();
  const page = { cursor, numItems: PAGE };
  let missing = 0;
  if (phase === "closures") {
    const result = await ctx.db.query("organizationClosures").paginate(page);
    for (const closure of result.page) {
      if (closure.state === "purged") {
        // The guard of the conserved classes, then of the decision itself, including closures
        // purged or expired before each job existed.
        if (await alive(ctx, closure.scheduledId)) continue;
        missing++;
        if (fix) await armGuard(fix, closure);
        continue;
      }
      const lost = !(await alive(ctx, closure.scheduledId));
      if (lost) missing++;
      if (fix && lost)
        await armPurge(fix, closure._id, closure.generation + 1, closure.exportUntil);
      if (fix && lost && !closure.revoked && closure.state === "closing")
        await fix.scheduler.runAfter(0, internal.organizationClosure.revoke, {
          closureId: closure._id,
          phase: 0,
          cursor: null,
        });
    }
    return { ...result, checked: result.page.length, missing };
  }
  if (phase === "telemetry") {
    const result = await ctx.db.query("operationalRetention").paginate(page);
    for (const job of result.page) {
      if (await alive(ctx, job.scheduledId)) continue;
      missing++;
      if (!fix) continue;
      const generation = job.generation + 1;
      const scheduledId = await fix.scheduler.runAt(
        Math.max(now, job.nextAt),
        internal.telemetryRetention.sweep,
        { organizationId: job.organizationId, generation },
      );
      await fix.db.patch("operationalRetention", job._id, { generation, scheduledId });
    }
    return { ...result, checked: result.page.length, missing };
  }
  if (phase === "access") {
    const job = await ctx.db.query("accessRetention").first();
    const next = await ctx.db.query("accessRecords").withIndex("by_expiresAt").first();
    const lost = job ? !(await alive(ctx, job.scheduledId)) : Boolean(next);
    if (lost) missing++;
    if (fix && lost) {
      if (job) await fix.db.delete("accessRetention", job._id);
      if (next) await armAccess(fix, Math.max(now, next.expiresAt));
    }
    return { checked: Number(Boolean(job)), missing, isDone: true, continueCursor: "" };
  }
  if (phase === "registry") {
    const result = await ctx.db.query("registryCache").paginate(page);
    for (const cache of result.page) {
      const retention = !(await alive(ctx, cache.retentionJobId));
      const expiry =
        cache.expiryJobId !== undefined && !cache.stale && !(await alive(ctx, cache.expiryJobId));
      if (retention || expiry) missing++;
      if (!fix) continue;
      if (retention) {
        const retentionJobId = await fix.scheduler.runAt(
          Math.max(now, cache.retainUntil),
          internal.registryStore.expire,
          { cacheId: cache._id },
        );
        await fix.db.patch("registryCache", cache._id, { retentionJobId });
      }
      if (expiry) {
        const expiryJobId = await fix.scheduler.runAt(
          Math.max(now, cache.expiresAt),
          internal.registryStore.expire,
          { cacheId: cache._id },
        );
        await fix.db.patch("registryCache", cache._id, { expiryJobId });
      }
    }
    return { ...result, checked: result.page.length, missing };
  }
  const result = await ctx.db.query("documentExports").paginate(page);
  for (const job of result.page) {
    if (await alive(ctx, job.expireJobId)) continue;
    missing++;
    if (!fix) continue;
    const expireJobId = await fix.scheduler.runAt(
      Math.max(now, job.expiresAt),
      internal.exports.expire,
      { exportId: job._id },
    );
    await fix.db.patch("documentExports", job._id, { expireJobId });
  }
  return { ...result, checked: result.page.length, missing };
}

const progress = {
  phase: v.number(),
  cursor: v.union(v.string(), v.null()),
};
const report = v.object({
  phase: v.string(),
  checked: v.number(),
  missing: v.number(),
  next: v.union(v.object(progress), v.null()),
});
function nextOf(phase: number, result: Page) {
  if (!result.isDone) return { phase, cursor: result.continueCursor };
  return phase + 1 < phases.length ? { phase: phase + 1, cursor: null } : null;
}

/** Run once after a restore, before access is reopened. Continues itself until the end. */
export const recover = internalMutation({
  args: progress,
  returns: report,
  handler: async (ctx, args) => {
    const result = await scan(ctx, phases[args.phase], args.cursor, ctx);
    const next = nextOf(args.phase, result);
    if (next) await ctx.scheduler.runAfter(0, internal.retentionRecovery.recover, next);
    return { phase: phases[args.phase], checked: result.checked, missing: result.missing, next };
  },
});
/** Read-only check, page by page: `missing` is the number of deadlines without a live job. */
export const inspect = internalQuery({
  args: progress,
  returns: report,
  handler: async (ctx, args) => {
    const result = await scan(ctx, phases[args.phase], args.cursor, null);
    return {
      phase: phases[args.phase],
      checked: result.checked,
      missing: result.missing,
      next: nextOf(args.phase, result),
    };
  },
});
