import { v } from "convex/values";

export const membershipRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("developer"),
  v.literal("operator"),
  v.literal("viewer"),
);
export const invitationStatus = v.union(
  v.literal("sending"),
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("revoked"),
  v.literal("delivery-failed"),
);
export const capabilities = v.object({
  manageOrganization: v.boolean(),
  manageMembers: v.boolean(),
  manageIntegrations: v.boolean(),
  operateDocuments: v.boolean(),
  readDocuments: v.boolean(),
});
export const organizationSummary = v.object({
  id: v.id("organizations"),
  name: v.string(),
  slug: v.string(),
  role: membershipRole,
  membershipId: v.id("memberships"),
  membershipVersion: v.number(),
});
export const closureSummary = v.object({
  state: v.union(v.literal("closing"), v.literal("purging"), v.literal("purged")),
  requestedAt: v.number(),
  exportUntil: v.number(),
  purgeBy: v.number(),
});
export const auditAction = v.union(
  v.literal("organization.created"),
  v.literal("organization.updated"),
  v.literal("organization.closure-requested"),
  v.literal("organization.terms-accepted"),
  /** An owner or admin kept a Free organization active during its archive notice (ADR 0009). */
  v.literal("organization.kept-active"),
  v.literal("member.role-changed"),
  v.literal("member.removed"),
  v.literal("member.joined"),
  v.literal("invitation.created"),
  v.literal("invitation.revoked"),
  v.literal("invitation.sent"),
  v.literal("invitation.delivery-failed"),
);
