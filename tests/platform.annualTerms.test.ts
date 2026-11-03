import { describe, expect, it } from "vite-plus/test";
import {
  assertTermShape,
  refundCents,
  remainingMonths,
  rescissionCents,
  termEndsAt,
  upgradeCents,
  usedMonths,
  withinWithdrawal,
} from "../platform/convex/lib/annualTerms";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import { termRescission } from "../platform/convex/lib/planTerms";

const { intermediate, large } = PLATFORM_PLANS;
const term = (year: number, month: number) => {
  const startsAt = Date.UTC(year, month, 1);
  return { startsAt, endsAt: termEndsAt(startsAt) };
};
const refundAt = (now: number, purchasedAt = Date.UTC(2027, 0, 1)) =>
  refundCents({
    paidAnnualCents: intermediate.annualCents,
    monthlyCents: intermediate.monthlyCents,
    usedMonths: usedMonths(term(2027, 0), now),
    withinWithdrawal: withinWithdrawal(purchasedAt, now),
  });

describe("annual catalog", () => {
  it("prices 12 months for the price of 10 on the paid tiers only", () => {
    expect(intermediate.annualCents).toBe(10 * intermediate.monthlyCents);
    expect(large.annualCents).toBe(10 * large.monthlyCents);
    expect("annualCents" in PLATFORM_PLANS.free).toBe(false);
  });
});

describe("annual term in civil UTC months", () => {
  it("ends on the 1st twelve months later, crossing the year from December", () => {
    expect(termEndsAt(Date.UTC(2026, 11, 1))).toBe(Date.UTC(2027, 11, 1));
    expect(termEndsAt(Date.UTC(2027, 1, 1))).toBe(Date.UTC(2028, 1, 1));
  });

  it("refuses a start that is not the 1st at 00:00 UTC", () => {
    expect(() => termEndsAt(Date.UTC(2026, 11, 2))).toThrow(RangeError);
    expect(() => termEndsAt(Date.UTC(2026, 11, 1, 3))).toThrow(RangeError);
  });

  it("counts the current month as used and as remaining, across December", () => {
    const december = term(2026, 11);
    expect(usedMonths(december, Date.UTC(2026, 11, 1))).toBe(1);
    expect(remainingMonths(december, Date.UTC(2026, 11, 1))).toBe(12);
    expect(usedMonths(december, Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(1);
    expect(usedMonths(december, Date.UTC(2027, 0, 1))).toBe(2);
    expect(remainingMonths(december, Date.UTC(2027, 0, 15))).toBe(11);
    expect(usedMonths(december, Date.UTC(2027, 10, 30))).toBe(12);
    expect(remainingMonths(december, Date.UTC(2027, 10, 30))).toBe(1);
    expect(usedMonths(december, december.endsAt)).toBe(12);
    expect(remainingMonths(december, december.endsAt)).toBe(0);
  });

  it("turns the month at midnight UTC at the end of February, leap year included", () => {
    const march = term(2027, 2);
    expect(usedMonths(term(2027, 1), Date.UTC(2027, 1, 28, 23, 59, 59, 999))).toBe(1);
    expect(usedMonths(term(2027, 1), Date.UTC(2027, 2, 1))).toBe(2);
    expect(usedMonths(march, Date.UTC(2028, 1, 29, 12))).toBe(12);
    expect(remainingMonths(march, Date.UTC(2028, 1, 29, 12))).toBe(1);
    expect(remainingMonths(march, Date.UTC(2028, 2, 1))).toBe(0);
  });
});

describe("annual refund", () => {
  it("returns R$ 894 for the Intermediário cancelled in the 4th month", () => {
    expect(refundAt(Date.UTC(2027, 3, 10))).toBe(89400);
  });

  it("returns nothing from the 10th month on", () => {
    expect(refundAt(Date.UTC(2027, 8, 30))).toBe(14900);
    expect(refundAt(Date.UTC(2027, 9, 1))).toBe(0);
    expect(refundAt(Date.UTC(2027, 11, 31))).toBe(0);
  });

  it("returns everything within 7 × 24 h of the purchase, and not a millisecond later", () => {
    const purchasedAt = Date.UTC(2026, 11, 28, 15);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // Bought for the next term in December; cancelled in its first days.
    expect(refundAt(Date.UTC(2026, 11, 30), purchasedAt)).toBe(149000);
    expect(refundAt(purchasedAt + sevenDays, purchasedAt)).toBe(149000);
    expect(refundAt(purchasedAt + sevenDays + 1, purchasedAt)).toBe(149000 - 14900);
  });

  it("does not count a moment before the purchase as within the withdrawal period", () => {
    const purchasedAt = Date.UTC(2027, 0, 10);
    expect(withinWithdrawal(purchasedAt, purchasedAt - 1)).toBe(false);
  });
});

describe("annual upgrade", () => {
  const upgrade = (remaining: number) =>
    upgradeCents({
      fromAnnualCents: intermediate.annualCents,
      toAnnualCents: large.annualCents,
      remainingMonths: remaining,
    });

  it("charges the difference over the remaining months, floored once on the total", () => {
    expect(upgrade(12)).toBe(350000);
    expect(upgrade(6)).toBe(175000);
    expect(upgrade(1)).toBe(29166);
    // Rounding each month down would give 5 × 29166 = 145830 and 7 × 29166 = 204162.
    expect(upgrade(5)).toBe(145833);
    expect(upgrade(7)).toBe(204166);
    expect(upgrade(11)).toBe(320833);
    expect(upgrade(0)).toBe(0);
  });

  it("refuses a downgrade and values outside the term or in fractional cents", () => {
    expect(() =>
      upgradeCents({ fromAnnualCents: 499000, toAnnualCents: 149000, remainingMonths: 3 }),
    ).toThrow(RangeError);
    expect(() => upgrade(13)).toThrow(RangeError);
    expect(() => upgrade(2.5)).toThrow(RangeError);
    expect(() =>
      refundCents({
        paidAnnualCents: 1490.5,
        monthlyCents: 14900,
        usedMonths: 1,
        withinWithdrawal: false,
      }),
    ).toThrow(RangeError);
  });
});

describe("term shape", () => {
  const start = Date.UTC(2027, 0, 1);
  const MAY = Date.UTC(2027, 4, 1);
  const shape = {
    tier: "intermediate" as const,
    firstPeriod: start,
    endsAt: termEndsAt(start),
    paidCents: intermediate.annualCents,
    purchasedAt: Date.UTC(2026, 11, 20, 15),
    references: ["in_synthetic_annual"],
    segments: [{ tier: "large" as const, fromPeriod: MAY }],
  };
  const refuses = (change: Partial<Parameters<typeof assertTermShape>[0]>) =>
    expect(() => assertTermShape({ ...shape, ...change })).toThrow(RangeError);

  it("accepts a term from a 1st, 00:00 UTC, ending 12 months later, with an upgrade", () => {
    expect(() => assertTermShape(shape)).not.toThrow();
    expect(() => assertTermShape({ ...shape, segments: [] })).not.toThrow();
  });

  it("refuses a mid-month start, a wrong end, and cents that are fractional or zero", () => {
    refuses({ firstPeriod: Date.UTC(2027, 0, 15) });
    refuses({ firstPeriod: start + 1 });
    refuses({ endsAt: Date.UTC(2027, 11, 1) });
    refuses({ paidCents: 1490.5 });
    refuses({ paidCents: 0 });
  });

  it("refuses missing or repeated references", () => {
    refuses({ references: [] });
    refuses({ references: ["in_synthetic_annual", "in_synthetic_annual"] });
  });

  it("takes segments as upgrades only: after the start, in order, on a higher tier", () => {
    refuses({ segments: [{ tier: "large", fromPeriod: Date.UTC(2027, 4, 2) }] });
    refuses({ segments: [{ tier: "large", fromPeriod: start }] });
    refuses({ segments: [{ tier: "large", fromPeriod: shape.endsAt }] });
    refuses({ segments: [{ tier: "intermediate", fromPeriod: MAY }] });
    refuses({ tier: "large", segments: [{ tier: "intermediate", fromPeriod: MAY }] });
    refuses({
      segments: [
        { tier: "large", fromPeriod: MAY },
        { tier: "large", fromPeriod: MAY },
      ],
    });
  });
});

describe("upgrade charges on the term", () => {
  const start = Date.UTC(2027, 0, 1);
  const MAY = Date.UTC(2027, 4, 1);
  // Upgraded in May: 8 months left at (R$ 4.990 − R$ 1.490) / 12.
  const charge = {
    fromTier: "intermediate" as "intermediate" | "large",
    tier: "large" as const,
    fromPeriod: MAY,
    reference: "in_synthetic_upgrade",
    paidCents: 233333,
    paidAt: Date.UTC(2027, 4, 10, 15),
  };
  const shape = {
    tier: "intermediate" as const,
    firstPeriod: start,
    endsAt: termEndsAt(start),
    paidCents: intermediate.annualCents + charge.paidCents,
    purchasedAt: Date.UTC(2026, 11, 20, 15),
    references: ["in_synthetic_annual", charge.reference],
    segments: [{ tier: "large" as const, fromPeriod: MAY }],
    upgrades: [charge],
  };
  const refuses = (change: Partial<typeof charge>, term: Partial<typeof shape> = {}) =>
    expect(() =>
      assertTermShape({ ...shape, ...term, upgrades: [{ ...charge, ...change }] }),
    ).toThrow(RangeError);

  it("keeps each upgrade charge with its month, reference and payment", () => {
    expect(() => assertTermShape(shape)).not.toThrow();
    // In the first month the upgrade covers the whole term: the tier changes, no segment.
    expect(() =>
      assertTermShape({
        ...shape,
        tier: "large",
        segments: [],
        upgrades: [{ ...charge, fromPeriod: start, paidCents: 350000 }],
        paidCents: intermediate.annualCents + 350000,
      }),
    ).not.toThrow();
  });

  it("refuses a charge that does not match the term's tiers, references or money", () => {
    refuses({ fromPeriod: Date.UTC(2027, 4, 2) });
    refuses({ fromPeriod: termEndsAt(start) });
    refuses({ fromPeriod: Date.UTC(2027, 3, 1) });
    refuses({ fromTier: "large" });
    refuses({ reference: "in_not_in_references" });
    refuses({ paidCents: 0 });
    refuses({ paidCents: 1.5 });
    refuses({ paidAt: -1 });
    refuses({}, { paidCents: charge.paidCents });
    expect(() =>
      assertTermShape({ ...shape, upgrades: [charge, { ...charge, paidCents: 1 }] }),
    ).toThrow(RangeError);
  });
});

describe("rescission of a term (termRescission)", () => {
  const OCT_1 = Date.UTC(2026, 9, 1);
  const FEB_1 = Date.UTC(2027, 1, 1);
  const base = {
    tier: "intermediate" as const,
    firstPeriod: OCT_1,
    endsAt: termEndsAt(OCT_1),
    paidCents: 149000,
    purchasedAt: Date.UTC(2026, 9, 10, 12),
    segments: [] as { tier: "intermediate" | "large"; fromPeriod: number }[],
    state: "active" as "active" | "scheduled",
  };
  const upgraded = {
    ...base,
    paidCents: 149000 + 233333,
    segments: [{ tier: "large" as const, fromPeriod: FEB_1 }],
  };

  it("reprices each used month at the tier it had: the example of R$ 1.231,33", () => {
    // Upgrade in the 5th month (February), rescinded in the 8th (May).
    expect(termRescission(upgraded, Date.UTC(2027, 4, 20))).toEqual({
      withdrawal: false,
      usedMonths: 8,
      usedCents: 4 * 14900 + 4 * 49900,
      refundCents: 123133,
      accessEndsAt: Date.UTC(2027, 5, 1),
    });
    expect(
      rescissionCents({
        paidCents: 382333,
        usedMonthlyCents: [14900, 14900, 14900, 14900, 49900, 49900, 49900, 49900],
        withinWithdrawal: false,
      }),
    ).toBe(123133);
  });

  it("returns R$ 894 in the 4th month, nothing from the 10th, and never less than zero", () => {
    expect(termRescission(base, Date.UTC(2027, 0, 31, 23))).toMatchObject({
      usedMonths: 4,
      refundCents: 89400,
      accessEndsAt: FEB_1,
    });
    expect(termRescission(base, Date.UTC(2027, 6, 1))).toMatchObject({ refundCents: 0 });
    // In the last month the access ends with the term.
    expect(termRescission(upgraded, Date.UTC(2027, 8, 15))).toMatchObject({
      usedMonths: 12,
      refundCents: 0,
      accessEndsAt: base.endsAt,
    });
  });

  it("within 7 days of the annual charge, a renewal included, returns everything and ends now", () => {
    const renewal = { ...base, purchasedAt: Date.UTC(2027, 9, 1, 1) };
    const at = renewal.purchasedAt + 7 * 24 * 60 * 60 * 1000;
    expect(termRescission(renewal, at)).toEqual({
      withdrawal: true,
      usedMonths: 12,
      usedCents: 12 * 14900,
      refundCents: 149000,
      accessEndsAt: at,
    });
    expect(termRescission(upgraded, base.purchasedAt + 1)).toMatchObject({
      withdrawal: true,
      refundCents: 382333,
      accessEndsAt: base.purchasedAt + 1,
    });
  });

  it("a term not started yet used nothing: everything back, even after 7 days", () => {
    const next = {
      ...base,
      firstPeriod: Date.UTC(2026, 11, 1),
      endsAt: termEndsAt(Date.UTC(2026, 11, 1)),
      purchasedAt: Date.UTC(2026, 9, 2),
      state: "scheduled" as const,
    };
    const at = Date.UTC(2026, 10, 20);
    expect(termRescission(next, at)).toEqual({
      withdrawal: false,
      usedMonths: 0,
      usedCents: 0,
      refundCents: 149000,
      accessEndsAt: at,
    });
    // Still `scheduled` after its 1st: the activation was refused and no plan was granted.
    const blocked = Date.UTC(2027, 1, 20);
    expect(termRescission(next, blocked)).toEqual({
      withdrawal: false,
      usedMonths: 0,
      usedCents: 0,
      refundCents: 149000,
      accessEndsAt: blocked,
    });
  });
});
