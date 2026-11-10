import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { claimFields } from "./lib/operationValues";
import { abandonBeforeEffect, activeClaim, executionAllowed } from "./lib/operationCore";
// Usage keys use the operation's first ID (ADR 0009, §5, item 5): the same after a rehydration.
import { firstId } from "./lib/coldArchiveOrigin";
import { cacheFor, restrictionFor } from "./lib/registryRead";
import { ERROR_COOLDOWN, PROVIDER, registryStatus, registryDataValue } from "./lib/registryValues";
import { reserveCall, saveResult } from "./lib/registryCall";
import { deny, limitOrganizationAction } from "./lib/organizationAccess";
import { cleanText, companyCnpj } from "./lib/companyAccess";
import { checkUsage, recordUsage, usageError } from "./lib/usageCore";

export const begin = internalMutation({
  args: { ...claimFields, cnpj: v.string() },
  returns: v.union(
    v.literal("call"),
    v.literal("cached"),
    v.literal("wait"),
    v.literal("unknown"),
    v.literal("denied"),
    v.literal("restricted"),
  ),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (
      !op ||
      op.stage !== "calling" ||
      op.task.name !== "registry.lookup" ||
      !(await executionAllowed(ctx, op))
    )
      return "denied";
    const request = JSON.parse(op.request) as { cnpj: string };
    if (request.cnpj !== args.cnpj) return "denied";
    if ((await restrictionFor(ctx, args.cnpj))?.blocked) return "restricted";
    const receipt = await ctx.db
      .query("registryCalls")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    if (receipt) return receipt.state === "responded" ? "cached" : "unknown";
    const cache = await cacheFor(ctx, args.cnpj);
    const now = Date.now();
    if (cache?.pendingUntil && cache.pendingUntil > now) return "wait";
    if (cache && cache.refreshAfter > now) return "cached";
    try {
      await checkUsage(ctx, op.organizationId, op.environment, "registry", firstId(op));
    } catch (error) {
      const code = usageError(error);
      if (!code) throw error;
      await abandonBeforeEffect(ctx, op, code);
      return "denied";
    }
    await limitOrganizationAction(ctx, "registry-provider", PROVIDER, 30);
    await recordUsage(ctx, op.organizationId, op.environment, "registry", firstId(op));
    await reserveCall(ctx, cache, args.cnpj, {
      pendingOperationId: op._id,
      pendingUntil: op.leaseUntil,
    });
    await ctx.db.insert("registryCalls", {
      operationId: op._id,
      organizationId: op.organizationId,
      provider: PROVIDER,
      startedAt: now,
      state: "dispatched_or_uncertain",
      costMinor: 0,
    });
    return "call";
  },
});
export const complete = internalMutation({
  args: {
    ...claimFields,
    cnpj: v.string(),
    status: registryStatus,
    data: v.union(registryDataValue, v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if ((await restrictionFor(ctx, args.cnpj))?.blocked) return false;
    const op = await activeClaim(ctx, args);
    if (
      !op ||
      op.stage !== "calling" ||
      op.task.name !== "registry.lookup" ||
      !(await executionAllowed(ctx, op))
    )
      return false;
    const cache = await cacheFor(ctx, args.cnpj);
    const receipt = await ctx.db
      .query("registryCalls")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    if (
      !cache ||
      cache.pendingOperationId !== op._id ||
      !receipt ||
      receipt.state !== "dispatched_or_uncertain"
    )
      return false;
    if ((args.status === "found") !== (args.data !== null)) return false;
    await saveResult(ctx, cache, args.status, args.data);
    await ctx.db.patch("registryCalls", receipt._id, {
      state: "responded",
      status: args.status,
      finishedAt: Date.now(),
    });
    return true;
  },
});
/** Saves the answer of a pre-creation lookup; the same fences as `complete`, held by the lookup. */
export const completeLookup = internalMutation({
  args: {
    lookupId: v.id("registryLookups"),
    cnpj: v.string(),
    status: registryStatus,
    data: v.union(registryDataValue, v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if ((await restrictionFor(ctx, args.cnpj))?.blocked) return false;
    const lookup = await ctx.db.get("registryLookups", args.lookupId);
    const cache = await cacheFor(ctx, args.cnpj);
    if (
      lookup?.cnpj !== args.cnpj ||
      lookup.call !== "dispatched_or_uncertain" ||
      cache?.pendingLookupId !== lookup._id ||
      (args.status === "found") !== (args.data !== null)
    )
      return false;
    await saveResult(ctx, cache, args.status, args.data);
    await ctx.db.patch("registryLookups", lookup._id, { call: "responded" });
    return true;
  },
});
/**
 * Releases a reservation whose lease ended without an answer, so a lookup waiting on it stops
 * showing `pending`; a newer reservation still running is left alone and checked again at its
 * own deadline. The call stays uncertain, so the row gets the error cooldown and an answer
 * arriving later no longer matches the holder and is discarded.
 */
export const settle = internalMutation({
  args: { cnpj: v.string() },
  returns: v.null(),
  handler: async (ctx, { cnpj }) => {
    const cache = await cacheFor(ctx, cnpj);
    if (cache?.pendingUntil === undefined) return null;
    const now = Date.now();
    if (cache.pendingUntil > now) {
      await ctx.scheduler.runAt(cache.pendingUntil, internal.registryStore.settle, { cnpj });
      return null;
    }
    await ctx.db.patch("registryCache", cache._id, {
      pendingOperationId: undefined,
      pendingLookupId: undefined,
      pendingUntil: undefined,
      refreshAfter: Math.max(cache.refreshAfter, now + ERROR_COOLDOWN),
    });
    return null;
  },
});
/** A lookup lives as long as a found answer stays fresh; it holds no cadastral data. */
export const forgetLookup = internalMutation({
  args: { lookupId: v.id("registryLookups") },
  returns: v.null(),
  handler: async (ctx, { lookupId }) => {
    if (await ctx.db.get("registryLookups", lookupId))
      await ctx.db.delete("registryLookups", lookupId);
    return null;
  },
});
export const expire = internalMutation({
  args: { cacheId: v.id("registryCache") },
  returns: v.null(),
  handler: async (ctx, { cacheId }) => {
    const cache = await ctx.db.get("registryCache", cacheId);
    if (!cache) return null;
    if (cache.retainUntil <= Date.now()) {
      if (cache.pendingUntil && cache.pendingUntil > Date.now()) {
        // Purge old source data on time, but preserve the in-flight exclusion lease.
        const retentionJobId = await ctx.scheduler.runAt(
          cache.pendingUntil,
          internal.registryStore.expire,
          { cacheId },
        );
        await ctx.db.patch("registryCache", cacheId, {
          data: null,
          consultedAt: null,
          sourceUpdatedAt: null,
          status: "unavailable",
          stale: true,
          expiresAt: 0,
          refreshAfter: 0,
          retainUntil: cache.pendingUntil,
          retentionJobId,
          version: cache.version + 1,
        });
      } else await ctx.db.delete("registryCache", cacheId);
    } else {
      if (cache.expiresAt <= Date.now() && !cache.stale)
        await ctx.db.patch("registryCache", cacheId, { stale: true });
    }
    return null;
  },
});

/** Administrative execution of a verified D02 decision, never callable by a tenant/API key. */
export const restrict = internalMutation({
  args: {
    cnpj: v.string(),
    blocked: v.boolean(),
    reference: v.string(),
    actor: v.string(),
    expectedVersion: v.number(),
  },
  returns: v.object({ version: v.number(), blocked: v.boolean() }),
  handler: async (ctx, args) => {
    const cnpj = companyCnpj(args.cnpj);
    const reference = cleanText(args.reference, 100);
    const actor = cleanText(args.actor, 100);
    const prior = await restrictionFor(ctx, cnpj);
    // The private D02 record is the audit trail. Retrying the same decision has no new effect.
    const repeated = prior?.reference === reference && prior.blocked === args.blocked;
    if (repeated && !args.blocked) return { version: prior.version, blocked: false };
    if (!repeated && (prior?.version ?? 0) !== args.expectedVersion)
      return deny("REGISTRY_CHANGED");
    if (!args.blocked && !prior?.blocked) return { version: prior?.version ?? 0, blocked: false };
    const version = repeated ? prior.version : (prior?.version ?? 0) + 1;
    const row = { cnpj, blocked: args.blocked, reference, actor, version, updatedAt: Date.now() };
    if (prior) await ctx.db.replace("registryRestrictions", prior._id, row);
    else await ctx.db.insert("registryRestrictions", row);
    // Invalidate the reservation too: a response already in flight cannot recreate this row,
    // including after a later release. complete() requires the original pending operation.
    // Releasing an active block also purges any cache recovered from an old backup.
    const cache = await cacheFor(ctx, cnpj);
    if (cache) {
      for (const jobId of [cache.expiryJobId, cache.retentionJobId]) {
        if (jobId && (await ctx.db.system.get(jobId))?.state.kind === "pending")
          await ctx.scheduler.cancel(jobId);
      }
      await ctx.db.delete("registryCache", cache._id);
    }
    return { version, blocked: args.blocked };
  },
});

/** Remove only the application history whose erasure the customer controller approved. */
export const eraseApplicationHistory = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    cnpj: v.string(),
    expectedCompanyVersion: v.number(),
    reference: v.string(),
  },
  returns: v.object({ removed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    cleanText(args.reference, 100);
    const cnpj = companyCnpj(args.cnpj);
    const company = await ctx.db.get("companies", args.companyId);
    if (!company || company.organizationId !== args.organizationId || company.cnpj !== cnpj)
      return deny("NOT_FOUND");
    if (company.version !== args.expectedCompanyVersion) return deny("COMPANY_CHANGED");
    if (!(await restrictionFor(ctx, cnpj))?.blocked) return deny();
    const rows = await ctx.db
      .query("registryApplications")
      .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
      .take(100);
    for (const row of rows) {
      if (row.organizationId !== args.organizationId) return deny();
    }
    for (const row of rows) await ctx.db.delete("registryApplications", row._id);
    return { removed: rows.length, done: rows.length < 100 };
  },
});
