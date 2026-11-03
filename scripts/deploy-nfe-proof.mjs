import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = JSON.parse(readFileSync(join(root, ".ci-results/nfe/hosted-target.json"), "utf8"));
assert.equal(target.type, "dev");
assert.equal(target.reference, "dev/issue-69-xml-proof");
assert.match(target.name, /^[a-z]+-[a-z]+-\d+$/);
assert.notEqual(target.name, "modest-seal-118");
const envFile = join(root, ".ci-results/nfe/hosted.env");
const key = /^CONVEX_DEPLOY_KEY=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim();
assert.ok(key?.startsWith(`dev:${target.name}|`));
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  "",
  "Commit changes before recording deployed revision",
);
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const buildFile = join(root, "platform/convex/buildInfo.ts");
const original = readFileSync(buildFile);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(CONVEX_|VITE_|FNFE_|CLERK_|BETTER_AUTH_|VALIDATION_)/.test(name),
  ),
);
console.log(`target: dev (${target.name}, isolated XML validation proof), code ${sha}`);
try {
  writeFileSync(buildFile, `export const buildSha: string | null = ${JSON.stringify(sha)};\n`);
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/convex/bin/main.js"), "deploy", "--env-file", envFile, "--yes"],
    { cwd: join(root, "platform"), env, stdio: "inherit", windowsHide: true },
  );
  assert.equal(result.status, 0, "Isolated hosted deploy failed");
  const response = await fetch(`https://${target.name}.convex.site/health`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.deepEqual(health, {
    status: "ok",
    appEnv: "validation",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
    issuanceEnv: "disabled",
    sha,
  });
  writeFileSync(
    join(root, ".ci-results/nfe/hosted-deploy.json"),
    JSON.stringify({ codeSha: sha, target, health, result: "passed" }, null, 2) + "\n",
  );
} finally {
  writeFileSync(buildFile, original);
}
