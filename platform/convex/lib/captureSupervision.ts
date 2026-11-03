import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { certificateHead } from "./certificateAccess";
import { CAPTURE_HOUR, type captureAlertKind } from "./captureValues";
import { baseEnvironment } from "./environmentAccess";
import { DAY } from "./operationalAudit";

/**
 * Supervision of the site's production capture (#422). Before it, a customer's capture could stop
 * or ask for attention without Freecorps knowing: only the webhook of the stream's project and
 * the customer's own monitors heard of it. Here every attention of a production stream, and what
 * a periodic check of each released company finds, becomes a Freecorps alert: once per finding
 * (`key`), with a structured log line and, when the deployment names an operational address,
 * one e-mail.
 *
 * The check is scheduled by company, never by cron (ADR 0007, §4; `FNFE_CRONS` stays `off`): the
 * release arms it, it schedules its next run while the release holds, even when its evaluation
 * fails, and stops by itself once the release is withdrawn, as the monitors of `observability.ts`
 * do. Each audited transition of the stream rearms a chain that is gone. It only reads the stream,
 * its operation and the A1; it never queries the source, opens the vault, changes a stream or
 * emits a webhook. A deployment without released companies has nothing scheduled.
 */

/** Interval of the check of a released company: its thresholds are days apart. */
export const SUPERVISION_INTERVAL = 6 * CAPTURE_HOUR;
/**
 * Days without an answered query that warn before the source suspends the NSU generation of a
 * CNPJ not queried for 60 days (ADR 0007, Consequências). The most severe first.
 */
export const QUIET_DAYS = [50, 30] as const;
/**
 * Days since the last answered query before an open gap: the source keeps a document for 90 days
 * after its reception (NT 2014.002, §3), so the oldest document of the gap starts to leave it
 * about then.
 */
export const GAP_WARNING_DAYS = 80;
/** Days left on the company's A1 that warn; 0 is expired or missing. The most severe first. */
export const CERTIFICATE_DAYS = [0, 7, 30] as const;
/** How long an operation of an active stream may stay without moving on before it is stalled. */
export const STALL_GRACE = CAPTURE_HOUR;
/** Alert e-mails handed to the provider in any hour, for the whole deployment. */
export const ALERT_MAIL_HOURLY_LIMIT = 20;

export type CaptureAlertKind = Infer<typeof captureAlertKind>;
export type CaptureFinding = {
  kind: CaptureAlertKind;
  key: string;
  streamId?: Id<"captureStreams">;
  code?: string;
  days?: number;
  streamState?: Doc<"captureStreams">["state"];
};

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
/**
 * Where the alert e-mails go: `FNFE_CAPTURE_ALERT_EMAIL` (one to five addresses, separated by
 * commas), sent through the hosted site's Email Sending (`EMAIL_MODE=cloudflare`, with
 * `CLOUDFLARE_EMAIL_API_TOKEN` and `ACCOUNT_EMAIL_FROM`). Only the hosted installation sends;
 * anything missing or malformed leaves the alerts `unconfigured`, still logged and listed.
 */
export function captureAlertDestination() {
  if (process.env.APP_ENV !== "installation" || process.env.EMAIL_MODE !== "cloudflare")
    return null;
  const to = (process.env.FNFE_CAPTURE_ALERT_EMAIL ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  const from = process.env.ACCOUNT_EMAIL_FROM ?? "";
  const apiKey = process.env.CLOUDFLARE_EMAIL_API_TOKEN ?? "";
  if (
    to.length < 1 ||
    to.length > 5 ||
    to.some((address) => !EMAIL.test(address)) ||
    !EMAIL.test(from) ||
    apiKey.length < 20
  )
    return null;
  return { to, from, apiKey };
}

/**
 * Records a Freecorps alert once per `key`: a repeated finding, a second run of the check or a
 * retried transaction add nothing. The log line is the metric: one `capture_alert` per alert, by
 * kind and code (a 656 is the attention `SOURCE_CONSUMPTION_BLOCKED`). It carries ids and codes,
 * never the CNPJ or the company's name.
 */
export async function raiseCaptureAlert(
  ctx: MutationCtx,
  company: Pick<Doc<"companies">, "_id" | "organizationId">,
  finding: CaptureFinding,
) {
  const existing = await ctx.db
    .query("captureAlerts")
    .withIndex("by_key", (q) => q.eq("key", finding.key))
    .first();
  if (existing) return null;
  const destination = captureAlertDestination();
  const createdAt = Date.now();
  const alertId = await ctx.db.insert("captureAlerts", {
    organizationId: company.organizationId,
    companyId: company._id,
    ...finding,
    delivery: destination ? "pending" : "unconfigured",
    createdAt,
  });
  console.warn(
    JSON.stringify({
      type: "capture_alert",
      alertId,
      kind: finding.kind,
      code: finding.code ?? null,
      days: finding.days ?? null,
      streamState: finding.streamState ?? null,
      organizationId: company.organizationId,
      companyId: company._id,
      streamId: finding.streamId ?? null,
      delivery: destination ? "pending" : "unconfigured",
    }),
  );
  if (destination) await ctx.scheduler.runAfter(0, internal.captureSupervisor.deliver, { alertId });
  return alertId;
}

/**
 * Arms the company's check unless one is already scheduled or running. `delay` 0 checks now, as
 * the release does. Returns whether it scheduled a new one. A stale scheduled run of an older
 * generation finds another generation and does nothing, so arming twice never runs two chains.
 */
export async function superviseCompany(
  ctx: MutationCtx,
  company: Pick<Doc<"companies">, "_id" | "organizationId">,
  delay = 0,
) {
  const row = await ctx.db
    .query("captureSupervision")
    .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
    .unique();
  if (row?.scheduledId) {
    const job = await ctx.db.system.get("_scheduled_functions", row.scheduledId);
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return false;
  }
  const generation = (row?.generation ?? 0) + 1;
  const scheduledId = await ctx.scheduler.runAfter(delay, internal.captureSupervisor.check, {
    companyId: company._id,
    generation,
  });
  if (row) await ctx.db.patch("captureSupervision", row._id, { generation, scheduledId });
  else
    await ctx.db.insert("captureSupervision", {
      organizationId: company.organizationId,
      companyId: company._id,
      generation,
      scheduledId,
    });
  return true;
}

/** Whether `stream` is a production stream of the hosted site, where production is a release. */
export function siteProductionStream(stream: Pick<Doc<"captureStreams">, "environment">) {
  return stream.environment === "production" && baseEnvironment() === "sandbox";
}

/**
 * The Freecorps signal of an attention (#422): the stream just moved to attention with `code`,
 * at `version`. Only production streams of the site; sandbox and the #50 target have no release.
 * The audit of the transition (`captureAudit`) has already rearmed the company's check.
 */
export async function attentionSignal(ctx: MutationCtx, stream: Doc<"captureStreams">) {
  if (!siteProductionStream(stream)) return;
  const company = { _id: stream.companyId, organizationId: stream.organizationId };
  await raiseCaptureAlert(ctx, company, {
    kind: "attention",
    key: `attention:${stream._id}:${stream.version}`,
    streamId: stream._id,
    ...(stream.code ? { code: stream.code } : {}),
    streamState: stream.state,
  });
}

/**
 * Why an active stream is not moving, or null: no current operation, an operation paused or
 * failed (which #418 turns into attention, so this is a fault), a succeeded one that was never
 * continued, or one whose turn passed long ago without a claim.
 */
function stallOf(
  stream: Doc<"captureStreams">,
  op: Doc<"operations"> | null,
  now: number,
): string | null {
  if (stream.state !== "active") return null;
  if (!op || op._id !== stream.operationId) return "OPERATION_MISSING";
  if (op.state === "paused" || op.state === "failed") return op.code ?? op.state.toUpperCase();
  if (op.state === "succeeded" && op.updatedAt < now - STALL_GRACE) return "NOT_CONTINUED";
  if ((op.state === "queued" || op.state === "retry_wait") && op.nextAttemptAt < now - STALL_GRACE)
    return "OVERDUE";
  return null;
}

/**
 * What the check finds for a released company now, each finding with the key that makes it
 * happen once: per stream version and operation state for a stall, per quiet period (from the
 * last answered query) and threshold, per gap, per certificate and threshold. Only the most
 * severe threshold of a kind is reported, so a company released with five days left on its A1
 * gets the 7-day alert, not also the 30-day one. Paused and attention streams count too: a paused
 * capture is still a CNPJ the source stops serving after 60 days.
 */
export async function supervisionFindings(
  ctx: QueryCtx,
  company: Doc<"companies">,
  now = Date.now(),
): Promise<CaptureFinding[]> {
  const findings: CaptureFinding[] = [];
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", company._id).eq("environment", "production"),
    )
    .first();
  if (stream && stream.organizationId === company.organizationId) {
    const base = { streamId: stream._id, streamState: stream.state };
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    const stall = stallOf(stream, op, now);
    if (stall)
      findings.push({
        ...base,
        kind: "stalled",
        key: `stalled:${stream._id}:${stream.version}:${op?._id ?? "none"}:${op?.state ?? "none"}`,
        code: stall,
      });
    const lastQuery = stream.lastSuccessAt ?? stream.createdAt;
    const quiet = QUIET_DAYS.find((days) => now - lastQuery >= days * DAY);
    if (quiet !== undefined)
      findings.push({
        ...base,
        kind: "quiet",
        key: `quiet:${stream._id}:${quiet}:${lastQuery}`,
        days: quiet,
        ...(stream.code ? { code: stream.code } : {}),
      });
    const gapSince = stream.recovery
      ? (stream.recovery.quietSince ?? stream.recovery.detectedAt)
      : null;
    if (stream.recovery && gapSince !== null && now - gapSince >= GAP_WARNING_DAYS * DAY)
      findings.push({
        ...base,
        kind: "gap",
        key: `gap:${stream._id}:${stream.recovery.detectedAt}`,
        days: Math.floor((now - gapSince) / DAY),
      });
  }
  const head = await certificateHead(ctx, company._id);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  // The company's own A1, valid or not: `ownCertificate` without the date, which `left` measures.
  const own =
    cert?.metadata &&
    cert.companyId === company._id &&
    cert.organizationId === company.organizationId &&
    cert.state === "active" &&
    cert.metadata.cnpj === company.cnpj
      ? { id: cert._id, notAfter: cert.metadata.notAfter }
      : null;
  const left = own ? own.notAfter - now : 0;
  const threshold = CERTIFICATE_DAYS.find((days) => left <= days * DAY);
  if (threshold !== undefined)
    findings.push({
      kind: "certificate",
      // Without an own A1, the certificate that left the head (or none ever sent) names the
      // loss, so losing a second one alerts again.
      key: `certificate:${company._id}:${own?.id ?? `none-${head?.activeId ?? head?.latestId ?? "never"}`}:${threshold}`,
      days: threshold,
    });
  return findings;
}
