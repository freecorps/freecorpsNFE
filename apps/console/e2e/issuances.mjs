import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";
import { currentOrganization } from "./shell.mjs";

/**
 * NFS-e issuance journey in the console, against the local worktree with the simulated sandbox
 * transport: one synthetic account, organization, company, profile and project. It issues a
 * domestic and an export NFS-e through the form, cancels one, downloads an XML and captures each
 * screen. Nothing here reaches a tax authority; nothing here proves a fiscal authorization.
 *
 *   node --experimental-strip-types apps/console/e2e/issuances.mjs
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "issuances", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.ok(site && new URL(site).hostname === "localhost");
  const output = join(root, ".browser-results/issuances");
  mkdirSync(output, { recursive: true });
  const report = {
    codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    environment: "anonymous-local",
    transport: "simulated",
    url: site,
    dataset:
      "one synthetic verified user; one organization; company 11.222.333/0001-81; synthetic takers",
    result: "running",
    scenarios: [],
    accessibility: [],
  };
  const finalization = createBrowserFinalization(report);

  async function rpc(kind, path, args, authorization) {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const result = await response.json();
    assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? ""}`);
    return result.value;
  }
  async function localCode(email) {
    const mails = await rpc("query", "mail:inbox", { email }, `Convex ${config.adminKey}`);
    const mail = mails.find((message) => message.type === "email-verification");
    assert.ok(mail, "Expected local mail");
    return mail.otp;
  }

  let browser, context, page;
  async function token() {
    return `Bearer ${await page.evaluate(async () => {
      const { authClient } = await import("/src/auth.ts");
      return (await authClient.convex.token()).data?.token;
    })}`;
  }
  const call = async (kind, path, args) => rpc(kind, path, args, await token());
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
      `Overflow: ${name}`,
    );
  }
  // Rows of the issuance list; on the phone the same rows are shown as cards.
  const issuanceRows = () => page.getByRole("table", { name: "Emissões" }).locator("tbody tr");
  const status = (label) =>
    page.locator("[data-issuance-status]").filter({ hasText: label }).waitFor({
      timeout: 60_000,
    });

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const email = `emissao-${crypto.randomUUID()}@development.invalid`,
      password = `local-test-${crypto.randomUUID()}`;
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Gestora sintética de emissão");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Código de oito dígitos").fill(await localCode(email));
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page.getByText("E-mail verificado.", { exact: false }).waitFor();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();

    await page.goto(`${site}/app`);
    const slug = `emissao-${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel("Nome da organização", { exact: true }).fill("Equipe Jatobá Serviços");
    await page.getByLabel("Endereço da organização").fill(slug);
    await page.getByRole("checkbox", { name: /Li e aceito os termos de uso/ }).check();
    await page.getByRole("button", { name: "Criar organização", exact: true }).click();
    await currentOrganization(page, "Equipe Jatobá Serviços").waitFor();
    const org = await call("query", "organizations:context", { slug, contextKey: "issuance-e2e" });
    const { companyId } = await call("mutation", "companies:create", {
      organizationId: org.id,
      cnpj: "11.222.333/0001-81",
      name: "Jatobá Software Ltda",
      address: {
        street: "Rua sintética",
        number: "10",
        complement: "",
        district: "Centro",
        city: "São Paulo",
        state: "SP",
        postalCode: "01001000",
      },
    });
    await call("mutation", "nfseProfiles:save", {
      organizationId: org.id,
      companyId,
      expectedVersion: 0,
      municipalityCode: "3550308",
      opSimpNac: 1,
      regEspTrib: 0,
      dpsSeries: "1",
      activities: [
        {
          code: "licenca",
          label: "Licenciamento de software",
          cnae: "6203100",
          lc116Item: "01.05",
          cTribNac: "010501",
          description: "Licença de uso de software",
        },
      ],
    });
    // Console sem projeto: no project or grant; the owner works on the company.
    // Entry through the menu, then the company.
    await page.goto(`${site}/app/${slug}`);
    await page.getByRole("link", { name: "Emissão NFS-e", exact: true }).click();
    await page.getByRole("heading", { name: "Emissão de NFS-e" }).waitFor();
    await page.getByLabel("Empresa prestadora").selectOption(companyId);
    await page.getByText("Ambiente simulado.").waitFor();
    await page.getByRole("heading", { name: "Nenhuma emissão desta empresa" }).waitFor();
    await capture("1-lista-vazia");
    report.scenarios.push("empty-list-with-simulated-notice");

    await page.getByRole("button", { name: /Nova emissão/ }).click();
    await page.getByRole("heading", { name: "Nova emissão" }).waitFor();
    await page.getByRole("button", { name: /Pedir emissão/ }).click();
    await page.getByText(/^O pedido não foi enviado\. Confira/).waitFor();
    await capture("2-validacao");
    report.scenarios.push("client-validation-before-request");

    // Domestic: non-opting provider states the ISS rate.
    await page.getByLabel("E-mail do prestador").fill("fiscal@jatoba.example");
    await page.getByLabel("CPF ou CNPJ do tomador").fill("11.444.777/0001-61");
    await page.getByLabel("Nome ou razão social").fill("Tomador Sintético Ltda");
    await page.getByLabel("Código IBGE do município").fill("3550308");
    await page.getByLabel("CEP").fill("01001-000");
    await page.getByLabel("Logradouro").fill("Praça da Sé");
    await page.getByLabel("Número").fill("100");
    await page.getByLabel("Bairro").fill("Sé");
    await page.getByLabel("Valor do serviço").fill("1.500,00");
    await page.getByLabel("Alíquota do ISS (%)").fill("2,5");
    await capture("3-formulario-nacional");
    // Double click: one attempt key, one issuance.
    await page.getByRole("button", { name: /Pedir emissão/ }).dblclick();
    await page.getByRole("heading", { name: /^(DPS|NFS-e) / }).waitFor();
    await status("Autorizada");
    await page.getByText("NFS-e autorizada", { exact: true }).waitFor();
    await capture("4-nacional-autorizada");
    const domesticUrl = new URL(page.url());
    report.scenarios.push("domestic-authorized-by-simulator");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .locator("li.fiscal-artifact")
        .filter({ hasText: "NFS-e autorizada" })
        .getByRole("button", { name: "Baixar XML" })
        .click(),
    ]);
    const xml = await (await download.createReadStream()).toArray();
    assert.match(Buffer.concat(xml).toString("utf8"), /sem validade fiscal/);
    report.scenarios.push("nfse-xml-download-ticket");

    // Export in USD with the frozen simulated PTAX.
    await page.getByRole("button", { name: /Voltar à lista de emissões/ }).click();
    await page.getByRole("button", { name: /Nova emissão/ }).click();
    await page.getByLabel("E-mail do prestador").fill("fiscal@jatoba.example");
    await page.getByText("Exportação de serviço").click();
    await page.getByRole("radio", { name: "Não tem NIF" }).check();
    await page.getByLabel("Motivo da ausência do NIF").selectOption("2");
    await page.getByLabel("Nome ou razão social").fill("Example Grocery LLC");
    await page.getByLabel("País (código ISO)").fill("US");
    await page.getByLabel("Cidade", { exact: true }).fill("San Francisco");
    await page.getByLabel("Código postal").fill("94105");
    await page.getByLabel("Estado, província ou região").fill("CA");
    await page.getByLabel("Logradouro").fill("Market St");
    await page.getByLabel("Número").fill("548");
    await page.getByLabel("Bairro").fill("N/A");
    await page.getByLabel("Moeda", { exact: true }).selectOption("USD");
    await page.getByLabel("Valor do serviço").fill("2000,00");
    await page.getByLabel("Descrição do serviço").fill("Software subscription, October 2026");
    await capture("5-formulario-exportacao");
    await page.getByRole("button", { name: /Pedir emissão/ }).click();
    await status("Autorizada");
    await page.getByText(/BRL por USD \(cotação simulada do sandbox\)/).waitFor();
    await capture("6-exportacao-autorizada");
    report.scenarios.push("export-authorized-with-frozen-ptax");

    // Cancel the domestic one.
    await page.goto(domesticUrl.toString());
    await status("Autorizada");
    await page.getByRole("button", { name: "Cancelar NFS-e" }).click();
    await page.getByLabel("Justificativa").fill("Serviço faturado em duplicidade no mês");
    await capture("7-cancelamento");
    await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
    await status("Cancelada");
    await page
      .locator("ol.fiscal-timeline > li")
      .filter({ hasText: "Cancelamento registrado" })
      .waitFor();
    await capture("8-cancelada");
    report.scenarios.push("cancelled-with-reason");

    // Reconciliation stays honest: the lost answer is not shown as success.
    await page.getByRole("button", { name: /Voltar à lista de emissões/ }).click();
    await page.getByRole("button", { name: /Nova emissão/ }).click();
    await page.getByLabel("E-mail do prestador").fill("fiscal@jatoba.example");
    await page.getByLabel("CPF ou CNPJ do tomador").fill("529.982.247-25");
    await page.getByLabel("Nome ou razão social").fill("Pessoa Tomadora Sintética");
    await page.getByLabel("Código IBGE do município").fill("3550308");
    await page.getByLabel("CEP").fill("01001-000");
    await page.getByLabel("Logradouro").fill("Rua Direita");
    await page.getByLabel("Número").fill("5");
    await page.getByLabel("Bairro").fill("Sé");
    await page.getByLabel("Valor do serviço").fill("300,00");
    await page.getByLabel("Alíquota do ISS (%)").fill("2");
    await page.getByLabel("Descrição do serviço").fill("Consultoria sintética [simular:timeout]");
    await page.getByRole("button", { name: /Pedir emissão/ }).click();
    await page.getByRole("heading", { name: /^(DPS|NFS-e) / }).waitFor();
    const reconciling = await page
      .locator("[data-issuance-status]")
      .filter({ hasText: "Em reconciliação" })
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    if (reconciling) {
      await capture("9-reconciliacao");
      report.scenarios.push("reconciliation-shown-without-success");
    }
    await status("Autorizada");
    report.scenarios.push(
      reconciling ? "reconciliation-resolved" : "timeout-resolved-before-capture",
    );

    await page.getByRole("button", { name: /Voltar à lista de emissões/ }).click();
    await issuanceRows().nth(2).waitFor();
    await capture("10-lista");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("11-lista-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`${site}/app/${slug}/usage`);
    await page.getByRole("heading", { name: "NFS-e emitidas" }).waitFor();
    await capture("12-uso");
    const usage = await call("query", "usage:overview", {
      organizationId: org.id,
      period: new Date().toISOString().slice(0, 7),
      contextKey: "issuance-e2e",
    });
    assert.equal(usage.rows.find((row) => row.metric === "issuances").committed, 3);
    report.scenarios.push("usage-shows-issuances");

    const list = await call("query", "issuanceConsole:list", {
      organizationId: org.id,
      companyId,
      environment: "sandbox",
      paginationOpts: { numItems: 10, cursor: null },
    });
    // The double click on the first request produced one issuance only.
    assert.equal(list.page.length, 3);
    // Rejected by the simulator: "Corrigir e emitir de novo" opens the form with the request, and
    // the new request gets another DPS number; the rejected one stays as it was.
    const refused = await call("mutation", "issuanceConsole:request", {
      organizationId: org.id,
      companyId,
      environment: "sandbox",
      idempotencyKey: `console-${crypto.randomUUID()}`,
      input: {
        activityCode: "licenca",
        competence: new Date().toISOString().slice(0, 7),
        issuerEmail: "fiscal@jatoba.example",
        market: "domestic",
        taker: {
          kind: "national",
          document: "11444777000161",
          name: "Tomador Recusado Ltda",
          address: {
            municipalityCode: "3550308",
            postalCode: "01001000",
            street: "Praça da Sé",
            number: "100",
            district: "Sé",
          },
        },
        description: "Licença sintética [simular:rejeicao]",
        amount: { currency: "BRL", value: "700.00" },
        issRate: "2",
        issWithheld: false,
      },
    });
    await page.goto(
      `${site}/app/${slug}/issuances?company=${companyId}&issuance=${refused.issuanceId}`,
    );
    await status("Rejeitada");
    await page.getByRole("link", { name: "Abrir em Operação e suporte" }).waitFor();
    await page.getByRole("button", { name: "Corrigir e emitir de novo" }).click();
    await page.getByRole("heading", { name: "Corrigir e emitir de novo" }).waitFor();
    assert.equal(await page.getByLabel("Código IBGE do município").inputValue(), "3550308");
    assert.equal(
      await page.getByLabel("Nome ou razão social").inputValue(),
      "Tomador Recusado Ltda",
    );
    await page.getByLabel("Descrição do serviço").fill("Licença sintética corrigida");
    await capture("13-corrigir-rejeitada");
    await page.getByRole("button", { name: /Pedir emissão/ }).click();
    await status("Autorizada");
    const corrected = new URL(page.url()).searchParams.get("issuance");
    assert.notEqual(corrected, refused.issuanceId);
    report.scenarios.push("rejected-corrected-with-new-dps-number");
    // Filters by state, and the cards of the narrow screen keep state and value in view.
    await page.getByRole("button", { name: /Voltar à lista de emissões/ }).click();
    await page
      .getByRole("form", { name: "Filtrar emissões" })
      .getByLabel("Situação")
      .selectOption("rejected");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await issuanceRows().first().waitFor();
    assert.equal(await issuanceRows().count(), 1);
    // On the phone the same table rows turn into cards (CSS of the DataTable).
    await page.setViewportSize({ width: 390, height: 844 });
    await issuanceRows().first().waitFor();
    await capture("14-lista-filtrada-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    report.scenarios.push("list-filtered-by-state-and-cards-on-mobile");
    report.issuances = list.page.map((row) => ({
      number: row.number,
      market: row.market,
      state: row.state,
      transport: row.transport,
      amount: row.amount,
      exchange: row.exchange && { rate: row.exchange.rate, quoteDate: row.exchange.quoteDate },
    }));
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      report.error = error instanceof Error ? error.message : String(error);
      await finalization.attempt(() =>
        page?.screenshot({ path: join(output, "failure.png"), fullPage: true }),
      );
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
