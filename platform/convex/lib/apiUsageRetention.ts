import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { DAY } from "./operationalAudit";

// Keep 30 full UTC days after the receipt's day, using the existing day index.
export const apiUsageExpiresAt = (day: string) => Date.parse(`${day}T00:00:00Z`) + 31 * DAY;

export async function compactApiUsage(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const rows = await ctx.db
    .query("apiUsageEvents")
    .withIndex("by_organizationId_and_day_and_shard", (q) =>
      q.eq("organizationId", organizationId).lt("day", cutoff),
    )
    .take(50);
  for (const row of rows) {
    const total = await ctx.db
      .query("apiUsageTotals")
      .withIndex("by_organizationId_and_projectId_and_environment_and_route", (q) =>
        q
          .eq("organizationId", organizationId)
          .eq("projectId", row.projectId)
          .eq("environment", row.environment)
          .eq("route", row.route),
      )
      .unique();
    const fields = {
      count: (total?.count ?? 0) + 1,
      firstAt: Math.min(total?.firstAt ?? row.createdAt, row.createdAt),
      lastAt: Math.max(total?.lastAt ?? row.createdAt, row.createdAt),
    };
    if (total) await ctx.db.patch("apiUsageTotals", total._id, fields);
    else
      await ctx.db.insert("apiUsageTotals", {
        organizationId,
        projectId: row.projectId,
        environment: row.environment,
        route: row.route,
        ...fields,
      });
    // Deletion and aggregation commit together; retry cannot double count a receipt.
    await ctx.db.delete("apiUsageEvents", row._id);
  }
  const first = await ctx.db
    .query("apiUsageEvents")
    .withIndex("by_organizationId_and_day_and_shard", (q) => q.eq("organizationId", organizationId))
    .first();
  return { removed: rows.length, nextAt: first ? apiUsageExpiresAt(first.day) : Infinity };
}
