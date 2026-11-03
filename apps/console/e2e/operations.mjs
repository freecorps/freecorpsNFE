import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { referenceLocal } from "../../../scripts/lib/reference-local.mjs";
import { localAuthPacer } from "./local-auth-pacing.mjs";
const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "operations", async () => {
  const { site, urls, rpc } = referenceLocal(root);
  const output = join(root, ".browser-results/operations");
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const fingerprint = () =>
    createHash("sha256")
      .update(
        git(
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "platform/convex",
          "apps/console/src",
          "patches",
        )
          .split(/\r?\n/)
          .filter((p) => /\.(ts|tsx|css|patch)$/.test(p))
          .sort((a, b) => a.localeCompare(b))
          .map((p) => readFileSync(join(root, p)))
          .join("\n"),
      )
      .digest("hex");
  const report = {
    codeSha: git("rev-parse", "HEAD"),
    dirty: !!git("status", "--porcelain"),
    runnerSha256: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    fingerprint: fingerprint(),
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
  const pageErrors = [];
  async function until(fn) {
    for (let i = 0; i < 100; i++) {
      const value = await fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Controlled state timed out");
  }
  async function capture(name) {
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    report.accessibility.push({
      name,
      violations: result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    });
    assert.equal(result.violations.length, 0, name);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "horizontal overflow",
    );
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: "pt-BR",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await localAuthPacer(report)(context);
    page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const suffix = crypto.randomUUID().slice(0, 8),
      email = `operations-${suffix}@development.invalid`,
      password = crypto.randomUUID() + "aA1!";
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste operações");
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

    const apiKey = `fnfe_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const scope = await rpc("mutation", "testing/observabilityProof:prepare", {
      email,
      keyHash: createHash("sha256").update(apiKey).digest("hex"),
      suffix: `ops-${suffix}`,
    });
    await page.goto(`${site}/app/${scope.slug}/operations`);
    await page.getByRole("heading", { name: "Operação e suporte", exact: true }).waitFor();
    await capture("before-monitor");
    const response = await fetch(`${urls.site}/v1/operations/${scope.operationId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Environment": "sandbox",
        "X-Request-Id": "synthetic-injected-reference",
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.requestId, response.headers.get("X-Request-Id"));
    assert.notEqual(body.requestId, "synthetic-injected-reference");
    await page.getByLabel("Referência da solicitação, operação ou evento").fill(body.requestId);
    await page.getByRole("button", { name: "Investigar", exact: true }).click();
    await page.getByRole("heading", { name: "Operação: Na fila", exact: true }).waitFor();
    await page.getByRole("button", { name: "Copiar referência", exact: true }).first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), body.requestId);
    const investigation = await human("query", "observability:investigate", {
      organizationId: scope.organizationId,
      reference: body.requestId,
      contextKey: "native-proof",
    });
    assert.ok(investigation.some((r) => r.operationId === scope.operationId));
    const safe = await human("query", "observability:operation", {
      organizationId: scope.organizationId,
      operationId: scope.operationId,
    });
    assert.equal("result" in safe, false);
    assert.ok(!JSON.stringify(investigation).includes(apiKey));
    assert.ok(!JSON.stringify(investigation).includes("must-never-appear"));
    report.scenarios.push("http-reference-to-native-audit-and-safe-operation-and-copy");
    await page.getByRole("button", { name: "Configurar monitoramento", exact: true }).click();
    await page.getByLabel("Projeto", { exact: true }).selectOption(scope.projectId);
    await page.getByLabel("Empresa", { exact: true }).selectOption(scope.companyId);
    await page.getByRole("button", { name: "Salvar monitor", exact: true }).click();
    await page.getByText("Monitor ativo", { exact: true }).waitFor();
    await page.getByRole("heading", { name: /^Atraso da fila · / }).waitFor();
    await capture("incident-desktop");
    const overviewArgs = { organizationId: scope.organizationId, contextKey: "native-proof" };
    const first = await human("query", "observability:overview", overviewArgs);
    assert.equal(first.alerts.length, 1);
    assert.equal(first.notifications.length, 1);
    // The operation came from an API key: the console explains that the integration controls it
    // (INTEGRATION_RECORD) and the pause goes through the integration's REST API.
    await page.getByRole("button", { name: "Pausar operação", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Criado pela integração" }).waitFor();
    const paused = await fetch(`${urls.site}/v1/operations/${scope.operationId}/pause`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedGeneration: body.data.generation }),
    });
    assert.equal(paused.status, 200);
    await page.getByRole("heading", { name: "Operação: Pausada", exact: true }).waitFor();
    await rpc("mutation", "observability:evaluate", {
      monitorId: first.monitors[0]._id,
      generation: first.monitors[0].generation,
    });
    await until(async () => {
      const state = await human("query", "observability:overview", overviewArgs);
      return state.alerts.length === 0 && state.notifications.length === 2 ? state : null;
    });
    await page.locator(".ui-badge").filter({ hasText: "Alerta recuperado" }).first().waitFor();
    report.scenarios.push("native-scheduler-alert-open-authorized-pause-recovery-and-dedup");
    await page.reload();
    await page.getByRole("heading", { name: "Operação e suporte", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("recovered-mobile");
    await page.setViewportSize({ width: 1440, height: 1100 });
    await capture("recovered-desktop");
    await page.getByLabel("Ação", { exact: true }).fill("alert.recovered");
    await page.getByRole("button", { name: "Filtrar auditoria", exact: true }).click();
    // The filtered trail shows the readable action; the raw code stays in "Detalhes técnicos".
    const audit = page.getByRole("region", { name: "Auditoria" });
    await audit
      .locator("strong")
      .filter({ hasText: /^Alerta recuperado$/ })
      .first()
      .waitFor();
    await audit
      .locator("code")
      .filter({ hasText: /^alert\.recovered$/ })
      .first()
      .waitFor({ state: "attached" });
    report.scenarios.push("indexed-filter-direct-route-reload-mobile-and-accessibility");
    const beforeEdit = (await human("query", "observability:overview", overviewArgs)).monitors[0];
    await human("mutation", "observability:configure", {
      organizationId: beforeEdit.organizationId,
      projectId: beforeEdit.projectId,
      companyId: beforeEdit.companyId,
      environment: beforeEdit.environment,
      ownerMembershipId: scope.lateOwnerId,
      enabled: false,
      notify: true,
      thresholds: beforeEdit.thresholds,
      expectedGeneration: beforeEdit.generation,
    });
    await page.getByText("Monitor pausado", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Editar monitor", exact: true }).click();
    assert.equal(
      await page.getByLabel("Responsável", { exact: true }).inputValue(),
      scope.lateOwnerId,
    );
    await page.getByRole("button", { name: "Salvar monitor", exact: true }).click();
    await page
      .getByRole("heading", { name: "Configuração do monitor", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      (await human("query", "observability:overview", overviewArgs)).monitors[0].ownerMembershipId,
      scope.lateOwnerId,
    );
    await page.getByRole("button", { name: "Editar monitor", exact: true }).click();
    await page
      .getByRole("form", { name: "Configuração do monitor" })
      .getByRole("button", { name: "Carregar mais", exact: true })
      .click();
    await page.getByRole("heading", { name: "Configuração do monitor", exact: true }).waitFor();
    await page.getByRole("button", { name: "Fechar configuração", exact: true }).click();
    report.scenarios.push("preserves-owner-beyond-first-page-and-pagination-does-not-submit");
    // Exercise the real component under a read budget, with expired rows inserted last.
    for (let offset = 0; offset < 1000; offset += 100)
      await rpc("mutation", "testing/observabilityProof:seedAuthBuckets", {
        suffix,
        offset,
        count: 100,
        expired: false,
      });
    await rpc("mutation", "testing/observabilityProof:seedAuthBuckets", {
      suffix,
      offset: 1000,
      count: 5,
      expired: true,
    });
    report.authCleanup = await rpc("mutation", "testing/observabilityProof:authCleanup", {});
    assert.equal(report.authCleanup.count, 5);
    assert.ok(report.authCleanup.documentsRead <= 100);
    report.scenarios.push(
      "native-lastRequest-cleanup-five-expired-among-one-thousand-recent-under-read-budget",
    );
    const latest = await human("query", "observability:overview", overviewArgs),
      m = latest.monitors[0];
    await human("mutation", "observability:configure", {
      organizationId: m.organizationId,
      projectId: m.projectId,
      companyId: m.companyId,
      environment: m.environment,
      ownerMembershipId: m.ownerMembershipId,
      enabled: false,
      notify: m.notify,
      thresholds: m.thresholds,
      expectedGeneration: m.generation,
    });
    await rpc("mutation", "testing/operationProof:retire", { keyId: scope.keyId });
    assert.deepEqual(pageErrors, []);
    assert.equal(fingerprint(), report.fingerprint, "sources changed during proof");
    report.result = "passed";
    report.observed = {
      referenceCorrelated: true,
      alertsOpened: 1,
      alertsRecovered: 1,
      notifications: 2,
      apiKeyRevoked: true,
      monitorStopped: true,
    };
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.pageErrors = pageErrors;
      report.error = error instanceof Error ? error.message : String(error);
      await finalization.attempt(() =>
        page?.screenshot({ path: join(output, "failure.png"), fullPage: true }),
      );
    });
  } finally {
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() =>
      console.log(
        JSON.stringify({
          result: report.result,
          error: report.error,
          scenarios: report.scenarios,
          authCleanup: report.authCleanup,
        }),
      ),
    );
    await finalization.attempt(() =>
      writeFileSync(join(output, "browser.json"), JSON.stringify(report, null, 2) + "\n", "utf8"),
    );
  }
  return report.result;
});
