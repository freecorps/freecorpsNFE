import { dhBrasilia } from "@freecorps/fiscal-nfse/pure";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { buildSha } from "./buildInfo";
import { requirePlatformEnvironment } from "./environment";
import { certificateHead, certificateUsable } from "./lib/certificateAccess";
import { FREECORPS_OPERATOR, gateRequest } from "./lib/issuanceGate";
import { productionCompanies } from "./lib/issuanceProduction";
import { closureOf } from "./lib/organizationClosure";
import { checkCapacity, reserveCapacity } from "./lib/capacityCore";
import {
  buildSnapshot,
  dpsIdOf,
  hasSimulationMarker,
  issuanceAccess,
  issuanceEvent,
  issuanceView,
  normalizeIssuanceInput,
  PRODUCTION_TARGET,
  productionGate,
  reserveDpsNumber,
  scopeOf,
  scopedIssuance,
  transportModeFor,
  type IssuanceScope,
  type ProductionPurpose,
} from "./lib/issuanceCore";
import { hasControl } from "./lib/nfseProfileRules";
import {
  cancelReason,
  cancelTask,
  issuanceInput,
  issuanceView as issuanceViewValidator,
  issueTask,
  type IssuanceInput,
  type IssuanceView,
  type TransportMode,
} from "./lib/issuanceValues";
import { nfseProfileOf } from "./lib/nfseProfile";
import { recordAudit } from "./lib/operationalAudit";
import { scopeFields } from "./lib/operationValues";
import { boundedPagination, deny } from "./lib/organizationAccess";

/**
 * Internal API of the NFS-e issuance (ADR 0004, phase 2). The REST routes (`issuanceRest.ts`)
 * and the console call these helpers or the internal functions below. Every entry checks
 * access itself: `organizationId`, `projectId` and `companyId` are selectors, never proof.
 */
const requestResult = v.object({ reused: v.boolean(), issuance: issuanceViewValidator });
/**
 * The key or the Stripe connection is checked again by `operations.reserve`, which records it as
 * the operation source. Without either, the caller is a console member.
 */
const keyArg = (keyHash?: string, connectionId?: Id<"stripeConnections">) => ({
  ...(keyHash !== undefined ? { keyHash } : {}),
  ...(connectionId !== undefined ? { connectionId } : {}),
});

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Closed for every company unless an operator opened it. Checked right after the caller's access
 * (organization, project, company, grant, scope, environment), never before: whoever lacks
 * access gets the same answer with the gate open or closed and cannot probe its state. Before
 * the gate, the deployment itself: only the fiscal production deployment serves `production`
 * issuances. Elsewhere, such as the #50 capture target, whose environment is `production` too,
 * the request ends as `NOT_FOUND` before any number is reserved. Then the company has to be in
 * `FNFE_NFSE_PRODUCTION_COMPANIES`; a new issuance also needs the gate on, a cancellation does
 * not (`productionTransportAllowed`).
 */
async function requireProductionGate(
  ctx: MutationCtx,
  scope: IssuanceScope,
  purpose: ProductionPurpose,
) {
  if (scope.environment !== "production") return;
  if (requirePlatformEnvironment().issuanceEnv !== "production") deny("NOT_FOUND");
  if (!productionCompanies().has(scope.companyId)) deny("ISSUANCE_PRODUCTION_DISABLED");
  if (purpose === "cancel") return;
  const gate = await productionGate(ctx, scope.companyId);
  if (!gate?.production || gate.organizationId !== scope.organizationId)
    deny("ISSUANCE_PRODUCTION_DISABLED");
}

async function existingOperation(
  ctx: MutationCtx,
  scope: IssuanceScope,
  name: string,
  key: string,
) {
  return ctx.db
    .query("idempotencyRecords")
    .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
      q
        .eq("organizationId", scope.organizationId)
        .eq("projectId", scope.projectId)
        .eq("name", name)
        .eq("key", key),
    )
    .unique();
}

async function issuanceOfOperation(ctx: MutationCtx, operationId: Id<"operations">) {
  const issuance = await ctx.db
    .query("issuances")
    .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
    .unique();
  return issuance ?? deny("NOT_FOUND");
}

/** Certificate pinned to the operation when the DPS leaves for a real tax authority. */
async function certificatePin(ctx: MutationCtx, scope: IssuanceScope, mode: TransportMode) {
  if (mode === "simulated") return undefined;
  const head = await certificateHead(ctx, scope.companyId);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  if (
    !cert ||
    !(await certificateUsable(ctx, scope, { id: cert._id, version: cert.version }, Date.now()))
  )
    return deny("CERTIFICATE_UNAVAILABLE");
  return { id: cert._id, version: cert.version };
}

/**
 * Accepts an issuance request: validates it against the profile in force, freezes the fiscal
 * snapshot, reserves the DPS number and the `documents.issue` operation in one transaction.
 * The same idempotency key with the same request returns the original issuance (`reused`),
 * before the profile is consulted again; a different request with the key fails with
 * `IDEMPOTENCY_CONFLICT`.
 */
export async function requestIssuance(
  ctx: MutationCtx,
  scopeArgs: IssuanceScope,
  idempotencyKey: string,
  input: IssuanceInput,
  keyHash?: string,
  connectionId?: Id<"stripeConnections">,
): Promise<{ reused: boolean; issuance: IssuanceView }> {
  const scope = scopeOf(scopeArgs);
  const actor = await issuanceAccess(ctx, scope, "issue", keyHash, connectionId);
  await requireProductionGate(ctx, scope, "issue");
  const request = JSON.stringify(normalizeIssuanceInput(input));
  if (await existingOperation(ctx, scope, issueTask.name, idempotencyKey)) {
    const replay: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
      internal.operations.reserve,
      { ...scope, ...keyArg(keyHash, connectionId), key: idempotencyKey, request, task: issueTask },
    );
    const issuance = await issuanceOfOperation(ctx, replay.operationId);
    return { reused: true, issuance: await issuanceView(ctx, issuance) };
  }
  const company = await ctx.db.get("companies", scope.companyId);
  // New fiscal work needs available stock. Previously admitted requests still reconcile above.
  await checkCapacity(ctx, scope.organizationId, "filesBytes", 1);
  await checkCapacity(ctx, scope.organizationId, "databaseBytes", 1);
  if (!company) return deny("NOT_FOUND");
  if (company.kind === "demonstration") return deny("ISSUANCE_DEMONSTRATION_DENIED");
  const profile = await nfseProfileOf(ctx, scope.companyId);
  if (!profile) return deny("NFSE_PROFILE_REQUIRED");
  const transport = transportModeFor(scope);
  const now = Date.now();
  const normalized = JSON.parse(request) as ReturnType<typeof normalizeIssuanceInput>;
  if (scope.environment === "production" && hasSimulationMarker(normalized.description))
    throw new ConvexError({ code: "ISSUANCE_FIELD_INVALID", field: "description" });
  // Route and validation happen before any number is reserved.
  const snapshot = buildSnapshot({
    request: normalized,
    company,
    profile,
    environment: scope.environment,
    transport,
    now,
  });
  // Only the Sefin Nacional has real production here; another channel is never forced.
  if (scope.environment === "production" && snapshot.target !== PRODUCTION_TARGET)
    throw new ConvexError({
      code: "NFSE_ROUTE_UNSUPPORTED",
      reason: "ROUTE_PRODUCTION",
      message:
        "O canal da nota não tem emissão em produção na plataforma; só a Sefin Nacional tem.",
    });
  const certificate = await certificatePin(ctx, scope, transport);
  const reserved: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
    internal.operations.reserve,
    {
      ...scope,
      ...keyArg(keyHash, connectionId),
      key: idempotencyKey,
      request,
      task: issueTask,
      ...(certificate ? { certificate } : {}),
    },
  );
  if (reserved.reused) {
    const issuance = await issuanceOfOperation(ctx, reserved.operationId);
    return { reused: true, issuance: await issuanceView(ctx, issuance) };
  }
  // At most 8 MiB DPS + 8 MiB authorized XML + 2 MiB best-effort DANFSe.
  await reserveCapacity(
    ctx,
    scope.organizationId,
    "filesBytes",
    `issuance:${reserved.operationId}`,
    18 * 1024 * 1024,
  );
  const series = snapshot.profile.dpsSeries;
  const number = await reserveDpsNumber(ctx, scope, series);
  const dpsId = dpsIdOf(snapshot, number);
  const frozen = JSON.stringify({ ...snapshot, series, number, dpsId });
  const issuanceId = await ctx.db.insert("issuances", {
    ...scope,
    operationId: reserved.operationId,
    state: "processing",
    transport,
    target: snapshot.target,
    series,
    number,
    dpsId,
    snapshot: frozen,
    snapshotSha256: await sha256(frozen),
    submissions: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const issuance = (await ctx.db.get("issuances", issuanceId))!;
  await issuanceEvent(ctx, issuance, "accepted", undefined, reserved.operationId);
  await recordAudit(ctx, {
    ...scope,
    actor,
    action: "issuance.accepted",
    target: issuanceId,
    operationId: reserved.operationId,
  });
  return { reused: false, issuance: await issuanceView(ctx, issuance) };
}

/**
 * Requests the cancellation (event e101101) of an authorized NFS-e. A cancellation already
 * registered or still in progress is returned as is (`reused`); after a rejected one, a new
 * request goes out with the next `sequence` (internal: the XSD has no `nPedRegEvento`).
 */
export async function requestCancellation(
  ctx: MutationCtx,
  scopeArgs: IssuanceScope,
  idempotencyKey: string,
  args: { issuanceId: string; reasonCode: Infer<typeof cancelReason>; reason: string },
  keyHash?: string,
  connectionId?: Id<"stripeConnections">,
): Promise<{ reused: boolean; issuance: IssuanceView }> {
  const scope = scopeOf(scopeArgs);
  const actor = await issuanceAccess(ctx, scope, "cancel", keyHash, connectionId);
  await requireProductionGate(ctx, scope, "cancel");
  const reason = args.reason.trim().replace(/\s+/g, " ");
  if (reason.length < 15 || reason.length > 255 || hasControl(reason))
    return deny("CANCEL_REASON_INVALID");
  // The simulator also reads the cancellation reason; in production it would go to a real event.
  if (scope.environment === "production" && hasSimulationMarker(reason))
    return deny("CANCEL_REASON_INVALID");
  const request = JSON.stringify({
    issuanceId: args.issuanceId,
    reasonCode: args.reasonCode,
    reason,
  });
  if (await existingOperation(ctx, scope, cancelTask.name, idempotencyKey)) {
    const replay: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
      internal.operations.reserve,
      {
        ...scope,
        ...keyArg(keyHash, connectionId),
        key: idempotencyKey,
        request,
        task: cancelTask,
      },
    );
    const cancellation = await ctx.db
      .query("issuanceCancellations")
      .withIndex("by_operationId", (q) => q.eq("operationId", replay.operationId))
      .unique();
    const issuance = cancellation ? await ctx.db.get("issuances", cancellation.issuanceId) : null;
    if (!issuance) return deny("NOT_FOUND");
    return { reused: true, issuance: await issuanceView(ctx, issuance) };
  }
  // A person cancels any issuance of the company; a key or a connection, only its project's.
  const issuance = await scopedIssuance(
    ctx,
    keyHash !== undefined || connectionId !== undefined
      ? scope
      : { ...scope, projectId: undefined },
    args.issuanceId,
  );
  const current = issuance.cancellationId
    ? await ctx.db.get("issuanceCancellations", issuance.cancellationId)
    : null;
  if (issuance.state === "cancelled" || current?.state === "processing")
    return { reused: true, issuance: await issuanceView(ctx, issuance) };
  if (issuance.state !== "authorized" || !issuance.accessKey)
    return deny("ISSUANCE_NOT_CANCELLABLE");
  // The event goes to the same world that authorized the invoice.
  const mode = transportModeFor(scope);
  if (mode !== issuance.transport) return deny("ISSUANCE_TRANSPORT_CHANGED");
  const certificate = await certificatePin(ctx, scope, mode);
  const reserved: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
    internal.operations.reserve,
    {
      ...scope,
      ...keyArg(keyHash, connectionId),
      key: idempotencyKey,
      request,
      task: cancelTask,
      ...(certificate ? { certificate } : {}),
    },
  );
  if (reserved.reused) return { reused: true, issuance: await issuanceView(ctx, issuance) };
  await reserveCapacity(
    ctx,
    scope.organizationId,
    "filesBytes",
    `issuance:${reserved.operationId}`,
    16 * 1024 * 1024,
  );
  const previous = await ctx.db
    .query("issuanceCancellations")
    .withIndex("by_issuanceId", (q) => q.eq("issuanceId", issuance._id))
    .take(100);
  const now = Date.now();
  const cancellationId = await ctx.db.insert("issuanceCancellations", {
    ...scope,
    issuanceId: issuance._id,
    operationId: reserved.operationId,
    sequence: previous.length + 1,
    reasonCode: args.reasonCode,
    reason,
    requestedAt: dhBrasilia(new Date(now)),
    state: "processing",
    submissions: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch("issuances", issuance._id, {
    cancellationId,
    version: issuance.version + 1,
    updatedAt: now,
  });
  await issuanceEvent(ctx, issuance, "cancel_requested", undefined, reserved.operationId);
  await recordAudit(ctx, {
    ...scope,
    actor,
    action: "issuance.cancel_requested",
    target: issuance._id,
    operationId: reserved.operationId,
  });
  return {
    reused: false,
    issuance: await issuanceView(ctx, (await ctx.db.get("issuances", issuance._id))!),
  };
}

const keyArgs = { ...scopeFields, keyHash: v.optional(v.string()) };

/**
 * REST page of the project's issuances, newest first. The cursor is bound to the scope and the
 * filter, like the document listings; the state filter runs inside the bounded read, so a page
 * may hold fewer items than `limit` and still have a next cursor.
 */
export async function listIssuancePage(
  ctx: QueryCtx,
  scopeArgs: IssuanceScope,
  args: { cursor: string | null; limit: number; state?: IssuanceView["state"] },
  keyHash?: string,
) {
  const scope = scopeOf(scopeArgs);
  await issuanceAccess(ctx, scope, "read", keyHash);
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50)
    return deny("INVALID_PAGINATION");
  const binding = JSON.stringify([
    scope.organizationId,
    scope.projectId,
    scope.companyId,
    scope.environment,
    args.state ?? null,
  ]);
  let cursor: string | null = null;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || typeof decoded.cursor !== "string") throw new Error();
      cursor = decoded.cursor;
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  const state = args.state;
  const indexed = ctx.db
    .query("issuances")
    .withIndex("by_projectId_and_companyId_and_environment_and_createdAt", (q) =>
      q
        .eq("projectId", scope.projectId)
        .eq("companyId", scope.companyId)
        .eq("environment", scope.environment),
    )
    .order("desc");
  const batch = await (
    state ? indexed.filter((q) => q.eq(q.field("state"), state)) : indexed
  ).paginate({ cursor, numItems: args.limit, maximumRowsRead: 100 });
  const page: IssuanceView[] = [];
  for (const row of batch.page)
    if (row.organizationId === scope.organizationId) page.push(await issuanceView(ctx, row));
  return {
    page,
    nextCursor: batch.isDone
      ? null
      : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
  };
}

export const request = internalMutation({
  args: { ...keyArgs, idempotencyKey: v.string(), input: issuanceInput },
  returns: requestResult,
  handler: (ctx, { keyHash, idempotencyKey, input, ...scope }) =>
    requestIssuance(ctx, scope, idempotencyKey, input, keyHash),
});

export const cancel = internalMutation({
  args: {
    ...keyArgs,
    idempotencyKey: v.string(),
    issuanceId: v.string(),
    reasonCode: cancelReason,
    reason: v.string(),
  },
  returns: requestResult,
  handler: (ctx, { keyHash, idempotencyKey, issuanceId, reasonCode, reason, ...scope }) =>
    requestCancellation(ctx, scope, idempotencyKey, { issuanceId, reasonCode, reason }, keyHash),
});

export const get = internalQuery({
  args: { ...keyArgs, issuanceId: v.string() },
  returns: issuanceViewValidator,
  handler: async (ctx, { keyHash, issuanceId, ...scope }) => {
    await issuanceAccess(ctx, scope, "read", keyHash);
    return issuanceView(ctx, await scopedIssuance(ctx, scope, issuanceId));
  },
});

/** Newest first, only the issuances requested through this project. */
export const list = internalQuery({
  args: { ...keyArgs, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(issuanceViewValidator),
  handler: async (ctx, { keyHash, paginationOpts, ...scope }) => {
    await issuanceAccess(ctx, scope, "read", keyHash);
    const page = await ctx.db
      .query("issuances")
      .withIndex("by_projectId_and_companyId_and_environment_and_createdAt", (q) =>
        q
          .eq("projectId", scope.projectId)
          .eq("companyId", scope.companyId)
          .eq("environment", scope.environment),
      )
      .order("desc")
      .paginate(boundedPagination(paginationOpts));
    const rows: IssuanceView[] = [];
    // The project was authorized above; each row still proves its organization.
    for (const row of page.page)
      if (row.organizationId === scope.organizationId) rows.push(await issuanceView(ctx, row));
    return { ...page, page: rows };
  },
});

/**
 * Production gate of one company (ADR 0004 §8, amendments of 21/10/2026). Internal only: no
 * member, API key or public function reaches it, and only on the fiscal production deployment.
 * `enable` comes from the approved workflow (operator, a different approver, run id and attempt,
 * `lib/issuanceGate.ts`) and needs the company in `FNFE_NFSE_PRODUCTION_COMPANIES` and an
 * organization that is not closing.
 * `emergency_disable` comes from the separate workflow without approval and is always possible.
 * Each change appends an `issuanceGateEvents` row and rewrites `issuanceGates`, the current state,
 * in the same transaction, plus the operational audit.
 */
export const setProductionGate = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    kind: v.union(v.literal("enable"), v.literal("emergency_disable")),
    operator: v.string(),
    actor: v.optional(v.string()),
    approver: v.optional(v.string()),
    reason: v.string(),
    runId: v.string(),
    runAttempt: v.number(),
  },
  returns: v.object({ production: v.boolean(), version: v.number() }),
  handler: async (ctx, { organizationId, companyId, ...change }) => {
    if (requirePlatformEnvironment().issuanceEnv !== "production")
      return deny("ISSUANCE_GATE_DEPLOYMENT_DENIED");
    const company = await ctx.db.get("companies", companyId);
    if (!company || company.organizationId !== organizationId) return deny("NOT_FOUND");
    if (company.kind === "demonstration") return deny("ISSUANCE_DEMONSTRATION_DENIED");
    const request = gateRequest(change);
    // Closing never opens anything: it stays possible for a closing organization or a company the
    // list no longer has. Opening needs all of them.
    if (request.production) {
      if (!productionCompanies().has(companyId)) return deny("ISSUANCE_GATE_COMPANY_DENIED");
      if (await closureOf(ctx, organizationId)) return deny("ORGANIZATION_CLOSED");
    }
    const gate: Doc<"issuanceGates"> | null = await productionGate(ctx, companyId);
    const last = await ctx.db
      .query("issuanceGateEvents")
      .withIndex("by_companyId_and_version", (q) => q.eq("companyId", companyId))
      .order("desc")
      .first();
    // The history numbers the change, even if the derived state was lost or restored older.
    const version = Math.max(last?.version ?? 0, gate?.version ?? 0) + 1;
    const now = Date.now();
    const eventId = await ctx.db.insert("issuanceGateEvents", {
      organizationId,
      companyId,
      version,
      ...request,
      buildSha,
      deployment: process.env.CONVEX_CLOUD_URL ?? "",
      createdAt: now,
    });
    const fields = {
      organizationId,
      companyId,
      production: request.production,
      // The customer may see this state and the audit; the logins stay in the history.
      actor: FREECORPS_OPERATOR,
      reason: request.reason,
      version,
      updatedAt: now,
      eventId,
    };
    if (gate) await ctx.db.replace("issuanceGates", gate._id, fields);
    else await ctx.db.insert("issuanceGates", fields);
    await recordAudit(ctx, {
      organizationId,
      companyId,
      environment: "production",
      actor: FREECORPS_OPERATOR,
      action: request.production ? "issuance.production_enabled" : "issuance.production_disabled",
      target: companyId,
    });
    return { production: request.production, version };
  },
});
