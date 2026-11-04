import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { localAuthPacer } from "./local-auth-pacing.mjs";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";
import { processNfe } from "../../../packages/fiscal-nfe/dist/index.js";
import { usageJourney } from "./usage.mjs";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "imports", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.equal(new URL(site).hostname, "localhost");
  const documentsMode = process.argv.includes("--documents");
  const usageMode = process.argv.includes("--usage");
  const output = join(
    root,
    usageMode
      ? ".browser-results/usage"
      : documentsMode
        ? ".browser-results/documents"
        : ".browser-results/imports",
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
    dirty: Boolean(git("status", "--porcelain")),
    sourceFingerprint: fingerprint(),
    runnerHash: hash(readFileSync(fileURLToPath(import.meta.url))),
    schemaHash: hash(
      Buffer.concat([
        readFileSync(join(root, "platform/convex/schema.ts")),
        readFileSync(join(root, "platform/convex/lib/importSchema.ts")),
        // `importSchema.ts` takes the version's card and content format from here.
        readFileSync(join(root, "platform/convex/lib/documentValues.ts")),
        ...(documentsMode
          ? [readFileSync(join(root, "platform/convex/lib/documentSchema.ts"))]
          : []),
      ]),
    ),
    environment: "anonymous-local",
    url: site,
    convexUrl: urls.cloud,
    dataset:
      "synthetic demo NF-e 55, unknown schema; verified local user, demonstration company, scoped API key",
    result: "running",
    scenarios: [],
    accessibility: [],
    receipts: [],
    browserFailures: [],
  };
  const finalization = createBrowserFinalization(report);
  function observeBrowser(context) {
    context.on("requestfailed", (request) => {
      if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
      report.browserFailures.push({
        kind: "requestfailed",
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      });
    });
    context.on("response", (response) => {
      if (response.status() < 400) return;
      if (!["document", "script", "stylesheet"].includes(response.request().resourceType())) return;
      report.browserFailures.push({
        kind: "response",
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) =>
        report.browserFailures.push({ kind: "pageerror", message: error.message }),
      );
    });
  }
  let browser, context, page;
  let jwt, apiKey;
  async function rpc(kind, path, args, admin = false, reuseToken = false) {
    if (!admin && (!reuseToken || !jwt))
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
    });
    const body = await response.json();
    assert.equal(body.status, "success", `${path}: ${body.errorMessage ?? "failed"}`);
    return body.value;
  }
  async function capture(name) {
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    report.accessibility.push({
      page: name,
      violations: result.violations.map((v) => ({ id: v.id, impact: v.impact })),
    });
    assert.equal(result.violations.length, 0, `Accessibility: ${name}`);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Horizontal overflow: ${name}`,
    );
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
    });
    const data = await response.json();
    assert.ok([200, 202].includes(response.status), `${path}: ${JSON.stringify(data.error)}`);
    return data.data;
  }
  /** A console batch belongs to the console project: read it with the session, not the key. */
  async function settled(importId, fromConsole = false) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const value = fromConsole
        ? await rpc("query", "imports:get", { importId })
        : await rest(`/v1/imports/${importId}`);
      if (value.files.every((file) => ["succeeded", "failed", "paused"].includes(file.state)))
        return value;
      await delay(1000);
    }
    throw new Error("Import processing did not settle");
  }
  /** Console sem projeto: the screen works on the company; no project is chosen. */
  async function selectScope(scope) {
    await page.getByLabel("Empresa participante do XML").selectOption(scope.companyId);
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    observeBrowser(context);
    const paceAuth = localAuthPacer(report);
    await paceAuth(context);
    page = await context.newPage();
    const backend = await rpc("query", "testing/importProof:ready", {}, true);
    assert.equal(backend, "imports-published-history/2");
    report.backendReadiness = backend;
    if (documentsMode)
      report.documentReadiness = await rpc("query", "testing/documentProof:ready", {}, true);
    console.log("imports: signup and verification");
    const email = `import-${crypto.randomUUID()}@development.invalid`,
      password = `synthetic-${crypto.randomUUID()}`;
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa da importação");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    const mail = await rpc("query", "mail:inbox", { email }, true);
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page
      .getByLabel("Código de oito dígitos")
      .fill(mail.find((m) => m.type === "email-verification").otp);
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    await page.goto(`${site}/console/prototipo/importacao?role=owner`);
    await page.getByText("Protótipo navegável", { exact: true }).waitFor();
    await capture("prototype-reference");
    console.log("imports: organization, demo company and project through authenticated functions");
    const org = await rpc("mutation", "organizations:create", {
      name: "Equipe XML sintético",
      slug: `xml-${crypto.randomUUID()}`,
      ...(await termsAcceptance((path, args) => rpc("query", path, args))),
    });
    const { companyId } = await rpc("mutation", "onboarding:start", {
      organizationId: org.organizationId,
      mode: "demonstration",
      expectedVersion: 0,
    });
    // The project and its grant serve only the API key; the console needs neither.
    const { projectId } = await rpc("mutation", "projects:create", {
      organizationId: org.organizationId,
      name: "Importação de demonstração",
      externalReference: crypto.randomUUID(),
    });
    const scope = {
      organizationId: org.organizationId,
      companyId,
      environment: "sandbox",
    };
    // Journeys that also drive the API key need its project; the console scope does not carry it.
    const integration = { ...scope, integrationProjectId: projectId };
    await rpc("mutation", "projects:grantCompany", {
      organizationId: org.organizationId,
      projectId,
      companyId,
      scopes:
        documentsMode || usageMode ? ["documents:import", "documents:read"] : ["documents:import"],
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    const key = await rpc("action", "keys:create", {
      organizationId: org.organizationId,
      projectId,
      name: "Prova XML",
      scopes:
        documentsMode || usageMode ? ["documents:import", "documents:read"] : ["documents:import"],
      environment: "sandbox",
      companyIds: [companyId],
      expiresAt: Date.now() + 3600000,
    });
    apiKey = key.secretOnce;
    // Record only the import journey, after credentials and verification codes leave the screen.
    const authenticatedState = await context.storageState();
    await context.close();
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      storageState: authenticatedState,
      recordVideo: { dir: join(output, "video"), size: { width: 1024, height: 712 } },
    });
    observeBrowser(context);
    await paceAuth(context);
    page = await context.newPage();
    await page.goto(`${site}/app/${org.slug}/imports?company=invalid&batch=invalid`);
    await page.getByRole("heading", { name: "Importar XML", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Empresa indisponível", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Empresa participante do XML").inputValue(), "");
    await page.goto(`${site}/app/${org.slug}/imports?company=${companyId}&batch=invalid`);
    await page.getByLabel("Arraste os XMLs aqui ou escolha os arquivos").waitFor();
    await page.getByRole("button", { name: "Importar arquivos", exact: true }).waitFor();
    report.scenarios.push("malformed-url-selectors-recover-with-empty-selection");
    await page.goto(`${site}/app/${org.slug}/imports`);
    await selectScope(scope);
    await capture("imports-empty-desktop");
    const bytes = readFileSync(join(root, "apps/console/public/examples/nfe-demonstracao.xml")),
      sha256 = hash(bytes);
    const unknown = Buffer.from('<desconhecido versao="9.99"/>');
    const inputs = [
      { name: "demonstracao.xml", mimeType: "application/xml", buffer: bytes },
      { name: "desconhecido.xml", mimeType: "application/xml", buffer: unknown },
    ];
    const filesInput = () => page.getByLabel("Arraste os XMLs aqui ou escolha os arquivos");
    const resume = page.getByRole("button", { name: "Retomar esta importação", exact: true });
    // A request lost before the server stores the XML: the file stays reserved. After a reload
    // the browser has no copy, so the row asks for it, and resuming sends it once.
    const pending = {
      name: "pendente.xml",
      mimeType: "application/xml",
      buffer: Buffer.from('<desconhecido versao="9.98"/>'),
    };
    let pendingUploads = 0;
    await context.route("**/v1/import-upload", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      pendingUploads++;
      return pendingUploads === 1 ? route.abort("failed") : route.continue();
    });
    await filesInput().setInputFiles([pending]);
    await page.getByRole("button", { name: "Importar arquivos", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "O envio de pendente.xml parou sem resposta" })
      .waitFor();
    await capture("imports-upload-lost-before-server");
    const pendingUrl = page.url();
    assert.ok(new URL(pendingUrl).searchParams.get("batch"));
    await page.reload();
    const pendingRow = page.locator(".fiscal-import-file").filter({ hasText: "pendente.xml" });
    await pendingRow
      .getByText("Selecione de novo o XML original pendente.xml", { exact: false })
      .waitFor();
    assert.equal(await resume.isDisabled(), true);
    await filesInput().setInputFiles([pending]);
    await resume.click();
    await page.locator(".fiscal-import-summary").filter({ hasText: "1 recusado" }).waitFor();
    assert.equal(pendingUploads, 2, "Resuming sends the reserved XML exactly once more");
    assert.equal(page.url(), pendingUrl);
    await context.unroute("**/v1/import-upload");
    report.scenarios.push("upload-lost-before-server-asks-for-the-xml-after-refresh");
    await page.getByRole("button", { name: "Nova importação", exact: true }).click();
    await page.getByRole("button", { name: "Importar arquivos", exact: true }).waitFor();
    // The server stores the first XML but its answer is lost: the panel reads the persisted state
    // and confirms it in the same run, without sending the bytes again and without an alert.
    let lostResponse = false,
      demonstrationUploads = 0;
    await context.route("**/v1/import-upload", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (hash(route.request().postDataBuffer() ?? Buffer.alloc(0)) === sha256)
        demonstrationUploads++;
      if (lostResponse) return route.continue();
      lostResponse = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    });
    await filesInput().setInputFiles(inputs);
    await page.getByRole("button", { name: "Importar arquivos", exact: true }).click();
    // The unknown XML is a refusal in words, never "concluído"; the batch is partial.
    await page
      .locator(".fiscal-import-summary")
      .filter({ hasText: "Parcial" })
      .filter({ hasText: "1 importado · 1 recusado" })
      .waitFor();
    const lostBatch = new URL(page.url()).searchParams.get("batch");
    assert.ok(lostBatch && lostBatch !== new URL(pendingUrl).searchParams.get("batch"));
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(demonstrationUploads, 1, "A stored XML is confirmed, never sent again");
    await capture("imports-upload-response-lost");
    await context.unroute("**/v1/import-upload");
    report.scenarios.push("lost-upload-response-confirmed-without-resend");
    await page.getByText("Importado", { exact: true }).waitFor();
    const refused = page
      .locator('.fiscal-import-file[data-tone="danger"]')
      .filter({ hasText: "desconhecido.xml" });
    await refused.getByText("XML recusado", { exact: true }).waitFor();
    await refused.getByText("Código para suporte:", { exact: false }).waitFor();
    assert.equal(await refused.getByRole("button", { name: /Reprocessar/ }).count(), 0);
    report.scenarios.push("refused-xml-toned-with-code-detail-and-no-useless-reprocess");
    await capture("imports-partial-desktop");
    // The batch whose answer was lost, from its URL: the recent list also holds pendente.xml.
    const fromUi = await settled(lostBatch, true);
    const hidden = await fetch(`${urls.site}/v1/imports/${lostBatch}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Environment": "sandbox" },
    });
    assert.equal(hidden.status, 404, "The integration key must not read a console batch");
    report.scenarios.push("console-batch-in-console-project-invisible-to-key");
    assert.equal(fromUi.files[0].code, "IMPORTED");
    assert.match(fromUi.files[1].code, /UNSUPPORTED/);
    const proof = JSON.parse(
      await rpc("query", "testing/importProof:inspect", { fileId: fromUi.files[0].id }, true),
    );
    const processed = JSON.parse(fromUi.files[0].result),
      expected = processNfe(bytes, {
        source: "imported-xml",
        evaluatedAt: processed.signature.evaluatedAt,
      });
    assert.deepEqual(processed.checks, expected.checks);
    assert.deepEqual(processed.metadata, expected.metadata);
    assert.deepEqual(
      {
        ...processed.document,
        products: proof.versions[0].items.map((item) => JSON.parse(item.data)),
      },
      expected.normalized.document,
    );
    report.scenarios.push(
      "real-browser-upload-partial-success",
      "package-panel-normalized-items-equivalent",
    );
    await page.reload();
    await page
      .locator(".fiscal-import-summary")
      .filter({ hasText: "1 importado · 1 recusado" })
      .waitFor();
    // The recent list reads as a list: date, files, result and origin of each batch.
    await page
      .locator(".fiscal-recent-imports > li")
      .filter({ hasText: "2 arquivos · 1 importado · 1 recusado" })
      .filter({ hasText: "Console" })
      .waitFor();
    report.scenarios.push("refresh-recovers-results", "recent-imports-readable");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("imports-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The demonstration company imports its own example in one step, through the same upload
    // as a chosen file (#510). The note is already there, so the server says DUPLICATE.
    await page.getByRole("button", { name: "Nova importação", exact: true }).click();
    let exampleUploads = 0;
    await context.route("**/v1/import-upload", async (route) => {
      if (
        route.request().method() === "POST" &&
        hash(route.request().postDataBuffer() ?? Buffer.alloc(0)) === sha256
      )
        exampleUploads++;
      return route.continue();
    });
    await page.getByRole("button", { name: "Importar o XML de exemplo", exact: true }).click();
    await page.locator(".fiscal-import-summary").filter({ hasText: "1 importado" }).waitFor();
    await page.getByText("Nota já importada antes; nada foi duplicado", { exact: true }).waitFor();
    const exampleBatch = new URL(page.url()).searchParams.get("batch");
    assert.ok(exampleBatch && exampleBatch !== lostBatch);
    assert.equal(exampleUploads, 1, "The example is the public file, sent once");
    await context.unroute("**/v1/import-upload");
    await capture("imports-example-duplicate");
    report.scenarios.push("demonstration-example-imported-in-one-step-through-the-real-upload");
    console.log("imports: API duplicate and storage evidence");
    const intent = crypto.randomUUID(),
      request = { companyId, files: [{ name: "demonstracao.xml", size: bytes.length, sha256 }] };
    const reserved = await rest("/v1/imports", "POST", request, intent),
      replay = await rest("/v1/imports", "POST", request, intent);
    assert.equal(replay.importId, reserved.importId);
    assert.equal(replay.reused, true);
    const path = `/v1/imports/${reserved.importId}/files/${reserved.fileIds[0]}`;
    const ticket = await rest(`${path}/upload`, "POST");
    const uploaded = await fetch(ticket.url, {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: bytes,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    await rest(`${path}/confirm`, "POST");
    const duplicate = await settled(reserved.importId);
    assert.equal(duplicate.files[0].documentId, fromUi.files[0].documentId);
    assert.equal(duplicate.files[0].code, "DUPLICATE");
    assert.deepEqual(JSON.parse(duplicate.files[0].result).document, processed.document);
    report.scenarios.push(
      "api-panel-same-logical-document",
      "api-idempotency-replays-reservation",
      "api-package-panel-equivalence",
    );
    const finalProof = JSON.parse(
      await rpc("query", "testing/importProof:inspect", { fileId: duplicate.files[0].id }, true),
    );
    assert.equal(finalProof.artifact.sha256, sha256);
    assert.equal(finalProof.artifact.size, bytes.length);
    assert.ok(!JSON.stringify(duplicate).includes(finalProof.artifact.storageId));
    const original = await rpc(
      "action",
      "testing/importProof:original",
      { fileId: duplicate.files[0].id },
      true,
    );
    assert.deepEqual(original, { sha256, size: bytes.length });
    const metadata = await rpc(
      "query",
      "testing/importProof:storage",
      { storageId: finalProof.artifact.storageId },
      true,
    );
    assert.equal(metadata.contentType, "application/vnd.freecorps.import+xml");
    const orphan = await rpc("action", "testing/importProof:orphan", {}, true);
    await rpc("mutation", "importUpload:sweep", { cursor: null, before: Date.now() + 1000 }, true);
    // The sweep reads 50 blobs per page and schedules the next one: in a local database with
    // more storage than that (earlier runs), the orphan goes on a later page.
    let orphanLeft;
    for (let attempt = 0; attempt < 60; attempt++) {
      orphanLeft = await rpc("query", "testing/importProof:storage", { storageId: orphan }, true);
      if (orphanLeft === null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(orphanLeft, null);
    assert.deepEqual(
      await rpc("action", "testing/importProof:original", { fileId: duplicate.files[0].id }, true),
      original,
    );
    report.scenarios.push(
      "native-private-original-bytes-and-sha256",
      "native-orphan-cleanup-preserves-linked-original",
    );
    report.receipts.push(
      { importId: lostBatch, results: fromUi },
      { importId: reserved.importId, results: duplicate },
      {
        originalSha256: sha256,
        size: bytes.length,
        documentId: finalProof.document._id,
        itemCount: proof.versions[0].items.length,
      },
    );
    console.log("imports: two native processing versions and public history");
    const oldKey = processed.document.key,
      base = oldKey.slice(0, 25) + "000000071" + oldKey.slice(34, 43);
    let sum = 0;
    for (let i = base.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
      sum += (base.charCodeAt(i) - 48) * weight;
    const digit = String(sum % 11 < 2 ? 0 : 11 - (sum % 11)),
      newKey = base + digit;
    // New synthetic identity; remove the old synthetic signature instead of implying that it authenticates changed bytes.
    const historicalBytes = Buffer.from(
      bytes
        .toString("utf8")
        .replace(/<Signature\b[\s\S]*?<\/Signature>/, "")
        .replaceAll(oldKey, newKey)
        .replace("<nNF>69</nNF>", "<nNF>71</nNF>")
        .replace(/<cDV>\d<\/cDV>/, `<cDV>${digit}</cDV>`),
    );
    assert.equal(processNfe(historicalBytes).checks.identity.status, "passed");
    const historical = await rest("/v1/imports", "POST", {
      companyId,
      files: [
        { name: "historico.xml", size: historicalBytes.length, sha256: hash(historicalBytes) },
      ],
    });
    const historicalPath = `/v1/imports/${historical.importId}/files/${historical.fileIds[0]}`;
    const historicalTicket = await rest(`${historicalPath}/upload`, "POST");
    assert.equal(
      (
        await fetch(historicalTicket.url, {
          method: "POST",
          headers: { "X-Upload-Token": historicalTicket.token },
          body: historicalBytes,
        })
      ).status,
      200,
    );
    await rpc(
      "mutation",
      "testing/importProof:confirmV1",
      { fileId: historical.fileIds[0], keyHash: hash(apiKey) },
      true,
    );
    const v1 = await settled(historical.importId),
      v1Result = v1.files[0].result;
    assert.ok(!Object.hasOwn(JSON.parse(v1Result), "fiscalSituation"));
    const reprocess = await rest(`${historicalPath}/reprocess`, "POST", {}, "native-version-two");
    const v2 = await settled(historical.importId),
      history = await rest(`${historicalPath}/history`);
    assert.equal(history.length, 2);
    assert.equal(history[0].processorVersion, "xml-import/3");
    assert.equal(history[1].processorVersion, "xml-import/1");
    assert.equal(history[1].result, v1Result);
    assert.ok(Object.hasOwn(JSON.parse(v2.files[0].result), "fiscalSituation"));
    assert.equal(v2.files[0].documentId, v1.files[0].documentId);
    assert.deepEqual(
      await rpc("action", "testing/importProof:original", { fileId: historical.fileIds[0] }, true),
      { sha256: hash(historicalBytes), size: historicalBytes.length },
    );
    const versionProof = JSON.parse(
      await rpc("query", "testing/importProof:inspect", { fileId: historical.fileIds[0] }, true),
    );
    assert.equal(versionProof.document.publishedVersionId, v2.files[0].versionId);
    report.receipts.push({ originalSha256: hash(historicalBytes), v1, v2, history, reprocess });
    report.scenarios.push(
      "native-v1-v2-original-and-prior-result-preserved",
      "reprocess-public-result-and-history-updated",
    );
    if (usageMode)
      await usageJourney({
        page,
        site,
        urls,
        scope,
        slug: org.slug,
        apiKey,
        bytes,
        file: fromUi.files[0],
        rpc,
        capture,
        report,
        output,
      });
    if (documentsMode)
      await (
        await import("./documents.mjs")
      ).documentsJourney({
        page,
        site,
        urls,
        scope: integration,
        slug: org.slug,
        keyId: key.keyId,
        apiKey,
        bytes,
        file: fromUi.files[0],
        rest,
        rpc,
        capture,
        report,
        output,
      });
    else
      await rpc("mutation", "keys:revoke", {
        organizationId: org.organizationId,
        projectId,
        keyId: key.keyId,
      });
    apiKey = undefined;
    assert.equal(fingerprint(), report.sourceFingerprint, "Source changed during browser proof");
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.error = String(error);
      if (page) {
        report.failurePath = new URL(page.url()).pathname;
        if (report.failurePath.startsWith("/app/")) {
          await finalization.attempt(() =>
            page.screenshot({ path: join(output, "failure.png"), fullPage: true }),
          );
          report.failureText = "unavailable";
          await finalization.attempt(async () => {
            report.failureText = await page.locator("body").innerText();
          });
        }
      }
    });
  } finally {
    await finalization.attempt(() => {
      report.sourceFingerprintAfter = fingerprint();
    });
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => page?.video()?.saveAs(join(output, "imports.webm")));
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n"),
    );
  }
  finalization.throwIfFailed();
  return report.result;
});
