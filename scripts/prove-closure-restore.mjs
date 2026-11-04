// D05: purge after restoring into an empty deployment. Synthetic data and local worktrees only.
// Usage: `bun scripts/prove-closure-restore.mjs prepare`, then
// `bun scripts/prove-closure-restore.mjs restore <absolute path of the fresh platform worktree>`.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convexToJson, jsonToConvex } from "convex/values";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { processNfe } from "../packages/fiscal-nfe/dist/index.js";
import { repoRoot } from "./lib/repo-root.mjs";

const root = repoRoot;
const output = join(root, ".ci-results/d05");
mkdirSync(output, { recursive: true });
const DAY = 86_400_000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// Classes removed by the purge and classes it must keep, as decided on 07/10 (RETENTION.md).
const EXCLUDED = [
  "organizations",
  "memberships",
  "invitations",
  "termsOfUseNotices",
  "organizationAudit",
  "onboarding",
  "companies",
  "companyGrants",
  "companyAudit",
  "registryApplications",
  "projects",
  "projectCompanies",
  "apiKeys",
  "integrationAudit",
  "certificates",
  "certificateHeads",
  "webhookEndpoints",
  "outboxEvents",
  "documentExports",
  "documentDownloads",
  "operationalAudit",
  "operationalMonitors",
  "operationalAlerts",
  "operationalNotifications",
  "operationalFailures",
  "usageLeases",
];
const CHILDREN = ["exportParts", "exportTickets", "webhookDeliveries", "webhookAttempts"];
const CONSERVED = [
  "fiscalDocuments",
  "documentArtifacts",
  "imports",
  "operations",
  "certificateAudit",
  "usageEvents",
  "usageTotals",
];
// Rows changed by the retention jobs themselves; compared through their expected effect.
const RETENTION = ["operationalAudit", "apiUsageEvents", "apiUsageTotals", "operationalRetention"];

function target(directory) {
  const paths = worktreePaths(directory),
    config = readLocalConfig(paths);
  assert.equal(paths.app, "platform");
  assert.ok(config);
  const urls = localUrls(config);
  assert.match(urls.cloud, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { paths, config, urls };
}
const source = target(root);
async function call(target, kind, path, args) {
  const response = await fetch(`${target.urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${target.config.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, args: convexToJson(args), format: "convex_encoded_json" }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return jsonToConvex(result.value);
}
async function safe(target) {
  const health = await (await fetch(`${target.urls.site}/health`)).json();
  assert.equal(health.appEnv, "development");
  assert.equal(health.fiscalEnv, "disabled");
  assert.deepEqual(await call(target, "query", "_system/frontend/listCronJobs", {}), []);
}
function cli(target, args, name) {
  console.log(`target: local-anonymous ${target.urls.cloud}; ${name}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CONVEX_") && !key.startsWith("VITE_"),
    ),
  );
  const run = spawnSync(
    process.execPath,
    [
      target.paths.convexCli,
      ...args,
      "--url",
      target.urls.cloud,
      "--admin-key",
      target.config.adminKey,
    ],
    {
      cwd: target.paths.backendRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (run.status !== 0)
    throw new Error(
      `${name} failed: ${String(run.stderr).replaceAll(target.config.adminKey, "[redacted]")}`,
    );
  return { exitCode: run.status, logSha256: sha(`${run.stdout}\n${run.stderr}`) };
}
async function api(secret, path, method = "GET", body) {
  const response = await fetch(`${source.urls.site}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${result.error?.code ?? response.status}`);
  return result.data;
}
async function importXml(scope, secret, name) {
  const bytes = readFileSync(join(root, `tests/fixtures/nfe/4.00/${name}.xml`));
  const batch = await api(secret, "/v1/imports", "POST", {
    companyId: scope.companyId,
    files: [{ name: `${name}.xml`, size: bytes.length, sha256: sha(bytes) }],
  });
  const path = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const upload = await api(secret, `${path}/upload`, "POST");
  const response = await fetch(`${source.urls.site}/v1/import-upload`, {
    method: "POST",
    headers: { "X-Upload-Token": upload.token },
    body: bytes,
  });
  assert.equal(response.status, 200);
  await api(secret, `${path}/confirm`, "POST");
  for (let i = 0; i < 120; i++) {
    const file = (await api(secret, `/v1/imports/${batch.importId}`)).files[0];
    if (file.state === "succeeded" || file.documentId) return file.documentId;
    await delay(500);
  }
  throw new Error("Synthetic import did not complete");
}
async function organization(suffix, cnpj) {
  const secret = `fnfe_${randomBytes(32).toString("base64url")}`;
  const scope =
    /** @type {{organizationId: string, companyId: string, projectId: string, keyId: string}} */ (
      await call(source, "mutation", "testing/operationProof:prepare", {
        keyHash: sha(secret),
        suffix,
      })
    );
  await call(source, "mutation", "testing/closureProof:configure", { ...scope, cnpj });
  return { scope, secret };
}
/** @returns {Promise<any>} Rows by table, table totals and stored files. */
async function inventory(target, ids) {
  return jsonToConvex(
    JSON.parse(
      await call(target, "query", "testing/closureProof:inventory", { organizationIds: ids }),
    ),
  );
}
async function decisions(target) {
  const page = await call(target, "query", "organizationClosure:decisions", {
    paginationOpts: { numItems: 100, cursor: null },
  });
  assert.equal(page.isDone, true);
  return page.page;
}
async function missingJobs(target) {
  let missing = 0,
    next = { phase: 0, cursor: null };
  const phases = {};
  while (next) {
    const page = await call(target, "query", "retentionRecovery:inspect", next);
    phases[page.phase] = (phases[page.phase] ?? 0) + page.missing;
    missing += page.missing;
    next = page.next;
  }
  return { missing, phases };
}
async function until(name, check, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out: ${name}`);
}
const rowsOf = (inv, table, organizationId) =>
  (inv.rows[table] ?? []).filter(
    (row) => row.organizationId === organizationId || row._id === organizationId,
  );
// Child rows carry no organizationId; only the closed organization has any in this dataset.
const childrenOf = (inv, table) => inv.rows[table] ?? [];
const stable = (rows) => sha(JSON.stringify(convexToJson(rows)));

const mode = process.argv[2];
const receipt = {
  codeSha: git(root, "rev-parse", "HEAD"),
  dirty: git(root, "status", "--porcelain") !== "",
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  recordedAt: new Date().toISOString(),
  source: source.urls,
  syntheticOnly: true,
  result: "running",
};
try {
  assert.equal(receipt.dirty, false, "D05 proof requires a clean checkout before any writes");
  await safe(source);
  if (mode === "prepare") {
    const invoice = readFileSync(join(root, "tests/fixtures/nfe/4.00/invoice-authorized.xml"));
    const cnpj = processNfe(invoice).normalized.document.issuer.document;
    const closed = await organization(`closure05-${randomUUID()}`, cnpj);
    const kept = await organization(`closure05-${randomUUID()}`, cnpj);
    const documents = [
      await importXml(closed.scope, closed.secret, "invoice-authorized"),
      await importXml(closed.scope, closed.secret, "event-110111"),
      await importXml(kept.scope, kept.secret, "invoice-authorized"),
    ];
    // An export of the organization to close; its files are an excluded class.
    const job = await api(closed.secret, "/v1/exports", "POST", {
      companyId: closed.scope.companyId,
      documentId: documents[0],
    });
    await until("export", async () => {
      const state = (await api(closed.secret, `/v1/exports/${job.id}`)).state;
      assert.ok(["running", "succeeded"].includes(state), state);
      return state === "succeeded";
    });
    // Deadlines that pass between the snapshot and the restore.
    const shortUntil = Date.now() + 90_000;
    await call(source, "mutation", "testing/closureProof:seed", {
      ...closed.scope,
      shortUntil,
      excluded: true,
    });
    await call(source, "mutation", "testing/closureProof:seed", {
      ...kept.scope,
      shortUntil,
      excluded: false,
    });
    const ids = [closed.scope.organizationId, kept.scope.organizationId];
    // Imports finish their projection in the background; wait until the rows settle.
    let before = await inventory(source, ids);
    for (let i = 0; ; i++) {
      await delay(2000);
      const next = await inventory(source, ids);
      if (stable(next) === stable(before)) break;
      assert.ok(i < 60, "Synthetic dataset did not settle");
      before = next;
    }
    const snapshotDirectory = mkdtempSync(join(tmpdir(), "fnfe-d05-snapshot-")),
      custodyDirectory = mkdtempSync(join(tmpdir(), "fnfe-d05-register-"));
    const snapshot = join(snapshotDirectory, "snapshot.zip");
    const snapshotStarted = Date.now();
    const exported = cli(
      source,
      ["export", "--include-file-storage", "--path", snapshot],
      "export synthetic snapshot with storage",
    );
    // Nothing changed while the snapshot was written, so `before` describes it exactly.
    assert.equal(
      stable(await inventory(source, ids)),
      stable(before),
      "Data changed during export",
    );
    // The closure is decided after the snapshot, with its window already over.
    await call(source, "mutation", "testing/closureProof:closeNow", {
      organizationId: closed.scope.organizationId,
      requestedAt: Date.now() - 31 * DAY,
    });
    const purged = await until("source purge", async () =>
      (await decisions(source)).find(
        (d) => d.organizationId === closed.scope.organizationId && d.state === "purged",
      ),
    );
    // The off-database register: ids and dates only.
    const register = join(custodyDirectory, "decisions.json");
    writeFileSync(register, JSON.stringify([purged]), { mode: 0o600 });
    const state = {
      codeSha: receipt.codeSha,
      snapshot,
      snapshotDirectory,
      snapshotSha256: sha(readFileSync(snapshot)),
      register,
      custodyDirectory,
      registerSha256: sha(readFileSync(register)),
      closed: closed.scope,
      kept: kept.scope,
      before: JSON.stringify(convexToJson(before)),
      shortUntil,
      snapshotStarted,
    };
    writeFileSync(join(output, "private.json"), JSON.stringify(state), { mode: 0o600 });
    Object.assign(receipt, {
      snapshotStarted,
      snapshotSha256: state.snapshotSha256,
      registerSha256: state.registerSha256,
      exported,
      sourcePurge: { removed: purged.removed, onTime: purged.purgedAt <= purged.purgeBy },
      dataset: {
        excludedRows: EXCLUDED.reduce(
          (n, t) => n + rowsOf(before, t, closed.scope.organizationId).length,
          0,
        ),
        documents: before.rows.fiscalDocuments.length,
        files: before.storage.length,
      },
      result: "passed",
    });
  } else if (mode === "restore") {
    const state = JSON.parse(readFileSync(join(output, "private.json"), "utf8"));
    assert.equal(state.codeSha, receipt.codeSha, "Restore requires the snapshot code revision");
    assert.equal(sha(readFileSync(state.snapshot)), state.snapshotSha256, "Snapshot differs");
    assert.equal(sha(readFileSync(state.register)), state.registerSha256, "Register differs");
    const destination = target(resolve(process.argv[3]));
    assert.equal(git(destination.paths.root, "rev-parse", "HEAD"), receipt.codeSha);
    assert.equal(git(destination.paths.root, "status", "--porcelain"), "");
    assert.notEqual(destination.paths.root, source.paths.root);
    assert.notEqual(destination.urls.cloud, source.urls.cloud);
    await safe(destination);
    await call(destination, "query", "testing/restoreProof:assertEmpty", {});
    const before = jsonToConvex(JSON.parse(state.before));
    const C = state.closed.organizationId,
      K = state.kept.organizationId,
      ids = [C, K];
    const started = Date.now();
    const imported = cli(
      destination,
      ["import", state.snapshot, "--replace", "--yes"],
      "restore into disposable local deployment",
    );
    const restored = await inventory(destination, ids);
    assert.equal(stable(restored), stable(before), "Restored rows or files differ from snapshot");
    // The decision made after the snapshot is absent from the restored data.
    assert.ok(!(await decisions(destination)).some((d) => d.organizationId === C));
    await until("short deadlines", async () => Date.now() > state.shortUntil + 1000, 400);
    const lost = await missingJobs(destination);
    assert.ok(lost.missing >= 3, `Expected lost jobs, found ${JSON.stringify(lost)}`);

    await call(destination, "mutation", "retentionRecovery:recover", { phase: 0, cursor: null });
    await until("recovered schedules", async () => (await missingJobs(destination)).missing === 0);
    const reapplied = [];
    for (const decision of JSON.parse(readFileSync(state.register, "utf8")))
      reapplied.push(
        await call(destination, "mutation", "organizationClosure:reapply", {
          organizationId: decision.organizationId,
          requestedAt: decision.requestedAt,
        }),
      );
    assert.deepEqual(reapplied, ["closing"]);
    const purge = await until("destination purge", async () =>
      (await decisions(destination)).find((d) => d.organizationId === C && d.state === "purged"),
    );
    const after = await until("expired retention rows", async () => {
      const inv = await inventory(destination, ids);
      const expired =
        (inv.rows.operationalAudit ?? []).some((row) => row.action === "proof.expired") ||
        (inv.rows.apiUsageEvents ?? []).some((row) => row.createdAt < started - 30 * DAY) ||
        inv.totals.accessRecords !== before.totals.accessRecords - 2;
      return expired ? null : inv;
    });

    // Eligible classes of the closed organization are gone, in tables and files.
    const remaining = Object.fromEntries(
      EXCLUDED.map((table) => [table, rowsOf(after, table, C).length]),
    );
    for (const table of CHILDREN) {
      if (table !== "exportTickets")
        assert.ok(childrenOf(before, table).length > 0, `The dataset needs ${table}`);
      remaining[table] = childrenOf(after, table).length;
    }
    assert.ok(
      Object.values(remaining).every((n) => n === 0),
      JSON.stringify(remaining),
    );
    const files = new Set(after.storage.map((file) => file.id));
    const exportFiles = childrenOf(before, "exportParts").map((part) => part.storageId);
    assert.ok(exportFiles.length > 0, "The dataset needs export files");
    for (const part of exportFiles) assert.ok(!files.has(part), "Export file survived the purge");
    // Conserved classes keep their exact rows and files.
    for (const table of CONSERVED)
      assert.equal(stable(rowsOf(after, table, C)), stable(rowsOf(before, table, C)), table);
    for (const artifact of rowsOf(before, "documentArtifacts", C))
      assert.ok(files.has(artifact.storageId), "Conserved original missing");
    const totals = (inv, org) =>
      rowsOf(inv, "apiUsageTotals", org).reduce((n, row) => n + row.count, 0) +
      rowsOf(inv, "apiUsageEvents", org).length;
    // REST receipts were compacted without losing a count, for both organizations.
    for (const org of ids) {
      assert.equal(totals(after, org), totals(before, org));
      assert.equal(rowsOf(after, "apiUsageEvents", org).length, 1);
    }
    // The other organization is untouched beyond its own expired rows.
    for (const table of Object.keys(before.rows))
      if (!RETENTION.includes(table))
        assert.equal(stable(rowsOf(after, table, K)), stable(rowsOf(before, table, K)), table);
    assert.deepEqual(
      rowsOf(after, "operationalAudit", K).map((row) => row.action),
      rowsOf(before, "operationalAudit", K)
        .map((row) => row.action)
        .filter((action) => action !== "proof.expired"),
    );

    // Repeating the recovery and the decision changes nothing.
    await call(destination, "mutation", "retentionRecovery:recover", { phase: 0, cursor: null });
    const again = await call(destination, "mutation", "organizationClosure:reapply", {
      organizationId: C,
      requestedAt: purge.requestedAt,
    });
    assert.equal(again, "purged");
    await delay(5000);
    const repeated = await inventory(destination, ids);
    assert.equal(
      stable({ ...repeated, rows: { ...repeated.rows, operationalRetention: [] } }),
      stable({ ...after, rows: { ...after.rows, operationalRetention: [] } }),
    );
    assert.equal((await missingJobs(destination)).missing, 0);
    const completed = Date.now();
    await safe(destination);
    Object.assign(receipt, {
      destination: destination.urls,
      imported,
      emptyTargetConfirmed: { applicationTables: true, storage: true, authentication: true },
      snapshotSha256: state.snapshotSha256,
      restoredSha256: stable(restored),
      lostSchedules: lost,
      recoveredSchedules: { missing: 0 },
      purge: {
        reapplied,
        removed: purge.removed,
        requestedAt: purge.requestedAt,
        exportUntil: purge.exportUntil,
        purgedAt: purge.purgedAt,
        onTimeAfterRecovery: purge.purgedAt <= completed,
        excludedRemaining: remaining,
        exportFilesRemoved: exportFiles.length,
        conservedTables: CONSERVED,
      },
      retention: {
        expiredTelemetryRemoved: true,
        restReceiptsCompacted: true,
        expiredAccessRecordsRemoved: 2,
      },
      repeatedProcessingUnchanged: true,
      finalSha256: stable(after),
      durationMs: completed - started,
      result: "passed",
    });
    // Separate, known temporary directories; no recursive deletion.
    unlinkSync(state.snapshot);
    rmdirSync(state.snapshotDirectory);
    unlinkSync(state.register);
    rmdirSync(state.custodyDirectory);
    receipt.restrictedTemporaryCopiesRemoved = true;
  } else throw new Error("Use prepare or restore <fresh-platform-worktree>");
} catch (error) {
  receipt.result = "failed";
  receipt.error = error.message;
  process.exitCode = 1;
}
writeFileSync(join(output, `${mode}.json`), JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ mode, result: receipt.result, error: receipt.error }));
