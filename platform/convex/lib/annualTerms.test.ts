import { describe, expect, it } from "vite-plus/test";
import {
  addMonths,
  assertTermShape,
  isTermMonthStart,
  refundCents,
  remainingMonths,
  rescissionCents,
  termEndsAt,
  termMonthAt,
  termMonthIndex,
  termMonthStart,
  upgradeCents,
  usedMonths,
  withinWithdrawal,
} from "./annualTerms";
import { PLATFORM_PLANS } from "./planCatalog";
import { termRescission, termUpgradeCents } from "./planTerms";

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

describe("annual term from any instant to its anniversary", () => {
  const months = (start: number) =>
    Array.from({ length: 13 }, (_, index) => termMonthStart(start, index));

  it("keeps the 31st through short months, without drifting, and ends on January 31", () => {
    const start = Date.UTC(2027, 0, 31, 10);
    expect(months(start).slice(0, 4)).toEqual([
      start,
      Date.UTC(2027, 1, 28, 10),
      Date.UTC(2027, 2, 31, 10),
      Date.UTC(2027, 3, 30, 10),
    ]);
    expect(termEndsAt(start)).toBe(Date.UTC(2028, 0, 31, 10));
    // In a leap year February keeps its 29th.
    expect(addMonths(Date.UTC(2028, 0, 31, 10), 1)).toBe(Date.UTC(2028, 1, 29, 10));
  });

  it("starts on February 29 and ends on February 28 the next year, at the same time", () => {
    const start = Date.UTC(2028, 1, 29, 9, 15);
    expect(termMonthStart(start, 1)).toBe(Date.UTC(2028, 2, 29, 9, 15));
    expect(termEndsAt(start)).toBe(Date.UTC(2029, 1, 28, 9, 15));
  });

  it("goes from March 31 to April 30 and back to May 31", () => {
    const start = Date.UTC(2027, 2, 31, 8);
    expect(termMonthStart(start, 1)).toBe(Date.UTC(2027, 3, 30, 8));
    expect(termMonthStart(start, 2)).toBe(Date.UTC(2027, 4, 31, 8));
  });

  it("crosses the year from the last millisecond of December 31", () => {
    const start = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    expect(termMonthStart(start, 1)).toBe(Date.UTC(2027, 0, 31, 23, 59, 59, 999));
    expect(termMonthStart(start, 2)).toBe(Date.UTC(2027, 1, 28, 23, 59, 59, 999));
    expect(termEndsAt(start)).toBe(Date.UTC(2027, 11, 31, 23, 59, 59, 999));
  });

  it("turns each term month exactly at its start, not a millisecond before", () => {
    const start = Date.UTC(2026, 9, 15, 14, 30);
    const end = termEndsAt(start);
    expect(termMonthIndex(start, start - 1)).toBe(-1);
    expect(termMonthIndex(start, start)).toBe(0);
    const february = Date.UTC(2027, 1, 15, 14, 30);
    expect(termMonthIndex(start, february - 1)).toBe(3);
    expect(termMonthIndex(start, february)).toBe(4);
    expect(termMonthAt(start, february - 1)).toEqual({
      index: 3,
      startsAt: Date.UTC(2027, 0, 15, 14, 30),
      endsAt: february,
    });
    expect(termMonthAt(start, february)).toEqual({
      index: 4,
      startsAt: february,
      endsAt: Date.UTC(2027, 2, 15, 14, 30),
    });
    expect(termMonthIndex(start, end - 1)).toBe(11);
    expect(termMonthIndex(start, end)).toBe(12);
    expect(() => termMonthAt(start, start - 1)).toThrow(RangeError);
  });

  it("counts the term month under way as used and as remaining", () => {
    const startsAt = Date.UTC(2026, 9, 15, 14, 30);
    const term = { startsAt, endsAt: termEndsAt(startsAt) };
    expect(usedMonths(term, term.startsAt - 1)).toBe(0);
    expect(usedMonths(term, term.startsAt)).toBe(1);
    expect(usedMonths(term, term.endsAt - 1)).toBe(12);
    expect(usedMonths(term, term.endsAt)).toBe(12);
    expect(remainingMonths(term, term.startsAt - 1)).toBe(12);
    expect(remainingMonths(term, term.startsAt)).toBe(12);
    expect(remainingMonths(term, term.endsAt - 1)).toBe(1);
    expect(remainingMonths(term, term.endsAt)).toBe(0);
  });

  it("knows the starts of the term months, the end included", () => {
    const start = Date.UTC(2027, 0, 31, 10);
    expect(months(start).every((at) => isTermMonthStart(start, at))).toBe(true);
    expect(isTermMonthStart(start, Date.UTC(2027, 1, 1))).toBe(false);
    expect(isTermMonthStart(start, Date.UTC(2027, 1, 28, 10) + 1)).toBe(false);
    expect(isTermMonthStart(start, start - 1)).toBe(false);
    expect(isTermMonthStart(start, addMonths(start, 13))).toBe(false);
  });

  it("refuses an invalid instant or month count", () => {
    expect(() => addMonths(-1, 1)).toThrow(RangeError);
    expect(() => addMonths(Date.UTC(2027, 0, 1) + 0.5, 1)).toThrow(RangeError);
    expect(() => addMonths(Date.UTC(2027, 0, 1), -1)).toThrow(RangeError);
    expect(() => addMonths(Date.UTC(2027, 0, 1), 1.5)).toThrow(RangeError);
    expect(() => termMonthStart(Date.UTC(2027, 0, 1), 13)).toThrow(RangeError);
    expect(() => termEndsAt(Number.NaN)).toThrow(RangeError);
  });

  it("matches the civil UTC months for a start on a 1st at 00:00 UTC", () => {
    // The arithmetic before the anniversary terms, for starts on a 1st.
    const civil = (at: number) => {
      const date = new Date(at);
      return date.getUTCFullYear() * 12 + date.getUTCMonth();
    };
    const first = (at: number, add = 0) => {
      const date = new Date(at);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + add, 1);
    };
    for (let month = 0; month < 48; month++) {
      const startsAt = Date.UTC(2026, month, 1);
      const term = { startsAt, endsAt: termEndsAt(startsAt) };
      expect(term.endsAt).toBe(first(startsAt, 12));
      for (let index = 0; index <= 12; index++)
        expect(termMonthStart(startsAt, index)).toBe(first(startsAt, index));
      for (let at = startsAt - 86_400_000; at < term.endsAt + 86_400_000; at += 86_400_000 * 7) {
        for (const now of [at, first(at), first(at, 1) - 1]) {
          const used =
            now < startsAt ? 0 : now >= term.endsAt ? 12 : civil(now) - civil(startsAt) + 1;
          const remaining =
            now >= term.endsAt ? 0 : civil(term.endsAt) - Math.max(civil(now), civil(startsAt));
          expect(usedMonths(term, now)).toBe(used);
          expect(remainingMonths(term, now)).toBe(remaining);
          if (now >= startsAt) {
            expect(termMonthAt(startsAt, now).startsAt).toBe(first(now));
            expect(termMonthAt(startsAt, now).endsAt).toBe(first(now, 1));
          }
        }
      }
    }
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

  it("prices a term from 15/10 14:30 by term months, turning at 15/02 14:30", () => {
    const start = Date.UTC(2026, 9, 15, 14, 30);
    const term = {
      tier: "intermediate" as const,
      segments: [],
      firstPeriod: start,
      endsAt: termEndsAt(start),
    };
    const fifth = Date.UTC(2027, 1, 15, 14, 30);
    const priceAt = (now: number) =>
      termUpgradeCents(term, "large", termMonthAt(start, now).startsAt);
    // A millisecond before, the 4th term month is under way: 9 months left, 3.500 × 9 / 12.
    expect(priceAt(fifth - 1)).toBe(262500);
    // At 15/02 14:30 the 5th begins: 8 months left, 3.500 × 8 / 12 floored.
    expect(priceAt(fifth)).toBe(233333);
    expect(termUpgradeCents(term, "intermediate", start)).toBeNull();
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

  it("accepts a start at any instant that ends on its anniversary", () => {
    const midMonth = Date.UTC(2026, 9, 15, 14, 30);
    expect(() =>
      assertTermShape({
        ...shape,
        firstPeriod: midMonth,
        endsAt: Date.UTC(2027, 9, 15, 14, 30),
        segments: [],
      }),
    ).not.toThrow();
  });

  it("refuses an invalid start, a wrong end, and cents that are fractional or zero", () => {
    refuses({ firstPeriod: Date.UTC(2027, 0, 15) });
    refuses({ firstPeriod: start + 1 });
    refuses({ firstPeriod: -1, segments: [] });
    refuses({ firstPeriod: start + 0.5, segments: [] });
    refuses({ endsAt: Date.UTC(2027, 11, 1) });
    refuses({ endsAt: shape.endsAt + 1 });
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

  it("starts segments at the start of a term month, not on a civil 1st", () => {
    const midMonth = Date.UTC(2026, 9, 15, 14, 30);
    const term = { ...shape, firstPeriod: midMonth, endsAt: termEndsAt(midMonth) };
    const fifth = Date.UTC(2027, 1, 15, 14, 30);
    expect(() =>
      assertTermShape({ ...term, segments: [{ tier: "large", fromPeriod: fifth }] }),
    ).not.toThrow();
    for (const fromPeriod of [Date.UTC(2027, 1, 1), Date.UTC(2027, 1, 15), fifth + 1])
      expect(() => assertTermShape({ ...term, segments: [{ tier: "large", fromPeriod }] })).toThrow(
        RangeError,
      );
  });
});

describe("a term that continues a chain counts from its anchor (ADR 0012, section 1)", () => {
  const ANCHOR = Date.UTC(2028, 1, 29, 9, 15);
  const SECOND = Date.UTC(2029, 1, 28, 9, 15);

  it("ends on the anchor's anniversaries: 28/02 in common years, 29/02 again in 2032", () => {
    expect(termEndsAt(ANCHOR)).toBe(SECOND);
    expect(termEndsAt(SECOND, ANCHOR)).toBe(Date.UTC(2030, 1, 28, 9, 15));
    expect(termEndsAt(Date.UTC(2031, 1, 28, 9, 15), ANCHOR)).toBe(Date.UTC(2032, 1, 29, 9, 15));
    // Its own anchor, the second term would drift: 28/02 for good.
    expect(termEndsAt(Date.UTC(2031, 1, 28, 9, 15))).toBe(Date.UTC(2032, 1, 28, 9, 15));
  });

  it("turns its months on the anchor's day, not on its own start's", () => {
    expect(termMonthStart(SECOND, 1, ANCHOR)).toBe(Date.UTC(2029, 2, 29, 9, 15));
    expect(termMonthStart(SECOND, 1)).toBe(Date.UTC(2029, 2, 28, 9, 15));
    const march28 = Date.UTC(2029, 2, 28, 12);
    expect(termMonthAt(SECOND, march28, ANCHOR)).toEqual({
      index: 0,
      startsAt: SECOND,
      endsAt: Date.UTC(2029, 2, 29, 9, 15),
    });
    expect(termMonthIndex(SECOND, march28)).toBe(1);
    const span = { startsAt: SECOND, endsAt: termEndsAt(SECOND, ANCHOR), anchor: ANCHOR };
    expect(usedMonths(span, march28)).toBe(1);
    expect(remainingMonths(span, march28)).toBe(12);
    expect(isTermMonthStart(SECOND, Date.UTC(2029, 2, 29, 9, 15), ANCHOR)).toBe(true);
    expect(isTermMonthStart(SECOND, Date.UTC(2029, 2, 28, 9, 15), ANCHOR)).toBe(false);
  });

  it("refuses a start that is not one of the anchor's anniversaries, or before it", () => {
    expect(() => termEndsAt(SECOND + 1, ANCHOR)).toThrow(RangeError);
    expect(() => termEndsAt(Date.UTC(2029, 1, 27, 9, 15), ANCHOR)).toThrow(RangeError);
    expect(() => termEndsAt(ANCHOR - 1, ANCHOR)).toThrow(RangeError);
    const shape = {
      tier: "intermediate" as const,
      firstPeriod: SECOND,
      anchor: ANCHOR,
      endsAt: Date.UTC(2030, 1, 28, 9, 15),
      paidCents: intermediate.annualCents,
      purchasedAt: Date.UTC(2029, 0, 30),
      references: ["in_chain_renewal"],
      segments: [{ tier: "large" as const, fromPeriod: Date.UTC(2029, 2, 29, 9, 15) }],
    };
    expect(() => assertTermShape(shape)).not.toThrow();
    for (const change of [
      { anchor: ANCHOR + 1 },
      { anchor: SECOND + 1 },
      { endsAt: termEndsAt(SECOND) + 1 },
      { segments: [{ tier: "large" as const, fromPeriod: Date.UTC(2029, 2, 28, 9, 15) }] },
    ])
      expect(() => assertTermShape({ ...shape, ...change })).toThrow(RangeError);
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

  it("takes a charge at the start of a term month of a term from the 15th", () => {
    const midMonth = Date.UTC(2026, 9, 15, 14, 30);
    const fifth = Date.UTC(2027, 1, 15, 14, 30);
    const term = {
      ...shape,
      firstPeriod: midMonth,
      endsAt: termEndsAt(midMonth),
      segments: [{ tier: "large" as const, fromPeriod: fifth }],
    };
    const at = (fromPeriod: number) => () =>
      assertTermShape({ ...term, upgrades: [{ ...charge, fromPeriod }] });
    expect(at(fifth)).not.toThrow();
    expect(at(Date.UTC(2027, 1, 1))).toThrow(RangeError);
    expect(at(fifth - 1)).toThrow(RangeError);
    // In the first term month the upgrade changes the tier, from the term's start.
    expect(() =>
      assertTermShape({
        ...term,
        tier: "large",
        segments: [],
        upgrades: [{ ...charge, fromPeriod: midMonth, paidCents: 350000 }],
        paidCents: intermediate.annualCents + 350000,
      }),
    ).not.toThrow();
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

  it("counts term months for a term from 15/10 14:30: R$ 894 and access until 15/02 14:30", () => {
    const start = Date.UTC(2026, 9, 15, 14, 30);
    const term = {
      ...base,
      firstPeriod: start,
      endsAt: termEndsAt(start),
      purchasedAt: start,
    };
    // 20/01 falls in the 4th term month, from 15/01 14:30 to 15/02 14:30.
    expect(termRescission(term, Date.UTC(2027, 0, 20))).toEqual({
      withdrawal: false,
      usedMonths: 4,
      usedCents: 4 * 14900,
      refundCents: 89400,
      accessEndsAt: Date.UTC(2027, 1, 15, 14, 30),
    });
    // A millisecond before 15/02 14:30 is still the 4th; at it, the 5th begins.
    const fifth = Date.UTC(2027, 1, 15, 14, 30);
    expect(termRescission(term, fifth - 1)).toMatchObject({ usedMonths: 4, accessEndsAt: fifth });
    expect(termRescission(term, fifth)).toMatchObject({
      usedMonths: 5,
      refundCents: 149000 - 5 * 14900,
      accessEndsAt: Date.UTC(2027, 2, 15, 14, 30),
    });
    // Upgraded from the 5th term month, rescinded in the 8th: each month at the tier it had.
    const raised = {
      ...term,
      paidCents: 149000 + 233333,
      segments: [{ tier: "large" as const, fromPeriod: fifth }],
    };
    expect(termRescission(raised, Date.UTC(2027, 4, 20))).toMatchObject({
      usedMonths: 8,
      usedCents: 4 * 14900 + 4 * 49900,
      refundCents: 123133,
      accessEndsAt: Date.UTC(2027, 5, 15, 14, 30),
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
