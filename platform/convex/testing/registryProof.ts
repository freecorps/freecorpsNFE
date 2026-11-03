import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof } from "./operationProof";
import { cacheFor } from "../lib/registryRead";
import { CACHE_TTL, RETENTION } from "../lib/registryValues";

/** Local synthetic cache, never enabled in a hosted deployment. */
export const stage = internalMutation({
  args: {
    companyId: v.id("companies"),
    mode: v.union(
      v.literal("found"),
      v.literal("unavailable"),
      v.literal("not_found"),
      v.literal("unsupported_format"),
      v.literal("stale"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const company = await ctx.db.get("companies", args.companyId);
    if (!company || !company.name.includes("sintética"))
      throw new Error("Synthetic company required");
    const existing = await cacheFor(ctx, company.cnpj),
      now = Date.now();
    const data = {
      name: "Razão social da fonte sintética",
      status: "Ativa",
      address: {
        street: "Rua da fonte",
        number: "76",
        complement: "",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
        postalCode: "01000000",
      },
    };
    const record = {
      provider: "opencnpj" as const,
      cnpj: company.cnpj,
      status: args.mode === "stale" ? ("found" as const) : args.mode,
      data: ["found", "stale", "unavailable"].includes(args.mode) ? data : null,
      sourceUpdatedAt: null,
      consultedAt: now - (args.mode === "found" ? 0 : 2 * CACHE_TTL),
      lastAttemptAt: now,
      expiresAt: args.mode === "found" ? now + CACHE_TTL : now - 1,
      refreshAfter: now + CACHE_TTL,
      retainUntil: now + RETENTION,
      version: (existing?.version ?? 0) + 1,
      stale: args.mode !== "found",
    };
    if (existing) await ctx.db.replace("registryCache", existing._id, record);
    else await ctx.db.insert("registryCache", record);
    return null;
  },
});
export const inspect = internalQuery({
  args: { companyId: v.id("companies") },
  returns: v.string(),
  handler: async (ctx, { companyId }) => {
    requireLocalProof();
    const company = await ctx.db.get("companies", companyId);
    if (!company) throw new Error("Missing company");
    const applications = await ctx.db
      .query("registryApplications")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .take(20);
    return JSON.stringify({ company, applications });
  },
});
