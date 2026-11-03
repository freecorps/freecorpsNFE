import { jsonRoute } from "./lib/externalHttp";
import { deny } from "./lib/organizationAccess";
import { ConvexError, v } from "convex/values";
import { authenticateKey } from "./lib/operationAccess";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requirePlatformEnvironment } from "./environment";
import { environmentServed, keyEnvironmentServed } from "./lib/environmentAccess";
import { projectGrant } from "./lib/projectAccess";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { armRetention } from "./lib/operationalRetention";
import { apiUsageExpiresAt } from "./lib/apiUsageRetention";

const companyValue = v.object({
  id: v.string(),
  name: v.string(),
  cnpj: v.string(),
  kind: v.union(v.literal("declared"), v.literal("demonstration")),
  registryStatus: v.literal("not-consulted"),
  fiscalAccess: v.literal("not-configured"),
});
async function visibleCompany(ctx: MutationCtx, key: Doc<"apiKeys">, id: string) {
  const index = key.companyIds.indexOf(id as Doc<"companies">["_id"]);
  if (index < 0) return null;
  const companyId = key.companyIds[index]!;
  const grant = await projectGrant(ctx, key.projectId, companyId);
  if (
    !grant?.active ||
    grant.organizationId !== key.organizationId ||
    grant.accessEpoch !== key.grantEpochs[index] ||
    !grant.environments.includes(key.environment) ||
    !grant.scopes.includes("companies:read")
  )
    return null;
  const company = await ctx.db.get("companies", companyId);
  if (
    !company ||
    company.organizationId !== key.organizationId ||
    !(await environmentServed(ctx, company, key.environment, "companies:read"))
  )
    return null;
  return {
    id: String(company._id),
    name: company.name,
    cnpj: company.cnpj,
    kind: company.kind,
    registryStatus: "not-consulted" as const,
    fiscalAccess: "not-configured" as const,
  };
}
export const companies = internalMutation({
  args: {
    keyHash: v.string(),
    requestId: v.string(),
    environment: v.string(),
    companyId: v.union(v.string(), v.null()),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  returns: v.object({
    data: v.union(companyValue, v.array(companyValue)),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    // The single key rule (revocation, expiry, project epoch, closure, never the console project).
    // Companies are not fiscal data: a key reads them in cold custody too (ADR 0009, §2).
    let key: Doc<"apiKeys">;
    try {
      key = await authenticateKey(ctx, args.keyHash, { archived: "allowed" });
    } catch (error) {
      if (error instanceof ConvexError) return deny("INVALID_API_KEY");
      throw error;
    }
    if (
      args.environment !== key.environment ||
      !(await keyEnvironmentServed(ctx, key, "companies:read"))
    )
      return deny("ENVIRONMENT_DENIED");
    if (!key.scopes.includes("companies:read")) return deny("SCOPE_DENIED");
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50)
      return deny("INVALID_PAGINATION");
    let offset = 0;
    if (args.cursor !== null) {
      try {
        const value: unknown = JSON.parse(atob(args.cursor));
        if (
          !value ||
          typeof value !== "object" ||
          !("key" in value) ||
          value.key !== key._id ||
          !("environment" in value) ||
          value.environment !== key.environment ||
          !("offset" in value) ||
          typeof value.offset !== "number" ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0 ||
          value.offset > key.companyIds.length
        )
          throw new Error("cursor");
        offset = value.offset;
      } catch {
        return deny("INVALID_CURSOR");
      }
    }
    const route =
      args.companyId === null ? ("companies.list" as const) : ("companies.get" as const);
    const selected =
      args.companyId === null
        ? key.companyIds.slice(offset, offset + args.limit)
        : [args.companyId];
    const visible = (await Promise.all(selected.map((id) => visibleCompany(ctx, key, id)))).flatMap(
      (c) => (c ? [c] : []),
    );
    if (args.companyId !== null && !visible.length) return deny("NOT_FOUND");
    const nextOffset = offset + args.limit;
    const nextCursor =
      args.companyId === null && nextOffset < key.companyIds.length
        ? btoa(JSON.stringify({ key: key._id, environment: key.environment, offset: nextOffset }))
        : null;
    // Detailed receipts are deduplicated during retention, then compacted transactionally.
    const previous = await ctx.db
      .query("apiUsageEvents")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!previous) {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      await ctx.db.insert("apiUsageEvents", {
        organizationId: key.organizationId,
        projectId: key.projectId,
        keyId: key._id,
        requestId: args.requestId,
        route,
        environment: key.environment,
        day,
        shard: parseInt(args.requestId.slice(0, 2), 16) % 16,
        createdAt: now,
      });
      await armRetention(ctx, key.organizationId, apiUsageExpiresAt(day));
    }
    return {
      data: args.companyId === null ? visible : visible[0]!,
      nextCursor,
    };
  },
});

/** All public responses are DTOs. Raw Convex errors and secrets never reach the HTTP body. */
export const companyRoute = jsonRoute({ notFound: "Empresa não encontrada." }, async (input) => {
  const { url } = input;
  const tail = url.pathname.slice("/v1/companies".length);
  if (tail && (!tail.startsWith("/") || tail.slice(1).includes("/") || tail.length === 1))
    return deny("NOT_FOUND");
  if (
    [...url.searchParams.keys()].some((k) => !["limit", "cursor"].includes(k)) ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("cursor").length > 1
  )
    return deny("INVALID_QUERY");
  const limitText = url.searchParams.get("limit") ?? "20";
  const cursor = url.searchParams.get("cursor");
  if (!/^\d{1,2}$/.test(limitText) || (cursor?.length ?? 0) > 1024)
    return deny("INVALID_PAGINATION");
  const result = await input.ctx.runMutation(internal.rest.companies, {
    keyHash: input.keyHash,
    requestId: input.requestId,
    environment: input.environment,
    companyId: tail ? tail.slice(1) : null,
    cursor,
    limit: Number(limitText),
  });
  return tail ? { data: result.data } : { data: result.data, nextCursor: result.nextCursor };
});
