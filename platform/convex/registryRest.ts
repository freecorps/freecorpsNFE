import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { jsonRoute } from "./lib/externalHttp";
import { authenticateKey, keyAccess } from "./lib/operationAccess";
import { registryLookupValue, registryReservation, registryTask } from "./lib/registryValues";
import { readRegistry } from "./lib/registryRead";
import { normalizeCnpj } from "@freecorps/contracts";
import { deny } from "./lib/organizationAccess";
import { reserveRegistry } from "./registry";

export const dispatch = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    companyId: v.string(),
    cnpj: v.string(),
    key: v.optional(v.string()),
  },
  returns: v.union(registryReservation, registryLookupValue),
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    if (key.environment !== args.environment) deny("ENVIRONMENT_DENIED");
    const companyId = ctx.db.normalizeId("companies", args.companyId);
    if (!companyId) return deny("NOT_FOUND");
    const scope = {
      organizationId: key.organizationId,
      projectId: key.projectId,
      companyId,
      environment: key.environment,
    };
    await keyAccess(ctx, args.keyHash, { ...scope, task: registryTask });
    const company = await ctx.db.get("companies", companyId);
    const cnpj = normalizeCnpj(args.cnpj);
    if (!cnpj) return deny("INVALID_REQUEST");
    if (company?.cnpj !== cnpj) return deny("NOT_FOUND");
    if (company.kind === "demonstration") return deny("NOT_FOUND");
    return args.key !== undefined
      ? await reserveRegistry(ctx, { ...scope, cnpj, key: args.key }, args.keyHash)
      : await readRegistry(ctx, cnpj);
  },
});
export const route = jsonRoute({ notFound: "Empresa não encontrada." }, async (input) => {
  const match = /^\/v1\/registry\/cnpj\/([A-Z0-9]{14})(\/refresh)?$/.exec(input.url.pathname);
  const post = input.request.method === "POST";
  if (!match || post !== Boolean(match[2]) || !input.route) return deny("NOT_FOUND");
  const companyId = post
    ? (input.route.value.body as { companyId: string }).companyId
    : input.url.searchParams.get("companyId");
  if (typeof companyId !== "string") return deny("INVALID_REQUEST");
  const data = await input.ctx.runMutation(internal.registryRest.dispatch, {
    keyHash: input.keyHash,
    environment: input.environment,
    cnpj: match[1]!,
    companyId,
    ...(post ? { key: input.idempotencyKey } : {}),
  });
  return { data };
});
