import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { convexToJson, jsonToConvex } from "convex/values";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../lib/worktree/deployment.mjs";
import { processNfe } from "../../packages/fiscal-nfe/dist/index.js";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";

const root = repoRoot;
const paths = worktreePaths(root),
  config = readLocalConfig(paths);
assert.equal(paths.app, "platform");
assert.ok(config);
const urls = localUrls(config);
assert.match(urls.cloud, /^http:\/\/127\.0\.0\.1:\d+$/);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(kind, path, args) {
  const response = await fetch(`${urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args: convexToJson(args), format: "convex_encoded_json" }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return jsonToConvex(result.value);
}
const health = await (await fetch(`${urls.site}/health`)).json();
assert.equal(health.appEnv, "development");
assert.equal(health.fiscalEnv, "disabled");
assert.deepEqual(await call("query", "_system/frontend/listCronJobs", {}), []);
console.log(`target: local-anonymous (${urls.cloud}); synthetic export benchmark`);
const secret = `fnfe_${randomBytes(32).toString("base64url")}`;
const scope = await call("mutation", "testing/operationProof:prepare", {
  keyHash: hash(secret),
  suffix: `export125-${randomUUID()}`,
});
const xml = readFileSync(new URL("tests/fixtures/nfe/4.00/invoice-authorized.xml", repoUrl));
const invoice = processNfe(xml).normalized.document;
await call("mutation", "testing/exportProof:configure", {
  keyId: scope.keyId,
  cnpj: invoice.issuer.document,
});
async function api(path, method = "GET", body) {
  const response = await fetch(`${urls.site}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Environment": "sandbox",
      "Idempotency-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${result.error?.code ?? response.status}`);
  return result.data;
}
const batch = await api("/v1/imports", "POST", {
  companyId: scope.companyId,
  files: [{ name: "sintetico.xml", size: xml.length, sha256: hash(xml) }],
});
const filePath = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
const ticket = await api(`${filePath}/upload`, "POST");
assert.equal(
  (
    await fetch(`${urls.site}/v1/import-upload`, {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: xml,
    })
  ).status,
  200,
);
await api(`${filePath}/confirm`, "POST");
let documentId;
for (let n = 0; n < 120; n++) {
  const result = await api(`/v1/imports/${batch.importId}`);
  if (result.files[0].documentId) {
    documentId = result.files[0].documentId;
    break;
  }
  await delay(500);
}
assert.ok(documentId, "Import did not publish a document");
for (let offset = 0; offset < 100; offset += 10)
  await call("mutation", "testing/exportProof:expand", { documentId, offset });

async function measure(batched) {
  const exportId = await call("mutation", "testing/exportProof:job", {
    organizationId: scope.organizationId,
    batched,
  });
  const start = await call("query", "exportSource:start", { exportId, sequence: 0 });
  let checkpoint = start.checkpoint,
    calls = 0,
    responseBytes = 0,
    readBytes = 0,
    readRows = 0,
    maxReadBytes = 0,
    maxReadRows = 0;
  const begun = performance.now();
  while (calls < 2000) {
    const result = await call("query", "testing/exportProof:measuredRead", {
      exportId,
      sequence: 0,
      checkpoint,
    });
    const { page, metrics } = JSON.parse(result);
    calls++;
    responseBytes += Buffer.byteLength(JSON.stringify(page));
    readBytes += metrics.bytesRead.used;
    readRows += metrics.documentsRead.used;
    maxReadBytes = Math.max(maxReadBytes, metrics.bytesRead.used);
    maxReadRows = Math.max(maxReadRows, metrics.documentsRead.used);
    checkpoint = page.checkpoint;
    if (page.done) break;
  }
  assert.ok(calls < 2000);
  const sourceDurationMs = Math.round(performance.now() - begun);
  const workerStart = performance.now();
  await call("action", "exportWorker:run", { exportId, sequence: 0 });
  let value;
  for (let n = 0; n < 240; n++) {
    value = JSON.parse(await call("query", "testing/exportProof:inspect", { exportId }));
    if (value.job.state !== "running") break;
    await delay(250);
  }
  assert.equal(value.job.state, "succeeded");
  const workerDurationMs = Math.round(performance.now() - workerStart);
  const counts = {},
    content = createHash("sha256"),
    partHashes = [];
  let compressedBytes = 0,
    uncompressedBytes = 0;
  for (const part of value.parts) {
    const bytes = Buffer.from(
      await call("action", "testing/exportProof:part", { storageId: part.storageId }),
    );
    assert.equal(hash(bytes), part.sha256);
    partHashes.push(part.sha256);
    compressedBytes += bytes.length;
    const text = gunzipSync(bytes).toString();
    uncompressedBytes += Buffer.byteLength(text);
    for (const line of text.trim().split("\n")) {
      const row = JSON.parse(line);
      counts[row.type] = (counts[row.type] ?? 0) + 1;
      if (row.type === "original")
        assert.equal(hash(Buffer.from(row.content, "base64")), row.sha256);
      if (row.type === "manifest" || row.type === "part-end") continue;
      delete row.observedAt;
      content.update(JSON.stringify(row) + "\n");
    }
  }
  assert.equal(counts.document, 100);
  assert.equal(counts.version, 200);
  assert.equal(counts.item, 6000);
  assert.equal(counts.original, 101);
  const report = {
    calls,
    responseBytes,
    readBytes,
    readRows,
    maxReadBytes,
    maxReadRows,
    sourceDurationMs,
    workerDurationMs,
    parts: value.parts.length,
    compressedBytes,
    uncompressedBytes,
    counts,
    contentSha256: content.digest("hex"),
    partHashes,
  };
  console.log(JSON.stringify({ batched, ...report }));
  return report;
}
const baseline = await measure(false),
  batched = await measure(true);
assert.equal(batched.contentSha256, baseline.contentSha256);
assert.ok(batched.calls < baseline.calls / 2);
mkdirSync(new URL(".ci-results/125/", repoUrl), { recursive: true });
writeFileSync(
  new URL(".ci-results/125/native.json", repoUrl),
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      runtime:
        "Convex local; real source queries and separately timed complete Node worker with Workpool",
      target: urls.cloud,
      syntheticOnly: true,
      baseline,
      batched,
    },
    null,
    2,
  ) + "\n",
);
