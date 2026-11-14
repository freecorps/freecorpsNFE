import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { addMonths, termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import { reserveUsage } from "./lib/usageCore";
import {
  OCT,
  NOV,
  NOV_10,
  s,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  YEARLY_PRICES,
  startInvoice,
  annualStartInvoice,
  annualCycleInvoice,
  fixture,
  type Fixture,
  code,
  refusal,
  deliver,
  processEvents,
  startCard,
} from "../../tests/helpers/billing";

/**
 * The card annual Checkout (ADR 0012, slice 2b).
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("Checkout anual por cartão (ADR 0012, fatia 2b)", () => {
  const OCT_1 = Date.UTC(2026, 9, 1);
  /** Signed on 31/01/2027 at 10:00:07 UTC: the anchor of the chain. */
  const JAN_31 = Date.UTC(2027, 0, 31, 10, 0, 7);
  const JAN_31_2028 = Date.UTC(2028, 0, 31, 10, 0, 7);
  type Tier = "intermediate" | "large";
  async function annualOn(f: Fixture, { yearly = true } = {}) {
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    if (yearly) f.fake.state.prices.push(...(YEARLY_PRICES as Json[]));
  }
  /** A session lasts an hour: by default the owner signs in again, at the current time. */
  const annualCheckout = async (
    f: Fixture,
    { tier = "intermediate" as Tier, key = "annual-card-key", owner = f.owner } = {},
  ) =>
    owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier,
      key,
      cycle: "annual",
    });
  const sessions = (f: Fixture) => f.fake.sent("/v1/checkout/sessions");
  const sentParams = (f: Fixture) => Object.fromEntries(sessions(f).at(-1)!.params);
  /** The subscription metadata the session asked Stripe to set, as its invoices carry it. */
  const sentMarks = (f: Fixture) =>
    Object.fromEntries(
      [...sessions(f).at(-1)!.params].flatMap(([name, value]) => {
        const field = /^subscription_data\[metadata\]\[(\w+)\]$/.exec(name);
        return field ? [[field[1]!, value]] : [];
      }),
    );
  /**
   * Paying the session: Stripe anchors the yearly subscription at the signing, truncated to the
   * second, and charges the first year at once (`subscription_create`).
   */
  function payAnnual(f: Fixture, customer: string, { tier = "intermediate" as Tier } = {}) {
    const anchor = s(Date.now()) * 1000;
    const params = sentParams(f);
    const sub = f.fake.subscribe(customer, tier, termEndsAt(anchor), anchor);
    (sub.items.data[0] as Json).price = f.fake.state.prices.find(
      (row) => row.id === params["line_items[0][price]"],
    );
    const invoice = f.fake.invoice({
      id: `in_annual_${sub.id}`,
      ...annualStartInvoice(customer, sub.id, f.organizationId, { tier, start: anchor }),
    });
    return { sub, invoice };
  }
  const terms = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanTerms").collect());
  const grants = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingGrants").collect());
  const sync = (f: Fixture) =>
    f.t.action(internal.billing.sync, { organizationId: f.organizationId });
  const customerOf = async (f: Fixture) =>
    (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
  const allocations = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("platformPlanAllocations").collect()).map((row) => [
        row.organizationId,
        row.tier,
      ]),
    );
  const measure = (f: Fixture, key: string) =>
    f.t
      .run((ctx) => reserveUsage(ctx, f.organizationId, "sandbox", "attempts", key, 1, true))
      .then((event) => event.period);
  /** The admission window of the fixture closes at the end of 2027; later years reopen it. */
  const admitUntil = (f: Fixture, admissionsUntil: number) =>
    f.t.run(async (ctx) => {
      const row = await ctx.db.query("platformPlanSettings").first();
      await ctx.db.patch("platformPlanSettings", row!._id, { admissionsUntil });
    });
  const term = (f: Fixture, state: "active" | "scheduled", firstPeriod: number) =>
    f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: termEndsAt(firstPeriod),
        source: "stripe",
        references: [`in_annual_${state}`],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state,
      }),
    );

  it("assinado em 31/01 às 10:00:07, cobra o ano na hora, vai até 31/01 seguinte e as cotas viram nos aniversários da âncora", async () => {
    vi.setSystemTime(JAN_31 + 250);
    const f = await fixture();
    await annualOn(f);
    const { url } = await annualCheckout(f, { tier: "large" });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const customer = await customerOf(f);
    const marks = {
      organizationId: f.organizationId,
      kind: "start",
      tier: "large",
      grantCents: "499000",
      cycle: "annual",
    };
    // Only the yearly price: no anchor on a 1st, no proration, no one-off line, no trial.
    expect(sentParams(f)).toEqual({
      customer,
      client_reference_id: f.organizationId,
      locale: "pt-BR",
      "payment_method_types[0]": "card",
      success_url: expect.stringMatching(/\/usage\?cobranca=retorno$/),
      cancel_url: expect.stringMatching(/\/usage\?cobranca=cancelado$/),
      expires_at: String(s(JAN_31 + 250 + 24 * 3600_000)),
      mode: "subscription",
      "line_items[0][price]": "price_large_year",
      "line_items[0][quantity]": "1",
      ...Object.fromEntries(
        Object.entries(marks).flatMap(([name, value]) => [
          [`metadata[${name}]`, value],
          [`subscription_data[metadata][${name}]`, value],
        ]),
      ),
    });
    const open = (await f.billing()).checkout;
    expect(open).toMatchObject({
      kind: "start",
      tier: "large",
      cycle: "annual",
      periodStartsAt: null,
      grantCents: 499000,
    });
    expect(open).not.toHaveProperty("period");
    // Paid: Stripe anchors the subscription at the signing and charges the year at once.
    const { sub, invoice } = payAnnual(f, customer, { tier: "large" });
    expect(sub.billing_cycle_anchor).toBe(s(JAN_31));
    expect((await allocations(f)).length).toBe(0);
    await sync(f);
    const [created] = await terms(f);
    expect(created).toMatchObject({
      state: "active",
      source: "stripe",
      tier: "large",
      firstPeriod: JAN_31,
      endsAt: JAN_31_2028,
      references: [invoice.id],
      stripeSubscriptionId: sub.id,
      paidCents: 499000,
      purchasedAt: JAN_31,
    });
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      termId: created!._id,
      startsAt: JAN_31 + 250,
      endsAt: JAN_31_2028,
      periodAnchor: JAN_31,
      version: 1,
    });
    // The admission is reserved when the first invoice is granted, as the monthly.
    expect(await allocations(f)).toEqual([[f.organizationId, "large"]]);
    expect(await f.billing()).toMatchObject({
      checkout: null,
      subscriptionTerm: true,
      annualBlocked: true,
      account: { renewalTier: "large", subscription: { id: sub.id, annual: true } },
    });
    // The quota periods turn on the anchor's monthly anniversaries: 28/02, then 31/03.
    expect(await measure(f, "january")).toBe("2027-01-31T10:00:07.000Z");
    vi.setSystemTime(Date.UTC(2027, 1, 28, 10, 0, 7));
    expect(await measure(f, "february")).toBe("2027-02-28T10:00:07.000Z");
    vi.setSystemTime(Date.UTC(2027, 2, 31, 10, 0, 7));
    expect(await measure(f, "march")).toBe("2027-03-31T10:00:07.000Z");
    // Replayed by Stripe, by another event or by the reconciliation: nothing new.
    for (const type of ["invoice.paid", "invoice.paid", "checkout.session.completed"])
      await deliver(f, { type, data: { object: { id: invoice.id, customer } } });
    await processEvents(f);
    await sync(f);
    expect(await terms(f)).toHaveLength(1);
    expect(await grants(f)).toMatchObject([
      { invoiceId: invoice.id, state: "applied", period: "2027-01-31T10:00:07.000Z" },
    ]);
    expect(await f.plan()).toMatchObject({ version: 1 });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    // On the anniversary Stripe renews the next year of the same anchor.
    vi.setSystemTime(JAN_31_2028 + 3600_000);
    const renewal = f.fake.invoice({
      id: "in_annual_card_renewal",
      ...annualCycleInvoice(customer, sub.id, JAN_31_2028, {
        anchor: JAN_31,
        amount: 499000,
        price: "price_large_year",
      }),
    });
    await sync(f);
    const renewed = (await terms(f)).find((row) => row.references[0] === renewal.id)!;
    expect(renewed).toMatchObject({
      state: "active",
      tier: "large",
      firstPeriod: JAN_31_2028,
      anchor: JAN_31,
      endsAt: Date.UTC(2029, 0, 31, 10, 0, 7),
    });
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      endsAt: Date.UTC(2029, 0, 31, 10, 0, 7),
      periodAnchor: JAN_31,
      version: 2,
    });
    expect(await allocations(f)).toEqual([[f.organizationId, "large"]]);
  });

  it("uma cadeia de 29/02/2028 renova em 28/02/2029, 2030 e 2031 e em 29/02/2032, sem deriva", async () => {
    const at = (year: number, day: number) => Date.UTC(year, 1, day, 10, 0, 7);
    const FEB_29 = at(2028, 29);
    vi.setSystemTime(FEB_29);
    const f = await fixture();
    await admitUntil(f, Date.UTC(2040, 0, 1));
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const { sub } = payAnnual(f, customer);
    await sync(f);
    const turns = [FEB_29, at(2029, 28), at(2030, 28), at(2031, 28), at(2032, 29), at(2033, 28)];
    expect(await terms(f)).toMatchObject([{ firstPeriod: FEB_29, endsAt: turns[1] }]);
    for (let year = 1; year < 5; year++) {
      vi.setSystemTime(turns[year]! + 3600_000);
      // A year counted from the previous anniversary would end on 28/02/2032: no such term.
      if (year === 3) {
        f.fake.invoice({
          id: "in_annual_leap_drifted",
          ...annualCycleInvoice(customer, sub.id, turns[3]!, { end: at(2032, 28) }),
        });
        await sync(f);
        expect((await grants(f)).at(-1)).toMatchObject({
          invoiceId: "in_annual_leap_drifted",
          state: "blocked",
          code: "INVOICE_UNEXPECTED",
        });
      }
      const invoice = f.fake.invoice({
        id: `in_annual_leap_${year}`,
        ...annualCycleInvoice(customer, sub.id, turns[year]!, { anchor: FEB_29 }),
      });
      await sync(f);
      expect((await terms(f)).find((row) => row.references[0] === invoice.id)).toMatchObject({
        state: "active",
        firstPeriod: turns[year],
        anchor: FEB_29,
        endsAt: turns[year + 1],
      });
      expect(await f.plan()).toMatchObject({ endsAt: turns[year + 1], periodAnchor: FEB_29 });
      if (year === 3) {
        // The quota month after 28/02/2031 starts on 29/03, the anchor's day, not on 28/03.
        vi.setSystemTime(Date.UTC(2031, 2, 29, 10, 0, 7) - 1);
        expect(await measure(f, "february-2031")).toBe("2031-02-28T10:00:07.000Z");
        vi.setSystemTime(Date.UTC(2031, 2, 29, 10, 0, 7));
        expect(await measure(f, "march-2031")).toBe("2031-03-29T10:00:07.000Z");
      }
    }
    expect(await terms(f)).toHaveLength(5);
  });

  it("uma primeira cobrança fora do esperado fica para uma pessoa; uma fatura de R$ 0, se vier, não compra nada", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const sub = f.fake.subscribe(customer, "intermediate", termEndsAt(OCT));
    (sub.items.data[0] as Json).price = YEARLY_PRICES[0];
    const first = annualStartInvoice(customer, sub.id, f.organizationId);
    // Not expected, but harmless if it arrives.
    f.fake.invoice({ ...first, id: "in_annual_card_zero", amount_paid: 0, amount_due: 0 });
    // A first charge with another `billing_reason`, or a line that is not a year of the anchor:
    // the money is held for a refund or a decision.
    f.fake.invoice({
      ...first,
      id: "in_annual_card_update",
      billing_reason: "subscription_update",
    });
    f.fake.invoice({
      ...annualStartInvoice(customer, sub.id, f.organizationId, { end: addMonths(OCT, 1) }),
      id: "in_annual_card_month",
    });
    await sync(f);
    expect((await grants(f)).map((grant) => [grant.invoiceId, grant.state, grant.code])).toEqual([
      ["in_annual_card_zero", "skipped", "ZERO_AMOUNT"],
      ["in_annual_card_update", "blocked", "INVOICE_UNEXPECTED"],
      ["in_annual_card_month", "blocked", "INVOICE_UNEXPECTED"],
    ]);
    expect(await terms(f)).toEqual([]);
    expect(await f.plan()).toBeNull();
  });

  it("repete a mesma sessão pela mesma chave, mesmo com o interruptor desligado depois, e recusa outro pedido com ela", async () => {
    const f = await fixture();
    await annualOn(f);
    const { url } = await annualCheckout(f);
    expect(await annualCheckout(f)).toEqual({ url });
    expect(sessions(f)).toHaveLength(1);
    expect(await code(annualCheckout(f, { tier: "large" }))).toBe("OPERATION_CONFLICT");
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "annual-card-key",
        }),
      ),
    ).toBe("OPERATION_CONFLICT");
    // Turning the switch off stops new sales; the session already open still answers.
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await annualCheckout(f)).toEqual({ url });
    expect(await code(annualCheckout(f, { key: "annual-card-after-off" }))).toBe("ANNUAL_DISABLED");
    expect(sessions(f)).toHaveLength(1);
    const rows = await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect());
    expect(rows).toMatchObject([{ cycle: "annual", grantCents: 149000, state: "open" }]);
    expect(rows[0]!.period).toBeUndefined();
  });

  it("recusa papel sem gestão, quem não é membro e outra organização", async () => {
    const f = await fixture();
    await annualOn(f);
    for (const role of ["developer", "operator", "viewer"] as const) {
      const member = await person(f.t, f.organizationId, role);
      expect(await code(annualCheckout(f, { owner: member }))).toBe("ACCESS_DENIED");
    }
    const other = await f.org("Outra organização");
    const stranger = await person(f.t, other, "owner");
    expect(await code(annualCheckout(f, { owner: stranger }))).toBe("ACCESS_DENIED");
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: other,
          tier: "intermediate",
          key: "annual-other-org",
          cycle: "annual",
        }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(f.fake.state.calls).toEqual([]);
  });

  it("recusa com o interruptor desligado e, sem o preço anual, não cria sessão nem segura a vaga", async () => {
    const f = await fixture();
    f.fake.state.prices.push(...(YEARLY_PRICES as Json[]));
    expect(await code(annualCheckout(f))).toBe("ANNUAL_DISABLED");
    expect(f.fake.state.calls).toEqual([]);
    f.fake.state.prices.splice(2);
    await annualOn(f, { yearly: false });
    expect(await code(annualCheckout(f))).toBe("BILLING_UNAVAILABLE");
    expect(await code(annualCheckout(f, { key: "annual-card-retry" }))).toBe("BILLING_UNAVAILABLE");
    expect(sessions(f)).toEqual([]);
    // The monthly is not affected by a missing yearly price.
    expect(await code(startCard(f))).toBe("OK");
    expect(sentParams(f)).toMatchObject({ "line_items[0][price]": "price_int" });
  });

  it.each([
    ["um termo em vigor", "active", OCT_1],
    ["um termo agendado", "scheduled", NOV],
  ] as const)("recusa com %s até o fim dele", async (_, state, firstPeriod) => {
    const f = await fixture();
    await annualOn(f);
    await term(f, state, firstPeriod);
    expect(await refusal(annualCheckout(f))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: termEndsAt(firstPeriod),
    });
    expect(f.fake.state.calls).toEqual([]);
  });

  it("recusa com Checkout aberto", async () => {
    const f = await fixture();
    await annualOn(f);
    await startCard(f);
    expect(await code(annualCheckout(f))).toBe("CHECKOUT_PENDING");
    await f.owner.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    expect(await code(annualCheckout(f))).toBe("OK");
    expect(sessions(f)).toHaveLength(2);
  });

  it("sobre o mensal do cartão de tier igual, com a renovação cancelada, o anual é cobrado e o substitui na hora, com âncora nova; um anual menor espera o fim dele", async () => {
    const f = await fixture();
    await annualOn(f);
    // The card Grande signed on 10/10 at 12:00 runs to 10/11 at 12:00.
    const { customer } = await startCard(f, "large");
    const monthly = f.fake.subscribe(customer, "large");
    f.fake.invoice(startInvoice(customer, monthly.id, f.organizationId, 49900, "large"));
    await sync(f);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV_10 });
    // While the monthly renews, the customer cancels its renewal first; nothing is cancelled for
    // them.
    expect(await code(annualCheckout(f, { tier: "large", key: "annual-large-renewing" }))).toBe(
      "SUBSCRIPTION_RENEWING",
    );
    expect(monthly.cancel_at_period_end).toBe(false);
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    const before = sessions(f).length;
    // A smaller annual now would be a downgrade outside the renewal: it waits for the monthly.
    expect(await refusal(annualCheckout(f, { key: "annual-int-under-large" }))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: NOV_10,
    });
    expect(sessions(f)).toHaveLength(before);
    // Ten days later the Grande annual is charged and starts at once, with its own anchor.
    const SIGNED = Date.UTC(2026, 9, 20, 9, 30, 15);
    vi.setSystemTime(SIGNED);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await code(annualCheckout(f, { tier: "large", key: "annual-large-over-large", owner })),
    ).toBe("OK");
    const { sub } = payAnnual(f, customer, { tier: "large" });
    await sync(f);
    const [created] = await terms(f);
    expect(created).toMatchObject({
      state: "active",
      tier: "large",
      firstPeriod: SIGNED,
      endsAt: termEndsAt(SIGNED),
      stripeSubscriptionId: sub.id,
    });
    // The term replaces the monthly now, without discount of the days left until 10/11.
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      termId: created!._id,
      startsAt: SIGNED,
      endsAt: termEndsAt(SIGNED),
      periodAnchor: SIGNED,
    });
    expect((await grants(f)).map((grant) => [grant.state, grant.code ?? null])).toEqual([
      ["applied", null],
      ["applied", null],
    ]);
    // The monthly subscription ends at its period end; the annual one is the account's now.
    expect(monthly.cancel_at_period_end).toBe(true);
    expect(f.fake.sent(`/v1/subscriptions/${monthly.id}`, "DELETE")).toEqual([]);
    expect(
      (
        await owner.query(api.billing.overview, {
          asOf: Date.now(),
          organizationId: f.organizationId,
        })
      ).account?.subscription,
    ).toMatchObject({ id: sub.id, annual: true });
  });

  it("sobre um mensal atribuído de tier igual, o anual no cartão o substitui na hora; um mensal maior em vigor segura o anual menor com a data", async () => {
    const f = await fixture();
    await annualOn(f);
    // A monthly Intermediário without a card behind it, as one assigned by the operator.
    await f.t.run((ctx) =>
      activateCatalogPlan(
        ctx,
        f.organizationId,
        "intermediate",
        OCT,
        NOV_10,
        0,
        "operator",
        "Mensal",
        undefined,
        OCT,
      ),
    );
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV_10 });
    await annualCheckout(f);
    const { sub } = payAnnual(f, await customerOf(f));
    await sync(f);
    const [created] = await terms(f);
    expect(created).toMatchObject({
      state: "active",
      firstPeriod: OCT,
      stripeSubscriptionId: sub.id,
    });
    expect(await f.plan()).toMatchObject({ termId: created!._id, endsAt: termEndsAt(OCT) });
    // A Grande monthly in force, as one assigned by the operator: the Intermediário annual waits.
    const g = await fixture();
    await annualOn(g);
    await g.t.run((ctx) =>
      activateCatalogPlan(ctx, g.organizationId, "large", OCT, NOV, 0, "operator", "Mensal"),
    );
    expect(await refusal(annualCheckout(g))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: NOV,
    });
    expect(await code(annualCheckout(g, { tier: "large", key: "annual-large-over-op" }))).toBe(
      "OK",
    );
  });

  it("recusa com plano personalizado, sem admissão e com o acesso de um termo rescindido", async () => {
    const f = await fixture();
    await annualOn(f);
    // A first plan reserves stock: closed admissions refuse it, reopened ones sell it.
    await admitUntil(f, Date.now() - 1);
    expect(await code(annualCheckout(f))).toBe("PLAN_UNAVAILABLE");
    expect(f.fake.state.calls).toEqual([]);
    await admitUntil(f, Date.UTC(2027, 11, 31));
    const custom = await f.t.run((ctx) =>
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
    );
    expect(await code(annualCheckout(f))).toBe("PLAN_UNAVAILABLE");
    await f.t.run((ctx) => ctx.db.delete("usagePlans", custom));
    // The month a rescinded term left is paid: a new annual waits for its end.
    const termId = await f.t.run(async (ctx) => {
      const id = await insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_annual_rescinded"],
        paidCents: 149000,
        purchasedAt: OCT_1,
        segments: [],
        state: "active",
      });
      await activateCatalogPlan(
        ctx,
        f.organizationId,
        "intermediate",
        OCT_1,
        termEndsAt(OCT_1),
        0,
        "operator",
        "Anual sintético",
        id,
      );
      return id;
    });
    await f.t.mutation(internal.plans.rescindTerm, {
      termId,
      key: "rescission-before-card-annual",
      actor: "operador-sintetico",
      reason: "Cliente pediu a rescisão ao suporte",
    });
    expect(await refusal(annualCheckout(f))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: NOV,
    });
    vi.setSystemTime(NOV);
    expect(
      await code(annualCheckout(f, { owner: await person(f.t, f.organizationId, "owner") })),
    ).toBe("OK");
  });

  it("recusa enquanto o cartão mensal renova; depois de “Não renovar”, o anual é vendido sem período nas marcas", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    await annualOn(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await sync(f);
    expect(await code(annualCheckout(f))).toBe("SUBSCRIPTION_RENEWING");
    expect(sessions(f)).toHaveLength(1);
    // Refused, never cancelled on the customer's behalf.
    expect(sub.cancel_at_period_end).toBe(false);
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(await code(annualCheckout(f))).toBe("OK");
    expect(sentMarks(f)).toEqual({
      organizationId: f.organizationId,
      kind: "start",
      tier: "intermediate",
      grantCents: "149000",
      cycle: "annual",
    });
  });

  it("o Checkout mensal não faz upgrade de uma assinatura anual", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await activateCatalogPlan(ctx, f.organizationId, "intermediate", OCT, NOV, 0, "op", "Mensal");
      await ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: "cus_annual_upgrade",
        livemode: false,
        renewalTier: "intermediate",
        subscription: {
          id: "sub_annual",
          status: "active",
          tier: "intermediate",
          cancelAtPeriodEnd: false,
          periodEnd: NOV,
          annual: true,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "upgrade-annual-sub",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    expect(f.fake.state.calls).toEqual([]);
  });

  it("a sessão concluída não concede nada sem a fatura paga, nem agenda conferência própria", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    for (const session of f.fake.state.sessions.values()) session.status = "complete";
    await sync(f);
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).toMatchObject([
      { cycle: "annual", state: "complete" },
    ]);
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
    expect(await allocations(f)).toEqual([]);
    const billingJobs = await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) =>
        job.name.startsWith("billing"),
      ),
    );
    expect(billingJobs).toEqual([]);
  });

  it("a visão do console diz se o anual está à venda e se a assinatura já comprou um termo", async () => {
    const f = await fixture();
    const view = async () =>
      (await person(f.t, f.organizationId, "owner")).query(api.billing.overview, {
        asOf: Date.now(),
        organizationId: f.organizationId,
      });
    expect(await view()).toMatchObject({
      annualEnabled: false,
      subscriptionTerm: false,
      annualBlocked: false,
    });
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const { sub } = payAnnual(f, customer);
    // The subscription exists before its first invoice is read: no term yet.
    f.fake.state.invoices.length = 0;
    await sync(f);
    expect(await view()).toMatchObject({ annualEnabled: true, subscriptionTerm: false });
    f.fake.invoice({
      id: `in_annual_${sub.id}`,
      ...annualStartInvoice(customer, sub.id, f.organizationId),
    });
    await sync(f);
    expect(await terms(f)).toMatchObject([{ state: "active", stripeSubscriptionId: sub.id }]);
    // The term holds a new annual on the card until it ends, its last month included: its own
    // subscription renews it (ADR 0012, one paid plan at a time).
    expect(await view()).toMatchObject({
      annualEnabled: true,
      subscriptionTerm: true,
      annualBlocked: true,
    });
    vi.setSystemTime(Date.UTC(2027, 9, 1));
    expect((await view()).annualBlocked).toBe(true);
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await view()).toMatchObject({ annualEnabled: false, subscriptionTerm: true });
    vi.setSystemTime(termEndsAt(OCT));
    expect((await view()).annualBlocked).toBe(false);
  });

  it("o anual no cartão espera o fim de um termo em vigor, mesmo no último mês dele", async () => {
    const f = await fixture();
    const FIRST = Date.UTC(2025, 10, 1);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: FIRST,
        endsAt: termEndsAt(FIRST),
        source: "stripe",
        references: ["in_annual_ending"],
        paidCents: 149000,
        purchasedAt: FIRST,
        segments: [],
        state: "active",
      }),
    );
    expect(termEndsAt(FIRST)).toBe(NOV);
    // A monthly card would renew into the term's months.
    expect(await code(startCard(f))).toBe("ANNUAL_TERM_ACTIVE");
    // October is the term's last month: a new annual, a new chain, waits for its end
    // (ADR 0012, one paid plan at a time).
    await annualOn(f);
    expect(await refusal(annualCheckout(f))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: NOV,
    });
    expect(sessions(f)).toEqual([]);
    expect(
      await (
        await person(f.t, f.organizationId, "owner")
      ).query(api.billing.overview, { asOf: Date.now(), organizationId: f.organizationId }),
    ).toMatchObject({ annualBlocked: true });
  });

  it("um termo que termina no meio do mês segura o anual no cartão até o fim dele", async () => {
    const f = await fixture();
    // 15/10/2026 14:30 to 15/10/2027 14:30 UTC.
    const START = Date.UTC(2026, 9, 15, 14, 30);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: START,
        endsAt: termEndsAt(START),
        source: "stripe",
        references: ["in_annual_mid_month"],
        paidCents: 149000,
        purchasedAt: START,
        segments: [],
        state: "active",
      }),
    );
    await annualOn(f);
    vi.setSystemTime(Date.UTC(2027, 9, 2));
    const owner = await person(f.t, f.organizationId, "owner");
    expect(await refusal(annualCheckout(f, { owner }))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: Date.UTC(2027, 9, 15, 14, 30),
    });
    expect(sessions(f)).toEqual([]);
  });
});
