import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  validationTarget,
  validateTarget,
  verifyRemoteEnvironment,
  backendRequest,
} from "../../../scripts/lib/validation.mjs";
import { signOutButton } from "./shell.mjs";
import { homeDestination } from "./m0-headings.mjs";

// Explicit operator run against synthetic accounts. Never run with PR secrets.
if (process.env.GITHUB_ACTIONS === "true")
  throw new Error("Shared validation E2E is an operator-only command");
if (!process.env.VALIDATION_ACCESS_FILE)
  throw new Error("Set VALIDATION_ACCESS_FILE to the private account file");
const accounts = JSON.parse(readFileSync(process.env.VALIDATION_ACCESS_FILE, "utf8"));
assert.equal(accounts.url, validationTarget.consoleUrl);
assert.equal(accounts.accounts.length, 3);
const admin = process.env.VALIDATION_CONVEX_DEPLOY_KEY ? validateTarget(process.env) : null;
if (admin) await verifyRemoteEnvironment(admin);
const output = join(homedir(), ".freecorpsnfe", "validation-evidence");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const url = validationTarget.consoleUrl;
async function query(path, token) {
  const response = await fetch(`${validationTarget.url}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ path, args: {}, format: "json" }),
  });
  return response.json();
}
async function login(page, account) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(`${url}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(account.email);
    await page.getByLabel("Senha", { exact: true }).fill(account.password);
    const signedIn = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/sign-in/email"),
    );
    const tokenResponse = page
      .waitForResponse(
        (response) =>
          response.url().endsWith("/api/auth/convex/token") && response.status() === 200,
      )
      .then((response) => response.json())
      .catch(() => null);
    await page.getByRole("button", { name: "Entrar no painel" }).click();
    const response = await signedIn;
    if (response.status() === 429) {
      console.log("Respecting auth rate limit before next synthetic sign-in");
      const retryAfter = Number(
        response.headers()["x-retry-after"] ?? response.headers()["retry-after"] ?? 60,
      );
      assert.ok(Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 60);
      await page.waitForTimeout(Math.min(retryAfter + 1, 60) * 1000);
      continue;
    }
    assert.equal(response.status(), 200, "Synthetic sign-in must succeed");
    const token = (await tokenResponse)?.token;
    assert.equal(typeof token, "string", "Convex must issue a token after sign-in");
    return token;
  }
  throw new Error("Auth rate limit still active; rerun after the window resets");
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  page.setDefaultTimeout(25_000);
  const initial = await page.goto(`${url}/login`);
  assert.equal(initial.status(), 200);
  assert.match(initial.headers()["x-robots-tag"], /noindex/);
  assert.match(initial.headers()["content-security-policy"], /frame-ancestors 'none'/);
  await page.getByRole("heading", { name: "Entre no painel." }).waitFor();
  await page.screenshot({ path: join(output, "login-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, "login-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const build = await (await fetch(`${url}/build.json`)).json();
  assert.match(build.sha, /^[a-f0-9]{40}$/);
  await page.getByText(`Versão ${build.sha.slice(0, 7)}`).waitFor();
  assert.equal((await query("access:overview")).status, "error");
  for (const account of accounts.accounts) {
    assert.match(account.email, /^[a-z0-9.-]+@validation\.invalid$/);
    const token = await login(page, account);
    // Without a validation role the console opens the organization list, not the M0 page.
    const home = homeDestination(account.role);
    await page.waitForURL((address) => address.pathname === home.path);
    await page.getByRole("heading", { name: home.heading, exact: true }).waitFor();
    if (account.role === "none") {
      assert.equal((await query("access:overview", token)).status, "error");
    } else {
      const response = await query("access:overview", token);
      assert.equal(response.value?.role, account.role);
      if (account.role === "operator") {
        await page.screenshot({ path: join(output, "console-desktop.png"), fullPage: true });
        await page.getByRole("link", { name: "Diagnóstico" }).click();
        await page.reload();
        await page.getByRole("heading", { name: "Estado do ambiente." }).waitFor();
        await page.getByText("Preservado", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: join(output, "console-mobile.png"), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 960 });
      } else {
        assert.equal((await query("access:diagnostics", token)).status, "error");
        assert.equal(await page.getByRole("link", { name: "Diagnóstico" }).count(), 0);
      }
    }
    let releaseLogout;
    const logoutGate = new Promise((resolve) => {
      releaseLogout = resolve;
    });
    await page.route(
      "**/api/auth/sign-out",
      async (route) => {
        await logoutGate;
        await route.continue();
      },
      { times: 1 },
    );
    const signedOut = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/sign-out"),
    );
    await (await signOutButton(page)).click();
    await page.getByRole("heading", { name: "Encerrando sua sessão…" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Entre para continuar." }).count(), 0);
    releaseLogout();
    assert.equal((await signedOut).status(), 200);
    // "Sair" ends at the landing.
    await page.waitForURL((address) => address.pathname === "/");
    assert.equal((await query("access:overview", token)).status, "error");
    await page.goto(`${url}/console/diagnostico`);
    await page.getByRole("heading", { name: "Entre para continuar." }).waitFor();
    console.log(`PASS login, permission and logout: ${account.role}`);
  }
  if (admin) {
    const account = accounts.accounts.find((entry) => entry.role === "operator");
    const token = await login(page, account);
    await page.getByRole("heading", { name: "Acesso confirmado pelo servidor" }).waitFor();
    // Expire only this test browser's session, never all sessions or users.
    const sessionId = await page.evaluate(async (siteUrl) => {
      const cookies = Object.entries(
        JSON.parse(localStorage.getItem("better-auth_cookie") || "{}"),
      );
      const cookie = cookies.map(([key, item]) => `${key}=${item.value}`).join("; ");
      const response = await fetch(`${siteUrl}/api/auth/get-session`, {
        headers: { "Better-Auth-Cookie": cookie },
        credentials: "omit",
      });
      return (await response.json()).session.id;
    }, validationTarget.siteUrl);
    console.log("target: dev (modest-seal-118), expire the current synthetic browser session only");
    await backendRequest(admin, "/api/function", {
      componentPath: "betterAuth",
      path: "adapter:updateOne",
      args: {
        input: {
          model: "session",
          where: [{ field: "_id", value: sessionId }],
          update: { expiresAt: Date.now() - 1000 },
        },
      },
      format: "json",
    });
    assert.equal((await query("access:overview", token)).status, "error");
    await page.reload();
    await page.getByRole("heading", { name: "Entre para continuar." }).waitFor();
    console.log("PASS expired session rejected with previously valid JWT");
  } else
    console.log(
      "SKIP live expiry mutation: deployment credential not supplied; covered by isolated tests",
    );
  console.log(JSON.stringify({ passed: true, sha: build.sha, screenshots: output }));
} finally {
  await browser.close();
}
