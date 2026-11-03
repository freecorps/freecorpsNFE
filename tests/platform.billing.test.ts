import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { enablePix, platformTest, person, usePlatformEnvironment } from "./helpers/platform";
import {
  billingConfig,
  invoiceGrant,
  readAnnualPrices,
  readBillingEnvelope,
  readCatalogPrices,
  readInvoice,
  readSubscriptions,
  type CatalogPrices,
} from "../platform/convex/lib/billingStripe";
import { termEndsAt } from "../platform/convex/lib/annualTerms";
import { activateCatalogPlan } from "../platform/convex/lib/planCore";
import { insertTerm } from "../platform/convex/lib/planTerms";

/**
 * Card subscriptions through Stripe (#556), proven against a synthetic Stripe API answered by a
 * stubbed `fetch` and synthetic signed events. Nothing here reaches Stripe, test mode or live.
 */
const OCT = Date.UTC(2026, 9, 10, 12);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
const JAN = Date.UTC(2027, 0, 1);
const WEBHOOK_SECRET = "whsec_synthetic_billing_only";
const s = (ms: number) => Math.floor(ms / 1000);
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-billing-only",
  now: OCT,
});
beforeEach(() => {
  vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "rk_test_synthetic0000");
  vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", WEBHOOK_SECRET);
});

type Json = Record<string, unknown>;
const PRICES: CatalogPrices = {
  intermediate: { priceId: "price_int", productId: "prod_int" },
  large: { priceId: "price_large", productId: "prod_large" },
};
const price = (id: string, lookup: string, amount: number, interval = "month") => ({
  id,
  lookup_key: lookup,
  active: true,
  livemode: false,
  currency: "brl",
  type: "recurring",
  unit_amount: amount,
  recurring: { interval, interval_count: 1, usage_type: "licensed" },
  product: id.replace("price", "prod"),
});
const YEARLY_PRICES = [
  price("price_int_year", "fnfe_plan_intermediate_annual_brl", 149000, "year"),
  price("price_large_year", "fnfe_plan_large_annual_brl", 499000, "year"),
];

/** A minimal Stripe: what the platform calls, what it sent, and failures on demand. */
function fakeStripe() {
  const state = {
    calls: [] as { method: string; path: string; params: URLSearchParams; key: string | null }[],
    customers: 0,
    sessions: new Map<string, Json>(),
    coupons: new Map<string, Json>(),
    loseResponseOnce: "",
    portalSessionOverrides: {} as Json,
    portalConfiguration: {
      active: true,
      livemode: false,
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
    } as Json,
    subscriptions: [] as Json[],
    invoices: [] as Json[],
    charges: new Map<string, Json>(),
    prices: [
      price("price_int", "fnfe_plan_intermediate_monthly_brl", 14900),
      price("price_large", "fnfe_plan_large_monthly_brl", 49900),
    ] as Json[],
    failNext: 0,
    /** Paths that time out on every call, whatever the method. */
    failPaths: [] as string[],
  };
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.stripe.com");
    const method = init.method ?? "GET";
    const params = new URLSearchParams(
      method === "GET" ? url.search : typeof init.body === "string" ? init.body : "",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("stripe-version")).toBe("2025-03-31.basil");
    state.calls.push({ method, path: url.pathname, params, key: headers.get("idempotency-key") });
    if (state.failNext > 0) {
      state.failNext--;
      throw new TypeError("synthetic timeout");
    }
    if (state.failPaths.includes(url.pathname)) throw new TypeError("synthetic timeout");
    const path = url.pathname;
    if (path === "/v1/prices") return reply({ data: state.prices });
    if (path === "/v1/customers") return reply({ id: `cus_${++state.customers}` });
    if (path === "/v1/coupons" && method === "POST") {
      const key = headers.get("idempotency-key")!;
      const coupon = state.coupons.get(key) ?? { id: `coupon_${state.coupons.size + 1}` };
      state.coupons.set(key, coupon);
      if (state.loseResponseOnce === path) {
        state.loseResponseOnce = "";
        throw new TypeError("synthetic lost response");
      }
      return reply(coupon);
    }
    if (path === "/v1/checkout/sessions" && method === "POST") {
      if (
        params.get("subscription_data[proration_behavior]") === "none" &&
        params.has("line_items[1][price_data][unit_amount]")
      )
        return reply({ error: { type: "invalid_request_error" } }, 400);
      const key = headers.get("idempotency-key")!;
      const id = `cs_${key.split(":")[1]}`;
      const session = state.sessions.get(id) ?? {
        id,
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: Number(params.get("expires_at")),
      };
      state.sessions.set(id, session);
      if (state.loseResponseOnce === path) {
        state.loseResponseOnce = "";
        throw new TypeError("synthetic lost response");
      }
      return reply(session);
    }
    const session = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    if (session) {
      const found = state.sessions.get(session[1]!);
      if (!found) return reply({ error: { code: "resource_missing" } }, 404);
      if (session[2]) found.status = "expired";
      return reply(found);
    }
    if (path === "/v1/subscriptions")
      return reply({
        data: state.subscriptions.filter((x) => x.customer === params.get("customer")),
      });
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (sub) {
      const found = state.subscriptions.find((x) => x.id === sub[1])!;
      if (method === "DELETE") found.status = "canceled";
      if (params.has("cancel_at_period_end"))
        found.cancel_at_period_end = params.get("cancel_at_period_end") === "true";
      // Stripe expands the item's price; the monthly fixtures keep the bare id, which says enough.
      if (params.has("items[0][price]")) {
        const id = params.get("items[0][price]");
        const yearly = state.prices.find(
          (row) => row.id === id && (row.recurring as Json | undefined)?.interval === "year",
        );
        (found.items as { data: Json[] }).data[0]!.price = yearly ?? id;
      }
      return reply(found);
    }
    if (path === "/v1/invoices")
      return reply({
        data: state.invoices.filter((x) => x.customer === params.get("customer")).toReversed(),
      });
    const charge = /^\/v1\/charges\/([^/]+)$/.exec(path);
    if (charge) return reply(state.charges.get(charge[1]!) ?? {});
    if (path === "/v1/billing_portal/sessions")
      return reply({
        url: "https://billing.stripe.com/p/session/synthetic",
        customer: params.get("customer"),
        livemode: false,
        configuration: state.portalConfiguration,
        ...state.portalSessionOverrides,
      });
    throw new Error(`unexpected Stripe call ${method} ${path}`);
  });
  return {
    state,
    sent: (path: string, method = "POST") =>
      state.calls.filter((call) => call.path === path && call.method === method),
    /** Paying the open Checkout creates the subscription; the session is then complete. */
    subscribe(customer: string, tier: "intermediate" | "large", periodEnd: number) {
      const id = `sub_${state.subscriptions.length + 1}`;
      for (const session of state.sessions.values())
        if (session.status === "open")
          Object.assign(session, { status: "complete", subscription: id });
      const subscription = {
        id,
        customer,
        status: "active",
        created: s(Date.now()),
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: "si_1",
              price: tier === "large" ? "price_large" : "price_int",
              current_period_end: s(periodEnd),
            },
          ],
        },
      };
      state.subscriptions.push(subscription);
      return subscription;
    },
    invoice(fields: Json) {
      const invoice = {
        id: `in_${state.invoices.length + 1}`,
        status: "paid",
        currency: "brl",
        attempted: true,
        lines: { data: [] },
        ...fields,
      };
      state.invoices.push(invoice);
      return invoice;
    },
  };
}
const startInvoice = (
  customer: string,
  subscription: string,
  organizationId: string,
  amount: number,
  tier = "intermediate",
) => ({
  customer,
  amount_paid: amount,
  amount_due: amount,
  billing_reason: "subscription_create",
  parent: {
    type: "subscription_details",
    subscription_details: {
      subscription,
      metadata: {
        organizationId,
        kind: "start",
        tier,
        period: "2026-10",
        grantCents: String(amount),
      },
    },
  },
});
const cycleInvoice = (
  customer: string,
  subscription: string,
  start: number,
  fields: Json = {},
) => ({
  customer,
  amount_paid: 14900,
  amount_due: 14900,
  billing_reason: "subscription_cycle",
  parent: { type: "subscription_details", subscription_details: { subscription, metadata: {} } },
  lines: {
    data: [
      {
        amount: 14900,
        period: { start: s(start), end: s(start) + 1 },
        pricing: {
          type: "price_details",
          price_details: { price: "price_int", product: "prod_int" },
        },
      },
    ],
  },
  ...fields,
});

async function fixture() {
  const t = platformTest();
  const org = (name: string) =>
    t.run((ctx) =>
      ctx.db.insert("organizations", {
        name,
        slug: crypto.randomUUID(),
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  const organizationId = await org("Organização sintética");
  const owner = await person(t, organizationId, "owner");
  await t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 10 * 2 ** 30,
    databaseBytes: 2 ** 30,
    custodyCents: 1_000_000,
    freeMonthlyCents: 10000,
    admissionsUntil: Date.UTC(2027, 11, 31),
    evidence: "synthetic-local-proof",
  });
  await enablePix(t);
  const fake = fakeStripe();
  const plan = () =>
    t.run((ctx) =>
      ctx.db
        .query("usagePlans")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .unique(),
    );
  const billing = () => owner.query(api.billing.overview, { organizationId });
  return { t, org, organizationId, owner, fake, plan, billing };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
function sign(body: string, secret = WEBHOOK_SECRET, at = s(Date.now())) {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}
let eventSeq = 0;
async function deliver(f: Fixture, event: Json, signature?: string) {
  const body = JSON.stringify({ id: `evt_${++eventSeq}`, livemode: false, ...event });
  const response = await f.t.fetch("/v1/billing/stripe/events", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature ?? sign(body) },
    body,
  });
  return { status: response.status, code: ((await response.json()) as { code: string }).code };
}
/** Runs the processing the webhook scheduled, without advancing to later scheduled work. */
async function processEvents(f: Fixture) {
  const pending = await f.t.run((ctx) =>
    ctx.db
      .query("billingEvents")
      .collect()
      .then((rows) => rows.filter((row) => row.state === "received")),
  );
  for (const event of pending)
    await f.t.action(internal.billing.processEvent, { eventId: event._id });
}
async function startCard(f: Fixture, tier: "intermediate" | "large" = "intermediate") {
  const { url } = await f.owner.action(api.billing.checkout, {
    organizationId: f.organizationId,
    tier,
    key: `start-${tier}-key`,
  });
  const customer = (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
  return { url, customer };
}

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
    const start = readInvoice({
      id: "in_1",
      ...startInvoice("cus_1", "sub_1", org, 14900),
      status: "paid",
      currency: "brl",
    })!;
    expect(invoiceGrant(start, PRICES, org)).toEqual({
      kind: "grant",
      tier: "intermediate",
      period: "2026-10",
    });
    expect(invoiceGrant({ ...start, amountPaid: 100 }, PRICES, org)).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    expect(invoiceGrant(start, PRICES, "org_2")).toEqual({
      kind: "review",
      code: "ORGANIZATION_MISMATCH",
    });
    expect(invoiceGrant({ ...start, status: "open" }, PRICES, org)).toEqual({
      kind: "none",
      code: "NOT_PAID",
    });
    expect(invoiceGrant({ ...start, currency: "usd" }, PRICES, org)).toEqual({
      kind: "review",
      code: "CURRENCY_MISMATCH",
    });
    const cycle = readInvoice({
      id: "in_2",
      ...cycleInvoice("cus_1", "sub_1", NOV),
      status: "paid",
      currency: "brl",
    })!;
    expect(invoiceGrant(cycle, PRICES, org)).toEqual({
      kind: "grant",
      tier: "intermediate",
      period: "2026-11",
    });
    expect(invoiceGrant({ ...cycle, amountPaid: 49900 }, PRICES, org)).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    expect(invoiceGrant({ ...cycle, lines: [] }, PRICES, org)).toEqual({
      kind: "review",
      code: "PRICE_UNKNOWN",
    });
    expect(invoiceGrant({ ...cycle, billingReason: "subscription_update" }, PRICES, org)).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
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

  it("uma fatura anual compra o termo pelo annualCents e só com o preço anual conferido", () => {
    const org = "org_1";
    const ANNUAL = {
      intermediate: { priceId: "price_int_year", productId: "prod_int_year" },
    };
    const start = readInvoice({
      id: "in_1",
      ...startInvoice("cus_1", "sub_1", org, 149000),
      status: "paid",
      currency: "brl",
      status_transitions: { paid_at: s(OCT) },
    })!;
    const annualStart = {
      ...start,
      subscriptionMetadata: { ...start.subscriptionMetadata, cycle: "annual", period: "2026-11" },
      lines: [{ priceId: "price_int_year", periodStart: OCT, amount: 0 }],
    };
    expect(start.paidAt).toBe(OCT);
    expect(invoiceGrant(annualStart, PRICES, org, ANNUAL)).toEqual({
      kind: "annual",
      tier: "intermediate",
      period: "2026-11",
    });
    // Marked annual, but no line at the verified yearly price: nothing shows it renews yearly.
    expect(invoiceGrant({ ...annualStart, lines: [] }, PRICES, org, ANNUAL)).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    expect(invoiceGrant(annualStart, PRICES, org)).toEqual({
      kind: "review",
      code: "PRICE_UNKNOWN",
    });
    expect(
      invoiceGrant(
        {
          ...annualStart,
          amountPaid: 14900,
          subscriptionMetadata: { ...annualStart.subscriptionMetadata, grantCents: "14900" },
        },
        PRICES,
        org,
        ANNUAL,
      ),
    ).toEqual({ kind: "review", code: "AMOUNT_MISMATCH" });
    // The subscription renews at what its recurring line charges: it must be the cycle bought.
    const line = (priceId: string) => [{ priceId, periodStart: NOV, amount: 0 }];
    expect(invoiceGrant({ ...annualStart, lines: line("price_int") }, PRICES, org, ANNUAL)).toEqual(
      { kind: "review", code: "INVOICE_UNEXPECTED" },
    );
    const monthlyStart = readInvoice({
      id: "in_3",
      ...startInvoice("cus_1", "sub_1", org, 14900),
      status: "paid",
      currency: "brl",
    })!;
    expect(invoiceGrant(monthlyStart, PRICES, org, ANNUAL)).toMatchObject({ kind: "grant" });
    expect(
      invoiceGrant({ ...monthlyStart, lines: line("price_int_year") }, PRICES, org, ANNUAL),
    ).toEqual({ kind: "review", code: "INVOICE_UNEXPECTED" });
    // A yearly price that no longer verifies is unknown by id, but its subscription is annual.
    expect(
      invoiceGrant({ ...monthlyStart, lines: line("price_int_year") }, PRICES, org, {}, ["sub_1"]),
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
    const renewal = readInvoice({
      id: "in_2",
      ...cycleInvoice("cus_1", "sub_1", NOV, { amount_paid: 149000 }),
      status: "paid",
      currency: "brl",
    })!;
    const yearly = { ...renewal, lines: [{ ...renewal.lines[0]!, priceId: "price_int_year" }] };
    expect(invoiceGrant(yearly, PRICES, org, ANNUAL)).toEqual({
      kind: "annual",
      tier: "intermediate",
      period: "2026-11",
    });
    expect(invoiceGrant(yearly, PRICES, org)).toEqual({ kind: "review", code: "PRICE_UNKNOWN" });
    expect(invoiceGrant({ ...yearly, amountPaid: 14900 }, PRICES, org, ANNUAL)).toEqual({
      kind: "review",
      code: "AMOUNT_MISMATCH",
    });
    // The anchor must be the 1st at 00:00 UTC: an hour later is no term renewal.
    const offAnchor = { ...yearly, lines: [{ ...yearly.lines[0]!, periodStart: NOV + 3600_000 }] };
    expect(invoiceGrant(offAnchor, PRICES, org, ANNUAL)).toEqual({
      kind: "review",
      code: "INVOICE_UNEXPECTED",
    });
    // The annual upgrade: a one-off payment marked annual, priced on the term when applied.
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
        period: "2027-02",
        grantCents: "233333",
      },
    })!;
    const LARGE = {
      ...ANNUAL,
      large: { priceId: "price_large_year", productId: "prod_large_year" },
    };
    expect(invoiceGrant(upgrade, PRICES, org, LARGE)).toEqual({
      kind: "annualUpgrade",
      tier: "large",
      period: "2027-02",
    });
    // Without the yearly price it moves the subscription to, it waits for a person.
    expect(invoiceGrant(upgrade, PRICES, org, ANNUAL)).toEqual({
      kind: "review",
      code: "PRICE_UNKNOWN",
    });
    expect(
      invoiceGrant(
        { ...upgrade, metadata: { ...upgrade.metadata, cycle: undefined } },
        PRICES,
        org,
        LARGE,
      ),
    ).toEqual({ kind: "grant", tier: "large", period: "2027-02" });
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

describe("portal de cartão e faturas", () => {
  it("abre para gestores usando o cliente da organização e a configuração conferida", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const admin = await person(f.t, f.organizationId, "admin");
    for (const manager of [f.owner, admin])
      expect(
        await manager.action(api.billing.portal, { organizationId: f.organizationId }),
      ).toEqual({
        url: "https://billing.stripe.com/p/session/synthetic",
      });
    for (const call of f.fake.sent("/v1/billing_portal/sessions")) {
      expect(call.params.get("customer")).toBe(customer);
      expect(call.params.get("expand[0]")).toBe("configuration");
    }
  });

  it.each([
    ["subscription_cancel", true],
    ["subscription_update", true],
    ["invoice_history", false],
    ["payment_method_update", false],
    ["subscription_cancel", undefined],
  ] as const)("recusa o portal com %s = %s", async (feature, enabled) => {
    const f = await fixture();
    await startCard(f);
    const features = f.fake.state.portalConfiguration.features as Json;
    features[feature] = { enabled };
    expect(
      await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("BILLING_UNAVAILABLE");
  });

  it.each([{ active: false }, { livemode: true }, { features: null }])(
    "recusa configuração inativa, de outro ambiente ou incompleta: %j",
    async (patch) => {
      const f = await fixture();
      await startCard(f);
      Object.assign(f.fake.state.portalConfiguration, patch);
      expect(
        await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
      ).toBe("BILLING_UNAVAILABLE");
    },
  );

  it("não abre sessão para pessoas sem acesso à organização ou sem gestão", async () => {
    const f = await fixture();
    await startCard(f);
    const args = { organizationId: f.organizationId };
    for (const role of ["developer", "operator", "viewer"] as const) {
      const member = await person(f.t, f.organizationId, role);
      expect(await code(member.action(api.billing.portal, args))).toBe("ACCESS_DENIED");
    }
    expect(await code(f.t.action(api.billing.portal, args))).toBe("UNAUTHENTICATED");
    const other = await f.org("Outra organização");
    expect(await code(f.owner.action(api.billing.portal, { organizationId: other }))).toBe(
      "ACCESS_DENIED",
    );
    expect(f.fake.sent("/v1/billing_portal/sessions")).toHaveLength(0);
  });
});

describe("respostas inconsistentes do portal", () => {
  it.each([
    { customer: "cus_other" },
    { livemode: true },
    { configuration: "bpc_not_expanded" },
    { url: "http://billing.stripe.com/unsafe" },
  ])("não entrega a sessão: %j", async (response) => {
    const f = await fixture();
    await startCard(f);
    f.fake.state.portalSessionOverrides = response;
    expect(
      await code(f.owner.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("BILLING_UNAVAILABLE");
  });
});

describe("interruptor do Pix na cobrança", () => {
  it("billing:overview traz pixEnabled, com e sem o cartão configurado", async () => {
    const f = await fixture();
    expect((await f.billing()).pixEnabled).toBe(true);
    await f.t.mutation(internal.plans.configurePix, {
      enabled: false,
      expectedVersion: 1,
      evidence: "synthetic-pix-off",
    });
    expect((await f.billing()).pixEnabled).toBe(false);
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "");
    expect(await f.billing()).toMatchObject({ card: false, pixEnabled: false });
  });
});

describe("permissões e isolamento", () => {
  it("recusa papel sem gestão, sessão ausente, outra organização e cobrança desligada", async () => {
    const f = await fixture();
    const viewer = await person(f.t, f.organizationId, "viewer");
    const operator = await person(f.t, f.organizationId, "operator");
    const args = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      key: "denied-key-1",
    };
    expect(
      await code(viewer.query(api.billing.overview, { organizationId: f.organizationId })),
    ).toBe("ACCESS_DENIED");
    expect(await code(viewer.action(api.billing.checkout, args))).toBe("ACCESS_DENIED");
    expect(await code(operator.action(api.billing.checkout, args))).toBe("ACCESS_DENIED");
    expect(
      await code(
        operator.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "cancel",
        }),
      ),
    ).toBe("ACCESS_DENIED");
    expect(
      await code(operator.action(api.billing.portal, { organizationId: f.organizationId })),
    ).toBe("ACCESS_DENIED");
    expect(await code(f.t.action(api.billing.checkout, args))).toBe("UNAUTHENTICATED");
    const other = await f.org("Outra organização");
    expect(
      await code(f.owner.action(api.billing.checkout, { ...args, organizationId: other })),
    ).toBe("ACCESS_DENIED");
    expect(await code(f.owner.query(api.billing.overview, { organizationId: other }))).toBe(
      "ACCESS_DENIED",
    );
    expect(f.fake.state.calls).toEqual([]);
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", "");
    expect(await code(f.owner.action(api.billing.checkout, args))).toBe("BILLING_DISABLED");
    expect(await f.billing()).toMatchObject({ card: false });
    expect(
      (await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1" } } })).status,
    ).toBe(404);
  });

  it("um evento de outro cliente ou de outro modo nunca mexe no plano", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    // Invoice of this customer claiming another organization: blocked, never granted.
    f.fake.invoice({ ...startInvoice(customer, sub.id, "j57other", 14900) });
    expect(
      await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    expect(
      await deliver(f, {
        type: "invoice.paid",
        livemode: true,
        data: { object: { id: "in_1", customer } },
      }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    expect(
      await deliver(f, {
        type: "invoice.paid",
        data: { object: { id: "in_9", customer: "cus_stranger" } },
      }),
    ).toEqual({ status: 200, code: "RECEIVED" });
    await processEvents(f);
    expect(await f.plan()).toBeNull();
    const events = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(events.map((e) => [e.state, e.code ?? null])).toEqual([
      ["processed", null],
      ["ignored", "LIVEMODE_MISMATCH"],
      ["ignored", "UNKNOWN_CUSTOMER"],
    ]);
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "blocked", code: "ORGANIZATION_MISMATCH" },
    ]);
    expect((await f.billing()).reviews).toMatchObject([
      { source: "grant", code: "ORGANIZATION_MISMATCH" },
    ]);
  });

  it("recusa assinatura inválida sem registrar nada", async () => {
    const f = await fixture();
    const body = JSON.stringify({
      id: "evt_x",
      type: "invoice.paid",
      livemode: false,
      data: { object: { id: "in_1" } },
    });
    expect(
      await deliver(
        f,
        { type: "invoice.paid", data: { object: { id: "in_1" } } },
        sign(body, "whsec_outro_segredo_sint"),
      ),
    ).toEqual({ status: 400, code: "SIGNATURE_INVALID" });
    expect(
      await deliver(
        f,
        { type: "invoice.paid", data: { object: { id: "in_1" } } },
        sign(body, WEBHOOK_SECRET, s(Date.now()) - 3600),
      ),
    ).toMatchObject({ status: 400 });
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toEqual([]);
  });
});

describe("ciclo da assinatura", () => {
  it.each(["/v1/coupons", "/v1/checkout/sessions"])(
    "recupera resposta perdida em %s sem duplicar cupom ou sessão",
    async (path) => {
      const f = await fixture();
      const args = {
        organizationId: f.organizationId,
        tier: "intermediate" as const,
        key: "retry-monthly",
      };
      f.fake.state.loseResponseOnce = path;
      expect(await code(f.owner.action(api.billing.checkout, args))).toBe("BILLING_UNAVAILABLE");
      expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").first())).toMatchObject({
        state: "creating",
      });
      const result = await f.owner.action(api.billing.checkout, args);
      expect(result.url).toContain("checkout.stripe.com");
      expect(f.fake.state.coupons.size).toBe(1);
      expect(f.fake.state.sessions.size).toBe(1);
      for (const endpoint of ["/v1/coupons", "/v1/checkout/sessions"]) {
        const calls = f.fake.sent(endpoint);
        expect(new Set(calls.map((call) => call.key)).size).toBe(1);
        expect(new Set(calls.map((call) => call.params.toString())).size).toBe(1);
      }
      expect(await f.plan()).toBeNull();
    },
  );

  it("o Stripe simulado recusa a combinação original da #668", async () => {
    fakeStripe();
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "stripe-version": "2025-03-31.basil" },
      body: new URLSearchParams({
        "subscription_data[proration_behavior]": "none",
        "line_items[1][price_data][unit_amount]": "14900",
      }).toString(),
    });
    expect(response.status).toBe(400);
  });

  it("a diferença após Pix é avulsa e o desconto inicial cobre só o recorrente maior", async () => {
    const f = await fixture();
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-before-large",
    });
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 14900,
      paymentReference: "synthetic-pix-difference",
      actor: "operator",
    });
    await f.owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "large-after-pix",
    });
    expect(Object.fromEntries(f.fake.sent("/v1/checkout/sessions")[0]!.params)).toMatchObject({
      "line_items[0][price]": "price_large",
      "line_items[1][price_data][unit_amount]": "35000",
      "subscription_data[proration_behavior]": "create_prorations",
      "subscription_data[billing_cycle_anchor]": String(s(NOV)),
    });
    expect(f.fake.sent("/v1/coupons")[0]!.params.get("applies_to[products][0]")).toBe("prod_large");
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate" });
  });

  it("contrata pelo Checkout, só ativa com a fatura paga e não repete o efeito", async () => {
    const f = await fixture();
    const { url, customer } = await startCard(f);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [created] = f.fake.sent("/v1/checkout/sessions");
    expect(Object.fromEntries(created!.params)).toMatchObject({
      mode: "subscription",
      customer,
      "line_items[0][price]": "price_int",
      "line_items[1][price_data][unit_amount]": "14900",
      "subscription_data[billing_cycle_anchor]": String(s(NOV)),
      "subscription_data[proration_behavior]": "create_prorations",
      "discounts[0][coupon]": "coupon_1",
      "subscription_data[metadata][grantCents]": "14900",
      "payment_method_types[0]": "card",
    });
    expect(Object.fromEntries(f.fake.sent("/v1/coupons")[0]!.params)).toMatchObject({
      duration: "once",
      percent_off: "100",
      "applies_to[products][0]": "prod_int",
      max_redemptions: "1",
      redeem_by: created!.params.get("expires_at"),
    });
    // Same intention after an uncertain answer: same session, one Stripe creation.
    expect(
      await f.owner.action(api.billing.checkout, {
        organizationId: f.organizationId,
        tier: "intermediate",
        key: "start-intermediate-key",
      }),
    ).toEqual({ url });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    // Card and Pix never run together.
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "large",
          key: "pix-while-card",
        }),
      ),
    ).toBe("PAYMENT_METHOD_CARD");
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "second-checkout",
        }),
      ),
    ).toBe("CHECKOUT_PENDING");
    // The browser coming back proves nothing.
    await f.owner.action(api.billing.refresh, { organizationId: f.organizationId });
    expect(await f.plan()).toBeNull();
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    f.fake.state.sessions.get(
      `cs_${(await f.t.run((ctx) => ctx.db.query("billingCheckouts").first()))!._id}`,
    )!.status = "complete";
    const event = { type: "invoice.paid", data: { object: { id: "in_1", customer } } };
    const body = JSON.stringify({ id: "evt_dup", livemode: false, ...event });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await f.t.fetch("/v1/billing/stripe/events", {
            method: "POST",
            headers: { "stripe-signature": sign(body) },
            body,
          })
        ).status,
      ).toBe(200);
    await processEvents(f);
    await f.owner.action(api.billing.refresh, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV, version: 1 });
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "applied", invoiceId: "in_1" },
    ]);
    expect(await f.billing()).toMatchObject({
      checkout: null,
      account: {
        renewalTier: "intermediate",
        subscription: { tier: "intermediate", periodEnd: NOV, cancelAtPeriodEnd: false },
      },
    });
  });

  it("renova no dia 1, ignora fatura antiga atrasada, e sem carência vence até o pagamento ser recuperado", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    vi.setSystemTime(NOV + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV));
    (sub.items.data[0] as Json).current_period_end = s(DEC);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: DEC, version: 2 });
    // A late, repeated event for October's invoice changes nothing.
    await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ endsAt: DEC, version: 2 });
    // December's charge is declined: the plan ends with November, the documents stay.
    vi.setSystemTime(DEC + 3600_000);
    const declined = f.fake.invoice(
      cycleInvoice(customer, sub.id, DEC, {
        status: "open",
        amount_paid: 0,
        hosted_invoice_url: "https://invoice.stripe.com/i/synthetic",
      }),
    );
    sub.status = "past_due";
    await deliver(f, {
      type: "invoice.payment_failed",
      data: { object: { id: declined.id, customer } },
    });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ endsAt: DEC });
    // Months later the console session has expired; read the account directly.
    const account = () => f.t.run((ctx) => ctx.db.query("billingAccounts").first());
    expect(await account()).toMatchObject({
      subscription: { status: "past_due" },
      openInvoice: {
        id: declined.id,
        amountDueCents: 14900,
        url: "https://invoice.stripe.com/i/synthetic",
      },
    });
    // Recovered on day 5: the whole month, as Pix.
    vi.setSystemTime(DEC + 4 * 86400_000);
    Object.assign(declined, { status: "paid", amount_paid: 14900 });
    sub.status = "active";
    (sub.items.data[0] as Json).current_period_end = s(JAN);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: JAN, version: 3 });
    expect((await account())?.openInvoice).toBeUndefined();
  });

  it("fechada a janela de admissão, quem já tem o plano renova; plano novo e upgrade são recusados (#549)", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
    // The window closes before the renewal on day 1.
    await f.t.run(async (ctx) => {
      const settings = await ctx.db.query("platformPlanSettings").first();
      await ctx.db.patch("platformPlanSettings", settings!._id, { admissionsUntil: NOV - 1 });
    });
    vi.setSystemTime(NOV + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV));
    (sub.items.data[0] as Json).current_period_end = s(DEC);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: DEC, version: 2 });
    expect(
      (await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).map((g) => g.state),
    ).toEqual(["applied", "applied"]);
    // Sessions from October have expired; fresh owners act in November.
    const owner = await person(f.t, f.organizationId, "owner");
    const other = await f.org("Outra organização");
    const otherOwner = await person(f.t, other, "owner");
    // An upgrade reserves more stock: it waits for a new window.
    expect(
      await code(
        owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "upgrade-after-window",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    // So does the first plan of another organization.
    expect(
      await code(
        otherOwner.action(api.billing.checkout, {
          organizationId: other,
          tier: "intermediate",
          key: "start-after-window",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
  });

  it("upgrade cobra a diferença integral, downgrade e cancelamento valem só na renovação", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    await f.owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "upgrade-large-1",
    });
    const upgrade = f.fake.sent("/v1/checkout/sessions").at(-1)!;
    expect(Object.fromEntries(upgrade.params)).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][unit_amount]": "35000",
      "invoice_creation[enabled]": "true",
      "invoice_creation[invoice_data][metadata][kind]": "upgrade",
    });
    f.fake.invoice({
      customer,
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
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV, version: 2 });
    // The subscription now renews at Grande, without proration.
    expect(Object.fromEntries(f.fake.sent("/v1/subscriptions/sub_1").at(-1)!.params)).toEqual({
      "items[0][id]": "si_1",
      "items[0][price]": "price_large",
      proration_behavior: "none",
    });
    // Downgrade: next renewal at Intermediário, October keeps Grande.
    expect(
      await code(
        f.owner.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "large",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "intermediate",
    });
    expect((sub.items.data[0] as Json).price).toBe("price_int");
    expect(await f.plan()).toMatchObject({ catalogTier: "large", version: 2 });
    // Cancel: no renewal, the paid period stays; Pix becomes possible again.
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(sub.cancel_at_period_end).toBe(true);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV });
    expect((await f.billing()).account?.subscription?.cancelAtPeriodEnd).toBe(true);
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "resume",
    });
    expect(sub.cancel_at_period_end).toBe(false);
  });

  it("um mês já pago por Pix não é cobrado de novo no cartão", async () => {
    const f = await fixture();
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-october",
    });
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "card-during-pix",
        }),
      ),
    ).toBe("PLAN_REQUEST_PENDING");
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 14900,
      paymentReference: "synthetic-pix-ref",
      actor: "operator",
    });
    await f.owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "card-after-pix",
    });
    const params = Object.fromEntries(f.fake.sent("/v1/checkout/sessions").at(-1)!.params);
    expect(params["line_items[1][price_data][unit_amount]"]).toBeUndefined();
    expect(params["subscription_data[metadata][grantCents]"]).toBe("0");
    expect(params["subscription_data[proration_behavior]"]).toBe("none");
    expect(params["discounts[0][coupon]"]).toBeUndefined();
    expect(f.fake.sent("/v1/coupons")).toHaveLength(0);
    const customer = (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice({ ...startInvoice(customer, sub.id, f.organizationId, 0), amount_paid: 0 });
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", version: 1 });
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "skipped", code: "ZERO_AMOUNT" },
    ]);
    // A second payment for the same month is held for a person, not granted twice.
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect((await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).at(-1)).toMatchObject({
      state: "blocked",
      code: "DUPLICATE_PAYMENT",
    });
    expect(await f.plan()).toMatchObject({ version: 1 });
  });

  it("reembolso e contestação só sinalizam; timeout do Stripe é retentado sem repetir efeito", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    f.fake.state.failNext = 1;
    await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } });
    await processEvents(f);
    let [event] = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(event).toMatchObject({ state: "received", attempts: 1 });
    expect(await f.plan()).toBeNull();
    await processEvents(f);
    [event] = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(event).toMatchObject({ state: "processed" });
    expect(await f.plan()).toMatchObject({ version: 1 });
    f.fake.state.charges.set("ch_1", { id: "ch_1", customer });
    await deliver(f, {
      type: "charge.refunded",
      data: { object: { id: "ch_1", customer, amount_refunded: 14900, refunded: true } },
    });
    await deliver(f, {
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_1", amount: 14900 } },
    });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", version: 1 });
    const { reviews } = await f.billing();
    expect(reviews.map((item) => item.code).sort()).toEqual(["DISPUTE_OPENED", "REFUND_FULL"]);
    const open = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    await f.t.mutation(internal.billing.resolveReview, {
      eventId: open.find((e) => e.review)!._id,
      actor: "operator",
    });
    expect((await f.billing()).reviews).toHaveLength(1);
  });

  it("abandonar o Checkout expira a sessão no Stripe e libera o Pix", async () => {
    const f = await fixture();
    await startCard(f);
    await f.owner.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    expect(f.fake.sent("/v1/checkout/sessions").length).toBe(1);
    expect((await f.billing()).checkout).toBeNull();
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "pix-after-abandon",
        }),
      ),
    ).toBe("OK");
  });

  it("encerrar a organização cancela a assinatura no Stripe", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    await f.t.action(internal.billing.stopForClosure, {
      organizationId: f.organizationId as Id<"organizations">,
      attempt: 0,
    });
    expect(sub.status).toBe("canceled");
    expect((await f.billing()).account?.subscription).toBeNull();
  });
});

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
        source: "pix",
        references: [`pix-annual-${organizationId}`],
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
  const requestPix = (f: Fixture, key: string, tier: "intermediate" | "large" = "intermediate") =>
    f.owner.mutation(api.plans.requestPaid, { organizationId: f.organizationId, tier, key });
  const confirm = (f: Fixture, requestId: Id<"platformPlanRequests">, reference: string) =>
    f.t.mutation(internal.plans.confirmPayment, {
      requestId,
      amountCents: 14900,
      paymentReference: reference,
      actor: "operator",
    });
  const checkoutLarge = (f: Fixture, key: string) =>
    f.owner.action(api.billing.checkout, { organizationId: f.organizationId, tier: "large", key });
  const grants = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingGrants").collect());

  it("nunca grava um termo fora do formato", async () => {
    const f = await fixture();
    await expect(
      annual(f, f.organizationId, "active", { firstPeriod: Date.UTC(2026, 9, 15) }),
    ).rejects.toThrow(RangeError);
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanTerms").collect())).toEqual([]);
  });

  it("no mês coberto, recusa Pix, confirmação, atribuição e gratuito sem mexer no plano anual", async () => {
    const f = await fixture();
    // Asked before the term existed, then paid by Pix under it.
    const request = await requestPix(f, "pix-before-annual");
    const termId = await annual(f, f.organizationId, "active", { grant: true });
    const plan = await f.plan();
    expect(plan).toMatchObject({ catalogTier: "intermediate", termId, version: 1 });
    expect(await code(requestPix(f, "pix-under-annual", "large"))).toBe("ANNUAL_TERM_ACTIVE");
    expect(await code(confirm(f, request.id, "synthetic-pix-under-annual"))).toBe(
      "ANNUAL_TERM_ACTIVE",
    );
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
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      state: "awaiting_payment",
    });
    // The free tier activates without a term, for the covered month: refused too.
    const other = await f.org("Gratuito sob anual");
    const owner = await person(f.t, other, "owner");
    await annual(f, other);
    expect(await code(owner.mutation(api.plans.claimFree, { organizationId: other }))).toBe(
      "ANNUAL_TERM_ACTIVE",
    );
  });

  it("com o anual agendado para o mês seguinte, o mês corrente ainda é vendido por Pix", async () => {
    const f = await fixture();
    await annual(f, f.organizationId, "scheduled", { firstPeriod: NOV });
    const request = await requestPix(f, "pix-before-scheduled");
    await confirm(f, request.id, "synthetic-pix-before-scheduled");
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
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

  it("um anual agendado para o mês seguinte recusa um novo Checkout, mas a fatura do mês corrente vale", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    await annual(f, f.organizationId, "scheduled", { firstPeriod: NOV });
    expect(await code(checkoutLarge(f, "card-before-scheduled"))).toBe("ANNUAL_TERM_ACTIVE");
    // A Stripe retry that pays October, before the term, still grants October.
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await grants(f)).toMatchObject([{ state: "applied" }]);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
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
  ] as const)("com o termo %s, o Pix mensal volta a valer", async (_, state, firstPeriod) => {
    const f = await fixture();
    await annual(f, f.organizationId, state, { firstPeriod });
    const request = await requestPix(f, "pix-after-annual");
    await confirm(f, request.id, "synthetic-pix-after-annual");
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
  });

  it("o último mês coberto ainda recusa o Pix mensal", async () => {
    const f = await fixture();
    // November 2025 to November 2026: October is its last month.
    await annual(f, f.organizationId, "active", { firstPeriod: Date.UTC(2025, 10, 1) });
    expect(await code(requestPix(f, "pix-last-month"))).toBe("ANNUAL_TERM_ACTIVE");
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
      const sub = f.fake.subscribe(customer, "intermediate", NOV);
      await annual(f, f.organizationId, state, { firstPeriod });
      f.fake.invoice(cycleInvoice(customer, sub.id, NOV));
      await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
      expect(await grants(f)).toMatchObject([
        { invoiceId: "in_1", period: "2026-11", state: "blocked", code: "ANNUAL_TERM_ACTIVE" },
      ]);
      expect(await f.plan()).toBeNull();
    },
  );

  it("o anual por Pix é recusado com Checkout aberto ou cartão que renova", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    const annualPix = (start: "now" | "next") =>
      code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: `annual-pix-${start}`,
          cycle: "annual",
          start,
        }),
      );
    const { customer } = await startCard(f);
    expect(await annualPix("now")).toBe("PAYMENT_METHOD_CARD");
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await annualPix("now")).toBe("PAYMENT_METHOD_CARD");
    expect(await annualPix("next")).toBe("PAYMENT_METHOD_CARD");
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
    // With the renewal cancelled, the annual can start next month, after the paid card month.
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(await annualPix("next")).toBe("OK");
  });

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

describe("anual por cartão: a fatura vira termo (ADR 0010, decisão 9)", () => {
  const OCT_1 = Date.UTC(2026, 9, 1);
  const CUSTOMER = "cus_annual_card";
  const yearlyPrice = (tier: string) => (tier === "large" ? "price_large_year" : "price_int_year");
  let invoiceSeq = 0;
  const invoiceId = () => `in_annual_${String(++invoiceSeq).padStart(4, "0")}`;
  /** The Customer a card Checkout created, and its subscription at the yearly price. */
  async function annualCard(
    f: Fixture,
    {
      yearlyPrices = YEARLY_PRICES as Json[],
      tier = "intermediate" as "intermediate" | "large",
      renewalTier = undefined as "intermediate" | "large" | undefined,
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
    const sub = f.fake.subscribe(CUSTOMER, tier, termEndsAt(OCT_1));
    // Stripe expands the item's price in a subscription: its lookup key says it is yearly.
    (sub.items.data[0] as Json).price = YEARLY_PRICES[tier === "large" ? 1 : 0];
    return sub;
  }
  /** First invoice of an annual Checkout: a one-off item for the term, the yearly price at R$ 0. */
  const annualStart = (
    f: Fixture,
    subscription: string,
    {
      period = "2026-10",
      tier = "intermediate",
      amount = 149000,
      paidAt = Date.now(),
      organizationId = f.organizationId as string,
      fields = {} as Json,
    } = {},
  ) =>
    f.fake.invoice({
      id: invoiceId(),
      customer: CUSTOMER,
      amount_paid: amount,
      amount_due: amount,
      billing_reason: "subscription_create",
      status_transitions: { paid_at: s(paidAt) },
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription,
          metadata: {
            organizationId,
            kind: "start",
            cycle: "annual",
            tier,
            period,
            grantCents: String(amount),
          },
        },
      },
      lines: {
        data: [
          {
            amount,
            period: { start: s(Date.now()), end: s(Date.now()) },
            pricing: { type: "price_details", price_details: { price: "price_1OneOff" } },
          },
          {
            amount: 0,
            period: { start: s(Date.now()), end: s(Date.now()) + 1 },
            pricing: { type: "price_details", price_details: { price: yearlyPrice(tier) } },
          },
        ],
      },
      ...fields,
    });
  /** A yearly renewal: the line starts at the end of the term it follows. */
  const annualRenewal = (
    subscription: string,
    start: number,
    { amount = 149000, price: priceId = "price_int_year" } = {},
  ) => ({
    ...cycleInvoice(CUSTOMER, subscription, start, {
      id: invoiceId(),
      amount_paid: amount,
      amount_due: amount,
      status_transitions: { paid_at: s(Date.now()) },
    }),
    lines: {
      data: [
        {
          amount,
          period: { start: s(start), end: s(termEndsAt(start)) },
          pricing: { type: "price_details", price_details: { price: priceId } },
        },
      ],
    },
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

  it("começando agora, cria um termo ativo e concede o plano até o fim do termo, uma vez", async () => {
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
      firstPeriod: OCT_1,
      endsAt: termEndsAt(OCT_1),
      references: [invoice.id],
      paidCents: 149000,
      purchasedAt: OCT,
    });
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: term._id,
      endsAt: termEndsAt(OCT_1),
      version: 1,
    });
    expect(await grants(f)).toMatchObject([
      {
        invoiceId: invoice.id,
        state: "applied",
        period: "2026-10",
        termId: term._id,
        planVersion: 1,
      },
    ]);
    // The yearly subscription is never moved to a monthly price.
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    expect((await f.billing()).account?.subscription).toMatchObject({ tier: "intermediate" });
    // Another annual invoice for months the term covers: paid, so blocked for a person.
    const twice = annualStart(f, sub.id, { period: "2026-11" });
    await sync(f);
    expect((await grants(f))[1]).toMatchObject({
      invoiceId: twice.id,
      state: "blocked",
      code: "ANNUAL_TERM_ACTIVE",
    });
    expect(await terms(f)).toHaveLength(1);
  });

  it("começando no mês seguinte, agenda o termo e só troca o plano no dia 1", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    annualStart(f, sub.id, { period: "2026-11" });
    await sync(f);
    const [term] = await terms(f);
    expect(term).toMatchObject({ state: "scheduled", firstPeriod: NOV, endsAt: termEndsAt(NOV) });
    expect(await grants(f)).toMatchObject([{ state: "applied", termId: term!._id }]);
    expect(await f.plan()).toBeNull();
    await runUntil(f, NOV);
    expect(await terms(f)).toMatchObject([{ state: "active" }]);
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: term!._id,
      startsAt: NOV,
      endsAt: termEndsAt(NOV),
    });
  });

  it("no último mês do termo, a renovação anual agenda o termo seguinte sem intervalo e sem nova reserva", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    // November 2025 to November 2026, bought by card: October is its last month.
    const firstPeriod = Date.UTC(2025, 10, 1);
    const old = await f.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: NOV,
        source: "stripe",
        references: ["in_annual_2025_first"],
        paidCents: 149000,
        purchasedAt: firstPeriod,
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
    const before = await stock(f);
    const renewal = f.fake.invoice(annualRenewal(sub.id, NOV));
    await sync(f);
    // Its own previous term does not block the renewal.
    const renewed = (await terms(f)).find((term) => term._id !== old)!;
    expect(renewed).toMatchObject({
      state: "scheduled",
      source: "stripe",
      firstPeriod: NOV,
      endsAt: termEndsAt(NOV),
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
      endsAt: termEndsAt(NOV),
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
    const renewal = f.fake.invoice(annualRenewal(sub.id, termEndsAt(OCT_1)));
    // The renewal's event first, then a late repeat of the first invoice's.
    await paid(f, renewal.id);
    await paid(f, first.id);
    await processEvents(f);
    await sync(f);
    expect((await terms(f)).map((term) => [term.state, term.firstPeriod])).toEqual([
      ["active", OCT_1],
      ["scheduled", termEndsAt(OCT_1)],
    ]);
    expect((await grants(f)).map((grant) => [grant.invoiceId, grant.state])).toEqual([
      [first.id, "applied"],
      [renewal.id, "applied"],
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: termEndsAt(OCT_1), version: 1 });
  });

  it.each([
    ["com valor diferente", "AMOUNT_MISMATCH", { amount: 148000 }],
    ["em outra moeda", "CURRENCY_MISMATCH", { fields: { currency: "usd" } }],
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
      f.fake.invoice(annualRenewal(sub.id, OCT_1, { amount, price: priceId }));
      await sync(f);
      expect(await grants(f)).toMatchObject([{ state: "blocked", code: blocked }]);
      expect(await terms(f)).toEqual([]);
    },
  );

  it("sem os preços anuais no Stripe, o mensal continua e a fatura anual fica PRICE_UNKNOWN", async () => {
    const f = await fixture();
    const sub = await annualCard(f, { yearlyPrices: [] });
    const monthlySub = f.fake.subscribe(CUSTOMER, "intermediate", NOV);
    f.fake.invoice({
      ...startInvoice(CUSTOMER, monthlySub.id, f.organizationId, 14900),
      id: invoiceId(),
    });
    const annual = annualStart(f, sub.id, { period: "2026-11" });
    await sync(f);
    expect((await grants(f)).map((grant) => [grant.state, grant.code ?? null])).toEqual([
      ["applied", null],
      ["blocked", "PRICE_UNKNOWN"],
    ]);
    expect((await grants(f))[1]).toMatchObject({ invoiceId: annual.id });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
    expect(await terms(f)).toEqual([]);
  });

  it("paga depois do primeiro mês do termo fica LATE_PAYMENT; paga a tempo e lida depois vale", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    vi.setSystemTime(NOV + 2 * 86400_000);
    annualStart(f, sub.id, { paidAt: NOV + 3600_000 });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "LATE_PAYMENT" }]);
    expect(await terms(f)).toEqual([]);
    // Paid on October 31st, read only in November: the term is granted from now to its end.
    const onTime = annualStart(f, sub.id, { paidAt: NOV - 3600_000 });
    await sync(f);
    expect(await terms(f)).toMatchObject([
      { state: "active", firstPeriod: OCT_1, purchasedAt: NOV - 3600_000, references: [onTime.id] },
    ]);
    expect(await f.plan()).toMatchObject({ startsAt: Date.now(), endsAt: termEndsAt(OCT_1) });
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
        source: "pix",
        references: ["pix-annual-other-org"],
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
    expect(await f.plan()).toMatchObject({ endsAt: termEndsAt(OCT_1) });
  });

  it("com o interruptor anual desligado, a fatura paga vale; a recusa de admissão bloqueia", async () => {
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
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    expect(await terms(f)).toMatchObject([{ state: "active" }]);
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
  });

  it("depois do anual por cartão, a fatura mensal de um mês coberto continua bloqueada", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    annualStart(f, sub.id);
    await sync(f);
    const monthly = f.fake.invoice({ ...cycleInvoice(CUSTOMER, sub.id, NOV), id: invoiceId() });
    await sync(f);
    expect(await grants(f)).toMatchObject([
      { state: "applied" },
      { invoiceId: monthly.id, state: "blocked", code: "ANNUAL_TERM_ACTIVE" },
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: termEndsAt(OCT_1), version: 1 });
  });

  it("a renovação cobrada no aniversário concede o termo seguinte na hora, sem nova reserva", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    // November 2025 to November 2026; Stripe charges the renewal at the anchor, an hour late.
    const firstPeriod = Date.UTC(2025, 10, 1);
    await f.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: NOV,
        source: "stripe",
        references: ["in_annual_2025_first"],
        paidCents: 149000,
        purchasedAt: firstPeriod,
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
    });
    const before = await stock(f);
    vi.setSystemTime(NOV + 3600_000);
    const renewal = f.fake.invoice(annualRenewal(sub.id, NOV));
    await sync(f);
    const renewed = (await terms(f)).find((term) => term.references[0] === renewal.id)!;
    expect(renewed).toMatchObject({
      state: "active",
      firstPeriod: NOV,
      endsAt: termEndsAt(NOV),
      purchasedAt: NOV + 3600_000,
    });
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      startsAt: NOV + 3600_000,
      endsAt: termEndsAt(NOV),
      version: 2,
    });
    expect(await grants(f)).toMatchObject([{ state: "applied", planVersion: 2 }]);
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
    annualStart(f, sub.id, { tier: "large", amount: 499000 });
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
    const monthly = g.fake.subscribe(customer, "intermediate", NOV);
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
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_annual_other_sub"],
        stripeSubscriptionId: "sub_another_annual",
        paidCents: 149000,
        purchasedAt: OCT_1,
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
    const sub = f.fake.subscribe(CUSTOMER, "intermediate", NOV);
    (sub.items.data[0] as Json).price = "price_retired_monthly";
    await sync(f);
    expect(
      f.fake.sent(`/v1/subscriptions/${sub.id}`).map((call) => call.params.get("items[0][price]")),
    ).toEqual(["price_int"]);
  });

  it("a primeira cobrança anual na âncora do dia 1, sem termo anterior, cria e ativa o termo", async () => {
    const f = await fixture();
    const sub = await annualCard(f);
    // The likely `next` route: no charge at the Checkout, the yearly price charged on the 1st.
    vi.setSystemTime(NOV + 3600_000);
    const invoice = f.fake.invoice(annualRenewal(sub.id, NOV));
    await sync(f);
    const [term] = await terms(f);
    expect(term).toMatchObject({
      state: "active",
      firstPeriod: NOV,
      endsAt: termEndsAt(NOV),
      references: [invoice.id],
      stripeSubscriptionId: sub.id,
    });
    expect(await f.plan()).toMatchObject({ termId: term!._id, endsAt: termEndsAt(NOV) });
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

  it.each([
    [
      "com o 1º mês depois do mês seguinte",
      (f: Fixture, sub: string) => annualStart(f, sub, { period: "2026-12" }),
    ],
    [
      "com o id fora do formato de referência",
      (f: Fixture, sub: string) => annualStart(f, sub, { fields: { id: "in_1" } }),
    ],
    [
      "de renovação paga mais de um mês antes",
      (f: Fixture, sub: string) => f.fake.invoice(annualRenewal(sub, DEC)),
    ],
  ] as const)("bloqueia a fatura anual %s", async (_, invoice) => {
    const f = await fixture();
    const sub = await annualCard(f);
    invoice(f, sub.id);
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "INVOICE_UNEXPECTED" }]);
    expect(await terms(f)).toEqual([]);
  });

  it("não retoma a assinatura anual com um anual por Pix agendado para depois do termo dela", async () => {
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
    // In the card term's last month, a Pix annual is bought for the month after it. The first
    // session has expired by then; a manager signs in again.
    vi.setSystemTime(Date.UTC(2027, 8, 15));
    const owner = await person(f.t, f.organizationId, "owner");
    const request = await owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-annual-after-card",
      cycle: "annual",
      start: "next",
    });
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 149000,
      paymentReference: "pix-annual-after-card",
      actor: "operator",
    });
    expect((await terms(f)).map((term) => [term.source, term.state])).toEqual([
      ["stripe", "active"],
      ["pix", "scheduled"],
    ]);
    // Resumed, the card would charge at its anchor a term the Pix one already covers.
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

  describe("upgrade do Intermediário anual para o Grande anual", () => {
    const FEB = Date.UTC(2027, 1, 10, 12);
    const FEB_1 = Date.UTC(2027, 1, 1);
    const END = termEndsAt(OCT_1);
    const annualOn = (f: Fixture) =>
      f.t.mutation(internal.plans.configureAnnual, {
        enabled: true,
        expectedVersion: 1,
        evidence: "synthetic-annual-on",
      });
    /** An Intermediário annual bought by card from October 2026, active, sale switch on. */
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
        period = "2027-02",
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

    it("cobra a diferença no Checkout, sobe o plano, reserva o aporte e a renovação passa a Grande sem mudar a data", async () => {
      const { f, sub, first, term } = await cardTerm();
      expect(term).toMatchObject({ tier: "intermediate", stripeSubscriptionId: sub.id });
      expect(await stock(f)).toMatchObject({ custody: 10800 });
      vi.setSystemTime(FEB);
      const { url } = await upgradeCheckout(f);
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      // A one-off payment of the difference over the 8 months left, the current one whole.
      expect(sessionParams(f)).toMatchObject({
        mode: "payment",
        customer: CUSTOMER,
        "line_items[0][price_data][currency]": "brl",
        "line_items[0][price_data][unit_amount]": "233333",
        "invoice_creation[enabled]": "true",
        "invoice_creation[invoice_data][metadata][kind]": "upgrade",
        "invoice_creation[invoice_data][metadata][cycle]": "annual",
        "invoice_creation[invoice_data][metadata][tier]": "large",
        "invoice_creation[invoice_data][metadata][period]": "2027-02",
        "invoice_creation[invoice_data][metadata][grantCents]": "233333",
      });
      expect(Object.keys(sessionParams(f))).not.toContain(
        "subscription_data[billing_cycle_anchor]",
      );
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
        segments: [{ tier: "large", fromPeriod: FEB_1 }],
        references: [first.id, invoice.id],
        paidCents: 149000 + 233333,
        purchasedAt: OCT,
        upgrades: [{ fromTier: "intermediate", tier: "large", fromPeriod: FEB_1, paidAt: FEB }],
      });
      expect(await f.plan()).toMatchObject({
        catalogTier: "large",
        termId: term._id,
        endsAt: END,
        version: 2,
      });
      expect((await grants(f)).at(-1)).toMatchObject({
        invoiceId: invoice.id,
        state: "applied",
        tier: "large",
        period: "2027-02",
        termId: term._id,
        planVersion: 2,
      });
      // The custody fund goes from R$ 108 to R$ 280 before the plan is raised.
      expect(await stock(f)).toMatchObject({ custody: 28000 });
      // The yearly subscription moves to the Grande yearly price once, without proration or
      // a new anchor: the renewal date stays and the next year is Grande.
      expect(
        f.fake.sent(`/v1/subscriptions/${sub.id}`).map((call) => Object.fromEntries(call.params)),
      ).toEqual([
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
        state: "active",
      });
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
      expect(await grants(f)).toHaveLength(3);
    });

    it("no último mês cobra um mês e ainda troca o preço da renovação", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 8, 20));
      await upgradeCheckout(f);
      expect(sessionParams(f)["line_items[0][price_data][unit_amount]"]).toBe("29166");
      upgradePaid(f, { amount: 29166, period: "2027-09" });
      await sync(f);
      expect(await terms(f)).toMatchObject([
        { _id: term._id, segments: [{ tier: "large", fromPeriod: Date.UTC(2027, 8, 1) }] },
      ]);
      expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toHaveLength(1);
    });

    it("recusa antes do Stripe: sem termo, termo Pix, Grande já em vigor, anual desligado, Checkout aberto e virada do mês", async () => {
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

      const pix = await fixture();
      await annualOn(pix);
      await pix.t.run(async (ctx) => {
        const termId = await insertTerm(ctx, {
          organizationId: pix.organizationId,
          tier: "intermediate",
          firstPeriod: OCT_1,
          endsAt: END,
          source: "pix",
          references: ["pix-annual-upgrade"],
          paidCents: 149000,
          purchasedAt: OCT,
          segments: [],
          state: "active",
        });
        await activateCatalogPlan(
          ctx,
          pix.organizationId,
          "intermediate",
          OCT,
          END,
          0,
          "operator",
          "Anual sintético",
          termId,
        );
      });
      expect(await code(upgradeCheckout(pix))).toBe("PAYMENT_METHOD_PIX");

      const { f } = await cardTerm();
      expect(await code(upgradeCheckout(f, { tier: "intermediate" }))).toBe("PLAN_UNAVAILABLE");
      // The last 45 minutes of the month: the price would change with the month.
      vi.setSystemTime(NOV - 30 * 60_000);
      expect(await code(upgradeCheckout(f))).toBe("PERIOD_CLOSING");
      vi.setSystemTime(OCT);
      await upgradeCheckout(f);
      expect(await code(upgradeCheckout(f, { key: "annual-upgrade-other" }))).toBe(
        "CHECKOUT_PENDING",
      );
      // The same key answers the same session; with another choice it is a conflict.
      expect(await code(upgradeCheckout(f))).toBe("OK");
      expect(
        await code(
          f.owner.action(api.billing.checkout, {
            organizationId: f.organizationId,
            tier: "large",
            key: "annual-upgrade-card",
            cycle: "annual",
          }),
        ),
      ).toBe("OPERATION_CONFLICT");
      // An open Checkout keeps the Pix away.
      expect(
        await code(
          f.owner.mutation(api.plans.requestPaid, {
            organizationId: f.organizationId,
            tier: "large",
            key: "pix-upgrade-under-card",
            cycle: "annual",
            start: "upgrade",
          }),
        ),
      ).toBe("PAYMENT_METHOD_CARD");
      expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);

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
      // Amount different from what the server prices for that month.
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

      // Paid after the month it priced.
      vi.setSystemTime(OCT);
      const late = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 2, 2));
      upgradePaid(late.f, { period: "2027-02", paidAt: Date.UTC(2027, 2, 1, 1) });
      await sync(late.f);
      expect((await grants(late.f)).at(-1)).toMatchObject({
        state: "blocked",
        code: "LATE_PAYMENT",
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
        owner.query(api.billing.overview, { organizationId: f.organizationId });
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
      const switches = () =>
        f.fake
          .sent(`/v1/subscriptions/${sub.id}`)
          .filter((call) => call.params.has("items[0][price]"))
          .map((call) => Object.fromEntries(call.params));
      await renewal("cancel");
      await upgradeCheckout(f);
      upgradePaid(f);
      await sync(f);
      expect(await f.plan()).toMatchObject({ catalogTier: "large" });
      expect(switches()).toEqual([]);
      await renewal("resume");
      expect(switches()).toEqual([
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
      expect(
        await owner.mutation(internal.billing.prepareCheckout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "annual-upgrade-card",
          livemode: false,
          cycle: "annual",
          start: "upgrade",
        }),
      ).toMatchObject({ kind: "upgrade", annual: true, anchor: null, grantCents: 29166 });
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
      const paidAt = Date.UTC(2027, 8, 25, 12);
      vi.setSystemTime(paidAt);
      await upgradeCheckout(f);
      const invoice = upgradePaid(f, { amount: 29166, period: "2027-09" });
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

  describe("rescisão pelo suporte", () => {
    const FEB_1 = Date.UTC(2027, 1, 1);
    const END = termEndsAt(OCT_1);
    async function cardTerm() {
      const f = await fixture();
      const sub = await annualCard(f);
      annualStart(f, sub.id);
      await sync(f);
      return { f, sub, term: (await terms(f))[0]! };
    }
    const account = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingAccounts").first());

    it("no 4º mês devolve R$ 894, cancela a assinatura no Stripe e nenhuma cobrança anual vira termo", async () => {
      const { f, sub, term } = await cardTerm();
      vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
      const result = await rescind(f, term._id);
      expect(result).toEqual([
        {
          termId: term._id,
          withdrawal: false,
          usedMonths: 4,
          refundCents: 89400,
          accessEndsAt: FEB_1,
        },
      ]);
      expect(await f.plan()).toMatchObject({ termId: term._id, endsAt: FEB_1 });
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
      expect(next).toMatchObject({ state: "active", firstPeriod: END });
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
          .query(api.billing.overview, { organizationId: g.f.organizationId })
          .then((overview) => overview.reviews.map((row) => [row.source, row.code]));
      expect(await reviews()).toContainEqual(["term", "SUBSCRIPTION_STOP_FAILED"]);
      // Its scheduled renewal, rescinded with it and flagged for the same subscription, is the
      // same pending item: shown once.
      await g.f.t.run(async (ctx) => {
        const { _id, _creationTime, ...first } = (await ctx.db.query("platformPlanTerms").first())!;
        await ctx.db.insert("platformPlanTerms", {
          ...first,
          firstPeriod: first.endsAt,
          endsAt: termEndsAt(first.endsAt),
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

describe("Checkout anual por cartão (ADR 0010, decisão 9)", () => {
  const OCT_1 = Date.UTC(2026, 9, 1);
  type Tier = "intermediate" | "large";
  async function annualOn(f: Fixture, { yearly = true } = {}) {
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    if (yearly) f.fake.state.prices.push(...(YEARLY_PRICES as Json[]));
  }
  const annualCheckout = (
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
   * Completing the session: nothing is due before the anchor, so Stripe completes it as
   * `no_payment_required`, with no invoice, and creates the subscription at the yearly price.
   */
  function subscribeAnnual(f: Fixture, customer: string) {
    const params = sentParams(f);
    const anchor = Number(params["subscription_data[billing_cycle_anchor]"]) * 1000;
    const sub = f.fake.subscribe(customer, "intermediate", anchor);
    (sub.items.data[0] as Json).price = f.fake.state.prices.find(
      (row) => row.id === params["line_items[0][price]"],
    );
    for (const session of f.fake.state.sessions.values())
      session.payment_status = "no_payment_required";
    return { sub, params };
  }
  /** The first charge, on the anchor: a yearly line from the 1st of `start` (November). */
  const firstCharge = (
    f: Fixture,
    customer: string,
    subscription: string,
    {
      id = "in_annual_card_first",
      price = "price_large_year",
      amount = 499000,
      start = NOV,
      fields = {},
    } = {},
  ) =>
    f.fake.invoice({
      ...cycleInvoice(customer, subscription, start),
      id,
      amount_paid: amount,
      amount_due: amount,
      status_transitions: { paid_at: s(Date.now()) },
      lines: {
        data: [
          {
            amount,
            period: { start: s(start), end: s(termEndsAt(start)) },
            pricing: { type: "price_details", price_details: { price } },
          },
        ],
      },
      ...fields,
    });
  const terms = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanTerms").collect());
  const grants = (f: Fixture) => f.t.run((ctx) => ctx.db.query("billingGrants").collect());
  const sync = (f: Fixture) =>
    f.t.action(internal.billing.sync, { organizationId: f.organizationId });
  const customerOf = async (f: Fixture) =>
    (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
  const term = (f: Fixture, state: "active" | "scheduled", firstPeriod: number) =>
    f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: termEndsAt(firstPeriod),
        source: "pix",
        references: [`pix-annual-${state}`],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state,
      }),
    );

  it("não cobra nada agora, ancora no dia 1 seguinte e a cobrança desse dia concede o termo", async () => {
    const f = await fixture();
    await annualOn(f);
    const { url } = await annualCheckout(f, { tier: "large" });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const customer = await customerOf(f);
    const marks = {
      organizationId: f.organizationId,
      kind: "start",
      tier: "large",
      period: "2026-11",
      grantCents: "499000",
      cycle: "annual",
    };
    // Only the yearly price: no one-off line, no trial.
    expect(sentParams(f)).toEqual({
      customer,
      client_reference_id: f.organizationId,
      locale: "pt-BR",
      "payment_method_types[0]": "card",
      success_url: expect.stringMatching(/\/usage\?cobranca=retorno$/),
      cancel_url: expect.stringMatching(/\/usage\?cobranca=cancelado$/),
      expires_at: String(s(OCT + 24 * 3600_000)),
      mode: "subscription",
      "line_items[0][price]": "price_large_year",
      "line_items[0][quantity]": "1",
      // The 1st of November at 00:00 UTC.
      "subscription_data[billing_cycle_anchor]": String(s(NOV)),
      "subscription_data[proration_behavior]": "none",
      ...Object.fromEntries(
        Object.entries(marks).flatMap(([name, value]) => [
          [`metadata[${name}]`, value],
          [`subscription_data[metadata][${name}]`, value],
        ]),
      ),
    });
    expect(await f.billing()).toMatchObject({
      checkout: {
        kind: "start",
        tier: "large",
        cycle: "annual",
        period: "2026-11",
        grantCents: 499000,
      },
    });
    // Completed without payment and without an invoice: the session closes, nothing is weighed.
    const { sub } = subscribeAnnual(f, customer);
    await sync(f);
    expect(await f.billing()).toMatchObject({
      checkout: null,
      account: { renewalTier: "large", subscription: { id: sub.id, annual: true } },
    });
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
    // The closed slot is not `CHECKOUT_PENDING`; the yearly subscription that renews refuses.
    expect(await code(annualCheckout(f, { key: "annual-card-again" }))).toBe(
      "SUBSCRIPTION_RENEWING",
    );
    // On the anchor Stripe charges the first year. Even with its event lost, the check scheduled
    // when the session completed reads it.
    vi.advanceTimersByTime(NOV + 3600_000 - Date.now());
    const first = firstCharge(f, customer, sub.id);
    vi.advanceTimersByTime(2 * 3600_000);
    await f.t.finishInProgressScheduledFunctions();
    const [created] = await terms(f);
    expect(created).toMatchObject({
      state: "active",
      source: "stripe",
      tier: "large",
      firstPeriod: NOV,
      endsAt: termEndsAt(NOV),
      references: [first.id],
      stripeSubscriptionId: sub.id,
      paidCents: 499000,
    });
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      termId: created!._id,
      endsAt: termEndsAt(NOV),
    });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`)).toEqual([]);
  });

  it("uma primeira cobrança fora do esperado fica para uma pessoa; uma fatura de R$ 0, se vier, não compra nada", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const { sub } = subscribeAnnual(f, customer);
    // Not expected with an anchor (still unproven in Stripe test mode), but harmless if it arrives.
    f.fake.invoice({
      id: "in_annual_card_zero",
      customer,
      amount_paid: 0,
      amount_due: 0,
      billing_reason: "subscription_create",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: sub.id, metadata: sentMarks(f) },
      },
    });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "skipped", code: "ZERO_AMOUNT" }]);
    // A first charge with another `billing_reason`: the money is held for a refund or a decision.
    vi.setSystemTime(NOV + 3600_000);
    firstCharge(f, customer, sub.id, {
      price: "price_int_year",
      amount: 149000,
      fields: { billing_reason: "subscription_update" },
    });
    await sync(f);
    expect((await grants(f))[1]).toMatchObject({
      invoiceId: "in_annual_card_first",
      state: "blocked",
      code: "INVOICE_UNEXPECTED",
    });
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
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).toMatchObject([
      { cycle: "annual", period: "2026-11", grantCents: 149000, state: "open" },
    ]);
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
    ["um termo que cobre o mês seguinte", "active", OCT_1],
    ["um termo agendado", "scheduled", NOV],
  ] as const)("recusa com %s", async (_, state, firstPeriod) => {
    const f = await fixture();
    await annualOn(f);
    await term(f, state, firstPeriod);
    expect(await code(annualCheckout(f))).toBe("ANNUAL_TERM_ACTIVE");
    expect(f.fake.state.calls).toEqual([]);
  });

  it("recusa com Pix aguardando ou Checkout aberto; um plano mensal maior em vigor não impede", async () => {
    const f = await fixture();
    await annualOn(f);
    const pix = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-before-annual-card",
    });
    expect(await code(annualCheckout(f))).toBe("PLAN_REQUEST_PENDING");
    await f.owner.mutation(api.plans.cancelRequest, {
      organizationId: f.organizationId,
      requestId: pix.id,
    });
    await startCard(f);
    expect(await code(annualCheckout(f))).toBe("CHECKOUT_PENDING");
    await f.owner.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    // The current month keeps the larger plan; the annual Intermediate follows it.
    await f.t.run((ctx) =>
      activateCatalogPlan(ctx, f.organizationId, "large", OCT, NOV, 0, "operator", "Mensal"),
    );
    expect(await code(annualCheckout(f))).toBe("OK");
    expect(sessions(f)).toHaveLength(2);
  });

  it("recusa com plano personalizado, na virada do mês e sem admissão", async () => {
    const f = await fixture();
    await annualOn(f);
    const settings = (admissionsUntil: number) =>
      f.t.run(async (ctx) => {
        const row = await ctx.db.query("platformPlanSettings").first();
        await ctx.db.patch("platformPlanSettings", row!._id, { admissionsUntil });
      });
    // A first plan reserves stock: closed admissions refuse it, reopened ones sell it.
    await settings(Date.now() - 1);
    expect(await code(annualCheckout(f))).toBe("PLAN_UNAVAILABLE");
    expect(f.fake.state.calls).toEqual([]);
    await settings(Date.UTC(2027, 11, 31));
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
    // 30 minutes before the 1st, the customer could not finish before the anchor.
    vi.setSystemTime(NOV - 30 * 60_000);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(await code(annualCheckout(f, { owner }))).toBe("PERIOD_CLOSING");
    expect(f.fake.state.calls).toEqual([]);
    vi.setSystemTime(OCT);
    expect(await code(annualCheckout(f, { owner }))).toBe("OK");
  });

  it("recusa enquanto o cartão mensal renova; depois de “Não renovar”, o anual é vendido", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    await annualOn(f);
    const sub = f.fake.subscribe(customer, "intermediate", NOV);
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
    expect(sentMarks(f)).toMatchObject({ cycle: "annual", period: "2026-11" });
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

  it("em dezembro ancora em 1º de janeiro do ano seguinte, e a cobrança desse dia vira o termo", async () => {
    // Two hours before the year turns, on 31 December.
    vi.setSystemTime(JAN - 2 * 3600_000);
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f, { tier: "large" });
    expect(sentParams(f)).toMatchObject({
      "subscription_data[billing_cycle_anchor]": String(s(JAN)),
      "subscription_data[proration_behavior]": "none",
      // The session ends before the anchor: past it, the anchor would be in the past.
      expires_at: String(s(JAN - 5 * 60_000)),
    });
    expect(sentMarks(f)).toMatchObject({ period: "2027-01", cycle: "annual" });
    const customer = await customerOf(f);
    const { sub } = subscribeAnnual(f, customer);
    await sync(f);
    expect(await terms(f)).toEqual([]);
    vi.advanceTimersByTime(JAN + 3600_000 - Date.now());
    const first = firstCharge(f, customer, sub.id, { start: JAN });
    vi.advanceTimersByTime(2 * 3600_000);
    await f.t.finishInProgressScheduledFunctions();
    expect(await terms(f)).toMatchObject([
      {
        state: "active",
        tier: "large",
        firstPeriod: JAN,
        endsAt: Date.UTC(2028, 0, 1),
        references: [first.id],
      },
    ]);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: Date.UTC(2028, 0, 1) });
  });

  it("a conclusão sem pagamento, reenviada com o interruptor desligado, não concede nem agenda outra conferência", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const { sub } = subscribeAnnual(f, customer);
    const [session] = f.fake.state.sessions.values();
    const completed = {
      id: "evt_annual_completed",
      type: "checkout.session.completed",
      data: { object: { id: session!.id, customer, payment_status: "no_payment_required" } },
    };
    expect((await deliver(f, completed)).status).toBe(200);
    await processEvents(f);
    // The switch stops new sales; it does not undo one already made.
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    // The same event again, and the same completion seen through another event.
    expect((await deliver(f, completed)).status).toBe(200);
    expect(
      (
        await deliver(f, {
          type: "customer.subscription.created",
          data: { object: { id: sub.id, customer } },
        })
      ).status,
    ).toBe(200);
    await processEvents(f);
    const events = await f.t.run((ctx) => ctx.db.query("billingEvents").collect());
    expect(events.map((event) => event.state)).toEqual(["processed", "processed"]);
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).toMatchObject([
      { cycle: "annual", period: "2026-11", state: "complete" },
    ]);
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
    expect(await f.plan()).toBeNull();
    const checks = await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.scheduledTime === NOV + 2 * 3600_000,
      ),
    );
    expect(checks).toHaveLength(1);
    // The money is taken on the 1st: the term is created even with the switch off.
    vi.advanceTimersByTime(NOV + 3600_000 - Date.now());
    firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    vi.advanceTimersByTime(2 * 3600_000);
    await f.t.finishInProgressScheduledFunctions();
    expect(await terms(f)).toMatchObject([
      { state: "active", tier: "intermediate", firstPeriod: NOV },
    ]);
  });

  /** Sells the annual Intermediate on 10 October and completes it without payment. */
  async function soldAnnual(f: Fixture) {
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const { sub } = subscribeAnnual(f, customer);
    await sync(f);
    return { customer, sub };
  }
  const fallbackChecks = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.scheduledTime === NOV + 2 * 3600_000,
      ),
    );

  const settingsPatch = (f: Fixture, fields: { admissionsUntil?: number; enabled?: boolean }) =>
    f.t.run(async (ctx) => {
      const row = await ctx.db.query("platformPlanSettings").first();
      await ctx.db.patch("platformPlanSettings", row!._id, fields);
    });
  const stockOf = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      return {
        files: settings.allocatedFilesBytes,
        custody: settings.allocatedCustodyCents,
        allocations: (await ctx.db.query("platformPlanAllocations").collect()).map((row) => [
          row.organizationId,
          row.tier,
        ]),
      };
    });
  const checkoutRow = async (f: Fixture) =>
    (await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).at(-1)!;
  const rechecks = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name.includes("recheckAnnualAdmission") && job.state.kind === "pending",
      ),
    );
  const reviewsOf = async (f: Fixture) =>
    (
      await (
        await person(f.t, f.organizationId, "owner")
      ).query(api.billing.overview, { organizationId: f.organizationId })
    ).reviews.map((row) => [row.source, row.code]);
  async function runUntil(f: Fixture, at: number) {
    vi.advanceTimersByTime(at - Date.now());
    await f.t.finishInProgressScheduledFunctions();
  }
  /** Sells the annual and closes the window before the customer completes the session. */
  async function refusedAnnual(f: Fixture) {
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    await settingsPatch(f, { admissionsUntil: Date.now() });
    const { sub } = subscribeAnnual(f, customer);
    await sync(f);
    return { customer, sub, checkoutId: (await checkoutRow(f))._id };
  }

  it("a conclusão reserva a admissão; fechada a janela e tomado o estoque depois, o dia 1 concede", async () => {
    const f = await fixture();
    expect((await stockOf(f)).allocations).toEqual([]);
    const { customer, sub } = await soldAnnual(f);
    // Reserved when the session completed, as the annual Pix `next` on its confirmation.
    const held = await stockOf(f);
    expect(held.allocations).toEqual([[f.organizationId, "intermediate"]]);
    expect(held.custody).toBeGreaterThan(0);
    expect(await checkoutRow(f)).toMatchObject({
      state: "complete",
      subscriptionId: sub.id,
      admission: { state: "reserved" },
    });
    expect(await rechecks(f)).toMatchObject([{ scheduledTime: NOV - 6 * 3600_000 }]);
    // A replay of the completion, by event or by a later reconciliation, reserves nothing more.
    for (const type of ["checkout.session.completed", "customer.subscription.created"])
      await deliver(f, { type, data: { object: { id: sub.id, customer } } });
    await processEvents(f);
    await sync(f);
    expect(await stockOf(f)).toEqual(held);
    expect(await rechecks(f)).toHaveLength(1);
    expect(await fallbackChecks(f)).toHaveLength(1);
    // The window closes and another organization takes all the stock left.
    await settingsPatch(f, { admissionsUntil: Date.now() + 60_000 });
    const other = await f.org("Outra organização");
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.insert("platformPlanAllocations", {
        organizationId: other,
        tier: "large",
        filesBytes: settings.filesBytes - settings.allocatedFilesBytes,
        databaseBytes: 0,
        custodyCents: settings.custodyCents - settings.allocatedCustodyCents,
        freeMonthlyCents: 0,
        updatedAt: Date.now(),
      });
      await ctx.db.patch("platformPlanSettings", settings._id, {
        allocatedFilesBytes: settings.filesBytes,
        allocatedCustodyCents: settings.custodyCents,
      });
    });
    // The recheck before the anchor finds the reservation held: nothing is cancelled.
    await runUntil(f, NOV - 5 * 3600_000);
    expect(await rechecks(f)).toEqual([]);
    expect(sub.status).toBe("active");
    expect((await checkoutRow(f)).admission).toMatchObject({ state: "reserved" });
    vi.setSystemTime(NOV + 3600_000);
    const first = firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ invoiceId: first.id, state: "applied" }]);
    expect(await terms(f)).toMatchObject([{ state: "active", tier: "intermediate" }]);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: termEndsAt(NOV) });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toEqual([]);
    expect(await reviewsOf(f)).toEqual([]);
  });

  it("recusada na conclusão: nada é reservado, a assinatura é cancelada antes da âncora e o console mostra a recusa", async () => {
    const f = await fixture();
    const { sub, checkoutId } = await refusedAnnual(f);
    expect(await checkoutRow(f)).toMatchObject({
      state: "complete",
      subscriptionId: sub.id,
      admission: { state: "refused", code: "PLAN_UNAVAILABLE", stop: "pending" },
    });
    expect((await stockOf(f)).allocations).toEqual([]);
    expect(await rechecks(f)).toEqual([]);
    // The cancellation runs at once, long before the anchor.
    await runUntil(f, Date.now() + 1);
    expect(sub.status).toBe("canceled");
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
    expect((await checkoutRow(f)).admission).toMatchObject({ state: "refused", stop: "done" });
    // Nothing renews any more.
    expect(await f.billing()).toMatchObject({ account: { subscription: null } });
    expect(await reviewsOf(f)).toEqual([["checkout", "PLAN_UNAVAILABLE"]]);
    // Replays cancel nothing more and change nothing.
    await f.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: f.organizationId,
      checkoutId,
      attempt: 0,
    });
    await sync(f);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
    expect((await checkoutRow(f)).admission).toMatchObject({ code: "PLAN_UNAVAILABLE" });
    // Stripe charges nothing on the 1st; the fallback check finds nothing to weigh.
    await runUntil(f, NOV + 3 * 3600_000);
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
    // Shown through the first month, then gone.
    expect(await reviewsOf(f)).toEqual([["checkout", "PLAN_UNAVAILABLE"]]);
    vi.setSystemTime(DEC);
    expect(await reviewsOf(f)).toEqual([]);
  });

  it.each([
    ["o catálogo desligado", "PLANS_DISABLED"],
    ["o uso acima do plano", "QUOTA_EXCEEDED"],
  ] as const)(
    "reconferida antes da âncora, %s cancela a assinatura sem cobrança",
    async (_, denial) => {
      const f = await fixture();
      const { sub } = await soldAnnual(f);
      // `plans:configure` refuses turning the catalog off; only a direct change does it. The
      // usage outgrows the tier only under a larger plan in force, which the guards follow.
      if (denial === "PLANS_DISABLED") await settingsPatch(f, { enabled: false });
      else
        await f.t.run((ctx) => ctx.db.patch("organizations", f.organizationId, { memberCount: 6 }));
      await runUntil(f, NOV - 6 * 3600_000);
      expect((await checkoutRow(f)).admission).toMatchObject({
        state: "refused",
        code: denial,
        stop: "pending",
      });
      await runUntil(f, Date.now() + 1);
      expect(sub.status).toBe("canceled");
      expect(Date.now()).toBeLessThan(NOV);
      expect(await reviewsOf(f)).toEqual([["checkout", denial]]);
    },
  );

  it("o cancelamento que falha é repetido; esgotado ou chegada a âncora, fica para uma pessoa", async () => {
    const f = await fixture();
    const { sub } = await refusedAnnual(f);
    // One failure: the retry 15 minutes later cancels it.
    f.fake.state.failNext = 1;
    await runUntil(f, Date.now() + 1);
    expect(sub.status).toBe("active");
    expect((await checkoutRow(f)).admission).toMatchObject({ stop: "pending" });
    await runUntil(f, Date.now() + 15 * 60_000);
    expect(sub.status).toBe("canceled");
    expect((await checkoutRow(f)).admission).toMatchObject({ stop: "done" });

    // Stripe stays down: the last retry flags it for a person.
    vi.setSystemTime(OCT);
    const g = await fixture();
    const { sub: gSub, checkoutId: gCheckout } = await refusedAnnual(g);
    g.fake.state.failNext = 1000;
    await g.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: g.organizationId,
      checkoutId: gCheckout,
      attempt: 5,
    });
    expect((await checkoutRow(g)).admission).toMatchObject({ stop: "failed" });
    g.fake.state.failNext = 0;
    expect(await reviewsOf(g)).toEqual([["checkout", "SUBSCRIPTION_STOP_FAILED"]]);
    // The operator runs it again from the start before the anchor: cancelled, flag gone.
    await g.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: g.organizationId,
      checkoutId: gCheckout,
      attempt: 0,
    });
    expect(gSub.status).toBe("canceled");
    expect(await reviewsOf(g)).toEqual([["checkout", "PLAN_UNAVAILABLE"]]);

    // From the anchor on Stripe may have charged: nothing is cancelled automatically.
    vi.setSystemTime(OCT);
    const h = await fixture();
    const { sub: hSub, checkoutId: hCheckout } = await refusedAnnual(h);
    vi.setSystemTime(NOV);
    await h.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: h.organizationId,
      checkoutId: hCheckout,
      attempt: 0,
    });
    expect(hSub.status).toBe("active");
    expect(h.fake.sent(`/v1/subscriptions/${hSub.id}`, "DELETE")).toEqual([]);
    expect(await reviewsOf(h)).toEqual([["checkout", "SUBSCRIPTION_STOP_FAILED"]]);
    // A person settles it in Stripe and marks it.
    await h.t.mutation(internal.billing.resolveReview, {
      checkoutId: hCheckout,
      actor: "operador-sintetico",
    });
    expect(await reviewsOf(h)).toEqual([]);
  });

  it("um cancelamento feito não volta a falhar quando a conferência seguinte falha na última tentativa", async () => {
    const f = await fixture();
    const { sub, checkoutId } = await refusedAnnual(f);
    // The DELETE goes through; the read-back that follows it times out.
    f.fake.state.failPaths = ["/v1/prices"];
    await f.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: f.organizationId,
      checkoutId,
      attempt: 5,
    });
    expect(sub.status).toBe("canceled");
    expect((await checkoutRow(f)).admission).toMatchObject({ stop: "done" });
    // A late failure never reopens it.
    await f.t.mutation(internal.billing.markAnnualStop, { checkoutId, stop: "failed" });
    expect((await checkoutRow(f)).admission).toMatchObject({ stop: "done" });
    f.fake.state.failPaths = [];
    expect(await reviewsOf(f)).toEqual([["checkout", "PLAN_UNAVAILABLE"]]);
  });

  it("uma assinatura recusada que comprou um termo não é cancelada nem pede cancelamento", async () => {
    const f = await fixture();
    const { sub, checkoutId } = await refusedAnnual(f);
    f.fake.state.failNext = 1000;
    await f.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: f.organizationId,
      checkoutId,
      attempt: 5,
    });
    f.fake.state.failNext = 0;
    expect(await reviewsOf(f)).toEqual([["checkout", "SUBSCRIPTION_STOP_FAILED"]]);
    // The charge got through and became a term: the subscription now renews it.
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: NOV,
        endsAt: termEndsAt(NOV),
        source: "stripe",
        references: ["in_refused_became_term"],
        stripeSubscriptionId: sub.id,
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
        state: "scheduled",
      }),
    );
    expect(await reviewsOf(f)).toEqual([]);
    await f.t.action(internal.billing.stopRefusedAnnual, {
      organizationId: f.organizationId,
      checkoutId,
      attempt: 0,
    });
    expect(sub.status).toBe("active");
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toEqual([]);
  });

  it("uma organização encerrada antes da conclusão não reserva, e a recusa não cancela de novo", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    const slug = (await f.t.run((ctx) => ctx.db.get("organizations", f.organizationId)))!.slug;
    expect(
      await code(
        f.owner.mutation(api.organizationClosure.close, {
          organizationId: f.organizationId,
          confirmation: slug,
        }),
      ),
    ).toBe("OK");
    const { sub } = subscribeAnnual(f, customer);
    await sync(f);
    expect((await checkoutRow(f)).admission).toMatchObject({
      state: "refused",
      code: "ORGANIZATION_CLOSED",
    });
    expect((await stockOf(f)).allocations).toEqual([]);
    await runUntil(f, Date.now() + 1);
    expect(sub.status).toBe("canceled");
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toHaveLength(1);
  });

  it("a recusa some quando um Checkout anual seguinte é reservado", async () => {
    const f = await fixture();
    await refusedAnnual(f);
    await runUntil(f, Date.now() + 1);
    expect(await reviewsOf(f)).toEqual([["checkout", "PLAN_UNAVAILABLE"]]);
    // The window opens again and the customer buys the annual once more.
    await settingsPatch(f, { admissionsUntil: Date.UTC(2027, 11, 31) });
    await annualCheckout(f, { key: "annual-card-again" });
    subscribeAnnual(f, await customerOf(f));
    await sync(f);
    expect(await checkoutRow(f)).toMatchObject({ admission: { state: "reserved" } });
    expect(await reviewsOf(f)).toEqual([]);
  });

  it("conclusão lida depois da âncora, na mesma conferência da cobrança: concedida, reserva sem reconferência", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    vi.setSystemTime(NOV + 3600_000);
    const { sub } = subscribeAnnual(f, customer);
    const first = firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ invoiceId: first.id, state: "applied" }]);
    expect(await terms(f)).toMatchObject([{ state: "active", stripeSubscriptionId: sub.id }]);
    expect(await checkoutRow(f)).toMatchObject({ admission: { state: "reserved" } });
    expect(await rechecks(f)).toEqual([]);
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toEqual([]);
  });

  it("conclusão lida depois da âncora com a cobrança bloqueada: nada é cancelado, fica para uma pessoa", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    await settingsPatch(f, { admissionsUntil: NOV - 1 });
    vi.setSystemTime(NOV + 3600_000);
    const { sub } = subscribeAnnual(f, customer);
    firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    await sync(f);
    expect(await grants(f)).toMatchObject([{ state: "blocked", code: "PLAN_UNAVAILABLE" }]);
    expect((await checkoutRow(f)).admission).toMatchObject({
      state: "refused",
      code: "PLAN_UNAVAILABLE",
    });
    await runUntil(f, Date.now() + 1);
    expect(sub.status).toBe("active");
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toEqual([]);
    expect((await checkoutRow(f)).admission).toMatchObject({ stop: "failed" });
    expect((await reviewsOf(f)).toSorted((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      ["checkout", "SUBSCRIPTION_STOP_FAILED"],
      ["grant", "PLAN_UNAVAILABLE"],
    ]);
    // `billing:resolveReview` takes exactly one pending item, a refused one, and an actor.
    const checkoutId = (await checkoutRow(f))._id;
    const grantId = (await grants(f))[0]!._id;
    for (const args of [
      { checkoutId, grantId, actor: "operador-sintetico" },
      { checkoutId, actor: " " },
      { actor: "operador-sintetico" },
    ])
      expect(await code(f.t.mutation(internal.billing.resolveReview, args))).toBe(
        "INVALID_REQUEST",
      );
    await f.t.mutation(internal.billing.resolveReview, { checkoutId, actor: "operador-sintetico" });
    expect(await reviewsOf(f)).toEqual([["grant", "PLAN_UNAVAILABLE"]]);
    const g = await fixture();
    await soldAnnual(g);
    expect(
      await code(
        g.t.mutation(internal.billing.resolveReview, {
          checkoutId: (await checkoutRow(g))._id,
          actor: "operador-sintetico",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("concluída a menos de seis horas da âncora, não agenda a reconferência", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    const customer = await customerOf(f);
    vi.setSystemTime(NOV - 3 * 3600_000);
    subscribeAnnual(f, customer);
    await sync(f);
    expect(await checkoutRow(f)).toMatchObject({ admission: { state: "reserved" } });
    expect(await rechecks(f)).toEqual([]);
    expect(await fallbackChecks(f)).toHaveLength(1);
  });

  it("a reconferência não faz nada depois de “Não renovar” ou do encerramento", async () => {
    const f = await fixture();
    const { sub } = await soldAnnual(f);
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    await settingsPatch(f, { enabled: false });
    await runUntil(f, NOV - 5 * 3600_000);
    expect((await checkoutRow(f)).admission).toMatchObject({ state: "reserved" });
    expect(f.fake.sent(`/v1/subscriptions/${sub.id}`, "DELETE")).toEqual([]);
    expect(await reviewsOf(f)).toEqual([]);

    vi.setSystemTime(OCT);
    const g = await fixture();
    const { sub: gSub } = await soldAnnual(g);
    const slug = (await g.t.run((ctx) => ctx.db.get("organizations", g.organizationId)))!.slug;
    await g.owner.mutation(api.organizationClosure.close, {
      organizationId: g.organizationId,
      confirmation: slug,
    });
    await g.t.action(internal.billing.stopForClosure, {
      organizationId: g.organizationId,
      attempt: 0,
    });
    expect(gSub.status).toBe("canceled");
    await runUntil(g, NOV - 5 * 3600_000);
    expect((await checkoutRow(g)).admission).toMatchObject({ state: "reserved" });
    // Only the closure's own DELETE; no refusal to show (a closed organization reads nothing).
    expect(g.fake.sent(`/v1/subscriptions/${gSub.id}`, "DELETE")).toHaveLength(1);
  });

  it("o Checkout mensal concluído não reserva nem agenda a reconferência", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    f.fake.subscribe(customer, "intermediate", NOV);
    await sync(f);
    const row = await checkoutRow(f);
    expect(row).toMatchObject({ state: "complete" });
    expect(row.admission).toBeUndefined();
    expect(row.subscriptionId).toBeUndefined();
    expect((await stockOf(f)).allocations).toEqual([]);
    expect(await rechecks(f)).toEqual([]);
  });

  it("a visão do console diz se o anual está à venda e se a assinatura já comprou um termo", async () => {
    const f = await fixture();
    const view = async () =>
      (await person(f.t, f.organizationId, "owner")).query(api.billing.overview, {
        organizationId: f.organizationId,
      });
    expect(await view()).toMatchObject({
      annualEnabled: false,
      subscriptionTerm: false,
      annualBlocked: false,
    });
    const { customer, sub } = await soldAnnual(f);
    // Sold and not charged yet: cancelling gives up a year never paid.
    expect(await view()).toMatchObject({ annualEnabled: true, subscriptionTerm: false });
    vi.setSystemTime(NOV + 3600_000);
    firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    await sync(f);
    expect(await terms(f)).toMatchObject([{ state: "active", stripeSubscriptionId: sub.id }]);
    // The term holds a new annual on the card until its last month.
    expect(await view()).toMatchObject({
      annualEnabled: true,
      subscriptionTerm: true,
      annualBlocked: true,
    });
    vi.setSystemTime(Date.UTC(2027, 9, 10, 12));
    expect((await view()).annualBlocked).toBe(false);
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await view()).toMatchObject({ annualEnabled: false, subscriptionTerm: true });
  });

  it("à espera da âncora, o Pix e o encerramento pelo operador são recusados; o do dono cancela a assinatura", async () => {
    const f = await fixture();
    const { sub } = await soldAnnual(f);
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "pix-while-annual-waits",
        }),
      ),
    ).toBe("PAYMENT_METHOD_CARD");
    expect(
      await code(
        f.t.mutation(internal.organizationClosure.closeByOperator, {
          organizationId: f.organizationId,
          actor: "operador-ficticio",
          reason: "Encerramento sintético do teste",
        }),
      ),
    ).toBe("PAID_PLAN");
    // No term exists yet, so the owner may close; the closure cancels before anything is charged.
    const slug = (await f.t.run((ctx) => ctx.db.get("organizations", f.organizationId)))!.slug;
    expect(
      await code(
        f.owner.mutation(api.organizationClosure.close, {
          organizationId: f.organizationId,
          confirmation: slug,
        }),
      ),
    ).toBe("OK");
    await f.t.action(internal.billing.stopForClosure, {
      organizationId: f.organizationId,
      attempt: 0,
    });
    expect(sub.status).toBe("canceled");
    expect(await terms(f)).toEqual([]);
  });

  it("“Não renovar” antes da âncora: nenhum termo, e o Pix volta a ser aceito", async () => {
    const f = await fixture();
    const { sub } = await soldAnnual(f);
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(sub.cancel_at_period_end).toBe(true);
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "pix-after-annual-cancel",
        }),
      ),
    ).toBe("OK");
    // Stripe ends the subscription at the anchor without charging; the fallback check finds nothing.
    vi.advanceTimersByTime(NOV + 3 * 3600_000 - Date.now());
    sub.status = "canceled";
    await f.t.finishInProgressScheduledFunctions();
    expect(await grants(f)).toEqual([]);
    expect(await terms(f)).toEqual([]);
  });

  it("uma sessão anual que expira não agenda a conferência da âncora", async () => {
    const f = await fixture();
    await annualOn(f);
    await annualCheckout(f);
    for (const session of f.fake.state.sessions.values()) session.status = "expired";
    await sync(f);
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").collect())).toMatchObject([
      { cycle: "annual", state: "expired" },
    ]);
    expect(await fallbackChecks(f)).toEqual([]);
    // And the completed one schedules exactly one.
    const g = await fixture();
    await soldAnnual(g);
    expect(await fallbackChecks(g)).toHaveLength(1);
  });

  it("um termo Pix que termina na âncora não impede o anual no cartão, que o renova sem intervalo", async () => {
    const f = await fixture();
    const PIX_FIRST = Date.UTC(2025, 10, 1);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: PIX_FIRST,
        endsAt: termEndsAt(PIX_FIRST),
        source: "pix",
        references: ["pix-annual-ending"],
        paidCents: 149000,
        purchasedAt: PIX_FIRST,
        segments: [],
        state: "active",
      }),
    );
    expect(termEndsAt(PIX_FIRST)).toBe(NOV);
    // A monthly card would renew into the term's months; the annual starts when it ends.
    expect(await code(startCard(f))).toBe("ANNUAL_TERM_ACTIVE");
    const { customer, sub } = await soldAnnual(f);
    vi.advanceTimersByTime(NOV + 3600_000 - Date.now());
    const first = firstCharge(f, customer, sub.id, { price: "price_int_year", amount: 149000 });
    vi.advanceTimersByTime(2 * 3600_000);
    await f.t.finishInProgressScheduledFunctions();
    expect(await grants(f)).toMatchObject([{ invoiceId: first.id, state: "applied" }]);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: termEndsAt(NOV) });
  });
});
