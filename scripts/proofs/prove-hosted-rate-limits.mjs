import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostedProof } from "../lib/hosted-proof.mjs";
import { backendRequest, validationTarget } from "../lib/validation.mjs";

const [credentialPath, expectedSha] = process.argv.slice(2);
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/);
const h = hostedProof(credentialPath);
const identity = await h.preflight();
assert.equal(identity.health.sha, expectedSha);
const context = {
  target: validationTarget,
  key: JSON.parse(readFileSync(credentialPath, "utf8")).adminKey,
};
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
const call = async (path, args) =>
  (
    await backendRequest(context, "/api/function", {
      path: `lib:${path}`,
      args,
      componentPath: "rateLimiter",
      format: "json",
    })
  ).value;
const cursor = (await h.logs(0)).cursor;
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
  for (const { name, key } of budgets) {
    await call("resetRateLimit", { name, key });
    report.resetBudgets++;
  }
  report.runtime = (await h.logs(cursor)).entries;
  report.finishedAt = new Date().toISOString();
  mkdirSync(".ci-results/hosted-79-80", { recursive: true });
  writeFileSync(
    `.ci-results/hosted-79-80/partitions-${expectedSha.slice(0, 7)}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: report.result,
      scenarios: report.scenarios,
      concurrent: report.concurrent,
      resetBudgets: report.resetBudgets,
      error: report.error,
    }),
  );
}
