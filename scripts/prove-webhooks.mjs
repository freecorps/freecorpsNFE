import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import AxeBuilder from "@axe-core/playwright";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "./lib/worktree/env-file.mjs";
import { convexRun } from "./lib/worktree/convex-local.mjs";
import { assertLinkedWorktree } from "./lib/worktree/state.mjs";
import { localAuthPacer } from "../apps/console/e2e/local-auth-pacing.mjs";
import { createWebhookReceiver } from "../examples/webhook-receiver.mjs";
import { independentReceiver, proveQuickstarts } from "./lib/sdk-proof.mjs";
const { chromium } = createRequire(new URL("../apps/console/package.json", import.meta.url))(
  "playwright",
);

const root = fileURLToPath(new URL("..", import.meta.url)),
  paths = worktreePaths(root);
assertLinkedWorktree(paths);
assert.equal(paths.app, "platform");
const config = readLocalConfig(paths),
  urls = localUrls(config),
  site = currentLocalSiteUrl(paths);
assert.equal(new URL(urls.cloud).hostname, "127.0.0.1");
assert.equal(new URL(site).hostname, "localhost");
const sdkMode = process.argv.includes("--sdk");
const baseline = process.argv.includes("--quickstart-before");
const output = join(
  root,
  sdkMode || baseline ? ".ci-results/74/browser" : ".ci-results/73/browser",
);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fingerprint() {
  const files = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "apps",
    "platform",
    "packages",
    "scripts",
    "examples",
  )
    .split(/\r?\n/)
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update(readFileSync(join(root, file)));
  }
  return digest.digest("hex");
}
const report = {
  codeSha: git("rev-parse", "HEAD"),
  runnerSha: git("rev-parse", "HEAD"),
  dirty: !!git("status", "--porcelain"),
  sourceFingerprint: fingerprint(),
  environment: "anonymous-local/sandbox",
  dnsResolver: process.env.FNFE_PROOF_DNS ?? "operating-system",
  site,
  backend: urls.cloud,
  dataset: "synthetic account, company, project, key, NF-e and webhook receiver",
  scenarios: [],
  accessibility: [],
  received: [],
  result: "running",
};
let secrets = [],
  failNext = 1,
  tunnel,
  browser,
  page,
  context,
  jwt,
  endpointId,
  scope,
  keyId,
  apiKey;
const receiverOptions = {
  database: join(output, `receiver-${crypto.randomUUID()}.sqlite`),
  secrets: () => secrets,
};
const receiver = sdkMode
  ? await independentReceiver({
      ...receiverOptions,
      options: () => ({ baseUrl: urls.site, apiKey, environment: "sandbox" }),
    })
  : createWebhookReceiver(receiverOptions);
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ready") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/hook") {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16384) throw new Error("too large");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks),
      headers = Object.fromEntries(
        Object.entries(request.headers).filter(([, v]) => typeof v === "string"),
      );
    const result = await receiver.receive(body, headers);
    if (result.status === 204)
      report.received.push({
        eventId: headers["x-fnfe-event-id"],
        deliveryId: headers["x-fnfe-delivery-id"],
        resourceVersion: headers["x-fnfe-resource-version"],
        signatureVersions: headers["x-fnfe-signature"].match(/k=\d+/g) ?? [],
        bodyHash: hash(body),
        result: result.code,
        type: JSON.parse(body.toString("utf8")).type,
      });
    const status = result.status === 204 && failNext-- > 0 ? 503 : result.status;
    response.writeHead(status, { "Retry-After": "2" });
    response.end("remote-private-response-omitted");
  } catch {
    response.writeHead(400);
    response.end();
  }
});
async function rpc(kind, path, args, admin = false) {
  if (!admin)
    jwt = await page.evaluate(async () => {
      const { authClient } = await import("/src/auth.ts");
      return (await authClient.convex.token()).data?.token;
    });
  const response = await fetch(`${urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: admin ? `Convex ${config.adminKey}` : `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(body.status, "success", `${path}: ${body.errorMessage ?? "failed"}`);
  return body.value;
}
async function rest(path, method = "GET", body, key = crypto.randomUUID()) {
  const response = await fetch(`${urls.site}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Environment": "sandbox",
      "Idempotency-Key": key,
      "Content-Type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result.error)}`);
  return result.data;
}
async function capture(name) {
  assert.equal(await page.locator("#webhook-secret").count(), 0, "Never capture a signing secret");
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  report.accessibility.push({
    name,
    violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact })),
  });
  assert.equal(axe.violations.length, 0, `Accessibility: ${name}`);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `Horizontal overflow: ${name}`,
  );
}
async function waitForDelivery(eventId) {
  for (let n = 0; n < 90; n++) {
    const history = await rest(`/v1/webhook-deliveries?endpointId=${endpointId}`);
    const d = history.items.find((d) => d.eventId === eventId);
    if (d?.state === "delivered" || d?.state === "failed" || d?.state === "paused") return d;
    await delay(1000);
  }
  throw new Error("Delivery did not settle");
}
try {
  const health = await (await fetch(`${urls.site}/health`)).json();
  assert.equal(health.appEnv, "development");
  assert.equal(health.fiscalEnv, "disabled");
  assert.deepEqual(await rpc("query", "_system/frontend/listCronJobs", {}, true), []);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const binary = resolve(
    process.env.FNFE_PROOF_CLOUDFLARED ?? join(root, ".ci-results/73/cloudflared.exe"),
  );
  tunnel = spawn(
    binary,
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
  const tunnelUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Quick Tunnel startup timed out")), 60_000);
    const read = (chunk) => {
      const found = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    };
    tunnel.stdout.on("data", read);
    tunnel.stderr.on("data", read);
    tunnel.on("error", reject);
  });
  report.receiverOrigin = tunnelUrl;
  console.log(`Waiting for public DNS and HTTPS: ${tunnelUrl}`);
  report.tunnelDiagnostics = [];
  tunnel.stderr.on("data", (chunk) => {
    report.tunnelDiagnostics.push(
      String(chunk)
        .trim()
        .replace(/(?:\d{1,3}\.){3}\d{1,3}/g, "[ip]")
        .replace(/fe80::[a-f0-9:]+/gi, "[ipv6]"),
    );
    report.tunnelDiagnostics = report.tunnelDiagnostics.slice(-10);
  });
  report.receiverProbeErrors = [];
  for (let n = 0; n < 180; n++) {
    try {
      if ((await fetch(`${tunnelUrl}/ready`, { signal: AbortSignal.timeout(3000) })).status === 204)
        break;
    } catch (error) {
      report.receiverProbeErrors.push(String(error.cause ?? error));
    }
    if (n % 10 === 0)
      console.log(`Receiver readiness ${n}: ${report.receiverProbeErrors.at(-1) ?? "waiting"}`);
    if (n === 179) throw new Error("HTTPS receiver unreachable");
    await delay(2000);
  }
  console.log("target: local-anonymous, enabling HTTPS only for synthetic receiver proof");
  convexRun(paths, ["env", "set", "WEBHOOK_MODE", "https"], { capture: true });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await localAuthPacer(report)(context);
  page = await context.newPage();
  page.on("pageerror", (e) => {
    report.browserError = e.message;
  });
  const email = `webhook-${crypto.randomUUID()}@development.invalid`,
    password = `synthetic-${crypto.randomUUID()}`;
  await page.goto(`${site}/signup`);
  await page.getByLabel("Seu nome").fill("Pessoa dos webhooks");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.getByText("Solicitação de cadastro registrada", { exact: false }).waitFor();
  const mail = await rpc("query", "mail:inbox", { email }, true);
  await page.goto(`${site}/verify-email`);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page
    .getByLabel("Código de oito dígitos")
    .fill(mail.find((m) => m.type === "email-verification").otp);
  await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
  await page
    .getByText("E-mail verificado. Você já pode entrar com sua senha.", { exact: true })
    .waitFor();
  await page.goto(`${site}/login`);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar no painel" }).click();
  await page.getByRole("heading", { name: "Seu espaço começa aqui." }).waitFor();
  const org = await rpc("mutation", "organizations:create", {
    name: "Webhooks sintéticos",
    slug: `webhook-${crypto.randomUUID()}`,
  });
  const { companyId } = await rpc("mutation", "onboarding:start", {
    organizationId: org.organizationId,
    mode: "demonstration",
    expectedVersion: 0,
  });
  const { projectId } = await rpc("mutation", "projects:create", {
    organizationId: org.organizationId,
    name: "Receptor de demonstração",
    externalReference: crypto.randomUUID(),
  });
  scope = { organizationId: org.organizationId, projectId, companyId, environment: "sandbox" };
  const scopes = ["documents:import", "documents:read", "webhooks:manage"];
  await rpc("mutation", "projects:grantCompany", {
    organizationId: org.organizationId,
    projectId,
    companyId,
    scopes,
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const key = await rpc("action", "keys:create", {
    organizationId: org.organizationId,
    projectId,
    name: "Prova webhook",
    scopes,
    environment: "sandbox",
    companyIds: [companyId],
    expiresAt: Date.now() + 3600000,
  });
  apiKey = key.secretOnce;
  keyId = key.keyId;
  if (baseline) {
    await page.goto(`${site}/app/${org.slug}/developer/quickstart/${projectId}`);
    await page.getByRole("heading", { name: "Consulte suas empresas.", exact: true }).waitFor();
    await capture("quickstart-before");
    throw new Error("BASELINE_CAPTURED");
  }
  const base = `${site}/app/${org.slug}/developer/webhooks/${projectId}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Novo destino", exact: true }).waitFor();
  await capture("webhooks-empty-desktop");
  await page.getByRole("button", { name: "Novo destino", exact: true }).click();
  await page.getByLabel("Nome do destino", { exact: true }).fill("Receptor HTTPS sintético");
  await page.getByLabel("URL HTTPS", { exact: true }).fill(`${tunnelUrl}/hook`);
  await page.getByRole("button", { name: "Criar destino", exact: true }).click();
  await page.getByLabel("Segredo do webhook", { exact: true }).waitFor();
  secrets = [
    {
      version: 1,
      secret: await page.getByLabel("Segredo do webhook", { exact: true }).inputValue(),
    },
  ];
  await page.getByRole("button", { name: "Já guardei o segredo", exact: true }).click();
  const endpoints = await rest(`/v1/webhook-endpoints?companyId=${companyId}`);
  endpointId = endpoints[0].id;
  assert.ok(!JSON.stringify(endpoints).includes(secrets[0].secret));
  await page.getByRole("button", { name: "Receptor HTTPS sintético · Ativo", exact: true }).click();
  await page.getByRole("button", { name: "Enviar teste sintético", exact: true }).click();
  await page.getByText("Aguardando nova tentativa", { exact: true }).waitFor();
  await capture("webhooks-retry-wait");
  const history = await rest(`/v1/webhook-deliveries?endpointId=${endpointId}`),
    eventId = history.items[0].eventId;
  const delivered = await waitForDelivery(eventId);
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.attempts, 2);
  assert.equal(report.received[0].result, "APPLIED");
  assert.equal(report.received[1].result, "DUPLICATE");
  report.scenarios.push(
    "native-https-dns-tls-hmac-failure-retry-one-effect",
    "ui-creation-secret-discard-and-live-history",
  );
  await page.reload();
  await page.getByRole("heading", { name: "Receptor HTTPS sintético", exact: true }).waitFor();
  assert.equal(await page.locator("#webhook-secret").count(), 0);
  await capture("webhooks-delivered-deep-link");
  await page.getByRole("button", { name: "Rotacionar segredo", exact: true }).click();
  await page.getByRole("button", { name: "Confirmar rotação", exact: true }).click();
  await page.getByLabel("Segredo do webhook", { exact: true }).waitFor();
  secrets = [
    {
      version: 2,
      secret: await page.getByLabel("Segredo do webhook", { exact: true }).inputValue(),
    },
    { ...secrets[0], validUntil: Date.now() + 3600000 },
  ];
  await page.getByRole("button", { name: "Já guardei o segredo", exact: true }).click();
  await page.getByRole("button", { name: "Reenviar entrega", exact: true }).first().click();
  await page.getByRole("button", { name: "Confirmar reenvio", exact: true }).click();
  for (let n = 0; n < 60 && report.received.length < 3; n++) await delay(500);
  assert.deepEqual(report.received[2].signatureVersions, ["k=2", "k=1"]);
  assert.equal(report.received[2].eventId, eventId);
  assert.equal(report.received[2].result, "DUPLICATE");
  report.scenarios.push("ui-rotation-both-signatures-and-audited-resend");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Ver tentativas", exact: true }).first().click();
  await page.getByText("Tentativa 3", { exact: false }).waitFor();
  await capture("webhooks-mobile-history");
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The same production transport must refuse DNS resolving to loopback.
  const denied = await rest("/v1/webhook-endpoints", "POST", {
    companyId,
    name: "DNS privado sintético",
    url: "https://127.0.0.1.nip.io/hook",
    events: ["document.received"],
  });
  const deniedEvent = await rest(`/v1/webhook-endpoints/${denied.endpoint.id}/test`, "POST", {});
  const originalEndpoint = endpointId;
  endpointId = denied.endpoint.id;
  const rejected = await waitForDelivery(deniedEvent.eventId);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.code, "DESTINATION_DENIED");
  endpointId = originalEndpoint;
  report.scenarios.push("native-dns-loopback-denied-for-synthetic-test");
  await page.goto(`${base}?company=${companyId}&endpoint=invalid`);
  await page
    .getByText("Destino indisponível para esta empresa e projeto.", { exact: true })
    .waitFor();
  report.scenarios.push("forged-deep-link-unavailable");
  assert.equal(receiver.inspect().resources[0].effects, 1);
  const xml = readFileSync(join(root, "apps/console/public/examples/nfe-demonstracao.xml"));
  const importIntent = crypto.randomUUID();
  const reservationInput = {
    companyId,
    files: [{ name: "demonstracao.xml", size: xml.length, sha256: hash(xml) }],
  };
  const imported = await rest("/v1/imports", "POST", reservationInput, importIntent);
  assert.equal(
    (await rest("/v1/imports", "POST", reservationInput, importIntent)).importId,
    imported.importId,
  );
  const filePath = `/v1/imports/${imported.importId}/files/${imported.fileIds[0]}`;
  const upload = await rest(`${filePath}/upload`, "POST");
  assert.equal(
    (
      await fetch(upload.url, {
        method: "POST",
        headers: { "X-Upload-Token": upload.token },
        body: xml,
      })
    ).status,
    200,
  );
  await rest(`${filePath}/confirm`, "POST");
  let importedDocument;
  for (let n = 0; n < 90; n++) {
    const current = await rest(`/v1/imports/${imported.importId}`);
    importedDocument = current.files[0].documentId;
    if (
      current.files[0].state === "succeeded" &&
      report.received.some((e) => e.type === "import.completed") &&
      report.received.some((e) => e.type === "document.received")
    )
      break;
    if (n === 89) throw new Error("Import did not deliver its public events");
    await delay(1000);
  }
  const document = await rest(`/v1/documents/${importedDocument}?companyId=${companyId}`);
  assert.ok(document.summary.resourceVersion >= 1);
  report.scenarios.push("native-xml-import-to-document-query-and-signed-outbox-events");
  if (sdkMode) {
    report.quickstarts = await proveQuickstarts({
      baseUrl: urls.site,
      apiKey,
      companyId,
      xmlPath: join(root, "apps/console/public/examples/nfe-demonstracao.xml"),
    });
    for (
      let attempt = 0;
      attempt < 120 && report.received.filter((e) => e.type === "import.completed").length < 3;
      attempt++
    )
      await delay(500);
    assert.ok(report.received.filter((e) => e.type === "import.completed").length >= 3);
    assert.ok(receiver.documentReads() > 0);
    report.authenticatedDocumentReads = receiver.documentReads();
    report.scenarios.push(
      "packaged-sdk-and-curl-import-query-equal-values-and-identities",
      "packaged-receiver-authenticated-document-read-and-persistent-effect",
    );
    await page.goto(`${site}/app/${org.slug}/developer/quickstart/${projectId}`);
    await page
      .getByRole("heading", { name: "Importar e consultar a NF-e de demonstração", exact: true })
      .waitFor();
    const commands = await page
      .getByRole("region", { name: "Variáveis no PowerShell" })
      .textContent();
    assert.ok(commands.includes(urls.site));
    const tab = await page.locator("main").textContent();
    assert.ok(tab.includes("X-Environment: sandbox"));
    assert.ok(tab.includes(companyId));
    assert.ok(!tab.includes(apiKey));
    await capture("quickstart-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("quickstart-mobile");
    for (const file of [
      "openapi.json",
      "quickstart.ts",
      "quickstart-curl.mjs",
      "sdk-webhook-receiver.mjs",
      "SDK.md",
    ])
      assert.equal((await fetch(`${site}/developer/${file}`)).status, 200);
    report.scenarios.push("quickstart-current-project-company-sandbox-downloads-desktop-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}?company=${companyId}&endpoint=${endpointId}`);
    await page.getByRole("heading", { name: "Receptor HTTPS sintético", exact: true }).waitFor();
  }

  await rpc("mutation", "projects:grantCompany", {
    organizationId: scope.organizationId,
    projectId,
    companyId,
    scopes: ["documents:read", "webhooks:manage"],
    environments: ["sandbox"],
    expectedVersion: 1,
  });
  await page.goto(`${base}?company=${companyId}&endpoint=${endpointId}`);
  await page.getByRole("button", { name: "Editar destino", exact: true }).click();
  const editForm = page.getByRole("region", { name: "Editar destino", exact: true });
  assert.equal(
    await editForm.getByRole("checkbox", { name: "Importação concluída", exact: true }).count(),
    0,
  );
  await editForm.getByRole("button", { name: "Salvar destino", exact: true }).click();
  await editForm.waitFor({ state: "detached" });
  const edited = await rest(`/v1/webhook-endpoints/${endpointId}`);
  assert.ok(!edited.events.includes("import.completed"));
  assert.equal(edited.events.length, 3);
  await capture("webhooks-revoked-subscription-edited");
  report.scenarios.push("revoked-import-scope-removes-hidden-subscription-on-edit");
  await page.getByRole("button", { name: "Editar destino", exact: true }).click();
  await editForm.getByLabel("Nome do destino", { exact: true }).fill("Rascunho anterior");
  const concurrent = await rest(`/v1/webhook-endpoints/${endpointId}`, "PATCH", {
    name: "Alterado por outro operador",
    url: edited.url,
    events: edited.events,
    active: edited.active,
    expectedVersion: edited.version,
  });
  await page.getByRole("heading", { name: concurrent.name, exact: true }).waitFor();
  await editForm.getByRole("button", { name: "Salvar destino", exact: true }).click();
  await editForm.getByRole("alert").waitFor({ timeout: 10_000 });
  const afterConflict = await rest(`/v1/webhook-endpoints/${endpointId}`);
  assert.equal(afterConflict.name, concurrent.name);
  assert.equal(afterConflict.version, concurrent.version);
  await editForm.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.getByRole("button", { name: "Editar destino", exact: true }).click();
  await editForm.getByLabel("Nome do destino", { exact: true }).fill("Edição atualizada");
  await editForm.getByRole("button", { name: "Salvar destino", exact: true }).click();
  await editForm.waitFor({ state: "detached" });
  assert.equal((await rest(`/v1/webhook-endpoints/${endpointId}`)).name, "Edição atualizada");
  report.scenarios.push("concurrent-edit-rejects-stale-form-and-reopens-current-version");
  assert.equal(report.browserError, undefined);
  assert.equal(fingerprint(), report.sourceFingerprint, "Source changed during proof");
  report.result = "passed";
} catch (error) {
  report.result = baseline && String(error).includes("BASELINE_CAPTURED") ? "baseline" : "failed";
  report.error = String(error);
  if (page && (await page.locator("#webhook-secret").count()) === 0)
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  if (report.result !== "baseline") process.exitCode = 1;
} finally {
  if (scope && apiKey) {
    try {
      const endpoints = await rest(`/v1/webhook-endpoints?companyId=${scope.companyId}`);
      for (const e of endpoints)
        await rest(`/v1/webhook-endpoints/${e.id}`, "PATCH", {
          name: e.name,
          url: e.url,
          events: e.events,
          active: false,
          expectedVersion: e.version,
        });
      report.endpointsDisabled = true;
    } catch {
      report.endpointsDisabled = false;
      process.exitCode = 1;
    }
  }
  if (scope && keyId && page)
    await rpc("mutation", "keys:revoke", {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      keyId,
    }).catch(() => {});
  console.log("target: local-anonymous, restoring disabled webhook transport");
  try {
    convexRun(paths, ["env", "set", "WEBHOOK_MODE", "disabled"], { capture: true });
    report.transportRestored = true;
  } catch {
    report.transportRestored = false;
    process.exitCode = 1;
  }
  tunnel?.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.receiver = receiver.inspect();
  receiver.close();
  await browser?.close();
  secrets = [];
  apiKey = undefined;
  report.sourceFingerprintAfter = fingerprint();
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
