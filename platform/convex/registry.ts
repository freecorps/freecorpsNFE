import { v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { companyScopeFields, scopeFields } from "./lib/operationValues";
import {
  registryTask,
  PROVIDER,
  registryLookupValue,
  registryReservation,
  registryFieldsValue,
  registryPreview,
  CACHE_TTL,
} from "./lib/registryValues";
import { keyAccess, memberAccess } from "./lib/operationAccess";
import { ensureConsoleProject } from "./lib/projectAccess";
import { requireCompany, companyByCnpj, companyCnpj, declaredFields } from "./lib/companyAccess";
import {
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import { cacheFor, readRegistry, restrictionFor } from "./lib/registryRead";
import {
  consultedCache,
  pickConsulted,
  recordApplication,
  registryFields,
} from "./lib/registryApply";
import { reserveCall } from "./lib/registryCall";
import { checkUsage, recordUsage, usageError } from "./lib/usageCore";
import { baseEnvironment } from "./lib/environmentAccess";

const companyScope = { organizationId: v.id("organizations"), companyId: v.id("companies") };
export const get = query({
  args: { ...companyScope, contextKey: v.string() },
  returns: registryLookupValue,
  handler: async (ctx, args) => {
    const { company } = await requireCompany(ctx, args.organizationId, args.companyId);
    if (company.kind === "demonstration") return deny("DEMONSTRATION_READ_ONLY");
    return await readRegistry(ctx, company.cnpj);
  },
});
export const refreshArgs = { ...scopeFields, cnpj: v.string(), key: v.string() };
export async function reserveRegistry(
  ctx: MutationCtx,
  args: Infer<typeof refreshValidator>,
  keyHash?: string,
): Promise<{ operationId: Id<"operations">; reused: boolean }> {
  const scope = { ...args, task: registryTask };
  if (keyHash) await keyAccess(ctx, keyHash, scope);
  else await memberAccess(ctx, scope, true);
  const company = await ctx.db.get("companies", args.companyId);
  const cnpj = companyCnpj(args.cnpj);
  if (company?.cnpj !== cnpj) return deny("NOT_FOUND");
  if (company.kind === "demonstration") return deny("DEMONSTRATION_READ_ONLY");
  if ((await restrictionFor(ctx, cnpj))?.blocked) return deny();
  await limitOrganizationAction(ctx, "registry-refresh", args.organizationId, 10);
  // Reusing a request is handled by the existing transaction and namespace of B05.
  return ctx.runMutation(internal.operations.reserve, {
    organizationId: args.organizationId,
    projectId: args.projectId,
    companyId: args.companyId,
    environment: args.environment,
    key: args.key,
    ...(keyHash ? { keyHash } : {}),
    request: JSON.stringify({ cnpj, provider: PROVIDER }),
    task: registryTask,
  });
}
const refreshValidator = v.object(refreshArgs);
/** Console refresh: the operation and its idempotency key belong to the console project. */
export const refresh = mutation({
  args: { ...companyScopeFields, cnpj: v.string(), key: v.string() },
  returns: registryReservation,
  handler: async (ctx, args) => {
    const { membership } = await memberAccess(ctx, { ...args, task: registryTask }, true);
    return reserveRegistry(ctx, {
      ...args,
      projectId: await ensureConsoleProject(ctx, membership),
    });
  },
});
export const apply = mutation({
  args: {
    ...companyScope,
    expectedCompanyVersion: v.number(),
    expectedCacheVersion: v.number(),
    fields: registryFieldsValue,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { company, user } = await requireCompany(ctx, args.organizationId, args.companyId, true);
    if (company.kind === "demonstration") deny("DEMONSTRATION_READ_ONLY");
    if (company.version !== args.expectedCompanyVersion) deny("COMPANY_CHANGED");
    const cache = await consultedCache(ctx, company.cnpj, args.expectedCacheVersion);
    const fields = registryFields(args.fields);
    const before = { name: company.name, address: company.address };
    const picked = pickConsulted(cache.data, fields, before);
    const after = declaredFields(picked.name, picked.address);
    await recordApplication(ctx, company, user._id, cache, fields, before, after);
    await ctx.db.patch("companies", company._id, {
      ...after,
      version: company.version + 1,
      updatedAt: Date.now(),
      fieldSources: {
        name: fields.includes("name") ? "registry" : company.fieldSources.name,
        address: fields.includes("address") ? "registry" : company.fieldSources.address,
      },
    });
    return null;
  },
});

/** The provider call of a pre-creation lookup must answer well before this (10 s timeout). */
const LOOKUP_LEASE = 30_000;
/**
 * Lookup before the company exists, for the roles that can create it. Charges the plan and calls
 * the provider only when there is no fresh answer; the same key returns the same lookup. There is
 * no company to release production, so the environment is the deployment's (`baseEnvironment`),
 * never the caller's (USAGE.md, Ambientes).
 */
export const lookup = mutation({
  args: { organizationId: v.id("organizations"), cnpj: v.string(), key: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("existing"), companyId: v.id("companies") }),
    v.object({
      kind: v.literal("lookup"),
      lookupId: v.id("registryLookups"),
      reused: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const { user, membership } = await requireMembership(ctx, args.organizationId);
    requireManager(membership);
    const cnpj = companyCnpj(args.cnpj);
    if (!/^[\w-]{8,100}$/.test(args.key)) deny("INVALID_REQUEST");
    const environment = baseEnvironment();
    const prior = await ctx.db
      .query("registryLookups")
      .withIndex("by_organizationId_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key),
      )
      .unique();
    if (prior) {
      if (prior.cnpj !== cnpj || prior.environment !== environment) deny("IDEMPOTENCY_CONFLICT");
      return { kind: "lookup" as const, lookupId: prior._id, reused: true };
    }
    const company = await companyByCnpj(ctx, args.organizationId, cnpj);
    if (company) return { kind: "existing" as const, companyId: company._id };
    await limitOrganizationAction(ctx, "registry-refresh", args.organizationId, 10);
    const now = Date.now();
    const lookupId = await ctx.db.insert("registryLookups", {
      organizationId: args.organizationId,
      cnpj,
      actorUserId: user._id,
      key: args.key,
      environment,
      quotaExceeded: false,
      createdAt: now,
      expiresAt: now + CACHE_TTL,
    });
    await ctx.scheduler.runAt(now + CACHE_TTL, internal.registryStore.forgetLookup, { lookupId });
    const result = { kind: "lookup" as const, lookupId, reused: false };
    // Restricted: the status reads `unavailable`, without calling the provider or showing data.
    if ((await restrictionFor(ctx, cnpj))?.blocked) return result;
    const cache = await cacheFor(ctx, cnpj);
    if (cache?.pendingUntil && cache.pendingUntil > now) {
      await ctx.scheduler.runAt(cache.pendingUntil, internal.registryStore.settle, { cnpj });
      return result;
    }
    if (cache && cache.refreshAfter > now) return result;
    const usageKey = `registry-lookup:${lookupId}`;
    try {
      await checkUsage(ctx, args.organizationId, environment, "registry", usageKey);
    } catch (error) {
      if (!usageError(error)) throw error;
      await ctx.db.patch("registryLookups", lookupId, { quotaExceeded: true });
      return result;
    }
    await limitOrganizationAction(ctx, "registry-provider", PROVIDER, 30);
    await recordUsage(ctx, args.organizationId, environment, "registry", usageKey);
    await reserveCall(ctx, cache, cnpj, {
      pendingLookupId: lookupId,
      pendingUntil: now + LOOKUP_LEASE,
    });
    await ctx.db.patch("registryLookups", lookupId, { call: "dispatched_or_uncertain" });
    await ctx.scheduler.runAfter(0, internal.registryWorker.lookup, { lookupId, cnpj });
    await ctx.scheduler.runAt(now + LOOKUP_LEASE, internal.registryStore.settle, { cnpj });
    return result;
  },
});
/**
 * State of a lookup for the managers of the organization that made it. The cache is global; this
 * path shows it only through the organization's own lookup of that CNPJ.
 */
export const lookupStatus = query({
  args: { organizationId: v.id("organizations"), lookupId: v.id("registryLookups") },
  returns: registryPreview,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    requireManager(membership);
    const lookup = await ctx.db.get("registryLookups", args.lookupId);
    if (!lookup || lookup.organizationId !== args.organizationId) return deny();
    const blocked = (await restrictionFor(ctx, lookup.cnpj))?.blocked;
    const cache = blocked || lookup.quotaExceeded ? null : await cacheFor(ctx, lookup.cnpj);
    // `pendingUntil` and `stale` are materialized by scheduled mutations (`settle`, `expire`):
    // a query never reads the clock.
    const state = lookup.quotaExceeded
      ? ("quota" as const)
      : cache?.pendingUntil !== undefined
        ? ("pending" as const)
        : cache?.status === "found" && cache.stale
          ? ("expired" as const)
          : (cache?.status ?? "unavailable");
    const found = state === "found" ? cache : null;
    return {
      lookupId: lookup._id,
      cnpj: lookup.cnpj,
      state,
      provider: PROVIDER,
      sourceUrl: "https://opencnpj.org/" as const,
      data: found?.data ?? null,
      consultedAt: found?.consultedAt ?? null,
      sourceUpdatedAt: found?.sourceUpdatedAt ?? null,
      expiresAt: found?.expiresAt ?? null,
      cacheVersion: found?.version ?? null,
    };
  },
});
