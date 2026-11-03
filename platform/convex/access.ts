import { ConvexError, v } from "convex/values";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { requirePlatformEnvironment } from "./environment";

export const roleValidator = v.union(v.literal("operator"), v.literal("viewer"));

async function actor(ctx: QueryCtx) {
  requirePlatformEnvironment();
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return null;
  const grant = await ctx.db
    .query("validationAccess")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", user._id))
    .unique();
  return { name: user.name, email: user.email, role: grant?.role ?? null };
}

export const session = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ name: v.string(), email: v.string(), role: v.union(roleValidator, v.null()) }),
  ),
  handler: actor,
});

export const overview = query({
  args: {},
  returns: v.object({
    status: v.literal("authorized"),
    role: roleValidator,
    environment: v.literal("validation"),
  }),
  handler: async (ctx) => {
    const current = await actor(ctx);
    if (!current) throw new ConvexError({ code: "UNAUTHENTICATED" });
    if (!current.role) throw new ConvexError({ code: "ACCESS_DENIED" });
    return {
      status: "authorized" as const,
      role: current.role,
      environment: "validation" as const,
    };
  },
});

export const diagnostics = query({
  args: {},
  returns: v.object({
    persistentRecordPresent: v.boolean(),
  }),
  handler: async (ctx) => {
    const current = await actor(ctx);
    if (!current) throw new ConvexError({ code: "UNAUTHENTICATED" });
    if (current.role !== "operator") throw new ConvexError({ code: "ACCESS_DENIED" });
    const probe = await ctx.db
      .query("validationProbes")
      .withIndex("by_key", (q) => q.eq("key", "persistence-v1"))
      .unique();
    return { persistentRecordPresent: Boolean(probe) };
  },
});

// Operated with a deployment credential only. Never infer grants from email on login.
export const grant = internalMutation({
  args: { authUserId: v.string(), role: roleValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    const existing = await ctx.db
      .query("validationAccess")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", args.authUserId))
      .unique();
    if (existing) await ctx.db.patch("validationAccess", existing._id, { role: args.role });
    else await ctx.db.insert("validationAccess", args);
    return null;
  },
});
