import {
  reserveCapacity,
  trackStoredFile,
  releaseCapacity,
  commitCapacity,
  checkCapacity,
  ensureCapacityReady,
  capacityEvent,
} from "./lib/capacityCore";
import { insertOriginal } from "./lib/originalStore";
import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { claimFields } from "./lib/operationValues";
import {
  captureClaim,
  captureAudit,
  captureAttention,
  rejectedProbeReachedEnd,
} from "./lib/captureCore";
import {
  CAPTURE_HOUR,
  captureTask,
  deferralAudit,
  releaseIntervalHours,
  ZERO_NSU,
  attemptUsageKey,
} from "./lib/captureValues";
import {
  activeClaim,
  continueOperation,
  executionAllowed,
  recordSourceFailure,
  waitOperation,
} from "./lib/operationCore";
import { deny } from "./lib/organizationAccess";
import {
  checkUsage,
  eventFor,
  recordUsage,
  reserveUsage,
  commitUsage,
  refundUsage,
  releaseUsage,
  usageError,
  planFor,
  requireQuota,
  capturePlanMissing,
  capturePlanRequired,
  requireCapturePlan,
  type UsageEnvironment,
} from "./lib/usageCore";
import { planEnded } from "./lib/usageValues";
import { quotaPeriod } from "./lib/quotaPeriod";
import { pauseOperation } from "./lib/operationCore";
import {
  RESUMABLE_PAUSES,
  USAGE_PAUSES,
  scheduleResume,
  streamOfOperation,
} from "./lib/captureAttention";
import { fiscalProofAllowed, fiscalProofPolicy, realFiscalMode } from "./lib/fiscalProof";
import { isSiteCapture, siteCaptureDecision, siteCapturePin } from "./lib/siteCapture";
import { captureRelease } from "./lib/fiscalCaptureRelease";
import {
  admitEnvelope,
  cursorFromBlock,
  newRecovery,
  nsuAfter,
  RECOVERY_BACKOFF,
  RECOVERY_STEP_MS,
  recoverySlot,
  recoveryStep,
} from "./lib/captureGap";
import { buildSha } from "./buildInfo";
import { ensureConsoleProject } from "./lib/projectAccess";

// Matches the connector's 2 MiB response + 16 MiB expanded envelope ceiling.
export const CAPTURE_RESERVED_BYTES = 18 * 1024 * 1024;
/**
 * The 999 of the distribution ("Rejeição: Erro não catalogado") says nothing about the request: the
 * stream asks again, after the source's hour and the release's interval, and only the third one in
 * a row stops it in attention with `SOURCE_999` (#195). Any other committed answer starts over.
 */
const SOURCE_ERROR_ATTENTION = 3;
const SOURCE_RETRY = "source_retry";

/** Operator-only receipt. It never returns XML, storage URLs or certificate material. */
export const proofEvidence = internalQuery({
  args: { streamId: v.id("captureStreams") },
  returns: v.object({
    sha: v.union(v.string(), v.null()),
    stream: schema.doc("captureStreams"),
    operation: v.union(
      v.null(),
      v.object({
        id: v.id("operations"),
        state: v.string(),
        code: v.union(v.string(), v.null()),
        uncertain: v.boolean(),
      }),
    ),
    batch: v.union(schema.doc("captureBatches"), v.null()),
    envelopes: v.array(v.object({ nsu: v.string(), schema: v.string(), sha256: v.string() })),
    authorizedCalls: v.number(),
  }),
  handler: async (ctx, { streamId }) => {
    const policy = fiscalProofPolicy();
    const stream = await ctx.db.get("captureStreams", streamId);
    if (
      !policy ||
      policy.sha !== buildSha ||
      policy.deploymentUrl !== process.env.CONVEX_CLOUD_URL ||
      !stream ||
      stream.companyId !== policy.companyId ||
      stream.organizationId !== policy.organizationId ||
      stream.projectId !== policy.projectId
    )
      return deny("FISCAL_PROOF_DENIED");
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    const batch = op
      ? await ctx.db
          .query("captureBatches")
          .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
          .unique()
      : null;
    const certificateId = ctx.db.normalizeId("certificates", policy.certificateId);
    if (!certificateId) return deny("FISCAL_PROOF_DENIED");
    const calls = await ctx.db
      .query("certificateAudit")
      .withIndex("by_certificateId_and_action_and_result", (q) =>
        q.eq("certificateId", certificateId).eq("action", "transport").eq("result", "authorized"),
      )
      .take(3);
    const envelopes = await ctx.db
      .query("captureEnvelopes")
      .withIndex("by_streamId_nsu", (q) => q.eq("streamId", streamId))
      .take(101);
    return {
      sha: buildSha,
      stream,
      operation: op
        ? { id: op._id, state: op.state, code: op.code ?? null, uncertain: op.uncertain }
        : null,
      batch,
      envelopes: envelopes.map(({ nsu, schema, sha256 }) => ({ nsu, schema, sha256 })),
      authorizedCalls: calls.length,
    };
  },
});

export const prepare = internalMutation({
  args: claimFields,
  returns: v.union(
    v.null(),
    v.object({
      stream: schema.doc("captureStreams"),
      batch: v.union(schema.doc("captureBatches"), v.null()),
      nsu: v.string(),
      mode: v.union(v.literal("distNSU"), v.literal("consNSU")),
      waitUntil: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const current = await captureClaim(ctx, args);
    if (!current) return null;
    const { op } = current;
    let stream = current.stream;
    let batch = await ctx.db
      .query("captureBatches")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    const request = JSON.parse(op.request) as { previousOperationId?: Id<"operations"> };
    if (!batch && request.previousOperationId) {
      const previous = await ctx.db.get("operations", request.previousOperationId);
      const prior = await ctx.db
        .query("captureBatches")
        .withIndex("by_operationId", (q) => q.eq("operationId", request.previousOperationId!))
        .unique();
      if (
        prior &&
        !prior.committed &&
        prior.streamId === stream._id &&
        previous?.organizationId === op.organizationId &&
        previous.companyId === op.companyId
      ) {
        await ctx.db.patch("captureBatches", prior._id, {
          operationId: op._id,
          ownerVersion: stream.version,
        });
        batch = (await ctx.db.get("captureBatches", prior._id))!;
      }
    }
    // A cursor that only a 656 set before #421 is the unread queue, not a gap (#419): read it
    // with `distNSU` from the checkpoint, 50 per query, instead of one `consNSU` per NSU. An
    // uncertain query is reconciled first, as always.
    if (!batch && !op.uncertain && (await cursorFromBlock(ctx, stream))) {
      await ctx.db.patch("captureStreams", stream._id, {
        mode: "distNSU",
        sourceCursor: undefined,
      });
      stream = (await ctx.db.get("captureStreams", stream._id))!;
      await captureAudit(ctx, stream, "blocked_cursor_cleared");
    }
    const mode = batch?.mode ?? (op.uncertain ? "consNSU" : stream.mode);
    const probe = stream.recovery?.probe;
    const nsu =
      batch?.requestNsu ??
      (mode === "consNSU"
        ? probe && probe > stream.checkpoint
          ? probe
          : nsuAfter(stream.checkpoint)
        : stream.checkpoint);
    if (!batch && stream.nextAllowedAt <= Date.now()) {
      if (realFiscalMode()) {
        const certificate = op.certificate
          ? await ctx.db.get("certificates", op.certificate.id)
          : null;
        if (!certificate || !(await fiscalProofAllowed(ctx, op, certificate))) {
          await ctx.db.patch("operations", op._id, { stage: "ready" });
          await pauseOperation(ctx, { ...op, stage: "ready" }, "FISCAL_PROOF_DENIED");
          return null;
        }
      } else if (isSiteCapture(op)) {
        // Before any usage or window reservation: a refusal spends neither.
        const decision = await siteCaptureDecision(ctx, op, op.certificate?.id);
        if (!decision.allowed && "deferUntil" in decision) {
          await ctx.db.patch("captureStreams", stream._id, {
            nextAllowedAt: Math.max(stream.nextAllowedAt, decision.deferUntil),
          });
          // The worker answers `wait`: neither the hourly ceiling nor the Freecorps general stop
          // (#424) spends an attempt or a recovery, however long they last (#421).
          await captureAudit(ctx, stream, decision.audit);
          return {
            stream,
            batch: null,
            mode,
            nsu,
            waitUntil: Math.max(stream.nextAllowedAt, decision.deferUntil),
          };
        }
        if (!decision.allowed) {
          // The pause turns the stream to attention (`pauseOperation`).
          await ctx.db.patch("operations", op._id, { stage: "ready" });
          await pauseOperation(ctx, { ...op, stage: "ready" }, decision.code);
          return null;
        }
      }
      // The recovery budget, below the source's 20 `consNSU` per hour (#419): a wait, like the
      // site's ceiling, whatever scheduled this query (a checkpoint, a resume or a sync).
      if (mode === "consNSU") {
        const slot = await recoverySlot(ctx, stream._id, Date.now());
        if (slot > Date.now()) {
          await ctx.db.patch("captureStreams", stream._id, { nextAllowedAt: slot });
          await captureAudit(ctx, stream, "recovery_deferred");
          return { stream, batch: null, mode, nsu, waitUntil: slot };
        }
      }
      const previous = request.previousOperationId
        ? await ctx.db.get("operations", request.previousOperationId)
        : null;
      const usageKey =
        op.usageCaptureKey ??
        (previous?.organizationId === op.organizationId &&
        previous.uncertain &&
        previous.state !== "succeeded"
          ? previous.usageCaptureKey
          : undefined) ??
        attemptUsageKey(op);
      try {
        // A query already charged under its key (an uncertain one being reconciled) was admitted.
        if (!(await eventFor(ctx, op.organizationId, "captures", usageKey)))
          await requireCapturePlan(ctx, op.organizationId, op.environment);
        await checkUsage(ctx, op.organizationId, op.environment, "captures", usageKey);
        await checkUsage(
          ctx,
          op.organizationId,
          op.environment,
          "bytes",
          `capture:${usageKey}`,
          CAPTURE_RESERVED_BYTES,
        );
        if (!(await capacityEvent(ctx, op.organizationId, "filesBytes", `capture:${usageKey}`))) {
          await ensureCapacityReady(ctx, op.organizationId);
          await checkCapacity(ctx, op.organizationId, "databaseBytes", 1);
          await reserveCapacity(
            ctx,
            op.organizationId,
            "filesBytes",
            `capture:${usageKey}`,
            CAPTURE_RESERVED_BYTES,
          );
        }
      } catch (error) {
        const code = usageError(error);
        if (!code) throw error;
        await ctx.db.patch("operations", op._id, { stage: "ready" });
        await pauseOperation(ctx, { ...op, stage: "ready" }, code);
        // On the site the stream is now in attention; it resumes by itself when the plan admits
        // a query again: the next period, the plan's start or a new plan (`usage.assignPlan`,
        // the only way out of PLAN_REQUIRED).
        if (isSiteCapture(op)) {
          const paused = (await ctx.db.get("captureStreams", stream._id))!;
          const at = await usageEligibleAt(ctx, op.organizationId, op.environment, usageKey);
          if (paused.state === "attention" && paused.code === code && at !== null)
            await scheduleResume(ctx, paused, Math.max(at, Date.now() + USAGE_RECHECK_MS));
        }
        return null;
      }
      await recordUsage(ctx, op.organizationId, op.environment, "captures", usageKey);
      await reserveUsage(
        ctx,
        op.organizationId,
        op.environment,
        "bytes",
        `capture:${usageKey}`,
        CAPTURE_RESERVED_BYTES,
      );
      // What the window was before this attempt, for a refusal before the request (#421).
      await ctx.db.patch("operations", op._id, {
        usageCaptureKey: usageKey,
        captureReservation: {
          fence: op.fence,
          nextAllowedAt: stream.nextAllowedAt,
          ...(stream.lastAttemptAt !== undefined ? { lastAttemptAt: stream.lastAttemptAt } : {}),
        },
      });
      // Reserve the worst-case source window before IO. A lost response cannot clear it.
      await ctx.db.patch("captureStreams", stream._id, {
        nextAllowedAt: Date.now() + CAPTURE_HOUR,
        lastAttemptAt: Date.now(),
        mode,
      });
      await captureAudit(
        ctx,
        stream,
        mode === "consNSU" ? "reconciliation_started" : "query_started",
      );
    }
    return { stream, batch, mode, nsu, waitUntil: batch ? 0 : stream.nextAllowedAt };
  },
});

/**
 * The vault refused the attempt after `prepare` and before the request (#421). The proof that
 * nothing left is where the worker calls this: only on `RefusedBeforeSend`, which
 * `transportWithCertificate` throws before decrypting the A1 and making the request. So there is
 * nothing to reconcile, and on the site what `prepare` reserved for this attempt is undone: the
 * source window and last attempt go back to what they were, and the usage charged under this
 * attempt's own key is refunded (a key carried from an uncertain query stays, since that query
 * may have reached the source). The #50 proof keeps its conservative window. Then, in the same
 * transaction, a deferral makes the operation wait (`waitOperation`) and returns until when; any
 * other refusal pauses it with its code. Either way it keeps the uncertainty it already had and
 * gains none. Returns null when it paused, or when the attempt is no longer this claim's.
 * `cut` is the vault's reading of the Freecorps cut, made with the reading that decided the code:
 * the variables may be written again before this mutation runs (#601).
 */
export const refusedBeforeSend = internalMutation({
  args: {
    ...claimFields,
    code: v.string(),
    defer: v.union(v.object({ until: v.number(), audit: deferralAudit }), v.null()),
    cut: v.optional(v.boolean()),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || op.stage !== "calling" || op.task.name !== captureTask.name) return null;
    const batch = await ctx.db
      .query("captureBatches")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    // A durable response contradicts the refusal: leave the attempt to the uncertain paths.
    if (batch) return null;
    if (!op.uncertain && op.usageCaptureKey === attemptUsageKey(op))
      await releaseCapacity(ctx, op.organizationId, "filesBytes", `capture:${op.usageCaptureKey}`);
    let stream = await streamOfOperation(ctx, op);
    let current = op;
    if (stream && isSiteCapture(op)) {
      const reserved = op.captureReservation?.fence === op.fence ? op.captureReservation : null;
      if (reserved) {
        await ctx.db.patch("captureStreams", stream._id, {
          nextAllowedAt: reserved.nextAllowedAt,
          lastAttemptAt: reserved.lastAttemptAt,
        });
        stream = (await ctx.db.get("captureStreams", stream._id))!;
      }
      const key = op.usageCaptureKey;
      if (key === attemptUsageKey(op)) {
        await refundUsage(ctx, op.organizationId, "captures", key);
        await refundUsage(ctx, op.organizationId, "bytes", `capture:${key}`);
      }
      const refunded = {
        captureReservation: undefined,
        ...(key === attemptUsageKey(op) ? { usageCaptureKey: undefined } : {}),
      };
      await ctx.db.patch("operations", op._id, refunded);
      current = { ...op, ...refunded };
    }
    const code = /^[A-Z0-9_]{1,80}$/.test(args.code) ? args.code : "TASK_FAILED";
    if (args.defer && Number.isSafeInteger(args.defer.until)) {
      const waitUntil = Math.max(stream?.nextAllowedAt ?? 0, args.defer.until);
      if (stream) {
        await ctx.db.patch("captureStreams", stream._id, { nextAllowedAt: waitUntil });
        await captureAudit(ctx, stream, args.defer.audit);
      }
      // Here and not through `recordOutcome`, which would take a renewed A1 for a lost access.
      await waitOperation(ctx, current, code, waitUntil);
      return waitUntil;
    }
    if (stream) await captureAudit(ctx, stream, "query_refused");
    // Back to `ready` first: a pause in `calling` would take the attempt for an uncertain one.
    await ctx.db.patch("operations", op._id, { stage: "ready" });
    await pauseOperation(ctx, { ...current, stage: "ready" }, code, "system", args.cut);
    return null;
  },
});
export const raw = internalMutation({
  args: {
    ...claimFields,
    rawId: v.id("_storage"),
    rawHash: v.string(),
    nsu: v.string(),
    mode: v.union(v.literal("distNSU"), v.literal("consNSU")),
  },
  returns: v.union(v.id("captureBatches"), v.null()),
  handler: async (ctx, args) => {
    const current = await captureClaim(ctx, args);
    if (!current) return null;
    const previous = await ctx.db
      .query("captureBatches")
      .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (previous) {
      if (previous.rawId !== args.rawId) await ctx.storage.delete(args.rawId);
      return previous._id;
    }
    const metadata = await ctx.db.system.get("_storage", args.rawId);
    if (!metadata || metadata.size > 2 * 1024 * 1024) return deny("INVALID_FILE");
    await trackStoredFile(
      ctx,
      current.op.organizationId,
      args.rawId,
      current.op.usageCaptureKey ? `capture:${current.op.usageCaptureKey}` : undefined,
    );
    return ctx.db.insert("captureBatches", {
      usageKey: current.op.usageCaptureKey,
      storedBytes: metadata.size,
      streamId: current.stream._id,
      operationId: args.operationId,
      ownerVersion: current.stream.version,
      requestNsu: args.nsu,
      mode: args.mode,
      rawId: args.rawId,
      rawHash: args.rawHash,
      saved: 0,
      committed: false,
      createdAt: Date.now(),
    });
  },
});
export const describe = internalMutation({
  args: {
    ...claimFields,
    batchId: v.id("captureBatches"),
    status: v.string(),
    lastNsu: v.union(v.string(), v.null()),
    maxNsu: v.union(v.string(), v.null()),
    count: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await captureClaim(ctx, args))) return false;
    const batch = await ctx.db.get("captureBatches", args.batchId);
    if (!batch || batch.operationId !== args.operationId || args.count < 0 || args.count > 50)
      return deny("OPERATION_CONFLICT");
    await ctx.db.patch("captureBatches", batch._id, {
      status: args.status,
      lastNsu: args.lastNsu ?? undefined,
      maxNsu: args.maxNsu ?? undefined,
      envelopeCount: args.count,
    });
    if (args.count === 0 && batch.usageKey) {
      const op = (await ctx.db.get("operations", args.operationId))!;
      await commitCapacity(ctx, op.organizationId, "filesBytes", `capture:${batch.usageKey}`, 0);
      await commitUsage(
        ctx,
        op.organizationId,
        "bytes",
        `capture:${batch.usageKey}`,
        batch.storedBytes ?? 0,
      );
    }
    return true;
  },
});
export const envelope = internalMutation({
  args: {
    ...claimFields,
    batchId: v.id("captureBatches"),
    position: v.number(),
    nsu: v.string(),
    schema: v.string(),
    sha256: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const current = await captureClaim(ctx, args);
    if (!current) return false;
    const batch = await ctx.db.get("captureBatches", args.batchId);
    if (
      !batch ||
      batch.operationId !== args.operationId ||
      batch.committed ||
      args.position < 0 ||
      args.position >= (batch.envelopeCount ?? 0)
    )
      return deny("OPERATION_CONFLICT");
    const entry = await ctx.db
      .query("captureBatchEntries")
      .withIndex("by_batchId_position", (q) =>
        q.eq("batchId", batch._id).eq("position", args.position),
      )
      .unique();
    if (entry) {
      await ctx.storage.delete(args.storageId);
      return true;
    }
    if (args.position !== batch.saved) return deny("OPERATION_CONFLICT");
    let existing = await ctx.db
      .query("captureEnvelopes")
      .withIndex("by_streamId_nsu", (q) => q.eq("streamId", current.stream._id).eq("nsu", args.nsu))
      .unique();
    if (existing && (existing.sha256 !== args.sha256 || existing.schema !== args.schema)) {
      await captureAttention(ctx, current.stream, "NSU_CONTENT_CONFLICT");
      return false;
    }
    if (!existing) {
      const metadata = await ctx.db.system.get("_storage", args.storageId);
      if (
        !metadata ||
        metadata.size !== args.size ||
        (batch.storedBytes ?? 0) + args.size > CAPTURE_RESERVED_BYTES
      )
        return deny("INVALID_FILE");
      await trackStoredFile(
        ctx,
        current.op.organizationId,
        args.storageId,
        batch.usageKey ? `capture:${batch.usageKey}` : undefined,
      );
      const artifactId = await insertOriginal(ctx, {
        organizationId: current.op.organizationId,
        projectId: current.op.projectId,
        companyId: current.op.companyId,
        environment: current.op.environment,
        captureStreamId: current.stream._id,
        source: "distribution-xml",
        storageId: args.storageId,
        sha256: args.sha256,
        size: args.size,
        importedAt: Date.now(),
      });
      const id = await ctx.db.insert("captureEnvelopes", {
        streamId: current.stream._id,
        batchId: batch._id,
        nsu: args.nsu,
        schema: args.schema,
        sha256: args.sha256,
        artifactId,
      });
      existing = (await ctx.db.get("captureEnvelopes", id))!;
      await ctx.db.patch("captureBatches", batch._id, {
        storedBytes: (batch.storedBytes ?? 0) + args.size,
      });
    } else await ctx.storage.delete(args.storageId);
    await ctx.db.insert("captureBatchEntries", {
      batchId: batch._id,
      position: args.position,
      envelopeId: existing._id,
    });
    await ctx.db.patch("captureBatches", batch._id, { saved: batch.saved + 1 });
    if (batch.saved + 1 === batch.envelopeCount && batch.usageKey) {
      await commitCapacity(
        ctx,
        current.op.organizationId,
        "filesBytes",
        `capture:${batch.usageKey}`,
        0,
      );
      await commitUsage(
        ctx,
        current.op.organizationId,
        "bytes",
        `capture:${batch.usageKey}`,
        (await ctx.db.get("captureBatches", batch._id))!.storedBytes ?? 0,
      );
    }
    return true;
  },
});
export const failed = internalMutation({
  // `cut`: the worker's reading of the Freecorps cut, made with the reading that gave the code.
  args: { ...claimFields, code: v.string(), cut: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await captureClaim(ctx, args);
    if (current) {
      const batch = await ctx.db
        .query("captureBatches")
        .withIndex("by_operationId", (q) => q.eq("operationId", current.op._id))
        .unique();
      if (batch?.usageKey)
        await commitUsage(
          ctx,
          current.op.organizationId,
          "bytes",
          `capture:${batch.usageKey}`,
          batch.storedBytes ?? 0,
        );
      else if (args.code === "FISCAL_TRANSPORT_DISABLED" && current.op.usageCaptureKey) {
        if (!current.op.uncertain)
          await releaseCapacity(
            ctx,
            current.op.organizationId,
            "filesBytes",
            `capture:${current.op.usageCaptureKey}`,
          );
        await releaseUsage(
          ctx,
          current.op.organizationId,
          "bytes",
          `capture:${current.op.usageCaptureKey}`,
        );
      }
      await captureAttention(ctx, current.stream, args.code, args.cut);
    }
    return null;
  },
});
export const checkpoint = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    if (!op) return deny("NOT_FOUND");
    const current = await captureClaim(ctx, {
      operationId: op._id,
      generation: op.generation,
      fence: op.fence,
    });
    if (!current || op.stage !== "response") return deny("OPERATION_CONFLICT");
    const stream = current.stream;
    const batch = await ctx.db
      .query("captureBatches")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    if (!batch || batch.saved !== batch.envelopeCount) return deny("BATCH_INCOMPLETE");
    if (batch.committed) return null;
    const entries = await ctx.db
      .query("captureBatchEntries")
      .withIndex("by_batchId_position", (q) => q.eq("batchId", batch._id))
      .take(50);
    let checkpoint = stream.checkpoint,
      code: string | undefined,
      received = stream.received;
    let sourceCursor = stream.sourceCursor,
      mode = stream.mode,
      nextAllowedAt = stream.nextAllowedAt,
      queuePending = false,
      recovery = stream.recovery;
    /** The next query's time when a branch decides it; otherwise the source windows below. */
    let decided: number | undefined;
    /** Consecutive 999 with this one (#195); absent after any other answer or refusal. */
    let sourceErrors: number | undefined;
    if (batch.mode === "consNSU" && batch.status === "138") {
      const only =
        entries.length === 1 ? await ctx.db.get("captureEnvelopes", entries[0]!.envelopeId) : null;
      if (!only || only.nsu !== batch.requestNsu) {
        await captureAttention(ctx, stream, "RECONCILIATION_INCOMPLETE");
        await ctx.db.patch("captureBatches", batch._id, { committed: true });
        return null;
      }
    }
    if (batch.lastNsu && batch.mode === "distNSU" && batch.lastNsu < stream.checkpoint) {
      await captureAttention(ctx, stream, "SOURCE_CURSOR_REGRESSION");
      await ctx.db.patch("captureBatches", batch._id, { committed: true });
      return null;
    }
    if (batch.status === "138" && batch.mode === "distNSU" && batch.lastNsu === stream.checkpoint) {
      await captureAttention(ctx, stream, "REPEATED_NSU");
      await ctx.db.patch("captureBatches", batch._id, { committed: true });
      return null;
    }
    // The site waits the company's interval at the end of the queue (ADR 0007, §4).
    const endOfQueue = async () => {
      if (!isSiteCapture(op)) return CAPTURE_HOUR;
      const company = await ctx.db.get("companies", op.companyId);
      const release = company ? await captureRelease(ctx, company) : null;
      return releaseIntervalHours(release?.minIntervalHours) * CAPTURE_HOUR;
    };
    if (batch.mode === "consNSU" && (batch.status === "138" || batch.status === "137")) {
      // One step of a gap recovery, or of the reconciliation of an uncertain query (#419).
      const step = await recoveryStep(ctx, op, stream, batch, await endOfQueue());
      ({ checkpoint, received, sourceCursor, mode, code, recovery } = step);
      decided = step.window;
    } else if (batch.status === "138") {
      for (const entry of entries) {
        const envelope = (await ctx.db.get("captureEnvelopes", entry.envelopeId))!;
        if (envelope.nsu <= checkpoint) continue;
        if (BigInt(envelope.nsu) !== BigInt(checkpoint) + 1n && checkpoint !== ZERO_NSU) {
          code = "NSU_GAP";
          mode = "consNSU";
          break;
        }
        if (checkpoint === ZERO_NSU && BigInt(envelope.nsu) > 1n) code = "HISTORY_LIMITED";
        if (!envelope.operationId) {
          await admitEnvelope(ctx, op, envelope);
          received++;
        }
        checkpoint = envelope.nsu;
      }
      sourceCursor = batch.lastNsu;
      if (sourceCursor && checkpoint < sourceCursor) {
        mode = "consNSU";
        code ??= "RECONCILING_GAP";
      } else if (sourceCursor && checkpoint === sourceCursor) mode = "distNSU";
      if (mode === "distNSU" && checkpoint === batch.lastNsu && checkpoint !== batch.maxNsu) {
        nextAllowedAt = Date.now() + 1000;
        queuePending = true;
      }
    } else if (batch.status === "137") {
      code = "NO_DOCUMENTS";
      if (batch.lastNsu && batch.lastNsu > checkpoint) {
        sourceCursor = batch.lastNsu;
        mode = "consNSU";
        code = "RECONCILING_GAP";
      }
    } else if (batch.status === "656") {
      code = "SOURCE_CONSUMPTION_BLOCKED";
      // The operation succeeds (the response is durable), so the monitors count it here.
      await recordSourceFailure(ctx, op, code);
      // Someone spends the CNPJ's quota: a day of halved recovery budget (#419).
      await captureAudit(ctx, stream, RECOVERY_BACKOFF, "system", batch._id);
      // Mode and cursor stay as they were (#421). In a 656, NT 2014.002 v1.40 (§3.11.4.1,
      // "Observação") returns in `ultNSU` the NSU of the last query made for the CNPJ, by any
      // application of the actor, not a bound of what this stream received nor of a gap in it.
      // Taking it as the source cursor turned the rest of the queue into a `consNSU` recovery
      // of one NSU per hour, while `distNSU` from the checkpoint reads up to 50 per query; and
      // the checkpoint never jumps there, which would skip documents. The value stays in the
      // batch for diagnosis; the stream only waits the source's hour, below.
    } else {
      code = `SOURCE_${batch.status}`;
      if (batch.status === "999") {
        sourceErrors = (stream.sourceErrors ?? 0) + 1;
        // Each 999 reaches the monitors, the retried ones too (#195).
        await recordSourceFailure(ctx, op, code);
      }
      // An uncertain first request can probe checkpoint + 1 before knowing
      // whether that NSU exists. Only a consistent source boundary can end
      // that probe; never discard a previously known gap or move checkpoint.
      if (rejectedProbeReachedEnd(stream, batch)) {
        sourceCursor = checkpoint;
        mode = "distNSU";
      }
    }
    // A `distNSU` answer that revealed a gap starts its recovery (#419). After a 138 the first
    // `consNSU` goes right away: the NT asks for an hour after a 137, not between `consNSU`.
    if (mode === "distNSU") recovery = undefined;
    else if (batch.mode === "distNSU") {
      recovery = newRecovery(stream, batch);
      if (batch.status === "138")
        decided = Math.max(
          Date.now() + RECOVERY_STEP_MS,
          await recoverySlot(ctx, stream._id, Date.now()),
        );
    }
    let window =
      decided ??
      (batch.status === "138" && batch.mode === "distNSU"
        ? nextAllowedAt
        : Math.max(nextAllowedAt, Date.now() + CAPTURE_HOUR));
    // At the end of the queue the site waits the company's interval; pending queues,
    // reconciliation and rejections keep the source windows.
    if (
      isSiteCapture(op) &&
      batch.mode === "distNSU" &&
      mode === "distNSU" &&
      !queuePending &&
      (batch.status === "138" || (batch.status === "137" && code === "NO_DOCUMENTS"))
    )
      window = Math.max(window, Date.now() + (await endOfQueue()));
    // A retried 999 asks no sooner than the end of the queue would (#195): the retry spends no
    // more of the CNPJ's queries than the release allows.
    const retrying = sourceErrors !== undefined && sourceErrors < SOURCE_ERROR_ATTENTION;
    if (retrying) window = Math.max(window, Date.now() + (await endOfQueue()));
    // Only an answer (137/138) tells where the source's queue ends (#494): a refusal's `maxNSU`
    // (656, 589, …) may be zero or another bound, and stays in the batch for diagnosis.
    const answered = ["137", "138"].includes(batch.status!);
    // Receipt and checkpoint commit together, after raw response and every envelope are durable.
    await ctx.db.patch("captureBatches", batch._id, { committed: true });
    await ctx.db.patch("captureStreams", stream._id, {
      checkpoint,
      sourceCursor,
      sourceMaxNsu: answered ? (batch.maxNsu ?? stream.sourceMaxNsu) : stream.sourceMaxNsu,
      mode,
      nextAllowedAt: window,
      received,
      lastSuccessAt: answered ? Date.now() : stream.lastSuccessAt,
      code,
      recovery,
      // The count survives only while the stream retries; attention and any other answer clear it.
      sourceErrors: retrying ? sourceErrors : undefined,
    });
    const updated = (await ctx.db.get("captureStreams", stream._id))!;
    await captureAudit(ctx, updated, "checkpoint_committed", "system", batch._id);
    if (retrying) {
      await captureAudit(ctx, updated, SOURCE_RETRY, "system", batch._id);
      return null;
    }
    if (
      code &&
      [
        "SOURCE_CURSOR_UNKNOWN",
        "RECONCILIATION_INCOMPLETE",
        "RECONCILIATION_UNAVAILABLE",
        "SOURCE_CONSUMPTION_BLOCKED",
      ].includes(code)
    )
      await captureAttention(ctx, updated, code);
    else if (!["137", "138", "108", "109"].includes(batch.status!))
      await captureAttention(ctx, updated, code!);
    return null;
  },
});
export const published = internalMutation({
  args: { operationId: v.id("operations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    if (!op || op.state !== "succeeded") return null;
    const request = JSON.parse(op.request) as { streamId: Id<"captureStreams"> };
    const stream = await ctx.db.get("captureStreams", request.streamId);
    if (!stream || stream.operationId !== op._id || stream.state !== "active") return null;
    if (!(await executionAllowed(ctx, op))) {
      await captureAttention(ctx, stream, "ACCESS_REVOKED");
      return null;
    }
    // A fiscal proof advances only by explicit operator action, preserving the
    // source window and committed checkpoint even if the caller disconnects.
    if (realFiscalMode()) {
      await ctx.db.patch("captureStreams", stream._id, {
        state: "paused",
        version: stream.version + 1,
        code: "FISCAL_PROOF_STEP_COMPLETE",
      });
      await captureAudit(ctx, stream, "proof_step_complete", "system");
      return null;
    }
    const operationId = await continueOperation(
      ctx,
      op,
      captureTask,
      JSON.stringify({ streamId: stream._id, version: stream.version }),
      stream.nextAllowedAt,
    );
    await ctx.db.patch("captureStreams", stream._id, { operationId });
    return null;
  },
});

/** Shortest wait before a quota pause is checked again, so a check never loops on itself. */
const USAGE_RECHECK_MS = 60_000;
/**
 * When the plan admits a new capture query in the environment: now, a later instant (the next period, or the start
 * of a plan not yet in force) or null when only a new plan can (an ended plan, or none with the
 * finite quotas a production capture requires, #429).
 */
async function usageEligibleAt(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  admittedKey?: string,
) {
  const now = Date.now();
  const plan = await planFor(ctx, organizationId);
  if (capturePlanRequired(environment) && capturePlanMissing(plan)) return null;
  if (plan && plan.startsAt > now) return plan.startsAt;
  if (plan && planEnded(plan, now)) return null;
  if (
    !admittedKey ||
    !(await capacityEvent(ctx, organizationId, "filesBytes", `capture:${admittedKey}`))
  ) {
    try {
      await checkCapacity(ctx, organizationId, "filesBytes", CAPTURE_RESERVED_BYTES);
      await checkCapacity(ctx, organizationId, "databaseBytes", 1);
    } catch (error) {
      if (!usageError(error)) throw error;
      // Stock has no monthly reset. A plan change, finished inventory or explicit resume
      // rechecks it; a full disk must not create a loop of scheduled fiscal attempts.
      return null;
    }
  }
  try {
    await requireQuota(ctx, organizationId, environment, "captures");
    await requireQuota(ctx, organizationId, environment, "bytes", CAPTURE_RESERVED_BYTES);
    return now;
  } catch (error) {
    if (!usageError(error)) throw error;
    // The quota resets when the plan's quota period ends: the civil month, or its anchor's month.
    return quotaPeriod(plan, now).endsAt;
  }
}

/**
 * Resumes by itself a production capture of the site that paused for a cause now gone (#418):
 * the quota or the plan's term (`USAGE_PAUSES`), or the lack of a usable A1 of the company's own
 * (`CERTIFICATE_UNAVAILABLE`). Scheduled by stream for its version, by the pause itself, by a new
 * plan (`usage.assignPlan`) or by the activation of a certificate (`certificates.finish`).
 * Nothing happens if a person acted in the meantime, if the cause holds (a quota check waits
 * again for its instant), or if the source of the paused query lost its access: then a person
 * resumes. The next query continues the paused one, as a resume in the console would, under the
 * company's release and its current A1.
 */
export const resumeEligible = internalMutation({
  args: { streamId: v.id("captureStreams"), version: v.number() },
  returns: v.null(),
  handler: async (ctx, { streamId, version }) => {
    const stream = await ctx.db.get("captureStreams", streamId);
    if (
      !stream ||
      stream.version !== version ||
      stream.state !== "attention" ||
      !stream.code ||
      !RESUMABLE_PAUSES.includes(stream.code)
    )
      return null;
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    if (
      !op ||
      op.state !== "paused" ||
      op.code !== stream.code ||
      !isSiteCapture(op) ||
      op.organizationId !== stream.organizationId ||
      op.companyId !== stream.companyId ||
      op.projectId !== stream.projectId
    )
      return null;
    if (USAGE_PAUSES.includes(stream.code)) {
      const at = await usageEligibleAt(ctx, op.organizationId, op.environment, op.usageCaptureKey);
      if (at === null) return null;
      if (at > Date.now()) {
        await scheduleResume(ctx, stream, Math.max(at, Date.now() + USAGE_RECHECK_MS));
        return null;
      }
    }
    const pin = await siteCapturePin(ctx, op);
    const parent = pin ? { ...op, certificate: pin } : null;
    if (!parent || !(await executionAllowed(ctx, parent))) return null;
    const next = stream.version + 1;
    const operationId = await continueOperation(
      ctx,
      parent,
      captureTask,
      JSON.stringify({ streamId: stream._id, version: next, previousOperationId: op._id }),
      Math.max(Date.now(), stream.nextAllowedAt),
    );
    // An uncertain query is reconciled first, as a resume in the console does.
    await ctx.db.patch("captureStreams", stream._id, {
      state: "active",
      version: next,
      operationId,
      code: undefined,
      mode: op.uncertain ? "consNSU" : stream.mode,
    });
    await captureAudit(ctx, (await ctx.db.get("captureStreams", stream._id))!, "resumed");
    return null;
  },
});

/**
 * #50 runner only, through the deploy key: the console project that owns a stream activated
 * in the console (ADR 0005). The proof policy names it before transport is enabled.
 */
export const proofConsoleProject = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("projects"),
  handler: async (ctx, { organizationId }) => {
    if (process.env.APP_ENV !== "validation") throw new Error("FISCAL_PROOF_DENIED");
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", "active"),
      )
      .take(2);
    if (members.length !== 1) throw new Error("FISCAL_PROOF_DENIED");
    return ensureConsoleProject(ctx, members[0]!);
  },
});
