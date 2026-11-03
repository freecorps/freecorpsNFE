import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  releaseTarget,
  releaseEnvironment,
  bootstrapPreconditions,
  releasePreconditions,
  ownerReviewRequired,
  releaseAuthorization,
  releaseWorker,
  bootstrapRevision,
  legacyEnvironmentNames,
} from "./lib/platform-release.mjs";
import { publishRevision } from "./lib/validation-deploy.mjs";
import { backendRequest } from "./lib/validation.mjs";
import { accountPolicy } from "../platform/account-policy.mjs";
import { operatorAuthorization, verifyOperatorRevision } from "./lib/platform-operator.mjs";
import { projectRepository } from "./lib/repository.mjs";
import { smokePlatform } from "./lib/platform-smoke.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";
import { publishedRevision, unchangedPublication } from "./lib/platform-unchanged.mjs";
import { dispatcherOf, ownerReview } from "./lib/owner-review.mjs";
import { startTermsOfUseNotice } from "./lib/terms-notice.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const planBytes = readFileSync(join(root, "deploy/platform-release.json"));
const plan = JSON.parse(planBytes),
  target = releaseTarget(plan);
const planHash = createHash("sha256").update(planBytes).digest("hex");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const operation = process.env.RELEASE_OPERATION;
assert.ok(["bootstrap", "release"].includes(operation), "Explicit release operation required");
(operation === "bootstrap" ? bootstrapPreconditions : releasePreconditions)(plan, root);
const operator = process.argv.length === 3 && process.argv[2] === "--operator";
assert.ok(process.argv.length === 2 || operator, "Unknown publication argument");
(operator ? operatorAuthorization : releaseAuthorization)(process.env, sha, target, planHash);
const operatorProof = operator ? verifyOperatorRevision(sha) : null;
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  "",
);
const output = join(root, ".ci-results/platform-release");
mkdirSync(output, { recursive: true });
const baseEnv = subprocessEnvironment(process.env);
const backendEnv = { ...baseEnv, CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY };
const frontendEnv = {
  ...baseEnv,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: target.accountId,
};
const context = { target: { url: target.cloud }, key: backendEnv.CONVEX_DEPLOY_KEY };
const query = async (path) =>
  (await backendRequest(context, "/api/query", { path, args: {}, format: "json" })).value;
function run(script, args, env = baseEnv, cwd = root) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300000,
  });
  // Provider output may contain credentials; keep it out of publication receipts.
  if (result.status !== 0) throw new Error(`Publication subprocess failed: ${script}`);
}
// Every commit since the published revision that touches a CODEOWNERS path needs an owner's
// approval, by a merged pull request approved by an owner who is not its author or by the owner's
// own dispatch, before anything is built or written (scripts/lib/owner-review.mjs, #424).
async function reviewGate() {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  let published = await publishedRevision(target);
  // Production may serve a revision of the archived repository, outside this history (the
  // cutover of 03/11/2026): the range cannot be checked, so it counts as unknown and only an
  // owner dispatch publishes, as ownerReview requires for an unknown revision.
  if (
    published &&
    spawnSync("git", ["cat-file", "-e", `${published}^{commit}`], { cwd: root }).status !== 0
  ) {
    console.log(
      `owner review: production serves ${published}, outside this history; only an owner dispatch publishes`,
    );
    published = null;
  }
  // Unreadable at a known published revision stays null, and ownerReview refuses the range.
  let previous = null;
  try {
    if (published) previous = git(["show", `${published}:.github/CODEOWNERS`]);
  } catch {
    previous = null;
  }
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${projectRepository()}/${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `GitHub API ${path}: ${response.status}`);
    return response.json();
  };
  let result;
  try {
    result = await ownerReview({
      from: published,
      to: sha,
      run: git,
      github,
      codeowners: { from: previous, to: readFileSync(join(root, ".github/CODEOWNERS"), "utf8") },
      dispatcher: dispatcherOf(process.env),
    });
  } catch (error) {
    // The publisher reports only the failed phase; the cause belongs in the log of the run.
    console.error(`owner review failed: ${error.message}`);
    throw error;
  }
  for (const proof of result.checked)
    console.log(
      `owner review: ${proof.sha.slice(0, 7)} ${proof.via === "pull" ? `PR #${proof.pull}` : "dispatch"}, approved by ${proof.approvers.join(", ")}`,
    );
  if (result.note) console.log(`owner review: ${result.note}`);
  for (const problem of result.problems) console.error(`owner review blocked: ${problem}`);
  assert.deepEqual(result.problems, [], "Owner review missing; nothing was published");
}
const workerConfig = join(output, "wrangler.json"),
  hostedConfig = join(output, "hosted.json");
writeFileSync(workerConfig, JSON.stringify(releaseWorker(target, root)));
writeFileSync(
  hostedConfig,
  JSON.stringify({
    cloud: target.cloud,
    site: target.site,
    frontend: target.frontend,
    api: target.api,
  }),
);
const buildFile = join(root, "platform/convex/buildInfo.ts"),
  originalBuild = readFileSync(buildFile);
const record = (receipt) =>
  writeFileSync(
    join(output, "receipt.json"),
    JSON.stringify(
      {
        ...receipt,
        planHash,
        operation,
        operatorProof,
        target: { deployment: target.deployment, worker: target.worker },
        scope: "hosted-sandbox-after-legacy-reset",
      },
      null,
      2,
    ) + "\n",
  );
console.log(
  `target: prod (${target.deployment}), Worker ${target.worker}, SHA ${sha}; sandbox product, fiscal disabled`,
);
const published = await (operation === "bootstrap" ? bootstrapRevision : publishRevision)(
  sha,
  {
    preflight: async () => {
      const actual = Object.fromEntries(
        (await query("_system/cli/queryEnvironmentVariables")).map(({ name, value }) => [
          name,
          value,
        ]),
      );
      releaseEnvironment(actual, target, operation);
      accountPolicy(actual);
      assert.deepEqual(
        legacyEnvironmentNames(Object.keys(actual)),
        [],
        "Legacy or maintenance credentials remain",
      );
      assert.ok(actual.BETTER_AUTH_SECRET?.length >= 32);
      assert.deepEqual(await query("_system/frontend/listCronJobs"), []);
      if (ownerReviewRequired({ operation, operator })) await reviewGate();
    },
    // Only the automatic release of a push to main skips a revision that changes nothing
    // published; an operator, a dispatch and the bootstrap always publish.
    unchanged:
      operation === "release" && !operator && process.env.GITHUB_EVENT_NAME === "push"
        ? async () => {
            const result = await unchangedPublication(sha, target, {
              run: (args) =>
                execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }),
            });
            console.log(
              result.skip
                ? `unchanged: production serves ${result.published}; the ${result.files} files changed since then are not published`
                : `publishing: ${result.reason}`,
            );
            return result;
          }
        : undefined,
    build: async () => {
      run("scripts/build-fiscal-packages.mjs", []);
      run("scripts/selfhost.mjs", ["build-hosted", hostedConfig]);
      run("node_modules/wrangler/bin/wrangler.js", [
        "deploy",
        "--config",
        workerConfig,
        "--dry-run",
      ]);
    },
    eligible: async () => {
      if (operator) {
        verifyOperatorRevision(sha);
        return true;
      }
      const response = await fetch(
        `https://api.github.com/repos/${projectRepository()}/git/ref/heads/main`,
        {
          headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      assert.ok(response.ok);
      return (await response.json()).object?.sha === sha;
    },
    probe: () => query("validation:readProbe"),
    initializeProbe: () =>
      backendRequest(context, "/api/mutation", {
        path: "validation:createProbe",
        args: { nonce: randomUUID() },
        format: "json",
      }),
    backend: async () => {
      try {
        writeFileSync(
          buildFile,
          `export const buildSha: string | null = ${JSON.stringify(sha)};\n`,
        );
        run(
          "node_modules/convex/bin/main.js",
          ["deploy", "--yes", "--typecheck", "disable", "--codegen", "disable"],
          backendEnv,
          join(root, "platform"),
        );
      } finally {
        writeFileSync(buildFile, originalBuild);
      }
    },
    frontend: async () =>
      run(
        "node_modules/wrangler/bin/wrangler.js",
        ["deploy", "--config", workerConfig],
        frontendEnv,
      ),
    smoke: () => smokePlatform(sha, target, query),
  },
  record,
);
// The e-mail notice of a new version of the terms of use (#594), once the revision serves: after a
// release, an unchanged revision or a bootstrap. A failed call is recorded, never a failed deploy.
if (published.state !== "obsolete")
  record({
    ...published,
    termsOfUseNotice: await startTermsOfUseNotice(
      async (path) =>
        (await backendRequest(context, "/api/mutation", { path, args: {}, format: "json" })).value,
    ),
  });
