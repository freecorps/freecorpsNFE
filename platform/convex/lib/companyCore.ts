import type { CompanyAddress } from "@freecorps/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { companyAudit, companyByCnpj, companyCnpj, declaredFields } from "./companyAccess";
import { deny } from "./organizationAccess";
import { requireEntitySlot } from "./planCore";

// Fora de companyAccess: a cota do plano puxa planCore, que chega de volta aos
// helpers de acesso (captureAttention → webhookOutbox → webhookAccess →
// operationAccess) e fecharia um ciclo de imports (#112).

/**
 * Creates the company in the caller's transaction, or reuses the one with the same CNPJ in the
 * organization; only a new company takes a plan slot. The caller has already checked access.
 * `registryFields` names the fields whose values came from the registry cache.
 */
export async function createCompany(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  userId: string,
  input: { cnpj: string; name: string; address: CompanyAddress },
  kind: Doc<"companies">["kind"],
  registryFields: ("name" | "address")[] = [],
) {
  const cnpj = companyCnpj(input.cnpj);
  const fields = declaredFields(input.name, input.address);
  const existing = await companyByCnpj(ctx, organizationId, cnpj);
  if (existing) {
    if (existing.kind !== kind) deny("COMPANY_KIND_CONFLICT");
    return { company: existing, reused: true };
  }
  await requireEntitySlot(ctx, organizationId, "companies");
  const now = Date.now();
  const id = await ctx.db.insert("companies", {
    organizationId,
    cnpj,
    ...fields,
    kind,
    declaredBy: userId,
    declaredAt: now,
    fieldSources: {
      name: registryFields.includes("name") ? "registry" : kind,
      address: registryFields.includes("address") ? "registry" : kind,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const company = (await ctx.db.get("companies", id))!;
  await companyAudit(ctx, company, userId, "company.created");
  return { company, reused: false };
}
