import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { referenceLocal } from "./lib/reference-local.mjs";
import { repoRoot } from "./lib/repo-root.mjs";
const root = repoRoot;
const { urls, rpc } = referenceLocal(root);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = JSON.parse(
  readFileSync(join(root, ".browser-results/usage/load-source.json"), "utf8"),
);
const output = join(root, ".ci-results/79");
mkdirSync(output, { recursive: true });
const report = {
  codeSha: git("rev-parse", "HEAD"),
  dirty: !!git("status", "--porcelain"),
  runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  schemaSha256: hash(readFileSync(join(root, "platform/convex/lib/usageSchema.ts"))),
  recordedAt: new Date().toISOString(),
  environment: {
    url: urls.cloud,
    kind: "anonymous-local",
    region: "local-Windows",
    resources: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    convex: JSON.parse(readFileSync(join(root, "node_modules/convex/package.json"), "utf8"))
      .version,
    sharedMachine: true,
  },
  syntheticOnly: true,
  dataset:
    "Two organizations; copies of a locally imported synthetic NF-e metadata/version, shared synthetic original; 4 indexed listing rows per document. No fiscal source calls.",
  observations: [],
  seedThrottleRetries: 0,
  leaseTransportRetries: 0,
  insertedDocuments: 0,
  logicalDocumentVersionBytes: 0,
  clientResponseBytes: 0,
  result: "running",
};
const scopes = [];
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function seed(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc("mutation", "testing/usageProof:seed", args);
    } catch (error) {
      // Native local deployment caps writes at 4 MiB/s. Retry only explicit rejection.
      if (!error.message.endsWith(": 429") || attempt >= 5) throw error;
      report.seedThrottleRetries++;
      await delay(1500);
    }
  }
}
async function probeLease(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpc("mutation", "testing/usageProof:lease", args);
    } catch (error) {
      // The stable lease key makes a transport retry idempotent. Count it separately.
      if (!error.message.endsWith(": 503") || attempt >= 8) throw error;
      report.leaseTransportRetries++;
      await delay(200 + Math.random() * 200);
    }
  }
}
async function measure(name, concurrent, perClient, request) {
  const latency = [],
    statuses = {},
    started = performance.now();
  await Promise.all(
    Array.from({ length: concurrent }, async (_, client) => {
      for (let i = 0; i < perClient; i++) {
        const at = performance.now(),
          response = await request(scopes[client % scopes.length], client, i);
        const text = await response.text();
        report.clientResponseBytes += Buffer.byteLength(text);
        latency.push(performance.now() - at);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status === 200 && name.startsWith("metadata"))
          assert.equal(JSON.parse(text).data.page.length, 50);
      }
    }),
  );
  const observation = {
    name,
    concurrent,
    requests: latency.length,
    durationMs: performance.now() - started,
    p50Ms: quantile(latency, 0.5),
    p95Ms: quantile(latency, 0.95),
    maxMs: Math.max(...latency),
    statuses,
  };
  observation.requestsPerSecond = latency.length / (observation.durationMs / 1000);
  report.observations.push(observation);
  console.log(JSON.stringify(observation));
  return observation;
}
try {
  for (let i = 0; i < 2; i++) {
    const secret = `fnfe_${hash(crypto.randomUUID()).slice(0, 43)}`;
    const scope = await rpc("mutation", "testing/operationProof:prepare", {
      keyHash: hash(secret),
      suffix: `usage-load-${crypto.randomUUID()}`,
    });
    scopes.push({ ...scope, secret });
    await rpc("mutation", "usage:assignPlan", {
      organizationId: scope.organizationId,
      name: "Carga sintética",
      startsAt: Date.now() - 1000,
      endsAt: Date.now() + 86400000,
      limits: {
        imports: 1000,
        bytes: 1024 * 1024 * 1024,
        registry: 1000,
        captures: 1000,
        deliveries: 1000,
      },
      concurrency: 8,
      expectedVersion: 0,
      actor: "load-proof",
      reason: "Synthetic local benchmark",
    });
  }
  const headers = (scope) => ({
    Authorization: `Bearer ${scope.secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  });
  for (const scope of scopes) {
    const keys = Array.from({ length: 20 }, () => crypto.randomUUID());
    const admitted = await Promise.all(
      keys.map((key) =>
        probeLease({
          organizationId: scope.organizationId,
          key,
          release: false,
        }),
      ),
    );
    assert.equal(admitted.filter(Boolean).length, 8);
    report.observations.push({ name: "concurrent-leases", requests: 20, admitted: 8, refused: 12 });
    await Promise.all(
      keys.map((key) =>
        probeLease({
          organizationId: scope.organizationId,
          key,
          release: true,
        }),
      ),
    );
  }
  const reads = (scope) =>
    fetch(`${urls.site}/v1/documents?companyId=${scope.companyId}&limit=50`, {
      headers: headers(scope),
    });
  const accepts = (scope) =>
    fetch(`${urls.site}/v1/imports`, {
      method: "POST",
      headers: { ...headers(scope), "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        companyId: scope.companyId,
        files: [{ name: "synthetic.xml", size: 100, sha256: "a".repeat(64) }],
      }),
    });
  let previous = 0;
  for (const target of [10000, 100000]) {
    console.log(`Preparing ${target} synthetic metadata documents`);
    for (let offset = previous / 2; offset < target / 2; offset += 100) {
      const batches = await Promise.all(
        scopes.map((scope) =>
          seed({
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            companyId: scope.companyId,
            environment: "sandbox",
            sourceId: source.sourceId,
            offset,
            count: Math.min(100, target / 2 - offset),
          }),
        ),
      );
      for (const batch of batches) {
        report.insertedDocuments += batch.count;
        report.logicalDocumentVersionBytes += batch.logicalBytes;
      }
      if (offset === 0) {
        const preflight = await reads(scopes[0]);
        assert.equal(
          preflight.status,
          200,
          "Synthetic dataset must satisfy the public REST contract",
        );
        assert.equal((await preflight.json()).data.page.length, 50);
        const bounded = JSON.parse(
          await rpc("query", "testing/usageProof:boundedRead", {
            keyHash: hash(scopes[0].secret),
            company: scopes[0].companyId,
          }),
        );
        assert.equal(bounded.page.length, 50);
      }
      await delay(1000);
      if (report.insertedDocuments % 10000 === 0)
        console.log(`Seeded ${report.insertedDocuments} documents`);
    }
    const metadata = await measure(`metadata-${target}`, 20, 5, reads);
    const acceptance = await measure(`acceptance-${target}`, 20, 1, accepts);
    report.observations.push({
      name: `targets-${target}`,
      metadataAllSucceeded: metadata.statuses[200] === metadata.requests,
      acceptanceAllSucceeded: acceptance.statuses[200] === acceptance.requests,
      metadataP95AtMost800ms: metadata.p95Ms <= 800 && metadata.statuses[200] === metadata.requests,
      acceptanceP95AtMost1000ms:
        acceptance.p95Ms <= 1000 && acceptance.statuses[200] === acceptance.requests,
    });
    for (const scope of scopes) {
      const bounded = JSON.parse(
        await rpc("query", "testing/usageProof:boundedRead", {
          keyHash: hash(scope.secret),
          company: scope.companyId,
        }),
      );
      assert.equal(bounded.page.length, 50);
      report.observations.push({
        name: `bounded-read-${target}`,
        documentsReadLimit: 1000,
        bytesReadLimit: 4 * 1024 * 1024,
        returned: bounded.page.length,
        passed: true,
      });
    }
    previous = target;
  }
  // Saturate metadata concurrency separately from configured admission throttles.
  await measure("metadata-saturation-80", 80, 2, reads);
  await measure("acceptance-configured-throttle", 40, 1, accepts);
  report.cost = {
    currency: "USD",
    source: "https://www.convex.dev/pricing",
    checkedOn: "2026-09-24",
    basis:
      "Starter marginal rates; illustrative measured subset, not an invoice or cloud usage report; no included allowance applied",
    functionCallsPerMillion: 2.2,
    databaseStorageGbMonth: 0.22,
    databaseStorageSubsetGb: report.logicalDocumentVersionBytes / 1e9,
    databaseStorageSubsetUsdMonth: (report.logicalDocumentVersionBytes / 1e9) * 0.22,
    exclusions: [
      "Indexes, system fields, artifacts and usage tables",
      "Database I/O, cache hit ratio, egress, Node action GB-hours",
      "Base subscription, allowances, taxes, exchange rate",
      "Provider latency/cost: no external requests executed",
    ],
    localCloudSpend: 0,
  };
  // Completing a measurement does not mean its latency/availability targets were met.
  report.result = "completed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  for (const scope of scopes)
    await rpc("mutation", "testing/operationProof:retire", { keyId: scope.keyId }).catch(() => {});
  writeFileSync(join(output, "load.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify({
      result: report.result,
      documents: report.insertedDocuments,
      error: report.error,
    }),
  );
}
