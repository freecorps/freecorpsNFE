import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { jsonRoute } from "./lib/externalHttp";
import { authenticateKey } from "./lib/operationAccess";
import { exportActor, summarizeExport, summarizePart } from "./lib/exportAccess";
import { createExport } from "./exports";
import { issueTicket } from "./exportDownloads";
import { deny } from "./lib/organizationAccess";
import { parseRequest } from "@freecorps/contracts/external";
import { recordAudit } from "./lib/operationalAudit";
import { currentRow } from "./lib/coldArchiveCurrent";

export const dispatch = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    method: v.string(),
    url: v.string(),
    body: v.string(),
    key: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    if (args.environment !== key.environment) return deny("ENVIRONMENT_DENIED");
    const url = new URL(args.url);
    const request = parseRequest(args.method, url, JSON.parse(args.body));
    if (!request) return deny("NOT_FOUND");
    if (args.method === "POST" && url.pathname === "/v1/exports") {
      const body = JSON.parse(args.body) as { companyId: string; documentId: string };
      const companyId = ctx.db.normalizeId("companies", body.companyId);
      // The export keeps the current ID: a rehydration rewrites `selection.documentId` (ADR 0009,
      // §5), so the old ID of a repetition resolves to the same selection as the export it repeats.
      const documentId =
        (await currentRow(ctx, key.organizationId, "fiscalDocuments", body.documentId))?._id ??
        ctx.db.normalizeId("fiscalDocuments", body.documentId);
      if (!companyId || !documentId) return deny("NOT_FOUND");
      return JSON.stringify(
        await createExport(
          ctx,
          {
            organizationId: key.organizationId,
            selection: { kind: "document", companyId, documentId, projectId: key.projectId },
            key: args.key,
            environment: key.environment,
          },
          args.keyHash,
        ),
      );
    }
    const partRef = /^\/v1\/export-parts\/([^/]+)\/ticket$/.exec(url.pathname)?.[1];
    if (partRef) {
      const partId = ctx.db.normalizeId("exportParts", partRef);
      if (!partId) return deny("NOT_FOUND");
      return JSON.stringify(await issueTicket(ctx, partId, args.keyHash));
    }
    const match = /^\/v1\/exports\/([^/]+)(?:\/(parts|revoke))?$/.exec(url.pathname);
    const exportRef = match?.[1];
    const id = exportRef ? ctx.db.normalizeId("documentExports", exportRef) : null;
    const job = id ? await ctx.db.get("documentExports", id) : null;
    if (!job) return deny("NOT_FOUND");
    await exportActor(ctx, job, args.keyHash);
    if (match?.[2] === "revoke") {
      await ctx.db.patch("documentExports", job._id, { state: "revoked" });
      await recordAudit(ctx, {
        organizationId: job.organizationId,
        actor: job.actor,
        action: "export.revoked",
        target: job._id,
      });
      await ctx.scheduler.runAfter(0, internal.exports.expire, { exportId: job._id });
      return JSON.stringify(summarizeExport({ ...job, state: "revoked" }, Date.now()));
    }
    if (match![2] === "parts") {
      if (job.state !== "succeeded" || job.expiresAt <= Date.now()) return deny("NOT_FOUND");
      const page = await ctx.db
        .query("exportParts")
        .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job._id))
        .paginate({
          cursor: url.searchParams.get("cursor"),
          numItems: Number(url.searchParams.get("limit") ?? 20),
          maximumRowsRead: 50,
        });
      return JSON.stringify({
        page: page.page.map(summarizePart),
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    }
    return JSON.stringify(summarizeExport(job, Date.now()));
  },
});
export const route = jsonRoute({ notFound: "Exportação não encontrada." }, async (input) => {
  const result = await input.ctx.runMutation(internal.exportRest.dispatch, {
    keyHash: input.keyHash,
    environment: input.environment,
    method: input.request.method,
    url: input.request.url,
    body: JSON.stringify(input.body),
    key: input.idempotencyKey,
  });
  return { data: JSON.parse(result) as unknown };
});
