import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DAY } from "./operationalAudit";

// D01: 30 days for assisted export after closing, then the eligible classes go within 7 days.
export const EXPORT_WINDOW = 30 * DAY;
export const PURGE_WINDOW = 7 * DAY;

export async function closureOf(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
}
/**
 * Only the export of a closing organization stays available, and only inside its window. A query
 * passes `null` (`clockOf`): the purge, scheduled for `exportUntil`, ends `closing`.
 */
export function exportWindowOpen(closure: Doc<"organizationClosures">, now: number | null) {
  return closure.state === "closing" && (now === null || now < closure.exportUntil);
}
export function summarizeClosure(closure: Doc<"organizationClosures">) {
  return {
    state: closure.state,
    requestedAt: closure.requestedAt,
    exportUntil: closure.exportUntil,
    purgeBy: closure.purgeBy,
  };
}
