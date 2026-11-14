import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { termEndsAt } from "./lib/annualTerms";
import { annualCardSuite } from "../../tests/helpers/billingAnnualCard";
import {
  OCT,
  BILLING_ENVIRONMENT,
  useStripeKeys,
  fixture,
  type Fixture,
  code,
} from "../../tests/helpers/billing";

/**
 * The support rescinds a card annual term (ADR 0010, decision 9).
 * Synthetic Stripe from `tests/helpers/billing.ts`: nothing here reaches Stripe, test mode or live.
 */
usePlatformEnvironment(BILLING_ENVIRONMENT);
useStripeKeys();

describe("anual por cartão: a fatura vira termo (ADR 0010, decisão 9, e ADR 0012, fatia 2b)", () => {
  const {
    YEAR,
    annualCard,
    annualStart,
    annualRenewal,
    sync,
    terms,
    grants,
    runUntil,
    DAY,
    rescind,
  } = annualCardSuite();
  describe("rescisão pelo suporte", () => {
    /** The 4th term month of a term of 10/10 at 12:00 ends on 10/02 at 12:00 UTC. */
    const FEB_10 = Date.UTC(2027, 1, 10, 12);
    const END = YEAR;
    async function cardTerm() {
      const f = await fixture();
      const sub = await annualCard(f);
      annualStart(f, sub.id);
      await sync(f);
      return { f, sub, term: (await terms(f))[0]! };
    }
    const account = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingAccounts").first());

    it("no 4º mês do termo devolve R$ 894, mantém o acesso até o fim desse mês, cancela a assinatura no Stripe e nenhuma cobrança anual vira termo", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
      const result = await rescind(f, term._id);
      expect(result).toEqual([
        {
          termId: term._id,
          withdrawal: false,
          usedMonths: 4,
          refundCents: 89400,
          accessEndsAt: FEB_10,
        },
      ]);
      expect(await f.plan()).toMatchObject({ termId: term._id, endsAt: FEB_10 });
      // The server never refunds: the only Stripe write is the cancellation of the subscription.
      await runUntil(f, Date.now());
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
      expect(f.fake.state.calls.filter((call) => call.path.includes("refund"))).toEqual([]);
      expect(sub.status).toBe("canceled");
      // The reconciliation read it back: no subscription left to renew or to resume.
      expect((await account(f))!.subscription).toBeUndefined();
      // Repeating the rescission schedules nothing new.
      expect(await rescind(f, term._id)).toEqual(result);
      await runUntil(f, Date.now());
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
      // Owner closure works again; it no longer waits for support.
      expect(
        await code(
          (await person(f.t, f.organizationId, "owner")).mutation(api.organizationClosure.close, {
            organizationId: f.organizationId,
            confirmation: (await f.t.run((ctx) => ctx.db.get("organizations", f.organizationId)))!
              .slug,
          }),
        ),
      ).toBe("OK");
    });

    it("se a assinatura ainda cobrar, a renovação fica para uma pessoa e não é retomada", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
      // Stripe does not answer: the cancellation is retried later.
      f.fake.state.failNext = 10;
      await rescind(f, term._id);
      await runUntil(f, Date.now());
      f.fake.state.failNext = 0;
      expect(sub.status).toBe("active");
      const owner = await person(f.t, f.organizationId, "owner");
      await owner.action(api.billing.changeRenewal, {
        organizationId: f.organizationId,
        change: "cancel",
      });
      expect(
        await code(
          owner.action(api.billing.changeRenewal, {
            organizationId: f.organizationId,
            change: "resume",
          }),
        ),
      ).toBe("ANNUAL_TERM_RESCINDED");
      f.fake.state.subscriptions[0]!.cancel_at_period_end = false;
      vi.setSystemTime(END + 3600_000);
      const renewal = f.fake.invoice(annualRenewal(sub.id, END));
      await sync(f);
      expect(await terms(f)).toHaveLength(1);
      expect((await grants(f)).find((row) => row.invoiceId === renewal.id)).toMatchObject({
        state: "blocked",
        code: "ANNUAL_TERM_RESCINDED",
      });
    });

    it("até 7 dias da cobrança, a renovação inclusive, devolve tudo e o acesso termina na hora", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(OCT + 3 * DAY);
      expect(await rescind(f, term._id)).toMatchObject([
        { withdrawal: true, refundCents: 149000, accessEndsAt: OCT + 3 * DAY },
      ]);
      expect(await f.plan()).toMatchObject({ endsAt: OCT + 3 * DAY });
      await runUntil(f, Date.now());
      expect(sub.status).toBe("canceled");

      vi.setSystemTime(OCT);
      const renewed = await cardTerm();
      vi.setSystemTime(END + 3600_000);
      const invoice = renewed.f.fake.invoice(annualRenewal(renewed.sub.id, END));
      await sync(renewed.f);
      const next = (await terms(renewed.f)).find((row) => row.references[0] === invoice.id)!;
      expect(next).toMatchObject({ state: "active", firstPeriod: END, anchor: OCT });
      vi.setSystemTime(END + 5 * DAY);
      expect(await rescind(renewed.f, next._id)).toMatchObject([
        { termId: next._id, withdrawal: true, refundCents: 149000, accessEndsAt: END + 5 * DAY },
      ]);
      expect(await renewed.f.plan()).toMatchObject({ termId: next._id, endsAt: END + 5 * DAY });
      // The term it renewed has ended: there is nothing left to rescind there.
      expect(await code(rescind(renewed.f, renewed.term._id, "rescission-ended"))).toBe(
        "TERM_ENDED",
      );
    });

    it("o cancelamento que falha é repetido e, esgotado, fica sinalizado até o operador repetir", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
      // One failure: the retry 15 minutes later cancels it.
      f.fake.state.failNext = 1;
      await rescind(f, term._id);
      await runUntil(f, Date.now());
      expect(sub.status).toBe("active");
      await runUntil(f, Date.now() + 15 * 60_000);
      expect(sub.status).toBe("canceled");
      // Read by its id, not by listing the Customer's subscriptions.
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "GET").length).toBeGreaterThan(0);

      vi.setSystemTime(OCT);
      const g = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
      g.f.fake.state.failNext = 1000;
      await rescind(g.f, g.term._id);
      // The last retry gives up and flags the rescinded term for a person.
      await g.f.t.action(internal.billing.stopTermRenewal, {
        organizationId: g.f.organizationId,
        subscriptionId: g.sub.id,
        attempt: 5,
      });
      expect((await terms(g.f))[0]!.rescission!.renewalStopFailed).toMatchObject({
        code: "SUBSCRIPTION_STOP_FAILED",
      });
      g.f.fake.state.failNext = 0;
      const owner = await person(g.f.t, g.f.organizationId, "owner");
      const reviews = () =>
        owner
          .query(api.billing.overview, { asOf: Date.now(), organizationId: g.f.organizationId })
          .then((overview) => overview.reviews.map((row) => [row.source, row.code]));
      expect(await reviews()).toContainEqual(["term", "SUBSCRIPTION_STOP_FAILED"]);
      // Its scheduled renewal, rescinded with it and flagged for the same subscription, is the
      // same pending item: shown once.
      await g.f.t.run(async (ctx) => {
        const { _id, _creationTime, ...first } = (await ctx.db.query("platformPlanTerms").first())!;
        await ctx.db.insert("platformPlanTerms", {
          ...first,
          firstPeriod: first.endsAt,
          anchor: first.firstPeriod,
          endsAt: termEndsAt(first.endsAt, first.firstPeriod),
          references: ["in_annual_renewal_synthetic"],
          rescission: { ...first.rescission!, after: _id },
        });
      });
      expect(
        (await reviews()).filter(([, reviewCode]) => reviewCode === "SUBSCRIPTION_STOP_FAILED"),
      ).toHaveLength(1);
      // The operator runs it again from the start: cancelled, and the flag goes away.
      await g.f.t.action(internal.billing.stopTermRenewal, {
        organizationId: g.f.organizationId,
        subscriptionId: g.sub.id,
        attempt: 0,
      });
      expect(g.sub.status).toBe("canceled");
      expect((await terms(g.f))[0]!.rescission!.renewalStopFailed).toBeUndefined();
      expect(await reviews()).not.toContainEqual(["term", "SUBSCRIPTION_STOP_FAILED"]);
    });
  });
});
