import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireMembership,
  requireManager,
  requireOwner,
  deny,
  denialCode,
} from "./lib/organizationAccess";
import {
  catalogTier,
  isCatalogTier,
  paidTier,
  planCapacity,
  PLATFORM_PLANS,
} from "./lib/planCatalog";
import { planFor } from "./lib/usageCore";
import { nextUsagePeriodStart, planEnded, usagePeriod } from "./lib/usageValues";
import {
  activateCatalogPlan,
  allocateOffer,
  annualEnabled,
  annualOn,
  grantTerm,
  planAllocation,
  pixEnabled,
  pixOn,
  planSettings,
  recordTermRefund as recordTermRefundCore,
  requirePlanAdmissions,
  rescindTerm as rescindTermCore,
  startTerm,
  undoTermUpgrade as undoTermUpgradeCore,
  upgradeTerm,
} from "./lib/planCore";
import { requirePlatformEnvironment } from "./environment";
import { assertPlanCapacity, getCapacityUsage } from "./lib/capacityCore";
import { archiveStatus } from "./lib/coldArchiveCore";
import { UPGRADE_SWITCH_MARGIN, cardBlocksPix, openCheckout, renews } from "./lib/billingCore";
import {
  annualTermBlocks,
  monthStart,
  termCovering,
  termsInForce,
  termTierAt,
  termUpgradeCents,
  upgradableTerm,
} from "./lib/planTerms";
import { remainingMonths, termEndsAt } from "./lib/annualTerms";

const scope = { organizationId: v.id("organizations") };
const requestResult = v.object({
  id: v.id("platformPlanRequests"),
  amountCents: v.number(),
  period: v.string(),
});
const offerValue = v.object({
  tier: catalogTier,
  name: v.string(),
  monthlyCents: v.number(),
  concurrency: v.number(),
  limits: v.object({
    imports: v.number(),
    captures: v.number(),
    registry: v.number(),
    bytes: v.number(),
    deliveries: v.number(),
    /** Only the free tier: new notes per month in Production (ADR 0010, decision 10). */
    notes: v.optional(v.number()),
  }),
  capacity: planCapacity,
  /** Paid tiers, only while the annual is on sale (`annualEnabled`): 12 months paid at once. */
  annualCents: v.optional(v.number()),
});
/**
 * An annual term as the console shows it (ADR 0010, decision 9): in force, scheduled, or
 * rescinded and not yet ended. The refund and the operator's notes stay with the operator.
 */
const termView = v.object({
  id: v.id("platformPlanTerms"),
  tier: paidTier,
  /** Upgrades: the tier from the 1st of `fromPeriod` to the end of the term. */
  segments: v.array(v.object({ tier: paidTier, fromPeriod: v.number() })),
  firstPeriod: v.number(),
  /** Its end, and the date the card renews it. */
  endsAt: v.number(),
  source: v.union(v.literal("stripe"), v.literal("pix")),
  state: v.union(v.literal("scheduled"), v.literal("active"), v.literal("rescinded")),
  /** A scheduled term whose start was refused (`blockedCode`): paid, waiting for the team. */
  blocked: v.boolean(),
  /** Rescinded only: when access ends, at once within the 7 days or at the end of the month. */
  accessEndsAt: v.union(v.number(), v.null()),
  /**
   * A card term whose subscription still renews it at `endsAt`: the one that bought it, live and
   * without "Não renovar". A Pix term never renews by itself.
   */
  renews: v.boolean(),
  /**
   * The upgrade on sale now, priced by the server (`termUpgradeCents`) over the `months` left,
   * the current one whole. On the card it closes 72 hours before `endsAt` (`cardUntil`).
   */
  upgrade: v.union(
    v.null(),
    v.object({
      tier: paidTier,
      amountCents: v.number(),
      months: v.number(),
      cardUntil: v.union(v.number(), v.null()),
    }),
  ),
});
type TermView = typeof termView.type;

/** How an annual request starts: `now` began in the month it was asked, `next` after it. */
function startOf(request: Doc<"platformPlanRequests">) {
  if (request.firstPeriod === undefined) return null;
  if (request.termId) return "upgrade" as const;
  return request.firstPeriod === monthStart(request.startsAt)
    ? ("now" as const)
    : ("next" as const);
}

/**
 * The organization's annual terms for the console: in force or scheduled, and the rescinded ones
 * whose access has not ended, except a renewal rescinded with the term it followed (`after`).
 * The upgrade is
 * offered on the active term of the current month while no term is scheduled, as
 * `upgradableTerm` sells it.
 */
async function termViews(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
  annualOnSale: boolean,
): Promise<TermView[]> {
  const holding = await termsInForce(ctx, organizationId, now);
  const rescinded = (
    await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", "rescinded").gt("endsAt", now),
      )
      .take(5)
  ).filter(
    (term) => !term.rescission?.after && (term.rescission?.accessEndsAt ?? term.endsAt) > now,
  );
  // The card subscriptions, one per Stripe mode, that may renew a card term.
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_organizationId_and_livemode", (q) => q.eq("organizationId", organizationId))
    .take(2);
  const renewing = (subscriptionId: string | undefined) =>
    accounts.some((account) => renews(account) && account.subscription!.id === subscriptionId);
  const month = monthStart(now);
  const scheduled = holding.some((term) => term.state === "scheduled");
  return [...holding, ...rescinded]
    .sort((a, b) => a.firstPeriod - b.firstPeriod)
    .flatMap((term): TermView[] => {
      if (term.state === "expired") return [];
      const amountCents =
        annualOnSale && !scheduled && term.state === "active" && term.firstPeriod <= month
          ? termUpgradeCents(term, "large", month)
          : null;
      return [
        {
          id: term._id,
          tier: term.tier,
          segments: term.segments,
          firstPeriod: term.firstPeriod,
          endsAt: term.endsAt,
          source: term.source,
          state: term.state,
          blocked: term.state === "scheduled" && term.blockedCode !== undefined,
          accessEndsAt: term.rescission?.accessEndsAt ?? null,
          renews:
            term.state !== "rescinded" &&
            term.source === "stripe" &&
            renewing(term.stripeSubscriptionId),
          upgrade:
            amountCents === null
              ? null
              : {
                  tier: "large" as const,
                  amountCents,
                  months: remainingMonths(
                    { startsAt: term.firstPeriod, endsAt: term.endsAt },
                    month,
                  ),
                  cardUntil: term.source === "stripe" ? term.endsAt - UPGRADE_SWITCH_MARGIN : null,
                },
        },
      ];
    });
}

/** Invalidates subscribed quotes at expiry, without granting quota or changing the plan version. */
export const refreshExpiry = internalMutation({
  args: { ...scope, version: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await planFor(ctx, args.organizationId);
    if (plan?.version === args.version && planEnded(plan, Date.now()))
      await ctx.db.patch("usagePlans", plan._id, { updatedAt: Date.now() });
    return null;
  },
});

export const overview = query({
  args: { ...scope, contextKey: v.string() },
  returns: v.object({
    enabled: v.boolean(),
    offers: v.array(offerValue),
    pricesCents: v.optional(
      v.object({
        intermediate: v.union(v.number(), v.null()),
        large: v.union(v.number(), v.null()),
      }),
    ),
    stock: v.optional(
      v.object({
        ready: v.boolean(),
        databaseMeasurement: v.literal("convex-document-bytes"),
        physicalDatabaseBytes: v.null(),
        totals: v.record(v.string(), v.object({ committed: v.number(), reserved: v.number() })),
      }),
    ),
    archive: v.optional(v.union(v.null(), v.object({ state: v.string(), eligibleAt: v.number() }))),
    subscription: v.union(
      v.null(),
      v.object({ tier: v.string(), endsAt: v.union(v.number(), v.null()), version: v.number() }),
    ),
    request: v.union(
      v.null(),
      requestResult.extend({
        tier: paidTier,
        state: v.union(
          v.literal("awaiting_payment"),
          v.literal("activated"),
          v.literal("cancelled"),
        ),
        cycle: v.union(v.literal("monthly"), v.literal("annual")),
        /** Annual only: `now`, `next`, or the `upgrade` of the term in force. */
        start: v.union(v.null(), v.literal("now"), v.literal("next"), v.literal("upgrade")),
        /** Annual only: the 1st, 00:00 UTC, the term or the upgrade starts. */
        firstPeriod: v.union(v.number(), v.null()),
      }),
    ),
    availability: v.object({ canClaimFree: v.boolean(), reason: v.union(v.string(), v.null()) }),
    /** The annual switch (`annualEnabled`): new annual sales and upgrades. */
    annualEnabled: v.boolean(),
    /** The Pix switch (`pixEnabled`): new requests by assisted Pix, annual upgrades included. */
    pixEnabled: v.boolean(),
    /**
     * Whether no term stops a new annual by Pix starting `now` (this month) or `next` month
     * (`annualTermBlocks`): a term in force allows only `next`, and only in its last month.
     */
    annualStarts: v.object({ now: v.boolean(), next: v.boolean() }),
    /** A card Checkout is open; when it goes away the console starts a new intention. */
    checkout: v.boolean(),
    terms: v.array(termView),
  }),
  handler: async (ctx, args) => {
    const { membership, user } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const settings = await planSettings(ctx);
    const plan = await planFor(ctx, args.organizationId);
    const request = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", args.organizationId).eq("state", "awaiting_payment"),
      )
      .unique();
    const claim = await ctx.db
      .query("platformFreeClaims")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
      .unique();
    const enabled = settings?.enabled === true;
    const annualOnSale = annualOn(settings);
    const now = Date.now();
    const activeOffer =
      plan &&
      plan.startsAt <= Date.now() &&
      !planEnded(plan, Date.now()) &&
      plan.catalogTier &&
      isCatalogTier(plan.catalogTier)
        ? PLATFORM_PLANS[plan.catalogTier]
        : null;
    const quote = (tier: typeof paidTier.type) =>
      plan?.catalogTier === "custom" ||
      (activeOffer && activeOffer.monthlyCents >= PLATFORM_PLANS[tier].monthlyCents)
        ? null
        : PLATFORM_PLANS[tier].monthlyCents - (activeOffer?.monthlyCents ?? 0);
    const archive = await archiveStatus(ctx, args.organizationId);
    const canClaimFree =
      enabled &&
      settings!.admissionsUntil > Date.now() &&
      membership.role === "owner" &&
      !plan &&
      !claim &&
      !request;
    return {
      enabled,
      ...(enabled
        ? { pricesCents: { intermediate: quote("intermediate"), large: quote("large") } }
        : {}),
      ...(enabled
        ? {
            stock: await getCapacityUsage(ctx, args.organizationId),
            archive: archive ? { state: archive.state, eligibleAt: archive.eligibleAt } : null,
          }
        : {}),
      offers: (Object.keys(PLATFORM_PLANS) as Array<typeof catalogTier.type>).map(
        (tier): typeof offerValue.type => {
          // Custody and subsidy stay out of the offer; the annual price only while it is on sale.
          const { name, monthlyCents, concurrency, limits, capacity } = PLATFORM_PLANS[tier];
          return {
            tier,
            name,
            monthlyCents,
            concurrency,
            limits,
            capacity,
            ...(annualOnSale && tier !== "free"
              ? { annualCents: PLATFORM_PLANS[tier].annualCents }
              : {}),
          };
        },
      ),
      subscription: plan
        ? { tier: plan.catalogTier ?? "custom", endsAt: plan.endsAt, version: plan.version }
        : null,
      request: request
        ? {
            id: request._id,
            tier: request.tier,
            amountCents: request.amountCents,
            state: request.state,
            period: request.period,
            cycle: request.cycle ?? ("monthly" as const),
            start: startOf(request),
            firstPeriod: request.firstPeriod ?? null,
          }
        : null,
      availability: {
        canClaimFree,
        reason: canClaimFree
          ? null
          : "Gratuidade sujeita à elegibilidade, inventário e orçamento disponível.",
      },
      annualEnabled: annualOnSale,
      pixEnabled: pixOn(settings),
      annualStarts: {
        now: !(await annualTermBlocks(ctx, args.organizationId, monthStart(now), now)),
        next: !(await annualTermBlocks(ctx, args.organizationId, nextUsagePeriodStart(now), now)),
      },
      checkout: !!(await openCheckout(ctx, args.organizationId, now)),
      terms: await termViews(ctx, args.organizationId, now, annualOnSale),
    };
  },
});

export const claimFree = mutation({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args) => {
    // Plans stay open in cold custody; `allocateOffer` refuses while archiving (ADR 0009, §2).
    const { user, membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireOwner(membership);
    await requirePlanAdmissions(ctx);
    const prior = await ctx.db
      .query("platformFreeClaims")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
      .unique();
    const plan = await planFor(ctx, args.organizationId);
    if (prior?.organizationId === args.organizationId && plan?.catalogTier === "free") return null;
    if (prior || plan) deny("FREE_PLAN_UNAVAILABLE");
    const pending = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", args.organizationId).eq("state", "awaiting_payment"),
      )
      .first();
    if (pending) deny("PLAN_REQUEST_PENDING");
    await activateCatalogPlan(
      ctx,
      args.organizationId,
      "free",
      Date.now(),
      null,
      0,
      user._id,
      "Adesão ao plano gratuito",
    );
    await ctx.db.insert("platformFreeClaims", {
      authUserId: user._id,
      organizationId: args.organizationId,
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Records an intent, never payment. Full UTC-month price and quota are shown before confirmation.
 * `cycle: "annual"` asks for a 12-month term paid in full (`annualCents`), starting `now` (the
 * current month counts as the first, ADR 0010, decision 9) or on the 1st of the `next` month.
 * `start: "upgrade"` raises the annual term in force to a higher tier from the current month to
 * its end, for the difference over the months left (`requestUpgrade`).
 */
export const requestPaid = mutation({
  args: {
    ...scope,
    tier: paidTier,
    key: v.string(),
    cycle: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    start: v.optional(v.union(v.literal("now"), v.literal("next"), v.literal("upgrade"))),
  },
  returns: requestResult,
  handler: async (ctx, args) => {
    const { user, membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const annual = args.cycle === "annual";
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(args.key) || annual !== (args.start !== undefined))
      deny("INVALID_REQUEST");
    const now = Date.now();
    const firstPeriod = annual
      ? args.start === "next"
        ? nextUsagePeriodStart(now)
        : monthStart(now)
      : undefined;
    const prior = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    if (prior) {
      // A replay repeats the same choice; `now` is a term starting in the month it was asked.
      if (
        prior.tier !== args.tier ||
        (prior.cycle ?? "monthly") !== (args.cycle ?? "monthly") ||
        (startOf(prior) ?? undefined) !== args.start
      )
        deny("OPERATION_CONFLICT");
      if (prior.state === "cancelled") deny("PLAN_REQUEST_UNAVAILABLE");
      return { id: prior._id, amountCents: prior.amountCents, period: prior.period };
    }
    // Turning a switch off stops new sales only; a request already made is still honored.
    if (annual && !(await annualEnabled(ctx))) deny("ANNUAL_DISABLED");
    if (!(await pixEnabled(ctx))) deny("PIX_DISABLED");
    if (args.start === "upgrade") return requestUpgrade(ctx, args, user._id, now);
    // A monthly request buys the current month, which must not overlap an annual term; an
    // annual one must not overlap one either, and waits while another is scheduled. A `next` in
    // the last month of a term renews it without a gap (ADR 0010, decision 9).
    if (
      firstPeriod !== undefined
        ? await annualTermBlocks(ctx, args.organizationId, firstPeriod, now)
        : await termCovering(ctx, args.organizationId, monthStart(now))
    )
      deny("ANNUAL_TERM_ACTIVE");
    const pending = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", args.organizationId).eq("state", "awaiting_payment"),
      )
      .unique();
    if (pending) deny("PLAN_REQUEST_PENDING");
    // One payment method at a time: a renewing card or an open Checkout would charge twice, and
    // an annual term must never be created beside a card that still renews monthly.
    if (await cardBlocksPix(ctx, args.organizationId)) deny("PAYMENT_METHOD_CARD");
    const plan = await planFor(ctx, args.organizationId);
    if (plan?.catalogTier === "custom") deny("PLAN_UNAVAILABLE");
    const current =
      plan &&
      !planEnded(plan, now) &&
      plan.startsAt <= now &&
      plan.catalogTier &&
      isCatalogTier(plan.catalogTier)
        ? PLATFORM_PLANS[plan.catalogTier]
        : null;
    const offer = PLATFORM_PLANS[args.tier];
    // Renewal becomes available at expiry. Downgrades need capacity review, not an in-month refund.
    // An annual term starting now replaces the month at full price, so only a lower tier is refused.
    if (
      current &&
      (args.start === "now"
        ? current.monthlyCents > offer.monthlyCents
        : !annual && current.monthlyCents >= offer.monthlyCents)
    )
      deny("PLAN_UNAVAILABLE");
    // A member's unpaid intent must not consume the company's admission budget.
    await allocateOffer(ctx, args.organizationId, args.tier, offer, { checkOnly: true });
    const amountCents = annual
      ? offer.annualCents
      : offer.monthlyCents - (current?.monthlyCents ?? 0);
    const period = usagePeriod(firstPeriod ?? now);
    const id = await ctx.db.insert("platformPlanRequests", {
      organizationId: args.organizationId,
      tier: args.tier,
      key: args.key,
      cycle: args.cycle ?? "monthly",
      ...(firstPeriod === undefined ? {} : { firstPeriod }),
      amountCents,
      period,
      startsAt: now,
      // Monthly: the month bought. Annual: `payBy`, the end of the term's first month.
      endsAt: nextUsagePeriodStart(firstPeriod ?? now),
      expectedVersion: plan?.version ?? 0,
      state: "awaiting_payment",
      requestedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    return { id, amountCents, period };
  },
});

export const cancelRequest = mutation({
  args: { ...scope, requestId: v.id("platformPlanRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const request = await ctx.db.get("platformPlanRequests", args.requestId);
    if (!request || request.organizationId !== args.organizationId) deny("NOT_FOUND");
    if (request.state === "cancelled") return null;
    if (request.state !== "awaiting_payment") deny("PLAN_REQUEST_UNAVAILABLE");
    await ctx.db.patch("platformPlanRequests", request._id, {
      state: "cancelled",
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The annual upgrade by Pix (ADR 0010, decision 9): the term in force, bought by Pix, rises to
 * `tier` from the current month, counted whole, to its end. The price is the difference of the
 * annual prices over the months left; the renewal date does not move. Like the other requests it
 * records an intent and reserves nothing; the payment deadline is the end of the current month,
 * because the price depends on it.
 */
async function requestUpgrade(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; tier: typeof paidTier.type; key: string },
  requestedBy: string,
  now: number,
) {
  const term = await upgradableTerm(ctx, args.organizationId, now);
  // The upgrade is paid as the term was: a card term by the card Checkout.
  if (term.source !== "pix") deny("PAYMENT_METHOD_CARD");
  const pending = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", args.organizationId).eq("state", "awaiting_payment"),
    )
    .unique();
  if (pending) deny("PLAN_REQUEST_PENDING");
  if (await cardBlocksPix(ctx, args.organizationId)) deny("PAYMENT_METHOD_CARD");
  const plan = await planFor(ctx, args.organizationId);
  if (plan?.catalogTier === "custom") deny("PLAN_UNAVAILABLE");
  const fromPeriod = monthStart(now);
  // Already at this tier or above: a downgrade only happens at renewal.
  const amountCents = termUpgradeCents(term, args.tier, fromPeriod);
  if (amountCents === null) return deny("PLAN_UNAVAILABLE");
  await allocateOffer(ctx, args.organizationId, args.tier, PLATFORM_PLANS[args.tier], {
    checkOnly: true,
  });
  const period = usagePeriod(now);
  const id = await ctx.db.insert("platformPlanRequests", {
    organizationId: args.organizationId,
    tier: args.tier,
    key: args.key,
    cycle: "annual",
    firstPeriod: fromPeriod,
    termId: term._id,
    amountCents,
    period,
    startsAt: now,
    endsAt: nextUsagePeriodStart(now),
    expectedVersion: plan?.version ?? 0,
    state: "awaiting_payment",
    requestedBy,
    createdAt: now,
    updatedAt: now,
  });
  return { id, amountCents, period };
}

/** Operator verifies Pix in the bank before calling; a member cannot assert their own payment. */
export const confirmPayment = internalMutation({
  args: {
    requestId: v.id("platformPlanRequests"),
    amountCents: v.number(),
    paymentReference: v.string(),
    actor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    if (
      !Number.isSafeInteger(args.amountCents) ||
      args.amountCents <= 0 ||
      !/^[a-zA-Z0-9_-]{8,120}$/.test(args.paymentReference) ||
      !args.actor.trim() ||
      args.actor.length > 120
    )
      deny("INVALID_REQUEST");
    const request = await ctx.db.get("platformPlanRequests", args.requestId);
    if (!request || request.amountCents !== args.amountCents) deny("PLAN_REQUEST_UNAVAILABLE");
    const receipt = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_paymentReference", (q) => q.eq("paymentReference", args.paymentReference))
      .unique();
    if (
      await ctx.db
        .query("platformPlanReceipts")
        .withIndex("by_paymentReference", (q) => q.eq("paymentReference", args.paymentReference))
        .first()
    )
      deny("OPERATION_CONFLICT");
    if (receipt) {
      if (receipt._id === request._id && receipt.state === "activated") return null;
      deny("OPERATION_CONFLICT");
    }
    if (request.state !== "awaiting_payment" || request.endsAt <= Date.now())
      deny("PLAN_REQUEST_UNAVAILABLE");
    const closure = await ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", request.organizationId))
      .unique();
    if (closure || !(await ctx.db.get("organizations", request.organizationId)))
      deny("ORGANIZATION_CLOSED");
    if (request.termId) await grantUpgrade(ctx, request, args.paymentReference, args.actor);
    else if (request.cycle === "annual")
      await grantAnnual(ctx, request, args.paymentReference, args.actor);
    else
      await activateCatalogPlan(
        ctx,
        request.organizationId,
        request.tier,
        Date.now(),
        request.endsAt,
        request.expectedVersion,
        args.actor,
        "Pagamento Pix conferido",
      );
    await ctx.db.patch("platformPlanRequests", request._id, {
      state: "activated",
      paymentReference: args.paymentReference,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The paid annual request becomes a term (ADR 0010, decision 9). The request, now `activated`
 * with the payment reference, is the Pix receipt, as in the monthly flow. `startTerm` grants the
 * plan now or schedules the term for its 1st.
 */
async function grantAnnual(
  ctx: MutationCtx,
  request: Doc<"platformPlanRequests">,
  paymentReference: string,
  actor: string,
) {
  const now = Date.now();
  const firstPeriod = request.firstPeriod;
  if (firstPeriod === undefined) return deny("INVALID_REQUEST");
  if (await annualTermBlocks(ctx, request.organizationId, firstPeriod, now))
    deny("ANNUAL_TERM_ACTIVE");
  await startTerm(
    ctx,
    {
      organizationId: request.organizationId,
      tier: request.tier,
      firstPeriod,
      endsAt: termEndsAt(firstPeriod),
      source: "pix",
      references: [paymentReference],
      paidCents: request.amountCents,
      purchasedAt: now,
      segments: [],
    },
    // Like the monthly Pix: a plan changed since the request is refused (`OPERATION_CONFLICT`).
    { expectedVersion: request.expectedVersion, actor, reason: "Pagamento Pix anual conferido" },
  );
}

/**
 * The paid upgrade raises the term it was asked for (`upgradeTerm`), in the month it was asked,
 * which the payment deadline guarantees. The term must still be the one in force and priced the
 * same; a plan changed since the request is refused (`OPERATION_CONFLICT`), as in the monthly
 * Pix. A refusal of the admission (stock, custody fund, window) throws and records nothing: the
 * operator holds the Pix, as with any refused confirmation.
 */
async function grantUpgrade(
  ctx: MutationCtx,
  request: Doc<"platformPlanRequests">,
  paymentReference: string,
  actor: string,
) {
  const now = Date.now();
  const term = await upgradableTerm(ctx, request.organizationId, now);
  if (term._id !== request.termId || request.firstPeriod !== monthStart(now))
    deny("PLAN_REQUEST_UNAVAILABLE");
  if (termUpgradeCents(term, request.tier, request.firstPeriod) !== request.amountCents)
    deny("OPERATION_CONFLICT");
  await upgradeTerm(
    ctx,
    term,
    {
      tier: request.tier,
      fromPeriod: request.firstPeriod,
      reference: paymentReference,
      paidCents: request.amountCents,
      paidAt: now,
    },
    { expectedVersion: request.expectedVersion, actor, reason: "Upgrade anual por Pix conferido" },
  );
}

/**
 * Activates a `scheduled` term on its first 1st. Scheduled at confirmation and safe to run again
 * or late: the operator runs it to reconcile a term whose 1st passed without activation. Any other
 * state, a rescinded term included, is left alone. A refusal is recorded in `blockedCode` for the
 * operator, without retrying. The checks grant nothing; the only write they may make is the
 * organization's `capacityAccounts` row, which `allocateOffer` creates once and is harmless.
 */
export const activateScheduledTerm = internalMutation({
  args: { termId: v.id("platformPlanTerms") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const term = await ctx.db.get("platformPlanTerms", args.termId);
    if (term?.state !== "scheduled" || term.firstPeriod > Date.now()) return null;
    const tier = termTierAt(term, Date.now());
    try {
      if (Date.now() >= term.endsAt) deny("TERM_ENDED");
      await allocateOffer(ctx, term.organizationId, tier, PLATFORM_PLANS[tier], {
        checkOnly: true,
      });
    } catch (error) {
      const code = denialCode(error);
      if (!code) throw error;
      await ctx.db.patch("platformPlanTerms", term._id, {
        blockedCode: code,
        updatedAt: Date.now(),
      });
      return null;
    }
    // The plan read now: the month before ran on whatever plan the organization had.
    const version = (await planFor(ctx, term.organizationId))?.version ?? 0;
    await grantTerm(ctx, term._id, version, "system:annual", "Início do plano anual agendado");
    return null;
  },
});

const operatorTermAction = {
  termId: v.id("platformPlanTerms"),
  /** Idempotency key: repeating the action with it answers what was done. */
  key: v.string(),
  /** GitHub login of the operator. */
  actor: v.string(),
  /** Why, as the client asked support: 10 to 500 characters. */
  reason: v.string(),
};

/**
 * "Rescindir" an annual term, through support (ADR 0010, decision 9, and the owner's decision of
 * 30/10/2026). The server computes the refund and records it on the term; the operator pays it
 * back by hand (a Stripe refund or a Pix) and then records it (`recordTermRefund`). Within 7 days
 * of the annual charge everything goes back and access ends now; afterwards access lasts until
 * the end of the current civil month (`rescindTerm` in `lib/planCore.ts`).
 */
export const rescindTerm = internalMutation({
  args: operatorTermAction,
  returns: v.array(
    v.object({
      termId: v.id("platformPlanTerms"),
      withdrawal: v.boolean(),
      usedMonths: v.number(),
      refundCents: v.number(),
      accessEndsAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    return rescindTermCore(ctx, args);
  },
});

/**
 * "Desfazer upgrade": the annual upgrade withdrawn within 7 days of its payment, refunded in full
 * by hand; the term and its renewal go back to the tier it left (`undoTermUpgrade`).
 */
export const undoTermUpgrade = internalMutation({
  args: operatorTermAction,
  returns: v.object({ reference: v.string(), refundCents: v.number(), tier: paidTier }),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    return undoTermUpgradeCore(ctx, args);
  },
});

/**
 * The operator states that (part of) the refund the server computed was paid back: the
 * rescission's, or, with `upgradeReference`, the withdrawn upgrade's (`recordTermRefund`). One
 * call per refund made; several may add up to the amount due.
 */
export const recordTermRefund = internalMutation({
  args: {
    termId: v.id("platformPlanTerms"),
    upgradeReference: v.optional(v.string()),
    amountCents: v.number(),
    /** The Stripe refund (`re_…`) or the Pix that paid it back. */
    reference: v.string(),
    actor: v.string(),
  },
  /** What is due and how much the refunds recorded so far add up to; equal when complete. */
  returns: v.object({ refundCents: v.number(), refundedCents: v.number() }),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    return recordTermRefundCore(ctx, args);
  },
});

/** Budgets are company funds already set aside, never a projection of future subscriptions. */
export const configure = internalMutation({
  args: {
    enabled: v.boolean(),
    expectedVersion: v.number(),
    filesBytes: v.number(),
    databaseBytes: v.number(),
    custodyCents: v.number(),
    freeMonthlyCents: v.number(),
    admissionsUntil: v.number(),
    evidence: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const prior = await planSettings(ctx);
    if ((prior?.version ?? 0) !== args.expectedVersion) deny("OPERATION_CONFLICT");
    if (
      [
        args.filesBytes,
        args.databaseBytes,
        args.custodyCents,
        args.freeMonthlyCents,
        args.admissionsUntil,
      ].some((n) => !Number.isSafeInteger(n) || n < 0 || n > 1e15) ||
      args.evidence.length < 8 ||
      args.evidence.length > 500
    )
      deny("INVALID_REQUEST");
    // Disabling admission must never silently remove quotas from organizations already enrolled.
    if (prior?.enabled && !args.enabled) deny("OPERATION_CONFLICT");
    const counters = {
      allocatedFilesBytes: prior?.allocatedFilesBytes ?? 0,
      allocatedDatabaseBytes: prior?.allocatedDatabaseBytes ?? 0,
      allocatedCustodyCents: prior?.allocatedCustodyCents ?? 0,
      allocatedFreeMonthlyCents: prior?.allocatedFreeMonthlyCents ?? 0,
    };
    if (
      args.filesBytes < counters.allocatedFilesBytes ||
      args.databaseBytes < counters.allocatedDatabaseBytes ||
      args.custodyCents < counters.allocatedCustodyCents ||
      args.freeMonthlyCents < counters.allocatedFreeMonthlyCents
    )
      deny("QUOTA_EXCEEDED");
    const { expectedVersion, ...fields } = args;
    const value = {
      key: "platform" as const,
      ...fields,
      ...counters,
      // The annual and Pix switches have their own mutations; rewriting the budgets keeps them.
      ...(prior?.annual ? { annual: prior.annual } : {}),
      ...(prior?.pix ? { pix: prior.pix } : {}),
      version: expectedVersion + 1,
      updatedAt: Date.now(),
    };
    if (prior) await ctx.db.replace("platformPlanSettings", prior._id, value);
    else await ctx.db.insert("platformPlanSettings", value);
    return value.version;
  },
});

/**
 * Annual sale switch (ADR 0010, decisions 4.2 and 9), turned on only after phase E. It needs the
 * catalog on; turning it off stops new annual sales and leaves terms already paid as they are.
 */
export const configureAnnual = internalMutation({
  args: { enabled: v.boolean(), expectedVersion: v.number(), evidence: v.string() },
  returns: v.number(),
  handler: (ctx, args) => configureSwitch(ctx, "annual", args),
});

/**
 * Assisted Pix sale switch, off until an operator turns it on. Off, the card is the only way to
 * buy; a request already made can still be confirmed, and terms paid by Pix stay as they are.
 */
export const configurePix = internalMutation({
  args: { enabled: v.boolean(), expectedVersion: v.number(), evidence: v.string() },
  returns: v.number(),
  handler: (ctx, args) => configureSwitch(ctx, "pix", args),
});

async function configureSwitch(
  ctx: MutationCtx,
  field: "annual" | "pix",
  args: { enabled: boolean; expectedVersion: number; evidence: string },
) {
  requirePlatformEnvironment();
  const prior = await planSettings(ctx);
  if ((prior?.version ?? 0) !== args.expectedVersion) deny("OPERATION_CONFLICT");
  if (args.evidence.length < 8 || args.evidence.length > 500) deny("INVALID_REQUEST");
  if (!prior || (args.enabled && !prior.enabled)) deny("PLANS_DISABLED");
  const now = Date.now();
  const value = { enabled: args.enabled, evidence: args.evidence, updatedAt: now };
  await ctx.db.patch("platformPlanSettings", prior._id, {
    ...(field === "annual" ? { annual: value } : { pix: value }),
    version: prior.version + 1,
    updatedAt: now,
  });
  return prior.version + 1;
}

/** Restored bytes and inventory precede this final transaction. A renewed custody fund precedes access. */
export const resumeArchived = internalMutation({
  args: { ...scope, archiveVersion: v.number(), expectedSettingsVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const run = await archiveStatus(ctx, args.organizationId);
    if (!run || run.version !== args.archiveVersion || run.state !== "restoring" || !run.restoredAt)
      deny("OPERATION_CONFLICT");
    if (
      await ctx.db
        .query("organizationClosures")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
        .first()
    )
      deny("ORGANIZATION_CLOSED");
    const settings = await requirePlanAdmissions(ctx);
    if (settings.version !== args.expectedSettingsVersion) deny("OPERATION_CONFLICT");
    const plan = await planFor(ctx, args.organizationId);
    const allocation = await planAllocation(ctx, args.organizationId);
    if (!plan?.capacity || !plan.catalogTier || !allocation) deny("PLAN_REQUIRED");
    await assertPlanCapacity(ctx, args.organizationId, plan.capacity);
    const terms = isCatalogTier(plan.catalogTier) ? PLATFORM_PLANS[plan.catalogTier] : null;
    const receipt = terms
      ? null
      : await ctx.db
          .query("platformPlanReceipts")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
          .order("desc")
          .first();
    const extraCustody = terms?.custodyCents ?? receipt?.custodyCents;
    if (!extraCustody || settings.allocatedCustodyCents + extraCustody > settings.custodyCents)
      deny("PLAN_UNAVAILABLE");
    await ctx.db.patch("platformPlanSettings", settings._id, {
      allocatedCustodyCents: settings.allocatedCustodyCents + extraCustody,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("platformPlanAllocations", allocation._id, {
      custodyCents: allocation.custodyCents + extraCustody,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("coldArchiveRuns", run._id, {
      state: "hot",
      version: run.version + 1,
      updatedAt: Date.now(),
    });
    // Rechecks all limits under the same transaction; any refusal rolls the unfreeze back.
    await allocateOffer(ctx, args.organizationId, plan.catalogTier, {
      capacity: plan.capacity,
      custodyCents: allocation.custodyCents + extraCustody,
      monthlySubsidyCents: terms?.monthlySubsidyCents ?? 0,
    });
    return null;
  },
});
