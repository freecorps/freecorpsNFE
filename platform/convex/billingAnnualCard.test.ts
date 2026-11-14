import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { addMonths, termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import {
  OCT,
  NOV,
  NOV_10,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  YEARLY_PRICES,
  startInvoice,
  cycleInvoice,
  fixture,
  type Fixture,
  code,
  processEvents,
  startCard,
} from "../../tests/helpers/billing";
import {
  OCT_1,
  YEAR,
  LEGACY,
  CUSTOMER,
  invoiceId,
  annualCard,
  annualStart,
  annualRenewal,
  sync,
  terms,
  grants,
  paid,
  stock,
  runUntil,
  legacyTerm,
  DAY,
} from "../../tests/helpers/billingAnnualCard";

/**
 * A paid card annual invoice becomes a term (ADR 0010, decision 9, and ADR 0012, slice 2b).
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("anual por cartão: a fatura vira termo (ADR 0010, decisão 9, e ADR 0012, fatia 2b)", () => {
  it("na contratação, cria um termo ativo da âncora e concede o plano até o fim dele, uma vez", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    const invoice = annualStart(f, sub.id);
    await sync(f);
    // Repeated reconciliation and a repeated event weigh the invoice once.
    await sync(f);
    await paid(f, invoice.id);
    await paid(f, invoice.id);
    await processEvents(f);
    const all = await terms(f);
    expect(all).toHaveLength(1);
    const term = all[0]!;
    expect(term).toMatchObject({
      organizationId: f.organizationId,
      state: "active",
      source: "stripe",
      tier: "intermediate",
      firstPeriod: OCT,
      endsAt: YEAR,
      references: [invoice.id],
      stripeSubscriptionId: sub.id,
      paidCents: 149000,
      purchasedAt: OCT,
    });
    // The first term starts on the anchor: it is its own, as the term records no other.
    expect(term.anchor).toBeUndefined();
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: term._id,
      startsAt: OCT,
      endsAt: YEAR,
      periodAnchor: OCT,
      version: 1,
    });
    expect(await grants(f)).toMatchObject([
      {
        invoiceId: invoice.id,
        state: "applied",
        period: "2026-10-10T12:00:00.000Z",
        termId: term._id,
        planVersion: 1,
      },
    ]);
    // The yearly subscription is never moved to a monthly price.
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    expect((await f.billing()).account?.subscription).toMatchObject({ tier: "intermediate" });
    // Another annual invoice for months the term covers: paid, so blocked for a person. Its
    // subscription renews the term it bought, so nothing stops it.
    const twice = annualStart(f, sub.id);
    await sync(f);
    expect((await grants(f))[1]).toMatchObject({
      invoiceId: twice.id,
      state: "blocked",
      code: "ANNUAL_TERM_ACTIVE",
    });
    expect((await grants(f))[1]!.subscriptionStop).toBeUndefined();
    expect(await terms(f)).toHaveLength(1);
  });

  it("um anual anterior à fatia 2b, ancorado no dia 1, renova no último mês: o termo seguinte fica agendado sem intervalo e sem nova reserva", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { anchor: LEGACY });
    const old = await legacyTerm(f);
    const before = await stock(f);
    // Paid in the old term's last month, a year of the anchor 01/11/2025 ahead.
    const renewal = f.fake.invoice(annualRenewal(sub.id, NOV, { anchor: LEGACY }));
    await sync(f);
    // Its own previous term does not block the renewal.
    const renewed = (await terms(f)).find((term) => term._id !== old)!;
    expect(renewed).toMatchObject({
      state: "scheduled",
      source: "stripe",
      firstPeriod: NOV,
      anchor: LEGACY,
      endsAt: Date.UTC(2027, 10, 1),
      references: [renewal.id],
    });
    expect(await grants(f)).toMatchObject([
      { invoiceId: renewal.id, state: "applied", period: "2026-11", termId: renewed._id },
    ]);
    expect(await f.plan()).toMatchObject({ termId: old, endsAt: NOV });
    await runUntil(f, NOV);
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      startsAt: NOV,
      endsAt: Date.UTC(2027, 10, 1),
      periodAnchor: LEGACY,
      version: 2,
    });
    expect(await stock(f)).toEqual(before);
  });

  it("fora de ordem ou repetida, cada fatura anual vira um termo só", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    const first = annualStart(f, sub.id);
    await sync(f);
    // A year later, in the term's last month, the renewal is paid.
    vi.setSystemTime(Date.UTC(2027, 8, 15));
    const renewal = f.fake.invoice(annualRenewal(sub.id, YEAR));
    // The renewal's event first, then a late repeat of the first invoice's.
    await paid(f, renewal.id);
    await paid(f, first.id);
    await processEvents(f);
    await sync(f);
    expect((await terms(f)).map((term) => [term.state, term.firstPeriod, term.anchor])).toEqual([
      ["active", OCT, undefined],
      ["scheduled", YEAR, OCT],
    ]);
    expect((await grants(f)).map((grant) => [grant.invoiceId, grant.state])).toEqual([
      [first.id, "applied"],
      [renewal.id, "applied"],
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: YEAR, version: 1 });
  });

  it.each([
    ["com valor diferente", "AMOUNT_MISMATCH", { amount: 148000 }],
    ["em outra moeda", "CURRENCY_MISMATCH", { fields: { currency: "usd" } }],
    // Invariant 6, annual half: a month's line at the yearly price is no year of the anchor.
    ["cuja linha não é um ano da âncora", "INVOICE_UNEXPECTED", { end: addMonths(OCT, 1) }],
    ["com o id fora do formato de referência", "INVOICE_UNEXPECTED", { fields: { id: "in_1" } }],
  ] as const)("bloqueia a primeira fatura %s", async (_, blocked, options) => {
    const f = await fixture();
    const sub = await annualCard(f);
    annualStart(f, sub.id, options);
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: blocked }]);
    expect(await terms(f)).toEqual([]);
    expect(await f.plan()).toBeNull();
  });

  it.each([
    ["mensal com a lookup key anual", "PRICE_UNKNOWN", "price_int_year", 149000, true],
    ["desconhecido", "PRICE_UNKNOWN", "price_somewhere_else", 149000, false],
    ["anual com valor diferente", "AMOUNT_MISMATCH", "price_int_year", 14900, false],
  ] as const)(
    "bloqueia a renovação a um preço %s",
    async (_, blocked, priceId, amount, monthly) => {
      const f = await fixture();
      const sub = await annualCard(f, {
        yearlyPrices: monthly
          ? YEARLY_PRICES.map((item) => ({
              ...item,
              recurring: { ...item.recurring, interval: "month" },
            }))
          : YEARLY_PRICES,
      });
      f.fake.invoice(annualRenewal(sub.id, OCT, { amount, price: priceId }));
      await sync(f);
      expect(await grants(f)).toMatchObject([{ state: "blocked", code: blocked }]);
      expect(await terms(f)).toEqual([]);
    },
  );

  it("bloqueia a renovação paga mais de um mês antes do ano que ela compra", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    f.fake.invoice(annualRenewal(sub.id, YEAR));
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "INVOICE_UNEXPECTED" }]);
    expect(await terms(f)).toEqual([]);
  });

  it("sem os preços anuais no Stripe, o mensal continua e a fatura anual fica PRICE_UNKNOWN", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { yearlyPrices: [] });
    const monthlySub = f.fake.subscribe(CUSTOMER, "intermediate");
    f.fake.invoice({
      ...startInvoice(CUSTOMER, monthlySub.id, f.organizationId, 14900),
      id: invoiceId(),
    });
    const annual = annualStart(f, sub.id);
    await sync(f);
    expect((await grants(f)).map((grant) => [grant.state, grant.code ?? null])).toEqual([
      ["applied", null],
      ["blocked", "PRICE_UNKNOWN"],
    ]);
    expect((await grants(f))[1]).toMatchObject({ invoiceId: annual.id });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV_10 });
    expect(await terms(f)).toEqual([]);
  });

  it("paga depois do primeiro mês do termo fica LATE_PAYMENT; paga a tempo e lida depois vale", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    vi.setSystemTime(NOV_10 + 2 * DAY);
    annualStart(f, sub.id, { paidAt: NOV_10 + 3600_000 });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "LATE_PAYMENT" }]);
    expect(await terms(f)).toEqual([]);
    // Paid within the first term month, read only after it: granted from now to the term's end.
    const onTime = annualStart(f, sub.id, { paidAt: NOV_10 - 3600_000 });
    await sync(f);
    expect(await terms(f)).toMatchObject([
      {
        state: "active",
        firstPeriod: OCT,
        purchasedAt: NOV_10 - 3600_000,
        references: [onTime.id],
      },
    ]);
    expect(await f.plan()).toMatchObject({
      startsAt: Date.now(),
      endsAt: YEAR,
      periodAnchor: OCT,
    });
  });

  it("a fatura sem âncora conhecida espera a conferência seguinte, sem registro", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    // A sync racing the completion: the subscription is not listed and shows no anchor yet.
    f.fake.state.unlisted.push(sub.id);
    const anchor = sub.billing_cycle_anchor;
    delete (sub as Partial<typeof sub>).billing_cycle_anchor;
    annualStart(f, sub.id);
    await sync(f);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "GET")).toHaveLength(1);
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
    Object.assign(sub, { billing_cycle_anchor: anchor });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "applied" }]);
    expect(await terms(f)).toMatchObject([{ state: "active", firstPeriod: OCT }]);
  });

  it("bloqueia a fatura que aponta outra organização; o anual de outra organização não bloqueia esta", async () => {
    const f = await fixture();
    const other = await f.org("Outra organização");
    const sub = await annualCard(f);
    annualStart(f, sub.id, { organizationId: other });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "ORGANIZATION_MISMATCH" }]);
    expect(await terms(f)).toEqual([]);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: other,
        tier: "large",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_annual_other_org"],
        paidCents: 499000,
        purchasedAt: OCT_1,
        segments: [],
        state: "active",
      }),
    );
    annualStart(f, sub.id);
    await sync(f);
    expect(
      (await terms(f)).filter((term) => term.organizationId === f.organizationId),
    ).toMatchObject([{ state: "active", source: "stripe" }]);
    expect(await f.plan()).toMatchObject({ endsAt: YEAR });
  });

  it("com o interruptor anual desligado, a fatura paga vale e reserva a admissão; a recusa de admissão bloqueia", async () => {
    const f = await fixture();
    for (const [enabled, expectedVersion] of [
      [true, 1],
      [false, 2],
    ] as const)
      await f.t.mutation(internal.plans.configureAnnual, {
        enabled,
        expectedVersion,
        evidence: "synthetic-annual-switch",
      });
    expect((await stock(f)).allocations).toEqual([]);
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    expect(await terms(f)).toMatchObject([{ state: "active" }]);
    // Reserved when the first invoice is granted, as the monthly (ADR 0012, section 1).
    expect((await stock(f)).allocations.map(([tier]) => tier)).toEqual(["intermediate"]);
    // A first reservation after the admission window closed: blocked for a person.
    const g = await fixture();
    await g.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { admissionsUntil: Date.now() - 1 });
    });
    const gSub = await annualCard(g);
    annualStart(g, gSub.id);
    await sync(g);
    expect(await grants(g)).toMatchObject([{ state: "blocked", code: "PLAN_UNAVAILABLE" }]);
    expect(await terms(g)).toEqual([]);
    expect((await stock(g)).allocations).toEqual([]);
  });

  it("a primeira fatura anual bloqueada para a assinatura no Stripe, sem reembolso automático, e o console mostra a parada até ela acontecer", async () => {
    const f = await fixture();
    // The admission window closed between the Checkout and the payment: paid, but no term.
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { admissionsUntil: Date.now() - 1 });
    });
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    const [grant] = await grants(f);
    expect(grant).toMatchObject({
      state: "blocked",
      code: "PLAN_UNAVAILABLE",
      subscriptionStop: { subscriptionId: sub.id, state: "pending" },
    });
    const reviews = async () =>
      (
        await (
          await person(f.t, f.organizationId, "owner")
        ).query(api.billing.overview, { asOf: Date.now(), organizationId: f.organizationId })
      ).reviews.map((row) => [row.source, row.code]);
    expect(await reviews()).toEqual(
      expect.arrayContaining([
        ["grant", "PLAN_UNAVAILABLE"],
        ["grant", "SUBSCRIPTION_STOP_PENDING"],
      ]),
    );
    // Cancelled at once, before it charges the next year; the refund stays manual.
    await runUntil(f, Date.now());
    expect(sub.status).toBe("canceled");
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
    expect(f.fake.state.calls.filter((call) => call.path.includes("refund"))).toEqual([]);
    expect((await grants(f))[0]!.subscriptionStop).toMatchObject({ state: "done" });
    expect(await reviews()).toEqual([["grant", "PLAN_UNAVAILABLE"]]);
    // Repeats do nothing new.
    await sync(f);
    await f.t.action(internal.billing.stopBlockedAnnual, {
      organizationId: f.organizationId,
      grantId: grant!._id,
      attempt: 0,
    });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
    expect(await grants(f)).toHaveLength(1);

    // Stripe stays down: retried, then flagged until the operator runs it again.
    const g = await fixture();
    await g.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { admissionsUntil: Date.now() - 1 });
    });
    const gSub = await annualCard(g);
    annualStart(g, gSub.id);
    await sync(g);
    const [gGrant] = await grants(g);
    g.fake.state.failNext = 1000;
    await g.t.action(internal.billing.stopBlockedAnnual, {
      organizationId: g.organizationId,
      grantId: gGrant!._id,
      attempt: 5,
    });
    g.fake.state.failNext = 0;
    expect((await grants(g))[0]!.subscriptionStop).toMatchObject({ state: "failed" });
    expect(gSub.status).toBe("active");
    expect(
      (
        await (
          await person(g.t, g.organizationId, "owner")
        ).query(api.billing.overview, { asOf: Date.now(), organizationId: g.organizationId })
      ).reviews.map((row) => row.code),
    ).toContain("SUBSCRIPTION_STOP_FAILED");
    await g.t.action(internal.billing.stopBlockedAnnual, {
      organizationId: g.organizationId,
      grantId: gGrant!._id,
      attempt: 0,
    });
    expect(gSub.status).toBe("canceled");
    expect((await grants(g))[0]!.subscriptionStop).toMatchObject({ state: "done" });
  });

  it("os jobs agendados pelo Checkout anual do dia 1 só registram e não fazem nada", async () => {
    const f = await fixture();
    const checkoutId = await f.t.run((ctx) =>
      ctx.db.insert("billingCheckouts", {
        organizationId: f.organizationId,
        key: "legacy-annual-day-one",
        kind: "start",
        tier: "intermediate",
        period: "2026-11",
        grantCents: 149000,
        cycle: "annual",
        state: "complete",
        subscriptionId: "sub_legacy_day_one",
        admission: { state: "refused", code: "PLAN_UNAVAILABLE", at: Date.now(), stop: "pending" },
        expiresAt: Date.now(),
        requestedBy: "legacy",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await f.t.mutation(internal.billing.recheckAnnualAdmission, { checkoutId });
    const legacy = { organizationId: f.organizationId, checkoutId, attempt: 0 };
    await f.t.mutation(internal.billing.retryAnnualStop, legacy);
    await f.t.action(internal.billing.stopRefusedAnnual, legacy);
    expect(f.fake.state.calls).toEqual([]);
  });

  it("depois do anual por cartão, a fatura mensal de um mês coberto continua bloqueada", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    const monthly = f.fake.invoice({ ...cycleInvoice(CUSTOMER, sub.id, NOV_10), id: invoiceId() });
    await sync(f);
    expect(await grants(f)).toMatchObject([
      { state: "applied" },
      { invoiceId: monthly.id, state: "blocked", code: "ANNUAL_TERM_ACTIVE" },
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: YEAR, version: 1 });
  });

  it("um anual anterior à fatia 2b renova no aniversário da âncora do dia 1, na hora e sem nova reserva", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { anchor: LEGACY });
    await legacyTerm(f);
    const before = await stock(f);
    // Stripe charges the renewal at the anchor, an hour late.
    vi.setSystemTime(NOV + 3600_000);
    const renewal = f.fake.invoice(annualRenewal(sub.id, NOV, { anchor: LEGACY }));
    await sync(f);
    const renewed = (await terms(f)).find((term) => term.references[0] === renewal.id)!;
    expect(renewed).toMatchObject({
      state: "active",
      firstPeriod: NOV,
      anchor: LEGACY,
      endsAt: Date.UTC(2027, 10, 1),
      purchasedAt: NOV + 3600_000,
    });
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      startsAt: NOV + 3600_000,
      endsAt: Date.UTC(2027, 10, 1),
      periodAnchor: LEGACY,
      version: 2,
    });
    expect(await grants(f)).toMatchObject([
      { state: "applied", planVersion: 2, period: "2026-11" },
    ]);
    expect(await stock(f)).toEqual(before);
  });

  it("nunca troca a assinatura anual por um preço mensal, nem com o preço anual sem conferência", async () => {
    const f = await fixture();
    // The yearly price no longer verifies, and the account still renews at the larger tier.
    const sub = await annualCard(f, { yearlyPrices: [], renewalTier: "large" });
    await sync(f);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    expect(
      (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))?.subscription,
    ).toMatchObject({ id: sub.id, tier: null, annual: true });
  });

  it("recusa o downgrade de uma assinatura anual", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { tier: "large" });
    annualStart(f, sub.id, { tier: "large" });
    await sync(f);
    expect(await terms(f)).toMatchObject([{ state: "active", tier: "large" }]);
    expect(
      await code(
        f.owner.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "intermediate",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    expect(await f.t.run((ctx) => ctx.db.query("billingAccounts").first())).toMatchObject({
      renewalTier: "large",
    });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
  });

  it("o assinante anual desfaz o “Não renovar”; a assinatura mensal sob o termo continua recusada", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    const renewal = (change: "cancel" | "resume", g: Fixture = f) =>
      code(g.owner.action(api.billing.changeRenewal, { organizationId: g.organizationId, change }));
    expect(await renewal("cancel")).toBe("OK");
    expect(sub.cancel_at_period_end).toBe(true);
    expect(await renewal("resume")).toBe("OK");
    expect(sub.cancel_at_period_end).toBe(false);
    // A monthly card subscription under a term bought by card still cannot resume.
    const g = await fixture();
    const { customer } = await startCard(g);
    const monthly = g.fake.subscribe(customer, "intermediate");
    g.fake.invoice(startInvoice(customer, monthly.id, g.organizationId, 14900));
    await g.t.action(internal.billing.sync, { organizationId: g.organizationId });
    expect(await renewal("cancel", g)).toBe("OK");
    await g.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: g.organizationId,
        tier: "intermediate",
        firstPeriod: NOV,
        endsAt: termEndsAt(NOV),
        source: "stripe",
        references: ["in_annual_other_sub"],
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
        state: "scheduled",
      }),
    );
    expect(await renewal("resume", g)).toBe("ANNUAL_TERM_ACTIVE");
    expect(monthly.cancel_at_period_end).toBe(true);
  });

  it("a retomada anual só vale sob o termo comprado por esta assinatura", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT,
        endsAt: YEAR,
        source: "stripe",
        references: ["in_annual_other_sub"],
        stripeSubscriptionId: "sub_another_annual",
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      }),
    );
    await sync(f);
    const renewal = (change: "cancel" | "resume") =>
      code(f.owner.action(api.billing.changeRenewal, { organizationId: f.organizationId, change }));
    expect(await renewal("cancel")).toBe("OK");
    expect(await renewal("resume")).toBe("ANNUAL_TERM_ACTIVE");
    expect(sub.cancel_at_period_end).toBe(true);
  });

  it("uma assinatura mensal a um preço sem conferência ainda passa ao preço mensal de renewalTier", async () => {
    const f = await fixture();
    await annualCard(f, { yearlyPrices: [], renewalTier: "intermediate" });
    // Not the annual subscription: a monthly one at a monthly price retired in Stripe.
    f.fake.state.subscriptions.length = 0;
    const sub = f.fake.subscribe(CUSTOMER, "intermediate");
    (sub.items.data[0] as Json).price = "price_retired_monthly";
    await sync(f);
    expect(
      f.fake.sent(`/v1/subscriptions/${sub.id}`).map((call) => call.params.get("items[0][price]")),
    ).toEqual(["price_int"]);
  });

  it("a primeira cobrança de um anual anterior à fatia 2b, na âncora do dia 1, cria e ativa o termo", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { anchor: NOV });
    // The day-1 route: no charge at the Checkout, the first year charged on the 1st.
    vi.setSystemTime(NOV + 3600_000);
    const invoice = f.fake.invoice(annualRenewal(sub.id, NOV, { anchor: NOV }));
    await sync(f);
    const [term] = await terms(f);
    expect(term).toMatchObject({
      state: "active",
      firstPeriod: NOV,
      endsAt: termEndsAt(NOV),
      references: [invoice.id],
      stripeSubscriptionId: sub.id,
    });
    expect(term!.anchor).toBeUndefined();
    expect(await f.plan()).toMatchObject({
      termId: term!._id,
      endsAt: termEndsAt(NOV),
      periodAnchor: NOV,
    });
  });

  it("começar agora com um plano mensal maior em vigor fica PLAN_UNAVAILABLE", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      activateCatalogPlan(ctx, f.organizationId, "large", OCT, NOV, 0, "operator", "Mensal"),
    );
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "PLAN_UNAVAILABLE" }]);
    expect(await terms(f)).toEqual([]);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV });
  });

  it("não retoma a assinatura anual com outro anual agendado para depois do termo dela", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    const renewal = (owner: Fixture["owner"], change: "cancel" | "resume") =>
      code(owner.action(api.billing.changeRenewal, { organizationId: f.organizationId, change }));
    expect(await renewal(f.owner, "cancel")).toBe("OK");
    // In the term's last month the first session has expired; a manager signs in again.
    vi.setSystemTime(Date.UTC(2027, 8, 15));
    const owner = await person(f.t, f.organizationId, "owner");
    // A term bought by another subscription, scheduled after this one.
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: YEAR,
        endsAt: termEndsAt(YEAR),
        source: "stripe",
        references: ["in_annual_after_card"],
        stripeSubscriptionId: "sub_other_annual",
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
        state: "scheduled",
      }),
    );
    expect((await terms(f)).map((term) => term.state)).toEqual(["active", "scheduled"]);
    // Resumed, the card would charge at its anchor a term the other one already covers.
    expect(await renewal(owner, "resume")).toBe("ANNUAL_TERM_ACTIVE");
    expect(sub.cancel_at_period_end).toBe(true);
  });

  it.each([
    [
      "ORGANIZATION_CLOSED",
      (f: Fixture) =>
        f.t.run((ctx) =>
          ctx.db.insert("organizationClosures", {
            organizationId: f.organizationId,
            state: "closing",
            requestedAt: Date.now(),
            exportUntil: Date.now() + 30 * 86400_000,
            purgeBy: Date.now() + 37 * 86400_000,
            generation: 1,
          }),
        ),
    ],
    [
      "PLAN_CUSTOM",
      (f: Fixture) =>
        f.t.run((ctx) =>
          ctx.db.insert("usagePlans", {
            organizationId: f.organizationId,
            catalogTier: "custom",
            name: "Contrato comercial sintético",
            startsAt: OCT_1,
            endsAt: NOV,
            limits: { imports: 5, bytes: 100, captures: 2, registry: 1, deliveries: 1 },
            concurrency: 1,
            version: 1,
            updatedAt: Date.now(),
          }),
        ),
    ],
  ] as const)("bloqueia a fatura anual com %s", async (blocked, setup) => {
    const f = await fixture();
    const sub = await annualCard(f);
    await setup(f);
    annualStart(f, sub.id);
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: blocked }]);
    expect(await terms(f)).toEqual([]);
  });
});
