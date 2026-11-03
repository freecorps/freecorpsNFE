import { expect, it } from "vite-plus/test";
import {
  checkOperatorRevision,
  operatorAuthorization,
  operatorBranch,
} from "./lib/platform-operator.mjs";

const sha = "a".repeat(40);
const ref = { object: { sha } };
const workflow = { state: "disabled_manually" };
const ci = {
  id: 1,
  head_sha: sha,
  head_branch: operatorBranch,
  path: ".github/workflows/deploy-validation.yml",
  status: "completed",
  conclusion: "success",
};
it("operador exige CI do SHA integrado e publicador antigo parado", () => {
  expect(checkOperatorRevision(sha, ref, workflow, [], [ci]).ciRun).toBe(1);
  expect(() =>
    checkOperatorRevision(sha, { object: { sha: "b".repeat(40) } }, workflow, [], [ci]),
  ).toThrow();
  expect(() => checkOperatorRevision(sha, ref, { state: "active" }, [], [ci])).toThrow();
  expect(() =>
    checkOperatorRevision(sha, ref, workflow, [{ status: "in_progress" }], [ci]),
  ).toThrow();
  for (const patch of [
    { conclusion: "failure" },
    { head_sha: "b".repeat(40) },
    { head_branch: "feat/fiscal-platform-v1" },
    { status: "in_progress" },
  ])
    expect(() => checkOperatorRevision(sha, ref, workflow, [], [{ ...ci, ...patch }])).toThrow();
});
it("excecao local mantem plano, SHA e credenciais do destino fixados", () => {
  const target = { deployment: "elated-possum-295", accountId: "a".repeat(32) };
  const planHash = "b".repeat(64);
  const env = {
    RELEASE_APPROVED_SHA: sha,
    RELEASE_PLAN_HASH: planHash,
    CONVEX_DEPLOY_KEY: "prod:elated-possum-295|synthetic",
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    CLOUDFLARE_API_TOKEN: "synthetic",
  };
  expect(() => operatorAuthorization(env, sha, target, planHash)).not.toThrow();
  for (const patch of [
    { GITHUB_ACTIONS: "true" },
    { RELEASE_APPROVED_SHA: "" },
    { RELEASE_PLAN_HASH: "" },
    { CONVEX_DEPLOY_KEY: "dev:modest-seal-118|synthetic" },
  ])
    expect(() => operatorAuthorization({ ...env, ...patch }, sha, target, planHash)).toThrow();
});
