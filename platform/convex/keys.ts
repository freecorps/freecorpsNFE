import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { grantableScopes, maxKeyCompanies, maxRotationOverlapMs } from "@freecorps/contracts";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { generateApiKeySecret, hashApiKey } from "./lib/apiKeyCrypto";
import { keyInput, keySummary, secretOnce } from "./lib/projectValues";
import { boundedPagination, deny, limitOrganizationAction } from "./lib/organizationAccess";
import {
  integrationAudit,
  projectGrant,
  requireGrantableCompany,
  requireProject,
  summarizeKey,
  validateScopes,
} from "./lib/projectAccess";
import { cleanText, findCompany } from "./lib/companyAccess";
import { baseEnvironment, environmentOffered, environmentServed } from "./lib/environmentAccess";

const scope = { organizationId: v.id("organizations"), projectId: v.id("projects") };
export const list = query({
  args: { ...scope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(keySummary),
  handler: async (ctx, args) => {
    const { membership, project } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    const result = await ctx.db
      .query("apiKeys")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate(boundedPagination(args.paginationOpts));
    const page = [];
    for (const key of result.page) {
      const companies = await Promise.all(
        key.companyIds.map((id) => findCompany(ctx, membership, id)),
      );
      if (!companies.every(Boolean)) continue;
      const grants = await Promise.all(
        key.companyIds.map((id) => projectGrant(ctx, project._id, id)),
      );
      const currentCompanyIds = key.companyIds.filter((_, index) => {
        const grant = grants[index];
        return (
          grant?.active &&
          grant.organizationId === args.organizationId &&
          grant.accessEpoch === key.grantEpochs[index] &&
          grant.environments.includes(key.environment)
        );
      });
      page.push({
        ...summarizeKey(key),
        projectInvalidated: key.projectEpoch !== project.accessEpoch,
        currentCompanyIds,
        rotationAvailable: grants.some(
          (grant, index) =>
            currentCompanyIds.includes(key.companyIds[index]!) &&
            key.scopes.some(
              (s) => grant?.scopes.includes(s) && grantableScopes(membership.role).includes(s),
            ),
        ),
        concessionsChanged:
          currentCompanyIds.length !== key.companyIds.length ||
          grants.some((grant) => key.scopes.some((s) => !grant?.scopes.includes(s))),
      });
    }
    return { ...result, page };
  },
});
export const create = action({
  args: keyInput,
  returns: secretOnce,
  handler: async (ctx, args): Promise<{ keyId: Id<"apiKeys">; secretOnce: string }> => {
    const secret = generateApiKeySecret();
    const keyId = await ctx.runMutation(internal.keys.store, {
      ...args,
      keyHash: await hashApiKey(secret),
      prefix: secret.slice(0, 13),
    });
    return { keyId, secretOnce: secret };
  },
});
export const store = internalMutation({
  args: {
    ...keyInput,
    keyHash: v.string(),
    prefix: v.string(),
    rotation: v.optional(v.object({ keyId: v.id("apiKeys"), overlapMs: v.number() })),
  },
  returns: v.id("apiKeys"),
  handler: async (ctx, args) => {
    const { project, membership, user } = await requireProject(
      ctx,
      args.organizationId,
      args.projectId,
    );
    if (project.state !== "active") deny("PROJECT_DISABLED");
    validateScopes(membership, args.scopes);
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= now ||
      args.expiresAt > 253402300799999
    )
      deny("INVALID_EXPIRATION");
    if (
      !args.companyIds.length ||
      args.companyIds.length > maxKeyCompanies ||
      new Set(args.companyIds).size !== args.companyIds.length
    )
      deny("INVALID_KEY_COMPANIES");
    await limitOrganizationAction(ctx, "key-create", user._id);
    const grantEpochs: number[] = [];
    for (const id of args.companyIds) {
      const company = await requireGrantableCompany(ctx, membership, id);
      const grant = await projectGrant(ctx, project._id, id);
      if (
        !grant?.active ||
        grant.organizationId !== args.organizationId ||
        !grant.environments.includes(args.environment) ||
        args.scopes.some((s) => !grant.scopes.includes(s)) ||
        (company.kind === "demonstration" && args.environment !== "sandbox")
      )
        deny("GRANT_DENIED");
      // A new production key on the hosted site needs the company's fiscal capture released;
      // a rotation keeps what a withdrawn release still serves (reading what was captured).
      if (
        args.environment === "production" &&
        baseEnvironment() === "sandbox" &&
        !(await (args.rotation
          ? environmentServed(ctx, company, args.environment, "companies:read")
          : environmentOffered(ctx, company, args.environment)))
      )
        deny("ENVIRONMENT_DENIED");
      grantEpochs.push(grant.accessEpoch);
    }
    if (args.rotation) {
      const old = await ctx.db.get("apiKeys", args.rotation.keyId);
      if (
        !old ||
        old.projectId !== project._id ||
        old.organizationId !== args.organizationId ||
        old.projectEpoch !== project.accessEpoch ||
        old.revokedAt !== null ||
        old.rotatedAt !== null ||
        old.expiresAt <= now
      )
        deny("KEY_UNAVAILABLE");
      const overlap = args.rotation.overlapMs;
      if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap > maxRotationOverlapMs)
        deny("INVALID_OVERLAP");
      if (
        args.environment !== old.environment ||
        args.expiresAt > old.expiresAt ||
        args.scopes.some((s) => !old.scopes.includes(s)) ||
        args.companyIds.some((id) => !old.companyIds.includes(id))
      )
        deny("ROTATION_ESCALATION");
      // Rotation cannot resurrect a grant that was revoked and subsequently granted again.
      if (
        args.companyIds.some(
          (id, i) => grantEpochs[i] !== old.grantEpochs[old.companyIds.indexOf(id)],
        )
      )
        deny("GRANT_DENIED");
      await ctx.db.patch("apiKeys", old._id, {
        rotatedAt: now,
        expiresAt: Math.min(old.expiresAt, now + overlap),
        ...(overlap === 0 ? { revokedAt: now } : {}),
      });
      await integrationAudit(ctx, project, user._id, "key.rotated", old._id);
    }
    const keyId = await ctx.db.insert("apiKeys", {
      organizationId: args.organizationId,
      projectId: project._id,
      projectEpoch: project.accessEpoch,
      name: cleanText(args.name, 100),
      keyHash: args.keyHash,
      prefix: args.prefix,
      scopes: args.scopes,
      environment: args.environment,
      companyIds: args.companyIds,
      grantEpochs,
      expiresAt: args.expiresAt,
      revokedAt: null,
      rotatedAt: null,
      createdAt: now,
      creatorMembershipId: membership._id,
    });
    await integrationAudit(ctx, project, user._id, "key.created", keyId);
    return keyId;
  },
});
export const rotate = action({
  args: { ...keyInput, keyId: v.id("apiKeys"), overlapMs: v.number() },
  returns: secretOnce,
  handler: async (
    ctx,
    { keyId: previousId, overlapMs, ...args },
  ): Promise<{ keyId: Id<"apiKeys">; secretOnce: string }> => {
    const secret = generateApiKeySecret();
    const keyId = await ctx.runMutation(internal.keys.store, {
      ...args,
      keyHash: await hashApiKey(secret),
      prefix: secret.slice(0, 13),
      rotation: { keyId: previousId, overlapMs },
    });
    return { keyId, secretOnce: secret };
  },
});
export const revoke = mutation({
  args: { ...scope, keyId: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project, user } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (!key || key.projectId !== project._id || key.organizationId !== args.organizationId) deny();
    if (key.revokedAt === null) {
      await ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now() });
      await integrationAudit(ctx, project, user._id, "key.revoked", key._id);
    }
    return null;
  },
});
