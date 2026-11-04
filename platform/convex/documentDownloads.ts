import { chargeDownload, chargeDownloadBytes } from "./lib/capacityCore";
import { v, type Infer } from "convex/values";
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { observedAction } from "./lib/externalHttp";
import { recordAudit } from "./lib/operationalAudit";
import { internal } from "./_generated/api";
import { companyScopeFields } from "./lib/operationValues";
import { documentAccess, loadScopedDocument, type DocumentScope } from "./lib/documentCore";
import { findCompany } from "./lib/companyAccess";
import { projectAccess } from "./lib/operationAccess";
import { readTask } from "./lib/documentCore";
import { canManageProject, ensureConsoleProject, isConsoleProject } from "./lib/projectAccess";
import { deny, limitOrganizationAction } from "./lib/organizationAccess";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { publicError } from "./lib/publicErrors";
import type { Doc, Id } from "./_generated/dataModel";
import { issuanceReadTask } from "./lib/issuanceCore";
import { currentRow } from "./lib/coldArchiveCurrent";
import { auditDanfe, danfeHeaders, resolveDanfe, serveDanfe } from "./documentDanfe";
import { danfeResolution } from "./lib/danfeValues";
import {
  coldOriginalSource,
  originalBody,
  originalSourceOf,
  type ColdOriginalSource,
} from "./lib/documentOriginalRead";

export async function artifactAccess(
  ctx: QueryCtx,
  scope: DocumentScope,
  value: string,
  keyHash?: string,
) {
  await documentAccess(ctx, scope, keyHash);
  // An ID of before a rehydration resolves through the organization's map (ADR 0009, §6).
  const artifact = await currentRow(ctx, scope.organizationId, "documentArtifacts", value);
  if (
    !artifact ||
    artifact.organizationId !== scope.organizationId ||
    artifact.companyId !== scope.companyId ||
    artifact.environment !== scope.environment
  )
    return deny("NOT_FOUND");
  if (artifact.fileId) {
    const file = await ctx.db.get("importFiles", artifact.fileId);
    if (!file || file.state !== "accepted") return deny("NOT_FOUND");
  } else if (artifact.parentArtifactId) {
    const parent = await ctx.db.get("documentArtifacts", artifact.parentArtifactId);
    const file = parent?.fileId ? await ctx.db.get("importFiles", parent.fileId) : null;
    if (
      !parent ||
      parent.organizationId !== scope.organizationId ||
      parent.companyId !== scope.companyId ||
      parent.environment !== scope.environment ||
      parent.storageId !== artifact.storageId ||
      file?.state !== "accepted" ||
      !artifact.documentId
    )
      return deny("NOT_FOUND");
    await loadScopedDocument(ctx, scope, artifact.documentId);
  } else if (artifact.source !== "distribution-xml" || !artifact.processingOperationId)
    return deny("NOT_FOUND");
  return artifact;
}
/** Console ticket: the member's company access, recorded under the console project. */
async function issueTicket(
  ctx: MutationCtx,
  args: DocumentScope,
  access: NonNullable<Awaited<ReturnType<typeof documentAccess>>>,
  artifactId: Id<"documentArtifacts"> | Id<"issuanceArtifacts">,
  danfe?: true,
) {
  const projectId = await ensureConsoleProject(ctx, access.membership);
  await limitOrganizationAction(
    ctx,
    "document-download-ticket",
    `${args.organizationId}:${access.membership._id}`,
    60,
  );
  const token = crypto.randomUUID() + crypto.randomUUID(),
    expiresAt = Date.now() + 60_000;
  const id = await ctx.db.insert("documentDownloads", {
    organizationId: args.organizationId,
    companyId: args.companyId,
    projectId,
    environment: args.environment,
    artifactId,
    ...(danfe ? { danfe } : {}),
    membershipId: access.membership._id,
    accessVersion: access.accessVersion,
    // The console project has no grant; the membership and its company access carry the check.
    projectEpoch: 0,
    grantEpoch: 0,
    tokenHash: await hashApiKey(token),
    expiresAt,
  });
  await ctx.scheduler.runAfter(60_000, internal.documentDownloads.expire, { id });
  return { token, expiresAt };
}
export const ticket = mutation({
  args: { ...companyScopeFields, artifactId: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const access = (await documentAccess(ctx, args))!;
    const artifact = await artifactAccess(ctx, args, args.artifactId);
    return issueTicket(ctx, args, access, artifact._id);
  },
});
/**
 * Console ticket for the DANFE of a published NF-e 55 (#402). It names the document's XML
 * original, which proves the scope; the download renders or reuses the PDF (`documentDanfe.ts`).
 */
export const danfeTicket = mutation({
  args: { ...companyScopeFields, documentId: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const access = (await documentAccess(ctx, args))!;
    const { doc, version } = await loadScopedDocument(ctx, args, args.documentId);
    if (doc.model !== "55" || version.kind !== "invoice") return deny("DANFE_UNAVAILABLE");
    return issueTicket(ctx, args, access, version.artifactId, true);
  },
});
export const expire = internalMutation({
  args: { id: v.id("documentDownloads") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const ticket = await ctx.db.get("documentDownloads", id);
    if (ticket && ticket.expiresAt <= Date.now()) await ctx.db.delete("documentDownloads", id);
    return null;
  },
});
type Ticket = Doc<"documentDownloads">;
async function documentArtifact(ctx: QueryCtx, ticket: Ticket) {
  const id = ctx.db.normalizeId("documentArtifacts", ticket.artifactId);
  const artifact = id ? await ctx.db.get("documentArtifacts", id) : null;
  if (
    !artifact ||
    artifact.companyId !== ticket.companyId ||
    artifact.organizationId !== ticket.organizationId ||
    artifact.environment !== ticket.environment
  )
    return null;
  const file = originalSourceOf(artifact);
  if (!file) return null;
  return { id: artifact._id, file, operationId: artifact.processingOperationId };
}
/**
 * The artifact proves its issuance, and the issuance proves the ticket's scope. A console ticket
 * reads any issuance of the company, like the console itself; another project's ticket, only
 * that project's issuances.
 */
async function issuanceArtifact(
  ctx: QueryCtx,
  ticket: Ticket,
  id: Id<"issuanceArtifacts">,
  console: boolean,
) {
  const artifact = await ctx.db.get("issuanceArtifacts", id);
  const issuance = artifact ? await ctx.db.get("issuances", artifact.issuanceId) : null;
  if (
    !artifact ||
    !issuance ||
    artifact.organizationId !== ticket.organizationId ||
    issuance.organizationId !== ticket.organizationId ||
    (!console && issuance.projectId !== ticket.projectId) ||
    issuance.companyId !== ticket.companyId ||
    issuance.environment !== ticket.environment
  )
    return null;
  return {
    id: artifact._id,
    file: { storageId: artifact.storageId },
    operationId: issuance.operationId,
  };
}
/**
 * The ticket's file, checked before and after it is read. A DANFE ticket answers with the DANFE
 * resolution (`documentDanfe.resolveDanfe`) instead: `transferKey` charges a ready PDF and the
 * call with `requestId` is the recheck after reading, which also records the audit.
 */
export const authorize = internalMutation({
  args: {
    tokenHash: v.string(),
    requestId: v.optional(v.string()),
    transferKey: v.optional(v.string()),
    /** DANFE only: the step right after this request's rendering, and the file read. */
    rendered: v.optional(v.boolean()),
    served: v.optional(v.id("_storage")),
  },
  returns: v.union(
    v.object({ state: v.literal("file"), storageId: v.id("_storage") }),
    // A cold XML original (ADR 0010, decision 8), served from the bucket by the route.
    v.object({ state: v.literal("cold"), source: coldOriginalSource }),
    danfeResolution,
  ),
  handler: async (ctx, args) => {
    const ticket = await ctx.db
      .query("documentDownloads")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!ticket || ticket.expiresAt <= Date.now()) return deny("NOT_FOUND");
    const membership = await ctx.db.get("memberships", ticket.membershipId);
    if (!membership || membership.organizationId !== ticket.organizationId)
      return deny("NOT_FOUND");
    const access = await findCompany(ctx, membership, ticket.companyId);
    // Issuance XML is read under the issuance grant of the project, like the issuance itself.
    const issuanceArtifactId = ctx.db.normalizeId("issuanceArtifacts", ticket.artifactId);
    const { project, grant } = await projectAccess(ctx, {
      ...ticket,
      task: issuanceArtifactId
        ? await issuanceReadTask(ctx, ticket.projectId, ticket.companyId)
        : readTask,
    });
    if (
      !access ||
      access.accessVersion !== ticket.accessVersion ||
      project.accessEpoch !== ticket.projectEpoch ||
      grant.accessEpoch !== ticket.grantEpoch ||
      (membership.role === "developer" && !canManageProject(membership, project))
    )
      return deny("NOT_FOUND");
    const found = issuanceArtifactId
      ? await issuanceArtifact(ctx, ticket, issuanceArtifactId, isConsoleProject(project))
      : await documentArtifact(ctx, ticket);
    if (!found) return deny("NOT_FOUND");
    let result:
      | Infer<typeof danfeResolution>
      | { state: "file"; storageId: Id<"_storage"> }
      | { state: "cold"; source: ColdOriginalSource };
    if (ticket.danfe) {
      const artifact = issuanceArtifactId
        ? null
        : await ctx.db.get("documentArtifacts", found.id as Id<"documentArtifacts">);
      if (!artifact?.documentId) return deny("NOT_FOUND");
      const { doc, version } = await loadScopedDocument(ctx, ticket, artifact.documentId);
      result = await resolveDanfe(ctx, ticket, doc, version, {
        transferKey: args.transferKey,
        rendered: args.rendered,
        recheck: !!args.requestId,
      });
      if (args.requestId && result.state === "ready" && result.storageId === args.served)
        await auditDanfe(ctx, { ...ticket, actor: membership._id, requestId: args.requestId }, doc);
      return result;
    } else {
      if (args.transferKey)
        await chargeOriginal(ctx, ticket.organizationId, found.file, args.transferKey);
      result =
        "storageId" in found.file
          ? { state: "file", storageId: found.file.storageId }
          : { state: "cold", source: found.file };
    }
    if (args.requestId)
      await recordAudit(ctx, {
        ...ticket,
        actor: membership._id,
        action: "http.documentDownload",
        target: found.id,
        requestId: args.requestId,
        operationId: found.operationId,
        status: 200,
      });
    return result;
  },
});
/**
 * Charges a download of an XML original: by its stored file when hot, by the raw size when cold
 * (ADR 0010, decision 8), which is the same number of bytes either way.
 */
export async function chargeOriginal(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  file: { storageId: Id<"_storage"> } | ColdOriginalSource,
  transferKey: string,
) {
  if ("storageId" in file) await chargeDownload(ctx, organizationId, file.storageId, transferKey);
  else await chargeDownloadBytes(ctx, organizationId, file.size, transferKey);
}
export const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "application/octet-stream",
  "Content-Disposition": 'attachment; filename="original.xml"',
};
// freecorps-access: ticket — o token de download é conferido por documentDownloads.authorize
export const route = observedAction(async (ctx, request) => {
  const requestId = request.headers.get("X-Request-Id")!;
  const origin = request.headers.get("Origin"),
    allowed = origin === process.env.SITE_URL;
  const cors: Record<string, string> = allowed
    ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin" }
    : {};
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: allowed ? 204 : 403,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "X-Download-Token",
      },
    });
  try {
    if (!allowed || new URL(request.url).search) return deny("NOT_FOUND");
    const token = request.headers.get("X-Download-Token") ?? "";
    if (token.length !== 72) return deny("NOT_FOUND");
    const tokenHash = await hashApiKey(token);
    const transferKey = crypto.randomUUID();
    const first = await ctx.runMutation(internal.documentDownloads.authorize, {
      tokenHash,
      transferKey,
    });
    if (first.state !== "file" && first.state !== "cold") {
      // The first download renders the PDF inside this request (a few seconds at most).
      const { blob, name } = await serveDanfe(
        ctx,
        async (options) => {
          const step = await ctx.runMutation(internal.documentDownloads.authorize, {
            tokenHash,
            ...(options.recheck
              ? { requestId, served: options.recheck }
              : { transferKey: options.transferKey, rendered: options.rendered }),
          });
          return step.state === "file" || step.state === "cold" ? deny("NOT_FOUND") : step;
        },
        { found: first, transferKey },
      );
      return new Response(blob, { headers: { ...danfeHeaders(name), ...cors } });
    }
    const blob =
      first.state === "file"
        ? await ctx.storage.get(first.storageId)
        : await originalBody(ctx.storage, first.source);
    if (!blob) return deny("ORIGINAL_UNAVAILABLE");
    await ctx.runMutation(internal.documentDownloads.authorize, { tokenHash, requestId });
    return new Response(blob, { headers: { ...responseHeaders, ...cors } });
  } catch (error) {
    const result = publicError(error, "Documento não encontrado.");
    return Response.json(
      { error: result.error, requestId },
      { status: result.status, headers: { ...cors, "Cache-Control": "no-store" } },
    );
  }
}, "documentDownload");
