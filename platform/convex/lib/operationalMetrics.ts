import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CAPTURE_HOUR, releaseIntervalHours } from "./captureValues";
import { captureRelease } from "./fiscalCaptureRelease";
import type { Doc } from "../_generated/dataModel";
import type { Infer } from "convex/values";
import { metric } from "./observabilitySchema";
import { OPERATION_SOURCES } from "./operationSources";
import { certificateHead } from "./certificateAccess";
import { DAY } from "./operationalAudit";
import { MAX_ENDPOINTS } from "./webhookValues";

export const defaultThresholds = {
  queue: 300_000,
  lease: 1,
  cursor: 2 * 60 * 60_000,
  source: 3,
  webhook: 900_000,
  certificate: 30 * DAY,
};
/**
 * The thresholds a monitor is evaluated with (#421). In production on the site, a capture at the
 * end of the queue waits the company's minimum interval (1 to 24 h) between two successes, so
 * the cursor threshold is at least that interval plus one source hour: the same margin the 2 h
 * default keeps over the 1 h interval, enough for scheduling and one lost window (a 108/109,
 * or a query held by the hourly ceiling) before the alert. A larger configured value stays.
 */
export async function effectiveThresholds(
  ctx: QueryCtx,
  scope: Doc<"operationalMonitors">,
): Promise<Doc<"operationalMonitors">["thresholds"]> {
  if (scope.environment !== "production") return scope.thresholds;
  const company = await ctx.db.get("companies", scope.companyId);
  const release =
    company?.organizationId === scope.organizationId ? await captureRelease(ctx, company) : null;
  if (!release) return scope.thresholds;
  const floor = (releaseIntervalHours(release.minIntervalHours) + 1) * CAPTURE_HOUR;
  return { ...scope.thresholds, cursor: Math.max(scope.thresholds.cursor, floor) };
}
export async function operationalMetrics(
  ctx: MutationCtx,
  scope: Doc<"operationalMonitors">,
  now: number,
): Promise<Infer<typeof metric>[]> {
  // One row beyond the threshold proves firing and identifies an incomplete count.
  // Reading up to 101 for every default threshold multiplies the cost of each minute.
  const leaseLimit = Math.min(101, scope.thresholds.lease + 1);
  const sourceLimit = Math.min(101, scope.thresholds.source + 1);
  const queued = await Promise.all(
    (["queued", "retry_wait", "reconciling"] as const).map((state) =>
      ctx.db
        .query("operations")
        .withIndex("by_projectId_companyId_environment_state_nextAttemptAt", (q) =>
          q
            .eq("projectId", scope.projectId)
            .eq("companyId", scope.companyId)
            .eq("environment", scope.environment)
            .eq("state", state)
            .lte("nextAttemptAt", now),
        )
        .first(),
    ),
  );
  const oldest = queued
    .filter((op) => op !== null)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
  const expired = await ctx.db
    .query("operations")
    .withIndex("by_projectId_companyId_environment_state_leaseUntil", (q) =>
      q
        .eq("projectId", scope.projectId)
        .eq("companyId", scope.companyId)
        .eq("environment", scope.environment)
        .eq("state", "running")
        .lte("leaseUntil", now),
    )
    .take(leaseLimit);
  const sources = await Promise.all(
    OPERATION_SOURCES.map(async (source) => {
      const failures = await ctx.db
        .query("operationalFailures")
        .withIndex("by_projectId_companyId_environment_source_createdAt", (q) =>
          q
            .eq("projectId", scope.projectId)
            .eq("companyId", scope.companyId)
            .eq("environment", scope.environment)
            .eq("source", source)
            .gte("createdAt", now - 3_600_000),
        )
        .take(sourceLimit);
      return {
        source,
        count: failures.length,
        capped: failures.length === sourceLimit,
        target: failures[0]?.operationId,
      };
    }),
  );
  const worstSource = [...sources].sort((a, b) => b.count - a.count)[0]!;
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", scope.companyId).eq("environment", scope.environment),
    )
    .unique();
  const ownedStream =
    stream?.projectId === scope.projectId && stream.organizationId === scope.organizationId
      ? stream
      : null;
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_projectId_and_companyId_and_environment", (q) =>
      q
        .eq("projectId", scope.projectId)
        .eq("companyId", scope.companyId)
        .eq("environment", scope.environment),
    )
    .take(MAX_ENDPOINTS + 1);
  let delivery: Doc<"webhookDeliveries"> | null = null;
  const candidates = await Promise.all(
    endpoints.slice(0, MAX_ENDPOINTS).flatMap((endpoint) =>
      (["queued", "running", "retry_wait", "failed", "paused"] as const).map((state) =>
        ctx.db
          .query("webhookDeliveries")
          .withIndex("by_endpointId_and_state_and_createdAt", (q) =>
            q.eq("endpointId", endpoint._id).eq("state", state),
          )
          .first(),
      ),
    ),
  );
  for (const candidate of candidates)
    if (candidate && (!delivery || candidate.createdAt < delivery.createdAt)) delivery = candidate;
  const head = await certificateHead(ctx, scope.companyId);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  return [
    {
      kind: "queue",
      value: oldest ? now - oldest.nextAttemptAt : 0,
      capped: false,
      target: oldest?._id ?? "queue",
    },
    {
      kind: "lease",
      value: expired.length,
      capped: expired.length === leaseLimit,
      target: expired[0]?._id ?? "lease",
    },
    {
      kind: "cursor",
      value: ownedStream ? now - (ownedStream.lastSuccessAt ?? ownedStream.createdAt) : null,
      capped: false,
      target: ownedStream?._id ?? "cursor",
    },
    {
      kind: "source",
      value: worstSource.count,
      capped: worstSource.capped,
      target: worstSource.target ?? "source",
      sources: sources.map(({ source, count, capped }) => ({ source, count, capped })),
    },
    {
      kind: "webhook",
      value: delivery ? now - delivery.createdAt : 0,
      capped: endpoints.length > MAX_ENDPOINTS,
      target: delivery?._id ?? "webhook",
    },
    {
      kind: "certificate",
      value: cert?.metadata ? cert.metadata.notAfter - now : null,
      capped: false,
      target: cert?._id ?? "certificate",
    },
  ];
}
