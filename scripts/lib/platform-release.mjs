import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { isProjectRepository } from "./repository.mjs";
import { probeHash } from "./validation-deploy.mjs";
import { smokeFailureDetails, smokeDiagnosticText } from "./smoke-diagnostic.mjs";

export function releaseEnvironment(actual, target, operation) {
  if (!["bootstrap", "release"].includes(operation)) throw new Error("Unknown release operation");
  for (const [key, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    // The maintainer authorized keeping HTTPS delivery active on 2026-10-07.
    WEBHOOK_MODE: operation === "bootstrap" ? "disabled" : "https",
    SITE_URL: target.frontend,
    AUTH_PROXY_MODE: "signed",
    API_URL: target.api,
  }))
    if (actual[key] !== value) throw new Error(`Unexpected backend variable: ${key}`);
  // The hosted sandbox is never the fiscal production of the NFS-e issuance.
  // Nor the throwaway preview of the read evaluation (#642).
  for (const name of [
    "FNFE_ISSUANCE_ENV",
    "FNFE_NFSE_PRODUCTION_COMPANIES",
    "FNFE_FISCAL_PROOF",
    "FNFE_HOSTED_PROOF",
  ])
    if (actual[name] !== undefined) throw new Error(`Unexpected backend variable: ${name}`);
  // The site capture adapter (ADR 0007, phase 4): off, or the real one for released companies.
  if (![undefined, "", "disabled", "sefaz"].includes(actual.FNFE_CAPTURE_TRANSPORT))
    throw new Error("Unexpected backend variable: FNFE_CAPTURE_TRANSPORT");
}

export function legacyEnvironmentNames(names) {
  const explicit = new Set([
    "FNFE_CUTOVER_TOKEN",
    "CLERK_JWT_ISSUER_DOMAIN",
    "FNFE_BACKOFFICE_ADMINS",
    "FNFE_ALLOW_PRODUCTION",
    "FNFE_CERT_MASTER_KEY",
    "FNFE_MIGRATION_FREEZE",
    "FNFE_SEFAZ_CA_PEM",
    "FNFE_ALERT_EMAIL_TO",
    "FNFE_EMAIL_FROM",
    "FNFE_RECIPIENT_EMAIL_ENABLED",
    "FNFE_REJECTION_ALERT_LIMIT",
    "RESEND_API_KEY",
  ]);
  return names.filter(
    (name) =>
      explicit.has(name) ||
      name.startsWith("FNFE_CERT_PFX_") ||
      name.startsWith("FNFE_WEBHOOK_SINK_"),
  );
}

export function releaseTarget(plan) {
  if (plan.version !== 3 || plan.productEnvironment !== "sandbox")
    throw new Error("Unsupported release plan or product environment");
  const target = plan.target;
  if (!target || target.deployment !== "elated-possum-295")
    throw new Error("Approved legacy production deployment required");
  if (target.worker !== "freecorpsnfe-backoffice" || !/^[a-f0-9]{32}$/.test(target.accountId))
    throw new Error("Existing backoffice Worker and account required");
  const frontend = new URL(target.frontend);
  if (
    frontend.protocol !== "https:" ||
    frontend.origin !== target.frontend ||
    frontend.origin !== "https://nfe.freecorps.com.br"
  )
    throw new Error("Approved backoffice address required");
  if (target.api !== "https://api.nfe.freecorps.com.br")
    throw new Error("Approved API address required");
  return {
    ...target,
    cloud: `https://${target.deployment}.convex.cloud`,
    site: `https://${target.deployment}.convex.site`,
  };
}
const cutoverGates = ["legacyReset", "consumerTransition"];
const installationGates = [...cutoverGates, "authBootstrap"];
// The installation record is immutable history: the one-time cutover (#84) and
// the login proof that closed the bootstrap. Updates never repeat or extend it;
// they only require it to be complete and its receipts to keep the same bytes.
// The one exception is a new reset (#525): its commit drops the authBootstrap
// receipt and replaces legacyReset and consumerTransition with the new cutover
// evidence, which lets bootstrap run again; the commit touches deploy/, a
// CODEOWNERS path, so it needs the owner review.
export function installationRecord(plan, root) {
  const record = plan.installation;
  if (
    record?.strategy !== "replace-legacy-empty" ||
    record.decisions?.discardLegacyData !== true ||
    record.decisions?.reuseAddress !== true ||
    record.decisions?.freshBetterAuthAccounts !== true
  )
    throw new Error("Explicit clean-start decisions required");
  const receipts = record.receipts ?? [];
  const gates = receipts.map((r) => r.gate);
  if (gates.some((g) => !installationGates.includes(g)) || new Set(gates).size !== gates.length)
    throw new Error("Unknown or repeated installation receipt");
  for (const gate of cutoverGates)
    if (!gates.includes(gate)) throw new Error(`Missing evidence: ${gate}`);
  for (const proof of receipts) {
    if (!/^[a-f0-9]{64}$/.test(proof.sha256)) throw new Error(`Missing evidence: ${proof.gate}`);
    const path = resolve(root, proof.path),
      rel = relative(resolve(root, "docs/v1.0/evidence"), path);
    if (rel.startsWith("..") || !rel || !/^[a-zA-Z0-9_./-]+$/.test(proof.path))
      throw new Error("Evidence must be versioned under docs/v1.0/evidence");
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== proof.sha256)
      throw new Error(`Evidence hash differs: ${proof.gate}`);
  }
  return { complete: gates.includes("authBootstrap") };
}
// Bootstrap follows the recorded cutover and may be repeated before the login proof. After it
// (authBootstrap receipt) only release publishes: a bootstrap would skip the existing probe, so
// another one needs a new installation record (see above), under the owner review (#525).
export function bootstrapPreconditions(plan, root) {
  if (installationRecord(plan, root).complete)
    throw new Error("Bootstrap requires an installation awaiting its login proof; use release");
}
// Every publication of the workflow passes the owner review before the build, bootstrap included
// (#525); only the local --operator, run with the production credentials, stays outside (known
// limit, docs/operacao/deploy-producao.md).
export function ownerReviewRequired({ operation, operator }) {
  if (!["bootstrap", "release"].includes(operation)) throw new Error("Unknown release operation");
  return !operator;
}
// Release updates a completed installation; it never resets data or creates accounts.
export function releasePreconditions(plan, root) {
  if (!installationRecord(plan, root).complete)
    throw new Error("Release requires a completed installation (authBootstrap receipt)");
}
// First installation has no platform functions or probe yet. It uses the same
// target/SHA gates, never resets data, and creates the probe idempotently.
export async function bootstrapRevision(sha, operations, record) {
  const receipt = {
    schemaVersion: 1,
    sha,
    state: "checking",
    phase: "preflight",
    before: null,
    after: null,
  };
  const save = () => record({ ...receipt });
  let started = false;
  save();
  try {
    await operations.preflight();
    receipt.phase = "build";
    save();
    await operations.build();
    receipt.phase = "eligibility";
    save();
    if (!(await operations.eligible())) {
      receipt.state = "obsolete";
      save();
      return receipt;
    }
    started = true;
    receipt.state = "publishing";
    receipt.phase = "backend";
    save();
    await operations.backend();
    receipt.phase = "probe";
    save();
    await operations.initializeProbe();
    receipt.before = probeHash(await operations.probe());
    receipt.phase = "frontend";
    save();
    await operations.frontend();
    receipt.phase = "smoke";
    save();
    await operations.smoke();
    receipt.phase = "persistence";
    save();
    receipt.after = probeHash(await operations.probe());
    if (receipt.before !== receipt.after) throw new Error("Probe changed during bootstrap");
    receipt.state = "awaiting-auth-proof";
    receipt.phase = "complete";
    save();
    return receipt;
  } catch (error) {
    receipt.state = started ? "partial" : "failed-before-publication";
    if (receipt.phase === "smoke") Object.assign(receipt, smokeFailureDetails(error));
    save();
    const diagnostic = receipt.diagnostic
      ? `; diagnostic=${smokeDiagnosticText(receipt.diagnostic)}`
      : "";
    throw new Error(`Bootstrap failed in ${receipt.phase}; state=${receipt.state}${diagnostic}`);
  }
}
export function releaseAuthorization(env, sha, target, planHash) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !isProjectRepository(env.GITHUB_REPOSITORY) ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
    !["bootstrap", "release"].includes(env.RELEASE_OPERATION) ||
    (env.GITHUB_EVENT_NAME === "push" && env.RELEASE_OPERATION !== "release") ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    env.GITHUB_SHA !== sha ||
    env.CI_TESTED_SHA !== sha ||
    env.RELEASE_APPROVED_SHA !== sha ||
    env.RELEASE_PLAN_HASH !== planHash
  )
    throw new Error(
      "Release requires the exact tested main SHA and plan; bootstrap is manual only",
    );
  if (
    !env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${target.deployment}|`) ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    env.CLOUDFLARE_ACCOUNT_ID !== target.accountId
  )
    throw new Error("Credentials must match the approved production target");
}
export function releaseWorker(target, root) {
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
      directory: resolve(root, ".selfhost/hosted/dist"),
      binding: "ASSETS",
      run_worker_first: ["/api/auth/*", "/v1/*", "/health", "/docs/404"],
      not_found_handling: "none",
    },
  };
}
