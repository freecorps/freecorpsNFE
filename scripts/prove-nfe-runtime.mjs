import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
assert.ok(["local", "hosted"].includes(mode), "Specify local or hosted");
let url,
  key,
  deployedSha = null;
if (mode === "local") {
  const config = readLocalConfig(worktreePaths(root));
  url = localUrls(config).cloud;
  key = config.adminKey;
} else {
  // Explicit isolated proof deployment; persistent validation and production are refused.
  const target = JSON.parse(readFileSync(join(root, ".ci-results/nfe/hosted-target.json"), "utf8"));
  assert.equal(target.type, "dev");
  assert.equal(target.reference, "dev/issue-69-xml-proof");
  assert.match(target.name, /^[a-z]+-[a-z]+-\d+$/);
  assert.notEqual(target.name, "modest-seal-118");
  url = `https://${target.name}.convex.cloud`;
  key = process.env.NFE_PROOF_DEPLOY_KEY;
  assert.ok(key?.startsWith(`dev:${target.name}|`), "Isolated proof dev key required");
  const response = await fetch(`https://${target.name}.convex.site/health`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.appEnv, "validation");
  assert.equal(health.fiscalEnv, "disabled");
  deployedSha = health.sha;
  assert.equal(
    deployedSha,
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  );
}
const independent = JSON.parse(
  readFileSync(join(root, ".ci-results/nfe/independent.json"), "utf8"),
);
const cases = [];
for (const entry of independent.cases) {
  const bytes = readFileSync(join(root, "tests/fixtures/nfe/4.00", entry.id + ".xml"));
  const response = await fetch(`${url}/api/action`, {
    method: "POST",
    headers: { Authorization: `Convex ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "xml:validate",
      args: { bytes: { $bytes: bytes.toString("base64") }, evaluatedAt: independent.evaluatedAt },
      format: "json",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(body.status, "success", `Runtime action failed: ${entry.id}`);
  const result = JSON.parse(body.value.json);
  assert.deepEqual(result, entry.result, `Independent/runtime divergence: ${entry.id}`);
  cases.push({
    id: entry.id,
    inputSha256: entry.inputSha256,
    resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    runtime: body.value.runtime,
    result: "passed",
  });
}
const receipt = {
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  ),
  environment: mode,
  deployedSha,
  url,
  dataset: "tests/fixtures/nfe/4.00/manifest.json",
  result: "passed",
  cases,
};
mkdirSync(join(root, ".ci-results/nfe"), { recursive: true });
writeFileSync(join(root, `.ci-results/nfe/${mode}.json`), JSON.stringify(receipt, null, 2) + "\n");
console.log(
  JSON.stringify({
    environment: mode,
    url,
    result: "passed",
    cases: cases.length,
    runtime: cases[0]?.runtime,
  }),
);
