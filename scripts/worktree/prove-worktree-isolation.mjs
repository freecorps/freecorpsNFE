import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../lib/worktree/deployment.mjs";
import { currentLocalSiteUrl, readEnvFile } from "../lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../lib/worktree/state.mjs";
import { assertPrivateDirectories } from "../lib/worktree/operation.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
if (!process.argv[2] || process.argv[3] !== "--stop-second")
  throw new Error(
    "Usage: node --experimental-strip-types scripts/worktree/prove-worktree-isolation.mjs <second-worktree> --stop-second",
  );
const a = worktreePaths(root),
  b = worktreePaths(process.argv[2]);
const git = (paths, args) =>
  execFileSync("git", args, { cwd: paths.root, encoding: "utf8" }).trim();
assert.notEqual(realpathSync(a.root), realpathSync(b.root));
assert.equal(
  resolve(a.root, git(a, ["rev-parse", "--git-common-dir"])),
  resolve(b.root, git(b, ["rev-parse", "--git-common-dir"])),
);
for (const paths of [a, b]) {
  assertLinkedWorktree(paths);
  assertPrivateDirectories(paths);
  assert.equal(paths.app, "platform");
  assert.equal(lstatSync(join(paths.root, "node_modules")).isSymbolicLink(), false);
}
assert.notEqual(
  realpathSync(join(a.root, "node_modules")),
  realpathSync(join(b.root, "node_modules")),
);
const configA = readLocalConfig(a),
  configB = readLocalConfig(b);
assert.notEqual(configA.adminKey, configB.adminKey);
assert.notEqual(
  readEnvFile(a.backendEnv).get("BETTER_AUTH_SECRET"),
  readEnvFile(b.backendEnv).get("BETTER_AUTH_SECRET"),
);
assert.notEqual(configA.ports.cloud, configB.ports.cloud);
assert.notEqual(currentLocalSiteUrl(a), currentLocalSiteUrl(b));
async function rpc(config, kind, path, args) {
  const response = await fetch(`${localUrls(config).cloud}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `Local operation ${path}`);
  return result.value;
}
const email = `isolation-${crypto.randomUUID()}@development.invalid`;
async function signup(paths, config) {
  const response = await fetch(`${localUrls(config).site}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      Origin: currentLocalSiteUrl(paths),
      "Content-Type": "application/json",
      "Better-Auth-Cookie": "",
    },
    body: JSON.stringify({
      name: "Isolation proof",
      email,
      password: `synthetic-${crypto.randomUUID()}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).user.id;
}
const userA = await signup(a, configA);
assert.equal((await rpc(configA, "query", "mail:inbox", { email })).length, 1);
assert.equal((await rpc(configB, "query", "mail:inbox", { email })).length, 0);
const userB = await signup(b, configB);
assert.notEqual(userA, userB);
for (const config of [configA, configB]) {
  assert.deepEqual(await rpc(config, "query", "_system/frontend/listCronJobs", {}), []);
  const response = await fetch(`${localUrls(config).cloud}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "mail:inbox", args: { email }, format: "json" }),
  });
  assert.notEqual((await response.json()).status, "success");
  const extracted = await rpc(config, "action", "xml:extract", {
    xml: readFileSync(join(root, "packages/fiscal-nfe/fixtures/minimal.xml"), "utf8"),
  });
  assert.match(extracted.runtime, /^v24\./);
  assert.equal(JSON.parse(extracted.json).total, "24.69");
}
execFileSync(
  process.execPath,
  ["--experimental-strip-types", join(b.root, "scripts/worktree.mjs"), "cleanup"],
  { cwd: b.root, windowsHide: true, stdio: "inherit" },
);
assert.equal((await fetch(`${localUrls(configA).site}/health`)).status, 200);
assert.equal((await rpc(configA, "query", "mail:inbox", { email })).length, 1);
let secondStopped = false;
try {
  await fetch(`${localUrls(configB).site}/health`, { signal: AbortSignal.timeout(2000) });
} catch {
  secondStopped = true;
}
assert.equal(secondStopped, true);
const report = {
  result: "passed",
  observedAt: new Date().toISOString(),
  codeSha: git(a, ["rev-parse", "HEAD"]),
  reproductionSha: git(b, ["rev-parse", "HEAD"]),
  separateDependencies: true,
  separateCredentials: true,
  isolatedAccountsAndMail: true,
  publicMailboxRejected: true,
  deployedCrons: 0,
  nodeActionOnBoth: true,
  stoppedSecondPreservedFirst: true,
  ports: [configA.ports, configB.ports],
};
mkdirSync(join(root, ".ci-results"), { recursive: true });
writeFileSync(
  join(root, ".ci-results/worktree-isolation.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
