import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { importTask } from "./importValues";
import { scopeFields } from "./operationValues";
import { firstId } from "./coldArchiveOrigin";
export const CAPTURE_HOUR = 3_600_000;
export const ZERO_NSU = "000000000000000";
/**
 * The company's minimum interval at the end of the queue, in hours (ADR 0007, §4). `enable`
 * validates 1 to 24; a stored value outside it never stalls nor shortens the stream.
 */
export const releaseIntervalHours = (minIntervalHours: number | undefined) =>
  Math.min(24, Math.max(1, Math.trunc(minIntervalHours ?? 1) || 1));
export const captureState = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("attention"),
);
/**
 * What a Freecorps alert of the site's production capture says (#422): an attention of the
 * stream, an active stream whose operation stopped, days without an answered query, a gap close to
 * the source's 90 days, the company's A1 close to expiring, or the check itself failing.
 */
export const captureAlertKind = v.union(
  v.literal("attention"),
  v.literal("stalled"),
  v.literal("quiet"),
  v.literal("gap"),
  v.literal("certificate"),
  v.literal("supervisor"),
);
/**
 * The e-mail of an alert: `unconfigured` without a destination, `suppressed` past the hourly
 * ceiling, `uncertain` when the provider may have accepted it. None is sent again by itself.
 */
export const captureAlertDelivery = v.union(
  v.literal("unconfigured"),
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("uncertain"),
  v.literal("suppressed"),
);
/** `captureAudit` action of a query postponed before the request (#421, #424). */
export const deferralAudit = v.union(
  v.literal("budget_deferred"),
  v.literal("fiscal_halt_deferred"),
  v.literal("terms_deferred"),
  v.literal("query_deferred"),
);
/**
 * The usage key a query charges when it continues no uncertain one: its operation and attempt.
 * One per attempt, so a refund (`refusedBeforeSend`) never blocks the next attempt's charge. A
 * query carrying another key reconciles an uncertain one already admitted (#429). Composed with
 * the operation's first ID (ADR 0009, §5, item 5), so the key survives a rehydration.
 */
export const attemptUsageKey = (op: Doc<"operations">) => `${firstId(op)}:${op.fence}`;
export const captureMode = v.union(v.literal("distNSU"), v.literal("consNSU"));
export const captureTask = {
  name: "connections.sync",
  workload: "capture",
  scope: "connections:write",
  executor: "captureWorker:execute",
  reconciler: "captureWorker:execute",
  checkpoint: "captureProcessing:checkpoint",
  onSucceeded: "captureProcessing:published",
} as const;
/**
 * Processing of a document the capture already stored (`captureEnvelopes.artifactId`): the
 * import executor reads the stored XML and publishes the document, with no source query and no
 * certificate. `captureProcessing.checkpoint` creates it, as a continuation of the query that
 * received the envelope, and the reprocessing of technical refusals (`refusalReprocess.ts`, #499),
 * as a continuation of a person's request; `operations.reserve` refuses it. Its scope stays the capture's,
 * for the grants; the environment it needs is `capture-processing` (`environmentPurpose`), which
 * a withdrawn or cut release still serves (#420).
 */
export const captureProcessingTask = {
  ...importTask,
  name: "documents.capture",
  scope: "connections:write",
} as const;
/** Whether `task` is exactly `captureProcessingTask`, every field: a partial task never is. */
export function isCaptureProcessing(task: Partial<Doc<"operations">["task"]>) {
  return (Object.keys(captureProcessingTask) as (keyof typeof captureProcessingTask)[]).every(
    (field) => task[field] === captureProcessingTask[field],
  );
}
export const captureSummary = v.object({
  id: v.id("captureStreams"),
  ...scopeFields,
  state: captureState,
  version: v.number(),
  checkpoint: v.string(),
  sourceCursor: v.union(v.string(), v.null()),
  sourceMaxNsu: v.union(v.string(), v.null()),
  nextAllowedAt: v.number(),
  lastAttemptAt: v.union(v.number(), v.null()),
  lastSuccessAt: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
  received: v.number(),
  operationId: v.union(v.id("operations"), v.null()),
  operationState: v.union(v.string(), v.null()),
  certificateState: v.string(),
  certificateExpiresAt: v.union(v.number(), v.null()),
});
export const captureControl = v.union(v.literal("sync"), v.literal("pause"), v.literal("resume"));
