import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import { withLocalBrowser } from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { normalizeCnpj } from "../../../packages/fiscal-core/src/cnpj.ts";
import { referenceLocal } from "../../../scripts/lib/reference-local.mjs";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "registry", async () => {
  const { site, urls, rpc } = referenceLocal(root);
  const suffix = crypto.randomUUID().slice(0, 8),
    output = join(root, ".browser-results/registry");
  // Each run owns its cache key; previous fixtures cannot alter the initial state.
  const baseCnpj = `Z${crypto.randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;
  const syntheticCnpj = Array.from({ length: 100 }, (_, digit) =>
    normalizeCnpj(baseCnpj + String(digit).padStart(2, "0")),
  ).find((value) => value !== null);
  assert.ok(syntheticCnpj);
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  function fingerprint() {
    const hash = createHash("sha256");
    for (const path of git(
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "platform",
      "apps",
      "packages",
      "tests",
      "scripts",
    )
      .split(/\r?\n/)
      .sort())
      hash.update(path).update(readFileSync(join(root, path)));
    return hash.digest("hex");
  }
  const report = {
    codeSha: git("rev-parse", "HEAD"),
    runnerSha: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    fingerprint: fingerprint(),
    environment: "anonymous-local",
    site,
    urls,
    dataset: "synthetic registry cache, no external provider calls",
    scenarios: [],
    accessibility: [],
    result: "running",
  };
  const finalization = createBrowserFinalization(report);
  let browser, context, page;
  async function capture(name) {
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    report.accessibility.push({
      name,
      violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact })),
    });
    assert.equal(axe.violations.length, 0, name);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Overflow ${name}`,
    );
  }
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    page = await context.newPage();
    page.setDefaultTimeout(25000);
    console.log("registry: signup and synthetic company");
    const email = `registry-${suffix}@development.invalid`,
      password = crypto.randomUUID() + "aA1!";
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste CNPJ");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    const mails = await rpc("query", "mail:inbox", { email });
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page
      .getByLabel("Código de oito dígitos")
      .fill(mails.find((m) => m.type === "email-verification").otp);
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    const jwt = await page.evaluate(async () => {
      const { authClient } = await import("/src/auth.ts");
      return (await authClient.convex.token()).data.token;
    });
    const human = (kind, path, args) => rpc(kind, path, args, `Bearer ${jwt}`);
    const org = await human("mutation", "organizations:create", {
      name: "Consulta sintética CNPJ",
      slug: `registry-${suffix}`,
      ...(await termsAcceptance((path, args) => human("query", path, args))),
    });
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
      cnpj: syntheticCnpj,
      address,
    });
    // Console sem projeto: refreshing the registry needs no project or grant.
    // The company page opens each area in its own tab (`?aba=`).
    const companyUrl = `${site}/app/${org.slug}/companies/${company.companyId}?aba=consulta`;
    await page.goto(companyUrl);
    await page.getByRole("heading", { name: "Consultar CNPJ", exact: true }).waitFor();
    await page
      .getByRole("region", { name: "Consultar CNPJ", exact: true })
      .getByText("Ainda não consultada", { exact: true })
      .waitFor();
    await capture("before-consultation");
    report.scenarios.push("direct-company-route-manual-cadastro-no-external-call");
    console.log("registry: source states and confirmation");
    const stage = (mode) =>
      rpc("mutation", "testing/registryProof:stage", { companyId: company.companyId, mode });
    await stage("found");
    const section = page.getByRole("region", { name: "Consultar CNPJ", exact: true });
    await section
      .getByText("Cadastro encontrado · Cache dentro do prazo", { exact: true })
      .waitFor();
    const inspect = async () =>
      JSON.parse(
        await rpc("query", "testing/registryProof:inspect", { companyId: company.companyId }),
      );
    assert.equal((await inspect()).company.name, "Empresa sintética manual");
    await capture("suggestion-desktop");
    report.scenarios.push("source-result-does-not-change-manual-cadastro");
    // A fresh cache: the panel waits for the next allowed consultation and says when.
    const refresh = section.getByRole("button", { name: "Atualizar consulta", exact: true });
    await section
      .getByText("A próxima consulta à fonte é permitida a partir de", { exact: false })
      .waitFor();
    assert.equal(await refresh.isDisabled(), true);
    report.scenarios.push("refresh-waits-for-next-allowed-consultation");
    await page.getByLabel("Substituir razão social atual:", { exact: false }).check();
    await page.getByRole("button", { name: "Confirmar campos selecionados", exact: true }).click();
    await page
      .getByRole("heading", { name: "Razão social da fonte sintética", exact: true })
      .waitFor();
    const applied = await inspect();
    assert.deepEqual(applied.company.address, address);
    assert.equal(applied.company.fieldSources.name, "registry");
    assert.equal(applied.company.fieldSources.address, "declared");
    assert.equal(applied.applications.length, 1);
    assert.equal(applied.applications[0].before.name, "Empresa sintética manual");
    report.scenarios.push("confirmed-name-only-preserves-address-origin-and-history");
    await page.reload();
    await page
      .getByRole("heading", { name: "Razão social da fonte sintética", exact: true })
      .waitFor();
    report.scenarios.push("reload-preserves-result-and-applied-fields");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("confirmed-mobile");
    await stage("stale");
    await section.getByText("Cadastro encontrado · Cache vencido", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Confirmar campos selecionados" }).count(),
      0,
    );
    await capture("stale-mobile");
    report.scenarios.push("stale-data-visible-application-disabled");
    await stage("unavailable");
    await section.getByText("Fonte indisponível · Cache vencido", { exact: true }).waitFor();
    // The source data has its own card, next to the consultation.
    await page
      .getByText("Dados anteriores preservados. A última tentativa não os confirmou.", {
        exact: true,
      })
      .waitFor();
    await capture("unavailable-mobile");
    report.scenarios.push("unavailable-preserves-previous-data-and-dates");
    await stage("not_found");
    await section
      .getByText("Não encontrado na base do provedor · Cache vencido", { exact: true })
      .waitFor();
    report.scenarios.push("not-found-is-explicit");
    await stage("unsupported_format");
    await section
      .getByText("Formato não suportado pela fonte · Cache vencido", { exact: true })
      .waitFor();
    report.scenarios.push("unsupported-format-is-explicit");
    assert.equal(report.fingerprint, fingerprint(), "Sources changed during proof");
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.error = String(error);
      await finalization.attempt(() =>
        page?.screenshot({ path: join(output, "failure.png"), fullPage: true }),
      );
    });
  } finally {
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() =>
      console.log(`registry: ${report.result}; ${report.scenarios.length} scenarios`),
    );
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n"),
    );
  }
  finalization.throwIfFailed();
  return report.result;
});
