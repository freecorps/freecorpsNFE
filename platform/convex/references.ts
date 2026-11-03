import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { dataset, referenceResult } from "./lib/referenceSchema";
import { readReferences } from "./lib/referenceRead";
import { requireCompany } from "./lib/companyAccess";
import { authenticateKey, keyAccess } from "./lib/operationAccess";
import { deny } from "./lib/organizationAccess";

const readArgs = {
  dataset,
  date: v.string(),
  version: v.optional(v.string()),
  q: v.optional(v.string()),
  code: v.optional(v.string()),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};
export const search = query({
  args: {
    ...readArgs,
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    contextKey: v.string(),
  },
  returns: referenceResult,
  handler: async (ctx, args) => {
    await requireCompany(ctx, args.organizationId, args.companyId);
    return await readReferences(ctx, args);
  },
});
export const rest = internalQuery({
  args: {
    ...readArgs,
    keyHash: v.string(),
    companyId: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
  },
  returns: referenceResult,
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    const companyId = ctx.db.normalizeId("companies", args.companyId);
    if (!companyId) return deny("NOT_FOUND");
    await keyAccess(ctx, args.keyHash, {
      organizationId: key.organizationId,
      projectId: key.projectId,
      companyId,
      environment: args.environment,
      task: { scope: "references:read" },
    });
    return await readReferences(ctx, args);
  },
});
