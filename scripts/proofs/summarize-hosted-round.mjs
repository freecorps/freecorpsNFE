import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assessLoad, runtimeUsage } from "../lib/hosted-load.mjs";

const [input, output, ...loadNames] = process.argv.slice(2);
assert.ok(input && output && loadNames.length, "Informe entrada, saída e recibos de carga");
mkdirSync(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const read = (name) => JSON.parse(readFileSync(join(input, name), "utf8"));
const loads = [];
for (const name of loadNames) {
  assert.match(name, /^load-[a-zA-Z0-9-]+\.json$/);
  const bytes = readFileSync(join(input, name));
  const { runtime, ...report } = JSON.parse(bytes.toString("utf8"));
  const runtimeName = name.replace(/\.json$/, "-runtime.jsonl");
  writeFileSync(
    join(output, runtimeName),
    runtime.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const observedTargets = [
    ...new Set(
      report.observations.flatMap((row) => {
        const match = /^(?:metadata|acceptance)-(\d+)-round-/.exec(row.name);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const expectedTargets = report.assessment
    ? [
        ...new Set(
          report.assessment.rounds.map((row) => Number(/^\w+-(\d+)-round-/.exec(row.name)?.[1])),
        ),
      ]
    : report.requestedTargets;
  assert.ok(expectedTargets?.length && expectedTargets.every(Number.isSafeInteger));
  // Missing observations must fail confirmation, never remove an attempted scale.
  const targets = [...new Set([...expectedTargets, ...observedTargets])];
  const pilotAssessment = assessLoad(report.observations, targets, {
    metadata: 1200,
    acceptance: 2500,
  });
  const rawSha256 = hash(bytes);
  write(name, {
    ...report,
    assessment: report.assessment ?? assessLoad(report.observations, report.requestedTargets),
    pilotAssessment,
    sampledUsage: runtimeUsage(runtime),
    runtimeFile: runtimeName,
    rawSha256,
  });
  loads.push({
    file: name,
    publishedSha: report.identity.health.sha,
    targets,
    rawSha256,
    pilotPassed: pilotAssessment.passed,
  });
}

const { runtime, ...monitors } = read("monitors.json");
assert.equal(monitors.result, "passed");
const from = Date.parse(monitors.capacityWindow.startedAt) / 1000;
const until = Date.parse(monitors.capacityWindow.finishedAt) / 1000;
const capacity = runtime.filter(
  (r) => r.identifier === "observability:evaluate" && r.timestamp >= from && r.timestamp <= until,
);
assert.ok(capacity.length >= 20, "Janela de capacidade incompleta");
assert.ok(
  capacity.every((r) => !r.error),
  "Avaliação falhou na janela de capacidade",
);
const usage = runtimeUsage(capacity).total;
const meanBytes = (usage.readBytes + usage.writeBytes) / capacity.length;
const monthlyCalls = 20 * 60 * 24 * 30;
const beforeUsage = read("usage-before-load.json");
const finalUsage = read("usage-final.json");
const observedIoGb =
  finalUsage.metrics.databaseIoGb.usage.current_month -
  beforeUsage.metrics.databaseIoGb.usage.current_month;
const observedCalls =
  finalUsage.metrics.functionCalls.usage.current_month -
  beforeUsage.metrics.functionCalls.usage.current_month;
assert.ok(observedIoGb >= 0 && observedCalls >= 0, "Contadores reiniciaram entre os recibos");
const durations = capacity.map((r) => r.executionTime * 1000).sort((a, b) => a - b);
const runtimeName = "monitors-runtime.jsonl";
writeFileSync(
  join(output, runtimeName),
  runtime.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
write("monitors.json", {
  ...monitors,
  runtimeFile: runtimeName,
  capacityUsage: usage,
  backendP95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
});
write("cost.json", {
  checkedOn: "2026-10-05",
  source: "https://www.convex.dev/pricing",
  plan: "Professional US East; marginal rates before shared allowances",
  prices: { databaseIoUsdPerGB: 0.2, functionUsdPerMillion: 2 },
  bytesPerGB: 1e9,
  monthlyCalls,
  measuredCalls: capacity.length,
  meanBytesPerEvaluation: meanBytes,
  projectedMonthlyMonitorUsd: ((meanBytes * monthlyCalls) / 1e9) * 0.2 + (monthlyCalls / 1e6) * 2,
  monthlyMonitorBudgetUsd: 20,
  observedDeploymentDelta: {
    fromFile: "usage-before-load.json",
    toFile: "usage-final.json",
    databaseIoGb: observedIoGb,
    functionCalls: observedCalls,
    marginalIoAndCallsUsd: observedIoGb * 0.2 + (observedCalls / 1e6) * 2,
    attribution:
      "All deployment activity between snapshots, including seeds, cleanup, publication checks, prior candidates " +
      "and administrative preparation by the other conversation. Provider counters may lag; not the cost of HTTP load alone.",
  },
  scope:
    "Extrapolation of the full-capacity observation window, possibly including opening transitions. " +
    "Includes evaluation database IO and calls. Excludes storage, action compute, network, provider runtime retention, " +
    "taxes, fixed plan fees, Cloudflare, CI runners, other application traffic and artificial fixture administration. Not an invoice.",
});
for (const name of [
  "retention.json",
  "cleanup.json",
  "cleanup-large-batch.json",
  "cleanup-resume.json",
  "cleanup-verification.json",
  "before-publication.json",
  "usage-before-load.json",
  "usage-after-baseline.json",
  "usage-after-operations.json",
  "usage-after-100k-control.json",
  "usage-final.json",
  "occ-message.json",
  "revision-adoption.json",
  "operational-code-comparison.json",
])
  write(name, read(name));
for (const name of readdirSync(input).filter(
  (name) => name === "direct-limiter.json" || /^partitions-[a-f0-9]{7}\.json$/.test(name),
)) {
  const { runtime, ...report } = read(name);
  const runtimeFile = name.replace(/\.json$/, "-runtime.jsonl");
  writeFileSync(
    join(output, runtimeFile),
    runtime.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  write(name, { ...report, runtimeFile });
}
const publications = [];
for (const directory of readdirSync(input).filter((name) =>
  /^publication(?:-[a-f0-9]{7})?$/.test(name),
)) {
  const report = read(`${directory}/deployment.json`);
  assert.ok(["validated", "partial"].includes(report.state));
  if (report.state === "validated") assert.equal(report.before, report.after);
  const file = `publication-${report.sha.slice(0, 7)}.json`;
  write(file, report);
  publications.push({ file, sha: report.sha, state: report.state });
}
const measuredSha = loads.at(-1).publishedSha;
const finalLoads = loads.filter(
  (load) => load.publishedSha === measuredSha && load.targets.includes(100000),
);
const distinctRuns = new Set(finalLoads.map((load) => load.rawSha256)).size;
assert.ok(publications.some((p) => p.sha === measuredSha && p.state === "validated"));
const ci = read(`ci-${measuredSha.slice(0, 7)}/.ci-results/tests.json`);
assert.equal(ci.revision.checkedSha, measuredSha);
assert.equal(ci.result, "passed");
write("ci-tests.json", ci);
write("round.json", {
  recordedAt: new Date().toISOString(),
  loads,
  publications,
  confirmation: {
    publishedSha: measuredSha,
    requiredIndependentRuns: 2,
    observedIndependentRuns: distinctRuns,
    files: finalLoads.map((load) => load.file),
    passed: distinctRuns >= 2 && finalLoads.every((load) => load.pilotPassed),
    reason:
      "Two complete three-round runs predeclared before measuring this candidate, because earlier candidates failed on repetition.",
  },
  pilotTargets: {
    metadataP95Ms: 1200,
    acceptanceP95Ms: 2500,
    profile:
      "20 clients concentrated in two organizations; three rounds per scale; all requests must return 200",
    status:
      "Private pilot targets explicitly selected by the maintainer before the 100k result; original targets remain optimization goals, not a public SLA",
  },
  limitations:
    "Synthetic metadata and operational fixtures. No fiscal transmission, real certificate rotation or webhook delivery. " +
    "Runtime logs are samples; provider counters include all deployment activity and may lag. " +
    "Global provider counters also include preparation of two scopes by conversation 38b8cde3-4851-4c9f-b63a-a378aff9366f; " +
    "that separate preparation had no load or monitors and verified cleanup at 2026-10-05T18:51:20Z.",
});
console.log("Recibos sanitizados e projeção de custo gerados");
