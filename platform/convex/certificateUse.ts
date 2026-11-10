import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { buildSha } from "./buildInfo";
import schema from "./schema";
import { claimFields } from "./lib/operationValues";
import { activeClaim, executionAllowed, markEffectSent, type Claim } from "./lib/operationCore";
import { certificateAudit, certificateHead, certificateUsable } from "./lib/certificateAccess";
import { fiscalProofAllowed, realFiscalMode } from "./lib/fiscalProof";
import { attemptUsageKey, captureTask, deferralAudit } from "./lib/captureValues";
import { requireActivePlan, requireCapturePlan, usageError } from "./lib/usageCore";
import { cancelTask, issueTask } from "./lib/issuanceValues";
import { issuanceCertificateAllowed, restrictedTransportAllowed } from "./lib/issuanceCore";
import { FREECORPS_OPERATOR, operatorAndReason } from "./lib/issuanceGate";
import { cutByVariable } from "./lib/captureAttention";
import { isIssuanceProductionDeployment, productionCompanies } from "./lib/issuanceProduction";
import {
  SITE_CAPTURE_ACTION,
  isSiteCapture,
  siteCaptureDecision,
  siteCapturePin,
} from "./lib/siteCapture";

/**
 * Each purpose is audited under its own action. The capture proof counts its budget over
 * `transport`; the NFS-e issuance in the restricted production (`nfse-transport`), in the fiscal
 * production (`nfse-production`) and the operator probe (`nfse-probe`) never spend it, and the
 * capture policy never authorizes them.
 */
const NFSE_TRANSPORT = "nfse-transport";
const NFSE_PRODUCTION = "nfse-production";
const NFSE_PROBE = "nfse-probe";
const NFSE_PROBE_PRODUCTION = "nfse-probe-production";
const nfseAction = (op: Doc<"operations">) =>
  op.environment === "production" ? NFSE_PRODUCTION : NFSE_TRANSPORT;

/** The site capture counts its ceiling over its own action; the #50 budget stays on `transport`. */
const captureAction = (op: Doc<"operations">) =>
  isSiteCapture(op) ? SITE_CAPTURE_ACTION : "transport";

const isNfseTask = (op: Doc<"operations">) =>
  [issueTask, cancelTask].some(
    (task) =>
      op.task.name === task.name &&
      op.task.executor === task.executor &&
      op.task.reconciler === task.reconciler,
  );
const actorOf = (op: Doc<"operations">) =>
  op.sourceKeyId
    ? `key:${op.sourceKeyId}`
    : op.sourceStripeConnectionId
      ? `stripe:${op.sourceStripeConnectionId}`
      : op.sourceCaptureReleaseId
        ? `release:${op.sourceCaptureReleaseId}`
        : `membership:${op.sourceMembershipId}`;

/**
 * Why the vault refused a transport: the code the operation pauses with or, with `defer`, waits
 * with until `defer.until`, audited on the stream as `defer.audit`. `cut` is whether a capture
 * refusal was the Freecorps cut by variable (`cutByVariable`), read with the reading that
 * decided the code: `refusedBeforeSend` runs in another transaction, when the variables may be
 * back (#601).
 */
const refusal = v.object({
  refused: v.string(),
  defer: v.optional(v.object({ until: v.number(), audit: deferralAudit })),
  cut: v.optional(v.boolean()),
});
type Refusal = Infer<typeof refusal>;

/**
 * The vault's decision for one attempt, audited once as `authorized` or `denied`. A refusal says
 * why, so the caller of a transport can tell a pause from a deferral (#421).
 */
async function authorizeUse(
  ctx: MutationCtx,
  args: Claim,
): Promise<{ certificate: Doc<"certificates"> } | Refusal> {
  const op = await activeClaim(ctx, args);
  if (!op) return { refused: "OPERATION_CHANGED" };
  const cert = op.certificate ? await ctx.db.get("certificates", op.certificate.id) : null;
  if (!cert) return { refused: "CERTIFICATE_UNAVAILABLE" };
  if (isNfseTask(op)) {
    // Independent of FISCAL_ENV, which belongs to the capture: the hosted installation keeps
    // it `disabled` and the NFS-e policy has its own variables (`restrictedTransportAllowed`).
    const allowed =
      (await executionAllowed(ctx, op)) && (await issuanceCertificateAllowed(ctx, op));
    await certificateAudit(
      ctx,
      cert,
      nfseAction(op),
      allowed ? "authorized" : "denied",
      actorOf(op),
      op._id,
    );
    return allowed ? { certificate: cert } : { refused: "ACCESS_REVOKED" };
  }
  const localSynthetic =
    process.env.APP_ENV === "development" &&
    process.env.FISCAL_ENV === "disabled" &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.CONVEX_SITE_URL ?? "");
  // Recheck capture even after real transport is disabled: an in-flight action
  // must not acquire the certificate using its earlier environment snapshot.
  // Fiscal production is reachable only through the #50 proof policy.
  // The hosted site's production capture has its own policy (ADR 0007, phase 4).
  const needsProof = realFiscalMode() || op.task.name === captureTask.name;
  let refused: Refusal | null = null;
  if (!(await executionAllowed(ctx, op))) {
    // Told apart as the claim does: the access fell, or the pinned A1 is no longer usable. On
    // the site, an A1 renewed since the claim is not a stop: the next claim pins it (#418).
    if (!(await executionAllowed(ctx, { ...op, certificate: undefined })))
      refused = { refused: "ACCESS_REVOKED" };
    else if (isSiteCapture(op) && (await siteCapturePin(ctx, op)))
      refused = {
        refused: "CERTIFICATE_CHANGED",
        defer: { until: Date.now(), audit: "query_deferred" },
      };
    else refused = { refused: "CERTIFICATE_UNAVAILABLE" };
  } else if (needsProof && !localSynthetic) {
    if (isSiteCapture(op)) {
      // The hourly ceiling and the general stop postpone, as in `prepare`; the wait is the
      // source window's (`SOURCE_COOLDOWN`).
      const decision = await siteCaptureDecision(ctx, op, cert._id);
      if (!decision.allowed)
        refused =
          "deferUntil" in decision
            ? {
                refused: "SOURCE_COOLDOWN",
                defer: { until: decision.deferUntil, audit: decision.audit },
              }
            : { refused: decision.code };
    } else if (!(await fiscalProofAllowed(ctx, op, cert)))
      refused = { refused: "FISCAL_PROOF_DENIED" };
  }
  // A new production query whose plan was withdrawn or ended after `prepare` does not leave
  // (#429): it pauses before the request, as any refusal here, and `refusedBeforeSend` gives
  // back what it charged. One reconciling an uncertain query was admitted under that query's key.
  if (!refused && op.task.name === captureTask.name && op.usageCaptureKey === attemptUsageKey(op))
    refused = await capturePlanRefusal(ctx, op);
  if (refused) refused = { ...refused, cut: cutByVariable(op, refused.refused) };
  await certificateAudit(
    ctx,
    cert,
    captureAction(op),
    refused ? "denied" : "authorized",
    actorOf(op),
    op._id,
  );
  return refused ?? { certificate: cert };
}

async function capturePlanRefusal(ctx: MutationCtx, op: Doc<"operations">) {
  try {
    await requireCapturePlan(ctx, op.organizationId, op.environment);
    if (op.environment === "production") await requireActivePlan(ctx, op.organizationId);
    return null;
  } catch (error) {
    const code = usageError(error);
    if (!code) throw error;
    return { refused: code };
  }
}

/** The certificate of the claimed attempt, or null when the vault refuses it. */
export const authorize = internalMutation({
  args: claimFields,
  returns: v.union(schema.doc("certificates"), v.null()),
  handler: async (ctx, args) => {
    const decision = await authorizeUse(ctx, args);
    return "certificate" in decision ? decision.certificate : null;
  },
});

/**
 * `authorize` for a transport (`transportWithCertificate`): the same decision and audit and, on
 * a refusal, its reason, so the capture pauses with that code or waits until `defer.until`
 * instead of taking a request that never left for an uncertain one (#421).
 */
export const authorizeTransport = internalMutation({
  args: claimFields,
  returns: v.union(v.object({ certificate: schema.doc("certificates") }), refusal),
  handler: (ctx, args) => authorizeUse(ctx, args),
});
export const complete = internalMutation({
  args: { ...claimFields, result: v.union(v.literal("success"), v.literal("failed")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    if (!op?.certificate) return false;
    const cert = await ctx.db.get("certificates", op.certificate.id);
    const claimed = await activeClaim(ctx, args);
    // Success or failure, the request may have left: the attempt can no longer be abandoned as
    // one that sent nothing, even when its access fell meanwhile.
    if (claimed) await markEffectSent(ctx, claimed);
    const current = !!claimed && (await executionAllowed(ctx, op));
    if (cert)
      await certificateAudit(
        ctx,
        cert,
        isNfseTask(op) ? nfseAction(op) : captureAction(op),
        current ? args.result : "stale",
        actorOf(op),
        op._id,
      );
    return current;
  },
});

const probeArgs = {
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  operator: v.string(),
  reason: v.string(),
};
const probeKind = v.union(v.literal("probe"), v.literal("verify-issued"));
const probeEnvironment = v.union(v.literal("producao-restrita"), v.literal("producao"));
const probeRead = v.object({
  target: v.string(),
  host: v.string(),
  outcome: v.string(),
  httpStatus: v.union(v.number(), v.null()),
});
/** The certificate audit of a probe says which world the customer's A1 was used against. */
const probeAction = (environment: "producao-restrita" | "producao") =>
  environment === "producao" ? NFSE_PROBE_PRODUCTION : NFSE_PROBE;

/** The probe history row of Freecorps: the GitHub login stays here, never in the audit. */
async function probeEvent(
  ctx: MutationCtx,
  fields: Omit<
    Doc<"issuanceProbeEvents">,
    "_id" | "_creationTime" | "buildSha" | "deployment" | "createdAt"
  >,
) {
  return ctx.db.insert("issuanceProbeEvents", {
    ...fields,
    buildSha,
    deployment: process.env.CONVEX_CLOUD_URL ?? "",
    createdAt: Date.now(),
  });
}

type ProbeRequest = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  kind: "probe" | "verify-issued";
  issuanceId?: Id<"issuances">;
};

/**
 * Whether the probe may run, and why not. On the fiscal production deployment, the production
 * reads for a company in `FNFE_NFSE_PRODUCTION_COMPANIES`; anywhere else, the restricted production
 * under the sandbox variables (`restrictedTransportAllowed`). `verify-issued` reads an issuance of
 * the fiscal production only: in `production`, authorized or cancelled, frozen for `producao` and
 * `sefin-nacional`, with its access key. The certificate must be active, usable and sealed.
 */
async function probePolicy(ctx: MutationCtx, args: ProbeRequest) {
  const environment = isIssuanceProductionDeployment()
    ? ("producao" as const)
    : ("producao-restrita" as const);
  const denied = (code: string, cert: Doc<"certificates"> | null = null) => ({
    environment,
    code,
    cert,
    issuance: null,
  });
  const company = await ctx.db.get("companies", args.companyId);
  if (!company || company.organizationId !== args.organizationId) return denied("NOT_FOUND");
  if (company.kind === "demonstration") return denied("ISSUANCE_DEMONSTRATION_DENIED");
  let issuance: Doc<"issuances"> | null = null;
  if (args.kind === "verify-issued") {
    issuance = args.issuanceId ? await ctx.db.get("issuances", args.issuanceId) : null;
    if (
      !issuance ||
      issuance.organizationId !== args.organizationId ||
      issuance.companyId !== args.companyId
    )
      return denied("NOT_FOUND");
    if (
      issuance.environment !== "production" ||
      issuance.transport !== "producao" ||
      issuance.target !== "sefin-nacional" ||
      !["authorized", "cancelled"].includes(issuance.state) ||
      !issuance.accessKey
    )
      return denied("ISSUANCE_NOT_AUTHORIZED");
  }
  const head = await certificateHead(ctx, args.companyId);
  const cert = head?.activeId ? await ctx.db.get("certificates", head.activeId) : null;
  if (
    !cert?.envelope ||
    !cert.metadata ||
    !(await certificateUsable(ctx, args, { id: cert._id, version: cert.version }, Date.now()))
  )
    return denied("CERTIFICATE_UNAVAILABLE");
  const allowed =
    environment === "producao"
      ? productionCompanies().has(args.companyId)
      : args.kind === "probe" && restrictedTransportAllowed(args.companyId);
  if (!allowed) return denied("ISSUANCE_PROBE_DISABLED", cert);
  return { environment, code: null, cert, issuance };
}

/**
 * Operator probe of the NFS-e transport (`issuanceProbe.verify` and `verifyIssued`): read-only
 * consultations with the company's active A1, without an operation. Once the operator and the
 * reason are valid, every answer goes to the probe history, with the GitHub login: a refusal too
 * (another organization, company or issuance, a demonstration company, no usable certificate, out
 * of the policy), as a `denied` row with its `code`, so nobody probes without a trace. The use of
 * the certificate is audited for the customer with the generic operator, as `nfse-probe` or, on
 * the fiscal production, `nfse-probe-production`.
 */
export const authorizeProbe = internalMutation({
  args: { ...probeArgs, kind: probeKind, issuanceId: v.optional(v.id("issuances")) },
  returns: v.union(
    v.object({
      certificate: schema.doc("certificates"),
      eventId: v.id("issuanceProbeEvents"),
      environment: probeEnvironment,
      issuance: v.union(
        v.object({ id: v.id("issuances"), dpsId: v.string(), accessKey: v.string() }),
        v.null(),
      ),
    }),
    v.object({ denied: v.string() }),
  ),
  handler: async (ctx, args) => {
    const { operator, reason } = operatorAndReason(args);
    const policy = await probePolicy(ctx, args);
    if (policy.cert)
      await certificateAudit(
        ctx,
        policy.cert,
        probeAction(policy.environment),
        policy.code ? "denied" : "authorized",
        FREECORPS_OPERATOR,
      );
    const eventId = await probeEvent(ctx, {
      organizationId: args.organizationId,
      companyId: args.companyId,
      kind: args.kind,
      environment: policy.environment,
      result: policy.code ? "denied" : "authorized",
      ...(policy.code ? { code: policy.code } : {}),
      operator,
      reason,
      ...(args.issuanceId ? { issuanceId: args.issuanceId } : {}),
    });
    if (policy.code || !policy.cert) return { denied: policy.code ?? "CERTIFICATE_UNAVAILABLE" };
    return {
      certificate: policy.cert,
      eventId,
      environment: policy.environment,
      issuance: policy.issuance
        ? {
            id: policy.issuance._id,
            dpsId: policy.issuance.dpsId,
            accessKey: policy.issuance.accessKey!,
          }
        : null,
    };
  },
});

/**
 * Closes a probe run opened by `authorizeProbe`: once, for an `authorized` row of the same
 * company and certificate. Operator, reason, kind and environment come from that row, never from
 * the caller.
 */
export const completeProbe = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    companyId: v.id("companies"),
    eventId: v.id("issuanceProbeEvents"),
    certificateId: v.id("certificates"),
    version: v.number(),
    result: v.union(v.literal("success"), v.literal("failed")),
    reads: v.array(probeRead),
    single: v.optional(v.union(v.boolean(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const started = await ctx.db.get("issuanceProbeEvents", args.eventId);
    const cert = await ctx.db.get("certificates", args.certificateId);
    if (
      !started ||
      started.result !== "authorized" ||
      started.companyId !== args.companyId ||
      started.organizationId !== args.organizationId ||
      !cert ||
      cert.companyId !== args.companyId ||
      cert.organizationId !== args.organizationId
    )
      return null;
    const closed = await ctx.db
      .query("issuanceProbeEvents")
      .withIndex("by_startedId", (q) => q.eq("startedId", started._id))
      .first();
    if (closed) return null;
    const current =
      cert.version === args.version &&
      (await certificateUsable(ctx, args, { id: cert._id, version: args.version }, Date.now()));
    const result = current ? args.result : "stale";
    await certificateAudit(ctx, cert, probeAction(started.environment), result, FREECORPS_OPERATOR);
    await probeEvent(ctx, {
      organizationId: started.organizationId,
      companyId: started.companyId,
      kind: started.kind,
      environment: started.environment,
      result,
      operator: started.operator,
      reason: started.reason,
      ...(started.issuanceId ? { issuanceId: started.issuanceId } : {}),
      startedId: started._id,
      reads: args.reads,
      ...(args.single !== undefined ? { single: args.single } : {}),
    });
    return null;
  },
});
