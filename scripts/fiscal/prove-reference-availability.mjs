import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { referenceLocal } from "../lib/reference-local.mjs";
import { canonicalEntries, sha256 } from "../../platform/convex/lib/referenceDataset.ts";
import { normalizeCnpj } from "../../packages/fiscal-core/src/cnpj.ts";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";
import { termsAcceptance } from "../lib/organization-terms.mjs";

// Local-only assay. Official reference payloads stay in ignored storage; CNPJ is synthetic.
const root = repoRoot;
const local = referenceLocal(root);
const output = new URL(".ci-results/reference-availability/", repoUrl);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const suffix = crypto.randomUUID().slice(0, 8);
const report = {
  observedAt: new Date().toISOString(),
  codeSha: git("rev-parse", "HEAD"),
  dirty: Boolean(git("status", "--porcelain")),
  runnerSha256: hash(new URL(import.meta.url)),
  schemaSha256: hash(new URL("platform/convex/schema.ts", repoUrl)),
  environment: "anonymous-local",
  urls: local.urls,
  console: local.site,
  sources: [],
  registry: [],
  result: "running",
};
async function auth(path, body, cookie = "") {
  return fetch(`${local.urls.site}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: local.site,
      "Content-Type": "application/json",
      "Better-Auth-Cookie": cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
}
try {
  const health = await fetch(`${local.urls.site}/health`);
  assert.equal(health.status, 200);
  report.health = await health.json();
  report.crons = await local.rpc("query", "_system/frontend/listCronJobs", {});
  assert.deepEqual(report.crons, []);
  const email = `references-${suffix}@development.invalid`;
  const password = crypto.randomUUID() + "aA1!";
  assert.equal(
    (await auth("/sign-up/email", { email, password, name: "Prova sintética" })).status,
    200,
  );
  const mails = await local.rpc("query", "mail:inbox", { email });
  assert.equal(
    (
      await auth("/email-otp/verify-email", {
        email,
        otp: mails.find((m) => m.type === "email-verification").otp,
      })
    ).status,
    200,
  );
  const login = await auth("/sign-in/email", { email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .get("set-better-auth-cookie")
    ?.match(/(?:__Secure-)?better-auth\.session_token=[^;,\s]+/)?.[0];
  assert.ok(cookie);
  const tokenResponse = await auth("/convex/token", undefined, cookie);
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json();
  assert.ok(token);
  const human = (kind, path, args) => local.rpc(kind, path, args, `Bearer ${token}`);
  const org = await human("mutation", "organizations:create", {
    name: "Conferência sintética",
    slug: `conferencia-${suffix}`,
    ...(await termsAcceptance((path, args) => human("query", path, args))),
  });
  const base = `TEST${suffix.toUpperCase()}`;
  const cnpj = Array.from({ length: 100 }, (_, i) => base + String(i).padStart(2, "0")).find(
    normalizeCnpj,
  );
  assert.ok(cnpj);
  const address = {
    street: "Rua manual",
    number: "1",
    complement: "",
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    postalCode: "01000000",
  };
  const company = await human("mutation", "companies:create", {
    organizationId: org.organizationId,
    name: "Empresa sintética manual",
    cnpj,
    address,
  });
  const { projectId } = await human("mutation", "projects:create", {
    organizationId: org.organizationId,
    name: "Conferência de dados",
    externalReference: suffix,
  });
  const scope = { organizationId: org.organizationId, projectId };
  const companyScope = { organizationId: org.organizationId, companyId: company.companyId };
  await human("mutation", "projects:grantCompany", {
    ...scope,
    companyId: company.companyId,
    scopes: ["references:read", "registry:read"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const key = await human("action", "keys:create", {
    ...scope,
    name: "Consulta sintética",
    companyIds: [company.companyId],
    scopes: ["references:read", "registry:read"],
    environment: "sandbox",
    expiresAt: Date.now() + 3600000,
  });
  async function rest(path, params = {}) {
    const url = new URL(`${local.urls.site}/v1/${path}`);
    url.search = new URLSearchParams({ companyId: company.companyId, ...params }).toString();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key.secretOnce}`, "X-Environment": "sandbox" },
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const dataset of ["municipalities", "ncm"]) {
    const payload = JSON.parse(
      readFileSync(new URL(`.reference-data/${dataset}.json`, repoUrl), "utf8"),
    );
    const before = await local.rpc("query", "referenceImport:current", { dataset });
    const initial = await rest(`references/${dataset}`);
    assert.equal(initial.status, before.version ? 200 : 503);
    payload.manifest.version += `-${suffix}`;
    const id = await local.stage(JSON.stringify(payload));
    await local.publish(id, dataset, "Conferência local #75 → #76");
    const rows = [];
    let cursor;
    do {
      const response = await rest(`references/${dataset}`, {
        date: payload.manifest.asOf,
        limit: "50",
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data.manifest, payload.manifest);
      rows.push(
        ...response.body.data.page.map(({ code, description, state, validFrom, validTo }) => ({
          code,
          description,
          state,
          validFrom,
          validTo,
        })),
      );
      cursor = response.body.data.nextCursor;
    } while (cursor);
    assert.equal(rows.length, payload.entries.length);
    const servedHash = await sha256(canonicalEntries(rows));
    assert.equal(servedHash, payload.manifest.contentSha256);
    const missing = await rest(
      `references/${dataset}/${dataset === "ncm" ? "99999999" : "9999999"}`,
    );
    assert.equal(missing.status, 200);
    assert.equal(missing.body.data.status, "not_found");
    report.sources.push({
      manifest: payload.manifest,
      before,
      initialHttpStatus: initial.status,
      servedCount: rows.length,
      servedContentSha256: servedHash,
      missingStatus: missing.body.data.status,
      active: await local.rpc("query", "referenceImport:current", { dataset }),
    });
    console.log(`${dataset}: ${rows.length} persisted rows verified through HTTP`);
  }
  const registry = () => rest(`registry/cnpj/${cnpj}`);
  const untouched = await registry();
  assert.equal(untouched.status, 200);
  assert.equal(untouched.body.data.status, "not_consulted");
  report.registry.push({ mode: "empty", status: untouched.body.data.status });
  for (const mode of ["found", "stale", "unavailable", "not_found", "unsupported_format"]) {
    await local.rpc("mutation", "testing/registryProof:stage", {
      companyId: company.companyId,
      mode,
    });
    const response = await registry();
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, mode === "stale" ? "found" : mode);
    assert.equal(response.body.data.freshness, mode === "found" ? "fresh" : "stale");
    assert.equal(response.body.data.sourceUpdatedAt, null);
    report.registry.push({
      mode,
      status: response.body.data.status,
      freshness: response.body.data.freshness,
      version: response.body.data.version,
      sourceUpdatedAt: response.body.data.sourceUpdatedAt,
      consultedAt: response.body.data.consultedAt,
    });
  }
  await local.rpc("mutation", "testing/registryProof:stage", {
    companyId: company.companyId,
    mode: "found",
  });
  const found = (await registry()).body.data;
  const manual = await human("query", "companies:get", { ...companyScope, contextKey: suffix });
  assert.equal(manual.name, "Empresa sintética manual");
  await human("mutation", "registry:apply", {
    ...companyScope,
    expectedCompanyVersion: manual.version,
    expectedCacheVersion: found.version,
    fields: ["name"],
  });
  const applied = await human("query", "companies:get", { ...companyScope, contextKey: suffix });
  assert.equal(applied.name, "Razão social da fonte sintética");
  assert.deepEqual(applied.address, address);
  assert.equal(applied.fieldSources.name, "registry");
  assert.equal(applied.fieldSources.address, "declared");
  assert.equal(applied.fiscalAccess, "not-configured");
  report.selectiveConfirmation = "passed";
  await human("mutation", "keys:revoke", { ...scope, keyId: key.keyId });
  report.revokedHttpStatuses = [(await rest("references/ncm")).status, (await registry()).status];
  assert.deepEqual(report.revokedHttpStatuses, [401, 401]);
  report.consoleRoutes = {
    references: `${local.site}/app/${org.slug}/references`,
    company: `${local.site}/app/${org.slug}/companies/${company.companyId}`,
  };
  // Separate ignored file for manual local browser inspection. Never copy into evidence.
  writeFileSync(
    new URL("browser-private.json", output),
    JSON.stringify({ email, password, ...report.consoleRoutes }),
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  writeFileSync(new URL("local.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(`Reference availability: ${report.result}`);
}
