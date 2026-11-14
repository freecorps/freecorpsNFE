import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { api, internal } from "../../platform/convex/_generated/api";
import { platformTest, person } from "./platform";
import type { CatalogPrices } from "../../platform/convex/lib/billingStripe";
import { addMonths, termEndsAt } from "../../platform/convex/lib/annualTerms";

/**
 * Fixtures of the card subscription suites through Stripe (#556): a synthetic Stripe API answered
 * by a stubbed `fetch`, synthetic signed events and the invoices Stripe sends. Nothing here reaches
 * Stripe, test mode or live.
 */
export const OCT = Date.UTC(2026, 9, 10, 12);
export const NOV = Date.UTC(2026, 10, 1);
export const DEC = Date.UTC(2026, 11, 1);
/** Anniversaries of a monthly card signed at `OCT`, 10/10 at 12:00 UTC (ADR 0012, slice 2a). */
export const NOV_10 = Date.UTC(2026, 10, 10, 12);
export const DEC_10 = Date.UTC(2026, 11, 10, 12);
export const JAN_10 = Date.UTC(2027, 0, 10, 12);
export const WEBHOOK_SECRET = "whsec_synthetic_billing_only";
export const s = (ms: number) => Math.floor(ms / 1000);
/** The local sandbox of every billing suite, with the clock at `OCT`. */
export const BILLING_ENVIRONMENT = {
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-billing-only",
  now: OCT,
};
/** Synthetic Stripe keys around each test of the calling file. */
export function useStripeKeys() {
  beforeEach(() => {
    vi.stubEnv("STRIPE_BILLING_SECRET_KEY", "rk_test_synthetic0000");
    vi.stubEnv("STRIPE_BILLING_WEBHOOK_SECRET", WEBHOOK_SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());
}

export type Json = Record<string, unknown>;
export const PRICES: CatalogPrices = {
  intermediate: { priceId: "price_int", productId: "prod_int" },
  large: { priceId: "price_large", productId: "prod_large" },
};
export const price = (id: string, lookup: string, amount: number, interval = "month") => ({
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
export const YEARLY_PRICES = [
  price("price_int_year", "fnfe_plan_intermediate_annual_brl", 149000, "year"),
  price("price_large_year", "fnfe_plan_large_annual_brl", 499000, "year"),
];

/** A minimal Stripe: what the platform calls, what it sent, and failures on demand. */
export function fakeStripe() {
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
export const startInvoice = (
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
export const cycleInvoice = (
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
export const yearlyPriceOf = (tier: string) =>
  tier === "large" ? "price_large_year" : "price_int_year";
/**
 * The first invoice of an annual Checkout (ADR 0012, slice 2b): the whole year charged at the
 * signing, the yearly line from `start`, the subscription's anchor, to the same day and time a
 * year later. The marks carry no period: the term starts when it is paid.
 */
export const annualStartInvoice = (
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
export const annualCycleInvoice = (
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

export async function fixture() {
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
  const fake = fakeStripe();
  const plan = () =>
    t.run((ctx) =>
      ctx.db
        .query("usagePlans")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .unique(),
    );
  const billing = () => owner.query(api.billing.overview, { asOf: Date.now(), organizationId });
  // Ids of the events this database receives: the sequence lives in the fixture, not in the module.
  let eventSeq = 0;
  const eventId = () => `evt_${++eventSeq}`;
  return { t, org, organizationId, owner, fake, plan, billing, eventId };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
/** The refusal's data: its code and, for a sale that waits, when it becomes available. */
export const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: unknown }) => error.data,
  );
export function sign(body: string, secret = WEBHOOK_SECRET, at = s(Date.now())) {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}
/** `signature` is the header, or a signer of the exact body sent. */
export async function deliver(
  f: Fixture,
  event: Json,
  signature?: string | ((body: string) => string),
) {
  const body = JSON.stringify({ id: f.eventId(), livemode: false, ...event });
  const header = typeof signature === "function" ? signature(body) : (signature ?? sign(body));
  const response = await f.t.fetch("/v1/billing/stripe/events", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
  return { status: response.status, code: ((await response.json()) as { code: string }).code };
}
/** Runs the processing the webhook scheduled, without advancing to later scheduled work. */
export async function processEvents(f: Fixture) {
  const pending = await f.t.run((ctx) =>
    ctx.db
      .query("billingEvents")
      .collect()
      .then((rows) => rows.filter((row) => row.state === "received")),
  );
  for (const event of pending)
    await f.t.action(internal.billing.processEvent, { eventId: event._id });
}
export async function startCard(f: Fixture, tier: "intermediate" | "large" = "intermediate") {
  const { url } = await f.owner.action(api.billing.checkout, {
    organizationId: f.organizationId,
    tier,
    key: `start-${tier}-key`,
  });
  const customer = (await f.t.run((ctx) => ctx.db.query("billingAccounts").first()))!.customerId;
  return { url, customer };
}
