import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import schema from "./schema";

export const readProbe = internalQuery({
  args: {},
  returns: v.union(schema.doc("validationProbes"), v.null()),
  handler: async (ctx) => {
    requirePlatformEnvironment();
    return await ctx.db
      .query("validationProbes")
      .withIndex("by_key", (q) => q.eq("key", "persistence-v1"))
      .unique();
  },
});

export const createProbe = internalMutation({
  args: { nonce: v.string() },
  returns: v.id("validationProbes"),
  handler: async (ctx, { nonce }) => {
    requirePlatformEnvironment();
    if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error("Expected a synthetic UUID");
    const existing = await ctx.db
      .query("validationProbes")
      .withIndex("by_key", (q) => q.eq("key", "persistence-v1"))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("validationProbes", {
      key: "persistence-v1",
      nonce,
      createdAt: Date.now(),
    });
  },
});
