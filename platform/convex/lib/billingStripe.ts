import { v } from "convex/values";
import { PLATFORM_PLANS } from "./planCatalog";
import { addMonths, termMonthAt } from "./annualTerms";
import { isPeriodAnchor, isPeriodInstant, periodKeyStart, quotaPeriod } from "./quotaPeriod";

/**
 * Card billing of the platform's own subscription through Stripe (#556). Unlike the Stripe
 * connection of ADR 0006, this side holds a Freecorps key and calls the Stripe API: the browser
 * return proves nothing, so every grant comes from an invoice read back from Stripe.
 */

/** Pinned so the invoice and subscription shapes read below do not move with the account default. */
export const STRIPE_API_VERSION = "2025-03-31.basil";
const STRIPE_API = "https://api.stripe.com";
const TIMEOUT_MS = 20_000;
export const PRICE_LOOKUP_KEYS = {
  intermediate: "fnfe_plan_intermediate_monthly_brl",
  large: "fnfe_plan_large_monthly_brl",
} as const;
/** Yearly prices of the annual plan (ADR 0010, decision 9), optional: see `readAnnualPrices`. */
export const ANNUAL_PRICE_LOOKUP_KEYS = {
  intermediate: "fnfe_plan_intermediate_annual_brl",
  large: "fnfe_plan_large_annual_brl",
} as const;
export type PaidTier = keyof typeof PRICE_LOOKUP_KEYS;
const PAID_TIERS = Object.keys(PRICE_LOOKUP_KEYS) as PaidTier[];
const isPaidTier = (value: unknown): value is PaidTier =>
  value === "intermediate" || value === "large";

export type BillingConfig = { secretKey: string; webhookSecret: string; livemode: boolean };

/**
 * `null` while card billing is not configured. Half a configuration, or a live key outside the
 * hosted installation, is refused instead of silently ignored.
 */
export function billingConfig(installation: boolean): BillingConfig | null {
  const secretKey = process.env.STRIPE_BILLING_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
  if (!secretKey && !webhookSecret) return null;
  const key = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.exec(secretKey ?? "");
  if (!key || !/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(webhookSecret ?? ""))
    throw new Error("Invalid platform configuration: STRIPE_BILLING");
  const livemode = key[1] === "live";
  if (livemode && !installation) throw new Error("Invalid platform configuration: STRIPE_BILLING");
  return { secretKey: secretKey!, webhookSecret: webhookSecret!, livemode };
}

/** A Stripe answer that is not a success. `status` 0 is a transport failure or timeout. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`STRIPE_${status}_${code}`);
    this.status = status;
    this.code = code;
  }
  /** Will not change on retry: a 4xx other than 409/429, or an answer we refuse to use. */
  get definitive() {
    if (this.status === 0) return this.code !== "TRANSPORT";
    return this.status >= 400 && this.status < 500 && this.status !== 409 && this.status !== 429;
  }
}

export type Params = Record<string, string | number | boolean | undefined>;
export async function stripeApi(
  config: BillingConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
  idempotencyKey?: string,
): Promise<Json> {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) form.append(name, String(value));
  const query = method === "GET" && [...form.keys()].length ? `?${form}` : "";
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(method === "POST" ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // A timeout does not prove the call failed: callers retry with the same idempotency key.
    throw new StripeApiError(0, "TRANSPORT");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = obj(obj(body)?.error);
    throw new StripeApiError(response.status, str(error?.code) ?? str(error?.type) ?? "ERROR");
  }
  const json = obj(body);
  if (!json) throw new StripeApiError(response.status, "MALFORMED");
  return json;
}

export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const int = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
const list = (value: unknown) => {
  const data = obj(value)?.data;
  return Array.isArray(data) ? data.map(obj).filter((item): item is Json => !!item) : [];
};
/** Id of an expandable field: the string itself or the expanded object's id. */
const ref = (value: unknown) => str(value) ?? str(obj(value)?.id);

/** Cancellation and resumption must pass the console's annual-term guards. */
export function readPortalSession(body: Json, customerId: string, livemode: boolean): string {
  const configuration = obj(body.configuration);
  const features = obj(configuration?.features);
  if (
    body.customer !== customerId ||
    body.livemode !== livemode ||
    configuration?.livemode !== livemode ||
    configuration.active !== true ||
    obj(features?.subscription_cancel)?.enabled !== false ||
    obj(features?.subscription_update)?.enabled !== false ||
    obj(features?.invoice_history)?.enabled !== true ||
    obj(features?.payment_method_update)?.enabled !== true
  )
    throw new StripeApiError(0, "PORTAL_CONFIGURATION");
  if (typeof body.url !== "string" || !body.url.startsWith("https://"))
    throw new StripeApiError(0, "MALFORMED");
  return body.url;
}

export type Price = { priceId: string; productId: string };
export type CatalogPrices = Record<PaidTier, Price>;
/** Per tier: a missing or wrong yearly price stops only the annual grants of that tier. */
export type AnnualPrices = Partial<Record<PaidTier, Price>>;
export type Cycle = "monthly" | "annual";

/** The prices in `body` with the lookup keys of `cycle` that charge exactly the catalog. */
function readPrices(body: Json, livemode: boolean, cycle: Cycle) {
  const keys = cycle === "annual" ? ANNUAL_PRICE_LOOKUP_KEYS : PRICE_LOOKUP_KEYS;
  const found: AnnualPrices = {};
  for (const price of list(body)) {
    const tier = PAID_TIERS.find((name) => keys[name] === price.lookup_key);
    const recurring = obj(price.recurring);
    const id = str(price.id);
    const product = ref(price.product);
    if (
      !tier ||
      !id ||
      !product ||
      price.active !== true ||
      price.livemode !== livemode ||
      price.currency !== "brl" ||
      price.type !== "recurring" ||
      int(price.unit_amount) !==
        PLATFORM_PLANS[tier][cycle === "annual" ? "annualCents" : "monthlyCents"] ||
      recurring?.interval !== (cycle === "annual" ? "year" : "month") ||
      recurring.interval_count !== 1 ||
      (recurring.usage_type !== undefined && recurring.usage_type !== "licensed")
    )
      continue;
    found[tier] = { priceId: id, productId: product };
  }
  return found;
}
/**
 * The recurring prices are created once in Stripe with the lookup keys above. The server only
 * uses them after checking they still charge exactly the catalog amount, monthly, in BRL.
 */
export function readCatalogPrices(body: Json, livemode: boolean): CatalogPrices | null {
  const found = readPrices(body, livemode, "monthly");
  return found.intermediate && found.large ? (found as CatalogPrices) : null;
}
/**
 * The yearly prices (`ANNUAL_PRICE_LOOKUP_KEYS`), checked like the monthly ones but yearly and
 * at `annualCents`. Optional: without them an annual invoice is `PRICE_UNKNOWN`, and nothing
 * monthly changes.
 */
export const readAnnualPrices = (body: Json, livemode: boolean): AnnualPrices =>
  readPrices(body, livemode, "annual");
export const tierOfPrice = (prices: CatalogPrices, priceId: string | null): PaidTier | null =>
  priceId === prices.intermediate.priceId
    ? "intermediate"
    : priceId === prices.large.priceId
      ? "large"
      : null;
/** Tier and cycle of a verified price, monthly or yearly; `null` for any other price. */
export function pricedTier(
  prices: CatalogPrices,
  annual: AnnualPrices,
  priceId: string | null,
): { tier: PaidTier; cycle: Cycle } | null {
  const monthly = tierOfPrice(prices, priceId);
  if (monthly) return { tier: monthly, cycle: "monthly" };
  const tier = PAID_TIERS.find((name) => priceId !== null && annual[name]?.priceId === priceId);
  return tier ? { tier, cycle: "annual" } : null;
}

/**
 * Our own markers, set by the server on the Checkout Session; anything else is ignored. An
 * annual Checkout marks its subscription (`subscription_data[metadata]`) with `kind: "start"`,
 * `cycle: ANNUAL_CYCLE`, `tier` and `grantCents` (`annualCents`), without `period` since slice 2b
 * of ADR 0012: the term starts when it is paid, and its line says which year of the anchor it
 * is. Its first invoice becomes the term; renewals are recognized by the yearly price alone. An
 * annual upgrade Checkout, a one-off payment, marks its invoice with `kind: "upgrade"`,
 * `cycle: ANNUAL_CYCLE`, the higher `tier`, the `period` it starts (the canonical key of the
 * start of the current term month) and `grantCents`, the difference priced on the term.
 */
export const ourMetadata = v.object({
  organizationId: v.optional(v.string()),
  kind: v.optional(v.string()),
  tier: v.optional(v.string()),
  period: v.optional(v.string()),
  grantCents: v.optional(v.string()),
  cycle: v.optional(v.string()),
});
export const ANNUAL_CYCLE = "annual";
function readOurs(value: unknown): typeof ourMetadata.type {
  const meta = obj(value) ?? {};
  const pick = (name: string) => {
    const text = str(meta[name]);
    return text && text.length <= 100 ? text : undefined;
  };
  const fields = {
    organizationId: pick("organizationId"),
    kind: pick("kind"),
    tier: pick("tier"),
    period: pick("period"),
    grantCents: pick("grantCents"),
    cycle: pick("cycle"),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export const invoiceFacts = v.object({
  id: v.string(),
  customerId: v.string(),
  status: v.string(),
  currency: v.string(),
  amountPaid: v.number(),
  amountDue: v.number(),
  attempted: v.boolean(),
  /** `status_transitions.paid_at`, in ms: when the money was taken. */
  paidAt: v.union(v.number(), v.null()),
  billingReason: v.union(v.string(), v.null()),
  subscriptionId: v.union(v.string(), v.null()),
  /** Upgrade payments carry the markers on the invoice; the first subscription invoice, on its parent. */
  metadata: ourMetadata,
  subscriptionMetadata: ourMetadata,
  lines: v.array(
    v.object({
      priceId: v.union(v.string(), v.null()),
      /** `period.start` and `period.end` of the line, in ms: what a recurring line bills. */
      periodStart: v.number(),
      periodEnd: v.number(),
      amount: v.number(),
    }),
  ),
  hostedUrl: v.union(v.string(), v.null()),
});
export type InvoiceFacts = typeof invoiceFacts.type;
export function readInvoice(invoice: Json): InvoiceFacts | null {
  const id = str(invoice.id);
  const customerId = ref(invoice.customer);
  const status = str(invoice.status);
  if (!id || !customerId || !status) return null;
  const details = obj(obj(invoice.parent)?.subscription_details);
  const paidAt = int(obj(invoice.status_transitions)?.paid_at);
  return {
    id,
    customerId,
    status,
    currency: str(invoice.currency) ?? "",
    amountPaid: int(invoice.amount_paid) ?? 0,
    amountDue: int(invoice.amount_due) ?? 0,
    attempted: invoice.attempted === true,
    paidAt: paidAt === undefined ? null : paidAt * 1000,
    billingReason: str(invoice.billing_reason) ?? null,
    subscriptionId: ref(details?.subscription) ?? null,
    metadata: readOurs(invoice.metadata),
    subscriptionMetadata: readOurs(details?.metadata),
    lines: list(invoice.lines)
      .slice(0, 20)
      .map((line) => ({
        priceId: ref(obj(obj(line.pricing)?.price_details)?.price) ?? null,
        periodStart: (int(obj(line.period)?.start) ?? 0) * 1000,
        periodEnd: (int(obj(line.period)?.end) ?? 0) * 1000,
        amount: int(line.amount) ?? 0,
      })),
    hostedUrl: str(invoice.hosted_invoice_url) ?? null,
  };
}
export const readInvoices = (body: Json) =>
  list(body)
    .map(readInvoice)
    .filter((item): item is InvoiceFacts => !!item);

export const subscriptionFacts = v.object({
  id: v.string(),
  status: v.string(),
  itemId: v.union(v.string(), v.null()),
  priceId: v.union(v.string(), v.null()),
  cancelAtPeriodEnd: v.boolean(),
  periodEnd: v.union(v.number(), v.null()),
  /** Its price is yearly or has an annual lookup key, verified or not: never switched to monthly. */
  annual: v.boolean(),
});
export type SubscriptionFacts = typeof subscriptionFacts.type;
/** Statuses after which Stripe never charges the subscription again. */
export const ENDED_STATUSES = ["canceled", "incomplete_expired"];
const ANNUAL_KEYS: readonly unknown[] = Object.values(ANNUAL_PRICE_LOOKUP_KEYS);
/** The item's price as Stripe expands it in a subscription; a bare id says nothing. */
function annualItem(item: Json) {
  const price = obj(list(item.items)[0]?.price);
  return ANNUAL_KEYS.includes(price?.lookup_key) || obj(price?.recurring)?.interval === "year";
}
/**
 * The subscription that will renew, newest first, else the newest one still running out its
 * paid period. One cancelling while a newer one renews is a switch (an upgrade after cancelling);
 * two that renew would charge twice, and the caller flags it instead of choosing. `annualIds`
 * lists the customer's annual subscriptions, ended ones included, and `anchors` the
 * `billing_cycle_anchor` of each, in ms (ADR 0012, invariant 6), so an invoice of a subscription
 * that has ended since is still weighed against its anchor.
 */
export function readSubscriptions(body: Json, customerId: string) {
  const mine = list(body).filter((item) => ref(item.customer) === customerId && str(item.id));
  const annualIds = mine.filter(annualItem).map((item) => str(item.id)!);
  const anchors = mine.flatMap((item) => {
    const anchor = int(item.billing_cycle_anchor);
    return anchor === undefined ? [] : [{ subscriptionId: str(item.id)!, anchor: anchor * 1000 }];
  });
  const live = mine
    .filter((item) => !ENDED_STATUSES.includes(str(item.status) ?? "canceled"))
    .sort((a, b) => (int(b.created) ?? 0) - (int(a.created) ?? 0))
    .map((item): SubscriptionFacts => {
      const first = list(item.items)[0];
      const end = int(first?.current_period_end);
      return {
        id: str(item.id)!,
        status: str(item.status)!,
        itemId: str(first?.id) ?? null,
        priceId: ref(first?.price) ?? null,
        cancelAtPeriodEnd: item.cancel_at_period_end === true,
        periodEnd: end === undefined ? null : end * 1000,
        annual: annualItem(item),
      };
    });
  const renewing = live.filter((item) => !item.cancelAtPeriodEnd);
  return {
    current: renewing[0] ?? live[0] ?? null,
    duplicates: renewing.length > 1,
    live,
    annualIds,
    anchors,
  };
}

/**
 * Invariant 6 of ADR 0012: `[start, end)` is exactly one month of the subscription's
 * `billing_cycle_anchor`, from its anniversary k to k + 1, always counted from the anchor
 * (`addMonths`, as Stripe clamps 31/01 to 28/02 and returns to 31/03). A subscription anchored on
 * a 1st at 00:00 UTC, as the monthly Checkouts before slice 2a, has the civil UTC months.
 */
export function anchorMonth(anchor: number | undefined, start: number, end: number) {
  if (
    anchor === undefined ||
    !isPeriodAnchor(anchor) ||
    !isPeriodInstant(start) ||
    !isPeriodInstant(end) ||
    start < anchor
  )
    return false;
  const month = quotaPeriod({ periodAnchor: anchor }, start);
  return month.startsAt === start && month.endsAt === end;
}

/**
 * The annual half of invariant 6 of ADR 0012: `[start, end)` is exactly one year of the
 * subscription's `billing_cycle_anchor`, its n-th term, from the monthly anniversary 12(n − 1)
 * to 12n, always counted from the anchor. A subscription anchored on 29/02/2028 renews on
 * 28/02/2029, 2030 and 2031 and on 29/02/2032, without drift. One anchored on a 1st at 00:00
 * UTC, as the annual Checkouts before slice 2b, has its terms from that 1st.
 */
export function anchorYear(anchor: number | undefined, start: number, end: number) {
  if (
    anchor === undefined ||
    !isPeriodAnchor(anchor) ||
    !isPeriodInstant(start) ||
    !isPeriodInstant(end) ||
    start < anchor
  )
    return false;
  const month = termMonthAt(anchor, start);
  return (
    month.startsAt === start &&
    month.index % 12 === 0 &&
    addMonths(anchor, month.index + 12) === end
  );
}

export type GrantDecision =
  /** A month of the subscription's `anchor` (ADR 0012, invariant 6): `[startsAt, endsAt)`. */
  | { kind: "grant"; tier: PaidTier; startsAt: number; endsAt: number; anchor: number }
  /** Raises the monthly plan to `tier` for the rest of its quota period `period` (canonical key). */
  | { kind: "upgrade"; tier: PaidTier; period: string }
  /**
   * A 12-month term (ADR 0010, decision 9), `[startsAt, endsAt)`: one year of the
   * subscription's `anchor` (ADR 0012, invariant 6), which the term keeps as its chain's anchor.
   */
  | { kind: "annual"; tier: PaidTier; startsAt: number; endsAt: number; anchor: number }
  /**
   * Raises the annual term covering `period` to `tier` until its end, priced on the term from
   * `period`, the canonical key of the start of the term month it was sold in.
   */
  | { kind: "annualUpgrade"; tier: PaidTier; period: string }
  | { kind: "none"; code: string }
  | { kind: "review"; code: string };
/**
 * What a paid invoice buys. The first invoice and upgrades charge what the server priced on the
 * Checkout Session; renewals charge the catalog price of the recurring item. A monthly first
 * invoice or renewal buys the period of its line at the monthly price, which must be exactly one
 * month of the subscription's `billing_cycle_anchor` (`anchors`, ADR 0012, invariant 6); a
 * monthly upgrade buys the rest of the quota period its marks name (`period`, a canonical key).
 * Anything else, or any amount that does not match, goes to a person. An annual invoice charges
 * exactly `annualCents` and buys the period of its yearly line, which must be exactly one year
 * of the subscription's anchor (`anchorYear`, invariant 6): the first one, marked
 * `cycle: ANNUAL_CYCLE` and charged at the signing since slice 2b, and each renewal at a yearly
 * price. Without the yearly prices (`annual` empty), both stay `PRICE_UNKNOWN`. A monthly-marked
 * invoice of one of `annualSubscriptions` (`readSubscriptions`) is `INVOICE_UNEXPECTED`. An
 * annual upgrade, a one-off payment marked `kind: "upgrade"` and annual, needs the verified yearly
 * price of its tier, which the subscription then moves to; its amount is checked on the term.
 */
export function invoiceGrant(
  invoice: InvoiceFacts,
  prices: CatalogPrices,
  organizationId: string,
  annual: AnnualPrices = {},
  annualSubscriptions: readonly string[] = [],
  anchors: Readonly<Record<string, number>> = {},
): GrantDecision {
  if (invoice.status !== "paid") return { kind: "none", code: "NOT_PAID" };
  if (invoice.amountPaid <= 0) return { kind: "none", code: "ZERO_AMOUNT" };
  if (invoice.currency !== "brl") return { kind: "review", code: "CURRENCY_MISMATCH" };
  const anchor = invoice.subscriptionId === null ? undefined : anchors[invoice.subscriptionId];
  /**
   * A line at a monthly price bills one month of the anchor, or the invoice goes to a person. An
   * anchor not read yet (a sync racing the Checkout's completion) decides nothing: the invoice is
   * not recorded and is weighed again on the next reconciliation, as an unpaid one.
   */
  const month = (tier: PaidTier, line: InvoiceFacts["lines"][number]): GrantDecision =>
    anchor === undefined
      ? { kind: "none", code: "ANCHOR_UNKNOWN" }
      : anchorMonth(anchor, line.periodStart, line.periodEnd)
        ? { kind: "grant", tier, startsAt: line.periodStart, endsAt: line.periodEnd, anchor }
        : { kind: "review", code: "INVOICE_UNEXPECTED" };
  /** A line at a yearly price bills one year of the anchor (invariant 6), as `month` a month. */
  const year = (tier: PaidTier, line: InvoiceFacts["lines"][number]): GrantDecision =>
    anchor === undefined
      ? { kind: "none", code: "ANCHOR_UNKNOWN" }
      : anchorYear(anchor, line.periodStart, line.periodEnd)
        ? { kind: "annual", tier, startsAt: line.periodStart, endsAt: line.periodEnd, anchor }
        : { kind: "review", code: "INVOICE_UNEXPECTED" };
  const priced = (marks: typeof ourMetadata.type, kind: string): GrantDecision => {
    if (marks.organizationId !== organizationId)
      return { kind: "review", code: "ORGANIZATION_MISMATCH" };
    const yearly = marks.cycle === ANNUAL_CYCLE;
    // A start, monthly or annual, begins when it is paid (ADR 0012), so its period is its line's,
    // never a mark; every upgrade names the period it was priced for.
    if (
      marks.kind !== kind ||
      !isPaidTier(marks.tier) ||
      (kind === "upgrade" && periodKeyStart(marks.period ?? "") === null) ||
      String(invoice.amountPaid) !== marks.grantCents
    )
      return { kind: "review", code: "AMOUNT_MISMATCH" };
    // The recurring line is what the subscription renews at: it must be the cycle bought. A
    // subscription at an annual price, even an unverified one, never buys a month.
    if (
      (!yearly &&
        invoice.subscriptionId !== null &&
        annualSubscriptions.includes(invoice.subscriptionId)) ||
      invoice.lines
        .map((line) => pricedTier(prices, annual, line.priceId))
        .some((line) =>
          yearly
            ? line && (line.cycle !== "annual" || line.tier !== marks.tier)
            : line?.cycle === "annual",
        )
    )
      return { kind: "review", code: "INVOICE_UNEXPECTED" };
    if (!yearly) {
      if (kind === "upgrade") return { kind: "upgrade", tier: marks.tier, period: marks.period! };
      // The first month: the recurring line at the monthly price of the tier bought, charged at
      // the signing and running to the same day and time next month.
      const tier = marks.tier;
      const line = invoice.lines.find((item) => item.priceId === prices[tier].priceId);
      return line ? month(tier, line) : { kind: "review", code: "INVOICE_UNEXPECTED" };
    }
    if (!annual[marks.tier]) return { kind: "review", code: "PRICE_UNKNOWN" };
    if (kind === "upgrade")
      return { kind: "annualUpgrade", tier: marks.tier, period: marks.period! };
    if (invoice.amountPaid !== PLATFORM_PLANS[marks.tier].annualCents)
      return { kind: "review", code: "AMOUNT_MISMATCH" };
    // The first year: the recurring line at the verified yearly price of the tier bought,
    // charged at the signing and running to the same day and time a year later.
    const yearlyPrice = annual[marks.tier]!.priceId;
    const line = invoice.lines.find((item) => item.priceId === yearlyPrice);
    return line ? year(marks.tier, line) : { kind: "review", code: "INVOICE_UNEXPECTED" };
  };
  if (invoice.billingReason === "subscription_create")
    return priced(invoice.subscriptionMetadata, "start");
  if (invoice.billingReason === "subscription_cycle") {
    const line = invoice.lines.find((item) => pricedTier(prices, annual, item.priceId));
    const price = line && pricedTier(prices, annual, line.priceId);
    if (!line || !price) return { kind: "review", code: "PRICE_UNKNOWN" };
    const yearly = price.cycle === "annual";
    const plan = PLATFORM_PLANS[price.tier];
    if (invoice.amountPaid !== (yearly ? plan.annualCents : plan.monthlyCents))
      return { kind: "review", code: "AMOUNT_MISMATCH" };
    return yearly ? year(price.tier, line) : month(price.tier, line);
  }
  if (!invoice.subscriptionId && invoice.metadata.kind === "upgrade")
    return priced(invoice.metadata, "upgrade");
  return { kind: "review", code: "INVOICE_UNEXPECTED" };
}

/** Event types the billing endpoint stores; the rest are acknowledged and dropped. */
export const BILLING_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;
export type BillingEnvelope = {
  id: string;
  type: (typeof BILLING_EVENT_TYPES)[number];
  livemode: boolean;
  objectId: string;
  customerId?: string;
  chargeId?: string;
  amountCents?: number;
  /** Refunds and disputes only flag a person (decision of 28/10/2026); they never move the plan. */
  review?: string;
};
/** Reads only selectors from the event; the state itself is fetched from the API afterwards. */
export function readBillingEnvelope(body: string): BillingEnvelope | null | "INVALID" {
  let event: Json | undefined;
  try {
    event = obj(JSON.parse(body));
  } catch {
    return "INVALID";
  }
  const id = str(event?.id);
  const type = str(event?.type);
  const object = obj(obj(event?.data)?.object);
  const objectId = str(object?.id);
  if (!event || !id || !/^evt_[A-Za-z0-9_]{1,250}$/.test(id) || !type || !object || !objectId)
    return "INVALID";
  if (typeof event.livemode !== "boolean") return "INVALID";
  if (!(BILLING_EVENT_TYPES as readonly string[]).includes(type)) return null;
  const envelope: BillingEnvelope = {
    id,
    type: type as BillingEnvelope["type"],
    livemode: event.livemode,
    objectId,
  };
  const customerId = ref(object.customer);
  if (customerId) envelope.customerId = customerId;
  if (type === "charge.refunded") {
    envelope.chargeId = objectId;
    envelope.amountCents = int(object.amount_refunded);
    envelope.review = object.refunded === true ? "REFUND_FULL" : "REFUND_PARTIAL";
  }
  if (type === "charge.dispute.created" || type === "charge.dispute.closed") {
    const charge = ref(object.charge);
    if (charge) envelope.chargeId = charge;
    envelope.amountCents = int(object.amount);
    envelope.review =
      type === "charge.dispute.created"
        ? "DISPUTE_OPENED"
        : object.status === "won"
          ? "DISPUTE_WON"
          : object.status === "lost"
            ? "DISPUTE_LOST"
            : "DISPUTE_CLOSED";
  }
  return envelope;
}
