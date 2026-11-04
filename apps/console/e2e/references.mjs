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
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { referenceLocal } from "../../../scripts/lib/reference-local.mjs";
import { FreecorpsClient } from "../../../packages/sdk/dist/index.js";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "references", async () => {
  const { site, urls, rpc, stage, publish } = referenceLocal(root);
  const suffix = crypto.randomUUID().slice(0, 8),
    output = join(root, ".browser-results/references");
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  function fingerprint() {
    const files = git(
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "platform",
      "packages",
      "apps",
      "lib",
      "scripts",
      "tests",
    )
      .split(/\r?\n/)
      .sort();
    const hash = createHash("sha256");
    for (const file of files) hash.update(file).update(readFileSync(join(root, file)));
    return hash.digest("hex");
  }
  const report = {
    codeSha: git("rev-parse", "HEAD"),
    runnerSha: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    fingerprint: fingerprint(),
    runnerHash: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    environment: "anonymous-local",
    site,
    urls,
    scenarios: [],
    sources: [],
    accessibility: [],
    result: "running",
  };
  const finalization = createBrowserFinalization(report);
  let browser, context, page;
  async function capture(name) {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
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
    page.setDefaultTimeout(20000);
    console.log("references: account, scope and empty table");
    const email = `reference-${suffix}@development.invalid`,
      password = crypto.randomUUID() + "aA1!";
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste Referências");
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
      name: "Referências sintéticas",
      slug: `refs-${suffix}`,
      ...(await termsAcceptance((path, args) => human("query", path, args))),
    });
    const company = await human("mutation", "companies:create", {
      organizationId: org.organizationId,
      name: "Empresa de demonstração",
      cnpj: "00000000000191",
      address: {
        street: "Rua de teste",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade",
        state: "SP",
        postalCode: "01000000",
      },
    });
    const { projectId } = await human("mutation", "projects:create", {
      organizationId: org.organizationId,
      name: "Consumidor de tabelas",
      externalReference: suffix,
    });
    const scope = { organizationId: org.organizationId, projectId };
    await human("mutation", "projects:grantCompany", {
      ...scope,
      companyId: company.companyId,
      scopes: ["references:read"],
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    const key = await human("action", "keys:create", {
      ...scope,
      name: "Chave sintética",
      companyIds: [company.companyId],
      scopes: ["references:read"],
      environment: "sandbox",
      expiresAt: Date.now() + 3600000,
    });
    const sdk = new FreecorpsClient({
      baseUrl: urls.site,
      apiKey: key.secretOnce,
      environment: "sandbox",
      maxRetries: 0,
    });
    const query = { companyId: company.companyId, date: "2026-09-22" };
    await page.goto(`${site}/app/${org.slug}/references`);
    await page.getByLabel("Empresa da consulta").selectOption(company.companyId);
    const initial = await rpc("query", "referenceImport:current", { dataset: "municipalities" });
    if (!initial.version) {
      await page.getByRole("heading", { name: "Tabela ainda indisponível" }).waitFor();
      await capture("unavailable");
      report.scenarios.push("unpublished-table-unavailable");
    }

    console.log("references: full official datasets in local storage");
    for (const dataset of ["municipalities", "ncm"]) {
      const data = JSON.parse(readFileSync(join(root, `.reference-data/${dataset}.json`), "utf8"));
      data.manifest.version += `-${suffix}`;
      const id = await stage(JSON.stringify(data));
      await publish(id, dataset, "Prova local de fonte oficial #75");
      const result = await sdk.call(dataset === "ncm" ? "listNcm" : "listMunicipalities", {
        path: {},
        query: { ...query, limit: 1 },
        body: {},
      });
      assert.equal(result.data.manifest.count, data.entries.length);
      assert.equal(result.data.page[0].code, data.entries[0].code);
      const viaHttp = await fetch(
        `${urls.site}/v1/references/${dataset}?companyId=${query.companyId}&date=${query.date}&limit=1`,
        { headers: { Authorization: `Bearer ${key.secretOnce}`, "X-Environment": "sandbox" } },
      );
      assert.equal(viaHttp.status, 200);
      assert.deepEqual((await viaHttp.json()).data, result.data);
      report.sources.push({ ...data.manifest, stage: "ready", published: true });
      report.scenarios.push(`${dataset}-official-full-import-http-sdk-equivalence`);
    }

    console.log("references: synthetic validity, publication and rollback");
    const corpus = JSON.parse(
      readFileSync(join(root, "tests/fixtures/references/1.0/ncm.json"), "utf8"),
    );
    corpus.manifest.version = `synthetic-${suffix}-v1`;
    const first = await stage(JSON.stringify(corpus));
    await publish(first, "ncm", "Prova sintética v1");
    const partialManifest = { ...corpus.manifest, version: `synthetic-${suffix}-partial` };
    const partial = await rpc("mutation", "referenceImport:begin", {
      manifest: JSON.stringify(partialManifest),
    });
    await rpc("mutation", "referenceImport:append", {
      versionId: partial,
      offset: 0,
      entries: corpus.entries.slice(0, 2),
    });
    await assert.rejects(publish(partial, "ncm", "Tentativa incompleta"), /REFERENCE_NOT_READY/);
    assert.equal(
      (await rpc("query", "referenceImport:current", { dataset: "ncm" })).version,
      corpus.manifest.version,
    );
    await assert.rejects(
      sdk.call("listNcm", {
        path: {},
        query: { ...query, version: partialManifest.version },
        body: {},
      }),
      (e) => e.code === "NOT_FOUND",
    );
    report.scenarios.push("native-interrupted-update-preserves-active-version");
    const firstPage = await sdk.call("listNcm", {
      path: {},
      query: { ...query, limit: 1 },
      body: {},
    });
    corpus.manifest.version = `synthetic-${suffix}-v2`;
    const second = await stage(JSON.stringify(corpus));
    await publish(second, "ncm", "Prova sintética v2");
    const next = await sdk.call("listNcm", {
      path: {},
      query: { ...query, limit: 1, cursor: firstPage.data.nextCursor },
      body: {},
    });
    assert.equal(next.data.manifest.version, `synthetic-${suffix}-v1`);
    assert.equal(next.data.page[0].code, "99000001");
    await publish(first, "ncm", "Rollback comprovado #75");
    assert.equal(
      (await sdk.call("listNcm", { path: {}, query, body: {} })).data.manifest.version,
      `synthetic-${suffix}-v1`,
    );
    report.scenarios.push("native-pagination-pins-version", "native-publication-and-rollback");
    await page.reload();
    await page.getByLabel("Empresa da consulta").selectOption(company.companyId);
    await page.getByLabel("Tabela", { exact: true }).selectOption("ncm");
    await page.getByLabel("Data de referência").fill(query.date);
    await page.getByRole("button", { name: "Pesquisar", exact: true }).click();
    await page.getByText("Fora de vigência", { exact: true }).waitFor();
    await capture("ncm-desktop");
    await page.getByRole("button", { name: "Próxima página" }).click();
    await page.getByText("99000020", { exact: true }).waitFor();
    report.scenarios.push("browser-paged-search");
    await page.getByLabel("Tipo de pesquisa").selectOption("exact");
    await page.getByLabel("Código ou descrição", { exact: true }).fill("99999999");
    await page.getByRole("button", { name: "Pesquisar", exact: true }).click();
    await page.getByText("Código inexistente nesta versão", { exact: true }).waitFor();
    await capture("ncm-not-found");
    await page.getByLabel("Código ou descrição", { exact: true }).fill("99000000");
    await page.getByRole("button", { name: "Pesquisar", exact: true }).click();
    await page.getByText("Fora de vigência", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("ncm-mobile");
    await page.getByLabel("Tabela", { exact: true }).selectOption("municipalities");
    await page.getByLabel("Código ou descrição", { exact: true }).fill("São Paulo");
    await page.getByRole("button", { name: "Pesquisar", exact: true }).click();
    await page.getByRole("heading", { name: "São Paulo", exact: true }).waitFor();
    await capture("municipalities-mobile");
    report.scenarios.push(
      "browser-exact-absent-and-expired",
      "browser-accent-search-official",
      "browser-mobile-no-overflow",
    );
    await human("mutation", "keys:revoke", { ...scope, keyId: key.keyId });
    await assert.rejects(
      sdk.call("listNcm", { path: {}, query, body: {} }),
      (e) => e.code === "INVALID_API_KEY",
    );
    report.scenarios.push("native-key-revocation");
    assert.equal(fingerprint(), report.fingerprint, "Sources changed during proof");
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.error = error instanceof Error ? error.message : String(error);
    });
  } finally {
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n"),
    );
  }
  finalization.throwIfFailed();
  return report.result;
});
