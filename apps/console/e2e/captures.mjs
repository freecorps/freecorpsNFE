import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import { createHash } from "node:crypto";
import { distributionXml } from "../../../tests/helpers/distribution.ts";
import { fixture } from "../../../tests/helpers/nfe-corpus.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { referenceLocal } from "../../../scripts/lib/reference-local.mjs";
import { syntheticCertificate } from "../../../tests/helpers/certificates.ts";
import { localAuthPacer } from "./local-auth-pacing.mjs";
const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "captures", async () => {
  const { site, urls, rpc } = referenceLocal(root);
  const output = join(root, ".browser-results/captures");
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const report = {
    codeSha: git("rev-parse", "HEAD"),
    runnerSha256: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    schemaSha256: createHash("sha256")
      .update(readFileSync(join(root, "platform/convex/lib/captureSchema.ts")))
      .digest("hex"),
    dirty: !!git("status", "--porcelain"),
    environment: "anonymous-local",
    site,
    backend: urls.cloud,
    syntheticOnly: true,
    scenarios: [],
    accessibility: [],
    result: "running",
  };
  const finalization = createBrowserFinalization(report);
  let browser, context, page;
  /**
   * With the fiscal capture offered by the deployment, Produção comes first and the Sandbox is a
   * collapsed block (#432): open it, so the journey reads the Sandbox in both setups.
   */
  async function openSandbox() {
    const block = page.locator("details.capture-sandbox");
    if ((await block.count()) && !(await block.evaluate((el) => el.open)))
      await block.locator(":scope > summary").click();
  }
  async function capture(name) {
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    report.accessibility.push({ name, violations: axe.violations.map((v) => v.id) });
    assert.equal(axe.violations.length, 0, name);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: "pt-BR",
    });
    await localAuthPacer(report)(context);
    page = await context.newPage();
    page.setDefaultTimeout(90000);
    const suffix = crypto.randomUUID().slice(0, 8),
      email = `capture-${suffix}@development.invalid`,
      password = crypto.randomUUID() + "aA1!";
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste certificados");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    const verification = await until(async () => {
      const mails = await rpc("query", "mail:inbox", { email });
      return mails.find((m) => m.type === "email-verification");
    });
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Código de oito dígitos").fill(verification.otp);
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    let jwt,
      jwtAt = 0;
    const human = async (kind, path, args) => {
      if (Date.now() - jwtAt > 40_000) {
        jwt = await page.evaluate(async () => {
          const { authClient } = await import("/src/auth.ts");
          return (await authClient.convex.token()).data.token;
        });
        jwtAt = Date.now();
      }
      return rpc(kind, path, args, `Bearer ${jwt}`);
    };
    const org = await human("mutation", "organizations:create", {
      name: "Certificados de teste",
      slug: `capture-${suffix}`,
    });
    let cnpj = "99" + String(Date.now()).slice(-10);
    for (const weights of [
      [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
      [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    ]) {
      const remainder =
        cnpj.split("").reduce((sum, digit, i) => sum + Number(digit) * weights[i], 0) % 11;
      cnpj += remainder < 2 ? "0" : String(11 - remainder);
    }
    const company = await human("mutation", "companies:create", {
      organizationId: org.organizationId,
      cnpj,
      name: "Empresa sintética A1",
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
        postalCode: "01000000",
      },
    });
    const scope = { organizationId: org.organizationId, companyId: company.companyId };
    // The company page opens each area in its own tab (`?aba=`).
    const companyUrl = `${site}/app/${org.slug}/companies/${company.companyId}?aba=captura`;
    await page.goto(companyUrl);
    await page.getByRole("heading", { name: "Empresa sintética A1" }).waitFor();
    // Console sem projeto: the company page controls the capture directly. The project and its
    // grant below serve only the integration's key.
    const project = await human("mutation", "projects:create", {
      organizationId: org.organizationId,
      name: "Captura de teste",
      externalReference: `capture-${suffix}`,
    });
    const captureScope = { ...scope, environment: "sandbox" };
    const scopes = ["connections:read", "connections:write", "documents:read"];
    await human("mutation", "projects:grantCompany", {
      ...scope,
      projectId: project.projectId,
      scopes,
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    await page.getByRole("tab", { name: "Captura", exact: true }).waitFor();
    await openSandbox();
    await page
      .getByText("A captura ainda não foi ativada para esta empresa.", { exact: true })
      .waitFor();
    await capture("before-activation");
    const material = syntheticCertificate({ cnpj });
    await page.getByRole("tab", { name: "Certificado", exact: true }).click();
    await page.getByLabel("Arquivo A1/PFX").setInputFiles({
      name: "synthetic.pfx",
      mimeType: "application/x-pkcs12",
      buffer: material.pfx,
    });
    await page
      .getByLabel("Senha do certificado", { exact: true })
      .fill(material.password.toString());
    await page.getByRole("button", { name: "Enviar para validação", exact: true }).click();
    await page.getByText("Validado para uso no serviço", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Captura", exact: true }).click();
    await openSandbox();
    await page.getByRole("button", { name: "Ativar captura no sandbox", exact: true }).click();
    // The reason and what to do, in plain words (#432); the same reason in the query's row of
    // the last queries (#433).
    const sandboxReason =
      "O Sandbox não consulta a Receita: a consulta fiscal está desligada neste ambiente.";
    await page.getByText(sandboxReason, { exact: true }).first().waitFor();
    await page
      .getByRole("group", { name: "Últimas consultas" })
      .getByRole("row")
      .filter({ hasText: "Não concluída" })
      .filter({ hasText: sandboxReason })
      .waitFor();
    await page.getByText("O que fazer:", { exact: true }).first().waitFor();
    let stream = await human("query", "captures:get", captureScope);
    const bytes = distributionXml({
      envelopes: [
        { nsu: 1, xml: fixture("summary-authorized") },
        { nsu: 2, xml: fixture("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
      ],
    });
    report.datasetSha256 = createHash("sha256").update(bytes).digest("hex");
    await rpc("mutation", "testing/captureProof:set", {
      streamId: stream.id,
      xml: bytes.toString(),
    });
    // Only a loopback synthetic source can shorten its own clock for this proof.
    await rpc("mutation", "testing/captureProof:allowNow", { streamId: stream.id });
    await page.getByRole("button", { name: "Retomar captura", exact: true }).click();
    async function until(predicate) {
      for (let i = 0; i < 120; i++) {
        const value = await predicate();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("Capture did not settle");
    }
    await until(
      async () =>
        (await rpc("query", "testing/captureProof:inspect", { streamId: stream.id })).stream
          .checkpoint === "000000000000002",
    );
    const first = await rpc("query", "testing/captureProof:inspect", { streamId: stream.id });
    assert.equal(first.calls, 1);
    assert.equal(first.envelopes.length, 2);
    assert.equal(first.stream.checkpoint, "000000000000002");
    assert.ok(first.stream.nextAllowedAt > Date.now());
    assert.ok(first.audit.some((a) => a.action === "checkpoint_committed" && a.batchId));
    report.scenarios.push("native-raw-envelopes-before-monotonic-checkpoint");
    const key = await human("action", "keys:create", {
      organizationId: org.organizationId,
      projectId: project.projectId,
      name: "Captura sintética",
      scopes,
      environment: "sandbox",
      companyIds: [company.companyId],
      expiresAt: Date.now() + 3600_000,
    });
    async function rest(path, body) {
      const response = await fetch(`${urls.site}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${key.secretOnce}`,
          "X-Environment": "sandbox",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    }
    // The console activated the stream in the console project: the integration's key neither sees
    // nor controls it (it keeps reading the captured documents of the company).
    assert.equal(await rest(`/v1/connections/nfe?companyId=${company.companyId}`), null);
    report.scenarios.push("console-stream-belongs-to-console-project-invisible-to-key");
    // Within the source's window the panel does not offer a new consultation and says until when,
    // with the time the server recorded. Waiting for the reason first lets the stream load.
    // The reason's id is per panel (sandbox and production share the page): read the one that
    // speaks of the source's window.
    const reason = page
      .locator(".ui-disabled-reason")
      .filter({ hasText: /próxima consulta a partir de/ });
    await reason.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Sincronizar", exact: true }).isDisabled(),
      true,
    );
    const syncReason = (await reason.textContent()) ?? "";
    assert.match(syncReason, /próxima consulta a partir de/);
    report.syncReason = syncReason;
    report.scenarios.push("sync-waits-for-next-allowed-consultation");
    // Pausing asks for confirmation first (#431); the dialog ignores the opening gesture briefly.
    await page.getByRole("button", { name: "Pausar captura", exact: true }).click();
    const pause = page.getByRole("alertdialog", { name: "Pausar a captura?" });
    // Its settle time counts from when it opened; wait it out after it is on the page.
    await pause.waitFor();
    await page.waitForTimeout(400);
    await pause.getByRole("button", { name: "Pausar captura", exact: true }).click();
    // On the badge (and, collapsed, on the block's summary).
    await page.getByText("Captura pausada", { exact: true }).first().waitFor();
    await page.getByText("Nenhuma: consultas automáticas pausadas", { exact: true }).waitFor();
    await capture("paused-desktop");
    await page.getByRole("button", { name: "Retomar captura", exact: true }).click();
    await page.getByText("Captura ativa", { exact: true }).first().waitFor();
    const latest = await rpc("query", "testing/captureProof:inspect", { streamId: stream.id });
    assert.equal(latest.calls, 1);
    assert.equal(latest.stream.nextAllowedAt, first.stream.nextAllowedAt);
    assert.equal(latest.stream.checkpoint, first.stream.checkpoint);
    report.scenarios.push("browser-sync-pause-resume-preserve-global-cooldown");
    const documents = await until(async () => {
      const result = await rest(
        `/v1/documents?companyId=${company.companyId}&source=distribution-xml`,
      );
      return result.page?.length === 1 && result.page[0].completeness === "full-xml"
        ? result
        : null;
    });
    assert.equal(documents.page.length, 1);
    assert.equal(documents.page[0].source, "distribution-xml");
    const detail = await rest(
      `/v1/documents/${documents.page[0].id}?companyId=${company.companyId}`,
    );
    assert.equal(detail.summary.source, "distribution-xml");
    assert.equal(detail.version.source, "distribution-xml");
    const original = await fetch(
      `${urls.site}/v1/document-artifacts/${detail.version.artifactId}/original?companyId=${company.companyId}`,
      { headers: { Authorization: `Bearer ${key.secretOnce}`, "X-Environment": "sandbox" } },
    );
    assert.equal(original.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await original.arrayBuffer()))
        .digest("hex"),
      createHash("sha256").update(fixture("invoice-authorized")).digest("hex"),
    );
    report.scenarios.push("captured-summary-and-xml-become-one-logical-document");
    report.scenarios.push("private-original-download-preserves-received-hash");
    report.observed = {
      checkpoint: latest.stream.checkpoint,
      envelopes: latest.envelopes.length,
      sourceCalls: latest.calls,
      cooldownPreserved: true,
      documents: documents.page.length,
    };
    await page.reload();
    await page.getByRole("tab", { name: "Captura", exact: true }).waitFor();
    await openSandbox();
    await page.getByText("Captura ativa", { exact: true }).first().waitFor();
    // One live region, saying changes of situation only (#432); copy buttons answer their click.
    assert.equal(
      await page.evaluate(
        () =>
          [...document.querySelectorAll("main [role='status'], main [aria-live]")].filter(
            (region) => !region.classList.contains("ui-copy__feedback"),
          ).length,
      ),
      1,
    );
    report.scenarios.push("single-live-region-for-the-capture-situation");
    await capture("active-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("active-mobile");
    report.scenarios.push("direct-reload-reactive-state-mobile-accessibility");
    stream = await human("query", "captures:get", captureScope);
    await human("mutation", "captures:control", {
      ...captureScope,
      action: "pause",
      expectedVersion: stream.version,
    });
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.error = error instanceof Error ? error.message : "unknown";
      await finalization.attempt(() =>
        page?.screenshot({ path: join(output, "failure.png"), fullPage: true }),
      );
    });
  } finally {
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() => console.log(JSON.stringify(report)));
    await finalization.attempt(() =>
      writeFileSync(join(output, "browser.json"), JSON.stringify(report, null, 2) + "\n"),
    );
  }
  return report.result;
});
