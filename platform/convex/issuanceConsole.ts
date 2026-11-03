import { companyCapabilities } from "@freecorps/contracts";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requestCancellation, requestIssuance } from "./issuance";
import { baseEnvironment } from "./lib/environmentAccess";
import { findCompany } from "./lib/companyAccess";
import { isIssuanceProductionDeployment, productionCompanies } from "./lib/issuanceProduction";
import {
  issuanceAccess,
  issuanceView,
  productionGate as productionGateOf,
  scopedIssuance,
  transportModeFor,
  type IssuanceScope,
  type IssuanceSnapshot,
} from "./lib/issuanceCore";
import {
  cancelReason,
  issuanceEventKind,
  issuanceInput,
  issuanceState,
  issuanceTaker,
  issuanceView as issuanceViewValidator,
  transportMode,
} from "./lib/issuanceValues";
import { originOf, recordOrigin } from "./lib/operationAccess";
import { companyScopeFields } from "./lib/operationValues";
import {
  boundedPagination,
  deny,
  limitOrganizationAction,
  requireMembership,
} from "./lib/organizationAccess";
import { ensureConsoleProject } from "./lib/projectAccess";
import { hashApiKey } from "./lib/apiKeyCrypto";

/**
 * Console entry of the NFS-e issuance, for Better Auth sessions. The rules live in the internal
 * helpers of `issuance.ts`: these functions only bind the session to them. People work on the
 * company, with no project: reading needs access to the company and a reading role (owner,
 * admin, operator, viewer); issuing and cancelling need a role that operates documents (owner,
 * admin, operator), the same that imports XML. What the console creates belongs to the
 * organization's console project, which has no API keys or webhooks. `organizationId`,
 * `companyId` and ids are selectors.
 */
type ConsoleScope = Omit<IssuanceScope, "projectId">;

/** Session reads: same check as the internal `get`/`list`, never an API key. */
const readAccess = (ctx: QueryCtx, scope: ConsoleScope) => issuanceAccess(ctx, scope, "read");

/** Console project of the organization, created by the first issuance or cancellation. */
async function consoleScope(ctx: MutationCtx, scope: ConsoleScope): Promise<IssuanceScope> {
  const { membership } = await requireMembership(ctx, scope.organizationId);
  return { ...scope, projectId: await ensureConsoleProject(ctx, membership) };
}

/** Company and what the member may do there. Unknown or forbidden selectors are `null`. */
export const context = query({
  args: { organizationId: v.id("organizations"), company: v.string() },
  returns: v.object({
    companyId: v.union(v.id("companies"), v.null()),
    company: v.union(
      v.object({
        name: v.string(),
        cnpj: v.string(),
        demonstration: v.boolean(),
      }),
      v.null(),
    ),
    /** Role may issue and cancel; the server checks again on every request. */
    canIssue: v.boolean(),
    /** Transport this deployment would use for the company, in the deployment's environment. */
    transport: transportMode,
    /**
     * On the fiscal production deployment, for owners and admins only: whether new invoices are
     * open for the company (company listed and gate on) and since when. Never who changed it.
     */
    productionGate: v.union(
      v.null(),
      v.object({ open: v.boolean(), since: v.union(v.number(), v.null()) }),
    ),
  }),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    // The same reading as `deployment.current`. A production deployment that is not the fiscal
    // production one (the #50 target) never issues: the request ends in NOT_FOUND there.
    const environment = baseEnvironment();
    const issues = environment === "sandbox" || isIssuanceProductionDeployment();
    const empty = {
      companyId: null,
      company: null,
      canIssue: false,
      transport: environment === "production" ? ("producao" as const) : ("simulated" as const),
      productionGate: null,
    };
    const companyId = ctx.db.normalizeId("companies", args.company);
    const access = companyId ? await findCompany(ctx, membership, companyId) : null;
    if (!companyId || !access) return empty;
    // In the sandbox, the real transport is opened per company; every other company stays in
    // the simulator. In production, the transport is always the real production.
    const transport = transportModeFor({ environment, companyId });
    const demonstration = access.company.kind === "demonstration";
    const company = { name: access.company.name, cnpj: access.company.cnpj, demonstration };
    const canIssue =
      issues && companyCapabilities(membership.role).operateDocuments && !demonstration;
    let productionGate: { open: boolean; since: number | null } | null = null;
    if (isIssuanceProductionDeployment() && companyCapabilities(membership.role).manage) {
      const gate = await productionGateOf(ctx, companyId);
      const open =
        productionCompanies().has(companyId) &&
        !!gate?.production &&
        gate.organizationId === args.organizationId;
      productionGate = { open, since: open ? gate!.updatedAt : null };
    }
    return { companyId, company, canIssue, transport, productionGate };
  },
});

function frozenSnapshot(issuance: Doc<"issuances">) {
  return JSON.parse(issuance.snapshot) as IssuanceSnapshot;
}
const listRow = v.object({
  ...issuanceViewValidator.fields,
  takerName: v.string(),
  origin: recordOrigin,
});

/**
 * Newest first, every issuance of the company: from the console and from the integrations.
 * Optional filters: the persisted state and the request period (`createdAt`, inclusive
 * milliseconds), within the same company index.
 */
export const list = query({
  args: {
    ...companyScopeFields,
    paginationOpts: paginationOptsValidator,
    state: v.optional(issuanceState),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  returns: paginationResultValidator(listRow),
  handler: async (ctx, { paginationOpts, state, from, to, ...scope }) => {
    await readAccess(ctx, scope);
    const valid = (value: number | undefined) =>
      value === undefined || (Number.isSafeInteger(value) && value >= 0);
    if (!valid(from) || !valid(to) || (from !== undefined && to !== undefined && to < from))
      return deny("INVALID_REQUEST");
    let query = ctx.db
      .query("issuances")
      .withIndex("by_organizationId_and_companyId_and_environment_and_createdAt", (q) => {
        const base = q
          .eq("organizationId", scope.organizationId)
          .eq("companyId", scope.companyId)
          .eq("environment", scope.environment);
        if (from !== undefined && to !== undefined)
          return base.gte("createdAt", from).lte("createdAt", to);
        if (from !== undefined) return base.gte("createdAt", from);
        if (to !== undefined) return base.lte("createdAt", to);
        return base;
      })
      .order("desc");
    if (state) query = query.filter((q) => q.eq(q.field("state"), state));
    const page = await query.paginate(boundedPagination(paginationOpts));
    const rows = [];
    for (const row of page.page)
      rows.push({
        ...(await issuanceView(ctx, row)),
        takerName: frozenSnapshot(row).taker.name,
        origin: await originOf(ctx, row),
      });
    return { ...page, page: rows };
  },
});

/** The frozen (normalized) taker back in the request's shape, without derived fields. */
function takerInput(taker: IssuanceSnapshot["taker"]): Infer<typeof issuanceTaker> {
  const email = taker.email ? { email: taker.email } : {};
  if (taker.kind === "national")
    return {
      kind: "national",
      document: taker.document,
      name: taker.name,
      ...email,
      address: {
        municipalityCode: taker.address.municipalityCode,
        postalCode: taker.address.postalCode,
        street: taker.address.street,
        number: taker.address.number,
        district: taker.address.district,
      },
    };
  const { country, city, postalCode, state, street, number, district } = taker.address;
  return {
    kind: "foreign",
    ...(taker.nif ? { nif: taker.nif } : {}),
    ...(taker.nifAbsence ? { nifAbsence: taker.nifAbsence } : {}),
    name: taker.name,
    ...email,
    address: {
      country,
      city,
      ...(postalCode ? { postalCode } : {}),
      ...(state ? { state } : {}),
      ...(street ? { street } : {}),
      ...(number ? { number } : {}),
      ...(district ? { district } : {}),
    },
  };
}

/**
 * The request of an issuance as the form takes it, to correct a rejected one and ask again. A
 * new request gets a new idempotency key and a new DPS number; nothing here reuses the old one.
 * Read access, the same as the detail: the data is the frozen snapshot shown there.
 */
export const resubmission = query({
  args: { ...companyScopeFields, issuanceId: v.string() },
  returns: issuanceInput,
  handler: async (ctx, { issuanceId, ...scope }) => {
    await readAccess(ctx, scope);
    const snapshot = frozenSnapshot(await scopedIssuance(ctx, scope, issuanceId));
    return {
      activityCode: snapshot.activity.code,
      competence: snapshot.competence,
      issuerEmail: snapshot.issuer.email,
      market: snapshot.market,
      taker: takerInput(snapshot.taker),
      description: snapshot.description,
      amount: snapshot.amount,
      ...(snapshot.iss.rate ? { issRate: snapshot.iss.rate } : {}),
      issWithheld: snapshot.iss.withheld,
    };
  },
});

/**
 * Takers of the company's latest issuances, newest first and one per document (CPF, CNPJ or
 * NIF), so the form can suggest a frequent one. Only this company: the same data its detail
 * already shows to whoever reads it.
 */
export const recentTakers = query({
  args: companyScopeFields,
  returns: v.array(v.object({ taker: issuanceTaker, lastUsedAt: v.number() })),
  handler: async (ctx, scope) => {
    await readAccess(ctx, scope);
    const rows = await ctx.db
      .query("issuances")
      .withIndex("by_organizationId_and_companyId_and_environment_and_createdAt", (q) =>
        q
          .eq("organizationId", scope.organizationId)
          .eq("companyId", scope.companyId)
          .eq("environment", scope.environment),
      )
      .order("desc")
      .take(50);
    const seen = new Set<string>();
    const takers = [];
    for (const row of rows) {
      const taker = takerInput(frozenSnapshot(row).taker);
      const identity =
        taker.kind === "national"
          ? `national:${taker.document}`
          : `foreign:${taker.address.country}:${taker.nif ?? taker.name.toUpperCase()}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      takers.push({ taker, lastUsedAt: row.createdAt });
      if (takers.length === 8) break;
    }
    return takers;
  },
});

const takerView = v.union(
  v.object({
    kind: v.literal("national"),
    documentType: v.union(v.literal("CPF"), v.literal("CNPJ")),
    document: v.string(),
    name: v.string(),
    email: v.union(v.string(), v.null()),
    address: v.object({
      municipalityCode: v.string(),
      postalCode: v.string(),
      street: v.string(),
      number: v.string(),
      district: v.string(),
    }),
  }),
  v.object({
    kind: v.literal("foreign"),
    nif: v.union(v.string(), v.null()),
    nifAbsence: v.union(v.literal(1), v.literal(2), v.null()),
    name: v.string(),
    email: v.union(v.string(), v.null()),
    address: v.object({
      country: v.string(),
      city: v.string(),
      postalCode: v.union(v.string(), v.null()),
      state: v.union(v.string(), v.null()),
      street: v.union(v.string(), v.null()),
      number: v.union(v.string(), v.null()),
      district: v.union(v.string(), v.null()),
    }),
  }),
);

/** Issuance with the frozen request (as accepted) and its history. */
export const detail = query({
  args: { ...companyScopeFields, issuanceId: v.string() },
  returns: v.object({
    issuance: issuanceViewValidator,
    snapshot: v.object({
      acceptedAt: v.number(),
      dhEmi: v.string(),
      dCompet: v.string(),
      issuer: v.object({ cnpj: v.string(), name: v.string(), email: v.string() }),
      profileVersion: v.number(),
      municipalityCode: v.string(),
      activity: v.object({
        code: v.string(),
        label: v.string(),
        cTribNac: v.string(),
        nbs: v.union(v.string(), v.null()),
      }),
      taker: takerView,
      description: v.string(),
      iss: v.object({
        rate: v.union(v.string(), v.null()),
        withheld: v.boolean(),
        amount: v.union(v.string(), v.null()),
      }),
    }),
    events: v.array(
      v.object({ kind: issuanceEventKind, code: v.union(v.string(), v.null()), at: v.number() }),
    ),
    canCancel: v.boolean(),
    /** Console or the integration that requested it; cancelling is allowed for any origin. */
    origin: recordOrigin,
  }),
  handler: async (ctx, { issuanceId, ...scope }) => {
    await readAccess(ctx, scope);
    const row = await scopedIssuance(ctx, scope, issuanceId);
    const snapshot = frozenSnapshot(row);
    const { membership } = await requireMembership(ctx, scope.organizationId);
    const events = await ctx.db
      .query("issuanceEvents")
      .withIndex("by_issuanceId", (q) => q.eq("issuanceId", row._id))
      .take(100);
    const view = await issuanceView(ctx, row);
    const taker = snapshot.taker;
    return {
      issuance: view,
      snapshot: {
        acceptedAt: snapshot.acceptedAt,
        dhEmi: snapshot.dhEmi,
        dCompet: snapshot.dCompet,
        issuer: snapshot.issuer,
        profileVersion: snapshot.profile.version,
        municipalityCode: snapshot.profile.municipalityCode,
        activity: {
          code: snapshot.activity.code,
          label: snapshot.activity.label,
          cTribNac: snapshot.activity.cTribNac,
          nbs: snapshot.activity.nbs ?? null,
        },
        taker:
          taker.kind === "national"
            ? {
                kind: "national" as const,
                documentType: taker.documentType,
                document: taker.document,
                name: taker.name,
                email: taker.email ?? null,
                address: taker.address,
              }
            : {
                kind: "foreign" as const,
                nif: taker.nif ?? null,
                nifAbsence: taker.nifAbsence ?? null,
                name: taker.name,
                email: taker.email ?? null,
                address: {
                  country: taker.address.country,
                  city: taker.address.city,
                  postalCode: taker.address.postalCode ?? null,
                  state: taker.address.state ?? null,
                  street: taker.address.street ?? null,
                  number: taker.address.number ?? null,
                  district: taker.address.district ?? null,
                },
              },
        description: snapshot.description,
        iss: {
          rate: snapshot.iss.rate ?? null,
          withheld: snapshot.iss.withheld,
          amount: snapshot.iss.amount,
        },
      },
      events: events.map((event) => ({
        kind: event.kind,
        code: event.code ?? null,
        at: event.createdAt,
      })),
      canCancel:
        companyCapabilities(membership.role).operateDocuments &&
        view.state === "authorized" &&
        view.cancellation?.state !== "processing",
      origin: await originOf(ctx, row),
    };
  },
});

const requestResult = v.object({ reused: v.boolean(), issuanceId: v.id("issuances") });

/**
 * Accepts an issuance requested in the console. The console generates the idempotency key per
 * submit attempt: a double submit or a retry after a lost answer returns the same issuance.
 */
export const request = mutation({
  args: { ...companyScopeFields, idempotencyKey: v.string(), input: issuanceInput },
  returns: requestResult,
  handler: async (ctx, { idempotencyKey, input, ...scope }) => {
    const result = await requestIssuance(
      ctx,
      await consoleScope(ctx, scope),
      idempotencyKey,
      input,
    );
    return { reused: result.reused, issuanceId: result.issuance.id };
  },
});

export const cancel = mutation({
  args: {
    ...companyScopeFields,
    idempotencyKey: v.string(),
    issuanceId: v.string(),
    reasonCode: cancelReason,
    reason: v.string(),
  },
  returns: requestResult,
  handler: async (ctx, { idempotencyKey, issuanceId, reasonCode, reason, ...scope }) => {
    const result = await requestCancellation(ctx, await consoleScope(ctx, scope), idempotencyKey, {
      issuanceId,
      reasonCode,
      reason,
    });
    return { reused: result.reused, issuanceId: result.issuance.id };
  },
});

/**
 * One-minute download ticket for a preserved XML of the issuance, redeemed at
 * `/v1/document-download` like the imported originals. The ticket belongs to the console
 * project; `documentDownloads.authorize` checks the member and its company access again.
 */
export const artifactTicket = mutation({
  args: { ...companyScopeFields, issuanceId: v.string(), artifactId: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { issuanceId, artifactId, ...scope }) => {
    await readAccess(ctx, scope);
    const issuance = await scopedIssuance(ctx, scope, issuanceId);
    const id = ctx.db.normalizeId("issuanceArtifacts", artifactId);
    const artifact = id ? await ctx.db.get("issuanceArtifacts", id) : null;
    if (
      !artifact ||
      artifact.issuanceId !== issuance._id ||
      artifact.organizationId !== scope.organizationId
    )
      return deny("NOT_FOUND");
    const { membership } = await requireMembership(ctx, scope.organizationId);
    const access = (await findCompany(ctx, membership, scope.companyId))!;
    const projectId = await ensureConsoleProject(ctx, membership);
    await limitOrganizationAction(
      ctx,
      "document-download-ticket",
      `${scope.organizationId}:${membership._id}`,
      60,
    );
    const token = crypto.randomUUID() + crypto.randomUUID(),
      expiresAt = Date.now() + 60_000;
    const ticketId = await ctx.db.insert("documentDownloads", {
      ...scope,
      projectId,
      artifactId: artifact._id,
      membershipId: membership._id,
      accessVersion: access.accessVersion,
      // The console project has no grant; the membership and its company access carry the check.
      projectEpoch: 0,
      grantEpoch: 0,
      tokenHash: await hashApiKey(token),
      expiresAt,
    });
    await ctx.scheduler.runAfter(60_000, internal.documentDownloads.expire, { id: ticketId });
    return { token, expiresAt };
  },
});
