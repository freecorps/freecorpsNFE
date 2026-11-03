import { v, type Infer } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { scopeFields } from "./lib/operationValues";
import {
  endpointInput,
  subscriptionType,
  MAX_ENDPOINTS,
  MAX_RESENDS,
  deliveryState,
} from "./lib/webhookValues";
import {
  endpointAccess,
  keptEndpointAccess,
  keptWebhookAccess,
  webhookAccess,
  subscribedAccess,
  validateEndpoint,
  type WebhookScope,
} from "./lib/webhookAccess";
import { projectAccess } from "./lib/operationAccess";
import { integrationAudit } from "./lib/projectAccess";
import { deny, limitOrganizationAction, boundedPagination } from "./lib/organizationAccess";
import { encryptSecret, newWebhookSecret } from "./lib/webhookSecrets";
import { emitEvent } from "./lib/webhookOutbox";
import { assertOrganizationHot } from "./lib/coldArchiveCore";
export const endpointSummary = v.object({
  id: v.id("webhookEndpoints"),
  name: v.string(),
  url: v.string(),
  events: v.array(subscriptionType),
  active: v.boolean(),
  version: v.number(),
  secretVersion: v.number(),
  previousUntil: v.union(v.number(), v.null()),
  createdAt: v.number(),
});
export function summarizeEndpoint(e: Doc<"webhookEndpoints">) {
  return {
    id: e._id,
    name: e.name,
    url: e.url,
    events: e.events,
    active: e.active,
    version: e.version,
    secretVersion: e.secretVersion,
    previousUntil: e.previousUntil ?? null,
    createdAt: e.createdAt,
  };
}
export const created = v.object({ endpoint: endpointSummary, secret: v.string() });
export async function createEndpoint(
  ctx: MutationCtx,
  scope: WebhookScope,
  input: { name: string; url: string; events: Infer<typeof subscriptionType>[] },
  keyHash?: string,
) {
  const actor = await webhookAccess(ctx, scope, keyHash);
  const fields = validateEndpoint(input);
  await subscribedAccess(ctx, scope, fields.events, keyHash);
  await limitOrganizationAction(ctx, "webhook-create", scope.projectId);
  const current = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_companyId_and_environment", (q) =>
      q.eq("companyId", scope.companyId).eq("environment", scope.environment),
    )
    .take(MAX_ENDPOINTS);
  if (current.length >= MAX_ENDPOINTS) return deny("ENDPOINT_LIMIT");
  const { project, grant } = await projectAccess(ctx, {
    ...scope,
    task: { scope: "webhooks:manage" },
  });
  const secret = newWebhookSecret(),
    now = Date.now();
  const id = await ctx.db.insert("webhookEndpoints", {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: scope.environment,
    ...fields,
    active: true,
    version: 1,
    secretVersion: 1,
    secret: "",
    projectEpoch: project.accessEpoch,
    grantEpoch: grant.accessEpoch,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch("webhookEndpoints", id, { secret: await encryptSecret(secret, `${id}:1`) });
  await integrationAudit(ctx, project, actor, "webhook.created", id);
  return { endpoint: summarizeEndpoint((await ctx.db.get("webhookEndpoints", id))!), secret };
}
export const create = mutation({
  args: { ...scopeFields, ...endpointInput },
  returns: created,
  handler: (ctx, args) => createEndpoint(ctx, args, args),
});
export const list = query({
  args: { ...scopeFields },
  returns: v.array(endpointSummary),
  handler: async (ctx, args) => {
    await keptWebhookAccess(ctx, args);
    return listEndpoints(ctx, args);
  },
});
export async function listEndpoints(ctx: QueryCtx, scope: WebhookScope) {
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_projectId_and_companyId_and_environment", (q) =>
      q
        .eq("projectId", scope.projectId)
        .eq("companyId", scope.companyId)
        .eq("environment", scope.environment),
    )
    .take(MAX_ENDPOINTS);
  return endpoints.map(summarizeEndpoint);
}
export const editArgs = {
  endpointId: v.id("webhookEndpoints"),
  expectedVersion: v.number(),
  ...endpointInput,
  active: v.boolean(),
};
/**
 * The only edit kept in cold custody (ADR 0009, §§2-3): switching the endpoint off. Name, URL and
 * events must stay as they are and `active` must be false; anything else is refused with
 * `ORGANIZATION_ARCHIVED`. The epochs stay: the endpoint is off and only sends again after an
 * edit outside custody, which pins them again.
 */
async function disableInCustody(
  ctx: MutationCtx,
  endpoint: Doc<"webhookEndpoints">,
  fields: { name: string; url: string; events: Doc<"webhookEndpoints">["events"] },
  active: boolean,
  actor: string,
) {
  if (
    active ||
    fields.name !== endpoint.name ||
    fields.url !== endpoint.url ||
    fields.events.length !== endpoint.events.length ||
    fields.events.some((event) => !endpoint.events.includes(event))
  )
    await assertOrganizationHot(ctx, endpoint.organizationId);
  await limitOrganizationAction(ctx, "webhook-edit", endpoint._id);
  await ctx.db.patch("webhookEndpoints", endpoint._id, {
    active: false,
    version: endpoint.version + 1,
    updatedAt: Date.now(),
  });
  await integrationAudit(
    ctx,
    (await ctx.db.get("projects", endpoint.projectId))!,
    actor,
    "webhook.updated",
    endpoint._id,
  );
  return summarizeEndpoint((await ctx.db.get("webhookEndpoints", endpoint._id))!);
}
export async function editEndpoint(
  ctx: MutationCtx,
  args: { [K in keyof typeof editArgs]: Infer<(typeof editArgs)[K]> },
  keyHash?: string,
) {
  const { endpoint, actor, custody } = await keptEndpointAccess(ctx, args.endpointId, keyHash);
  if (endpoint.version !== args.expectedVersion) return deny("ENDPOINT_CHANGED");
  const fields = validateEndpoint(args);
  if (custody) return disableInCustody(ctx, endpoint, fields, args.active, actor);
  const eventsChanged =
    fields.events.length !== endpoint.events.length ||
    fields.events.some((event) => !endpoint.events.includes(event));
  if (args.active || eventsChanged) await subscribedAccess(ctx, endpoint, fields.events, keyHash);
  await limitOrganizationAction(ctx, "webhook-edit", endpoint._id);
  const { project, grant } = await projectAccess(ctx, {
    ...endpoint,
    task: { scope: "webhooks:manage" },
  });
  await ctx.db.patch("webhookEndpoints", endpoint._id, {
    ...fields,
    active: args.active,
    version: endpoint.version + 1,
    projectEpoch: project.accessEpoch,
    grantEpoch: grant.accessEpoch,
    updatedAt: Date.now(),
  });
  await integrationAudit(ctx, project, actor, "webhook.updated", endpoint._id);
  return summarizeEndpoint((await ctx.db.get("webhookEndpoints", endpoint._id))!);
}
export const update = mutation({
  args: editArgs,
  returns: endpointSummary,
  handler: (ctx, args) => editEndpoint(ctx, args),
});
export const rotateArgs = {
  endpointId: v.id("webhookEndpoints"),
  expectedVersion: v.number(),
  overlapMs: v.number(),
};
export async function rotateEndpoint(
  ctx: MutationCtx,
  args: { [K in keyof typeof rotateArgs]: Infer<(typeof rotateArgs)[K]> },
  keyHash?: string,
) {
  // Rotating a secret is kept in cold custody (ADR 0009, §2).
  const { endpoint, actor } = await keptEndpointAccess(ctx, args.endpointId, keyHash);
  if (endpoint.version !== args.expectedVersion) return deny("ENDPOINT_CHANGED");
  if (!Number.isSafeInteger(args.overlapMs) || args.overlapMs < 0 || args.overlapMs > 86_400_000)
    return deny("INVALID_REQUEST");
  if ((endpoint.previousUntil ?? 0) > Date.now()) return deny("ROTATION_IN_PROGRESS");
  await limitOrganizationAction(ctx, "webhook-rotate", endpoint._id, 3);
  const secret = newWebhookSecret(),
    version = endpoint.secretVersion + 1;
  const previousUntil = Date.now() + args.overlapMs;
  await ctx.db.patch("webhookEndpoints", endpoint._id, {
    secret: await encryptSecret(secret, `${endpoint._id}:${version}`),
    secretVersion: version,
    previousSecret: args.overlapMs ? endpoint.secret : undefined,
    previousVersion: args.overlapMs ? endpoint.secretVersion : undefined,
    previousUntil: args.overlapMs ? previousUntil : undefined,
    version: endpoint.version + 1,
    updatedAt: Date.now(),
  });
  if (args.overlapMs)
    await ctx.scheduler.runAt(previousUntil, internal.webhookDelivery.expireSecret, {
      endpointId: endpoint._id,
      version,
    });
  await integrationAudit(
    ctx,
    (await ctx.db.get("projects", endpoint.projectId))!,
    actor,
    "webhook.rotated",
    endpoint._id,
  );
  return {
    endpoint: summarizeEndpoint((await ctx.db.get("webhookEndpoints", endpoint._id))!),
    secret,
  };
}
export const rotate = mutation({
  args: rotateArgs,
  returns: created,
  handler: (ctx, args) => rotateEndpoint(ctx, args),
});
export async function testEndpoint(
  ctx: MutationCtx,
  endpointId: Id<"webhookEndpoints">,
  key: string,
  keyHash?: string,
) {
  const { endpoint, actor } = await endpointAccess(ctx, endpointId, keyHash);
  if (!endpoint.active || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return deny("INVALID_REQUEST");
  await limitOrganizationAction(ctx, "webhook-test", endpointId, 5);
  const id = await emitEvent(ctx, {
    organizationId: endpoint.organizationId,
    companyId: endpoint.companyId,
    projectId: endpoint.projectId,
    environment: endpoint.environment,
    logicalKey: `test:${endpointId}:${key}`,
    type: "webhook.test",
    resourceType: "endpoint",
    resourceId: endpointId,
    resourceVersion: endpoint.version,
    endpointId,
  });
  await integrationAudit(
    ctx,
    (await ctx.db.get("projects", endpoint.projectId))!,
    actor,
    "webhook.test",
    id,
  );
  return { eventId: (await ctx.db.get("outboxEvents", id))!.eventId };
}
export const test = mutation({
  args: { endpointId: v.id("webhookEndpoints"), key: v.string() },
  returns: v.object({ eventId: v.string() }),
  handler: (ctx, args) => testEndpoint(ctx, args.endpointId, args.key),
});
export const deliverySummary = v.object({
  id: v.id("webhookDeliveries"),
  eventId: v.string(),
  type: v.string(),
  resourceVersion: v.number(),
  state: deliveryState,
  attempts: v.number(),
  resends: v.number(),
  generation: v.number(),
  nextAttemptAt: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
  httpStatus: v.union(v.number(), v.null()),
  durationMs: v.union(v.number(), v.null()),
  response: v.union(v.string(), v.null()),
  createdAt: v.number(),
  canRetry: v.boolean(),
});
export async function summarizeDelivery(ctx: QueryCtx, d: Doc<"webhookDeliveries">) {
  const event = (await ctx.db.get("outboxEvents", d.eventId))!;
  return {
    id: d._id,
    eventId: event.eventId,
    type: event.type,
    resourceVersion: event.resourceVersion,
    state: d.state,
    attempts: d.attempts,
    resends: d.resends,
    generation: d.generation,
    nextAttemptAt: ["queued", "retry_wait"].includes(d.state) ? d.nextAttemptAt : null,
    code: d.code ?? null,
    httpStatus: d.httpStatus ?? null,
    durationMs: d.durationMs ?? null,
    response: d.response ?? null,
    createdAt: d.createdAt,
    canRetry: ["failed", "paused", "delivered"].includes(d.state) && d.resends < MAX_RESENDS,
  };
}
export const deliveries = query({
  args: { endpointId: v.id("webhookEndpoints"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(deliverySummary),
  handler: async (ctx, args) => {
    await endpointAccess(ctx, args.endpointId);
    const page = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", args.endpointId))
      .order("desc")
      .paginate(boundedPagination(args.paginationOpts));
    return { ...page, page: await Promise.all(page.page.map((d) => summarizeDelivery(ctx, d))) };
  },
});
export const attempts = query({
  args: { deliveryId: v.id("webhookDeliveries") },
  returns: v.array(
    v.object({
      number: v.number(),
      startedAt: v.number(),
      finishedAt: v.union(v.number(), v.null()),
      code: v.union(v.string(), v.null()),
      httpStatus: v.union(v.number(), v.null()),
      durationMs: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const d = await ctx.db.get("webhookDeliveries", args.deliveryId);
    if (!d) return deny("NOT_FOUND");
    await endpointAccess(ctx, d.endpointId);
    const rows = await ctx.db
      .query("webhookAttempts")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", d._id))
      .take(24);
    return rows.map((a) => ({
      number: a.number,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt ?? null,
      code: a.code ?? null,
      httpStatus: a.httpStatus ?? null,
      durationMs: a.durationMs ?? null,
    }));
  },
});
export async function retryDelivery(
  ctx: MutationCtx,
  id: Id<"webhookDeliveries">,
  expectedGeneration: number,
  key: string,
  keyHash?: string,
) {
  const d = await ctx.db.get("webhookDeliveries", id);
  if (!d) return deny("NOT_FOUND");
  const { endpoint, actor } = await endpointAccess(ctx, d.endpointId, keyHash);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) return deny("INVALID_REQUEST");
  if (d.lastRetryKey === key) return summarizeDelivery(ctx, d);
  if (
    d.generation !== expectedGeneration ||
    !endpoint.active ||
    !["failed", "paused", "delivered"].includes(d.state) ||
    d.resends >= MAX_RESENDS
  )
    return deny("OPERATION_CONFLICT");
  await limitOrganizationAction(ctx, "webhook-retry", endpoint._id, 5);
  const generation = d.generation + 1;
  await ctx.db.patch("webhookDeliveries", id, {
    state: "queued",
    generation,
    cycleAttempts: 0,
    resends: d.resends + 1,
    nextAttemptAt: Date.now(),
    leaseUntil: 0,
    code: undefined,
    httpStatus: undefined,
    durationMs: undefined,
    response: undefined,
    lastRetryKey: key,
    recoveries: 0,
  });
  await ctx.scheduler.runAfter(0, internal.webhookDelivery.dispatch, {
    deliveryId: id,
    generation,
  });
  await integrationAudit(
    ctx,
    (await ctx.db.get("projects", endpoint.projectId))!,
    actor,
    "webhook.retried",
    id,
  );
  return summarizeDelivery(ctx, (await ctx.db.get("webhookDeliveries", id))!);
}
export const retry = mutation({
  args: { deliveryId: v.id("webhookDeliveries"), expectedGeneration: v.number(), key: v.string() },
  returns: deliverySummary,
  handler: (ctx, args) => retryDelivery(ctx, args.deliveryId, args.expectedGeneration, args.key),
});
