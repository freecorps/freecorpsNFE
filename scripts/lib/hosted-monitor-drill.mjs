import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { scopeFields } from "./hosted-fixtures.mjs";
import { OPERATION_SOURCES } from "../../platform/convex/lib/operationSources.ts";

/** 101 synthetic failures per source, one beyond the 100 the monitor reads. */
const FAILURES = OPERATION_SOURCES.length * 101;
const DAY = 86400000;
const thresholds = {
  queue: 300000,
  lease: 1,
  cursor: 7200000,
  source: 3,
  webhook: 900000,
  certificate: 30 * DAY,
};

async function clearIncompleteMonitor(h, scope, logicalKey) {
  const fields = { projectId: scope.projectId, companyId: scope.companyId, environment: "sandbox" };
  const endpoints = await h.rows(
    "webhookEndpoints",
    "by_projectId_and_companyId_and_environment",
    fields,
    21,
  );
  assert.ok(endpoints.length <= 20);
  for (const endpoint of endpoints) {
    assert.equal(endpoint.organizationId, scope.organizationId);
    const deliveries = await h.rows(
      "webhookDeliveries",
      "by_endpointId",
      { endpointId: endpoint._id },
      6,
    );
    assert.ok(deliveries.length <= 5);
    if (deliveries.length)
      await h.remove(
        "webhookDeliveries",
        deliveries.map((d) => d._id),
      );
  }
  if (endpoints.length)
    await h.remove(
      "webhookEndpoints",
      endpoints.map((e) => e._id),
    );
  for (const [table, index, keys, limit] of [
    ["outboxEvents", "by_logicalKey", { logicalKey }, 2],
    [
      "operationalFailures",
      "by_projectId_companyId_environment_source_createdAt",
      fields,
      FAILURES + 1,
    ],
    [
      "operations",
      "by_organizationId_and_projectId_and_environment",
      { organizationId: scope.organizationId, projectId: scope.projectId, environment: "sandbox" },
      103,
    ],
    [
      "projectCompanies",
      "by_projectId_and_companyId",
      { projectId: scope.projectId, companyId: scope.companyId },
      2,
    ],
  ]) {
    const rows = await h.rows(table, index, keys, limit);
    assert.ok(rows.length < limit);
    for (const row of rows) {
      assert.equal(row.organizationId, scope.organizationId);
      assert.equal(row.companyId, scope.companyId);
      if (table === "operations") assert.ok(!row.workId && row.task.name === "proof.import");
    }
    if (rows.length)
      await h.remove(
        table,
        rows.map((r) => r._id),
      );
  }
}

export function assertMonitorSamples(monitors, sampleMode, limits) {
  assert.ok(
    ["baseline", "candidate"].includes(sampleMode),
    "Choose baseline or candidate monitor samples",
  );
  const lease = sampleMode === "baseline" ? 101 : Math.min(101, limits.lease + 1);
  const source = sampleMode === "baseline" ? 101 : Math.min(101, limits.source + 1);
  assert.ok(
    monitors.every(
      (m) =>
        m.metrics.find((x) => x.kind === "lease").value === lease &&
        m.metrics.find((x) => x.kind === "lease").capped,
    ),
  );
  assert.ok(monitors.length > 0);
  assert.ok(
    monitors.every((m) => {
      const sources = m.metrics.find((x) => x.kind === "source").sources;
      return (
        sources.length === OPERATION_SOURCES.length &&
        sources.every((x) => x.count === source && x.capped)
      );
    }),
  );
}

export async function prepareMonitorFixtures(h, state, membership, save) {
  const s = state.scopes[0],
    now = Date.now();
  state.monitors ??= [];
  state.monitorProjects ??= [];
  for (let i = state.monitors.length; i < 20; i++) {
    const project = {
      organizationId: s.organizationId,
      name: `Ensaio monitor ${i}`,
      externalReference: `${state.suffix}-monitor-${i}`,
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: s.ownerMembershipId,
      creatorEpoch: 0,
      createdAt: now,
    };
    const existingProjects = await h.rows(
      "projects",
      "by_organizationId_and_externalReference",
      { organizationId: s.organizationId, externalReference: project.externalReference },
      2,
    );
    assert.ok(existingProjects.length <= 1);
    if (!existingProjects.length) await h.add("projects", [project]);
    const projectId = (
      await h.rows(
        "projects",
        "by_organizationId_and_externalReference",
        { organizationId: s.organizationId, externalReference: project.externalReference },
        1,
      )
    )[0]._id;
    const scope = { ...scopeFields(s), projectId };
    const existingMonitors = await h.rows(
      "operationalMonitors",
      "by_projectId_and_companyId_and_environment",
      { projectId, companyId: s.companyId, environment: "sandbox" },
      2,
    );
    assert.ok(existingMonitors.length <= 1);
    if (existingMonitors.length) {
      // The disabled monitor is the final preparation marker, including after a lost response.
      const existing = existingMonitors[0];
      assert.ok(!existing.enabled && !existing.scheduledId);
      state.monitorProjects[i] = projectId;
      state.monitors[i] = existing._id;
      save(state);
      continue;
    }
    await clearIncompleteMonitor(h, scope, `${state.suffix}-${i}`);
    await h.add(
      "projectCompanies",
      [
        {
          ...scopeFields(s),
          projectId,
          scopes: ["documents:import", "documents:read", "connections:write", "webhooks:manage"],
          environments: ["sandbox"],
          active: true,
          version: 1,
          accessEpoch: 0,
        },
      ].map(({ environment: _environment, ...g }) => g),
    );
    const operation = {
      ...scope,
      sourceMembershipId: s.ownerMembershipId,
      sourceAccessVersion: `manager:${membership.version}`,
      task: {
        name: "proof.import",
        scope: "documents:import",
        workload: "import",
        executor: "testing/operationTransport:execute",
      },
      request: "{}",
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "running",
      stage: "ready",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 6,
      leaseUntil: now - DAY,
      nextAttemptAt: now - 600000,
      backoffMs: 0,
      jitterMs: 0,
      uncertain: true,
      createdAt: now,
      updatedAt: now,
    };
    await h.add("operations", [
      ...Array.from({ length: 101 }, () => operation),
      { ...operation, state: "queued", uncertain: false },
    ]);
    const ops = await h.rows(
      "operations",
      "by_organizationId_and_projectId_and_environment",
      { organizationId: s.organizationId, projectId, environment: "sandbox" },
      102,
    );
    const operationId = ops[0]._id;
    await h.add(
      "operationalFailures",
      OPERATION_SOURCES.flatMap((source) =>
        Array.from({ length: 101 }, () => ({
          ...scope,
          operationId,
          source,
          code: "SYNTHETIC_FAILURE",
          createdAt: now,
          expiresAt: now + 7 * DAY,
        })),
      ),
    );
    await h.add(
      "webhookEndpoints",
      Array.from({ length: 20 }, (_, j) => ({
        ...scope,
        name: `Ensaio ${j}`,
        url: "https://example.invalid",
        events: ["document.received"],
        active: true,
        version: 1,
        secretVersion: 1,
        secret: "synthetic-never-transmitted",
        projectEpoch: 0,
        grantEpoch: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const endpoints = await h.rows(
      "webhookEndpoints",
      "by_projectId_and_companyId_and_environment",
      { projectId, companyId: s.companyId, environment: "sandbox" },
      20,
    );
    await h.add("outboxEvents", [
      {
        organizationId: s.organizationId,
        companyId: s.companyId,
        environment: "sandbox",
        logicalKey: `${state.suffix}-${i}`,
        eventId: randomUUID(),
        type: "document.received",
        resourceType: "document",
        resourceId: "synthetic",
        resourceVersion: 1,
        body: "{}",
        createdAt: now,
      },
    ]);
    const event = (
      await h.rows("outboxEvents", "by_logicalKey", { logicalKey: `${state.suffix}-${i}` }, 1)
    )[0];
    await h.add(
      "webhookDeliveries",
      endpoints.flatMap((e) =>
        ["queued", "running", "retry_wait", "failed", "paused"].map((deliveryState) => ({
          endpointId: e._id,
          eventId: event._id,
          state: deliveryState,
          generation: 1,
          attempts: 1,
          resends: 0,
          cycleAttempts: 1,
          nextAttemptAt: now,
          leaseUntil: now - DAY,
          createdAt: now - 1800000,
        })),
      ),
    );
    await h.add("operationalMonitors", [
      {
        ...scope,
        ownerMembershipId: s.ownerMembershipId,
        enabled: false,
        notify: true,
        thresholds,
        generation: 1,
        metrics: [],
        createdAt: now,
      },
    ]);
    const m = (
      await h.rows(
        "operationalMonitors",
        "by_projectId_and_companyId_and_environment",
        { projectId, companyId: s.companyId, environment: "sandbox" },
        1,
      )
    )[0];
    state.monitorProjects[i] = projectId;
    state.monitors[i] = m._id;
    save(state);
    console.log(`Prepared monitor ${i + 1}/20 with bounded worst-case samples`);
  }
}

/** Exercises deployed monitor/retention code; fixtures never enqueue fiscal or webhook IO. */
export async function monitorDrill(h, state, save, sampleMode) {
  assert.ok(
    ["baseline", "candidate"].includes(sampleMode),
    "Choose baseline or candidate monitor samples",
  );
  const s = state.scopes[0],
    now = Date.now();
  const report = {
    startedAt: new Date(now).toISOString(),
    scenarios: [],
    samples: [],
    result: "running",
    sampleMode,
  };
  let logCursor = (await h.logs(0)).cursor;
  report.runtime = [];
  async function collectLogs() {
    const logs = await h.logs(logCursor);
    logCursor = logs.cursor;
    report.runtime.push(
      ...logs.entries.filter(
        (e) =>
          e.identifier === "observability:evaluate" || e.identifier === "telemetryRetention:sweep",
      ),
    );
  }
  state.monitors ??= [];
  state.monitorProjects ??= [];
  if (!state.actor) {
    const user = await h.component("adapter:create", {
      input: {
        model: "user",
        data: {
          name: "Ensaio operacional",
          email: `${state.suffix}@validation.invalid`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    const session = await h.component("adapter:create", {
      input: {
        model: "session",
        data: {
          userId: user._id,
          token: randomUUID(),
          expiresAt: now + DAY,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    state.actor = { subject: user._id, sessionId: session._id };
    save(state);
    await h.patch("memberships", [s.ownerMembershipId], { authUserId: user._id });
  }
  const user = (kind, path, args) => h.asUser(state.actor, kind, path, args);
  const membership = await h.query(
    `return await ctx.db.get(${JSON.stringify(s.ownerMembershipId)});`,
  );
  const overview = () =>
    user("query", "observability:overview", {
      organizationId: s.organizationId,
      contextKey: state.suffix,
    });
  async function pauseAll() {
    const monitors = await h.rows(
      "operationalMonitors",
      "by_organizationId",
      { organizationId: s.organizationId },
      20,
    );
    // Fence every chain; its next execution becomes a no-op. Only this run's organization.
    for (const m of monitors) {
      await h.patch("operationalMonitors", [m._id], {
        enabled: false,
        generation: m.generation + 1,
      });
    }
    return monitors.length;
  }
  try {
    await prepareMonitorFixtures(h, state, membership, save);
    if (!state.syntheticCertificate) {
      await h.add("certificates", [
        {
          organizationId: s.organizationId,
          companyId: s.companyId,
          version: 1,
          state: "active",
          uploaderId: state.actor.subject,
          membershipId: s.ownerMembershipId,
          membershipVersion: 1,
          envelopeRevision: 1,
          metadata: {
            fingerprint: "synthetic-no-pfx",
            subject: "Ensaio",
            cnpj: "00000000000191",
            notBefore: now - DAY,
            notAfter: now + DAY,
          },
          createdAt: now,
          updatedAt: now,
        },
      ]);
      state.syntheticCertificate = (
        await h.rows("certificates", "by_companyId", { companyId: s.companyId }, 1)
      )[0]._id;
      await h.add("certificateHeads", [
        {
          organizationId: s.organizationId,
          companyId: s.companyId,
          nextVersion: 2,
          activeId: state.syntheticCertificate,
        },
      ]);
      await h.add("captureStreams", [
        {
          ...scopeFields(s),
          projectId: state.monitorProjects[0],
          identity: state.suffix,
          service: "nfe-distribution",
          state: "active",
          version: 1,
          checkpoint: "000000000000005",
          mode: "distNSU",
          nextAllowedAt: now + DAY,
          received: 0,
          createdAt: now - 3 * 3600000,
        },
      ]);
      state.syntheticStream = (
        await h.rows(
          "captureStreams",
          "by_companyId_environment",
          { companyId: s.companyId, environment: "sandbox" },
          1,
        )
      )[0]._id;
      save(state);
    }
    // Enabling through the public function verifies access, scopes and scheduling.
    // A failed rehearsal can have paused its two control fixtures already.
    for (const projectId of state.monitorProjects) {
      const ops = await h.rows(
        "operations",
        "by_organizationId_and_projectId_and_environment",
        { organizationId: s.organizationId, projectId, environment: "sandbox" },
        102,
      );
      for (const uncertain of [true, false]) {
        const ids = ops.filter((op) => op.uncertain === uncertain).map((op) => op._id);
        if (ids.length)
          await h.patch("operations", ids, {
            state: uncertain ? "running" : "queued",
            sourceAccessVersion: `manager:${membership.version}`,
          });
      }
    }
    for (let i = 0; i < state.monitors.length; i++) {
      if (i === 10) await delay(61000);
      const m = await h.query(`return await ctx.db.get(${JSON.stringify(state.monitors[i])});`);
      await user("mutation", "observability:configure", {
        ...scopeFields(m),
        ownerMembershipId: s.ownerMembershipId,
        enabled: true,
        notify: true,
        thresholds,
        expectedGeneration: m.generation,
      });
      await collectLogs();
    }
    report.capacityWindow = { startedAt: new Date().toISOString() };
    await delay(65000);
    const first = await overview();
    report.capacityWindow.finishedAt = new Date().toISOString();
    report.capacityWindow.checkedAgesMs = first.monitors.map((m) => Date.now() - m.checkedAt);
    report.capacityWindow.maxAgeTargetMs = 90000;
    assert.equal(first.monitors.length, 20);
    assert.ok(first.monitors.every((m) => m.checkedAt && m.metrics.length === 6));
    assert.ok(
      first.monitors.every((m) => m.checkedAt >= Date.parse(report.capacityWindow.startedAt)),
      "Every monitor must evaluate during the full-capacity window",
    );
    assert.ok(
      report.capacityWindow.checkedAgesMs.every((age) => age >= 0 && age <= 90000),
      "Monitor evaluation is more than 90 seconds old",
    );
    assert.equal(first.alerts.length, 101);
    assertMonitorSamples(first.monitors, sampleMode, thresholds);
    report.scenarios.push({
      name: `20-monitors-20-endpoints-101-leases-${FAILURES}-failures`,
      passed: true,
      openAlerts: first.alerts.length,
    });
    const counts = await h.rows(
      "operationalNotifications",
      "by_organizationId",
      { organizationId: s.organizationId },
      1000,
    );
    assert.equal(counts.length, 101);
    await collectLogs();
    report.scenarios.push({
      name: "scheduler-repeats-without-notification-storm",
      passed: true,
      notifications: counts.length,
      generations: first.monitors.map((m) => m.generation),
    });
    // The twenty-first scope must be refused even with an authorized owner.
    await assert.rejects(
      user("mutation", "observability:configure", {
        ...scopeFields(s),
        ownerMembershipId: s.ownerMembershipId,
        enabled: true,
        notify: true,
        thresholds,
        expectedGeneration: 0,
      }),
      /RATE_LIMITED/,
    );
    report.scenarios.push({ name: "monitor-cap-refuses-21st", passed: true });
    const m = first.monitors[0];
    await assert.rejects(
      h.rpc("mutation", "observability:configure", {
        ...scopeFields(m),
        ownerMembershipId: s.ownerMembershipId,
        enabled: false,
        notify: true,
        thresholds,
        expectedGeneration: m.generation,
      }),
    );
    await assert.rejects(
      user("query", "observability:overview", {
        organizationId: state.scopes[1].organizationId,
        contextKey: state.suffix,
      }),
      /ACCESS_DENIED/,
    );
    report.scenarios.push({ name: "unauthenticated-and-other-organization-denied", passed: true });
    const ops = await h.rows(
      "operations",
      "by_organizationId_and_projectId_and_environment",
      { organizationId: s.organizationId, projectId: m.projectId, environment: "sandbox" },
      102,
    );
    const queued = ops.find((o) => o.state === "queued"),
      running = ops.find((o) => o.state === "running");
    for (const op of [queued, running])
      await user("mutation", "operations:control", {
        operationId: op._id,
        action: "pause",
        expectedGeneration: op.generation,
      });
    const paused = await h.query(`return await ctx.db.get(${JSON.stringify(running._id)});`);
    assert.equal(paused.state, "paused");
    assert.equal(paused.uncertain, true);
    await assert.rejects(
      user("mutation", "operations:control", {
        operationId: paused._id,
        action: "retry",
        expectedGeneration: paused.generation,
      }),
      /RECONCILIATION_REQUIRED/,
    );
    const audit = await user("query", "observability:investigate", {
      organizationId: s.organizationId,
      reference: paused._id,
      contextKey: state.suffix,
    });
    assert.ok(audit.length > 0);
    report.scenarios.push({
      name: "runbook-pause-investigate-uncertain-retry-refused",
      passed: true,
    });
    const cursorBefore = await h.query(
      `return await ctx.db.get(${JSON.stringify(state.syntheticStream)});`,
    );
    const cursorPaused = await user("mutation", "captures:control", {
      ...scopeFields(cursorBefore),
      action: "pause",
      expectedVersion: cursorBefore.version,
    });
    assert.equal(cursorPaused.state, "paused");
    assert.equal(cursorPaused.checkpoint, cursorBefore.checkpoint);
    assert.equal(cursorPaused.nextAllowedAt, cursorBefore.nextAllowedAt);
    await assert.rejects(
      user("mutation", "captures:control", {
        ...scopeFields(cursorBefore),
        action: "resume",
        expectedVersion: cursorPaused.version,
      }),
      /CERTIFICATE_UNAVAILABLE/,
    );
    report.scenarios.push({
      name: "runbook-cursor-pause-preserves-checkpoint-and-refuses-metadata-only-certificate",
      passed: true,
    });

    const endpoint = (
      await h.rows(
        "webhookEndpoints",
        "by_projectId_and_companyId_and_environment",
        { projectId: m.projectId, companyId: s.companyId, environment: "sandbox" },
        1,
      )
    )[0];
    const delivery = (
      await h.rows("webhookDeliveries", "by_endpointId", { endpointId: endpoint._id }, 5)
    ).find((d) => d.state === "failed");
    assert.ok(delivery);
    const retryArgs = {
      deliveryId: delivery._id,
      expectedGeneration: delivery.generation,
      key: randomUUID(),
    };
    await user("mutation", "webhooks:retry", retryArgs);
    let retried;
    for (let attempt = 0; attempt < 30; attempt++) {
      retried = await h.query(`return await ctx.db.get(${JSON.stringify(delivery._id)});`);
      if (retried.state === "paused") break;
      await delay(1000);
    }
    assert.equal(retried.code, "DELIVERY_DISABLED");
    assert.equal(retried.attempts, delivery.attempts);
    assert.equal(retried.eventId, delivery.eventId);
    await user("mutation", "webhooks:retry", retryArgs);
    const duplicate = await h.query(`return await ctx.db.get(${JSON.stringify(delivery._id)});`);
    assert.equal(duplicate.generation, delivery.generation + 1);
    assert.equal(duplicate.resends, 1);
    assert.equal(duplicate.state, "paused");
    report.scenarios.push({
      name: "runbook-webhook-retry-idempotent-and-transport-disabled",
      passed: true,
    });
    // Downstream recovery is simulated. No callback or fiscal source is contacted.
    for (const projectId of state.monitorProjects) {
      const pending = await h.rows(
        "operations",
        "by_organizationId_and_projectId_and_environment",
        { organizationId: s.organizationId, projectId, environment: "sandbox" },
        102,
      );
      await h.patch(
        "operations",
        pending.map((o) => o._id),
        { state: "paused" },
      );
      const failures = await h.rows(
        "operationalFailures",
        "by_projectId_companyId_environment_source_createdAt",
        { projectId, companyId: s.companyId, environment: "sandbox" },
        FAILURES,
      );
      await h.patch(
        "operationalFailures",
        failures.map((f) => f._id),
        { createdAt: now - 2 * 3600000 },
      );
      const endpoints = await h.rows(
        "webhookEndpoints",
        "by_projectId_and_companyId_and_environment",
        { projectId, companyId: s.companyId, environment: "sandbox" },
        20,
      );
      const ids = await h.query(
        `return (await Promise.all(${JSON.stringify(endpoints.map((e) => e._id))}.map(id=>ctx.db.query("webhookDeliveries").withIndex("by_endpointId",q=>q.eq("endpointId",id)).take(5)))).flat().map(d=>d._id);`,
      );
      await h.patch("webhookDeliveries", ids, { state: "delivered" });
      await collectLogs();
    }
    const cert = await h.query(
      `return await ctx.db.get(${JSON.stringify(state.syntheticCertificate)});`,
    );
    await h.patch("certificates", [cert._id], {
      metadata: { ...cert.metadata, notAfter: Date.now() + 90 * DAY },
    });
    const stream = await h.query(
      `return await ctx.db.get(${JSON.stringify(state.syntheticStream)});`,
    );
    await h.patch("captureStreams", [stream._id], { lastSuccessAt: Date.now() });
    await delay(65000);
    const recovered = await overview();
    assert.equal(recovered.alerts.length, 0);
    report.scenarios.push({
      name: "six-signals-recover-after-controlled-source-repair",
      passed: true,
    });
    report.samples = recovered.monitors.map((m) => ({
      generation: m.generation,
      checkedAt: m.checkedAt,
      metrics: m.metrics.map(({ kind, value, capped }) => ({ kind, value, capped })),
    }));
    const afterStream = await h.query(`return await ctx.db.get(${JSON.stringify(stream._id)});`);
    assert.equal(afterStream.checkpoint, stream.checkpoint);
    assert.equal(afterStream.nextAllowedAt, stream.nextAllowedAt);
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = error.message;
  } finally {
    report.pausedMonitors = await pauseAll();
    await collectLogs();
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
