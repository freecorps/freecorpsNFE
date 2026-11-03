import { defineTable } from "convex/server";
import { v } from "convex/values";
import { noticeMail } from "./coldArchiveSchema";

export const sandboxClosureState = v.union(
  v.literal("notice"),
  v.literal("kept_active"),
  v.literal("closed"),
  v.literal("cancelled"),
);
/** Why a notice ended without Freecorps closing the organization. */
export const sandboxClosureCancel = v.union(
  v.literal("activity"),
  v.literal("production"),
  v.literal("paid_plan"),
  v.literal("organization_closed"),
);

export const sandboxClosureTables = {
  /**
   * ADR 0009, decision 2 of 29/10/2026: the 30-day notice before Freecorps closes an open
   * organization that only ever had Sandbox and is idle for 90 days. Kept apart from
   * `coldArchiveRuns`, which the early purge of the closure (`fiscalGuard:early`) reads as
   * Production. Ids, dates and counts only; it goes with the closure purge.
   */
  sandboxClosureNotices: defineTable({
    organizationId: v.id("organizations"),
    /** The operator's idempotency key of `sandboxClosure:notice`. */
    key: v.string(),
    state: sandboxClosureState,
    /** Fences `close`: every end of the notice bumps it. */
    version: v.number(),
    noticeAt: v.number(),
    /** First instant Freecorps may close the organization: the notice plus 30 days. */
    closeAt: v.number(),
    updatedAt: v.number(),
    noticeMail,
    keptActiveAt: v.optional(v.number()),
    cancelled: v.optional(v.object({ reason: sandboxClosureCancel, at: v.number() })),
    closureId: v.optional(v.id("organizationClosures")),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_key", ["key"])
    .index("by_state_and_closeAt", ["state", "closeAt"])
    // The operator's view of notice e-mails without an outcome (`sandboxClosure:mailStatus`).
    .index("by_noticeMail_state_and_noticeAt", ["noticeMail.state", "noticeAt"]),
};
