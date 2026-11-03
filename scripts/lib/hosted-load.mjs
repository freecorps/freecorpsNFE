import assert from "node:assert/strict";

/** Explicit operator transition, after checking persisted ownership of every scope. */
export function adoptRevision(state, identity, previousSha) {
  assert.match(previousSha ?? "", /^[a-f0-9]{40}$/, "Informe o SHA publicado anterior completo");
  assert.equal(state.identity.health.sha, previousSha, "O estado não pertence ao SHA anterior");
  assert.match(identity.health.sha, /^[a-f0-9]{40}$/);
  assert.notEqual(identity.health.sha, previousSha, "A revisão publicada não mudou");
  assert.deepEqual(identity.target, state.identity.target, "O alvo não pode mudar");
  assert.equal(identity.frontend.sha, identity.health.sha);
  return {
    ...state,
    identity,
    revisions: [
      ...(state.revisions ?? []),
      { previousSha, publishedSha: identity.health.sha, adoptedAt: new Date().toISOString() },
    ],
  };
}

// A cloud load test must name its maximum scale; never escalate to 100k implicitly.
export function loadTargets(args) {
  assert.ok(
    args.length === 2 && args[0] === "--max-documents" && ["10000", "100000"].includes(args[1]),
    "Informe --max-documents 10000 ou --max-documents 100000 para a carga hospedada",
  );
  return [10000, 100000].filter((size) => size <= Number(args[1]));
}

export function remainingLoadTargets(targets, scopes) {
  const maximum = targets.at(-1);
  assert.ok(scopes.length === 2, "Prepare as duas organizações antes da carga");
  for (const scope of scopes) {
    assert.ok(
      Number.isSafeInteger(scope.seeded) && scope.seeded >= 1 && scope.seeded <= maximum / 2,
      "O estado existente excede --max-documents ou tem contagem inválida",
    );
  }
  return targets.filter((size) => scopes.every((scope) => scope.seeded <= size / 2));
}

/** Completion of the runner is separate from meeting the engineering targets. */
export function assessLoad(observations, targets, latency = { metadata: 800, acceptance: 1000 }) {
  assert.ok(
    [latency.metadata, latency.acceptance].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ),
  );
  const rounds = targets.flatMap((size) =>
    ["metadata", "acceptance"].flatMap((kind) =>
      [1, 2, 3].map((round) => {
        const name = `${kind}-${size}-round-${round}`;
        const samples = observations.filter((row) => row.name === name);
        const sample = samples[0];
        const expectedRequests = kind === "metadata" ? 100 : 20;
        const targetP95Ms = latency[kind];
        const complete =
          samples.length === 1 && sample.concurrent === 20 && sample.requests === expectedRequests;
        const allSuccessful =
          complete &&
          sample.statuses?.[200] === expectedRequests &&
          Object.entries(sample.statuses).every(
            ([status, count]) => status === "200" || count === 0,
          );
        const withinLatency =
          complete &&
          Number.isFinite(sample.p95Ms) &&
          sample.p95Ms >= 0 &&
          sample.p95Ms <= targetP95Ms;
        return {
          name,
          expectedRequests,
          targetP95Ms,
          complete,
          allSuccessful,
          withinLatency,
          passed: !!(allSuccessful && withinLatency),
        };
      }),
    ),
  );
  return { passed: rounds.length > 0 && rounds.every((round) => round.passed), rounds };
}

export const summarizeUsage = (rows) => {
  const sum = (key) => rows.reduce((n, row) => n + (row.usageStats?.[key] ?? 0), 0);
  return {
    calls: rows.length,
    errors: rows.filter((r) => r.error).length,
    // retryCount is the attempt ordinal, not a delta to sum across completions.
    observedRetryAttempts: rows.filter((row) => (row.occRetries ?? 0) > 0).length,
    readDocuments: sum("databaseReadDocuments"),
    readBytes: sum("databaseReadBytes"),
    writeBytes: sum("databaseWriteBytes"),
  };
};

export function groupRuntime(rows) {
  const application = {},
    administration = {};
  for (const row of rows) {
    const groups =
      row.identifier === "testQuery" || row.identifier.startsWith("_system/")
        ? administration
        : application;
    const key = `${row.componentPath ?? "root"}/${row.identifier}`;
    (groups[key] ??= []).push(row);
  }
  return { application, administration, total: summarizeUsage(rows) };
}

export function runtimeUsage(rows) {
  const { application, administration, total } = groupRuntime(rows);
  const summarize = (groups) =>
    Object.fromEntries(
      Object.entries(groups).map(([name, entries]) => [name, summarizeUsage(entries)]),
    );
  return { application: summarize(application), administration: summarize(administration), total };
}
