import { jsonRoute } from "./lib/externalHttp";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authenticateKey } from "./lib/operationAccess";
import { importAccess, importSummaryPlan } from "./lib/importCore";
import { reserveImport, uploadTicket, confirmFile } from "./imports";
import { deny } from "./lib/organizationAccess";
import { reprocessArtifact } from "./importProcessing";
import { historyPlan } from "./importHistory";
import { retryImportAdmission } from "./lib/importAdmission";
import { currentRow } from "./lib/coldArchiveCurrent";

export const dispatch = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    path: v.string(),
    method: v.string(),
    key: v.string(),
    body: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    if (args.environment !== key.environment) return deny("ENVIRONMENT_DENIED");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(args.body) as Record<string, unknown>;
    } catch {
      return deny("INVALID_REQUEST");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return deny("INVALID_REQUEST");
    if (args.path === "/v1/imports" && args.method === "POST") {
      if (
        Object.keys(body).sort().join(",") !== "companyId,files" ||
        typeof body.companyId !== "string" ||
        !Array.isArray(body.files)
      )
        return deny("INVALID_REQUEST");
      const companyId = ctx.db.normalizeId("companies", body.companyId);
      if (!companyId) return deny("NOT_FOUND");
      const files = body.files.map((file: unknown) => {
        if (
          !file ||
          typeof file !== "object" ||
          Object.keys(file).sort().join(",") !== "name,sha256,size" ||
          !("name" in file) ||
          typeof file.name !== "string" ||
          !("size" in file) ||
          typeof file.size !== "number" ||
          !("sha256" in file) ||
          typeof file.sha256 !== "string"
        )
          return deny("INVALID_FILE");
        return { name: file.name, size: file.size, sha256: file.sha256 };
      });
      return JSON.stringify(
        await reserveImport(
          ctx,
          {
            organizationId: key.organizationId,
            projectId: key.projectId,
            companyId,
            environment: key.environment,
            key: args.key,
            files,
          },
          args.keyHash,
        ),
      );
    }
    if (Object.keys(body).length) return deny("INVALID_REQUEST");
    const match =
      /^\/v1\/imports\/([^/]+)(?:\/files\/([^/]+)\/(upload|confirm|reprocess|history))?$/.exec(
        args.path,
      );
    // IDs of before a rehydration resolve through the key organization's map (ADR 0009, §6);
    // `importAccess` and the file's batch still prove the scope of the rows found.
    const batch = match ? await currentRow(ctx, key.organizationId, "imports", match[1]!) : null;
    if (!match || !batch) return deny("NOT_FOUND");
    await importAccess(ctx, batch, args.keyHash, args.method === "POST");
    // GET goes to `read` through the Node reader (`documentContentNode.importRead`).
    if (!match[2] || args.method !== "POST" || match[3] === "history") return deny("NOT_FOUND");
    const file = await currentRow(ctx, key.organizationId, "importFiles", match[2]);
    if (!file || file.importId !== batch._id) return deny("NOT_FOUND");
    if (match[3] === "upload")
      return JSON.stringify(await uploadTicket(ctx, file._id, args.keyHash));
    if (match[3] === "reprocess")
      return JSON.stringify(await reprocessArtifact(ctx, file._id, args.key, args.keyHash));
    return JSON.stringify(await confirmFile(ctx, file._id, args.keyHash));
  },
});
/**
 * The GET routes, read-only: the batch summary and a file's history. Both answer with a content
 * plan (`lib/documentContentPlan.ts`), since each `result` is the content of a version.
 */
export const read = internalQuery({
  args: { keyHash: v.string(), environment: v.string(), path: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    if (args.environment !== key.environment) return deny("ENVIRONMENT_DENIED");
    const match = /^\/v1\/imports\/([^/]+)(?:\/files\/([^/]+)\/history)?$/.exec(args.path);
    const batch = match ? await currentRow(ctx, key.organizationId, "imports", match[1]!) : null;
    if (!match || !batch) return deny("NOT_FOUND");
    await importAccess(ctx, batch, args.keyHash, false);
    if (!match[2]) return JSON.stringify({ $plan: await importSummaryPlan(ctx, batch) });
    const file = await currentRow(ctx, key.organizationId, "importFiles", match[2]);
    if (!file || file.importId !== batch._id) return deny("NOT_FOUND");
    return JSON.stringify({ $plan: await historyPlan(ctx, file._id, args.keyHash) });
  },
});
export const route = jsonRoute(
  { notFound: "Importação ou arquivo não encontrado." },
  async (input) => {
    if (input.url.search) return deny("INVALID_REQUEST");
    if (!input.route) return deny("NOT_FOUND");
    const dispatchArgs = {
      keyHash: input.keyHash,
      environment: input.environment,
      path: input.url.pathname,
      method: input.request.method,
      key: input.idempotencyKey,
      body: JSON.stringify(input.body),
    };
    if (input.request.method === "GET") {
      const body: unknown = input.body;
      if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
        return deny("INVALID_REQUEST");
      const data = await input.ctx.runAction(internal.documentContentNode.importRead, {
        keyHash: input.keyHash,
        environment: input.environment,
        path: input.url.pathname,
      });
      return { data: JSON.parse(data) as unknown };
    }
    const dispatch = () => input.ctx.runMutation(internal.importRest.dispatch, dispatchArgs);
    const data =
      input.route.name === "reserveImport"
        ? await retryImportAdmission(dispatch)
        : await dispatch();
    return { data: JSON.parse(data) as unknown };
  },
);
