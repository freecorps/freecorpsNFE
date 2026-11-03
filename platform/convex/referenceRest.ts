import { jsonRoute } from "./lib/externalHttp";
import { internal } from "./_generated/api";
import { deny } from "./lib/organizationAccess";

export const route = jsonRoute(
  { notFound: "Referência não encontrada." },
  async ({ ctx, url, ...input }) => {
    const match = /^\/v1\/references\/(municipalities|ncm)(?:\/(\d+))?$/.exec(url.pathname);
    if (!match) return deny("NOT_FOUND");
    const environment = input.environment;
    if (environment !== "sandbox" && environment !== "production")
      return deny("ENVIRONMENT_DENIED");
    const companyId = url.searchParams.get("companyId");
    if (!companyId || !/^[a-z0-9]{16,64}$/.test(companyId)) return deny("NOT_FOUND");
    const data = await ctx.runQuery(internal.references.rest, {
      keyHash: input.keyHash,
      environment,
      companyId,
      dataset: match[1] as "municipalities" | "ncm",
      date: url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10),
      ...(match[2] ? { code: match[2] } : {}),
      ...(url.searchParams.has("version") ? { version: url.searchParams.get("version")! } : {}),
      ...(url.searchParams.has("q") ? { q: url.searchParams.get("q")! } : {}),
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    });
    return { data };
  },
);
