// A tarefa escolhida na landing atravessa o cadastro (#510): "Começar no sandbox" abre
// `/signup?redirect=/console?tarefa=importar`, a verificação no mesmo cartão entra sozinha,
// `/console` leva a tarefa à lista de organizações e a primeira organização abre o Início com
// "Importar XML" escolhida. Com a sessão aberta, a mesma chamada leva direto ao Início.
import { withLocalBrowser } from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { localAuthPacer } from "./local-auth-pacing.mjs";
import { managementSession } from "./management-session.mjs";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "task-entry", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.ok(site && new URL(site).hostname === "localhost");
  const output = join(root, ".browser-results/task-entry");
  mkdirSync(output, { recursive: true });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const report = {
    codeSha: sha,
    runnerHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    environment: "anonymous-local",
    url: site,
    dataset: "one synthetic account; one organization",
    result: "running",
    scenarios: [],
    addresses: [],
  };
  const { localCode } = managementSession({
    urls,
    config,
    site,
    report,
    contextKey: "task-entry",
    visit: () => {},
  });
  const paceAuth = localAuthPacer(report);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await paceAuth(context);
    const page = await context.newPage();
    const address = () => {
      const url = new URL(page.url());
      return url.pathname + url.search;
    };

    report.step = "landing";
    await page.goto(`${site}/`);
    await page.getByRole("link", { name: "Começar no sandbox" }).first().click();
    await page.waitForURL((url) => url.pathname === "/signup");
    assert.equal(address(), "/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar");
    report.addresses.push(address());

    report.step = "signup";
    const email = `tarefa-${crypto.randomUUID()}@development.invalid`,
      password = `local-test-${crypto.randomUUID()}`;
    await page.getByLabel("Seu nome").fill("Pessoa de demonstração");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    report.step = "verify";
    // O mesmo cartão pede o código quando o servidor aceita o cadastro; o e-mail local chega
    // logo depois, então a caixa é lida com o campo na tela e repetida por um instante.
    const codeField = page.getByLabel("Código de oito dígitos");
    await codeField.waitFor();
    const code = await (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await localCode(email, "email-verification");
        } catch (error) {
          if (attempt >= 20) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    })();
    await codeField.fill(code);
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    // Sem organização: `/console` leva a tarefa à lista que cria a primeira.
    await page.waitForURL((url) => url.pathname === "/app");
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    assert.equal(address(), "/app?tarefa=importar");
    report.addresses.push(address());

    report.step = "create organization";
    const slug = `tarefa-${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel("Nome da organização", { exact: true }).fill("Equipe da tarefa");
    await page.getByLabel("Endereço da organização").fill(slug);
    await page.getByRole("checkbox", { name: /Li e aceito os termos de uso/ }).check();
    await page.getByRole("button", { name: "Criar organização", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/app/${slug}`);
    assert.equal(address(), `/app/${slug}?tarefa=importar`);
    report.addresses.push(address());
    const choice = page.getByRole("radio", { name: /Importar XML/ });
    await choice.waitFor();
    assert.equal(await choice.isChecked(), true);
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), `fnfe:console-task:${slug}`),
      "importar",
    );
    await page.screenshot({ path: join(output, "inicio-importar.png"), fullPage: true });
    report.scenarios.push("landing-signup-verify-create-organization-opens-importar");

    report.step = "signed-in entry";
    await page.goto(`${site}/`);
    await page.getByRole("link", { name: "Criar conta", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/app/${slug}`);
    assert.equal(address(), `/app/${slug}?tarefa=importar`);
    report.addresses.push(address());
    await page.getByRole("radio", { name: /Importar XML/ }).waitFor();
    report.scenarios.push("signed-in-entry-goes-straight-to-inicio");
    report.result = "passed";
  } catch (error) {
    report.failure = error instanceof Error ? error.name : "UnknownError";
    report.result = "failed";
    console.error(error instanceof Error ? error.message : error);
  } finally {
    await browser?.close().catch(() => {});
    console.log(JSON.stringify({ ...report, authTraffic: undefined }));
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report.result;
});
