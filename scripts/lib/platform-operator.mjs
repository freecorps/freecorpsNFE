import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { projectRepository } from "./repository.mjs";

export const operatorBranch = "main";
export function checkOperatorRevision(sha, ref, workflow, runs, ciRuns) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(ref.object?.sha, sha, "Integration branch advanced");
  assert.equal(workflow.state, "disabled_manually", "Disable legacy production publisher first");
  assert.ok(
    runs.every((run) => run.status === "completed"),
    "Legacy publication still active",
  );
  const ci = ciRuns.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === operatorBranch &&
      run.path === ".github/workflows/deploy-validation.yml" &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  assert.ok(ci, "Exact integration revision requires successful publication validation");
  return { sha, ciRun: ci.id, sourceBranch: operatorBranch, legacyPublisher: workflow.state };
}
export function verifyOperatorRevision(sha) {
  const api = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", `repos/${projectRepository()}/${path}`], {
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  const allRuns = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", `repos/${projectRepository()}/${path}`, "--paginate", "--slurp"], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ).flatMap((page) => page.workflow_runs);
  return checkOperatorRevision(
    sha,
    api(`git/ref/heads/${operatorBranch}`),
    api("actions/workflows/deploy.yml"),
    allRuns("actions/workflows/deploy.yml/runs?per_page=100"),
    allRuns(`actions/runs?head_sha=${sha}&per_page=100`),
  );
}
export function operatorAuthorization(env, sha, target, planHash) {
  assert.notEqual(env.GITHUB_ACTIONS, "true", "Operator exception is local only");
  assert.equal(env.RELEASE_APPROVED_SHA, sha, "Explicit approved SHA required");
  assert.equal(env.RELEASE_PLAN_HASH, planHash, "Explicit reviewed plan hash required");
  assert.ok(env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${target.deployment}|`));
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, target.accountId);
  assert.ok(env.CLOUDFLARE_API_TOKEN?.trim());
}
