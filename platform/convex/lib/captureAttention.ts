import { recordAudit } from "./operationalAudit";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { emitEvent } from "./webhookOutbox";
import { attentionSignal, siteProductionStream, superviseCompany } from "./captureSupervision";
import { fiscalCaptureEnabled } from "./fiscalCaptureRelease";
import { siteCaptureProfile } from "./siteCapture";

/**
 * Attention of a capture stream and its automatic resumption. Kept apart from `captureCore.ts`
 * so that `operationCore.ts` can turn a paused capture operation into attention without an
 * import cycle.
 */
export async function captureAudit(
  ctx: MutationCtx,
  stream: Doc<"captureStreams">,
  action: string,
  actor = "system",
  batchId?: Id<"captureBatches">,
  lost?: Doc<"captureAudit">["lost"],
) {
  await recordAudit(ctx, {
    organizationId: stream.organizationId,
    projectId: stream.projectId,
    companyId: stream.companyId,
    environment: stream.environment,
    actor,
    action: `capture.${action}`,
    target: stream._id,
    operationId: stream.operationId,
    code: stream.code,
  });
  await ctx.db.insert("captureAudit", {
    streamId: stream._id,
    organizationId: stream.organizationId,
    action,
    actor,
    checkpoint: stream.checkpoint,
    ...(batchId ? { batchId } : {}),
    ...(lost ? { lost } : {}),
    createdAt: Date.now(),
  });
  // Every audited transition of a site production stream rearms the company's check when its
  // chain is gone (#422): one read while a run is scheduled, which is nearly always.
  if (siteProductionStream(stream))
    await superviseCompany(ctx, { _id: stream.companyId, organizationId: stream.organizationId });
}

/**
 * Whether a production stream of the site stops with `code` because the Freecorps cut the capture
 * by variable (runbook "Corte por variável", #601), read with the reading that gave the code
 * (the worker's, or the transaction moving the stream to attention): without
 * `FNFE_CAPTURE_FISCAL` the release reads as withdrawn and the query stops with `ACCESS_REVOKED`;
 * a query claimed without either variable stops with `FISCAL_TRANSPORT_DISABLED`. With both
 * variables present, those codes are a real loss of access or a misconfigured deployment, never
 * the cut. A real revocation during the cut is marked as the cut too: the console then offers
 * "Retomar captura", which a revoked access needed anyway, and the resume checks everything again.
 */
export function cutByVariable(stream: Pick<Doc<"captureStreams">, "environment">, code: string) {
  if (process.env.APP_ENV !== "installation" || !siteProductionStream(stream)) return false;
  const fiscalCut = !fiscalCaptureEnabled();
  if (code === "ACCESS_REVOKED") return fiscalCut;
  if (code === "FISCAL_TRANSPORT_DISABLED")
    return fiscalCut || process.env.FNFE_CAPTURE_TRANSPORT !== "sefaz";
  return false;
}

/**
 * The mark written with an attention: the `cut` decided by whoever read the variables together
 * with the code (`captureWorker` decides `FISCAL_TRANSPORT_DISABLED` in an action and the vault
 * decides `ACCESS_REVOKED` in `certificateUse`, and the variables may be written again before
 * this mutation runs), or else this transaction's own
 * reading. Only a cut code of a site production stream carries the mark, whatever `cut` says.
 */
function freecorpsCutOf(stream: Doc<"captureStreams">, code: string, cut?: boolean) {
  return (
    (code === "ACCESS_REVOKED" || code === "FISCAL_TRANSPORT_DISABLED") &&
    process.env.APP_ENV === "installation" &&
    siteProductionStream(stream) &&
    (cut ?? cutByVariable(stream, code))
  );
}

/**
 * The console's reading of a stream (#601): in attention because of the Freecorps cut, with the
 * capture switched on again, so "Retomar captura" is all it needs. While a variable is still
 * missing the console keeps the code's own words: a resume would stop again.
 */
export function stoppedByCut(stream: Doc<"captureStreams">) {
  return (
    stream.state === "attention" &&
    stream.freecorpsCut === true &&
    (stream.code === "ACCESS_REVOKED" || stream.code === "FISCAL_TRANSPORT_DISABLED") &&
    siteCaptureProfile()
  );
}

/**
 * Moves the stream to attention with `code` and emits `connection.attention_required` through
 * the outbox, keyed by the new stream version. The same code twice is one transition and one
 * event. On the site, a production attention is also a Freecorps alert (#422,
 * `attentionSignal`), once per transition. `cut` is the caller's reading of the Freecorps cut
 * (`freecorpsCutOf`), when the code was decided in another transaction.
 */
export async function captureAttention(
  ctx: MutationCtx,
  stream: Doc<"captureStreams">,
  code: string,
  cut?: boolean,
) {
  if (stream.state === "attention" && stream.code === code) return;
  const version = stream.version + 1;
  await ctx.db.patch("captureStreams", stream._id, {
    state: "attention",
    code,
    version,
    freecorpsCut: freecorpsCutOf(stream, code, cut) || undefined,
    // A stop of any kind ends the run of 999 (#195): the resume after it gets the retries again.
    sourceErrors: undefined,
  });
  // The audit and the signal record the stream as it is now: in attention, with the new code.
  const updated = (await ctx.db.get("captureStreams", stream._id))!;
  await captureAudit(ctx, updated, code);
  await emitEvent(ctx, {
    organizationId: stream.organizationId,
    companyId: stream.companyId,
    projectId: stream.projectId,
    environment: stream.environment,
    type: "connection.attention_required",
    resourceType: "connection",
    resourceId: stream._id,
    resourceVersion: version,
    logicalKey: `connection:${stream._id}:${version}`,
    operationIds: stream.operationId ? [stream.operationId] : [],
  });
  await attentionSignal(ctx, updated);
}

/** The stream a capture operation queries for, from the request the server built. */
export async function streamOfOperation(ctx: MutationCtx, op: Doc<"operations">) {
  let streamId: unknown;
  try {
    streamId = (JSON.parse(op.request) as { streamId?: unknown }).streamId;
  } catch {
    return null;
  }
  const id = typeof streamId === "string" ? ctx.db.normalizeId("captureStreams", streamId) : null;
  const stream = id ? await ctx.db.get("captureStreams", id) : null;
  return stream &&
    stream.operationId === op._id &&
    stream.organizationId === op.organizationId &&
    stream.companyId === op.companyId &&
    stream.environment === op.environment
    ? stream
    : null;
}

/**
 * A paused capture operation tells it on its stream (#418): the stream it runs goes to attention
 * with the pause code. Only the operation the stream is running, and only while the stream is
 * active: a paused stream or an older operation stays as it is.
 */
export async function operationAttention(
  ctx: MutationCtx,
  op: Doc<"operations">,
  code: string,
  cut?: boolean,
) {
  const stream = await streamOfOperation(ctx, op);
  if (stream?.state === "active") await captureAttention(ctx, stream, code, cut);
}

/** Plan pauses: the quota of the period, the plan's term or a production capture without one (#429). */
export const USAGE_PAUSES: readonly string[] = [
  "QUOTA_EXCEEDED",
  "PLAN_INACTIVE",
  "PLAN_REQUIRED",
  "CAPACITY_INVENTORY_REQUIRED",
];
/** Attention codes the server resumes by itself once their cause is gone (`resumeEligible`). */
export const RESUMABLE_PAUSES: readonly string[] = [...USAGE_PAUSES, "CERTIFICATE_UNAVAILABLE"];

/**
 * Schedules the automatic resumption check of a stream in attention, for its current version: a
 * person's action in the meantime (resume, pause, transfer) changes the version and the check
 * does nothing. Scheduled by stream, never by cron (ADR 0007, §4).
 */
export async function scheduleResume(ctx: MutationCtx, stream: Doc<"captureStreams">, at: number) {
  await ctx.scheduler.runAt(at, internal.captureProcessing.resumeEligible, {
    streamId: stream._id,
    version: stream.version,
  });
}

/** A production stream of the company in attention for one of `codes` is checked again now. */
export async function resumeCompanyCapture(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  codes: readonly string[],
) {
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", companyId).eq("environment", "production"),
    )
    .unique();
  if (stream?.state === "attention" && stream.code && codes.includes(stream.code))
    await scheduleResume(ctx, stream, Date.now());
}

/** Upper bound of streams read when a plan changes: two per company, far above real use. */
const ORGANIZATION_STREAMS = 500;
/** The organization's production streams in attention for one of `codes` are checked again now. */
export async function resumeOrganizationCaptures(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  codes: readonly string[],
) {
  const streams = await ctx.db
    .query("captureStreams")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(ORGANIZATION_STREAMS);
  for (const stream of streams)
    if (
      stream.environment === "production" &&
      stream.state === "attention" &&
      stream.code &&
      codes.includes(stream.code)
    )
      await scheduleResume(ctx, stream, Date.now());
}
