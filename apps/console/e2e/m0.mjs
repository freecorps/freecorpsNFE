import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import {
  browserTarget as target,
  browserPlan,
  accessibilityCounts,
  accessibilityBlocked,
  browserStep,
} from "../../../scripts/lib/browser-validation.mjs";
import { sameRevision, checkPublication } from "../../../scripts/lib/validation-deploy.mjs";
import { diagnosticsHeading, homeDestination } from "./m0-headings.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const runId = randomUUID();
const output = join(root, ".browser-results", runId);
mkdirSync(output, { recursive: true });
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  result: "failed",
  stage: "configuration",
  scenarios: [],
  accessibility: [],
  measurements: [],
  authHttpCounts: {},
  pending: [
    "M1-M4 product journeys",
    "live session expiry and grant revocation",
    "native zoom and screen reader review",
    "external integrator quickstart",
    "real fiscal integration",
  ],
};
let browser;
let plan;
let lastAuthAt = 0;
let completedSessions = 0;

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, "HTTP request failed");
  return response.json();
}
async function revisions() {
  const frontend = await json(`${target.consoleUrl}/build.json`);
  const backend = await json(`${target.siteUrl}/health`);
  sameRevision(plan.sha, frontend, backend);
}
async function query(path, token) {
  return json(`${target.url}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, args: {}, format: "json" }),
  });
}
async function scenario(id, kind, operation) {
  report.stage = id;
  const started = Date.now();
  const record = { id, kind, result: "failed" };
  report.scenarios.push(record);
  try {
    await operation();
    record.result = "passed";
  } finally {
    record.durationMs = Date.now() - started;
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
async function accessible(page, id) {
  const counts = accessibilityCounts(
    await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(),
  );
  report.accessibility.push({ id, ...counts });
  // Finish functional journeys before applying the blocking accessibility gate.
}
async function layout(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "Horizontal overflow",
  );
}
/** Waits until `/console` settled where this role lands: its address, then its heading. */
async function home(page, role) {
  const { path, heading } = homeDestination(role);
  await page.waitForURL((address) => address.pathname === path);
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}
async function keyboardTo(page, locator) {
  for (let count = 0; count < 16; count++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Control unreachable by keyboard");
}
async function signOut(page, token) {
  // Revoke only the session created in this browser context, including on failure.
  const ok = await page.evaluate(async (siteUrl) => {
    const stored = JSON.parse(localStorage.getItem("better-auth_cookie") || "{}");
    const cookie = Object.entries(stored)
      .filter(([, item]) => !item.expires || Date.parse(item.expires) >= Date.now())
      .map(([name, item]) => `${name}=${item.value}`)
      .join("; ");
    if (!cookie) return false;
    const response = await fetch(`${siteUrl}/api/auth/sign-out`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", "Better-Auth-Cookie": cookie },
      body: "{}",
    });
    return response.ok;
  }, target.consoleUrl);
  assert.ok(ok, "Session cleanup failed");
  if (token) assert.equal((await query("access:overview", token)).status, "error");
}

try {
  report.runnerSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  report.runnerDirty =
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const ci = process.env.GITHUB_ACTIONS === "true";
  if (ci) checkPublication(process.env, report.runnerSha);
  const accounts =
    !ci && process.env.VALIDATION_ACCESS_FILE
      ? JSON.parse(readFileSync(process.env.VALIDATION_ACCESS_FILE, "utf8"))
      : null;
  const publication = ci
    ? JSON.parse(readFileSync(join(root, ".validation-results/deployment.json"), "utf8"))
    : null;
  plan = browserPlan(process.env, report.runnerSha, accounts, publication);
  report.mode = plan.mode;
  report.publishedSha = plan.sha;
  const candidateCss =
    process.env.VALIDATION_E2E_CANDIDATE_CSS === "1"
      ? readFileSync(join(root, "apps/console/src/ui/ui.css"), "utf8")
      : null;
  if (candidateCss) {
    report.mode = "review-candidate-css";
    report.candidateCssSha256 = createHash("sha256").update(candidateCss).digest("hex");
  }
  if (plan.mode === "obsolete") {
    report.result = "obsolete";
  } else {
    await scenario("revision-before", "product-integration", revisions);
    browser = await chromium.launch({ headless: true });
    report.browser = browser.version();
    for (const viewport of [
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1440, height: 960 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.origin !== target.consoleUrl || !url.pathname.startsWith("/api/auth/")) return;
        lastAuthAt = Date.now();
        const known = ["sign-in/email", "sign-out", "get-session", "convex/token"];
        const endpoint = known.find((name) => url.pathname === `/api/auth/${name}`) ?? "other";
        const key = `${endpoint}:${response.status()}`;
        report.authHttpCounts[key] = (report.authHttpCounts[key] ?? 0) + 1;
      });
      if (candidateCss)
        await context.route(`${target.consoleUrl}/assets/*.css`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: `${await response.text()}\n${candidateCss}` });
        });
      page.setDefaultTimeout(25_000);
      page.setDefaultNavigationTimeout(30_000);
      try {
        // Whoever comes back to the product finds the login on the landing, also on a phone (#452).
        await scenario(`${viewport.name}-landing-login`, "product-integration", async () => {
          const response = await page.goto(`${target.consoleUrl}/`);
          assert.equal(response.status(), 200);
          const header = page.getByRole("banner");
          const login = header.getByRole("link", { name: "Entrar", exact: true });
          await login.waitFor();
          await header.getByRole("link", { name: "Criar conta", exact: true }).waitFor();
          await layout(page);
          await keyboardTo(page, login);
          assert.ok((await login.boundingBox()).height >= (viewport.name === "mobile" ? 44 : 20));
          assert.equal(
            await page.getByRole("contentinfo").getByRole("link", { name: "Entrar" }).count(),
            1,
          );
        });
        await scenario(`${viewport.name}-login-public`, "product-integration", async () => {
          const response = await page.goto(`${target.consoleUrl}/login`);
          assert.equal(response.status(), 200);
          assert.match(response.headers()["x-robots-tag"] ?? "", /noindex/);
          await page.getByRole("heading", { name: "Entre no painel." }).waitFor();
          await page.getByText(`Versão ${plan.sha.slice(0, 7)}`).waitFor();
          await layout(page);
          // Measure before axe injection; cold browser context, no artificial throttling.
          report.measurements.push({
            viewport: viewport.name,
            kind: "laboratory",
            ...(await page.evaluate(() => {
              const navigation = performance.getEntriesByType("navigation")[0];
              const assets = performance
                .getEntriesByType("resource")
                .filter(
                  (r) =>
                    new URL(r.name).origin === location.origin && /\.(js|css)(\?|$)/.test(r.name),
                );
              return {
                domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
                loadMs: Math.round(navigation.loadEventEnd),
                jsCssEncodedBytes: assets.reduce((sum, r) => sum + r.encodedBodySize, 0),
                measuredAssets: assets.length,
              };
            })),
          });
          await accessible(page, `${viewport.name}-login`);
          await keyboardTo(page, page.getByLabel("E-mail", { exact: true }));
          await page.keyboard.press("Tab");
          assert.equal(
            await page
              .getByLabel("Senha", { exact: true })
              .evaluate((e) => e === document.activeElement),
            true,
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await page
              .getByRole("button", { name: "Entrar no painel" })
              .evaluate((e) => e === document.activeElement),
            true,
          );
          assert.equal((await query("access:overview")).status, "error");
        });
        if (plan.mode === "review")
          await scenario(`${viewport.name}-offline-signin`, "simulated-network", async () => {
            await page.route(
              "**/api/auth/sign-in/email",
              (route) => route.abort("internetdisconnected"),
              { times: 1 },
            );
            await page.getByLabel("E-mail", { exact: true }).fill("offline@validation.invalid");
            await page.getByLabel("Senha", { exact: true }).fill("synthetic-offline-only");
            await page.getByRole("button", { name: "Entrar no painel" }).click();
            await page.getByRole("alert").waitFor();
            assert.equal(
              await page.getByRole("heading", { name: "Acesso confirmado pelo servidor" }).count(),
              0,
            );
          });
        for (const account of plan.accounts) {
          // Better Auth resets its rolling count after a full idle window, not since sign-in.
          // Stop page activity between sessions; count from the last actual auth response.
          while (completedSessions && Date.now() - lastAuthAt < 61_000)
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(60_000, 61_000 - (Date.now() - lastAuthAt))),
            );
          let token;
          let loggedOut = false;
          let loginAttempted = false;
          try {
            await scenario(
              `${viewport.name}-${account.role}-session`,
              "product-integration",
              async () => {
                await browserStep(report, "open-login:goto", "page.goto", () =>
                  page.goto(`${target.consoleUrl}/login`),
                );
                await browserStep(report, "open-login:email", "locator.fill", () =>
                  page.getByLabel("E-mail", { exact: true }).fill(account.email),
                );
                await browserStep(report, "open-login:password", "locator.fill", () =>
                  page.getByLabel("Senha", { exact: true }).fill(account.password),
                );
                // Only sign-in must emit a new request. Token refresh/cache timing is internal.
                const signedIn = page
                  .waitForResponse((r) => r.url().endsWith("/api/auth/sign-in/email"))
                  .catch(() => null);
                loginAttempted = true;
                report.checkpoint = "submit-login";
                await page.getByRole("button", { name: "Entrar no painel" }).press("Enter");
                assert.equal(
                  (await signedIn)?.status(),
                  200,
                  "Sign-in failed; respect rate limit before rerunning",
                );
                // A verified account without a validation role is an ordinary user of the
                // product: the console opens its organizations, never the M0 page.
                await home(page, account.role);
                // Convex's plugin sets the JWT cookie on sign-in, including when no refresh is sent.
                // Read the same unexpired browser token that authorized the UI; never persist it.
                token = await page.evaluate(() => {
                  const stored = JSON.parse(localStorage.getItem("better-auth_cookie") || "{}");
                  const tokens = Object.entries(stored).filter(
                    ([name, item]) =>
                      name.endsWith(".convex_jwt") && Date.parse(item.expires) > Date.now(),
                  );
                  return tokens.length === 1 ? tokens[0][1].value : null;
                });
                report.checkpoint = "issued-token";
                assert.equal(typeof token, "string");
                const overview = await query("access:overview", token);
                report.checkpoint = "overview";
                if (account.role === "none") {
                  assert.equal(
                    await page
                      .getByRole("heading", { name: "Acesso confirmado pelo servidor" })
                      .count(),
                    0,
                  );
                  assert.equal(overview.status, "error");
                } else {
                  assert.equal(overview.value?.role, account.role);
                  assert.equal(overview.value?.environment, "validation");
                  await page
                    .getByText(
                      `Sessão válida · Perfil ${account.role === "operator" ? "operador" : "leitura"}`,
                      { exact: true },
                    )
                    .waitFor();
                }
                await accessible(page, `${viewport.name}-${account.role}`);
                report.checkpoint = "layout";
                await layout(page);
                report.checkpoint = "diagnostics";
                await page.goto(`${target.consoleUrl}/console/diagnostico`);
                await page.reload();
                // Every role waits for its own heading; the server's answer is checked apart.
                await page
                  .getByRole("heading", { name: diagnosticsHeading(account.role), exact: true })
                  .waitFor();
                if (account.role === "operator") {
                  assert.equal((await query("access:diagnostics", token)).status, "success");
                  await accessible(page, `${viewport.name}-diagnostics`);
                } else {
                  // The server denies the data and the page never shows it.
                  assert.equal((await query("access:diagnostics", token)).status, "error");
                  assert.equal(
                    await page
                      .getByRole("heading", { name: diagnosticsHeading("operator") })
                      .count(),
                    0,
                  );
                }
                // Return to a valid route after the forged diagnostics URL.
                await page.goto(`${target.consoleUrl}/console`);
                report.checkpoint = "logout-control";
                // The shell renders after the load, and `/console` sends an account without a
                // role on to `/app`; navigating closes the drawer. Open it only where the page
                // settled, or a drawer opened too early closes again.
                await home(page, account.role);
                // "Sair" is the last item of the account menu, at the foot of the sidebar
                // (a drawer on the phone, hidden while closed): reach both by keyboard.
                if (viewport.name === "mobile") {
                  await keyboardTo(page, page.getByRole("button", { name: "Abrir menu" }));
                  await page.keyboard.press("Enter");
                }
                // Not `account`: a const with that name would shadow the loop variable in the
                // whole callback, and its TDZ broke the login fill above with a ReferenceError.
                const accountMenu = page.getByRole("button", { name: /menu da conta/ });
                await accountMenu.waitFor();
                await keyboardTo(page, accountMenu);
                await page.keyboard.press("ArrowUp");
                await page.getByRole("menuitem", { name: "Sair", exact: true }).waitFor();
                // The menu focuses its last item after it renders, not with it.
                await page.waitForFunction(
                  () => document.activeElement?.textContent?.trim() === "Sair",
                );
                const signedOut = page.waitForResponse((r) =>
                  r.url().endsWith("/api/auth/sign-out"),
                );
                await page.keyboard.press("Enter");
                report.checkpoint = "logout-response";
                assert.equal((await signedOut).status(), 200);
                loggedOut = true;
                report.checkpoint = "revocation";
                // "Sair" ends at the landing; the console no longer opens for this browser.
                await page.waitForURL((address) => address.pathname === "/");
                assert.equal((await query("access:overview", token)).status, "error");
                await page.goto(`${target.consoleUrl}/console`);
                await page.getByRole("heading", { name: "Entre para continuar." }).waitFor();
              },
            );
          } finally {
            if (loginAttempted && !loggedOut) await signOut(page, token);
            await page.goto("about:blank");
            completedSessions++;
          }
        }
      } catch {
        // Only a fresh, anonymous login screenshot. Failure DOM/network can contain secrets.
        const evidenceContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const evidencePage = await evidenceContext.newPage();
          await evidencePage.goto(`${target.consoleUrl}/login`, { timeout: 20_000 });
          await evidencePage
            .getByRole("heading", { name: "Entre no painel." })
            .waitFor({ timeout: 15_000 });
          await evidencePage.screenshot({
            path: join(output, `${viewport.name}-anonymous-login.png`),
            fullPage: true,
            mask: [evidencePage.locator("input, textarea")],
          });
        } catch {
          /* Report still exists when the site itself is unavailable. */
        } finally {
          await evidenceContext.close();
        }
        throw new Error("Browser scenario failed");
      } finally {
        await context.close();
      }
    }
    await scenario("revision-after", "product-integration", revisions);
    await scenario("accessibility-gate", "automated-accessibility", async () => {
      assert.equal(report.accessibility.some(accessibilityBlocked), false);
    });
    report.result = "passed";
    report.stage = "complete";
  }
} catch {
  // Playwright errors may include filled form values. Publish only the fixed scenario ID.
  process.exitCode = 1;
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    report.result = "failed";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const summary = `# Navegador M0\n\nResultado: ${report.result}. Etapa: ${report.stage}. Modo: ${report.mode ?? "unknown"}.\n\nRunner: \`${report.runnerSha ?? "unknown"}\`; alterações locais: ${report.runnerDirty ?? "unknown"}. Publicado: \`${report.publishedSha ?? "unknown"}\`.\n\nCSS candidato SHA-256: ${report.candidateCssSha256 ?? "sem override"}.\n\nCenários aprovados: ${report.scenarios.filter((s) => s.result === "passed").length}/${report.scenarios.length}.\n\n${report.failure ? `Falha: \`${report.failure.checkpoint}\`, \`${report.failure.method}\`, ${report.failure.error}, ${report.failure.cause ?? "unknown"}.\n\n` : ""}M1–M4, zoom nativo, leitor de tela, integrador externo e integração fiscal continuam pendentes.\n`;
  writeFileSync(join(output, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify({ result: report.result, stage: report.stage, runId }));
}
