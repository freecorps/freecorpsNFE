import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import schema from "./schema";
import { requireCompany } from "./lib/companyAccess";
import { deny, limitOrganizationAction, boundedPagination } from "./lib/organizationAccess";
import {
  certificateScope,
  certificateSummary as summaryValidator,
  certificateMeta,
  envelope,
} from "./lib/certificateValues";
import { certificateHead, certificateAudit, certificateSummary } from "./lib/certificateAccess";
import { resumeCompanyCapture } from "./lib/captureAttention";

export const list = query({
  args: { ...certificateScope, contextKey: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(summaryValidator),
  handler: async (ctx, args) => {
    await requireCompany(ctx, args.organizationId, args.companyId, false, {
      archived: "allowed",
    });
    const page = await ctx.db
      .query("certificates")
      .withIndex("by_companyId", (q) => q.eq("companyId", args.companyId))
      .order("desc")
      .paginate(boundedPagination(args.paginationOpts));
    return { ...page, page: page.page.map(certificateSummary) };
  },
});
export const reserve = internalMutation({
  args: certificateScope,
  returns: v.object({ id: v.id("certificates"), version: v.number() }),
  handler: async (ctx, args) => {
    const { company, user, membership } = await requireCompany(
      ctx,
      args.organizationId,
      args.companyId,
      true,
    );
    if (company.kind === "demonstration") return deny("DEMONSTRATION_READ_ONLY");
    await limitOrganizationAction(ctx, "certificate-upload", args.organizationId, 5);
    const head = await certificateHead(ctx, company._id),
      version = head?.nextVersion ?? 1;
    const now = Date.now();
    const id = await ctx.db.insert("certificates", {
      ...args,
      version,
      state: "uploading",
      uploaderId: user._id,
      membershipId: membership._id,
      membershipVersion: membership.version,
      envelopeRevision: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (head)
      await ctx.db.patch("certificateHeads", head._id, { latestId: id, nextVersion: version + 1 });
    else
      await ctx.db.insert("certificateHeads", { ...args, latestId: id, nextVersion: version + 1 });
    await certificateAudit(
      ctx,
      (await ctx.db.get("certificates", id))!,
      "upload",
      "reserved",
      user._id,
    );
    await ctx.scheduler.runAfter(5 * 60_000, internal.certificates.abandon, { id });
    return { id, version };
  },
});
export const save = internalMutation({
  args: { id: v.id("certificates"), envelope },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cert = await ctx.db.get("certificates", args.id);
    if (!cert) return deny();
    const { membership, user } = await requireCompany(
      ctx,
      cert.organizationId,
      cert.companyId,
      true,
    );
    if (
      cert.state !== "uploading" ||
      cert.uploaderId !== user._id ||
      cert.membershipVersion !== membership.version
    )
      return deny("CERTIFICATE_CHANGED");
    await ctx.db.patch("certificates", cert._id, {
      envelope: args.envelope,
      state: "validating",
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.certificateWorker.validate, { id: cert._id });
    return null;
  },
});
export const encrypted = internalQuery({
  args: { id: v.id("certificates") },
  returns: v.union(schema.doc("certificates"), v.null()),
  handler: (ctx, args) => ctx.db.get("certificates", args.id),
});
export const validationCompany = internalQuery({
  args: { companyId: v.id("companies") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await ctx.db.get("companies", args.companyId))?.cnpj ?? null,
});
export const finish = internalMutation({
  args: {
    id: v.id("certificates"),
    metadata: v.optional(certificateMeta),
    code: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cert = await ctx.db.get("certificates", args.id);
    if (!cert || cert.state !== "validating") return null;
    const head = await certificateHead(ctx, cert.companyId);
    const member = await ctx.db.get("memberships", cert.membershipId);
    let code = args.code;
    if (
      !member ||
      member.state !== "active" ||
      member.version !== cert.membershipVersion ||
      member.organizationId !== cert.organizationId ||
      !["owner", "admin"].includes(member.role)
    )
      code = "ACCESS_REVOKED";
    if (head?.latestId !== cert._id) code = "CERTIFICATE_SUPERSEDED";
    if (args.metadata && args.metadata.notAfter <= Date.now()) code = "CERTIFICATE_EXPIRED";
    if (code || !args.metadata || !head) {
      await ctx.db.patch("certificates", cert._id, {
        state: "rejected",
        code: code ?? "CERTIFICATE_INVALID",
        envelope: undefined,
        updatedAt: Date.now(),
      });
      await certificateAudit(
        ctx,
        cert,
        "validation",
        code ?? "CERTIFICATE_INVALID",
        cert.uploaderId,
      );
      return null;
    }
    if (head.activeId) {
      const previous = await ctx.db.get("certificates", head.activeId);
      if (previous?.state === "active") {
        await ctx.db.patch("certificates", previous._id, {
          state: "replaced",
          updatedAt: Date.now(),
        });
        await certificateAudit(ctx, previous, "rotation", "replaced", cert.uploaderId);
      }
    }
    await ctx.db.patch("certificates", cert._id, {
      state: "active",
      metadata: args.metadata,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("certificateHeads", head._id, { activeId: cert._id });
    await ctx.scheduler.runAt(args.metadata.notAfter, internal.certificates.expire, {
      id: cert._id,
    });
    await certificateAudit(ctx, cert, "validation", "active", cert.uploaderId);
    // A production capture that stopped for want of a usable A1 is checked again with this one.
    await resumeCompanyCapture(ctx, cert.companyId, ["CERTIFICATE_UNAVAILABLE"]);
    return null;
  },
});
export const abandon = internalMutation({
  args: {
    id: v.id("certificates"),
    code: v.optional(
      v.union(
        v.literal("CERTIFICATE_SIZE"),
        v.literal("CERTIFICATE_UPLOAD_FAILED"),
        v.literal("CERTIFICATE_KEY_UNAVAILABLE"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cert = await ctx.db.get("certificates", args.id);
    if (cert && ["uploading", "validating"].includes(cert.state)) {
      await ctx.db.patch("certificates", cert._id, {
        state: "rejected",
        code: args.code ?? "CERTIFICATE_UPLOAD_TIMEOUT",
        envelope: undefined,
        updatedAt: Date.now(),
      });
      await certificateAudit(ctx, cert, "validation", args.code ?? "CERTIFICATE_UPLOAD_TIMEOUT");
    }
    return null;
  },
});
export const expire = internalMutation({
  args: { id: v.id("certificates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cert = await ctx.db.get("certificates", args.id);
    if (cert?.state === "active" && cert.metadata && cert.metadata.notAfter <= Date.now()) {
      await ctx.db.patch("certificates", cert._id, { state: "expired", updatedAt: Date.now() });
      const head = await certificateHead(ctx, cert.companyId);
      if (head?.activeId === cert._id)
        await ctx.db.patch("certificateHeads", head._id, { activeId: undefined });
      await certificateAudit(ctx, cert, "expiration", "expired");
    }
    return null;
  },
});
export const revoke = mutation({
  args: { ...certificateScope, id: v.id("certificates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireCompany(ctx, args.organizationId, args.companyId, true, {
      archived: "allowed",
    });
    const cert = await ctx.db.get("certificates", args.id);
    if (!cert || cert.organizationId !== args.organizationId || cert.companyId !== args.companyId)
      return deny();
    if (cert.state === "revoked") return null;
    const head = await certificateHead(ctx, cert.companyId);
    if (head?.activeId === cert._id)
      await ctx.db.patch("certificateHeads", head._id, { activeId: undefined });
    await ctx.db.patch("certificates", cert._id, {
      state: "revoked",
      envelope: undefined,
      updatedAt: Date.now(),
    });
    await certificateAudit(ctx, cert, "revocation", "revoked", user._id);
    return null;
  },
});
export const authorizeRewrap = internalQuery({
  args: { ...certificateScope, id: v.id("certificates") },
  returns: schema.doc("certificates"),
  handler: async (ctx, args) => {
    await requireCompany(ctx, args.organizationId, args.companyId, true);
    const cert = await ctx.db.get("certificates", args.id);
    if (
      !cert?.envelope ||
      cert.organizationId !== args.organizationId ||
      cert.companyId !== args.companyId
    )
      return deny();
    return cert;
  },
});
export const saveRewrap = internalMutation({
  args: { id: v.id("certificates"), revision: v.number(), envelope },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cert = await ctx.db.get("certificates", args.id);
    if (!cert) return deny();
    const { user } = await requireCompany(ctx, cert.organizationId, cert.companyId, true);
    if (!cert.envelope || cert.envelopeRevision !== args.revision)
      return deny("CERTIFICATE_CHANGED");
    await ctx.db.patch("certificates", cert._id, {
      envelope: args.envelope,
      envelopeRevision: cert.envelopeRevision + 1,
      updatedAt: Date.now(),
    });
    await certificateAudit(
      ctx,
      { ...cert, envelope: args.envelope },
      "key_rotation",
      "rewrapped",
      user._id,
    );
    return null;
  },
});
