import { chargeDownload } from "./lib/capacityCore";
import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { exportActor, exportAllowed } from "./lib/exportAccess";
import { deny, limitOrganizationAction } from "./lib/organizationAccess";
import { recordAudit } from "./lib/operationalAudit";
import { observedAction } from "./lib/externalHttp";
import { publicError } from "./lib/publicErrors";
import { hashApiKey } from "./lib/apiKeyCrypto";

export const ticketValue = v.object({ token: v.string(), expiresAt: v.number() });
export async function issueTicket(ctx: MutationCtx, partId: Id<"exportParts">, keyHash?: string) {
  const part = await ctx.db.get("exportParts", partId);
  const job = part ? await ctx.db.get("documentExports", part.exportId) : null;
  if (!job || job.state !== "succeeded" || job.expiresAt <= Date.now()) return deny("NOT_FOUND");
  await exportActor(ctx, job, keyHash);
  await limitOrganizationAction(ctx, "export-download", job.actor, 60);
  const token = crypto.randomUUID() + crypto.randomUUID(),
    expiresAt = Math.min(Date.now() + 60_000, job.expiresAt);
  const id = await ctx.db.insert("exportTickets", {
    exportId: job._id,
    partId,
    tokenHash: await hashApiKey(token),
    expiresAt,
  });
  await ctx.scheduler.runAt(expiresAt, internal.exportDownloads.expire, { id });
  return { token, expiresAt };
}
export const ticket = mutation({
  args: { partId: v.id("exportParts") },
  returns: ticketValue,
  handler: (ctx, args) => issueTicket(ctx, args.partId),
});
export const expire = internalMutation({
  args: { id: v.id("exportTickets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get("exportTickets", args.id);
    if (ticket && ticket.expiresAt <= Date.now()) await ctx.db.delete("exportTickets", ticket._id);
    return null;
  },
});
export const authorize = internalMutation({
  args: {
    tokenHash: v.string(),
    requestId: v.optional(v.string()),
    transferKey: v.optional(v.string()),
  },
  returns: v.object({
    storageId: v.id("_storage"),
    sequence: v.number(),
    sha256: v.string(),
    size: v.number(),
  }),
  handler: async (ctx, args) => {
    const ticket = await ctx.db
      .query("exportTickets")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!ticket || ticket.expiresAt <= Date.now()) return deny("NOT_FOUND");
    const job = await ctx.db.get("documentExports", ticket.exportId);
    const part = await ctx.db.get("exportParts", ticket.partId);
    if (
      !job ||
      !part ||
      part.exportId !== job._id ||
      job.state !== "succeeded" ||
      job.expiresAt <= Date.now()
    )
      return deny("NOT_FOUND");
    await exportAllowed(ctx, job);
    // The Freecorps pays for an assisted export, download included (ADR 0009, decision 3 of
    // 30/10/2026); the archived organization's quota is not charged.
    if (args.transferKey && !job.assistedRequestId)
      await chargeDownload(ctx, job.organizationId, part.storageId, args.transferKey);
    if (args.requestId)
      await recordAudit(ctx, {
        organizationId: job.organizationId,
        actor: job.actor,
        action: "export.downloaded",
        target: part._id,
        requestId: args.requestId,
      });
    return {
      storageId: part.storageId,
      sequence: part.sequence,
      sha256: part.sha256,
      size: part.size,
    };
  },
});
// freecorps-access: ticket — o token de download é conferido por exportDownloads.authorize
export const route = observedAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");
  const allowed = origin === process.env.SITE_URL;
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
    // Server consumers need no Origin; browsers may only use the configured console.
    if ((origin && !allowed) || new URL(request.url).search) return deny("NOT_FOUND");
    const token = request.headers.get("X-Download-Token") ?? "";
    if (token.length !== 72) return deny("NOT_FOUND");
    const tokenHash = await hashApiKey(token);
    const part = await ctx.runMutation(internal.exportDownloads.authorize, {
      tokenHash,
      transferKey: crypto.randomUUID(),
    });
    const blob = await ctx.storage.get(part.storageId);
    if (!blob || blob.size !== part.size) return deny("NOT_FOUND");
    await ctx.runMutation(internal.exportDownloads.authorize, {
      tokenHash,
      requestId: request.headers.get("X-Request-Id")!,
    });
    return new Response(blob, {
      headers: {
        ...cors,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="export-${part.sequence}.jsonl.gz"`,
      },
    });
  } catch (error) {
    const result = publicError(error, "Exportação não encontrada.");
    return Response.json(
      { error: result.error, requestId: request.headers.get("X-Request-Id") },
      {
        status: result.status,
        headers: { ...cors, "Cache-Control": "no-store" },
      },
    );
  }
}, "exportDownload");
