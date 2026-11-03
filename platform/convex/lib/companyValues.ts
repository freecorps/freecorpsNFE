import { v } from "convex/values";

export const companyAddress = v.object({
  street: v.string(),
  number: v.string(),
  complement: v.string(),
  district: v.string(),
  city: v.string(),
  state: v.string(),
  postalCode: v.string(),
});
export const companyFields = { name: v.string(), address: companyAddress };
export const fieldSource = v.union(
  v.literal("declared"),
  v.literal("demonstration"),
  v.literal("registry"),
);
export const companyKind = v.union(v.literal("declared"), v.literal("demonstration"));
export const companySummary = v.object({
  id: v.id("companies"),
  cnpj: v.string(),
  name: v.string(),
  kind: companyKind,
  version: v.number(),
});
export const companyCapabilitiesValue = v.object({
  read: v.boolean(),
  manage: v.boolean(),
  operateDocuments: v.boolean(),
});
export const companyAuditAction = v.union(
  v.literal("company.created"),
  v.literal("company.updated"),
  v.literal("company.registry_applied"),
  v.literal("company.granted"),
  v.literal("company.revoked"),
  v.literal("company.nfse_profile_created"),
  v.literal("company.nfse_profile_updated"),
  v.literal("company.nfse_dps_start_set"),
);
export const onboardingMode = v.union(v.literal("manual"), v.literal("demonstration"));
