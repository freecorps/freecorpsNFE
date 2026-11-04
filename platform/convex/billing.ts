import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePlatformEnvironment } from "./environment";
import {
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import { PLATFORM_PLANS, isCatalogTier, paidTier } from "./lib/planCatalog";
import { allocateOffer, annualEnabled, markTermRenewalStop, pixEnabled } from "./lib/planCore";
import {
  rescindedSubscription,
  termsEnd,
  termMonth,
  termTierAt,
  termUpgradeCents,
  termsInForce,
  upgradableTerm,
} from "./lib/planTerms";
import { assertPlanChangeable } from "./lib/coldArchiveCore";
import { planFor } from "./lib/usageCore";
import { planEnded } from "./lib/usageValues";
import { periodKey, quotaPeriod } from "./lib/quotaPeriod";
import { billingOpenInvoice, billingSubscription, checkoutKind } from "./lib/billingSchema";
import {
  ANNUAL_CYCLE,
  ANNUAL_PRICE_LOOKUP_KEYS,
  ENDED_STATUSES,
  PRICE_LOOKUP_KEYS,
  StripeApiError,
  billingConfig,
  invoiceFacts,
  pricedTier,
  readAnnualPrices,
  readCatalogPrices,
  readInvoices,
  readPortalSession,
  readSubscriptions,
  stripeApi,
  subscriptionFacts,
  type AnnualPrices,
  type BillingConfig,
  type CatalogPrices,
  type Params,
} from "./lib/billingStripe";
import {
  CREATING_TTL,
  PERIOD_CLOSING_MARGIN,
  UPGRADE_SWITCH_MARGIN,
  needsPerson,
  accountOf,
  applyInvoice,
  openCheckout,
  paidByCard,
  periodStart,
  pixMonthlyUntil,
  pixPending,
  renews,
  scheduledPixRenewal,
} from "./lib/billingCore";

/**
 * Card subscriptions of the platform plans through Stripe (#556), next to the assisted Pix of
 * `plans.ts`. The console only states an intention; the server prices it, Stripe charges it and
 * the plan moves only when a paid invoice is read back from the Stripe API.
 */
const scope = { organizationId: v.id("organizations") };
const config = () => billingConfig(requirePlatformEnvironment().installation);
function requireConfig() {
  const value = config();
  if (!value) return deny("BILLING_DISABLED");
  return value;
}
/** Who asks comes first: no session, no membership or no manager role is refused before anything
 * about the billing configuration is revealed. Each prepare mutation checks the role again. */
async function managerConfig(ctx: ActionCtx, organizationId: Id<"organizations">) {
  await ctx.runQuery(internal.billing.authorize, { organizationId });
  return requireConfig();
}
export const authorize = internalQuery({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    return null;
  },
});
/** Stripe refusals and timeouts reach the console as one code; the detail stays in the logs. */
async function stripe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StripeApiError) {
      console.error("billing.stripe", error.message);
      return deny("BILLING_UNAVAILABLE");
    }
    throw error;
  }
}
/** The monthly prices, required, and the yearly ones, optional, in one read. */
async function catalogPrices(
  cfg: BillingConfig,
): Promise<{ monthly: CatalogPrices; annual: AnnualPrices }> {
  const body = await stripeApi(cfg, "GET", "/v1/prices", {
    "lookup_keys[0]": PRICE_LOOKUP_KEYS.intermediate,
    "lookup_keys[1]": PRICE_LOOKUP_KEYS.large,
    "lookup_keys[2]": ANNUAL_PRICE_LOOKUP_KEYS.intermediate,
    "lookup_keys[3]": ANNUAL_PRICE_LOOKUP_KEYS.large,
    active: true,
    limit: 10,
  });
  const prices = readCatalogPrices(body, cfg.livemode);
  // A price changed in Stripe without the catalog: nothing is sold until a person fixes it.
  if (!prices) throw new StripeApiError(0, "PRICE_MISMATCH");
  return { monthly: prices, annual: readAnnualPrices(body, cfg.livemode) };
}

const reviewItem = v.object({
  /** `term`: a rescinded card term whose subscription could not be cancelled. */
  source: v.union(v.literal("event"), v.literal("grant"), v.literal("term")),
  code: v.string(),
  amountCents: v.union(v.number(), v.null()),
  createdAt: v.number(),
});
export const overview = query({
  args: scope,
  returns: v.object({
    card: v.boolean(),
    account: v.union(
      v.null(),
      v.object({
        renewalTier: v.union(paidTier, v.null()),
        subscription: v.union(billingSubscription, v.null()),
        openInvoice: v.union(billingOpenInvoice, v.null()),
        syncedAt: v.union(v.number(), v.null()),
        syncError: v.union(v.string(), v.null()),
      }),
    ),
    checkout: v.union(
      v.null(),
      v.object({
        kind: checkoutKind,
        tier: paidTier,
        /** Both cycles charge `grantCents` when the customer pays (ADR 0012). */
        cycle: v.union(v.literal("monthly"), v.literal("annual")),
        /**
         * The canonical key of the period an upgrade raises (ADR 0012), for consoles published
         * before it; absent on a start, which begins when it is paid. Read `periodStartsAt`.
         */
        period: v.optional(v.string()),
        /**
         * When the period an upgrade raises starts: the monthly plan's quota period or the term
         * month. Null for a start, monthly or annual, which runs from the payment to the same day
         * and time a month or a year later.
         */
        periodStartsAt: v.union(v.number(), v.null()),
        grantCents: v.number(),
        url: v.union(v.string(), v.null()),
        expiresAt: v.number(),
      }),
    ),
    reviews: v.array(reviewItem),
    /** Plan in force and a Pix request waiting, so the card actions follow the same rules. */
    plan: v.union(v.null(), v.object({ tier: v.string(), endsAt: v.union(v.number(), v.null()) })),
    pixPending: v.boolean(),
    /** The annual switch (`annualEnabled`): the annual Checkout is on sale. */
    annualEnabled: v.boolean(),
    /** The Pix switch (`pixEnabled`): the console offers the assisted Pix beside the card. */
    pixEnabled: v.boolean(),
    /**
     * The subscription in the account bought a term in force or scheduled. An annual one without
     * it has not been granted a term: its first charge is still being read, or it was blocked for
     * a person.
     */
    subscriptionTerm: v.boolean(),
    /**
     * A term in force or scheduled refuses the annual Checkout until the last one ends
     * (`termsEnd`, ADR 0012, one paid plan at a time): its own subscription renews a card term.
     */
    annualBlocked: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    let cfg: BillingConfig | null = null;
    try {
      cfg = config();
    } catch {
      // Misconfigured card billing reads as unavailable; Pix, if switched on, keeps working.
    }
    const now = Date.now();
    const current = await planFor(ctx, args.organizationId);
    const plan =
      current && current.startsAt <= now && !planEnded(current, now)
        ? { tier: current.catalogTier ?? "custom", endsAt: current.endsAt }
        : null;
    const pixWaiting = await pixPending(ctx, args.organizationId, now);
    const annualOnSale = await annualEnabled(ctx);
    const pixOnSale = await pixEnabled(ctx);
    const annualBlocked = (await termsEnd(ctx, args.organizationId, now)) !== null;
    if (!cfg)
      return {
        card: false,
        account: null,
        checkout: null,
        reviews: [],
        plan,
        pixPending: pixWaiting,
        annualEnabled: annualOnSale,
        pixEnabled: pixOnSale,
        subscriptionTerm: false,
        annualBlocked,
      };
    const account = await accountOf(ctx, args.organizationId, cfg.livemode);
    const subscriptionId = account?.subscription?.id;
    const subscriptionTerm =
      subscriptionId !== undefined &&
      (await termsInForce(ctx, args.organizationId, now)).some(
        (term) => term.stripeSubscriptionId === subscriptionId,
      );
    const checkout = await openCheckout(ctx, args.organizationId, Date.now());
    const events = await ctx.db
      .query("billingEvents")
      .withIndex("by_organizationId_and_review", (q) =>
        q.eq("organizationId", args.organizationId).eq("review", true),
      )
      .order("desc")
      .take(5);
    const grants = await ctx.db
      .query("billingGrants")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(20);
    const rescinded = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", args.organizationId).eq("state", "rescinded"),
      )
      .take(20);
    return {
      card: true,
      account: account
        ? {
            renewalTier: account.renewalTier ?? null,
            subscription: account.subscription ?? null,
            openInvoice: account.openInvoice ?? null,
            syncedAt: account.syncedAt ?? null,
            syncError: account.syncError ?? null,
          }
        : null,
      checkout: checkout
        ? {
            kind: checkout.kind,
            tier: checkout.tier,
            cycle: checkout.cycle ?? ("monthly" as const),
            ...(checkout.period !== undefined ? { period: checkout.period } : {}),
            periodStartsAt: checkout.period === undefined ? null : periodStart(checkout.period),
            grantCents: checkout.grantCents,
            url: checkout.state === "open" ? (checkout.url ?? null) : null,
            expiresAt: checkout.expiresAt,
          }
        : null,
      reviews: [
        ...events.map((event) => ({
          source: "event" as const,
          code: event.code ?? event.type,
          amountCents: event.amountCents ?? null,
          createdAt: event.createdAt,
        })),
        ...grants
          .filter((grant) => needsPerson(grant) && !grant.resolvedBy)
          .slice(0, 5)
          .map((grant) => ({
            source: "grant" as const,
            code: grant.code ?? "BLOCKED",
            amountCents: grant.amountCents,
            createdAt: grant.createdAt,
          })),
        // A term and its scheduled renewal, rescinded together, share one subscription to stop.
        ...rescinded.flatMap((term, index) => {
          const failed = term.rescission?.renewalStopFailed;
          const repeated = rescinded
            .slice(0, index)
            .some(
              (prior) =>
                prior.rescission?.renewalStopFailed &&
                prior.stripeSubscriptionId === term.stripeSubscriptionId,
            );
          return failed && !repeated
            ? [
                {
                  source: "term" as const,
                  code: "SUBSCRIPTION_STOP_FAILED",
                  amountCents: null,
                  createdAt: failed.at,
                },
              ]
            : [];
        }),
      ].sort((a, b) => b.createdAt - a.createdAt),
      plan,
      pixPending: pixWaiting,
      annualEnabled: annualOnSale,
      pixEnabled: pixOnSale,
      subscriptionTerm,
      annualBlocked,
    };
  },
});

/**
 * Prices the intention under the same rules as Pix (ADR 0012, slice 2a): the whole month, charged
 * at the signing, or the full difference on an upgrade. The monthly subscription has no anchor of
 * its own: Stripe anchors it at the signing (`billing_cycle_anchor`), and it renews on each
 * anniversary of that instant, which the quota periods of the plan follow. One paid plan at a
 * time: with a paid plan in force, the card monthly only sells an upgrade of the card plan that
 * renews; anything else waits for the end of that plan, refused with the date (`availableAt`).
 *
 * `cycle: "annual"` prices a 12-month term at `annualCents` (ADR 0010, decision 9), charged and
 * started at the signing (ADR 0012, slice 2b): Stripe anchors the yearly subscription there and
 * renews it on each anniversary, and the term's chain keeps that anchor. Over a monthly in force
 * of the same tier or below, by card or Pix, it is sold now and replaces that monthly without
 * discount; over a pricier one, or while any term holds, it waits for its end, with the date. A
 * card that still renews is refused, never cancelled here: an abandoned Checkout must leave the
 * monthly subscription as it was.
 *
 * `start: "upgrade"` (annual only) raises the card term in force to `tier` from the start of the
 * current term month to its end: a one-off payment of the difference over the term months left,
 * as the monthly upgrade; once paid, the annual subscription moves to the yearly price of `tier`
 * at renewal, keeping its anchor.
 */
export const prepareCheckout = internalMutation({
  args: {
    ...scope,
    tier: paidTier,
    key: v.string(),
    livemode: v.boolean(),
    cycle: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    start: v.optional(v.literal("upgrade")),
  },
  returns: v.object({
    checkoutId: v.id("billingCheckouts"),
    kind: checkoutKind,
    annual: v.boolean(),
    customerId: v.union(v.string(), v.null()),
    organizationName: v.string(),
    slug: v.string(),
    /**
     * The canonical key of the period an upgrade raises; a start, monthly or annual, has none:
     * Stripe anchors its subscription at the signing.
     */
    period: v.optional(v.string()),
    grantCents: v.number(),
    expiresAt: v.number(),
    url: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { user, membership, organization } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    await assertPlanChangeable(ctx, args.organizationId);
    const annual = args.cycle === "annual";
    const upgrade = args.start === "upgrade";
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(args.key) || (upgrade && !annual)) deny("INVALID_REQUEST");
    // A card that renews monthly would charge months of the term: refused while any term holds,
    // in force or scheduled, until the last one ends (one paid plan at a time, ADR 0012). The card
    // has no deferred start, so a monthly never waits inside the term for its end.
    if (!annual) {
      const busyUntil = await termsEnd(ctx, args.organizationId, Date.now());
      if (busyUntil !== null) deny("ANNUAL_TERM_ACTIVE", { availableAt: busyUntil });
    }
    // The admission window is checked by `allocateOffer` below: an organization that already
    // holds the reservation may return to the card after it closes (#549).
    const now = Date.now();
    const account = await accountOf(ctx, args.organizationId, args.livemode);
    const answer = (row: Doc<"billingCheckouts">) => ({
      checkoutId: row._id,
      kind: row.kind,
      annual: row.cycle === "annual",
      customerId: account?.customerId ?? null,
      organizationName: organization.name,
      slug: organization.slug,
      ...(row.period !== undefined ? { period: row.period } : {}),
      grantCents: row.grantCents,
      expiresAt: row.expiresAt,
      url: row.url ?? null,
    });
    const prior = await ctx.db
      .query("billingCheckouts")
      .withIndex("by_organizationId_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    if (prior) {
      if (
        prior.tier !== args.tier ||
        (prior.cycle === "annual") !== annual ||
        (prior.cycle === "annual" && prior.kind === "upgrade") !== upgrade
      )
        deny("OPERATION_CONFLICT");
      if (prior.state === "open" && prior.expiresAt > now + 60_000) return answer(prior);
      // Same intention after a timeout: the same idempotency key returns the same session.
      if (prior.state === "creating" && prior.createdAt + CREATING_TTL > now) return answer(prior);
      deny("PLAN_REQUEST_UNAVAILABLE");
    }
    if (annual && !(await annualEnabled(ctx))) deny("ANNUAL_DISABLED");
    // One paid plan at a time (ADR 0012): the card annual is not sold while any term is in force
    // or scheduled, its last month included; it has no deferred start, and a card term renews by
    // its own subscription, at Stripe.
    if (annual && !upgrade) {
      const busyUntil = await termsEnd(ctx, args.organizationId, now);
      if (busyUntil !== null) deny("ANNUAL_TERM_ACTIVE", { availableAt: busyUntil });
    }
    if (await openCheckout(ctx, args.organizationId, now)) deny("CHECKOUT_PENDING");
    if (await pixPending(ctx, args.organizationId, now)) deny("PLAN_REQUEST_PENDING");
    const plan = await planFor(ctx, args.organizationId);
    if (plan?.catalogTier === "custom") deny("PLAN_UNAVAILABLE");
    // The access a rescinded term left runs to the end of its term month, already paid: a new
    // start, monthly or annual, waits for it (ADR 0012), as the invoice would replace it.
    if (!upgrade && plan?.termId && plan.startsAt <= now && !planEnded(plan, now))
      deny("PLAN_UNAVAILABLE", { availableAt: plan.endsAt });
    // One paid plan at a time (ADR 0012): the monthly card waits for the monthly Pix plan in
    // force, and for a renewal of it already paid, to end. A paid renewal not yet started also
    // holds the annual, which would replace it before it is used.
    if (!annual) {
      const pixUntil = await pixMonthlyUntil(ctx, args.organizationId, now);
      if (pixUntil !== null) deny("PAYMENT_METHOD_PIX", { availableAt: pixUntil });
    } else if (!upgrade) {
      const renewal = await scheduledPixRenewal(ctx, args.organizationId, now);
      if (renewal) deny("PAYMENT_METHOD_PIX", { availableAt: renewal.availableAt });
    }
    const day = 24 * 60 * 60_000;
    // A start, monthly or annual, is charged when paid: its session lasts a day.
    let expiresAt = now + day;
    let period: string | undefined;
    const current =
      plan &&
      plan.startsAt <= now &&
      !planEnded(plan, now) &&
      plan.catalogTier &&
      isCatalogTier(plan.catalogTier)
        ? PLATFORM_PLANS[plan.catalogTier]
        : null;
    const offer = PLATFORM_PLANS[args.tier];
    let kind: "start" | "upgrade";
    let grantCents: number;
    if (upgrade) {
      // The card term in force, bought by the annual subscription that will renew it.
      const term = await upgradableTerm(ctx, args.organizationId, now);
      if (term.source !== "stripe") deny("PAYMENT_METHOD_PIX");
      const sub = account?.subscription;
      if (
        !sub?.annual ||
        sub.id !== term.stripeSubscriptionId ||
        ENDED_STATUSES.includes(sub.status)
      )
        deny("SUBSCRIPTION_REQUIRED");
      // Close to the anchor the price switch might not reach Stripe before it bills the renewal
      // at the old tier. Paid at the latest when the session expires (24 h), the switch still has
      // two days; from the anniversary the new term is upgraded in its first month instead.
      if (term.endsAt - now < UPGRADE_SWITCH_MARGIN) deny("PERIOD_CLOSING");
      // Priced on the term month under way, counted from the chain's anchor (ADR 0012), which
      // counts whole: the payment must land within it, so it closes shortly before it turns and
      // the session expires before it does.
      const month = termMonth(term, now);
      if (month.endsAt - now < PERIOD_CLOSING_MARGIN)
        deny("PERIOD_CLOSING", { availableAt: month.endsAt });
      // Already at this tier or above: a downgrade only happens at renewal.
      const price = termUpgradeCents(term, args.tier, month.startsAt);
      if (price === null) return deny("PLAN_UNAVAILABLE");
      kind = "upgrade";
      grantCents = price;
      period = periodKey(month.startsAt);
      expiresAt = Math.min(now + day, month.endsAt - 5 * 60_000);
    } else if (annual) {
      // A card that still renews would bill beside the term: "Não renovar" comes first.
      if (renews(account)) deny("SUBSCRIPTION_RENEWING");
      // Charged and started now, the term replaces a monthly of the same tier or below without
      // discount; a pricier one would make it a downgrade outside the renewal, so it waits for
      // that monthly to end (one paid plan at a time, ADR 0012).
      if (current && current.monthlyCents > offer.monthlyCents && plan!.endsAt !== null)
        deny("PLAN_UNAVAILABLE", { availableAt: plan!.endsAt });
      kind = "start";
      grantCents = offer.annualCents;
    } else if (renews(account)) {
      // Already renewing by card: only an upgrade is paid here; a downgrade is `changeRenewal`
      // and the same tier renews by itself. An annual subscription is upgraded with
      // `cycle: "annual"` and `start: "upgrade"`.
      if (account!.subscription!.annual || !current || current.monthlyCents >= offer.monthlyCents)
        deny("PLAN_UNAVAILABLE");
      // The full difference buys the rest of the plan's quota period, with the same anchor and
      // end; the plan in force must be exactly that period.
      const span = quotaPeriod(plan, now);
      if (plan!.endsAt !== span.endsAt) deny("PLAN_UNAVAILABLE");
      // So the payment and the switch of price never straddle the renewal, the upgrade closes
      // shortly before it, and the session expires before the period ends.
      if (span.endsAt - now < PERIOD_CLOSING_MARGIN)
        deny("PERIOD_CLOSING", { availableAt: span.endsAt });
      kind = "upgrade";
      grantCents = offer.monthlyCents - current.monthlyCents;
      period = span.key;
      expiresAt = Math.min(now + day, span.endsAt - 5 * 60_000);
    } else {
      // A card plan in force whose renewal was cancelled: a new subscription would start a second
      // paid plan beside it. It renews by "Retomar renovação"; anything else waits for its end.
      if (
        current &&
        plan!.endsAt !== null &&
        current.monthlyCents > 0 &&
        (await paidByCard(ctx, plan!))
      )
        deny("PLAN_UNAVAILABLE", { availableAt: plan!.endsAt });
      // The first month in full, charged at the signing (#556): no credit, no proration.
      kind = "start";
      grantCents = offer.monthlyCents;
    }
    await allocateOffer(ctx, args.organizationId, args.tier, offer, { checkOnly: true });
    const id = await ctx.db.insert("billingCheckouts", {
      organizationId: args.organizationId,
      key: args.key,
      kind,
      tier: args.tier,
      ...(period !== undefined ? { period } : {}),
      grantCents,
      ...(annual ? { cycle: "annual" as const } : {}),
      state: "creating",
      expiresAt,
      requestedBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    return answer((await ctx.db.get("billingCheckouts", id))!);
  },
});

/** The first customer wins; a racing creation reuses it (same idempotency key at Stripe). */
export const saveCustomer = internalMutation({
  args: { ...scope, customerId: v.string(), livemode: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const prior = await accountOf(ctx, args.organizationId, args.livemode);
    if (prior) return prior.customerId;
    await ctx.db.insert("billingAccounts", {
      ...args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return args.customerId;
  },
});
export const saveCheckout = internalMutation({
  args: {
    checkoutId: v.id("billingCheckouts"),
    sessionId: v.string(),
    url: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("billingCheckouts", args.checkoutId);
    if (!row || row.state !== "creating") return null;
    await ctx.db.patch("billingCheckouts", row._id, {
      state: "open",
      sessionId: args.sessionId,
      url: args.url,
      expiresAt: args.expiresAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const dropCheckout = internalMutation({
  args: { checkoutId: v.id("billingCheckouts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("billingCheckouts", args.checkoutId);
    if (row && (row.state === "creating" || row.state === "open"))
      await ctx.db.patch("billingCheckouts", row._id, { state: "expired", updatedAt: Date.now() });
    return null;
  },
});

/** An instant as the console writes it (`formatUtcInstant`): "10/11/2026 às 12:00 UTC". */
function utcText(at: number) {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  const seconds = date.getUTCSeconds() ? `:${two(date.getUTCSeconds())}` : "";
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} às ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}${seconds} UTC`;
}

const metadata = (prefix: string, fields: Record<string, string | number>): Params =>
  Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [`${prefix}[${name}]`, String(value)]),
  );

/**
 * Opens a Stripe Checkout and returns its address. Paying there grants nothing by itself. The
 * annual one (`cycle: "annual"`) needs the verified yearly price of the tier.
 */
export const checkout = action({
  args: {
    ...scope,
    tier: paidTier,
    key: v.string(),
    cycle: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    start: v.optional(v.literal("upgrade")),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const cfg = await managerConfig(ctx, args.organizationId);
    const prepared = await ctx.runMutation(internal.billing.prepareCheckout, {
      ...args,
      livemode: cfg.livemode,
    });
    if (prepared.url) return { url: prepared.url };
    try {
      const { monthly: prices, annual: annualPrices } = await catalogPrices(cfg);
      const yearly = annualPrices[args.tier];
      // Without its yearly price the annual is not sold, nor the upgrade that renews at it; the
      // monthly is unaffected.
      if (prepared.annual && !yearly) throw new StripeApiError(0, "PRICE_MISMATCH");
      let customerId = prepared.customerId;
      if (!customerId) {
        const customer = await stripeApi(
          cfg,
          "POST",
          "/v1/customers",
          {
            name: prepared.organizationName,
            ...metadata("metadata", { organizationId: args.organizationId }),
          },
          `fnfe-customer:${args.organizationId}:${cfg.livemode ? "live" : "test"}`,
        );
        if (typeof customer.id !== "string") throw new StripeApiError(0, "MALFORMED");
        customerId = await ctx.runMutation(internal.billing.saveCustomer, {
          organizationId: args.organizationId,
          customerId: customer.id,
          livemode: cfg.livemode,
        });
      }
      const { siteUrl } = requirePlatformEnvironment();
      const back = `${siteUrl}/app/${encodeURIComponent(prepared.slug)}/usage?cobranca=`;
      const offer = PLATFORM_PLANS[args.tier];
      const marks = {
        organizationId: args.organizationId,
        kind: prepared.kind,
        tier: args.tier,
        // A start has none: its period is the one Stripe bills from the signing.
        ...(prepared.period !== undefined ? { period: prepared.period } : {}),
        grantCents: prepared.grantCents,
        // Read back by `invoiceGrant`: the first invoice of this subscription buys a term.
        ...(prepared.annual ? { cycle: ANNUAL_CYCLE } : {}),
      };
      const oneOff = (index: number, name: string): Params => ({
        [`line_items[${index}][price_data][currency]`]: "brl",
        [`line_items[${index}][price_data][unit_amount]`]: prepared.grantCents,
        [`line_items[${index}][price_data][product_data][name]`]: name,
        [`line_items[${index}][quantity]`]: 1,
      });
      const common: Params = {
        customer: customerId,
        client_reference_id: args.organizationId,
        locale: "pt-BR",
        "payment_method_types[0]": "card",
        success_url: `${back}retorno`,
        cancel_url: `${back}cancelado`,
        expires_at: Math.floor(prepared.expiresAt / 1000),
        ...metadata("metadata", marks),
      };
      const params: Params =
        prepared.kind === "upgrade"
          ? {
              ...common,
              mode: "payment",
              ...oneOff(
                0,
                prepared.annual
                  ? `Mudança para ${offer.name} anual, do mês do plano anual iniciado em ${utcText(periodStart(prepared.period))} ao fim do plano anual`
                  : `Mudança para ${offer.name}, diferença do mês do plano iniciado em ${utcText(periodStart(prepared.period))}`,
              ),
              "invoice_creation[enabled]": true,
              ...metadata("invoice_creation[invoice_data][metadata]", marks),
            }
          : {
              ...common,
              mode: "subscription",
              "line_items[0][price]": (prepared.annual ? yearly! : prices[args.tier]).priceId,
              "line_items[0][quantity]": 1,
              // Neither cycle has an anchor, one-off item, trial, coupon or proration (ADR 0012,
              // slices 2a and 2b): Stripe charges the whole month or year at the signing, anchors
              // the subscription there and renews it on each anniversary.
              ...metadata("subscription_data[metadata]", marks),
            };
      const session = await stripeApi(
        cfg,
        "POST",
        "/v1/checkout/sessions",
        params,
        `fnfe-checkout:${prepared.checkoutId}`,
      );
      const url = typeof session.url === "string" ? session.url : null;
      if (typeof session.id !== "string" || !url?.startsWith("https://"))
        throw new StripeApiError(0, "MALFORMED");
      await ctx.runMutation(internal.billing.saveCheckout, {
        checkoutId: prepared.checkoutId,
        sessionId: session.id,
        url,
        expiresAt:
          typeof session.expires_at === "number" ? session.expires_at * 1000 : prepared.expiresAt,
      });
      return { url };
    } catch (error) {
      // A definitive refusal frees the slot; a timeout keeps it for a retry with the same key.
      if (!(error instanceof StripeApiError)) throw error;
      if (error.definitive)
        await ctx.runMutation(internal.billing.dropCheckout, { checkoutId: prepared.checkoutId });
      console.error("billing.stripe", error.message);
      return deny("BILLING_UNAVAILABLE");
    }
  },
});

/** A downgrade, a cancellation or its undoing. Each takes effect at the next renewal only. */
export const prepareRenewal = internalMutation({
  args: {
    ...scope,
    change: v.union(paidTier, v.literal("cancel"), v.literal("resume")),
    livemode: v.boolean(),
  },
  returns: v.object({ subscriptionId: v.string() }),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    await assertPlanChangeable(ctx, args.organizationId);
    const account = await accountOf(ctx, args.organizationId, args.livemode);
    const subscription = account?.subscription;
    if (
      !account ||
      !subscription ||
      ["canceled", "incomplete_expired"].includes(subscription.status)
    )
      deny("SUBSCRIPTION_REQUIRED");
    if (args.change === "cancel" || args.change === "resume") {
      // Resuming a monthly subscription renews it into the months of a term in force. Resuming
      // the annual subscription whose invoices bought every term in force renews them. Any other
      // term in force, a Pix renewal scheduled after it included, would block that charge.
      if (
        args.change === "resume" &&
        (await termsInForce(ctx, args.organizationId, Date.now())).some(
          (term) => !(subscription.annual && term.stripeSubscriptionId === subscription.id),
        )
      )
        deny("ANNUAL_TERM_ACTIVE");
      // A subscription whose term was rescinded is being cancelled (`stopTermRenewal`): resuming
      // it would charge the year the client gave up.
      if (
        args.change === "resume" &&
        (await rescindedSubscription(ctx, args.organizationId, subscription.id))
      )
        deny("ANNUAL_TERM_RESCINDED");
      if (args.change === "resume" && (await pixPending(ctx, args.organizationId, Date.now())))
        deny("PLAN_REQUEST_PENDING");
      return { subscriptionId: subscription.id };
    }
    if (subscription.cancelAtPeriodEnd) deny("SUBSCRIPTION_CANCELLING");
    // The annual downgrade at renewal is not sold yet; the reconciliation never moves its price.
    if (subscription.annual) deny("PLAN_UNAVAILABLE");
    const renewal = account.renewalTier ?? subscription.tier;
    if (
      !renewal ||
      PLATFORM_PLANS[args.change].monthlyCents >= PLATFORM_PLANS[renewal].monthlyCents
    )
      deny("PLAN_UNAVAILABLE");
    // The lower plan must hold what the organization already keeps; nothing is deleted to fit.
    await allocateOffer(ctx, args.organizationId, args.change, PLATFORM_PLANS[args.change], {
      checkOnly: true,
    });
    await ctx.db.patch("billingAccounts", account._id, {
      renewalTier: args.change,
      updatedAt: Date.now(),
    });
    return { subscriptionId: subscription.id };
  },
});
export const changeRenewal = action({
  args: { ...scope, change: v.union(paidTier, v.literal("cancel"), v.literal("resume")) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cfg = await managerConfig(ctx, args.organizationId);
    const { subscriptionId } = await ctx.runMutation(internal.billing.prepareRenewal, {
      ...args,
      livemode: cfg.livemode,
    });
    await stripe(async () => {
      if (args.change === "cancel" || args.change === "resume")
        await stripeApi(cfg, "POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
          cancel_at_period_end: args.change === "cancel",
        });
      // The price itself follows `renewalTier` in the reconciliation.
      await syncOrganization(ctx, args.organizationId, cfg);
    });
    return null;
  },
});

export const portalTarget = internalMutation({
  args: { ...scope, livemode: v.boolean() },
  returns: v.object({ customerId: v.string(), slug: v.string() }),
  handler: async (ctx, args) => {
    const { membership, organization } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const account = await accountOf(ctx, args.organizationId, args.livemode);
    if (!account) return deny("SUBSCRIPTION_REQUIRED");
    return { customerId: account.customerId, slug: organization.slug };
  },
});
/** Card and invoices only. Never expose a portal that can bypass the console's renewal guards. */
export const portal = action({
  args: scope,
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const cfg = await managerConfig(ctx, args.organizationId);
    const target = await ctx.runMutation(internal.billing.portalTarget, {
      ...args,
      livemode: cfg.livemode,
    });
    const { siteUrl } = requirePlatformEnvironment();
    return stripe(async () => {
      const session = await stripeApi(cfg, "POST", "/v1/billing_portal/sessions", {
        customer: target.customerId,
        locale: "pt-BR",
        return_url: `${siteUrl}/app/${encodeURIComponent(target.slug)}/usage`,
        "expand[0]": "configuration",
      });
      return { url: readPortalSession(session, target.customerId, cfg.livemode) };
    });
  },
});

export const prepareRefresh = internalMutation({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { membership, user } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    await limitOrganizationAction(ctx, "billing-refresh", user._id, 5);
    return null;
  },
});
/** "Conferir pagamento": reads Stripe again. Used on return from Checkout and after a missed event. */
export const refresh = action({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cfg = await managerConfig(ctx, args.organizationId);
    await ctx.runMutation(internal.billing.prepareRefresh, args);
    await stripe(() => syncOrganization(ctx, args.organizationId, cfg));
    return null;
  },
});

export const prepareAbandon = internalMutation({
  args: scope,
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const row = await openCheckout(ctx, args.organizationId, Date.now());
    if (!row) return null;
    if (!row.sessionId) {
      await ctx.db.patch("billingCheckouts", row._id, { state: "expired", updatedAt: Date.now() });
      return null;
    }
    return row.sessionId;
  },
});
/** Expires the open Checkout at Stripe, so nobody can still pay it, then frees Pix again. */
export const abandonCheckout = action({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cfg = await managerConfig(ctx, args.organizationId);
    const sessionId = await ctx.runMutation(internal.billing.prepareAbandon, args);
    if (!sessionId) return null;
    await stripe(async () => {
      try {
        await stripeApi(
          cfg,
          "POST",
          `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        );
      } catch (error) {
        // Already complete or expired: the reconciliation below reads which.
        if (!(error instanceof StripeApiError && error.status === 400)) throw error;
      }
      await syncOrganization(ctx, args.organizationId, cfg);
    });
    return null;
  },
});

export const syncTarget = internalQuery({
  args: { ...scope, livemode: v.boolean() },
  returns: v.union(v.null(), v.object({ customerId: v.string(), sessions: v.array(v.string()) })),
  handler: async (ctx, args) => {
    const account = await accountOf(ctx, args.organizationId, args.livemode);
    if (!account) return null;
    const open = await ctx.db
      .query("billingCheckouts")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", args.organizationId).eq("state", "open"),
      )
      .take(5);
    return {
      customerId: account.customerId,
      sessions: open.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
    };
  },
});

const priceValue = v.object({ priceId: v.string(), productId: v.string() });
const pricesValue = v.object({ intermediate: priceValue, large: priceValue });
/**
 * Applies what Stripe says now. The facts are read fresh from the API, so the order in which
 * the webhooks arrived does not matter, and each invoice is weighed once.
 */
export const reconcile = internalMutation({
  args: {
    ...scope,
    livemode: v.boolean(),
    customerId: v.string(),
    subscription: v.union(subscriptionFacts, v.null()),
    duplicates: v.boolean(),
    invoices: v.array(invoiceFacts),
    prices: pricesValue,
    annualPrices: pricesValue.partial(),
    annualSubscriptions: v.array(v.string()),
    /** The `billing_cycle_anchor` of each subscription of the customer, in ms (invariant 6). */
    anchors: v.array(v.object({ subscriptionId: v.string(), anchor: v.number() })),
    sessions: v.array(v.object({ sessionId: v.string(), status: v.string() })),
  },
  returns: v.union(
    v.null(),
    v.object({
      subscriptionId: v.string(),
      itemId: v.string(),
      priceId: v.string(),
      key: v.string(),
      /** An annual subscription keeps its anchor: the renewal date does not move. */
      annual: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const first = await accountOf(ctx, args.organizationId, args.livemode);
    if (!first || first.customerId !== args.customerId) return null;
    const anchors = Object.fromEntries(
      args.anchors.map((item) => [item.subscriptionId, item.anchor]),
    );
    // Oldest first, so a renewal never lands before the month it follows.
    for (const invoice of [...args.invoices].reverse())
      await applyInvoice(
        ctx,
        first,
        invoice,
        args.prices,
        args.annualPrices,
        args.annualSubscriptions,
        anchors,
      );
    for (const session of args.sessions) {
      if (session.status !== "complete" && session.status !== "expired") continue;
      const row = await ctx.db
        .query("billingCheckouts")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session.sessionId))
        .unique();
      if (row?.organizationId !== args.organizationId || row.state !== "open") continue;
      // A finished session frees the slot for the next one. It grants nothing: every start,
      // monthly or annual, is charged at the signing, and its paid invoice is what grants.
      await ctx.db.patch("billingCheckouts", row._id, {
        state: session.status,
        updatedAt: Date.now(),
      });
    }
    const account = (await ctx.db.get("billingAccounts", first._id))!;
    const sub = args.subscription;
    const priced = sub ? pricedTier(args.prices, args.annualPrices, sub.priceId) : null;
    const tier = priced?.tier ?? null;
    const annual = !!sub && (sub.annual || priced?.cycle === "annual");
    // A new subscription renews at the price its Checkout chose.
    const renewalTier =
      sub && sub.id !== account.subscription?.id
        ? (tier ?? account.renewalTier)
        : account.renewalTier;
    const open = args.invoices.find(
      (invoice) => invoice.status === "open" && invoice.attempted && invoice.amountDue > 0,
    );
    const now = Date.now();
    await ctx.db.replace("billingAccounts", account._id, {
      organizationId: account.organizationId,
      customerId: account.customerId,
      livemode: account.livemode,
      ...(renewalTier ? { renewalTier } : {}),
      ...(sub
        ? {
            subscription: {
              id: sub.id,
              status: sub.status,
              tier,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              periodEnd: sub.periodEnd,
              ...(annual ? { annual: true as const } : {}),
            },
          }
        : {}),
      ...(open
        ? { openInvoice: { id: open.id, amountDueCents: open.amountDue, url: open.hostedUrl } }
        : {}),
      syncedAt: now,
      ...(args.duplicates ? { syncError: "SUBSCRIPTION_DUPLICATE" } : {}),
      createdAt: account.createdAt,
      updatedAt: now,
    });
    // A monthly subscription, even at a price that no longer verifies, moves to the verified
    // price of `renewalTier`. An annual one never moves to a monthly price, verified or not
    // (`annual` reads the yearly lookup key or interval): it would reset the anchor and charge at
    // once. Its renewal invoice stays `PRICE_UNKNOWN` until the yearly price verifies again.
    if (
      !sub ||
      !sub.itemId ||
      !renewalTier ||
      tier === renewalTier ||
      sub.cancelAtPeriodEnd ||
      ["canceled", "incomplete_expired"].includes(sub.status)
    )
      return null;
    if (annual) {
      // After an annual upgrade: up, from a verified yearly price to the verified yearly price
      // of the tier that a term bought by this subscription already reached, so its renewal is
      // the larger tier (ADR 0010, decision 9). Down only after that upgrade was withdrawn within
      // 7 days (`plans:undoTermUpgrade`): back to the yearly price of the tier the term returned
      // to. Never to a monthly price.
      const yearly = args.annualPrices[renewalTier];
      if (priced?.cycle !== "annual" || !yearly) return null;
      const up = PLATFORM_PLANS[renewalTier].annualCents > PLATFORM_PLANS[priced.tier].annualCents;
      if (
        !(await termsInForce(ctx, args.organizationId, now)).some(
          (term) =>
            term.stripeSubscriptionId === sub.id &&
            termTierAt(term, now) === renewalTier &&
            (up ||
              !!term.undoneUpgrades?.some(
                (undone) => undone.tier === priced.tier && undone.fromTier === renewalTier,
              )),
        )
      )
        return null;
      return {
        subscriptionId: sub.id,
        itemId: sub.itemId,
        priceId: yearly.priceId,
        key: `fnfe-renewal:${sub.id}:${yearly.priceId}:${account.updatedAt}`,
        annual: true,
      };
    }
    const priceId = args.prices[renewalTier].priceId;
    return {
      subscriptionId: sub.id,
      itemId: sub.itemId,
      priceId,
      key: `fnfe-renewal:${sub.id}:${priceId}:${account.updatedAt}`,
      annual: false,
    };
  },
});

async function syncOrganization(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  organizationId: Id<"organizations">,
  cfg: BillingConfig,
) {
  for (let round = 0; round < 2; round++) {
    const target = await ctx.runQuery(internal.billing.syncTarget, {
      organizationId,
      livemode: cfg.livemode,
    });
    if (!target) return;
    const { monthly: prices, annual: annualPrices } = await catalogPrices(cfg);
    const [subscriptions, invoices, sessions] = await Promise.all([
      stripeApi(cfg, "GET", "/v1/subscriptions", {
        customer: target.customerId,
        status: "all",
        limit: 10,
      }),
      stripeApi(cfg, "GET", "/v1/invoices", { customer: target.customerId, limit: 20 }),
      Promise.all(
        target.sessions.map(async (sessionId) => {
          const session = await stripeApi(
            cfg,
            "GET",
            `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
          );
          return {
            sessionId,
            status: typeof session.status === "string" ? session.status : "",
          };
        }),
      ),
    ]);
    const { current, duplicates, annualIds, anchors } = readSubscriptions(
      subscriptions,
      target.customerId,
    );
    const facts = readInvoices(invoices).filter(
      (invoice) => invoice.customerId === target.customerId,
    );
    // The list holds at most 10 subscriptions, and one created while it was read (a Checkout
    // completing) may be missing: an invoice's own subscription is then read by its id, so its
    // anchor is known. One that failed to load, or came without an anchor, leaves the invoice for
    // the next reconciliation; one Stripe says is gone (404), or another customer's, never will
    // anchor it, so it gets the anchor -1, which no line matches: the paid invoice goes to review
    // (`INVOICE_UNEXPECTED`) instead of waiting forever.
    const missing = new Set(
      facts.flatMap((invoice) =>
        invoice.subscriptionId &&
        !anchors.some((item) => item.subscriptionId === invoice.subscriptionId)
          ? [invoice.subscriptionId]
          : [],
      ),
    );
    for (const subscriptionId of missing) {
      let body: Record<string, unknown>;
      try {
        body = await stripeApi(
          cfg,
          "GET",
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
      } catch (error) {
        if (error instanceof StripeApiError && error.status === 404) {
          anchors.push({ subscriptionId, anchor: -1 });
          continue;
        }
        throw error;
      }
      // Another customer's subscription never anchors this one's invoice.
      const customer = typeof body.customer === "string" ? body.customer : null;
      if (customer !== null && customer !== target.customerId)
        anchors.push({ subscriptionId, anchor: -1 });
      else anchors.push(...readSubscriptions({ data: [body] }, target.customerId).anchors);
    }
    const change = await ctx.runMutation(internal.billing.reconcile, {
      organizationId,
      livemode: cfg.livemode,
      customerId: target.customerId,
      subscription: current,
      duplicates,
      invoices: facts,
      prices,
      annualPrices,
      annualSubscriptions: annualIds,
      anchors,
      sessions,
    });
    if (!change) return;
    // Without proration: the period already paid keeps its plan, the next one bills the new
    // price. Both cycles say so explicitly: same interval, same anchor, so the renewal stays on
    // the anniversary of the signing (ADR 0012).
    await stripeApi(
      cfg,
      "POST",
      `/v1/subscriptions/${encodeURIComponent(change.subscriptionId)}`,
      {
        "items[0][id]": change.itemId,
        "items[0][price]": change.priceId,
        proration_behavior: "none",
        billing_cycle_anchor: "unchanged",
      },
      change.key,
    );
  }
}

/** Scheduled after each paid period and by the events; quietly does nothing without billing. */
export const sync = internalAction({
  args: scope,
  returns: v.null(),
  handler: async (ctx, args) => {
    const cfg = config();
    if (cfg) await syncOrganization(ctx, args.organizationId, cfg);
    return null;
  },
});

const MAX_EVENT_ATTEMPTS = 8;
/** Records an authenticated event once. Its processing reads Stripe again, so order is moot. */
export const recordEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    objectId: v.string(),
    customerId: v.optional(v.string()),
    chargeId: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    review: v.optional(v.string()),
    modeMatches: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (
      await ctx.db
        .query("billingEvents")
        .withIndex("by_stripeEventId", (q) => q.eq("stripeEventId", args.stripeEventId))
        .first()
    )
      return false;
    const account = args.customerId
      ? await ctx.db
          .query("billingAccounts")
          .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId!))
          .first()
      : null;
    const { review, modeMatches, ...fields } = args;
    const now = Date.now();
    const ignored = !modeMatches ? "LIVEMODE_MISMATCH" : null;
    const id = await ctx.db.insert("billingEvents", {
      ...fields,
      ...(account ? { organizationId: account.organizationId } : {}),
      state: ignored ? "ignored" : "received",
      ...(ignored ? { code: ignored } : review ? { code: review } : {}),
      review: false,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (!ignored) await ctx.scheduler.runAfter(0, internal.billing.processEvent, { eventId: id });
    return true;
  },
});
export const eventTarget = internalQuery({
  args: { eventId: v.id("billingEvents") },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.union(v.id("organizations"), v.null()),
      chargeId: v.union(v.string(), v.null()),
      customerId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("billingEvents", args.eventId);
    if (!event || event.state !== "received") return null;
    return {
      organizationId: event.organizationId ?? null,
      chargeId: event.chargeId ?? null,
      customerId: event.customerId ?? null,
    };
  },
});
/**
 * Ends one event. A refund or a dispute of a known customer waits for a person; it never moves
 * the plan by itself (decision of 28/10/2026). An unknown customer is not ours to act upon.
 */
export const finishEvent = internalMutation({
  args: {
    eventId: v.id("billingEvents"),
    customerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("billingEvents", args.eventId);
    if (!event || event.state !== "received") return null;
    const now = Date.now();
    if (args.error) {
      const attempts = event.attempts + 1;
      if (attempts >= MAX_EVENT_ATTEMPTS) {
        await ctx.db.patch("billingEvents", event._id, {
          state: "failed",
          code: args.error,
          attempts,
          updatedAt: now,
        });
        return null;
      }
      await ctx.db.patch("billingEvents", event._id, { attempts, updatedAt: now });
      await ctx.scheduler.runAfter(
        Math.min(60_000 * 4 ** (attempts - 1), 6 * 60 * 60_000),
        internal.billing.processEvent,
        { eventId: event._id },
      );
      return null;
    }
    let organizationId = event.organizationId;
    if (!organizationId && args.customerId) {
      const account = await ctx.db
        .query("billingAccounts")
        .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId!))
        .first();
      organizationId = account?.organizationId;
    }
    const review =
      !!organizationId &&
      ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"].includes(event.type);
    await ctx.db.patch("billingEvents", event._id, {
      ...(organizationId ? { organizationId } : {}),
      ...(args.customerId && !event.customerId ? { customerId: args.customerId } : {}),
      state: organizationId ? "processed" : "ignored",
      ...(organizationId ? {} : { code: "UNKNOWN_CUSTOMER" }),
      review,
      attempts: event.attempts + 1,
      updatedAt: now,
    });
    return null;
  },
});
export const processEvent = internalAction({
  args: { eventId: v.id("billingEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.billing.eventTarget, args);
    if (!target) return null;
    const cfg = config();
    if (!cfg) {
      await ctx.runMutation(internal.billing.finishEvent, { ...args, error: "BILLING_DISABLED" });
      return null;
    }
    try {
      let customerId = target.customerId ?? undefined;
      // A dispute names only the charge; the charge names the customer.
      if (!customerId && target.chargeId) {
        const charge = await stripeApi(
          cfg,
          "GET",
          `/v1/charges/${encodeURIComponent(target.chargeId)}`,
        );
        if (typeof charge.customer === "string") customerId = charge.customer;
      }
      const organizationId =
        target.organizationId ??
        (customerId
          ? await ctx.runQuery(internal.billing.organizationOfCustomer, { customerId })
          : null);
      if (organizationId) await syncOrganization(ctx, organizationId, cfg);
      await ctx.runMutation(internal.billing.finishEvent, { ...args, customerId });
    } catch (error) {
      const code = error instanceof StripeApiError ? error.message : "SYNC_FAILED";
      console.error("billing.event", code);
      await ctx.runMutation(internal.billing.finishEvent, { ...args, error: code });
    }
    return null;
  },
});
export const organizationOfCustomer = internalQuery({
  args: { customerId: v.string() },
  returns: v.union(v.null(), v.id("organizations")),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("billingAccounts")
        .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
        .first()
    )?.organizationId ?? null,
});

/** The operator settles a refund, dispute or blocked payment outside the platform, then marks it. */
export const resolveReview = internalMutation({
  args: {
    eventId: v.optional(v.id("billingEvents")),
    grantId: v.optional(v.id("billingGrants")),
    actor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    if (
      !args.actor.trim() ||
      args.actor.length > 120 ||
      [args.eventId, args.grantId].filter(Boolean).length !== 1
    )
      deny("INVALID_REQUEST");
    if (args.eventId) {
      const event = await ctx.db.get("billingEvents", args.eventId);
      if (!event) deny("NOT_FOUND");
      await ctx.db.patch("billingEvents", event._id, {
        review: false,
        resolvedBy: args.actor,
        updatedAt: Date.now(),
      });
    } else {
      const grant = await ctx.db.get("billingGrants", args.grantId!);
      if (!grant || !needsPerson(grant)) deny("NOT_FOUND");
      await ctx.db.patch("billingGrants", grant._id, { resolvedBy: args.actor });
    }
    return null;
  },
});

export const closureTargets = internalQuery({
  args: scope,
  returns: v.array(v.object({ livemode: v.boolean() })),
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("billingAccounts")
      .withIndex("by_organizationId_and_livemode", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .take(2);
    return accounts.filter(renews).map((account) => ({ livemode: account.livemode }));
  },
});
/**
 * A closed organization is not charged again. The subscription ends at once, without an
 * automatic refund of the month already paid (refunds are a person's decision).
 */
export const stopForClosure = internalAction({
  args: { ...scope, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cfg = config();
    if (!cfg) return null;
    const targets = await ctx.runQuery(internal.billing.closureTargets, {
      organizationId: args.organizationId,
    });
    if (!targets.some((target) => target.livemode === cfg.livemode)) return null;
    try {
      const target = await ctx.runQuery(internal.billing.syncTarget, {
        organizationId: args.organizationId,
        livemode: cfg.livemode,
      });
      if (!target) return null;
      const body = await stripeApi(cfg, "GET", "/v1/subscriptions", {
        customer: target.customerId,
        status: "all",
        limit: 10,
      });
      for (const subscription of readSubscriptions(body, target.customerId).live)
        await stripeApi(cfg, "DELETE", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`);
      await syncOrganization(ctx, args.organizationId, cfg);
    } catch (error) {
      if (!(error instanceof StripeApiError) || args.attempt >= 5) throw error;
      await ctx.runMutation(internal.billing.retryClosure, args);
    }
    return null;
  },
});
/**
 * Cancels the subscription `subscriptionId` at once, without proration or refund, when Stripe
 * still has it live for `customerId`. One already ended, unknown to Stripe or of another Customer
 * is left alone, so a repeat does nothing new.
 */
async function cancelSubscription(cfg: BillingConfig, customerId: string, subscriptionId: string) {
  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  let subscription: Record<string, unknown> | null = null;
  try {
    subscription = await stripeApi(cfg, "GET", path);
  } catch (error) {
    // Unknown to Stripe: nothing left to charge.
    if (!(error instanceof StripeApiError && error.status === 404)) throw error;
  }
  const customer = subscription?.customer;
  const status = subscription?.status;
  if (
    subscription &&
    (customer === customerId ||
      (typeof customer === "object" &&
        customer !== null &&
        (customer as { id?: unknown }).id === customerId)) &&
    typeof status === "string" &&
    !ENDED_STATUSES.includes(status)
  )
    await stripeApi(cfg, "DELETE", path);
}
/** Retries before `stopTermRenewal` gives up and flags it for a person. */
const STOP_ATTEMPTS = 5;
/**
 * A rescinded card term is not renewed (`plans:rescindTerm`): the annual subscription that bought
 * it is cancelled at once, without proration or refund, as on closure. The refund is a person's
 * statement apart (`plans:recordTermRefund`). Only that subscription goes, read by its id; one
 * already ended, or of another Customer, is left alone, so a repeat does nothing new. A Stripe
 * failure is retried with a growing wait; after the last attempt the rescinded term is flagged
 * (`renewalStopFailed`, `SUBSCRIPTION_STOP_FAILED` in `billing:overview`), and the operator runs
 * this again with `attempt: 0`, which clears the flag once the subscription is cancelled.
 */
export const stopTermRenewal = internalAction({
  args: { ...scope, subscriptionId: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cfg = config();
    if (!cfg) return null;
    try {
      const target = await ctx.runQuery(internal.billing.syncTarget, {
        organizationId: args.organizationId,
        livemode: cfg.livemode,
      });
      if (!target) return null;
      await cancelSubscription(cfg, target.customerId, args.subscriptionId);
      await ctx.runMutation(internal.billing.markRenewalStop, {
        organizationId: args.organizationId,
        subscriptionId: args.subscriptionId,
        code: null,
      });
      await syncOrganization(ctx, args.organizationId, cfg);
    } catch (error) {
      if (!(error instanceof StripeApiError)) throw error;
      console.error("billing.stopTermRenewal", error.message);
      if (args.attempt >= STOP_ATTEMPTS)
        await ctx.runMutation(internal.billing.markRenewalStop, {
          organizationId: args.organizationId,
          subscriptionId: args.subscriptionId,
          code: "SUBSCRIPTION_STOP_FAILED",
        });
      else await ctx.runMutation(internal.billing.retryTermRenewalStop, args);
    }
    return null;
  },
});
export const retryTermRenewalStop = internalMutation({
  args: { ...scope, subscriptionId: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      15 * 60_000 * (args.attempt + 1),
      internal.billing.stopTermRenewal,
      { ...args, attempt: args.attempt + 1 },
    );
    return null;
  },
});
export const markRenewalStop = internalMutation({
  args: { ...scope, subscriptionId: v.string(), code: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markTermRenewalStop(ctx, args.organizationId, args.subscriptionId, args.code);
    return null;
  },
});

/**
 * Expires at Stripe the upgrade Checkout a rescission closed (`plans:rescindTerm`), as
 * `abandonCheckout` does, so nobody pays it afterwards. A session already complete or expired is
 * read back by the reconciliation; a payment that still got through raises nothing, because the
 * term is no longer in force, and waits as a blocked invoice for a person.
 */
export const expireCheckout = internalAction({
  args: { ...scope, sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cfg = config();
    if (!cfg) return null;
    try {
      await stripeApi(
        cfg,
        "POST",
        `/v1/checkout/sessions/${encodeURIComponent(args.sessionId)}/expire`,
      );
    } catch (error) {
      if (!(error instanceof StripeApiError && error.status === 400)) throw error;
    }
    await syncOrganization(ctx, args.organizationId, cfg);
    return null;
  },
});
export const retryClosure = internalMutation({
  args: { ...scope, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      15 * 60_000 * (args.attempt + 1),
      internal.billing.stopForClosure,
      {
        organizationId: args.organizationId,
        attempt: args.attempt + 1,
      },
    );
    return null;
  },
});
