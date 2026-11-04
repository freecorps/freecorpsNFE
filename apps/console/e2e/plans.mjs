import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createBrowserFinalization } from "../../../scripts/lib/browser-finalization.mjs";
import {
  withLocalBrowser,
  localBrowserFetch as fetch,
} from "../../../scripts/lib/local-browser.mjs";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { localAuthPacer } from "./local-auth-pacing.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "plans", async () => {
  const paths = worktreePaths(root);
  const config = readLocalConfig(paths);
  const urls = localUrls(config);
  const site = currentLocalSiteUrl(paths);
  const runId = randomUUID();
  const output = join(root, "docs/v1.0/evidence/429/redesign", runId);
  const privateOutput = join(root, ".browser-results/plans", runId);
  mkdirSync(output, { recursive: true });
  mkdirSync(privateOutput, { recursive: true });
  const hash = (file) =>
    createHash("sha256")
      .update(readFileSync(join(root, file)))
      .digest("hex");
  const fingerprint = () =>
    Object.fromEntries(
      [
        "apps/console/e2e/plans.mjs",
        "apps/console/src/plans.tsx",
        "apps/console/src/usage.tsx",
        "platform/convex/plans.ts",
        "platform/convex/lib/planCatalog.ts",
        "platform/convex/lib/planCore.ts",
        "platform/convex/lib/capacityCore.ts",
        "platform/convex/schema.ts",
      ].map((file) => [file, hash(file)]),
    );
  const report = {
    runId,
    startedAt: new Date().toISOString(),
    codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    ),
    environment: "anonymous-local",
    site,
    convexUrl: urls.cloud,
    deploymentName: config.deploymentName,
    dataset: "one synthetic account and organization per run; synthetic payment; no fiscal calls",
    result: "running",
    step: "preparation",
    scenarios: [],
    accessibility: [],
    screenshots: [],
    rateLimits: [],
    errors: [],
  };
  const finalization = createBrowserFinalization(report);
  const email = `plans-${runId}@development.invalid`;
  const password = `plans-local-${randomUUID()}`;
  const slug = `plans-${runId.slice(0, 12)}`;
  let browser, context, page, jwt, organizationId;
  function step(value) {
    report.step = value;
    console.log(`Planos: ${value}`);
  }
  async function rpc(kind, path, args, admin = true) {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      headers: {
        Authorization: admin ? `Convex ${config.adminKey}` : `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = await response.json();
    if (!response.ok || body.status !== "success") {
      // Never print the response, arguments, authorization, or raw backend logs.
      const code = body.errorData?.code;
      report.errors.push({
        path,
        status: response.status,
        code: typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : null,
      });
      throw new Error(`Local operation failed: ${path}`);
    }
    return body.value;
  }
  const overview = () =>
    rpc(
      "query",
      "plans:overview",
      // The query never reads the clock (#45): the caller passes it, as the page does.
      { organizationId, contextKey: "plans-browser", asOf: Date.now() },
      false,
    );
  const usage = () =>
    rpc(
      "query",
      "usage:overview",
      {
        organizationId,
        contextKey: "plans-browser",
        period: new Date().toISOString().slice(0, 7),
      },
      false,
    );
  async function capture(name) {
    // Only capture authenticated plan screens; never signup, OTP, cookies, HAR or storageState.
    const file = `${name}.png`;
    const published = [
      "01-disabled-desktop",
      "02-catalog-desktop",
      "06-intermediate-active-desktop",
      "07-upgrade-350-confirm-desktop",
      "11-reloaded-mobile",
    ].includes(name);
    const imagePath = join(published ? output : privateOutput, file);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: imagePath,
      fullPage: true,
      animations: "disabled",
      mask: [page.getByText(email, { exact: true })],
    });
    report.screenshots.push({
      file,
      published,
      sha256: createHash("sha256").update(readFileSync(imagePath)).digest("hex"),
    });
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    report.accessibility.push({
      page: name,
      ...dimensions,
      violations: result.violations.map(({ id, impact }) => ({ id, impact })),
    });
    assert.equal(result.violations.length, 0, `Accessibility: ${name}`);
    assert.ok(dimensions.scrollWidth <= dimensions.width, `Horizontal overflow: ${name}`);
  }
  async function waitForQuery(read, predicate) {
    // Bounded read-only observation. Mutations and signup are never retried.
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await read();
      if (predicate(result)) return result;
      await delay(500);
    }
    throw new Error("Persisted state did not reach the expected result");
  }
  try {
    browser = await chromium.launch({ headless: true });
    report.browser = browser.version();
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "pt-BR",
    });
    await localAuthPacer(report)(context);
    context.on("response", (response) => {
      if (response.status() === 429)
        report.rateLimits.push({ path: new URL(response.url()).pathname, step: report.step });
    });
    page = await context.newPage();
    step("signup-ui");
    await page.goto(`${site}/signup`);
    await page.getByLabel("Seu nome").fill("Pessoa de teste dos planos");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page
      .getByText("Se ainda não houver uma conta com este e-mail", { exact: false })
      .waitFor();
    step("verify-and-login-ui");
    const messages = await rpc("query", "mail:inbox", { email });
    const message = messages.find((entry) => entry.type === "email-verification");
    assert.ok(message, "Local verification message required");
    await page.goto(`${site}/verify-email`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Código de oito dígitos").fill(message.otp);
    await page.getByRole("button", { name: "Verificar e-mail", exact: true }).click();
    await page
      .getByText("E-mail verificado. Entre com sua senha para continuar.", { exact: true })
      .waitFor();
    await page.goto(`${site}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    await page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    step("create-organization-ui");
    await page
      .getByLabel("Nome da organização", { exact: true })
      .fill("Equipe de teste dos planos");
    await page.getByLabel("Endereço da organização", { exact: true }).fill(slug);
    await page.getByRole("checkbox", { name: /Li e aceito os termos de uso/ }).check();
    await page.getByRole("button", { name: "Criar organização", exact: true }).click();
    await page.waitForURL(`${site}/app/${slug}`);
    jwt = await page.evaluate(async () => {
      const { authClient } = await import("/src/auth.ts");
      return (await authClient.convex.token()).data?.token;
    });
    assert.ok(jwt, "Authenticated local session required");
    const org = await rpc(
      "query",
      "organizations:context",
      { slug, contextKey: "plans-browser" },
      false,
    );
    organizationId = org.id;
    report.scenarios.push("signup-verify-login-and-organization-created-through-ui");
    report.sourceHashesBefore = fingerprint();
    await page.locator(`a[href="/app/${slug}/usage"]:visible`).first().click();
    await page.getByRole("heading", { name: "Uso e limites", exact: true }).waitFor();

    step("disabled-gate");
    const initial = await overview();
    report.disabledGate = initial.enabled ? "not-exercised-already-enabled" : "passed";
    if (!initial.enabled) {
      await page
        .getByText("A contratação de planos está indisponível no momento.", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Ativar gratuito", exact: true }).count(),
        0,
      );
      assert.equal(initial.subscription, null);
      await capture("01-disabled-desktop");
      report.scenarios.push("disabled-gate-no-enrollment-controls");
    } else if (process.argv.includes("--require-disabled")) {
      throw new Error("The disabled gate requires a local deployment with plans not enabled yet");
    }

    step("configure-local-only");
    const settings = await rpc("query", "_system/cli/tableData", {
      table: "platformPlanSettings",
      order: "asc",
      paginationOpts: { cursor: null, numItems: 2 },
    });
    assert.ok(
      settings.isDone && settings.page.length <= 1,
      "Expected one local settings row at most",
    );
    const prior = settings.page[0];
    const configured = await rpc("mutation", "plans:configure", {
      enabled: true,
      expectedVersion: prior?.version ?? 0,
      filesBytes: Math.max(
        prior?.filesBytes ?? 0,
        (prior?.allocatedFilesBytes ?? 0) + 100 * 2 ** 30,
      ),
      databaseBytes: Math.max(
        prior?.databaseBytes ?? 0,
        (prior?.allocatedDatabaseBytes ?? 0) + 10 * 2 ** 30,
      ),
      custodyCents: Math.max(
        prior?.custodyCents ?? 0,
        (prior?.allocatedCustodyCents ?? 0) + 1_000_000,
      ),
      freeMonthlyCents: Math.max(
        prior?.freeMonthlyCents ?? 0,
        (prior?.allocatedFreeMonthlyCents ?? 0) + 10_000,
      ),
      admissionsUntil: Date.now() + 24 * 60 * 60 * 1000,
      evidence: "Synthetic local browser journey; no real company funds or payment",
    });
    // The journey pays by assisted Pix, off by default.
    await rpc("mutation", "plans:configurePix", {
      enabled: true,
      expectedVersion: configured,
      evidence: "Synthetic local browser journey; Pix confirmed by the operator",
    });
    await page.getByRole("button", { name: "Ativar gratuito", exact: true }).waitFor();
    await capture("02-catalog-desktop");
    step("activate-free-ui");
    await page.getByRole("button", { name: "Ativar gratuito", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Confirmar ativação", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Gratuito", exact: true }).waitFor();
    assert.equal(await page.getByText("Plano vigente", { exact: true }).isVisible(), true);
    const free = await waitForQuery(overview, (data) => data.subscription?.tier === "free");
    const freeUsage = await usage();
    assert.equal(freeUsage.plan.limits.imports, 100);
    assert.equal(freeUsage.plan.endsAt, null);
    await capture("03-free-active-desktop");
    report.scenarios.push("free-activated-ui-and-persisted-with-100-imports-no-expiry");

    step("request-intermediate-ui");
    await page.getByRole("button", { name: "Solicitar Intermediário", exact: true }).click();
    assert.match(await dialog.innerText(), /R\$\s*149,00/);
    await capture("04-intermediate-confirm-desktop");
    await dialog.getByRole("button", { name: "Registrar pedido", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Aguardando pagamento", { exact: true }).waitFor();
    const pending = await overview();
    assert.equal(pending.request.state, "awaiting_payment");
    assert.equal(pending.request.amountCents, 14900);
    assert.deepEqual(pending.subscription, free.subscription);
    assert.deepEqual((await usage()).plan, freeUsage.plan);
    await page.getByRole("heading", { name: "Gratuito", exact: true }).waitFor();
    await capture("05-intermediate-pending-desktop");
    report.scenarios.push("intermediate-14900-awaiting-payment-keeps-exact-free-plan-and-quotas");

    step("confirm-synthetic-payment-local-only");
    await rpc("mutation", "plans:confirmPayment", {
      requestId: pending.request.id,
      amountCents: 14900,
      paymentReference: `synthetic-browser-${runId}`,
      actor: "local-browser-test",
    });
    // No reload: subscription must update the visible plan after server confirmation.
    await page.getByRole("heading", { name: "Intermediário", exact: true }).waitFor();
    assert.equal(await page.getByText("Plano vigente", { exact: true }).isVisible(), true);
    assert.equal(
      await page
        .getByText(
          "Pedido registrado. Aguarde as instruções de pagamento pelo canal de atendimento.",
          { exact: true },
        )
        .count(),
      0,
    );
    const active = await waitForQuery(
      overview,
      (data) => data.subscription?.tier === "intermediate" && !data.request,
    );
    const activeUsage = await usage();
    report.activatedPlan = {
      tier: active.subscription.tier,
      version: activeUsage.plan.version,
      imports: activeUsage.plan.limits.imports,
      largeQuoteCents: active.pricesCents.large,
    };
    assert.equal(activeUsage.plan.limits.imports, 1000);
    assert.equal(activeUsage.plan.version, freeUsage.plan.version + 1);
    assert.equal(active.pricesCents.large, 35000);
    await capture("06-intermediate-active-desktop");
    report.scenarios.push(
      "synthetic-internal-payment-activates-intermediate-live-and-1000-imports",
    );

    step("upgrade-server-quote-ui");
    await page.getByRole("button", { name: "Solicitar Grande", exact: true }).click();
    assert.match(await dialog.innerText(), /R\$\s*350,00/);
    assert.match(await dialog.innerText(), /Valor da diferença/);
    await capture("07-upgrade-350-confirm-desktop");
    await dialog.getByRole("button", { name: "Registrar pedido", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Aguardando pagamento", { exact: true }).waitFor();
    const upgrade = await overview();
    assert.equal(upgrade.request.amountCents, active.pricesCents.large);
    assert.deepEqual((await usage()).plan, activeUsage.plan);
    report.scenarios.push(
      "upgrade-ui-and-persisted-request-match-server-35000-quote-no-extra-quota",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("08-upgrade-pending-mobile");
    step("cancel-pending-ui");
    await page.getByRole("button", { name: "Cancelar pedido", exact: true }).click();
    await capture("09-cancel-confirm-mobile");
    await dialog.getByRole("button", { name: "Confirmar cancelamento", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Pedido cancelado. O plano atual foi mantido.", { exact: true }).waitFor();
    assert.equal((await overview()).request, null);
    assert.deepEqual((await usage()).plan, activeUsage.plan);
    await capture("10-cancelled-mobile");
    report.scenarios.push("upgrade-cancelled-through-ui-keeps-exact-intermediate-plan-and-quotas");

    step("direct-route-reload-mobile");
    await page.reload();
    await page.getByRole("heading", { name: "Intermediário", exact: true }).waitFor();
    assert.equal(await page.getByText("Aguardando pagamento", { exact: true }).count(), 0);
    await capture("11-reloaded-mobile");
    report.scenarios.push("direct-usage-route-reload-mobile-390-no-horizontal-overflow-and-axe");
    assert.equal(report.rateLimits.length, 0, "No rate-limited responses expected");
    report.sourceHashesAfter = fingerprint();
    assert.deepEqual(
      report.sourceHashesAfter,
      report.sourceHashesBefore,
      "Candidate changed during the plan journey",
    );
    report.result = "passed";
    step("complete");
  } catch (error) {
    // The phase and completed assertions are sufficient in the public receipt.
    // Playwright exceptions may include credentials in locator/fill call logs.
    if (
      error?.code === "ERR_ASSERTION" &&
      typeof error.actual === "number" &&
      typeof error.expected === "number"
    )
      report.failedAssertion = { actual: error.actual, expected: error.expected };
    finalization.fail(
      new Error(
        `Plans browser journey failed at ${report.step}; inspect the sanitized receipt and private screenshot`,
      ),
    );
    await finalization.attempt(() =>
      page?.screenshot({ path: join(privateOutput, "failure-private.png"), fullPage: true }),
    );
  } finally {
    await finalization.attempt(() => context?.close());
    await finalization.attempt(() => browser?.close());
    report.finishedAt = new Date().toISOString();
    await finalization.attempt(() =>
      writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    );
    await finalization.attempt(() =>
      console.log(
        JSON.stringify({
          result: report.result,
          step: report.step,
          scenarios: report.scenarios.length,
          receipt: join(output, "report.json"),
        }),
      ),
    );
  }
  finalization.throwIfFailed();
  return report.result;
});
