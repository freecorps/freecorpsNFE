import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paidTier } from "./planCatalog";

/** What the last reconciliation read from the Stripe subscription, never what the browser said. */
export const billingSubscription = v.object({
  id: v.string(),
  status: v.string(),
  /** Tier of the recurring price, monthly or yearly; `null` when it is not a verified price. */
  tier: v.union(paidTier, v.null()),
  cancelAtPeriodEnd: v.boolean(),
  /** End of the period already invoiced, in ms: the next renewal when it renews. */
  periodEnd: v.union(v.number(), v.null()),
  /** At an annual price, verified or not: its price never moves to a monthly one. */
  annual: v.optional(v.literal(true)),
});
export const billingOpenInvoice = v.object({
  id: v.string(),
  amountDueCents: v.number(),
  url: v.union(v.string(), v.null()),
});
export const checkoutKind = v.union(v.literal("start"), v.literal("upgrade"));
/**
 * Legacy, read by nothing since slice 2b of ADR 0012: the admission an annual start anchored on
 * the next 1st recorded when its session completed. `reserved`: the stock of the tier was held
 * from then. `refused`: the denial `code`, with `stop` following the cancellation of the
 * subscription and `resolvedBy` the person who settled it. The annual is now charged at the
 * signing and reserves when its first invoice is granted, as the monthly.
 */
const annualAdmission = v.union(
  v.object({ state: v.literal("reserved"), at: v.number() }),
  v.object({
    state: v.literal("refused"),
    code: v.string(),
    at: v.number(),
    stop: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
    resolvedBy: v.optional(v.string()),
  }),
);
export const grantState = v.union(v.literal("applied"), v.literal("skipped"), v.literal("blocked"));
export const billingEventState = v.union(
  v.literal("received"),
  v.literal("processed"),
  v.literal("ignored"),
  v.literal("failed"),
);

/** Card subscriptions through Stripe (#556). */
export const billingTables = {
  /** One Stripe customer per organization; the customer id is the only link Stripe sends back. */
  billingAccounts: defineTable({
    organizationId: v.id("organizations"),
    customerId: v.string(),
    livemode: v.boolean(),
    /** Tier the next renewal must charge, decided by the server (start, upgrade or downgrade). */
    renewalTier: v.optional(paidTier),
    subscription: v.optional(billingSubscription),
    openInvoice: v.optional(billingOpenInvoice),
    syncedAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_livemode", ["organizationId", "livemode"])
    .index("by_customerId", ["customerId"]),
  /** A server-priced Checkout Session. Its return URL proves nothing; the paid invoice does. */
  billingCheckouts: defineTable({
    organizationId: v.id("organizations"),
    key: v.string(),
    kind: checkoutKind,
    tier: paidTier,
    /**
     * The canonical key (ADR 0012) of the period an upgrade raises: the monthly plan's quota
     * period or the term month. A start has none, monthly since slice 2a and annual since slice
     * 2b: it begins when it is paid. Rows before them hold the civil month, `AAAA-MM`.
     */
    period: v.optional(v.string()),
    grantCents: v.number(),
    /** An annual Checkout (ADR 0010, decision 9): a term start or its upgrade. */
    cycle: v.optional(v.literal("annual")),
    state: v.union(
      v.literal("creating"),
      v.literal("open"),
      v.literal("complete"),
      v.literal("expired"),
    ),
    sessionId: v.optional(v.string()),
    url: v.optional(v.string()),
    /**
     * Legacy, written before slice 2b of ADR 0012: the subscription a completed annual start
     * anchored on the next 1st created, and its admission (`annualAdmission`).
     */
    subscriptionId: v.optional(v.string()),
    admission: v.optional(annualAdmission),
    expiresAt: v.number(),
    requestedBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_key", ["organizationId", "key"])
    .index("by_organizationId_and_state", ["organizationId", "state"])
    .index("by_sessionId", ["sessionId"]),
  /** Each paid invoice is weighed once: applied to the plan, skipped (covered) or blocked. */
  billingGrants: defineTable({
    organizationId: v.id("organizations"),
    invoiceId: v.string(),
    tier: v.union(paidTier, v.null()),
    /**
     * The canonical key (ADR 0012) of the period bought: the start of a card month, which is an
     * anniversary of its subscription's anchor since slice 2a, the period an upgrade raised, or a
     * term's start, an anniversary of that anchor since slice 2b. Null when the invoice bought
     * nothing.
     */
    period: v.union(v.string(), v.null()),
    amountCents: v.number(),
    state: grantState,
    code: v.optional(v.string()),
    planVersion: v.optional(v.number()),
    /** The annual term an applied annual invoice created or raised; `period` is then its start. */
    termId: v.optional(v.id("platformPlanTerms")),
    /** Operator who settled a blocked grant (refund, manual plan), outside the platform. */
    resolvedBy: v.optional(v.string()),
    /**
     * A blocked first invoice of an annual subscription (slice 2b of ADR 0012): the year was
     * charged but bought no term, so the subscription is cancelled before it charges again
     * (`billing:stopBlockedAnnual`). `failed` once the retries ran out, for a person.
     */
    subscriptionStop: v.optional(
      v.object({
        subscriptionId: v.string(),
        state: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_invoiceId", ["invoiceId"])
    .index("by_organizationId", ["organizationId"]),
  /** Authenticated Stripe events, deduplicated by id. `review` waits for a person (refund, dispute). */
  billingEvents: defineTable({
    stripeEventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    objectId: v.string(),
    customerId: v.optional(v.string()),
    chargeId: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    organizationId: v.optional(v.id("organizations")),
    state: billingEventState,
    code: v.optional(v.string()),
    review: v.boolean(),
    resolvedBy: v.optional(v.string()),
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stripeEventId", ["stripeEventId"])
    .index("by_organizationId_and_review", ["organizationId", "review"]),
};
