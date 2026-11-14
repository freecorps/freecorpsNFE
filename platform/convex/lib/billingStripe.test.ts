import { describe, expect, it, vi } from "vite-plus/test";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";
import {
  billingConfig,
  invoiceGrant,
  readAnnualPrices,
  readBillingEnvelope,
  readCatalogPrices,
  readInvoice,
  readSubscriptions,
} from "./billingStripe";
import { addMonths } from "./annualTerms";
import {
  NOV,
  DEC,
  WEBHOOK_SECRET,
  s,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  PRICES,
  price,
  YEARLY_PRICES,
  startInvoice,
  cycleInvoice,
  annualStartInvoice,
  annualCycleInvoice,
} from "../../../tests/helpers/billing";

/**
 * How the platform reads Stripe (#556): configuration, subscriptions, prices,
 * invoices and events, each read only through the selectors the server checked.
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("leitura do Stripe", () => {
  it("escolhe a assinatura que renova e só acusa duplicidade entre duas que renovam", () => {
    const sub = (id: string, created: number, cancel: boolean) => ({
      id,
      customer: "cus_1",
      status: "active",
      created,
      cancel_at_period_end: cancel,
      items: { data: [{ id: `si_${id}`, price: "price_int", current_period_end: s(NOV) }] },
    });
    const switched = readSubscriptions(
      { data: [sub("sub_new", 2, false), sub("sub_old", 1, true)] },
      "cus_1",
    );
    expect(switched).toMatchObject({ current: { id: "sub_new" }, duplicates: false });
    expect(switched.live).toHaveLength(2);
    const cancelling = readSubscriptions({ data: [sub("sub_old", 1, true)] }, "cus_1");
    expect(cancelling).toMatchObject({
      current: { id: "sub_old", cancelAtPeriodEnd: true },
      duplicates: false,
    });
    expect(
      readSubscriptions({ data: [sub("a", 1, false), sub("b", 2, false)] }, "cus_1"),
    ).toMatchObject({ current: { id: "b" }, duplicates: true });
    expect(readSubscriptions({ data: [sub("a", 1, false)] }, "cus_other").current).toBeNull();
  });

  it("só aceita configuração completa e chave real fora da instalação é recusada", () => {
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "");
    expect(billingConfig(false)).toBeNull();
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "rk_test_synthetic0000");
    expect(() => billingConfig(false)).toThrow("STRIPE_BILLING");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", WEBHOOK_SECRET);
    expect(billingConfig(false)).toMatchObject({ livemode: false });
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "rk_live_synthetic0000");
    expect(() => billingConfig(false)).toThrow("STRIPE_BILLING");
    expect(billingConfig(true)).toMatchObject({ livemode: true });
  });

  it("concede só o que o servidor precificou e manda o resto para revisão", () => {
    const org = "org_1";
    // Signed on 31/01 at 10:00:07 UTC: Stripe anchors the subscription there (ADR 0012).
    const JAN_31 = Date.UTC(2027, 0, 31, 10, 0, 7);
    const FEB_28 = Date.UTC(2027, 1, 28, 10, 0, 7);
    const MAR_31 = Date.UTC(2027, 2, 31, 10, 0, 7);
    const anchors: Record<string, number> = { sub_1: JAN_31 };
    const grant = (invoice: Parameters<typeof invoiceGrant>[0], to = org, at = anchors) =>
      invoiceGrant(invoice, PRICES, to, {}, [], at);
    const start = readInvoice({
      id: "in_1",
      ...startInvoice("cus_1", "sub_1", org, 14900, "intermediate", JAN_31),
      status: "paid",
      currency: "brl",
    })!;
    expect(grant(start)).toEqual({
      kind: "grant",
      tier: "intermediate",
      startsAt: JAN_31,
      endsAt: FEB_28,
      anchor: JAN_31,
    });
    expect(grant({ ...start, amountPaid: 100 })).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    expect(grant(start, "org_2")).toEqual({ kind: "review", code: "ORGANIZATION_MISMATCH" });
    expect(grant({ ...start, status: "open" })).toEqual({ kind: "none", code: "NOT_PAID" });
    expect(grant({ ...start, currency: "usd" })).toEqual({
      kind: "review",
      code: "CURRENCY_MISMATCH",
    });
    // Invariant 6: a line that is not one month of the anchor goes to a person. An anchor not
    // read yet decides nothing: the invoice waits for the next reconciliation.
    expect(grant(start, org, {})).toEqual({ kind: "none", code: "ANCHOR_UNKNOWN" });
    expect(grant(start, org, { sub_1: JAN_31 - 1000 })).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    expect(grant({ ...start, lines: [] })).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    // The first invoice of a Checkout before slice 2a: a one-off item and a recurring line from
    // the signing to the 1st it anchored on. It is no month of that anchor.
    const legacyStart = { ...start, lines: [{ ...start.lines[0]!, periodEnd: NOV }] };
    expect(grant(legacyStart, org, { sub_1: NOV })).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    const cycle = readInvoice({
      id: "in_2",
      ...cycleInvoice("cus_1", "sub_1", FEB_28, {}, MAR_31),
      status: "paid",
      currency: "brl",
    })!;
    // Counted from the anchor, never from the previous anniversary: 28/02 to 31/03, no drift.
    expect(grant(cycle)).toEqual({
      kind: "grant",
      tier: "intermediate",
      startsAt: FEB_28,
      endsAt: MAR_31,
      anchor: JAN_31,
    });
    const drifted = { ...cycle, lines: [{ ...cycle.lines[0]!, periodEnd: addMonths(FEB_28, 1) }] };
    expect(grant(drifted)).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    const offAnniversary = {
      ...cycle,
      lines: [{ ...cycle.lines[0]!, periodStart: FEB_28 + 3600_000 }],
    };
    expect(grant(offAnniversary)).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    // A subscription anchored on a 1st at 00:00 UTC, as before slice 2a: its months are civil.
    const legacy = readInvoice({
      id: "in_3",
      ...cycleInvoice("cus_1", "sub_1", NOV),
      status: "paid",
      currency: "brl",
    })!;
    expect(grant(legacy, org, { sub_1: Date.UTC(2026, 9, 1) })).toEqual({
      kind: "grant",
      tier: "intermediate",
      startsAt: NOV,
      endsAt: DEC,
      anchor: Date.UTC(2026, 9, 1),
    });
    expect(grant({ ...cycle, amountPaid: 49900 })).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    expect(grant({ ...cycle, lines: [] })).toEqual({ kind: "review", code: "PRICE_UNKNOWN" });
    expect(grant({ ...cycle, billingReason: "subscription_update" })).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    // A monthly upgrade names the quota period it was priced on, by its canonical key.
    const upgrade = readInvoice({
      id: "in_4",
      customer: "cus_1",
      status: "paid",
      currency: "brl",
      amount_paid: 35000,
      billing_reason: "manual",
      metadata: {
        organizationId: org,
        kind: "upgrade",
        tier: "large",
        period: "2027-02-28T10:00:07.000Z",
        grantCents: "35000",
      },
    })!;
    expect(grant(upgrade)).toEqual({
      kind: "upgrade",
      tier: "large",
      period: "2027-02-28T10:00:07.000Z",
    });
    for (const period of ["2027-02-28T10:00:07Z", "2027-02-01T00:00:00.000Z", undefined])
      expect(grant({ ...upgrade, metadata: { ...upgrade.metadata, period } })).toEqual({
        kind: "review",
        code: "AMOUNT_MISMATCH",
      });
  });

  it("aceita só o preço anual exato, por tier, sem afetar o mensal", () => {
    const monthly = [
      price("price_int", "fnfe_plan_intermediate_monthly_brl", 14900),
      price("price_large", "fnfe_plan_large_monthly_brl", 49900),
    ];
    const read = (yearly: Json[]) => ({
      monthly: readCatalogPrices({ data: [...monthly, ...yearly] }, false),
      annual: readAnnualPrices({ data: [...monthly, ...yearly] }, false),
    });
    expect(read(YEARLY_PRICES)).toEqual({
      monthly: PRICES,
      annual: {
        intermediate: { priceId: "price_int_year", productId: "prod_int_year" },
        large: { priceId: "price_large_year", productId: "prod_large_year" },
      },
    });
    const [intermediate, large] = YEARLY_PRICES;
    for (const wrong of [
      { ...large, currency: "usd" },
      { ...large, unit_amount: 498000 },
      { ...large, active: false },
      { ...large, recurring: { interval: "month", interval_count: 1 } },
      { ...large, recurring: { interval: "year", interval_count: 2 } },
    ])
      expect(read([intermediate!, wrong])).toEqual({
        monthly: PRICES,
        annual: { intermediate: { priceId: "price_int_year", productId: "prod_int_year" } },
      });
    expect(read([])).toEqual({ monthly: PRICES, annual: {} });
  });

  it("uma fatura anual compra um ano exato da âncora pelo annualCents e só com o preço anual conferido", () => {
    const org = "org_1";
    const ANNUAL = {
      intermediate: { priceId: "price_int_year", productId: "prod_int_year" },
    };
    // Signed on 31/01/2027 at 10:00:07 UTC: Stripe anchors the subscription and charges the
    // first year there (ADR 0012, slice 2b).
    const JAN_31 = Date.UTC(2027, 0, 31, 10, 0, 7);
    const JAN_31_NEXT = Date.UTC(2028, 0, 31, 10, 0, 7);
    const anchors: Record<string, number> = { sub_1: JAN_31 };
    const grant = (
      invoice: Parameters<typeof invoiceGrant>[0],
      annual: Parameters<typeof invoiceGrant>[3] = ANNUAL,
      at = anchors,
      annualSubscriptions: string[] = [],
    ) => invoiceGrant(invoice, PRICES, org, annual, annualSubscriptions, at);
    const start = readInvoice({
      id: "in_1",
      ...annualStartInvoice("cus_1", "sub_1", org, { start: JAN_31, paidAt: JAN_31 }),
      status: "paid",
      currency: "brl",
    })!;
    expect(start.paidAt).toBe(JAN_31);
    expect(grant(start)).toEqual({
      kind: "annual",
      tier: "intermediate",
      startsAt: JAN_31,
      endsAt: JAN_31_NEXT,
      anchor: JAN_31,
    });
    // A period mark, as the Checkouts before slice 2b set, names nothing: the line decides.
    const marked = {
      ...start,
      subscriptionMetadata: { ...start.subscriptionMetadata, period: "2027-02" },
    };
    expect(grant(marked)).toMatchObject({ kind: "annual", startsAt: JAN_31 });
    // Invariant 6, annual half: a line that is not one year of the anchor goes to a person. An
    // anchor not read yet decides nothing: the invoice waits for the next reconciliation.
    expect(grant(start, ANNUAL, {})).toEqual({ kind: "none", code: "ANCHOR_UNKNOWN" });
    const line = start.lines[0]!;
    for (const lines of [
      [{ ...line, periodEnd: addMonths(JAN_31, 1) }],
      [{ ...line, periodEnd: JAN_31_NEXT - 1000 }],
      [{ ...line, periodStart: JAN_31 + 3600_000 }],
    ])
      expect(grant({ ...start, lines })).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    expect(grant(start, ANNUAL, { sub_1: JAN_31 - 1000 })).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    // Marked annual, but no line at the verified yearly price: nothing shows it renews yearly.
    expect(grant({ ...start, lines: [] })).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    expect(grant(start, {})).toEqual({ kind: "review", code: "PRICE_UNKNOWN" });
    expect(
      grant({
        ...start,
        amountPaid: 14900,
        subscriptionMetadata: { ...start.subscriptionMetadata, grantCents: "14900" },
      }),
    ).toEqual({ kind: "review", code: "AMOUNT_MISMATCH" });
    // The subscription renews at what its recurring line charges: it must be the cycle bought.
    const monthlyLine = [{ ...line, priceId: "price_int" }];
    expect(grant({ ...start, lines: monthlyLine })).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    const monthlyStart = readInvoice({
      id: "in_3",
      ...startInvoice("cus_1", "sub_1", org, 14900),
      status: "paid",
      currency: "brl",
    })!;
    expect(
      invoiceGrant(monthlyStart, PRICES, org, ANNUAL, [], {
        sub_1: monthlyStart.lines[0]!.periodStart,
      }),
    ).toMatchObject({ kind: "grant" });
    const yearlyLine = [{ ...monthlyStart.lines[0]!, priceId: "price_int_year" }];
    expect(invoiceGrant({ ...monthlyStart, lines: yearlyLine }, PRICES, org, ANNUAL)).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    // A yearly price that no longer verifies is unknown by id, but its subscription is annual.
    expect(
      invoiceGrant({ ...monthlyStart, lines: yearlyLine }, PRICES, org, {}, ["sub_1"]),
    ).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    const yearlySub = (price: Json | string) => ({
      data: [
        {
          id: "sub_1",
          customer: "cus_1",
          status: "canceled",
          items: { data: [{ id: "si_1", price }] },
        },
      ],
    });
    expect(readSubscriptions(yearlySub(YEARLY_PRICES[0]!), "cus_1").annualIds).toEqual(["sub_1"]);
    expect(
      readSubscriptions(yearlySub({ id: "price_x", recurring: { interval: "year" } }), "cus_1")
        .annualIds,
    ).toEqual(["sub_1"]);
    expect(readSubscriptions(yearlySub("price_int_year"), "cus_1").annualIds).toEqual([]);
    // A chain anchored on 29/02/2028 renews on 28/02/2029, 2030 and 2031 and on 29/02/2032,
    // always counted from the anchor; a year counted from the previous anniversary drifts.
    const FEB_29 = Date.UTC(2028, 1, 29, 10, 0, 7);
    const leap = { sub_1: FEB_29 };
    const renewal = (from: number, to: number) =>
      readInvoice({
        id: "in_2",
        ...annualCycleInvoice("cus_1", "sub_1", from, { end: to }),
        status: "paid",
        currency: "brl",
      })!;
    const FEB_28_2031 = Date.UTC(2031, 1, 28, 10, 0, 7);
    const FEB_29_2032 = Date.UTC(2032, 1, 29, 10, 0, 7);
    expect(grant(renewal(FEB_28_2031, FEB_29_2032), ANNUAL, leap)).toEqual({
      kind: "annual",
      tier: "intermediate",
      startsAt: FEB_28_2031,
      endsAt: FEB_29_2032,
      anchor: FEB_29,
    });
    expect(grant(renewal(FEB_28_2031, Date.UTC(2032, 1, 28, 10, 0, 7)), ANNUAL, leap)).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    // Not a year of the anchor: 13 months in, or a month's line at the yearly price.
    expect(
      grant(
        renewal(Date.UTC(2029, 2, 29, 10, 0, 7), Date.UTC(2030, 2, 29, 10, 0, 7)),
        ANNUAL,
        leap,
      ),
    ).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    // A card annual anchored on a 1st at 00:00 UTC, as before slice 2b, keeps renewing.
    const legacy = renewal(NOV, Date.UTC(2027, 10, 1));
    expect(grant(legacy, ANNUAL, { sub_1: Date.UTC(2025, 10, 1) })).toEqual({
      kind: "annual",
      tier: "intermediate",
      startsAt: NOV,
      endsAt: Date.UTC(2027, 10, 1),
      anchor: Date.UTC(2025, 10, 1),
    });
    const yearly = renewal(JAN_31_NEXT, Date.UTC(2029, 0, 31, 10, 0, 7));
    expect(grant(yearly)).toMatchObject({ kind: "annual", startsAt: JAN_31_NEXT });
    expect(grant(yearly, {})).toEqual({ kind: "review", code: "PRICE_UNKNOWN" });
    expect(grant({ ...yearly, amountPaid: 14900 })).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    // The annual upgrade: a one-off payment marked annual, priced on the term month it names.
    const upgrade = readInvoice({
      id: "in_4",
      customer: "cus_1",
      status: "paid",
      currency: "brl",
      amount_paid: 233333,
      billing_reason: "manual",
      metadata: {
        organizationId: org,
        kind: "upgrade",
        cycle: "annual",
        tier: "large",
        period: "2027-05-31T10:00:07.000Z",
        grantCents: "233333",
      },
    })!;
    const LARGE = {
      ...ANNUAL,
      large: { priceId: "price_large_year", productId: "prod_large_year" },
    };
    expect(grant(upgrade, LARGE)).toEqual({
      kind: "annualUpgrade",
      tier: "large",
      period: "2027-05-31T10:00:07.000Z",
    });
    // Without the yearly price it moves the subscription to, it waits for a person.
    expect(grant(upgrade)).toEqual({ kind: "review", code: "PRICE_UNKNOWN" });
    expect(
      grant({ ...upgrade, metadata: { ...upgrade.metadata, period: undefined } }, LARGE),
    ).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    expect(
      grant({ ...upgrade, metadata: { ...upgrade.metadata, cycle: undefined } }, LARGE),
    ).toEqual({ kind: "upgrade", tier: "large", period: "2027-05-31T10:00:07.000Z" });
  });

  it("lê do evento só seletores e marca reembolso e contestação para revisão", () => {
    expect(readBillingEnvelope("{")).toBe("INVALID");
    expect(
      readBillingEnvelope(
        JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } }),
      ),
    ).toBe("INVALID");
    expect(
      readBillingEnvelope(
        JSON.stringify({
          id: "evt_1",
          type: "payout.paid",
          livemode: false,
          data: { object: { id: "po_1" } },
        }),
      ),
    ).toBeNull();
    expect(
      readBillingEnvelope(
        JSON.stringify({
          id: "evt_1",
          type: "charge.refunded",
          livemode: false,
          data: {
            object: { id: "ch_1", customer: "cus_1", amount_refunded: 14900, refunded: true },
          },
        }),
      ),
    ).toMatchObject({
      customerId: "cus_1",
      chargeId: "ch_1",
      amountCents: 14900,
      review: "REFUND_FULL",
    });
    expect(
      readBillingEnvelope(
        JSON.stringify({
          id: "evt_2",
          type: "charge.dispute.closed",
          livemode: false,
          data: { object: { id: "dp_1", charge: "ch_1", amount: 14900, status: "lost" } },
        }),
      ),
    ).toMatchObject({ chargeId: "ch_1", review: "DISPUTE_LOST" });
  });
});
