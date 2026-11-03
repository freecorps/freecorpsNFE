import { relative } from "node:path";
import { isProjectRepository } from "./repository.mjs";
import { subprocessEnvironment } from "./subprocess-environment.mjs";
import { reportSuites, suiteFor } from "./test-projects.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VALIDATION_WORKFLOW = ".github/workflows/deploy-validation.yml@refs/heads/main";
export function revision(env, event, checkedSha) {
  if (!SHA.test(checkedSha) || (env.GITHUB_SHA && checkedSha !== env.GITHUB_SHA))
    throw new Error("Checkout differs from the workflow SHA");
  const headSha = event.pull_request?.head?.sha ?? checkedSha;
  const baseSha = event.pull_request?.base?.sha ?? null;
  if (!SHA.test(headSha) || (baseSha !== null && !SHA.test(baseSha)))
    throw new Error("Invalid revision metadata");
  return {
    checkedSha,
    headSha,
    baseSha,
    kind: env.GITHUB_EVENT_NAME === "pull_request" ? "pr-merge" : "commit",
    draft: event.pull_request?.draft === true,
  };
}

export function testEnvironment(env) {
  return subprocessEnvironment(env);
}

export function sanitizeReport(raw, root, metadata, exitCode) {
  const suites = Object.fromEntries(
    reportSuites.map((name) => [name, { files: 0, passed: 0, failed: 0, pending: 0 }]),
  );
  for (const result of raw.testResults ?? []) {
    const file = relative(root, result.name).replaceAll("\\", "/");
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith("../"))
      throw new Error("Report contains an unexpected test path");
    const suite = suites[suiteFor(file)];
    suite.files++;
    for (const test of result.assertionResults ?? []) {
      if (test.status === "passed") suite.passed++;
      else if (test.status === "failed") suite.failed++;
      else suite.pending++;
    }
  }
  return {
    schemaVersion: 1,
    revision: metadata,
    result: exitCode === 0 && raw.success === true ? "passed" : "failed",
    suites,
  };
}

export function publicationSha(env, testedSha) {
  if (!SHA.test(testedSha) || testedSha !== env.GITHUB_SHA)
    throw new Error("Publication requires the exact validated commit");
  // Under workflow_call the caller owns event, ref and workflow_ref: only the
  // manual validation workflow on main gets a SHA, never the production push.
  return env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main" &&
    isProjectRepository(env.GITHUB_REPOSITORY) &&
    env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${VALIDATION_WORKFLOW}`
    ? testedSha
    : "";
}
