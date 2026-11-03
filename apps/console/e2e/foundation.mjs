import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { localAuthPacer } from "./local-auth-pacing.mjs";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";
import { signOutButton } from "./shell.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "foundation", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config);
  const site = currentLocalSiteUrl(paths);
  assert.ok(site);
  const output = join(root, ".browser-results/foundation");
  mkdirSync(output, { recursive: true });
  const email = `foundation-${crypto.randomUUID()}@development.invalid`;
  const password = `local-test-${crypto.randomUUID()}`;
  const newPassword = `local-reset-${crypto.randomUUID()}`;
  const report = {
    codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    environment: "anonymous-local",
    result: "running",
    scenarios: [],
    accessibility: [],
    rateLimits: [],
  };
  const finalization = createBrowserFinalization(report);
  async function rpc(kind, path, args, extra = {}) {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json", ...extra }),
    });
    const body = await response.json();
    assert.equal(body.status, "success", `Local operation ${path} failed`);
    return body.value;
  }
  async function code(type) {
    const messages = await rpc("query", "mail:inbox", { email });
    const message = messages.find((m) => m.type === type);
    assert.ok(message, "Expected local account message");
    return message.otp;
  }
  const paceAuth = localAuthPacer(report);
  let browser, context, page, oldContext;
  function observeLimits(target) {
    target.on("response", (response) => {
      if (response.status() === 429)
        report.rateLimits.push({ path: new URL(response.url()).pathname });
    });
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
  async function login(target, value) {
    await target.goto(`${site}/login`);
    await target.getByLabel("E-mail", { exact: true }).fill(email);
    await target.getByLabel("Senha", { exact: true }).fill(value);
    await target.getByRole("button", { name: "Entrar no painel" }).click();
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await paceAuth(context);
    observeLimits(context);
    page = await context.newPage();
    // Keep this independent runner outside authentication traffic from a preceding browser suite.
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Conta de demonstração");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await capture("signup");
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", {
        exact: false,
      })
      .waitFor();
    await login(page, password);
    await page.getByRole("alert").filter({ hasText: "Verifique seu e-mail" }).waitFor();
    report.scenarios.push("unverified-signin-rejected");
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Código de oito dígitos").fill(await code("email-verification"));
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    await login(page, password);
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    await capture("account");
    report.scenarios.push("signup-verification-real-convex-profile");
    for (const screen of [
      "onboarding",
      "importacao",
      "documento",
      "empresa",
      "certificado",
      "captura",
    ]) {
      await page.goto(`${site}/console/prototipo/${screen}?role=owner`);
      await page.getByText("Protótipo navegável", { exact: true }).waitFor();
      await capture(screen);
      await page.getByRole("button", { name: "Simular erro desta etapa" }).click();
      await page.getByRole("alert").waitFor();
      await page.getByRole("button", { name: "Voltar ao exemplo sem erro" }).click();
    }
    await page.goto(`${site}/console/prototipo/onboarding?role=owner`);
    await page.getByRole("link", { name: "Continuar para importação" }).click();
    await page.getByRole("link", { name: "Abrir resultado de exemplo" }).click();
    await page.getByRole("button", { name: "Simular documento apenas com resumo" }).click();
    await page.getByText("Apenas resumo", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Explorar jornada de captura" }).click();
    await page.getByRole("link", { name: "Examinar etapa de certificado" }).click();
    await page.getByRole("link", { name: "Examinar controles de captura" }).click();
    await page.getByText("Captura desativada", { exact: true }).waitFor();
    await page.getByLabel("Simular papel na organização").selectOption("viewer");
    await page.getByRole("heading", { name: "Esta ação exige outro papel." }).waitFor();
    await page.getByRole("link", { name: "Consultar documento de exemplo" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("document-mobile");
    report.scenarios.push("both-navigable-journeys-errors-summary-role-navigation-mobile");
    oldContext = await browser.newContext();
    await paceAuth(oldContext);
    observeLimits(oldContext);
    const oldPage = await oldContext.newPage();
    await login(oldPage, password);
    await oldPage.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    await page.goto(`${site}/forgot-password`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Solicitar código", exact: true }).click();
    await page.getByRole("link", { name: "Informar código de recuperação" }).click();
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Código de oito dígitos").fill(await code("forget-password"));
    await page.getByLabel("Nova senha", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Salvar nova senha" }).click();
    await page
      .getByText("Senha atualizada. Entre novamente com a nova senha.", { exact: true })
      .waitFor();
    await oldPage.reload();
    await oldPage.getByRole("heading", { name: "Entre para continuar." }).waitFor();
    await login(page, password);
    await page.getByRole("alert").filter({ hasText: "Confira seu e-mail e senha" }).waitFor();
    await page.getByLabel("Senha", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    report.scenarios.push("password-reset-old-password-and-second-browser-session-rejected");
    await oldContext.close();
    const tab = await context.newPage();
    await tab.goto(`${site}/console`);
    await tab.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    await (await signOutButton(page)).click();
    // "Sair" ends at the landing; the console no longer opens for this browser.
    await page.waitForURL((address) => address.pathname === "/");
    await page.goto(`${site}/console`);
    await page.getByRole("heading", { name: "Entre para continuar." }).waitFor();
    await tab.bringToFront();
    await tab.getByRole("heading", { name: "Entre para continuar." }).waitFor();
    report.scenarios.push("logout-and-other-tab-session-cleared");
    await page.goto(`${site}/missing-foundation-page`);
    await page.getByRole("heading", { name: "Página não encontrada." }).waitFor();
    await capture("not-found-mobile");
    const xml = readFileSync(join(root, "packages/fiscal-nfe/fixtures/minimal.xml"), "utf8");
    const extracted = await rpc("action", "xml:extract", { xml });
    assert.equal(JSON.parse(extracted.json).items[0].unitPrice, "12.3456789012");
    assert.match(extracted.runtime, /^v24\./);
    report.scenarios.push(`xml-real-node-action-${extracted.runtime}`);
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      // Avoid URLs, mail addresses, credentials, codes and raw traces in the public receipt.
      report.failedAfter = report.scenarios.length;
      await finalization.attempt(async () => {
        try {
          await page?.screenshot({ path: join(output, "failure-private.png"), fullPage: true });
        } catch (error) {
          report.diagnosticCaptureFailed = true;
          throw error;
        }
      });
    });
  } finally {
    await finalization.attempt(() => oldContext?.close());
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() => console.log(JSON.stringify(report)));
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    );
  }
  finalization.throwIfFailed();
  return report.result;
});
