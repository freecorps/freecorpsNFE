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
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";
import { currentOrganization, organizationOption, switchOrganization } from "./shell.mjs";
import { managementSession } from "./management-session.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "keys", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.ok(site && new URL(site).hostname === "localhost");
  const output = join(root, ".browser-results/keys");
  mkdirSync(output, { recursive: true });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  function sourceFingerprint() {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "apps",
        "platform",
        "packages",
        "scripts",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/)
      .sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file);
      hash.update(readFileSync(join(root, file)));
    }
    return hash.digest("hex");
  }
  const report = {
    codeSha: sha,
    runnerSha: sha,
    sourceFingerprint: sourceFingerprint(),
    runnerHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    environment: "anonymous-local",
    url: site,
    convexUrl: urls.cloud,
    schemaHash: createHash("sha256")
      .update(readFileSync(join(root, "platform/convex/schema.ts")))
      .digest("hex"),
    dataset:
      "two synthetic verified users; two organizations, two companies; projects and scoped keys; local account mail and invitation",
    result: "running",
    scenarios: [],
    accessibility: [],
    theme: null,
    rateLimits: [],
  };
  const finalization = createBrowserFinalization(report);
  const paginationOpts = { numItems: 50, cursor: null },
    contextKey = "browser-negative";
  const { rpc, localCode, authorization, success, create } = managementSession({
    urls,
    config,
    site,
    report,
    contextKey,
    visit,
  });
  let browser;
  const contexts = [];
  async function account(name) {
    // Local auth has one shared IP bucket. Keep independent real signup journeys outside its window.
    report.step = `local auth cooldown before ${name}`;
    console.log(report.step);
    await delay(30_000);
    await delay(31_000);
    report.step = `signup: ${name}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("response", (response) => {
      if (response.status() === 429)
        report.rateLimits.push({ path: new URL(response.url()).pathname, step: report.step });
    });
    const email = `org-${crypto.randomUUID()}@development.invalid`,
      password = `local-test-${crypto.randomUUID()}`;
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill(name);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    report.step = `verify: ${name}`;
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page
      .getByLabel("Código de oito dígitos")
      .fill(await localCode(email, "email-verification"));
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    report.step = `login: ${name}`;
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    const jwt = await page.evaluate(async () => {
      const { authClient } = await import("/src/auth.ts");
      return (await authClient.convex.token()).data?.token;
    });
    assert.ok(jwt);
    return { name, email, context, page, jwt };
  }
  async function capture(user, name) {
    const page = user.page;
    if (name === "projects-empty-desktop")
      await page.getByRole("heading", { name: "Projetos e integrações", exact: true }).waitFor();
    if (["project-granted-desktop", "project-mobile"].includes(name)) {
      await page.getByRole("heading", { name: "Configuração do projeto", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Remover acesso a Empresa Ipê Integrações", exact: true })
        .waitFor();
    }
    if (["keys-created-desktop", "keys-mobile"].includes(name))
      await page
        .getByRole("button", { name: "Revogar Exemplo sandbox", exact: true })
        .first()
        .waitFor();
    if (name === "key-create-desktop")
      await page.getByRole("button", { name: "Gerar chave", exact: true }).waitFor();
    if (name === "quickstart-desktop")
      await page
        .getByRole("heading", { name: "Primeira chamada em três passos", exact: true })
        .waitFor();
    assert.equal(
      await page.getByLabel("Segredo da chave", { exact: true }).count(),
      0,
      "Never capture a secret",
    );
    // The heading precedes paginated subscriptions. Capture actual rows, not their empty first render.
    for (const title of ["Acesso à empresa", "Histórico da empresa"]) {
      const section = user.page
        .locator("section.company-section")
        .filter({ has: user.page.getByRole("heading", { name: title, exact: true }) });
      if (await section.count()) await section.locator("li.member-row").first().waitFor();
    }
    await user.page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const result = await new AxeBuilder({ page: user.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    report.accessibility.push({
      page: name,
      violations: result.violations.map((v) => ({ id: v.id, impact: v.impact })),
    });
    assert.equal(result.violations.length, 0, `Accessibility: ${name}`);
    assert.ok(
      await user.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Overflow: ${name}`,
    );
  }
  async function visit(user, path) {
    report.step = `navigate: ${path}`;
    if (new URL(user.page.url()).pathname === path) return;
    const direct = user.page.locator(`a[href="${path}"]:visible`).first();
    if (await direct.count()) {
      await direct.click();
      await user.page.waitForURL(`${site}${path}`);
      return;
    }
    const match = path.match(
      /^\/app\/([^/]+)(?:\/(?:settings\/[^/]+|companies(?:\/[^/]+)?|onboarding))?$/,
    );
    const option = match ? await organizationOption(user.page, match[1]) : { listed: false };
    if (match && option.listed) {
      if (!option.checked) {
        await switchOrganization(user.page, match[1]);
        await user.page.waitForURL(`${site}/app/${match[1]}`);
      }
      if (new URL(user.page.url()).pathname === path) return;
      const link = user.page.locator(`a[href="${path}"]:visible`).first();
      if (await link.count()) {
        await link.click();
        await user.page.waitForURL(`${site}${path}`);
        return;
      }
    }
    // Unknown/forged routes intentionally enter by URL. Pace full reloads against local auth limits.
    await delay(8_000);
    await user.page.goto(`${site}${path}`);
  }
  async function call(secret, path = "/v1/companies", environment = "sandbox") {
    const response = await fetch(`${urls.site}${path}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": environment },
    });
    const body = await response.json();
    assert.equal(body.requestId, response.headers.get("x-request-id"));
    return { status: response.status, body };
  }
  // In-page orientations also link to sections; navigate through the project tabs.
  function projectTab(page, name) {
    return page
      .getByRole("navigation", { name: "Seções do projeto" })
      .getByRole("link", { name, exact: true });
  }
  function passed(name) {
    report.scenarios.push({ name, result: "passed" });
    console.log(name);
  }
  async function noSecret(user, secret) {
    assert.equal(await user.page.getByLabel("Segredo da chave").count(), 0);
    assert.equal((await user.page.content()).includes(secret), false);
    assert.equal(user.page.url().includes(secret), false);
    assert.equal(
      await user.page.evaluate(
        (value) =>
          [localStorage, sessionStorage].some((storage) =>
            Object.keys(storage).some((key) => storage.getItem(key)?.includes(value)),
          ),
        secret,
      ),
      false,
    );
  }
  try {
    browser = await chromium.launch({ headless: true });
    const owner = await account("Gestora de integrações"),
      page = owner.page;
    const org = await create(owner, "Equipe Ipê Integrações");
    const otherOrg = await success(owner, "mutation", "organizations:create", {
      name: "Outra equipe Ipê",
      slug: `other-${crypto.randomUUID()}`,
    });
    const company = await success(owner, "mutation", "companies:create", {
      organizationId: org.id,
      cnpj: "00000000000191",
      name: "Empresa Ipê Integrações",
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade sintética",
        state: "SP",
        postalCode: "00000000",
      },
    });
    await page.getByRole("link", { name: "Projetos e chaves", exact: true }).click();
    await page.getByRole("heading", { name: "Projetos e integrações" }).waitFor();
    await capture(owner, "projects-empty-desktop");
    await page.getByLabel("Nome do projeto", { exact: true }).fill("Integração Exemplo");
    await page.getByLabel("Referência do aplicativo").fill("exemplo");
    await page.getByRole("button", { name: "Criar projeto", exact: true }).click();
    await page.getByRole("heading", { name: "Integração Exemplo", exact: true }).waitFor();
    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    const scope = { organizationId: org.id, projectId };
    await page.getByLabel("Empresa", { exact: true }).selectOption(company.companyId);
    await page.getByRole("button", { name: "Salvar concessão", exact: true }).click();
    await page.getByRole("button", { name: "Remover acesso a Empresa Ipê Integrações" }).waitFor();
    await capture(owner, "project-granted-desktop");
    passed("UI creates project and explicit company/scope/environment grant");
    await projectTab(page, "Chaves de API").click();
    await page.getByRole("button", { name: "Criar chave", exact: true }).click();
    await page.getByLabel("Nome da chave", { exact: true }).fill("Exemplo sandbox");
    // The key inherits the project's grant: company and scope groups start selected.
    assert.equal(
      await page.getByLabel("Empresa Ipê Integrações", { exact: true }).isChecked(),
      true,
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Importar e consultar documentos", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(await page.getByRole("option", { name: /^Produção/ }).isDisabled(), true);
    await capture(owner, "key-create-desktop");
    await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
    const secretField = page.getByLabel("Segredo da chave", { exact: true });
    await secretField.waitFor();
    const secret = await secretField.inputValue();
    assert.ok(/^fnfe_[A-Za-z0-9_-]{43}$/.test(secret));
    const first = await call(secret);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 1);
    assert.equal(first.body.data[0].id, company.companyId);
    const curlBody = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "curl.exe" : "curl",
        ["--fail-with-body", "--silent", "--show-error", "--config", "-"],
        {
          input: `url = "${urls.site}/v1/companies?limit=20"\nheader = "Authorization: Bearer ${secret}"\nheader = "X-Environment: sandbox"\n`,
          encoding: "utf8",
          timeout: 15_000,
        },
      ),
    );
    assert.equal(curlBody.data[0].id, company.companyId);
    assert.ok(curlBody.requestId);
    report.curlReceipt = {
      companyCount: curlBody.data.length,
      requestId: curlBody.requestId,
      transport: "curl config via stdin; no secret in command line or receipt",
    };
    report.httpReceipt = {
      status: first.status,
      requestId: first.body.requestId,
      companyCount: first.body.data.length,
    };
    passed("UI-created key authenticates a real HTTP request to local Convex");
    assert.equal((await call(secret, `/v1/companies/${company.companyId}`)).status, 200);
    assert.equal((await call(secret, "/v1/companies/forged")).status, 404);
    assert.equal((await call(secret, "/v1/companies", "production")).status, 403);
    const foreign = await success(owner, "mutation", "companies:create", {
      organizationId: otherOrg.organizationId,
      cnpj: "00000000000191",
      name: "Empresa privada",
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade sintética",
        state: "SP",
        postalCode: "00000000",
      },
    });
    assert.equal((await call(secret, `/v1/companies/${foreign.companyId}`)).status, 404);
    passed("real REST denies foreign companies, forged IDs and wrong environment");
    await page.getByRole("button", { name: "Já guardei o segredo" }).click();
    await noSecret(owner, secret);
    await capture(owner, "keys-created-desktop");
    await projectTab(page, "Primeira chamada").click();
    await page.getByRole("heading", { name: "Primeira chamada em três passos" }).waitFor();
    await noSecret(owner, secret);
    const curlExample = await page.getByRole("region", { name: "Comando curl" }).textContent();
    assert.ok(curlExample.includes("COLE_O_SEGREDO_NO_SEU_AMBIENTE"));
    assert.ok(curlExample.includes('-H "X-Environment: sandbox"'));
    assert.equal(curlExample.includes("\n+"), false);
    await capture(owner, "quickstart-desktop");
    passed("quickstart uses placeholders and secret is absent from DOM, URL and browser storage");
    await projectTab(page, "Chaves de API").click();
    await noSecret(owner, secret);
    await page.getByRole("button", { name: "Rotacionar Exemplo sandbox", exact: true }).click();
    await page.getByLabel("Coexistência da chave anterior").selectOption("1");
    await page.getByRole("button", { name: "Confirmar rotação", exact: true }).click();
    await secretField.waitFor();
    const nextSecret = await secretField.inputValue();
    assert.ok(nextSecret !== secret);
    assert.equal((await call(secret)).status, 200);
    assert.equal((await call(nextSecret)).status, 200);
    await page.getByRole("button", { name: "Já guardei o segredo" }).click();
    await noSecret(owner, nextSecret);
    passed("UI rotation preserves both keys within selected coexistence window");
    // First row is the replacement. Revoke it through the actual confirmation flow.
    const row = page.getByRole("row").filter({ hasText: "Exemplo sandbox" }).first();
    await row.getByRole("button", { name: "Revogar Exemplo sandbox", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Revogar Exemplo sandbox?" })
      .getByRole("button", { name: "Confirmar revogação", exact: true })
      .click();
    await row.getByText("Revogada", { exact: true }).waitFor();
    assert.equal((await call(nextSecret)).status, 401);
    assert.equal((await call(secret)).status, 200);
    passed("UI revocation immediately refuses new calls with the replacement key");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(owner, "keys-mobile");
    await projectTab(page, "Empresas e acesso").click();
    await capture(owner, "project-mobile");
    const disable = page.getByRole("button", { name: "Desativar projeto", exact: true });
    await disable.click();
    const dialog = page.getByRole("alertdialog", { name: "Desativar Integração Exemplo?" });
    await dialog.waitFor();
    const focused = (locator) => locator.evaluate((element) => element === document.activeElement);
    assert.equal(await focused(dialog.getByRole("button", { name: "Manter ativo" })), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await focused(disable), true);
    passed("project deactivation asks for an accessible confirmation and returns focus");
    await page.getByRole("button", { name: "Remover acesso a Empresa Ipê Integrações" }).click();
    await page
      .getByRole("alertdialog", { name: "Remover o acesso a Empresa Ipê Integrações?" })
      .getByRole("button", { name: "Confirmar remoção", exact: true })
      .click();
    await page.getByText("O projeto ainda não tem acesso a empresas.", { exact: true }).waitFor();
    assert.equal((await call(secret, `/v1/companies/${company.companyId}`)).status, 404);
    await page.getByLabel("Empresa", { exact: true }).selectOption(company.companyId);
    await page.getByRole("button", { name: "Salvar concessão", exact: true }).click();
    await page.getByRole("button", { name: "Remover acesso a Empresa Ipê Integrações" }).waitFor();
    assert.equal((await call(secret, `/v1/companies/${company.companyId}`)).status, 404);
    passed("revoking/regranting a company through the UI never revives old keys");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await projectTab(page, "Chaves de API").click();
    await page.getByText("Concessões alteradas", { exact: true }).waitFor();
    for (const button of await page
      .getByRole("button", { name: "Rotacionar Exemplo sandbox", exact: true })
      .all())
      assert.equal(await button.isEnabled(), false);
    passed("key list reflects revoked grant epochs and disables unusable rotation");
    await page.getByRole("button", { name: "Criar chave", exact: true }).click();
    await page.getByLabel("Nome da chave", { exact: true }).fill("Contexto descartável");
    await page.getByLabel("Empresa Ipê Integrações", { exact: true }).check();
    await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
    await secretField.waitFor();
    const contextSecret = await secretField.inputValue();
    await switchOrganization(page, otherOrg.slug);
    await currentOrganization(page, "Outra equipe Ipê").waitFor();
    await noSecret(owner, contextSecret);
    await page.goBack();
    await page.getByRole("heading", { name: "Integração Exemplo", exact: true }).waitFor();
    await noSecret(owner, contextSecret);
    passed("organization switch and browser history discard a displayed secret");
    // Complete direct-route proof with pacing for the existing local auth IP bucket.
    await delay(30_000);
    await delay(31_000);
    await page.goto(`${site}/app/${org.slug}/developer/keys/invalid-project`);
    await page.getByRole("heading", { name: "Projeto indisponível.", exact: true }).waitFor();
    await capture(owner, "project-invalid-route");
    passed("invalid project URL renders the unavailable state without leaking private data");
    report.theme = await page.evaluate(() => ({
      ink: getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim(),
      font: getComputedStyle(document.documentElement).fontFamily,
    }));
    assert.equal(report.theme.ink, "#203b32");
    assert.ok(report.theme.font.includes("Geist"));
    const listed = await success(owner, "query", "keys:list", {
      ...scope,
      contextKey,
      paginationOpts,
    });
    assert.equal(JSON.stringify(listed).includes(contextSecret), false);
    assert.equal(JSON.stringify(listed).includes("keyHash"), false);
    passed("direct backend list excludes hashes/secrets and preserves console theme");
    const internalDenied = await rpc(
      "mutation",
      "rest:companies",
      {
        keyHash: createHash("sha256").update(contextSecret).digest("hex"),
        requestId: crypto.randomUUID(),
        environment: "sandbox",
        companyId: null,
        cursor: null,
        limit: 20,
      },
      await authorization(owner),
    );
    assert.equal(
      internalDenied.status,
      "error",
      "Internal REST implementation must reject direct client invocation",
    );
    passed("direct client calls cannot invoke internal REST authorization functions");
    const developer = await account("Pessoa desenvolvedora");
    await success(owner, "action", "invitations:send", {
      organizationId: org.id,
      email: developer.email,
      role: "developer",
    });
    await success(developer, "action", "invitations:accept", {
      token: await localCode(developer.email, "organization-invitation"),
    });
    const members = await success(owner, "query", "organizations:members", {
      organizationId: org.id,
      contextKey,
      paginationOpts,
    });
    const membership = members.page.find((m) => m.email === developer.email);
    assert.ok(membership);
    await success(owner, "mutation", "companies:setGrant", {
      organizationId: org.id,
      companyId: company.companyId,
      membershipId: membership.id,
      allowed: true,
      expectedMembershipVersion: membership.version,
      expectedGrantVersion: 0,
    });
    const devProject = await success(developer, "mutation", "projects:create", {
      organizationId: org.id,
      name: "Projeto concedido",
      externalReference: "developer",
    });
    const devScope = { organizationId: org.id, projectId: devProject.projectId };
    await success(developer, "mutation", "projects:grantCompany", {
      ...devScope,
      companyId: company.companyId,
      scopes: ["companies:read"],
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    await developer.page.goto(`${site}/app/${org.slug}/developer/keys/${devProject.projectId}`);
    await developer.page.getByRole("button", { name: "Criar chave", exact: true }).click();
    await developer.page.getByLabel("Nome da chave", { exact: true }).fill("Segredo do developer");
    await developer.page.getByLabel("Empresa Ipê Integrações", { exact: true }).check();
    await developer.page.getByRole("button", { name: "Gerar chave", exact: true }).click();
    await developer.page.getByLabel("Segredo da chave").waitFor();
    const devSecret = await developer.page.getByLabel("Segredo da chave").inputValue();
    await success(owner, "mutation", "companies:setGrant", {
      organizationId: org.id,
      companyId: company.companyId,
      membershipId: membership.id,
      allowed: false,
      expectedMembershipVersion: membership.version,
      expectedGrantVersion: 1,
    });
    await developer.page.getByLabel("Segredo da chave").waitFor({ state: "detached" });
    await noSecret(developer, devSecret);
    const hiddenKeys = await success(developer, "query", "keys:list", {
      ...devScope,
      contextKey,
      paginationOpts,
    });
    assert.equal(hiddenKeys.page.length, 0);
    assert.equal(
      (await call(devSecret)).status,
      200,
      "The organization still owns the project credential",
    );
    passed(
      "live company-grant loss clears the secret and hides key metadata without using a human session for REST",
    );
    await success(owner, "mutation", "organizations:removeMember", {
      organizationId: org.id,
      membershipId: membership.id,
      expectedVersion: membership.version,
    });
    await developer.page
      .getByRole("heading", { name: "Organização indisponível.", exact: true })
      .waitFor();
    await noSecret(developer, devSecret);
    await capture(developer, "membership-removed");
    const removed = await rpc(
      "query",
      "keys:list",
      { ...devScope, contextKey, paginationOpts },
      await authorization(developer),
    );
    assert.equal(removed.status, "error");
    passed("membership removal clears the open project page and denies direct backend access");
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.failure =
        error instanceof Error
          ? { name: error.name, message: error.message.slice(0, 1500) }
          : { name: "UnknownError", message: String(error).slice(0, 1500) };
      console.error(report.step, report.failure);
    });
  } finally {
    await finalization.attempt(() => {
      report.finalSourceFingerprint = sourceFingerprint();
      if (report.sourceFingerprint !== report.finalSourceFingerprint) {
        report.result = "failed";
        report.failure = {
          name: "SourceChanged",
          message: "Source files changed during the browser proof",
        };
      }
    });
    await finalization.attempt(() => {
      report.finishedAt = new Date().toISOString();
    });
    for (const context of contexts) await finalization.attempt(() => context.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n"),
    );
  }
  return report.result;
});
