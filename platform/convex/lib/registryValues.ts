import { v } from "convex/values";
import { companyAddress } from "./companyValues";

export const PROVIDER = "opencnpj" as const;
export const CACHE_TTL = 86_400_000;
export const NEGATIVE_TTL = 3_600_000;
export const ERROR_COOLDOWN = 60_000;
export const RETENTION = 30 * CACHE_TTL;
export const registryDataValue = v.object({
  name: v.string(),
  status: v.string(),
  address: companyAddress,
});
export const registryStatus = v.union(
  v.literal("found"),
  v.literal("not_found"),
  v.literal("unavailable"),
  v.literal("unsupported_format"),
);
/** Mirrors `registryLookup` of the public contract. */
export const registryLookupValue = v.object({
  cnpj: v.string(),
  provider: v.literal(PROVIDER),
  sourceUrl: v.literal("https://opencnpj.org/"),
  status: v.union(v.literal("not_consulted"), ...registryStatus.members),
  freshness: v.union(v.literal("missing"), v.literal("fresh"), v.literal("stale")),
  data: v.union(registryDataValue, v.null()),
  sourceUpdatedAt: v.union(v.number(), v.null()),
  consultedAt: v.union(v.number(), v.null()),
  lastAttemptAt: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  refreshAfter: v.union(v.number(), v.null()),
  version: v.number(),
});
export const registryFieldsValue = v.array(v.union(v.literal("name"), v.literal("address")));
/** A pre-creation lookup: its state and, only when found, the server's answer and version. */
export const registryPreview = v.object({
  lookupId: v.id("registryLookups"),
  cnpj: v.string(),
  state: v.union(
    v.literal("pending"),
    v.literal("quota"),
    v.literal("expired"),
    ...registryStatus.members,
  ),
  provider: v.literal(PROVIDER),
  sourceUrl: v.literal("https://opencnpj.org/"),
  data: v.union(registryDataValue, v.null()),
  consultedAt: v.union(v.number(), v.null()),
  sourceUpdatedAt: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  cacheVersion: v.union(v.number(), v.null()),
});
export const registryReservation = v.object({
  operationId: v.id("operations"),
  reused: v.boolean(),
});
export const registryTask = {
  name: "registry.lookup",
  workload: "capture",
  scope: "registry:read",
  executor: "registryWorker:execute",
  reconciler: "registryWorker:reconcile",
} as const;
