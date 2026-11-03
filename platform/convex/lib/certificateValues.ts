import { v } from "convex/values";

export const MAX_PFX_BYTES = 256 * 1024;
export const MAX_PASSWORD_BYTES = 1024;
export const certificateScope = {
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
};
export const certificateState = v.union(
  v.literal("uploading"),
  v.literal("validating"),
  v.literal("active"),
  v.literal("replaced"),
  v.literal("revoked"),
  v.literal("expired"),
  v.literal("rejected"),
);
export const certificateMeta = v.object({
  fingerprint: v.string(),
  subject: v.string(),
  cnpj: v.string(),
  notBefore: v.number(),
  notAfter: v.number(),
});
export const envelope = v.object({
  format: v.literal(1),
  keyVersion: v.string(),
  wrappedKey: v.bytes(),
  pfx: v.bytes(),
  password: v.bytes(),
});
export const certificateSummary = v.object({
  id: v.id("certificates"),
  version: v.number(),
  state: certificateState,
  metadata: v.union(certificateMeta, v.null()),
  code: v.union(v.string(), v.null()),
  createdAt: v.number(),
});
export const certificatePin = v.object({ id: v.id("certificates"), version: v.number() });
