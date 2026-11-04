import { trackStoredFile, commitCapacity, reserveCapacity } from "./lib/capacityCore";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { observedAction, readLimited } from "./lib/externalHttp";
import { recordAudit } from "./lib/operationalAudit";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { deny } from "./lib/organizationAccess";
import { keyAccess, projectAccess } from "./lib/operationAccess";
import { findCompany } from "./lib/companyAccess";
import {
  IMPORT_MIME,
  MAX_IMPORT_BYTES,
  importTask,
  storageHash,
  UPLOAD_TTL,
} from "./lib/importValues";
import { publicError } from "./lib/publicErrors";
import { DOCUMENT_CONTENT_MIME } from "./lib/documentValues";
import { requirePlatformEnvironment } from "./environment";

async function tokenFile(ctx: MutationCtx, tokenHash: string) {
  const file = await ctx.db
    .query("importFiles")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (
    !file ||
    file.state !== "reserved" ||
    (file.tokenExpiresAt ?? 0) <= Date.now() ||
    file.expiresAt <= Date.now()
  )
    return deny("UPLOAD_EXPIRED");
  const batch = (await ctx.db.get("imports", file.importId))!;
  const scope = { ...batch, task: importTask };
  const { project, grant } = await projectAccess(ctx, scope);
  if (project.accessEpoch !== file.tokenProjectEpoch || grant.accessEpoch !== file.tokenGrantEpoch)
    return deny("ACCESS_REVOKED");
  if (file.tokenKeyId) {
    const key = await ctx.db.get("apiKeys", file.tokenKeyId);
    if (!key) return deny("ACCESS_REVOKED");
    await keyAccess(ctx, key.keyHash, scope);
  } else {
    const member = file.tokenMembershipId
      ? await ctx.db.get("memberships", file.tokenMembershipId)
      : null;
    if (
      !member ||
      member.organizationId !== batch.organizationId ||
      !["owner", "admin", "operator"].includes(member.role)
    )
      return deny("ACCESS_REVOKED");
    const access = await findCompany(ctx, member, batch.companyId);
    if (!access || access.accessVersion !== file.tokenAccessVersion) return deny("ACCESS_REVOKED");
  }
  await reserveCapacity(ctx, batch.organizationId, "filesBytes", `import:${file._id}`, file.size);
  return file;
}
export const inspect = internalMutation({
  args: { tokenHash: v.string() },
  returns: schema.doc("importFiles"),
  handler: (ctx, args) => tokenFile(ctx, args.tokenHash),
});
export const attach = internalMutation({
  args: { tokenHash: v.string(), storageId: v.id("_storage"), requestId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await tokenFile(ctx, args.tokenHash);
    const meta = await ctx.db.system.get("_storage", args.storageId);
    const owner = await ctx.db
      .query("importFiles")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (
      owner ||
      !meta ||
      meta.size !== file.size ||
      meta.size > MAX_IMPORT_BYTES ||
      storageHash(meta.sha256) !== file.sha256
    )
      return deny("INVALID_FILE");
    const batch = (await ctx.db.get("imports", file.importId))!;
    await trackStoredFile(ctx, batch.organizationId, args.storageId, `import:${file._id}`);
    await commitCapacity(ctx, batch.organizationId, "filesBytes", `import:${file._id}`, 0);
    await ctx.db.patch("importFiles", file._id, {
      storageId: args.storageId,
      state: "uploaded",
      uploadedAt: Date.now(),
      tokenHash: undefined,
      tokenExpiresAt: undefined,
    });
    if (args.requestId) {
      const batch = (await ctx.db.get("imports", file.importId))!;
      await recordAudit(ctx, {
        ...batch,
        actor: "upload-ticket",
        action: "http.importUpload",
        target: file._id,
        requestId: args.requestId,
        operationId: file.operationId,
        status: 200,
      });
    }
    return null;
  },
});
// freecorps-access: ticket — o token de upload é conferido por importUpload.inspect
export const route = observedAction(async (ctx, request) => {
  const requestId = request.headers.get("X-Request-Id")!;
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Request-Id": requestId,
  });
  if (origin === requirePlatformEnvironment().siteUrl) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Upload-Token");
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  let storageId: import("./_generated/dataModel").Id<"_storage"> | undefined;
  let attached = false;
  try {
    const token = request.headers.get("X-Upload-Token") ?? "";
    if (token.length !== 72) return deny("UPLOAD_EXPIRED");
    const tokenHash = await hashApiKey(token);
    const file = await ctx.runMutation(internal.importUpload.inspect, { tokenHash });
    const bytes = await readLimited(request, MAX_IMPORT_BYTES);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.length !== file.size || sha256 !== file.sha256) return deny("INVALID_FILE");
    storageId = await ctx.storage.store(new Blob([bytes], { type: IMPORT_MIME }));
    await ctx.runMutation(internal.importUpload.attach, { tokenHash, storageId, requestId });
    attached = true;
    return Response.json({ data: { uploaded: true }, requestId }, { status: 200, headers });
  } catch (error) {
    const result = publicError(error, "Arquivo não encontrado.");
    return Response.json({ error: result.error, requestId }, { status: result.status, headers });
  } finally {
    if (storageId && !attached) await ctx.storage.delete(storageId);
  }
}, "importUpload");
/** One scheduled scanner owns a monotonically advancing storage window for this deployment. */
export async function requestCleanup(ctx: MutationCtx, until: number) {
  const state = await ctx.db
    .query("importMaintenance")
    .withIndex("by_key", (q) => q.eq("key", "storage-cleanup"))
    .unique();
  const nextAt = Date.now() + UPLOAD_TTL;
  // Cover a full minute once; admitted imports must not all write the same global row.
  // Rounding upward only extends the scanner's lifetime, never advances its safe cutoff.
  const requestedUntil = Math.ceil(until / 60_000) * 60_000;
  if (state?.nextAt !== undefined && state.requestedUntil >= requestedUntil) return;
  if (state) {
    await ctx.db.patch("importMaintenance", state._id, {
      requestedUntil: Math.max(state.requestedUntil, requestedUntil),
      ...(!state.nextAt ? { nextAt } : {}),
    });
    if (state.nextAt) return;
  } else
    await ctx.db.insert("importMaintenance", {
      key: "storage-cleanup",
      lastSweptAt: Date.now() - 1,
      requestedUntil,
      nextAt,
    });
  await ctx.scheduler.runAt(nextAt, internal.importUpload.cleanup, {});
}
async function sweepPage(
  ctx: MutationCtx,
  args: { cursor: string | null; after: number; before: number },
) {
  const page = await ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) =>
      q.gt("_creationTime", args.after).lte("_creationTime", args.before),
    )
    .paginate({ cursor: args.cursor, numItems: 50 });
  for (const blob of page.page) {
    if (blob.contentType === "application/vnd.freecorps.export+gzip") {
      const part = await ctx.db
        .query("exportParts")
        .withIndex("by_storageId", (q) => q.eq("storageId", blob._id))
        .unique();
      if (!part) await ctx.storage.delete(blob._id);
      continue;
    }
    if (blob.contentType !== IMPORT_MIME && blob.contentType !== DOCUMENT_CONTENT_MIME) continue;
    // The content blob of a version (ADR 0010, B4) whose attach never committed has no holder.
    const owner =
      blob.contentType === IMPORT_MIME
        ? await ctx.db
            .query("importFiles")
            .withIndex("by_storageId", (q) => q.eq("storageId", blob._id))
            .unique()
        : await ctx.db
            .query("documentVersions")
            .withIndex("by_contentStorageId", (q) => q.eq("contentStorageId", blob._id))
            .first();
    // A file a rehydration uploaded (ADR 0009, §5) is held by its intent until the second pass
    // points its row at it; its orphans have their own collection.
    const rehydrated = await ctx.db
      .query("coldArchiveUploads")
      .withIndex("by_storageId", (q) => q.eq("storageId", blob._id))
      .first();
    if (!owner && !rehydrated) await ctx.storage.delete(blob._id);
  }
  return page;
}
export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await ctx.db
      .query("importMaintenance")
      .withIndex("by_key", (q) => q.eq("key", "storage-cleanup"))
      .unique();
    if (!state?.nextAt || state.nextAt > Date.now()) return null;
    const before = state.scanBefore ?? Math.min(Date.now() - UPLOAD_TTL, state.requestedUntil);
    const page = await sweepPage(ctx, {
      after: state.lastSweptAt,
      before,
      cursor: state.cursor ?? null,
    });
    const more = !page.isDone || before < state.requestedUntil;
    const nextAt = more ? Date.now() + (page.isDone ? UPLOAD_TTL : 0) : undefined;
    await ctx.db.patch("importMaintenance", state._id, {
      lastSweptAt: page.isDone ? before : state.lastSweptAt,
      cursor: page.isDone ? undefined : page.continueCursor,
      scanBefore: page.isDone ? undefined : before,
      nextAt,
    });
    if (nextAt !== undefined) await ctx.scheduler.runAt(nextAt, internal.importUpload.cleanup, {});
    return null;
  },
});
/** Explicit local/admin diagnostic. Normal traffic uses the coalesced cleanup above. */
export const sweep = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), before: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await sweepPage(ctx, { ...args, after: 0 });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.importUpload.sweep, {
        ...args,
        cursor: page.continueCursor,
      });
    return null;
  },
});
