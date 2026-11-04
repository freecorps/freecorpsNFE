import { PLATFORM_PLANS, type paidTier } from "./planCatalog";

/**
 * Annual term arithmetic (ADR 0010, decision 9): UTC instants in ms and integer cents only. A term
 * runs from its start, any instant, to the same day and time 12 months later, its anniversary.
 * The term month of index `k`, counted from 0 (the (k + 1)-th month, ADR 0012), runs from
 * `termMonthStart(start, k)` to `termMonthStart(start, k + 1)`, and the term month under way
 * always counts whole. A term starting on a 1st at 00:00
 * UTC has the civil UTC months as its term months. A term that renews another keeps the anchor of
 * their chain (`anchor`, ADR 0012, section 1): its months are the anchor's, from the one it starts.
 */
type PaidTier = typeof paidTier.type;
export const TERM_MONTHS = 12;
/** Withdrawal period of CDC art. 49: 7 × 24 h from the purchase, inclusive. */
export const WITHDRAWAL_MS = 7 * 24 * 60 * 60 * 1000;

/** A term's span; `anchor`, when given, is the anchor of its chain, which its months count from. */
export type AnnualTerm = { startsAt: number; endsAt: number; anchor?: number | undefined };

/** The last instant a `Date` holds: 8.64e15 ms after 1970. */
const MAX_INSTANT = 8.64e15;
function instant(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INSTANT)
    throw new RangeError("Invalid instant");
  return value;
}
function cents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid cents");
  return value;
}
function months(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > TERM_MONTHS)
    throw new RangeError("Invalid months");
  return value;
}

/**
 * `start` moved `count` UTC months ahead: the same day of the month and time of day, the day
 * clamped to the target month's last day. Always counted from `start`, never chained, so 31/01
 * gives 28/02 (29/02 in a leap year) and then 31/03, not 28/03.
 */
export function addMonths(start: number, count: number) {
  instant(start);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid months");
  const date = new Date(start);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const timeOfDay = start - Date.UTC(year, month, day);
  const lastDay = new Date(Date.UTC(year, month + count + 1, 0)).getUTCDate();
  return instant(Date.UTC(year, month + count, Math.min(day, lastDay)) + timeOfDay);
}

/**
 * The month of `anchor` holding `at`, counted from 0: `addMonths(anchor, k) <= at <
 * addMonths(anchor, k + 1)`. −1 before `anchor`; not capped.
 */
function monthIndex(anchor: number, at: number) {
  instant(anchor);
  if (!Number.isSafeInteger(at)) throw new RangeError("Invalid instant");
  if (at < anchor) return -1;
  const from = new Date(anchor);
  const to = new Date(instant(at));
  const index =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  // That month's start falls in the civil month of `at`, so it is at most one month ahead.
  return addMonths(anchor, index) > at ? index - 1 : index;
}

/**
 * How many months of `anchor` come before a term starting at `start`: the term's months are the
 * anchor's months from there on (ADR 0012, section 1). `start` must be one of the anchor's
 * monthly anniversaries, the anchor itself included.
 */
function offsetOf(anchor: number, start: number) {
  const offset = monthIndex(anchor, instant(start));
  if (offset < 0 || addMonths(anchor, offset) !== start)
    throw new RangeError("Start is not an anniversary of the anchor");
  return offset;
}

/**
 * End of the term that starts at `start`, any instant: its anniversary, 12 months later. A term
 * that continues a chain counts its months from the chain's `anchor` (ADR 0012, section 1), so a
 * chain anchored on 29/02/2028 has terms turning on 28/02/2029 and on 29/02/2032, without drift.
 * Without `anchor`, the term is its own anchor.
 */
export function termEndsAt(start: number, anchor = start) {
  return addMonths(anchor, offsetOf(anchor, start) + TERM_MONTHS);
}

/** Start of the term's month `index`, from 0 to 12; month 12 starts when the term ends. */
export function termMonthStart(start: number, index: number, anchor = start) {
  return addMonths(anchor, offsetOf(anchor, start) + months(index));
}

/**
 * The term month holding `at`, counted from 0: `termMonthStart(start, k) <= at <
 * termMonthStart(start, k + 1)`. −1 before `start`; not capped, so 12 from the term's end.
 */
export function termMonthIndex(start: number, at: number, anchor = start) {
  const offset = offsetOf(anchor, start);
  if (!Number.isSafeInteger(at)) throw new RangeError("Invalid instant");
  if (at < start) return -1;
  return monthIndex(anchor, at) - offset;
}

/** The term month holding `at`, which must not come before `start`. */
export function termMonthAt(start: number, at: number, anchor = start) {
  const index = termMonthIndex(start, at, anchor);
  if (index < 0) throw new RangeError("Before the term");
  const offset = offsetOf(anchor, start);
  return {
    index,
    startsAt: addMonths(anchor, offset + index),
    endsAt: addMonths(anchor, offset + index + 1),
  };
}

/** Whether `at` starts one of the term's months, the end included (`termMonthStart`, 0 to 12). */
export function isTermMonthStart(start: number, at: number, anchor = start) {
  if (!Number.isSafeInteger(at) || at < start || at > MAX_INSTANT) return false;
  const index = termMonthIndex(start, at, anchor);
  return index <= TERM_MONTHS && addMonths(anchor, offsetOf(anchor, start) + index) === at;
}

/** Term months already used at `now`, counting the current one as used. */
export function usedMonths(term: AnnualTerm, now: number) {
  if (now < term.startsAt) return 0;
  if (now >= term.endsAt) return TERM_MONTHS;
  return termMonthIndex(term.startsAt, now, term.anchor) + 1;
}

/** Term months still ahead at `now` for an upgrade, counting the current one as whole. */
export function remainingMonths(term: AnnualTerm, now: number) {
  if (now >= term.endsAt) return 0;
  if (now < term.startsAt) return TERM_MONTHS;
  return TERM_MONTHS - termMonthIndex(term.startsAt, now, term.anchor);
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
  /** The anchor of the term's chain (ADR 0012, section 1); missing, the term is its own. */
  anchor?: number | undefined;
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
const REFERENCE = /^[a-zA-Z0-9_-]{8,120}$/;
/** A payment reference a term can record (a Stripe invoice id or a Pix reference). */
export const isTermReference = (ref: string) => REFERENCE.test(ref);

/**
 * Throws unless the term:
 * - starts at a valid instant and ends on its anniversary, `TERM_MONTHS` later (`termEndsAt`);
 *   with `anchor`, it starts on one of the anchor's monthly anniversaries and its months, end
 *   included, are the anchor's;
 * - holds positive integer cents and a valid purchase time;
 * - names at least one payment reference, valid and without repeats;
 * - has valid segments;
 * - records each upgrade charge (`upgrades`) once, inside the term and the money paid.
 *
 * `tier` is the tier at the start; `segments` record only the upgrades. Each starts at the start
 * of a term month (`isTermMonthStart`), strictly after the previous one (the first strictly after
 * `firstPeriod`) and before `endsAt`, on a tier above the previous one: a downgrade only happens
 * at renewal. An upgrade in the first term month covers all 12, so it changes `tier` instead of
 * adding a segment.
 */
export function assertTermShape(term: TermShape) {
  const anchor = term.anchor ?? term.firstPeriod;
  if (
    !Number.isSafeInteger(term.firstPeriod) ||
    term.firstPeriod < 0 ||
    !Number.isSafeInteger(anchor) ||
    anchor < 0 ||
    anchor > term.firstPeriod
  )
    throw new RangeError("Invalid term start");
  let endsAt: number;
  try {
    endsAt = termEndsAt(term.firstPeriod, anchor);
  } catch {
    throw new RangeError("Invalid term start");
  }
  if (term.endsAt !== endsAt) throw new RangeError("Invalid term end");
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
      !isTermMonthStart(term.firstPeriod, segment.fromPeriod, anchor) ||
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
      !isTermMonthStart(term.firstPeriod, upgrade.fromPeriod, anchor) ||
      upgrade.fromPeriod < term.firstPeriod ||
      upgrade.fromPeriod >= term.endsAt ||
      tierAt(upgrade.fromPeriod) !== upgrade.tier ||
      // The tier it left: the one in force just before. In the first term month the upgrade
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
