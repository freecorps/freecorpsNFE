// Hosted proof of the rate-limiter component (#79/#80, #142) on the production
// deployment elated-possum-295. It writes synthetic budgets only, under a random
// prefix, and resets every one of them at the end, partitions included.
// Run: node scripts/proofs/prove-hosted-rate-limits.mjs <expected-sha>
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const [expectedSha] = process.argv.slice(2);
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/, "Expected published SHA");
const credential = JSON.parse(
  readFileSync(join(homedir(), ".freecorpsnfe/cutover-84/operator.json"), "utf8"),
);
const target = {
  cloud: "https://elated-possum-295.convex.cloud",
  // An installation refuses direct calls; /health goes through the public Worker.
  api: "https://api.nfe.freecorps.com.br",
};
assert.equal(credential.deploymentName, "elated-possum-295");
assert.equal(credential.deploymentType, "prod");
assert.equal(credential.url, target.cloud);
assert.ok(typeof credential.adminKey === "string" && credential.adminKey.length > 20);
for (const name of ["CONVEX_DEPLOY_KEY", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"])
  assert.ok(!process.env[name], `Remove inherited ${name}`);

const health = await (await fetch(`${target.api}/health`, { redirect: "error" })).json();
assert.equal(health.sha, expectedSha, "Production does not serve the expected SHA");
assert.equal(health.status, "ok");
assert.equal(health.appEnv, "installation");
assert.equal(health.productEnv, "sandbox");
const identity = { deployment: credential.deploymentName, health };

async function post(path, body) {
  const response = await fetch(target.cloud + path, {
    method: "POST",
    headers: { Authorization: `Convex ${credential.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `Backend ${path} HTTP ${response.status}`);
  return response.json();
}
async function logs(cursor) {
  let response;
  try {
    response = await fetch(`${target.cloud}/api/stream_function_logs?cursor=${cursor}`, {
      headers: { Authorization: `Convex ${credential.adminKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError") return { cursor, entries: [] };
    throw error;
  }
  assert.equal(response.status, 200);
  const data = await response.json();
  // Production also logs real traffic: keep only counts of the rate limiter's own calls,
  // never messages, values, identities or execution ids.
  const entries = {};
  for (const entry of data.entries ?? []) {
    if (entry.kind !== "Completion" || entry.componentPath !== "rateLimiter") continue;
    const id = `${entry.identifier}:${entry.error ? "error" : "ok"}`;
    entries[id] ??= { calls: 0, occRetries: 0 };
    entries[id].calls++;
    entries[id].occRetries += entry.occInfo?.retryCount ?? 0;
  }
  return { cursor: data.newCursor ?? cursor, entries };
}
const prefix = `hosted-partitions-${randomUUID()}`;
const budgets = [];
const budget = (suffix, rate, period = 60_000, key) => {
  const result = {
    name: `${prefix}-${suffix}`,
    key,
    config: { kind: "token bucket", rate, capacity: rate, period },
  };
  budgets.push(result);
  return result;
};
const call = async (path, args) => {
  const result = await post("/api/function", {
    path: `lib:${path}`,
    args,
    componentPath: "rateLimiter",
    format: "json",
  });
  assert.equal(result.status, "success", `Component call ${path} failed`);
  return result.value;
};
const cursor = (await logs(0)).cursor;
const report = {
  identity,
  startedAt: new Date().toISOString(),
  syntheticOnly: true,
  scenarios: [],
};
try {
  // Slow refill prevents a new whole token during this short migration rehearsal.
  const legacy = budget("migration", 60, 3_600_000);
  for (let i = 0; i < 17; i++) assert.ok((await call("rateLimit", legacy)).ok);
  const before = await call("getValue", legacy);
  for (let i = 0; i < 43; i++) {
    const result =
      i % 2 === 0
        ? await call("rateLimitMany", { limits: [legacy], partitionShards: 8 })
        : await call("rateLimit", legacy);
    assert.ok(result.ok, `Remaining legacy token ${i + 1} refused`);
  }
  assert.equal((await call("checkRateLimit", legacy)).ok, false);
  assert.equal((await call("rateLimitMany", { limits: [legacy], partitionShards: 8 })).ok, false);
  const after = await call("getValue", legacy);
  assert.ok(after.value >= 0 && after.value < 1);
  report.scenarios.push({
    name: "legacy-balance-migration-and-mixed-callers",
    passed: true,
    consumedBefore: 17,
    consumedAfter: 43,
    beforeBalance: before.value,
    afterBalance: after.value,
  });
  const untouched = budget("untouched", 60, 3_600_000);
  const refused = await call("rateLimitMany", { limits: [untouched, legacy], partitionShards: 8 });
  assert.equal(refused.ok, false);
  assert.equal((await call("getValue", untouched)).value, 60);
  report.scenarios.push({ name: "migration-and-refusal-preserve-other-budget", passed: true });

  const fixed = budget("fixed-migration", 20, 3_600_000);
  fixed.config = { ...fixed.config, kind: "fixed window", start: 0 };
  for (let i = 0; i < 7; i++) assert.ok((await call("rateLimit", fixed)).ok);
  const fixedBefore = await call("getValue", fixed);
  for (let i = 0; i < 13; i++)
    assert.ok((await call("rateLimitMany", { limits: [fixed], partitionShards: 8 })).ok);
  const fixedAfter = await call("getValue", fixed);
  assert.equal(
    fixedAfter.ts,
    fixedBefore.ts,
    "Rehearsal crossed its fixed window; repeat on a new window",
  );
  assert.equal(fixedAfter.value, 0);
  assert.equal((await call("checkRateLimit", fixed)).ok, false);
  report.scenarios.push({
    name: "fixed-window-migration-preserves-balance-and-boundary",
    passed: true,
    consumedBefore: 7,
    consumedAfter: 13,
    periodMs: 3_600_000,
    sameWindow: true,
  });

  const actors = [0, 1].map((i) => budget("actor", 60, 60_000, String(i)));
  const orgs = [0, 1].map((i) => budget("org", 120, 60_000, String(i)));
  const times = [],
    counts = { ok: 0, refused: 0, failed: 0 };
  await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      for (let j = 0; j < 5; j++) {
        const start = performance.now();
        try {
          const result = await call("rateLimitMany", {
            limits: [actors[i % 2], orgs[i % 2]],
            partitionShards: 8,
          });
          counts[result.ok ? "ok" : "refused"]++;
        } catch {
          counts.failed++;
        }
        times.push(performance.now() - start);
      }
    }),
  );
  times.sort((a, b) => a - b);
  report.concurrent = {
    counts,
    p95Ms: times[94],
    clients: 20,
    requests: 100,
    initiallyUnpartitioned: true,
  };
  assert.deepEqual(counts, { ok: 100, refused: 0, failed: 0 });
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.resetBudgets = 0;
  report.leftPartitioned = 0;
  for (const budget of budgets) {
    await call("resetRateLimit", { name: budget.name, key: budget.key });
    report.resetBudgets++;
    // Without its partitions row, the budget no longer reads the partitioned layout.
    if ((await call("getValue", budget)).shard === -1) report.leftPartitioned++;
  }
  if (report.leftPartitioned) {
    report.result = "failed";
    process.exitCode = 1;
  }
  report.runtime = (await logs(cursor)).entries;
  report.finishedAt = new Date().toISOString();
  mkdirSync(".ci-results/hosted-rate-limits", { recursive: true });
  writeFileSync(
    `.ci-results/hosted-rate-limits/partitions-${expectedSha.slice(0, 7)}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: report.result,
      scenarios: report.scenarios,
      concurrent: report.concurrent,
      resetBudgets: report.resetBudgets,
      leftPartitioned: report.leftPartitioned,
      error: report.error,
    }),
  );
}
