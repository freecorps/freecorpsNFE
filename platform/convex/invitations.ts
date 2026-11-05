import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { requireEntitySlot } from "./lib/planCore";
import { canManageRole } from "@freecorps/contracts";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePlatformEnvironment } from "./environment";
import { createAccountMailProvider } from "./lib/accountMail";
import {
  audit,
  boundedPagination,
  deny,
  findMembership,
  limitOrganizationAction,
  normalizeEmail,
  requireManager,
  requireMembership,
  requireRoleGrant,
  requireUser,
} from "./lib/organizationAccess";
import { closureOf } from "./lib/organizationClosure";
import { invitationStatus, membershipRole } from "./lib/organizationValues";

const lifetime = 72 * 60 * 60_000;
const previewValue = v.object({
  organizationName: v.string(),
  role: membershipRole,
  expiresAt: v.number(),
});
const acceptedValue = v.object({ organizationId: v.id("organizations"), slug: v.string() });
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function issuerActive(ctx: QueryCtx, invitation: Doc<"invitations">) {
  const issuer = await ctx.db.get("memberships", invitation.issuerMembershipId);
  return (
    !!issuer &&
    issuer.organizationId === invitation.organizationId &&
    issuer.state === "active" &&
    issuer.version === invitation.issuerVersion &&
    canManageRole(issuer.role, invitation.role)
  );
}
async function eligible(ctx: QueryCtx, tokenHash: string, asOf: number) {
  const user = await requireUser(ctx);
  const invitation = await ctx.db
    .query("invitations")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt <= asOf ||
    invitation.email !== normalizeEmail(user.email) ||
    !(await issuerActive(ctx, invitation))
  )
    return deny("INVITATION_UNAVAILABLE");
  const organization = await ctx.db.get("organizations", invitation.organizationId);
  if (!organization) return deny("INVITATION_UNAVAILABLE");
  // The closure revokes open invitations in a later batch; until then the record itself refuses.
  if (await closureOf(ctx, organization._id)) return deny("INVITATION_UNAVAILABLE");
  return { user, invitation, organization };
}

export const reserve = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
    role: membershipRole,
    tokenHash: v.string(),
  },
  returns: v.id("invitations"),
  handler: async (ctx, { organizationId, email: inputEmail, role, tokenHash }) => {
    const { membership, user } = await requireMembership(ctx, organizationId);
    requireRoleGrant(membership, role);
    const email = normalizeEmail(inputEmail);
    if (email === normalizeEmail(user.email)) deny("SELF_INVITATION");
    await limitOrganizationAction(ctx, "invite", user._id);
    await limitOrganizationAction(ctx, "invite-recipient", await digest(email), 3);
    for (const status of ["pending", "sending"] as const) {
      const existing = await ctx.db
        .query("invitations")
        .withIndex("by_organizationId_and_email_and_status", (q) =>
          q.eq("organizationId", organizationId).eq("email", email).eq("status", status),
        )
        .take(2);
      for (const invitation of existing) {
        // A crashed sender can be replaced explicitly after the bounded delivery window.
        const expiresAt =
          status === "sending"
            ? Math.min(invitation.expiresAt, invitation.createdAt + 60_000)
            : invitation.expiresAt;
        if (expiresAt > Date.now() && (await issuerActive(ctx, invitation)))
          deny("INVITATION_PENDING");
        await ctx.db.patch("invitations", invitation._id, {
          status: "revoked",
          updatedAt: Date.now(),
        });
        await audit(ctx, {
          organizationId,
          actorUserId: user._id,
          action: "invitation.revoked",
          target: invitation._id,
        });
      }
    }
    const now = Date.now();
    const id = await ctx.db.insert("invitations", {
      organizationId,
      email,
      role,
      tokenHash,
      status: "sending",
      expiresAt: now + lifetime,
      issuerMembershipId: membership._id,
      issuerVersion: membership.version,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "invitation.created",
      target: id,
      afterRole: role,
    });
    return id;
  },
});
export const finishDelivery = internalMutation({
  args: { invitationId: v.id("invitations"), delivered: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { invitationId, delivered }) => {
    const invitation = await ctx.db.get("invitations", invitationId);
    if (!invitation || invitation.status !== "sending") return false;
    const issuer = await ctx.db.get("memberships", invitation.issuerMembershipId);
    if (!issuer) return false;
    const active = await issuerActive(ctx, invitation);
    const status = active ? (delivered ? "pending" : "delivery-failed") : "revoked";
    await ctx.db.patch("invitations", invitationId, { status, updatedAt: Date.now() });
    await audit(ctx, {
      organizationId: invitation.organizationId,
      actorUserId: issuer.authUserId,
      action:
        status === "pending"
          ? "invitation.sent"
          : status === "revoked"
            ? "invitation.revoked"
            : "invitation.delivery-failed",
      target: invitationId,
    });
    return status === "pending";
  },
});

/** Only an explicit UI action reserves and sends. No cron or automatic retry sends mail. */
export const send = action({
  args: { organizationId: v.id("organizations"), email: v.string(), role: membershipRole },
  returns: v.object({ invitationId: v.id("invitations"), delivered: v.boolean() }),
  handler: async (ctx, args): Promise<{ invitationId: Id<"invitations">; delivered: boolean }> => {
    const { local, accounts, siteUrl } = requirePlatformEnvironment();
    const email = normalizeEmail(args.email);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const invitationId = await ctx.runMutation(internal.invitations.reserve, {
      ...args,
      email,
      tokenHash: await digest(token),
    });
    let delivered = false;
    try {
      const provider = createAccountMailProvider(
        local
          ? {
              provider: "local",
              capture: (message) => ctx.runMutation(internal.mail.capture, message),
            }
          : accounts.enabled
            ? {
                provider: "cloudflare",
                apiKey: accounts.apiKey,
                from: accounts.from,
                allowedRecipients: accounts.allowedRecipients,
                siteUrl,
              }
            : { provider: "disabled" },
      );
      await provider.send({ email, otp: token, type: "organization-invitation" });
      delivered = true;
    } catch {
      /* Never log the token or the provider response. The manager receives a safe retry state. */
    }
    delivered = await ctx.runMutation(internal.invitations.finishDelivery, {
      invitationId,
      delivered,
    });
    return { invitationId, delivered };
  },
});

export const list = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    contextKey: v.string(),
  },
  returns: paginationResultValidator(
    v.object({
      id: v.id("invitations"),
      email: v.string(),
      role: membershipRole,
      status: invitationStatus,
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, { organizationId, paginationOpts }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    requireManager(membership);
    const result = await ctx.db
      .query("invitations")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .paginate(boundedPagination(paginationOpts));
    const page = await Promise.all(
      result.page.map(async (i) => ({
        id: i._id,
        email: i.email,
        role: i.role,
        status:
          (i.status === "pending" || i.status === "sending") && !(await issuerActive(ctx, i))
            ? ("revoked" as const)
            : i.status,
        expiresAt: i.expiresAt,
      })),
    );
    return { ...result, page };
  },
});
export const revoke = mutation({
  args: { organizationId: v.id("organizations"), invitationId: v.id("invitations") },
  returns: v.null(),
  handler: async (ctx, { organizationId, invitationId }) => {
    const { user, membership } = await requireMembership(ctx, organizationId, {
      archived: "allowed",
    });
    const invitation = await ctx.db.get("invitations", invitationId);
    if (!invitation || invitation.organizationId !== organizationId) return deny();
    requireRoleGrant(membership, invitation.role);
    if (invitation.status !== "pending" && invitation.status !== "sending")
      deny("INVITATION_UNAVAILABLE");
    await ctx.db.patch("invitations", invitationId, { status: "revoked", updatedAt: Date.now() });
    await audit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "invitation.revoked",
      target: invitationId,
    });
    return null;
  },
});
export const inspect = internalQuery({
  args: { tokenHash: v.string(), asOf: v.number() },
  returns: previewValue,
  handler: async (ctx, { tokenHash, asOf }) => {
    const { invitation, organization } = await eligible(ctx, tokenHash, asOf);
    return {
      organizationName: organization.name,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  },
});
export const consume = internalMutation({
  args: { tokenHash: v.string() },
  returns: acceptedValue,
  handler: async (ctx, { tokenHash }) => {
    const { user, invitation, organization } = await eligible(ctx, tokenHash, Date.now());
    const previous = await findMembership(ctx, organization._id, user._id);
    // Invitations never overwrite an active membership or elevate its role.
    if (previous?.state === "active") deny("ALREADY_MEMBER");
    await requireEntitySlot(ctx, organization._id, "members");
    const now = Date.now();
    const data = {
      organizationId: organization._id,
      authUserId: user._id,
      name: user.name,
      email: normalizeEmail(user.email),
      role: invitation.role,
      state: "active" as const,
      version: (previous?.version ?? 0) + 1,
      joinedAt: now,
      updatedAt: now,
    };
    const membershipId = previous ? previous._id : await ctx.db.insert("memberships", data);
    if (previous) await ctx.db.patch("memberships", previous._id, data);
    await ctx.db.patch("organizations", organization._id, {
      ownerCount: organization.ownerCount + Number(invitation.role === "owner"),
      memberCount: organization.memberCount + 1,
      updatedAt: now,
    });
    await ctx.db.patch("invitations", invitation._id, { status: "accepted", updatedAt: now });
    await audit(ctx, {
      organizationId: organization._id,
      actorUserId: user._id,
      action: "member.joined",
      target: membershipId,
      afterRole: invitation.role,
    });
    return { organizationId: organization._id, slug: organization.slug };
  },
});
async function tokenHash(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return deny("INVITATION_UNAVAILABLE");
  return digest(token);
}
export const preview = action({
  args: { token: v.string() },
  returns: previewValue,
  handler: async (
    ctx,
    { token },
  ): Promise<{ organizationName: string; role: Doc<"memberships">["role"]; expiresAt: number }> => {
    const user = await requireUser(ctx);
    await limitOrganizationAction(ctx, "accept", user._id, 20);
    // Only the action supplies this snapshot time; consumption always checks its own server clock.
    return ctx.runQuery(internal.invitations.inspect, {
      tokenHash: await tokenHash(token),
      asOf: Date.now(),
    });
  },
});
export const accept = action({
  args: { token: v.string() },
  returns: acceptedValue,
  handler: async (
    ctx,
    { token },
  ): Promise<{ organizationId: Id<"organizations">; slug: string }> => {
    const user = await requireUser(ctx);
    await limitOrganizationAction(ctx, "accept", user._id, 20);
    return ctx.runMutation(internal.invitations.consume, { tokenHash: await tokenHash(token) });
  },
});
