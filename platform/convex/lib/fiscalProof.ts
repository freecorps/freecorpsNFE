import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildSha } from "../buildInfo";
import { captureTask } from "./captureValues";
import { CONVEX_CLOUD_DEPLOYMENT_URL } from "./convexDeployment";

export type ProofFiscalEnvironment = "homologation" | "production";

/**
 * Fiscal environment of the dedicated #50 target, fixed when the code is published.
 * Production exists only there, to read the distribution of NF-e already received;
 * it never issues, cancels or manifests. Any other deployment stays in homologation.
 */
export function proofFiscalTarget(): ProofFiscalEnvironment {
  return process.env.APP_ENV === "validation" && process.env.FNFE_PROOF_FISCAL_ENV === "production"
    ? "production"
    : "homologation";
}

/** Platform environment whose streams reach the given fiscal environment. */
export const productEnvironmentOf = (fiscal: ProofFiscalEnvironment) =>
  fiscal === "production" ? ("production" as const) : ("sandbox" as const);

/** Real transport mode: every step is an explicit operator action under the proof policy. */
export const realFiscalMode = () =>
  process.env.FISCAL_ENV === "homologation" || process.env.FISCAL_ENV === "production";

/** Deployment-secret policy for the manually operated #50 proof only. */
export type FiscalProofPolicy = {
  deploymentUrl: string;
  fiscalEnvironment: ProofFiscalEnvironment;
  sha: string;
  organizationId: string;
  projectId: string;
  companyId: string;
  certificateId: string;
  certificateVersion: number;
  fingerprint: string;
  cnpj: string;
  startsAt: number;
  expiresAt: number;
  maxRequests: number;
};

export function fiscalProofPolicy(): FiscalProofPolicy | null {
  try {
    const value: unknown = JSON.parse(process.env.FNFE_FISCAL_PROOF ?? "");
    if (!value || typeof value !== "object") return null;
    const p = value as Record<string, unknown>;
    if (
      !["organizationId", "projectId", "companyId", "certificateId"].every(
        (field) => typeof p[field] === "string" && /^[a-zA-Z0-9]{1,100}$/.test(p[field]),
      ) ||
      (p.fiscalEnvironment !== "homologation" && p.fiscalEnvironment !== "production") ||
      typeof p.deploymentUrl !== "string" ||
      !CONVEX_CLOUD_DEPLOYMENT_URL.test(p.deploymentUrl) ||
      typeof p.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(p.sha) ||
      typeof p.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.fingerprint) ||
      typeof p.cnpj !== "string" ||
      !/^\d{14}$/.test(p.cnpj) ||
      typeof p.certificateVersion !== "number" ||
      !Number.isSafeInteger(p.certificateVersion) ||
      p.certificateVersion < 1 ||
      typeof p.startsAt !== "number" ||
      !Number.isSafeInteger(p.startsAt) ||
      typeof p.expiresAt !== "number" ||
      !Number.isSafeInteger(p.expiresAt) ||
      p.expiresAt <= p.startsAt ||
      p.expiresAt - p.startsAt > 3 * 3_600_000 ||
      typeof p.maxRequests !== "number" ||
      !Number.isSafeInteger(p.maxRequests) ||
      p.maxRequests < 1 ||
      p.maxRequests > 2
    )
      return null;
    return p as FiscalProofPolicy;
  } catch {
    return null;
  }
}

/** The caller writes the authorization audit in the same transaction as this read.
 * Counts all authorizations for this certificate, even failed/uncertain calls;
 * changing the policy window does not refill the budget. */
export async function fiscalProofAllowed(
  ctx: QueryCtx,
  op: Doc<"operations">,
  cert: Doc<"certificates">,
) {
  const p = fiscalProofPolicy();
  const now = Date.now();
  // The policy names the fiscal environment it authorizes; the target must match it.
  const fiscal = proofFiscalTarget();
  if (
    !p ||
    process.env.APP_ENV !== "validation" ||
    p.fiscalEnvironment !== fiscal ||
    process.env.FISCAL_ENV !== fiscal ||
    process.env.FNFE_CAPTURE_TRANSPORT !== "sefaz" ||
    process.env.PRODUCT_ENV !== productEnvironmentOf(fiscal) ||
    process.env.FNFE_CRONS !== "off" ||
    process.env.WEBHOOK_MODE !== "disabled" ||
    process.env.EMAIL_MODE !== "disabled" ||
    p.deploymentUrl !== process.env.CONVEX_CLOUD_URL ||
    p.sha !== buildSha ||
    now < p.startsAt ||
    now >= p.expiresAt ||
    op.environment !== productEnvironmentOf(fiscal) ||
    op.task.name !== captureTask.name ||
    op.task.executor !== captureTask.executor ||
    op.task.reconciler !== captureTask.reconciler ||
    op.organizationId !== p.organizationId ||
    op.projectId !== p.projectId ||
    op.companyId !== p.companyId ||
    cert._id !== p.certificateId ||
    cert.organizationId !== p.organizationId ||
    cert.companyId !== p.companyId ||
    cert.version !== p.certificateVersion ||
    cert.metadata?.cnpj !== p.cnpj ||
    cert.metadata.fingerprint !== p.fingerprint
  )
    return false;
  const company = await ctx.db.get("companies", op.companyId);
  if (company?.cnpj !== p.cnpj) return false;
  const calls = await ctx.db
    .query("certificateAudit")
    .withIndex("by_certificateId_and_action_and_result", (q) =>
      q.eq("certificateId", cert._id).eq("action", "transport").eq("result", "authorized"),
    )
    .take(p.maxRequests);
  return calls.length < p.maxRequests;
}
