import { hojeBrasilia } from "@freecorps/fiscal-nfse/pure";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requestCancellation, requestIssuance } from "./issuance";
import { normalizeIssuanceInput } from "./lib/issuanceCore";
import { hasControl } from "./lib/nfseProfileRules";
import { CANCEL_SCOPE, ISSUE_SCOPE, issuanceState, issuanceTaker } from "./lib/issuanceValues";
import { nfseProfileOf } from "./lib/nfseProfile";
import { municipalityState } from "./lib/nfseProfileRules";
import { humanAccess, memberAccess, projectAccess } from "./lib/operationAccess";
import { boundedPagination, deny, limitOrganizationAction } from "./lib/organizationAccess";
import { integrationAudit, requireGrantableCompany, requireProject } from "./lib/projectAccess";
import { findCompany } from "./lib/companyAccess";
import { assertOrganizationHot, inCustody, stableJson } from "./lib/coldArchiveCore";
import { scopeFields } from "./lib/operationValues";
import { readReferences } from "./lib/referenceRead";
import { referenceSearch } from "../../packages/contracts/src/references";
import { encryptSecret } from "./lib/webhookSecrets";
import { planIssuance, type ChargeReading } from "./lib/stripeEvent";
import {
  MAX_CONNECTIONS,
  connectionView,
  stripeCharge,
  stripeConnectionConfig,
  stripeEventState,
  stripeRefundAction,
  stripeReversal,
  type StripeConnectionConfig,
} from "./lib/stripeValues";

/**
 * Stripe connection (ADR 0006). The console configures it; `stripeRest.ts` receives the signed
 * events and hands them to `record`, which deduplicates them; `process` turns a paid charge into
 * an issuance and a full refund into a cancellation, under the connection's project grant.
 */

const MANAGERS: readonly string[] = ["owner", "admin"];

function view(c: Doc<"stripeConnections">): Infer<typeof connectionView> {
  return {
    id: c._id,
    projectId: c.projectId,
    companyId: c.companyId,
    environment: c.environment,
    name: c.name,
    active: c.active,
    config: c.config,
    secretSet: c.secret !== "",
    secretSetAt: c.secretSetAt ?? null,
    lastEventAt: c.lastEventAt ?? null,
    lastFailureAt: c.lastFailureAt ?? null,
    lastFailureCode: c.lastFailureCode ?? null,
    version: c.version,
    createdAt: c.createdAt,
  };
}

type Scope = Pick<
  Doc<"stripeConnections">,
  "organizationId" | "projectId" | "companyId" | "environment"
>;

/**
 * Creating, configuring and disabling a connection: an owner or admin who manages the project,
 * with access to the company, and the project's grant with `documents:issue` (and
 * `documents:cancel` when refunds cancel). The connection issues on its own, like a key with
 * those scopes, which only owners and admins may grant.
 */
async function manageAccess(ctx: QueryCtx, scope: Scope, config: StripeConnectionConfig) {
  const { membership, user, project } = await requireProject(
    ctx,
    scope.organizationId,
    scope.projectId,
  );
  if (!MANAGERS.includes(membership.role)) deny("SCOPE_DENIED");
  const company = await requireGrantableCompany(ctx, membership, scope.companyId);
  if (company.kind === "demonstration") deny("ISSUANCE_DEMONSTRATION_DENIED");
  const { grant } = await projectAccess(ctx, { ...scope, task: { scope: ISSUE_SCOPE } });
  if (config.refundPolicy === "cancel")
    await projectAccess(ctx, { ...scope, task: { scope: CANCEL_SCOPE } }).catch(() =>
      deny("STRIPE_CANCEL_SCOPE_REQUIRED"),
    );
  return { user, project, grant };
}

/**
 * Same rule as `normalizeIssuanceInput`: above zero, at most 5%, up to 4 places with the last
 * two only zeros (the DPS carries 2). Checked here so a bad rate fails when saved, not per charge.
 */
function validIssRate(rate: string) {
  const match = /^(\d)(?:\.(\d{1,4}))?$/.exec(rate);
  return (
    !!match &&
    !/^0(\.0+)?$/.test(rate) &&
    !/[1-9]/.test((match[2] ?? "").slice(2)) &&
    (match[1]! < "5" || (match[1] === "5" && !/[1-9]/.test(match[2] ?? "")))
  );
}

async function validateConfig(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  name: string,
  config: StripeConnectionConfig,
) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) deny("INVALID_REQUEST");
  const description = config.description.trim();
  if (!description || description.length > 2000 || hasControl(description.replace(/[\t\n]/g, " ")))
    deny("STRIPE_DESCRIPTION_INVALID");
  if (!config.invoices && !config.checkouts) deny("STRIPE_TRIGGER_REQUIRED");
  const profile = await nfseProfileOf(ctx, companyId);
  if (!profile) deny("NFSE_PROFILE_REQUIRED");
  // The connection never sends `issuerEmail`: the DPS takes the profile's.
  if (!profile.issuerEmail) deny("STRIPE_ISSUER_EMAIL_REQUIRED");
  const codes = new Set(profile.activities.map((a) => a.code));
  const needsDomestic = config.market !== "export";
  const needsExport = config.market !== "domestic";
  const domestic = config.domesticActivityCode?.trim() || undefined;
  const exported = config.exportActivityCode?.trim() || undefined;
  if (needsDomestic && (!domestic || !codes.has(domestic)))
    deny("STRIPE_DOMESTIC_ACTIVITY_INVALID");
  if (needsExport && (!exported || !codes.has(exported))) deny("STRIPE_EXPORT_ACTIVITY_INVALID");
  const issRate = config.issRate?.trim() || undefined;
  // Same shape the issuance accepts (at most 5%, 4 places); the issuance checks it again.
  if (issRate !== undefined && (!needsDomestic || !validIssRate(issRate)))
    deny("STRIPE_ISS_RATE_INVALID");
  return {
    name: trimmed,
    config: {
      market: config.market,
      ...(needsDomestic ? { domesticActivityCode: domestic } : {}),
      ...(needsExport ? { exportActivityCode: exported } : {}),
      description,
      ...(issRate !== undefined ? { issRate } : {}),
      invoices: config.invoices,
      checkouts: config.checkouts,
      foreignWithoutNif: config.foreignWithoutNif,
      refundPolicy: config.refundPolicy,
    },
  };
}

export const listConnections = query({
  args: { organizationId: v.id("organizations"), projectId: v.id("projects") },
  returns: v.array(connectionView),
  handler: async (ctx, args) => {
    const { membership } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    const rows = await ctx.db
      .query("stripeConnections")
      .withIndex("by_projectId_and_companyId_and_environment", (q) =>
        q.eq("projectId", args.projectId),
      )
      .take(100);
    // Like the project's webhooks: only connections of companies the member reaches.
    const visible = [];
    for (const c of rows)
      if (
        c.organizationId === args.organizationId &&
        (await findCompany(ctx, membership, c.companyId))
      )
        visible.push(view(c));
    return visible;
  },
});

export const createConnection = mutation({
  args: { ...scopeFields, name: v.string(), config: stripeConnectionConfig },
  returns: connectionView,
  handler: async (ctx, args) => {
    const scope = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      companyId: args.companyId,
      environment: args.environment,
    };
    // Access first: whoever lacks it learns nothing about the configuration rules.
    const { user, project, grant } = await manageAccess(ctx, scope, args.config);
    const fields = await validateConfig(ctx, args.companyId, args.name, args.config);
    await limitOrganizationAction(ctx, "stripe-connection", args.projectId);
    const current = await ctx.db
      .query("stripeConnections")
      .withIndex("by_projectId_and_companyId_and_environment", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("companyId", args.companyId)
          .eq("environment", args.environment),
      )
      .take(MAX_CONNECTIONS);
    if (current.length >= MAX_CONNECTIONS) deny("STRIPE_CONNECTION_LIMIT");
    const now = Date.now();
    const id = await ctx.db.insert("stripeConnections", {
      ...scope,
      ...fields,
      active: true,
      secret: "",
      projectEpoch: project.accessEpoch,
      grantEpoch: grant.accessEpoch,
      version: 1,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    await integrationAudit(ctx, project, user._id, "stripe.connection_created", id);
    return view((await ctx.db.get("stripeConnections", id))!);
  },
});

/**
 * Revoking a connection is kept in cold custody (ADR 0009, §2): an owner or admin who manages the
 * project, with access to the company, switches it off. The project's grant is not checked, since
 * it goes through the archive refusal of `projectAccess`, and switching off issues nothing. Name
 * and configuration must stay as they are and `active` must be false; anything else is refused
 * with `ORGANIZATION_ARCHIVED`.
 */
async function disableInCustody(
  ctx: MutationCtx,
  connection: Doc<"stripeConnections">,
  args: { expectedVersion: number; name: string; config: StripeConnectionConfig; active: boolean },
) {
  const { membership, user, project } = await requireProject(
    ctx,
    connection.organizationId,
    connection.projectId,
    { archived: "allowed" },
  );
  if (!MANAGERS.includes(membership.role)) deny("SCOPE_DENIED");
  await requireGrantableCompany(ctx, membership, connection.companyId);
  if (
    args.active ||
    args.name.trim() !== connection.name ||
    stableJson(args.config) !== stableJson(connection.config)
  )
    await assertOrganizationHot(ctx, connection.organizationId);
  if (connection.version !== args.expectedVersion) deny("STRIPE_CONNECTION_CHANGED");
  await ctx.db.patch("stripeConnections", connection._id, {
    active: false,
    version: connection.version + 1,
    updatedAt: Date.now(),
  });
  await integrationAudit(ctx, project, user._id, "stripe.connection_disabled", connection._id);
  return view((await ctx.db.get("stripeConnections", connection._id))!);
}
export const updateConnection = mutation({
  args: {
    connectionId: v.id("stripeConnections"),
    expectedVersion: v.number(),
    name: v.string(),
    config: stripeConnectionConfig,
    active: v.boolean(),
  },
  returns: connectionView,
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("stripeConnections", args.connectionId);
    if (!connection) return deny("NOT_FOUND");
    if (await inCustody(ctx, connection.organizationId))
      return disableInCustody(ctx, connection, args);
    // Access first: whoever lacks it learns nothing about the configuration rules.
    const { user, project, grant } = await manageAccess(ctx, connection, args.config);
    const fields = await validateConfig(ctx, connection.companyId, args.name, args.config);
    if (connection.version !== args.expectedVersion) deny("STRIPE_CONNECTION_CHANGED");
    // Saving re-pins the grant in force: whoever saves vouches for the connection again.
    await ctx.db.patch("stripeConnections", connection._id, {
      ...fields,
      active: args.active,
      projectEpoch: project.accessEpoch,
      grantEpoch: grant.accessEpoch,
      version: connection.version + 1,
      updatedAt: Date.now(),
    });
    await integrationAudit(
      ctx,
      project,
      user._id,
      args.active ? "stripe.connection_updated" : "stripe.connection_disabled",
      connection._id,
    );
    return view((await ctx.db.get("stripeConnections", connection._id))!);
  },
});

/** The `whsec_…` of the Stripe endpoint. Stored encrypted and never returned. */
export const setSigningSecret = mutation({
  args: { connectionId: v.id("stripeConnections"), secret: v.string() },
  returns: connectionView,
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("stripeConnections", args.connectionId);
    if (!connection) return deny("NOT_FOUND");
    const { user, project } = await manageAccess(ctx, connection, connection.config);
    const secret = args.secret.trim();
    if (!/^whsec_[A-Za-z0-9+/=_-]{16,200}$/.test(secret)) deny("STRIPE_SECRET_INVALID");
    const now = Date.now();
    await ctx.db.patch("stripeConnections", connection._id, {
      secret: await encryptSecret(secret, `stripe:${connection._id}`),
      secretSetAt: now,
      lastFailureAt: undefined,
      lastFailureCode: undefined,
      // Not a configuration change: `version` stays, so an open draft of the form still saves.
      updatedAt: now,
    });
    await integrationAudit(ctx, project, user._id, "stripe.secret_set", connection._id);
    return view((await ctx.db.get("stripeConnections", connection._id))!);
  },
});

const eventView = v.object({
  id: v.id("stripeEvents"),
  stripeEventId: v.string(),
  type: v.string(),
  livemode: v.boolean(),
  state: stripeEventState,
  code: v.union(v.string(), v.null()),
  charge: v.union(stripeCharge, v.null()),
  reversal: v.union(stripeReversal, v.null()),
  missing: v.array(v.string()),
  taker: v.union(issuanceTaker, v.null()),
  issuance: v.union(
    v.object({
      id: v.id("issuances"),
      state: issuanceState,
      series: v.string(),
      number: v.number(),
      nfseNumber: v.union(v.string(), v.null()),
      code: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  refundAction: v.union(stripeRefundAction, v.null()),
  receivedAt: v.number(),
  updatedAt: v.number(),
});

/** People read the events like the issuances of the company (ADR 0005), whatever the project. */
async function readAccess(ctx: QueryCtx, connection: Doc<"stripeConnections">) {
  await humanAccess(ctx, { ...connection, task: { scope: ISSUE_SCOPE } }, false);
}

export const listEvents = query({
  args: {
    connectionId: v.id("stripeConnections"),
    state: v.optional(stripeEventState),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(eventView),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("stripeConnections", args.connectionId);
    if (!connection) return deny("NOT_FOUND");
    await readAccess(ctx, connection);
    const base = args.state
      ? ctx.db
          .query("stripeEvents")
          .withIndex("by_connectionId_and_state_and_receivedAt", (q) =>
            q.eq("connectionId", connection._id).eq("state", args.state!),
          )
      : ctx.db
          .query("stripeEvents")
          .withIndex("by_connectionId_and_receivedAt", (q) => q.eq("connectionId", connection._id));
    const page = await base.order("desc").paginate(boundedPagination(args.paginationOpts));
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (e) => {
          const issuance = e.issuanceId ? await ctx.db.get("issuances", e.issuanceId) : null;
          return {
            id: e._id,
            stripeEventId: e.stripeEventId,
            type: e.type,
            livemode: e.livemode,
            state: e.state,
            code: e.code ?? null,
            charge: e.charge ?? null,
            reversal: e.reversal ?? null,
            missing: e.missing ?? [],
            taker: e.taker ?? null,
            issuance: issuance
              ? {
                  id: issuance._id,
                  state: issuance.state,
                  series: issuance.series,
                  number: issuance.number,
                  nfseNumber: issuance.nfseNumber ?? null,
                  code: issuance.code ?? null,
                }
              : null,
            refundAction: e.refundAction ?? null,
            receivedAt: e.receivedAt,
            updatedAt: e.updatedAt,
          };
        }),
      ),
    };
  },
});

/**
 * A person with write access to the company releases a held charge: completing the taker
 * (`pending_data`), retrying after a refusal (`failed`), or issuing again after the NFS-e was
 * rejected by the tax authority. The issuance still goes out under the connection's grant.
 */
async function releaseAccess(ctx: MutationCtx, eventId: Id<"stripeEvents">) {
  const event = await ctx.db.get("stripeEvents", eventId);
  if (!event) return deny("NOT_FOUND");
  const { user } = await memberAccess(ctx, { ...event, task: { scope: ISSUE_SCOPE } }, true);
  if (!event.charge) deny("STRIPE_EVENT_NOT_RELEASABLE");
  return { event, user };
}
async function requeue(
  ctx: MutationCtx,
  event: Doc<"stripeEvents">,
  patch: Partial<Doc<"stripeEvents">>,
) {
  await ctx.db.patch("stripeEvents", event._id, {
    ...patch,
    state: "queued",
    code: undefined,
    missing: undefined,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.stripe.processEvent, {
    eventId: event._id,
    step: "issue",
  });
}

export const completeEvent = mutation({
  args: { eventId: v.id("stripeEvents"), taker: issuanceTaker },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, user } = await releaseAccess(ctx, args.eventId);
    if (event.state !== "pending_data" && event.state !== "failed")
      deny("STRIPE_EVENT_NOT_RELEASABLE");
    // Refuse a bad taker now, with the issuance's own codes, rather than as a failed event later.
    const connection = await ctx.db.get("stripeConnections", event.connectionId);
    if (!connection) return deny("NOT_FOUND");
    const plan = planIssuance({
      config: connection.config,
      charge: event.charge!,
      taker: args.taker,
    });
    if (plan.kind !== "ready") return deny(plan.kind === "pending" ? "INVALID_REQUEST" : plan.code);
    normalizeIssuanceInput(plan.input);
    await requeue(ctx, event, { taker: args.taker, completedBy: user._id });
    return null;
  },
});

export const retryEvent = mutation({
  args: { eventId: v.id("stripeEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, user } = await releaseAccess(ctx, args.eventId);
    if (event.state === "pending_data" || event.state === "failed") {
      await requeue(ctx, event, { completedBy: user._id });
      return null;
    }
    const issuance = event.issuanceId ? await ctx.db.get("issuances", event.issuanceId) : null;
    if (event.state !== "issued" || issuance?.state !== "rejected")
      deny("STRIPE_EVENT_NOT_RELEASABLE");
    await requeue(ctx, event, {
      attempt: (event.attempt ?? 0) + 1,
      issuanceId: undefined,
      completedBy: user._id,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Webhook side: called by `stripeRest.ts` after the signature checked out.

export const webhookTarget = internalQuery({
  args: { connectionId: v.string() },
  returns: v.union(v.object({ id: v.id("stripeConnections"), secret: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("stripeConnections", args.connectionId);
    const connection = id ? await ctx.db.get("stripeConnections", id) : null;
    if (!connection) return null;
    return { id: connection._id, secret: connection.secret };
  },
});

/** Last signature failure, shown in the setup guide. At most one write per minute. */
export const noteFailure = internalMutation({
  args: { connectionId: v.id("stripeConnections"), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get("stripeConnections", args.connectionId);
    if (!connection) return null;
    const now = Date.now();
    if (connection.lastFailureCode === args.code && (connection.lastFailureAt ?? 0) > now - 60_000)
      return null;
    await ctx.db.patch("stripeConnections", connection._id, {
      lastFailureAt: now,
      lastFailureCode: args.code,
    });
    return null;
  },
});

const reading = v.union(
  v.object({ kind: v.literal("charge"), charge: stripeCharge }),
  v.object({ kind: v.literal("reversal"), reversal: stripeReversal }),
  v.object({ kind: v.literal("ignored"), code: v.string() }),
);

/**
 * Records a signed event once (by its Stripe id) and says what comes next. A charge already
 * recorded by another event (completed, then async succeeded) is a duplicate: the first row
 * carries the issuance. Never throws for what the event says: Stripe gets 200 either way.
 */
export const record = internalMutation({
  args: {
    connectionId: v.id("stripeConnections"),
    stripeEventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    reading,
  },
  returns: v.object({
    eventId: v.id("stripeEvents"),
    next: v.union(v.literal("issue"), v.literal("cancel"), v.null()),
  }),
  handler: async (ctx, args) => {
    const connection = (await ctx.db.get("stripeConnections", args.connectionId))!;
    const seen = await ctx.db
      .query("stripeEvents")
      .withIndex("by_connectionId_and_stripeEventId", (q) =>
        q.eq("connectionId", connection._id).eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (seen) return { eventId: seen._id, next: null };
    const now = Date.now();
    await ctx.db.patch("stripeConnections", connection._id, { lastEventAt: now });
    const base = {
      organizationId: connection.organizationId,
      projectId: connection.projectId,
      companyId: connection.companyId,
      environment: connection.environment,
      connectionId: connection._id,
      stripeEventId: args.stripeEventId,
      type: args.type,
      livemode: args.livemode,
      receivedAt: now,
      updatedAt: now,
    };
    const ignore = async (code: string, extra: Partial<Doc<"stripeEvents">> = {}) => ({
      eventId: await ctx.db.insert("stripeEvents", { ...base, ...extra, state: "ignored", code }),
      next: null,
    });
    const r = args.reading as ChargeReading;
    if (!connection.active) return ignore("CONNECTION_DISABLED");
    // A test-mode payment never becomes a production NFS-e. Sandbox accepts both (ADR 0006 §6).
    if (connection.environment === "production" && !args.livemode)
      return ignore("LIVEMODE_MISMATCH");
    if (r.kind === "ignored") return ignore(r.code);
    if (r.kind === "charge") {
      const { charge } = r;
      const keys = {
        charge,
        chargeId: charge.id,
        ...(charge.paymentIntentId ? { paymentIntentId: charge.paymentIntentId } : {}),
      };
      if (charge.kind === "invoice" ? !connection.config.invoices : !connection.config.checkouts)
        return ignore("TRIGGER_DISABLED", keys);
      const earlier = await ctx.db
        .query("stripeEvents")
        .withIndex("by_connectionId_and_chargeId", (q) =>
          q.eq("connectionId", connection._id).eq("chargeId", charge.id),
        )
        .take(20);
      const first = earlier.find((e) => e.state !== "ignored" && e.state !== "refund");
      if (first)
        return ignore("DUPLICATE_CHARGE", {
          chargeId: charge.id,
          ...(first.issuanceId ? { issuanceId: first.issuanceId } : {}),
        });
      return {
        eventId: await ctx.db.insert("stripeEvents", { ...base, ...keys, state: "queued" }),
        next: "issue" as const,
      };
    }
    const { reversal } = r;
    const refundRow = (code: string, extra: Partial<Doc<"stripeEvents">> = {}) =>
      ctx.db.insert("stripeEvents", {
        ...base,
        reversal,
        ...(reversal.paymentIntentId ? { paymentIntentId: reversal.paymentIntentId } : {}),
        ...extra,
        state: "refund",
        code,
      });
    if (!reversal.total)
      return {
        eventId: await refundRow(
          reversal.kind === "refund" ? "PARTIAL_REFUND" : "DISPUTE_NOT_LOST",
        ),
        next: null,
      };
    const charged = reversal.paymentIntentId
      ? (
          await ctx.db
            .query("stripeEvents")
            .withIndex("by_connectionId_and_paymentIntentId", (q) =>
              q.eq("connectionId", connection._id).eq("paymentIntentId", reversal.paymentIntentId),
            )
            .take(20)
        ).find((e) => e.state === "issued" && e.issuanceId)
      : undefined;
    if (!charged) return { eventId: await refundRow("NO_ISSUANCE"), next: null };
    const link = { chargeId: charged.chargeId, issuanceId: charged.issuanceId };
    if (connection.config.refundPolicy === "notify") {
      const eventId = await refundRow("CANCEL_SUGGESTED", link);
      await ctx.db.patch("stripeEvents", charged._id, {
        refundAction: "suggested",
        refundEventId: eventId,
        updatedAt: now,
      });
      return { eventId, next: null };
    }
    const eventId = await refundRow("CANCEL_QUEUED", link);
    await ctx.db.patch("stripeEvents", charged._id, { refundEventId: eventId, updatedAt: now });
    return { eventId, next: "cancel" as const };
  },
});

/** IBGE code of a Brazilian customer's city, from the municipalities reference; none if unsure. */
async function municipalityOf(ctx: QueryCtx, city?: string, state?: string) {
  if (!city || !state) return undefined;
  const uf = state.trim().toUpperCase();
  try {
    const found = await readReferences(ctx, {
      dataset: "municipalities",
      date: hojeBrasilia(new Date()),
      q: city.slice(0, 100),
      limit: 50,
    });
    if (!("page" in found)) return undefined;
    const key = referenceSearch(city);
    const matches = found.page.filter(
      (m) => referenceSearch(m.description) === key && municipalityState(m.code) === uf,
    );
    return matches.length === 1 ? matches[0]!.code : undefined;
  } catch {
    return undefined;
  }
}

export const issueEvent = internalMutation({
  args: { eventId: v.id("stripeEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("stripeEvents", args.eventId);
    if (!event || event.state !== "queued" || !event.charge) return null;
    const connection = await ctx.db.get("stripeConnections", event.connectionId);
    const now = Date.now();
    if (!connection?.active) {
      await ctx.db.patch("stripeEvents", event._id, {
        state: "failed",
        code: "CONNECTION_DISABLED",
        updatedAt: now,
      });
      return null;
    }
    const customer = event.charge.customer;
    const municipalityCode =
      !event.taker && connection.config.market !== "export" && (customer.country ?? "BR") === "BR"
        ? await municipalityOf(ctx, customer.city, customer.state)
        : undefined;
    const plan = planIssuance({
      config: connection.config,
      charge: event.charge,
      ...(municipalityCode ? { municipalityCode } : {}),
      ...(event.taker ? { taker: event.taker } : {}),
    });
    if (plan.kind === "pending") {
      await ctx.db.patch("stripeEvents", event._id, {
        state: "pending_data",
        missing: plan.missing,
        updatedAt: now,
      });
      return null;
    }
    if (plan.kind !== "ready") {
      await ctx.db.patch("stripeEvents", event._id, {
        state: plan.kind === "ignored" ? "ignored" : "failed",
        code: plan.code,
        updatedAt: now,
      });
      return null;
    }
    const key = event.attempt
      ? `stripe:${event.charge.id}:${event.attempt}`
      : `stripe:${event.charge.id}`;
    const { issuance } = await requestIssuance(
      ctx,
      {
        organizationId: connection.organizationId,
        projectId: connection.projectId,
        companyId: connection.companyId,
        environment: connection.environment,
      },
      key,
      plan.input,
      undefined,
      connection._id,
    );
    await ctx.db.patch("stripeEvents", event._id, {
      state: "issued",
      issuanceId: issuance.id as Id<"issuances">,
      updatedAt: now,
    });
    return null;
  },
});

export const cancelEvent = internalMutation({
  args: { eventId: v.id("stripeEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("stripeEvents", args.eventId);
    if (!event || event.code !== "CANCEL_QUEUED" || !event.issuanceId || !event.reversal)
      return null;
    const connection = await ctx.db.get("stripeConnections", event.connectionId);
    if (!connection) return null;
    const what = event.reversal.kind === "refund" ? "Cobrança reembolsada" : "Disputa perdida";
    await requestCancellation(
      ctx,
      {
        organizationId: connection.organizationId,
        projectId: connection.projectId,
        companyId: connection.companyId,
        environment: connection.environment,
      },
      `stripe-cancel:${event.reversal.id}`,
      {
        issuanceId: event.issuanceId,
        reasonCode: "9",
        reason: `${what} no Stripe (${event.reversal.id}).`,
      },
      undefined,
      connection._id,
    );
    const now = Date.now();
    await ctx.db.patch("stripeEvents", event._id, { code: "CANCEL_REQUESTED", updatedAt: now });
    const charged = await chargeRowOf(ctx, event);
    if (charged)
      await ctx.db.patch("stripeEvents", charged._id, {
        refundAction: "requested",
        updatedAt: now,
      });
    return null;
  },
});

async function chargeRowOf(ctx: QueryCtx, refund: Doc<"stripeEvents">) {
  if (!refund.issuanceId) return null;
  const rows = await ctx.db
    .query("stripeEvents")
    .withIndex("by_issuanceId", (q) => q.eq("issuanceId", refund.issuanceId))
    .take(20);
  return rows.find((e) => e.state === "issued") ?? null;
}

/** A refused request leaves its code on the row; nothing was reserved (or it rolled back). */
export const failEvent = internalMutation({
  args: {
    eventId: v.id("stripeEvents"),
    step: v.union(v.literal("issue"), v.literal("cancel")),
    code: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("stripeEvents", args.eventId);
    if (!event) return null;
    const now = Date.now();
    if (args.step === "issue") {
      if (event.state === "queued")
        await ctx.db.patch("stripeEvents", event._id, {
          state: "failed",
          code: args.code,
          updatedAt: now,
        });
      return null;
    }
    await ctx.db.patch("stripeEvents", event._id, { code: args.code, updatedAt: now });
    const charged = await chargeRowOf(ctx, event);
    if (charged)
      await ctx.db.patch("stripeEvents", charged._id, { refundAction: "failed", updatedAt: now });
    return null;
  },
});

function errorCode(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code =
    data && typeof data === "object" && "code" in data && typeof data.code === "string"
      ? data.code
      : null;
  return code && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "STRIPE_PROCESSING_FAILED";
}

/**
 * Runs one step in its own transaction, so a refusal rolls back everything the step wrote and
 * only the code is kept. Called by the webhook right after `record`, and by the console.
 */
export const processEvent = internalAction({
  args: { eventId: v.id("stripeEvents"), step: v.union(v.literal("issue"), v.literal("cancel")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      if (args.step === "issue")
        await ctx.runMutation(internal.stripe.issueEvent, { eventId: args.eventId });
      else await ctx.runMutation(internal.stripe.cancelEvent, { eventId: args.eventId });
    } catch (error) {
      await ctx.runMutation(internal.stripe.failEvent, { ...args, code: errorCode(error) });
    }
    return null;
  },
});
