import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import { annualCardSuite } from "../../tests/helpers/billingAnnualCard";
import {
  OCT,
  NOV,
  NOV_10,
  s,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  type Json,
  YEARLY_PRICES,
  fixture,
  type Fixture,
  code,
  refusal,
  processEvents,
} from "../../tests/helpers/billing";

/**
 * The upgrade of a card annual from Intermediário to Grande (ADR 0012, slice 2b).
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("anual por cartão: a fatura vira termo (ADR 0010, decisão 9, e ADR 0012, fatia 2b)", () => {
  const {
    YEAR,
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
    DAY,
    rescind,
    undoUpgrade,
    switches,
  } = annualCardSuite();
  describe("upgrade do Intermediário anual para o Grande anual", () => {
    /** Mid-February: the 5th term month, from 10/02 to 10/03 at 12:00 UTC. */
    const FEB = Date.UTC(2027, 1, 15, 12);
    const FEB_10 = Date.UTC(2027, 1, 10, 12);
    const FEB_KEY = "2027-02-10T12:00:00.000Z";
    const END = YEAR;
    const annualOn = (f: Fixture) =>
      f.t.mutation(internal.plans.configureAnnual, {
        enabled: true,
        expectedVersion: 1,
        evidence: "synthetic-annual-on",
      });
    /** An Intermediário annual bought by card on 10/10/2026 at 12:00, active, sale switch on. */
    async function cardTerm() {
      const f = await fixture();
      await annualOn(f);
      const sub = await annualCard(f);
      const first = annualStart(f, sub.id);
      await sync(f);
      return { f, sub, first, term: (await terms(f))[0]! };
    }
    /** A session lasts an hour: the owner signs in again after each jump in time. */
    const upgradeCheckout = async (
      f: Fixture,
      { key = "annual-upgrade-card", tier = "large" as "intermediate" | "large" } = {},
    ) =>
      (await person(f.t, f.organizationId, "owner")).action(api.billing.checkout, {
        organizationId: f.organizationId,
        tier,
        key,
        cycle: "annual",
        start: "upgrade",
      });
    const sessionParams = (f: Fixture) =>
      Object.fromEntries(f.fake.sent("/v1/checkout/sessions").at(-1)!.params);
    /** The invoice Stripe creates after the one-off payment, with the markers of the session. */
    const upgradePaid = (
      f: Fixture,
      {
        amount = 233333,
        period = FEB_KEY,
        paidAt = Date.now(),
        organizationId = f.organizationId as string,
      } = {},
    ) => {
      for (const session of f.fake.state.sessions.values()) session.status = "complete";
      return f.fake.invoice({
        id: invoiceId(),
        customer: CUSTOMER,
        amount_paid: amount,
        amount_due: amount,
        billing_reason: "manual",
        status_transitions: { paid_at: s(paidAt) },
        metadata: {
          organizationId,
          kind: "upgrade",
          cycle: "annual",
          tier: "large",
          period,
          grantCents: String(amount),
        },
        lines: {
          data: [
            {
              amount,
              period: { start: s(paidAt), end: s(paidAt) },
              pricing: { type: "price_details", price_details: { price: "price_1OneOff" } },
            },
          ],
        },
      });
    };

    it("cobra a diferença pelos meses do termo, sobe o plano desde o início do mês do termo, reserva o aporte e a renovação passa a Grande sem mudar a data", async () => {
      const { f, sub, first, term } = await cardTerm();
      expect(term).toMatchObject({ tier: "intermediate", stripeSubscriptionId: sub.id });
      expect(await stock(f)).toMatchObject({ custody: 10800 });
      vi.setSystemTime(FEB);
      const { url } = await upgradeCheckout(f);
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      // A one-off payment of the difference over the 8 term months left, the current one whole,
      // counted from the anchor of 10/10 at 12:00, not from the civil month.
      expect(sessionParams(f)).toMatchObject({
        mode: "payment",
        customer: CUSTOMER,
        "line_items[0][price_data][currency]": "brl",
        "line_items[0][price_data][unit_amount]": "233333",
        "line_items[0][price_data][product_data][name]":
          "Mudança para Grande anual, do mês do plano anual iniciado em 10/02/2027 às 12:00 UTC ao fim do plano anual",
        "invoice_creation[enabled]": "true",
        "invoice_creation[invoice_data][metadata][kind]": "upgrade",
        "invoice_creation[invoice_data][metadata][cycle]": "annual",
        "invoice_creation[invoice_data][metadata][tier]": "large",
        "invoice_creation[invoice_data][metadata][period]": FEB_KEY,
        "invoice_creation[invoice_data][metadata][grantCents]": "233333",
        expires_at: String(s(FEB + DAY)),
      });
      expect(Object.keys(sessionParams(f))).not.toContain(
        "subscription_data[billing_cycle_anchor]",
      );
      expect(
        await (
          await person(f.t, f.organizationId, "owner")
        ).query(api.billing.overview, { asOf: Date.now(), organizationId: f.organizationId }),
      ).toMatchObject({
        checkout: { kind: "upgrade", cycle: "annual", periodStartsAt: FEB_10, period: FEB_KEY },
      });
      // The browser return grants nothing.
      await sync(f);
      expect(await f.plan()).toMatchObject({ catalogTier: "intermediate" });
      const invoice = upgradePaid(f);
      await sync(f);
      await paid(f, invoice.id);
      await processEvents(f);
      const [upgraded] = await terms(f);
      expect(upgraded).toMatchObject({
        _id: term._id,
        tier: "intermediate",
        endsAt: END,
        segments: [{ tier: "large", fromPeriod: FEB_10 }],
        references: [first.id, invoice.id],
        paidCents: 149000 + 233333,
        purchasedAt: OCT,
        upgrades: [{ fromTier: "intermediate", tier: "large", fromPeriod: FEB_10, paidAt: FEB }],
      });
      expect(await f.plan()).toMatchObject({
        catalogTier: "large",
        termId: term._id,
        endsAt: END,
        periodAnchor: OCT,
        version: 2,
      });
      expect((await grants(f)).at(-1)).toMatchObject({
        invoiceId: invoice.id,
        state: "applied",
        tier: "large",
        period: FEB_KEY,
        termId: term._id,
        planVersion: 2,
      });
      // The custody fund goes from R$ 108 to R$ 280 before the plan is raised.
      expect(await stock(f)).toMatchObject({ custody: 28000 });
      // The yearly subscription moves to the Grande yearly price once, without proration or
      // a new anchor: the renewal date stays and the next year is Grande.
      expect(switches(f, sub.id)).toEqual([
        {
          "items[0][id]": "si_1",
          "items[0][price]": "price_large_year",
          proration_behavior: "none",
          billing_cycle_anchor: "unchanged",
        },
      ]);
      expect(await f.t.run((ctx) => ctx.db.query("billingAccounts").first())).toMatchObject({
        renewalTier: "large",
        subscription: { id: sub.id, tier: "large", annual: true },
      });
      // The renewal at the anchor is a Grande term, from the same date.
      vi.setSystemTime(END + 3600_000);
      const renewal = f.fake.invoice(
        annualRenewal(sub.id, END, { amount: 499000, price: "price_large_year" }),
      );
      await sync(f);
      expect((await terms(f)).find((row) => row.references[0] === renewal.id)).toMatchObject({
        tier: "large",
        firstPeriod: END,
        anchor: OCT,
        state: "active",
      });
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
      expect(await grants(f)).toHaveLength(3);
    });

    it("no último mês do termo cobra um mês e ainda troca o preço da renovação", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 8, 20));
      await upgradeCheckout(f);
      expect(sessionParams(f)["line_items[0][price_data][unit_amount]"]).toBe("29166");
      upgradePaid(f, { amount: 29166, period: "2027-09-10T12:00:00.000Z" });
      await sync(f);
      expect(await terms(f)).toMatchObject([
        { _id: term._id, segments: [{ tier: "large", fromPeriod: Date.UTC(2027, 8, 10, 12) }] },
      ]);
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
    });

    it("recusa antes do Stripe: sem termo, termo sem assinatura, Grande já em vigor, anual desligado, Checkout aberto e virada do mês do termo", async () => {
      const none = await fixture();
      await annualOn(none);
      none.fake.state.prices.push(...(YEARLY_PRICES as Json[]));
      expect(await code(upgradeCheckout(none))).toBe("ANNUAL_TERM_REQUIRED");
      expect(
        await code(
          none.owner.action(api.billing.checkout, {
            organizationId: none.organizationId,
            tier: "large",
            key: "upgrade-monthly",
            start: "upgrade",
          }),
        ),
      ).toBe("INVALID_REQUEST");

      // A term whose subscription this customer does not have: no price switch could follow.
      const orphan = await fixture();
      await annualOn(orphan);
      await orphan.t.run(async (ctx) => {
        const termId = await insertTerm(ctx, {
          organizationId: orphan.organizationId,
          tier: "intermediate",
          firstPeriod: OCT,
          endsAt: END,
          source: "stripe",
          references: ["in_annual_upgrade"],
          paidCents: 149000,
          purchasedAt: OCT,
          segments: [],
          state: "active",
        });
        await activateCatalogPlan(
          ctx,
          orphan.organizationId,
          "intermediate",
          OCT,
          END,
          0,
          "operator",
          "Anual sintético",
          termId,
        );
      });
      expect(await code(upgradeCheckout(orphan))).toBe("SUBSCRIPTION_REQUIRED");

      const { f } = await cardTerm();
      expect(await code(upgradeCheckout(f, { tier: "intermediate" }))).toBe("PLAN_UNAVAILABLE");
      // The last 45 minutes of the term month: the price would change with it.
      vi.setSystemTime(NOV_10 - 30 * 60_000);
      expect(await refusal(upgradeCheckout(f))).toEqual({
        code: "PERIOD_CLOSING",
        availableAt: NOV_10,
      });
      // The civil month turning means nothing to a term of the 10th.
      vi.setSystemTime(NOV - 30 * 60_000);
      await upgradeCheckout(f);
      expect(await code(upgradeCheckout(f, { key: "annual-upgrade-other" }))).toBe(
        "CHECKOUT_PENDING",
      );
      // The same key answers the same session; with another choice it is a conflict.
      expect(await code(upgradeCheckout(f))).toBe("OK");
      expect(
        await code(
          (await person(f.t, f.organizationId, "owner")).action(api.billing.checkout, {
            organizationId: f.organizationId,
            tier: "large",
            key: "annual-upgrade-card",
            cycle: "annual",
          }),
        ),
      ).toBe("OPERATION_CONFLICT");
      expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);

      vi.setSystemTime(OCT);
      const off = await cardTerm();
      await off.f.t.mutation(internal.plans.configureAnnual, {
        enabled: false,
        expectedVersion: 2,
        evidence: "synthetic-annual-off",
      });
      expect(await code(upgradeCheckout(off.f))).toBe("ANNUAL_DISABLED");
      expect(off.f.fake.sent("/v1/checkout/sessions")).toEqual([]);
    });

    it("o pagamento que não confere fica para uma pessoa, sem termo nem plano alterados", async () => {
      // Amount different from what the server prices for that term month.
      const wrong = await cardTerm();
      vi.setSystemTime(FEB);
      upgradePaid(wrong.f, { amount: 250000 });
      await sync(wrong.f);
      expect((await grants(wrong.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "AMOUNT_MISMATCH",
        amountCents: 250000,
      });
      expect(await terms(wrong.f)).toEqual([wrong.term]);

      // Paid after the term month it priced, which ended on 10/03 at 12:00 UTC.
      vi.setSystemTime(OCT);
      const late = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 2, 12));
      upgradePaid(late.f, { paidAt: Date.UTC(2027, 2, 10, 13) });
      await sync(late.f);
      expect((await grants(late.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "LATE_PAYMENT",
      });
      expect(await terms(late.f)).toEqual([late.term]);

      // Priced in the term's last month and paid after the term ended: still late for its month.
      vi.setSystemTime(OCT);
      const ended = await cardTerm();
      vi.setSystemTime(END + DAY);
      upgradePaid(ended.f, {
        amount: 29166,
        period: "2027-09-10T12:00:00.000Z",
        paidAt: END + 3600_000,
      });
      await sync(ended.f);
      expect((await grants(ended.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "LATE_PAYMENT",
      });

      // A period that is not the start of a term month: the civil 1st of a term of the 10th.
      vi.setSystemTime(OCT);
      const civil = await cardTerm();
      vi.setSystemTime(FEB);
      upgradePaid(civil.f, { period: "2027-02" });
      await sync(civil.f);
      expect((await grants(civil.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "INVOICE_UNEXPECTED",
      });

      // The admission no longer holds the R$ 172 of custody: paid, blocked, nothing raised.
      vi.setSystemTime(OCT);
      const refused = await cardTerm();
      const plan = await refused.f.plan();
      vi.setSystemTime(FEB);
      await refused.f.t.run(async (ctx) => {
        const settings = (await ctx.db.query("platformPlanSettings").unique())!;
        await ctx.db.patch("platformPlanSettings", settings._id, { custodyCents: 20000 });
      });
      upgradePaid(refused.f);
      await sync(refused.f);
      expect((await grants(refused.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "PLAN_UNAVAILABLE",
      });
      expect(await terms(refused.f)).toEqual([refused.term]);
      expect(await refused.f.plan()).toEqual(plan);
      expect(await stock(refused.f)).toMatchObject({ custody: 10800 });
      expect(refused.f.fake.sent(`/v1/subscriptions/${refused.sub.id}`)).toEqual([]);

      // A second paid upgrade for a term already Grande: the money waits for a person.
      vi.setSystemTime(OCT);
      const twice = await cardTerm();
      vi.setSystemTime(FEB);
      upgradePaid(twice.f);
      upgradePaid(twice.f);
      await sync(twice.f);
      expect((await grants(twice.f)).slice(-2)).toMatchObject([
        { state: "applied" },
        { state: "blocked", code: "DUPLICATE_PAYMENT" },
      ]);
      expect((await terms(twice.f))[0]!.upgrades).toHaveLength(1);
    });

    it("uma renovação cobrada abaixo do upgrade vira o termo cobrado e fica para uma pessoa", async () => {
      const { f, sub } = await cardTerm();
      vi.setSystemTime(FEB);
      await upgradeCheckout(f);
      upgradePaid(f);
      await sync(f);
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
      // The switch did not reach Stripe in time: the anchor bills the Intermediário yearly.
      (sub.items.data[0] as Json).price = YEARLY_PRICES[0];
      vi.setSystemTime(END + 3600_000);
      const renewal = f.fake.invoice(annualRenewal(sub.id, END));
      await sync(f);
      // The money was taken at that price: the term is the one charged.
      expect((await terms(f)).find((row) => row.references[0] === renewal.id)).toMatchObject({
        tier: "intermediate",
        firstPeriod: END,
        state: "active",
      });
      const grant = (await grants(f)).find((row) => row.invoiceId === renewal.id)!;
      expect(grant).toMatchObject({ state: "applied", code: "RENEWAL_BELOW_UPGRADE" });
      const owner = await person(f.t, f.organizationId, "owner");
      const overview = () =>
        owner.query(api.billing.overview, { asOf: Date.now(), organizationId: f.organizationId });
      expect((await overview()).reviews).toMatchObject([
        { source: "grant", code: "RENEWAL_BELOW_UPGRADE", amountCents: 149000 },
      ]);
      // The account renews at what Stripe charges; no switch is attempted afterwards.
      expect((await overview()).account?.renewalTier).toBe("intermediate");
      await sync(f);
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
      await f.t.mutation(internal.billing.resolveReview, { grantId: grant._id, actor: "operator" });
      expect((await overview()).reviews).toEqual([]);
    });

    it("com “Não renovar”, a troca de preço espera e acontece na retomada", async () => {
      const { f, sub } = await cardTerm();
      vi.setSystemTime(FEB);
      const owner = await person(f.t, f.organizationId, "owner");
      const renewal = (change: "cancel" | "resume") =>
        owner.action(api.billing.changeRenewal, { organizationId: f.organizationId, change });
      const priceSwitches = () => switches(f, sub.id).filter((call) => "items[0][price]" in call);
      await renewal("cancel");
      await upgradeCheckout(f);
      upgradePaid(f);
      await sync(f);
      expect(await f.plan()).toMatchObject({ catalogTier: "large" });
      expect(priceSwitches()).toEqual([]);
      await renewal("resume");
      expect(priceSwitches()).toEqual([
        {
          "items[0][id]": "si_1",
          "items[0][price]": "price_large_year",
          proration_behavior: "none",
          billing_cycle_anchor: "unchanged",
        },
      ]);
    });

    it("bloqueia o upgrade pago cujo termo não é de uma assinatura deste cliente", async () => {
      const { f, term } = await cardTerm();
      await f.t.run((ctx) =>
        ctx.db.patch("platformPlanTerms", term._id, { stripeSubscriptionId: "sub_elsewhere" }),
      );
      vi.setSystemTime(FEB);
      upgradePaid(f);
      await sync(f);
      expect((await grants(f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "SUBSCRIPTION_REQUIRED",
      });
      expect((await terms(f))[0]!.upgrades).toBeUndefined();
    });

    it("recusa o upgrade no cartão a menos de 72 h do fim do termo; a sessão não tem âncora", async () => {
      const { f } = await cardTerm();
      vi.setSystemTime(END - 72 * 3600_000 + 1);
      expect(await code(upgradeCheckout(f))).toBe("PERIOD_CLOSING");
      vi.setSystemTime(END - 72 * 3600_000 - 60_000);
      await upgradeCheckout(f);
      const owner = await person(f.t, f.organizationId, "owner");
      // The same key answers the session it opened: a one-off payment, without an anchor.
      const prepared = await owner.mutation(internal.billing.prepareCheckout, {
        organizationId: f.organizationId,
        tier: "large",
        key: "annual-upgrade-card",
        livemode: false,
        cycle: "annual",
        start: "upgrade",
      });
      expect(prepared).toMatchObject({
        kind: "upgrade",
        annual: true,
        period: "2027-09-10T12:00:00.000Z",
        grantCents: 29166,
      });
      expect(prepared).not.toHaveProperty("anchor");
    });

    it("sem um termo do cartão elevado, a assinatura anual não troca de preço", async () => {
      const f = await fixture();
      // The account asks for Grande, but no term bought by this subscription reached it.
      const sub = await annualCard(f, { renewalTier: "large" });
      annualStart(f, sub.id);
      await sync(f);
      await f.t.run(async (ctx) => {
        const account = (await ctx.db.query("billingAccounts").first())!;
        await ctx.db.patch("billingAccounts", account._id, { renewalTier: "large" });
      });
      await sync(f);
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    });

    it("desfeito em 7 dias, o termo volta ao Intermediário e a assinatura desce uma vez ao preço anual dele, na mesma âncora", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(FEB);
      await upgradeCheckout(f);
      const invoice = upgradePaid(f);
      await sync(f);
      expect(await f.plan()).toMatchObject({ catalogTier: "large" });
      expect(switches(f, sub.id)).toHaveLength(1);
      vi.setSystemTime(FEB + 2 * DAY);
      expect(await undoUpgrade(f, term._id)).toEqual({
        reference: invoice.id,
        refundCents: 233333,
        tier: "intermediate",
      });
      expect((await terms(f))[0]).toMatchObject({
        tier: "intermediate",
        segments: [],
        upgrades: [],
        paidCents: 149000,
        undoneUpgrades: [{ reference: invoice.id, refundCents: 233333 }],
      });
      expect(await f.plan()).toMatchObject({
        catalogTier: "intermediate",
        termId: term._id,
        endsAt: END,
        periodAnchor: OCT,
      });
      expect(await f.t.run((ctx) => ctx.db.query("billingAccounts").first())).toMatchObject({
        renewalTier: "intermediate",
      });
      // The reconciliation the withdrawal scheduled moves the price down, without proration and
      // keeping the anchor; reading Stripe again changes nothing more.
      await runUntil(f, Date.now());
      await sync(f);
      expect(switches(f, sub.id)).toEqual([
        {
          "items[0][id]": "si_1",
          "items[0][price]": "price_large_year",
          proration_behavior: "none",
          billing_cycle_anchor: "unchanged",
        },
        {
          "items[0][id]": "si_1",
          "items[0][price]": "price_int_year",
          proration_behavior: "none",
          billing_cycle_anchor: "unchanged",
        },
      ]);
      // The renewal at the anchor is an Intermediário, and nothing is flagged for a person.
      vi.setSystemTime(END + 3600_000);
      const renewal = f.fake.invoice(annualRenewal(sub.id, END));
      await sync(f);
      expect((await terms(f)).find((row) => row.references[0] === renewal.id)).toMatchObject({
        tier: "intermediate",
        firstPeriod: END,
        state: "active",
      });
      const grant = (await grants(f)).find((row) => row.invoiceId === renewal.id)!;
      expect(grant.state).toBe("applied");
      expect(grant.code).toBeUndefined();
    });

    it("sem upgrade desfeito, a assinatura anual nunca desce de preço", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(FEB);
      await upgradeCheckout(f);
      upgradePaid(f);
      await sync(f);
      vi.setSystemTime(FEB + 7 * DAY + 1);
      expect(await code(undoUpgrade(f, term._id))).toBe("WITHDRAWAL_ENDED");
      // Someone sets the renewal down by hand: the reconciliation still refuses to follow.
      await f.t.run(async (ctx) => {
        const account = (await ctx.db.query("billingAccounts").first())!;
        await ctx.db.patch("billingAccounts", account._id, { renewalTier: "intermediate" });
      });
      await sync(f);
      expect(switches(f, sub.id)).toHaveLength(1);
    });

    it("desfeito depois do fim do termo, a renovação já cobrada no Grande não muda", async () => {
      const { f, sub, term } = await cardTerm();
      // In the last term month, before the card closes 72 hours ahead of its end.
      const paidAt = Date.UTC(2027, 9, 5, 12);
      vi.setSystemTime(paidAt);
      await upgradeCheckout(f);
      const invoice = upgradePaid(f, { amount: 29166, period: "2027-09-10T12:00:00.000Z" });
      await sync(f);
      expect(switches(f, sub.id)).toHaveLength(1);
      vi.setSystemTime(END + 3600_000);
      const renewal = f.fake.invoice(
        annualRenewal(sub.id, END, { amount: 499000, price: "price_large_year" }),
      );
      await sync(f);
      const next = (await terms(f)).find((row) => row.references[0] === renewal.id)!;
      expect(next).toMatchObject({ tier: "large", state: "active" });
      vi.setSystemTime(END + DAY);
      expect(await undoUpgrade(f, term._id)).toMatchObject({
        reference: invoice.id,
        refundCents: 29166,
      });
      // The plan is the renewal's, and the subscription already charged the Grande year.
      expect(await f.plan()).toMatchObject({ termId: next._id, catalogTier: "large" });
      expect(await f.t.run((ctx) => ctx.db.query("billingAccounts").first())).toMatchObject({
        renewalTier: "large",
      });
      await runUntil(f, Date.now());
      await sync(f);
      expect(switches(f, sub.id)).toHaveLength(1);
    });

    it("a rescisão expira o Checkout de upgrade aberto, aqui e no Stripe", async () => {
      const { f, term } = await cardTerm();
      vi.setSystemTime(FEB);
      await upgradeCheckout(f);
      const [session] = [...f.fake.state.sessions.values()];
      await rescind(f, term._id);
      expect(
        (await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).map(
          (row) => row.state,
        ),
      ).toEqual(["expired"]);
      await runUntil(f, Date.now());
      expect(f.fake.sent(`/v1/checkout/sessions/${session!.id as string}/expire`)).toHaveLength(1);
      expect(session!.status).toBe("expired");
    });
  });
});
