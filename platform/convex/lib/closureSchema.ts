import { defineTable } from "convex/server";
import { v } from "convex/values";

export const closureState = v.union(
  v.literal("closing"),
  v.literal("purging"),
  v.literal("purged"),
);
export const closureTables = {
  // D01: the minimum record of an organization closure. It survives the purge and holds no
  // names, e-mails or secrets. Once the fiscal guard ends, the requester, the revocation flag and
  // the counts go too: only ids, dates and the state of its own job remain (decision of 19/10).
  organizationClosures: defineTable({
    organizationId: v.id("organizations"),
    state: closureState,
    requestedAt: v.number(),
    requestedBy: v.optional(v.string()),
    exportUntil: v.number(),
    purgeBy: v.number(),
    generation: v.number(),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    revoked: v.optional(v.boolean()),
    removed: v.optional(v.number()),
    purgedAt: v.optional(v.number()),
    // End of the fiscal guard: the conserved classes went at this instant.
    expiredAt: v.optional(v.number()),
    // Rows of the conserved classes removed so far, while the guard purge runs.
    expired: v.optional(v.number()),
    // Decided once: the organization never had Production, so its fiscal data leaves right after
    // the purge (decision of 27/10/2026). Missing on closures purged before it.
    sandboxOnly: v.optional(v.boolean()),
    // First instant after the `decision` class: then this row and the holds go as well.
    decisionUntil: v.optional(v.number()),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_state", ["state"]),
  // A fiscal inspection, lawsuit or formal request of an authority keeps the conserved classes
  // of the organization past the guard. The reference points to the restricted register of D02;
  // no names of data subjects, e-mails or documents here. Reference and responsible go when the
  // fiscal guard ends, so a released hold keeps only ids and dates.
  retentionHolds: defineTable({
    organizationId: v.id("organizations"),
    reference: v.optional(v.string()),
    responsible: v.optional(v.string()),
    reviewAt: v.number(),
    createdAt: v.number(),
    releasedAt: v.optional(v.number()),
  }).index("by_organizationId_and_reference", ["organizationId", "reference"]),
};
