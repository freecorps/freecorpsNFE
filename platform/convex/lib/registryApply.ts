import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { companyAudit } from "./companyAccess";
import type { companyAddress } from "./companyValues";
import { deny } from "./organizationAccess";
import { cacheFor, restrictionFor } from "./registryRead";
import { PROVIDER } from "./registryValues";

export type RegistryField = "name" | "address";
type CompanyFields = { name: string; address: Infer<typeof companyAddress> };

/**
 * The server's found and unexpired answer for `cnpj`, at the version the person reviewed. The
 * client never supplies consulted values: a different version is `REGISTRY_CHANGED`.
 */
export async function consultedCache(ctx: QueryCtx, cnpj: string, expectedVersion: number) {
  if ((await restrictionFor(ctx, cnpj))?.blocked) deny();
  const cache = await cacheFor(ctx, cnpj);
  if (
    !cache?.data ||
    cache.status !== "found" ||
    cache.version !== expectedVersion ||
    cache.expiresAt <= Date.now() ||
    !cache.consultedAt
  )
    return deny("REGISTRY_CHANGED");
  return { ...cache, data: cache.data, consultedAt: cache.consultedAt };
}
export function registryFields(fields: RegistryField[]) {
  if (!fields.length || new Set(fields).size !== fields.length) deny("INVALID_REQUEST");
  return fields;
}
/** The consulted values replace the selected fields; the others keep `values`. */
export function pickConsulted(
  data: CompanyFields,
  fields: RegistryField[],
  values: CompanyFields,
): CompanyFields {
  return {
    name: fields.includes("name") ? data.name : values.name,
    address: fields.includes("address") ? data.address : values.address,
  };
}
/** The organization's own lookup of `cnpj`, checked even when nothing will be applied. */
export async function ownedLookup(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  cnpj: string,
  lookupId: Id<"registryLookups">,
) {
  const lookup = await ctx.db.get("registryLookups", lookupId);
  if (!lookup || lookup.organizationId !== organizationId) return deny();
  if (lookup.cnpj !== cnpj) return deny("REGISTRY_CHANGED");
  return lookup;
}
/**
 * The cache an organization may use to create a company: its own unexpired lookup of the same
 * CNPJ, with an answer it could see. A lookup ID of another organization is not proof of access.
 */
export async function lookupCache(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  cnpj: string,
  choice: { lookupId: Id<"registryLookups">; expectedCacheVersion: number },
) {
  const lookup = await ownedLookup(ctx, organizationId, cnpj, choice.lookupId);
  if (lookup.quotaExceeded || lookup.expiresAt <= Date.now()) return deny("REGISTRY_CHANGED");
  // `lookupStatus` shows a restricted CNPJ as `unavailable`; answering `ACCESS_DENIED` here would
  // tell a manager who saw the data before that a restriction arrived since.
  if ((await restrictionFor(ctx, cnpj))?.blocked) return deny("REGISTRY_CHANGED");
  return consultedCache(ctx, cnpj, choice.expectedCacheVersion);
}
/** Provenance of an application: fields, values before/after, author and source dates. */
export async function recordApplication(
  ctx: MutationCtx,
  company: Doc<"companies">,
  actorUserId: string,
  cache: { consultedAt: number; sourceUpdatedAt: number | null },
  fields: RegistryField[],
  before: CompanyFields,
  after: CompanyFields,
) {
  await ctx.db.insert("registryApplications", {
    companyId: company._id,
    organizationId: company.organizationId,
    actorUserId,
    provider: PROVIDER,
    consultedAt: cache.consultedAt,
    sourceUpdatedAt: cache.sourceUpdatedAt,
    appliedAt: Date.now(),
    fields,
    before,
    after,
  });
  await companyAudit(ctx, company, actorUserId, "company.registry_applied");
}
