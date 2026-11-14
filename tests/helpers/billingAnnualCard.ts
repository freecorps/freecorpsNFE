import { vi } from "vite-plus/test";
import { internal } from "../../platform/convex/_generated/api";
import type { Id } from "../../platform/convex/_generated/dataModel";
import { termEndsAt } from "../../platform/convex/lib/annualTerms";
import { activateCatalogPlan } from "../../platform/convex/lib/planCore";
import { insertTerm } from "../../platform/convex/lib/planTerms";
import {
  OCT,
  NOV,
  type Json,
  YEARLY_PRICES,
  annualStartInvoice,
  annualCycleInvoice,
  type Fixture,
  deliver,
} from "./billing";

/**
 * Builders of the card annual suites (ADR 0010, decision 9, and ADR 0012, slice 2b): a card
 * Customer at the yearly price, its invoices and the support's actions on its term. Each suite
 * calls it once, inside its `describe`, so the invoice sequence belongs to that file.
 */
export function annualCardSuite() {
  const OCT_1 = Date.UTC(2026, 9, 1);
  /** A card annual signed at `OCT`, 10/10/2026 at 12:00 UTC: Stripe anchors it there. */
  const YEAR = termEndsAt(OCT);
  /** A card annual bought before slice 2b, anchored on 01/11/2025 at 00:00 UTC. */
  const LEGACY = Date.UTC(2025, 10, 1);
  const CUSTOMER = "cus_annual_card";
  let invoiceSeq = 0;
  const invoiceId = () => `in_annual_${String(++invoiceSeq).padStart(4, "0")}`;
  /** The Customer a card Checkout created, and its subscription at the yearly price. */
  async function annualCard(
    f: Fixture,
    {
      yearlyPrices = YEARLY_PRICES as Json[],
      tier = "intermediate" as "intermediate" | "large",
      renewalTier = undefined as "intermediate" | "large" | undefined,
      anchor = OCT,
    } = {},
  ) {
    f.fake.state.prices.push(...yearlyPrices);
    await f.t.run((ctx) =>
      ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: CUSTOMER,
        livemode: false,
        ...(renewalTier ? { renewalTier } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const sub = f.fake.subscribe(CUSTOMER, tier, termEndsAt(anchor), anchor);
    // Stripe expands the item's price in a subscription: its lookup key says it is yearly.
    (sub.items.data[0] as Json).price = YEARLY_PRICES[tier === "large" ? 1 : 0];
    return sub;
  }
  /** First invoice of an annual Checkout: the first year, charged at the signing, `OCT`. */
  const annualStart = (
    f: Fixture,
    subscription: string,
    {
      tier = "intermediate",
      amount = tier === "large" ? 499000 : 149000,
      paidAt = Date.now(),
      start = OCT,
      end = termEndsAt(start),
      organizationId = f.organizationId as string,
      fields = {},
    }: {
      tier?: string;
      amount?: number;
      paidAt?: number;
      start?: number;
      end?: number;
      organizationId?: string;
      fields?: Json;
    } = {},
  ) =>
    f.fake.invoice({
      id: invoiceId(),
      ...annualStartInvoice(CUSTOMER, subscription, organizationId, {
        tier,
        amount,
        start,
        end,
        paidAt,
      }),
      ...fields,
    });
  /** A yearly renewal: the line starts at an anniversary of `anchor`, the end of a term. */
  const annualRenewal = (
    subscription: string,
    start: number,
    { amount = 149000, price: priceId = "price_int_year", anchor = OCT } = {},
  ) => ({
    ...annualCycleInvoice(CUSTOMER, subscription, start, { anchor, amount, price: priceId }),
    id: invoiceId(),
  });
  const sync = (f: Fixture) =>
    f.t.action(internal.billing.sync, { organizationId: f.organizationId });
  const terms = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanTerms").collect());
  const grants = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingGrants").collect());
  const paid = (f: Fixture, id: string) =>
    deliver(f, { type: "invoice.paid", data: { object: { id, customer: CUSTOMER } } });
  const stock = (f: Fixture) =>
    f.t.run(async (ctx) => ({
      custody: (await ctx.db.query("platformPlanSettings").unique())!.allocatedCustodyCents,
      allocations: (await ctx.db.query("platformPlanAllocations").collect()).map((row) => [
        row.tier,
        row.filesBytes,
        row.custodyCents,
      ]),
    }));
  async function runUntil(f: Fixture, at: number) {
    vi.advanceTimersByTime(at - Date.now());
    await f.t.finishInProgressScheduledFunctions();
  }
  /** A card term bought before slice 2b, from 01/11/2025 to 01/11/2026, with its plan. */
  const legacyTerm = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: LEGACY,
        endsAt: NOV,
        source: "stripe",
        references: ["in_annual_2025_first"],
        paidCents: 149000,
        purchasedAt: LEGACY,
        segments: [],
        state: "active",
      });
      await activateCatalogPlan(
        ctx,
        f.organizationId,
        "intermediate",
        OCT,
        NOV,
        0,
        "operator",
        "Anual sintético",
        termId,
      );
      return termId;
    });
  const DAY = 24 * 60 * 60 * 1000;
  const OPERATOR = "operador-sintetico";
  const operatorAction = (termId: Id<"platformPlanTerms">, key: string) => ({
    termId,
    key,
    actor: OPERATOR,
    reason: "Cliente pediu ao suporte por escrito",
  });
  const rescind = (f: Fixture, termId: Id<"platformPlanTerms">, key = "rescission-card") =>
    f.t.mutation(internal.plans.rescindTerm, operatorAction(termId, key));
  const undoUpgrade = (f: Fixture, termId: Id<"platformPlanTerms">, key = "undo-card-upgrade") =>
    f.t.mutation(internal.plans.undoTermUpgrade, operatorAction(termId, key));
  const switches = (f: Fixture, subscriptionId: string) =>
    f.fake
      .sent(`/v1/subscriptions/${subscriptionId}`)
      .map((call) => Object.fromEntries(call.params));
  return {
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
    OPERATOR,
    operatorAction,
    rescind,
    undoUpgrade,
    switches,
  };
}
