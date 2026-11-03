import { PLATFORM_PLANS, type paidTier } from "./planCatalog";

/**
 * Annual term arithmetic (ADR 0010, decision 9): civil UTC months and integer cents only. A term
 * covers 12 months from the 1st of a month; the month under way always counts whole.
 */
type PaidTier = typeof paidTier.type;
export const TERM_MONTHS = 12;
/** Withdrawal period of CDC art. 49: 7 × 24 h from the purchase, inclusive. */
export const WITHDRAWAL_MS = 7 * 24 * 60 * 60 * 1000;

export type AnnualTerm = { startsAt: number; endsAt: number };

const monthIndex = (at: number) => {
  const date = new Date(at);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};
function cents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid cents");
  return value;
}
function months(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > TERM_MONTHS)
    throw new RangeError("Invalid months");
  return value;
}

/** 1st of the 12th month after `firstPeriodStart`, 00:00 UTC; the start must be a 1st, 00:00 UTC. */
export function termEndsAt(firstPeriodStart: number) {
  const date = new Date(firstPeriodStart);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (firstPeriodStart !== Date.UTC(year, month, 1)) throw new RangeError("Invalid term start");
  return Date.UTC(year, month + TERM_MONTHS, 1);
}

/** Months of the term already used at `now`, counting the current month as used. */
export function usedMonths(term: AnnualTerm, now: number) {
  if (now < term.startsAt) return 0;
  if (now >= term.endsAt) return TERM_MONTHS;
  return monthIndex(now) - monthIndex(term.startsAt) + 1;
}

/** Months still ahead at `now` for an upgrade, counting the current month as whole. */
export function remainingMonths(term: AnnualTerm, now: number) {
  if (now >= term.endsAt) return 0;
  return monthIndex(term.endsAt) - Math.max(monthIndex(now), monthIndex(term.startsAt));
}

export function withinWithdrawal(purchasedAt: number, now: number) {
  return now >= purchasedAt && now - purchasedAt <= WITHDRAWAL_MS;
}

/**
 * Full refund within the withdrawal period; afterwards the used months are repriced at the full
 * monthly price and the difference, never negative, goes back. Money only; access is apart.
 */
export function refundCents(input: {
  paidAnnualCents: number;
  monthlyCents: number;
  usedMonths: number;
  withinWithdrawal: boolean;
}) {
  return rescissionCents({
    paidCents: input.paidAnnualCents,
    usedMonthlyCents: Array.from({ length: months(input.usedMonths) }, () => input.monthlyCents),
    withinWithdrawal: input.withinWithdrawal,
  });
}

/**
 * The refund of a rescinded term whose tier may change during it (an upgrade): within the
 * withdrawal period, everything paid; afterwards, what was paid minus each used month at the full
 * monthly price of the tier it had (`usedMonthlyCents`, one entry per used month), never negative.
 */
export function rescissionCents(input: {
  paidCents: number;
  usedMonthlyCents: readonly number[];
  withinWithdrawal: boolean;
}) {
  const paid = cents(input.paidCents);
  if (input.withinWithdrawal) return paid;
  months(input.usedMonthlyCents.length);
  const used = input.usedMonthlyCents.reduce((sum, monthly) => sum + cents(monthly), 0);
  return Math.max(0, paid - used);
}

/** 1st of the `index`-th month after `firstPeriodStart` (a 1st, 00:00 UTC), 00:00 UTC. */
export function termMonthStart(firstPeriodStart: number, index: number) {
  const date = new Date(firstPeriodStart);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + index, 1);
}

/** Annual upgrade: the price difference over the remaining months, floored once on the total. */
export function upgradeCents(input: {
  fromAnnualCents: number;
  toAnnualCents: number;
  remainingMonths: number;
}) {
  const from = cents(input.fromAnnualCents);
  const to = cents(input.toAnnualCents);
  if (to <= from) throw new RangeError("Not an upgrade");
  return Math.floor(((to - from) * months(input.remainingMonths)) / TERM_MONTHS);
}

/** What a stored term must satisfy before any write (`platformPlanTerms`, `insertTerm`). */
export type TermShape = {
  tier: PaidTier;
  firstPeriod: number;
  endsAt: number;
  paidCents: number;
  purchasedAt: number;
  references: readonly string[];
  segments: readonly { tier: PaidTier; fromPeriod: number }[];
  upgrades?: readonly {
    fromTier: PaidTier;
    tier: PaidTier;
    fromPeriod: number;
    reference: string;
    paidCents: number;
    paidAt: number;
  }[];
};
const isMonthStart = (at: number) => {
  const date = new Date(at);
  return at === Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
const REFERENCE = /^[a-zA-Z0-9_-]{8,120}$/;
/** A payment reference a term can record (a Stripe invoice id or a Pix reference). */
export const isTermReference = (ref: string) => REFERENCE.test(ref);

/**
 * Throws unless the term:
 * - starts on a 1st at 00:00 UTC and ends exactly `TERM_MONTHS` later (`termEndsAt`);
 * - holds positive integer cents and a valid purchase time;
 * - names at least one payment reference, valid and without repeats;
 * - has valid segments;
 * - records each upgrade charge (`upgrades`) once, inside the term and the money paid.
 *
 * `tier` is the tier at the start; `segments` record only the upgrades. Each starts on a 1st
 * strictly after the previous one (the first strictly after `firstPeriod`) and before `endsAt`,
 * on a tier above the previous one: a downgrade only happens at renewal. An upgrade in the first
 * month covers all 12 months, so it changes `tier` instead of adding a segment.
 */
export function assertTermShape(term: TermShape) {
  if (term.endsAt !== termEndsAt(term.firstPeriod)) throw new RangeError("Invalid term end");
  if (cents(term.paidCents) === 0) throw new RangeError("Invalid cents");
  if (!Number.isSafeInteger(term.purchasedAt) || term.purchasedAt < 0)
    throw new RangeError("Invalid purchase time");
  if (
    term.references.length === 0 ||
    new Set(term.references).size !== term.references.length ||
    !term.references.every((ref) => REFERENCE.test(ref))
  )
    throw new RangeError("Invalid references");
  let from = term.firstPeriod;
  let tier = term.tier;
  for (const segment of term.segments) {
    if (
      !isMonthStart(segment.fromPeriod) ||
      segment.fromPeriod <= from ||
      segment.fromPeriod >= term.endsAt ||
      PLATFORM_PLANS[segment.tier].monthlyCents <= PLATFORM_PLANS[tier].monthlyCents
    )
      throw new RangeError("Invalid segment");
    from = segment.fromPeriod;
    tier = segment.tier;
  }
  // Each upgrade charge leaves the term at its tier from its month on, was paid with one of the
  // term's references, and all of them together stay below what the term was paid in total.
  const tierAt = (at: number) =>
    term.segments.findLast((segment) => segment.fromPeriod <= at)?.tier ?? term.tier;
  let upgraded = 0;
  for (const upgrade of term.upgrades ?? []) {
    if (
      !isMonthStart(upgrade.fromPeriod) ||
      upgrade.fromPeriod < term.firstPeriod ||
      upgrade.fromPeriod >= term.endsAt ||
      tierAt(upgrade.fromPeriod) !== upgrade.tier ||
      // The tier it left: the one in force the month before. In the first month the upgrade
      // replaced `tier` itself, so only the order of the tiers is checked below.
      (upgrade.fromPeriod > term.firstPeriod &&
        tierAt(upgrade.fromPeriod - 1) !== upgrade.fromTier) ||
      PLATFORM_PLANS[upgrade.fromTier].monthlyCents >= PLATFORM_PLANS[upgrade.tier].monthlyCents ||
      !term.references.includes(upgrade.reference) ||
      !Number.isSafeInteger(upgrade.paidAt) ||
      upgrade.paidAt < 0 ||
      cents(upgrade.paidCents) === 0
    )
      throw new RangeError("Invalid upgrade");
    upgraded += upgrade.paidCents;
  }
  if (
    upgraded >= term.paidCents ||
    new Set((term.upgrades ?? []).map((upgrade) => upgrade.reference)).size !==
      (term.upgrades ?? []).length
  )
    throw new RangeError("Invalid upgrade");
}
