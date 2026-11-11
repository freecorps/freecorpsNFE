import {
  reserveCapacity,
  commitCapacity,
  releaseCapacity,
  trackStoredFile,
  releaseStoredFile,
  ensureCapacityReady,
} from "./lib/capacityCore";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { exportSelection, exportSummary, partSummary } from "./lib/exportSchema";
import { exportActor, exportAllowed, summarizeExport, summarizePart } from "./lib/exportAccess";
import {
  deny,
  requireMembership,
  requireManager,
  limitOrganizationAction,
  boundedPagination,
} from "./lib/organizationAccess";
import { documentAccess, loadDocument } from "./lib/documentCore";
import { authenticateKey } from "./lib/operationAccess";
import { ensureConsoleProject, isConsoleProject } from "./lib/projectAccess";
import { recordAudit, DAY } from "./lib/operationalAudit";
import { requestCleanup } from "./lib/importCore";
import { environment } from "./lib/projectValues";
import {
  baseEnvironment,
  organizationEnvironmentServed,
  type ProductEnvironment,
} from "./lib/environmentAccess";

const pool = new Workpool(components.exportPool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
});
export const stepArgs = { exportId: v.id("documentExports"), sequence: v.number() };
export async function enqueue(ctx: MutationCtx, exportId: Id<"documentExports">, sequence: number) {
  await pool.enqueueAction(
    ctx,
    internal.exportWorker.run,
    { exportId, sequence },
    {
      retry: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
      onComplete: internal.exports.completed,
      context: { exportId, sequence },
    },
  );
}
export async function createExport(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    selection: Infer<typeof exportSelection>;
    key: string;
    environment: ProductEnvironment;
  },
  keyHash?: string,
) {
  if (!/^[\x21-\x7e]{1,128}$/.test(args.key)) return deny("INVALID_REQUEST");
  const { member, key } = keyHash
    ? { member: null, key: await authenticateKey(ctx, keyHash) }
    : {
        member: (await requireMembership(ctx, args.organizationId, { closed: "export" }))
          .membership,
        key: null,
      };
  const environment = args.environment;
  let epochs: { accessVersion?: string; projectEpoch?: number; grantEpoch?: number } = {};
  if (args.selection.kind === "organization") {
    if (!member) return deny("SCOPE_DENIED");
    requireManager(member);
    if (
      !(await organizationEnvironmentServed(
        ctx,
        args.organizationId,
        environment,
        "documents:read",
      ))
    )
      return deny("ENVIRONMENT_DENIED");
  } else {
    const scope = { ...args.selection, organizationId: args.organizationId, environment };
    await loadDocument(ctx, scope, args.selection.documentId, keyHash);
    const access = await documentAccess(ctx, scope, keyHash);
    if (access) {
      // A member exports under the console project, which has no grant: its company access counts.
      const project = await ctx.db.get("projects", scope.projectId);
      if (!project || !isConsoleProject(project)) return deny("NOT_FOUND");
      epochs = {
        projectEpoch: project.accessEpoch,
        grantEpoch: 0,
        accessVersion: access.accessVersion,
      };
    } else {
      const project = await ctx.db.get("projects", scope.projectId);
      const grant = await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
        )
        .unique();
      epochs = { projectEpoch: project!.accessEpoch, grantEpoch: grant!.accessEpoch };
    }
  }
  const actor = member ? `member:${member._id}` : `key:${key!._id}`;
  const prior = await ctx.db
    .query("documentExports")
    .withIndex("by_organizationId_and_actor_and_key", (q) =>
      q.eq("organizationId", args.organizationId).eq("actor", actor).eq("key", args.key),
    )
    .unique();
  if (prior) {
    await exportActor(ctx, prior, keyHash);
    // Validators normalize the selection's shape; compare its fields, not object insertion order.
    if (
      prior.selection.kind !== args.selection.kind ||
      prior.environment !== environment ||
      (prior.selection.kind === "document" &&
        args.selection.kind === "document" &&
        (prior.selection.documentId !== args.selection.documentId ||
          prior.selection.companyId !== args.selection.companyId ||
          prior.selection.projectId !== args.selection.projectId))
    )
      return deny("IDEMPOTENCY_CONFLICT");
    return summarizeExport(prior, Date.now());
  }
  await limitOrganizationAction(ctx, "export", args.organizationId, 2);
  const running = await ctx.db
    .query("documentExports")
    .withIndex("by_organizationId_and_state", (q) =>
      q.eq("organizationId", args.organizationId).eq("state", "running"),
    )
    .take(2);
  if (running.length >= 2) return deny("RATE_LIMITED");
  await ensureCapacityReady(ctx, args.organizationId);
  const now = Date.now();
  const id = await ctx.db.insert("documentExports", {
    ...args,
    ...epochs,
    environment,
    actor,
    ...(member
      ? { membershipId: member._id, membershipVersion: member.version }
      : { keyId: key!._id }),
    state: "running",
    checkpoint: JSON.stringify({ phase: "documents", cursor: null, pagination: "keyset-v1" }),
    sequence: 0,
    bytes: 0,
    createdAt: now,
    expiresAt: now + DAY,
  });
  await reserveCapacity(ctx, args.organizationId, "exportsCount", `export:${id}`, 1);
  await recordAudit(ctx, {
    organizationId: args.organizationId,
    actor,
    action: "export.requested",
    target: id,
  });
  await enqueue(ctx, id, 0);
  const expireJobId = await ctx.scheduler.runAt(now + DAY, internal.exports.expire, {
    exportId: id,
  });
  await ctx.db.patch("documentExports", id, { expireJobId });
  await requestCleanup(ctx, now + DAY + 3_600_000);
  return summarizeExport((await ctx.db.get("documentExports", id))!, Date.now());
}
/**
 * Console: a document export belongs to the organization's console project. The environment is
 * the document's (Produção only for a company with the fiscal capture, ADR 0007); without it,
 * the deployment's base environment.
 */
export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    environment: v.optional(environment),
    selection: v.union(
      v.object({ kind: v.literal("organization") }),
      v.object({
        kind: v.literal("document"),
        documentId: v.id("fiscalDocuments"),
        companyId: v.id("companies"),
      }),
    ),
    key: v.string(),
  },
  returns: exportSummary,
  handler: async (ctx, { selection, environment, ...rest }) => {
    const args = { ...rest, environment: environment ?? baseEnvironment() };
    if (selection.kind === "organization") return createExport(ctx, { ...args, selection });
    const { membership } = await requireMembership(ctx, args.organizationId);
    const projectId = await ensureConsoleProject(ctx, membership);
    return createExport(ctx, { ...args, selection: { ...selection, projectId } });
  },
});
/**
 * Console: the environments an organization export may cover, for a manager. Produção appears
 * on the hosted site once a company released the fiscal capture (ADR 0007).
 */
export const environments = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(environment),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      closed: "export",
      // The assisted export of an archived organization is delivered on this page (ADR 0009, §7).
      archived: "allowed",
    });
    requireManager(membership);
    const base = baseEnvironment();
    const other = base === "sandbox" ? ("production" as const) : ("sandbox" as const);
    return (await organizationEnvironmentServed(ctx, args.organizationId, other, "documents:read"))
      ? [base, other]
      : [base];
  },
});
/** Readable scope for the console list. Read only after `exportAllowed` passed for the job. */
const exportDescription = v.union(
  v.null(),
  v.object({
    companyName: v.string(),
    model: v.union(v.literal("55"), v.literal("nfse")),
    fiscalKey: v.string(),
  }),
);
async function describeExport(ctx: QueryCtx, job: Doc<"documentExports">) {
  if (job.selection.kind !== "document") return null;
  const [company, document] = await Promise.all([
    ctx.db.get("companies", job.selection.companyId),
    ctx.db.get("fiscalDocuments", job.selection.documentId),
  ]);
  if (
    company?.organizationId !== job.organizationId ||
    document?.organizationId !== job.organizationId ||
    document.companyId !== company._id
  )
    return null;
  return { companyName: company.name, model: document.model, fiscalKey: document.fiscalKey };
}
export const list = query({
  args: { organizationId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(exportSummary.extend({ description: exportDescription })),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      closed: "export",
      archived: "allowed",
    });
    const result = await ctx.db
      .query("documentExports")
      .withIndex("by_organizationId_and_actor", (q) =>
        q.eq("organizationId", args.organizationId).eq("actor", `member:${membership._id}`),
      )
      .order("desc")
      .paginate(boundedPagination(args.paginationOpts));
    // Keep only exports whose original authorization still holds. No private metadata survives revocation.
    const page = [];
    for (const job of result.page) {
      try {
        await exportAllowed(ctx, job);
        page.push({ ...summarizeExport(job, null), description: await describeExport(ctx, job) });
      } catch {
        /* fail closed */
      }
    }
    return { ...result, page };
  },
});
export const parts = query({
  args: { exportId: v.id("documentExports"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(partSummary),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    if (!job) return deny("NOT_FOUND");
    await exportActor(ctx, job);
    // `exports.expire` turns the job `expired` at `expiresAt`; a query never reads the clock (#45).
    if (job.state !== "succeeded") return deny("NOT_FOUND");
    const result = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job._id))
      .paginate(boundedPagination(args.paginationOpts));
    return { ...result, page: result.page.map(summarizePart) };
  },
});
export const revoke = mutation({
  args: { exportId: v.id("documentExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    if (!job) return deny("NOT_FOUND");
    await exportActor(ctx, job);
    await ctx.db.patch("documentExports", job._id, { state: "revoked" });
    await recordAudit(ctx, {
      organizationId: job.organizationId,
      actor: job.actor,
      action: "export.revoked",
      target: job._id,
    });
    await ctx.scheduler.runAfter(0, internal.exports.expire, args);
    return null;
  },
});
export const commit = internalMutation({
  args: {
    ...stepArgs,
    checkpoint: v.string(),
    done: v.boolean(),
    part: v.optional(
      v.object({ storageId: v.id("_storage"), sha256: v.string(), size: v.number() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    const discard = async () => {
      if (args.part) {
        const linked = await ctx.db
          .query("exportParts")
          .withIndex("by_storageId", (q) => q.eq("storageId", args.part!.storageId))
          .unique();
        if (!linked) await ctx.storage.delete(args.part.storageId);
      }
      return null;
    };
    if (
      !job ||
      job.sequence !== args.sequence ||
      job.state !== "running" ||
      job.expiresAt <= Date.now()
    )
      return discard();
    try {
      await exportAllowed(ctx, job);
    } catch {
      await ctx.db.patch("documentExports", job._id, { state: "failed", code: "ACCESS_REVOKED" });
      await discard();
      await ctx.scheduler.runAfter(0, internal.exports.expire, { exportId: job._id });
      return null;
    }
    if (job.sequence >= 10_000 || job.bytes + (args.part?.size ?? 0) > 2 * 1024 ** 3) {
      await ctx.db.patch("documentExports", job._id, {
        state: "failed",
        code: "EXPORT_LIMIT_EXCEEDED",
      });
      await discard();
      await ctx.scheduler.runAfter(0, internal.exports.expire, { exportId: job._id });
      return null;
    }
    // In the isolated destination of an assisted export (ADR 0009, §7) the organization has no
    // capacity, audit nor Workpool: the operator drives each step and publishes the parts in the
    // origin, where the Freecorps pays for them.
    const assisted = !!job.assisted;
    if (args.part && assisted)
      await ctx.db.insert("exportParts", {
        ...args.part,
        exportId: job._id,
        sequence: job.sequence,
      });
    else if (args.part) {
      await trackStoredFile(
        ctx,
        job.organizationId,
        args.part.storageId,
        `export:${job._id}:${args.sequence}`,
        { temporary: true },
      );
      await commitCapacity(
        ctx,
        job.organizationId,
        "temporaryBytes",
        `export:${job._id}:${args.sequence}`,
        0,
      );
      await commitCapacity(
        ctx,
        job.organizationId,
        "exportsBytes",
        `export:${job._id}:${args.sequence}`,
        args.part.size,
      );
      await ctx.db.insert("exportParts", {
        ...args.part,
        exportId: job._id,
        sequence: job.sequence,
      });
    }
    if (args.done && !assisted)
      await commitCapacity(ctx, job.organizationId, "exportsCount", `export:${job._id}`);
    await ctx.db.patch("documentExports", job._id, {
      checkpoint: args.checkpoint,
      sequence: job.sequence + 1,
      bytes: job.bytes + (args.part?.size ?? 0),
      state: args.done ? "succeeded" : "running",
    });
    if (assisted) return null;
    if (!args.done) await enqueue(ctx, job._id, job.sequence + 1);
    else
      await recordAudit(ctx, {
        organizationId: job.organizationId,
        actor: job.actor,
        action: "export.succeeded",
        target: job._id,
      });
    return null;
  },
});
export const completed = internalMutation({
  args: vOnCompleteArgs(v.object(stepArgs)),
  returns: v.null(),
  handler: async (ctx, { context }) => {
    const job = await ctx.db.get("documentExports", context.exportId);
    if (job?.state === "running" && job.sequence === context.sequence) {
      await ctx.db.patch("documentExports", job._id, { state: "failed", code: "EXPORT_FAILED" });
      await recordAudit(ctx, {
        organizationId: job.organizationId,
        actor: job.actor,
        action: "export.failed",
        target: job._id,
        code: "EXPORT_FAILED",
      });
      await ctx.scheduler.runAfter(0, internal.exports.expire, { exportId: job._id });
    }
    return null;
  },
});
export const expire = internalMutation({
  args: { exportId: v.id("documentExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    if (!job || (job.expiresAt > Date.now() && !["failed", "revoked"].includes(job.state)))
      return null;
    if (job.expiresAt <= Date.now() && job.state !== "expired")
      await ctx.db.patch("documentExports", job._id, { state: "expired" });
    await releaseCapacity(ctx, job.organizationId, "exportsCount", `export:${job._id}`);
    await releaseCapacity(
      ctx,
      job.organizationId,
      "exportsBytes",
      `export:${job._id}:${job.sequence}`,
    );
    await releaseCapacity(
      ctx,
      job.organizationId,
      "temporaryBytes",
      `export:${job._id}:${job.sequence}`,
    );
    const parts = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job._id))
      .take(20);
    for (const part of parts) {
      await ctx.storage.delete(part.storageId);
      await releaseStoredFile(ctx, job.organizationId, part.storageId);
      await ctx.db.delete("exportParts", part._id);
    }
    if (Date.now() >= job.createdAt + 30 * DAY && !parts.length)
      await ctx.db.delete("documentExports", job._id);
    else {
      const at = parts.length ? Date.now() : job.createdAt + 30 * DAY;
      const expireJobId = await ctx.scheduler.runAt(at, internal.exports.expire, args);
      await ctx.db.patch("documentExports", job._id, { expireJobId });
    }
    return null;
  },
});

/** Reserve the bounded part before reading originals or generating the compressed output. */
export const reservePart = internalMutation({
  args: stepArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    if (
      !job ||
      job.state !== "running" ||
      job.sequence !== args.sequence ||
      job.expiresAt <= Date.now()
    )
      return false;
    await exportAllowed(ctx, job);
    // The isolated destination of an assisted export has no capacity to reserve (ADR 0009, §7).
    if (job.assisted) return true;
    await reserveCapacity(ctx, job.organizationId, "exportsCount", `export:${job._id}`, 1);
    const key = `export:${job._id}:${args.sequence}`;
    await reserveCapacity(ctx, job.organizationId, "exportsBytes", key, 20 * 1024 * 1024);
    await reserveCapacity(ctx, job.organizationId, "temporaryBytes", key, 20 * 1024 * 1024);
    return true;
  },
});
