import { defineTable } from "convex/server";
import { v } from "convex/values";
import { assignedTier, paidTier } from "./planCatalog";

export const termState = v.union(
  v.literal("scheduled"),
  v.literal("active"),
  v.literal("rescinded"),
  v.literal("expired"),
);

/**
 * One of the operator's statements that part of a computed refund was paid back, by hand (a
 * Stripe refund or a Pix): what it returned, its reference, who did it and when it was recorded.
 * A card refund cannot exceed the charge it returns, so the annual charge and an upgrade may take
 * one refund each; together they make the computed amount. The server never refunds by itself.
 */
const termRefund = v.object({
  cents: v.number(),
  reference: v.string(),
  actor: v.string(),
  at: v.number(),
});
const termUpgrade = {
  fromTier: paidTier,
  tier: paidTier,
  fromPeriod: v.number(),
  reference: v.string(),
  paidCents: v.number(),
  paidAt: v.number(),
};

export const planTables = {
  platformPlanSettings: defineTable({
    key: v.literal("platform"),
    enabled: v.boolean(),
    version: v.number(),
    filesBytes: v.number(),
    databaseBytes: v.number(),
    custodyCents: v.number(),
    freeMonthlyCents: v.number(),
    allocatedFilesBytes: v.number(),
    allocatedDatabaseBytes: v.number(),
    allocatedCustodyCents: v.number(),
    allocatedFreeMonthlyCents: v.number(),
    admissionsUntil: v.number(),
    evidence: v.string(),
    updatedAt: v.number(),
    /** Annual sale switch (ADR 0010, decision 4.2); missing is off, and it needs `enabled` too. */
    annual: v.optional(
      v.object({ enabled: v.boolean(), evidence: v.string(), updatedAt: v.number() }),
    ),
  }).index("by_key", ["key"]),
  platformPlanAllocations: defineTable({
    organizationId: v.id("organizations"),
    tier: assignedTier,
    filesBytes: v.number(),
    databaseBytes: v.number(),
    custodyCents: v.number(),
    freeMonthlyCents: v.number(),
    updatedAt: v.number(),
  }).index("by_organizationId", ["organizationId"]),
  platformFreeClaims: defineTable({
    authUserId: v.string(),
    organizationId: v.id("organizations"),
    createdAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_organizationId", ["organizationId"]),
  platformPlanReceipts: defineTable({
    organizationId: v.id("organizations"),
    paymentReference: v.string(),
    monthlyCents: v.number(),
    baseCostCents: v.number(),
    stressCostCents: v.number(),
    custodyCents: v.number(),
    planVersion: v.number(),
    createdAt: v.number(),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_paymentReference", ["paymentReference"]),
  platformPlanRequests: defineTable({
    organizationId: v.id("organizations"),
    tier: paidTier,
    key: v.string(),
    amountCents: v.number(),
    period: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    expectedVersion: v.number(),
    state: v.union(v.literal("awaiting_payment"), v.literal("activated"), v.literal("cancelled")),
    requestedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    paymentReference: v.optional(v.string()),
    /** Missing is monthly. An annual request is paid in full (`annualCents`) and grants a term. */
    cycle: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    /**
     * Annual only: the 1st, 00:00 UTC, the term starts. Its `endsAt` is the payment deadline
     * (`payBy`), the end of the term's first month, as a monthly request expires at month end.
     */
    firstPeriod: v.optional(v.number()),
    /**
     * An annual upgrade (`start: "upgrade"`): the term it raises. `firstPeriod` is then the month
     * the upgrade starts and `amountCents` the difference over the remaining months.
     */
    termId: v.optional(v.id("platformPlanTerms")),
  })
    .index("by_organizationId_and_key", ["organizationId", "key"])
    .index("by_organizationId_and_state", ["organizationId", "state"])
    .index("by_paymentReference", ["paymentReference"]),
  /**
   * One annual term (ADR 0010, decisions 4.2 and 9). Times are ms at 00:00 UTC of a 1st, and
   * `endsAt` is `termEndsAt(firstPeriod)`; `assertTermShape` checks each write (`insertTerm`).
   * While a `scheduled` or `active` term has not ended, the monthly paths refuse
   * (`ANNUAL_TERM_ACTIVE`, `activeTerm`).
   */
  platformPlanTerms: defineTable({
    organizationId: v.id("organizations"),
    /**
     * Tier from `firstPeriod`; an upgrade adds a segment, or, in the first month, which it covers
     * whole, changes this field.
     */
    tier: paidTier,
    firstPeriod: v.number(),
    endsAt: v.number(),
    source: v.union(v.literal("stripe"), v.literal("pix")),
    /** Stripe invoice IDs or Pix payment references of the charges of this term. */
    references: v.array(v.string()),
    /** The Stripe subscription whose invoice bought a `stripe` term; it renews this term. */
    stripeSubscriptionId: v.optional(v.string()),
    /** Everything paid for this term: the annual charge plus each upgrade in `upgrades`. */
    paidCents: v.number(),
    /** Payment of the current annual charge; it opens the 7-day withdrawal window. */
    purchasedAt: v.number(),
    segments: v.array(v.object({ tier: paidTier, fromPeriod: v.number() })),
    /**
     * Each upgrade charge, apart from the annual one, so the rescission can weigh it on its own:
     * the tier before and after, the month it starts (a 1st), its reference (also in
     * `references`), what it charged and when it was paid.
     */
    upgrades: v.optional(v.array(v.object(termUpgrade))),
    /**
     * Upgrades withdrawn within 7 days of their payment (`plans:undoTermUpgrade`, or a rescission
     * that finds one): the charge, now out of `upgrades`, `segments` and `paidCents` but kept in
     * `references`, refunded in full (`refundCents`), with who undid it, why, when, the
     * idempotency key, the action that undid it (`via`: `plans:undoTermUpgrade` or a rescission)
     * and, as it is paid back, the operator's `refunds`.
     */
    undoneUpgrades: v.optional(
      v.array(
        v.object({
          ...termUpgrade,
          key: v.string(),
          actor: v.string(),
          reason: v.string(),
          at: v.number(),
          via: v.union(v.literal("undo"), v.literal("rescission")),
          refundCents: v.number(),
          refunds: v.optional(v.array(termRefund)),
        }),
      ),
    ),
    /**
     * The operator's rescission (`plans:rescindTerm`), with the refund the server computed:
     * `withdrawal` within 7 days of `purchasedAt` (everything paid back, access ends at once),
     * otherwise `paidCents` minus `usedCents`, the `usedMonths` at the full monthly price of the
     * tier of each, with access until `accessEndsAt`, the end of the current civil month. `after`
     * names the term whose rescission took this scheduled renewal with it. `refunds` are the
     * operator's statements that the money went back, summing at most to `refundCents`.
     * `renewalStopFailed` flags a card subscription `billing:stopTermRenewal` could not cancel
     * after its retries; it shows in `billing:overview` (`reviews`) until a retry succeeds.
     */
    rescission: v.optional(
      v.object({
        key: v.string(),
        actor: v.string(),
        reason: v.string(),
        at: v.number(),
        withdrawal: v.boolean(),
        usedMonths: v.number(),
        usedCents: v.number(),
        refundCents: v.number(),
        accessEndsAt: v.number(),
        after: v.optional(v.id("platformPlanTerms")),
        refunds: v.optional(v.array(termRefund)),
        renewalStopFailed: v.optional(v.object({ at: v.number(), code: v.string() })),
      }),
    ),
    state: termState,
    updatedAt: v.number(),
    /**
     * Why the activation of a `scheduled` term was refused (`plans:activateScheduledTerm`), such
     * as `CAPACITY_INVENTORY_REQUIRED`; the operator resolves it and runs the activation again.
     */
    blockedCode: v.optional(v.string()),
  }).index("by_organizationId_and_state_and_endsAt", ["organizationId", "state", "endsAt"]),
};
