import plan from "../../../deploy/issuance-production.json" with { type: "json" };
import { CONVEX_CLOUD_DEPLOYMENT_URL } from "./convexDeployment";

/**
 * Fiscal production of the NFS-e issuance (ADR 0004 §8, phase 4) lives on one dedicated Convex
 * deployment, whose name and URL are versioned in `deploy/issuance-production.json`. An
 * environment variable alone never turns a deployment into fiscal production: changing the env
 * of the shared sandbox, or of the #50 capture target, cannot open it; only a reviewed commit
 * names the deployment. `deployment: null` means none is fiscal production, and everything stays
 * closed. The URL binds the deployment only on Convex Cloud: a self-hosted backend chooses its
 * own origin, and its operator owns that deployment and its code anyway.
 */
export const ISSUANCE_PRODUCTION_MARK = "FNFE_ISSUANCE_ENV";

/**
 * The deployment variables these helpers read. `requirePlatformEnvironment` passes `process.env`,
 * and the issuance modules read the result from the validated profile. The capture still passes
 * `process.env` itself until it moves to the profile too (#130).
 */
export type DeploymentVariables = Readonly<Record<string, string | undefined>>;

function planUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const { version, deployment, url } = value as Record<string, unknown>;
  if (
    version !== 1 ||
    typeof deployment !== "string" ||
    typeof url !== "string" ||
    !CONVEX_CLOUD_DEPLOYMENT_URL.test(url) ||
    url !== `https://${deployment}.convex.cloud`
  )
    return null;
  return url;
}
/** URL of the fiscal production deployment, read once; `null` when the plan names none. */
const PRODUCTION_URL = planUrl(plan);

/**
 * Variables of the sandbox and of the capture proofs. The fiscal production deployment refuses to
 * run with any of them: it never serves the restricted production, the capture or its proofs.
 */
export const issuanceProductionForbiddenVariables = [
  "FNFE_NFSE_SANDBOX_TRANSPORT",
  "FNFE_NFSE_RESTRICTED_COMPANIES",
  "FNFE_FISCAL_PROOF",
  "FNFE_PROOF_FISCAL_ENV",
  "FNFE_CERT_PROOF_ORIGIN",
  "FNFE_CERT_PROOF_CA",
  "FNFE_CAPTURE_FISCAL",
  "FNFE_HOSTED_PROOF",
] as const;

/**
 * Company ids separated by commas. Empty or malformed means none: a list of companies allowed to
 * reach a tax authority fails closed.
 */
export function companyList(raw: string | undefined): ReadonlySet<string> {
  const value = (raw ?? "").trim();
  if (!value) return new Set();
  const ids = value.split(",").map((id) => id.trim());
  return ids.every((id) => /^[a-zA-Z0-9]{1,100}$/.test(id)) ? new Set(ids) : new Set();
}

/**
 * Companies of the fiscal production deployment that may have the production gate
 * (`FNFE_NFSE_PRODUCTION_COMPANIES`, company ids separated by commas). Empty or malformed means
 * none. Only the production deployment may carry the variable.
 */
export const ISSUANCE_PRODUCTION_COMPANIES = "FNFE_NFSE_PRODUCTION_COMPANIES";
export const productionCompanies = (env: DeploymentVariables) =>
  companyList(env[ISSUANCE_PRODUCTION_COMPANIES]);

const named = (env: DeploymentVariables) =>
  PRODUCTION_URL !== null && env.CONVEX_CLOUD_URL === PRODUCTION_URL;
const marked = (env: DeploymentVariables) => env[ISSUANCE_PRODUCTION_MARK] === "production";

/**
 * Whether this deployment is the fiscal production of the issuance: the versioned URL (exact
 * equality), the hosted installation profile and the mark `FNFE_ISSUANCE_ENV=production`, all
 * three. The #50 capture target (`APP_ENV=validation`) never qualifies.
 */
export function isIssuanceProductionDeployment(env: DeploymentVariables) {
  return named(env) && marked(env) && env.APP_ENV === "installation";
}

/**
 * Configuration errors of the fiscal production profile, for `requirePlatformEnvironment`: the
 * mark (even empty) outside the named deployment, and the named deployment without the mark or
 * outside the installation profile. Neither one silently becomes a sandbox.
 */
export function issuanceProductionMisconfigured(env: DeploymentVariables) {
  const present = env[ISSUANCE_PRODUCTION_MARK] !== undefined;
  if (named(env)) return !isIssuanceProductionDeployment(env);
  return present;
}
