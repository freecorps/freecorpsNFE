import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { armRetention } from "./lib/operationalRetention";
import { apiUsageExpiresAt, compactApiUsage } from "./lib/apiUsageRetention";
import { internal } from "./_generated/api";

/** Run once after rollout, including organizations without any future requests. Safe to repeat. */
export const backfillApiUsage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ scanned: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("apiUsageEvents")
      .paginate({ cursor: args.cursor, numItems: 100 });
    for (const row of page.page)
      await armRetention(ctx, row.organizationId, Math.max(Date.now(), apiUsageExpiresAt(row.day)));
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.telemetryRetention.backfillApiUsage, {
        cursor: page.continueCursor,
      });
    return { scanned: page.page.length, isDone: page.isDone };
  },
});

export const sweep = internalMutation({
  args: { organizationId: v.id("organizations"), generation: v.number() },
  returns: v.number(),
  handler: async (ctx, a) => {
    const job = await ctx.db
      .query("operationalRetention")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", a.organizationId))
      .unique();
    if (!job || job.generation !== a.generation || job.nextAt > Date.now()) return 0;
    const compacted = await compactApiUsage(ctx, a.organizationId);
    let removed = compacted.removed,
      nextAt = compacted.nextAt;
    for (const table of [
      "operationalAudit",
      "operationalNotifications",
      "operationalFailures",
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_organizationId_and_expiresAt", (q) =>
          q.eq("organizationId", a.organizationId).lte("expiresAt", Date.now()),
        )
        .take(50);
      for (const row of rows) {
        await ctx.db.delete(table, row._id);
        removed++;
      }
      const first = await ctx.db
        .query(table)
        .withIndex("by_organizationId_and_expiresAt", (q) =>
          q.eq("organizationId", a.organizationId),
        )
        .first();
      if (first) nextAt = Math.min(nextAt, first.expiresAt);
    }
    await ctx.db.delete("operationalRetention", job._id);
    if (Number.isFinite(nextAt))
      await armRetention(ctx, a.organizationId, Math.max(Date.now() + 1000, nextAt));
    return removed;
  },
});
