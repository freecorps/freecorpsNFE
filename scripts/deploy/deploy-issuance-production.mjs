// Publication of the NFS-e fiscal production deployment, the second target (#198, ADR 0004 §8).
// `plan` checks the versioned plan without any secret; `publish` publishes backend, console and
// Worker of the planned deployment. While deploy/issuance-production.json names no deployment, or
// names one without `release`, both refuse before reading a secret, and nothing is published.
// `publish` then needs the run approved by another person in deploy/issuance-gate.json, read from
// the GitHub API (`verifiedRun`), before the deploy key is used.
// The hosted sandbox keeps its own pipeline (`deploy.yml`, `scripts/deploy/deploy-platform.mjs`).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GateRefusal, deployKeyFor, githubRun, verifiedRun } from "../lib/issuance-gate.mjs";
import {
  RELEASE_WORKFLOWS,
  approvedRevision,
  issuanceHealth,
  issuanceReleaseEnvironment,
  issuanceReleaseTarget,
  issuanceReleaseWorker,
} from "../lib/issuance-release.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const action = process.argv[2];
const output = join(root, ".ci-results/issuance-release");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const receipt = { action, started: new Date().toISOString(), phases: [] };

function record() {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function publish(target) {
  // First, before the deploy key is read: the run and another authorized person's approval, from
  // the GitHub API, as in the gate's `enable`. Without an approval (no required reviewers in the
  // environment), the publication is refused with APPROVAL_MISSING.
  const github = await githubRun(process.env, true);
  const verified = verifiedRun({
    action: "publish",
    env: process.env,
    run: github.run,
    approvals: github.approvals,
    config: read("deploy/issuance-gate.json"),
    workflows: RELEASE_WORKFLOWS,
  });
  Object.assign(receipt, verified);
  // Only what the publication needs; the plan check above runs without any dependency.
  const { backendRequest } = await import("../lib/validation.mjs");
  const { accountPolicy } = await import("../../platform/account-policy.mjs");
  const { legacyEnvironmentNames } = await import("../lib/platform-release.mjs");
  const { subprocessEnvironment } = await import("../lib/subprocess-environment.mjs");
  // The checkout is the SHA the API confirmed for the approved run (`head_sha`, `GITHUB_SHA`).
  const sha = git("rev-parse", "HEAD");
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_SHA !== sha ||
    process.env.RELEASE_APPROVED_SHA !== sha ||
    process.env.CI_TESTED_SHA !== sha
  )
    throw new GateRefusal(
      "REVISION_NOT_APPROVED",
      "A revisão publicada precisa ser a aprovada e testada na main.",
    );
  if (git("status", "--porcelain") !== "")
    throw new GateRefusal("CHECKOUT_DIRTY", "O checkout precisa estar limpo.");
  const key = deployKeyFor(process.env.CONVEX_DEPLOY_KEY, target.deployment);
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID !== target.accountId)
    throw new GateRefusal(
      "CLOUDFLARE_MISMATCH",
      "Token ou conta Cloudflare diferente da do plano.",
    );
  const base = subprocessEnvironment(process.env);
  const run = (script, args, env = base, cwd = root) => {
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600_000,
    });
    // Provider output may contain credentials; keep it out of the receipt.
    if (result.status !== 0) throw new GateRefusal("SUBPROCESS_FAILED", `Falhou: ${script}`);
  };
  const phase = async (name, step) => {
    receipt.phases.push({ name, state: "running" });
    await step();
    receipt.phases.at(-1).state = "done";
  };
  const context = { target: { url: target.cloud }, key };
  const query = async (path) =>
    (await backendRequest(context, "/api/query", { path, args: {}, format: "json" })).value;
  receipt.sha = sha;

  await phase("preflight", async () => {
    const actual = Object.fromEntries(
      (await query("_system/cli/queryEnvironmentVariables")).map(({ name, value }) => [
        name,
        value,
      ]),
    );
    issuanceReleaseEnvironment(actual, target);
    accountPolicy(actual);
    if (legacyEnvironmentNames(Object.keys(actual)).length)
      throw new GateRefusal(
        "ENVIRONMENT_MISMATCH",
        "Credenciais legadas ou de manutenção no deployment.",
      );
    if (!(actual.BETTER_AUTH_SECRET?.length >= 32))
      throw new GateRefusal("ENVIRONMENT_MISMATCH", "BETTER_AUTH_SECRET ausente ou curto.");
  });
  const workerConfig = join(output, "wrangler.json"),
    hostedConfig = join(output, "hosted.json");
  mkdirSync(output, { recursive: true });
  writeFileSync(workerConfig, JSON.stringify(issuanceReleaseWorker(target, root)));
  writeFileSync(
    hostedConfig,
    JSON.stringify({
      cloud: target.cloud,
      site: target.site,
      frontend: target.frontend,
      api: target.api,
    }),
  );
  await phase("build", async () => {
    run("scripts/build/build-fiscal-packages.mjs", []);
    // The console of the fiscal production: VITE_PRODUCT_ENV=production (selfhost build).
    run("scripts/selfhost.mjs", ["build-hosted-production", hostedConfig]);
    run("node_modules/wrangler/bin/wrangler.js", ["deploy", "--config", workerConfig, "--dry-run"]);
  });
  await phase("backend", async () => {
    const buildFile = join(root, "platform/convex/buildInfo.ts"),
      original = readFileSync(buildFile);
    try {
      writeFileSync(buildFile, `export const buildSha: string | null = ${JSON.stringify(sha)};\n`);
      run(
        "node_modules/convex/bin/main.js",
        ["deploy", "--yes", "--typecheck", "disable", "--codegen", "disable"],
        { ...base, CONVEX_DEPLOY_KEY: key },
        join(root, "platform"),
      );
    } finally {
      writeFileSync(buildFile, original);
    }
  });
  await phase("frontend", async () =>
    run("node_modules/wrangler/bin/wrangler.js", ["deploy", "--config", workerConfig], {
      ...base,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: target.accountId,
    }),
  );
  await phase("smoke", async () => {
    const health = (url) =>
      fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    for (let attempt = 0; ; attempt++) {
      const states = [
        issuanceHealth(await health(`${target.site}/health`), sha),
        issuanceHealth(await health(`${target.api}/health`), sha),
      ];
      if (states.every((state) => state === "ready")) break;
      if (attempt === 19)
        throw new GateRefusal("SMOKE_TIMEOUT", "A revisão publicada não respondeu a tempo.");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  });
  // The e-mail notice of a new version of the terms of use (#594), once the revision serves. A
  // failed call is recorded as `failed`, never a refused publication; the next one starts it again.
  const { startTermsOfUseNotice } = await import("../lib/terms-notice.mjs");
  receipt.termsOfUseNotice = await startTermsOfUseNotice(
    async (path) =>
      (await backendRequest(context, "/api/mutation", { path, args: {}, format: "json" })).value,
  );
}

try {
  if (action !== "plan" && action !== "publish")
    throw new GateRefusal("ACTION_INVALID", "Use: deploy-issuance-production.mjs plan|publish");
  // First and without any secret: no named deployment and release, nothing else runs.
  const target = issuanceReleaseTarget(
    read("deploy/issuance-production.json"),
    read("deploy/platform-release.json").target,
    read("platform/validation.json"),
  );
  receipt.deployment = target.deployment;
  if (action === "plan") {
    // The dispatch's approved SHA, passed by env: a mismatch fails here, not by skipping jobs.
    approvedRevision(process.env.APPROVED_SHA, process.env.GITHUB_SHA);
    console.log(`Plano nomeia ${target.deployment} (${target.frontend}, ${target.api}).`);
  } else await publish(target);
  receipt.result = "passed";
} catch (error) {
  receipt.result = "refused";
  receipt.code = error instanceof GateRefusal ? error.code : "UNEXPECTED";
  console.error(error instanceof GateRefusal ? error.message : "Falha inesperada na publicação.");
  process.exitCode = 1;
}
receipt.finished = new Date().toISOString();
record();
