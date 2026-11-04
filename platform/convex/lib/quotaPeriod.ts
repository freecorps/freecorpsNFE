import { termMonthAt } from "./annualTerms";

/**
 * Quota periods (ADR 0012, section 4). A plan without `periodAnchor` counts by the civil UTC
 * month; one with it, by the monthly anniversaries of the anchor (`addMonths`, the day clamped to
 * the month's last day and always counted from the anchor). A period is half-open, [start, end).
 *
 * Its key depends only on its start: a start on the 1st at 00:00:00.000 UTC has the key `AAAA-MM`,
 * any other the exact `Date.prototype.toISOString()` of the start. Only these two spellings are
 * canonical, so one instant has one key and the alphabetical order of the keys is the
 * chronological one. `stock`, the fixed key of the capacity stock, is not a period.
 */
export type QuotaPeriod = { key: string; startsAt: number; endsAt: number };
type Anchored = { periodAnchor?: number } | null | undefined;

/** The last instant a `Date` holds: 8.64e15 ms after 1970. */
const MAX_INSTANT = 8.64e15;
const CIVIL = /^(\d{4})-(\d{2})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isInstant = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_INSTANT;
const monthStart = (at: number) => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** The canonical key of a period that starts at `start`. */
export function periodKey(start: number) {
  if (!isInstant(start)) throw new RangeError("Invalid instant");
  const iso = new Date(start).toISOString();
  return monthStart(start) === start ? iso.slice(0, 7) : iso;
}

/** The start of the period a canonical key names, or null for any other spelling. */
export function periodKeyStart(key: string) {
  const civil = CIVIL.exec(key);
  const start = civil
    ? Date.UTC(Number(civil[1]), Number(civil[2]) - 1, 1)
    : ISO.test(key)
      ? Date.parse(key)
      : Number.NaN;
  return isInstant(start) && periodKey(start) === key ? start : null;
}

/** The civil UTC month holding `at`. */
export function civilPeriod(at: number): QuotaPeriod {
  if (!isInstant(at)) throw new RangeError("Invalid instant");
  const date = new Date(at);
  const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    key: periodKey(startsAt),
    startsAt,
    endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/** A valid `usagePlans.periodAnchor`: an instant truncated to the whole second. */
export const isPeriodAnchor = (value: number) => isInstant(value) && value % 1000 === 0;

/**
 * The quota period of `plan` holding `at`: the civil UTC month when the plan has no anchor or
 * `at` comes before it (a plan row not started yet); otherwise the month of the anchor holding
 * `at`, from its anniversary k − 1 to its anniversary k. A counter resolves it once, at the
 * reservation, from the plan read in the same transaction; the settlement uses the stored key.
 */
export function quotaPeriod(plan: Anchored, at: number): QuotaPeriod {
  const anchor = plan?.periodAnchor;
  if (anchor === undefined || at < anchor) return civilPeriod(at);
  const month = termMonthAt(anchor, at);
  return { key: periodKey(month.startsAt), startsAt: month.startsAt, endsAt: month.endsAt };
}

/**
 * The period a stored key names, as `plan` counts it: its start and, when the plan's own periods
 * include it, its end. A civil key always ends on the next 1st; an anchored key of an anchor the
 * plan no longer records (a replaced row) has no known end. Null when the key is not canonical.
 */
export function keyPeriod(plan: Anchored, key: string) {
  const startsAt = periodKeyStart(key);
  if (startsAt === null) return null;
  const own = quotaPeriod(plan, startsAt);
  if (own.key === key) return own;
  return { key, startsAt, endsAt: CIVIL.test(key) ? civilPeriod(startsAt).endsAt : null };
}
