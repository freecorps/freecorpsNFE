import { convertToBrl } from "@freecorps/fiscal-nfse/pure";
import { v } from "convex/values";
import { insertFiscal, trackStoredFile } from "./lib/capacityCore";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  boundedRejections,
  issuanceEvent,
  productionResendAllowed,
  productionTransportAllowed,
  transportModeFor,
  type ProductionPurpose,
  type IssuanceSnapshot,
} from "./lib/issuanceCore";
import { rejectionItem } from "./lib/issuanceValues";
import { recordAudit } from "./lib/operationalAudit";
import { activeClaim, type Claim } from "./lib/operationCore";
import { claimFields } from "./lib/operationValues";
import { recordUsage } from "./lib/usageCore";
// Usage keys use the issuance's first ID (ADR 0009, §5, item 5): the same after a rehydration.
import { firstId, originalId } from "./lib/coldArchiveOrigin";
import { emitEvent } from "./lib/webhookOutbox";

/**
 * Fenced writes of the issuance worker. Every function checks the active claim (generation,
 * fence and lease) before writing: a stale attempt never overwrites the current one. The
 * checkpoints run inside `operations.checkpoint`, already under the fence.
 */

async function claimed(ctx: MutationCtx, claim: Claim) {
  const op = await activeClaim(ctx, claim);
  if (!op) return null;
  const issuance = await ctx.db
    .query("issuances")
    .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
    .unique();
  return issuance ? { op, issuance } : null;
}
async function claimedCancellation(ctx: MutationCtx, claim: Claim) {
  const op = await activeClaim(ctx, claim);
  if (!op) return null;
  const cancellation = await ctx.db
    .query("issuanceCancellations")
    .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
    .unique();
  const issuance = cancellation ? await ctx.db.get("issuances", cancellation.issuanceId) : null;
  return cancellation && issuance ? { op, cancellation, issuance } : null;
}
async function artifactOf(
  ctx: MutationCtx,
  issuanceId: Id<"issuances">,
  kind: Doc<"issuanceArtifacts">["kind"],
  cancellationId?: Id<"issuanceCancellations">,
) {
  const rows = await ctx.db
    .query("issuanceArtifacts")
    .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuanceId).eq("kind", kind))
    .take(20);
  return rows.find((row) => row.cancellationId === cancellationId) ?? null;
}
/**
 * Webhook of a persisted transition, in the same transaction. The logical key makes a replayed
 * checkpoint or reconciliation reuse the first event; only the project that requested the
 * issuance receives it, and the envelope carries ids only.
 */
async function issuanceWebhook(
  ctx: MutationCtx,
  issuanceId: Id<"issuances">,
  type:
    | "issuance.authorized"
    | "issuance.rejected"
    | "issuance.cancelled"
    | "issuance.cancellation_rejected",
  key: string,
  operationId: Id<"operations">,
) {
  const current = (await ctx.db.get("issuances", issuanceId))!;
  await emitEvent(ctx, {
    organizationId: current.organizationId,
    projectId: current.projectId,
    companyId: current.companyId,
    environment: current.environment,
    logicalKey: `issuance:${current._id}:${key}`,
    type,
    resourceType: "issuance",
    resourceId: current._id,
    ...originalId(current),
    resourceVersion: current.version,
    operationIds: [operationId],
  });
}
async function bump(
  ctx: MutationCtx,
  issuance: Doc<"issuances">,
  fields: Partial<Doc<"issuances">>,
) {
  await ctx.db.patch("issuances", issuance._id, {
    ...fields,
    version: issuance.version + 1,
    updatedAt: Date.now(),
  });
}
/**
 * Whether the deployment still allows the transport frozen at acceptance: the sandbox variable
 * may have changed, and the production gate or the fiscal production profile of the deployment
 * may have been closed while the operation waited.
 */
async function transportAllowed(
  ctx: MutationCtx,
  issuance: Doc<"issuances">,
  purpose: ProductionPurpose,
) {
  if (transportModeFor(issuance) !== issuance.transport) return false;
  if (issuance.environment !== "production") return true;
  return productionTransportAllowed(ctx, issuance, purpose);
}

const stored = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  size: v.number(),
});
const prepared = v.object({
  snapshot: v.string(),
  dpsId: v.string(),
  series: v.string(),
  number: v.number(),
  transport: v.string(),
  target: v.string(),
  allowed: v.boolean(),
  state: v.string(),
  code: v.union(v.string(), v.null()),
  submissions: v.number(),
  exchange: v.union(
    v.null(),
    v.object({
      currency: v.string(),
      rate: v.string(),
      quoteDate: v.string(),
      brlAmount: v.string(),
    }),
  ),
  dps: v.union(v.null(), stored),
  accessKey: v.union(v.string(), v.null()),
  nfse: v.union(v.null(), stored),
});

const TRANSPORT_DISABLED = "ISSUANCE_TRANSPORT_DISABLED";

/**
 * After an attempt was refused before anything left (the vault refused the certificate, or the
 * production origin is not the fixed one), decides in one transaction, under the claim, what the
 * attempt becomes. What the database says, never what the attempt remembers:
 *
 * - `lost`: the claim is gone or the issuance (cancellation) left `processing`; nothing written.
 * - `uncertain`: something was submitted before (`submissions > 0`); it may have reached the
 *   authority, so the operation keeps reconciling and nothing is rejected.
 * - `open`: only for the vault refusal, with no `code`: the policy still allows the transport,
 *   so the refusal is the certificate's own (revoked, replaced, expired) and the attempt waits.
 * - `rejected`: nothing was ever submitted; rejected for good, here, with `code` or, for a closed
 *   policy (variable, list, gate or fiscal production profile), `ISSUANCE_TRANSPORT_DISABLED`.
 */
export const stopIfClosed = internalMutation({
  args: {
    ...claimFields,
    task: v.union(v.literal("issue"), v.literal("cancel")),
    code: v.optional(v.string()),
  },
  returns: v.union(
    v.literal("lost"),
    v.literal("uncertain"),
    v.literal("open"),
    v.literal("rejected"),
  ),
  handler: async (ctx, { task, code, ...claim }) => {
    if (task === "issue") {
      const found = await claimed(ctx, claim);
      if (!found || found.issuance.state !== "processing") return "lost";
      if (found.issuance.submissions > 0) return "uncertain";
      if (code === undefined && (await transportAllowed(ctx, found.issuance, "issue")))
        return "open";
      await rejectIssuance(ctx, found, code ?? TRANSPORT_DISABLED, []);
      return "rejected";
    }
    const found = await claimedCancellation(ctx, claim);
    if (!found || found.cancellation.state !== "processing") return "lost";
    if (found.cancellation.submissions > 0) return "uncertain";
    if (code === undefined && (await transportAllowed(ctx, found.issuance, "cancel")))
      return "open";
    await rejectCancellation(ctx, found, code ?? TRANSPORT_DISABLED, []);
    return "rejected";
  },
});

export const prepareIssue = internalMutation({
  args: claimFields,
  returns: v.union(v.null(), prepared),
  handler: async (ctx, claim) => {
    const found = await claimed(ctx, claim);
    if (!found) return null;
    const { issuance } = found;
    const dps = await artifactOf(ctx, issuance._id, "dps");
    const nfse = await artifactOf(ctx, issuance._id, "nfse");
    const pick = (row: Doc<"issuanceArtifacts"> | null) =>
      row ? { storageId: row.storageId, sha256: row.sha256, size: row.size } : null;
    return {
      snapshot: issuance.snapshot,
      dpsId: issuance.dpsId,
      series: issuance.series,
      number: issuance.number,
      transport: issuance.transport,
      target: issuance.target,
      allowed: await transportAllowed(ctx, issuance, "issue"),
      state: issuance.state,
      code: issuance.code ?? null,
      submissions: issuance.submissions,
      exchange: issuance.exchange
        ? {
            currency: issuance.exchange.currency,
            rate: issuance.exchange.rate,
            quoteDate: issuance.exchange.quoteDate,
            brlAmount: issuance.exchange.brlAmount,
          }
        : null,
      dps: pick(dps),
      accessKey: issuance.accessKey ?? null,
      nfse: pick(nfse),
    };
  },
});

/** Freezes the PTAX quote once; later attempts reuse it. Returns the BRL value of the service. */
export const freezeExchange = internalMutation({
  args: {
    ...claimFields,
    rate: v.string(),
    quoteDate: v.string(),
    source: v.union(v.literal("ptax-bcb"), v.literal("simulated")),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { rate, quoteDate, source, ...claim }) => {
    const found = await claimed(ctx, claim);
    if (!found) return null;
    const { issuance } = found;
    if (issuance.exchange) return issuance.exchange.brlAmount;
    const snapshot = JSON.parse(issuance.snapshot) as IssuanceSnapshot;
    if (snapshot.amount.currency === "BRL") return snapshot.amount.value;
    if (!/^\d{1,6}\.\d{6}$/.test(rate) || !/^\d{4}-\d{2}-\d{2}$/.test(quoteDate))
      throw new Error("PTAX_RATE_INVALID");
    const brlAmount = convertToBrl(snapshot.amount.value, rate);
    await bump(ctx, issuance, {
      exchange: {
        currency: snapshot.amount.currency,
        amount: snapshot.amount.value,
        rate,
        quoteDate,
        brlAmount,
        source,
        frozenAt: Date.now(),
      },
    });
    await issuanceEvent(ctx, issuance, "exchange_frozen", undefined, issuance.operationId);
    return brlAmount;
  },
});

/** The DPS is persisted before the first transmission and never rebuilt afterwards. */
export const saveDps = internalMutation({
  args: { ...claimFields, ...stored.fields, signed: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { storageId, sha256, size, signed, ...claim }) => {
    const found = await claimed(ctx, claim);
    if (!found || (await artifactOf(ctx, found.issuance._id, "dps"))) return false;
    await ctx.db.insert("issuanceArtifacts", {
      organizationId: found.issuance.organizationId,
      issuanceId: found.issuance._id,
      kind: "dps",
      storageId,
      sha256,
      size,
      signed,
      createdAt: Date.now(),
    });
    await issuanceEvent(ctx, found.issuance, "dps_saved", undefined, found.op._id);
    await trackStoredFile(
      ctx,
      found.issuance.organizationId,
      storageId,
      `issuance:${found.op._id}`,
    );
    return true;
  },
});

/** Durable mark written before each transmission: from here on, only reconciliation repeats it. */
/**
 * Marks a submission right before it leaves, and decides in the same transaction whether it may:
 * the transport still allowed (`transportAllowed`) and, for a resend (`submissions > 0`), the
 * production gate on (`productionResendAllowed`). The answer is never a memory of the attempt:
 *
 * - `submit`: marked; the DPS may be sent.
 * - `lost`: the claim is gone or the issuance left `processing`; nothing written.
 * - `blocked`: something was submitted before and this send is not allowed now; nothing written,
 *   and the issuance keeps reconciling (`ISSUANCE_RESEND_BLOCKED`).
 * - `rejected`: nothing was ever submitted and the policy closed; rejected for good here.
 */
export const markSubmitted = internalMutation({
  args: claimFields,
  returns: v.union(
    v.literal("submit"),
    v.literal("lost"),
    v.literal("blocked"),
    v.literal("rejected"),
  ),
  handler: async (ctx, claim) => {
    const found = await claimed(ctx, claim);
    if (!found || found.issuance.state !== "processing") return "lost";
    const { issuance } = found;
    const allowed =
      (await transportAllowed(ctx, issuance, "issue")) &&
      (issuance.submissions === 0 || (await productionResendAllowed(ctx, issuance)));
    if (!allowed) {
      if (issuance.submissions > 0) return "blocked";
      await rejectIssuance(ctx, found, TRANSPORT_DISABLED, []);
      return "rejected";
    }
    await bump(ctx, issuance, { submissions: issuance.submissions + 1 });
    await issuanceEvent(ctx, issuance, "submitted", undefined, found.op._id);
    return "submit";
  },
});

/** Binds the authorized NFS-e to the issuance; the checkpoint then publishes the document. */
export const recordAuthorization = internalMutation({
  args: {
    ...claimFields,
    ...stored.fields,
    accessKey: v.string(),
    nfseNumber: v.union(v.string(), v.null()),
    recoveredByConsult: v.boolean(),
    /** DANFSe rendered from the same XML; absent when rendering failed (`danfseError`). */
    danfse: v.optional(stored),
    danfseError: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (
    ctx,
    {
      storageId,
      sha256,
      size,
      accessKey,
      nfseNumber,
      recoveredByConsult,
      danfse,
      danfseError,
      ...claim
    },
  ) => {
    const found = await claimed(ctx, claim);
    if (!found || !/^\d{50}$/.test(accessKey)) return false;
    const { issuance } = found;
    if (issuance.accessKey && issuance.accessKey !== accessKey) return false;
    // Idempotent: a repeated call keeps the first XML (and drops the new copy) but still makes
    // sure the issuance carries the key, so the checkpoint can always publish.
    if (await artifactOf(ctx, issuance._id, "nfse")) await ctx.storage.delete(storageId);
    else
      await ctx.db.insert("issuanceArtifacts", {
        organizationId: issuance.organizationId,
        issuanceId: issuance._id,
        kind: "nfse",
        storageId,
        sha256,
        size,
        signed: true,
        createdAt: Date.now(),
      });
    // The first DANFSe stays, like the first XML; a copy from a repeated call is dropped.
    if (await artifactOf(ctx, issuance._id, "danfse")) {
      if (danfse) await ctx.storage.delete(danfse.storageId);
    } else if (danfse) {
      await ctx.db.insert("issuanceArtifacts", {
        organizationId: issuance.organizationId,
        issuanceId: issuance._id,
        kind: "danfse",
        ...danfse,
        signed: false,
        createdAt: Date.now(),
      });
      await issuanceEvent(ctx, issuance, "danfse_saved", undefined, found.op._id);
    } else if (danfseError)
      await issuanceEvent(ctx, issuance, "danfse_failed", danfseError.slice(0, 80), found.op._id);
    await trackStoredFile(ctx, issuance.organizationId, storageId, `issuance:${found.op._id}`);
    if (danfse)
      await trackStoredFile(
        ctx,
        issuance.organizationId,
        danfse.storageId,
        `issuance:${found.op._id}`,
      );
    if (issuance.accessKey !== accessKey)
      await bump(ctx, issuance, {
        accessKey,
        ...(nfseNumber ? { nfseNumber } : {}),
        recoveredByConsult,
      });
    return true;
  },
});

export const rejectIssue = internalMutation({
  args: { ...claimFields, code: v.string(), rejections: v.array(rejectionItem) },
  returns: v.boolean(),
  handler: async (ctx, { code, rejections, ...claim }) => {
    const found = await claimed(ctx, claim);
    if (!found || found.issuance.state !== "processing") return false;
    await rejectIssuance(ctx, found, code, rejections);
    return true;
  },
});
async function rejectIssuance(
  ctx: MutationCtx,
  found: NonNullable<Awaited<ReturnType<typeof claimed>>>,
  code: string,
  rejections: Array<{ code: string | null; message: string }>,
) {
  const { issuance } = found;
  await bump(ctx, issuance, {
    state: "rejected",
    code,
    rejections: boundedRejections(rejections),
  });
  await issuanceEvent(ctx, issuance, "rejected", code, found.op._id);
  await recordAudit(ctx, {
    organizationId: issuance.organizationId,
    projectId: issuance.projectId,
    companyId: issuance.companyId,
    environment: issuance.environment,
    actor: "system",
    action: "issuance.rejected",
    target: issuance._id,
    operationId: found.op._id,
    code,
  });
  await issuanceWebhook(ctx, issuance._id, "issuance.rejected", "rejected", found.op._id);
}

/**
 * Publishes the authorization: the emitted fiscal document, the usage unit and the history.
 * Runs inside `operations.checkpoint` with the operation's fence; idempotent.
 */
export const checkpointIssue = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, { operationId }) => {
    const issuance = await ctx.db
      .query("issuances")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .unique();
    if (!issuance || issuance.state === "authorized") return null;
    if (issuance.state !== "processing" || !issuance.accessKey)
      throw new Error("ISSUANCE_NOT_AUTHORIZED");
    const accessKey = issuance.accessKey;
    const existing = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
        q
          .eq("organizationId", issuance.organizationId)
          .eq("companyId", issuance.companyId)
          .eq("environment", issuance.environment)
          .eq("model", "nfse")
          .eq("fiscalKey", accessKey),
      )
      .unique();
    if (existing && existing.direction !== "emitted") throw new Error("DOCUMENT_CONFLICT");
    const now = Date.now();
    const documentId =
      existing?._id ??
      (await insertFiscal(
        ctx,
        "fiscalDocuments",
        {
          organizationId: issuance.organizationId,
          companyId: issuance.companyId,
          environment: issuance.environment,
          model: "nfse",
          direction: "emitted",
          fiscalKey: accessKey,
          // Not part of `documents/1` yet: no published version, outside listings and onboarding.
          completeness: -1,
          listedAt: now,
          createdAt: now,
        },
        false,
      ));
    await bump(ctx, issuance, { state: "authorized", documentId, authorizedAt: now });
    // One unit per authorized invoice; replays and reconciliation reuse the same key.
    await recordUsage(
      ctx,
      issuance.organizationId,
      issuance.environment,
      "issuances",
      `issuance:${firstId(issuance)}`,
      1,
      true,
    );
    await issuanceEvent(ctx, issuance, "authorized", undefined, operationId);
    await recordAudit(ctx, {
      organizationId: issuance.organizationId,
      projectId: issuance.projectId,
      companyId: issuance.companyId,
      environment: issuance.environment,
      actor: "system",
      action: "issuance.authorized",
      target: issuance._id,
      operationId,
    });
    await issuanceWebhook(ctx, issuance._id, "issuance.authorized", "authorized", operationId);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Cancellation

const preparedCancel = v.object({
  snapshot: v.string(),
  transport: v.string(),
  target: v.string(),
  allowed: v.boolean(),
  accessKey: v.string(),
  sequence: v.number(),
  reasonCode: v.string(),
  reason: v.string(),
  requestedAt: v.string(),
  state: v.string(),
  code: v.union(v.string(), v.null()),
  submissions: v.number(),
  event: v.union(v.null(), stored),
});

export const prepareCancel = internalMutation({
  args: claimFields,
  returns: v.union(v.null(), preparedCancel),
  handler: async (ctx, claim) => {
    const found = await claimedCancellation(ctx, claim);
    const accessKey = found?.issuance.accessKey;
    if (!found || !accessKey) return null;
    const { cancellation, issuance } = found;
    const event = await artifactOf(ctx, issuance._id, "cancel-request", cancellation._id);
    return {
      snapshot: issuance.snapshot,
      transport: issuance.transport,
      target: issuance.target,
      allowed: await transportAllowed(ctx, issuance, "cancel"),
      accessKey,
      sequence: cancellation.sequence,
      reasonCode: cancellation.reasonCode,
      reason: cancellation.reason,
      requestedAt: cancellation.requestedAt,
      state: cancellation.state,
      code: cancellation.code ?? null,
      submissions: cancellation.submissions,
      event: event ? { storageId: event.storageId, sha256: event.sha256, size: event.size } : null,
    };
  },
});

export const saveCancelEvent = internalMutation({
  args: { ...claimFields, ...stored.fields, signed: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { storageId, sha256, size, signed, ...claim }) => {
    const found = await claimedCancellation(ctx, claim);
    if (
      !found ||
      (await artifactOf(ctx, found.issuance._id, "cancel-request", found.cancellation._id))
    )
      return false;
    await ctx.db.insert("issuanceArtifacts", {
      organizationId: found.issuance.organizationId,
      issuanceId: found.issuance._id,
      cancellationId: found.cancellation._id,
      kind: "cancel-request",
      storageId,
      sha256,
      size,
      signed,
      createdAt: Date.now(),
    });
    await trackStoredFile(
      ctx,
      found.issuance.organizationId,
      storageId,
      `issuance:${found.op._id}`,
    );
    return true;
  },
});

/**
 * Marks a cancellation submission right before it leaves, with the transport still allowed in
 * the same transaction (the cancellation rule: deployment and list, not the gate). The persisted
 * event is idempotent by its Id, so a resend needs nothing more. Answers as `markSubmitted`.
 */
export const markCancelSubmitted = internalMutation({
  args: claimFields,
  returns: v.union(
    v.literal("submit"),
    v.literal("lost"),
    v.literal("blocked"),
    v.literal("rejected"),
  ),
  handler: async (ctx, claim) => {
    const found = await claimedCancellation(ctx, claim);
    if (!found || found.cancellation.state !== "processing") return "lost";
    if (!(await transportAllowed(ctx, found.issuance, "cancel"))) {
      if (found.cancellation.submissions > 0) return "blocked";
      await rejectCancellation(ctx, found, TRANSPORT_DISABLED, []);
      return "rejected";
    }
    await ctx.db.patch("issuanceCancellations", found.cancellation._id, {
      submissions: found.cancellation.submissions + 1,
      updatedAt: Date.now(),
    });
    await issuanceEvent(ctx, found.issuance, "cancel_submitted", undefined, found.op._id);
    return "submit";
  },
});

export const recordCancelEvent = internalMutation({
  args: {
    ...claimFields,
    event: v.union(v.null(), stored),
    alreadyRegistered: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, { event, alreadyRegistered, ...claim }) => {
    const found = await claimedCancellation(ctx, claim);
    if (!found) return false;
    const { cancellation, issuance } = found;
    if (event && !(await artifactOf(ctx, issuance._id, "cancel-event", cancellation._id)))
      await ctx.db.insert("issuanceArtifacts", {
        organizationId: issuance.organizationId,
        issuanceId: issuance._id,
        cancellationId: cancellation._id,
        kind: "cancel-event",
        ...event,
        signed: true,
        createdAt: Date.now(),
      });
    if (event)
      await trackStoredFile(
        ctx,
        issuance.organizationId,
        event.storageId,
        `issuance:${found.op._id}`,
      );
    await ctx.db.patch("issuanceCancellations", cancellation._id, {
      alreadyRegistered,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const rejectCancel = internalMutation({
  args: { ...claimFields, code: v.string(), rejections: v.array(rejectionItem) },
  returns: v.boolean(),
  handler: async (ctx, { code, rejections, ...claim }) => {
    const found = await claimedCancellation(ctx, claim);
    if (!found || found.cancellation.state !== "processing") return false;
    await rejectCancellation(ctx, found, code, rejections);
    return true;
  },
});
async function rejectCancellation(
  ctx: MutationCtx,
  found: NonNullable<Awaited<ReturnType<typeof claimedCancellation>>>,
  code: string,
  rejections: Array<{ code: string | null; message: string }>,
) {
  const { cancellation, issuance } = found;
  await ctx.db.patch("issuanceCancellations", cancellation._id, {
    state: "rejected",
    code,
    rejections: boundedRejections(rejections),
    updatedAt: Date.now(),
  });
  await bump(ctx, issuance, {});
  await issuanceEvent(ctx, issuance, "cancel_rejected", code, found.op._id);
  await recordAudit(ctx, {
    organizationId: issuance.organizationId,
    projectId: issuance.projectId,
    companyId: issuance.companyId,
    environment: issuance.environment,
    actor: "system",
    action: "issuance.cancel_rejected",
    target: issuance._id,
    operationId: found.op._id,
    code,
  });
  await issuanceWebhook(
    ctx,
    issuance._id,
    "issuance.cancellation_rejected",
    `cancellation:${cancellation._id}:rejected`,
    found.op._id,
  );
}

export const checkpointCancel = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, { operationId }) => {
    const cancellation = await ctx.db
      .query("issuanceCancellations")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .unique();
    if (!cancellation || cancellation.state === "registered") return null;
    if (cancellation.state !== "processing") throw new Error("CANCELLATION_NOT_REGISTERED");
    const issuance = (await ctx.db.get("issuances", cancellation.issuanceId))!;
    await ctx.db.patch("issuanceCancellations", cancellation._id, {
      state: "registered",
      updatedAt: Date.now(),
    });
    await bump(ctx, issuance, { state: "cancelled" });
    await issuanceEvent(ctx, issuance, "cancelled", undefined, operationId);
    await recordAudit(ctx, {
      organizationId: issuance.organizationId,
      projectId: issuance.projectId,
      companyId: issuance.companyId,
      environment: issuance.environment,
      actor: "system",
      action: "issuance.cancelled",
      target: issuance._id,
      operationId,
    });
    await issuanceWebhook(ctx, issuance._id, "issuance.cancelled", "cancelled", operationId);
    return null;
  },
});
