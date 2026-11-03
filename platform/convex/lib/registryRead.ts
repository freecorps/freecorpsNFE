import type { QueryCtx } from "../_generated/server";
import { PROVIDER } from "./registryValues";
import type { RegistryLookup } from "../../../packages/contracts/src/registry";

export function restrictionFor(ctx: QueryCtx, cnpj: string) {
  return ctx.db
    .query("registryRestrictions")
    .withIndex("by_cnpj", (q) => q.eq("cnpj", cnpj))
    .unique();
}
export function cacheFor(ctx: QueryCtx, cnpj: string) {
  return ctx.db
    .query("registryCache")
    .withIndex("by_provider_and_cnpj", (q) => q.eq("provider", PROVIDER).eq("cnpj", cnpj))
    .unique();
}
export async function readRegistry(ctx: QueryCtx, cnpj: string): Promise<RegistryLookup> {
  const blocked = (await restrictionFor(ctx, cnpj))?.blocked;
  const cache = blocked ? null : await cacheFor(ctx, cnpj);
  return {
    cnpj,
    provider: PROVIDER,
    sourceUrl: "https://opencnpj.org/",
    status: blocked ? "unavailable" : (cache?.status ?? "not_consulted"),
    freshness: !cache?.consultedAt ? "missing" : cache.stale ? "stale" : "fresh",
    data: cache?.data ?? null,
    sourceUpdatedAt: cache?.sourceUpdatedAt ?? null,
    consultedAt: cache?.consultedAt ?? null,
    lastAttemptAt: cache?.lastAttemptAt ?? null,
    expiresAt: cache?.consultedAt ? cache.expiresAt : null,
    refreshAfter: cache?.refreshAfter ?? null,
    version: cache?.version ?? 0,
  };
}
