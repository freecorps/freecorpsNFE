import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { captureTask, isCaptureProcessing } from "./captureValues";
import { certificateHead, certificateUsable } from "./certificateAccess";
import { baseEnvironment } from "./environmentAccess";
import {
  CAPTURE_FISCAL_HALTED,
  CAPTURE_TERMS_PENDING,
  captureFiscalHalted,
  captureRelease,
  captureTermsExpired,
  captureReleaseState,
  fiscalCaptureEnabled,
  ownCertificate,
} from "./fiscalCaptureRelease";
import { isIssuanceProductionDeployment } from "./issuanceProduction";
import { closureOf } from "./organizationClosure";
import { isConsoleProject } from "./projectAccess";

/**
 * Real NF-e capture on the hosted site (ADR 0007, phase 4): released companies query the
 * distribution in production, without the #50 manual policy. `FISCAL_ENV` stays `disabled`
 * there, since it names the deployment-wide fiscal mode of the #50 proof; the site uses two
 * switches of its own, and neither one opens anything without a released company:
 *
 * - `FNFE_CAPTURE_FISCAL=enabled`: companies may release the capture (`fiscalCaptureRelease.ts`);
 * - `FNFE_CAPTURE_TRANSPORT=sefaz`: the real adapter answers for them.
 *
 * The persisted general stop (`captureFiscalHalts`, #424) closes both gates below for every
 * company, without editing a variable: `prepare` postpones the query and the vault refuses.
 *
 * Every query is authorized again by the release, the company's own A1 and the hourly ceiling,
 * in `prepare` before any reservation and in `certificateUse.authorize` before the vault opens.
 */
export const SITE_CAPTURE_ACTION = "capture-production";
/** Authorized queries per company in any hour, a ceiling above the source windows (1 s / 1 h). */
export const SITE_CAPTURE_HOURLY_LIMIT = 120;
const HOUR = 3_600_000;

/** The deployment switches, read on every call (Node may replace `process.env`). */
export function siteCaptureProfile() {
  return (
    process.env.APP_ENV === "installation" &&
    process.env.FISCAL_ENV === "disabled" &&
    process.env.FNFE_CAPTURE_TRANSPORT === "sefaz" &&
    fiscalCaptureEnabled() &&
    !isIssuanceProductionDeployment(process.env)
  );
}

/** A production capture operation of the hosted site, whatever the switches say now. */
export function isSiteCapture(op: Doc<"operations">) {
  return (
    process.env.APP_ENV === "installation" &&
    op.environment === "production" &&
    op.task.name === captureTask.name &&
    op.task.executor === captureTask.executor &&
    op.task.reconciler === captureTask.reconciler
  );
}

/**
 * How long a capture waits before checking the general stop again: the source's own shortest
 * window at the end of the queue, so a resume costs at most what a normal cycle already waits,
 * and each recheck is one claim per company per hour.
 */
export const HALT_RECHECK_MS = HOUR;

export type SiteCaptureDecision =
  | { allowed: true }
  | { allowed: false; code: string }
  | {
      allowed: false;
      code: string;
      deferUntil: number;
      /** `captureAudit` action of the deferral. */
      audit: "budget_deferred" | "fiscal_halt_deferred" | "terms_deferred";
    };

/**
 * Whether this production capture operation may query the source now. Refusals carry the code
 * the operation pauses with. The hourly ceiling defers instead, to the end of its window, and so
 * does the Freecorps general stop (#424), by `HALT_RECHECK_MS`: a temporary stop of Freecorps
 * never puts the customer's stream in attention nor asks the customer to resume it. A release
 * past the deadline to accept new terms (#428) waits the same way: accepting them is enough.
 */
export async function siteCaptureDecision(
  ctx: QueryCtx,
  op: Doc<"operations">,
  certificateId: Id<"certificates"> | undefined,
  now = Date.now(),
): Promise<SiteCaptureDecision> {
  if (!isSiteCapture(op) || baseEnvironment() !== "sandbox" || !siteCaptureProfile())
    return { allowed: false, code: "FISCAL_TRANSPORT_DISABLED" };
  const company = await ctx.db.get("companies", op.companyId);
  let streamId: Id<"captureStreams"> | undefined;
  try {
    streamId = (JSON.parse(op.request) as { streamId?: Id<"captureStreams"> }).streamId;
  } catch {
    return { allowed: false, code: "CAPTURE_FISCAL_DENIED" };
  }
  const stream = streamId ? await ctx.db.get("captureStreams", streamId) : null;
  if (
    !company ||
    company.organizationId !== op.organizationId ||
    company.kind !== "declared" ||
    !stream ||
    stream.companyId !== company._id ||
    stream.identity !== company.cnpj ||
    stream.environment !== "production" ||
    stream.service !== "nfe-distribution" ||
    (await closureOf(ctx, op.organizationId)) ||
    (await captureReleaseState(ctx, company)) !== "released"
  )
    return { allowed: false, code: "CAPTURE_FISCAL_DENIED" };
  const cert = certificateId ? await ctx.db.get("certificates", certificateId) : null;
  if (!cert || !ownCertificate(company, cert, now))
    return { allowed: false, code: "CAPTURE_FISCAL_DENIED" };
  // After the company's own refusals, which are real and pause: the stop only postpones.
  if (await captureFiscalHalted(ctx))
    return {
      allowed: false,
      code: CAPTURE_FISCAL_HALTED,
      deferUntil: now + HALT_RECHECK_MS,
      audit: "fiscal_halt_deferred",
    };
  if (await captureTermsExpired(ctx, company, now))
    return {
      allowed: false,
      code: CAPTURE_TERMS_PENDING,
      deferUntil: now + HALT_RECHECK_MS,
      audit: "terms_deferred",
    };
  const recent = await ctx.db
    .query("certificateAudit")
    .withIndex("by_companyId_and_action_and_result", (q) =>
      q.eq("companyId", company._id).eq("action", SITE_CAPTURE_ACTION).eq("result", "authorized"),
    )
    .order("desc")
    .take(SITE_CAPTURE_HOURLY_LIMIT);
  const inWindow = recent.filter((row) => row.createdAt > now - HOUR);
  if (inWindow.length >= SITE_CAPTURE_HOURLY_LIMIT)
    return {
      allowed: false,
      code: "SITE_CAPTURE_HOURLY_LIMIT",
      deferUntil: inWindow.at(-1)!.createdAt + HOUR,
      audit: "budget_deferred",
    };
  return { allowed: true };
}

/**
 * Who authorizes the automatic queries (ADR 0007, §4, #418). A person of the console (owner,
 * admin or operator) starts the production capture, and that first query runs under the person's
 * access, as any console command. From then on, the queries the stream schedules by itself and
 * the processing of their documents run under the company's release, which the company's owner
 * or admin turned on with its own A1 and the terms: a role change or the departure of who clicked
 * "Iniciar" no longer stops them. The release is pinned by its version, so withdrawing it (by the
 * company or the Freecorps emergency) cuts every queued query, and a new release never resumes
 * them: a person starts again. The deployment switch (`FNFE_CAPTURE_FISCAL`) cuts them while it is
 * off, without a new version. Neither cuts the processing of what was already received (#420,
 * `releaseSourceAllowed`). Keys and Stripe connections keep their own source, which their
 * integration revokes.
 */
export const releaseAccessVersion = (release: Doc<"captureReleases">) =>
  `release:${release.version}`;

/**
 * The release source of the continuations of `parent`, or null when it keeps its own source.
 * Same condition as `executionAllowed` for that source: a person's operation in the console
 * project. `operations.reserve` only records people in the console project, so a person's
 * capture elsewhere does not exist today; if it ever does, it keeps the person as its source
 * instead of switching to one that `executionAllowed` would refuse.
 */
export async function releaseSourceFor(ctx: QueryCtx, parent: Doc<"operations">) {
  if (!isSiteCapture(parent) || !parent.sourceMembershipId) return null;
  const project = await ctx.db.get("projects", parent.projectId);
  if (!project || project.organizationId !== parent.organizationId || !isConsoleProject(project))
    return null;
  const company = await ctx.db.get("companies", parent.companyId);
  const release = company ? await captureRelease(ctx, company) : null;
  if (!company || !release || (await captureReleaseState(ctx, company)) !== "released") return null;
  return {
    sourceCaptureReleaseId: release._id,
    sourceAccessVersion: releaseAccessVersion(release),
  };
}

/**
 * Whether the release an operation runs under still holds: the company's own release, at the
 * pinned version and released now, on the site and in production. Project, closure and the
 * environment served are checked by the caller (`executionAllowed`).
 *
 * The processing of a document the capture already stored (`captureProcessingTask`) only needs
 * the release that received it to still be the company's (#420): withdrawn, blocked, released
 * again or cut by the switch, the envelope behind the checkpoint still becomes a document, as the
 * contract keeps what was received. It never carries a certificate, and the task only reads the
 * stored XML, so nothing here reaches the source or the vault.
 */
export async function releaseSourceAllowed(ctx: QueryCtx, op: Doc<"operations">) {
  if (
    !op.sourceCaptureReleaseId ||
    process.env.APP_ENV !== "installation" ||
    op.environment !== "production" ||
    baseEnvironment() !== "sandbox"
  )
    return false;
  const company = await ctx.db.get("companies", op.companyId);
  if (!company || company.organizationId !== op.organizationId || company.kind !== "declared")
    return false;
  const release = await captureRelease(ctx, company);
  if (isCaptureProcessing(op.task))
    return release?._id === op.sourceCaptureReleaseId && release.releasedBefore && !op.certificate;
  return (
    release?._id === op.sourceCaptureReleaseId &&
    releaseAccessVersion(release) === op.sourceAccessVersion &&
    (await captureReleaseState(ctx, company)) === "released"
  );
}

/**
 * The certificate a site capture attempt pins: the company's active A1 now, when it is the
 * company's own (`ownCertificate`) and usable. A renewal between two queries moves the pin; a
 * certificate of another company or CNPJ, expired or missing, gives none.
 */
export async function siteCapturePin(ctx: QueryCtx, op: Doc<"operations">, now = Date.now()) {
  const [company, head] = await Promise.all([
    ctx.db.get("companies", op.companyId),
    certificateHead(ctx, op.companyId),
  ]);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  if (!company || company.organizationId !== op.organizationId || !cert) return null;
  if (!ownCertificate(company, cert, now)) return null;
  const pin = { id: cert._id, version: cert.version };
  return (await certificateUsable(ctx, op, pin, now)) ? pin : null;
}
