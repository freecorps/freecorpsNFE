import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { keyAccess, memberAccess, READ_ROLES } from "./operationAccess";
import { deny } from "./organizationAccess";
import { activeClaim, executionAllowed, type Claim } from "./operationCore";
import { captureTask } from "./captureValues";
import { certificateHead } from "./certificateAccess";
import {
  CAPTURE_FISCAL_HALTED,
  CAPTURE_TERMS_PENDING,
  captureFiscalHalted,
  captureReleaseState,
  captureTermsExpired,
} from "./fiscalCaptureRelease";

/** The source confirms that the probed next NSU does not exist. A known
 * missing range or a regressed/incomplete boundary must never be discarded. */
export function rejectedProbeReachedEnd(
  stream: Doc<"captureStreams">,
  batch: Doc<"captureBatches">,
) {
  return (
    batch.streamId === stream._id &&
    batch.status === "589" &&
    batch.mode === "consNSU" &&
    batch.lastNsu === stream.checkpoint &&
    batch.maxNsu === stream.checkpoint &&
    (!stream.sourceCursor || stream.sourceCursor <= stream.checkpoint)
  );
}

type StreamScope = Pick<Doc<"captureStreams">, "organizationId" | "companyId" | "environment"> & {
  projectId?: Id<"projects">;
};
/** Keys act on their project's stream; people, on the company's stream (`memberAccess`). */
export async function captureAccess(
  ctx: QueryCtx,
  scope: StreamScope,
  write: boolean,
  keyHash?: string,
) {
  const task = {
    ...captureTask,
    scope: write ? ("connections:write" as const) : ("connections:read" as const),
  };
  if (keyHash) {
    if (!scope.projectId) return deny("NOT_FOUND");
    const key = await keyAccess(ctx, keyHash, { ...scope, projectId: scope.projectId, task });
    return `key:${key._id}`;
  }
  const { user } = await memberAccess(ctx, { ...scope, task }, write);
  return user._id;
}
export { captureAttention, captureAudit } from "./captureAttention";
export async function captureClaim(ctx: MutationCtx, claim: Claim) {
  const op = await activeClaim(ctx, claim);
  if (!op || op.task.name !== captureTask.name || !(await executionAllowed(ctx, op))) return null;
  const request = JSON.parse(op.request) as { streamId: Id<"captureStreams">; version: number };
  const stream = await ctx.db.get("captureStreams", request.streamId);
  if (
    !stream ||
    stream.operationId !== op._id ||
    stream.version !== request.version ||
    stream.state !== "active" ||
    stream.organizationId !== op.organizationId ||
    stream.companyId !== op.companyId ||
    stream.projectId !== op.projectId
  )
    return null;
  return { op, stream };
}
/** Whether the stream's company is past the deadline to accept new terms (#428). */
async function termsExpiredFor(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const company = await ctx.db.get("companies", stream.companyId);
  return (
    company?.organizationId === stream.organizationId && (await captureTermsExpired(ctx, company))
  );
}
/**
 * The stream's situation as the console shows it: in attention also while it stays active with
 * its operation stopped, and `halted` during the Freecorps general stop of the site (#424), when
 * an active production stream waits without asking the customer to act. `termsPending`: an active
 * production stream waiting for the company to accept new terms (#428). One rule for the panel
 * (`captureView`) and the badges of the companies (#433, `fiscalCaptureOf`).
 */
export async function streamSituation(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
  const state =
    stream.state === "active" && op && ["paused", "failed"].includes(op.state)
      ? ("attention" as const)
      : stream.state;
  const halted =
    state === "active" &&
    stream.environment === "production" &&
    process.env.APP_ENV === "installation" &&
    (await captureFiscalHalted(ctx));
  const termsPending =
    !halted &&
    state === "active" &&
    stream.environment === "production" &&
    process.env.APP_ENV === "installation" &&
    (await termsExpiredFor(ctx, stream));
  return { op, state, halted, termsPending };
}
export async function captureView(ctx: QueryCtx, stream: Doc<"captureStreams">) {
  const head = await certificateHead(ctx, stream.companyId);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  const { op, state, halted, termsPending } = await streamSituation(ctx, stream);
  return {
    id: stream._id,
    organizationId: stream.organizationId,
    companyId: stream.companyId,
    projectId: stream.projectId,
    environment: stream.environment,
    state,
    version: stream.version,
    checkpoint: stream.checkpoint,
    sourceCursor: stream.sourceCursor ?? null,
    sourceMaxNsu: stream.sourceMaxNsu ?? null,
    nextAllowedAt: stream.nextAllowedAt,
    lastAttemptAt: stream.lastAttemptAt ?? null,
    lastSuccessAt: stream.lastSuccessAt ?? null,
    code: termsPending
      ? CAPTURE_TERMS_PENDING
      : halted
        ? CAPTURE_FISCAL_HALTED
        : (stream.code ?? op?.code ?? null),
    received: stream.received,
    operationId: op?._id ?? null,
    operationState: op?.state ?? null,
    certificateState:
      cert?.metadata && cert.metadata.notAfter <= Date.now()
        ? "expired"
        : (cert?.state ?? "missing"),
    certificateExpiresAt: cert?.metadata?.notAfter ?? null,
  };
}
/** Without a project (the console), the company's stream; with one, only that project's. */
export async function scopedStream(ctx: QueryCtx, scope: StreamScope) {
  const stream = await ctx.db
    .query("captureStreams")
    .withIndex("by_companyId_environment", (q) =>
      q.eq("companyId", scope.companyId).eq("environment", scope.environment),
    )
    .unique();
  if (
    stream &&
    (stream.organizationId !== scope.organizationId ||
      (scope.projectId !== undefined && stream.projectId !== scope.projectId))
  )
    return null;
  return stream;
}

/**
 * The badge of the company's fiscal capture (Produção) in the list of companies and on its page
 * (#433): `null` when there is none to show (never released, withdrawn, or a role that does not
 * read captures), `not-started` while released and never started, otherwise the situation of the
 * panel. The caller already proved the member reaches the company; this reads three documents at
 * most (release, stream and its operation), plus the general stop shared by the query.
 */
export const fiscalCaptureBadge = v.union(
  v.null(),
  v.literal("not-started"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("attention"),
  v.literal("halted"),
  /** Waiting for the company to accept new terms (#428). */
  v.literal("terms"),
);
export async function fiscalCaptureOf(
  ctx: QueryCtx,
  membership: Pick<Doc<"memberships">, "role">,
  company: Doc<"companies">,
): Promise<Infer<typeof fiscalCaptureBadge>> {
  if (!READ_ROLES.includes(membership.role)) return null;
  if ((await captureReleaseState(ctx, company)) !== "released") return null;
  const stream = await scopedStream(ctx, {
    organizationId: company.organizationId,
    companyId: company._id,
    environment: "production",
  });
  if (!stream) return "not-started";
  const { state, halted, termsPending } = await streamSituation(ctx, stream);
  return halted ? "halted" : termsPending ? "terms" : state;
}
