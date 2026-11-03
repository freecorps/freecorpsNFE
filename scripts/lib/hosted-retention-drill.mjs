import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { hash, scopeFields } from "./hosted-fixtures.mjs";

export async function retentionDrill(h, state) {
  const s = state.scopes[0],
    now = Date.now(),
    expired = now - 1000,
    future = now + 366 * 86400000;
  const before = await h.query(`return await ctx.db.get(${JSON.stringify(s.source.doc._id)});`);
  const monitor = (
    await h.rows(
      "operationalMonitors",
      "by_organizationId",
      { organizationId: s.organizationId },
      1,
    )
  )[0];
  const alert = (
    await h.rows("operationalAlerts", "by_monitorId_and_kind", { monitorId: monitor._id }, 1)
  )[0];
  assert.ok(alert);
  const templates = {
    operationalAudit: {
      organizationId: s.organizationId,
      actor: state.suffix,
      action: "http.retention-drill",
      target: state.suffix,
      createdAt: now,
    },
    operationalNotifications: {
      organizationId: s.organizationId,
      monitorId: monitor._id,
      alertId: alert._id,
      transition: "open",
      createdAt: now,
    },
    operationalFailures: {
      ...scopeFields(s),
      operationId: s.source.version.operationId,
      source: "other",
      code: "RETENTION_DRILL",
      createdAt: now,
    },
  };
  for (const [table, template] of Object.entries(templates))
    await h.add(table, [
      ...Array.from({ length: 60 }, () => ({ ...template, expiresAt: expired })),
      { ...template, expiresAt: future },
    ]);
  const job = (
    await h.rows(
      "operationalRetention",
      "by_organizationId",
      { organizationId: s.organizationId },
      1,
    )
  )[0];
  assert.ok(job);
  await h.patch("operationalRetention", [job._id], { nextAt: Date.now() - 1 });
  const firstBatch = await h.rpc("mutation", "telemetryRetention:sweep", {
    organizationId: s.organizationId,
    generation: job.generation,
  });
  assert.equal(firstBatch, 150);
  let remaining = 180;
  for (let i = 0; i < 30 && remaining; i++) {
    remaining = 0;
    for (const table of Object.keys(templates))
      remaining += (
        await h.rows(
          table,
          "by_organizationId_and_expiresAt",
          { organizationId: s.organizationId, expiresAt: expired },
          100,
        )
      ).length;
    if (remaining) await delay(1000);
  }
  assert.equal(remaining, 0);
  for (const table of Object.keys(templates))
    assert.equal(
      (
        await h.rows(
          table,
          "by_organizationId_and_expiresAt",
          { organizationId: s.organizationId, expiresAt: future },
          10,
        )
      ).length,
      1,
    );
  const current = (
    await h.rows(
      "operationalRetention",
      "by_organizationId",
      { organizationId: s.organizationId },
      1,
    )
  )[0];
  const early = await h.rpc("mutation", "telemetryRetention:sweep", {
    organizationId: s.organizationId,
    generation: current.generation,
  });
  assert.equal(early, 0);
  const apiReceipts = await apiRetentionDrill(h, state);
  const after = await h.query(`return await ctx.db.get(${JSON.stringify(s.source.doc._id)});`);
  assert.deepEqual(after, before);
  return {
    recordedAt: new Date().toISOString(),
    result: "passed",
    expiredPerClass: 60,
    firstBatch,
    remainingExpired: remaining,
    futurePreservedPerClass: 1,
    earlySweepRemoved: early,
    documentUnchangedSha256: hash(JSON.stringify(after)),
    apiReceipts,
    scope:
      "HTTP audit, notifications, failure samples and REST receipt compaction; original fiscal metadata preserved; runtime/provider retention and legal review excluded",
  };
}

/** Exercise the REST receipt compaction added after the first hosted rehearsal. */
async function apiRetentionDrill(h, state) {
  const s = state.scopes[0];
  const now = Date.now();
  const expiredAt = now - 40 * 86400000;
  const expiredDay = new Date(expiredAt).toISOString().slice(0, 10);
  const currentDay = new Date(now).toISOString().slice(0, 10);
  const receiptFields = { organizationId: s.organizationId };
  const readEvents = (day) =>
    h.rows("apiUsageEvents", "by_organizationId_and_day_and_shard", { ...receiptFields, day }, 100);
  const readTotals = () =>
    h.rows(
      "apiUsageTotals",
      "by_organizationId_and_projectId_and_environment_and_route",
      { ...receiptFields, projectId: s.projectId, environment: "sandbox" },
      3,
    );
  const before = await readTotals();
  assert.equal((await readEvents(expiredDay)).length, 0);
  const beforeCurrent = (await readEvents(currentDay)).length;
  const template = {
    ...receiptFields,
    projectId: s.projectId,
    keyId: s.keyId,
    environment: "sandbox",
    route: "companies.list",
    shard: 0,
  };
  await h.add("apiUsageEvents", [
    ...Array.from({ length: 60 }, (_, i) => ({
      ...template,
      route: i % 2 ? "companies.get" : "companies.list",
      requestId: `${state.suffix}-retention-${now}-${i}`,
      day: expiredDay,
      createdAt: expiredAt + i,
    })),
    {
      ...template,
      requestId: `${state.suffix}-retention-${now}-current`,
      day: currentDay,
      createdAt: now,
    },
  ]);
  const job = (await h.rows("operationalRetention", "by_organizationId", receiptFields, 1))[0];
  assert.ok(job);
  await h.patch("operationalRetention", [job._id], { nextAt: Date.now() - 1 });
  const args = { ...receiptFields, generation: job.generation };
  const firstBatch = await h.rpc("mutation", "telemetryRetention:sweep", args);
  assert.equal(firstBatch, 50);
  const duplicateRemoved = await h.rpc("mutation", "telemetryRetention:sweep", args);
  assert.equal(duplicateRemoved, 0);
  let remaining = 60;
  for (let i = 0; i < 30 && remaining; i++) {
    remaining = (await readEvents(expiredDay)).length;
    if (remaining) await delay(1000);
  }
  assert.equal(remaining, 0);
  assert.equal((await readEvents(currentDay)).length, beforeCurrent + 1);
  const after = await readTotals();
  for (const route of ["companies.list", "companies.get"]) {
    const total = after.find((row) => row.route === route);
    assert.ok(total);
    assert.equal(total.count - (before.find((row) => row.route === route)?.count ?? 0), 30);
  }
  const current = (await h.rows("operationalRetention", "by_organizationId", receiptFields, 1))[0];
  const earlyRemoved = await h.rpc("mutation", "telemetryRetention:sweep", {
    ...receiptFields,
    generation: current.generation,
  });
  assert.equal(earlyRemoved, 0);
  assert.deepEqual(await readTotals(), after);
  return {
    expiredReceipts: 60,
    firstBatch,
    remainingExpired: remaining,
    compactedPerRoute: 30,
    currentPreserved: 1,
    duplicateRemoved,
    earlyRemoved,
    totalConserved: true,
    result: "passed",
  };
}
