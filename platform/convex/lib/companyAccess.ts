import { recordAudit } from "./operationalAudit";
import { companyCapabilities, normalizeCnpj, type CompanyAddress } from "@freecorps/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deny, requireManager, requireMembership, type CustodyOption } from "./organizationAccess";

export function cleanText(value: string, max: number, required = true) {
  const result = value.trim();
  if (
    (required && !result) ||
    result.length > max ||
    result.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    deny("INVALID_COMPANY");
  return result;
}
export function declaredFields(name: string, value: CompanyAddress) {
  const address = {
    street: cleanText(value.street, 120),
    number: cleanText(value.number, 20),
    complement: cleanText(value.complement, 80, false),
    district: cleanText(value.district, 80),
    city: cleanText(value.city, 80),
    state: value.state.trim().toUpperCase(),
    postalCode: value.postalCode.trim().replace(/^(\d{5})-(\d{3})$/, "$1$2"),
  };
  if (
    !/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(
      address.state,
    ) ||
    !/^\d{8}$/.test(address.postalCode)
  )
    deny("INVALID_ADDRESS");
  return { name: cleanText(name, 160), address };
}
export function companyCnpj(value: string) {
  const cnpj = normalizeCnpj(value);
  return cnpj ?? deny("INVALID_CNPJ");
}
export function summary(company: Doc<"companies">) {
  return {
    id: company._id,
    cnpj: company.cnpj,
    name: company.name,
    kind: company.kind,
    version: company.version,
  };
}
export async function findCompany(
  ctx: QueryCtx,
  membership: Doc<"memberships">,
  companyId: Id<"companies">,
) {
  const company = await ctx.db.get("companies", companyId);
  if (
    !company ||
    company.organizationId !== membership.organizationId ||
    membership.state !== "active"
  )
    return null;
  if (companyCapabilities(membership.role).manage)
    return { company, accessVersion: `manager:${membership.version}` };
  const grant = await ctx.db
    .query("companyGrants")
    .withIndex("by_companyId_and_membershipId", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membership._id),
    )
    .unique();
  if (
    !grant?.active ||
    grant.organizationId !== membership.organizationId ||
    grant.membershipEpoch !== (membership.companyAccessEpoch ?? 0)
  )
    return null;
  return { company, accessVersion: `grant:${grant.version}:${membership.version}` };
}
export async function requireCompany(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  companyId: Id<"companies">,
  manage = false,
  options: CustodyOption = {},
) {
  const access = await requireMembership(ctx, organizationId, options);
  if (manage) requireManager(access.membership);
  const result = await findCompany(ctx, access.membership, companyId);
  if (!result) return deny();
  return { ...access, ...result };
}
export async function companyAudit(
  ctx: MutationCtx,
  company: Doc<"companies">,
  actorUserId: string,
  action: Doc<"companyAudit">["action"],
  targetMembershipId?: Id<"memberships">,
) {
  await recordAudit(ctx, {
    organizationId: company.organizationId,
    companyId: company._id,
    actor: actorUserId,
    action,
    target: targetMembershipId ?? company._id,
  });
  await ctx.db.insert("companyAudit", {
    organizationId: company.organizationId,
    companyId: company._id,
    actorUserId,
    action,
    ...(targetMembershipId ? { targetMembershipId } : {}),
    createdAt: Date.now(),
  });
}
export async function onboardingState(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return ctx.db
    .query("onboarding")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
}
export function companyByCnpj(ctx: QueryCtx, organizationId: Id<"organizations">, cnpj: string) {
  return ctx.db
    .query("companies")
    .withIndex("by_organizationId_and_cnpj", (q) =>
      q.eq("organizationId", organizationId).eq("cnpj", cnpj),
    )
    .unique();
}
/**
 * The first reason a company cannot be deleted, or null. Documents, imports, issuance, capture,
 * projects (and through them keys, operations and exports), webhooks, Stripe and any
 * certificate that is not a rejected attempt keep the company. A certificate still being
 * uploaded or validated also keeps it, so the worker never finishes on a removed company.
 */
export async function companyHistory(ctx: QueryCtx, company: Doc<"companies">) {
  const companyId = company._id,
    organizationId = company.organizationId;
  const found = await Promise.all([
    ctx.db
      .query("fiscalDocuments")
      .withIndex("by_companyId_environment_listedAt", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("documentArtifacts")
      .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
        q.eq("companyId", companyId),
      )
      .first(),
    ctx.db
      .query("documentListings")
      .withIndex("by_companyId_environment_filterKey_date", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("imports")
      .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
        q.eq("organizationId", organizationId).eq("companyId", companyId),
      )
      .first(),
    ctx.db
      .query("issuances")
      .withIndex("by_companyId_and_environment_and_series_and_number", (q) =>
        q.eq("companyId", companyId),
      )
      .first(),
    ctx.db
      .query("dpsSequences")
      .withIndex("by_companyId_and_environment_and_series", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("issuanceSimulations")
      .withIndex("by_companyId_and_environment_and_dpsId", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("issuanceGateEvents")
      .withIndex("by_companyId_and_version", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("captureReleaseEvents")
      .withIndex("by_companyId_and_version", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("captureStreams")
      .withIndex("by_companyId_environment", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("projectCompanies")
      .withIndex("by_organizationId_and_companyId", (q) =>
        q.eq("organizationId", organizationId).eq("companyId", companyId),
      )
      .first(),
    ctx.db
      .query("webhookEndpoints")
      .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", companyId))
      .first(),
    ctx.db
      .query("stripeConnections")
      .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", companyId))
      .first(),
  ]);
  if (found.some(Boolean)) return "COMPANY_HAS_HISTORY" as const;
  for await (const certificate of ctx.db
    .query("certificates")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId)))
    if (certificate.state !== "rejected") return "COMPANY_HAS_HISTORY" as const;
  return null;
}
