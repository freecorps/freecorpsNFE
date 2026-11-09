import { jsonRoute } from "./lib/externalHttp";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authenticateKey } from "./lib/operationAccess";
import { deny } from "./lib/organizationAccess";
import {
  listDocuments,
  getDocument,
  documentItems,
  documentVersions,
  unclassifiedArtifacts,
  documentFiles,
  reprocessDocument,
} from "./documents";
import { artifactAccess, chargeOriginal, responseHeaders } from "./documentDownloads";
import { originalBody, originalSource } from "./lib/documentOriginalRead";
import { servedOriginal } from "./lib/originalStore";
import { prepareCompany } from "./documentProjection";
import { documentAccess, loadScopedDocument } from "./lib/documentCore";
import { auditDanfe, danfeHeaders, resolveDanfe, serveDanfe } from "./documentDanfe";
import { danfeResolution } from "./lib/danfeValues";
import { fiscalStatuses, type FiscalStatus } from "@freecorps/contracts";
import type { ContentPlan } from "./lib/documentContentPlan";
const fields = {
  keyHash: v.string(),
  environment: v.string(),
  company: v.string(),
  path: v.string(),
  search: v.string(),
};
async function parse(
  ctx: Parameters<typeof authenticateKey>[0],
  args: { keyHash: string; environment: string; company: string },
) {
  const key = await authenticateKey(ctx, args.keyHash);
  if (key.environment !== args.environment) return deny("ENVIRONMENT_DENIED");
  const companyId = ctx.db.normalizeId("companies", args.company);
  if (!companyId) return deny("NOT_FOUND");
  const scope = {
    organizationId: key.organizationId,
    projectId: key.projectId,
    companyId,
    environment: key.environment,
  };
  await documentAccess(ctx, scope, args.keyHash);
  return scope;
}
/**
 * Routes whose response needs a version's content answer with the plan, never the data: the
 * route hands them to `documentContentNode.restRead`, which reads the blobs and renders.
 */
const planned = (plan: ContentPlan) => JSON.stringify({ $plan: plan });
/** The paths `dispatch` answers with a plan (`planned`). */
export const plannedPath = /^\/v1\/documents\/[^/]+(?:\/(?:items|events|versions|json))?$/;
export const initialize = internalMutation({
  args: { keyHash: v.string(), environment: v.string(), company: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const scope = await parse(ctx, args);
    await prepareCompany(ctx, scope);
    return null;
  },
});
export const dispatch = internalQuery({
  args: fields,
  returns: v.string(),
  handler: async (ctx, args) => {
    const scope = await parse(ctx, args),
      params = new URLSearchParams(args.search);
    if (args.path === "/v1/document-artifacts") {
      for (const name of params.keys())
        if (!["companyId", "cursor", "limit"].includes(name) || params.getAll(name).length !== 1)
          return deny("INVALID_REQUEST");
      return JSON.stringify(
        await unclassifiedArtifacts(
          ctx,
          { ...scope, cursor: params.get("cursor"), limit: Number(params.get("limit") ?? 20) },
          args.keyHash,
        ),
      );
    }
    const match = /^\/v1\/documents(?:\/([^/]+)(?:\/(items|events|versions|json|files))?)?$/.exec(
      args.path,
    );
    if (!match) return deny("NOT_FOUND");
    const allowed = !match[1]
      ? ["companyId", "cursor", "limit", "status", "source", "from", "to", "key"]
      : match[2] === "items"
        ? ["companyId", "cursor", "limit", "versionId"]
        : match[2] === "events"
          ? ["companyId", "cursor", "limit", "kind"]
          : ["versions", "files"].includes(match[2] ?? "")
            ? ["companyId", "cursor", "limit"]
            : ["companyId", "versionId"];
    for (const name of params.keys())
      if (!allowed.includes(name) || params.getAll(name).length !== 1)
        return deny("INVALID_REQUEST");
    const cursor = params.get("cursor"),
      limit = Number(params.get("limit") ?? (match[2] === "items" ? 25 : 20));
    if (!match[1]) {
      const status = params.get("status"),
        source = params.get("source");
      if (
        (status !== null && !fiscalStatuses.includes(status as FiscalStatus)) ||
        (source !== null && source !== "imported-xml" && source !== "distribution-xml")
      )
        return deny("INVALID_REQUEST");
      return JSON.stringify(
        await listDocuments(
          ctx,
          {
            ...scope,
            cursor,
            limit,
            ...(status ? { status: status as FiscalStatus } : {}),
            ...(source ? { source } : {}),
            ...(params.has("from") ? { from: Number(params.get("from")) } : {}),
            ...(params.has("to") ? { to: Number(params.get("to")) } : {}),
            ...(params.has("key") ? { key: params.get("key")! } : {}),
          },
          args.keyHash,
        ),
      );
    }
    const documentId = match[1],
      versionId = params.get("versionId") ?? undefined;
    if (match[2] === "items") {
      if (!versionId) return deny("INVALID_REQUEST");
      return planned(
        await documentItems(ctx, { ...scope, documentId, versionId, cursor, limit }, args.keyHash),
      );
    }
    if (match[2] === "files")
      return JSON.stringify(
        await documentFiles(ctx, { ...scope, documentId, cursor, limit }, args.keyHash),
      );
    if (["events", "versions"].includes(match[2] ?? ""))
      return planned(
        await documentVersions(
          ctx,
          {
            ...scope,
            documentId,
            cursor,
            limit,
            ...(match[2] === "events" ? { kind: params.get("kind") ?? "event" } : {}),
          },
          args.keyHash,
        ),
      );
    return planned(
      await getDocument(
        ctx,
        { ...scope, documentId, ...(versionId ? { versionId } : {}) },
        args.keyHash,
      ),
    );
  },
});
export const reprocess = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    company: v.string(),
    documentId: v.string(),
    key: v.string(),
  },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: async (ctx, args) =>
    reprocessDocument(
      ctx,
      { ...(await parse(ctx, args)), documentId: args.documentId, key: args.key },
      args.keyHash,
    ),
});
export const download = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    company: v.string(),
    artifactId: v.string(),
    transferKey: v.optional(v.string()),
  },
  returns: originalSource,
  handler: async (ctx, args) => {
    const scope = await parse(ctx, args);
    const artifact = await artifactAccess(ctx, scope, args.artifactId, args.keyHash);
    const source = await servedOriginal(ctx, artifact);
    if (args.transferKey) await chargeOriginal(ctx, scope.organizationId, source, args.transferKey);
    return source;
  },
});
/** The DANFE of a published NF-e 55, under the key's `documents:read` grant (`documentDanfe.ts`). */
export const danfe = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    company: v.string(),
    documentId: v.string(),
    transferKey: v.optional(v.string()),
    rendered: v.optional(v.boolean()),
    /** The file read; with it, the call is the recheck and audits a current download. */
    recheck: v.optional(v.id("_storage")),
    requestId: v.optional(v.string()),
  },
  returns: danfeResolution,
  handler: async (ctx, { documentId, transferKey, rendered, recheck, requestId, ...args }) => {
    const scope = await parse(ctx, args);
    const { doc, version } = await loadScopedDocument(ctx, scope, documentId);
    const result = await resolveDanfe(ctx, scope, doc, version, {
      transferKey,
      rendered,
      recheck: recheck !== undefined,
    });
    if (recheck && requestId && result.state === "ready" && result.storageId === recheck) {
      const key = await authenticateKey(ctx, args.keyHash);
      await auditDanfe(
        ctx,
        { ...scope, projectId: key.projectId, actor: `key:${key._id}`, requestId },
        doc,
      );
    }
    return result;
  },
});
export const route = jsonRoute(
  { notFound: "Documento não encontrado.", maxBody: 1024 },
  async ({ ctx, request, url, requestId, route, ...input }) => {
    if (request.url.length > 8192) return deny("INVALID_REQUEST");
    const args = {
      keyHash: input.keyHash,
      environment: input.environment,
      company: url.searchParams.get("companyId") ?? "",
    };
    if (request.method === "POST") {
      // The contract fixes the path, a single `companyId` and the empty body.
      if (route?.name !== "reprocessDocument") return deny("INVALID_REQUEST");
      const data = await ctx.runMutation(internal.documentRest.reprocess, {
        ...args,
        documentId: (route.value.path as { documentId: string }).documentId,
        key: input.idempotencyKey,
      });
      return { data, status: 202, headers: { Location: `/v1/operations/${data.operationId}` } };
    }
    const artifact = /^\/v1\/document-artifacts\/([^/]+)\/original$/.exec(url.pathname);
    if (artifact) {
      if (
        [...url.searchParams.keys()].some((key) => key !== "companyId") ||
        url.searchParams.getAll("companyId").length !== 1
      )
        return deny("INVALID_REQUEST");
      const source = await ctx.runMutation(internal.documentRest.download, {
        ...args,
        artifactId: artifact[1]!,
        transferKey: crypto.randomUUID(),
      });
      // Hot or cold (ADR 0010, decision 8): the same raw XML, checked against the recorded hash.
      const blob = await originalBody(ctx.storage, source);
      if (!blob) return deny("ORIGINAL_UNAVAILABLE");
      await ctx.runMutation(internal.documentRest.download, { ...args, artifactId: artifact[1]! });
      return new Response(blob, { headers: { ...responseHeaders, "X-Request-Id": requestId } });
    }
    const danfe = /^\/v1\/documents\/([^/]+)\/danfe$/.exec(url.pathname);
    if (danfe) {
      if (
        [...url.searchParams.keys()].some((key) => key !== "companyId") ||
        url.searchParams.getAll("companyId").length !== 1
      )
        return deny("INVALID_REQUEST");
      // The first download renders the PDF inside this request (a few seconds at most).
      const { blob, name } = await serveDanfe(ctx, (options) =>
        ctx.runMutation(internal.documentRest.danfe, {
          ...args,
          documentId: danfe[1]!,
          ...options,
          ...(options.recheck ? { requestId } : {}),
        }),
      );
      return new Response(blob, { headers: { ...danfeHeaders(name), "X-Request-Id": requestId } });
    }
    const dispatchArgs = { ...args, path: url.pathname, search: url.search };
    let data: string;
    if (url.pathname === "/v1/documents") {
      // The key's expiry was checked against the clock at admission (`observedAction`).
      data = await ctx.runQuery(internal.documentRest.dispatch, dispatchArgs);
      const page: unknown = JSON.parse(data);
      // Indexed pages are read-only. Preserve the legacy backfill when the query sees a gap.
      if (page && typeof page === "object" && "indexing" in page && page.indexing === true) {
        await ctx.runMutation(internal.documentRest.initialize, args);
        data = await ctx.runQuery(internal.documentRest.dispatch, dispatchArgs);
      }
    } else {
      await ctx.runMutation(internal.documentRest.initialize, args);
      data = plannedPath.test(url.pathname)
        ? await ctx.runAction(internal.documentContentNode.restRead, dispatchArgs)
        : await ctx.runQuery(internal.documentRest.dispatch, dispatchArgs);
    }
    return { data: JSON.parse(data) as unknown };
  },
);
