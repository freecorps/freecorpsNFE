import { hostedProof, assertSyntheticScope } from "./lib/hosted-proof.mjs";
import { prepareScope, importSource, seedMetadata, hash, headers } from "./lib/hosted-fixtures.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { readPrivateState, writePrivateState } from "./lib/private-run-state.mjs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadTargets,
  remainingLoadTargets,
  runtimeUsage,
  assessLoad,
  adoptRevision,
} from "./lib/hosted-load.mjs";
import { planLoadOptions, planLoad, cleanupWithPlans } from "./lib/hosted-plan-load.mjs";

const mode = process.argv[3] ?? "preflight";
const requestedTargets = mode === "load" ? loadTargets(process.argv.slice(5)) : null;
const planOptions = mode === "plan-load" ? planLoadOptions(process.argv.slice(5)) : null;
const hosted = hostedProof(process.argv[2]);
const identity = await hosted.preflight();
if (mode === "preflight") {
  console.log(JSON.stringify(identity, null, 2));
  process.exit(0);
}
assert.ok(
  [
    "prepare",
    "load",
    "plan-load",
    "inspect",
    "recover-seed",
    "monitors",
    "read-candidate",
    "retention",
    "cleanup",
    "verify-cleanup",
    "monitor-candidate",
    "adopt-revision",
  ].includes(mode),
);
const privatePath = process.argv[4];
assert.ok(privatePath, "Provide an absolute private run-state path outside the checkout");
assert.ok(isAbsolute(privatePath));
const privateRelative = relative(process.cwd(), resolve(privatePath));
assert.ok(
  privateRelative === ".." ||
    privateRelative.startsWith(`..\\`) ||
    privateRelative.startsWith("../") ||
    isAbsolute(privateRelative),
  "Private run-state must stay outside the checkout",
);
const output = ".ci-results/hosted-79-80";
mkdirSync(output, { recursive: true });
mkdirSync(dirname(privatePath), { recursive: true });
const physicalRelative = relative(
  realpathSync(process.cwd()),
  join(realpathSync(dirname(privatePath)), basename(privatePath)),
);
assert.ok(
  physicalRelative.startsWith("../") ||
    physicalRelative.startsWith("..\\") ||
    isAbsolute(physicalRelative),
  "Private directory resolves inside the checkout",
);
const savePrivate = (state) => writePrivateState(privatePath, state);
const state = readPrivateState(privatePath) ?? {
  suffix: `hosted-79-80-${randomUUID()}`,
  scopes: [],
  identity,
};
const targets = requestedTargets ? remainingLoadTargets(requestedTargets, state.scopes) : [];
if (mode !== "adopt-revision")
  assert.equal(state.identity.health.sha, identity.health.sha, "Published revision changed");
for (const s of state.scopes) await assertSyntheticScope(hosted, state, s);
if (mode === "adopt-revision") {
  assert.equal(state.scopes.length, 2, "Prepare both synthetic scopes first");
  const next = adoptRevision(state, identity, process.argv[5]);
  savePrivate(next);
  const receipt = {
    recordedAt: new Date().toISOString(),
    transition: next.revisions.at(-1),
    scopeCount: state.scopes.length,
    seeded: state.scopes.map((s) => s.seeded),
    identity,
  };
  writeFileSync(join(output, "revision-adoption.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
  process.exit(0);
}
if (mode === "verify-cleanup") {
  const checks = [];
  for (const s of state.scopes) {
    const docs = await hosted.rows(
      "fiscalDocuments",
      "by_companyId_environment_listedAt",
      { companyId: s.companyId, environment: "sandbox" },
      2,
      ["_id"],
    );
    assert.deepEqual(
      docs.map((d) => d._id),
      [s.source.doc._id],
    );
    const listings = await hosted.rows(
      "documentListings",
      "by_companyId_environment_filterKey_date",
      { companyId: s.companyId, environment: "sandbox" },
      5,
      ["documentId"],
    );
    assert.equal(listings.length, 4);
    assert.ok(listings.every((r) => r.documentId === s.source.doc._id));
    const versions = await hosted.rows(
      "documentVersions",
      "by_artifactId",
      { artifactId: s.source.version.artifactId },
      2,
      ["_id"],
    );
    assert.deepEqual(
      versions.map((v) => v._id),
      [s.source.version._id],
    );
    const monitors = await hosted.rows(
      "operationalMonitors",
      "by_organizationId",
      { organizationId: s.organizationId },
      20,
    );
    assert.ok(monitors.every((m) => !m.enabled));
    const jobs = await hosted.query(
      `return await Promise.all(${JSON.stringify(monitors.flatMap((m) => (m.scheduledId ? [m.scheduledId] : [])))}.map(async id => (await ctx.db.system.get(id))?.state.kind ?? "absent"));`,
    );
    assert.ok(jobs.every((state) => !["pending", "inProgress"].includes(state)));
    const response = await fetch(
      `${hosted.target.siteUrl}/v1/documents?companyId=${s.companyId}&limit=50`,
      { headers: headers(s) },
    );
    assert.equal(response.status, 401);
    checks.push({
      originalDocuments: docs.length,
      originalVersions: versions.length,
      originalListings: listings.length,
      pausedMonitors: monitors.length,
      scheduledStates: jobs,
      revokedKeyHttpStatus: response.status,
    });
  }
  const report = { identity, recordedAt: new Date().toISOString(), result: "passed", checks };
  writeFileSync(join(output, "cleanup-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  process.exit(0);
}
if (mode === "monitor-candidate") {
  const monitor = await hosted.query(
    `return await ctx.db.get(${JSON.stringify(state.monitors[0])});`,
  );
  const now = Date.now(),
    results = {};
  for (const label of ["before", "after"]) {
    const cursor = (await hosted.logs(0)).cursor;
    const metrics = await hosted.candidate(
      readFileSync(join(output, `metrics-${label}.js`), "utf8"),
      { monitor, now },
    );
    const logs = await hosted.logs(cursor);
    results[label] = {
      metrics: metrics.map(({ kind, value, capped, sources }) => ({
        kind,
        value,
        capped,
        ...(sources ? { sources } : {}),
      })),
      runtime: logs.entries.filter((e) => e.identifier === "testQuery"),
    };
  }
  const firing = (metrics) =>
    metrics.map((m) => ({
      kind: m.kind,
      firing:
        m.value === null
          ? null
          : m.kind === "certificate"
            ? m.value <= monitor.thresholds[m.kind]
            : m.value >= monitor.thresholds[m.kind],
    }));
  assert.deepEqual(firing(results.after.metrics), firing(results.before.metrics));
  writeFileSync(
    join(output, "candidate-monitor.json"),
    JSON.stringify(
      {
        identity,
        recordedAt: new Date().toISOString(),
        thresholds: monitor.thresholds,
        equivalentAlertDecisions: true,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(results));
  process.exit(0);
}
if (mode === "plan-load") {
  const result = await planLoad(hosted, state, savePrivate, planOptions);
  const report = {
    identity,
    recordedAt: new Date().toISOString(),
    options: planOptions,
    ...result,
  };
  mkdirSync(".ci-results/hosted-429", { recursive: true });
  writeFileSync(".ci-results/hosted-429/plan-load.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ result: result.result }));
  process.exit(result.result === "passed" ? 0 : 1);
}
if (mode === "cleanup") {
  const { cleanupHosted } = await import("./lib/hosted-cleanup.mjs");
  const result = await cleanupWithPlans(hosted, state, cleanupHosted);
  writeFileSync(
    join(output, "cleanup.json"),
    JSON.stringify({ identity, ...result }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  process.exit(result.closedPlans?.failed?.length ? 1 : 0);
}
if (mode === "retention") {
  const { retentionDrill } = await import("./lib/hosted-retention-drill.mjs");
  const result = await retentionDrill(hosted, state);
  writeFileSync(
    join(output, "retention.json"),
    JSON.stringify({ identity, ...result }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}
if (mode === "read-candidate") {
  const bundle = readFileSync(join(output, "candidate.js"), "utf8"),
    observations = [];
  for (const s of state.scopes) {
    const scope = {
      organizationId: s.organizationId,
      projectId: s.projectId,
      companyId: s.companyId,
      environment: "sandbox",
      cursor: null,
      limit: 50,
    };
    const baseline = JSON.parse(
      await hosted.rpc("query", "documentRest:dispatch", {
        keyHash: s.keyHash,
        company: s.companyId,
        environment: "sandbox",
        path: "/v1/documents",
        search: `?companyId=${s.companyId}&limit=50`,
      }),
    );
    const cursor = (await hosted.logs(0)).cursor;
    const candidate = JSON.parse(
      await hosted.candidate(bundle, {
        keyHash: s.keyHash,
        company: s.companyId,
        environment: scope.environment,
        path: "/v1/documents",
        search: `?companyId=${s.companyId}&limit=50`,
      }),
    );
    assert.deepEqual(candidate, baseline);
    const logs = await hosted.logs(cursor);
    const sample = logs.entries.filter((e) => e.identifier === "testQuery");
    observations.push({ returned: candidate.page.length, equivalent: true, runtime: sample });
  }
  writeFileSync(
    join(output, "candidate-read.json"),
    JSON.stringify({ identity, bundleSha256: hash(bundle), observations }, null, 2) + "\n",
  );
  console.log(JSON.stringify(observations));
  process.exit(0);
}
if (mode === "recover-seed") {
  const { recoverSeed } = await import("./lib/hosted-recover-seed.mjs");
  for (const scope of state.scopes) console.log(JSON.stringify(await recoverSeed(hosted, scope)));
  process.exit(0);
}
if (mode === "monitors") {
  const { monitorDrill } = await import("./lib/hosted-monitor-drill.mjs");
  const result = await monitorDrill(hosted, state, savePrivate, process.argv[5]);
  writeFileSync(
    join(output, "monitors.json"),
    JSON.stringify({ identity, ...result }, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  process.exit(result.result === "passed" ? 0 : 1);
}
if (mode === "inspect") {
  for (const scope of state.scopes) {
    const ops = await hosted.rows(
      "operations",
      "by_organizationId_and_projectId_and_environment",
      { organizationId: scope.organizationId, projectId: scope.projectId, environment: "sandbox" },
      10,
    );
    console.log(JSON.stringify(ops.map((o) => ({ state: o.state, code: o.code, stage: o.stage }))));
  }
  process.exit(0);
}
if (mode === "prepare") {
  for (let i = state.scopes.length; i < 2; i++) {
    const scope = await prepareScope(hosted, `${state.suffix}-${i}`);
    state.scopes.push(scope);
    savePrivate(state);
    scope.source = await importSource(hosted, scope);
    scope.seeded = 1;
    savePrivate(state);
    console.log(`Synthetic scope ${i + 1} imported and indexed`);
  }
  for (const scope of state.scopes)
    if (!scope.source) {
      scope.source = await importSource(hosted, scope);
      scope.seeded = 1;
      savePrivate(state);
      console.log("Recovered synthetic source import");
    }
  process.exit(0);
}
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const report = {
  recordedAt: new Date().toISOString(),
  codeSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runnerSha256: hash(readFileSync(new URL(import.meta.url))),
  identity,
  syntheticOnly: true,
  requestedTargets,
  observations: [],
  runtime: [],
  logicalBytes: 0,
};
let cursor = (await hosted.logs(0)).cursor;
async function collectLogs() {
  const result = await hosted.logs(cursor);
  cursor = result.cursor;
  report.runtime.push(...result.entries);
}
async function measure(name, concurrent, perClient, request) {
  const times = [],
    statuses = {},
    started = performance.now();
  await Promise.all(
    Array.from({ length: concurrent }, async (_, i) => {
      for (let j = 0; j < perClient; j++) {
        const at = performance.now(),
          res = await request(state.scopes[i % 2], j),
          text = await res.text();
        times.push(performance.now() - at);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (name.startsWith("metadata") && res.status === 200)
          assert.equal(JSON.parse(text).data.page.length, 50);
      }
    }),
  );
  const observation = {
    name,
    concurrent,
    requests: times.length,
    statuses,
    p50Ms: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    maxMs: Math.max(...times),
    durationMs: performance.now() - started,
  };
  report.observations.push(observation);
  console.log(JSON.stringify(observation));
  await collectLogs();
  saveLoad();
}
const reads = (s) =>
  fetch(`${hosted.target.siteUrl}/v1/documents?companyId=${s.companyId}&limit=50`, {
    headers: headers(s),
    signal: AbortSignal.timeout(30000),
  });
const accepts = (s) =>
  fetch(`${hosted.target.siteUrl}/v1/imports`, {
    method: "POST",
    headers: { ...headers(s), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      companyId: s.companyId,
      files: [{ name: "synthetic.xml", size: 100, sha256: "a".repeat(64) }],
    }),
    signal: AbortSignal.timeout(30000),
  });
const scaleStarts = new Map();
function saveLoad() {
  writeFileSync(
    join(output, "load.json"),
    JSON.stringify(
      {
        ...report,
        assessment: assessLoad(report.observations, targets),
        sampledUsage: runtimeUsage(report.runtime),
      },
      null,
      2,
    ) + "\n",
  );
}
function saveScale(target) {
  const start = scaleStarts.get(target);
  if (!start) return;
  writeFileSync(
    join(output, `load-${target}-baseline.json`),
    JSON.stringify(
      {
        ...report,
        observations: report.observations.slice(start.observations),
        assessment: assessLoad(report.observations.slice(start.observations), [target]),
        runtime: report.runtime.slice(start.runtime),
        sampledUsage: runtimeUsage(report.runtime.slice(start.runtime)),
      },
      null,
      2,
    ) + "\n",
  );
}
let activeTarget;
try {
  for (const target of targets) {
    activeTarget = target;
    // Include seed reads/writes in the receipt, not only the HTTP measurement window.
    scaleStarts.set(target, {
      observations: report.observations.length,
      runtime: report.runtime.length,
    });
    for (const scope of state.scopes) {
      assert.ok(scope.source);
      while (scope.seeded < target / 2) {
        const count = Math.min(1000, target / 2 - scope.seeded);
        const result = await seedMetadata(hosted, scope, scope.source, scope.seeded, count);
        scope.seeded += count;
        report.logicalBytes += result.logicalBytes;
        savePrivate(state);
        if (scope.seeded % 5000 === 0)
          console.log(`Seeded ${scope.seeded} metadata documents in scope`);
      }
    }
    await collectLogs();
    for (let round = 0; round < 3; round++) {
      await measure(`metadata-${target}-round-${round + 1}`, 20, 5, reads);
      await measure(`acceptance-${target}-round-${round + 1}`, 20, 1, accepts);
      // Keep baseline below the configured admission quota, which is tested separately.
      if (round < 2) await delay(61000);
    }
    saveScale(target);
  }
  if (activeTarget === 100000) await measure("metadata-saturation-80", 80, 2, reads);
  report.result = "completed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await collectLogs();
  saveLoad();
  saveScale(activeTarget);
}
