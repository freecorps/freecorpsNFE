import { recordAudit } from "./operationalAudit";
import { RateLimiter } from "@freecorps/convex-rate-limiter";
import { canManageRole, type MembershipRole } from "@freecorps/contracts";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { components } from "../_generated/api";
import { authComponent } from "../auth";
import { requirePlatformEnvironment } from "../environment";
import { closureOf, exportWindowOpen } from "./organizationClosure";
import { clockOf } from "./clock";
import { assertOrganizationHot } from "./coldArchiveCore";

/**
 * Refuses with `code`. `availableAt`, when known, is the instant the refused sale becomes
 * available (ADR 0012, one paid plan at a time): the console shows it beside the code.
 */
export function deny(code = "ACCESS_DENIED", detail: { availableAt?: number | null } = {}): never {
  throw new ConvexError(
    typeof detail.availableAt === "number" ? { code, availableAt: detail.availableAt } : { code },
  );
}
/** The code of a `deny` refusal, or null for any other error. */
export function denialCode(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code
    : null;
}
type AuthUser = NonNullable<Awaited<ReturnType<typeof authComponent.safeGetAuthUser>>>;
/**
 * The Better Auth user of the caller's session, or null. Replaces `safeGetAuthUser`, whose
 * session lookup filters `expiresAt` by the wall clock and so makes every query uncacheable
 * (#43). A query finds the session by `_id` only: the JWT that names it lasts 15 minutes and
 * is only issued for a live session, and logout, revocation and account deletion remove the
 * row. A mutation, or an action that calls this itself, still refuses a session past `expiresAt`;
 * an action that checks access through a query accepts it like the query does.
 */
export async function sessionUser(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<AuthUser | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") return null;
  const now = clockOf(ctx);
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [
      { field: "_id", value: identity.sessionId },
      ...(now === null ? [] : [{ field: "expiresAt", operator: "gt" as const, value: now }]),
    ],
  });
  // The session must belong to the token's subject, not only exist.
  if (!session || session.userId !== identity.subject) return null;
  const user: AuthUser | null = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", value: identity.subject }],
  });
  return user ?? null;
}
export async function requireUser(ctx: QueryCtx | MutationCtx | ActionCtx) {
  requirePlatformEnvironment();
  const user = await sessionUser(ctx);
  if (!user) return deny("UNAUTHENTICATED");
  if (!user.emailVerified) return deny("EMAIL_UNVERIFIED");
  return user;
}
export async function findMembership(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: string,
) {
  return ctx.db
    .query("memberships")
    .withIndex("by_organizationId_and_authUserId", (q) =>
      q.eq("organizationId", organizationId).eq("authUserId", userId),
    )
    .unique();
}
/**
 * What a caller lets through while the organization is in cold custody. `archived: "allowed"`
 * is only for the actions ADR 0009, §2 keeps open: reads of non-fiscal data, revoking keys,
 * credentials and accesses, removing members and invitations, requesting the closure and the
 * plan change, which `allocateOffer` decides by state. Every other call refuses
 * `ORGANIZATION_ARCHIVED` from the freeze to the end of the rehydration.
 */
export type CustodyOption = { archived?: "allowed" };
/** A closed organization only admits the export of its data, while the window lasts. */
export async function requireMembership(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  options: { closed?: "export" } & CustodyOption = {},
) {
  const user = await requireUser(ctx);
  const membership = await findMembership(ctx, organizationId, user._id);
  if (!membership || membership.state !== "active") return deny();
  const organization = await ctx.db.get("organizations", organizationId);
  if (!organization) return deny();
  if (options.archived !== "allowed") await assertOrganizationHot(ctx, organizationId);
  const closure = await closureOf(ctx, organizationId);
  if (closure && !(options.closed === "export" && exportWindowOpen(closure, clockOf(ctx))))
    return deny("ORGANIZATION_CLOSED");
  return { user, membership, organization, closure };
}
export function requireManager(membership: Doc<"memberships">) {
  if (membership.role !== "owner" && membership.role !== "admin") deny();
}
/** Decisions only the owner takes, such as accepting a fiscal loss in a capture (#442). */
export function requireOwner(membership: Doc<"memberships">) {
  if (membership.role !== "owner") deny();
}
export function requireRoleGrant(membership: Doc<"memberships">, role: MembershipRole) {
  if (!canManageRole(membership.role, role)) deny();
}
export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) deny("INVALID_EMAIL");
  return email;
}
export function organizationName(value: string) {
  const name = value.trim();
  if (
    name.length < 2 ||
    name.length > 80 ||
    name.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    deny("INVALID_NAME");
  return name;
}
export async function audit(
  ctx: MutationCtx,
  entry: Omit<Doc<"organizationAudit">, "_id" | "_creationTime" | "createdAt">,
) {
  await recordAudit(ctx, {
    organizationId: entry.organizationId,
    actor: entry.actorUserId,
    action: entry.action,
    target: entry.target,
  });
  await ctx.db.insert("organizationAudit", { ...entry, createdAt: Date.now() });
}
/**
 * Removes an active member: the membership stays as history, its company grants lapse with the
 * epoch, and pending invitations to the same address in that organization are revoked. The
 * caller checks permission and the last owner.
 */
export async function withdrawMembership(
  ctx: MutationCtx,
  organization: Doc<"organizations">,
  target: Doc<"memberships">,
  actorUserId: string,
) {
  const now = Date.now();
  await ctx.db.patch("memberships", target._id, {
    state: "removed",
    companyAccessEpoch: (target.companyAccessEpoch ?? 0) + 1,
    version: target.version + 1,
    updatedAt: now,
  });
  // Withdrawal of membership also withdraws earlier invitations to the same account.
  // The indexed range participates in OCC with invitation reservation/consumption.
  for (const status of ["pending", "sending"] as const) {
    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_organizationId_and_email_and_status", (q) =>
        q.eq("organizationId", organization._id).eq("email", target.email).eq("status", status),
      )
      .take(2);
    for (const invitation of invitations) {
      await ctx.db.patch("invitations", invitation._id, { status: "revoked", updatedAt: now });
      await audit(ctx, {
        organizationId: organization._id,
        actorUserId,
        action: "invitation.revoked",
        target: invitation._id,
      });
    }
  }
  await ctx.db.patch("organizations", organization._id, {
    ownerCount: organization.ownerCount - Number(target.role === "owner"),
    memberCount: organization.memberCount - 1,
    updatedAt: now,
  });
  await audit(ctx, {
    organizationId: organization._id,
    actorUserId,
    action: "member.removed",
    target: target._id,
    beforeRole: target.role,
  });
}
const limiter = new RateLimiter(components.rateLimiter);
export async function limitOrganizationAction(
  ctx: MutationCtx | ActionCtx,
  operation: string,
  key: string,
  rate = 10,
) {
  const result = await limiter.limit(ctx, `organization-${operation}`, {
    key,
    config: { kind: "fixed window", rate, capacity: rate, period: 60_000, start: 0 },
  });
  if (!result.ok) deny("RATE_LIMITED");
}
export function boundedPagination<T extends { numItems: number }>(options: T): T {
  return { ...options, numItems: Math.min(50, Math.max(1, options.numItems)) };
}
