import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { requireEntitySlot } from "./lib/planCore";
import { companyCapabilities, grantableScopes } from "@freecorps/contracts";
import { query, mutation, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { boundedPagination, deny, limitOrganizationAction } from "./lib/organizationAccess";
import { cleanText, findCompany } from "./lib/companyAccess";
import { companyKind } from "./lib/companyValues";
import { environment, integrationScope, projectState, projectSummary } from "./lib/projectValues";
import { baseEnvironment, environmentOffered } from "./lib/environmentAccess";
import {
  canManageProject,
  integrationActor,
  integrationAudit,
  projectGrant,
  requireGrantableCompany,
  requireProject,
  summarizeProject,
  validateScopes,
} from "./lib/projectAccess";

const scope = { organizationId: v.id("organizations"), projectId: v.id("projects") };
export const list = query({
  args: {
    organizationId: v.id("organizations"),
    contextKey: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(projectSummary),
  handler: async (ctx, { organizationId, paginationOpts }) => {
    const { membership } = await integrationActor(ctx, organizationId, { archived: "allowed" });
    const source =
      membership.role === "developer"
        ? ctx.db
            .query("projects")
            .withIndex("by_creatorMembershipId", (q) => q.eq("creatorMembershipId", membership._id))
        : ctx.db
            .query("projects")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId));
    const result = await source.paginate(boundedPagination(paginationOpts));
    return {
      ...result,
      page: result.page.filter((p) => canManageProject(membership, p)).map(summarizeProject),
    };
  },
});
export const get = query({
  args: { organizationId: v.id("organizations"), projectId: v.string(), contextKey: v.string() },
  returns: v.union(
    v.null(),
    projectSummary.extend({
      grantableScopes: v.array(integrationScope),
      accessVersion: v.string(),
      deploymentEnvironment: environment,
    }),
  ),
  handler: async (ctx, { organizationId, projectId }) => {
    const { membership } = await integrationActor(ctx, organizationId, { archived: "allowed" });
    const id = ctx.db.normalizeId("projects", projectId);
    const project = id ? await ctx.db.get("projects", id) : null;
    if (!project || !canManageProject(membership, project)) return null;
    // Depend on current company access as well: revocation clears in-flight forms/secrets.
    const grants = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_active", (q) =>
        q.eq("projectId", project._id).eq("active", true),
      )
      .take(51);
    const access = await Promise.all(
      grants.map(async (g) => {
        if (membership.role !== "developer") return `${g._id}:${g.version}`;
        const human = await ctx.db
          .query("companyGrants")
          .withIndex("by_companyId_and_membershipId", (q) =>
            q.eq("companyId", g.companyId).eq("membershipId", membership._id),
          )
          .unique();
        return `${g._id}:${g.version}:${human?.version ?? 0}`;
      }),
    );
    return {
      ...summarizeProject(project),
      grantableScopes: grantableScopes(membership.role),
      accessVersion: `${project.version}:${membership.version}:${access.join(",")}`,
      // The only environment this deployment serves; REST refuses keys for any other.
      deploymentEnvironment: baseEnvironment(),
    };
  },
});
export const create = mutation({
  args: { organizationId: v.id("organizations"), name: v.string(), externalReference: v.string() },
  returns: v.object({ projectId: v.id("projects"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    const { membership, user } = await integrationActor(ctx, args.organizationId);
    const name = cleanText(args.name, 100),
      externalReference = cleanText(args.externalReference, 80);
    await limitOrganizationAction(ctx, "project-create", user._id);
    const previous = await ctx.db
      .query("projects")
      .withIndex("by_organizationId_and_externalReference", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalReference", externalReference),
      )
      .unique();
    if (previous) {
      if (!canManageProject(membership, previous) || previous.name !== name)
        deny("PROJECT_CONFLICT");
      return { projectId: previous._id, reused: true };
    }
    await requireEntitySlot(ctx, args.organizationId, "projects");
    const projectId = await ctx.db.insert("projects", {
      organizationId: args.organizationId,
      name,
      externalReference,
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: membership._id,
      creatorEpoch: membership.companyAccessEpoch ?? 0,
      createdAt: Date.now(),
    });
    await integrationAudit(
      ctx,
      (await ctx.db.get("projects", projectId))!,
      user._id,
      "project.created",
      projectId,
    );
    return { projectId, reused: false };
  },
});
export const update = mutation({
  args: { ...scope, name: v.string(), state: projectState, expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project, user } = await requireProject(ctx, args.organizationId, args.projectId);
    if (project.version !== args.expectedVersion) deny("PROJECT_CHANGED");
    await ctx.db.patch("projects", project._id, {
      name: cleanText(args.name, 100),
      state: args.state,
      version: project.version + 1,
      accessEpoch:
        project.accessEpoch + Number(project.state === "active" && args.state === "disabled"),
    });
    await integrationAudit(ctx, project, user._id, "project.updated", project._id);
    return null;
  },
});
export const companies = query({
  args: { ...scope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      companyId: v.id("companies"),
      name: v.string(),
      /** The demonstration company is the one whose synthetic XML the first call imports. */
      kind: companyKind,
      scopes: v.array(integrationScope),
      environments: v.array(environment),
      /** Environments a new grant or key may name for the company (`offeredEnvironments`). */
      offeredEnvironments: v.array(environment),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { membership } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    const result = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_active", (q) =>
        q.eq("projectId", args.projectId).eq("active", true),
      )
      .paginate(boundedPagination(args.paginationOpts));
    const page = [];
    for (const grant of result.page) {
      // Developers cannot discover companies outside their own live concessions.
      const company = await findCompany(ctx, membership, grant.companyId);
      if (company && grant.organizationId === args.organizationId)
        page.push({
          companyId: grant.companyId,
          name: company.company.name,
          kind: company.company.kind,
          scopes: grant.scopes,
          environments: grant.environments,
          offeredEnvironments: await companyEnvironments(ctx, company.company),
          version: grant.version,
        });
    }
    return { ...result, page };
  },
});
export const companyGrant = query({
  args: { ...scope, companyId: v.id("companies"), contextKey: v.string() },
  returns: v.union(v.null(), v.object({ version: v.number(), active: v.boolean() })),
  handler: async (ctx, args) => {
    const { membership } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    await requireGrantableCompany(ctx, membership, args.companyId);
    const grant = await projectGrant(ctx, args.projectId, args.companyId);
    return grant ? { version: grant.version, active: grant.active } : null;
  },
});
/**
 * The environments a new grant or key of this project may name for the company: the
 * deployment's, plus Produção on the hosted site while its fiscal capture is released.
 */
export const offeredEnvironments = query({
  args: { ...scope, companyId: v.id("companies") },
  returns: v.array(environment),
  handler: async (ctx, args) => {
    const { membership } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    return companyEnvironments(ctx, await requireGrantableCompany(ctx, membership, args.companyId));
  },
});
/**
 * The companies the caller may grant to the project, a page at a time, with what a guided
 * setup needs to propose a grant without one subscription per company (#512): the environments
 * a new grant may name (`offeredEnvironments`) and the version a save must name, also for a
 * grant removed before (0 when there was none). Same companies as `companies.list`.
 */
export const grantCandidates = query({
  args: { ...scope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      companyId: v.id("companies"),
      name: v.string(),
      kind: companyKind,
      offeredEnvironments: v.array(environment),
      grantVersion: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { membership, project } = await requireProject(ctx, args.organizationId, args.projectId, {
      archived: "allowed",
    });
    const describe = async (company: Doc<"companies">) => ({
      companyId: company._id,
      name: company.name,
      kind: company.kind,
      offeredEnvironments: await companyEnvironments(ctx, company),
      grantVersion: (await projectGrant(ctx, project._id, company._id))?.version ?? 0,
    });
    if (companyCapabilities(membership.role).manage) {
      const result = await ctx.db
        .query("companies")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
        .paginate(boundedPagination(args.paginationOpts));
      return { ...result, page: await Promise.all(result.page.map(describe)) };
    }
    // A developer grants only the companies of their own live concessions.
    const result = await ctx.db
      .query("companyGrants")
      .withIndex("by_membershipId_and_membershipEpoch_and_active", (q) =>
        q
          .eq("membershipId", membership._id)
          .eq("membershipEpoch", membership.companyAccessEpoch ?? 0)
          .eq("active", true),
      )
      .paginate(boundedPagination(args.paginationOpts));
    const page = [];
    for (const grant of result.page) {
      const found =
        grant.organizationId === args.organizationId
          ? await findCompany(ctx, membership, grant.companyId)
          : null;
      if (found) page.push(await describe(found.company));
    }
    return { ...result, page };
  },
});
async function companyEnvironments(ctx: QueryCtx, company: Doc<"companies">) {
  const base = baseEnvironment();
  return base === "sandbox" &&
    company.kind === "declared" &&
    (await environmentOffered(ctx, company, "production"))
    ? [base, "production" as const]
    : [base];
}
export const grantCompany = mutation({
  args: {
    ...scope,
    companyId: v.id("companies"),
    scopes: v.array(integrationScope),
    environments: v.array(environment),
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project, membership, user } = await requireProject(
      ctx,
      args.organizationId,
      args.projectId,
    );
    if (project.state !== "active") deny("PROJECT_DISABLED");
    const company = await requireGrantableCompany(ctx, membership, args.companyId);
    validateScopes(membership, args.scopes);
    if (
      !args.environments.length ||
      new Set(args.environments).size !== args.environments.length ||
      (company.kind === "demonstration" && args.environments.includes("production"))
    )
      deny("ENVIRONMENT_DENIED");
    const previous = await projectGrant(ctx, project._id, company._id);
    if ((previous?.version ?? 0) !== args.expectedVersion) deny("GRANT_CHANGED");
    // An environment new to the grant must be offered for the company now: on the hosted site,
    // Produção only while its fiscal capture is released (ADR 0007, #493). One the active grant
    // already names stays, so a grant saved before a withdrawal remains editable and removable.
    const kept = previous?.active ? previous.environments : [];
    for (const env of args.environments)
      if (!kept.includes(env) && !(await environmentOffered(ctx, company, env)))
        deny("ENVIRONMENT_DENIED");
    if (!previous?.active) {
      const active = await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_active", (q) =>
          q.eq("projectId", project._id).eq("active", true),
        )
        .take(50);
      if (active.length >= 50) deny("PROJECT_COMPANY_LIMIT");
    }
    const data = {
      organizationId: args.organizationId,
      projectId: project._id,
      companyId: company._id,
      scopes: args.scopes,
      environments: args.environments,
      active: true,
      version: (previous?.version ?? 0) + 1,
      accessEpoch: previous?.accessEpoch ?? 0,
    };
    if (previous) await ctx.db.patch("projectCompanies", previous._id, data);
    else await ctx.db.insert("projectCompanies", data);
    await integrationAudit(ctx, project, user._id, "project.company.granted", company._id);
    return null;
  },
});
export const revokeCompany = mutation({
  args: { ...scope, companyId: v.id("companies"), expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { project, membership, user } = await requireProject(
      ctx,
      args.organizationId,
      args.projectId,
      { archived: "allowed" },
    );
    await requireGrantableCompany(ctx, membership, args.companyId);
    const grant = await projectGrant(ctx, project._id, args.companyId);
    if (!grant || grant.version !== args.expectedVersion) deny("GRANT_CHANGED");
    if (grant.active) {
      await ctx.db.patch("projectCompanies", grant._id, {
        active: false,
        version: grant.version + 1,
        accessEpoch: grant.accessEpoch + 1,
      });
      await integrationAudit(ctx, project, user._id, "project.company.revoked", args.companyId);
    }
    return null;
  },
});
