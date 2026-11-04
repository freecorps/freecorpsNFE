import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
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
import { civilPeriod } from "./lib/quotaPeriod";
import {
  activateCatalogPlan,
  allocateOffer,
  allocatePlan,
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
import { archiveStatus, endArchiveNotice } from "./lib/coldArchiveCore";
import {
  UPGRADE_SWITCH_MARGIN,
  cardBlocksPix,
  openCheckout,
  paidByCard,
  periodStart,
  renewalEnd,
  renews,
  scheduledPixRenewal,
} from "./lib/billingCore";
import {
  chainAnchor,
  monthlyBlockedByTerm,
  termLastMonth,
  termMonth,
  termOverlapping,
  termsInForce,
  termTierAt,
  termUpgradeCents,
  upgradableTerm,
} from "./lib/planTerms";
import { addMonths, remainingMonths, termEndsAt, termMonthStart } from "./lib/annualTerms";

const scope = { organizationId: v.id("organizations") };
const requestResult = v.object({
  id: v.id("platformPlanRequests"),
  amountCents: v.number(),
  /**
   * The civil month bought, `AAAA-MM`, for consoles published before ADR 0012; optional, as the
   * anniversary periods will not have it. The console reads the instants instead.
   */
  period: v.optional(v.string()),
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
  /** Upgrades: the tier from `fromPeriod`, the start of a term month, to the end of the term. */
  segments: v.array(v.object({ tier: paidTier, fromPeriod: v.number() })),
  /** Its start, any instant: the card still starts on a 1st, the Pix at the confirmation. */
  firstPeriod: v.number(),
  /** Its end, and the date the card renews it. */
  endsAt: v.number(),
  /** The start of its last month, from which a Pix term may be renewed by a new request. */
  renewalFrom: v.number(),
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
   * the current one whole, from `from`, the start of the current term month, to the end of the
   * term. A Pix upgrade is paid by `until`, the end of that month, as the price depends on it. On
   * the card it closes 72 hours before `endsAt` (`cardUntil`).
   */
  upgrade: v.union(
    v.null(),
    v.object({
      tier: paidTier,
      amountCents: v.number(),
      months: v.number(),
      from: v.number(),
      until: v.number(),
      cardUntil: v.union(v.number(), v.null()),
    }),
  ),
});
type TermView = typeof termView.type;

/**
 * How an annual request starts: `now`, at its confirmation; `renewal`, at `firstPeriod`, the end
 * of the plan it renews, with the chain's `anchor`; or the `upgrade` of the term `termId`. Null
 * for a monthly request. A request made before slice 1b has `firstPeriod` on a 1st and no
 * `anchor`: `now` for a term from the 1st of the month asked, `next` for the following one. It
 * is still confirmed as asked, its term starting on that 1st (`grantAnnual`).
 */
function startOf(request: Doc<"platformPlanRequests">) {
  if ((request.cycle ?? "monthly") !== "annual") return null;
  if (request.termId) return "upgrade" as const;
  if (request.firstPeriod === undefined) return "now" as const;
  if (request.anchor !== undefined) return "renewal" as const;
  return request.firstPeriod === civilPeriod(request.startsAt).startsAt
    ? ("now" as const)
    : ("next" as const);
}

/**
 * When what the request buys starts and, monthly only, ends, for the console. An annual one starts
 * at its `firstPeriod`, or at the confirmation (null). A monthly one from slice 1c: a `renewal`
 * from its `firstPeriod` to the next anniversary of its anchor; an `upgrade` from the confirmation
 * to the end of the plan it raises, its payment deadline (`endsAt`); a `now` from the confirmation
 * for a month (both null). One made before 1c: the civil month it buys.
 */
function requestPeriod(request: Doc<"platformPlanRequests">) {
  if ((request.cycle ?? "monthly") === "annual")
    return { periodStartsAt: request.firstPeriod ?? null, periodEndsAt: null };
  if (
    request.start === "renewal" &&
    request.firstPeriod !== undefined &&
    request.anchor !== undefined
  )
    return {
      periodStartsAt: request.firstPeriod,
      periodEndsAt: renewalEnd({ firstPeriod: request.firstPeriod, anchor: request.anchor }),
    };
  if (request.start === "upgrade") return { periodStartsAt: null, periodEndsAt: request.endsAt };
  if (request.start === "now") return { periodStartsAt: null, periodEndsAt: null };
  return {
    periodStartsAt: request.period ? periodStart(request.period) : request.startsAt,
    periodEndsAt: request.endsAt,
  };
}

/** A request past its payment deadline (`payBy`, `endsAt`) can no longer be confirmed. */
const requestExpired = (request: Doc<"platformPlanRequests">, now: number) => request.endsAt <= now;

/**
 * The request awaiting payment, or null. One past its deadline no longer holds the organization:
 * it is cancelled here, so a new request can be made (`confirmPayment` refuses it anyway).
 */
async function pendingRequest(ctx: MutationCtx, organizationId: Id<"organizations">, now: number) {
  const pending = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", organizationId).eq("state", "awaiting_payment"),
    )
    .unique();
  if (!pending || !requestExpired(pending, now)) return pending;
  await ctx.db.patch("platformPlanRequests", pending._id, { state: "cancelled", updatedAt: now });
  return null;
}

/** A Pix request for an annual `now` is paid within 7 days (`payBy`); its price never changes. */
const PIX_PAY_WINDOW = 7 * 24 * 60 * 60 * 1000;

type AnnualStart =
  | { start: "now" }
  | {
      start: "renewal";
      firstPeriod: number;
      anchor: number;
      endsAt: number;
      /** Why `now` is refused meanwhile: a paid plan is in force until `firstPeriod`. */
      nowCode: string;
    }
  | { start: null; code: string; availableAt: number | null };

/**
 * How a new annual by Pix may start at `now` (ADR 0012, one paid plan at a time). Without a paid
 * plan in force, `now`: at the confirmation, with a new anchor. In the last month of a Pix plan in
 * force, its `renewal`: from its end, keeping the anchor of the chain; a monthly Pix plan is all
 * its last month, so any tier renews it. Anything else waits for the plan in force to end and is
 * refused with a code and, when known, the instant it becomes available: a Pix term before its
 * last month, or already renewed (`ANNUAL_TERM_ACTIVE`, from the last month of the latest term);
 * a card plan, even without renewal (`PAYMENT_METHOD_CARD`, from its end); a card that renews
 * or an open Checkout (`PAYMENT_METHOD_CARD`, no date: it depends on the client); the access left
 * by a rescinded term (`PLAN_UNAVAILABLE`, from its end); a monthly Pix renewal already paid
 * (`PLAN_UNAVAILABLE`, from its start, `renewalWait`); a custom plan (`PLAN_UNAVAILABLE`).
 */
async function pixAnnualStart(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
): Promise<AnnualStart> {
  const plan = await planFor(ctx, organizationId);
  if (plan?.catalogTier === "custom")
    return { start: null, code: "PLAN_UNAVAILABLE", availableAt: null };
  // One payment method at a time: a renewing card or an open Checkout would charge twice.
  if (await cardBlocksPix(ctx, organizationId))
    return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: null };
  const scheduled = await renewalWait(ctx, organizationId, now);
  if (scheduled) return scheduled;
  const terms = (await termsInForce(ctx, organizationId, now)).sort(
    (a, b) => a.firstPeriod - b.firstPeriod,
  );
  const last = terms.at(-1);
  if (last) {
    if (last.source !== "pix")
      return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: last.endsAt };
    // Only the term granted and under way is renewed; one scheduled starts first.
    if (last.state !== "active" || now < termLastMonth(last))
      return {
        start: null,
        code: "ANNUAL_TERM_ACTIVE",
        // A term whose start was refused waits for the team; it no longer holds after its end.
        availableAt: last.blockedCode ? last.endsAt : termLastMonth(last),
      };
    const anchor = chainAnchor(last);
    return {
      start: "renewal",
      firstPeriod: last.endsAt,
      anchor,
      endsAt: termEndsAt(last.endsAt, anchor),
      nowCode: "ANNUAL_TERM_ACTIVE",
    };
  }
  if (
    !plan ||
    plan.startsAt > now ||
    planEnded(plan, now) ||
    (plan.catalogTier !== "intermediate" && plan.catalogTier !== "large")
  )
    return { start: "now" };
  if (plan.termId || plan.endsAt === null)
    return { start: null, code: "PLAN_UNAVAILABLE", availableAt: plan.endsAt };
  if (await paidByCard(ctx, plan))
    return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: plan.endsAt };
  const anchor = renewalAnchor({ ...plan, endsAt: plan.endsAt });
  return {
    start: "renewal",
    firstPeriod: plan.endsAt,
    anchor,
    endsAt: termEndsAt(plan.endsAt, anchor),
    nowCode: "PLAN_UNAVAILABLE",
  };
}

const annualStartView = (start: AnnualStart) => ({
  start: start.start,
  startsAt: start.start === "renewal" ? start.firstPeriod : null,
  endsAt: start.start === "renewal" ? start.endsAt : null,
  code: start.start === null ? start.code : null,
  availableAt: start.start === null ? start.availableAt : null,
});

/**
 * A monthly Pix renewal already paid and waiting for its start (`scheduledPixRenewal`) holds the
 * organization: no other Pix sale until it starts, when it is the plan in force and may be renewed
 * or upgraded in turn. One whose activation was refused waits for the team until its end.
 */
async function renewalWait(ctx: QueryCtx, organizationId: Id<"organizations">, now: number) {
  const scheduled = await scheduledPixRenewal(ctx, organizationId, now);
  if (!scheduled) return null;
  return {
    start: null,
    code: "PLAN_UNAVAILABLE",
    availableAt: scheduled.request.blockedCode ? scheduled.endsAt : scheduled.startsAt,
  } as const;
}

type MonthlyStart =
  | { start: "now" }
  | { start: "renewal"; firstPeriod: number; anchor: number; endsAt: number }
  | { start: "upgrade"; endsAt: number; anchor: number | null }
  | { start: null; code: string; availableAt: number | null };

/**
 * How a monthly by Pix of `tier` may start at `now` (ADR 0012, one paid plan at a time). Without
 * a paid plan in force, `now`: a month from the confirmation, with a new anchor. With a monthly
 * Pix plan in force, a higher tier is its `upgrade`, now, for the full difference, with the same
 * period and anchor; the same or a lower tier is its `renewal`, from its end to the next
 * anniversary of its anchor. In the last month of a Pix term, any tier is its `renewal`, from the
 * term's end, keeping the chain's anchor. Anything else waits and is refused like the annual
 * (`pixAnnualStart`): a Pix term before its last month or already renewed (`ANNUAL_TERM_ACTIVE`);
 * a card plan, even without renewal, a higher tier included (`PAYMENT_METHOD_CARD`, from its
 * end); a renewing card or an open Checkout (`PAYMENT_METHOD_CARD`, no date); the access left by a
 * rescinded term (`PLAN_UNAVAILABLE`, from its end); a renewal already paid (`renewalWait`); a
 * custom plan (`PLAN_UNAVAILABLE`).
 */
async function pixMonthlyStart(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
  tier: typeof paidTier.type,
): Promise<MonthlyStart> {
  const plan = await planFor(ctx, organizationId);
  if (plan?.catalogTier === "custom")
    return { start: null, code: "PLAN_UNAVAILABLE", availableAt: null };
  if (await cardBlocksPix(ctx, organizationId))
    return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: null };
  const scheduled = await renewalWait(ctx, organizationId, now);
  if (scheduled) return scheduled;
  const last = (await termsInForce(ctx, organizationId, now))
    .sort((a, b) => a.firstPeriod - b.firstPeriod)
    .at(-1);
  if (last) {
    if (last.source !== "pix")
      return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: last.endsAt };
    if (last.state !== "active" || now < termLastMonth(last))
      return {
        start: null,
        code: "ANNUAL_TERM_ACTIVE",
        availableAt: last.blockedCode ? last.endsAt : termLastMonth(last),
      };
    const anchor = chainAnchor(last);
    return {
      start: "renewal",
      firstPeriod: last.endsAt,
      anchor,
      endsAt: renewalEnd({ firstPeriod: last.endsAt, anchor }),
    };
  }
  if (
    !plan ||
    plan.startsAt > now ||
    planEnded(plan, now) ||
    (plan.catalogTier !== "intermediate" && plan.catalogTier !== "large")
  )
    return { start: "now" };
  if (plan.termId || plan.endsAt === null)
    return { start: null, code: "PLAN_UNAVAILABLE", availableAt: plan.endsAt };
  // The card plan runs to its end even with the renewal cancelled: no Pix beside it, not even
  // an upgrade (ADR 0012).
  if (await paidByCard(ctx, plan))
    return { start: null, code: "PAYMENT_METHOD_CARD", availableAt: plan.endsAt };
  if (PLATFORM_PLANS[tier].monthlyCents > PLATFORM_PLANS[plan.catalogTier].monthlyCents)
    return { start: "upgrade", endsAt: plan.endsAt, anchor: plan.periodAnchor ?? null };
  const anchor = renewalAnchor({ ...plan, endsAt: plan.endsAt });
  return {
    start: "renewal",
    firstPeriod: plan.endsAt,
    anchor,
    endsAt: renewalEnd({ firstPeriod: plan.endsAt, anchor }),
  };
}

/** What a monthly by Pix of `tier` costs: the full monthly price, or the difference on upgrade. */
async function monthlyCents(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  tier: typeof paidTier.type,
  start: MonthlyStart,
) {
  if (start.start !== "upgrade") return PLATFORM_PLANS[tier].monthlyCents;
  const plan = (await planFor(ctx, organizationId))!;
  return (
    PLATFORM_PLANS[tier].monthlyCents -
    PLATFORM_PLANS[plan.catalogTier as typeof paidTier.type].monthlyCents
  );
}

const monthlyStartValue = v.object({
  start: v.union(v.literal("now"), v.literal("renewal"), v.literal("upgrade"), v.null()),
  /** What the request would charge; null when refused. */
  amountCents: v.union(v.number(), v.null()),
  /** A renewal: when it starts, the end of the plan in force. */
  startsAt: v.union(v.number(), v.null()),
  /** A renewal: its end; an upgrade: the end of the plan in force, which does not move. */
  endsAt: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
  availableAt: v.union(v.number(), v.null()),
});
async function monthlyStartView(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
  tier: typeof paidTier.type,
): Promise<typeof monthlyStartValue.type> {
  const start = await pixMonthlyStart(ctx, organizationId, now, tier);
  return {
    start: start.start,
    amountCents: start.start === null ? null : await monthlyCents(ctx, organizationId, tier, start),
    startsAt: start.start === "renewal" ? start.firstPeriod : null,
    endsAt: start.start === "renewal" || start.start === "upgrade" ? start.endsAt : null,
    code: start.start === null ? start.code : null,
    availableAt: start.start === null ? start.availableAt : null,
  };
}

/**
 * The anchor a renewal of the monthly `plan` keeps: its `periodAnchor` when its end is one of
 * the anchor's anniversaries, as every monthly Pix granted from slice 1c. A monthly plan without
 * it, one granted by the civil month (a Pix before 1c, or the card until slice 2a), ends on a
 * 1st at 00:00 UTC, and the renewal anchors a chain of its own there.
 */
function renewalAnchor(plan: { periodAnchor?: number; endsAt: number }) {
  const anchor = plan.periodAnchor;
  if (anchor !== undefined && anchor <= plan.endsAt)
    try {
      termEndsAt(plan.endsAt, anchor);
      return anchor;
    } catch {
      // Not an anniversary: the renewal starts a chain of its own.
    }
  return plan.endsAt;
}

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
          renewalFrom: termLastMonth(term),
          source: term.source,
          state: term.state,
          blocked: term.state === "scheduled" && term.blockedCode !== undefined,
          accessEndsAt: term.rescission?.accessEndsAt ?? null,
          renews:
            term.state !== "rescinded" &&
            term.source === "stripe" &&
            renewing(term.stripeSubscriptionId),
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
                  until: month.endsAt,
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
        /**
         * `now`, the `renewal` of the plan in force, or the `upgrade` of the term or of the
         * monthly plan in force; `next` is an annual request made before slice 1b for the 1st of
         * the following month. Null for a monthly request made before slice 1c, which buys the
         * civil month.
         */
        start: v.union(
          v.null(),
          v.literal("now"),
          v.literal("renewal"),
          v.literal("upgrade"),
          v.literal("next"),
        ),
        /** A renewal or an annual upgrade: the instant the plan, the term or the upgrade starts. */
        firstPeriod: v.union(v.number(), v.null()),
        /**
         * When what the request buys starts: the month, the renewal or the annual upgrade. Null
         * for a `now` and a monthly upgrade, which start at the confirmation of the payment.
         */
        periodStartsAt: v.union(v.number(), v.null()),
        /**
         * Monthly only: the end, exclusive, of the month bought, or of the plan a monthly upgrade
         * raises. Null for a monthly `now`, which ends a month after the confirmation.
         */
        periodEndsAt: v.union(v.number(), v.null()),
        /** The payment deadline: past it, the confirmation is refused. */
        payBy: v.number(),
        /**
         * Past `payBy`: it no longer holds the organization, and the next request cancels it
         * (`pendingRequest`).
         */
        expired: v.boolean(),
      }),
    ),
    availability: v.object({ canClaimFree: v.boolean(), reason: v.union(v.string(), v.null()) }),
    /** The annual switch (`annualEnabled`): new annual sales and upgrades. */
    annualEnabled: v.boolean(),
    /** The Pix switch (`pixEnabled`): new requests by assisted Pix, annual upgrades included. */
    pixEnabled: v.boolean(),
    /**
     * How a new annual by Pix starts (`pixAnnualStart`, ADR 0012): `now`, at the confirmation;
     * `renewal`, from `startsAt`, the end of the Pix plan in force, to `endsAt`; or null, refused
     * with `code` until `availableAt`, when known.
     */
    annualStart: v.object({
      start: v.union(v.literal("now"), v.literal("renewal"), v.null()),
      startsAt: v.union(v.number(), v.null()),
      endsAt: v.union(v.number(), v.null()),
      code: v.union(v.string(), v.null()),
      availableAt: v.union(v.number(), v.null()),
    }),
    /**
     * How a new monthly by Pix of each paid tier starts (`pixMonthlyStart`, ADR 0012): `now`, a
     * month from the confirmation; the `renewal` of the Pix plan in force, from `startsAt` to
     * `endsAt`; the `upgrade` of the monthly in force, now, to its `endsAt`; or null, refused with
     * `code` until `availableAt`, when known. `amountCents` is what the request would charge.
     */
    monthlyStart: v.object({ intermediate: monthlyStartValue, large: monthlyStartValue }),
    /**
     * A monthly Pix renewal paid and waiting for its start (`scheduledPixRenewal`). `blocked`: its
     * activation was refused, and it waits for the team.
     */
    scheduledRenewal: v.union(
      v.null(),
      v.object({ tier: paidTier, startsAt: v.number(), endsAt: v.number(), blocked: v.boolean() }),
    ),
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
    const monthlyStart = {
      intermediate: await monthlyStartView(ctx, args.organizationId, now, "intermediate"),
      large: await monthlyStartView(ctx, args.organizationId, now, "large"),
    };
    const scheduled = await scheduledPixRenewal(ctx, args.organizationId, now);
    const quote = (tier: typeof paidTier.type) => monthlyStart[tier].amountCents;
    const archive = await archiveStatus(ctx, args.organizationId);
    const canClaimFree =
      enabled &&
      settings!.admissionsUntil > Date.now() &&
      membership.role === "owner" &&
      !plan &&
      !claim &&
      (!request || requestExpired(request, now));
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
            start: startOf(request) ?? request.start ?? null,
            firstPeriod: request.firstPeriod ?? null,
            ...requestPeriod(request),
            payBy: request.endsAt,
            expired: requestExpired(request, now),
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
      annualStart: annualStartView(await pixAnnualStart(ctx, args.organizationId, now)),
      monthlyStart,
      scheduledRenewal: scheduled
        ? {
            tier: scheduled.request.tier,
            startsAt: scheduled.startsAt,
            endsAt: scheduled.endsAt,
            blocked: scheduled.request.blockedCode !== undefined,
          }
        : null,
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
    if (await pendingRequest(ctx, args.organizationId, Date.now())) deny("PLAN_REQUEST_PENDING");
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
 * Records an intent, never payment. A monthly (ADR 0012, slice 1c) is the server's choice by tier
 * (`pixMonthlyStart`): `now`, a month from the confirmation, with a new anchor; with a monthly Pix
 * plan in force, the `upgrade` to a higher tier for the full difference, to the same end, or the
 * `renewal` at the same or a lower tier from its end, keeping its anchor, as is any tier asked in
 * the last month of a Pix term. `cycle: "annual"` asks for a 12-month term paid in full (`annualCents`, ADR 0012): `now` starts
 * at the confirmation of the payment, with no paid plan in force; `renewal`, asked in the last
 * month of the Pix plan in force, starts at its end and keeps its anchor (`pixAnnualStart`).
 * `start: "upgrade"` raises the annual term in force to a higher tier from the current term month
 * to its end, for the difference over the months left (`requestUpgrade`). Any other sale while a
 * paid plan is in force is refused with the instant it becomes available (`availableAt`).
 */
export const requestPaid = mutation({
  args: {
    ...scope,
    tier: paidTier,
    key: v.string(),
    cycle: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    /** `next` only replays a request made before slice 1b with that key; nothing new uses it. */
    start: v.optional(
      v.union(v.literal("now"), v.literal("renewal"), v.literal("upgrade"), v.literal("next")),
    ),
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
    const prior = await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    if (prior) {
      // A replay repeats the same choice.
      if (
        prior.tier !== args.tier ||
        (prior.cycle ?? "monthly") !== (args.cycle ?? "monthly") ||
        (startOf(prior) ?? undefined) !== args.start
      )
        deny("OPERATION_CONFLICT");
      if (prior.state === "cancelled") deny("PLAN_REQUEST_UNAVAILABLE");
      return { id: prior._id, amountCents: prior.amountCents, period: prior.period };
    }
    if (args.start === "next") deny("INVALID_REQUEST");
    // Turning a switch off stops new sales only; a request already made is still honored.
    if (annual && !(await annualEnabled(ctx))) deny("ANNUAL_DISABLED");
    if (!(await pixEnabled(ctx))) deny("PIX_DISABLED");
    if (args.start === "upgrade") return requestUpgrade(ctx, args, user._id, now);
    let renewal: { firstPeriod: number; anchor: number; endsAt: number } | null = null;
    let monthly: Exclude<MonthlyStart, { start: null }> | null = null;
    if (annual) {
      // One paid plan at a time (ADR 0012): `now` without a paid plan in force, `renewal` in the
      // last month of the Pix plan in force; anything else waits, with the date it opens.
      const start = await pixAnnualStart(ctx, args.organizationId, now);
      if (start.start === null) deny(start.code, { availableAt: start.availableAt });
      // Nothing to renew; or a paid plan in force until the renewal starts.
      if (start.start === "now" && args.start !== "now") deny("PLAN_UNAVAILABLE");
      if (start.start === "renewal") {
        if (args.start !== "renewal") deny(start.nowCode, { availableAt: start.firstPeriod });
        renewal = start;
      }
    } else {
      // The same rule for the monthly, which the server reads from the tier: `now`, the renewal
      // or the upgrade of the Pix plan in force; anything else waits, with the date it opens.
      const start = await pixMonthlyStart(ctx, args.organizationId, now, args.tier);
      if (start.start === null) return deny(start.code, { availableAt: start.availableAt });
      monthly = start;
    }
    if (await pendingRequest(ctx, args.organizationId, now)) deny("PLAN_REQUEST_PENDING");
    // One payment method at a time: a renewing card or an open Checkout would charge twice, and
    // an annual term must never be created beside a card that still renews monthly.
    if (await cardBlocksPix(ctx, args.organizationId)) deny("PAYMENT_METHOD_CARD");
    const plan = await planFor(ctx, args.organizationId);
    if (plan?.catalogTier === "custom") deny("PLAN_UNAVAILABLE");
    const offer = PLATFORM_PLANS[args.tier];
    // A member's unpaid intent must not consume the company's admission budget.
    await allocateOffer(ctx, args.organizationId, args.tier, offer, { checkOnly: true });
    const expectedVersion = plan?.version ?? 0;
    if (annual) {
      const id = await ctx.db.insert("platformPlanRequests", {
        organizationId: args.organizationId,
        tier: args.tier,
        key: args.key,
        cycle: "annual",
        ...(renewal ? { firstPeriod: renewal.firstPeriod, anchor: renewal.anchor } : {}),
        amountCents: offer.annualCents,
        startsAt: now,
        // `payBy`: a renewal within the term's first month, which it then starts at once without
        // moving its end; `now` within 7 days.
        endsAt: renewal
          ? termMonthStart(renewal.firstPeriod, 1, renewal.anchor)
          : now + PIX_PAY_WINDOW,
        expectedVersion,
        state: "awaiting_payment",
        requestedBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      return { id, amountCents: offer.annualCents };
    }
    const start = monthly!;
    const amountCents = await monthlyCents(ctx, args.organizationId, args.tier, start);
    const id = await ctx.db.insert("platformPlanRequests", {
      organizationId: args.organizationId,
      tier: args.tier,
      key: args.key,
      cycle: "monthly",
      start: start.start,
      ...(start.start === "renewal"
        ? { firstPeriod: start.firstPeriod, anchor: start.anchor }
        : {}),
      amountCents,
      startsAt: now,
      // `payBy`, as the annual: `now` within 7 days; a renewal within the month it buys, which
      // it then starts at once without moving its end; an upgrade within the plan it raises.
      endsAt: start.start === "now" ? now + PIX_PAY_WINDOW : start.endsAt,
      expectedVersion,
      state: "awaiting_payment",
      requestedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    return { id, amountCents };
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
 * The annual upgrade by Pix (ADR 0010, decision 9, and ADR 0012): the term in force, bought by
 * Pix, rises to `tier` from the start of the current term month, counted whole, to its end. The
 * price is the difference of the annual prices over the term months left; the renewal date does
 * not move. Like the other requests it records an intent and reserves nothing; the payment
 * deadline is the end of the current term month, because the price depends on it.
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
  if (await pendingRequest(ctx, args.organizationId, now)) deny("PLAN_REQUEST_PENDING");
  if (await cardBlocksPix(ctx, args.organizationId)) deny("PAYMENT_METHOD_CARD");
  const plan = await planFor(ctx, args.organizationId);
  if (plan?.catalogTier === "custom") deny("PLAN_UNAVAILABLE");
  const month = termMonth(term, now);
  // Already at this tier or above: a downgrade only happens at renewal.
  const amountCents = termUpgradeCents(term, args.tier, month.startsAt);
  if (amountCents === null) return deny("PLAN_UNAVAILABLE");
  await allocateOffer(ctx, args.organizationId, args.tier, PLATFORM_PLANS[args.tier], {
    checkOnly: true,
  });
  const id = await ctx.db.insert("platformPlanRequests", {
    organizationId: args.organizationId,
    tier: args.tier,
    key: args.key,
    cycle: "annual",
    firstPeriod: month.startsAt,
    termId: term._id,
    amountCents,
    startsAt: now,
    endsAt: month.endsAt,
    expectedVersion: plan?.version ?? 0,
    state: "awaiting_payment",
    requestedBy,
    createdAt: now,
    updatedAt: now,
  });
  return { id, amountCents };
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
    let scheduled = false;
    if (request.termId) await grantUpgrade(ctx, request, args.paymentReference, args.actor);
    else if (request.cycle === "annual")
      await grantAnnual(ctx, request, args.paymentReference, args.actor);
    else if (request.start) scheduled = await grantMonthly(ctx, request, args.actor);
    // A monthly request made before slice 1c buys the civil month it was asked in.
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
      ...(scheduled ? { scheduled: true } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The paid monthly request from slice 1c grants its plan (ADR 0012), and the request, now
 * `activated` with the payment reference, is the Pix receipt. A `now` starts at the confirmation,
 * truncated to the second, which anchors a new chain, and ends on its first monthly anniversary;
 * it is refused, as the request would be, if a paid plan came into force since
 * (`pixMonthlyStart`). An `upgrade` raises the plan in force now, to its end, with its anchor. A
 * `renewal` paid late, from its `firstPeriod` on, grants now, to the same end; paid earlier, it
 * reserves the stock now and waits for `plans:activatePixRenewal` at its `firstPeriod`, while the
 * plan in force runs until then: true. A term over it refuses it. As the other confirmations, a
 * plan changed since the request is refused (`OPERATION_CONFLICT`).
 */
async function grantMonthly(ctx: MutationCtx, request: Doc<"platformPlanRequests">, actor: string) {
  const now = Date.now();
  const { organizationId, tier, expectedVersion } = request;
  if (request.start === "now") {
    const start = await pixMonthlyStart(ctx, organizationId, now, tier);
    if (start.start === null) deny(start.code, { availableAt: start.availableAt });
    if (start.start !== "now")
      deny("PLAN_UNAVAILABLE", {
        availableAt: start.start === "renewal" ? start.firstPeriod : start.endsAt,
      });
    const anchor = Math.floor(now / 1000) * 1000;
    const reason = "Pagamento Pix mensal conferido";
    await activateCatalogPlan(
      ctx,
      organizationId,
      tier,
      anchor,
      addMonths(anchor, 1),
      expectedVersion,
      actor,
      reason,
      undefined,
      anchor,
    );
    return false;
  }
  if (request.start === "upgrade") {
    const plan = await planFor(ctx, organizationId);
    if (
      !plan ||
      plan.version !== expectedVersion ||
      plan.endsAt === null ||
      plan.termId ||
      planEnded(plan, now)
    )
      return deny("OPERATION_CONFLICT");
    const reason = "Upgrade mensal por Pix conferido";
    await activateCatalogPlan(
      ctx,
      organizationId,
      tier,
      now,
      plan.endsAt,
      expectedVersion,
      actor,
      reason,
      undefined,
      plan.periodAnchor,
    );
    return false;
  }
  const firstPeriod = request.firstPeriod!;
  const anchor = request.anchor!;
  const endsAt = renewalEnd({ firstPeriod, anchor });
  if (await termOverlapping(ctx, organizationId, firstPeriod, endsAt)) deny("ANNUAL_TERM_ACTIVE");
  const reason = "Renovação mensal por Pix conferida";
  if (firstPeriod <= now) {
    await activateCatalogPlan(
      ctx,
      organizationId,
      tier,
      now,
      endsAt,
      expectedVersion,
      actor,
      reason,
      undefined,
      anchor,
    );
    return false;
  }
  if (((await planFor(ctx, organizationId))?.version ?? 0) !== expectedVersion)
    deny("OPERATION_CONFLICT");
  await allocatePlan(ctx, organizationId, tier);
  // Paid: a pending archive notice ends now, as any plan activation ends it.
  await endArchiveNotice(ctx, organizationId, "plan");
  await ctx.scheduler.runAt(firstPeriod, internal.plans.activatePixRenewal, {
    requestId: request._id,
  });
  return true;
}

/**
 * Grants a monthly Pix renewal paid before its start (`scheduled`) at its `firstPeriod`, with the
 * anchor it keeps, to the next anniversary. Scheduled at confirmation and safe to run again or
 * late: the operator runs it to reconcile a renewal whose start passed without activation. The
 * plan read now is replaced, as a term's activation does. A refusal (the month already over, a
 * term over it, the admission) is recorded in `blockedCode` for the operator, without retrying.
 */
export const activatePixRenewal = internalMutation({
  args: { requestId: v.id("platformPlanRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const request = await ctx.db.get("platformPlanRequests", args.requestId);
    const now = Date.now();
    if (
      !request?.scheduled ||
      request.state !== "activated" ||
      request.firstPeriod === undefined ||
      request.anchor === undefined ||
      request.firstPeriod > now
    )
      return null;
    const { organizationId, tier, anchor } = request;
    const endsAt = renewalEnd({ firstPeriod: request.firstPeriod, anchor });
    try {
      if (now >= endsAt) deny("PERIOD_ENDED");
      if (
        await ctx.db
          .query("organizationClosures")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
          .unique()
      )
        deny("ORGANIZATION_CLOSED");
      if (await monthlyBlockedByTerm(ctx, organizationId, now, endsAt)) deny("ANNUAL_TERM_ACTIVE");
      await allocateOffer(ctx, organizationId, tier, PLATFORM_PLANS[tier], { checkOnly: true });
    } catch (error) {
      const code = denialCode(error);
      if (!code) throw error;
      await ctx.db.patch("platformPlanRequests", request._id, {
        blockedCode: code,
        updatedAt: now,
      });
      return null;
    }
    const version = (await planFor(ctx, organizationId))?.version ?? 0;
    await activateCatalogPlan(
      ctx,
      organizationId,
      tier,
      now,
      endsAt,
      version,
      "system:pix",
      "Início da renovação mensal Pix",
      undefined,
      anchor,
    );
    await ctx.db.patch("platformPlanRequests", request._id, {
      scheduled: undefined,
      blockedCode: undefined,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * The paid annual request becomes a term (ADR 0010, decision 9, and ADR 0012). The request, now
 * `activated` with the payment reference, is the Pix receipt, as in the monthly flow. A `now`
 * starts at the confirmation, truncated to the second, which anchors a new chain; it is refused,
 * as the request would be, if a paid plan came into force since (`pixAnnualStart`). A `renewal`
 * starts at its `firstPeriod` and keeps the chain's `anchor`; a term over it refuses it.
 * `startTerm` grants the plan now, a renewal paid late included, or schedules the term.
 */
async function grantAnnual(
  ctx: MutationCtx,
  request: Doc<"platformPlanRequests">,
  paymentReference: string,
  actor: string,
) {
  const now = Date.now();
  let firstPeriod = request.firstPeriod;
  let anchor = request.anchor ?? firstPeriod;
  if (firstPeriod === undefined || anchor === undefined) {
    const start = await pixAnnualStart(ctx, request.organizationId, now);
    if (start.start === null) deny(start.code, { availableAt: start.availableAt });
    if (start.start === "renewal") deny(start.nowCode, { availableAt: start.firstPeriod });
    firstPeriod = anchor = Math.floor(now / 1000) * 1000;
  }
  const endsAt = termEndsAt(firstPeriod, anchor);
  if (await termOverlapping(ctx, request.organizationId, firstPeriod, endsAt))
    deny("ANNUAL_TERM_ACTIVE");
  await startTerm(
    ctx,
    {
      organizationId: request.organizationId,
      tier: request.tier,
      firstPeriod,
      ...(anchor !== firstPeriod ? { anchor } : {}),
      endsAt,
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
 * The paid upgrade raises the term it was asked for (`upgradeTerm`), from the start of the term
 * month it was asked in, which the payment deadline guarantees. The term must still be the one in
 * force and priced the
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
  if (term._id !== request.termId || request.firstPeriod !== termMonth(term, now).startsAt)
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
 * back by hand (a Stripe refund or a Pix) and then records it (`recordTermRefund`). Within 7 days
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
