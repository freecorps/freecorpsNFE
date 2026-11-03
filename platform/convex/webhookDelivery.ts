import { recordAudit } from "./lib/operationalAudit";
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { pools } from "./lib/operationCore";
import { endpointAllowed } from "./lib/webhookAccess";
import { MAX_ATTEMPTS, LEASE_MS, MAX_RETRY_AFTER_MS } from "./lib/webhookValues";
const deliveryArgs = { deliveryId: v.id("webhookDeliveries"), generation: v.number() };
import {
  checkUsage,
  recordUsage,
  usageError,
  acquireUsageLease,
  releaseUsageLease,
} from "./lib/usageCore";
export const expireSecret = internalMutation({
  args: { endpointId: v.id("webhookEndpoints"), version: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const e = await ctx.db.get("webhookEndpoints", args.endpointId);
    if (e && e.secretVersion === args.version && (e.previousUntil ?? Infinity) <= Date.now())
      await ctx.db.patch("webhookEndpoints", e._id, {
        previousSecret: undefined,
        previousVersion: undefined,
        previousUntil: undefined,
      });
    return null;
  },
});
export const dispatch = internalMutation({
  args: deliveryArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (
      !d ||
      d.generation !== args.generation ||
      !["queued", "retry_wait"].includes(d.state) ||
      d.nextAttemptAt > Date.now()
    )
      return null;
    await pools.webhook.enqueueAction(ctx, internal.webhookWorker.run, args, { retry: false });
    await ctx.scheduler.runAfter(LEASE_MS * 2, internal.webhookDelivery.recover, args);
    return null;
  },
});
export const claim = internalMutation({
  args: deliveryArgs,
  returns: v.union(
    v.null(),
    v.object({
      endpoint: schema.doc("webhookEndpoints"),
      event: schema.doc("outboxEvents"),
      deliveryId: v.id("webhookDeliveries"),
    }),
  ),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (
      !d ||
      d.generation !== args.generation ||
      !["queued", "retry_wait"].includes(d.state) ||
      d.nextAttemptAt > Date.now()
    )
      return null;
    const e = await ctx.db.get("webhookEndpoints", d.endpointId),
      event = await ctx.db.get("outboxEvents", d.eventId);
    const code =
      !e || !event || !(await endpointAllowed(ctx, e, event.type))
        ? "ACCESS_REVOKED"
        : process.env.WEBHOOK_MODE !== "https"
          ? "DELIVERY_DISABLED"
          : undefined;
    if (code) {
      await ctx.db.patch("webhookDeliveries", d._id, { state: "paused", code });
      return null;
    }
    if (d.cycleAttempts >= MAX_ATTEMPTS) {
      await ctx.db.patch("webhookDeliveries", d._id, {
        state: "failed",
        code: "ATTEMPTS_EXHAUSTED",
      });
      return null;
    }
    const leaseUntil = Date.now() + LEASE_MS;
    try {
      await checkUsage(ctx, e!.organizationId, e!.environment, "deliveries", String(d._id));
    } catch (error) {
      const code = usageError(error);
      if (!code) throw error;
      await ctx.db.patch("webhookDeliveries", d._id, { state: "paused", code });
      return null;
    }
    if (!(await acquireUsageLease(ctx, e!.organizationId, String(d._id), leaseUntil))) {
      const nextAttemptAt = Date.now() + 1000;
      await ctx.db.patch("webhookDeliveries", d._id, { nextAttemptAt });
      await ctx.scheduler.runAt(nextAttemptAt, internal.webhookDelivery.dispatch, args);
      return null;
    }
    await recordUsage(ctx, e!.organizationId, e!.environment, "deliveries", String(d._id));
    await recordUsage(
      ctx,
      e!.organizationId,
      e!.environment,
      "attempts",
      `webhook:${d._id}:${d.generation}`,
      1,
      true,
    );
    await ctx.db.patch("webhookDeliveries", d._id, {
      state: "running",
      attempts: d.attempts + 1,
      cycleAttempts: d.cycleAttempts + 1,
      leaseUntil,
    });
    await ctx.db.insert("webhookAttempts", {
      deliveryId: d._id,
      generation: d.generation,
      number: d.attempts + 1,
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAt(leaseUntil, internal.webhookDelivery.recover, args);
    return { endpoint: e!, event: event!, deliveryId: d._id };
  },
});
async function finishAttempt(
  ctx: MutationCtx,
  d: Doc<"webhookDeliveries">,
  fields: { code: string; httpStatus?: number; durationMs?: number; response?: string },
) {
  const endpoint = await ctx.db.get("webhookEndpoints", d.endpointId);
  if (endpoint) await releaseUsageLease(ctx, endpoint.organizationId, String(d._id));
  const attempt = await ctx.db
    .query("webhookAttempts")
    .withIndex("by_deliveryId_and_generation", (q) =>
      q.eq("deliveryId", d._id).eq("generation", d.generation),
    )
    .unique();
  if (endpoint && attempt && !attempt.finishedAt) {
    const event = await ctx.db.get("outboxEvents", d.eventId);
    await recordAudit(ctx, {
      organizationId: endpoint.organizationId,
      projectId: endpoint.projectId,
      companyId: endpoint.companyId,
      environment: endpoint.environment,
      actor: "system",
      action: "webhook.attempt",
      target: d._id,
      eventId: event?.eventId,
      code: fields.code,
      status: fields.httpStatus,
      durationMs: fields.durationMs,
    });
  }
  if (attempt && !attempt.finishedAt)
    await ctx.db.patch("webhookAttempts", attempt._id, { ...fields, finishedAt: Date.now() });
}
async function retry(
  ctx: MutationCtx,
  d: Doc<"webhookDeliveries">,
  fields: { code: string; httpStatus?: number; durationMs?: number; response?: string },
  notBefore = 0,
) {
  await finishAttempt(ctx, d, fields);
  const latestFields = {
    httpStatus: undefined,
    response: undefined,
    durationMs: undefined,
    ...fields,
  };
  const generation = d.generation + 1;
  if (d.cycleAttempts >= MAX_ATTEMPTS || (d.recoveries ?? 0) >= MAX_ATTEMPTS) {
    await ctx.db.patch("webhookDeliveries", d._id, {
      ...latestFields,
      generation,
      state: "failed",
      leaseUntil: 0,
    });
    return;
  }
  const backoff = Math.min(3600_000, 5_000 * 2 ** Math.max(0, d.cycleAttempts - 1));
  const jitter = Math.floor((Math.random() * backoff) / 4);
  const nextAttemptAt = Math.max(
    Date.now() + backoff + jitter,
    Math.min(notBefore, Date.now() + MAX_RETRY_AFTER_MS),
  );
  await ctx.db.patch("webhookDeliveries", d._id, {
    ...latestFields,
    state: "retry_wait",
    generation,
    nextAttemptAt,
    leaseUntil: 0,
    recoveries: (d.recoveries ?? 0) + Number(fields.code === "DELIVERY_UNCERTAIN"),
  });
  await ctx.scheduler.runAt(nextAttemptAt, internal.webhookDelivery.dispatch, {
    deliveryId: d._id,
    generation,
  });
}
export const outcomeArgs = {
  ...deliveryArgs,
  status: v.optional(v.number()),
  retryAt: v.optional(v.number()),
  durationMs: v.number(),
  code: v.union(
    v.literal("HTTP_RESPONSE"),
    v.literal("NETWORK_ERROR"),
    v.literal("DESTINATION_DENIED"),
    v.literal("SIGNING_UNAVAILABLE"),
  ),
};
export const outcome = internalMutation({
  args: outcomeArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (
      !d ||
      d.generation !== args.generation ||
      d.state !== "running" ||
      d.leaseUntil <= Date.now()
    )
      return false;
    const status = args.status;
    const fields = {
      code: status ? `HTTP_${status}` : args.code,
      httpStatus: status,
      response: status ? `HTTP ${status}. Corpo remoto omitido.` : undefined,
      durationMs: Math.max(0, Math.min(60_000, args.durationMs)),
    };
    if (status && status >= 200 && status < 300) {
      await finishAttempt(ctx, d, fields);
      await ctx.db.patch("webhookDeliveries", d._id, {
        ...fields,
        state: "delivered",
        leaseUntil: 0,
      });
    } else if (
      args.code === "DESTINATION_DENIED" ||
      args.code === "SIGNING_UNAVAILABLE" ||
      (status && status < 500 && status !== 429)
    ) {
      await finishAttempt(ctx, d, fields);
      await ctx.db.patch("webhookDeliveries", d._id, { ...fields, state: "failed", leaseUntil: 0 });
    } else await retry(ctx, d, fields, args.retryAt);
    return true;
  },
});
export const recover = internalMutation({
  args: deliveryArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (!d || d.generation !== args.generation) return null;
    if (
      (d.state === "running" && d.leaseUntil <= Date.now()) ||
      (["queued", "retry_wait"].includes(d.state) && d.nextAttemptAt + LEASE_MS * 2 <= Date.now())
    )
      await retry(ctx, d, { code: "DELIVERY_UNCERTAIN" });
    return null;
  },
});
/** A request already in flight cannot be recalled by a subsequent permission change. */
export const canSend = internalQuery({
  args: { ...deliveryArgs, endpointVersion: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (
      !d ||
      d.generation !== args.generation ||
      d.state !== "running" ||
      d.leaseUntil <= Date.now()
    )
      return false;
    const e = await ctx.db.get("webhookEndpoints", d.endpointId),
      event = await ctx.db.get("outboxEvents", d.eventId);
    return (
      !!e &&
      !!event &&
      e.version === args.endpointVersion &&
      process.env.WEBHOOK_MODE === "https" &&
      (await endpointAllowed(ctx, e, event.type))
    );
  },
});
