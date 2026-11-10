import { v } from "convex/values";
import { companyCapabilities, demonstrationCompany } from "@freecorps/contracts";
import { query, mutation } from "./_generated/server";
import {
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import { findCompany, onboardingState, summary } from "./lib/companyAccess";
import { createCompany } from "./lib/companyCore";
import { companySummary, onboardingMode } from "./lib/companyValues";

export const get = query({
  args: { organizationId: v.id("organizations"), contextKey: v.string() },
  returns: v.object({
    mode: v.union(onboardingMode, v.null()),
    company: v.union(companySummary, v.null()),
    guidanceDismissed: v.boolean(),
    version: v.number(),
    canManage: v.boolean(),
    firstDocument: v.union(v.literal("pending-import"), v.literal("imported")),
    certificateRequired: v.literal(false),
  }),
  handler: async (ctx, { organizationId }) => {
    const { membership } = await requireMembership(ctx, organizationId);
    const state = await onboardingState(ctx, organizationId);
    const permitted = state?.companyId ? await findCompany(ctx, membership, state.companyId) : null;
    const document = permitted
      ? await ctx.db
          .query("fiscalDocuments")
          .withIndex("by_organizationId_and_companyId_and_environment_and_completeness", (q) =>
            q
              .eq("organizationId", organizationId)
              .eq("companyId", permitted.company._id)
              .eq("environment", "sandbox")
              .gte("completeness", 0),
          )
          .first()
      : null;
    return {
      mode: state?.mode ?? null,
      company: permitted ? summary(permitted.company) : null,
      guidanceDismissed: state?.guidanceDismissed ?? false,
      version: state?.version ?? 0,
      canManage: companyCapabilities(membership.role).manage,
      firstDocument: document ? ("imported" as const) : ("pending-import" as const),
      certificateRequired: false as const,
    };
  },
});
export const start = mutation({
  args: {
    organizationId: v.id("organizations"),
    mode: onboardingMode,
    expectedVersion: v.number(),
  },
  returns: v.object({ companyId: v.union(v.id("companies"), v.null()) }),
  handler: async (ctx, { organizationId, mode, expectedVersion }) => {
    const { user, membership } = await requireMembership(ctx, organizationId);
    requireManager(membership);
    const previous = await onboardingState(ctx, organizationId);
    if (previous?.mode === mode && (mode === "manual" || previous.companyId))
      return { companyId: previous.companyId ?? null };
    if ((previous?.version ?? 0) !== expectedVersion) deny("ONBOARDING_CHANGED");
    await limitOrganizationAction(ctx, "onboarding-start", user._id);
    const demo =
      mode === "demonstration"
        ? await createCompany(ctx, organizationId, user._id, demonstrationCompany, "demonstration")
        : null;
    const companyId = demo?.company._id;
    const data = {
      organizationId,
      mode,
      ...(companyId ? { companyId } : {}),
      guidanceDismissed: false,
      version: (previous?.version ?? 0) + 1,
      updatedAt: Date.now(),
    };
    if (previous) await ctx.db.replace("onboarding", previous._id, data);
    else await ctx.db.insert("onboarding", data);
    return { companyId: companyId ?? null };
  },
});
export const selectCompany = mutation({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    expectedVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { organizationId, companyId, expectedVersion }) => {
    const { membership } = await requireMembership(ctx, organizationId);
    requireManager(membership);
    const selected = await findCompany(ctx, membership, companyId);
    if (!selected) return deny();
    const previous = await onboardingState(ctx, organizationId);
    if (previous?.companyId === companyId) return null;
    if ((previous?.version ?? 0) !== expectedVersion) deny("ONBOARDING_CHANGED");
    const data = {
      organizationId,
      mode:
        selected.company.kind === "demonstration"
          ? ("demonstration" as const)
          : ("manual" as const),
      companyId,
      guidanceDismissed: false,
      version: (previous?.version ?? 0) + 1,
      updatedAt: Date.now(),
    };
    if (previous) await ctx.db.replace("onboarding", previous._id, data);
    else await ctx.db.insert("onboarding", data);
    return null;
  },
});
export const dismissGuidance = mutation({
  args: { organizationId: v.id("organizations"), expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { organizationId, expectedVersion }) => {
    const { membership } = await requireMembership(ctx, organizationId);
    requireManager(membership);
    const state = await onboardingState(ctx, organizationId);
    if (!state) deny("ONBOARDING_CHANGED");
    if (state.guidanceDismissed) return null;
    if (state.version !== expectedVersion) deny("ONBOARDING_CHANGED");
    await ctx.db.patch("onboarding", state._id, {
      guidanceDismissed: true,
      version: state.version + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});
