import { describe, expect, it } from "vite-plus/test";
import {
  ANNUAL_PRICE_LOOKUP_KEYS,
  BILLING_EVENT_TYPES,
  PRICE_LOOKUP_KEYS,
  STRIPE_API_VERSION,
  readAnnualPrices,
  readCatalogPrices,
  readPortalSession,
} from "../platform/convex/lib/billingStripe";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import {
  BILLING_EVENTS,
  CATALOG_PRICES,
  DEFAULT_ENDPOINT,
  STRIPE_API_VERSION as CHECK_API_VERSION,
  checkPortal,
  checkPrices,
  checkWebhook,
  parseArgs,
  readKey,
  report,
} from "./lib/billing-stripe-check.mjs";

const prices = (patch: (key: string) => Record<string, unknown> = () => ({})) => ({
  data: Object.entries(CATALOG_PRICES).map(([key, { interval, cents }], i) => ({
    id: `price_${i}`,
    product: `prod_${i}`,
    lookup_key: key,
    active: true,
    livemode: false,
    currency: "brl",
    type: "recurring",
    unit_amount: cents,
    recurring: { interval, interval_count: 1, usage_type: "licensed" },
    ...patch(key),
  })),
});
const configuration = (features: Record<string, unknown> = {}, rest = {}) => ({
  is_default: true,
  active: true,
  livemode: false,
  features: {
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    ...features,
  },
  ...rest,
});
const hook = (rest = {}) => ({
  url: DEFAULT_ENDPOINT,
  status: "enabled",
  livemode: false,
  enabled_events: [...BILLING_EVENTS],
  ...rest,
});
/** O que a plataforma aceita: os dois mensais e os dois anuais. */
const platformAccepts = (body: { data: unknown[] }) =>
  readCatalogPrices(body, false) !== null &&
  Object.keys(readAnnualPrices(body, false)).length === 2;

describe("paridade com a plataforma", () => {
  it("usa as mesmas lookup keys, valores, eventos e versão da API", () => {
    expect(CATALOG_PRICES).toEqual({
      [PRICE_LOOKUP_KEYS.intermediate]: {
        interval: "month",
        cents: PLATFORM_PLANS.intermediate.monthlyCents,
      },
      [PRICE_LOOKUP_KEYS.large]: { interval: "month", cents: PLATFORM_PLANS.large.monthlyCents },
      [ANNUAL_PRICE_LOOKUP_KEYS.intermediate]: {
        interval: "year",
        cents: PLATFORM_PLANS.intermediate.annualCents,
      },
      [ANNUAL_PRICE_LOOKUP_KEYS.large]: {
        interval: "year",
        cents: PLATFORM_PLANS.large.annualCents,
      },
    });
    expect(BILLING_EVENTS).toEqual([...BILLING_EVENT_TYPES]);
    expect(CHECK_API_VERSION).toBe(STRIPE_API_VERSION);
  });

  it("aprova e recusa os mesmos preços que a plataforma", () => {
    expect(checkPrices(prices(), false).ok).toBe(true);
    expect(platformAccepts(prices())).toBe(true);
    const target = ANNUAL_PRICE_LOOKUP_KEYS.large;
    for (const change of [
      { active: false },
      { livemode: true },
      { currency: "usd" },
      { type: "one_time" },
      { unit_amount: 1 },
      { recurring: { interval: "month", interval_count: 1 } },
      { recurring: { interval: "year", interval_count: 2 } },
      { recurring: { interval: "year", interval_count: 1, usage_type: "metered" } },
      { lookup_key: "outra" },
    ]) {
      const body = prices((key) => (key === target ? change : {}));
      expect(checkPrices(body, false).ok, JSON.stringify(change)).toBe(false);
      expect(platformAccepts(body), JSON.stringify(change)).toBe(false);
    }
  });

  it("aprova e recusa o mesmo portal que readPortalSession", () => {
    const session = (config: Record<string, unknown>) => ({
      customer: "cus_1",
      livemode: false,
      url: "https://billing.stripe.com/p/session",
      configuration: config,
    });
    expect(checkPortal({ data: [configuration()] }, false).ok).toBe(true);
    expect(readPortalSession(session(configuration()), "cus_1", false)).toMatch(/^https:/);
    for (const [features, rest] of [
      [{ subscription_cancel: { enabled: true } }, {}],
      [{ subscription_update: { enabled: true } }, {}],
      [{ invoice_history: { enabled: false } }, {}],
      [{ payment_method_update: { enabled: false } }, {}],
      [{}, { active: false }],
      [{}, { livemode: true }],
    ] as const) {
      const config = configuration(features, rest);
      expect(checkPortal({ data: [config] }, false).ok).toBe(false);
      expect(() => readPortalSession(session(config), "cus_1", false)).toThrow();
    }
  });
});

describe("endpoint de eventos", () => {
  it("exige um único endpoint ativo, no modo da chave, com todos os eventos", () => {
    const check = (data: unknown[]) => checkWebhook({ data }, DEFAULT_ENDPOINT, false);
    expect(check([hook()]).ok).toBe(true);
    expect(check([hook({ enabled_events: ["*"] })]).ok).toBe(true);
    expect(check([hook({ url: "https://outro/v1/billing/stripe/events" })]).ok).toBe(false);
    expect(check([hook(), hook()]).problems).toEqual(["mais de um endpoint na URL"]);
    expect(check([hook({ status: "disabled" })]).ok).toBe(false);
    expect(check([hook({ livemode: true })]).ok).toBe(false);
    expect(check([hook({ enabled_events: ["invoice.paid"] })]).problems[0]).toMatch(
      /checkout\.session\.completed/,
    );
  });
});

describe("entrada e relatório", () => {
  it("lê só chave de API do Stripe e diz o modo", () => {
    // Built at run time so no versioned line looks like a credential to the public scan.
    const key = (prefix: string, mode: string, body = "synthetic0000") =>
      [prefix, mode, body].join("_");
    expect(readKey(`${key("sk", "test")}\n`).livemode).toBe(false);
    expect(readKey(key("rk", "live")).livemode).toBe(true);
    for (const text of [key("pk", "test"), key("whsec", "synthetic"), key("sk", "test", "x")])
      expect(() => readKey(text)).toThrow("BILLING_CHECK_KEY_INVALID");
  });

  it("aceita só os argumentos conhecidos e a rota de eventos da cobrança", () => {
    expect(parseArgs(["--key-file", "/k"])).toEqual({ keyFile: "/k", endpoint: DEFAULT_ENDPOINT });
    const validation = "https://modest-seal-118.convex.site/v1/billing/stripe/events";
    expect(parseArgs(["--key-file", "/k", "--endpoint", validation]).endpoint).toBe(validation);
    expect(() => parseArgs([])).toThrow("BILLING_CHECK_ARGUMENTS_INVALID");
    expect(() => parseArgs(["--key-file"])).toThrow("BILLING_CHECK_ARGUMENTS_INVALID");
    expect(() => parseArgs(["--key", "/k"])).toThrow("BILLING_CHECK_ARGUMENTS_INVALID");
    expect(() =>
      parseArgs(["--key-file", "/k", "--endpoint", "http://x/v1/billing/stripe/events"]),
    ).toThrow("BILLING_CHECK_ENDPOINT_INVALID");
    expect(() =>
      parseArgs(["--key-file", "/k", "--endpoint", "https://x/v1/stripe/events"]),
    ).toThrow("BILLING_CHECK_ENDPOINT_INVALID");
  });

  it("não traz ids da conta no relatório", () => {
    const result = report({
      livemode: false,
      endpoint: DEFAULT_ENDPOINT,
      prices: prices(),
      webhooks: { data: [hook({ id: "we_secreto" })] },
      portal: { data: [configuration({}, { id: "bpc_secreto" })] },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("test");
    expect(JSON.stringify(result)).not.toMatch(/price_|prod_|we_|bpc_/);
  });
});
