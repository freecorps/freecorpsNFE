// Publication of the second target: the NFS-e fiscal production deployment (#198, ADR 0004 §8),
// with its own console and API domains on its own Worker. Pure checks; the runner is
// `scripts/deploy-issuance-production.mjs`. The hosted sandbox keeps its own pipeline
// (`deploy.yml`, `scripts/deploy-platform.mjs`), which never reads this plan.
//
// Out of scope, recorded on purpose: a Convex custom domain for the backend (the plan binds the
// deployment to its `https://<name>.convex.cloud` URL, and the own domains are the Worker's, as in
// the sandbox) and a regional Convex Cloud URL (the plan accepts only the default region).
import { resolve } from "node:path";
import { GateRefusal, productionTarget } from "./issuance-gate.mjs";

const refuse = (code, message) => {
  throw new GateRefusal(code, message);
};

/**
 * The publication is an approved action, like the gate's `enable` (`verifiedRun`): this workflow,
 * approved in its environment by a person in `authorizedActors` other than who dispatched it. The
 * environment's required reviewers alone are not the check: without them (GitHub Free, private
 * repository) the run has no approval and nothing is published.
 */
export const RELEASE_WORKFLOWS = {
  publish: {
    file: ".github/workflows/deploy-issuance-production.yml",
    environment: "nfse-production-release",
    approved: true,
  },
};

/**
 * Variables of the sandbox and of the capture proofs, which the fiscal production deployment never
 * carries. The same list as `issuanceProductionForbiddenVariables` in
 * `platform/convex/lib/issuanceProduction.ts` (a test keeps both equal).
 */
export const ISSUANCE_FORBIDDEN_VARIABLES = [
  "FNFE_NFSE_SANDBOX_TRANSPORT",
  "FNFE_NFSE_RESTRICTED_COMPANIES",
  "FNFE_FISCAL_PROOF",
  "FNFE_PROOF_FISCAL_ENV",
  "FNFE_CERT_PROOF_ORIGIN",
  "FNFE_CERT_PROOF_CA",
  "FNFE_CAPTURE_FISCAL",
  "FNFE_HOSTED_PROOF",
];

const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
function ownOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return refuse("RELEASE_INVALID", `${label} não é uma origem.`);
  }
  if (url.protocol !== "https:" || url.origin !== value)
    refuse("RELEASE_INVALID", `${label} precisa ser uma origem https, sem caminho.`);
  if (/(^|\.)(convex\.cloud|convex\.site|workers\.dev)$/.test(url.hostname))
    refuse("RELEASE_INVALID", `${label} precisa ser um domínio próprio, não do provedor.`);
  return value;
}

/**
 * The target of the publication: the deployment named in `deploy/issuance-production.json` and
 * its `release` (Worker, Cloudflare account, console and API origins). While the plan names no
 * deployment, or names one without `release`, nothing is published. The release never reuses the
 * hosted sandbox's Worker or domains, nor the validation target's.
 */
export function issuanceReleaseTarget(plan, sandbox, validation) {
  const target = productionTarget(plan);
  const release = plan.release;
  if (release === null || release === undefined)
    refuse(
      "RELEASE_NOT_PLANNED",
      "deploy/issuance-production.json nomeia o deployment, mas não o Worker e os domínios " +
        '("release": null). Nada é publicado.',
    );
  if (
    typeof release !== "object" ||
    Object.keys(release).sort().join() !== "accountId,api,frontend,worker"
  )
    refuse("RELEASE_INVALID", "release precisa de worker, accountId, frontend e api.");
  if (!WORKER.test(release.worker) || release.worker === sandbox.worker)
    refuse("RELEASE_INVALID", "release.worker inválido ou igual ao do sandbox hospedado.");
  if (!ACCOUNT.test(release.accountId)) refuse("RELEASE_INVALID", "release.accountId inválido.");
  const frontend = ownOrigin(release.frontend, "release.frontend");
  const api = ownOrigin(release.api, "release.api");
  const taken = [sandbox.frontend, sandbox.api, validation.consoleUrl];
  if (frontend === api || taken.includes(frontend) || taken.includes(api))
    refuse("RELEASE_INVALID", "Os domínios precisam ser próprios, distintos e não do sandbox.");
  return { ...target, worker: release.worker, accountId: release.accountId, frontend, api };
}

/**
 * The variables the deployment must have before a publication: the installation profile in fiscal
 * production, marked, with its own origins, and none of the sandbox or capture variables.
 */
export function issuanceReleaseEnvironment(actual, target) {
  for (const [key, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "production",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    FNFE_ISSUANCE_ENV: "production",
    WEBHOOK_MODE: "https",
    SITE_URL: target.frontend,
    AUTH_PROXY_MODE: "signed",
    API_URL: target.api,
  }))
    if (actual[key] !== value) refuse("ENVIRONMENT_MISMATCH", `Variável do backend: ${key}`);
  for (const name of ISSUANCE_FORBIDDEN_VARIABLES)
    if (actual[name] !== undefined) refuse("ENVIRONMENT_MISMATCH", `Variável proibida: ${name}`);
  const capture = actual.FNFE_CAPTURE_TRANSPORT;
  if (capture !== undefined && capture !== "" && capture !== "disabled")
    refuse("ENVIRONMENT_MISMATCH", "Variável do backend: FNFE_CAPTURE_TRANSPORT");
}

/**
 * The offsite backup target of the fiscal production deployment: the planned deployment, in the
 * same R2 account and bucket as the sandbox's copies, under its own prefix. While the plan names
 * no deployment, `productionTarget` refuses with `PLAN_NOT_NAMED` and the backup skips it.
 */
export function issuanceBackupTarget(plan, accountId) {
  const target = productionTarget(plan);
  return { deployment: target.deployment, cloud: target.cloud, site: target.site, accountId };
}

/** The Worker of the fiscal production console and API, apart from the sandbox's. */
export function issuanceReleaseWorker(target, root) {
  return {
    name: target.worker,
    account_id: target.accountId,
    main: resolve(root, "deploy/selfhost/worker.ts"),
    compatibility_date: "2026-09-28",
    workers_dev: false,
    preview_urls: false,
    routes: [target.frontend, target.api].map((origin) => ({
      pattern: new URL(origin).hostname,
      custom_domain: true,
    })),
    secrets: { required: ["AUTH_PROXY_SECRET"] },
    vars: {
      BACKEND_SITE_URL: target.site,
      CONSOLE_ORIGIN: target.frontend,
      API_ORIGIN: target.api,
    },
    assets: {
      directory: resolve(root, ".selfhost/hosted-production/dist"),
      binding: "ASSETS",
      run_worker_first: ["/api/auth/*", "/v1/*", "/health", "/docs/404"],
      not_found_handling: "none",
    },
  };
}

/**
 * The SHA approved in the dispatch (`approved_sha`) must be the full SHA of the run's checkout:
 * otherwise the CI and the publication would be silently skipped.
 */
export function approvedRevision(approved, sha) {
  if (typeof approved !== "string" || !/^[a-f0-9]{40}$/.test(approved) || approved !== sha)
    refuse(
      "APPROVED_SHA_MISMATCH",
      "approved_sha precisa ser o SHA completo (40 caracteres) da main que este run publica.",
    );
  return approved;
}

/**
 * After the publication, the backend and the public API answer the published revision as the
 * fiscal production: strict, no field missing. A different SHA is a publication still spreading.
 */
export function issuanceHealth(health, sha) {
  if (!health || health.sha !== sha) return "pending";
  if (
    health.status !== "ok" ||
    health.appEnv !== "installation" ||
    health.productEnv !== "production" ||
    health.fiscalEnv !== "disabled" ||
    health.issuanceEnv !== "production" ||
    // Older revisions omit the field; the fiscal production never captures for the site.
    (health.captureFiscal ?? "disabled") !== "disabled"
  )
    refuse("ENVIRONMENT_MISMATCH", "O /health publicado não é o da produção fiscal.");
  return "ready";
}
