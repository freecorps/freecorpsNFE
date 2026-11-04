import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  enablePix,
  platformTest,
  person,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";
import {
  billingConfig,
  invoiceGrant,
  readAnnualPrices,
  readBillingEnvelope,
  readCatalogPrices,
  readInvoice,
  readSubscriptions,
  type CatalogPrices,
} from "./lib/billingStripe";
import { addMonths, termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan } from "./lib/planCore";
import { insertTerm } from "./lib/planTerms";
import { reserveUsage } from "./lib/usageCore";

/**
 * Card subscriptions through Stripe (#556), proven against a synthetic Stripe API answered by a
 * stubbed `fetch` and synthetic signed events. Nothing here reaches Stripe, test mode or live.
 */
const OCT = Date.UTC(2026, 9, 10, 12);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
/** Anniversaries of a monthly card signed at `OCT`, 10/10 at 12:00 UTC (ADR 0012, slice 2a). */
const NOV_10 = Date.UTC(2026, 10, 10, 12);
const DEC_10 = Date.UTC(2026, 11, 10, 12);
const JAN_10 = Date.UTC(2027, 0, 10, 12);
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
    /** Subscriptions the list leaves out, as one created while it is read; found by id. */
    unlisted: [] as string[],
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
        data: state.subscriptions.filter(
          (x) => x.customer === params.get("customer") && !state.unlisted.includes(String(x.id)),
        ),
      });
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (sub) {
      const found = state.subscriptions.find((x) => x.id === sub[1]);
      if (!found) return reply({ error: { code: "resource_missing" } }, 404);
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
    /**
     * Paying the open Checkout creates the subscription; the session is then complete. Without
     * an anchor, as the monthly Checkout since slice 2a of ADR 0012, Stripe anchors it at the
     * signing, truncated to the second, and its first period ends a month later.
     */
    subscribe(
      customer: string,
      tier: "intermediate" | "large",
      periodEnd?: number,
      anchor = s(Date.now()) * 1000,
    ) {
      const id = `sub_${state.subscriptions.length + 1}`;
      for (const session of state.sessions.values())
        if (session.status === "open")
          Object.assign(session, { status: "complete", subscription: id });
      const subscription = {
        id,
        customer,
        status: "active",
        created: s(Date.now()),
        billing_cycle_anchor: s(anchor),
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: "si_1",
              price: tier === "large" ? "price_large" : "price_int",
              current_period_end: s(periodEnd ?? addMonths(anchor, 1)),
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
/**
 * The first invoice of a monthly Checkout (ADR 0012, slice 2a): the whole month charged at the
 * signing, the recurring line from `start`, the subscription's anchor, to the same day and time
 * next month. The marks carry no period: the month starts when it is paid.
 */
const startInvoice = (
  customer: string,
  subscription: string,
  organizationId: string,
  amount: number,
  tier = "intermediate",
  start = s(Date.now()) * 1000,
) => ({
  customer,
  amount_paid: amount,
  amount_due: amount,
  billing_reason: "subscription_create",
  parent: {
    type: "subscription_details",
    subscription_details: {
      subscription,
      metadata: { organizationId, kind: "start", tier, grantCents: String(amount) },
    },
  },
  lines: {
    data: [
      {
        amount,
        period: { start: s(start), end: s(addMonths(start, 1)) },
        pricing: {
          type: "price_details",
          price_details: {
            price: tier === "large" ? "price_large" : "price_int",
            product: tier === "large" ? "prod_large" : "prod_int",
          },
        },
      },
    ],
  },
});
/** A monthly renewal: the line runs from `start` to `end`, by default the next anniversary. */
const cycleInvoice = (
  customer: string,
  subscription: string,
  start: number,
  fields: Json = {},
  end = addMonths(start, 1),
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
        period: { start: s(start), end: s(end) },
        pricing: {
          type: "price_details",
          price_details: { price: "price_int", product: "prod_int" },
        },
      },
    ],
  },
  ...fields,
});
const yearlyPriceOf = (tier: string) => (tier === "large" ? "price_large_year" : "price_int_year");
/**
 * The first invoice of an annual Checkout (ADR 0012, slice 2b): the whole year charged at the
 * signing, the yearly line from `start`, the subscription's anchor, to the same day and time a
 * year later. The marks carry no period: the term starts when it is paid.
 */
const annualStartInvoice = (
  customer: string,
  subscription: string,
  organizationId: string,
  {
    tier = "intermediate",
    amount = tier === "large" ? 499000 : 149000,
    start = s(Date.now()) * 1000,
    end = termEndsAt(start),
    paidAt = Date.now(),
  }: { tier?: string; amount?: number; start?: number; end?: number; paidAt?: number } = {},
) => ({
  customer,
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
        grantCents: String(amount),
      },
    },
  },
  lines: {
    data: [
      {
        amount,
        period: { start: s(start), end: s(end) },
        pricing: { type: "price_details", price_details: { price: yearlyPriceOf(tier) } },
      },
    ],
  },
});
/** A yearly renewal: the line runs from `start`, an anniversary of `anchor`, for 12 months of it. */
const annualCycleInvoice = (
  customer: string,
  subscription: string,
  start: number,
  { anchor = start, amount = 149000, price: priceId = "price_int_year", end = 0 } = {},
) => ({
  ...cycleInvoice(customer, subscription, start, {
    amount_paid: amount,
    amount_due: amount,
    status_transitions: { paid_at: s(Date.now()) },
  }),
  lines: {
    data: [
      {
        amount,
        period: { start: s(start), end: s(end || termEndsAt(start, anchor)) },
        pricing: { type: "price_details", price_details: { price: priceId } },
      },
    ],
  },
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
/** The refusal's data: its code and, for a sale that waits, when it becomes available. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: unknown }) => error.data,
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
  it("recupera resposta perdida na criação da sessão sem duplicar a sessão", async () => {
    const f = await fixture();
    const args = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      key: "retry-monthly",
    };
    f.fake.state.loseResponseOnce = "/v1/checkout/sessions";
    expect(await code(f.owner.action(api.billing.checkout, args))).toBe("BILLING_UNAVAILABLE");
    expect(await f.t.run((ctx) => ctx.db.query("billingCheckouts").first())).toMatchObject({
      state: "creating",
    });
    const result = await f.owner.action(api.billing.checkout, args);
    expect(result.url).toContain("checkout.stripe.com");
    expect(f.fake.state.sessions.size).toBe(1);
    const calls = f.fake.sent("/v1/checkout/sessions");
    expect(new Set(calls.map((call) => call.key)).size).toBe(1);
    expect(new Set(calls.map((call) => call.params.toString())).size).toBe(1);
    expect(await f.plan()).toBeNull();
  });

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

  it("o mensal no cartão espera o fim do Pix, mesmo num plano maior, e então cobra o mês inteiro", async () => {
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
    // One paid plan at a time (ADR 0012): the Pix month runs from 10/10 12:00 to 10/11 12:00 UTC.
    const pixEnd = Date.UTC(2026, 10, 10, 12);
    expect(
      await refusal(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "large-during-pix",
        }),
      ),
    ).toEqual({ code: "PAYMENT_METHOD_PIX", availableAt: pixEnd });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(0);
    vi.setSystemTime(pixEnd);
    const owner = await person(f.t, f.organizationId, "owner");
    await owner.action(api.billing.checkout, {
      organizationId: f.organizationId,
      tier: "large",
      key: "large-after-pix",
    });
    // The whole month at the recurring price, charged at the signing (ADR 0012, slice 2a).
    const sent = f.fake.sent("/v1/checkout/sessions")[0]!.params;
    expect(Object.fromEntries(sent)).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_large",
      "subscription_data[metadata][grantCents]": "49900",
    });
    expect(sent.has("line_items[1][price_data][unit_amount]")).toBe(false);
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate" });
  });

  it("contrata pelo Checkout, só ativa com a fatura paga e não repete o efeito", async () => {
    const f = await fixture();
    const { url, customer } = await startCard(f);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [created] = f.fake.sent("/v1/checkout/sessions");
    // ADR 0012, slice 2a: the recurring price alone, charged at the signing, which Stripe takes
    // as the anchor. No anchor on the 1st, one-off item, coupon or proration; the marks carry no
    // period, since the month starts when it is paid. The link lasts a day.
    expect(Object.fromEntries(created!.params)).toEqual({
      mode: "subscription",
      customer,
      client_reference_id: f.organizationId,
      locale: "pt-BR",
      "payment_method_types[0]": "card",
      success_url: expect.stringContaining("cobranca=retorno"),
      cancel_url: expect.stringContaining("cobranca=cancelado"),
      expires_at: String(s(OCT + 24 * 3600_000)),
      "line_items[0][price]": "price_int",
      "line_items[0][quantity]": "1",
      "metadata[organizationId]": f.organizationId,
      "metadata[kind]": "start",
      "metadata[tier]": "intermediate",
      "metadata[grantCents]": "14900",
      "subscription_data[metadata][organizationId]": f.organizationId,
      "subscription_data[metadata][kind]": "start",
      "subscription_data[metadata][tier]": "intermediate",
      "subscription_data[metadata][grantCents]": "14900",
    });
    expect(f.fake.state.calls.some((call) => call.path === "/v1/coupons")).toBe(false);
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
    const sub = f.fake.subscribe(customer, "intermediate");
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
    // From the signing, 10/10 at 12:00 UTC, to the same day and time next month, with that anchor.
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: OCT,
      endsAt: NOV_10,
      periodAnchor: OCT,
      version: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.query("billingEvents").collect())).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).toMatchObject([
      { state: "applied", invoiceId: "in_1", period: "2026-10-10T12:00:00.000Z" },
    ]);
    expect(await f.billing()).toMatchObject({
      checkout: null,
      account: {
        renewalTier: "intermediate",
        subscription: { tier: "intermediate", periodEnd: NOV_10, cancelAtPeriodEnd: false },
      },
    });
  });

  it("renova no aniversário, ignora fatura antiga atrasada, e sem carência vence até o pagamento ser recuperado", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    (sub.items.data[0] as Json).current_period_end = s(DEC_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10, periodAnchor: OCT, version: 2 });
    // A late, repeated event for October's invoice changes nothing.
    await deliver(f, { type: "invoice.paid", data: { object: { id: "in_1", customer } } });
    await processEvents(f);
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10, version: 2 });
    // December's charge is declined: the plan ends with the month paid, the documents stay.
    vi.setSystemTime(DEC_10 + 3600_000);
    const declined = f.fake.invoice(
      cycleInvoice(customer, sub.id, DEC_10, {
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
    expect(await f.plan()).toMatchObject({ endsAt: DEC_10 });
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
    // Recovered 4 days later: the whole month, as Pix, still on the anchor's anniversaries.
    vi.setSystemTime(DEC_10 + 4 * 86400_000);
    Object.assign(declined, { status: "paid", amount_paid: 14900 });
    sub.status = "active";
    (sub.items.data[0] as Json).current_period_end = s(JAN_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ endsAt: JAN_10, periodAnchor: OCT, version: 3 });
    expect((await account())?.openInvoice).toBeUndefined();
  });

  it("fechada a janela de admissão, quem já tem o plano renova; plano novo e upgrade são recusados (#549)", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV_10 });
    // The window closes before the renewal on the anniversary.
    await f.t.run(async (ctx) => {
      const settings = await ctx.db.query("platformPlanSettings").first();
      await ctx.db.patch("platformPlanSettings", settings!._id, { admissionsUntil: NOV - 1 });
    });
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
    (sub.items.data[0] as Json).current_period_end = s(DEC_10);
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      endsAt: DEC_10,
      version: 2,
    });
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
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    // Mid-period: the full difference now, for the same period, which keeps its anchor and end.
    vi.setSystemTime(Date.UTC(2026, 9, 25, 9));
    const owner = await person(f.t, f.organizationId, "owner");
    await owner.action(api.billing.checkout, {
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
      "invoice_creation[invoice_data][metadata][period]": "2026-10-10T12:00:00.000Z",
      expires_at: String(s(Date.UTC(2026, 9, 26, 9))),
    });
    expect(
      (await owner.query(api.billing.overview, { organizationId: f.organizationId })).checkout,
    ).toMatchObject({
      kind: "upgrade",
      periodStartsAt: OCT,
      grantCents: 35000,
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
        period: "2026-10-10T12:00:00.000Z",
        grantCents: "35000",
      },
    });
    for (const session of f.fake.state.sessions.values()) session.status = "complete";
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: NOV_10,
      periodAnchor: OCT,
      version: 2,
    });
    // The subscription now renews at Grande, without proration, on the same anniversary.
    expect(Object.fromEntries(f.fake.sent("/v1/subscriptions/sub_1").at(-1)!.params)).toEqual({
      "items[0][id]": "si_1",
      "items[0][price]": "price_large",
      proration_behavior: "none",
      billing_cycle_anchor: "unchanged",
    });
    // Downgrade: next renewal at Intermediário, the period paid keeps Grande.
    expect(
      await code(
        owner.action(api.billing.changeRenewal, {
          organizationId: f.organizationId,
          change: "large",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "intermediate",
    });
    expect((sub.items.data[0] as Json).price).toBe("price_int");
    expect(await f.plan()).toMatchObject({ catalogTier: "large", version: 2 });
    // Cancel: no renewal, the paid period stays; Pix becomes possible again.
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(sub.cancel_at_period_end).toBe(true);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: NOV_10 });
    expect(
      (await owner.query(api.billing.overview, { organizationId: f.organizationId })).account
        ?.subscription?.cancelAtPeriodEnd,
    ).toBe(true);
    // One paid plan at a time: a new subscription beside the card plan in force waits for its
    // end, with the date; the renewal is "Retomar renovação".
    expect(
      await refusal(
        owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "start-while-cancelling",
        }),
      ),
    ).toEqual({ code: "PLAN_UNAVAILABLE", availableAt: NOV_10 });
    await owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "resume",
    });
    expect(sub.cancel_at_period_end).toBe(false);
  });

  it("o upgrade fecha 45 minutos antes do aniversário e reabre depois da renovação", async () => {
    const f = await fixture();
    const { customer } = await startCard(f);
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    const upgrade = (key: string, owner = f.owner) =>
      owner.action(api.billing.checkout, { organizationId: f.organizationId, tier: "large", key });
    vi.setSystemTime(NOV_10 - 44 * 60_000);
    const late = await person(f.t, f.organizationId, "owner");
    expect(await refusal(upgrade("upgrade-at-the-end", late))).toEqual({
      code: "PERIOD_CLOSING",
      availableAt: NOV_10,
    });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(1);
    // Just before the margin, the session expires before the period ends.
    vi.setSystemTime(NOV_10 - 46 * 60_000);
    await upgrade("upgrade-before-the-end", late);
    expect(f.fake.sent("/v1/checkout/sessions").at(-1)!.params.get("expires_at")).toBe(
      String(s(NOV_10 - 5 * 60_000)),
    );
    await late.action(api.billing.abandonCheckout, { organizationId: f.organizationId });
    // A difference paid after the period turned no longer matches it: a person looks.
    vi.setSystemTime(NOV_10 + 3600_000);
    f.fake.invoice(cycleInvoice(customer, sub.id, NOV_10));
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
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: DEC_10 });
    expect(
      (await f.t.run((ctx) => ctx.db.query("billingGrants").collect())).map((grant) => [
        grant.state,
        grant.code ?? null,
        grant.period,
      ]),
    ).toEqual([
      ["applied", null, "2026-10-10T12:00:00.000Z"],
      ["applied", null, "2026-11-10T12:00:00.000Z"],
      ["blocked", "LATE_PAYMENT", "2026-10-10T12:00:00.000Z"],
    ]);
    // In the next period, the upgrade is sold again, priced on it.
    const next = await person(f.t, f.organizationId, "owner");
    await upgrade("upgrade-next-period", next);
    expect(
      f.fake
        .sent("/v1/checkout/sessions")
        .at(-1)!
        .params.get("invoice_creation[invoice_data][metadata][period]"),
    ).toBe("2026-11-10T12:00:00.000Z");
  });

  it("o mês pago por Pix não abre o cartão: pedido aguardando e plano em vigor recusam o Checkout", async () => {
    const f = await fixture();
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-october",
    });
    const card = (key: string) =>
      f.owner.action(api.billing.checkout, {
        organizationId: f.organizationId,
        tier: "intermediate",
        key,
      });
    expect(await code(card("card-during-pix"))).toBe("PLAN_REQUEST_PENDING");
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 14900,
      paymentReference: "synthetic-pix-ref",
      actor: "operator",
    });
    // The same tier is no longer credited at R$ 0: the card waits for the Pix plan to end.
    expect(await refusal(card("card-after-pix"))).toEqual({
      code: "PAYMENT_METHOD_PIX",
      availableAt: Date.UTC(2026, 10, 10, 12),
    });
    // A renewal already paid by Pix holds the card until the end of the month it bought.
    const renewal = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-renewal",
    });
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: renewal.id,
      amountCents: 14900,
      paymentReference: "synthetic-pix-renewal-ref",
      actor: "operator",
    });
    expect(await refusal(card("card-after-renewal"))).toEqual({
      code: "PAYMENT_METHOD_PIX",
      availableAt: Date.UTC(2026, 11, 10, 12),
    });
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    expect(
      await refusal(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "annual-after-renewal",
          cycle: "annual",
        }),
      ),
    ).toEqual({ code: "PAYMENT_METHOD_PIX", availableAt: Date.UTC(2026, 10, 10, 12) });
    // A renewal whose activation was refused waits for the team until the end of its month.
    await f.t.run((ctx) =>
      ctx.db.patch("platformPlanRequests", renewal.id, { blockedCode: "PLANS_DISABLED" }),
    );
    expect(
      await refusal(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "annual-after-blocked-renewal",
          cycle: "annual",
        }),
      ),
    ).toEqual({ code: "PAYMENT_METHOD_PIX", availableAt: Date.UTC(2026, 11, 10, 12) });
    expect(f.fake.sent("/v1/checkout/sessions")).toHaveLength(0);
    expect(f.fake.sent("/v1/coupons")).toHaveLength(0);
  });

  it("uma linha de tier do catálogo atribuída pelo operador não é tomada por Pix", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      activateCatalogPlan(ctx, f.organizationId, "intermediate", OCT, NOV, 0, "op", "Atribuído"),
    );
    // No Pix confirmation wrote the row: the card is not sent to wait for a Pix plan.
    expect(
      await code(
        f.owner.action(api.billing.checkout, {
          organizationId: f.organizationId,
          tier: "large",
          key: "card-over-assigned",
        }),
      ),
    ).toBe("OK");
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
      (await owner.query(api.billing.overview, { organizationId: f.organizationId })).reviews,
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
      (await owner.query(api.billing.overview, { organizationId: f.organizationId })).reviews,
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
        source: "pix",
        references: ["pix-annual-term-2a"],
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

  it("com um anual agendado, o Pix mensal espera o último mês dele", async () => {
    const f = await fixture();
    await annual(f, f.organizationId, "scheduled", { firstPeriod: NOV });
    // One paid plan at a time (ADR 0012): a month from now would overlap the term; the monthly
    // opens as its renewal, in its last month.
    expect(await refusal(requestPix(f, "pix-before-scheduled"))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: Date.UTC(2027, 9, 1),
    });
    expect(await f.plan()).toBeNull();
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
  ] as const)("com o termo %s, o Pix mensal volta a valer", async (_, state, firstPeriod) => {
    const f = await fixture();
    await annual(f, f.organizationId, state, { firstPeriod });
    const request = await requestPix(f, "pix-after-annual");
    await confirm(f, request.id, "synthetic-pix-after-annual");
    // A month from the confirmation, anchored on it (ADR 0012).
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: OCT,
      periodAnchor: OCT,
      endsAt: Date.UTC(2026, 10, 10, 12),
    });
  });

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
    // One paid plan at a time (ADR 0012): not even a larger tier by the difference.
    expect(await refusal(requestPix(f, "pix-over-rescinded", "large"))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: NOV,
    });
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

  it("no último mês do termo, o Pix mensal é a renovação no fim dele, com a âncora do termo", async () => {
    const f = await fixture();
    // November 2025 to November 2026: October is its last month.
    const anchor = Date.UTC(2025, 10, 1);
    await annual(f, f.organizationId, "active", { firstPeriod: anchor });
    const request = await requestPix(f, "pix-last-month");
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      start: "renewal",
      firstPeriod: NOV,
      anchor,
      // Paid within the month it buys.
      endsAt: DEC,
      amountCents: 14900,
    });
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

  it("o anual por Pix é recusado com Checkout aberto ou cartão que renova", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
    const request = (start: "now" | "renewal", owner = f.owner) =>
      owner.mutation(api.plans.requestPaid, {
        organizationId: f.organizationId,
        tier: "intermediate",
        key: `annual-pix-${start}`,
        cycle: "annual",
        start,
      });
    const refusal = (start: "now" | "renewal") =>
      request(start).then(
        () => "OK",
        (error: { data?: { code?: string; availableAt?: number } }) => error.data,
      );
    const annualPix = (start: "now" | "renewal") => code(request(start));
    const { customer } = await startCard(f);
    expect(await annualPix("now")).toBe("PAYMENT_METHOD_CARD");
    const sub = f.fake.subscribe(customer, "intermediate");
    f.fake.invoice(startInvoice(customer, sub.id, f.organizationId, 14900));
    await f.t.action(internal.billing.sync, { organizationId: f.organizationId });
    // While the card renews, no date is promised.
    expect(await refusal("now")).toEqual({ code: "PAYMENT_METHOD_CARD" });
    expect(await annualPix("renewal")).toBe("PAYMENT_METHOD_CARD");
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
    // One paid plan at a time (ADR 0012): with the renewal cancelled, the card month still runs,
    // and the Pix waits for its end, a new chain then, never a renewal across payment methods.
    await f.owner.action(api.billing.changeRenewal, {
      organizationId: f.organizationId,
      change: "cancel",
    });
    expect(await refusal("renewal")).toEqual({
      code: "PAYMENT_METHOD_CARD",
      availableAt: NOV_10,
    });
    expect(await refusal("now")).toEqual({ code: "PAYMENT_METHOD_CARD", availableAt: NOV_10 });
    vi.setSystemTime(NOV_10);
    expect(await code(request("now", await person(f.t, f.organizationId, "owner")))).toBe("OK");
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

describe("anual por cartão: a fatura vira termo (ADR 0010, decisão 9, e ADR 0012, fatia 2b)", () => {
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
        ).query(api.billing.overview, { organizationId: f.organizationId })
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
        ).query(api.billing.overview, { organizationId: g.organizationId })
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
    // In the card term's last month, a Pix annual waits for the card term to end (ADR 0012, one
    // paid plan at a time): the renewal never crosses payment methods. The first session has
    // expired by then; a manager signs in again.
    vi.setSystemTime(Date.UTC(2027, 8, 15));
    const owner = await person(f.t, f.organizationId, "owner");
    for (const start of ["now", "renewal"] as const)
      expect(
        await owner
          .mutation(api.plans.requestPaid, {
            organizationId: f.organizationId,
            tier: "intermediate",
            key: `pix-annual-after-card-${start}`,
            cycle: "annual",
            start,
          })
          .catch((error: { data?: unknown }) => error.data),
      ).toEqual({ code: "PAYMENT_METHOD_CARD", availableAt: YEAR });
    // A Pix term scheduled after it, as one sold before that rule.
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: YEAR,
        endsAt: termEndsAt(YEAR),
        source: "pix",
        references: ["pix-annual-after-card"],
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
        state: "scheduled",
      }),
    );
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
        ).query(api.billing.overview, { organizationId: f.organizationId }),
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

    it("recusa antes do Stripe: sem termo, termo Pix, Grande já em vigor, anual desligado, Checkout aberto e virada do mês do termo", async () => {
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
          firstPeriod: OCT,
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
      // An open Checkout keeps the Pix away.
      expect(
        await code(
          (await person(f.t, f.organizationId, "owner")).mutation(api.plans.requestPaid, {
            organizationId: f.organizationId,
            tier: "large",
            key: "pix-upgrade-under-card",
            cycle: "annual",
            start: "upgrade",
          }),
        ),
      ).toBe("PAYMENT_METHOD_CARD");
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
        source: "pix",
        references: [`pix-annual-${state}`],
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

  it("recusa com Pix aguardando ou Checkout aberto", async () => {
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
      (await owner.query(api.billing.overview, { organizationId: f.organizationId })).account
        ?.subscription,
    ).toMatchObject({ id: sub.id, annual: true });
  });

  it("sobre o mensal Pix de tier igual, o anual no cartão o substitui na hora; um mensal maior em vigor segura o anual menor com a data", async () => {
    const f = await fixture();
    await annualOn(f);
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "pix-monthly-before-annual",
    });
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 14900,
      paymentReference: "synthetic-pix-monthly-annual",
      actor: "operator",
    });
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
        source: "pix",
        references: ["pix-annual-rescinded"],
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

  it("o anual no cartão espera o fim de um termo Pix, mesmo no último mês dele", async () => {
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
    // A monthly card would renew into the term's months.
    expect(await code(startCard(f))).toBe("ANNUAL_TERM_ACTIVE");
    // October is the Pix term's last month: the card annual, a new chain, waits for its end
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
      ).query(api.billing.overview, {
        organizationId: f.organizationId,
      }),
    ).toMatchObject({ annualBlocked: true });
  });

  it("um termo Pix que termina no meio do mês segura o anual no cartão até o fim dele", async () => {
    const f = await fixture();
    // 15/10/2026 14:30 to 15/10/2027 14:30 UTC.
    const PIX_START = Date.UTC(2026, 9, 15, 14, 30);
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: PIX_START,
        endsAt: termEndsAt(PIX_START),
        source: "pix",
        references: ["pix-annual-mid-month"],
        paidCents: 149000,
        purchasedAt: PIX_START,
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
