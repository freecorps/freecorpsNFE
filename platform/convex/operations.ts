import { v, type Infer } from "convex/values";
import { commitCapacity, releaseCapacity } from "./lib/capacityCore";
import { makeFunctionReference } from "convex/server";
import { vOnCompleteArgs, type WorkId } from "@convex-dev/workpool";
import { internalMutation, query, mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { certificatePin } from "./lib/certificateValues";
import { certificateUsable } from "./lib/certificateAccess";
import schema from "./schema";
import { requireActivePlan, rateUsage, acquireUsageLease, recordUsage } from "./lib/usageCore";
import { completeImport } from "./lib/webhookOutbox";
import { releaseBatchNotes, releasePendingNote } from "./lib/importCore";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { deny, requireUser } from "./lib/organizationAccess";
import { keyAccess, humanAccess, memberAccess, projectAccess } from "./lib/operationAccess";
import { isConsoleProject } from "./lib/projectAccess";
import { connectionAccess } from "./lib/stripeAccess";
import {
  taskSpec,
  scopeFields,
  canonicalRequest,
  MAX_ATTEMPTS,
  LEASE_MS,
  RECOVERY_BATCH,
  claimFields,
  outcome,
  operationSummary,
} from "./lib/operationValues";
import {
  activeClaim,
  auditOperation,
  executionAllowed,
  finishAttempt,
  pauseOperation,
  pools,
  retryOperation,
  schedule,
  summary,
  waitOperation,
} from "./lib/operationCore";
import { isSiteCapture, siteCapturePin } from "./lib/siteCapture";
import { isCaptureProcessing } from "./lib/captureValues";
// Usage keys use the operation's first ID (ADR 0009, §5, item 5): the same after a rehydration.
import { firstId } from "./lib/coldArchiveOrigin";
import { requireTermsOfUse } from "./lib/termsOfUse";

/** Internal ingress for domain mutations. Task references and the request are constructed by the server. */
export const reserve = internalMutation({
  args: {
    certificate: v.optional(certificatePin),
    ...scopeFields,
    keyHash: v.optional(v.string()),
    /** A Stripe connection (ADR 0006) asking under its project's grant, never with a key. */
    connectionId: v.optional(v.id("stripeConnections")),
    key: v.string(),
    request: v.string(),
    // Domain ingress may pin a mutable resource for execution while retaining the caller's stable request identity.
    idempotencyRequest: v.optional(v.string()),
    task: taskSpec,
  },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    // The processing of a stored capture document exists only as a continuation of the query that
    // received it (`captureProcessing.checkpoint`); no caller reserves one.
    if ((args.keyHash && args.connectionId) || isCaptureProcessing(args.task))
      deny("INVALID_REQUEST");
    const key = args.keyHash ? await keyAccess(ctx, args.keyHash, args) : null;
    const connection = args.connectionId
      ? await connectionAccess(ctx, args.connectionId, args)
      : null;
    let human:
      | {
          sourceMembershipId: import("./_generated/dataModel").Id<"memberships">;
          sourceAccessVersion: string;
        }
      | undefined;
    if (!key && !connection) {
      const { membership, accessVersion } = await memberAccess(ctx, args, true);
      human = { sourceMembershipId: membership._id, sourceAccessVersion: accessVersion };
    }
    if (!/^[\x21-\x7e]{1,128}$/.test(args.key) || !/^[a-z][a-z0-9_.-]{0,79}$/.test(args.task.name))
      deny("INVALID_REQUEST");
    let request: string, requestIdentity: string;
    try {
      request = canonicalRequest(args.request);
      requestIdentity = canonicalRequest(args.idempotencyRequest ?? request);
    } catch {
      return deny("INVALID_REQUEST");
    }
    // Environment/company belong to request identity, while the reservation namespace is deliberately stable across environments.
    const requestHash = await hashApiKey(
      canonicalRequest(
        JSON.stringify({
          request: JSON.parse(requestIdentity) as unknown,
          environment: args.environment,
          companyId: args.companyId,
        }),
      ),
    );
    // People act only through the console project, also when an earlier request is reused.
    if (!key && !connection) {
      const target = await ctx.db.get("projects", args.projectId);
      if (!target || target.organizationId !== args.organizationId || !isConsoleProject(target))
        return deny("NOT_FOUND");
    }
    const record = await ctx.db
      .query("idempotencyRecords")
      .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("projectId", args.projectId)
          .eq("name", args.task.name)
          .eq("key", args.key),
      )
      .unique();
    if (record) {
      const existing = (await ctx.db.get("operations", record.operationId))!;
      if (args.keyHash) await keyAccess(ctx, args.keyHash, existing);
      else if (args.connectionId) await connectionAccess(ctx, args.connectionId, existing);
      else await humanAccess(ctx, existing, true);
      if (record.requestHash !== requestHash) deny("IDEMPOTENCY_CONFLICT");
      return { operationId: record.operationId, reused: true };
    }
    const { project, grant } = await projectAccess(ctx, args);
    // Confirming an upload already reserved its commercial units. New commands require an active plan.
    if (args.task.name !== "documents.import") await requireActivePlan(ctx, args.organizationId);
    // Past the effect of new terms of use, an organization that has not accepted them creates no
    // new command (#586). The upload was admitted under them, and the cancellation of a note
    // already issued stays possible.
    if (args.task.name !== "documents.import" && args.task.name !== "documents.cancel")
      await requireTermsOfUse(ctx, args.organizationId);
    await rateUsage(ctx, args.organizationId, key?._id);
    const now = Date.now();
    if (args.certificate && !(await certificateUsable(ctx, args, args.certificate, now)))
      return deny("CERTIFICATE_UNAVAILABLE");
    const operationId = await ctx.db.insert("operations", {
      ...(args.certificate ? { certificate: args.certificate } : {}),
      organizationId: args.organizationId,
      projectId: args.projectId,
      companyId: args.companyId,
      environment: args.environment,
      task: args.task,
      request,
      requestHash,
      ...(key
        ? { sourceKeyId: key._id }
        : connection
          ? { sourceStripeConnectionId: connection._id }
          : human!),
      projectEpoch: project.accessEpoch,
      grantEpoch: grant.accessEpoch,
      state: "queued",
      stage: "ready",
      generation: 1,
      fence: 0,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      recoveryAttempts: 0,
      leaseUntil: 0,
      nextAttemptAt: now,
      backoffMs: 0,
      jitterMs: 0,
      uncertain: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("idempotencyRecords", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      name: args.task.name,
      key: args.key,
      requestHash,
      operationId,
    });
    await schedule(ctx, operationId);
    await auditOperation(
      ctx,
      (await ctx.db.get("operations", operationId))!,
      "accepted",
      key
        ? `key:${key._id}`
        : connection
          ? `stripe:${connection._id}`
          : `membership:${human!.sourceMembershipId}`,
    );
    return { operationId, reused: false };
  },
});
export const dispatch = internalMutation({
  args: { operationId: v.id("operations"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    if (
      op &&
      op.generation === args.generation &&
      !op.workId &&
      ["queued", "retry_wait", "reconciling"].includes(op.state)
    )
      await schedule(ctx, op._id);
    return null;
  },
});
export const claim = internalMutation({
  args: { operationId: v.id("operations"), generation: v.number() },
  returns: v.union(schema.doc("operations"), v.null()),
  handler: async (ctx, args) => {
    let op = await ctx.db.get("operations", args.operationId);
    if (
      !op ||
      op.generation !== args.generation ||
      !["queued", "retry_wait", "reconciling"].includes(op.state) ||
      op.nextAttemptAt > Date.now()
    )
      return null;
    // A production capture of the site queries with the company's A1 of now (#418): the attempt
    // pins it here, so a renewal between two queries goes on by itself. Without a usable A1 of
    // the company's own, the operation pauses and the stream goes to attention; a lost access
    // still reads as ACCESS_REVOKED.
    if (isSiteCapture(op)) {
      const pin = await siteCapturePin(ctx, op);
      if (!pin) {
        const access = await executionAllowed(ctx, { ...op, certificate: undefined });
        await pauseOperation(ctx, op, access ? "CERTIFICATE_UNAVAILABLE" : "ACCESS_REVOKED");
        return null;
      }
      if (pin.id !== op.certificate?.id || pin.version !== op.certificate.version) {
        await ctx.db.patch("operations", op._id, { certificate: pin });
        op = { ...op, certificate: pin };
        await auditOperation(ctx, op, "certificate_current");
      }
    }
    if (!(await executionAllowed(ctx, op))) {
      await pauseOperation(ctx, op, "ACCESS_REVOKED");
      return null;
    }
    const resume = op.stage === "response" || op.stage === "checkpoint";
    if (!resume && op.attempts >= op.maxAttempts) {
      await pauseOperation(ctx, op, "ATTEMPTS_EXHAUSTED");
      return null;
    }
    const fence = op.fence + 1,
      leaseUntil = Date.now() + LEASE_MS;
    if (!(await acquireUsageLease(ctx, op.organizationId, String(op._id), leaseUntil))) {
      await ctx.db.patch("operations", op._id, {
        workId: undefined,
        nextAttemptAt: Date.now() + 1000,
      });
      await schedule(ctx, op._id);
      return null;
    }
    await recordUsage(
      ctx,
      op.organizationId,
      op.environment,
      "attempts",
      `operation:${firstId(op)}:${op.generation}:${fence}`,
      1,
      true,
    );
    await ctx.db.patch("operations", op._id, {
      state: "running",
      fence,
      leaseUntil,
      recoveryAt: leaseUntil,
      attempts: op.attempts + Number(!resume),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("operationAttempts", {
      operationId: op._id,
      generation: op.generation,
      fence,
      mode: resume ? "resume" : op.uncertain ? "reconcile" : "execute",
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAt(leaseUntil, internal.operations.recoverOne, { operationId: op._id });
    return ctx.db.get("operations", op._id);
  },
});
export const beginEffect = internalMutation({
  args: claimFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || op.stage !== "ready") return false;
    if (!(await executionAllowed(ctx, op))) {
      await pauseOperation(ctx, op, "ACCESS_REVOKED");
      return false;
    }
    await ctx.db.patch("operations", op._id, { stage: "calling" });
    return true;
  },
});
export const recordOutcome = internalMutation({
  args: { ...claimFields, outcome },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || op.stage !== "calling") return false;
    if (!(await executionAllowed(ctx, op))) {
      await pauseOperation(ctx, op, "ACCESS_REVOKED");
      return false;
    }
    const result = args.outcome;
    if (result.kind === "success") {
      if (new TextEncoder().encode(result.response).length > 32_768) {
        await retryOperation(ctx, op, true, "RESPONSE_TOO_LARGE");
        return false;
      }
      await ctx.db.patch("operations", op._id, {
        response: result.response,
        stage: "response",
        uncertain: false,
        code: undefined,
      });
      return true;
    }
    const code = /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : "TASK_FAILED";
    if (result.kind === "wait") {
      if (!Number.isSafeInteger(result.notBefore) || result.notBefore < 0)
        deny("INVALID_RETRY_TIME");
      await waitOperation(ctx, op, code, result.notBefore);
    } else if (result.kind === "definitive") {
      if (op.task.workload === "capture" && op.usageCaptureKey)
        await commitCapacity(
          ctx,
          op.organizationId,
          "filesBytes",
          `capture:${op.usageCaptureKey}`,
          0,
        );
      if (op.task.workload === "issuance")
        await releaseCapacity(ctx, op.organizationId, "filesBytes", `issuance:${op._id}`);
      await finishAttempt(ctx, op, code);
      await ctx.db.patch("operations", op._id, {
        state: "failed",
        recoveryAt: undefined,
        leaseUntil: 0,
        code,
        uncertain: false,
      });
      await auditOperation(ctx, op, code);
      const file = await ctx.db
        .query("importFiles")
        .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
        .unique();
      // A processing that failed publishes no note: the notes its NFS-e batch held end, and the
      // file's provisional one too. A reprocessing names no file here, only its batch notes.
      if (op.task.workload === "import") await releaseBatchNotes(ctx, op.organizationId, op._id);
      if (file) {
        await releasePendingNote(ctx, op.organizationId, file._id);
        await completeImport(ctx, file.importId);
      }
    } else {
      const notBefore = result.notBefore;
      if (notBefore !== undefined && (!Number.isSafeInteger(notBefore) || notBefore < 0))
        deny("INVALID_RETRY_TIME");
      // A transient outcome is a trusted adapter's assertion that retry cannot duplicate an external effect.
      if (result.kind === "absent" && !op.uncertain) deny("INVALID_RECONCILIATION");
      // Absence is only an observation: an older remote request may still commit.
      // Reconciliation never grants permission to repeat the original effect.
      await retryOperation(
        ctx,
        op,
        result.kind === "uncertain" || op.uncertain,
        code,
        notBefore,
        result.kind === "uncertain" ? result.diagnostic : undefined,
      );
    }
    return false;
  },
});
export const checkpoint = internalMutation({
  args: claimFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || op.stage !== "response") return false;
    if (!(await executionAllowed(ctx, op))) {
      await pauseOperation(ctx, op, "ACCESS_REVOKED");
      return false;
    }
    // Domain writes and the checkpoint commit in the same transaction under the current fence.
    if (op.task.checkpoint)
      await ctx.runMutation(
        makeFunctionReference<"mutation", { operationId: typeof op._id; response: string }, null>(
          op.task.checkpoint,
        ),
        {
          operationId: op._id,
          response: op.response!,
        },
      );
    await ctx.db.patch("operations", op._id, { stage: "checkpoint" });
    return true;
  },
});
export const publish = internalMutation({
  args: claimFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || op.stage !== "checkpoint") return false;
    // Publication is a final effect of its own (the import's document, the capture's
    // continuation): the authority is read again here, with or without a certificate.
    if (!(await executionAllowed(ctx, op))) {
      await pauseOperation(ctx, op, "ACCESS_REVOKED");
      return false;
    }
    for (const kind of ["result", "usage"] as const) {
      const existing = await ctx.db
        .query("operationReceipts")
        .withIndex("by_operationId_and_kind", (q) => q.eq("operationId", op._id).eq("kind", kind))
        .unique();
      if (!existing)
        await ctx.db.insert("operationReceipts", {
          operationId: op._id,
          organizationId: op.organizationId,
          projectId: op.projectId,
          kind,
          createdAt: Date.now(),
        });
    }
    await ctx.db.patch("operations", op._id, {
      state: "succeeded",
      recoveryAt: undefined,
      leaseUntil: 0,
      updatedAt: Date.now(),
    });
    if (op.task.onSucceeded)
      await ctx.runMutation(
        makeFunctionReference<"mutation", { operationId: typeof op._id }, null>(
          op.task.onSucceeded,
        ),
        { operationId: op._id },
      );
    if (op.task.workload === "issuance")
      await releaseCapacity(ctx, op.organizationId, "filesBytes", `issuance:${op._id}`);
    await finishAttempt(ctx, op, "SUCCEEDED");
    await auditOperation(ctx, op, "succeeded");
    return true;
  },
});

async function recover(ctx: Parameters<typeof activeClaim>[0], op: Doc<"operations">) {
  if (op.recoveryAt === undefined || op.recoveryAt > Date.now()) return;
  if (["queued", "retry_wait", "reconciling"].includes(op.state) && op.workId) {
    const status = await pools[op.task.workload].status(ctx, op.workId as WorkId);
    if (status.state !== "finished") {
      const recoveryAt = Date.now() + LEASE_MS;
      await ctx.db.patch("operations", op._id, { recoveryAt });
      await ctx.scheduler.runAt(recoveryAt, internal.operations.recoverOne, {
        operationId: op._id,
      });
      return;
    }
  }
  await retryOperation(ctx, op, op.uncertain || op.stage === "calling", "EXECUTION_LOST");
}
export const recoverOne = internalMutation({
  args: { operationId: v.id("operations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    if (op) await recover(ctx, op);
    return null;
  },
});
export const recoverBatch = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const batch = await ctx.db
      .query("operations")
      .withIndex("by_recoveryAt", (q) => q.gt("recoveryAt", 0).lte("recoveryAt", Date.now()))
      .take(RECOVERY_BATCH);
    for (const op of batch) await recover(ctx, op);
    return batch.length;
  },
});
export const onComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ operationId: v.id("operations"), generation: v.number() })),
  returns: v.null(),
  handler: async (ctx, { context, workId }) => {
    const op = await ctx.db.get("operations", context.operationId);
    if (
      !op ||
      op.generation !== context.generation ||
      op.workId !== workId ||
      op.recoveryAt === undefined
    )
      return null;
    // Success is committed by publish; a callback cannot manufacture a successful operation.
    await recover(ctx, op);
    return null;
  },
});
export const get = query({
  args: { operationId: v.id("operations") },
  returns: operationSummary,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const op = await ctx.db.get("operations", args.operationId);
    if (!op) return deny("NOT_FOUND");
    await humanAccess(ctx, op, false);
    return summary(op);
  },
});
export const controlKind = v.union(v.literal("pause"), v.literal("retry"));
export async function controlOperation(
  ctx: Parameters<typeof activeClaim>[0],
  op: Doc<"operations">,
  action: Infer<typeof controlKind>,
  expectedGeneration: number,
  actor: string,
) {
  if (op.generation !== expectedGeneration) deny("OPERATION_CONFLICT");
  if (["succeeded", "failed"].includes(op.state)) deny("OPERATION_CONFLICT");
  if (action === "pause") {
    if (op.state !== "paused") await pauseOperation(ctx, op, "PAUSED_BY_USER", actor);
    return;
  }
  if (op.state !== "paused") deny("OPERATION_CONFLICT");
  if (!(await executionAllowed(ctx, op))) deny("ACCESS_REVOKED");
  if ((op.recoveryAttempts ?? 0) >= 12) deny("RECOVERY_BUDGET_EXHAUSTED");
  if (op.uncertain && !op.task.reconciler) deny("RECONCILIATION_REQUIRED");
  // A manual retry neither resets the budget nor bypasses a persisted fiscal window.
  const exhausted = op.attempts >= op.maxAttempts && !["response", "checkpoint"].includes(op.stage);
  if (exhausted && !op.uncertain) deny("ATTEMPTS_EXHAUSTED");
  await auditOperation(ctx, op, "retry_requested", actor);
  if (exhausted) {
    // An uncertain effect with a reconciler is never abandoned: each manual resumption grants
    // exactly one reconciliation past the limit, keeping the attempt history and the recovery
    // budget. The reconciler consults before anything else; it never runs the executor.
    const granted = { ...op, maxAttempts: op.attempts + 1 };
    await ctx.db.patch("operations", op._id, { maxAttempts: granted.maxAttempts });
    await retryOperation(ctx, granted, true, "MANUAL_RECONCILE");
    return;
  }
  await retryOperation(ctx, op, op.uncertain, "MANUAL_RETRY");
}
export const control = mutation({
  args: { operationId: v.id("operations"), action: controlKind, expectedGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const op = await ctx.db.get("operations", args.operationId);
    if (!op) return deny("NOT_FOUND");
    const user = await humanAccess(ctx, op, true);
    await controlOperation(ctx, op, args.action, args.expectedGeneration, user._id);
    return null;
  },
});
