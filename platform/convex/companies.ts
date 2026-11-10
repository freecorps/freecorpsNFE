import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { companyCapabilities, normalizeCnpj } from "@freecorps/contracts";
import { query, mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { purger } from "./lib/purge";
import {
  boundedPagination,
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import {
  companyAddress,
  companyAuditAction,
  companyCapabilitiesValue,
  companyFields,
  companySummary,
  fieldSource,
} from "./lib/companyValues";
import { membershipRole } from "./lib/organizationValues";
import { recordAudit } from "./lib/operationalAudit";
import { cacheFor } from "./lib/registryRead";
import { registryFieldsValue, registryStatus } from "./lib/registryValues";
import {
  lookupCache,
  ownedLookup,
  pickConsulted,
  recordApplication,
  registryFields,
} from "./lib/registryApply";
import { fiscalCaptureBadge, fiscalCaptureOf } from "./lib/captureCore";
import {
  companyAudit,
  companyByCnpj,
  companyCnpj,
  companyHistory,
  declaredFields,
  findCompany,
  onboardingState,
  requireCompany,
  summary,
} from "./lib/companyAccess";
import { createCompany } from "./lib/companyCore";

const scope = { organizationId: v.id("organizations"), companyId: v.id("companies") };
/**
 * A company as the console lists it: with the badge of its fiscal capture (#433), read in the
 * same query and bounded by the page (`boundedPagination`), never one subscription per row.
 */
const listedCompany = companySummary.extend({
  fiscalCapture: fiscalCaptureBadge,
  /** With an `active` badge, when it turns `terms`: the console compares its clock (#45). */
  fiscalCaptureTermsDeadline: v.union(v.number(), v.null()),
});
export const list = query({
  args: {
    organizationId: v.id("organizations"),
    contextKey: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(listedCompany),
  handler: async (ctx, { organizationId, paginationOpts }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    const listed = async (company: Doc<"companies">) => ({
      ...summary(company),
      ...(await fiscalCaptureOf(ctx, membership, company)),
    });
    if (companyCapabilities(membership.role).manage) {
      const result = await ctx.db
        .query("companies")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate(boundedPagination(paginationOpts));
      return { ...result, page: await Promise.all(result.page.map(listed)) };
    }
    const result = await ctx.db
      .query("companyGrants")
      .withIndex("by_membershipId_and_membershipEpoch_and_active", (q) =>
        q
          .eq("membershipId", membership._id)
          .eq("membershipEpoch", membership.companyAccessEpoch ?? 0)
          .eq("active", true),
      )
      .paginate(boundedPagination(paginationOpts));
    const permitted = await Promise.all(
      result.page.map(async (grant) =>
        grant.organizationId === organizationId
          ? findCompany(ctx, membership, grant.companyId)
          : null,
      ),
    );
    return {
      ...result,
      page: await Promise.all(permitted.flatMap((item) => (item ? [listed(item.company)] : []))),
    };
  },
});
export const get = query({
  args: { organizationId: v.id("organizations"), companyId: v.string(), contextKey: v.string() },
  returns: v.union(
    v.null(),
    listedCompany.extend({
      address: companyAddress,
      declaredAt: v.number(),
      accessVersion: v.string(),
      capabilities: companyCapabilitiesValue,
      registryStatus: v.union(v.literal("not-consulted"), registryStatus),
      fiscalAccess: v.literal("not-configured"),
      fieldSources: v.object({ name: fieldSource, address: fieldSource }),
    }),
  ),
  handler: async (ctx, { organizationId, companyId }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    // Route segments are untrusted text. Convex validates both encoding and table identity.
    const normalizedId = ctx.db.normalizeId("companies", companyId);
    if (!normalizedId) return null;
    const access = await findCompany(ctx, membership, normalizedId);
    if (!access) return null;
    const company = access.company;
    return {
      ...summary(company),
      ...(await fiscalCaptureOf(ctx, membership, company)),
      address: company.address,
      declaredAt: company.declaredAt,
      fieldSources: company.fieldSources,
      accessVersion: access.accessVersion,
      capabilities: companyCapabilities(membership.role),
      registryStatus:
        company.kind === "demonstration"
          ? ("not-consulted" as const)
          : ((await cacheFor(ctx, company.cnpj))?.status ?? ("not-consulted" as const)),
      fiscalAccess: "not-configured" as const,
    };
  },
});
export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    cnpj: v.string(),
    ...companyFields,
    // The fields confirmed from the organization's own lookup (`registry.lookup`). Their values
    // come from the server cache at that version; the submitted values stay as `before`.
    registry: v.optional(
      v.object({
        lookupId: v.id("registryLookups"),
        expectedCacheVersion: v.number(),
        fields: registryFieldsValue,
      }),
    ),
  },
  returns: v.object({ companyId: v.id("companies"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    const { user, membership } = await requireMembership(ctx, args.organizationId);
    requireManager(membership);
    await limitOrganizationAction(ctx, "company-create", user._id, 10);
    const cnpj = companyCnpj(args.cnpj);
    const declared = declaredFields(args.name, args.address);
    // An existing company is returned as is: nothing consulted overwrites it. The choice is still
    // checked, so a lookup of another organization or CNPJ is refused on that path too.
    const existing = await companyByCnpj(ctx, args.organizationId, cnpj);
    const fields = args.registry && registryFields(args.registry.fields);
    if (args.registry && existing)
      await ownedLookup(ctx, args.organizationId, cnpj, args.registry.lookupId);
    const consulted =
      args.registry && fields && !existing
        ? { cache: await lookupCache(ctx, args.organizationId, cnpj, args.registry), fields }
        : null;
    const values = consulted
      ? pickConsulted(consulted.cache.data, consulted.fields, declared)
      : declared;
    const { company, reused } = await createCompany(
      ctx,
      args.organizationId,
      user._id,
      { cnpj, ...values },
      "declared",
      consulted?.fields,
    );
    if (consulted && !reused)
      await recordApplication(ctx, company, user._id, consulted.cache, consulted.fields, declared, {
        name: company.name,
        address: company.address,
      });
    const onboarding = await onboardingState(ctx, args.organizationId);
    if (!onboarding)
      await ctx.db.insert("onboarding", {
        organizationId: args.organizationId,
        mode: "manual",
        companyId: company._id,
        guidanceDismissed: false,
        version: 1,
        updatedAt: Date.now(),
      });
    else if (onboarding.mode === "manual" && !onboarding.companyId)
      await ctx.db.patch("onboarding", onboarding._id, {
        companyId: company._id,
        version: onboarding.version + 1,
        updatedAt: Date.now(),
      });
    return { companyId: company._id, reused };
  },
});
export const update = mutation({
  args: { ...scope, ...companyFields, expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { organizationId, companyId, name, address, expectedVersion }) => {
    const { user, company } = await requireCompany(ctx, organizationId, companyId, true);
    if (company.kind === "demonstration") deny("DEMONSTRATION_READ_ONLY");
    if (company.version !== expectedVersion) deny("COMPANY_CHANGED");
    const fields = declaredFields(name, address);
    await ctx.db.patch("companies", companyId, {
      ...fields,
      declaredAt: Date.now(),
      declaredBy: user._id,
      fieldSources: {
        name: fields.name === company.name ? company.fieldSources.name : "declared",
        address: Object.entries(fields.address).every(
          ([key, value]) => value === company.address[key as keyof typeof address],
        )
          ? company.fieldSources.address
          : "declared",
      },
      version: company.version + 1,
      updatedAt: Date.now(),
    });
    await companyAudit(ctx, company, user._id, "company.updated");
    return null;
  },
});
export const members = query({
  args: { ...scope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      membershipId: v.id("memberships"),
      name: v.string(),
      email: v.string(),
      role: membershipRole,
      membershipVersion: v.number(),
      granted: v.boolean(),
      grantVersion: v.number(),
      inherited: v.boolean(),
    }),
  ),
  handler: async (ctx, { organizationId, companyId, paginationOpts }) => {
    await requireCompany(ctx, organizationId, companyId, true, { archived: "allowed" });
    const result = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", "active"),
      )
      .paginate(boundedPagination(paginationOpts));
    const page = await Promise.all(
      result.page.map(async (member) => {
        const grant = await ctx.db
          .query("companyGrants")
          .withIndex("by_companyId_and_membershipId", (q) =>
            q.eq("companyId", companyId).eq("membershipId", member._id),
          )
          .unique();
        const inherited = companyCapabilities(member.role).manage;
        return {
          membershipId: member._id,
          name: member.name,
          email: member.email,
          role: member.role,
          membershipVersion: member.version,
          granted:
            inherited ||
            Boolean(grant?.active && grant.membershipEpoch === (member.companyAccessEpoch ?? 0)),
          grantVersion: grant?.version ?? 0,
          inherited,
        };
      }),
    );
    return { ...result, page };
  },
});
export const setGrant = mutation({
  args: {
    ...scope,
    membershipId: v.id("memberships"),
    allowed: v.boolean(),
    expectedMembershipVersion: v.number(),
    expectedGrantVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, company } = await requireCompany(ctx, args.organizationId, args.companyId, true);
    const member = await ctx.db.get("memberships", args.membershipId);
    if (
      !member ||
      member.organizationId !== args.organizationId ||
      member.state !== "active" ||
      companyCapabilities(member.role).manage
    )
      return deny();
    if (member.version !== args.expectedMembershipVersion) deny("MEMBERSHIP_CHANGED");
    const grant = await ctx.db
      .query("companyGrants")
      .withIndex("by_companyId_and_membershipId", (q) =>
        q.eq("companyId", args.companyId).eq("membershipId", args.membershipId),
      )
      .unique();
    if ((grant?.version ?? 0) !== args.expectedGrantVersion) deny("GRANT_CHANGED");
    const active = Boolean(
      grant?.active && grant.membershipEpoch === (member.companyAccessEpoch ?? 0),
    );
    if (active === args.allowed) return null;
    const data = {
      organizationId: args.organizationId,
      companyId: args.companyId,
      membershipId: member._id,
      membershipEpoch: member.companyAccessEpoch ?? 0,
      active: args.allowed,
      version: (grant?.version ?? 0) + 1,
      updatedAt: Date.now(),
    };
    if (grant) await ctx.db.patch("companyGrants", grant._id, data);
    else await ctx.db.insert("companyGrants", data);
    await companyAudit(
      ctx,
      company,
      user._id,
      args.allowed ? "company.granted" : "company.revoked",
      member._id,
    );
    return null;
  },
});
export const activity = query({
  args: { ...scope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      id: v.id("companyAudit"),
      action: companyAuditAction,
      createdAt: v.number(),
      targetMembershipId: v.optional(v.id("memberships")),
    }),
  ),
  handler: async (ctx, { organizationId, companyId, paginationOpts }) => {
    await requireCompany(ctx, organizationId, companyId, true, { archived: "allowed" });
    const result = await ctx.db
      .query("companyAudit")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .order("desc")
      .paginate(boundedPagination(paginationOpts));
    return {
      ...result,
      page: result.page.map((entry) => ({
        id: entry._id,
        action: entry.action,
        createdAt: entry.createdAt,
        ...(entry.targetMembershipId ? { targetMembershipId: entry.targetMembershipId } : {}),
      })),
    };
  },
});

/** Whether the company can still be deleted: a manager, a declared company and no history. */
export const deletion = query({
  args: { ...scope, contextKey: v.string() },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { organizationId, companyId }) => {
    const { membership } = await requireMembership(ctx, organizationId);
    // A company removed a moment ago answers "not allowed", so the page can leave without errors.
    const access = companyCapabilities(membership.role).manage
      ? await findCompany(ctx, membership, companyId)
      : null;
    return {
      allowed: Boolean(
        access?.company.kind === "declared" && !(await companyHistory(ctx, access.company)),
      ),
    };
  },
});
/**
 * Removes a company registered by mistake. Only a company that never took part in a fiscal,
 * integration or certificate flow goes; anything with history stays, under its own retention.
 * The confirmation is the CNPJ, typed by the manager.
 */
export const remove = mutation({
  args: { ...scope, expectedVersion: v.number(), confirmation: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId, companyId, expectedVersion, confirmation }) => {
    const { user, company } = await requireCompany(ctx, organizationId, companyId, true);
    if (company.kind === "demonstration") deny("DEMONSTRATION_READ_ONLY");
    if (company.version !== expectedVersion) deny("COMPANY_CHANGED");
    if (normalizeCnpj(confirmation) !== company.cnpj) deny("CONFIRMATION_MISMATCH");
    const history = await companyHistory(ctx, company);
    if (history) deny(history);
    const { del, drain, all } = purger(ctx, { left: 4000 });
    const id = company._id;
    const done = await all(
      () =>
        drain<"companyGrants">(
          (n) =>
            ctx.db
              .query("companyGrants")
              .withIndex("by_companyId_and_membershipId", (q) => q.eq("companyId", id))
              .take(n),
          del("companyGrants"),
        ),
      () =>
        drain<"companyAudit">(
          (n) =>
            ctx.db
              .query("companyAudit")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("companyAudit"),
        ),
      () =>
        drain<"certificateAudit">(
          (n) =>
            ctx.db
              .query("certificateAudit")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("certificateAudit"),
        ),
      () =>
        drain<"certificateHeads">(
          (n) =>
            ctx.db
              .query("certificateHeads")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("certificateHeads"),
        ),
      () =>
        drain<"certificates">(
          (n) =>
            ctx.db
              .query("certificates")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("certificates"),
        ),
      () =>
        drain<"nfseProfiles">(
          (n) =>
            ctx.db
              .query("nfseProfiles")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("nfseProfiles"),
        ),
      () =>
        drain<"registryApplications">(
          (n) =>
            ctx.db
              .query("registryApplications")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("registryApplications"),
        ),
      () =>
        drain<"issuanceGates">(
          (n) =>
            ctx.db
              .query("issuanceGates")
              .withIndex("by_companyId", (q) => q.eq("companyId", id))
              .take(n),
          del("issuanceGates"),
        ),
    );
    // A company without history has few rows; a larger tree is refused instead of left halfway.
    if (!done) deny("COMPANY_HAS_HISTORY");
    const onboarding = await onboardingState(ctx, organizationId);
    if (onboarding?.companyId === company._id)
      await ctx.db.patch("onboarding", onboarding._id, {
        companyId: undefined,
        version: onboarding.version + 1,
        updatedAt: Date.now(),
      });
    await ctx.db.delete("companies", company._id);
    await recordAudit(ctx, {
      organizationId,
      companyId: company._id,
      actor: user._id,
      action: "company.deleted",
      target: company._id,
    });
    return null;
  },
});
