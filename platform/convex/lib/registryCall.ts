import type { Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  CACHE_TTL,
  ERROR_COOLDOWN,
  NEGATIVE_TTL,
  PROVIDER,
  RETENTION,
  type registryDataValue,
  type registryStatus,
} from "./registryValues";

/**
 * Marks the cache row of `cnpj` as being consulted by one holder (an operation or a lookup) until
 * `pendingUntil`; only that holder may then save the answer. Creates the row on the first call.
 */
export async function reserveCall(
  ctx: MutationCtx,
  cache: Doc<"registryCache"> | null,
  cnpj: string,
  holder: {
    pendingOperationId?: Id<"operations">;
    pendingLookupId?: Id<"registryLookups">;
    pendingUntil: number;
  },
) {
  const now = Date.now();
  const patch = {
    pendingOperationId: holder.pendingOperationId,
    pendingLookupId: holder.pendingLookupId,
    pendingUntil: holder.pendingUntil,
    lastAttemptAt: now,
  };
  if (cache) return ctx.db.patch("registryCache", cache._id, patch);
  const cacheId = await ctx.db.insert("registryCache", {
    provider: PROVIDER,
    cnpj,
    status: "unavailable",
    data: null,
    sourceUpdatedAt: null,
    consultedAt: null,
    expiresAt: 0,
    refreshAfter: 0,
    retainUntil: now + RETENTION,
    version: 0,
    stale: true,
    ...patch,
  });
  const retentionJobId = await ctx.scheduler.runAt(now + RETENTION, internal.registryStore.expire, {
    cacheId,
  });
  await ctx.db.patch("registryCache", cacheId, { retentionJobId });
}

/** Saves the provider's answer for the holder that reserved the call and releases the row. */
export async function saveResult(
  ctx: MutationCtx,
  cache: Doc<"registryCache">,
  status: Infer<typeof registryStatus>,
  data: Infer<typeof registryDataValue> | null,
) {
  const now = Date.now();
  const success = status === "found" || status === "not_found";
  const expiresAt = success
    ? now + (status === "found" ? CACHE_TTL : NEGATIVE_TTL)
    : cache.expiresAt;
  const retainUntil = (success ? now : (cache.consultedAt ?? now)) + RETENTION;
  for (const jobId of [cache.expiryJobId, cache.retentionJobId]) {
    if (jobId && (await ctx.db.system.get(jobId))?.state.kind === "pending")
      await ctx.scheduler.cancel(jobId);
  }
  const expiryJobId = success
    ? await ctx.scheduler.runAt(expiresAt, internal.registryStore.expire, { cacheId: cache._id })
    : undefined;
  const retentionJobId = await ctx.scheduler.runAt(retainUntil, internal.registryStore.expire, {
    cacheId: cache._id,
  });
  await ctx.db.patch("registryCache", cache._id, {
    status,
    data: success ? data : cache.data,
    consultedAt: success ? now : cache.consultedAt,
    expiresAt,
    stale: !success || expiresAt <= now,
    sourceUpdatedAt: null,
    refreshAfter: success ? expiresAt : now + ERROR_COOLDOWN,
    retainUntil,
    expiryJobId,
    retentionJobId,
    version: cache.version + 1,
    pendingOperationId: undefined,
    pendingLookupId: undefined,
    pendingUntil: undefined,
  });
}
