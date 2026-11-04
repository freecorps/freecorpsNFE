import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireMembership, requireManager, deny } from "./lib/organizationAccess";
import { planFields, metrics, reportedMetric } from "./lib/usageValues";
import { countedIn, periodTotals, planFor, sumTotals } from "./lib/usageCore";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { authenticateKey } from "./lib/operationAccess";
import { recordRestRefusal } from "./lib/restLimits";
import { ConvexError } from "convex/values";
import { USAGE_PAUSES, resumeOrganizationCaptures } from "./lib/captureAttention";
import { capacityPolicy, reserveCapacity, commitCapacity } from "./lib/capacityCore";
import { assertOrganizationHot, assertPlanChangeable } from "./lib/coldArchiveCore";
import { allocateOffer } from "./lib/planCore";
import { termCovering } from "./lib/planTerms";
import {
  isPeriodAnchor,
  isPeriodInstant,
  keyPeriod,
  periodKeyStart,
  quotaPeriod,
} from "./lib/quotaPeriod";
import { internal } from "./_generated/api";

const restBudget = v.object({ organizationId: v.id("organizations"), actor: v.string() });
/**
 * The REST reads a key keeps in cold custody (ADR 0009, §2): the non-fiscal routes, by contract
 * name. They stay charged in `restReads`, without the archive refusal; any other read is refused
 * here with `ORGANIZATION_ARCHIVED`, before it is charged.
 */
const CUSTODY_READS: ReadonlySet<string> = new Set([
  "listCompanies",
  "getCompany",
  "getCapabilities",
  "listWebhookEndpoints",
]);
export const chargeRestRead = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    requestId: v.string(),
    route: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const kept = args.route !== null && CUSTODY_READS.has(args.route);
    if (!kept) await assertOrganizationHot(ctx, args.organizationId);
    if (await capacityPolicy(ctx)) {
      await reserveCapacity(ctx, args.organizationId, "restReads", args.requestId, 1, false, {
        archived: "allowed",
      });
      await commitCapacity(ctx, args.organizationId, "restReads", args.requestId);
    }
    return null;
  },
});
/**
 * Resolve selectors under authorization; the domain rechecks access before serving data. The
 * result can come from the query cache after the key expires, so the action compares
 * `expiresAt` with its own clock (#79). `chargeReads` spares GETs the `chargeRestRead`
 * mutation while the capacity policy is off; changing the setting invalidates the cache.
 */
export const restAdmissionScope = internalQuery({
  args: { keyHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      actor: v.string(),
      expiresAt: v.number(),
      chargeReads: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    let key;
    try {
      // Admission is not access: in cold custody the route refuses what the key no longer reaches.
      key = await authenticateKey(ctx, args.keyHash, { archived: "allowed" });
    } catch (error) {
      if (error instanceof ConvexError && error.data?.code === "INVALID_API_KEY") return null;
      throw error;
    }
    return {
      organizationId: key.organizationId,
      actor: `key:${key._id}`,
      expiresAt: key.expiresAt,
      chargeReads: await capacityPolicy(ctx),
    };
  },
});

/** Tickets share the REST budget of their issuing key/member, never a budget per token. */
export const downloadAdmissionScope = internalQuery({
  args: {
    tokenHash: v.string(),
    kind: v.union(v.literal("documentDownload"), v.literal("exportDownload")),
  },
  returns: v.union(v.null(), restBudget),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    if (args.kind === "documentDownload") {
      const ticket = await ctx.db
        .query("documentDownloads")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
        .unique();
      if (!ticket || ticket.expiresAt <= Date.now()) return null;
      const member = await ctx.db.get("memberships", ticket.membershipId);
      if (!member || member.state !== "active" || member.organizationId !== ticket.organizationId)
        return null;
      return { organizationId: ticket.organizationId, actor: `member:${ticket.membershipId}` };
    }
    const ticket = await ctx.db
      .query("exportTickets")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!ticket || ticket.expiresAt <= Date.now()) return null;
    const job = await ctx.db.get("documentExports", ticket.exportId);
    if (!job || job.expiresAt <= Date.now() || job.state !== "succeeded") return null;
    if (job.keyId) {
      const key = await ctx.db.get("apiKeys", job.keyId);
      if (!key || key.revokedAt !== null || key.expiresAt <= Date.now()) return null;
    } else if (job.membershipId) {
      const member = await ctx.db.get("memberships", job.membershipId);
      if (!member || member.state !== "active") return null;
    }
    const actor = job.keyId ? `key:${job.keyId}` : `member:${job.membershipId}`;
    return { organizationId: job.organizationId, actor };
  },
});

export const restRefusal = internalMutation({
  args: { organizationId: v.id("organizations"), actor: v.string(), requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordRestRefusal(ctx, args);
  },
});

/**
 * Only a deployment administrator can assign a negotiated plan. Customer roles cannot grant quota.
 *
 * `periodAnchor` (ADR 0012, section 4): with the catalog off, none by default, and the operator
 * may pass one up to `startsAt`. With it on, the Personalizado always has one, `startsAt` by
 * default, and `endsAt` is the anniversary of it that ends the anchored month under way: a
 * prefunded month at a time. The free tier never has one, and the new row never inherits the
 * anchor of the row it replaces.
 */
export const assignPlan = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    ...planFields,
    expectedVersion: v.number(),
    actor: v.string(),
    reason: v.string(),
    commercial: v.optional(
      v.object({
        monthlyCents: v.number(),
        baseCostCents: v.number(),
        stressCostCents: v.number(),
        custodyCents: v.number(),
        paymentReference: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    if (!(await ctx.db.get("organizations", args.organizationId))) deny("NOT_FOUND");
    if (
      await ctx.db
        .query("organizationClosures")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
        .first()
    )
      deny("ORGANIZATION_CLOSED");
    // The row would replace the annual plan in force; the term ends or is rescinded first. A term
    // scheduled for later replaces this row when it starts, as it replaces any plan.
    if (await termCovering(ctx, args.organizationId, Date.now())) deny("ANNUAL_TERM_ACTIVE");
    // Same rule as `allocateOffer`: an archived organization takes a plan, an archiving one waits.
    await assertPlanChangeable(ctx, args.organizationId);
    // Commercial enrollments go through prefunded admission and payment confirmation.
    const commercialMode = await capacityPolicy(ctx);
    if (commercialMode) {
      const terms = args.commercial;
      if (args.catalogTier !== "custom" || !args.capacity || !terms) deny("PLAN_UNAVAILABLE");
      if (
        Object.values(args.limits).some((n) => n === null) ||
        Object.values(args.capacity).some((n) => !Number.isSafeInteger(n) || n < 1 || n > 1e12) ||
        args.capacity.companies > 1000 ||
        args.capacity.projects > 1000 ||
        args.capacity.members > 1000 ||
        [terms.monthlyCents, terms.baseCostCents, terms.stressCostCents, terms.custodyCents].some(
          (n) => !Number.isSafeInteger(n) || n < 1 || n > 1e12,
        ) ||
        terms.monthlyCents * 60 < terms.baseCostCents * 100 ||
        terms.monthlyCents * 65 < terms.stressCostCents * 100 ||
        !/^[a-zA-Z0-9_-]{8,120}$/.test(terms.paymentReference) ||
        args.startsAt > Date.now() ||
        args.endsAt === null ||
        args.endsAt <= Date.now() ||
        // Checked again below for every plan; here, before the default anchor is taken from it.
        !Number.isSafeInteger(args.startsAt) ||
        args.startsAt < 0 ||
        (args.periodAnchor !== undefined && !isPeriodAnchor(args.periodAnchor)) ||
        args.endsAt !==
          quotaPeriod(
            { periodAnchor: args.periodAnchor ?? Math.floor(args.startsAt / 1000) * 1000 },
            Date.now(),
          ).endsAt
      )
        deny("INVALID_REQUEST");
      if (
        (await ctx.db
          .query("platformPlanReceipts")
          .withIndex("by_paymentReference", (q) => q.eq("paymentReference", terms.paymentReference))
          .first()) ||
        (await ctx.db
          .query("platformPlanRequests")
          .withIndex("by_paymentReference", (q) => q.eq("paymentReference", terms.paymentReference))
          .first())
      )
        deny("OPERATION_CONFLICT");
      await allocateOffer(ctx, args.organizationId, "custom", {
        capacity: args.capacity,
        custodyCents: terms.custodyCents,
        monthlySubsidyCents: 0,
      });
    }
    if (
      !args.name.trim() ||
      args.name.length > 80 ||
      !args.actor.trim() ||
      args.actor.length > 120 ||
      !args.reason.trim() ||
      args.reason.length > 300 ||
      !Number.isSafeInteger(args.startsAt) ||
      args.startsAt < 0 ||
      (args.endsAt !== null &&
        (!Number.isSafeInteger(args.endsAt) || args.endsAt <= args.startsAt)) ||
      !Number.isSafeInteger(args.concurrency) ||
      args.concurrency < 1 ||
      args.concurrency > 32 ||
      Object.values(args.limits).some(
        (n) => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1e12),
      ) ||
      (args.periodAnchor !== undefined &&
        (args.catalogTier === "free" ||
          !isPeriodAnchor(args.periodAnchor) ||
          args.periodAnchor > args.startsAt))
    )
      deny("INVALID_REQUEST");
    const before = await planFor(ctx, args.organizationId);
    if ((before?.version ?? 0) !== args.expectedVersion) deny("OPERATION_CONFLICT");
    const { actor, reason, expectedVersion, commercial, periodAnchor, ...fields } = args;
    const anchor = commercialMode
      ? (periodAnchor ?? Math.floor(args.startsAt / 1000) * 1000)
      : periodAnchor;
    const after = {
      ...fields,
      ...(anchor !== undefined ? { periodAnchor: anchor } : {}),
      version: expectedVersion + 1,
      updatedAt: Date.now(),
    };
    if (before) await ctx.db.replace("usagePlans", before._id, after);
    else await ctx.db.insert("usagePlans", after);
    if (commercialMode && commercial) {
      await ctx.db.insert("platformPlanReceipts", {
        organizationId: args.organizationId,
        ...commercial,
        planVersion: after.version,
        createdAt: Date.now(),
      });
      if (args.endsAt !== null)
        await ctx.scheduler.runAt(args.endsAt, internal.plans.refreshExpiry, {
          organizationId: args.organizationId,
          version: after.version,
        });
    }
    await ctx.db.insert("usagePlanAudit", {
      organizationId: args.organizationId,
      actor,
      reason,
      before: before ? JSON.stringify(before) : null,
      after: JSON.stringify(after),
      createdAt: Date.now(),
    });
    // A production capture paused by the quota or the term is checked again under the new plan.
    await resumeOrganizationCaptures(ctx, args.organizationId, USAGE_PAUSES);
    return after.version;
  },
});
const periodValue = v.object({
  key: v.string(),
  startsAt: v.number(),
  /** Null for an anchored key of an anchor the plan no longer records (`keyPeriod`). */
  endsAt: v.union(v.number(), v.null()),
});
/** How many periods `usage:overview` lists in `recent`. */
const RECENT_PERIODS = 12;
/**
 * The latest distinct period keys counted for the organization, newest first: canonical keys sort
 * as their starts (ADR 0012, section 4). One indexed read per distinct key, at most
 * `2 × RECENT_PERIODS` reads whatever the stored keys are, non-canonical ones skipped.
 */
async function countedKeys(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const keys: string[] = [];
  let below: string | null = null;
  for (let read = 0; read < 2 * RECENT_PERIODS && keys.length < RECENT_PERIODS; read++) {
    const bound: string | null = below;
    const row: Doc<"usageTotals"> | null = await ctx.db
      .query("usageTotals")
      .withIndex("by_organizationId_and_period_and_metric_and_environment", (q) =>
        bound === null
          ? q.eq("organizationId", organizationId)
          : q.eq("organizationId", organizationId).lt("period", bound),
      )
      .order("desc")
      .first();
    if (!row) break;
    if (periodKeyStart(row.period) !== null) keys.push(row.period);
    below = row.period;
  }
  return keys;
}
const usageRow = v.object({
  metric: reportedMetric,
  committed: v.number(),
  reserved: v.number(),
  updatedAt: v.union(v.number(), v.null()),
  startedAt: v.union(v.number(), v.null()),
});
/**
 * The organization's plan and its usage in a quota period, per environment (#429): each
 * environment has its own balance under the same plan limits. A total not yet attributed by the
 * backfill counts in both, as the quota counts it, and `unattributed` says so. `rows` sums every
 * total of the period, as before #429, only for a console published before it; remove it with
 * the required `environment`.
 *
 * The period is `period`, a canonical key (ADR 0012, section 4), or else the plan's quota period
 * holding `asOf`; one of them is required, since a query does not read the clock. The answer
 * names the period, with its start and end, and `recent`, the latest periods with usage, newest
 * first, with the one holding `asOf` and the one asked.
 */
export const overview = query({
  args: {
    organizationId: v.id("organizations"),
    period: v.optional(v.string()),
    asOf: v.optional(v.number()),
    contextKey: v.string(),
  },
  returns: v.object({
    plan: v.union(v.object({ ...planFields, version: v.number() }), v.null()),
    period: periodValue,
    /** The period holding `asOf`; null without it. */
    current: v.union(periodValue, v.null()),
    recent: v.array(periodValue),
    environments: v.object({ sandbox: v.array(usageRow), production: v.array(usageRow) }),
    unattributed: v.boolean(),
    rows: v.array(usageRow),
  }),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership); // Aggregate usage can reveal activity in companies outside a member's grant.
    const asOf = args.asOf;
    if (
      (asOf !== undefined && !isPeriodInstant(asOf)) ||
      (args.period !== undefined && periodKeyStart(args.period) === null) ||
      (args.period === undefined && asOf === undefined)
    )
      deny("INVALID_REQUEST");
    const plan = await planFor(ctx, args.organizationId);
    const current = asOf === undefined ? null : quotaPeriod(plan, asOf);
    const period = args.period === undefined ? current! : keyPeriod(plan, args.period)!;
    const keys = new Set([
      ...(await countedKeys(ctx, args.organizationId)),
      period.key,
      ...(current ? [current.key] : []),
    ]);
    const recent = [...keys]
      .sort()
      .reverse()
      .slice(0, RECENT_PERIODS)
      .map((key) => keyPeriod(plan, key)!);
    const totals = await Promise.all(
      metrics.map(async (metric) => ({
        metric,
        rows: await periodTotals(ctx, args.organizationId, period.key, metric),
      })),
    );
    const view = (counted: (row: Doc<"usageTotals">) => boolean) =>
      totals.map(({ metric, rows }) => ({ metric, ...sumTotals(rows.filter(counted)) }));
    return {
      plan: plan
        ? {
            name: plan.name,
            startsAt: plan.startsAt,
            endsAt: plan.endsAt,
            limits: plan.limits,
            concurrency: plan.concurrency,
            ...(plan.periodAnchor !== undefined ? { periodAnchor: plan.periodAnchor } : {}),
            version: plan.version,
          }
        : null,
      period,
      current,
      recent,
      environments: {
        sandbox: view(countedIn("sandbox")),
        production: view(countedIn("production")),
      },
      unattributed: totals.some(({ rows }) => rows.some((row) => !row.environment)),
      rows: view(() => true),
    };
  },
});
