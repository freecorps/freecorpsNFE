import { v } from "convex/values";
import { query } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { baseEnvironment } from "./lib/environmentAccess";
import { fiscalCaptureEnabled } from "./lib/fiscalCaptureRelease";
import { findMembership, requireMembership, requireUser } from "./lib/organizationAccess";
import { environment } from "./lib/projectValues";

/**
 * The environment this deployment serves, for the console: `environment` is its `PRODUCT_ENV`
 * and `fiscalProduction` says whether it is the fiscal production deployment of the NFS-e
 * issuance (`issuanceEnv`). The console sets the scope of its fiscal screens and the environment
 * indicator from it; every function checks the environment again. Public and without a session,
 * like `/health`, which already reports both.
 */
export const current = query({
  args: {},
  returns: v.object({
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    fiscalProduction: v.boolean(),
  }),
  handler: async () => {
    const { issuanceEnv } = requirePlatformEnvironment();
    return {
      environment: baseEnvironment(),
      fiscalProduction: issuanceEnv === "production",
    };
  },
});

/**
 * The environments the console's selector offers for the organization (ADR 0007, §1 and §2): the
 * deployment's own always; Produção beside the Sandbox once a company of the organization had its
 * fiscal capture released, even if it was withdrawn later, since its documents stay for reading.
 * Before that, only to an owner or admin while the deployment offers the fiscal capture: the
 * release is made inside Produção, never from the Sandbox. Only a view: every function checks
 * the environment against the company again.
 *
 * `null` for a signed-in person who is not an active member, as `organizations.context` answers:
 * the console's shell asks this beside the organization's context, and a member removed with the
 * page open must see "Organização indisponível.", not a failed shell (#4).
 */
export const environments = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(v.null(), v.array(environment)),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const member = await findMembership(ctx, args.organizationId, user._id);
    if (!member || member.state !== "active") return null;
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    const base = baseEnvironment();
    if (base === "production") return [base];
    // One row per company, read until the first released one: no cap may hide Produção.
    const released = await ctx.db
      .query("captureReleases")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("releasedBefore"), true))
      .first();
    const manager = membership.role === "owner" || membership.role === "admin";
    return released || (manager && fiscalCaptureEnabled())
      ? ["sandbox" as const, "production" as const]
      : ["sandbox" as const];
  },
});
