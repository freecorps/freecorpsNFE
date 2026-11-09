import { v } from "convex/values";
import { query, mutation, internalMutation, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
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
import { planEnded } from "./lib/usageValues";
import {
  activateCatalogPlan,
  allocateOffer,
  annualOn,
  grantTerm,
  planAllocation,
  planSettings,
  recordTermRefund as recordTermRefundCore,
  requirePlanAdmissions,
  rescindTerm as rescindTermCore,
  undoTermUpgrade as undoTermUpgradeCore,
} from "./lib/planCore";
import { requirePlatformEnvironment } from "./environment";
import { assertPlanCapacity, getCapacityUsage } from "./lib/capacityCore";
import { archiveStatus } from "./lib/coldArchiveCore";
import { UPGRADE_SWITCH_MARGIN, openCheckout, renews } from "./lib/billingCore";
import {
  chainAnchor,
  termMonth,
  termsInForce,
  termTierAt,
  termUpgradeCents,
} from "./lib/planTerms";
import { remainingMonths } from "./lib/annualTerms";

const scope = { organizationId: v.id("organizations") };
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
  /** Upgrades: the tier from `fromPeriod`, the start of a term month, to the end of the term. */
  segments: v.array(v.object({ tier: paidTier, fromPeriod: v.number() })),
  /** Its start, any instant: the card's payment, or a renewal's turn. */
  firstPeriod: v.number(),
  /** Its end, and the date the card renews it. */
  endsAt: v.number(),
  state: v.union(v.literal("scheduled"), v.literal("active"), v.literal("rescinded")),
  /** A scheduled term whose start was refused (`blockedCode`): paid, waiting for the team. */
  blocked: v.boolean(),
  /** Rescinded only: when access ends, at once within the 7 days or at the end of the month. */
  accessEndsAt: v.union(v.number(), v.null()),
  /**
   * A term whose subscription still renews it at `endsAt`: the one that bought it, live and
   * without "Não renovar".
   */
  renews: v.boolean(),
  /**
   * The upgrade on sale now, priced by the server (`termUpgradeCents`) over the `months` left,
   * the current one whole, from `from`, the start of the current term month, to the end of the
   * term. It closes 72 hours before `endsAt` (`closesAt`).
   */
  upgrade: v.union(
    v.null(),
    v.object({
      tier: paidTier,
      amountCents: v.number(),
      months: v.number(),
      from: v.number(),
      closesAt: v.number(),
    }),
  ),
});
type TermView = typeof termView.type;

/**
 * The organization's annual terms for the console: in force or scheduled, and the rescinded ones
 * whose access has not ended, except a renewal rescinded with the term it followed (`after`).
 * The upgrade is offered on the active term covering `now` while no term is scheduled, as
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
  const scheduled = holding.some((term) => term.state === "scheduled");
  return [...holding, ...rescinded]
    .sort((a, b) => a.firstPeriod - b.firstPeriod)
    .flatMap((term): TermView[] => {
      if (term.state === "expired") return [];
      // Priced from the start of the term month under way, which counts whole.
      const month =
        annualOnSale && !scheduled && term.state === "active" && term.firstPeriod <= now
          ? termMonth(term, now)
          : null;
      const amountCents = month === null ? null : termUpgradeCents(term, "large", month.startsAt);
      return [
        {
          id: term._id,
          tier: term.tier,
          segments: term.segments,
          firstPeriod: term.firstPeriod,
          endsAt: term.endsAt,
          state: term.state,
          blocked: term.state === "scheduled" && term.blockedCode !== undefined,
          accessEndsAt: term.rescission?.accessEndsAt ?? null,
          renews: term.state !== "rescinded" && renewing(term.stripeSubscriptionId),
          upgrade:
            month === null || amountCents === null
              ? null
              : {
                  tier: "large" as const,
                  amountCents,
                  months: remainingMonths(
                    { startsAt: term.firstPeriod, endsAt: term.endsAt, anchor: chainAnchor(term) },
                    month.startsAt,
                  ),
                  from: month.startsAt,
                  closesAt: term.endsAt - UPGRADE_SWITCH_MARGIN,
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

/**
 * The plans page. `asOf` is the console's clock, rounded to the minute: a query never reads the
 * clock (#45). It only shapes what the page shows and enables; every mutation decides with its own.
 */
export const overview = query({
  args: { ...scope, contextKey: v.string(), asOf: v.number() },
  returns: v.object({
    enabled: v.boolean(),
    offers: v.array(offerValue),
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
    availability: v.object({ canClaimFree: v.boolean(), reason: v.union(v.string(), v.null()) }),
    /** The annual switch (`annualEnabled`): new annual sales and upgrades. */
    annualEnabled: v.boolean(),
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
    const claim = await ctx.db
      .query("platformFreeClaims")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
      .unique();
    const enabled = settings?.enabled === true;
    const annualOnSale = annualOn(settings);
    const now = args.asOf;
    const archive = await archiveStatus(ctx, args.organizationId);
    const canClaimFree =
      enabled && settings!.admissionsUntil > now && membership.role === "owner" && !plan && !claim;
    return {
      enabled,
      ...(enabled
        ? {
            stock: await getCapacityUsage(ctx, args.organizationId, now),
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
      availability: {
        canClaimFree,
        reason: canClaimFree
          ? null
          : "Gratuidade sujeita à elegibilidade, inventário e orçamento disponível.",
      },
      annualEnabled: annualOnSale,
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
 * Activates a `scheduled` term at its start, `firstPeriod`. Scheduled at confirmation and safe to
 * run again or late: the operator runs it to reconcile a term whose start passed without
 * activation. Any other
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
 * back by hand (a Stripe refund) and then records it (`recordTermRefund`). Within 7 days
 * of the annual charge everything goes back and access ends now; afterwards access lasts until
 * the end of the current term month (`rescindTerm` in `lib/planCore.ts`).
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
    /** The Stripe refund (`re_…`) that paid it back. */
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
      // The annual switch has its own mutation; rewriting the budgets keeps it.
      ...(prior?.annual ? { annual: prior.annual } : {}),
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
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const prior = await planSettings(ctx);
    if ((prior?.version ?? 0) !== args.expectedVersion) deny("OPERATION_CONFLICT");
    if (args.evidence.length < 8 || args.evidence.length > 500) deny("INVALID_REQUEST");
    if (!prior || (args.enabled && !prior.enabled)) deny("PLANS_DISABLED");
    const now = Date.now();
    await ctx.db.patch("platformPlanSettings", prior._id, {
      annual: { enabled: args.enabled, evidence: args.evidence, updatedAt: now },
      version: prior.version + 1,
      updatedAt: now,
    });
    return prior.version + 1;
  },
});

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
