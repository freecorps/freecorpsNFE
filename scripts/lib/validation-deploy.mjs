import { createHash } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { isProjectRepository, projectRepository } from "./repository.mjs";
import { smokeFailureDetails, smokeDiagnosticText } from "./smoke-diagnostic.mjs";

export async function withRehearsalLock(directory, operation) {
  // Shared Git directory makes linked worktrees contend for the same writer.
  // No expiry: a crashed operator must inspect the process before clearing this lock.
  mkdirSync(directory);
  try {
    return await operation();
  } finally {
    rmdirSync(directory);
  }
}

const SHA = /^[a-f0-9]{40}$/;
export async function requireRehearsalWindow(token, request = fetch, env = process.env) {
  if (!token?.trim()) throw new Error("Rehearsal requires authenticated GitHub access");
  const base = `https://api.github.com/repos/${projectRepository(env)}`;
  const options = {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  const ref = await request(`${base}/git/ref/heads/main`, options);
  if (!ref.ok) throw new Error("Cannot authenticate access to the integration branch");
  const head = (await ref.json()).object?.sha;
  if (!SHA.test(head)) throw new Error("Invalid integration revision");
  const directory = await request(`${base}/contents/.github/workflows?ref=${head}`, options);
  if (!directory.ok) throw new Error("Cannot prove the automatic writer is absent");
  const files = await directory.json();
  if (
    !Array.isArray(files) ||
    !files.some((file) => file.name === "ci.yml") ||
    files.some((file) => file.name === "deploy-validation.yml")
  )
    throw new Error(
      "Rehearsal requires the automatic writer to be absent; use the pipeline after integration",
    );
}

// Printed when main moved during CI; the run exits non-zero without having written anything.
export function obsoleteMessage(testedSha, currentMain) {
  const head = /^[0-9a-f]{40}$/.test(currentMain ?? "") ? currentMain : "unknown";
  return `Obsolete revision: tested ${testedSha}, but main is now at ${head}. Nothing was published; dispatch again on the current main.`;
}

export function checkPublication(env, checkedSha) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !isProjectRepository(env.GITHUB_REPOSITORY) ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !SHA.test(checkedSha) ||
    checkedSha !== env.GITHUB_SHA ||
    checkedSha !== env.CI_TESTED_SHA
  )
    throw new Error("Publication requires CI for this exact integration revision");
  return checkedSha;
}

export function sameRevision(expected, frontend, backend) {
  if (
    !SHA.test(expected) ||
    frontend?.sha !== expected ||
    backend?.sha !== expected ||
    frontend.environment !== "validation" ||
    backend.appEnv !== "validation" ||
    backend.status !== "ok" ||
    backend.productEnv !== "sandbox" ||
    backend.fiscalEnv !== "disabled" ||
    // Every revision since #337 reports it: without it, the services are not the approved one.
    backend.issuanceEnv !== "disabled"
  )
    throw new Error("Published services do not match the approved validation revision");
}

export function probeHash(probe) {
  if (!probe || probe.key !== "persistence-v1" || typeof probe.nonce !== "string")
    throw new Error("Persistent probe missing; initialize explicitly before publication");
  return createHash("sha256").update(JSON.stringify(probe)).digest("hex");
}

// The workflow owns serialization. This function never rechecks/cancels between services.
export async function publishRevision(sha, operations, record) {
  const receipt = {
    schemaVersion: 1,
    sha,
    state: "checking",
    phase: "preflight",
    before: null,
    after: null,
  };
  const save = () => record({ ...receipt });
  save();
  let started = false;
  try {
    await operations.preflight();
    // Optional: a revision that changes nothing published ends here, before any build or write.
    const unchanged = await operations.unchanged?.();
    if (unchanged?.skip) {
      Object.assign(receipt, {
        state: "unchanged",
        phase: "complete",
        publishedSha: unchanged.published,
      });
      save();
      return receipt;
    }
    receipt.phase = "build";
    save();
    await operations.build();
    receipt.phase = "eligibility";
    save();
    receipt.before = probeHash(await operations.probe());
    // Read the remote branch immediately before the first write, inside the writer lock.
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
    receipt.backendSha = sha;
    receipt.phase = "frontend";
    save();
    await operations.frontend();
    receipt.phase = "smoke";
    save();
    await operations.smoke();
    receipt.phase = "persistence";
    save();
    receipt.after = probeHash(await operations.probe());
    if (receipt.before !== receipt.after)
      throw new Error("Persistent probe changed during publication");
    receipt.state = "validated";
    receipt.phase = "complete";
    save();
    return receipt;
  } catch (error) {
    receipt.state = started ? "partial" : "failed-before-publication";
    if (receipt.phase === "smoke") Object.assign(receipt, smokeFailureDetails(error));
    save();
    // Do not print raw provider/auth responses, credentials or fixture contents.
    const diagnostic = receipt.diagnostic
      ? `; diagnostic=${smokeDiagnosticText(receipt.diagnostic)}`
      : "";
    const cleanup = receipt.cleanupDiagnostic
      ? `; cleanup=${smokeDiagnosticText(receipt.cleanupDiagnostic)}`
      : "";
    throw new Error(
      `Validation publication failed in ${receipt.phase}; state=${receipt.state}${diagnostic}${cleanup}`,
    );
  }
}
