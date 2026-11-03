import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  assertTermShape,
  remainingMonths,
  rescissionCents,
  termMonthStart,
  upgradeCents,
  usedMonths,
  withinWithdrawal,
} from "./annualTerms";
import { nextUsagePeriodStart } from "./usageValues";
import { deny } from "./organizationAccess";
import { PLATFORM_PLANS, type paidTier } from "./planCatalog";

export type TermFields = Omit<Doc<"platformPlanTerms">, "_id" | "_creationTime" | "updatedAt">;
const HOLDING = ["active", "scheduled"] as const;

/** Every new term goes through here, so none is stored out of shape (`assertTermShape`). */
export async function insertTerm(ctx: MutationCtx, term: TermFields) {
  assertTermShape(term);
  return ctx.db.insert("platformPlanTerms", { ...term, updatedAt: Date.now() });
}

/** 1st of the UTC month of `at`, 00:00 UTC: the start of the period a monthly payment buys. */
export function monthStart(at: number) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Tier of the term in the month of `at`: the last upgrade segment begun by then, or `tier`. */
export function termTierAt(term: Pick<Doc<"platformPlanTerms">, "tier" | "segments">, at: number) {
  return term.segments.findLast((segment) => segment.fromPeriod <= at)?.tier ?? term.tier;
}

/**
 * Any `scheduled` or `active` term not yet ended at `now`. A path that keeps a card renewing
 * monthly (Checkout, resuming the renewal) refuses while it exists (`ANNUAL_TERM_ACTIVE`).
 */
export async function activeTerm(ctx: QueryCtx, organizationId: Id<"organizations">, now: number) {
  for (const state of HOLDING) {
    const term = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", state).gt("endsAt", now),
      )
      .first();
    if (term) return term;
  }
  return null;
}

/** Every `scheduled` or `active` term not yet ended at `now`: at most the current one and its renewal. */
export async function termsInForce(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const terms = [];
  for (const state of HOLDING)
    terms.push(
      ...(await ctx.db
        .query("platformPlanTerms")
        .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
          q.eq("organizationId", organizationId).eq("state", state).gt("endsAt", now),
        )
        .take(10)),
    );
  return terms;
}

/**
 * Why a new annual term starting at `firstPeriod` cannot be sold: a term already covers that
 * month, or another term is scheduled and not yet ended at `now`. A `next` request in an active
 * term's last month starts at its `endsAt`, which it no longer covers, so the renewal leaves no
 * gap; a scheduled term that ended blocked (`TERM_ENDED`) no longer stops new sales.
 */
export async function annualTermBlocks(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  firstPeriod: number,
  now: number,
) {
  return !!(
    (await termCovering(ctx, organizationId, firstPeriod)) ||
    (await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", "scheduled").gt("endsAt", now),
      )
      .first())
  );
}

/**
 * The `scheduled` or `active` term covering the month that starts at `periodStart`
 * (`firstPeriod <= periodStart < endsAt`). A monthly payment or activation for a covered month
 * would overlap the annual plan, so it is refused or blocked (`ANNUAL_TERM_ACTIVE`); a month
 * before a term scheduled for later is still sold monthly (ADR 0010, decision 9).
 */
export async function termCovering(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  periodStart: number,
) {
  for (const state of HOLDING) {
    // At most the current term and its renewal end after any given month.
    const terms = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", state).gt("endsAt", periodStart),
      )
      .take(10);
    const term = terms.find((row) => row.firstPeriod <= periodStart);
    if (term) return term;
  }
  return null;
}

/**
 * The term an annual upgrade raises (ADR 0010, decision 9): the `active` term covering the month
 * of `now`. Refused while a term has not started yet, this one or a renewal scheduled after it
 * (`ANNUAL_TERM_SCHEDULED`): the renewal was paid at its own tier, and a term not yet started is
 * upgraded once it starts. Without any term, `ANNUAL_TERM_REQUIRED`.
 */
export async function upgradableTerm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const term = await termCovering(ctx, organizationId, monthStart(now));
  const scheduled = await ctx.db
    .query("platformPlanTerms")
    .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
      q.eq("organizationId", organizationId).eq("state", "scheduled").gt("endsAt", now),
    )
    .first();
  if (scheduled) return deny("ANNUAL_TERM_SCHEDULED");
  if (term?.state !== "active") return deny("ANNUAL_TERM_REQUIRED");
  return term;
}

/**
 * What raising `term` to `tier` from the month of `from` costs: the difference of the annual
 * prices over the months left, the current one whole, floored once (`upgradeCents`). `null` when
 * `tier` is not above the tier the term has in that month.
 */
export function termUpgradeCents(
  term: Pick<Doc<"platformPlanTerms">, "tier" | "segments" | "firstPeriod" | "endsAt">,
  tier: typeof paidTier.type,
  from: number,
) {
  const current = PLATFORM_PLANS[termTierAt(term, from)];
  const target = PLATFORM_PLANS[tier];
  if (target.annualCents <= current.annualCents) return null;
  return upgradeCents({
    fromAnnualCents: current.annualCents,
    toAnnualCents: target.annualCents,
    remainingMonths: remainingMonths({ startsAt: term.firstPeriod, endsAt: term.endsAt }, from),
  });
}

type TermMoney = Pick<
  Doc<"platformPlanTerms">,
  "tier" | "segments" | "firstPeriod" | "endsAt" | "paidCents" | "purchasedAt" | "state"
>;

/**
 * What rescinding `term` at `now` gives back (ADR 0010, decision 9, and the owner's decision of
 * 30/10/2026). Within 7 days of `purchasedAt`, the payment of its annual charge: everything paid,
 * and access ends now. Afterwards: `paidCents` minus each used month, the current one whole, at
 * the full monthly price of the tier the term had in it, never negative; access lasts until the
 * end of the current civil month. A term not started yet used nothing, so it gives everything
 * back and grants nothing more: one before its 1st, and one still `scheduled` after it, whose
 * activation was refused (`blockedCode`) and which never granted a plan.
 */
export function termRescission(term: TermMoney, now: number) {
  const withdrawal = withinWithdrawal(term.purchasedAt, now);
  const started = term.state !== "scheduled" && now >= term.firstPeriod;
  const used = started ? usedMonths({ startsAt: term.firstPeriod, endsAt: term.endsAt }, now) : 0;
  const usedMonthlyCents = Array.from(
    { length: used },
    (_, index) =>
      PLATFORM_PLANS[termTierAt(term, termMonthStart(term.firstPeriod, index))].monthlyCents,
  );
  return {
    withdrawal,
    usedMonths: used,
    usedCents: usedMonthlyCents.reduce((sum, monthly) => sum + monthly, 0),
    refundCents: rescissionCents({
      paidCents: term.paidCents,
      usedMonthlyCents,
      withinWithdrawal: withdrawal,
    }),
    accessEndsAt: withdrawal || !started ? now : Math.min(nextUsagePeriodStart(now), term.endsAt),
  };
}

/**
 * The term's last upgrade when its payment is still within 7 days at `now`: the client may
 * withdraw from it alone (`plans:undoTermUpgrade`). There is at most one upgrade per term, from
 * Intermediário to Grande.
 */
export function withdrawableUpgrade(term: Pick<Doc<"platformPlanTerms">, "upgrades">, now: number) {
  const upgrade = term.upgrades?.at(-1);
  return upgrade && withinWithdrawal(upgrade.paidAt, now) ? upgrade : null;
}

/**
 * The term without its last upgrade: the segment it opened goes, or, for an upgrade in the first
 * month, `tier` returns to the tier it left; its charge leaves `upgrades` and `paidCents` and
 * stays in `references`, so the payment is still known. Checked by `assertTermShape`.
 */
export function withoutLastUpgrade(term: Doc<"platformPlanTerms">) {
  const upgrade = term.upgrades?.at(-1);
  if (!upgrade) throw new RangeError("No upgrade");
  const first = upgrade.fromPeriod === term.firstPeriod;
  const fields = {
    tier: first ? upgrade.fromTier : term.tier,
    segments: first
      ? term.segments
      : term.segments.filter(
          (segment) =>
            !(segment.fromPeriod === upgrade.fromPeriod && segment.tier === upgrade.tier),
        ),
    upgrades: term.upgrades!.slice(0, -1),
    paidCents: term.paidCents - upgrade.paidCents,
  };
  assertTermShape({ ...term, ...fields });
  return { upgrade, fields };
}

/** Whether the Stripe subscription `subscriptionId` bought a term scheduled or in force. */
export async function subscriptionHasTerm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  subscriptionId: string,
) {
  for (const state of ["scheduled", "active"] as const) {
    const terms = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", state),
      )
      .take(100);
    if (terms.some((term) => term.stripeSubscriptionId === subscriptionId)) return true;
  }
  return false;
}

/**
 * Whether the Stripe subscription `subscriptionId` bought a term that was rescinded: it must not
 * charge again (`billing:stopTermRenewal` cancels it), so its renewal is blocked and resuming it
 * is refused (`ANNUAL_TERM_RESCINDED`).
 */
export async function rescindedSubscription(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  subscriptionId: string,
) {
  const rescinded = await ctx.db
    .query("platformPlanTerms")
    .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
      q.eq("organizationId", organizationId).eq("state", "rescinded"),
    )
    .take(100);
  return rescinded.some((term) => term.stripeSubscriptionId === subscriptionId);
}
