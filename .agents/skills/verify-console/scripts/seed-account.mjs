// Conta sintética para a skill verify-console, pelo caminho real: cadastro e
// login na tela, código lido no coletor de e-mail local e, como a própria conta,
// uma organização com empresa de demonstração, projeto, chave, webhook e uma NF-e
// importada pela REST, mais uma organização vazia. Nada é inserido no banco por
// fora. Idempotente por worktree: reaproveita account.json enquanto a conta e as
// organizações existirem.
//
//   node .agents/skills/verify-console/scripts/seed-account.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localAuthPacer } from "../../../../apps/console/e2e/local-auth-pacing.mjs";
import {
  localBrowserFetch as fetch,
  withLocalBrowser,
} from "../../../../scripts/lib/local-browser.mjs";
import { readLocalConfig, localUrls } from "../../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../../scripts/lib/worktree/env-file.mjs";
import { worktreePaths } from "../../../../scripts/lib/worktree/paths.mjs";
import { outputDirectory } from "./lib.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
if (process.argv.includes("--help")) {
  console.log(
    "Uso: node .agents/skills/verify-console/scripts/seed-account.mjs\n" +
      `Cria ou reaproveita a conta sintética e grava ${outputDirectory}/account.json.\n` +
      "Exige o dev do worktree pronto (start-dev.mjs).",
  );
  process.exit(0);
}
const { chromium } = createRequire(join(root, "apps/console/package.json"))("playwright");
const accountFile = join(root, outputDirectory, "account.json");
mkdirSync(join(root, outputDirectory), { recursive: true });

await withLocalBrowser(root, "verify-console-seed", async () => {
  const paths = worktreePaths(root);
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  const report = { result: "running" };
  const saved = existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, "utf8")) : null;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await localAuthPacer(report)(context);
    const page = await context.newPage();

    async function rpc(kind, path, args, admin = false) {
      const authorization = admin
        ? `Convex ${config.adminKey}`
        : `Bearer ${await page.evaluate(async () => {
            const { authClient } = await import("/src/auth.ts");
            return (await authClient.convex.token()).data?.token;
          })}`;
      const response = await fetch(`${urls.cloud}/api/${kind}`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      });
      const body = await response.json();
      assert.equal(
        body.status,
        "success",
        `${path}: ${JSON.stringify(body.errorData ?? body.errorMessage ?? "falhou")}`,
      );
      return body.value;
    }
    async function login(email, password) {
      await page.goto(`${site}/login`);
      await page.getByLabel("E-mail", { exact: true }).fill(email);
      await page.getByLabel("Senha", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Entrar no painel" }).click();
    }
    async function signedIn() {
      try {
        await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
        return true;
      } catch {
        return false;
      }
    }

    // Conta: a gravada, se ainda entra; senão uma nova, pelo cadastro real.
    let account = saved;
    if (account) {
      await login(account.email, account.password);
      if (!(await signedIn())) {
        console.log("seed: a conta gravada não entra mais (banco recriado?); criando outra.");
        account = null;
      }
    }
    if (!account) {
      account = {
        email: `verificacao-${randomUUID()}@development.invalid`,
        password: randomBytes(18).toString("base64url"),
      };
      await page.goto(`${site}/signup`);
      await page.getByLabel("Seu nome").fill("Conta de verificação");
      await page.getByLabel("E-mail", { exact: true }).fill(account.email);
      await page.getByLabel("Senha", { exact: true }).fill(account.password);
      await page.getByRole("button", { name: "Criar conta", exact: true }).click();
      await page
        .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
        .waitFor();
      await login(account.email, account.password);
      await page.getByRole("alert").filter({ hasText: "Verifique seu e-mail" }).waitFor();
      const inbox = await rpc("query", "mail:inbox", { email: account.email }, true);
      const mail = inbox.find((message) => message.type === "email-verification");
      assert.ok(mail, "O coletor local não recebeu o código de verificação");
      await page.goto(`${site}/verify-email`);
      await page.getByLabel("E-mail", { exact: true }).fill(account.email);
      await page.getByLabel("Código de oito dígitos").fill(mail.otp);
      await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
      await page
        .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
        .waitFor();
      await login(account.email, account.password);
      assert.ok(await signedIn(), "O login depois da verificação não abriu o console");
      console.log(`seed: conta criada (${account.email})`);
      // Gravada já: uma falha adiante não deixa uma conta sem senha conhecida.
      writeFileSync(accountFile, `${JSON.stringify(account, null, 2)}
`, { mode: 0o600 });
    }

    const exists = async (slug) =>
      Boolean(slug && (await rpc("query", "organizations:context", { slug, contextKey: "seed" })));
    if (!(account.data && (await exists(account.data.slug)) && (await exists(account.empty?.slug)))) {
      const suffix = randomUUID().slice(0, 8);
      // Organização nova aceita a versão vigente dos termos, como o formulário do console.
      const terms = await rpc("query", "termsOfUse:current", {});
      const accepted = terms ? { termsOfUse: terms.version } : {};
      const org = await rpc("mutation", "organizations:create", {
        name: "Verificação do console",
        slug: `verificacao-${suffix}`,
        ...accepted,
      });
      const { companyId } = await rpc("mutation", "onboarding:start", {
        organizationId: org.organizationId,
        mode: "demonstration",
        expectedVersion: 0,
      });
      const { projectId } = await rpc("mutation", "projects:create", {
        organizationId: org.organizationId,
        name: "Integração de verificação",
        externalReference: `verificacao-${suffix}`,
      });
      await rpc("mutation", "projects:grantCompany", {
        organizationId: org.organizationId,
        projectId,
        companyId,
        scopes: ["documents:import", "documents:read", "webhooks:manage"],
        environments: ["sandbox"],
        expectedVersion: 0,
      });
      // O segredo só serve à importação abaixo: fica na memória, nunca no disco.
      const key = await rpc("action", "keys:create", {
        organizationId: org.organizationId,
        projectId,
        name: "Chave de verificação",
        scopes: ["documents:import", "documents:read"],
        environment: "sandbox",
        companyIds: [companyId],
        expiresAt: Date.now() + 30 * 86_400_000,
      });
      await rpc("mutation", "webhooks:create", {
        organizationId: org.organizationId,
        projectId,
        companyId,
        environment: "sandbox",
        name: "Webhook de verificação",
        url: "https://webhook.example.com/freecorps",
        events: ["document.received", "import.completed"],
      });
      const rest = async (path, method = "GET", body) => {
        const response = await fetch(`${urls.site}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key.secretOnce}`,
            "X-Environment": "sandbox",
            "Idempotency-Key": randomUUID(),
            "Content-Type": "application/json",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        });
        const data = await response.json();
        assert.ok([200, 202].includes(response.status), `${path}: HTTP ${response.status}`);
        return data.data;
      };
      const xml = readFileSync(join(root, "apps/console/public/examples/nfe-demonstracao.xml"));
      const batch = await rest("/v1/imports", "POST", {
        companyId,
        files: [
          {
            name: "nfe-demonstracao.xml",
            size: xml.length,
            sha256: createHash("sha256").update(xml).digest("hex"),
          },
        ],
      });
      const filePath = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
      const ticket = await rest(`${filePath}/upload`, "POST");
      const upload = await fetch(ticket.url, {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: xml,
      });
      assert.equal(upload.status, 200, "Envio do XML recusado");
      await rest(`${filePath}/confirm`, "POST");
      let documentId;
      for (let attempt = 0; attempt < 120 && !documentId; attempt++) {
        const current = await rest(`/v1/imports/${batch.importId}`);
        if (current.files[0].state === "succeeded") documentId = current.files[0].documentId;
        else if (current.files[0].state === "failed") throw new Error("A importação do XML falhou");
        else await delay(500);
      }
      assert.ok(documentId, "A importação do XML não terminou em 60 segundos");
      const empty = await rpc("mutation", "organizations:create", {
        name: "Organização vazia",
        slug: `vazia-${suffix}`,
        ...accepted,
      });
      account.data = {
        slug: org.slug,
        organizationId: org.organizationId,
        companyId,
        projectId,
        documentId,
      };
      account.empty = { slug: empty.slug, organizationId: empty.organizationId };
      console.log(`seed: organizações ${org.slug} (com dados) e ${empty.slug} (vazia)`);
    } else console.log("seed: conta e organizações reaproveitadas");
    account.updatedAt = new Date().toISOString();
    writeFileSync(accountFile, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
    report.result = "passed";
  } finally {
    await browser.close();
  }
  return report.result;
});
