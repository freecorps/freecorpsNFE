import { mkdirSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Pure checks for the manual #50 runner. Every failure is a fixed code so the
// operator knows which input is missing without printing plan or secret values.

// Each round may get a new deployment; a reference can name only one of them.
export const PROOF_REFERENCE = /^dev\/issue-50-fiscal-proof(-[a-z0-9]{1,20})?$/;
export const PROOF_COMMANDS = Object.freeze([
  "validate-local",
  "publish",
  "provision",
  "step",
  "inspect",
  "receipt",
  "pause",
  "stop",
]);
// Production and persistent validation.
export const SHARED_TARGETS = Object.freeze(["elated-possum-295", "modest-seal-118"]);
// Shared deployments that the public tree does not name (the personal development deployment),
// kept as the SHA-256 of the name: a proof never targets them either.
export const SHARED_TARGET_SHA256 = Object.freeze([
  "cbc0160f7e13f268d9454f0e67580330de7d0fdfddf3ab82c8027c4b63eea261",
]);
/** Whether a deployment is shared: named in SHARED_TARGETS or listed by hash. */
export function isSharedTarget(name, hashes = SHARED_TARGET_SHA256) {
  return (
    SHARED_TARGETS.includes(name) ||
    hashes.includes(createHash("sha256").update(String(name)).digest("hex"))
  );
}
const MAX_WINDOW_MS = 3 * 3_600_000;

/** Platform environment whose streams reach the plan's fiscal environment. */
export const productEnvironmentOf = (plan) =>
  plan.fiscalEnvironment === "production" ? "production" : "sandbox";

/**
 * Variables the dedicated target must hold whenever no step is running. A production
 * plan marks the target once, at publish; homologation targets never carry the mark.
 */
export function proofBaseline(plan) {
  return {
    APP_ENV: "validation",
    PRODUCT_ENV: productEnvironmentOf(plan),
    FISCAL_ENV: "disabled",
    FNFE_CAPTURE_TRANSPORT: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "disabled",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    ...(plan.fiscalEnvironment === "production" ? { FNFE_PROOF_FISCAL_ENV: "production" } : {}),
  };
}

const fail = (code) => {
  throw new Error(code);
};
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const instant = (value) => Number.isSafeInteger(value) && value > 0;

/** Real certificates never reach CI or a non-Windows host (DPAPI custody). */
export function assertOperatorHost(env, platform) {
  if (env.CI || env.GITHUB_ACTIONS || env.RUNNER_NAME) fail("CI_FORBIDDEN");
  if (platform !== "win32") fail("OPERATOR_HOST_REQUIRED");
}

export function assertCommand(command) {
  if (!PROOF_COMMANDS.includes(command)) fail("COMMAND_REQUIRED");
  return command;
}

/** Explicit SHA, target, scope, authorization, window and budget; nothing has a default. */
export function validatePlan(plan) {
  if (!record(plan)) fail("PLAN_INVALID");
  if (typeof plan.approvedSha !== "string" || !/^[a-f0-9]{40}$/.test(plan.approvedSha))
    fail("PLAN_SHA_REQUIRED");
  const target = plan.target;
  if (
    !record(target) ||
    target.type !== "dev" ||
    typeof target.reference !== "string" ||
    !PROOF_REFERENCE.test(target.reference) ||
    typeof target.name !== "string" ||
    !/^[a-z]+-[a-z]+-\d+$/.test(target.name)
  )
    fail("PLAN_TARGET_REQUIRED");
  if (isSharedTarget(target.name)) fail("PLAN_TARGET_SHARED");
  if (plan.service !== "nfe-distribution") fail("PLAN_SERVICE_REQUIRED");
  // Production only reads the distribution of NF-e already received (#50); the runner has
  // no command that issues, cancels or manifests.
  if (plan.fiscalEnvironment !== "homologation" && plan.fiscalEnvironment !== "production")
    fail("PLAN_FISCAL_ENVIRONMENT_REQUIRED");
  const authorization = plan.authorization;
  if (
    !record(authorization) ||
    !text(authorization.approvedBy, 100) ||
    !text(authorization.reference, 300) ||
    !instant(authorization.approvedAt)
  )
    fail("PLAN_AUTHORIZATION_REQUIRED");
  const company = plan.company;
  if (
    !record(company) ||
    Object.keys(company).some((key) => !["cnpj", "name", "address"].includes(key)) ||
    typeof company.cnpj !== "string" ||
    !/^\d{14}$/.test(company.cnpj) ||
    !text(company.name, 200) ||
    !record(company.address)
  )
    fail("PLAN_COMPANY_REQUIRED");
  // A bare file name keeps the PFX inside the private directory.
  if (typeof plan.pfxFile !== "string" || !/^[\w.-]+\.(pfx|p12)$/i.test(plan.pfxFile))
    fail("PLAN_PFX_REQUIRED");
  if (
    !instant(plan.startsAt) ||
    !instant(plan.expiresAt) ||
    plan.expiresAt <= plan.startsAt ||
    plan.expiresAt - plan.startsAt > MAX_WINDOW_MS ||
    authorization.approvedAt >= plan.expiresAt
  )
    fail("PLAN_WINDOW_REQUIRED");
  if (!Number.isSafeInteger(plan.maxRequests) || plan.maxRequests < 1 || plan.maxRequests > 2)
    fail("PLAN_REQUESTS_REQUIRED");
  return plan;
}

/** Publishing code or releasing the certificate needs a current authorization. */
export function assertAuthorizationActive(plan, now) {
  if (now < plan.authorization.approvedAt || now >= plan.expiresAt) fail("AUTHORIZATION_INACTIVE");
}

/** Only `step` may reach the source, and only inside the authorized window. */
export function assertFiscalWindow(plan, now) {
  if (now < plan.startsAt || now >= plan.expiresAt) fail("FISCAL_WINDOW_CLOSED");
}

/**
 * One writer per private directory. `pause` and `stop` never take it, so a
 * running step can always be shut down. A killed process leaves the lock for
 * the operator to inspect before removing it.
 */
export function acquireProofLock(directory) {
  const lock = join(directory, "run.lock");
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code === "EEXIST") fail("PROOF_LOCKED");
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Removed by the operator meanwhile: never mask the command's own result.
    try {
      rmdirSync(lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

const iso = (ms) => (Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null);

/**
 * Allow-listed receipt for the repository. Identity (CNPJ, company name, IDs),
 * storage references, XML and credentials are never copied from the evidence.
 */
export function publicReceipt({ plan, evidence, environment, certificateState, generatedAt }) {
  const batch = evidence.batch;
  const stream = evidence.stream;
  const receipt = {
    schema: "freecorps.fiscal-proof-receipt/1",
    generatedAt: iso(generatedAt),
    target: { name: plan.target.name, type: plan.target.type, reference: plan.target.reference },
    approvedSha: plan.approvedSha,
    deployedSha: evidence.sha,
    service: plan.service,
    fiscalEnvironment: plan.fiscalEnvironment,
    authorization: {
      approvedBy: plan.authorization.approvedBy,
      approvedAt: iso(plan.authorization.approvedAt),
      reference: plan.authorization.reference,
    },
    window: {
      startsAt: iso(plan.startsAt),
      expiresAt: iso(plan.expiresAt),
      maxRequests: plan.maxRequests,
    },
    authorizedCalls: evidence.authorizedCalls,
    operation: evidence.operation
      ? {
          state: evidence.operation.state,
          code: evidence.operation.code,
          uncertain: evidence.operation.uncertain,
        }
      : null,
    // No status means no source answer was persisted; it is not a fiscal result.
    source: batch
      ? {
          status: batch.status ?? null,
          mode: batch.mode,
          requestNsu: batch.requestNsu,
          lastNsu: batch.lastNsu ?? null,
          maxNsu: batch.maxNsu ?? null,
          envelopeCount: batch.envelopeCount ?? null,
          rawSha256: batch.rawHash,
          storedBytes: batch.storedBytes ?? null,
          committed: batch.committed,
          persistedAt: iso(batch.createdAt),
        }
      : null,
    envelopes: evidence.envelopes.map(({ nsu, schema, sha256 }) => ({ nsu, schema, sha256 })),
    stream: {
      state: stream.state,
      code: stream.code ?? null,
      mode: stream.mode,
      checkpoint: stream.checkpoint,
      sourceCursor: stream.sourceCursor ?? null,
      nextAllowedAt: iso(stream.nextAllowedAt),
    },
    shutdown: {
      FISCAL_ENV: environment.FISCAL_ENV ?? null,
      FNFE_CAPTURE_TRANSPORT: environment.FNFE_CAPTURE_TRANSPORT ?? null,
      FNFE_CRONS: environment.FNFE_CRONS ?? null,
      EMAIL_MODE: environment.EMAIL_MODE ?? null,
      WEBHOOK_MODE: environment.WEBHOOK_MODE ?? null,
      certificateState: certificateState ?? null,
    },
  };
  assertSanitized(JSON.stringify(receipt), [plan.company.cnpj, plan.company.name]);
  return receipt;
}

/** Last barrier before a receipt leaves the private directory. */
export function assertSanitized(serialized, forbidden = []) {
  const markers = ["<", "BEGIN ", "PRIVATE KEY", "dev:", "prod:", "__Secure-", "eyJ"];
  if (
    markers.some((marker) => serialized.includes(marker)) ||
    forbidden.some((value) => typeof value === "string" && value && serialized.includes(value))
  )
    fail("RECEIPT_NOT_SANITIZED");
  return serialized;
}
