import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  deny,
  limitOrganizationAction,
  requireMembership,
  requireOwner,
  requireUser,
} from "./lib/organizationAccess";
import {
  acceptTermsOfUse,
  currentTermsOfUse,
  pendingTermsOfUse,
  termsOfUseAcceptance,
} from "./lib/termsOfUse";

const currentValue = v.object({
  version: v.string(),
  sha256: v.string(),
  since: v.number(),
  effectiveAt: v.number(),
});

/** The version a new organization accepts, for the creation form; `null` while none is current. */
export const current = query({
  args: {},
  returns: v.union(v.null(), currentValue),
  handler: async (ctx) => {
    await requireUser(ctx);
    return currentTermsOfUse();
  },
});

/**
 * The organization's standing with the terms of use, for any active member: the current version,
 * the acceptance that holds and what is still pending, with the moment it takes effect (past it,
 * new commands are refused with TERMS_OF_USE_REQUIRED). The name of who accepted goes only to
 * owners and admins, who see the members (ORGANIZATIONS.md). Only owners accept.
 */
export const status = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    current: v.union(v.null(), currentValue),
    accepted: v.union(
      v.null(),
      v.object({
        version: v.string(),
        sha256: v.string(),
        acceptedAt: v.number(),
        acceptedBy: v.union(v.null(), v.string()),
      }),
    ),
    pending: v.union(v.null(), v.object({ version: v.string(), effectiveAt: v.number() })),
    canAccept: v.boolean(),
  }),
  handler: async (ctx, { organizationId }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    const acceptance = await termsOfUseAcceptance(ctx, organizationId);
    let acceptedBy: string | null = null;
    if (acceptance && (membership.role === "owner" || membership.role === "admin")) {
      const person = await ctx.db.get("memberships", acceptance.membershipId);
      acceptedBy = person?.organizationId === organizationId ? person.name : null;
    }
    return {
      current: currentTermsOfUse(),
      accepted: acceptance
        ? {
            version: acceptance.version,
            sha256: acceptance.sha256,
            acceptedAt: acceptance.createdAt,
            acceptedBy,
          }
        : null,
      pending: pendingTermsOfUse(acceptance?.version ?? null),
      canAccept: membership.role === "owner",
    };
  },
});

/**
 * An owner accepts the current version in the console (terms of use, section 11). Accepting
 * again the version that holds records nothing. A closed organization accepts nothing.
 */
export const accept = mutation({
  args: { organizationId: v.id("organizations"), terms: v.string() },
  returns: v.object({ version: v.string() }),
  handler: async (ctx, args) => {
    const { user, membership } = await requireMembership(ctx, args.organizationId);
    requireOwner(membership);
    await limitOrganizationAction(ctx, "terms-of-use", args.organizationId);
    const terms = currentTermsOfUse();
    if (!terms || args.terms !== terms.version) return deny("TERMS_OF_USE_OUTDATED");
    if (!pendingTermsOfUse((await termsOfUseAcceptance(ctx, args.organizationId))?.version ?? null))
      return { version: terms.version };
    await acceptTermsOfUse(ctx, {
      organizationId: args.organizationId,
      membershipId: membership._id,
      authUserId: user._id,
      terms: args.terms,
    });
    return { version: terms.version };
  },
});
