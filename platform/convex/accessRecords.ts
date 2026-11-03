import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { clientIp } from "../auth-transport";
import { DAY } from "./lib/operationalAudit";

const HOUR = 3_600_000;
// Six consecutive months never exceed 184 days.
export const ACCESS_RETENTION = 184 * DAY;

/** One sweep deadline for the whole table, at most a week ahead. No job while nothing is retained. */
export async function arm(ctx: MutationCtx, expiresAt: number) {
  const nextAt = Math.min(expiresAt, Date.now() + 7 * DAY);
  const current = await ctx.db.query("accessRetention").first();
  if (current && current.nextAt <= nextAt) return;
  if (current) await ctx.scheduler.cancel(current.scheduledId);
  const scheduledId = await ctx.scheduler.runAt(nextAt, internal.accessRecords.sweep, {});
  if (current) await ctx.db.patch("accessRetention", current._id, { nextAt, scheduledId });
  else await ctx.db.insert("accessRetention", { nextAt, scheduledId });
}

export const record = internalMutation({
  args: { userId: v.string(), ip: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ip = clientIp(args.ip);
    if (!ip || !args.userId || args.userId.length > 64) return null;
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const existing = await ctx.db
      .query("accessRecords")
      .withIndex("by_userId_and_ip_and_hour", (q) =>
        q.eq("userId", args.userId).eq("ip", ip).eq("hour", hour),
      )
      .first();
    if (!existing) await insert(ctx, { userId: args.userId, ip, hour });
    return null;
  },
});

export const recordActor = internalMutation({
  args: { actor: v.string(), ip: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ip = clientIp(args.ip);
    if (!ip || !/^(key|member):[A-Za-z0-9]{1,64}$/.test(args.actor)) return null;
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const existing = await ctx.db
      .query("accessRecords")
      .withIndex("by_actor_and_ip_and_hour", (q) =>
        q.eq("actor", args.actor).eq("ip", ip).eq("hour", hour),
      )
      .first();
    if (!existing) await insert(ctx, { actor: args.actor, ip, hour });
    return null;
  },
});

async function insert(
  ctx: MutationCtx,
  row: { userId?: string; actor?: string; ip: string; hour: number },
) {
  const at = Date.now();
  const expiresAt = at + ACCESS_RETENTION;
  await ctx.db.insert("accessRecords", { ...row, at, expiresAt });
  await arm(ctx, expiresAt);
}

export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("accessRecords")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(100);
    for (const row of rows) await ctx.db.delete("accessRecords", row._id);
    const job = await ctx.db.query("accessRetention").first();
    if (job) await ctx.db.delete("accessRetention", job._id);
    const next = await ctx.db.query("accessRecords").withIndex("by_expiresAt").first();
    if (next) await arm(ctx, Math.max(now + 1000, next.expiresAt));
    return rows.length;
  },
});
