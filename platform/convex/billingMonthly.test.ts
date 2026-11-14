import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import { reserveUsage } from "./lib/usageCore";
import {
  OCT,
  NOV,
  DEC,
  NOV_10,
  DEC_10,
  s,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  startInvoice,
  cycleInvoice,
  fixture,
  type Fixture,
  code,
  refusal,
  deliver,
  processEvents,
  startCard,
} from "../../tests/helpers/billing";

/**
 * The monthly card renews on the anniversary of its anchor (ADR 0012, slice 2a).
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("mensal no cartão por aniversário (ADR 0012, fatia 2a)", () => {
  const JAN_31 = Date.UTC(2027, 0, 31, 10, 0, 7);
  const FEB_28 = Date.UTC(2027, 1, 28, 10, 0, 7);
  const MAR_31 = Date.UTC(2027, 2, 31, 10, 0, 7);
  const APR_30 = Date.UTC(2027, 3, 30, 10, 0, 7);
  const OCT_1 = Date.UTC(2026, 9, 1);
  const sync = (f: Fixture) =>
    f.t.action(internal.billing.sync, { organizationId: f.organizationId });
  const grants = (f: Fixture) =>
    f.t
      .run((ctx) => ctx.db.query("billingGrants").collect())
      .then((rows) => rows.map((row) => [row.state, row.code ?? null, row.period]));
  const measure = (f: Fixture, key: string) =>
    f.t
      .run((ctx) => reserveUsage(ctx, f.organizationId, "sandbox", "attempts", key, 1, true))
      .then((event) => event.period);

  it("assinado em 31/01 às 10:00:07, renova em 28/02 e 31/03 sem deriva, e as cotas viram nos aniversários", async () => {
    const f = await fixture();
    vi.setSystemTime(JAN_31 + 250);
    const owner = await person(f.t, f.organizationId, "owner");
    await owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "start-on-the-31st",
    });
    const customer = (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
    // Stripe anchors the subscription at the signing, in whole seconds, and charges at once.
    const sub = f.fake.subscribe(customer, "intermediate");
    expect(sub.billing_cycle_anchor).toBe(s(JAN_31));
    const first = f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await sync(f);
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: JAN_31 + 250,
      endsAt: FEB_28,
      periodAnchor: JAN_31,
      version: 1,
    });
    expect(await measure(f, "january")).toBe("2027-01-31T10:00:07.000Z");
    // Replayed by Stripe, by another event or by the reconciliation: nothing new.
    for (let i = 0; i < 2; i++)
      await deliver(f, { type: "invoice.paid", data: { object: { id: first.id, customer } } });
    await processEvents(f);
    await sync(f);
    expect(await f.plan()).toMatchObject({ version: 1 });
    // 28/02, the 31st clamped to February's last day, at the same time.
    vi.setSystemTime(FEB_28);
    expect(await measure(f, "february-before-renewal")).toBe("2027-02-28T10:00:07.000Z");
    vi.setSystemTime(FEB_28 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, FEB_28, {}, MAR_31));
    (sub.items.data[0] as Json).current_period_end = s(MAR_31);
    await sync(f);
    // Counted from the anchor, never from 28/02: the next month ends on 31/03, not 28/03.
    expect(await f.plan()).toMatchObject({ endsAt: MAR_31, periodAnchor: JAN_31, version: 2 });
    vi.setSystemTime(MAR_31 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, MAR_31, {}, APR_30));
    (sub.items.data[0] as Json).current_period_end = s(APR_30);
    await sync(f);
    expect(await f.plan()).toMatchObject({ endsAt: APR_30, periodAnchor: JAN_31, version: 3 });
    expect(await measure(f, "march")).toBe("2027-03-31T10:00:07.000Z");
    expect(await grants(f)).toEqual([
      ["applied", null, "2027-01-31T10:00:07.000Z"],
      ["applied", null, "2027-02-28T10:00:07.000Z"],
      ["applied", null, "2027-03-31T10:00:07.000Z"],
    ]);
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toHaveLength(2);
  });

  it("uma fatura cujo período não é um mês da âncora vai para uma pessoa, sem mexer no plano", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await sync(f);
    vi.setSystemTime(NOV_10 + 3600_000);
    // A renewal counted from a drifted day: one day short of the anchor's month.
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10, {}, NOV_10 + 29 * 86400_000));
    await sync(f);
    expect(await grants(f)).toEqual([
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["blocked", "INVOICE_UNEXPECTED", null],
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: NOV_10, version: 1 });
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      (
        await owner.query(api.billing.overview, {
          asOf: Date.now(),
          organizationId: f.organizationId,
        })
      ).reviews,
    ).toMatchObject([{ code: "INVOICE_UNEXPECTED" }]);
  });

  it("a fatura de uma assinatura fora da lista lê a âncora pelo id; sem âncora, espera a próxima conferência", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    // A sync racing the completion: the paid first invoice is listed, its subscription is not.
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.state.unlisted.push(sub.id);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await sync(f);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "GET")).toHaveLength(1);
    expect(await f.plan()).toMatchObject({ endsAt: NOV_10, periodAnchor: OCT, version: 1 });
    // An anchor Stripe does not show at all records nothing: no permanent block, retried later.
    vi.setSystemTime(NOV_10 + 3600_000);
    const anchor = sub.billing_cycle_anchor;
    delete (sub as Partial<typeof sub>).billing_cycle_anchor;
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    await sync(f);
    expect(await grants(f)).toEqual([["applied", null, "2026-10-10T12:00:00.000Z"]]);
    expect(await f.plan()).toMatchObject({ endsAt: NOV_10, version: 1 });
    Object.assign(sub, { billing_cycle_anchor: anchor });
    await sync(f);
    expect(await grants(f)).toEqual([
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["applied", null, "2026-11-10T12:00:00.000Z"],
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10, version: 2 });
  });

  it("a fatura paga de uma assinatura que o Stripe não tem mais vai para revisão, sem esperar para sempre", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    f.fake.invoice(startInvoice(customer, "sub_gone_0000", f.organizationId, 14900));
    await sync(f);
    expect(await grants(f)).toEqual([["blocked", "INVOICE_UNEXPECTED", null]]);
    expect(await f.plan()).toBeNull();
  });

  it("a renovação cobrada abaixo de um upgrade cuja troca de preço não chegou fica para uma pessoa", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await sync(f);
    await f.owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "upgrade-switch-lost",
    });
    const name = f.fake
      .sent("/v1/checkout/sessions")
      .at(-1)!
      .params.get("line_items[0][price_data][product_data][name]");
    expect(name).toBe(
      "Mudança para Grande, diferença do mês do plano iniciado em 10/10/2026 às 12:00 UTC",
    );
    f.fake.invoice({
      customer,
      amount_paid: 35000,
      amount_due: 35000,
      billing_reason: "manual",
      metadata: {
        organizationId: f.organizationId,
        kind: "upgrade",
        tier: "large",
        period: "2026-10-10T12:00:00.000Z",
        grantCents: "35000",
      },
    });
    for (const session of f.fake.state.sessions.values()) session.status = "complete";
    // The upgrade is granted, but the switch of price never reaches Stripe.
    f.fake.state.failPaths.push(`/v1/subscriptions/${sub.id}`);
    expect(await code(sync(f))).toBe("ERROR");
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV_10 });
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.state.failPaths = [];
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    await sync(f);
    // Granted at the tier charged, flagged; the switch lands now, for the next month.
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: DEC_10 });
    expect(await grants(f)).toEqual([
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["applied", "RENEWAL_BELOW_UPGRADE", "2026-11-10T12:00:00.000Z"],
    ]);
    expect((sub.items.data[0] as Json).price).toBe("price_large");
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      (
        await owner.query(api.billing.overview, {
          asOf: Date.now(),
          organizationId: f.organizationId,
        })
      ).reviews,
    ).toMatchObject([{ code: "RENEWAL_BELOW_UPGRADE" }]);
  });

  it("uma assinatura anterior à fatia 2a, ancorada no dia 1, continua concedendo e sobe de plano", async () => {
    const f = await fixture();
    const CUSTOMER = "cus_legacy_day_one";
    // A card month granted before slice 2a: civil, without anchor, until the next 1st.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: CUSTOMER,
        livemode: false,
        renewalTier: "intermediate",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await activateCatalogPlan(ctx, f.organizationId, "intermediate", OCT, NOV, 0, "op", "Antes");
      await ctx.db.insert("billingGrants", {
        organizationId: f.organizationId,
        invoiceId: "in_legacy_october",
        tier: "intermediate",
        period: "2026-10",
        amountCents: 14900,
        state: "applied",
        planVersion: 1,
        createdAt: Date.now(),
      });
    });
    const sub = f.fake.subscribe(CUSTOMER, "intermediate", NOV, OCT_1);
    await sync(f);
    expect(await f.plan()).not.toHaveProperty("periodAnchor");
    // The upgrade is priced on the civil month in force and anchors it on that 1st: the same
    // `AAAA-MM` periods, now with an anchor (invariant 4).
    await f.owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "legacy-upgrade",
    });
    const sent = f.fake.sent("/v1/checkout/sessions").at(-1)!.params;
    expect(sent.get("invoice_creation[invoice_data][metadata][period]")).toBe("2026-10");
    expect(sent.get("line_items[0][price_data][unit_amount]")).toBe("35000");
    f.fake.invoice({
      customer: CUSTOMER,
      amount_paid: 35000,
      amount_due: 35000,
      billing_reason: "manual",
      metadata: {
        organizationId: f.organizationId,
        kind: "upgrade",
        tier: "large",
        period: "2026-10",
        grantCents: "35000",
      },
    });
    for (const session of f.fake.state.sessions.values()) session.status = "complete";
    await sync(f);
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: NOV,
      periodAnchor: OCT_1,
      version: 2,
    });
    expect(await measure(f, "october")).toBe("2026-10");
    // Its renewal on the 1st is a month of its anchor on 01/10: still granted, civil keys.
    vi.setSystemTime(NOV + 3600_000);
    f.fake.invoice(
      cycleInvoice(CUSTOMER, sub.id, NOV, {
        amount_paid: 49900,
        amount_due: 49900,
        lines: {
          data: [
            {
              amount: 49900,
              period: { start: s(NOV), end: s(DEC) },
              pricing: { type: "price_details", price_details: { price: "price_large" } },
            },
          ],
        },
      }),
    );
    (sub.items.data[0] as Json).current_period_end = s(DEC);
    await sync(f);
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: DEC,
      periodAnchor: OCT_1,
      version: 3,
    });
    expect(await measure(f, "november")).toBe("2026-11");
    expect(await grants(f)).toEqual([
      ["applied", null, "2026-10"],
      ["applied", null, "2026-10"],
      ["applied", null, "2026-11"],
    ]);
  });

  it("com um termo anual em vigor, o mensal no cartão espera o fim dele, com a data", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT,
        endsAt: termEndsAt(OCT),
        source: "stripe",
        references: ["in_annual_term_2a"],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      }),
    );
    expect(
      await refusal(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "monthly-under-term",
        }),
      ),
    ).toEqual({ code: "ANNUAL_TERM_ACTIVE", availableAt: termEndsAt(OCT) });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(0);
  });
});
