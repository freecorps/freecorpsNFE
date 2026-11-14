import { describe, expect, it } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import {
  OCT,
  NOV,
  DEC,
  NOV_10,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  startInvoice,
  cycleInvoice,
  fixture,
  type Fixture,
  code,
  refusal,
  startCard,
} from "../../tests/helpers/billing";

/**
 * An annual term (ADR 0010, decision 9) holds the monthly sales and assignments it covers.
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("plano anual (ADR 0010, decisão 9)", () => {
  const OCT_1 = Date.UTC(2026, 9, 1);
  type TermState = "scheduled" | "active" | "rescinded" | "expired";
  /** A synthetic Intermediate term; `grant` also writes the plan row it grants. */
  const annual = (
    f: Fixture,
    organizationId: Id<"organizations">,
    state: TermState = "active",
    { firstPeriod = OCT_1, grant = false } = {},
  ) =>
    f.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: termEndsAt(firstPeriod),
        source: "stripe",
        references: [`in_annual_${organizationId}`],
        paidCents: 149000,
        purchasedAt: firstPeriod,
        segments: [],
        state,
      });
      if (grant)
        await activateCatalogPlan(
          ctx,
          organizationId,
          "intermediate",
          firstPeriod,
          termEndsAt(firstPeriod),
          0,
          "operator",
          "Anual sintético",
          termId,
        );
      return termId;
    });
  const checkoutLarge = (f: Fixture, key: string) =>
    f.owner.action(api.billing.checkout, { organizationId: f.organizationId, tier: "large", key });
  const grants = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingGrants").collect());

  it("nunca grava um termo fora do formato", async () => {
    const f = await fixture();
    await expect(
      annual(f, f.organizationId, "active", { firstPeriod: Date.UTC(2026, 9, 15) + 0.5 }),
    ).rejects.toThrow(RangeError);
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanTerms").collect())).toEqual([]);
  });

  it("recusa a ativação mensal que um termo agendado encurtaria e vende a que termina antes dele", async () => {
    const f = await fixture();
    const monthly = (endsAt: number) =>
      f.t.run((ctx) =>
        activateCatalogPlan(ctx, f.organizationId, "large", OCT, endsAt, 0, "op", "Mensal"),
      );
    await annual(f, f.organizationId, "scheduled", { firstPeriod: Date.UTC(2026, 9, 20, 9) });
    expect(await code(monthly(NOV))).toBe("ANNUAL_TERM_ACTIVE");
    expect(await f.plan()).toBeNull();
    await monthly(Date.UTC(2026, 9, 20, 9));
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: Date.UTC(2026, 9, 20, 9),
    });
  });

  it("no mês coberto, recusa atribuição e gratuito sem mexer no plano anual", async () => {
    const f = await fixture();
    const termId = await annual(f, f.organizationId, "active", { grant: true });
    const plan = await f.plan();
    expect(plan).toMatchObject({ catalogTier: "intermediate", termId, version: 1 });
    expect(
      await code(
        f.t.mutation(internal.usage.assignPlan, {
          organizationId: f.organizationId,
          name: "Plano manual",
          startsAt: Date.now() - 1,
          endsAt: NOV,
          limits: { imports: 5, bytes: 100, captures: 2, registry: 1, deliveries: 1 },
          concurrency: 1,
          actor: "operator",
          reason: "Synthetic proof",
          expectedVersion: 1,
        }),
      ),
    ).toBe("ANNUAL_TERM_ACTIVE");
    expect(await f.plan()).toEqual(plan);
    // The free tier activates without a term, for the covered month: refused too.
    const other = await f.org("Gratuito sob anual");
    const owner = await person(f.t, other, "owner");
    await annual(f, other);
    expect(await code(owner.mutation(api.plans.claimFree, { organizationId: other }))).toBe(
      "ANNUAL_TERM_ACTIVE",
    );
  });

  it("recusa o Checkout mensal e bloqueia uma vez a fatura do mês coberto", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await annual(f, f.organizationId, "active");
    expect(await code(checkoutLarge(f, "card-under-annual"))).toBe("ANNUAL_TERM_ACTIVE");
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    // Money was taken: a person looks at it, never a silent skip.
    expect(await grants(f)).toMatchObject([
      { invoiceId: "in_1", state: "blocked", code: "ANNUAL_TERM_ACTIVE" },
    ]);
    expect(await f.plan()).toBeNull();
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toHaveLength(1);
  });

  it("um anual agendado para depois recusa um novo Checkout até o fim dele, mas o mês pago antes dele vale", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    await annual(f, f.organizationId, "scheduled", { firstPeriod: DEC });
    // No deferred start on the card: the monthly waits for the end of the term, with the date.
    expect(await refusal(checkoutLarge(f, "card-before-scheduled"))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: termEndsAt(DEC),
    });
    // A Stripe retry that pays a month ending before the term still grants it.
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toMatchObject([{ state: "applied" }]);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV_10 });
  });

  it("um anual agendado dentro do mês pago bloqueia a fatura que ele encurtaria", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    await annual(f, f.organizationId, "scheduled", { firstPeriod: NOV });
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "ANNUAL_TERM_ACTIVE" }]);
    expect(await f.plan()).toBeNull();
  });

  it("não retoma a renovação mensal cancelada com um anual em vigor", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    const renewal = (change: "cancel" | "resume") =>
      f.owner.action(api.billing.changeRenewal, { organizationId: f.organizationId, change });
    await renewal("cancel");
    await annual(f, f.organizationId, "scheduled", { firstPeriod: NOV });
    expect(await code(renewal("resume"))).toBe("ANNUAL_TERM_ACTIVE");
    expect(sub.cancel_at_period_end).toBe(true);
  });

  it.each([
    ["rescindido", "rescinded", OCT_1],
    ["expirado", "expired", OCT_1],
    // Ends on the 1st of this month: October is no longer covered.
    ["terminado no dia 1 deste mês", "active", Date.UTC(2025, 9, 1)],
  ] as const)(
    "com o termo %s, o mensal no cartão volta a ser vendido",
    async (_, state, firstPeriod) => {
      const f = await fixture();
      await annual(f, f.organizationId, state, { firstPeriod });
      expect(await code(checkoutLarge(f, "card-after-annual"))).toBe("OK");
      expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    },
  );

  it("o acesso de um termo rescindido segura o mensal até o fim do mês do termo", async () => {
    const f = await fixture();
    const termId = await annual(f, f.organizationId, "active", { grant: true });
    await f.t.mutation(internal.plans.rescindTerm, {
      termId,
      key: "rescission-monthly-key",
      actor: "operador-sintetico",
      reason: "Cliente pediu a rescisão ao suporte",
    });
    expect(await f.plan()).toMatchObject({ termId, catalogTier: "intermediate", endsAt: NOV });
    // One paid plan at a time (ADR 0012): not even a larger tier.
    expect(
      await refusal(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "card-over-rescinded",
        }),
      ),
    ).toEqual({ code: "PLAN_UNAVAILABLE", availableAt: NOV });
    // A monthly invoice paid anyway, by a Checkout opened before, waits for a person instead of
    // replacing the plan the term left.
    await f.t.run((ctx) =>
      ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: "cus_over_rescinded",
        livemode: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const sub = f.fake.subscribe("cus_over_rescinded", "large", NOV);
    f.fake.invoice(startInvoice("cus_over_rescinded", sub.id, f.organizationId, 49900, "large"));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "ANNUAL_TERM_ACTIVE" }]);
    expect(await f.plan()).toMatchObject({ termId, catalogTier: "intermediate", endsAt: NOV });
  });

  it.each([
    ["coberto pelo termo", { state: "scheduled", firstPeriod: NOV }],
    // Only October, the month of the activation, is covered; it blocks instead of failing the sync.
    ["seguinte ao fim do termo", { state: "active", firstPeriod: Date.UTC(2025, 10, 1) }],
  ] as const)(
    "bloqueia a renovação mensal paga para o mês %s",
    async (_, { state, firstPeriod }) => {
      const f = await fixture();
      const { customer } = await startCard(f);
      // A subscription signed before slice 2a, anchored on 01/10 at 00:00 UTC: civil months.
      const sub = f.fake.subscribe(customer, "intermediate", NOV, Date.UTC(2026, 9, 1));
      await annual(f, f.organizationId, state, { firstPeriod });
      f.fake.invoice(cycleInvoice(customer, sub.id, NOV));
      await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
      expect(await grants(f)).toMatchObject([
        { invoiceId: "in_1", period: "2026-11", state: "blocked", code: "ANNUAL_TERM_ACTIVE" },
      ]);
      expect(await f.plan()).toBeNull();
    },
  );

  it("não ativa um plano com o termo de outra organização", async () => {
    const f = await fixture();
    const foreign = await annual(f, await f.org("Dona do termo"));
    expect(
      await code(
        f.t.run((ctx) =>
          activateCatalogPlan(
            ctx,
            f.organizationId,
            "intermediate",
            OCT_1,
            termEndsAt(OCT_1),
            0,
            "operator",
            "Anual de outra organização",
            foreign,
          ),
        ),
      ),
    ).toBe("INVALID_REQUEST");
    expect(await f.plan()).toBeNull();
  });

  it("o anual de outra organização não bloqueia esta", async () => {
    const f = await fixture();
    await annual(f, await f.org("Outra organização"));
    const { url } = await startCard(f);
    expect(url).toContain("checkout.stripe.com");
    const customer = (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toMatchObject([{ state: "applied" }]);
  });
});
