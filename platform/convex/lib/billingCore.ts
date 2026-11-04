import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { PLATFORM_PLANS, isCatalogTier } from "./planCatalog";
import { activateCatalogPlan, allocateOffer, startTerm, upgradeTerm } from "./planCore";
import { denialCode } from "./organizationAccess";
import {
  annualTermBlocks,
  monthlyBlockedByTerm,
  rescindedSubscription,
  termTierAt,
  termUpgradeCents,
  upgradableTerm,
} from "./planTerms";
import { isTermReference, termEndsAt, termMonthStart } from "./annualTerms";
import { planFor } from "./usageCore";
import { nextUsagePeriodStart, planEnded } from "./usageValues";
import {
  ENDED_STATUSES,
  invoiceGrant,
  type AnnualPrices,
  type CatalogPrices,
  type InvoiceFacts,
  type PaidTier,
} from "./billingStripe";

/** Checks for a renewal missed by the webhooks this long after each paid period ends. */
export const RENEWAL_CHECK_DELAY = 2 * 60 * 60 * 1000;
/**
 * The card annual upgrade is refused this close to the term's end (`PERIOD_CLOSING`): a session
 * paid at its 24 h expiry still leaves 48 h for the price switch before Stripe bills the renewal.
 */
export const UPGRADE_SWITCH_MARGIN = 72 * 60 * 60 * 1000;
/**
 * A grant a person must settle: a blocked payment, or an applied renewal charged below what an
 * annual upgrade bought (`RENEWAL_BELOW_UPGRADE`). Other applied or skipped grants need nobody.
 */
export const needsPerson = (grant: Pick<Doc<"billingGrants">, "state" | "code">) =>
  grant.state === "blocked" ||
  (grant.state === "applied" && grant.code === "RENEWAL_BELOW_UPGRADE");
/** A Checkout Session whose creation never answered is abandoned after this, never reused. */
export const CREATING_TTL = 10 * 60 * 1000;
/**
 * The admission of a completed annual start is checked again this long before its anchor, so a
 * refusal still cancels the subscription before Stripe bills it: the five retries of the
 * cancellation add up to 3 h 45 min.
 */
export const ADMISSION_RECHECK_MARGIN = 6 * 60 * 60 * 1000;

/**
 * The admission of a completed annual start Checkout (ADR 0010, D3), as the invoice of its 1st
 * will weigh it: `reserve` takes the stock of the tier now, as the annual Pix `next` does on its
 * confirmation, so the admission window, the stock and the other sales cannot refuse that
 * invoice afterwards (`allocateOffer` only raises a reservation); `recheck` writes nothing and
 * reads what can still refuse it: the catalog switch, the usage, the capacity inventory, an
 * archiving under way and a custom plan. A closed organization, or one being closed, is refused
 * with `ORGANIZATION_CLOSED` before anything is reserved: the closure cancels its subscription
 * anyway (`billing:stopForClosure`). Returns the denial code, or null when admitted.
 */
export async function admitAnnualCheckout(
  ctx: MutationCtx,
  row: Pick<Doc<"billingCheckouts">, "organizationId" | "tier">,
  mode: "reserve" | "recheck",
): Promise<string | null> {
  if (
    await ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", row.organizationId))
      .unique()
  )
    return "ORGANIZATION_CLOSED";
  if ((await planFor(ctx, row.organizationId))?.catalogTier === "custom") return "PLAN_CUSTOM";
  try {
    // Every denial comes before the first write, so a refusal reserves nothing.
    await allocateOffer(ctx, row.organizationId, row.tier, PLATFORM_PLANS[row.tier], {
      checkOnly: mode === "recheck",
    });
    return null;
  } catch (error) {
    const code = denialCode(error);
    if (!code) throw error;
    return code;
  }
}

export const accountOf = (ctx: QueryCtx, organizationId: Id<"organizations">, livemode: boolean) =>
  ctx.db
    .query("billingAccounts")
    .withIndex("by_organizationId_and_livemode", (q) =>
      q.eq("organizationId", organizationId).eq("livemode", livemode),
    )
    .unique();

/** A card subscription that Stripe will charge again at the end of the period. */
export const renews = (account: Doc<"billingAccounts"> | null) =>
  !!account?.subscription &&
  !ENDED_STATUSES.includes(account.subscription.status) &&
  !account.subscription.cancelAtPeriodEnd;

export async function openCheckout(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  for (const state of ["open", "creating"] as const) {
    const rows = await ctx.db
      .query("billingCheckouts")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", state),
      )
      .take(10);
    const live = rows.find((row) =>
      state === "open" ? row.expiresAt > now : row.createdAt + CREATING_TTL > now,
    );
    if (live) return live;
  }
  return null;
}

/**
 * Pix and card never bill the same organization at once: a Pix request waits while a card
 * subscription will renew or a Checkout is open, in either Stripe mode.
 */
export async function cardBlocksPix(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_organizationId_and_livemode", (q) => q.eq("organizationId", organizationId))
    .take(2);
  return accounts.some(renews) || !!(await openCheckout(ctx, organizationId, Date.now()));
}

export const periodStart = (period: string) =>
  Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1);

/** Records how one invoice was weighed, once (`billingGrants`). */
type GrantRecord = (
  state: Doc<"billingGrants">["state"],
  code?: string,
  planVersion?: number,
  termId?: Id<"platformPlanTerms">,
) => Promise<unknown>;

/**
 * Weighs one paid invoice exactly once (`billingGrants.invoiceId`), whatever the order or the
 * number of times Stripe or the reconciliation shows it. It never shortens a plan already in
 * force, never sells the same month twice and never drops a payment silently: what cannot be
 * applied stays `blocked` for a person.
 */
export async function applyInvoice(
  ctx: MutationCtx,
  account: Doc<"billingAccounts">,
  invoice: InvoiceFacts,
  prices: CatalogPrices,
  annual: AnnualPrices = {},
  annualSubscriptions: readonly string[] = [],
) {
  if (invoice.customerId !== account.customerId) return;
  if (
    await ctx.db
      .query("billingGrants")
      .withIndex("by_invoiceId", (q) => q.eq("invoiceId", invoice.id))
      .first()
  )
    return;
  const organizationId = account.organizationId;
  const decision = invoiceGrant(invoice, prices, organizationId, annual, annualSubscriptions);
  // An unpaid invoice may still be paid: it is weighed again on the next reconciliation.
  if (decision.kind === "none" && decision.code === "NOT_PAID") return;
  const now = Date.now();
  const bought =
    decision.kind === "grant" || decision.kind === "annual" || decision.kind === "annualUpgrade";
  const record: GrantRecord = (state, code, planVersion, termId) =>
    ctx.db.insert("billingGrants", {
      organizationId,
      invoiceId: invoice.id,
      tier: bought ? decision.tier : null,
      period: bought ? decision.period : null,
      amountCents: invoice.amountPaid,
      state,
      ...(code ? { code } : {}),
      ...(planVersion !== undefined ? { planVersion } : {}),
      ...(termId ? { termId } : {}),
      createdAt: now,
    });
  if (decision.kind === "none") return void (await record("skipped", decision.code));
  if (decision.kind === "review") return void (await record("blocked", decision.code));
  if (decision.kind === "annual")
    return applyAnnualInvoice(ctx, account, invoice, decision.tier, decision.period, now, record);
  if (decision.kind === "annualUpgrade")
    return applyAnnualUpgrade(
      ctx,
      account,
      invoice,
      decision.tier,
      decision.period,
      now,
      record,
      annualSubscriptions,
    );
  // A monthly invoice. The activation below runs from now to the end of the month paid for; an
  // annual term overlapping it would be shortened, so the money was paid but cannot be granted: a
  // person looks at it, never `SUPERSEDED`, instead of `activateCatalogPlan` failing the sync. A
  // month that ends before a term scheduled for later is still granted.
  const end = nextUsagePeriodStart(periodStart(decision.period));
  if (await monthlyBlockedByTerm(ctx, organizationId, now, end))
    return void (await record("blocked", "ANNUAL_TERM_ACTIVE"));
  // Paid after the month it bought: no quota is sold for the past.
  if (end <= now) return void (await record("blocked", "LATE_PAYMENT"));
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (closure) return void (await record("blocked", "ORGANIZATION_CLOSED"));
  const plan = await planFor(ctx, organizationId);
  if (plan?.catalogTier === "custom") return void (await record("blocked", "PLAN_CUSTOM"));
  const active = plan && plan.startsAt <= now && !planEnded(plan, now);
  if (active && plan.endsAt !== null && plan.endsAt > end)
    return void (await record("skipped", "SUPERSEDED"));
  if (
    active &&
    plan.endsAt === end &&
    plan.catalogTier &&
    isCatalogTier(plan.catalogTier) &&
    PLATFORM_PLANS[plan.catalogTier].monthlyCents >= PLATFORM_PLANS[decision.tier].monthlyCents
  )
    return void (await record("blocked", "DUPLICATE_PAYMENT"));
  try {
    // Checks every admission rule before any write, so a refusal leaves nothing behind.
    await allocateOffer(ctx, organizationId, decision.tier, PLATFORM_PLANS[decision.tier], {
      checkOnly: true,
    });
  } catch (error) {
    const code = denialCode(error);
    if (!code) throw error;
    return void (await record("blocked", code));
  }
  await activateCatalogPlan(
    ctx,
    organizationId,
    decision.tier,
    now,
    end,
    plan?.version ?? 0,
    `stripe:${invoice.id}`,
    "Pagamento por cartão confirmado (Stripe)",
  );
  await record("applied", undefined, (plan?.version ?? 0) + 1);
  // An upgrade paid by card also raises what the subscription renews at.
  if (invoice.metadata.kind === "upgrade")
    await ctx.db.patch("billingAccounts", account._id, {
      renewalTier: decision.tier,
      updatedAt: now,
    });
  await ctx.scheduler.runAt(end + RENEWAL_CHECK_DELAY, internal.billing.sync, { organizationId });
}

/**
 * A paid annual invoice becomes one term (ADR 0010, decision 9), as a confirmed annual Pix does:
 * the first invoice for the marked month, a renewal for the month its line starts, which is the
 * previous term's `endsAt`, so the renewal leaves no gap. The annual switch is not checked: it
 * stops new sales, and this money was taken. Admission still is, and every refusal is `blocked`.
 *
 * A renewal below the tier the term it follows reached (an annual upgrade whose price switch did
 * not reach Stripe before the anchor) is granted at the tier it charged, since that is the money
 * taken, but recorded with `RENEWAL_BELOW_UPGRADE` for a person, who charges the difference or
 * refunds; the account then renews at that tier, as Stripe does.
 */
async function applyAnnualInvoice(
  ctx: MutationCtx,
  account: Doc<"billingAccounts">,
  invoice: InvoiceFacts,
  tier: PaidTier,
  period: string,
  now: number,
  record: GrantRecord,
) {
  const organizationId = account.organizationId;
  const firstPeriod = periodStart(period);
  const endsAt = termEndsAt(firstPeriod);
  const paidAt = invoice.paidAt ?? now;
  // The Pix `payBy`: the whole term only if paid within its first term month.
  if (paidAt >= termMonthStart(firstPeriod, 1) || now >= endsAt)
    return void (await record("blocked", "LATE_PAYMENT"));
  // As the Pix request, a term starts this month or the next; the term keeps the invoice id.
  if (firstPeriod > nextUsagePeriodStart(now) || !isTermReference(invoice.id))
    return void (await record("blocked", "INVOICE_UNEXPECTED"));
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (closure) return void (await record("blocked", "ORGANIZATION_CLOSED"));
  const plan = await planFor(ctx, organizationId);
  if (plan?.catalogTier === "custom") return void (await record("blocked", "PLAN_CUSTOM"));
  if (await annualTermBlocks(ctx, organizationId, firstPeriod, now))
    return void (await record("blocked", "ANNUAL_TERM_ACTIVE"));
  // The subscription of a rescinded term should have been cancelled (`stopTermRenewal`); a year
  // it still charged is not a new term, the money waits for a refund.
  if (
    invoice.subscriptionId &&
    (await rescindedSubscription(ctx, organizationId, invoice.subscriptionId))
  )
    return void (await record("blocked", "ANNUAL_TERM_RESCINDED"));
  // Starting now replaces the month in force: as the Pix `now`, never with a lower tier.
  if (
    firstPeriod <= now &&
    plan &&
    plan.startsAt <= now &&
    !planEnded(plan, now) &&
    plan.catalogTier &&
    isCatalogTier(plan.catalogTier) &&
    PLATFORM_PLANS[plan.catalogTier].monthlyCents > PLATFORM_PLANS[tier].monthlyCents
  )
    return void (await record("blocked", "PLAN_UNAVAILABLE"));
  try {
    await allocateOffer(ctx, organizationId, tier, PLATFORM_PLANS[tier], { checkOnly: true });
  } catch (error) {
    const code = denialCode(error);
    if (!code) throw error;
    return void (await record("blocked", code));
  }
  const version = plan?.version ?? 0;
  const termId = await startTerm(
    ctx,
    {
      organizationId,
      tier,
      firstPeriod,
      endsAt,
      source: "stripe",
      references: [invoice.id],
      ...(invoice.subscriptionId ? { stripeSubscriptionId: invoice.subscriptionId } : {}),
      paidCents: invoice.amountPaid,
      purchasedAt: paidAt,
      segments: [],
    },
    {
      expectedVersion: version,
      actor: `stripe:${invoice.id}`,
      reason: "Pagamento anual por cartão confirmado (Stripe)",
    },
  );
  const below = await renewalBelowUpgrade(ctx, organizationId, invoice, firstPeriod, tier);
  await record(
    "applied",
    below ? "RENEWAL_BELOW_UPGRADE" : undefined,
    firstPeriod <= now ? version + 1 : undefined,
    termId,
  );
  if (below)
    await ctx.db.patch("billingAccounts", account._id, { renewalTier: tier, updatedAt: now });
  await ctx.scheduler.runAt(endsAt + RENEWAL_CHECK_DELAY, internal.billing.sync, {
    organizationId,
  });
}

/**
 * Whether the term the subscription of `invoice` renews, ending at `firstPeriod`, had reached in
 * its last month a tier above `tier`: the renewal was charged below what an upgrade bought.
 */
async function renewalBelowUpgrade(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  invoice: InvoiceFacts,
  firstPeriod: number,
  tier: PaidTier,
) {
  if (!invoice.subscriptionId) return false;
  for (const state of ["active", "expired"] as const) {
    const previous = await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId).eq("state", state).eq("endsAt", firstPeriod),
      )
      .take(10);
    if (
      previous.some(
        (term) =>
          term.stripeSubscriptionId === invoice.subscriptionId &&
          PLATFORM_PLANS[termTierAt(term, firstPeriod - 1)].annualCents >
            PLATFORM_PLANS[tier].annualCents,
      )
    )
      return true;
  }
  return false;
}

/**
 * A paid annual upgrade (ADR 0010, decision 9), a one-off payment from the upgrade Checkout,
 * raises the card term in force to `tier` from the 1st of `period` until the term ends, as the
 * Pix confirmation does (`upgradeTerm`). The amount must be the difference the server prices on
 * that term for that month. Every check runs before any write, so a refusal is `blocked` for a
 * person with the money already taken. Applied, the account renews at `tier`: the reconciliation
 * then moves the annual subscription to that tier's yearly price, without proration and keeping
 * the anchor, so the renewal date stays and the next year is the larger tier.
 */
async function applyAnnualUpgrade(
  ctx: MutationCtx,
  account: Doc<"billingAccounts">,
  invoice: InvoiceFacts,
  tier: PaidTier,
  period: string,
  now: number,
  record: GrantRecord,
  annualSubscriptions: readonly string[],
) {
  const organizationId = account.organizationId;
  const fromPeriod = periodStart(period);
  const paidAt = invoice.paidAt ?? now;
  // The price depends on the month: paid after it, the difference no longer matches.
  if (paidAt >= nextUsagePeriodStart(fromPeriod))
    return void (await record("blocked", "LATE_PAYMENT"));
  if (!isTermReference(invoice.id)) return void (await record("blocked", "INVOICE_UNEXPECTED"));
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (closure) return void (await record("blocked", "ORGANIZATION_CLOSED"));
  const plan = await planFor(ctx, organizationId);
  if (plan?.catalogTier === "custom") return void (await record("blocked", "PLAN_CUSTOM"));
  let term: Doc<"platformPlanTerms">;
  try {
    term = await upgradableTerm(ctx, organizationId, now);
  } catch (error) {
    const code = denialCode(error);
    if (!code) throw error;
    return void (await record("blocked", code));
  }
  // The term of the month paid for, bought by card: a Pix term is upgraded by Pix.
  if (term.firstPeriod > fromPeriod || term.source !== "stripe")
    return void (await record("blocked", "ANNUAL_TERM_REQUIRED"));
  // Its subscription must be one this customer has, in this mode, as the Checkout required:
  // otherwise no price switch could follow.
  if (!term.stripeSubscriptionId || !annualSubscriptions.includes(term.stripeSubscriptionId))
    return void (await record("blocked", "SUBSCRIPTION_REQUIRED"));
  const price = termUpgradeCents(term, tier, fromPeriod);
  // Already raised, by this payment's twin or otherwise: the money waits for a person.
  if (price === null) return void (await record("blocked", "DUPLICATE_PAYMENT"));
  if (price !== invoice.amountPaid) return void (await record("blocked", "AMOUNT_MISMATCH"));
  try {
    await allocateOffer(ctx, organizationId, tier, PLATFORM_PLANS[tier], { checkOnly: true });
  } catch (error) {
    const code = denialCode(error);
    if (!code) throw error;
    return void (await record("blocked", code));
  }
  const version = plan?.version ?? 0;
  await upgradeTerm(
    ctx,
    term,
    { tier, fromPeriod, reference: invoice.id, paidCents: invoice.amountPaid, paidAt },
    {
      expectedVersion: version,
      actor: `stripe:${invoice.id}`,
      reason: "Upgrade anual por cartão confirmado (Stripe)",
    },
  );
  await record("applied", undefined, version + 1, term._id);
  await ctx.db.patch("billingAccounts", account._id, { renewalTier: tier, updatedAt: now });
}
