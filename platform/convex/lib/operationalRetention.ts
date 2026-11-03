import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

/** One deadline per organization. No recurring job when there is no retained telemetry. */
export async function armRetention(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  nextAt: number,
) {
  const current = await ctx.db
    .query("operationalRetention")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (current && current.nextAt <= nextAt) return;
  if (current) await ctx.scheduler.cancel(current.scheduledId);
  const generation = (current?.generation ?? 0) + 1;
  const scheduledId = await ctx.scheduler.runAt(nextAt, internal.telemetryRetention.sweep, {
    organizationId,
    generation,
  });
  const fields = { organizationId, nextAt, generation, scheduledId };
  if (current) await ctx.db.patch("operationalRetention", current._id, fields);
  else await ctx.db.insert("operationalRetention", fields);
}
