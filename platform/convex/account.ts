import type { AccountProfile } from "@freecorps/contracts";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { requirePlatformEnvironment } from "./environment";
import { createAccountMailProvider } from "./lib/accountMail";
import { limitAccountMail } from "./lib/authRequest";
import {
  audit,
  deny,
  limitOrganizationAction,
  normalizeEmail,
  requireUser,
  withdrawMembership,
} from "./lib/organizationAccess";
import { closureOf } from "./lib/organizationClosure";
import { membershipRole } from "./lib/organizationValues";

/**
 * What the panel offers without a session, all from the account e-mail (`accountPolicy`).
 * `invitationEmail`: the invitation code only reaches the person by e-mail, so without it the
 * console does not offer to send invitations (#538).
 * `emailChange`: changing the login e-mail needs a code sent to the new address, so without it
 * the console does not offer the change (#628).
 */
export const capabilities = query({
  args: {},
  returns: v.object({
    registration: v.boolean(),
    emailRecovery: v.boolean(),
    invitationEmail: v.boolean(),
    emailChange: v.boolean(),
  }),
  handler: async () => {
    const { accounts } = requirePlatformEnvironment();
    return {
      registration: accounts.enabled,
      emailRecovery: accounts.enabled,
      invitationEmail: accounts.enabled,
      emailChange: accounts.enabled,
    };
  },
});

export const profile = query({
  args: {},
  returns: v.object({ name: v.string(), emailVerified: v.literal(true), organization: v.null() }),
  handler: async (ctx) => {
    requirePlatformEnvironment();
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new ConvexError({ code: "UNAUTHENTICATED" });
    if (!user.emailVerified) throw new ConvexError({ code: "EMAIL_UNVERIFIED" });
    return {
      name: user.name,
      emailVerified: true as const,
      organization: null,
    } satisfies AccountProfile;
  },
});

/**
 * D02: correction and deletion of the account by its holder (decision of 19/10/2026, issue #254).
 * The membership copies name and e-mail when the person joins; every change of the account
 * rewrites those copies in the same transaction, active and removed alike.
 */
export const DELETED_ACCOUNT_NAME = "Conta excluída";
const EMAIL_CHANGE_TTL = 10 * 60_000;
const EMAIL_CHANGE_ATTEMPTS = 3;

function accountName(value: string) {
  const name = value.trim();
  if (
    name.length < 2 ||
    name.length > 100 ||
    name.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    deny("INVALID_NAME");
  return name;
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Eight uniform digits; bytes of 250 and above are discarded to avoid modulo bias. */
function emailChangeCode() {
  let code = "";
  while (code.length < 8)
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      if (byte < 250 && code.length < 8) code += String(byte % 10);
  return code;
}
async function membershipsOf(ctx: MutationCtx, authUserId: string) {
  const rows: Doc<"memberships">[] = [];
  for (const state of ["active", "removed"] as const)
    for await (const membership of ctx.db
      .query("memberships")
      .withIndex("by_authUserId_and_state", (q) =>
        q.eq("authUserId", authUserId).eq("state", state),
      ))
      rows.push(membership);
  return rows;
}
async function accountByEmail(ctx: MutationCtx, email: string): Promise<{ _id: string } | null> {
  return ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "email", value: email }],
  });
}
/** Removes every row of a component model that points at the account, page by page. */
async function deleteAll(
  ctx: MutationCtx,
  model: "session" | "account" | "twoFactor",
  authUserId: string,
) {
  let removed = 0;
  let cursor: string | null = null;
  for (;;) {
    const result: { count: number; isDone: boolean; continueCursor: string } =
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model, where: [{ field: "userId", value: authUserId }] },
        paginationOpts: { cursor, numItems: 100 },
      });
    removed += result.count;
    if (result.isDone) return removed;
    cursor = result.continueCursor;
  }
}
/** The OTP rows Better Auth keeps per address (`<type>-otp-<email>`). */
async function deleteVerifications(ctx: MutationCtx, email: string) {
  const identifiers = ["email-verification", "forget-password", "sign-in"].map(
    (type) => `${type}-otp-${email}`,
  );
  const result: { count: number } = await ctx.runMutation(
    components.betterAuth.adapter.deleteMany,
    {
      input: {
        model: "verification",
        where: [{ field: "identifier", operator: "in", value: identifiers }],
      },
      paginationOpts: { cursor: null, numItems: 100 },
    },
  );
  return result.count;
}
async function discardEmailChange(ctx: MutationCtx, authUserId: string) {
  const pending = await ctx.db
    .query("emailChanges")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
  if (pending) await ctx.db.delete("emailChanges", pending._id);
}

export const rename = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const name = accountName(args.name);
    await limitOrganizationAction(ctx, "account-update", user._id);
    if (name === user.name) return null;
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: user._id }],
        update: { name, updatedAt: Date.now() },
      },
    });
    // The version stays: it guards role changes and the invitations this member issued.
    for (const membership of await membershipsOf(ctx, user._id))
      await ctx.db.patch("memberships", membership._id, { name });
    return null;
  },
});

/**
 * Stores the hashed code for the new address. An address of another account receives no code,
 * so the answer is the same in both cases; the confirmation refuses it again in its own
 * transaction.
 */
export const reserveEmailChange = internalMutation({
  args: { email: v.string(), codeHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const email = normalizeEmail(args.email);
    if (email === normalizeEmail(user.email)) deny("EMAIL_UNCHANGED");
    await limitOrganizationAction(ctx, "email-change", user._id, 3);
    const now = Date.now();
    for (const expired of await ctx.db
      .query("emailChanges")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20))
      await ctx.db.delete("emailChanges", expired._id);
    await discardEmailChange(ctx, user._id);
    if (await accountByEmail(ctx, email)) return false;
    await ctx.db.insert("emailChanges", {
      authUserId: user._id,
      email,
      codeHash: args.codeHash,
      attempts: 0,
      expiresAt: now + EMAIL_CHANGE_TTL,
    });
    return true;
  },
});

export const requestEmailChange = action({
  args: { email: v.string() },
  returns: v.object({ requestAccepted: v.literal(true) }),
  handler: async (ctx, args): Promise<{ requestAccepted: true }> => {
    const { local, accounts } = requirePlatformEnvironment();
    await requireUser(ctx);
    const email = normalizeEmail(args.email);
    // The recipient budget comes first, for every address, as in the account routes.
    if (!(await limitAccountMail(ctx, email)).ok) deny("RATE_LIMITED");
    const code = emailChangeCode();
    const send: boolean = await ctx.runMutation(internal.account.reserveEmailChange, {
      email,
      codeHash: await digest(`${email}:${code}`),
    });
    if (send)
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
                }
              : { provider: "disabled" },
        );
        await provider.send({ email, otp: code, type: "email-change" });
      } catch {
        // Never log the code or the provider response. The person asks for a new code.
        console.warn("ACCOUNT_EMAIL_UNAVAILABLE");
      }
    return { requestAccepted: true as const };
  },
});

/**
 * Returns the outcome instead of throwing, so a wrong code still commits its attempt. A valid
 * code changes `user` and every membership, removes the OTP rows of both addresses and ends the
 * open sessions: the person signs in again with the new address.
 */
export const confirmEmailChange = mutation({
  args: { code: v.string() },
  returns: v.union(
    v.literal("changed"),
    v.literal("invalid"),
    v.literal("expired"),
    v.literal("exhausted"),
    v.literal("unavailable"),
  ),
  handler: async (ctx, { code }) => {
    const user = await requireUser(ctx);
    const pending = await ctx.db
      .query("emailChanges")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
      .unique();
    if (!pending) return "invalid";
    if (pending.expiresAt <= Date.now()) {
      await ctx.db.delete("emailChanges", pending._id);
      return "expired";
    }
    const value = code.trim();
    if (
      !/^\d{8}$/.test(value) ||
      (await digest(`${pending.email}:${value}`)) !== pending.codeHash
    ) {
      const attempts = pending.attempts + 1;
      if (attempts >= EMAIL_CHANGE_ATTEMPTS) {
        await ctx.db.delete("emailChanges", pending._id);
        return "exhausted";
      }
      await ctx.db.patch("emailChanges", pending._id, { attempts });
      return "invalid";
    }
    await ctx.db.delete("emailChanges", pending._id);
    // Safe to reveal now: the person proved control of the new address.
    if (await accountByEmail(ctx, pending.email)) return "unavailable";
    const previous = user.email.toLowerCase();
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        where: [{ field: "_id", value: user._id }],
        update: { email: pending.email, emailVerified: true, updatedAt: Date.now() },
      },
    });
    for (const membership of await membershipsOf(ctx, user._id))
      await ctx.db.patch("memberships", membership._id, { email: pending.email });
    await deleteVerifications(ctx, previous);
    await deleteVerifications(ctx, pending.email);
    await deleteAll(ctx, "session", user._id);
    return "changed";
  },
});

const blocker = v.object({
  organizationId: v.id("organizations"),
  name: v.string(),
  slug: v.string(),
  role: membershipRole,
  /** The only owner: transfer ownership or close the organization first. */
  onlyOwner: v.boolean(),
});
/** What still prevents the deletion: each organization the account is an active member of. */
export const deletion = query({
  args: {},
  returns: v.object({ blockers: v.array(blocker), more: v.boolean() }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const active = await ctx.db
      .query("memberships")
      .withIndex("by_authUserId_and_state", (q) =>
        q.eq("authUserId", user._id).eq("state", "active"),
      )
      .take(21);
    const blockers = [];
    for (const membership of active.slice(0, 20)) {
      const organization = await ctx.db.get("organizations", membership.organizationId);
      if (!organization) continue;
      blockers.push({
        organizationId: organization._id,
        name: organization.name,
        slug: organization.slug,
        role: membership.role,
        onlyOwner: membership.role === "owner" && organization.ownerCount === 1,
      });
    }
    return { blockers, more: active.length > 20 };
  },
});

/**
 * Anonymizes the memberships, revokes the invitations still open to the address and deletes the
 * account rows. Shared by the deletion and its reapplication after a restore (D05).
 */
async function eraseAccount(ctx: MutationCtx, authUserId: string, emails: string[]) {
  // Read before writing: revoking or blanking moves each row out of the index range.
  const open: Doc<"invitations">[] = [];
  for (const email of emails)
    for (const status of ["pending", "sending"] as const)
      for await (const invitation of ctx.db
        .query("invitations")
        .withIndex("by_email_and_status", (q) => q.eq("email", email).eq("status", status)))
        open.push(invitation);
  for (const invitation of open) {
    await ctx.db.patch("invitations", invitation._id, { status: "revoked", updatedAt: Date.now() });
    await audit(ctx, {
      organizationId: invitation.organizationId,
      actorUserId: authUserId,
      action: "invitation.revoked",
      target: invitation._id,
    });
  }
  const invitations = open.length;
  // Closed invitations keep status, role and dates for the organization, without the address.
  const closed: Doc<"invitations">[] = [];
  for (const email of emails)
    for (const status of ["accepted", "revoked", "delivery-failed"] as const)
      for await (const invitation of ctx.db
        .query("invitations")
        .withIndex("by_email_and_status", (q) => q.eq("email", email).eq("status", status)))
        closed.push(invitation);
  for (const invitation of closed) await ctx.db.patch("invitations", invitation._id, { email: "" });
  // Role, dates, state and `authUserId` stay: they are the organization's history.
  const memberships = await membershipsOf(ctx, authUserId);
  for (const membership of memberships)
    await ctx.db.patch("memberships", membership._id, { name: DELETED_ACCOUNT_NAME, email: "" });
  await discardEmailChange(ctx, authUserId);
  const access = await ctx.db
    .query("validationAccess")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
  if (access) await ctx.db.delete("validationAccess", access._id);
  for (const email of emails) await deleteVerifications(ctx, email);
  await deleteAll(ctx, "session", authUserId);
  await deleteAll(ctx, "account", authUserId);
  await deleteAll(ctx, "twoFactor", authUserId);
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "user", where: [{ field: "_id", value: authUserId }] },
  });
  return { memberships: memberships.length, invitations, closedInvitations: closed.length };
}
/** Copy this line to the restricted register outside the database: a restore reapplies it. */
function logDeletion(
  authUserId: string,
  counts: { memberships: number; invitations: number; closedInvitations: number },
  requestedBy: "holder" | "restore",
) {
  console.info(
    JSON.stringify({
      type: "account.deleted",
      authUserId,
      requestedBy,
      deletedAt: Date.now(),
      ...counts,
    }),
  );
}

/**
 * Only the holder, with a verified e-mail, typing the address to confirm. Refused while any
 * membership is active; the check reads the same index the invitation acceptance writes, so a
 * concurrent acceptance conflicts with this transaction instead of slipping past it.
 */
export const remove = mutation({
  args: { confirmation: v.string() },
  returns: v.null(),
  handler: async (ctx, { confirmation }) => {
    const user = await requireUser(ctx);
    const email = user.email.toLowerCase();
    if (confirmation.trim().toLowerCase() !== email) deny("CONFIRMATION_MISMATCH");
    const active = await ctx.db
      .query("memberships")
      .withIndex("by_authUserId_and_state", (q) =>
        q.eq("authUserId", user._id).eq("state", "active"),
      )
      .first();
    if (active) deny("ACCOUNT_HAS_MEMBERSHIPS");
    logDeletion(user._id, await eraseAccount(ctx, user._id, [email]), "holder");
    return null;
  },
});

/**
 * D05: reapplies an account deletion kept in the restricted register, before access reopens.
 * Memberships the snapshot brings back active are removed again, as they were before the
 * original deletion; a sole owner of an organization that is not closed blocks the
 * reapplication, which then changes nothing. Running it again after it applied changes nothing.
 */
export const reapplyDeletion = internalMutation({
  args: { authUserId: v.string() },
  returns: v.object({
    state: v.union(v.literal("applied"), v.literal("unchanged"), v.literal("blocked")),
    blockedOrganizations: v.array(v.id("organizations")),
  }),
  handler: async (ctx, { authUserId }) => {
    const user: { email: string } | null = await ctx.runQuery(
      components.betterAuth.adapter.findOne,
      { model: "user", where: [{ field: "_id", value: authUserId }] },
    );
    const memberships = await membershipsOf(ctx, authUserId);
    const emails = new Set<string>();
    if (user) emails.add(user.email.toLowerCase());
    for (const membership of memberships) if (membership.email) emails.add(membership.email);
    const active = memberships.filter((membership) => membership.state === "active");
    const blockedOrganizations = [];
    for (const membership of active) {
      const organization = await ctx.db.get("organizations", membership.organizationId);
      if (
        organization &&
        membership.role === "owner" &&
        organization.ownerCount === 1 &&
        !(await closureOf(ctx, organization._id))
      )
        blockedOrganizations.push(organization._id);
    }
    if (blockedOrganizations.length) return { state: "blocked" as const, blockedOrganizations };
    if (!user && !emails.size) return { state: "unchanged" as const, blockedOrganizations };
    for (const membership of active) {
      const organization = await ctx.db.get("organizations", membership.organizationId);
      if (organization) await withdrawMembership(ctx, organization, membership, "restore");
    }
    const counts = await eraseAccount(ctx, authUserId, [...emails]);
    logDeletion(authUserId, counts, "restore");
    return { state: "applied" as const, blockedOrganizations };
  },
});
