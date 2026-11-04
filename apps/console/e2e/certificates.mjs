import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import { withLocalBrowser } from "../../../scripts/lib/local-browser.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { referenceLocal } from "../../../scripts/lib/reference-local.mjs";
import { syntheticCertificate } from "../../../tests/helpers/certificates.ts";
import { localAuthPacer } from "./local-auth-pacing.mjs";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";
const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "certificates", async () => {
  const { site, urls, rpc } = referenceLocal(root),
    before = process.argv.includes("--before");
  const output = join(root, ".browser-results/certificates");
  mkdirSync(output, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const report = {
    codeSha: git("rev-parse", "HEAD"),
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
      email = `cert-${suffix}@development.invalid`,
      password = crypto.randomUUID() + "aA1!";
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste certificados");
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
      name: "Certificados de teste",
      slug: `cert-${suffix}`,
      ...(await termsAcceptance((path, args) => human("query", path, args))),
    });
    const company = await human("mutation", "companies:create", {
      organizationId: org.organizationId,
      cnpj: "00000000000191",
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
    const companyPath = `${site}/app/${org.slug}/companies/${company.companyId}`;
    // The certificate has its own tab on the company page; `--before` keeps the old single page.
    const companyUrl = before ? companyPath : `${companyPath}?aba=certificado`;
    await page.goto(companyUrl);
    await page.getByRole("heading", { name: "Empresa sintética A1" }).waitFor();
    if (before) {
      await capture("before-desktop");
      report.scenarios.push("baseline-company");
    } else {
      await page
        .getByText("Nenhum certificado enviado para esta empresa.", { exact: true })
        .waitFor();
      await capture("empty-desktop");
      const material = syntheticCertificate();
      async function upload(pfx, secret) {
        await page
          .getByLabel("Arquivo A1/PFX")
          .setInputFiles({ name: "synthetic.pfx", mimeType: "application/x-pkcs12", buffer: pfx });
        await page.getByLabel("Senha do certificado", { exact: true }).fill(secret);
        await page.getByRole("button", { name: "Enviar para validação", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('input[name="password"]').value === "",
        );
        assert.equal(await page.getByLabel("Arquivo A1/PFX").inputValue(), "");
      }
      await upload(material.pfx, "wrong");
      await page.getByText("Rejeitado", { exact: true }).waitFor();
      await capture("wrong-password");
      report.scenarios.push("wrong-password-secret-cleared");
      await upload(material.pfx, material.password.toString());
      await page.getByText("Validado para uso no serviço", { exact: true }).waitFor();
      await capture("active-desktop");
      report.scenarios.push("upload-validation-metadata");
      await page.reload();
      await page.getByText("Validado para uso no serviço", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Senha do certificado", { exact: true }).inputValue(), "");
      const list = await human("query", "certificates:list", {
        ...scope,
        contextKey: "proof",
        paginationOpts: { numItems: 20, cursor: null },
      });
      assert.ok(!/envelope|wrappedKey|password|pfx/i.test(JSON.stringify(list)));
      const persisted = await page.evaluate(() =>
        JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      );
      assert.ok(!persisted.includes(material.password.toString()));
      report.scenarios.push("reload-no-secret-storage-or-query");
      await upload(material.pfx, material.password.toString());
      await page.getByText("Substituído", { exact: true }).waitFor();
      report.scenarios.push("rotation");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("active-mobile");
      await page.getByRole("button", { name: "Desativar versão 3", exact: true }).click();
      await page.getByRole("button", { name: "Confirmar desativação", exact: true }).click();
      await page.getByText("Desativado", { exact: true }).waitFor();
      report.scenarios.push("revocation");
      await capture("revoked-mobile");
      await page.getByLabel("Senha do certificado", { exact: true }).fill("unsent-secret");
      await page.goto(`${site}/app/${org.slug}/companies`);
      await page.goto(companyUrl);
      assert.equal(await page.getByLabel("Senha do certificado", { exact: true }).inputValue(), "");
      report.scenarios.push("navigation-clears-secret");
    }
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
      writeFileSync(
        join(output, before ? "before.json" : "browser.json"),
        JSON.stringify(report, null, 2) + "\n",
      ),
    );
  }
  return report.result;
});
