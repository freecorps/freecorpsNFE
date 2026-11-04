import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { archiveGate, archiveStatus } from "./lib/coldArchiveCore";
import { assistedCompany } from "./lib/exportSchema";
import { assertAssistedDestination, exportAllowed } from "./lib/exportAccess";
import { environment } from "./lib/projectValues";
import {
  environmentServed,
  organizationEnvironmentServed,
  type ProductEnvironment,
} from "./lib/environmentAccess";
import { readTask } from "./lib/documentCore";
import { deny, findMembership, normalizeEmail } from "./lib/organizationAccess";
import { closureOf, exportWindowOpen } from "./lib/organizationClosure";
import { recordAudit, DAY } from "./lib/operationalAudit";
import { requestCleanup } from "./importUpload";

/**
 * The assisted export of an archived organization (ADR 0009, §7, decisions of 30/10/2026). The
 * owner asks the support; the operator's command (`scripts/cold-tier/cold-archive.mjs export`) records the
 * request here, restores the package in the isolated destination, generates there the same export
 * as EXPORTS.md with the normal generator, and publishes its parts in the origin, as an export of
 * the owner, downloaded by the same signed ticket with the same 24 hours.
 *
 * Origin: `request`, `prepare`, `uploadUrl`, `attachPart`. Isolated destination: `generate`,
 * `progress`, `parts`. Every function is internal, for the operator's deploy key.
 */

/** The run states with a sealed package the isolated restore reads (`ISOLATED_RESTORE_STATES`). */
const SEALED_STATES = ["sealed", "verified", "deleting", "archived", "restoring"];
/** At most one owner's request per organization in this window; a data subject's is exempt. */
export const ASSISTED_EXPORT_WINDOW = 30 * DAY;
const EXPORT_MIME = "application/vnd.freecorps.export+gzip";
const MAX_COMPANIES = 5_000;
/** The origin job's checkpoint once its last part is attached: the request was delivered. */
const DELIVERED = JSON.stringify({ phase: "done" });
const token = (value: string, max: number) =>
  value.length >= 1 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

/** The organization's run, if it is the current one and has a sealed package. */
async function sealedRun(ctx: MutationCtx, runId: Id<"coldArchiveRuns">) {
  const run = await ctx.db.get("coldArchiveRuns", runId);
  if (!run) return deny("NOT_FOUND");
  const current = await archiveStatus(ctx, run.organizationId);
  // A rehydrated organization has the normal export again (ADR 0009, §7).
  if (current?._id !== run._id || run.state === "hot") return deny("ARCHIVE_ORGANIZATION_HOT");
  if (!SEALED_STATES.includes(run.state) || !run.manifest) return deny("ARCHIVE_NOT_SEALED");
  return run;
}
/** The owner by the account: verified e-mail, active membership, role `owner`. */
async function ownerByAccount(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  email: string,
) {
  const user: { _id: string; emailVerified?: boolean } | null = await ctx.runQuery(
    components.betterAuth.adapter.findOne,
    { model: "user", where: [{ field: "email", value: normalizeEmail(email) }] },
  );
  const membership = user?.emailVerified
    ? await findMembership(ctx, organizationId, user._id)
    : null;
  if (!membership || membership.state !== "active" || membership.role !== "owner")
    return deny("ASSISTED_EXPORT_NOT_OWNER");
  return membership;
}
/** The request's member must still be its organization's active owner. */
async function stillOwner(ctx: MutationCtx, request: Doc<"assistedExports">) {
  const membership = await ctx.db.get("memberships", request.membershipId);
  if (
    !membership ||
    membership.organizationId !== request.organizationId ||
    membership.authUserId !== request.authUserId ||
    membership.state !== "active" ||
    membership.role !== "owner"
  )
    return deny("ASSISTED_EXPORT_NOT_OWNER");
  return membership;
}
async function openForExport(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const closure = await closureOf(ctx, organizationId);
  if (closure && !exportWindowOpen(closure)) deny("ORGANIZATION_CLOSED");
}

const requestResult = v.object({
  requestId: v.id("assistedExports"),
  organizationId: v.id("organizations"),
  environments: v.array(environment),
  createdAt: v.number(),
  repeated: v.boolean(),
});
/**
 * Records the request the support received. Only the organization's owner, checked by the
 * account of the e-mail the request came from; at most one owner's request each 30 days per
 * organization, unless it serves a data subject's request under RIGHTS.md (`basis: "rights"`,
 * with its reference in the restricted register). The ticket (`key`) makes it idempotent: the
 * same ticket with the same content returns the same request, even after the window.
 */
export const request = internalMutation({
  args: {
    runId: v.id("coldArchiveRuns"),
    key: v.string(),
    email: v.string(),
    basis: v.union(v.literal("owner"), v.literal("rights")),
    rightsReference: v.optional(v.string()),
    environments: v.array(environment),
  },
  returns: requestResult,
  handler: async (ctx, args) => {
    archiveGate();
    const environments = [...new Set(args.environments)].sort();
    if (
      !token(args.key, 128) ||
      !environments.length ||
      environments.length !== args.environments.length ||
      (args.basis === "rights") !== (args.rightsReference !== undefined) ||
      (args.rightsReference !== undefined && !token(args.rightsReference, 128))
    )
      return deny("INVALID_REQUEST");
    const run = await sealedRun(ctx, args.runId);
    const organizationId = run.organizationId;
    const membership = await ownerByAccount(ctx, organizationId, args.email);
    await openForExport(ctx, organizationId);
    const prior = await ctx.db
      .query("assistedExports")
      .withIndex("by_organizationId_and_key", (q) =>
        q.eq("organizationId", organizationId).eq("key", args.key),
      )
      .unique();
    if (prior) {
      if (
        prior.runId !== run._id ||
        prior.basis !== args.basis ||
        prior.rightsReference !== args.rightsReference ||
        prior.authUserId !== membership.authUserId ||
        prior.environments.join() !== environments.join()
      )
        return deny("IDEMPOTENCY_CONFLICT");
      return {
        requestId: prior._id,
        organizationId,
        environments,
        createdAt: prior.createdAt,
        repeated: true,
      };
    }
    const now = Date.now();
    if (args.basis === "owner") {
      const last = await ctx.db
        .query("assistedExports")
        .withIndex("by_organizationId_and_basis_and_createdAt", (q) =>
          q
            .eq("organizationId", organizationId)
            .eq("basis", "owner")
            .gt("createdAt", now - ASSISTED_EXPORT_WINDOW),
        )
        .order("desc")
        .first();
      if (last)
        throw new ConvexError({
          code: "ASSISTED_EXPORT_RATE_LIMITED",
          retryAt: last.createdAt + ASSISTED_EXPORT_WINDOW,
        });
    }
    const requestId = await ctx.db.insert("assistedExports", {
      organizationId,
      runId: run._id,
      key: args.key,
      basis: args.basis,
      ...(args.rightsReference !== undefined ? { rightsReference: args.rightsReference } : {}),
      authUserId: membership.authUserId,
      membershipId: membership._id,
      environments,
      createdAt: now,
    });
    await recordAudit(ctx, {
      organizationId,
      actor: `member:${membership._id}`,
      action: "export.assisted_requested",
      target: requestId,
    });
    return { requestId, organizationId, environments, createdAt: now, repeated: false };
  },
});

/** The companies of the organization as the normal export would read them in `environment`. */
export async function companiesFor(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: ProductEnvironment,
) {
  const rows = await ctx.db
    .query("companies")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(MAX_COMPANIES + 1);
  if (rows.length > MAX_COMPANIES) return deny("ASSISTED_EXPORT_LIMIT_EXCEEDED");
  const companies = [];
  for (const company of rows)
    companies.push({
      id: company._id,
      cnpj: company.cnpj,
      name: company.name,
      createdAt: company.createdAt,
      served: await environmentServed(ctx, company, environment, readTask.scope),
    });
  return companies;
}

/**
 * The origin's export for one environment of the request: the job the owner sees in Exportações
 * and downloads, with no worker. Returns the live one (running or succeeded, before its deadline)
 * or creates another, with the companies the destination needs. `restart` fails a running job
 * that already has parts, when its destination was lost and the generation starts over.
 */
export const prepare = internalMutation({
  args: {
    requestId: v.id("assistedExports"),
    environment,
    restart: v.optional(v.boolean()),
  },
  returns: v.object({
    exportId: v.id("documentExports"),
    organizationId: v.id("organizations"),
    environment,
    createdAt: v.number(),
    expiresAt: v.number(),
    state: v.union(v.literal("running"), v.literal("succeeded")),
    sequence: v.number(),
    companies: v.array(assistedCompany),
  }),
  handler: async (ctx, args) => {
    archiveGate();
    const request = await ctx.db.get("assistedExports", args.requestId);
    if (!request || !request.environments.includes(args.environment)) return deny("NOT_FOUND");
    await sealedRun(ctx, request.runId);
    const membership = await stillOwner(ctx, request);
    await openForExport(ctx, request.organizationId);
    const now = Date.now();
    const answer = async (job: Doc<"documentExports">) => ({
      exportId: job._id,
      organizationId: job.organizationId,
      environment: job.environment,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      state: job.state as "running" | "succeeded",
      sequence: job.sequence,
      companies: await companiesFor(ctx, job.organizationId, job.environment),
    });
    const latest = await ctx.db
      .query("documentExports")
      .withIndex("by_assistedRequestId_and_environment", (q) =>
        q.eq("assistedRequestId", request._id).eq("environment", args.environment),
      )
      .order("desc")
      .first();
    // A request is delivered once: after its 24 hours the owner asks again, under the limit.
    if (latest?.checkpoint === DELIVERED && latest.expiresAt <= now)
      return deny("ASSISTED_EXPORT_DELIVERED");
    if (latest && latest.expiresAt > now) {
      if (latest.state === "succeeded") return answer(latest);
      if (latest.state === "running" && (latest.sequence === 0 || !args.restart))
        return answer(latest);
      if (latest.state === "running") {
        await ctx.db.patch("documentExports", latest._id, {
          state: "failed",
          code: "ASSISTED_EXPORT_RESTARTED",
        });
        await ctx.scheduler.runAfter(0, internal.exports.expire, { exportId: latest._id });
      }
    }
    if (
      !(await organizationEnvironmentServed(
        ctx,
        request.organizationId,
        args.environment,
        readTask.scope,
      ))
    )
      return deny("ENVIRONMENT_DENIED");
    const exportId = await ctx.db.insert("documentExports", {
      organizationId: request.organizationId,
      environment: args.environment,
      selection: { kind: "organization" },
      actor: `member:${membership._id}`,
      membershipId: membership._id,
      membershipVersion: membership.version,
      key: `assisted:${request._id}:${args.environment}:${now}`,
      state: "running",
      checkpoint: JSON.stringify({ phase: "assisted" }),
      sequence: 0,
      bytes: 0,
      createdAt: now,
      expiresAt: now + DAY,
      assistedRequestId: request._id,
    });
    const expireJobId = await ctx.scheduler.runAt(now + DAY, internal.exports.expire, { exportId });
    await ctx.db.patch("documentExports", exportId, { expireJobId });
    // The storage scanner removes a part uploaded but never attached, as it does for the worker's.
    await requestCleanup(ctx, now + DAY + 3_600_000);
    await recordAudit(ctx, {
      organizationId: request.organizationId,
      actor: `member:${membership._id}`,
      action: "export.requested",
      target: exportId,
    });
    return answer((await ctx.db.get("documentExports", exportId))!);
  },
});

/** The origin's assisted job still accepting parts, under the owner's current authorization. */
async function publishable(ctx: MutationCtx, exportId: Id<"documentExports">) {
  archiveGate();
  const job = await ctx.db.get("documentExports", exportId);
  if (!job?.assistedRequestId || job.state !== "running" || job.expiresAt <= Date.now())
    return deny("NOT_FOUND");
  await exportAllowed(ctx, job);
  return job;
}
export const uploadUrl = internalMutation({
  args: { exportId: v.id("documentExports") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await publishable(ctx, args.exportId);
    return ctx.storage.generateUploadUrl();
  },
});

/** Hex SHA-256 of a part, as the export records it, to the base64 of the storage metadata. */
function hexToBase64(hex: string) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return "";
  let binary = "";
  for (let i = 0; i < 64; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}

/**
 * Attaches to the origin's job the next part generated in the destination, under the same
 * sequence fence and limits as the worker's commit. The uploaded blob must be fresh, held by no
 * other part and carry the SHA-256, size and MIME of the generated part; otherwise it is deleted
 * and nothing is attached. Repeating an attached part changes nothing. The last part publishes the
 * export, which the owner then downloads with the normal ticket.
 */
export const attachPart = internalMutation({
  args: {
    exportId: v.id("documentExports"),
    sequence: v.number(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    size: v.number(),
    done: v.boolean(),
  },
  returns: v.object({ ok: v.boolean(), code: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    archiveGate();
    const attached = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) =>
        q.eq("exportId", args.exportId).eq("sequence", args.sequence),
      )
      .unique();
    if (attached) {
      if (attached.sha256 !== args.sha256 || attached.size !== args.size)
        return deny("ASSISTED_EXPORT_PART_CONFLICT");
      // A lost response re-uploaded the same part: drop the copy, keep the attached one.
      if (attached.storageId !== args.storageId) await dropUnheld(ctx, args.storageId);
      return { ok: true };
    }
    const job = await publishable(ctx, args.exportId);
    if (job.sequence !== args.sequence) return deny("ASSISTED_EXPORT_SEQUENCE");
    const blob = await ctx.db.system.get("_storage", args.storageId);
    const held = await ctx.db
      .query("exportParts")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (
      !blob ||
      held ||
      blob._creationTime < job.createdAt ||
      // The command uploads with the export MIME, so the storage scanner collects an unattached
      // part like the worker's; a blob stored without a type has no other MIME to compare.
      (blob.contentType !== undefined && blob.contentType !== EXPORT_MIME) ||
      blob.size !== args.size ||
      blob.sha256 !== hexToBase64(args.sha256)
    ) {
      if (blob && !held) await ctx.storage.delete(args.storageId);
      return { ok: false, code: "ASSISTED_EXPORT_PART_MISMATCH" };
    }
    if (job.sequence >= 10_000 || job.bytes + args.size > 2 * 1024 ** 3) {
      await ctx.storage.delete(args.storageId);
      return { ok: false, code: "EXPORT_LIMIT_EXCEEDED" };
    }
    await ctx.db.insert("exportParts", {
      exportId: job._id,
      sequence: job.sequence,
      storageId: args.storageId,
      sha256: args.sha256,
      size: args.size,
    });
    await ctx.db.patch("documentExports", job._id, {
      sequence: job.sequence + 1,
      bytes: job.bytes + args.size,
      state: args.done ? "succeeded" : "running",
      ...(args.done ? { checkpoint: DELIVERED } : {}),
    });
    if (args.done)
      await recordAudit(ctx, {
        organizationId: job.organizationId,
        actor: job.actor,
        action: "export.succeeded",
        target: job._id,
      });
    return { ok: true };
  },
});
async function dropUnheld(ctx: MutationCtx, storageId: Id<"_storage">) {
  const held = await ctx.db
    .query("exportParts")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (!held && (await ctx.db.system.get("_storage", storageId)))
    await ctx.storage.delete(storageId);
}

/**
 * Destination: the job that generates, with the normal generator, the parts of the origin's
 * export, for the same organization, environment, cutoff and deadline. Only where the organization
 * does not exist (`assertAssistedDestination`). The origin's export ID makes it idempotent.
 */
export const generate = internalMutation({
  args: {
    exportId: v.id("documentExports"),
    organizationId: v.id("organizations"),
    environment,
    createdAt: v.number(),
    expiresAt: v.number(),
    companies: v.array(assistedCompany),
  },
  returns: v.object({ jobId: v.id("documentExports"), created: v.boolean() }),
  handler: async (ctx, args) => {
    await assertAssistedDestination(ctx, args.organizationId);
    const prior = await ctx.db
      .query("documentExports")
      .withIndex("by_organizationId_and_actor_and_key", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("actor", "assisted")
          .eq("key", args.exportId),
      )
      .unique();
    if (prior) return { jobId: prior._id, created: false };
    if (args.expiresAt <= Date.now() || args.companies.length > MAX_COMPANIES)
      return deny("INVALID_REQUEST");
    const jobId = await ctx.db.insert("documentExports", {
      organizationId: args.organizationId,
      environment: args.environment,
      selection: { kind: "organization" },
      actor: "assisted",
      key: args.exportId,
      state: "running",
      checkpoint: JSON.stringify({ phase: "documents", cursor: null, pagination: "keyset-v1" }),
      sequence: 0,
      bytes: 0,
      createdAt: args.createdAt,
      expiresAt: args.expiresAt,
      assisted: { exportId: args.exportId, companies: args.companies },
    });
    return { jobId, created: true };
  },
});
async function destinationJob(
  ctx: Parameters<typeof assertAssistedDestination>[0],
  jobId: Id<"documentExports">,
) {
  const job = await ctx.db.get("documentExports", jobId);
  if (!job?.assisted) return deny("NOT_FOUND");
  await assertAssistedDestination(ctx, job.organizationId);
  return job;
}
export const progress = internalQuery({
  args: { jobId: v.id("documentExports") },
  returns: v.object({
    state: v.string(),
    sequence: v.number(),
    code: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const job = await destinationJob(ctx, args.jobId);
    const expired = job.state === "running" && job.expiresAt <= Date.now();
    return {
      state: expired ? "expired" : job.state,
      sequence: job.sequence,
      code: job.code ?? null,
    };
  },
});
/** Destination: the generated parts after `after`, with a URL of the loopback destination. */
export const parts = internalQuery({
  args: { jobId: v.id("documentExports"), after: v.number() },
  returns: v.array(
    v.object({ sequence: v.number(), sha256: v.string(), size: v.number(), url: v.string() }),
  ),
  handler: async (ctx, args) => {
    const job = await destinationJob(ctx, args.jobId);
    if (job.state !== "succeeded") return deny("NOT_FOUND");
    const page = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) =>
        q.eq("exportId", job._id).gt("sequence", args.after),
      )
      .take(100);
    const result = [];
    for (const part of page) {
      const url = await ctx.storage.getUrl(part.storageId);
      if (!url) return deny("EXPORT_ORIGINAL_UNAVAILABLE");
      result.push({ sequence: part.sequence, sha256: part.sha256, size: part.size, url });
    }
    return result;
  },
});
