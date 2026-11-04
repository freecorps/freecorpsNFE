import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { PLATFORM_PLANS, isCatalogTier } from "./planCatalog";
import { activateCatalogPlan, allocateOffer, startTerm, upgradeTerm } from "./planCore";
import { denialCode } from "./organizationAccess";
import {
  annualTermBlocks,
  chainAnchor,
  monthlyBlockedByTerm,
  rescindedSubscription,
  subscriptionHasTerm,
  termCovering,
  termMonth,
  termTierAt,
  termUpgradeCents,
  upgradableTerm,
} from "./planTerms";
import { isTermMonthStart, isTermReference, termMonthStart } from "./annualTerms";
import { planFor } from "./usageCore";
import { planEnded } from "./usageValues";
import { periodKey, periodKeyStart, quotaPeriod } from "./quotaPeriod";
import {
  ANNUAL_CYCLE,
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
export async function cardBlocksPix(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_organizationId_and_livemode", (q) => q.eq("organizationId", organizationId))
    .take(2);
  return accounts.some(renews) || !!(await openCheckout(ctx, organizationId, now));
}

/**
 * A Pix request awaiting payment within its deadline (`endsAt`, its `payBy`): it holds the card.
 * One past the deadline can no longer be confirmed, and the next Pix request cancels it.
 */
export async function pixPending(ctx: QueryCtx, organizationId: Id<"organizations">, now: number) {
  const requests = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", organizationId).eq("state", "awaiting_payment"),
    )
    .take(10);
  return requests.some((request) => request.endsAt > now);
}

/**
 * Whether a card invoice granted this plan row. The row records no payment method, so this relies
 * on `applyInvoice`: every card grant that writes the row records, in `billingGrants`, the version
 * it wrote (`planVersion`), and any later write (a Pix confirmation, an operator's assignment)
 * raises the row's version past it. The last 20 grants are enough: only the newest applied one can
 * match the row in force.
 */
export async function paidByCard(ctx: QueryCtx, plan: Doc<"usagePlans">) {
  const grants = await ctx.db
    .query("billingGrants")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", plan.organizationId))
    .order("desc")
    .take(20);
  return grants.some((grant) => grant.state === "applied" && grant.planVersion === plan.version);
}

/** The end of a monthly Pix renewal starting at `firstPeriod`: the next anniversary of `anchor`. */
export const renewalEnd = (request: { firstPeriod: number; anchor: number }) =>
  termMonthStart(request.firstPeriod, 1, request.anchor);

/** A month is at most 31 days: a renewal that started before this window has already ended. */
const RENEWAL_WINDOW = 31 * 24 * 60 * 60 * 1000;
/** The scheduled activation runs at the start; this long after it, the renewal is `overdue`. */
const RENEWAL_OVERDUE = 10 * 60 * 1000;

/**
 * A monthly Pix renewal paid before its start and not yet granted (`scheduled`, ADR 0012): it
 * holds the organization as a plan in force would, from now to the end of the month it bought. A
 * refused activation (`blockedCode`) waits for the team and no longer holds after that end. Only
 * renewals starting in the last 31 days are read, so ended rows that keep `scheduled` never crowd
 * out the current one. `availableAt` is when what it holds opens: its start, or, refused, its end.
 * `overdue`: its start passed 10 minutes ago and it was neither granted nor refused (an
 * activation that failed unexpectedly), so it needs the team as a refused one does.
 */
export async function scheduledPixRenewal(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const rows = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_scheduled_and_firstPeriod", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("scheduled", true)
        .gt("firstPeriod", now - RENEWAL_WINDOW),
    )
    .take(5);
  for (const request of rows) {
    if (
      request.state !== "activated" ||
      request.firstPeriod === undefined ||
      request.anchor === undefined
    )
      continue;
    const span = { firstPeriod: request.firstPeriod, anchor: request.anchor };
    const endsAt = renewalEnd(span);
    if (endsAt <= now) continue;
    const blocked = request.blockedCode !== undefined;
    const overdue = !blocked && request.firstPeriod + RENEWAL_OVERDUE <= now;
    return {
      request,
      startsAt: request.firstPeriod,
      endsAt,
      blocked,
      overdue,
      // Blocked or overdue, it still holds the organization until its end: never a past date.
      availableAt: blocked || overdue ? endsAt : request.firstPeriod,
    };
  }
  return null;
}

/**
 * Whether a monthly Pix confirmation wrote this plan row: the activated monthly request that
 * recorded its version (`planVersion`). A positive signal, unlike `paidByCard`: a row assigned by
 * an operator, or granted before the version was recorded, is not taken for Pix. Only the newest
 * activated requests can match the row in force.
 */
export async function paidByPix(ctx: QueryCtx, plan: Doc<"usagePlans">) {
  const requests = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", plan.organizationId).eq("state", "activated"),
    )
    .order("desc")
    .take(20);
  return requests.some((request) => request.planVersion === plan.version);
}

/**
 * When the monthly Pix plan in force, with any renewal of it already paid, ends; null without
 * one. A monthly plan row of a catalog tier without a term, written by a Pix confirmation
 * (`paidByPix`), is a Pix plan. One paid plan at a time (ADR 0012): the monthly card Checkout
 * waits until then.
 */
export async function pixMonthlyUntil(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now: number,
) {
  const renewal = await scheduledPixRenewal(ctx, organizationId, now);
  const plan = await planFor(ctx, organizationId);
  // A card that renews holds the plan in force; the Pix waits for it (`cardBlocksPix`).
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_organizationId_and_livemode", (q) => q.eq("organizationId", organizationId))
    .take(2);
  const inForce =
    !accounts.some(renews) &&
    plan &&
    plan.startsAt <= now &&
    !planEnded(plan, now) &&
    plan.endsAt !== null &&
    !plan.termId &&
    (plan.catalogTier === "intermediate" || plan.catalogTier === "large") &&
    (await paidByPix(ctx, plan))
      ? plan.endsAt
      : null;
  if (renewal) return Math.max(renewal.endsAt, inForce ?? 0);
  return inForce;
}

/**
 * The start of the period a stored key names: `AAAA-MM`, or the exact ISO instant of an
 * anniversary period (`periodKeyStart`, ADR 0012). The server only writes canonical keys, so any
 * other spelling, or a missing key, is a bug and throws.
 */
export function periodStart(period: string | undefined) {
  const start = period === undefined ? null : periodKeyStart(period);
  if (start === null) throw new Error("Invalid period key");
  return start;
}

/**
 * A card monthly upgrade is refused this close to the end of the period it would raise
 * (`PERIOD_CLOSING`), so the difference is paid within that period and the switch of price never
 * straddles the renewal.
 */
export const PERIOD_CLOSING_MARGIN = 45 * 60 * 1000;

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
 * applied stays `blocked` for a person. `anchors` holds the `billing_cycle_anchor` of each
 * subscription of the customer (`readSubscriptions`), which a monthly invoice is weighed against
 * (ADR 0012, invariant 6).
 */
export async function applyInvoice(
  ctx: MutationCtx,
  account: Doc<"billingAccounts">,
  invoice: InvoiceFacts,
  prices: CatalogPrices,
  annual: AnnualPrices = {},
  annualSubscriptions: readonly string[] = [],
  anchors: Readonly<Record<string, number>> = {},
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
  const decision = invoiceGrant(
    invoice,
    prices,
    organizationId,
    annual,
    annualSubscriptions,
    anchors,
  );
  // An unpaid invoice may still be paid, and the anchor of a subscription not read yet will be:
  // either is weighed again on the next reconciliation.
  if (
    decision.kind === "none" &&
    (decision.code === "NOT_PAID" || decision.code === "ANCHOR_UNKNOWN")
  )
    return;
  const now = Date.now();
  const bought = decision.kind !== "none" && decision.kind !== "review";
  // The first invoice of an annual subscription (slice 2b): charged at the signing. Blocked, it
  // bought no term, and the subscription would charge the next year at its anniversary.
  const firstAnnual =
    invoice.billingReason === "subscription_create" &&
    invoice.subscriptionId !== null &&
    (invoice.subscriptionMetadata.cycle === ANNUAL_CYCLE ||
      annualSubscriptions.includes(invoice.subscriptionId));
  const record: GrantRecord = async (state, code, planVersion, termId) => {
    // Stopped at once, unless the subscription renews a term it bought (a repeated charge of a
    // year already granted): the refund stays a person's decision.
    const stop =
      state === "blocked" &&
      firstAnnual &&
      !(await subscriptionHasTerm(ctx, organizationId, invoice.subscriptionId!));
    const grantId = await ctx.db.insert("billingGrants", {
      organizationId,
      invoiceId: invoice.id,
      tier: bought ? decision.tier : null,
      // The canonical key of the period bought (ADR 0012): `AAAA-MM` or the exact ISO instant.
      period: !bought
        ? null
        : decision.kind === "grant" || decision.kind === "annual"
          ? periodKey(decision.startsAt)
          : decision.period,
      amountCents: invoice.amountPaid,
      state,
      ...(code ? { code } : {}),
      ...(planVersion !== undefined ? { planVersion } : {}),
      ...(termId ? { termId } : {}),
      ...(stop
        ? {
            subscriptionStop: {
              subscriptionId: invoice.subscriptionId!,
              state: "pending" as const,
            },
          }
        : {}),
      createdAt: now,
    });
    if (stop)
      await ctx.scheduler.runAfter(0, internal.billing.stopBlockedAnnual, {
        organizationId,
        grantId,
        attempt: 0,
      });
    return grantId;
  };
  if (decision.kind === "none") return void (await record("skipped", decision.code));
  if (decision.kind === "review") return void (await record("blocked", decision.code));
  if (decision.kind === "annual")
    return applyAnnualInvoice(ctx, account, invoice, decision, now, record);
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
  // A monthly invoice (ADR 0012, slice 2a). A first month or a renewal buys its line's period, a
  // month of the subscription's anchor; an upgrade buys the rest of the quota period in force,
  // the one it was priced on, with the anchor of that plan. A plan row granted before slice 2a
  // has no anchor and runs by the civil UTC month: its upgrade anchors on the 1st that month
  // starts, which keeps the same `AAAA-MM` periods (invariant 4).
  const plan = await planFor(ctx, organizationId);
  const active = !!plan && plan.startsAt <= now && !planEnded(plan, now);
  let end: number | null;
  let anchor: number;
  if (decision.kind === "upgrade") {
    // A plan a term granted is never raised by a monthly upgrade (one paid plan at a time).
    if (active && plan.termId) return void (await record("blocked", "ANNUAL_TERM_ACTIVE"));
    const current = active && plan.endsAt !== null ? quotaPeriod(plan, now) : null;
    const same = current?.key === decision.period && current.endsAt === plan!.endsAt;
    end = same ? current.endsAt : null;
    anchor = plan?.periodAnchor ?? current?.startsAt ?? now;
  } else {
    end = decision.endsAt;
    anchor = decision.anchor;
  }
  // The activation below runs from now to the end of the period paid for; an annual term
  // overlapping it would be shortened, so the money was paid but cannot be granted: a person
  // looks at it, never `SUPERSEDED`, instead of `activateCatalogPlan` failing the sync. A month
  // that ends before a term scheduled for later is still granted.
  if (end !== null && (await monthlyBlockedByTerm(ctx, organizationId, now, end)))
    return void (await record("blocked", "ANNUAL_TERM_ACTIVE"));
  // Paid after the period it bought, or an upgrade paid after its period turned: no quota is
  // sold for the past, and the difference was priced on a period no longer in force.
  if (end === null || end <= now) return void (await record("blocked", "LATE_PAYMENT"));
  const closure = await ctx.db
    .query("organizationClosures")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (closure) return void (await record("blocked", "ORGANIZATION_CLOSED"));
  if (plan?.catalogTier === "custom") return void (await record("blocked", "PLAN_CUSTOM"));
  // A plan a term granted, the access left by a rescinded term included, ends with the term
  // month: a monthly would replace it (one paid plan at a time, ADR 0012), so a person looks.
  if (active && plan.termId) return void (await record("blocked", "ANNUAL_TERM_ACTIVE"));
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
  // A renewal charged below the tier the month it follows reached, while the account still renews
  // at that tier: the price switch of a paid upgrade did not reach Stripe before it drafted the
  // renewal. The money taken is that tier's, so it is granted, but flagged for a person, as the
  // annual one. `renewalTier` stays: the switch, once it lands, bills the next month right.
  const below =
    decision.kind === "grant" &&
    invoice.billingReason === "subscription_cycle" &&
    !!plan &&
    !plan.termId &&
    plan.endsAt === decision.startsAt &&
    plan.catalogTier === account.renewalTier &&
    !!account.renewalTier &&
    PLATFORM_PLANS[account.renewalTier].monthlyCents > PLATFORM_PLANS[decision.tier].monthlyCents;
  // Every catalog row the card writes carries its anchor, up to `startsAt`, and ends on one of
  // its anniversaries (ADR 0012, invariant 4): `activateCatalogPlan` refuses anything else.
  await activateCatalogPlan(
    ctx,
    organizationId,
    decision.tier,
    now,
    end,
    plan?.version ?? 0,
    `stripe:${invoice.id}`,
    "Pagamento por cartão confirmado (Stripe)",
    undefined,
    anchor,
  );
  await record("applied", below ? "RENEWAL_BELOW_UPGRADE" : undefined, (plan?.version ?? 0) + 1);
  // An upgrade paid by card also raises what the subscription renews at.
  if (decision.kind === "upgrade")
    await ctx.db.patch("billingAccounts", account._id, {
      renewalTier: decision.tier,
      updatedAt: now,
    });
  await ctx.scheduler.runAt(end + RENEWAL_CHECK_DELAY, internal.billing.sync, { organizationId });
}

/**
 * A paid annual invoice becomes one term (ADR 0010, decision 9), as a confirmed annual Pix does,
 * for the year of the subscription's anchor its yearly line bills (ADR 0012, invariant 6): the
 * first invoice, charged at the signing since slice 2b, from the anchor itself; a renewal from
 * the anniversary 12(n − 1), which is the previous term's `endsAt`, so the renewal leaves no gap.
 * The term records the anchor as the one of its chain when it does not start on it, so its
 * months, its end and the quota periods of its plan count from it. The annual switch is not
 * checked: it stops new sales, and this money was taken. Admission still is, and every refusal is
 * `blocked`; granted, the term reserves the admission as the monthly does (`startTerm`). A
 * monthly plan of the same tier or below in force is replaced at once, without discount (one paid
 * plan at a time, ADR 0012).
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
  year: { tier: PaidTier; startsAt: number; endsAt: number; anchor: number },
  now: number,
  record: GrantRecord,
) {
  const organizationId = account.organizationId;
  const { tier, startsAt: firstPeriod, endsAt, anchor } = year;
  const paidAt = invoice.paidAt ?? now;
  // The Pix `payBy`: the whole term only if paid within its first term month.
  if (paidAt >= termMonthStart(firstPeriod, 1, anchor) || now >= endsAt)
    return void (await record("blocked", "LATE_PAYMENT"));
  // Stripe charges a year when it starts: one starting after the anchor's month in force (a
  // renewal paid more than a month early) is no sale; the term keeps the invoice id.
  const latest = now < anchor ? anchor : quotaPeriod({ periodAnchor: anchor }, now).endsAt;
  if (firstPeriod > latest || !isTermReference(invoice.id))
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
  // Starting now replaces the monthly in force without discount, never with a lower tier: the
  // Checkout refuses that sale until the monthly ends (`PLAN_UNAVAILABLE`, with the date).
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
      // The chain's anchor is the subscription's (ADR 0012, section 1); a first term is its own.
      ...(anchor !== firstPeriod ? { anchor } : {}),
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
 * raises the card term in force to `tier` from `period`, the start of the term month it was sold
 * in (counted from the chain's anchor, ADR 0012), until the term ends, as the Pix confirmation
 * does (`upgradeTerm`). It must be paid within that term month (`LATE_PAYMENT` otherwise), and
 * the amount must be the difference the server prices on that term for that month. Every check
 * runs before any write, so a refusal is `blocked` for a person with the money already taken.
 * Applied, the account renews at `tier`: the reconciliation then moves the annual subscription to
 * that tier's yearly price, without proration and keeping the anchor, so the renewal date stays
 * and the next year is the larger tier.
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
  // The price depends on the term month: paid after it, the difference no longer matches. The
  // month is the one of the `active` or `scheduled` term covering `period`, even one whose
  // `endsAt` has passed since (terms are not marked `expired`); a rescinded term is not looked
  // at, and its upgrade is refused below (`ANNUAL_TERM_REQUIRED`).
  const priced = await termCovering(ctx, organizationId, fromPeriod);
  if (
    priced &&
    isTermMonthStart(priced.firstPeriod, fromPeriod, chainAnchor(priced)) &&
    paidAt >= termMonth(priced, fromPeriod).endsAt
  )
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
  // A segment starts at the start of a term month, as the Checkout priced it.
  if (!isTermMonthStart(term.firstPeriod, fromPeriod, chainAnchor(term)))
    return void (await record("blocked", "INVOICE_UNEXPECTED"));
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
