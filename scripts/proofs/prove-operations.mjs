import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../lib/worktree/deployment.mjs";
import { cleanupOperationProof } from "../lib/operation-proof-cleanup.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const config = readLocalConfig(worktreePaths(root));
assert.ok(config, "Start this worktree's local platform backend first");
const urls = localUrls(config);
async function call(type, path, args) {
  const res = await fetch(`${urls.cloud}/api/${type}`, {
    method: "POST",
    headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  assert.equal(body.status, "success", `${path}: ${body.errorMessage}`);
  return body.value;
}
const health = await (await fetch(`${urls.site}/health`)).json();
assert.equal(health.appEnv, "development");
assert.equal(health.fiscalEnv, "disabled");
const applicationCrons = await call("query", "_system/frontend/listCronJobs", {});
assert.deepEqual(applicationCrons, []);
const effects = new Map();
const reconciliations = new Map();
const active = new Map(),
  peak = new Map();
const server = createServer((req, res) => {
  const id = req.url?.split("/").at(-1);
  const group = req.url?.split("/")[2];
  if (group === "late" && req.method === "POST") {
    // The source commits after both the transport timeout and the original lease.
    setTimeout(() => {
      effects.set(id, (effects.get(id) ?? 0) + 1);
      if (!res.destroyed) {
        res.writeHead(200);
        res.end("late effect");
      }
    }, 65_000);
    return;
  }
  const load = ["import", "capture", "webhook"].includes(group);
  if (load) {
    active.set(group, (active.get(group) ?? 0) + 1);
    peak.set(group, Math.max(peak.get(group) ?? 0, active.get(group)));
  }
  if (req.method === "POST") effects.set(id, (effects.get(id) ?? 0) + 1);
  else reconciliations.set(id, (reconciliations.get(id) ?? 0) + 1);
  const finish = () => {
    if (load) active.set(group, active.get(group) - 1);
    res.writeHead(effects.has(id) ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ synthetic: true, document: id }));
  };
  if (load) setTimeout(finish, 400);
  else finish();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const transportUrl = `http://127.0.0.1:${server.address().port}/effect`;
const cases = [];
let failure = null,
  proofKeyId = null;
async function completed(operationId) {
  const deadline = Date.now() + 120_000;
  let observed;
  while (Date.now() < deadline) {
    observed = await call("query", "testing/operationProof:inspect", { operationId });
    if (observed.operation.state === "succeeded") return observed;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Operation remained ${observed.operation.state}`);
}
try {
  const secret = `fnfe_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(secret).digest("hex");
  const scope = await call("mutation", "testing/operationProof:prepare", {
    keyHash,
    suffix: randomUUID(),
  });
  proofKeyId = scope.keyId;
  const { keyId: _keyId, ...selectors } = scope;
  for (const scenario of ["normal", "crash-after-external-effect", "late-external-effect"]) {
    const crashAfterEffect = scenario === "crash-after-external-effect";
    const args = {
      ...selectors,
      keyHash,
      environment: "sandbox",
      key: randomUUID(),
      request: JSON.stringify({
        url: scenario === "late-external-effect" ? `${transportUrl}/late` : transportUrl,
        crashAfterEffect,
      }),
      task: {
        name: "proof.import",
        workload: "import",
        scope: "documents:import",
        executor: "testing/operationTransport:execute",
        reconciler: "testing/operationTransport:reconcile",
        checkpoint: "testing/operationProof:checkpoint",
      },
    };
    const [a, b] = await Promise.all([
      call("mutation", "operations:reserve", args),
      call("mutation", "operations:reserve", args),
    ]);
    assert.equal(a.operationId, b.operationId);
    assert.equal(Number(a.reused) + Number(b.reused), 1);
    const observed = await completed(a.operationId);
    assert.equal(observed.operation.state, "succeeded");
    assert.equal(effects.get(a.operationId), 1, "External effect must not be retransmitted");
    assert.equal(observed.documents.length, 1);
    assert.deepEqual(observed.receipts.map((r) => r.kind).sort(), ["result", "usage"]);
    if (crashAfterEffect) assert.ok(reconciliations.get(a.operationId) >= 1);
    if (scenario === "late-external-effect") assert.ok(reconciliations.get(a.operationId) >= 2);
    const response = await fetch(`${urls.site}/v1/operations/${a.operationId}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.state, "succeeded");
    const conflict = await fetch(`${urls.site}/v1/operations/${a.operationId}/retry`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedGeneration: observed.operation.generation }),
    });
    assert.equal(conflict.status, 409);
    cases.push({
      scenario,
      result: "passed",
      generation: observed.operation.generation,
      attempts: observed.attempts.length,
      externalEffects: effects.get(a.operationId),
      reconciliationCalls: reconciliations.get(a.operationId) ?? 0,
      documents: observed.documents.length,
      logicalEvents: 1,
      usageUnits: 1,
    });
    console.log(JSON.stringify(cases.at(-1)));
  }
  for (const [workload, limit, requiredScope] of [
    ["import", 4, "documents:import"],
    ["capture", 2, "connections:write"],
    ["webhook", 4, "webhooks:manage"],
  ]) {
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("mutation", "operations:reserve", {
          ...selectors,
          keyHash,
          environment: "sandbox",
          key: randomUUID(),
          request: JSON.stringify({ url: `${transportUrl}/${workload}` }),
          task: {
            name: `proof.${workload}`,
            workload,
            scope: requiredScope,
            executor: "testing/operationTransport:execute",
            checkpoint: "testing/operationProof:checkpoint",
          },
        }),
      ),
    );
    await Promise.all(jobs.map((job) => completed(job.operationId)));
    assert.ok(
      peak.get(workload) <= limit && peak.get(workload) > 1,
      `${workload} peak ${peak.get(workload)} / limit ${limit}`,
    );
    for (const job of jobs) assert.equal(effects.get(job.operationId), 1);
    cases.push({
      scenario: `${workload}-concurrency`,
      jobs: jobs.length,
      limit,
      observedPeak: peak.get(workload),
      result: "passed",
    });
    console.log(JSON.stringify(cases.at(-1)));
  }
} catch (error) {
  failure = error;
} finally {
  failure = await cleanupOperationProof(
    () =>
      proofKeyId
        ? call("mutation", "testing/operationProof:retire", { keyId: proofKeyId })
        : Promise.resolve(),
    () => new Promise((resolve) => server.close(resolve)),
    failure,
  );
}
const receipt = {
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  runnerSha256: createHash("sha256")
    .update((await import("node:fs")).readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  time: new Date().toISOString(),
  environment: "local-anonymous",
  url: urls.cloud,
  schema: "platform/convex/schema.ts",
  applicationCrons: applicationCrons.length,
  dataset: "synthetic operations; loopback HTTP effects; no fiscal credentials",
  result: failure ? "failed" : "passed",
  failure: failure ? { name: failure.name, message: failure.message } : null,
  cases,
};
mkdirSync(join(root, ".ci-results/operations"), { recursive: true });
writeFileSync(
  join(root, ".ci-results/operations/local.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  "utf8",
);
if (failure) throw failure;
