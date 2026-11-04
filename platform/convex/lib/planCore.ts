import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deny } from "./organizationAccess";
import { PLATFORM_PLANS, type CatalogTier, type paidTier, type planCapacity } from "./planCatalog";
import { assertPlanCapacity, capacityPlan, ensureCapacityReady } from "./capacityCore";
import { planFor } from "./usageCore";
import { USAGE_PAUSES, resumeOrganizationCaptures } from "./captureAttention";
import { purger, type Budget } from "./purge";
import { assertPlanChangeable, endArchiveNotice, inCustody } from "./coldArchiveCore";
import { internal } from "../_generated/api";
import {
  insertTerm,
  monthlyBlockedByTerm,
  termRescission,
  termsInForce,
  termTierAt,
  withdrawableUpgrade,
  withoutLastUpgrade,
  type TermFields,
} from "./planTerms";
import { assertTermShape, isTermReference, withinWithdrawal } from "./annualTerms";
import { planEnded } from "./usageValues";
import { isOperatorLogin, operatorAndReason } from "./issuanceGate";

export const planSettings = (ctx: QueryCtx) =>
  ctx.db
    .query("platformPlanSettings")
    .withIndex("by_key", (q) => q.eq("key", "platform"))
    .unique();
export const planAllocation = (ctx: QueryCtx, organizationId: Id<"organizations">) =>
  ctx.db
    .query("platformPlanAllocations")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();

async function integrationCount(ctx: QueryCtx, organizationId: Id<"organizations">, limit: number) {
  const rows = await ctx.db
    .query("projects")
    .withIndex("by_organizationId_and_kind", (q) =>
      q.eq("organizationId", organizationId).eq("kind", undefined),
    )
    .take(limit);
  return rows.length;
}

/** The annual sale is on only while the catalog is on too (ADR 0010, decision 4.2). */
export const annualOn = (
  settings: Pick<Doc<"platformPlanSettings">, "enabled" | "annual"> | null,
) => settings?.enabled === true && settings.annual?.enabled === true;
export const annualEnabled = async (ctx: QueryCtx) => annualOn(await planSettings(ctx));
/** The assisted Pix sale is on only while the catalog is on too; the card does not depend on it. */
export const pixOn = (settings: Pick<Doc<"platformPlanSettings">, "enabled" | "pix"> | null) =>
  settings?.enabled === true && settings.pix?.enabled === true;
export const pixEnabled = async (ctx: QueryCtx) => pixOn(await planSettings(ctx));

export async function requirePlanAdmissions(ctx: QueryCtx) {
  const settings = await requirePlansEnabled(ctx);
  if (settings.admissionsUntil <= Date.now()) deny("PLAN_UNAVAILABLE");
  return settings;
}
/** The catalog is on; the admission window (`admissionsUntil`) is checked apart. */
async function requirePlansEnabled(ctx: QueryCtx) {
  const settings = await planSettings(ctx);
  if (!settings?.enabled) deny("PLANS_DISABLED");
  return settings;
}

export async function assertEntityCapacity(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  capacity: typeof planCapacity.type,
) {
  const organization = await ctx.db.get("organizations", organizationId);
  if (!organization) deny("NOT_FOUND");
  const [companies, projects] = await Promise.all([
    ctx.db
      .query("companies")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .take(capacity.companies + 1),
    integrationCount(ctx, organizationId, capacity.projects + 1),
  ]);
  if (
    companies.length > capacity.companies ||
    projects > capacity.projects ||
    organization.memberCount > capacity.members
  )
    deny("QUOTA_EXCEEDED");
}

/**
 * Admission reserves the whole stock, not an optimistic average. Custody is never recycled by
 * cancellation. The admission window (`admissionsUntil`) only gates a new reservation: an
 * organization that already holds the reservation of the offer renews, by card or Pix, or moves
 * down after the window closes (#549). A first plan or an upgrade still needs the window open.
 */
export async function allocatePlan(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  tier: CatalogTier,
) {
  return allocateOffer(ctx, organizationId, tier, PLATFORM_PLANS[tier]);
}
export async function allocateOffer(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  tier: CatalogTier | "custom",
  offer: {
    capacity: typeof planCapacity.type;
    custodyCents: number;
    monthlySubsidyCents: number;
  },
  options: { checkOnly?: boolean } = {},
) {
  // The one exception of the cold custody for plans (ADR 0009, §2): archived still contracts.
  await assertPlanChangeable(ctx, organizationId);
  const settings = await requirePlansEnabled(ctx);
  if (!(await ensureCapacityReady(ctx, organizationId))) deny("CAPACITY_INVENTORY_REQUIRED");
  await assertPlanCapacity(ctx, organizationId, offer.capacity);
  await assertEntityCapacity(ctx, organizationId, offer.capacity);
  const prior = await planAllocation(ctx, organizationId);
  const allocation = {
    filesBytes: Math.max(
      prior?.filesBytes ?? 0,
      offer.capacity.filesBytes + offer.capacity.exportsBytes,
    ),
    databaseBytes: Math.max(prior?.databaseBytes ?? 0, offer.capacity.databaseBytes),
    custodyCents: Math.max(prior?.custodyCents ?? 0, offer.custodyCents),
    freeMonthlyCents: Math.max(prior?.freeMonthlyCents ?? 0, offer.monthlySubsidyCents),
  };
  const reserves =
    !prior ||
    allocation.filesBytes > prior.filesBytes ||
    allocation.databaseBytes > prior.databaseBytes ||
    allocation.custodyCents > prior.custodyCents ||
    allocation.freeMonthlyCents > prior.freeMonthlyCents;
  if (reserves && settings.admissionsUntil <= Date.now()) deny("PLAN_UNAVAILABLE");
  const totals = {
    allocatedFilesBytes:
      settings.allocatedFilesBytes + allocation.filesBytes - (prior?.filesBytes ?? 0),
    allocatedDatabaseBytes:
      settings.allocatedDatabaseBytes + allocation.databaseBytes - (prior?.databaseBytes ?? 0),
    allocatedCustodyCents:
      settings.allocatedCustodyCents + allocation.custodyCents - (prior?.custodyCents ?? 0),
    allocatedFreeMonthlyCents:
      settings.allocatedFreeMonthlyCents +
      allocation.freeMonthlyCents -
      (prior?.freeMonthlyCents ?? 0),
  };
  if (
    totals.allocatedFilesBytes > settings.filesBytes ||
    totals.allocatedDatabaseBytes > settings.databaseBytes ||
    totals.allocatedCustodyCents > settings.custodyCents ||
    totals.allocatedFreeMonthlyCents > settings.freeMonthlyCents
  )
    deny("PLAN_UNAVAILABLE");
  if (options.checkOnly) return;
  await ctx.db.patch("platformPlanSettings", settings._id, { ...totals, updatedAt: Date.now() });
  const fields = { organizationId, tier, ...allocation, updatedAt: Date.now() };
  if (prior) await ctx.db.replace("platformPlanAllocations", prior._id, fields);
  else await ctx.db.insert("platformPlanAllocations", fields);
}

/**
 * The quota anchor of the plan rows a term grants (ADR 0012, slice Q): the term's start, truncated
 * to the whole second. Terms sold so far start on a 1st at 00:00 UTC, so their keys stay `AAAA-MM`.
 */
const termAnchor = (term: Pick<Doc<"platformPlanTerms">, "firstPeriod">) =>
  Math.floor(term.firstPeriod / 1000) * 1000;

/**
 * Without `termId`, a monthly activation: refused when an annual term overlaps it from `startsAt`
 * to `endsAt` (`monthlyBlockedByTerm`), which it would shorten. It has no `periodAnchor` yet
 * (ADR 0012, slice Q): its quotas count by the civil UTC month. With it, the plan row records the
 * term it grants and the term's start as `periodAnchor`, and the grant must match the term
 * (`INVALID_REQUEST` otherwise): same organization, `scheduled` or `active`, the tier in force at
 * `startsAt`, `startsAt` within the term and `endsAt` equal to the term's.
 */
export async function activateCatalogPlan(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  tier: CatalogTier,
  startsAt: number,
  endsAt: number | null,
  expectedVersion: number,
  actor: string,
  reason: string,
  termId?: Id<"platformPlanTerms">,
) {
  let periodAnchor: number | undefined;
  if (termId === undefined) {
    if (await monthlyBlockedByTerm(ctx, organizationId, startsAt, endsAt))
      deny("ANNUAL_TERM_ACTIVE");
  } else {
    const term = await ctx.db.get("platformPlanTerms", termId);
    if (
      term?.organizationId !== organizationId ||
      (term.state !== "scheduled" && term.state !== "active") ||
      startsAt < term.firstPeriod ||
      startsAt >= term.endsAt ||
      endsAt !== term.endsAt ||
      termTierAt(term, startsAt) !== tier
    )
      deny("INVALID_REQUEST");
    periodAnchor = termAnchor(term);
  }
  const before = await planFor(ctx, organizationId);
  if ((before?.version ?? 0) !== expectedVersion) deny("OPERATION_CONFLICT");
  await allocatePlan(ctx, organizationId, tier);
  const offer = PLATFORM_PLANS[tier];
  const after = {
    organizationId,
    catalogTier: tier,
    name: offer.name,
    limits: offer.limits,
    capacity: offer.capacity,
    concurrency: offer.concurrency,
    startsAt,
    endsAt,
    version: expectedVersion + 1,
    updatedAt: Date.now(),
    ...(termId ? { termId } : {}),
    ...(periodAnchor !== undefined ? { periodAnchor } : {}),
  };
  if (before) await ctx.db.replace("usagePlans", before._id, after);
  else await ctx.db.insert("usagePlans", after);
  await ctx.db.insert("usagePlanAudit", {
    organizationId,
    actor,
    reason,
    before: before ? JSON.stringify(before) : null,
    after: JSON.stringify(after),
    createdAt: Date.now(),
  });
  // An archived organization captures nothing until its rehydration; its streams stay paused.
  if (!(await inCustody(ctx, organizationId)))
    await resumeOrganizationCaptures(ctx, organizationId, USAGE_PAUSES);
  // Renewing, or any new plan, ends a pending archive notice in this same transaction.
  await endArchiveNotice(ctx, organizationId, "plan");
  if (endsAt !== null)
    await ctx.scheduler.runAt(endsAt, internal.plans.refreshExpiry, {
      organizationId,
      version: after.version,
    });
}

/**
 * Records a paid annual term and starts it, for Pix and card alike (ADR 0010, decision 9). A
 * term whose `firstPeriod`, its start instant, has arrived grants the plan now over
 * `expectedVersion`; one starting later reserves the stock now and is activated at its
 * `firstPeriod` (`plans:activateScheduledTerm`), while the current plan runs until then. The
 * caller has already checked the admission.
 */
export async function startTerm(
  ctx: MutationCtx,
  term: Omit<TermFields, "state" | "blockedCode">,
  grant: { expectedVersion: number; actor: string; reason: string },
) {
  const scheduled = term.firstPeriod > Date.now();
  const termId = await insertTerm(ctx, { ...term, state: scheduled ? "scheduled" : "active" });
  if (scheduled) {
    await allocatePlan(ctx, term.organizationId, term.tier);
    // Paid: a pending archive notice ends now, as any plan activation ends it.
    await endArchiveNotice(ctx, term.organizationId, "plan");
    await ctx.scheduler.runAt(term.firstPeriod, internal.plans.activateScheduledTerm, { termId });
  } else await grantTerm(ctx, termId, grant.expectedVersion, grant.actor, grant.reason);
  return termId;
}

/** Replaces the plan at `expectedVersion` with the term's, and marks the term `active`. */
export async function grantTerm(
  ctx: MutationCtx,
  termId: Id<"platformPlanTerms">,
  expectedVersion: number,
  actor: string,
  reason: string,
) {
  const term = (await ctx.db.get("platformPlanTerms", termId))!;
  const now = Date.now();
  await activateCatalogPlan(
    ctx,
    term.organizationId,
    termTierAt(term, now),
    now,
    term.endsAt,
    expectedVersion,
    actor,
    reason,
    termId,
  );
  await ctx.db.patch("platformPlanTerms", termId, {
    state: "active",
    blockedCode: undefined,
    updatedAt: now,
  });
}

/**
 * Raises an `active` term to `upgrade.tier` from `upgrade.fromPeriod`, the start of one of its
 * term months, until its end (ADR 0010, decision 9), for Pix and card alike, and grants the plan
 * now over `expectedVersion`. The end and the renewal date stay; the upgrade becomes a segment, or
 * the term's `tier` in its first term month, which it covers whole. The charge is added to
 * `references`, `paidCents` and `upgrades`; `purchasedAt` stays the annual charge's. The grant
 * goes through `activateCatalogPlan`, whose
 * `allocatePlan` reserves the larger tier's stock and custody fund (the R$ 172 "aporte" between
 * Intermediário and Grande) in this same transaction, before the plan is raised: any refusal
 * throws and rolls the term back too. The caller has checked the term and the price.
 */
export async function upgradeTerm(
  ctx: MutationCtx,
  term: Doc<"platformPlanTerms">,
  upgrade: {
    tier: typeof paidTier.type;
    fromPeriod: number;
    reference: string;
    paidCents: number;
    paidAt: number;
  },
  grant: { expectedVersion: number; actor: string; reason: string },
) {
  const first = upgrade.fromPeriod === term.firstPeriod;
  const fields = {
    tier: first ? upgrade.tier : term.tier,
    segments: first
      ? term.segments
      : [...term.segments, { tier: upgrade.tier, fromPeriod: upgrade.fromPeriod }],
    references: [...term.references, upgrade.reference],
    paidCents: term.paidCents + upgrade.paidCents,
    upgrades: [
      ...(term.upgrades ?? []),
      { fromTier: termTierAt(term, upgrade.fromPeriod), ...upgrade },
    ],
  };
  assertTermShape({ ...term, ...fields });
  const now = Date.now();
  await ctx.db.patch("platformPlanTerms", term._id, { ...fields, updatedAt: now });
  await activateCatalogPlan(
    ctx,
    term.organizationId,
    upgrade.tier,
    now,
    term.endsAt,
    grant.expectedVersion,
    grant.actor,
    grant.reason,
    term._id,
  );
}

/**
 * Rewrites the plan row `term` granted, without a new reservation: back to a lower tier after an
 * upgrade is withdrawn, or ending sooner after a rescission (`endsAt`; without it, the end stays).
 * Nothing changes unless the plan in force is the term's: a term not started yet, or one whose
 * plan already ended, has no plan to rewrite. The reservation (`platformPlanAllocations`) stays,
 * as on any expiry or downgrade: `allocateOffer` never lowers it and only the legal purge returns
 * it (`purgePlanRecords`). Nothing kept above the lower tier is deleted; the capacity guards then
 * refuse new entries, as after any downgrade.
 */
async function rewriteTermPlan(
  ctx: MutationCtx,
  term: Pick<Doc<"platformPlanTerms">, "_id" | "organizationId">,
  change: { tier: typeof paidTier.type; endsAt?: number },
  actor: string,
  reason: string,
) {
  const now = Date.now();
  const before = await planFor(ctx, term.organizationId);
  if (!before || before.termId !== term._id || planEnded(before, now)) return;
  const offer = PLATFORM_PLANS[change.tier];
  const endsAt = change.endsAt ?? before.endsAt;
  const after = {
    organizationId: term.organizationId,
    catalogTier: change.tier,
    name: offer.name,
    limits: offer.limits,
    capacity: offer.capacity,
    concurrency: offer.concurrency,
    startsAt: before.catalogTier === change.tier ? before.startsAt : now,
    endsAt,
    version: before.version + 1,
    updatedAt: now,
    termId: term._id,
    // The same chain keeps its anchor (ADR 0012, section 4).
    ...(before.periodAnchor !== undefined ? { periodAnchor: before.periodAnchor } : {}),
  };
  await ctx.db.replace("usagePlans", before._id, after);
  await ctx.db.insert("usagePlanAudit", {
    organizationId: term.organizationId,
    actor,
    reason,
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    createdAt: now,
  });
  if (endsAt !== null)
    await ctx.scheduler.runAt(endsAt, internal.plans.refreshExpiry, {
      organizationId: term.organizationId,
      version: after.version,
    });
}

const OPERATION_KEY = /^[a-zA-Z0-9_-]{8,100}$/;
/** An operator action on a term: an idempotency key, a GitHub login and a reason. */
function operatorInput(args: { key: string; actor: string; reason: string }) {
  if (!OPERATION_KEY.test(args.key)) deny("INVALID_REQUEST");
  return operatorAndReason({ operator: args.actor, reason: args.reason });
}
type OperatorAction = {
  termId: Id<"platformPlanTerms">;
  key: string;
  actor: string;
  reason: string;
};
export type RescissionSummary = {
  termId: Id<"platformPlanTerms">;
  withdrawal: boolean;
  usedMonths: number;
  refundCents: number;
  accessEndsAt: number;
};

/** The rescission of `term` and of the scheduled renewal rescinded with it, as first recorded. */
async function rescissionSummary(ctx: QueryCtx, term: Doc<"platformPlanTerms">) {
  const withIt = (
    await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", term.organizationId).eq("state", "rescinded"),
      )
      .take(100)
  ).filter((row) => row.rescission?.after === term._id);
  return [term, ...withIt].map((row): RescissionSummary => ({
    termId: row._id,
    withdrawal: row.rescission!.withdrawal,
    usedMonths: row.rescission!.usedMonths,
    refundCents: row.rescission!.refundCents,
    accessEndsAt: row.rescission!.accessEndsAt,
  }));
}

/**
 * Rescinds one term at `now` (`termRescission`). An upgrade whose payment is still within its 7
 * days, while the annual charge is not, is withdrawn first, as `undoTermUpgrade` would: refunded
 * in full, and the used months priced at the tier before it. The plan the term granted ends at
 * `accessEndsAt`, at the tier the term has then.
 */
async function rescindOne(
  ctx: MutationCtx,
  term: Doc<"platformPlanTerms">,
  input: { key: string; operator: string; reason: string; after?: Id<"platformPlanTerms"> },
  now: number,
) {
  let current = term;
  let withdrawn = {};
  if (!withinWithdrawal(term.purchasedAt, now) && withdrawableUpgrade(term, now)) {
    const { upgrade, fields } = withoutLastUpgrade(term);
    withdrawn = {
      ...fields,
      undoneUpgrades: [
        ...(term.undoneUpgrades ?? []),
        {
          ...upgrade,
          key: input.key,
          actor: input.operator,
          reason: input.reason,
          at: now,
          via: "rescission" as const,
          refundCents: upgrade.paidCents,
        },
      ],
    };
    current = { ...term, ...withdrawn };
  }
  const outcome = termRescission(current, now);
  await ctx.db.patch("platformPlanTerms", term._id, {
    ...withdrawn,
    state: "rescinded",
    rescission: {
      key: input.key,
      actor: input.operator,
      reason: input.reason,
      at: now,
      ...outcome,
      ...(input.after ? { after: input.after } : {}),
    },
    updatedAt: now,
  });
  await rewriteTermPlan(
    ctx,
    term,
    { tier: termTierAt(current, now), endsAt: outcome.accessEndsAt },
    `operator:${input.operator}`,
    outcome.withdrawal ? "Rescisão do plano anual em 7 dias" : "Rescisão do plano anual",
  );
}

/**
 * "Rescindir" (ADR 0010, decision 9, and the owner's decision of 30/10/2026), through support: the
 * server computes the refund, which the operator pays back by hand (`recordTermRefund`); nothing
 * here calls a Stripe refund. A `scheduled` renewal of the term, already paid and unused, is
 * rescinded with it with everything paid back, so no term remains to renew. An annual Pix
 * request awaiting payment (a renewal or an upgrade) is cancelled, and the Stripe subscription
 * of a card term is cancelled at once (`billing:stopTermRenewal`), so nothing is charged again;
 * an open upgrade Checkout is expired, here and at Stripe (`billing:expireCheckout`), so the term
 * is not raised after it ends. The same `key` answers the rescission already made, and a key that
 * undid an upgrade of the term is `OPERATION_CONFLICT`; another key on a rescinded term is
 * `TERM_RESCINDED`, and on a term already ended, `TERM_ENDED`.
 */
export async function rescindTerm(ctx: MutationCtx, args: OperatorAction) {
  const { operator, reason } = operatorInput(args);
  const term = await ctx.db.get("platformPlanTerms", args.termId);
  if (!term) return deny("NOT_FOUND");
  if (term.rescission?.key === args.key) return rescissionSummary(ctx, term);
  if (term.undoneUpgrades?.some((row) => row.key === args.key && row.via === "undo"))
    return deny("OPERATION_CONFLICT");
  if (term.state === "rescinded") return deny("TERM_RESCINDED");
  const now = Date.now();
  if (term.state === "expired" || term.endsAt <= now) return deny("TERM_ENDED");
  const renewals = (await termsInForce(ctx, term.organizationId, now)).filter(
    (row) => row._id !== term._id && row.firstPeriod >= term.endsAt,
  );
  await rescindOne(ctx, term, { key: args.key, operator, reason }, now);
  for (const renewal of renewals)
    await rescindOne(ctx, renewal, { key: args.key, operator, reason, after: term._id }, now);
  const pending = await ctx.db
    .query("platformPlanRequests")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", term.organizationId).eq("state", "awaiting_payment"),
    )
    .take(10);
  for (const request of pending)
    if (request.cycle === "annual")
      await ctx.db.patch("platformPlanRequests", request._id, {
        state: "cancelled",
        updatedAt: now,
      });
  for (const state of ["open", "creating"] as const) {
    const checkouts = await ctx.db
      .query("billingCheckouts")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", term.organizationId).eq("state", state),
      )
      .take(10);
    for (const checkout of checkouts) {
      if (checkout.kind !== "upgrade") continue;
      await ctx.db.patch("billingCheckouts", checkout._id, { state: "expired", updatedAt: now });
      if (checkout.sessionId)
        await ctx.scheduler.runAfter(0, internal.billing.expireCheckout, {
          organizationId: term.organizationId,
          sessionId: checkout.sessionId,
        });
    }
  }
  const subscriptions = new Set(
    [term, ...renewals].flatMap((row) =>
      row.source === "stripe" && row.stripeSubscriptionId ? [row.stripeSubscriptionId] : [],
    ),
  );
  for (const subscriptionId of subscriptions)
    await ctx.scheduler.runAfter(0, internal.billing.stopTermRenewal, {
      organizationId: term.organizationId,
      subscriptionId,
      attempt: 0,
    });
  return rescissionSummary(ctx, (await ctx.db.get("platformPlanTerms", term._id))!);
}

/**
 * "Desfazer upgrade": the client withdraws from an upgrade within 7 days of its payment, as from
 * each annual charge (CDC art. 49). The upgrade charge is refunded in full, by hand
 * (`recordTermRefund`); the term returns to the tier it left (`withoutLastUpgrade`) and keeps its
 * own dates and rules, and the plan in force follows, without a new reservation. A card term also
 * renews at that tier again: the account's `renewalTier` goes back, and the reconciliation moves
 * the annual subscription down to that yearly price, the one downward switch it makes; not after
 * the term ended, when its renewal was already charged. The same `key` answers the withdrawal
 * already made; the key of the term's rescission is `OPERATION_CONFLICT`.
 */
export async function undoTermUpgrade(ctx: MutationCtx, args: OperatorAction) {
  const { operator, reason } = operatorInput(args);
  const term = await ctx.db.get("platformPlanTerms", args.termId);
  if (!term) return deny("NOT_FOUND");
  const now = Date.now();
  if (term.rescission?.key === args.key) return deny("OPERATION_CONFLICT");
  const done = term.undoneUpgrades?.find((row) => row.key === args.key);
  if (done?.via === "rescission") return deny("OPERATION_CONFLICT");
  if (done)
    return { reference: done.reference, refundCents: done.refundCents, tier: done.fromTier };
  if (term.state === "rescinded") return deny("TERM_RESCINDED");
  if (!term.upgrades?.length) return deny("UPGRADE_NOT_FOUND");
  if (!withdrawableUpgrade(term, now)) return deny("WITHDRAWAL_ENDED");
  const { upgrade, fields } = withoutLastUpgrade(term);
  await ctx.db.patch("platformPlanTerms", term._id, {
    ...fields,
    undoneUpgrades: [
      ...(term.undoneUpgrades ?? []),
      {
        ...upgrade,
        key: args.key,
        actor: operator,
        reason,
        at: now,
        via: "undo" as const,
        refundCents: upgrade.paidCents,
      },
    ],
    updatedAt: now,
  });
  await rewriteTermPlan(
    ctx,
    term,
    { tier: termTierAt({ ...term, ...fields }, now) },
    `operator:${operator}`,
    "Upgrade anual desfeito em 7 dias",
  );
  if (term.source === "stripe" && term.stripeSubscriptionId && term.endsAt > now) {
    const accounts = await ctx.db
      .query("billingAccounts")
      .withIndex("by_organizationId_and_livemode", (q) =>
        q.eq("organizationId", term.organizationId),
      )
      .take(2);
    for (const account of accounts)
      if (
        account.subscription?.id === term.stripeSubscriptionId &&
        account.renewalTier === upgrade.tier
      ) {
        await ctx.db.patch("billingAccounts", account._id, {
          renewalTier: upgrade.fromTier,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(0, internal.billing.sync, {
          organizationId: term.organizationId,
        });
      }
  }
  return { reference: upgrade.reference, refundCents: upgrade.paidCents, tier: upgrade.fromTier };
}

/**
 * The operator states that part of a computed refund was paid back by hand: the rescission's, or
 * the withdrawn upgrade's whose charge is `upgradeReference`. A card refund cannot exceed the
 * charge it returns, so the computed amount may take several refunds (the annual invoice and the
 * upgrade one), each recorded once by its `reference`; the refund is complete when they add up to
 * `refundCents`. Going over it is `AMOUNT_MISMATCH`, a refund of zero is not recorded
 * (`REFUND_NOT_DUE`), and the same reference with another amount is `OPERATION_CONFLICT`;
 * repeating a statement changes nothing.
 */
export async function recordTermRefund(
  ctx: MutationCtx,
  args: {
    termId: Id<"platformPlanTerms">;
    upgradeReference?: string;
    amountCents: number;
    reference: string;
    actor: string;
  },
) {
  if (
    !isOperatorLogin(args.actor) ||
    !isTermReference(args.reference) ||
    !Number.isSafeInteger(args.amountCents) ||
    args.amountCents <= 0
  )
    deny("INVALID_REQUEST");
  const term = await ctx.db.get("platformPlanTerms", args.termId);
  if (!term) return deny("NOT_FOUND");
  const target =
    args.upgradeReference === undefined
      ? term.rescission
      : term.undoneUpgrades?.find((row) => row.reference === args.upgradeReference);
  if (!target) return deny("NOT_FOUND");
  if (target.refundCents === 0) deny("REFUND_NOT_DUE");
  const refunds = target.refunds ?? [];
  const sum = (rows: readonly { cents: number }[]) =>
    rows.reduce((total, row) => total + row.cents, 0);
  const same = refunds.find((row) => row.reference === args.reference);
  if (same) {
    if (same.cents !== args.amountCents) deny("OPERATION_CONFLICT");
    return { refundCents: target.refundCents, refundedCents: sum(refunds) };
  }
  if (sum(refunds) + args.amountCents > target.refundCents) deny("AMOUNT_MISMATCH");
  const at = Date.now();
  const next = [
    ...refunds,
    { cents: args.amountCents, reference: args.reference, actor: args.actor, at },
  ];
  if (args.upgradeReference === undefined)
    await ctx.db.patch("platformPlanTerms", term._id, {
      rescission: { ...term.rescission!, refunds: next },
      updatedAt: at,
    });
  else
    await ctx.db.patch("platformPlanTerms", term._id, {
      undoneUpgrades: term.undoneUpgrades!.map((row) =>
        row.reference === args.upgradeReference ? { ...row, refunds: next } : row,
      ),
      updatedAt: at,
    });
  return { refundCents: target.refundCents, refundedCents: sum(next) };
}

/**
 * Flags, on each rescinded term the Stripe subscription `subscriptionId` bought, that
 * `billing:stopTermRenewal` gave up cancelling it (`code`), or clears the flag once it did
 * (`null`). The flag shows in `billing:overview` (`reviews`) until then.
 */
export async function markTermRenewalStop(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  subscriptionId: string,
  code: string | null,
) {
  const rescinded = await ctx.db
    .query("platformPlanTerms")
    .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
      q.eq("organizationId", organizationId).eq("state", "rescinded"),
    )
    .take(100);
  const now = Date.now();
  for (const term of rescinded) {
    if (term.stripeSubscriptionId !== subscriptionId || !term.rescission) continue;
    if (code === null && !term.rescission.renewalStopFailed) continue;
    const { renewalStopFailed: _, ...rescission } = term.rescission;
    await ctx.db.patch("platformPlanTerms", term._id, {
      rescission:
        code === null ? rescission : { ...rescission, renewalStopFailed: { at: now, code } },
      updatedAt: now,
    });
  }
}

/** The indexed ranges participate in OCC, so concurrent creates cannot consume the last slot twice. */
export async function requireEntitySlot(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  kind: "companies" | "projects" | "members",
) {
  const plan = await capacityPlan(ctx, organizationId);
  if (!plan?.capacity) return;
  const limit = plan.capacity[kind];
  if (kind === "members") {
    const org = await ctx.db.get("organizations", organizationId);
    if (!org || org.memberCount >= limit) deny("QUOTA_EXCEEDED");
    return;
  }
  const count =
    kind === "companies"
      ? (
          await ctx.db
            .query("companies")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(limit)
        ).length
      : await integrationCount(ctx, organizationId, limit);
  if (count >= limit) deny("QUOTA_EXCEEDED");
}

/** Called only by the existing fiscal guard after its deadline and hold checks. */
export async function purgePlanRecords(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  budget: Budget,
) {
  const { all, drain, del } = purger(ctx, budget);
  return all(
    () =>
      drain<"capacityFiles">(
        (n) =>
          ctx.db
            .query("capacityFiles")
            .withIndex("by_organizationId_and_storageId", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("capacityFiles"),
      ),
    () =>
      drain<"capacityRecords">(
        (n) =>
          ctx.db
            .query("capacityRecords")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("capacityRecords"),
      ),
    () =>
      drain<"capacityEvents">(
        (n) =>
          ctx.db
            .query("capacityEvents")
            .withIndex("by_organizationId_and_metric_and_key", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("capacityEvents"),
      ),
    () =>
      drain<"capacityTotals">(
        (n) =>
          ctx.db
            .query("capacityTotals")
            .withIndex("by_organizationId_and_period_and_metric", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("capacityTotals"),
      ),
    () =>
      drain<"capacityAccounts">(
        (n) =>
          ctx.db
            .query("capacityAccounts")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("capacityAccounts"),
      ),
    () =>
      drain<"platformPlanRequests">(
        (n) =>
          ctx.db
            .query("platformPlanRequests")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("platformPlanRequests"),
      ),
    () =>
      drain<"platformPlanTerms">(
        (n) =>
          ctx.db
            .query("platformPlanTerms")
            .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("platformPlanTerms"),
      ),
    () =>
      drain<"platformFreeClaims">(
        (n) =>
          ctx.db
            .query("platformFreeClaims")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("platformFreeClaims"),
      ),
    () =>
      drain<"platformPlanReceipts">(
        (n) =>
          ctx.db
            .query("platformPlanReceipts")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("platformPlanReceipts"),
      ),
    () =>
      drain<"billingAccounts">(
        (n) =>
          ctx.db
            .query("billingAccounts")
            .withIndex("by_organizationId_and_livemode", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("billingAccounts"),
      ),
    () =>
      drain<"billingCheckouts">(
        (n) =>
          ctx.db
            .query("billingCheckouts")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("billingCheckouts"),
      ),
    () =>
      drain<"billingGrants">(
        (n) =>
          ctx.db
            .query("billingGrants")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("billingGrants"),
      ),
    () =>
      drain<"billingEvents">(
        (n) =>
          ctx.db
            .query("billingEvents")
            .withIndex("by_organizationId_and_review", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("billingEvents"),
      ),
    () =>
      drain<"platformPlanAllocations">(
        (n) =>
          ctx.db
            .query("platformPlanAllocations")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        async (row) => {
          const settings = await planSettings(ctx);
          if (settings)
            await ctx.db.patch("platformPlanSettings", settings._id, {
              allocatedFilesBytes: settings.allocatedFilesBytes - row.filesBytes,
              allocatedDatabaseBytes: settings.allocatedDatabaseBytes - row.databaseBytes,
              allocatedFreeMonthlyCents: settings.allocatedFreeMonthlyCents - row.freeMonthlyCents,
              // The custody fund was spent, not returned to the company by a legal deletion.
              updatedAt: Date.now(),
            });
          return del("platformPlanAllocations")(row);
        },
      ),
  );
}
