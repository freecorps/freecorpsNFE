import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { organizationCapabilities } from "@freecorps/contracts";
import { query, mutation } from "./_generated/server";
import {
  audit,
  boundedPagination,
  deny,
  findMembership,
  limitOrganizationAction,
  organizationName,
  requireManager,
  requireMembership,
  requireRoleGrant,
  requireUser,
  withdrawMembership,
} from "./lib/organizationAccess";
import { closureOf, summarizeClosure } from "./lib/organizationClosure";
import {
  acceptTermsOfUse,
  currentTermsOfUse,
  pendingTermsOfUse,
  termsOfUseAcceptance,
} from "./lib/termsOfUse";
import {
  auditAction,
  capabilities,
  closureSummary,
  membershipRole,
  organizationSummary,
} from "./lib/organizationValues";

export const listMine = query({
  args: { paginationOpts: paginationOptsValidator, contextKey: v.string() },
  returns: paginationResultValidator(organizationSummary),
  handler: async (ctx, { paginationOpts }) => {
    const user = await requireUser(ctx);
    const result = await ctx.db
      .query("memberships")
      .withIndex("by_authUserId_and_state", (q) =>
        q.eq("authUserId", user._id).eq("state", "active"),
      )
      .paginate(boundedPagination(paginationOpts));
    const page = await Promise.all(
      result.page.map(async (member) => {
        const org = await ctx.db.get("organizations", member.organizationId);
        if (!org) throw new Error("Membership organization missing");
        return {
          id: org._id,
          name: org.name,
          slug: org.slug,
          role: member.role,
          membershipId: member._id,
          membershipVersion: member.version,
        };
      }),
    );
    return { ...result, page };
  },
});

/**
 * Where the console opens after login: the organization the browser remembers, when the person
 * is still an active member of it, or the only organization the person belongs to. `null` sends
 * the person to the list (no organization, or several and none remembered). `remembered` is an
 * untrusted slug from the browser: it never reveals whether another organization exists.
 */
export const landing = query({
  args: { remembered: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ slug: v.string() })),
  handler: async (ctx, { remembered }) => {
    const user = await requireUser(ctx);
    if (remembered && remembered.length <= 48) {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", remembered))
        .unique();
      const member = org ? await findMembership(ctx, org._id, user._id) : null;
      if (org && member?.state === "active") return { slug: org.slug };
    }
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_authUserId_and_state", (q) =>
        q.eq("authUserId", user._id).eq("state", "active"),
      )
      .take(2);
    const [membership] = memberships;
    if (memberships.length !== 1 || !membership) return null;
    const org = await ctx.db.get("organizations", membership.organizationId);
    return org ? { slug: org.slug } : null;
  },
});

/** A fresh contextKey forces a server read when returning to a previously visited organization. */
export const context = query({
  args: { slug: v.string(), contextKey: v.string() },
  returns: v.union(
    v.null(),
    organizationSummary.extend({
      capabilities,
      memberCount: v.number(),
      ownerCount: v.number(),
      closure: v.union(v.null(), closureSummary),
      /** The version of the terms of use still to accept and when it takes effect (#586). */
      termsOfUse: v.union(v.null(), v.object({ version: v.string(), effectiveAt: v.number() })),
    }),
  ),
  handler: async (ctx, { slug }) => {
    const user = await requireUser(ctx);
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!org) return null;
    const member = await findMembership(ctx, org._id, user._id);
    if (!member || member.state !== "active") return null;
    const closure = await closureOf(ctx, org._id);
    return {
      id: org._id,
      name: org.name,
      slug: org.slug,
      role: member.role,
      membershipId: member._id,
      membershipVersion: member.version,
      memberCount: org.memberCount,
      ownerCount: org.ownerCount,
      capabilities: organizationCapabilities(member.role),
      closure: closure ? summarizeClosure(closure) : null,
      termsOfUse: currentTermsOfUse()
        ? pendingTermsOfUse((await termsOfUseAcceptance(ctx, org._id))?.version ?? null)
        : null,
    };
  },
});

/**
 * Creates the organization with the person as its owner. While a version of the terms of use is
 * current, `termsOfUse` is the version the person read and accepted (#586); the server records it
 * with its hash, in the same transaction, or refuses the creation.
 */
export const create = mutation({
  args: { name: v.string(), slug: v.string(), termsOfUse: v.optional(v.string()) },
  returns: v.object({ organizationId: v.id("organizations"), slug: v.string() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const name = organizationName(args.name);
    const slug = args.slug.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(slug)) deny("INVALID_SLUG");
    await limitOrganizationAction(ctx, "create", user._id, 5);
    if (
      await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    )
      deny("SLUG_UNAVAILABLE");
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name,
      slug,
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email.toLowerCase(),
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    });
    await audit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "organization.created",
      target: organizationId,
      afterRole: "owner",
    });
    await acceptTermsOfUse(ctx, {
      organizationId,
      membershipId,
      authUserId: user._id,
      terms: args.termsOfUse,
    });
    return { organizationId, slug };
  },
});

export const update = mutation({
  args: { organizationId: v.id("organizations"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId, name }) => {
    const { user, membership } = await requireMembership(ctx, organizationId);
    requireManager(membership);
    await ctx.db.patch("organizations", organizationId, {
      name: organizationName(name),
      updatedAt: Date.now(),
    });
    await audit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "organization.updated",
      target: organizationId,
    });
    return null;
  },
});

export const members = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    contextKey: v.string(),
  },
  returns: paginationResultValidator(
    v.object({
      id: v.id("memberships"),
      name: v.string(),
      email: v.string(),
      role: membershipRole,
      version: v.number(),
    }),
  ),
  handler: async (ctx, { organizationId, paginationOpts }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    requireManager(membership);
    const result = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", "active"),
      )
      .paginate(boundedPagination(paginationOpts));
    return {
      ...result,
      page: result.page.map((m) => ({
        id: m._id,
        name: m.name,
        email: m.email,
        role: m.role,
        version: m.version,
      })),
    };
  },
});

export const changeRole = mutation({
  args: {
    organizationId: v.id("organizations"),
    membershipId: v.id("memberships"),
    role: membershipRole,
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { organizationId, membershipId, role, expectedVersion }) => {
    const { user, membership, organization } = await requireMembership(ctx, organizationId);
    const target = await ctx.db.get("memberships", membershipId);
    if (!target || target.organizationId !== organizationId || target.state !== "active")
      return deny();
    requireRoleGrant(membership, target.role);
    requireRoleGrant(membership, role);
    if (target.version !== expectedVersion) deny("MEMBERSHIP_CHANGED");
    if (target.role === role) return null;
    const ownerDelta = Number(role === "owner") - Number(target.role === "owner");
    if (organization.ownerCount + ownerDelta < 1) deny("LAST_OWNER");
    await ctx.db.patch("memberships", membershipId, {
      role,
      version: target.version + 1,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("organizations", organizationId, {
      ownerCount: organization.ownerCount + ownerDelta,
      updatedAt: Date.now(),
    });
    await audit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "member.role-changed",
      target: membershipId,
      beforeRole: target.role,
      afterRole: role,
    });
    return null;
  },
});

export const removeMember = mutation({
  args: {
    organizationId: v.id("organizations"),
    membershipId: v.id("memberships"),
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { organizationId, membershipId, expectedVersion }) => {
    const { user, membership, organization } = await requireMembership(ctx, organizationId, {
      archived: "allowed",
    });
    const target = await ctx.db.get("memberships", membershipId);
    if (!target || target.organizationId !== organizationId || target.state !== "active")
      return deny();
    requireRoleGrant(membership, target.role);
    if (target.version !== expectedVersion) deny("MEMBERSHIP_CHANGED");
    if (organization.ownerCount - Number(target.role === "owner") < 1) deny("LAST_OWNER");
    await withdrawMembership(ctx, organization, target, user._id);
    return null;
  },
});

export const activity = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    contextKey: v.string(),
  },
  returns: paginationResultValidator(
    v.object({
      id: v.id("organizationAudit"),
      action: auditAction,
      target: v.string(),
      beforeRole: v.optional(membershipRole),
      afterRole: v.optional(membershipRole),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { organizationId, paginationOpts }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    requireManager(membership);
    const result = await ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .paginate(boundedPagination(paginationOpts));
    return {
      ...result,
      page: result.page.map(({ _id, action, target, beforeRole, afterRole, createdAt }) => ({
        id: _id,
        action,
        target,
        beforeRole,
        afterRole,
        createdAt,
      })),
    };
  },
});
