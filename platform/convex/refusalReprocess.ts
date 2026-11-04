import { ConvexError, v, type Infer } from "convex/values";
import { syncNfseBatch } from "./lib/unclassifiedArtifacts";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { activeClaim, continueOperation, executionAllowed } from "./lib/operationCore";
import { claimFields, companyScopeFields, operationState, outcome } from "./lib/operationValues";
import { memberAccess, projectAccess } from "./lib/operationAccess";
import { findCompany } from "./lib/companyAccess";
import { consoleProject, ensureConsoleProject } from "./lib/projectAccess";
import { importTask, NFE_PARSER_VERSION, PROCESSOR_VERSION, refusalTask } from "./lib/importValues";
import { captureProcessingTask } from "./lib/captureValues";
// Keys composed with IDs of archivable rows use their first ID (ADR 0009, §5, item 5), so a
// repetition after a rehydration finds the same record and never redoes the effect.
import { firstId } from "./lib/coldArchiveOrigin";

/**
 * Reprocessing of the technical refusals of a company and environment (#499): originals without
 * a document whose newest published version was refused with a code a newer parser can resolve.
 * The new interpretation replaces the earlier technical refusal, and both stay in the artifact's
 * history (rule of #395).
 *
 * A person asks. While the run of the company and environment is live (`live`), asking again
 * returns it; otherwise the request opens a new run. One record per company and environment
 * (`current:<company>:<environment>`) points at the latest run; the request reads and rewrites it
 * in the same transaction, so two simultaneous requests never open two runs. Each run sweeps
 * what is, at that moment, still a refusal of an older parser that no live operation handles
 * (`busy`), so a new run only picks what is left.
 *
 * Each original becomes one child operation, recorded under `<run>:<artifact>` (a retry of a
 * page never processes an original twice) and under `latest:<artifact>` (the newest child, which
 * any other run checks before touching the original). The sweep reads one page per attempt and
 * keeps its cursor on the operation (`refusalSweep`); between pages it waits while the children
 * of the page start, one every `CHILD_SPACING_MS`.
 */
/** Codes of a refusal by the parser, never by the content or the company. */
const TECHNICAL_REFUSALS = new Set(["XML_EVENT_UNSUPPORTED", "XML_SCHEMA_UNSUPPORTED"]);
const SWEEP_PAGE = 50;
const CHILD_SPACING_MS = 2_000;
/** Child operations the status reads; past it, the counts are partial. */
const STATUS_LIMIT = 200;

type Scope = Pick<Doc<"operations">, "organizationId" | "projectId">;

/**
 * Not terminal: queued, running, waiting (`retry_wait`, `reconciling`), or paused while a person
 * can still resume it in Operação e suporte, with the same checks as `controlOperation`
 * (recoveries left, attempts left or an uncertain effect to reconcile, the source still allowed).
 * A run paused for good (access revoked, attempts exhausted) is not live.
 */
async function live(ctx: QueryCtx, op: Doc<"operations"> | null) {
  if (!op || op.state === "succeeded" || op.state === "failed") return false;
  if (op.state !== "paused") return true;
  if ((op.recoveryAttempts ?? 0) >= 12) return false;
  if (op.uncertain && !op.task.reconciler) return false;
  const exhausted = op.attempts >= op.maxAttempts && !["response", "checkpoint"].includes(op.stage);
  if (exhausted && !op.uncertain) return false;
  return sourceAllowed(ctx, op);
}
/**
 * What `executionAllowed` checks for a resumption, without its clock-bound branches, so a query
 * may ask: the project and grant epochs, and the person who asked (the source of every run and of
 * its children). Another source (an API key, the capture release, a Stripe connection) is only
 * reached through an original a different operation holds; its own pause code says whether the
 * source cut it.
 */
async function sourceAllowed(ctx: QueryCtx, op: Doc<"operations">) {
  try {
    const { project, grant } = await projectAccess(ctx, op);
    if (project.accessEpoch !== op.projectEpoch || grant.accessEpoch !== op.grantEpoch)
      return false;
  } catch (error) {
    if (error instanceof ConvexError && error.data?.code === "NOT_FOUND") return false;
    throw error;
  }
  if (op.sourceCaptureReleaseId || !op.sourceMembershipId) return op.code !== "ACCESS_REVOKED";
  const membership = await ctx.db.get("memberships", op.sourceMembershipId);
  if (
    !membership ||
    membership.organizationId !== op.organizationId ||
    !["owner", "admin", "operator"].includes(membership.role)
  )
    return false;
  const access = await findCompany(ctx, membership, op.companyId);
  return !!access && access.accessVersion === op.sourceAccessVersion;
}
function record(ctx: QueryCtx, scope: Scope, key: string) {
  return ctx.db
    .query("idempotencyRecords")
    .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
      q
        .eq("organizationId", scope.organizationId)
        .eq("projectId", scope.projectId)
        .eq("name", refusalTask.name)
        .eq("key", key),
    )
    .unique();
}
const currentKey = (scope: Pick<Doc<"operations">, "companyId" | "environment">) =>
  `current:${scope.companyId}:${scope.environment}`;
async function operationAt(ctx: QueryCtx, scope: Scope, key: string) {
  const found = await record(ctx, scope, key);
  return found ? await ctx.db.get("operations", found.operationId) : null;
}
function childRecords(ctx: QueryCtx, op: Doc<"operations">) {
  return ctx.db
    .query("idempotencyRecords")
    .withIndex("by_organizationId_and_projectId_and_name_and_key", (q) =>
      q
        .eq("organizationId", op.organizationId)
        .eq("projectId", op.projectId)
        .eq("name", refusalTask.name)
        .gte("key", `${firstId(op)}:`)
        .lt("key", `${firstId(op)};`),
    );
}
/** `documentId` of the outcome `importProcessing.published` leaves in the response. */
function publishedDocument(response: string | undefined) {
  let value: unknown = null;
  try {
    value = response ? JSON.parse(response) : null;
  } catch {
    return false;
  }
  return value && typeof value === "object" && "documentId" in value
    ? typeof value.documentId === "string"
    : false;
}
/** Whether a live operation already handles the original. */
async function busy(ctx: QueryCtx, op: Doc<"operations">, artifact: Doc<"documentArtifacts">) {
  const at = async (id: Id<"operations"> | undefined) =>
    !!id && (await live(ctx, await ctx.db.get("operations", id)));
  // The newest child of any run, this one's earlier runs included.
  if (await live(ctx, await operationAt(ctx, op, `latest:${firstId(artifact)}`))) return true;
  // A reprocessing asked elsewhere (REST, the capture) may not have written a version yet.
  if (await at(artifact.processingOperationId)) return true;
  const file = artifact.fileId ? await ctx.db.get("importFiles", artifact.fileId) : null;
  if (await at(file?.processingOperationId)) return true;
  const unpublished = await ctx.db
    .query("documentVersions")
    .withIndex("by_artifactId_and_publishedAt", (q) =>
      q.eq("artifactId", artifact._id).eq("publishedAt", undefined),
    )
    .take(10);
  for (const version of unpublished) if (await at(version.operationId)) return true;
  return false;
}
/**
 * `candidate` when the artifact's newest published version is a technical refusal of an older
 * parser and no live operation handles the original; `busy` when one does; `null` otherwise. A
 * leftover version of an operation that ended does not hold it back.
 */
async function olderRefusal(
  ctx: QueryCtx,
  op: Doc<"operations">,
  artifact: Doc<"documentArtifacts">,
): Promise<"candidate" | "busy" | null> {
  const latest = await ctx.db
    .query("documentVersions")
    .withIndex("by_artifactId_and_publishedAt", (q) => q.eq("artifactId", artifact._id))
    .order("desc")
    .first();
  if (
    !latest ||
    latest.publishedAt === undefined ||
    latest.entryIndex !== undefined ||
    !TECHNICAL_REFUSALS.has(latest.code) ||
    latest.parserVersion === NFE_PARSER_VERSION
  )
    return null;
  return (await busy(ctx, op, artifact)) ? "busy" : "candidate";
}
/** What the first `STATUS_LIMIT` children of a run became; `partial` past them. */
async function childCounts(ctx: QueryCtx, op: Doc<"operations">) {
  const counts = { reprocessed: 0, stillRefused: 0, failed: 0, pending: 0 };
  const children = await childRecords(ctx, op).take(STATUS_LIMIT + 1);
  for (const child of children.slice(0, STATUS_LIMIT)) {
    const task = await ctx.db.get("operations", child.operationId);
    if (task?.state === "succeeded") {
      if (publishedDocument(task.response)) counts.reprocessed++;
      else counts.stillRefused++;
    } else if (await live(ctx, task)) counts.pending++;
    else counts.failed++;
  }
  return { ...counts, partial: children.length > STATUS_LIMIT };
}
/**
 * A run counts as live while it is (`live`) or while any child it read is still pending: until
 * then, asking again returns it (`request` applies the same rule) and the console follows it.
 */
function runLive(op: Doc<"operations">, counts: { pending: number }, opLive: boolean) {
  return opLive || (op.state === "succeeded" && counts.pending > 0);
}
async function upsertRecord(
  ctx: MutationCtx,
  op: Doc<"operations">,
  key: string,
  operationId: Id<"operations">,
) {
  const existing = await record(ctx, op, key);
  if (existing) await ctx.db.patch("idempotencyRecords", existing._id, { operationId });
  else
    await ctx.db.insert("idempotencyRecords", {
      organizationId: op.organizationId,
      projectId: op.projectId,
      name: refusalTask.name,
      key,
      requestHash: op.requestHash,
      operationId,
    });
}
async function reprocessRefusal(
  ctx: MutationCtx,
  op: Doc<"operations">,
  artifact: Doc<"documentArtifacts">,
  at: number,
) {
  // A captured original keeps the processing of the capture (`capture-processing`), which the
  // environment serves even after the release is withdrawn (#420); an imported one is reprocessed
  // as `documents.reprocess` does.
  const child = await continueOperation(
    ctx,
    op,
    artifact.source === "distribution-xml"
      ? captureProcessingTask
      : { ...importTask, name: "documents.reprocess" },
    JSON.stringify({ artifactId: artifact._id, processorVersion: PROCESSOR_VERSION }),
    at,
    false,
  );
  // The import panel follows the file's current operation, of the batch's own project only.
  if (artifact.fileId && artifact.projectId === op.projectId) {
    await ctx.db.patch("importFiles", artifact.fileId, { processingOperationId: child });
    await syncNfseBatch(ctx, artifact._id);
  }
  await upsertRecord(ctx, op, `${firstId(op)}:${firstId(artifact)}`, child);
  await upsertRecord(ctx, op, `latest:${firstId(artifact)}`, child);
}

/** Console: owner, admin or operator of the company asks; viewer and developer are refused. */
export const request = mutation({
  args: companyScopeFields,
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: async (ctx, args): Promise<{ operationId: Id<"operations">; reused: boolean }> => {
    const { membership } = await memberAccess(ctx, { ...args, task: refusalTask }, true);
    const projectId = await ensureConsoleProject(ctx, membership);
    const scope = { ...args, projectId };
    // Read and rewritten here: a concurrent request conflicts on it and sees the run opened.
    const pointer = await record(ctx, scope, currentKey(args));
    const current = pointer ? await ctx.db.get("operations", pointer.operationId) : null;
    if (
      current &&
      ((await live(ctx, current)) ||
        (current.state === "succeeded" && (await childCounts(ctx, current)).pending > 0))
    )
      return { operationId: current._id, reused: true };
    const reserved: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
      internal.operations.reserve,
      {
        ...scope,
        // Only unique per run (each previous run opens at most one after it): the pointer above,
        // not this key, decides whether a run is reused.
        key: `${args.companyId}:${args.environment}:${current ? firstId(current) : "first"}`,
        task: refusalTask,
        request: JSON.stringify({ parser: NFE_PARSER_VERSION }),
      },
    );
    const { operationId } = reserved;
    const op = (await ctx.db.get("operations", operationId))!;
    await upsertRecord(ctx, op, currentKey(args), operationId);
    return { operationId, reused: false };
  },
});
async function allowed(run: () => Promise<unknown>) {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof ConvexError && ["NOT_FOUND", "SCOPE_DENIED"].includes(error.data?.code))
      return false;
    throw error;
  }
}
/** Whether `request` would admit this person: the same access check, for the console. */
export const canRequest = query({
  args: companyScopeFields,
  returns: v.boolean(),
  handler: (ctx, args) => allowed(() => memberAccess(ctx, { ...args, task: refusalTask }, true)),
});
/** Whether `status` would admit this person (owner, admin, operator or viewer of the company). */
export const canRead = query({
  args: companyScopeFields,
  returns: v.boolean(),
  handler: (ctx, args) =>
    allowed(() => memberAccess(ctx, { ...args, task: { scope: "documents:read" } }, false)),
});

const statusValue = v.object({
  operationId: v.id("operations"),
  state: operationState,
  code: v.union(v.string(), v.null()),
  /** The sweep went through every page and the run succeeded. */
  done: v.boolean(),
  /**
   * Not terminal (`live`) or with a child still pending (`runLive`): asking again returns this
   * run; otherwise it opens a new one.
   */
  live: v.boolean(),
  /** Originals the sweep sent to reprocessing so far. */
  requested: v.number(),
  /** Originals it skipped because an earlier operation still handles them. */
  busy: v.number(),
  reprocessed: v.number(),
  stillRefused: v.number(),
  /** Children that ended without concluding: a new run may pick their originals again. */
  failed: v.number(),
  pending: v.number(),
  partial: v.boolean(),
});
/** The most recent run of the company and environment, if any, and what its children became. */
export const status = query({
  args: companyScopeFields,
  returns: v.union(v.null(), statusValue),
  handler: async (ctx, args): Promise<Infer<typeof statusValue> | null> => {
    // Reading keeps working after a withdrawal, like the documents it produced.
    await memberAccess(ctx, { ...args, task: { scope: "documents:read" } }, false);
    const project = await consoleProject(ctx, args.organizationId);
    const op = project
      ? await operationAt(ctx, { ...args, projectId: project._id }, currentKey(args))
      : null;
    if (!op) return null;
    const counts = await childCounts(ctx, op);
    return {
      operationId: op._id,
      state: op.state,
      code: op.code ?? null,
      done: op.state === "succeeded",
      live: runLive(op, counts, await live(ctx, op)),
      requested: op.refusalSweep?.requested ?? 0,
      busy: op.refusalSweep?.busy ?? 0,
      ...counts,
    };
  },
});

const sweepResult = v.union(
  v.object({ kind: v.literal("lost") }),
  v.object({ kind: v.literal("revoked") }),
  v.object({
    kind: v.literal("page"),
    requested: v.number(),
    total: v.number(),
    done: v.boolean(),
  }),
);
/** One page of originals without a document, from the cursor kept on the operation. */
export const sweep = internalMutation({
  args: { ...claimFields, pageSize: v.optional(v.number()) },
  returns: sweepResult,
  handler: async (ctx, args): Promise<Infer<typeof sweepResult>> => {
    const op = await activeClaim(ctx, args);
    if (!op) return { kind: "lost" };
    if (!(await executionAllowed(ctx, op))) return { kind: "revoked" };
    const progress = op.refusalSweep ?? { cursor: null, requested: 0 };
    let busy = progress.busy ?? 0;
    const page = await ctx.db
      .query("documentArtifacts")
      .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
        q
          .eq("companyId", op.companyId)
          .eq("environment", op.environment)
          .eq("documentId", undefined),
      )
      .paginate({ cursor: progress.cursor, numItems: args.pageSize ?? SWEEP_PAGE });
    let requested = 0;
    const now = Date.now();
    for (const artifact of page.page) {
      if (artifact.organizationId !== op.organizationId || artifact.parentArtifactId) continue;
      if (await record(ctx, op, `${op._id}:${artifact._id}`)) continue;
      const found = await olderRefusal(ctx, op, artifact);
      if (found === "busy") busy++;
      if (found !== "candidate") continue;
      await reprocessRefusal(ctx, op, artifact, now + requested * CHILD_SPACING_MS);
      requested++;
    }
    const total = progress.requested + requested;
    // The cursor commits with the children of the page: a retry resumes after them.
    await ctx.db.patch("operations", op._id, {
      refusalSweep: { cursor: page.continueCursor, requested: total, busy },
    });
    return { kind: "page", requested, total, done: page.isDone };
  },
});

/**
 * Executor: one page per attempt. A page with more to read waits (no attempt spent) until its
 * children have started; the last one succeeds. The processing itself runs in the children.
 */
export const execute = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: async (ctx, args): Promise<Infer<typeof outcome>> => {
    const claim = { operationId: args.operationId, generation: args.generation, fence: args.fence };
    const page = await ctx.runMutation(internal.refusalReprocess.sweep, claim);
    // A lost claim records nothing (`recordOutcome` ignores it); recovery resumes from the cursor.
    if (page.kind === "lost") return { kind: "uncertain", code: "LEASE_LOST" };
    // `recordOutcome` pauses it as ACCESS_REVOKED, a decision and not a source failure.
    if (page.kind === "revoked") return { kind: "definitive", code: "ACCESS_REVOKED" };
    if (!page.done)
      return {
        kind: "wait",
        code: "SWEEP_CONTINUES",
        notBefore: Date.now() + Math.max(1_000, page.requested * CHILD_SPACING_MS),
      };
    return { kind: "success", response: JSON.stringify({ requested: page.total }) };
  },
});
