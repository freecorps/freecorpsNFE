import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation, internalMutation, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  deny,
  findMembership,
  requireMembership,
  requireManager,
  limitOrganizationAction,
  boundedPagination,
} from "./lib/organizationAccess";
import { recordAudit, safeToken, DAY } from "./lib/operationalAudit";
import { scopeFields } from "./lib/operationValues";
import { thresholds } from "./lib/observabilitySchema";
import {
  defaultThresholds,
  effectiveThresholds,
  operationalMetrics,
} from "./lib/operationalMetrics";
import { authenticateKey } from "./lib/operationAccess";
import { projectGrant } from "./lib/projectAccess";
import { baseEnvironment, environmentServed } from "./lib/environmentAccess";
import { captureReleaseState } from "./lib/fiscalCaptureRelease";
import { humanAccess } from "./lib/operationAccess";
import { operationSummary } from "./lib/operationValues";
import { summary } from "./lib/operationCore";
import { armRetention } from "./lib/operationalRetention";

async function manager(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const access = await requireMembership(ctx, organizationId);
  requireManager(access.membership);
  return access;
}
export const operation = query({
  args: { organizationId: v.id("organizations"), operationId: v.id("operations") },
  returns: operationSummary.omit("result"),
  handler: async (ctx, a) => {
    await manager(ctx, a.organizationId);
    const op = await ctx.db.get("operations", a.operationId);
    if (!op || op.organizationId !== a.organizationId) return deny("NOT_FOUND");
    await humanAccess(ctx, op, false);
    const { result: _result, ...safe } = summary(op);
    return safe;
  },
});
export const audit = query({
  args: {
    organizationId: v.id("organizations"),
    actor: v.optional(v.string()),
    action: v.optional(v.string()),
    from: v.number(),
    until: v.number(),
    paginationOpts: paginationOptsValidator,
    contextKey: v.string(),
  },
  returns: paginationResultValidator(schema.doc("operationalAudit")),
  handler: async (ctx, a) => {
    await manager(ctx, a.organizationId);
    if (
      !Number.isSafeInteger(a.from) ||
      !Number.isSafeInteger(a.until) ||
      a.until < a.from ||
      a.until - a.from > 366 * DAY ||
      (a.actor && !safeToken(a.actor)) ||
      (a.action && !safeToken(a.action))
    )
      deny("INVALID_REQUEST");
    const table = ctx.db.query("operationalAudit");
    const records =
      a.actor && a.action
        ? table.withIndex("by_organizationId_and_actor_and_action_and_createdAt", (q) =>
            q
              .eq("organizationId", a.organizationId)
              .eq("actor", a.actor!)
              .eq("action", a.action!)
              .gte("createdAt", a.from)
              .lte("createdAt", a.until),
          )
        : a.actor
          ? table.withIndex("by_organizationId_and_actor_and_createdAt", (q) =>
              q
                .eq("organizationId", a.organizationId)
                .eq("actor", a.actor!)
                .gte("createdAt", a.from)
                .lte("createdAt", a.until),
            )
          : a.action
            ? table.withIndex("by_organizationId_and_action_and_createdAt", (q) =>
                q
                  .eq("organizationId", a.organizationId)
                  .eq("action", a.action!)
                  .gte("createdAt", a.from)
                  .lte("createdAt", a.until),
              )
            : table.withIndex("by_organizationId_and_createdAt", (q) =>
                q
                  .eq("organizationId", a.organizationId)
                  .gte("createdAt", a.from)
                  .lte("createdAt", a.until),
              );
    return records.order("desc").paginate({
      ...boundedPagination(a.paginationOpts),
      maximumRowsRead: Math.min(a.paginationOpts.maximumRowsRead ?? 100, 100),
      maximumBytesRead: Math.min(a.paginationOpts.maximumBytesRead ?? 1_048_576, 1_048_576),
    });
  },
});
export const investigate = query({
  args: { organizationId: v.id("organizations"), reference: v.string(), contextKey: v.string() },
  returns: v.array(schema.doc("operationalAudit")),
  handler: async (ctx, a) => {
    await manager(ctx, a.organizationId);
    if (!safeToken(a.reference)) return [];
    const op = ctx.db.normalizeId("operations", a.reference);
    const [requests, events, operations, targets] = await Promise.all([
      ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_requestId", (q) =>
          q.eq("organizationId", a.organizationId).eq("requestId", a.reference),
        )
        .take(25),
      ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_eventId", (q) =>
          q.eq("organizationId", a.organizationId).eq("eventId", a.reference),
        )
        .take(25),
      op
        ? ctx.db
            .query("operationalAudit")
            .withIndex("by_organizationId_and_operationId", (q) =>
              q.eq("organizationId", a.organizationId).eq("operationId", op),
            )
            .take(50)
        : [],
      ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_target", (q) =>
          q.eq("organizationId", a.organizationId).eq("target", a.reference),
        )
        .take(25),
    ]);
    const linked = [...requests, ...events, ...targets].find((row) => row.operationId)?.operationId;
    const linkedRows =
      linked && linked !== op
        ? await ctx.db
            .query("operationalAudit")
            .withIndex("by_organizationId_and_operationId", (q) =>
              q.eq("organizationId", a.organizationId).eq("operationId", linked),
            )
            .take(50)
        : [];
    const eventIds = [
      ...new Set(
        [...requests, ...operations, ...linkedRows].flatMap((row) =>
          row.eventId ? [row.eventId] : [],
        ),
      ),
    ].slice(0, 5);
    const eventRows = (
      await Promise.all(
        eventIds.map((eventId) =>
          ctx.db
            .query("operationalAudit")
            .withIndex("by_organizationId_and_eventId", (q) =>
              q.eq("organizationId", a.organizationId).eq("eventId", eventId),
            )
            .take(25),
        ),
      )
    ).flat();
    return [
      ...new Map(
        [...requests, ...events, ...operations, ...targets, ...linkedRows, ...eventRows].map(
          (row) => [row._id, row],
        ),
      ).values(),
    ]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 100);
  },
});
const resolvedName = v.object({ ref: v.string(), name: v.string() });
/**
 * Resolves audit actors, companies and projects to display names, only inside the requested
 * organization. A reference from another organization, or one that no longer exists, is simply
 * absent from the answer, so the console falls back to a generic label without learning anything.
 */
async function actorName(ctx: QueryCtx, organizationId: Id<"organizations">, actor: string) {
  const split = actor.indexOf(":");
  const prefix = split < 0 ? "" : actor.slice(0, split),
    rest = split < 0 ? actor : actor.slice(split + 1);
  if (prefix === "key") {
    const id = ctx.db.normalizeId("apiKeys", rest);
    const key = id ? await ctx.db.get("apiKeys", id) : null;
    return key?.organizationId === organizationId ? key.name : null;
  }
  if (prefix === "" || prefix === "member" || prefix === "membership") {
    const id = ctx.db.normalizeId("memberships", rest);
    const member = id ? await ctx.db.get("memberships", id) : null;
    if (member) return member.organizationId === organizationId ? member.name : null;
  }
  if (prefix === "" || prefix === "user") {
    const member = await findMembership(ctx, organizationId, rest);
    return member?.name ?? null;
  }
  return null;
}
export const names = query({
  args: {
    organizationId: v.id("organizations"),
    contextKey: v.string(),
    actors: v.array(v.string()),
    companyIds: v.array(v.string()),
    projectIds: v.array(v.string()),
  },
  returns: v.object({
    actors: v.array(resolvedName),
    companies: v.array(resolvedName),
    projects: v.array(resolvedName),
  }),
  handler: async (ctx, a) => {
    await manager(ctx, a.organizationId);
    const unique = (refs: string[]) => [...new Set(refs)].filter((ref) => safeToken(ref));
    const [actors, companyIds, projectIds] = [
      unique(a.actors),
      unique(a.companyIds),
      unique(a.projectIds),
    ];
    if (actors.length > 100 || companyIds.length > 100 || projectIds.length > 100)
      deny("INVALID_REQUEST");
    const named = (ref: string, name: string | null | undefined) => (name ? [{ ref, name }] : []);
    const [actorNames, companies, projects] = await Promise.all([
      Promise.all(
        actors.map(async (ref) => named(ref, await actorName(ctx, a.organizationId, ref))),
      ),
      Promise.all(
        companyIds.map(async (ref) => {
          const id = ctx.db.normalizeId("companies", ref);
          const company = id ? await ctx.db.get("companies", id) : null;
          return named(ref, company?.organizationId === a.organizationId ? company.name : null);
        }),
      ),
      Promise.all(
        projectIds.map(async (ref) => {
          const id = ctx.db.normalizeId("projects", ref);
          const project = id ? await ctx.db.get("projects", id) : null;
          return named(ref, project?.organizationId === a.organizationId ? project.name : null);
        }),
      ),
    ]);
    return { actors: actorNames.flat(), companies: companies.flat(), projects: projects.flat() };
  },
});
export const overview = query({
  args: { organizationId: v.id("organizations"), contextKey: v.string() },
  returns: v.object({
    monitors: v.array(schema.doc("operationalMonitors")),
    alerts: v.array(schema.doc("operationalAlerts")),
    notifications: v.array(schema.doc("operationalNotifications")),
    defaults: thresholds,
  }),
  handler: async (ctx, a) => {
    await manager(ctx, a.organizationId);
    const [monitors, alerts, notifications] = await Promise.all([
      ctx.db
        .query("operationalMonitors")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", a.organizationId))
        .take(20),
      ctx.db
        .query("operationalAlerts")
        .withIndex("by_organizationId_and_state", (q) =>
          q.eq("organizationId", a.organizationId).eq("state", "open"),
        )
        .take(120),
      ctx.db
        .query("operationalNotifications")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", a.organizationId))
        .order("desc")
        .take(20),
    ]);
    return { monitors, alerts, notifications, defaults: defaultThresholds };
  },
});
export const configure = mutation({
  args: {
    ...scopeFields,
    ownerMembershipId: v.id("memberships"),
    enabled: v.boolean(),
    notify: v.boolean(),
    thresholds,
    expectedGeneration: v.number(),
  },
  returns: v.id("operationalMonitors"),
  handler: async (ctx, a) => {
    const { user } = await manager(ctx, a.organizationId);
    await limitOrganizationAction(ctx, "monitor-configure", a.organizationId);
    const [owner, project, company, grant] = await Promise.all([
      ctx.db.get("memberships", a.ownerMembershipId),
      ctx.db.get("projects", a.projectId),
      ctx.db.get("companies", a.companyId),
      projectGrant(ctx, a.projectId, a.companyId),
    ]);
    if (
      !owner ||
      owner.organizationId !== a.organizationId ||
      owner.state !== "active" ||
      !["owner", "admin"].includes(owner.role) ||
      project?.organizationId !== a.organizationId ||
      company?.organizationId !== a.organizationId ||
      !grant?.active ||
      !grant.environments.includes(a.environment) ||
      !(await environmentServed(ctx, company, a.environment, "observability"))
    )
      deny("NOT_FOUND");
    if (
      Object.values(a.thresholds).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      a.thresholds.lease > 100 ||
      a.thresholds.source > 100 ||
      [
        a.thresholds.queue,
        a.thresholds.cursor,
        a.thresholds.webhook,
        a.thresholds.certificate,
      ].some((n) => n > 365 * DAY)
    )
      deny("INVALID_REQUEST");
    const existing = await ctx.db
      .query("operationalMonitors")
      .withIndex("by_projectId_and_companyId_and_environment", (q) =>
        q
          .eq("projectId", a.projectId)
          .eq("companyId", a.companyId)
          .eq("environment", a.environment),
      )
      .unique();
    if ((existing?.generation ?? 0) !== a.expectedGeneration) deny("OPERATION_CONFLICT");
    if (
      !existing &&
      (
        await ctx.db
          .query("operationalMonitors")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", a.organizationId))
          .take(20)
      ).length >= 20
    )
      deny("RATE_LIMITED");
    if (existing?.scheduledId) await ctx.scheduler.cancel(existing.scheduledId);
    const { expectedGeneration, ...fields } = a;
    const generation = expectedGeneration + 1;
    const id =
      existing?._id ??
      (await ctx.db.insert("operationalMonitors", {
        ...fields,
        generation,
        metrics: [],
        createdAt: Date.now(),
      }));
    if (existing)
      await ctx.db.patch("operationalMonitors", id, {
        ...fields,
        generation,
        scheduledId: undefined,
        stopped: undefined,
      });
    if (a.enabled) {
      const scheduledId = await ctx.scheduler.runAfter(0, internal.observability.evaluate, {
        monitorId: id,
        generation,
      });
      await ctx.db.patch("operationalMonitors", id, { scheduledId });
    }
    await recordAudit(ctx, {
      organizationId: a.organizationId,
      projectId: a.projectId,
      companyId: a.companyId,
      environment: a.environment,
      actor: user._id,
      action: "monitor.configured",
      target: id,
    });
    return id;
  },
});
export const remove = mutation({
  args: {
    organizationId: v.id("organizations"),
    monitorId: v.id("operationalMonitors"),
    expectedGeneration: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await manager(ctx, a.organizationId);
    const monitor = await ctx.db.get("operationalMonitors", a.monitorId);
    if (!monitor || monitor.organizationId !== a.organizationId) return deny("NOT_FOUND");
    if (monitor.enabled || monitor.generation !== a.expectedGeneration)
      return deny("OPERATION_CONFLICT");
    if (monitor.scheduledId) await ctx.scheduler.cancel(monitor.scheduledId);
    const alerts = await ctx.db
      .query("operationalAlerts")
      .withIndex("by_monitorId_and_kind", (q) => q.eq("monitorId", monitor._id))
      .take(6);
    for (const alert of alerts) await ctx.db.delete("operationalAlerts", alert._id);
    await ctx.db.delete("operationalMonitors", monitor._id);
    await recordAudit(ctx, {
      ...monitor,
      actor: user._id,
      action: "monitor.removed",
      target: monitor._id,
    });
    return null;
  },
});
export const evaluate = internalMutation({
  args: { monitorId: v.id("operationalMonitors"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const monitor = await ctx.db.get("operationalMonitors", a.monitorId);
    if (!monitor?.enabled || monitor.generation !== a.generation) return null;
    const owner = await ctx.db.get("memberships", monitor.ownerMembershipId);
    const project = await ctx.db.get("projects", monitor.projectId);
    const grant = await projectGrant(ctx, monitor.projectId, monitor.companyId);
    const company = await ctx.db.get("companies", monitor.companyId);
    if (
      !company ||
      !(await environmentServed(ctx, company, monitor.environment, "observability")) ||
      !owner ||
      owner.state !== "active" ||
      !["owner", "admin"].includes(owner.role) ||
      owner.organizationId !== monitor.organizationId ||
      project?.state !== "active" ||
      !grant?.active ||
      !grant.environments.includes(monitor.environment)
    ) {
      // The panel says why the monitor stopped (#422): a production monitor of a company whose
      // fiscal capture was withdrawn stops with the release, any other loss of access is revoked.
      const code =
        company &&
        monitor.environment === "production" &&
        baseEnvironment() === "sandbox" &&
        (await captureReleaseState(ctx, company)) !== "released"
          ? "CAPTURE_RELEASE_WITHDRAWN"
          : "ACCESS_REVOKED";
      await ctx.db.patch("operationalMonitors", monitor._id, {
        enabled: false,
        generation: monitor.generation + 1,
        scheduledId: undefined,
        stopped: { code, at: Date.now() },
      });
      await recordAudit(ctx, {
        organizationId: monitor.organizationId,
        actor: "system",
        action: "monitor.access_revoked",
        target: monitor._id,
        code,
      });
      return null;
    }
    const now = Date.now(),
      metrics = await operationalMetrics(ctx, monitor, now),
      limits = await effectiveThresholds(ctx, monitor);
    for (const sample of metrics) {
      const threshold = limits[sample.kind];
      if (sample.value === null) continue;
      const firing =
        sample.kind === "certificate" ? sample.value <= threshold : sample.value >= threshold;
      const previous = await ctx.db
        .query("operationalAlerts")
        .withIndex("by_monitorId_and_kind", (q) =>
          q.eq("monitorId", monitor._id).eq("kind", sample.kind),
        )
        .unique();
      if (!firing && sample.capped) continue; // A truncated observation cannot prove recovery.
      if (!firing && previous?.state !== "open") continue;
      if (firing && previous?.state === "open") {
        await ctx.db.patch("operationalAlerts", previous._id, {
          value: sample.value,
          target: sample.target,
          threshold,
        });
        continue;
      }
      const state = firing ? ("open" as const) : ("recovered" as const);
      const notify =
        monitor.notify &&
        (state === "recovered"
          ? previous?.notifiedOpen === true
          : !previous || now - previous.lastNotifiedAt >= 3_600_000);
      const fields = {
        state,
        value: sample.value,
        threshold,
        target: sample.target,
        openedAt: firing ? now : previous!.openedAt,
        recoveredAt: firing ? undefined : now,
        occurrences: (previous?.occurrences ?? 0) + Number(firing),
        lastNotifiedAt: notify ? now : (previous?.lastNotifiedAt ?? 0),
        notifiedOpen: firing && notify,
      };
      const alertId =
        previous?._id ??
        (await ctx.db.insert("operationalAlerts", {
          monitorId: monitor._id,
          organizationId: monitor.organizationId,
          kind: sample.kind,
          ...fields,
        }));
      if (previous) await ctx.db.patch("operationalAlerts", previous._id, fields);
      if (notify) {
        await ctx.db.insert("operationalNotifications", {
          organizationId: monitor.organizationId,
          monitorId: monitor._id,
          alertId,
          transition: state,
          createdAt: now,
          expiresAt: now + 30 * DAY,
        });
        await armRetention(ctx, monitor.organizationId, now + 30 * DAY);
      }
      await recordAudit(ctx, {
        organizationId: monitor.organizationId,
        projectId: monitor.projectId,
        companyId: monitor.companyId,
        environment: monitor.environment,
        actor: "system",
        action: `alert.${state}`,
        target: alertId,
        code: sample.kind,
      });
    }
    // Each invocation consumes its generation; duplicate scheduled invocations become no-ops.
    const generation = monitor.generation + 1;
    const scheduledId = await ctx.scheduler.runAfter(60_000, internal.observability.evaluate, {
      monitorId: monitor._id,
      generation,
    });
    await ctx.db.patch("operationalMonitors", monitor._id, {
      metrics,
      checkedAt: now,
      generation,
      scheduledId,
    });
    return null;
  },
});
export const recordRequest = internalMutation({
  args: {
    keyHash: v.string(),
    requestId: v.string(),
    route: v.string(),
    status: v.number(),
    durationMs: v.number(),
    operationId: v.optional(v.string()),
    eventId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    let key;
    try {
      key = await authenticateKey(ctx, a.keyHash);
    } catch {
      return null;
    }
    let operationId: Id<"operations"> | undefined;
    if (a.status < 400 && a.operationId) {
      const id = ctx.db.normalizeId("operations", a.operationId);
      const operation = id ? await ctx.db.get("operations", id) : null;
      if (
        operation?.organizationId === key.organizationId &&
        operation.projectId === key.projectId &&
        operation.environment === key.environment &&
        key.companyIds.includes(operation.companyId)
      )
        operationId = operation._id;
    }
    let eventId: string | undefined;
    if (a.status < 400 && a.eventId && safeToken(a.eventId, 36)) {
      const event = await ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_eventId", (q) =>
          q.eq("organizationId", key.organizationId).eq("eventId", a.eventId!),
        )
        .take(25);
      if (
        event.some(
          (row) =>
            row.projectId === key.projectId &&
            row.environment === key.environment &&
            row.companyId &&
            key.companyIds.includes(row.companyId),
        )
      )
        eventId = a.eventId;
    }
    await recordAudit(ctx, {
      organizationId: key.organizationId,
      projectId: key.projectId,
      environment: key.environment,
      actor: `key:${key._id}`,
      action: `http.${a.route}`,
      target: operationId ?? key.projectId,
      requestId: a.requestId,
      operationId,
      eventId,
      status: a.status,
      durationMs: a.durationMs,
    });
    return null;
  },
});
