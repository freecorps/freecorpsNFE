// Hosted proof of webhook secret rotation and isolation (#51) on elated-possum-295.
// Writes synthetic organizations only; never toggles WEBHOOK_MODE nor touches other endpoints.
// Run: node --experimental-strip-types --require ./docs/v1.0/evidence/73/dns-proof.cjs \
//   scripts/proofs/prove-hosted-webhooks.mjs <cloudflared> <expected-sha>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWebhookReceiver } from "../../examples/webhook-receiver.mjs";
import { verifyWebhook } from "../../packages/contracts/src/webhooks.ts";
import { importSource, prepareScope } from "../lib/hosted-fixtures.mjs";

const [tunnelBinary, expectedSha] = process.argv.slice(2);
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/, "Expected published SHA");
const credential = JSON.parse(
  readFileSync(join(homedir(), ".freecorpsnfe/cutover-84/operator.json"), "utf8"),
);
const target = {
  cloud: "https://elated-possum-295.convex.cloud",
  site: "https://elated-possum-295.convex.site",
  // An installation refuses direct calls; REST goes through the public Worker.
  siteUrl: "https://api.nfe.freecorps.com.br",
};
assert.equal(credential.deploymentName, "elated-possum-295");
assert.equal(credential.deploymentType, "prod");
assert.equal(credential.url, target.cloud);

const runId = `hosted-51-${randomUUID()}`;
const privateDir = join(homedir(), ".freecorpsnfe/hosted-51", runId);
mkdirSync(privateDir, { recursive: true });
mkdirSync(resolve(".ci-results/51-webhooks"), { recursive: true });
const reportPath = resolve(".ci-results/51-webhooks", `${runId}.json`);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const report = {
  runId,
  startedAt: new Date().toISOString(),
  target,
  result: "running",
  scenarios: [],
  received: [],
  requests: [],
};
const state = { runId, scopes: [], keys: [], endpointIds: [] };
const save = () => {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(privateDir, "state.json"), JSON.stringify(state, null, 2));
};

async function post(path, body) {
  const response = await fetch(target.cloud + path, {
    method: "POST",
    headers: {
      Authorization: `Convex ${credential.adminKey}`,
      "Content-Type": "application/json",
      "Convex-Client": "npm-1.44.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `Backend ${path} HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function rpc(kind, path, args = {}) {
  const result = await post(`/api/${kind}`, { path, args: [args], format: "convex_encoded_json" });
  assert.equal(result.status, "success", `RPC ${path} failed`);
  return result.value;
}
async function query(body) {
  const source = `import {query} from "convex:/_system/repl/wrappers.js";
    export default query({handler: async (ctx) => {${body}}});`;
  const result = await post("/api/run_test_function", {
    adminKey: credential.adminKey,
    args: {},
    bundle: { path: "testQuery.js", source },
    format: "json",
  });
  assert.equal(result.status, "success", "Read-only query failed");
  return result.value;
}
const eq = (fields) =>
  Object.entries(fields)
    .map(([k, v]) => `.eq(${JSON.stringify(k)},${JSON.stringify(v)})`)
    .join("");
const h = {
  target,
  query,
  add: async (table, documents) =>
    assert.equal(
      (await rpc("mutation", "_system/frontend/addDocument", { table, documents })).success,
      true,
    ),
  patch: async (table, ids, fields) =>
    assert.equal(
      (await rpc("mutation", "_system/frontend/patchDocumentsFields", { table, ids, fields }))
        .success,
      true,
    ),
  rows: (table, index, fields, limit = 100) =>
    query(
      `return await ctx.db.query(${JSON.stringify(table)}).withIndex(${JSON.stringify(index)},q=>q${eq(fields)}).take(${limit});`,
    ),
};

async function configuration() {
  const vars = Object.fromEntries(
    (await rpc("query", "_system/cli/queryEnvironmentVariables")).map((x) => [x.name, x.value]),
  );
  assert.match(vars.FNFE_WEBHOOK_MASTER_KEY ?? "", /^[a-fA-F0-9]{64}$/);
  return Object.fromEntries(
    ["APP_ENV", "PRODUCT_ENV", "FISCAL_ENV", "FNFE_CRONS", "WEBHOOK_MODE"].map((k) => [k, vars[k]]),
  );
}
async function inventory() {
  // Other endpoints are counted, never read in detail nor changed.
  return query(`const e = await ctx.db.query("webhookEndpoints").take(500);
    const d = await ctx.db.query("webhookDeliveries").take(2000);
    const states = {}; for (const x of d) states[x.state] = (states[x.state] ?? 0) + 1;
    return { complete: e.length < 500 && d.length < 2000, endpoints: e.length,
      active: e.filter(x => x.active).map(x => x._id), deliveries: d.length, states };`);
}
async function rest(scope, path, method = "GET", body, options = {}) {
  const response = await fetch(target.siteUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${scope.secret}`,
      "X-Environment": options.environment ?? "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": options.key ?? randomUUID(),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  const code = data.error?.code ?? null;
  report.requests.push({
    path,
    method,
    http: response.status,
    requestId: data.requestId ?? null,
    code,
  });
  save();
  if (options.denied) {
    assert.ok(
      [400, 401, 403, 404, 409].includes(response.status),
      `Expected denial: ${method} ${path}: ${response.status}`,
    );
    return { http: response.status, code };
  }
  assert.equal(
    response.status,
    200,
    `REST ${method} ${path}: ${response.status}/${code ?? "unknown"}`,
  );
  return data.data;
}
async function settle(scope, endpointId, eventId, states = ["delivered", "failed", "paused"]) {
  for (let i = 0; i < 65; i++) {
    const page = await rest(scope, `/v1/webhook-deliveries?endpointId=${endpointId}`);
    const delivery = page.items.find((x) => x.eventId === eventId);
    if (delivery && states.includes(delivery.state)) return delivery;
    await delay(1200);
  }
  throw new Error("Delivery did not settle");
}
const endpointRow = (id) =>
  query(`const e = await ctx.db.get(${JSON.stringify(id)});
    return { active: e.active, version: e.version, secretVersion: e.secretVersion,
      previousVersion: e.previousVersion ?? null, previousUntil: e.previousUntil ?? null,
      hasPreviousSecret: e.previousSecret !== undefined, updatedAt: e.updatedAt };`);
const scenario = (name, evidence) => {
  report.scenarios.push({ name, result: "passed", at: new Date().toISOString(), ...evidence });
  save();
  console.log(`passed: ${name}`);
};

let server,
  tunnel,
  receiver,
  mode = "ok",
  lastMessage,
  endpoint;
// The receiver keeps validUntil for the old secret, as WEBHOOKS.md requires.
let secrets = [];
const receiverOptions = { database: join(privateDir, "receiver.sqlite"), secrets: () => secrets };
try {
  report.before = await configuration();
  assert.deepEqual(report.before, {
    APP_ENV: "installation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "https",
  });
  report.healthBefore = await (await fetch(target.site + "/health")).json();
  report.frontendBefore = await (await fetch("https://nfe.freecorps.com.br/build.json")).json();
  assert.equal(report.healthBefore.sha, expectedSha);
  assert.equal(report.frontendBefore.sha, expectedSha);
  report.crons = (await rpc("query", "_system/frontend/listCronJobs")).length;
  assert.equal(report.crons, 0);
  report.sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  report.runnerHash = hash(readFileSync(new URL(import.meta.url)));
  report.tunnel = {
    version: execFileSync(tunnelBinary, ["--version"], { encoding: "utf8" }).trim(),
    sha256: hash(readFileSync(tunnelBinary)),
  };
  report.inventoryBefore = await inventory();
  assert.equal(report.inventoryBefore.complete, true);
  save();

  receiver = createWebhookReceiver(receiverOptions);
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/ready") return void res.writeHead(204).end();
    if (req.method !== "POST" || req.url !== "/hook") return void res.writeHead(404).end();
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error("size");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
      );
      const verification = await verifyWebhook({ body, headers, secrets, now: Date.now() });
      const record = {
        at: Date.now(),
        eventId: headers["x-fnfe-event-id"],
        deliveryId: headers["x-fnfe-delivery-id"],
        bodyHash: hash(body),
        signatureVersions: headers["x-fnfe-signature"]?.match(/k=\d+/g) ?? [],
        verified: verification.ok,
      };
      if (!verification.ok) {
        report.received.push({ ...record, code: verification.code });
        save();
        return void res.writeHead(400).end();
      }
      lastMessage = { body, headers };
      const result =
        mode === "hold"
          ? { status: 503, code: "TEMPORARY_UNAVAILABLE" }
          : await receiver.receive(body, headers);
      report.received.push({
        ...record,
        type: verification.event.type,
        result: result.code,
        http: result.status,
      });
      save();
      res.writeHead(result.status, mode === "hold" ? { "Retry-After": "15" } : {}).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  tunnel = spawn(
    tunnelBinary,
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      `http://127.0.0.1:${server.address().port}`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const origin = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Tunnel timeout")), 55_000);
    const read = (chunk) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        done(match[0]);
      }
    };
    tunnel.stdout.on("data", read);
    tunnel.stderr.on("data", read);
    tunnel.on("error", fail);
  });
  report.receiverOriginHash = hash(origin);
  let ready = false;
  for (let n = 0; n < 30 && !ready; n++) {
    try {
      ready =
        (await fetch(origin + "/ready", { signal: AbortSignal.timeout(4000) })).status === 204;
    } catch {}
    if (!ready) await delay(1500);
  }
  assert.equal(ready, true, "Receiver HTTPS unavailable");

  // Synthetic rows only after every network prerequisite passed.
  const a = await prepareScope(h, `${runId}-a`);
  state.scopes.push(a);
  state.keys.push(a.keyId);
  save();
  const b = await prepareScope(h, `${runId}-b`);
  state.scopes.push(b);
  state.keys.push(b.keyId);
  save();
  const created = await rest(a, "/v1/webhook-endpoints", "POST", {
    companyId: a.companyId,
    name: "Ensaio hospedado #51 rotação/isolamento",
    url: origin + "/hook",
    events: ["document.received"],
  });
  endpoint = created.endpoint;
  state.endpointIds.push(endpoint.id);
  save();
  const v1 = { version: endpoint.secretVersion, secret: created.secret };
  secrets = [v1];

  // Rotation: baseline signature, then real overlap, refusal of a concurrent rotation and expiry.
  const test = await rest(a, `/v1/webhook-endpoints/${endpoint.id}/test`, "POST", {});
  let delivery = await settle(a, endpoint.id, test.eventId);
  assert.equal(delivery.state, "delivered");
  const baseline = report.received.at(-1);
  assert.deepEqual(baseline.signatureVersions, ["k=1"]);
  const effects = receiver.inspect();

  const overlapMs = 60_000;
  const rotated = await rest(a, `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`, "POST", {
    expectedVersion: endpoint.version,
    overlapMs,
  });
  endpoint = rotated.endpoint;
  const v2 = { version: endpoint.secretVersion, secret: rotated.secret };
  assert.equal(v2.version, 2);
  assert.notEqual(v2.secret, v1.secret);
  secrets = [{ ...v1, validUntil: endpoint.previousUntil }, v2];
  const during = await endpointRow(endpoint.id);
  assert.equal(during.hasPreviousSecret, true);
  const concurrent = await rest(
    a,
    `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`,
    "POST",
    { expectedVersion: endpoint.version, overlapMs: 0 },
    { denied: true },
  );
  assert.equal(concurrent.code, "ROTATION_IN_PROGRESS");
  assert.equal((await endpointRow(endpoint.id)).secretVersion, 2);

  await rest(a, `/v1/webhook-deliveries/${delivery.id}/retry`, "POST", {
    expectedGeneration: delivery.generation,
  });
  delivery = await settle(a, endpoint.id, test.eventId);
  const overlap = report.received.at(-1);
  assert.deepEqual(overlap.signatureVersions, ["k=2", "k=1"]);
  const overlapMessage = lastMessage;
  const now = Date.now();
  const oldDuring = await verifyWebhook({ ...overlapMessage, secrets: [v1], now });
  const newDuring = await verifyWebhook({ ...overlapMessage, secrets: [v2], now });
  assert.equal(oldDuring.ok, true);
  assert.equal(newDuring.ok, true);
  assert.deepEqual(receiver.inspect(), effects);
  scenario("rotation-overlap-signs-both-versions", {
    overlapMs,
    previousUntil: endpoint.previousUntil,
    baseline: baseline.signatureVersions,
    overlap: overlap.signatureVersions,
    oldOnlyDuring: oldDuring.ok,
    newOnlyDuring: newDuring.ok,
    concurrentRotation: concurrent,
    effectsUnchanged: true,
  });

  await delay(Math.max(0, endpoint.previousUntil - Date.now() + 2000));
  let expired;
  for (let i = 0; i < 30; i++) {
    expired = await endpointRow(endpoint.id);
    if (!expired.hasPreviousSecret) break;
    await delay(1000);
  }
  assert.equal(expired.hasPreviousSecret, false, "Old ciphertext not removed after expiry");
  const afterTest = await rest(a, `/v1/webhook-endpoints/${endpoint.id}/test`, "POST", {});
  const afterDelivery = await settle(a, endpoint.id, afterTest.eventId);
  assert.equal(afterDelivery.state, "delivered");
  const after = report.received.at(-1);
  assert.deepEqual(after.signatureVersions, ["k=2"]);
  const oldAfter = await verifyWebhook({ ...lastMessage, secrets: [v1], now: Date.now() });
  const newAfter = await verifyWebhook({ ...lastMessage, secrets: [v2], now: Date.now() });
  assert.equal(oldAfter.code, "SIGNATURE_INVALID");
  assert.equal(newAfter.ok, true);
  scenario("rotation-expiry-retires-old-secret", {
    after: after.signatureVersions,
    oldOnlyAfter: oldAfter.code,
    newOnlyAfter: newAfter.ok,
    endpoint: expired,
  });

  // Isolation: other organization, other project, company outside the key, wrong environment.
  const source = await importSource(h, a);
  state.documentId = source.doc._id;
  save();
  await rest(a, `/v1/documents/${source.doc._id}?companyId=${a.companyId}`);
  const before = await endpointRow(endpoint.id);
  const deliveriesBefore = (await rest(a, `/v1/webhook-deliveries?endpointId=${endpoint.id}`)).items
    .length;
  const receivedBefore = report.received.length;
  const probes = [
    [`/v1/webhook-endpoints/${endpoint.id}`, "GET"],
    [`/v1/webhook-endpoints?companyId=${a.companyId}`, "GET"],
    [
      `/v1/webhook-endpoints/${endpoint.id}`,
      "PATCH",
      {
        expectedVersion: before.version,
        name: "x",
        url: origin + "/hook",
        events: ["document.received"],
        active: false,
      },
    ],
    [
      `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`,
      "POST",
      { expectedVersion: before.version, overlapMs: 0 },
    ],
    [`/v1/webhook-endpoints/${endpoint.id}/test`, "POST", {}],
    [`/v1/webhook-deliveries?endpointId=${endpoint.id}`, "GET"],
    [
      `/v1/webhook-deliveries/${afterDelivery.id}/retry`,
      "POST",
      { expectedGeneration: afterDelivery.generation },
    ],
    [`/v1/documents/${source.doc._id}?companyId=${a.companyId}`, "GET"],
  ];
  // Probes the scope may legitimately answer (its own documents, its own empty list) are skipped.
  // Each scope must fail with its contractual status and code, not just any denial.
  const probe = async (scope, expected, { skip = [], ...options } = {}) => {
    const results = [];
    for (const [path, method, body] of probes) {
      if (skip.some((prefix) => path.startsWith(prefix))) continue;
      const denied = await rest(scope, path, method, body, { ...options, denied: true });
      const route = path.replace(/[a-z0-9]{32}/g, ":id");
      assert.deepEqual(denied, expected, route);
      results.push({ method, route, ...denied });
    }
    return results;
  };
  const otherOrganization = await probe(b, { http: 404, code: "NOT_FOUND" });
  const wrongEnvironment = await probe(
    a,
    { http: 403, code: "ENVIRONMENT_DENIED" },
    { environment: "production" },
  );

  // Same organization, another project with a valid grant and key of its own.
  const project = await query(`return await ctx.db.get(${JSON.stringify(a.projectId)});`);
  delete project._id;
  delete project._creationTime;
  project.externalReference = `${runId}-project2`;
  await h.add("projects", [project]);
  const p2 = (
    await h.rows("projects", "by_organizationId", { organizationId: a.organizationId })
  ).find((p) => p.externalReference === project.externalReference);
  assert.ok(p2);
  const grants = await h.rows("projectCompanies", "by_projectId_and_companyId", {
    projectId: a.projectId,
    companyId: a.companyId,
  });
  const grant = { ...grants[0], projectId: p2._id };
  delete grant._id;
  delete grant._creationTime;
  await h.add("projectCompanies", [grant]);
  const key = await query(`return await ctx.db.get(${JSON.stringify(a.keyId)});`);
  delete key._id;
  delete key._creationTime;
  const otherSecret = `fnfe_${randomBytes(32).toString("base64url")}`;
  key.projectId = p2._id;
  key.keyHash = hash(otherSecret);
  await h.add("apiKeys", [key]);
  const k2 = (await h.rows("apiKeys", "by_keyHash", { keyHash: key.keyHash }))[0];
  state.keys.push(k2._id);
  save();
  const otherProjectScope = { ...a, secret: otherSecret };
  const ownList = await rest(otherProjectScope, `/v1/webhook-endpoints?companyId=${a.companyId}`);
  // The other project lists only its own endpoints for the shared company: none.
  assert.deepEqual(ownList, []);
  const otherProject = await probe(
    otherProjectScope,
    { http: 404, code: "NOT_FOUND" },
    {
      skip: ["/v1/documents/", "/v1/webhook-endpoints?"],
    },
  );

  // Same key, company removed from its grant; then revoked.
  await h.patch("apiKeys", [k2._id], { projectId: a.projectId, companyIds: [], grantEpochs: [] });
  const companyOutside = await probe(otherProjectScope, { http: 404, code: "NOT_FOUND" });
  await h.patch("apiKeys", [k2._id], { revokedAt: Date.now() });
  const revokedKey = await probe(otherProjectScope, { http: 401, code: "INVALID_API_KEY" });

  // Owner key without webhooks:manage.
  await h.patch("apiKeys", [a.keyId], { scopes: ["documents:read"] });
  const removedScope = await probe(
    a,
    { http: 403, code: "SCOPE_DENIED" },
    { skip: ["/v1/documents/"] },
  );
  await h.patch("apiKeys", [a.keyId], { scopes: key.scopes });

  const unchanged = await endpointRow(endpoint.id);
  assert.deepEqual(unchanged, before, "Denied calls changed the endpoint");
  assert.equal(
    (await rest(a, `/v1/webhook-deliveries?endpointId=${endpoint.id}`)).items.length,
    deliveriesBefore,
  );
  assert.equal(report.received.length, receivedBefore, "Denied calls reached the receiver");
  scenario("isolation-denies-without-effect", {
    otherOrganization,
    wrongEnvironment,
    otherProject,
    otherProjectListOmitsEndpoint: true,
    companyOutside,
    revokedKey,
    removedScope,
    endpointUnchanged: true,
    deliveriesUnchanged: deliveriesBefore,
    receiverCallsUnchanged: true,
  });

  // Grant revoked while a delivery waits for retry: it pauses before the network.
  mode = "hold";
  const pending = await rest(a, `/v1/webhook-endpoints/${endpoint.id}/test`, "POST", {});
  const waiting = await settle(a, endpoint.id, pending.eventId, ["retry_wait"]);
  mode = "ok";
  await h.patch("projectCompanies", [grants[0]._id], {
    active: false,
    accessEpoch: grants[0].accessEpoch + 1,
  });
  const callsBefore = report.received.filter((x) => x.eventId === pending.eventId).length;
  let paused;
  for (let i = 0; i < 40; i++) {
    paused = await query(`const d = await ctx.db.get(${JSON.stringify(waiting.id)});
      return { state: d.state, attempts: d.attempts, code: d.code ?? null };`);
    if (paused.state === "paused") break;
    await delay(1000);
  }
  assert.equal(paused.state, "paused");
  assert.equal(report.received.filter((x) => x.eventId === pending.eventId).length, callsBefore);
  scenario("grant-revocation-pauses-retry-before-network", {
    deliveryId: waiting.id,
    after: paused,
    receiverCalls: callsBefore,
  });
  report.receiverEffects = receiver.inspect();
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = {
    name: error.name,
    message: error.message?.replace(/(?:whsec_|fnfe_)[A-Za-z0-9_-]+/g, "<redacted>"),
  };
  console.log(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.cleanup = { errors: [] };
  for (const id of state.endpointIds)
    try {
      await h.patch("webhookEndpoints", [id], { active: false, updatedAt: Date.now() });
    } catch {
      report.cleanup.errors.push("disable-endpoint");
    }
  for (const id of state.keys)
    try {
      await h.patch("apiKeys", [id], { revokedAt: Date.now() });
    } catch {
      report.cleanup.errors.push("revoke-key");
    }
  try {
    report.after = await configuration();
    report.inventoryAfter = await inventory();
    report.healthAfter = await (await fetch(target.site + "/health")).json();
    assert.deepEqual(report.after, report.before);
    assert.equal(report.healthAfter.sha, report.healthBefore.sha);
    assert.equal(
      report.inventoryAfter.active.filter((id) => state.endpointIds.includes(id)).length,
      0,
    );
    if (report.inventoryBefore)
      assert.deepEqual(report.inventoryAfter.active, report.inventoryBefore.active);
  } catch {
    report.cleanup.errors.push("verify-final-state");
  }
  receiver?.close();
  tunnel?.kill();
  await new Promise((done) => (server ? server.close(done) : done()));
  report.finishedAt = new Date().toISOString();
  if (report.cleanup.errors.length) {
    report.result = "cleanup-failed";
    process.exitCode = 1;
  }
  save();
  console.log(
    JSON.stringify({
      result: report.result,
      scenarios: report.scenarios.length,
      reportPath,
      cleanup: report.cleanup,
    }),
  );
}
