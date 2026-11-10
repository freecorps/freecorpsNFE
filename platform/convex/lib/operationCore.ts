import { recordAudit } from "./operationalAudit";
import { armRetention } from "./operationalRetention";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { backoff, LEASE_MS, type claimFields, type responseDiagnostic } from "./operationValues";
import { projectAccess } from "./operationAccess";
import { findCompany } from "./companyAccess";
import { certificateUsable } from "./certificateAccess";
import { releaseUsageLease } from "./usageCore";
import { isConsoleProject } from "./projectAccess";
import { isSiteCapture, releaseSourceAllowed, releaseSourceFor } from "./siteCapture";
import { operationAttention } from "./captureAttention";
import { originalId } from "./coldArchiveOrigin";
import type { OperationSource } from "./operationSources";

export const poolLimits = { import: 4, capture: 2, webhook: 4, issuance: 2 } as const;
export const pools = {
  import: new Workpool(components.importPool, {
    maxParallelism: poolLimits.import,
    retryActionsByDefault: false,
  }),
  capture: new Workpool(components.capturePool, {
    maxParallelism: poolLimits.capture,
    retryActionsByDefault: false,
  }),
  webhook: new Workpool(components.webhookPool, {
    maxParallelism: poolLimits.webhook,
    retryActionsByDefault: false,
  }),
  issuance: new Workpool(components.issuancePool, {
    maxParallelism: poolLimits.issuance,
    retryActionsByDefault: false,
  }),
};

/**
 * Domain continuations inherit the original actor and epochs; never manufacture system access.
 * One source changes, by name: a production capture of the site started by a person continues
 * under the company's release, pinned by its version (`releaseSourceFor`, ADR 0007, §4, #418).
 * The parent still needs its own access here, so the chain always starts at a person's command
 * and is cut by withdrawing the release.
 */
export async function continueOperation(
  ctx: MutationCtx,
  parent: Doc<"operations">,
  task: Doc<"operations">["task"],
  request: string,
  nextAttemptAt = Date.now(),
  useCertificate = true,
) {
  if (!(await executionAllowed(ctx, parent))) throw new ConvexError({ code: "ACCESS_REVOKED" });
  const source = (await releaseSourceFor(ctx, parent)) ?? {
    sourceKeyId: parent.sourceKeyId,
    sourceMembershipId: parent.sourceMembershipId,
    sourceStripeConnectionId: parent.sourceStripeConnectionId,
    sourceCaptureReleaseId: parent.sourceCaptureReleaseId,
    sourceAccessVersion: parent.sourceAccessVersion,
  };
  const id = await ctx.db.insert("operations", {
    organizationId: parent.organizationId,
    projectId: parent.projectId,
    companyId: parent.companyId,
    environment: parent.environment,
    ...source,
    projectEpoch: parent.projectEpoch,
    grantEpoch: parent.grantEpoch,
    ...(useCertificate && parent.certificate ? { certificate: parent.certificate } : {}),
    task,
    request,
    requestHash: parent.requestHash,
    state: "queued",
    stage: "ready",
    generation: 1,
    fence: 0,
    attempts: 0,
    maxAttempts: 6,
    recoveryAttempts: 0,
    leaseUntil: 0,
    nextAttemptAt,
    backoffMs: 0,
    jitterMs: 0,
    uncertain: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await schedule(ctx, id);
  await auditOperation(ctx, (await ctx.db.get("operations", id))!, "continued");
  return id;
}
export type Claim = { [K in keyof typeof claimFields]: Infer<(typeof claimFields)[K]> };
export async function auditOperation(
  ctx: MutationCtx,
  op: Doc<"operations">,
  action: string,
  actor = "system",
) {
  await recordAudit(ctx, {
    organizationId: op.organizationId,
    projectId: op.projectId,
    companyId: op.companyId,
    environment: op.environment,
    actor,
    action: `operation.${action}`,
    target: op._id,
    operationId: op._id,
    code: op.code,
  });
  await ctx.db.insert("operationAudit", {
    operationId: op._id,
    generation: op.generation,
    action,
    actor,
    createdAt: Date.now(),
  });
}
export async function activeClaim(ctx: MutationCtx, args: Claim) {
  const op = await ctx.db.get("operations", args.operationId);
  return op &&
    op.generation === args.generation &&
    op.fence === args.fence &&
    op.state === "running" &&
    op.leaseUntil > Date.now()
    ? op
    : null;
}
export async function executionAllowed(ctx: MutationCtx, op: Doc<"operations">) {
  if (op.certificate && !(await certificateUsable(ctx, op, op.certificate, Date.now())))
    return false;
  try {
    const { project, grant } = await projectAccess(ctx, op);
    // A re-grant does not resurrect an accepted operation from a revoked epoch.
    if (project.accessEpoch !== op.projectEpoch || grant.accessEpoch !== op.grantEpoch)
      return false;
    // Only continuations of a console capture carry the release as their source.
    if (op.sourceCaptureReleaseId)
      return isConsoleProject(project) && (await releaseSourceAllowed(ctx, op));
    if (op.sourceMembershipId) {
      const membership = await ctx.db.get("memberships", op.sourceMembershipId);
      if (
        !membership ||
        membership.organizationId !== op.organizationId ||
        !["owner", "admin", "operator"].includes(membership.role)
      )
        return false;
      const access = await findCompany(ctx, membership, op.companyId);
      return !!access && access.accessVersion === op.sourceAccessVersion;
    }
    if (op.sourceStripeConnectionId) {
      const connection = await ctx.db.get("stripeConnections", op.sourceStripeConnectionId);
      return (
        !!connection &&
        connection.active &&
        connection.projectId === op.projectId &&
        connection.companyId === op.companyId &&
        connection.environment === op.environment &&
        connection.projectEpoch === op.projectEpoch &&
        connection.grantEpoch === op.grantEpoch
      );
    }
    if (!op.sourceKeyId) return false;
    const key = await ctx.db.get("apiKeys", op.sourceKeyId);
    return !!key && key.revokedAt === null && key.expiresAt > Date.now();
  } catch (error) {
    const data: unknown = error instanceof ConvexError ? error.data : null;
    if (data && typeof data === "object" && "code" in data && data.code === "NOT_FOUND")
      return false;
    throw error;
  }
}
export async function schedule(ctx: MutationCtx, id: Id<"operations">) {
  const op = (await ctx.db.get("operations", id))!;
  const recoveryAt = op.nextAttemptAt + LEASE_MS;
  // Workpool buckets runAt into time segments. The scheduler opens the exact
  // domain window before enqueueing, so an early bucket cannot consume a job.
  if (op.nextAttemptAt > Date.now()) {
    await ctx.db.patch("operations", id, { workId: undefined, recoveryAt });
    await ctx.scheduler.runAt(op.nextAttemptAt, internal.operations.dispatch, {
      operationId: id,
      generation: op.generation,
    });
  } else {
    const workId: WorkId = await pools[op.task.workload].enqueueAction(
      ctx,
      internal.operationWorker.run,
      { operationId: id, generation: op.generation },
      {
        retry: false,
        onComplete: internal.operations.onComplete,
        context: { operationId: id, generation: op.generation },
      },
    );
    await ctx.db.patch("operations", id, { workId, recoveryAt });
  }
  await ctx.scheduler.runAt(recoveryAt, internal.operations.recoverOne, { operationId: id });
}
type Diagnostic = Infer<typeof responseDiagnostic>;
/** Bounded copy: media type and key names only, at most 20 names of 64 characters. */
function boundedDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    httpStatus: diagnostic.httpStatus,
    contentType: diagnostic.contentType?.slice(0, 128) ?? null,
    body: diagnostic.body.slice(0, 16),
    keys: diagnostic.keys.slice(0, 20).map((key) => key.slice(0, 64)),
  };
}
export async function finishAttempt(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  diagnostic?: Diagnostic,
) {
  // Pauses asked by a person or a withdrawn release are decisions, not source failures.
  if (
    (await closeAttempt(ctx, op, code, diagnostic)) &&
    !["SUCCEEDED", "ACCESS_REVOKED", ...DECIDED_PAUSES].includes(code)
  )
    await recordSourceFailure(ctx, op, code);
}
/** The attempt row of the claim `op` carries (generation + fence). */
function claimAttempt(ctx: MutationCtx, op: Doc<"operations">) {
  return ctx.db
    .query("operationAttempts")
    .withIndex("by_operationId_and_generation_and_fence", (q) =>
      q.eq("operationId", op._id).eq("generation", op.generation).eq("fence", op.fence),
    )
    .unique();
}
/**
 * A request of the running attempt may have reached the source: the vault closed a use of the
 * certificate for it (`certificateUse.complete`), whether the request answered or failed. From
 * here the attempt only records its outcome or is recovered as uncertain; `abandonBeforeEffect`
 * refuses it.
 */
export async function markEffectSent(ctx: MutationCtx, op: Doc<"operations">) {
  if (op.state !== "running") throw new Error(`markEffectSent: operation is ${op.state}`);
  const attempt = await claimAttempt(ctx, op);
  if (attempt && attempt.effectAt === undefined)
    await ctx.db.patch("operationAttempts", attempt._id, { effectAt: Date.now() });
}
/** Closes the open attempt row with `code`; true when this call closed it. */
async function closeAttempt(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  diagnostic?: Diagnostic,
) {
  await releaseUsageLease(ctx, op.organizationId, String(op._id));
  const attempt = await claimAttempt(ctx, op);
  if (attempt && attempt.finishedAt === undefined) {
    await ctx.db.patch("operationAttempts", attempt._id, {
      finishedAt: Date.now(),
      code,
      ...(diagnostic ? { diagnostic: boundedDiagnostic(diagnostic) } : {}),
    });
    return true;
  }
  return false;
}
/** Shortest wait, so an adapter that keeps answering "wait" never spins the worker. */
const MIN_WAIT_MS = 1000;
/**
 * The attempt sent nothing and must wait until `notBefore` (#421): the source window
 * (`SOURCE_COOLDOWN`) or a gate before the source, like the hourly ceiling of the site. The
 * attempt row keeps the code for the history, but a wait is not a failure: no
 * `operationalFailures` row, no recovery spent, and the attempt the claim counted is given back,
 * so no wait, however long or repeated, exhausts the operation. Uncertainty is kept as it was.
 */
export async function waitOperation(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  notBefore: number,
) {
  await closeAttempt(ctx, op, code);
  await ctx.db.patch("operations", op._id, {
    state: op.uncertain ? "reconciling" : "retry_wait",
    generation: op.generation + 1,
    stage: "ready",
    leaseUntil: 0,
    // Only an attempt that began an effect reaches here (`recordOutcome` needs `calling`), and
    // the claim counted it.
    attempts: Math.max(0, op.attempts - 1),
    nextAttemptAt: Math.max(notBefore, Date.now() + MIN_WAIT_MS),
    code,
    updatedAt: Date.now(),
  });
  await auditOperation(ctx, op, code);
  await schedule(ctx, op._id);
}
/**
 * A failure of the external source for the monitors (`source` metric), kept 7 days. Also used
 * when the operation itself succeeded but the source refused, like the 656 of the distribution.
 */
export async function recordSourceFailure(ctx: MutationCtx, op: Doc<"operations">, code: string) {
  const source: OperationSource =
    op.task.name === "connections.sync"
      ? "nfe-distribution"
      : op.task.name === "registry.lookup"
        ? "opencnpj"
        : op.task.workload === "issuance"
          ? "nfse-issuance"
          : op.task.workload === "import"
            ? "xml-processing"
            : "other";
  await ctx.db.insert("operationalFailures", {
    organizationId: op.organizationId,
    projectId: op.projectId,
    companyId: op.companyId,
    environment: op.environment,
    operationId: op._id,
    source,
    code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : "TASK_FAILED",
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 86_400_000,
  });
  await armRetention(ctx, op.organizationId, Date.now() + 7 * 86_400_000);
}
/** Pauses decided by a person or by the release: the stream says paused, never attention. */
const DECIDED_PAUSES = ["PAUSED_BY_USER", "CAPTURE_RELEASE_WITHDRAWN"];
export async function pauseOperation(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  actor = "system",
  /** The Freecorps cut as read with `code`, when that was another transaction (`captureAttention`). */
  cut?: boolean,
) {
  await finishAttempt(ctx, op, code);
  await ctx.db.patch("operations", op._id, {
    state: "paused",
    generation: op.generation + 1,
    leaseUntil: 0,
    recoveryAt: undefined,
    uncertain: op.uncertain || op.stage === "calling",
    code,
    updatedAt: Date.now(),
  });
  if (op.workId) await pools[op.task.workload].cancel(ctx, op.workId as WorkId);
  await auditOperation(ctx, op, code, actor);
  // Any other pause of a production capture on the site stops the queries, so the stream goes
  // to attention with the code and `connection.attention_required`, once (#418).
  if (isSiteCapture(op) && !DECIDED_PAUSES.includes(code))
    await operationAttention(ctx, op, code, cut);
}
/**
 * Pause of an attempt that the caller proves sent nothing: a gate, the usage limit, the vault or
 * a lost access refused it after `beginEffect` and before the request. The stage goes back to
 * `ready` first, since `pauseOperation` reads `calling` as an effect that may have left; the
 * operation keeps the uncertainty it already had, or `uncertain` when an earlier send of the same
 * operation may have reached the source. Only a running attempt before its response may rewind:
 * `response` and `checkpoint` hold a result that a rewind would lose. Nor one whose certificate
 * use was completed (`markEffectSent`): its request may have left, whatever the caller believes.
 */
export async function abandonBeforeEffect(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  options: { actor?: string; cut?: boolean; uncertain?: boolean } = {},
) {
  if (op.state !== "running" || (op.stage !== "ready" && op.stage !== "calling"))
    throw new Error(`abandonBeforeEffect: ${op.state}/${op.stage} is past the effect`);
  if ((await claimAttempt(ctx, op))?.effectAt !== undefined)
    throw new Error("abandonBeforeEffect: a request of this attempt may have left");
  if (op.stage !== "ready") await ctx.db.patch("operations", op._id, { stage: "ready" });
  await pauseOperation(
    ctx,
    { ...op, stage: "ready", uncertain: op.uncertain || !!options.uncertain },
    code,
    options.actor,
    options.cut,
  );
}
/** Fields a domain keeps on its operation; the protocol's own (state, stage, fences) stay out. */
type OperationDomainFields = Pick<
  Doc<"operations">,
  "usageCaptureKey" | "captureReservation" | "refusalSweep"
>;
/**
 * Writes the domain's progress on a running attempt, in the transaction that holds its claim.
 * `undefined` removes a field. Returns the operation as written, for the protocol calls that follow.
 */
export async function patchOperationDomain(
  ctx: MutationCtx,
  op: Doc<"operations">,
  fields: { [K in keyof OperationDomainFields]?: OperationDomainFields[K] | undefined },
): Promise<Doc<"operations">> {
  if (op.state !== "running") throw new Error(`patchOperationDomain: operation is ${op.state}`);
  await ctx.db.patch("operations", op._id, fields);
  return { ...op, ...fields };
}
/** The response limit of `recordOutcome`, also for a result the domain rewrites. */
export const RESPONSE_LIMIT_BYTES = 32_768;
/**
 * Rewrites the operation's result with the domain's DTO: in the checkpoint (`stage: "response"`,
 * still under the fence of `operations.checkpoint`) or once succeeded, as `onSucceeded` does in the
 * transaction that wrote `succeeded`. Nowhere else: an attempt that has not answered has no result
 * to rewrite.
 */
export async function setResult(ctx: MutationCtx, op: Doc<"operations">, response: string) {
  const inCheckpoint = op.state === "running" && op.stage === "response";
  if (!inCheckpoint && op.state !== "succeeded")
    throw new Error(`setResult: ${op.state}/${op.stage} has no result to write`);
  if (new TextEncoder().encode(response).length > RESPONSE_LIMIT_BYTES)
    throw new Error("setResult: response over the limit");
  await ctx.db.patch("operations", op._id, { response });
}
export async function retryOperation(
  ctx: MutationCtx,
  op: Doc<"operations">,
  uncertain: boolean,
  code: string,
  notBefore = 0,
  diagnostic?: Diagnostic,
) {
  await finishAttempt(ctx, op, code, diagnostic);
  const resume = op.stage === "response" || op.stage === "checkpoint";
  if ((op.recoveryAttempts ?? 0) >= 12) {
    await pauseOperation(ctx, op, "RECOVERY_BUDGET_EXHAUSTED");
    return;
  }
  if (!resume && (op.attempts >= op.maxAttempts || (uncertain && !op.task.reconciler))) {
    await pauseOperation(ctx, op, uncertain ? "RECONCILIATION_REQUIRED" : "ATTEMPTS_EXHAUSTED");
    return;
  }
  const delay = backoff(op.attempts);
  await ctx.db.patch("operations", op._id, {
    state: uncertain ? "reconciling" : "retry_wait",
    generation: op.generation + 1,
    recoveryAttempts: (op.recoveryAttempts ?? 0) + 1,
    stage: resume ? op.stage : "ready",
    uncertain,
    leaseUntil: 0,
    ...delay,
    nextAttemptAt: Math.max(
      op.nextAttemptAt,
      notBefore,
      Date.now() + delay.backoffMs + delay.jitterMs,
    ),
    code,
    updatedAt: Date.now(),
  });
  await auditOperation(ctx, op, code);
  await schedule(ctx, op._id);
}
export function summary(op: Doc<"operations">) {
  return {
    id: String(op._id),
    ...originalId(op),
    state: op.state,
    generation: op.generation,
    attempts: op.attempts,
    nextAttemptAt: ["queued", "retry_wait", "reconciling"].includes(op.state)
      ? op.nextAttemptAt
      : null,
    code: op.code ?? null,
    result: op.state === "succeeded" ? (op.response ?? null) : null,
    uncertain: op.uncertain,
  };
}
