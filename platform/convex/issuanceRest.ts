import { v } from "convex/values";
import type { RequestOf } from "@freecorps/contracts/external";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { jsonRoute } from "./lib/externalHttp";
import { authenticateKey } from "./lib/operationAccess";
import { deny } from "./lib/organizationAccess";
import { listIssuancePage, requestCancellation, requestIssuance } from "./issuance";
import {
  issuanceAccess,
  issuanceView,
  scopedIssuance,
  type IssuanceScope,
} from "./lib/issuanceCore";
import {
  cancelReason,
  issuanceInput,
  type IssuanceInput,
  type IssuanceView,
} from "./lib/issuanceValues";
import { currentRow } from "./lib/coldArchiveCurrent";
import { chargeDownload } from "./lib/capacityCore";

/**
 * Public REST of the NFS-e issuance (ADR 0004, phase 2): `/v1/issuances`. The API key gives the
 * organization, project and environment; `companyId` is a selector checked by `issuanceAccess`
 * (key scope, environment, company in the key, active project grant). Answers mirror the persisted
 * state: `processing` is not success, and the client follows the issuance or its webhooks.
 */

type IssuanceRequest = RequestOf<"createIssuance">["body"];

const keyFields = { keyHash: v.string(), environment: v.string(), company: v.string() };
const states = ["processing", "authorized", "rejected", "cancelled"] as const;

async function keyScope(
  ctx: QueryCtx,
  args: { keyHash: string; environment: string; company: string },
): Promise<IssuanceScope> {
  const key = await authenticateKey(ctx, args.keyHash);
  if (key.environment !== args.environment) return deny("ENVIRONMENT_DENIED");
  const companyId = ctx.db.normalizeId("companies", args.company);
  if (!companyId) return deny("NOT_FOUND");
  return {
    organizationId: key.organizationId,
    projectId: key.projectId,
    companyId,
    environment: key.environment,
  };
}
const idempotencyKey = (key: string) =>
  /^[\x21-\x7e]{1,128}$/.test(key) ? key : deny("INVALID_REQUEST");

/** Public DTO: no organization id, and no link to a document outside `documents/1` yet. */
function publicIssuance(view: IssuanceView) {
  const { organizationId: _organization, documentId: _document, ...rest } = view;
  return rest;
}
const accepted = (result: { reused: boolean; issuance: IssuanceView }) =>
  JSON.stringify({ reused: result.reused, issuance: publicIssuance(result.issuance) });

export const issue = internalMutation({
  args: { ...keyFields, key: v.string(), input: issuanceInput },
  returns: v.string(),
  handler: async (ctx, args) => {
    const scope = await keyScope(ctx, args);
    return accepted(
      await requestIssuance(ctx, scope, idempotencyKey(args.key), args.input, args.keyHash),
    );
  },
});

export const cancel = internalMutation({
  args: {
    ...keyFields,
    key: v.string(),
    issuanceId: v.string(),
    reasonCode: cancelReason,
    reason: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const scope = await keyScope(ctx, args);
    return accepted(
      await requestCancellation(
        ctx,
        scope,
        idempotencyKey(args.key),
        { issuanceId: args.issuanceId, reasonCode: args.reasonCode, reason: args.reason },
        args.keyHash,
      ),
    );
  },
});

export const read = internalQuery({
  args: {
    ...keyFields,
    issuanceId: v.union(v.string(), v.null()),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    state: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const scope = await keyScope(ctx, args);
    if (args.issuanceId !== null) {
      await issuanceAccess(ctx, scope, "read", args.keyHash);
      const view = await issuanceView(ctx, await scopedIssuance(ctx, scope, args.issuanceId));
      return JSON.stringify(publicIssuance(view));
    }
    const state = args.state;
    if (state !== null && !(states as readonly string[]).includes(state))
      return deny("INVALID_REQUEST");
    const result = await listIssuancePage(
      ctx,
      scope,
      {
        cursor: args.cursor,
        limit: args.limit,
        ...(state ? { state: state as IssuanceView["state"] } : {}),
      },
      args.keyHash,
    );
    return JSON.stringify({ page: result.page.map(publicIssuance), nextCursor: result.nextCursor });
  },
});

/**
 * Authorizes one preserved artifact (XML or DANFSe PDF) of the issuance. A mutation, so the key expiry is checked against
 * the clock on every download; the route calls it again after reading the bytes. With `transferKey`, the first call
 * charges the file to the organization's download bytes, like the other downloads, before any byte is served.
 */
export const artifact = internalMutation({
  args: {
    ...keyFields,
    issuanceId: v.string(),
    artifactId: v.string(),
    transferKey: v.optional(v.string()),
  },
  returns: v.object({ storageId: v.id("_storage"), kind: v.string() }),
  handler: async (ctx, args) => {
    const scope = await keyScope(ctx, args);
    await issuanceAccess(ctx, scope, "read", args.keyHash);
    const issuance = await scopedIssuance(ctx, scope, args.issuanceId);
    const row = await currentRow(ctx, scope.organizationId, "issuanceArtifacts", args.artifactId);
    if (!row || row.issuanceId !== issuance._id || row.organizationId !== scope.organizationId)
      return deny("NOT_FOUND");
    if (args.transferKey)
      await chargeDownload(ctx, scope.organizationId, row.storageId, args.transferKey);
    return { storageId: row.storageId, kind: row.kind };
  },
});

function decoded(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return deny("INVALID_REQUEST");
  }
}
function only(url: URL, allowed: string[], required: string[]) {
  for (const name of url.searchParams.keys())
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1)
      deny("INVALID_REQUEST");
  for (const name of required) if (!url.searchParams.has(name)) deny("INVALID_REQUEST");
}

export const route = jsonRoute(
  { notFound: "Emissão não encontrada." },
  async ({ ctx, request, url, requestId, route, ...input }) => {
    if (request.url.length > 8192) return deny("INVALID_REQUEST");
    const base = { keyHash: input.keyHash, environment: input.environment };
    const key = input.idempotencyKey;

    if (request.method === "POST") {
      if (url.search || !route) return deny("NOT_FOUND");
      if (route.name === "createIssuance") {
        // The contract already parsed the body with `issuanceRequest`.
        const { companyId, ...issuance } = route.value.body as IssuanceRequest;
        const data = JSON.parse(
          await ctx.runMutation(internal.issuanceRest.issue, {
            ...base,
            company: companyId,
            key,
            // The wire schema already bounds `nifAbsence` to 1 or 2; the validator checks it again.
            input: issuance as IssuanceInput,
          }),
        ) as { issuance: { id: string } };
        return { data, status: 202, headers: { Location: `/v1/issuances/${data.issuance.id}` } };
      }
      const { path, body } = route.value as {
        path: { issuanceId: string };
        body: { companyId: string; reasonCode: "1" | "2" | "9"; reason: string };
      };
      const data = await ctx.runMutation(internal.issuanceRest.cancel, {
        ...base,
        company: body.companyId,
        key,
        issuanceId: path.issuanceId,
        reasonCode: body.reasonCode,
        reason: body.reason,
      });
      return { data: JSON.parse(data) as unknown, status: 202 };
    }

    const download = /^\/v1\/issuances\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (download) {
      only(url, ["companyId"], ["companyId"]);
      const args = {
        ...base,
        company: url.searchParams.get("companyId")!,
        issuanceId: decoded(download[1]!),
        artifactId: decoded(download[2]!),
      };
      const found = await ctx.runMutation(internal.issuanceRest.artifact, {
        ...args,
        transferKey: crypto.randomUUID(),
      });
      const blob = await ctx.storage.get(found.storageId);
      if (!blob) return deny("ORIGINAL_UNAVAILABLE");
      // Access may have been revoked while the bytes were read.
      await ctx.runMutation(internal.issuanceRest.artifact, args);
      return new Response(blob, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${found.kind}.${found.kind === "danfse" ? "pdf" : "xml"}"`,
          "X-Request-Id": requestId,
        },
      });
    }

    if (route?.name !== "listIssuances" && route?.name !== "getIssuance") return deny("NOT_FOUND");
    const limitText = url.searchParams.get("limit") ?? "20";
    if (!/^\d{1,2}$/.test(limitText)) return deny("INVALID_PAGINATION");
    // The key's expiry was checked against the clock at admission (`observedAction`).
    const data = await ctx.runQuery(internal.issuanceRest.read, {
      ...base,
      company: url.searchParams.get("companyId")!,
      issuanceId:
        route.name === "getIssuance"
          ? (route.value.path as { issuanceId: string }).issuanceId
          : null,
      cursor: url.searchParams.get("cursor"),
      limit: Number(limitText),
      state: url.searchParams.get("state"),
    });
    return { data: JSON.parse(data) as unknown };
  },
);
