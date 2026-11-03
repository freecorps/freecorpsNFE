import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import { withLocalBrowser } from "../../../scripts/lib/local-browser.mjs";
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
import { organizationOption, switchOrganization } from "./shell.mjs";
import { managementSession, managementSessionHash } from "./management-session.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "companies", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.ok(site && new URL(site).hostname === "localhost");
  const visualOnly = process.argv.includes("--visual-only");
  const output = join(
    root,
    visualOnly ? ".browser-results/companies-visual" : ".browser-results/companies",
  );
  mkdirSync(output, { recursive: true });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const report = {
    codeSha: sha,
    runnerSha: sha,
    runnerHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    managementSessionHash,
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    environment: "anonymous-local",
    url: site,
    convexUrl: urls.cloud,
    schemaHash: createHash("sha256")
      .update(readFileSync(join(root, "platform/convex/schema.ts")))
      .digest("hex"),
    dataset: visualOnly
      ? "one synthetic verified user; one organization; one numeric company; visual confirmation"
      : "two synthetic verified users; three organizations; numeric and alphanumeric companies; local invitations only",
    result: "running",
    scenarios: [],
    accessibility: [],
    theme: null,
    rateLimits: [],
  };
  const finalization = createBrowserFinalization(report);
  const paginationOpts = { numItems: 50, cursor: null },
    contextKey = "browser-negative";
  const { rpc, localCode, authorization, success, denied, create, send, accept } =
    managementSession({
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
    await delay(61_000);
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
    // The heading precedes paginated subscriptions. Capture actual rows, not their empty first render.
    for (const title of ["Acesso à empresa", "Histórico da empresa"]) {
      const section = user.page.getByRole("region", { name: title, exact: true });
      // The header row comes first; wait for a data row.
      if (await section.count()) await section.getByRole("row").nth(1).waitFor();
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
    // The organization menu collapses on narrow screens; only visible links are clickable.
    const direct = user.page.locator(`a[href="${path}"]`).filter({ visible: true }).first();
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
      const link = user.page.locator(`a[href="${path}"]`).filter({ visible: true }).first();
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

  const address = {
    street: "Rua sintética",
    number: "1",
    complement: "",
    district: "Centro",
    city: "Cidade sintética",
    state: "SP",
    postalCode: "00000000",
  };
  async function fillCompany(user, cnpj, name) {
    await user.page.getByLabel("CNPJ", { exact: true }).fill(cnpj);
    // The registration starts with the CNPJ; these cases fill the rest manually, without lookup.
    await user.page.getByRole("button", { name: "Preencher manualmente", exact: true }).click();
    await user.page.getByLabel("Nome da empresa", { exact: true }).fill(name);
    for (const [field, label] of Object.entries({
      street: "Logradouro",
      number: "Número",
      complement: "Complemento (opcional)",
      district: "Bairro",
      city: "Município",
      state: "UF",
      postalCode: "CEP",
    })) {
      await user.page.getByLabel(label, { exact: true }).fill(address[field]);
    }
  }
  async function phase(name) {
    report.step = name;
    console.log(name);
    await delay(61_000);
  }
  const companyPath = (org, id) => "/app/" + org.slug + "/companies/" + id;
  try {
    browser = await chromium.launch({ headless: true });
    if (visualOnly) {
      const owner = await account("Gestora visual de empresas");
      const org = await create(owner, "Equipe Ipê Empresas");
      await visit(owner, "/app/" + org.slug + "/companies");
      await owner.page.getByRole("button", { name: "Cadastrar empresa", exact: true }).click();
      await fillCompany(owner, "00.000.000/0001-91", "Empresa Ipê Atualizada");
      await owner.page.getByRole("button", { name: "Salvar empresa" }).click();
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      await capture(owner, "company-desktop");
      await owner.page.setViewportSize({ width: 390, height: 844 });
      await capture(owner, "company-mobile");
      await visit(owner, "/app/" + org.slug + "/companies");
      await owner.page
        .getByRole("link", { name: "Empresa Ipê Atualizada", exact: false })
        .waitFor();
      await capture(owner, "companies-mobile");
      await owner.page.setViewportSize({ width: 1440, height: 1000 });
      await capture(owner, "companies-desktop");
      await visit(owner, "/app/" + org.slug + "/onboarding");
      await owner.page
        .getByRole("link", { name: "Empresa Ipê Atualizada", exact: false })
        .waitFor();
      await owner.page.getByLabel("Empresa dos primeiros passos").waitFor();
      await capture(owner, "onboarding-desktop");
      await owner.page.setViewportSize({ width: 390, height: 844 });
      await capture(owner, "onboarding-mobile");
      await phase("malformed company URL on authenticated visual session");
      await visit(owner, "/app/" + org.slug + "/companies/not-an-id");
      await owner.page
        .getByRole("heading", { name: "Empresa indisponível.", exact: true })
        .waitFor();
      await capture(owner, "company-invalid-route");
      report.scenarios.push(
        "visual-captures-wait-for-paginated-member-and-audit-rows",
        "desktop-mobile-accessibility-and-overflow",
        "malformed-company-url-renders-unavailable-without-generic-error",
      );
      report.result = "passed";
    } else {
      const owner = await account("Gestora de empresas"),
        operator = await account("Operadora de empresas");
      const a = await create(owner, "Equipe Ipê Empresas"),
        b = await create(owner, "Equipe Oliveira Empresas"),
        c = await create(operator, "Equipe Araucária Empresas");
      await phase("manual onboarding and numeric company");
      await visit(owner, "/app/" + a.slug + "/onboarding");
      // The choice leads straight to the registration form, focused on its heading.
      await owner.page
        .getByRole("button", { name: "Cadastrar minha empresa", exact: true })
        .click();
      await owner.page.waitForURL(`${site}/app/${a.slug}/companies#cadastrar-empresa`);
      await owner.page
        .getByRole("heading", { name: "Cadastrar uma empresa.", exact: true })
        .waitFor();
      assert.deepEqual(
        await owner.page.evaluate(() => [
          document.activeElement?.tagName,
          document.activeElement?.textContent,
        ]),
        ["H2", "Cadastrar uma empresa."],
      );
      await capture(owner, "onboarding-manual-empty");
      await fillCompany(owner, "00000000000190", "Empresa Ipê Numérica");
      await owner.page.getByRole("button", { name: "Salvar empresa" }).click();
      await owner.page.getByRole("alert").filter({ hasText: "dígitos verificadores" }).waitFor();
      await owner.page.getByLabel("CNPJ", { exact: true }).fill("00.000.000/0001-91");
      await owner.page.getByRole("button", { name: "Salvar empresa" }).click();
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Numérica", exact: true })
        .waitFor();
      const a1 = new URL(owner.page.url()).pathname.split("/").at(-1);
      const get = (user, org, id) =>
        success(user, "query", "companies:get", {
          organizationId: org.id,
          companyId: id,
          contextKey,
        });
      const first = await get(owner, a, a1);
      assert.equal(first.cnpj, "00000000000191");
      assert.equal(first.registryStatus, "not-consulted");
      assert.equal(first.fiscalAccess, "not-configured");
      await capture(owner, "company-numeric-desktop");
      await visit(owner, "/app/" + a.slug + "/companies");
      await owner.page.getByRole("button", { name: "Cadastrar empresa", exact: true }).click();
      await fillCompany(owner, "00000000000191", "Tentativa sem sobrescrever");
      await owner.page.getByRole("button", { name: "Salvar empresa" }).click();
      await owner.page
        .getByRole("status")
        .filter({ hasText: "Os dados existentes foram preservados" })
        .waitFor();
      await owner.page.getByRole("link", { name: "Ver empresa cadastrada", exact: true }).click();
      assert.equal(new URL(owner.page.url()).pathname, companyPath(a, a1));
      assert.equal((await get(owner, a, a1)).name, first.name);
      const auth = await authorization(owner);
      const concurrent = await Promise.all(
        [0, 1].map(() =>
          rpc(
            "mutation",
            "companies:create",
            {
              organizationId: a.id,
              cnpj: "12.ABC.345/01DE-35",
              name: "Empresa Ipê Alfanumérica",
              address,
            },
            auth,
          ),
        ),
      );
      assert.ok(concurrent.every((r) => r.status === "success"));
      assert.equal(concurrent[0].value.companyId, concurrent[1].value.companyId);
      assert.equal(concurrent.filter((r) => r.value.reused).length, 1);
      const a2 = concurrent[0].value.companyId;
      assert.equal((await get(owner, a, a2)).cnpj, "12ABC34501DE35");
      report.scenarios.push(
        "numeric-leading-zero-valid-and-invalid-dv-through-ui",
        "repeated-ui-create-recovers-same-company-without-overwrite",
        "concurrent-alphanumeric-create-exactly-once",
      );
      // The cadastro opens in read mode; "Editar cadastro" opens the form.
      const edit = () => owner.page.getByRole("button", { name: "Editar cadastro", exact: true });
      await edit().click();
      await owner.page.getByLabel("Nome da empresa", { exact: true }).fill("Rascunho privado");
      await owner.page.getByLabel("Empresa atual").selectOption(a2);
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Alfanumérica", exact: true })
        .waitFor();
      assert.equal(await owner.page.getByLabel("Nome da empresa", { exact: true }).count(), 0);
      await edit().click();
      assert.equal(
        await owner.page.getByLabel("Nome da empresa", { exact: true }).inputValue(),
        "Empresa Ipê Alfanumérica",
      );
      await owner.page.getByLabel("Empresa atual").selectOption(a1);
      await owner.page.getByRole("heading", { name: first.name, exact: true }).waitFor();
      await edit().click();
      assert.equal(
        await owner.page.getByLabel("Nome da empresa", { exact: true }).inputValue(),
        first.name,
      );
      await owner.page
        .getByLabel("Nome da empresa", { exact: true })
        .fill("Empresa Ipê Atualizada");
      await owner.page.getByRole("button", { name: "Salvar alterações" }).click();
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      assert.equal(await owner.page.getByLabel("CNPJ", { exact: true }).count(), 0);
      report.scenarios.push(
        "company-switch-discards-private-draft",
        "confirmed-update-preserves-immutable-cnpj",
      );
      await phase("resume onboarding and demonstration without certificate");
      await visit(owner, "/app/" + a.slug + "/onboarding");
      await owner.page.getByLabel("Empresa dos primeiros passos").selectOption(a2);
      await owner.page.getByRole("link", { name: "Empresa Ipê Alfanumérica" }).waitFor();
      await owner.page.reload();
      await owner.page
        .getByRole("heading", { name: "Comece pela sua empresa.", exact: true })
        .waitFor();
      assert.equal(await owner.page.getByLabel("Empresa dos primeiros passos").inputValue(), a2);
      await owner.page.getByRole("button", { name: "Dispensar orientação", exact: true }).click();
      await owner.page.getByText("Orientação dispensada.", { exact: false }).waitFor();
      await owner.page.getByText("Aguardando importação", { exact: true }).waitFor();
      await visit(owner, "/app/" + b.slug + "/onboarding");
      await owner.page.getByRole("button", { name: "Explorar demonstração" }).click();
      await owner.page.getByText("Empresa preparada", { exact: true }).waitFor();
      await capture(owner, "onboarding-demonstration");
      const demo = await success(owner, "query", "onboarding:get", {
        organizationId: b.id,
        contextKey,
      });
      assert.equal(demo.certificateRequired, false);
      assert.equal(demo.firstDocument, "pending-import");
      assert.notEqual(demo.company.id, a2);
      await owner.page.getByRole("link", { name: "Empresa de demonstração" }).first().click();
      await owner.page
        .getByText("Dados sintéticos para explorar o sandbox.", { exact: false })
        .waitFor();
      assert.equal(await owner.page.getByRole("button", { name: "Salvar alterações" }).count(), 0);
      assert.equal(await owner.page.getByRole("button", { name: "Editar cadastro" }).count(), 0);
      await capture(owner, "company-demonstration");
      report.scenarios.push(
        "onboarding-selection-survives-reload",
        "dismiss-guidance-does-not-complete-first-document",
        "sandbox-demonstration-without-pfx",
        "same-cnpj-independent-between-organizations",
      );
      await phase("company grants and tenant isolation");
      const own = await success(operator, "mutation", "companies:create", {
        organizationId: c.id,
        cnpj: "00000000000191",
        name: "Empresa Araucária Privada",
        address,
      });
      const token = await send(owner, a, operator, "operator");
      await accept(operator, token, a);
      await visit(operator, companyPath(a, a1));
      await operator.page
        .getByRole("heading", { name: "Empresa indisponível.", exact: true })
        .waitFor();
      assert.equal(await get(operator, a, a1), null);
      await visit(owner, companyPath(a, a1));
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      await owner.page.getByRole("tab", { name: "Acesso", exact: true }).click();
      await owner.page.waitForURL(`${site}${companyPath(a, a1)}?aba=acesso`);
      const row = owner.page
        .getByRole("row")
        .filter({ has: owner.page.getByText(operator.email, { exact: true }) });
      await row.getByRole("button", { name: "Conceder acesso", exact: true }).click();
      await operator.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      assert.equal((await get(operator, a, a1)).capabilities.operateDocuments, true);
      const visible = await success(operator, "query", "companies:list", {
        organizationId: a.id,
        contextKey,
        paginationOpts,
      });
      assert.deepEqual(
        visible.page.map((company) => company.id),
        [a1],
      );
      assert.equal(await get(operator, a, a2), null);
      await denied(operator, "query", "companies:get", {
        organizationId: b.id,
        companyId: demo.company.id,
        contextKey,
      });
      assert.equal(await get(operator, a, own.companyId), null);
      await denied(operator, "mutation", "companies:update", {
        organizationId: a.id,
        companyId: a1,
        name: "Ataque",
        address,
        expectedVersion: 2,
      });
      assert.equal(
        await operator.page.getByRole("heading", { name: "Acesso à empresa", exact: true }).count(),
        0,
      );
      await capture(operator, "company-operator-granted");
      await visit(operator, companyPath(c, own.companyId));
      await operator.page
        .getByRole("heading", { name: "Empresa Araucária Privada", exact: true })
        .waitFor();
      await visit(operator, companyPath(a, a1));
      await operator.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      await phase("record authenticated company revocation");
      // Warm a known adjacent SPA entry; switching organizations also inserts its overview.
      await operator.page.getByRole("link", { name: "Todas as empresas", exact: true }).click();
      await operator.page.getByRole("heading", { name: "Empresas", exact: true }).waitFor();
      await operator.page.goBack();
      await operator.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      // Record only an already-authenticated view, never account or invitation secrets.
      const removalContext = await browser.newContext({
        storageState: await operator.context.storageState(),
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: join(output, "video"), size: { width: 1280, height: 900 } },
      });
      contexts.push(removalContext);
      const removalPage = await removalContext.newPage();
      removalPage.setDefaultTimeout(15_000);
      await removalPage.goto(`${site}${companyPath(a, a1)}`);
      await removalPage
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      await delay(1000);
      // Revoking asks for confirmation in a dialog first.
      await row.getByRole("button", { name: "Revogar acesso", exact: true }).click();
      await owner.page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Confirmar revogação", exact: true })
        .click();
      await removalPage
        .getByRole("heading", { name: "Empresa indisponível.", exact: true })
        .waitFor();
      assert.equal(
        await removalPage.getByText("Empresa Ipê Atualizada", { exact: true }).count(),
        0,
      );
      await delay(1000);
      await removalContext.close();
      await removalPage.video().saveAs(join(output, "company-revocation.webm"));
      await operator.page
        .getByRole("heading", { name: "Empresa indisponível.", exact: true })
        .waitFor();
      assert.equal(
        await operator.page.getByText("Empresa Ipê Atualizada", { exact: true }).count(),
        0,
      );
      assert.equal(await get(operator, a, a1), null);
      await capture(operator, "company-revoked");
      await operator.page.goForward();
      await operator.page.getByRole("heading", { name: "Empresas", exact: true }).waitFor();
      await operator.page.goBack();
      await operator.page
        .getByRole("heading", { name: "Empresa indisponível.", exact: true })
        .waitFor();
      assert.equal(
        await operator.page.getByText("Empresa Ipê Atualizada", { exact: true }).count(),
        0,
      );
      report.scenarios.push(
        "ungranted-company-refused",
        "live-grant-exposes-only-authorized-company",
        "same-org-other-company-and-cross-org-identifiers-refused",
        "operator-cannot-edit-or-manage-grants",
        "live-revocation-clears-private-view-and-warm-history",
      );
      await operator.context.close();
      await phase("final desktop and mobile evidence");
      await visit(owner, "/app/" + a.slug + "/companies");
      await owner.page.getByRole("heading", { name: "Empresas", exact: true }).waitFor();
      report.theme = await owner.page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        return {
          ink: css.getPropertyValue("--color-text").trim(),
          canvas: css.getPropertyValue("--color-bg").trim(),
          focus: css.getPropertyValue("--color-focus").trim(),
          font: css.fontFamily,
        };
      });
      assert.deepEqual(report.theme, {
        ink: "#203b32",
        canvas: "#f7f8f4",
        focus: "#397a62",
        font: `Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif`,
      });
      await capture(owner, "companies-desktop");
      await owner.page.setViewportSize({ width: 390, height: 844 });
      await capture(owner, "companies-mobile");
      await visit(owner, companyPath(a, a1));
      await owner.page
        .getByRole("heading", { name: "Empresa Ipê Atualizada", exact: true })
        .waitFor();
      await capture(owner, "company-mobile");
      await visit(owner, "/app/" + a.slug + "/onboarding");
      await owner.page
        .getByRole("heading", { name: "Comece pela sua empresa.", exact: true })
        .waitFor();
      await capture(owner, "onboarding-mobile");
      report.scenarios.push(
        "green-theme-tokens-preserved",
        "desktop-mobile-accessibility-and-overflow",
      );
      report.result = "passed";
    }
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      // Browser actions may contain credentials in diagnostics. Keep only the error class in the receipt.
      report.failure = error instanceof Error ? error.name : "UnknownError";
      report.failureAt =
        error instanceof Error
          ? error.stack
              ?.split("\n")
              .find((line) => line.includes("companies.mjs:"))
              ?.trim()
          : undefined;
      report.pages = await Promise.all(
        contexts.map((context) =>
          finalization.attempt(async () => {
            const page = context.pages()[0];
            if (!page) return { path: "closed", headings: [], alerts: [] };
            return {
              path: new URL(page.url()).pathname,
              headings: await finalization.attempt(() => page.locator("h1, h2").allTextContents()),
              alerts: await finalization.attempt(() => page.getByRole("alert").allTextContents()),
            };
          }),
        ),
      );
      console.error(
        error instanceof Error && error.name === "AssertionError" ? error.message : report.failure,
      );
    });
  } finally {
    for (const context of contexts) await finalization.attempt(() => context.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() => console.log(JSON.stringify(report)));
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    );
  }
  return report.result;
});
