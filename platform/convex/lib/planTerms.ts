import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  assertTermShape,
  remainingMonths,
  rescissionCents,
  termMonthAt,
  termMonthStart,
  upgradeCents,
  usedMonths,
  withinWithdrawal,
} from "./annualTerms";
import { deny } from "./organizationAccess";
import { PLATFORM_PLANS, type paidTier } from "./planCatalog";

export type TermFields = Omit<Doc<"platformPlanTerms">, "_id" | "_creationTime" | "updatedAt">;
const HOLDING = ["active", "scheduled"] as const;

/** Every new term goes through here, so none is stored out of shape (`assertTermShape`). */
export async function insertTerm(ctx: MutationCtx, term: TermFields) {
  assertTermShape(term);
  return ctx.db.insert("platformPlanTerms", { ...term, updatedAt: Date.now() });
}

type TermClock = Pick<Doc<"platformPlanTerms">, "firstPeriod" | "anchor" | "endsAt">;

/**
 * The anchor of the term's chain (ADR 0012, section 1): stored on a renewal, otherwise the term's
 * own start. Its months, its end and the quota periods of the plan it grants count from it.
 */
export const chainAnchor = (term: Pick<Doc<"platformPlanTerms">, "firstPeriod" | "anchor">) =>
  term.anchor ?? term.firstPeriod;

/** The term month holding `at` (`termMonthAt`, counted from the chain's anchor). */
export const termMonth = (term: TermClock, at: number) =>
  termMonthAt(term.firstPeriod, at, chainAnchor(term));

const span = (term: TermClock) => ({
  startsAt: term.firstPeriod,
  endsAt: term.endsAt,
  anchor: chainAnchor(term),
});

/** Tier of the term at `at`: the last upgrade segment begun by then, or `tier`. */
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
 * The end of the last `scheduled` or `active` term not yet ended at `now`, or null. One paid plan
 * at a time (ADR 0012): a sale that waits for the terms in force becomes available then.
 */
export async function termsEnd(ctx: QueryCtx, organizationId: Id<"organizations">, now: number) {
  const terms = await termsInForce(ctx, organizationId, now);
  return terms.length ? Math.max(...terms.map((term) => term.endsAt)) : null;
}

/**
 * Why a new annual term starting at the instant `start` cannot be sold: a term already covers
 * that instant, or another term is scheduled and not yet ended at `now`. A renewal requested in an
 * active term's last month starts at its `endsAt`, which it no longer covers, so the renewal
 * leaves no gap; a scheduled term that ended blocked (`TERM_ENDED`) no longer stops new sales.
 */
export async function annualTermBlocks(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  start: number,
  now: number,
) {
  return !!(
    (await termCovering(ctx, organizationId, start)) ||
    (await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", "scheduled").gt("endsAt", now),
      )
      .first())
  );
}

/**
 * A `scheduled` or `active` term overlapping the instants `[from, to)`: `endsAt > from` and
 * `firstPeriod < to`. Empty when `to <= from`.
 */
export async function termOverlapping(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  from: number,
  to: number,
) {
  for (const state of HOLDING) {
    // At most the current term and its renewal end after any given instant.
    const terms = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", state).gt("endsAt", from),
      )
      .take(10);
    const term = terms.find((row) => row.firstPeriod < to);
    if (term) return term;
  }
  return null;
}

/** The `scheduled` or `active` term covering the instant `at` (`firstPeriod <= at < endsAt`). */
export async function termCovering(ctx: QueryCtx, organizationId: Id<"organizations">, at: number) {
  return termOverlapping(ctx, organizationId, at, at + 1);
}

/**
 * The term that refuses or blocks a monthly plan from `startsAt` to `endsAt`
 * (`ANNUAL_TERM_ACTIVE`): one overlapping it, which the plan would shorten or overlap. A plan
 * without end, the Gratuito, only checks `startsAt`: the term's activation replaces it. The
 * instant `startsAt` is always checked, even for an `endsAt` already past. A plan that ends before
 * a term scheduled for later is still sold monthly (ADR 0010, decision 9).
 */
export async function monthlyBlockedByTerm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  startsAt: number,
  endsAt: number | null,
) {
  return termOverlapping(ctx, organizationId, startsAt, Math.max(endsAt ?? 0, startsAt + 1));
}

/**
 * The term an annual upgrade raises (ADR 0010, decision 9): the `active` term covering `now`.
 * Refused while a term has not started yet, this one or a renewal scheduled after it
 * (`ANNUAL_TERM_SCHEDULED`): the renewal was paid at its own tier, and a term not yet started is
 * upgraded once it starts. Without any term, `ANNUAL_TERM_REQUIRED`.
 */
export async function upgradableTerm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const term = await termCovering(ctx, organizationId, now);
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
 * What raising `term` to `tier` from `from`, the start of one of its term months, costs: the
 * difference of the annual prices over the term months left, that one whole, floored once
 * (`upgradeCents`). `null` when `tier` is not above the tier the term has in that month.
 */
export function termUpgradeCents(
  term: Pick<Doc<"platformPlanTerms">, "tier" | "segments" | "firstPeriod" | "anchor" | "endsAt">,
  tier: typeof paidTier.type,
  from: number,
) {
  const current = PLATFORM_PLANS[termTierAt(term, from)];
  const target = PLATFORM_PLANS[tier];
  if (target.annualCents <= current.annualCents) return null;
  return upgradeCents({
    fromAnnualCents: current.annualCents,
    toAnnualCents: target.annualCents,
    remainingMonths: remainingMonths(span(term), from),
  });
}

type TermMoney = Pick<
  Doc<"platformPlanTerms">,
  "tier" | "segments" | "firstPeriod" | "anchor" | "endsAt" | "paidCents" | "purchasedAt" | "state"
>;

/**
 * What rescinding `term` at `now` gives back (ADR 0010, decision 9, and the owner's decision of
 * 30/10/2026). Within 7 days of `purchasedAt`, the payment of its annual charge: everything paid,
 * and access ends now. Afterwards: `paidCents` minus each used term month, the current one whole,
 * at the full monthly price of the tier the term had in it, never negative; access lasts until the
 * end of the current term month. A term not started yet used nothing, so it gives everything
 * back and grants nothing more: one before its `firstPeriod`, and one still `scheduled` after it,
 * whose activation was refused (`blockedCode`) and which never granted a plan.
 */
export function termRescission(term: TermMoney, now: number) {
  const withdrawal = withinWithdrawal(term.purchasedAt, now);
  const started = term.state !== "scheduled" && now >= term.firstPeriod;
  const used = started ? usedMonths(span(term), now) : 0;
  const usedMonthlyCents = Array.from(
    { length: used },
    (_, index) =>
      PLATFORM_PLANS[termTierAt(term, termMonthStart(term.firstPeriod, index, chainAnchor(term)))]
        .monthlyCents,
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
    accessEndsAt: withdrawal || !started ? now : Math.min(termMonth(term, now).endsAt, term.endsAt),
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

/**
 * Whether the Stripe subscription `subscriptionId` bought a term scheduled or in force: it renews
 * that term, so a blocked charge of it never cancels it (`billing:stopBlockedAnnual`).
 */
export async function subscriptionHasTerm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  subscriptionId: string,
) {
  for (const state of HOLDING) {
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
