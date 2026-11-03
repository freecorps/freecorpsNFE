import { patchFiscal } from "./capacityCore";
import { recordAudit } from "./operationalAudit";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { WebhookEnvelope } from "@freecorps/contracts";
import { internal } from "../_generated/api";
import { endpointAllowed } from "./webhookAccess";
import { MAX_ENDPOINTS } from "./webhookValues";
import { originalId } from "./coldArchiveOrigin";

export async function emitEvent(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    companyId: Id<"companies">;
    environment: "sandbox" | "production";
    projectId?: Id<"projects">;
    logicalKey: string;
    type: WebhookEnvelope["type"];
    resourceType: WebhookEnvelope["resource"]["type"];
    resourceId: string;
    /** The first ID of a rehydrated resource (ADR 0009, §6); only when it differs from `resourceId`. */
    originalId?: string;
    resourceVersion: number;
    endpointId?: Id<"webhookEndpoints">;
    operationIds?: Id<"operations">[];
    /** Only `connection.history_limited` carries data (`verifyWebhook` refuses it elsewhere). */
    data?: WebhookEnvelope["data"];
  },
) {
  const existing = await ctx.db
    .query("outboxEvents")
    .withIndex("by_logicalKey", (q) => q.eq("logicalKey", input.logicalKey))
    .unique();
  if (existing) return existing._id;
  const { endpointId, operationIds = [], data, originalId: first, ...fields } = input;
  const eventId = crypto.randomUUID(),
    createdAt = Date.now();
  const body: WebhookEnvelope = {
    eventId,
    type: input.type,
    version: "1",
    occurredAt: createdAt,
    environment: input.environment,
    companyId: input.companyId,
    resource: {
      type: input.resourceType,
      id: input.resourceId,
      ...(first !== undefined && first !== input.resourceId ? { originalId: first } : {}),
      version: input.resourceVersion,
    },
    synthetic: input.type === "webhook.test",
    ...(data ? { data } : {}),
  };
  const id = await ctx.db.insert("outboxEvents", {
    ...fields,
    eventId,
    body: JSON.stringify(body),
    createdAt,
  });
  const audit = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    companyId: input.companyId,
    environment: input.environment,
    actor: "system",
    action: input.type,
    target: input.resourceId,
    eventId,
  };
  // Correlation is optional metadata. A stale or mismatched reference must not
  // undo the authorized domain change and its outbox event.
  let linked = 0,
    incomplete = operationIds.length > 20;
  for (const operationId of new Set(operationIds.slice(0, 20))) {
    const op = await ctx.db.get("operations", operationId);
    if (
      !op ||
      op.organizationId !== input.organizationId ||
      op.companyId !== input.companyId ||
      (input.projectId !== undefined && op.projectId !== input.projectId) ||
      op.environment !== input.environment
    ) {
      incomplete = true;
      continue;
    }
    await recordAudit(ctx, { ...audit, projectId: op.projectId, operationId });
    linked++;
  }
  if (!linked)
    await recordAudit(ctx, { ...audit, ...(incomplete ? { code: "CORRELATION_INCOMPLETE" } : {}) });
  if (incomplete)
    console.warn(JSON.stringify({ type: "telemetry_correlation_incomplete", eventId }));
  const endpoints = endpointId
    ? [await ctx.db.get("webhookEndpoints", endpointId)]
    : await ctx.db
        .query("webhookEndpoints")
        .withIndex("by_companyId_and_environment", (q) =>
          q.eq("companyId", input.companyId).eq("environment", input.environment),
        )
        .take(MAX_ENDPOINTS);
  for (const endpoint of endpoints) {
    if (
      !endpoint ||
      endpoint.organizationId !== input.organizationId ||
      (input.projectId && endpoint.projectId !== input.projectId) ||
      (input.type !== "webhook.test" && !endpoint.events.includes(input.type)) ||
      !(await endpointAllowed(ctx, endpoint, input.type))
    )
      continue;
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      endpointId: endpoint._id,
      eventId: id,
      state: "queued",
      generation: 1,
      attempts: 0,
      cycleAttempts: 0,
      resends: 0,
      nextAttemptAt: createdAt,
      leaseUntil: 0,
      createdAt,
    });
    await ctx.scheduler.runAfter(0, internal.webhookDelivery.dispatch, {
      deliveryId,
      generation: 1,
    });
  }
  return id;
}
export async function documentEvent(
  ctx: MutationCtx,
  doc: Doc<"fiscalDocuments">,
  type: "document.received" | "document.updated" | "document.event_received",
  key: string,
  causeOperationId?: Id<"operations">,
) {
  const current = (await ctx.db.get("fiscalDocuments", doc._id))!;
  const logicalKey = `document:${doc._id}:${key}`;
  if (
    await ctx.db
      .query("outboxEvents")
      .withIndex("by_logicalKey", (q) => q.eq("logicalKey", logicalKey))
      .unique()
  )
    return;
  const resourceVersion = (current.publicVersion ?? 0) + 1;
  const version = current.publishedVersionId
    ? await ctx.db.get("documentVersions", current.publishedVersionId)
    : null;
  await patchFiscal(ctx, "fiscalDocuments", doc._id, { publicVersion: resourceVersion });
  await emitEvent(ctx, {
    organizationId: doc.organizationId,
    companyId: doc.companyId,
    environment: doc.environment,
    logicalKey,
    type,
    resourceType: "document",
    resourceId: doc._id,
    ...originalId(current),
    resourceVersion,
    operationIds: causeOperationId ? [causeOperationId] : version ? [version.operationId] : [],
  });
}
/** Completion concerns the original batch. Reprocessing does not reopen that batch. */
export async function completeImport(ctx: MutationCtx, importId: Id<"imports">) {
  const batch = await ctx.db.get("imports", importId);
  if (!batch || batch.completedAt !== undefined) return;
  const files = await ctx.db
    .query("importFiles")
    .withIndex("by_importId", (q) => q.eq("importId", importId))
    .take(21);
  if (!files.length || files.length > 20) throw new Error("Invalid import size");
  for (const file of files) {
    if (file.state === "expired") continue;
    const op = file.operationId ? await ctx.db.get("operations", file.operationId) : null;
    if (!op || !["succeeded", "failed"].includes(op.state)) return;
  }
  await ctx.db.patch("imports", batch._id, { completedAt: Date.now() });
  await emitEvent(ctx, {
    organizationId: batch.organizationId,
    projectId: batch.projectId,
    companyId: batch.companyId,
    environment: batch.environment,
    logicalKey: `import:${batch._id}:completed`,
    type: "import.completed",
    resourceType: "import",
    resourceId: batch._id,
    ...originalId(batch),
    resourceVersion: 1,
    operationIds: files.flatMap((file) => (file.operationId ? [file.operationId] : [])),
  });
}
