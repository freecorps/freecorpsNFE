import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { companyScopeFields } from "./lib/operationValues";
import {
  captureTask,
  captureSummary,
  captureControl,
  isCaptureProcessing,
  ZERO_NSU,
} from "./lib/captureValues";
import {
  captureAccess,
  captureAudit,
  captureView,
  scopedStream,
  streamSituation,
  rejectedProbeReachedEnd,
} from "./lib/captureCore";
import { certificateHead, certificateUsable } from "./lib/certificateAccess";
import { deny, requireManager, requireMembership, requireOwner } from "./lib/organizationAccess";
import {
  continueOperation,
  executionAllowed,
  pauseOperation,
  retryOperation,
} from "./lib/operationCore";
import { hashApiKey } from "./lib/apiKeyCrypto";
import type { DocumentScope } from "./lib/documentCore";
import { ensureConsoleProject } from "./lib/projectAccess";
import { admitStored, gapCeiling, lostRange, nsuAfter } from "./lib/captureGap";
import { originOf, recordOrigin, requireConsoleRecord } from "./lib/operationAccess";
import { stoppedByCut } from "./lib/captureAttention";
import { isSiteCapture, siteCapturePin } from "./lib/siteCapture";
import { emitEvent } from "./lib/webhookOutbox";
import { notesQuotaStop, planFor, requireCapturePlan } from "./lib/usageCore";
import { noteLimit } from "./lib/usageValues";
import { firstCreation } from "./lib/coldArchiveOrigin";
import { HISTORY_LIMITED_EVENT } from "@freecorps/contracts/webhooks";

type OwnedScope = DocumentScope & { projectId: Id<"projects"> };
/**
 * A key activates its project's stream. A person activates the company's: an existing stream of
 * the organization, from any project, is shown as it is; a new one belongs to the console
 * project. With a `transferToken`, a manager only receives another organization's stream.
 */
export async function startCapture(
  ctx: MutationCtx,
  scope: OwnedScope,
  keyHash?: string,
  transferToken?: string,
) {
  scope = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: scope.environment,
  };
  const actor = await captureAccess(ctx, scope, true, keyHash);
  const company = (await ctx.db.get("companies", scope.companyId))!;
  if (company.kind !== "declared") return deny("CAPTURE_DEMONSTRATION_DENIED");
  const head = await certificateHead(ctx, company._id);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  if (
    !cert ||
    !(await certificateUsable(ctx, scope, { id: cert._id, version: cert.version }, Date.now()))
  )
    return deny("CERTIFICATE_UNAVAILABLE");
  const existing = await ctx.db
    .query("captureStreams")
    .withIndex("by_identity_environment_service", (q) =>
      q
        .eq("identity", company.cnpj)
        .eq("environment", scope.environment)
        .eq("service", "nfe-distribution"),
    )
    .unique();
  if (
    existing &&
    (existing.organizationId !== scope.organizationId ||
      existing.companyId !== scope.companyId ||
      (keyHash !== undefined && existing.projectId !== scope.projectId))
  ) {
    if (keyHash) return deny("STREAM_CONFLICT");
    const { membership } = await requireMembership(ctx, scope.organizationId);
    requireManager(membership);
    if (
      !transferToken ||
      existing.state !== "paused" ||
      !existing.transferExpiresAt ||
      existing.transferExpiresAt <= Date.now() ||
      (await hashApiKey(transferToken)) !== existing.transferHash
    )
      return deny("STREAM_CONFLICT");
    await ctx.db.patch("captureStreams", existing._id, {
      ...scope,
      version: existing.version + 1,
      state: "paused",
      operationId: undefined,
      transferHash: undefined,
      transferExpiresAt: undefined,
      received: 0,
      code: "TRANSFERRED",
    });
    await captureAudit(ctx, existing, "transfer_released", actor);
    const transferred = (await ctx.db.get("captureStreams", existing._id))!;
    await captureAudit(ctx, transferred, "transfer_received", actor);
    return captureView(ctx, transferred);
  }
  // A code with nothing to receive (no stream, or already this company's) is refused (#461):
  // creating or showing a capture would read as the origin's history received. Any string, even
  // an empty one, asks for a transfer; only its absence is the plain activation.
  if (transferToken !== undefined) {
    const { membership } = await requireMembership(ctx, scope.organizationId);
    requireManager(membership);
    return deny("TRANSFER_NOT_FOUND");
  }
  if (existing) return captureView(ctx, existing);
  const id = await ctx.db.insert("captureStreams", {
    ...scope,
    identity: company.cnpj,
    service: "nfe-distribution",
    version: 1,
    state: "paused",
    checkpoint: ZERO_NSU,
    mode: "distNSU",
    nextAllowedAt: 0,
    received: 0,
    createdAt: Date.now(),
  });
  await captureAudit(ctx, (await ctx.db.get("captureStreams", id))!, "activated", actor);
  return controlCapture(ctx, scope, "resume", 1, keyHash);
}
/** The new operation runs in the actor's project: the key's, or the console project for people. */
export async function controlCapture(
  ctx: MutationCtx,
  scope: OwnedScope,
  action: "sync" | "pause" | "resume",
  expectedVersion: number,
  keyHash?: string,
) {
  scope = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: scope.environment,
  };
  const actor = await captureAccess(ctx, scope, true, keyHash);
  const stream = await scopedStream(
    ctx,
    keyHash !== undefined ? scope : { ...scope, projectId: undefined },
  );
  if (!stream) return deny("NOT_FOUND");
  // People see the company's stream, but control only one the console activated or received.
  if (keyHash === undefined) await requireConsoleRecord(ctx, stream);
  if (stream.version !== expectedVersion) return deny("OPERATION_CONFLICT");
  const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
  if (action === "pause") {
    if (op && !["succeeded", "failed", "paused"].includes(op.state))
      await pauseOperation(ctx, op, "PAUSED_BY_USER", actor);
    await ctx.db.patch("captureStreams", stream._id, {
      state: "paused",
      version: stream.version + 1,
      code: "PAUSED_BY_USER",
    });
  } else {
    if (action === "sync" && stream.state !== "active") return deny("CAPTURE_PAUSED");
    // On the site, a 656 is resumed only after the source window: retrying sooner would extend
    // the block for every system that reads the CNPJ (ADR 0007, §4).
    if (
      process.env.APP_ENV === "installation" &&
      stream.environment === "production" &&
      stream.code === "SOURCE_CONSUMPTION_BLOCKED" &&
      stream.nextAllowedAt > Date.now()
    )
      throw new ConvexError({ code: "SOURCE_COOLDOWN", nextAllowedAt: stream.nextAllowedAt });
    if (op && stream.state === "active" && !["succeeded", "failed", "paused"].includes(op.state))
      return captureView(ctx, stream);
    await startQuery(ctx, scope, stream, op, keyHash);
  }
  await captureAudit(ctx, stream, action, actor);
  return captureView(ctx, (await ctx.db.get("captureStreams", stream._id))!);
}
/**
 * A new query of the stream, continuing `op`, in the actor's project: the next version, active,
 * with the source window and any durable batch kept. Shared by resume, sync and an accepted gap.
 */
async function startQuery(
  ctx: MutationCtx,
  scope: OwnedScope,
  stream: Doc<"captureStreams">,
  op: Doc<"operations"> | null,
  keyHash?: string,
) {
  let mode = op?.uncertain ? ("consNSU" as const) : stream.mode;
  // Resume also repairs streams whose 589 was committed before this policy
  // existed. Reuse durable evidence instead of spending another source call.
  if (mode === "consNSU" && op?.state === "succeeded" && !op.uncertain) {
    const batch = await ctx.db
      .query("captureBatches")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique();
    if (batch?.committed && rejectedProbeReachedEnd(stream, batch)) mode = "distNSU";
  }
  // A new production query needs the plan with finite quotas (#429), before anything
  // is written. An uncertain one is reconciled under the usage key it already charged.
  if (!op?.uncertain) await requireCapturePlan(ctx, scope.organizationId, scope.environment);
  // Resume durable work under a new actor/certificate without discarding the old batch or source window.
  const pin = await companyPin(ctx, scope);
  if (!pin) return deny("CERTIFICATE_UNAVAILABLE");
  const version = stream.version + 1;
  const result: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
    internal.operations.reserve,
    {
      ...scope,
      ...(keyHash ? { keyHash } : {}),
      certificate: pin,
      key: `stream:${stream._id}:${version}`,
      task: captureTask,
      request: JSON.stringify({
        streamId: stream._id,
        version,
        previousOperationId: op?._id ?? null,
      }),
    },
  );
  await ctx.db.patch("captureStreams", stream._id, {
    state: "active",
    version,
    operationId: result.operationId,
    transferHash: undefined,
    transferExpiresAt: undefined,
    code: undefined,
    mode,
  });
  return result.operationId;
}
/** The company's active A1, when it is usable now. */
async function companyPin(ctx: QueryCtx, scope: DocumentScope) {
  const head = await certificateHead(ctx, scope.companyId);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  const pin = cert ? { id: cert._id, version: cert.version } : null;
  return pin && (await certificateUsable(ctx, scope, pin, Date.now())) ? pin : null;
}
/**
 * The stopped query of an integration's stream, ready to be continued after a person accepted
 * the loss (#442): under the integration's own source (its key), project and webhooks, with the
 * company's current A1, as `captureProcessing.resumeEligible` continues a paused one. A source
 * that lost its access (key revoked or expired, grant or scope withdrawn, project disabled)
 * continues nothing, and the acceptance is refused before anything is written.
 */
async function integrationParent(
  ctx: MutationCtx,
  stream: Doc<"captureStreams">,
  op: Doc<"operations"> | null,
) {
  if (
    !op ||
    op.organizationId !== stream.organizationId ||
    op.companyId !== stream.companyId ||
    op.projectId !== stream.projectId
  )
    return deny("OPERATION_CONFLICT");
  const pin = isSiteCapture(op) ? await siteCapturePin(ctx, op) : await companyPin(ctx, op);
  if (!pin) return deny("CERTIFICATE_UNAVAILABLE");
  const parent = { ...op, certificate: pin };
  if (!(await executionAllowed(ctx, parent))) return deny("INTEGRATION_ACCESS_REVOKED");
  return parent;
}
const nsuRange = v.object({ from: v.string(), to: v.string(), count: v.number() });
/**
 * What the console tells about gaps (#419): the range lost at the bottom of a gap the source no
 * longer has, which the owner may accept (`acceptGap`); the range still being recovered; and the
 * losses already accepted, with who, when and why. Not part of the REST connection.
 */
const gapSummary = v.object({
  lost: v.union(
    v.null(),
    v.object({
      ...nsuRange.fields,
      quietSince: v.union(v.number(), v.null()),
      detectedAt: v.union(v.number(), v.null()),
    }),
  ),
  recovering: v.union(v.null(), nsuRange),
  accepted: v.array(
    v.object({
      ...nsuRange.fields,
      acceptedAt: v.number(),
      acceptedBy: v.union(v.string(), v.null()),
      reason: v.union(v.string(), v.null()),
    }),
  ),
});
const rangeOf = (from: string, to: string) => ({
  from,
  to,
  count: Number(BigInt(to) - BigInt(from) + 1n),
});
/**
 * Accepted losses shown in the console, newest first: only rows of the stream's current
 * organization, so a capture received by transfer does not show the reasons the organization it
 * came from wrote, as in `history`.
 */
const ACCEPTED_SHOWN = 5;
async function gapView(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const lost = await lostRange(ctx, stream);
  const ceiling =
    stream.state === "active" && stream.mode === "consNSU" ? await gapCeiling(ctx, stream) : null;
  const rows = await ctx.db
    .query("captureAudit")
    .withIndex("by_streamId_and_action_and_createdAt", (q) =>
      q.eq("streamId", stream._id).eq("action", HISTORY_LIMITED),
    )
    .order("desc")
    .take(ACCEPTED_SHOWN);
  const accepted = [];
  for (const row of rows) {
    if (!row.lost || row.organizationId !== stream.organizationId) continue;
    const id = row.actor.startsWith("member:")
      ? ctx.db.normalizeId("memberships", row.actor.slice("member:".length))
      : null;
    const member = id ? await ctx.db.get("memberships", id) : null;
    accepted.push({
      ...rangeOf(row.lost.from, row.lost.to),
      acceptedAt: row.createdAt,
      acceptedBy: member?.organizationId === stream.organizationId ? member.name : null,
      reason: row.lost.reason ?? null,
    });
  }
  return {
    lost: lost
      ? {
          ...rangeOf(lost.from, lost.to),
          quietSince: stream.recovery?.quietSince ?? null,
          detectedAt: stream.recovery?.detectedAt ?? null,
        }
      : null,
    recovering:
      ceiling && ceiling > nsuAfter(stream.checkpoint)
        ? rangeOf(nsuAfter(stream.checkpoint), nsuAfter(ceiling, -1n))
        : null,
    accepted,
  };
}
const HISTORY_LIMITED = "history_limited";
/** Longest reason for accepting a loss (#442); the console shows the same limit. */
const GAP_REASON_MAX = 500;
/** The owner's reason, trimmed: required, at most `GAP_REASON_MAX`, no control characters. */
function gapReason(value: string) {
  const reason = value.trim();
  // Line breaks and tabs from the text box stay; other control characters are refused.
  const control = (char: string) => (char < " " && !"\t\n\r".includes(char)) || char === "\u007F";
  if (!reason || reason.length > GAP_REASON_MAX || reason.split("").some(control))
    deny("GAP_REASON_INVALID");
  return reason;
}
/**
 * Console: the company's stream, whichever project activated it, and its origin, so the console
 * offers pause, resume and sync only on a stream it controls (`requireConsoleRecord`).
 * `freecorpsCut` says the attention came from the Freecorps cut by variable and the capture is on
 * again (#601, `stoppedByCut`); only for the stream's own code, which the general stop and
 * pending terms of an active stream replace. `countsNotes` says the plan caps this stream's new
 * queries by new notes (ADR 0010), and `notesQuota` that its `QUOTA_EXCEEDED` is that limit, so the
 * console names it. None is part of the REST connection, whose `code` stays the stream's.
 */
export const get = query({
  args: companyScopeFields,
  returns: v.union(
    v.object({
      ...captureSummary.fields,
      origin: recordOrigin,
      gap: gapSummary,
      freecorpsCut: v.boolean(),
      /** The plan caps new queries of this stream by new notes, not by queries (ADR 0010). */
      countsNotes: v.optional(v.boolean()),
      /**
       * The stream's `QUOTA_EXCEEDED` is the notes limit: the notes of the pause's month reached
       * it (`notesQuotaStop`). Absent for any other code or quota.
       */
      notesQuota: v.optional(v.boolean()),
      /**
       * An active production stream whose company has not accepted the current terms: from this
       * deadline on it waits for them (`CAPTURE_TERMS_PENDING`). A query never reads the clock,
       * so the console compares it with its own (#45).
       */
      termsDeadline: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, scope) => {
    await captureAccess(ctx, scope, false);
    const stream = await scopedStream(ctx, scope);
    if (!stream) return null;
    const situation = await streamSituation(ctx, stream);
    const view = await captureView(ctx, stream, situation);
    return {
      ...view,
      termsDeadline: situation.termsDeadline,
      origin: await originOf(ctx, stream),
      gap: await gapView(ctx, stream),
      freecorpsCut: view.code === stream.code && stoppedByCut(stream),
      ...(noteLimit(await planFor(ctx, scope.organizationId), "captures", scope.environment) !==
      null
        ? { countsNotes: true }
        : {}),
      ...((await notesQuotaStop(ctx, stream, view.code)) ? { notesQuota: true } : {}),
    };
  },
});
/** Queries shown in the panel's history (#433), and the audit rows read to find them. */
const HISTORY_SHOWN = 10;
const HISTORY_ROWS = 200;
const QUERY_STARTS = ["query_started", "reconciliation_started"];
/** A row the stream wrote when it went to attention: the action is the code itself. */
const attentionRow = (action: string) => /^[A-Z][A-Z0-9_]*$/.test(action);
const historyEntry = v.object({
  /** When the query was about to leave, after the quota and the source window were reserved. */
  at: v.number(),
  /** `recovery`: a query for one record missing in the sequence, or the check of a lost answer. */
  kind: v.union(v.literal("query"), v.literal("recovery")),
  /**
   * `answered`: the source answered with documents (138) or none (137); `refused`: it answered
   * with another code (`status`: 656, 108, …); `not-sent`: refused before leaving (the vault),
   * and the quota given back; `stopped`: the capture stopped with `code` and no answer kept;
   * `unanswered`: no answer was kept and the capture went on; `running`: the newest, still out.
   */
  outcome: v.union(
    v.literal("answered"),
    v.literal("refused"),
    v.literal("not-sent"),
    v.literal("stopped"),
    v.literal("unanswered"),
    v.literal("running"),
  ),
  status: v.union(v.string(), v.null()),
  /** Documents (envelopes) of an answered query; `null` for the other outcomes. */
  documents: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
});
/**
 * Console (#433): the company's last queries to the source, newest first, at most
 * `HISTORY_SHOWN`: when, what came back and how many documents. Read from the stream's own audit
 * (`captureAudit`), where every query writes its start, and from the batch its answer was kept
 * in; only rows of the stream's current organization, so a capture received by transfer does not
 * show the queries of the organization it came from. The same access as `get`.
 */
export const history = query({
  args: companyScopeFields,
  returns: v.array(historyEntry),
  handler: async (ctx, scope) => {
    await captureAccess(ctx, scope, false);
    const stream = await scopedStream(ctx, scope);
    if (!stream) return [];
    const rows = (
      await ctx.db
        .query("captureAudit")
        .withIndex("by_streamId", (q) => q.eq("streamId", stream._id))
        .order("desc")
        .take(HISTORY_ROWS)
    )
      .filter((row) => row.organizationId === stream.organizationId)
      // Oldest first by first creation (ADR 0009, §5, item 6): rehydrated rows got a new
      // `_creationTime`, after the audits written while the organization was archived.
      .sort((a, b) => firstCreation(a) - firstCreation(b));
    type Entry = {
      at: number;
      kind: "query" | "recovery";
      batchId: Id<"captureBatches"> | null;
      refused: boolean;
      code: string | null;
    };
    const entries: Entry[] = [];
    for (const row of rows) {
      if (QUERY_STARTS.includes(row.action)) {
        entries.push({
          at: row.createdAt,
          kind: row.action === "query_started" ? "query" : "recovery",
          batchId: null,
          refused: false,
          code: null,
        });
        continue;
      }
      const entry = entries.at(-1);
      if (!entry) continue;
      if (row.action === "checkpoint_committed" && row.batchId && !entry.batchId)
        entry.batchId = row.batchId;
      else if (row.action === "query_refused") entry.refused = true;
      else if (attentionRow(row.action) && !entry.code) entry.code = row.action;
    }
    const shown = entries.slice(-HISTORY_SHOWN).reverse();
    // The newest query is still out while its operation runs and nothing answered after it.
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    const inFlight =
      !!op &&
      !["succeeded", "failed", "paused"].includes(op.state) &&
      (stream.lastAttemptAt ?? 0) > (stream.lastSuccessAt ?? 0);
    return Promise.all(
      shown.map(async (entry, index) => {
        const batch = entry.batchId ? await ctx.db.get("captureBatches", entry.batchId) : null;
        const answer = batch?.streamId === stream._id && batch.status ? batch : null;
        const outcome = answer
          ? ["137", "138"].includes(answer.status!)
            ? ("answered" as const)
            : ("refused" as const)
          : entry.refused
            ? ("not-sent" as const)
            : entry.code
              ? ("stopped" as const)
              : index === 0 && inFlight && entry.at >= stream.lastAttemptAt!
                ? ("running" as const)
                : ("unanswered" as const);
        return {
          at: entry.at,
          kind: entry.kind,
          outcome,
          status: answer?.status ?? null,
          documents: outcome === "answered" ? (answer!.envelopeCount ?? 0) : null,
          code: entry.code,
        };
      }),
    );
  },
});
async function consoleScope(ctx: MutationCtx, scope: DocumentScope): Promise<OwnedScope> {
  const { membership } = await requireMembership(ctx, scope.organizationId);
  return { ...scope, projectId: await ensureConsoleProject(ctx, membership) };
}
export const activate = mutation({
  args: { ...companyScopeFields, transferToken: v.optional(v.string()) },
  returns: captureSummary,
  handler: async (ctx, { transferToken, ...scope }) =>
    startCapture(ctx, await consoleScope(ctx, scope), undefined, transferToken),
});
export const control = mutation({
  args: { ...companyScopeFields, action: captureControl, expectedVersion: v.number() },
  returns: captureSummary,
  handler: async (ctx, { action, expectedVersion, ...scope }) =>
    controlCapture(ctx, await consoleScope(ctx, scope), action, expectedVersion),
});
/**
 * "Aceitar a perda e continuar" (#419): the owner of the organization, with access to
 * the company, accepts that the bottom of a gap the source no longer has is lost (NT 2014.002
 * v1.40, §3.6: an NSU answered 137 is to be disregarded; §3: 90 days). The confirmation repeats
 * the range the console showed and the stream version it read: a different range, a stream that
 * changed (resume, pause, withdrawal, another acceptance) or a gap whose limit is still unknown
 * is refused. The checkpoint moves to the last lost NSU, the envelopes already recovered above it
 * are admitted in order, and the stream goes on: `consNSU` while something above is still
 * missing, `distNSU` from the source cursor afterwards. The loss stays in the stream's audit as
 * `history_limited`, with the range, the person, the time and the reason. Retrying the same
 * confirmation answers the stream as it is, without a second effect. Console only: a decision
 * with a fiscal loss belongs to the organization's owner, with a written reason, never to an
 * administrator or an API key (owner's decision of 26/10/2026, ADR 0008).
 *
 * A stream an integration started (#442) is decided here too, by the same person: the API has no
 * such action, and the stream stays the integration's. Its next query continues the stopped one
 * under the integration's key, project and webhooks (`integrationParent`), never the console's,
 * and the integration's endpoints get `connection.history_limited` with the range. It is the one
 * write of the console on an integration's capture (ADR 0005, §1; exception accepted on 26/10/2026).
 */
export const acceptGap = mutation({
  args: {
    ...companyScopeFields,
    expectedVersion: v.number(),
    from: v.string(),
    to: v.string(),
    reason: v.string(),
  },
  returns: captureSummary,
  handler: async (ctx, { expectedVersion, from, to, reason: given, ...args }) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    requireOwner(membership);
    const reason = gapReason(given);
    const actor = `member:${membership._id}`;
    await captureAccess(ctx, args, true);
    const stream = await scopedStream(ctx, args);
    if (!stream) return deny("NOT_FOUND");
    if (stream.version !== expectedVersion) {
      const last = await ctx.db
        .query("captureAudit")
        .withIndex("by_streamId_and_action_and_createdAt", (q) =>
          q.eq("streamId", stream._id).eq("action", HISTORY_LIMITED),
        )
        .order("desc")
        .first();
      if (
        last?.lost?.from === from &&
        last.lost.to === to &&
        last.lost.confirmedVersion === expectedVersion
      )
        return captureView(ctx, stream);
      return deny("OPERATION_CONFLICT");
    }
    const lost = await lostRange(ctx, stream);
    if (!lost) return deny("GAP_NOT_ACCEPTABLE");
    if (lost.from !== from || lost.to !== to) return deny("GAP_CONFIRMATION_MISMATCH");
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    if (op && !["succeeded", "failed", "paused"].includes(op.state))
      return deny("OPERATION_CONFLICT");
    const integration = (await originOf(ctx, stream)).kind === "integration";
    const parent = integration ? await integrationParent(ctx, stream, op) : null;
    await captureAudit(ctx, stream, HISTORY_LIMITED, actor, undefined, {
      from,
      to,
      confirmedVersion: expectedVersion,
      reason,
    });
    const recovery = stream.recovery
      ? { ...stream.recovery, unavailableTo: undefined, probe: undefined }
      : undefined;
    await ctx.db.patch("captureStreams", stream._id, { checkpoint: to, recovery });
    let operationId: Id<"operations">;
    if (parent) {
      const version = stream.version + 1;
      operationId = await continueOperation(
        ctx,
        parent,
        captureTask,
        JSON.stringify({ streamId: stream._id, version, previousOperationId: parent._id }),
        Math.max(Date.now(), stream.nextAllowedAt),
      );
      await ctx.db.patch("captureStreams", stream._id, {
        state: "active",
        version,
        operationId,
        transferHash: undefined,
        transferExpiresAt: undefined,
      });
    } else
      operationId = await startQuery(
        ctx,
        await consoleScope(ctx, args),
        (await ctx.db.get("captureStreams", stream._id))!,
        op,
      );
    // The recovered NSUs right above the loss go in sequence now, under the new query's access.
    const next = (await ctx.db.get("operations", operationId))!;
    const admitted = await admitStored(ctx, next, stream._id, to, stream.received);
    const position = { _id: stream._id, ...admitted, sourceCursor: stream.sourceCursor };
    const missing = (await gapCeiling(ctx, position)) !== null;
    await ctx.db.patch("captureStreams", stream._id, {
      ...admitted,
      mode: missing ? "consNSU" : "distNSU",
      recovery: missing ? recovery : undefined,
      // Cleared by the next answer; the range stays in the audit.
      code: "HISTORY_LIMITED",
    });
    const accepted = (await ctx.db.get("captureStreams", stream._id))!;
    // The integration learns of the loss by its own webhook (#442), once: in this transaction, keyed
    // by the stream version the acceptance created; a retry answers above without reaching here.
    // The range and the role go; the person and the reason stay in the console's audit.
    if (parent)
      await emitEvent(ctx, {
        organizationId: accepted.organizationId,
        companyId: accepted.companyId,
        projectId: accepted.projectId,
        environment: accepted.environment,
        type: HISTORY_LIMITED_EVENT,
        resourceType: "connection",
        resourceId: accepted._id,
        resourceVersion: accepted.version,
        logicalKey: `connection:${accepted._id}:history_limited:${accepted.version}`,
        operationIds: [operationId],
        data: { lost: { from, to }, decidedBy: "owner" },
      });
    return captureView(ctx, accepted);
  },
});
export const release = mutation({
  args: { ...companyScopeFields, expectedVersion: v.number() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    requireManager(membership);
    const scope = {
      organizationId: args.organizationId,
      companyId: args.companyId,
      environment: args.environment,
    };
    await controlCapture(ctx, await consoleScope(ctx, scope), "pause", args.expectedVersion);
    const stream = (await scopedStream(ctx, args))!;
    const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
    const batch = op
      ? await ctx.db
          .query("captureBatches")
          .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
          .unique()
      : null;
    if (
      op?.uncertain ||
      (batch && !batch.committed) ||
      stream.mode === "consNSU" ||
      (stream.sourceCursor && stream.checkpoint < stream.sourceCursor)
    )
      return deny("RECONCILIATION_REQUIRED");
    const token = crypto.randomUUID() + crypto.randomUUID(),
      expiresAt = Date.now() + 15 * 60_000;
    await ctx.db.patch("captureStreams", stream._id, {
      transferHash: await hashApiKey(token),
      transferExpiresAt: expiresAt,
    });
    await captureAudit(ctx, stream, "transfer_authorized", membership.authUserId);
    return { token, expiresAt };
  },
});

/** Envelopes read per transaction; each one reads its operation, and the eligible ones its access. */
const RESUME_PAGE = 50;
/**
 * What the resumption did, summed over its pages: `resumed` left `paused`; `refused` kept by its
 * source (`executionAllowed`); `stillPaused`, by the code it paused with again inside
 * `retryOperation` (the recovery budget or the attempts), retried but not running.
 */
const resumeCounts = v.object({
  resumed: v.number(),
  refused: v.number(),
  stillPaused: v.record(v.string(), v.number()),
});
/**
 * One-time resumption, after the deploy of #420, of the documents a production capture already
 * received but never processed: before it, withdrawing the release or the general cut
 * (`FNFE_CAPTURE_FISCAL`) paused the `documents.capture` continuations with `ACCESS_REVOKED`, and
 * their NSU are behind the checkpoint, so no later query brings them again. No cron runs on the
 * site; the runbook (`docs/operacao/captura-fiscal.md`) calls it once with the deploy key, and it
 * continues by itself, page by page, until the last envelope.
 *
 * Only a `documents.capture` in production paused with `ACCESS_REVOKED` is touched, and only when
 * its own source admits it now (`executionAllowed`): a closed organization, a company that left,
 * a revoked project, grant or key, or a person who lost access keep it paused, counted as
 * refused. One that `retryOperation` pauses again (recovery budget, attempts) counts under
 * `stillPaused` with that code, never as resumed. Nothing queries the source or opens the vault: the operation has no certificate and
 * its executor only reads the stored XML. Running it again leaves alone an operation already
 * resumed, and the processing never duplicates a document (one version per operation, the
 * document deduplicated by fiscal key).
 */
export const resumeStoredDocuments = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), totals: v.optional(resumeCounts) },
  returns: v.object({ ...resumeCounts.fields, isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("captureEnvelopes")
      .paginate({ numItems: RESUME_PAGE, cursor: args.cursor ?? null });
    const totals = {
      resumed: args.totals?.resumed ?? 0,
      refused: args.totals?.refused ?? 0,
      stillPaused: { ...args.totals?.stillPaused },
    };
    for (const envelope of page.page) {
      const op = envelope.operationId ? await ctx.db.get("operations", envelope.operationId) : null;
      if (
        !op ||
        op.state !== "paused" ||
        op.code !== "ACCESS_REVOKED" ||
        op.environment !== "production" ||
        !isCaptureProcessing(op.task)
      )
        continue;
      if (!(await executionAllowed(ctx, op))) {
        totals.refused++;
        continue;
      }
      await retryOperation(ctx, op, op.uncertain, "CAPTURE_DOCUMENT_RESUMED");
      // The evidence of the runbook: only what really left `paused` counts as resumed.
      const after = (await ctx.db.get("operations", op._id))!;
      if (after.state !== "paused") totals.resumed++;
      else {
        const code = after.code ?? "UNKNOWN";
        totals.stillPaused[code] = (totals.stillPaused[code] ?? 0) + 1;
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.captures.resumeStoredDocuments, {
        cursor: page.continueCursor,
        totals,
      });
    else
      console.log(
        `captures.resumeStoredDocuments: ${totals.resumed} resumed, ${totals.refused} refused, ` +
          `stillPaused ${JSON.stringify(totals.stillPaused)}`,
      );
    return { ...totals, isDone: page.isDone };
  },
});

/**
 * Read-only list, for the runbook, of the `documents.capture` in production still paused after
 * the resumption: operation, organization, company, code and the kind of source. Ids only, no
 * fiscal data. One page of `captureEnvelopes` per call; pass `continueCursor` until `isDone`.
 */
export const pausedStoredDocuments = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    page: v.array(
      v.object({
        operationId: v.id("operations"),
        organizationId: v.id("organizations"),
        companyId: v.id("companies"),
        code: v.union(v.string(), v.null()),
        source: v.union(
          v.literal("release"),
          v.literal("membership"),
          v.literal("key"),
          v.literal("stripe"),
          v.literal("none"),
        ),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const envelopes = await ctx.db
      .query("captureEnvelopes")
      .paginate({ numItems: RESUME_PAGE, cursor: args.cursor ?? null });
    const page = [];
    for (const envelope of envelopes.page) {
      const op = envelope.operationId ? await ctx.db.get("operations", envelope.operationId) : null;
      if (
        !op ||
        op.state !== "paused" ||
        op.environment !== "production" ||
        !isCaptureProcessing(op.task)
      )
        continue;
      page.push({
        operationId: op._id,
        organizationId: op.organizationId,
        companyId: op.companyId,
        code: op.code ?? null,
        source: op.sourceCaptureReleaseId
          ? ("release" as const)
          : op.sourceMembershipId
            ? ("membership" as const)
            : op.sourceKeyId
              ? ("key" as const)
              : op.sourceStripeConnectionId
                ? ("stripe" as const)
                : ("none" as const),
      });
    }
    return { page, continueCursor: envelopes.continueCursor, isDone: envelopes.isDone };
  },
});
