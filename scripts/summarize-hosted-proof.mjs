import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hash } from "./lib/hosted-fixtures.mjs";
import assert from "node:assert/strict";
import { groupRuntime, summarizeUsage as summary } from "./lib/hosted-load.mjs";

const input = ".ci-results/hosted-79-80";
const output = process.argv[2] ?? "docs/v1.0/evidence/79-80";
mkdirSync(output, { recursive: true });
const read = (file) => JSON.parse(readFileSync(join(input, file), "utf8"));
const write = (file, data) =>
  writeFileSync(join(output, file), JSON.stringify(data, null, 2) + "\n");
const writeEvents = (file, entries) =>
  writeFileSync(
    join(output, file),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
write("tests.json", {
  ...JSON.parse(readFileSync(".ci-results/tests.json", "utf8")),
  checkoutWasDirty: true,
  scope:
    "Local full suite on the candidate working tree; revision identifies its base, sources.json identifies final sources. Hosted fiscal transport excluded.",
});
for (const size of [10000, 100000]) {
  const file = `load-${size}-baseline.json`,
    raw = read(file);
  const { application: groups, administration, total } = groupRuntime(raw.runtime);
  const runtimeFile = `load-${size}-runtime.jsonl`;
  writeEvents(
    runtimeFile,
    Object.values(groups).flatMap((rows) =>
      rows.filter((r) => r.error || r.occRetries).concat(rows.slice(0, 3)),
    ),
  );
  write(file, {
    identity: raw.identity,
    recordedAt: raw.recordedAt,
    checkoutBaseSha: raw.codeSha,
    checkoutWasDirty: true,
    runnerSha256: raw.runnerSha256,
    originalReceiptSha256: hash(readFileSync(join(input, file))),
    dataset: {
      totalMetadataDocuments: size,
      organizations: 2,
      distinctImportedXml: 2,
      syntheticOnly: true,
    },
    observations: raw.observations,
    runtimeSamplesFile: runtimeFile,
    runtime: Object.fromEntries(
      Object.entries(groups).map(([name, rows]) => [
        name,
        {
          ...summary(rows),
          recordedSamples:
            rows.filter((r) => r.error || r.occRetries).length + Math.min(3, rows.length),
        },
      ]),
    ),
    administrativeRuntime: Object.fromEntries(
      Object.entries(administration).map(([name, rows]) => [name, summary(rows)]),
    ),
    totalSampledRuntime: total,
    collectionNotes:
      "Application and administrative IO are reported separately; totalSampledRuntime includes both. Logs cover only the captured invocation and may omit earlier seeding, prepare, cleanup, retries or concurrent work. Samples are not billing totals. Historical rounds paused 15 seconds; runner now uses 61 seconds. See the original receipt for completion and collection failures.",
  });
}
for (const file of [
  "candidate-read.json",
  "candidate-build.json",
  "candidate-monitor.json",
  "metrics-build.json",
  "retention.json",
  "cleanup.json",
  "cleanup-mass.json",
  "cleanup-verification.json",
  "expiry.json",
])
  write(file, read(file));
const { runtime: monitorRuntime, ...monitorReceipt } = read("monitors.json");
writeEvents("monitors-runtime.jsonl", monitorRuntime);
write("monitors.json", {
  ...monitorReceipt,
  runtimeFile: "monitors-runtime.jsonl",
  runtimeEntries: monitorRuntime.length,
});

const monitor = read("candidate-monitor.json");
// Concurrent runner inspections appear as additional testQuery entries. Metrics probe is the large read.
const metricSample = (label) =>
  monitor.results[label].runtime.toSorted(
    (a, b) => b.usageStats.databaseReadDocuments - a.usageStats.databaseReadDocuments,
  )[0];
const before = metricSample("before"),
  after = metricSample("after");
const evaluations = read("monitors.json").runtime.filter(
  (r) => r.identifier === "observability:evaluate" && !r.error,
);
const steady = evaluations.filter(
  (r) => r.usageStats.databaseWriteDocuments === 4 && r.usageStats.databaseReadDocuments >= 600,
);
assert.ok(steady.length > 0, "No incident-state runtime samples for the cost projection");
const baselineBytes =
  steady.reduce((n, r) => n + r.usageStats.databaseReadBytes + r.usageStats.databaseWriteBytes, 0) /
  steady.length;
const price = {
  databaseIoUsdPerGB: 0.2,
  functionUsdPerMillion: 2,
  databaseStorageUsdPerGBMonth: 0.2,
  actionComputeUsdPerGBHour: 0.3,
  networkUsdPerGB: 0.12,
};
const monthlyCalls = 20 * 60 * 24 * 30;
const monthly = (bytes) =>
  ((bytes * monthlyCalls) / 1e9) * price.databaseIoUsdPerGB +
  (monthlyCalls / 1e6) * price.functionUsdPerMillion;
const load = read("load-100000-baseline.json");
const pageBefore = load.runtime.find(
  (r) =>
    r.identifier === "documentRest:dispatch" &&
    !r.error &&
    r.usageStats.databaseReadDocuments === 462,
);
const pageAfter = read("candidate-read.json").observations[0].runtime.find(
  (r) => r.usageStats.databaseReadDocuments === 212,
);
assert.ok(pageBefore && pageAfter);
write("cost.json", {
  priceCheckedOn: "2026-09-30",
  source: "https://www.convex.dev/pricing",
  plan: "Professional, US rates, marginal cost before shared allowances",
  price,
  monthlyCalls,
  metadataPageIo: {
    returnedDocuments: 50,
    beforeReadBytes: pageBefore.usageStats.databaseReadBytes,
    afterReadBytes: pageAfter.usageStats.databaseReadBytes,
    usdPer10000UncachedQueriesBefore:
      ((pageBefore.usageStats.databaseReadBytes * 10000) / 1e9) * price.databaseIoUsdPerGB,
    usdPer10000UncachedQueriesAfter:
      ((pageAfter.usageStats.databaseReadBytes * 10000) / 1e9) * price.databaseIoUsdPerGB,
    scope:
      "Query database IO only, representative 100k synthetic metadata sample. Excludes authorization mutation, HTTP action, audit, cache savings, retries and client network. Not a complete route bill.",
  },
  steadyMutationSamples: steady.length,
  observedBaselineBytesPerEvaluation: baselineBytes,
  measuredMetrics: { before: summary([before]), after: summary([after]) },
  projectedMonthlyMonitorUsd: {
    baseline: monthly(baselineBytes),
    candidate: monthly(
      baselineBytes - before.usageStats.databaseReadBytes + after.usageStats.databaseReadBytes,
    ),
  },
  limits:
    "30-day incident scenario, 20 monitors, 20 endpoints each, default thresholds. Candidate estimate replaces measured metrics IO only; full candidate mutation not deployed. Excludes storage, transition writes, action compute, external IO, taxes and shared plan fees. Raising count thresholds to 100 retains the baseline ceiling. Not actual billed spend.",
});
console.log("Sanitized hosted evidence and reproducible cost projection written");
const sourcePaths = [
  "platform/convex/documentRest.ts",
  "platform/convex/documents.ts",
  "platform/convex/lib/documentCore.ts",
  "platform/convex/importRest.ts",
  "platform/convex/imports.ts",
  "platform/convex/lib/importAdmission.ts",
  "platform/convex/lib/operationalMetrics.ts",
  "scripts/prove-hosted-operations.mjs",
  "scripts/lib/hosted-proof.mjs",
  "scripts/lib/hosted-load.mjs",
  "scripts/lib/hosted-fixtures.mjs",
  "scripts/lib/hosted-monitor-drill.mjs",
  "scripts/lib/hosted-retention-drill.mjs",
  "scripts/lib/hosted-cleanup.mjs",
  "scripts/lib/hosted-recover-seed.mjs",
  "scripts/lib/private-run-state.mjs",
  "scripts/build-hosted-read-probe.mjs",
  "scripts/build-hosted-monitor-probe.mjs",
  "scripts/prove-document-expiry.mjs",
  "scripts/summarize-hosted-proof.mjs",
];
write("sources.json", {
  checkoutBaseSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  checkoutWasDirty: true,
  purpose:
    "Final reproducible sources, SHA-256 with LF line endings. Historical runner and bundle hashes remain in individual receipts; later guard/collector/format fixes are not retroactive re-execution.",
  sources: sourcePaths.map((path) => ({
    path,
    sha256: hash(readFileSync(path, "utf8").replaceAll("\r\n", "\n")),
  })),
});
