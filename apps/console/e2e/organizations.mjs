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
import { localAuthPacer } from "./local-auth-pacing.mjs";
import { worktreePaths } from "../../../scripts/lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../scripts/lib/worktree/env-file.mjs";
import { assertLinkedWorktree } from "../../../scripts/lib/worktree/state.mjs";
import { currentOrganization, organizationOption, switchOrganization } from "./shell.mjs";
import { managementSession, managementSessionHash } from "./management-session.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
await withLocalBrowser(root, "organizations", async () => {
  const paths = worktreePaths(root);
  assertLinkedWorktree(paths);
  assert.equal(paths.app, "platform");
  const config = readLocalConfig(paths),
    urls = localUrls(config),
    site = currentLocalSiteUrl(paths);
  assert.ok(site && new URL(site).hostname === "localhost");
  const output = join(root, ".browser-results/organizations");
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
    dataset: "four synthetic verified users; four organizations; local invitations only",
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
  const paceAuth = localAuthPacer(report);
  const contexts = [];
  async function account(name) {
    // Local auth has one shared IP bucket. Keep independent real signup journeys outside its window.
    report.step = `phase: ${name}`;
    console.log(report.step);
    report.step = `signup: ${name}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    await paceAuth(context);
    const page = await context.newPage();
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
    const match = path.match(/^\/app\/([^/]+)(?:\/settings\/[^/]+)?$/);
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
  try {
    browser = await chromium.launch({ headless: true });
    const owner = await account("Proprietária de demonstração"),
      admin = await account("Administradora de demonstração"),
      viewer = await account("Leitor de demonstração"),
      outsider = await account("Outra equipe de demonstração");
    await visit(owner, `/app`);
    await owner.page.getByRole("heading", { name: "Organizações", exact: true }).waitFor();
    await capture(owner, "organizations-empty");
    const a = await create(owner, "Equipe Ipê"),
      b = await create(owner, "Equipe Oliveira"),
      c = await create(outsider, "Equipe Araucária");
    await capture(owner, "organization-created");
    const adminToken = await send(owner, a, admin, "admin");
    await denied(outsider, "action", "invitations:accept", { token: adminToken });
    await accept(admin, adminToken, a);
    const bToken = await send(owner, b, admin, "viewer");
    await accept(admin, bToken, b);
    const viewerToken = await send(owner, a, viewer, "viewer");
    const viewerAuthorization = await authorization(viewer);
    const consumes = await Promise.all(
      [0, 1].map(() =>
        rpc("action", "invitations:accept", { token: viewerToken }, viewerAuthorization),
      ),
    );
    assert.equal(consumes.filter((result) => result.status === "success").length, 1);
    assert.equal(consumes.filter((result) => result.status === "error").length, 1);
    report.scenarios.push(
      "real-signup-create-explicit-local-invite-verified-email-accept",
      "invitation-secret-absent-from-url-and-browser-storage",
      "wrong-email-refused",
      "concurrent-invitation-consumption-exactly-once",
    );
    await visit(admin, `/app/${a.slug}/settings/members`);
    await admin.page.getByRole("heading", { name: "Membros", exact: true }).waitFor();
    await capture(admin, "members-admin");
    const roleOptions = await admin.page
      .getByLabel("Papel no convite")
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value));
    assert.deepEqual(roleOptions, ["developer", "operator", "viewer"]);
    await visit(owner, `/app/${a.slug}/settings/organization`);
    await owner.page
      .getByLabel("Nome da organização", { exact: true })
      .fill("Equipe Ipê Atualizada");
    await owner.page.getByRole("button", { name: "Salvar configurações" }).click();
    await owner.page.getByText("Nome da organização atualizado.", { exact: true }).waitFor();
    a.name = "Equipe Ipê Atualizada";
    await capture(owner, "organization-settings");
    // Warm both organizations. A draft and pending role selection must not survive switching away/back.
    await admin.page.getByLabel("E-mail da pessoa").fill("draft-private@development.invalid");
    await admin.page.getByLabel("Papel no convite").selectOption("operator");
    await switchOrganization(admin.page, b.slug);
    await currentOrganization(admin.page, b.name).waitFor();
    assert.equal(await admin.page.getByLabel("E-mail da pessoa").count(), 0);
    assert.equal(
      await admin.page
        .getByRole("navigation", { name: "Navegação da organização" })
        .getByRole("link", { name: "Membros", exact: true })
        .count(),
      0,
    );
    await switchOrganization(admin.page, a.slug);
    await currentOrganization(admin.page, a.name).waitFor();
    await admin.page.getByRole("link", { name: "Membros", exact: true }).click();
    assert.equal(await admin.page.getByLabel("E-mail da pessoa").inputValue(), "");
    assert.equal(await admin.page.getByLabel("Papel no convite").inputValue(), "viewer");
    report.scenarios.push("context-switch-clears-private-forms-and-role-selection-with-warm-cache");
    for (const query of ["organizations:members", "organizations:activity", "invitations:list"])
      await denied(outsider, "query", query, { organizationId: a.id, paginationOpts, contextKey });
    await denied(outsider, "mutation", "organizations:update", {
      organizationId: a.id,
      name: "Forged",
    });
    await denied(owner, "mutation", "organizations:removeMember", {
      organizationId: a.id,
      membershipId: c.membershipId,
      expectedVersion: c.membershipVersion,
    });
    await visit(outsider, `/app/${a.slug}/settings/members`);
    await outsider.page.getByRole("heading", { name: "Organização indisponível." }).waitFor();
    assert.equal(await outsider.page.getByText(a.name, { exact: true }).count(), 0);
    await capture(outsider, "foreign-organization-denied");
    await visit(viewer, `/app/${a.slug}/settings/members`);
    await viewer.page
      .getByRole("heading", { name: "Página indisponível para seu papel." })
      .waitFor();
    assert.equal(await viewer.page.getByLabel("E-mail da pessoa").count(), 0);
    await capture(viewer, "viewer-denied");
    await visit(owner, `/app/${a.slug}/settings/members`);
    const viewerRow = owner.page
      .getByRole("row")
      .filter({ has: owner.page.getByText(viewer.email, { exact: true }) })
      .first();
    await viewerRow.getByLabel(`Papel de ${viewer.name}`).selectOption("operator");
    await viewerRow.getByRole("button", { name: "Salvar papel", exact: true }).click();
    await viewerRow.locator(".ui-badge").filter({ hasText: "Operador" }).waitFor();
    report.scenarios.push("owner-changes-member-role-through-ui");
    report.scenarios.push(
      "cross-organization-direct-queries-mutation-url-and-forged-member-id-refused",
      "viewer-url-cannot-open-management",
      "admin-cannot-grant-owner-or-admin",
    );
    await viewer.context.close();
    await outsider.context.close();
    report.step = "phase: removal recording";
    console.log(report.step);
    // A second authenticated view stays on A while the first warms B. Record only this segment,
    // after authentication: the video never includes passwords or verification/invitation codes.
    const removalContext = await browser.newContext({
      storageState: await admin.context.storageState(),
      viewport: { width: 1280, height: 900 },
      recordVideo: { dir: join(output, "video"), size: { width: 1280, height: 900 } },
    });
    contexts.push(removalContext);
    await paceAuth(removalContext);
    const removalPage = await removalContext.newPage();
    await delay(8_000);
    await removalPage.goto(`${site}/app/${a.slug}/settings/members`);
    await removalPage.getByRole("heading", { name: "Membros", exact: true }).waitFor();
    await switchOrganization(admin.page, b.slug);
    await currentOrganization(admin.page, b.name).waitFor();
    await visit(owner, `/app/${a.slug}/settings/members`);
    const row = owner.page
      .getByRole("row")
      .filter({ has: owner.page.getByText(admin.email, { exact: true }) })
      .first();
    await row.getByRole("button", { name: "Remover membro", exact: true }).click();
    await owner.page
      .getByRole("alertdialog", { name: `Remover ${admin.name}?` })
      .getByRole("button", { name: "Confirmar remoção" })
      .click();
    await removalPage
      .getByRole("heading", {
        name: /Organização indisponível.|Não foi possível confirmar o acesso/,
      })
      .waitFor();
    assert.equal(await removalPage.locator("input").count(), 0);
    assert.equal(await removalPage.getByText(viewer.email, { exact: true }).count(), 0);
    await delay(1_000);
    await removalContext.close();
    await removalPage.video().saveAs(join(output, "membership-removal.webm"));
    await denied(admin, "query", "organizations:members", {
      organizationId: a.id,
      paginationOpts,
      contextKey,
    });
    await denied(admin, "mutation", "organizations:update", {
      organizationId: a.id,
      name: "Stale access",
    });
    await currentOrganization(admin.page, b.name).waitFor();
    assert.equal((await organizationOption(admin.page, a.slug)).listed, false);
    // Browser back uses the still-mounted SPA client and its previously visited queries.
    await admin.page.goBack();
    await admin.page.getByRole("heading", { name: "Organização indisponível." }).waitFor();
    await capture(admin, "removed-member-warm-cache");
    report.scenarios.push(
      "open-management-page-clears-after-removal",
      "removed-member-cannot-read-write-or-reenter-warm-context",
      "browser-back-rechecks-removed-membership-without-reloading-the-spa",
    );
    // The completed viewers no longer renew JWTs. Keep the next independent concurrency phase
    // outside the previous local token bucket instead of changing production authentication limits.
    report.step = "phase: owner concurrency";
    console.log(report.step);
    const d = await create(owner, "Equipe Jacarandá");
    const secondOwnerToken = await send(owner, d, admin, "owner");
    await accept(admin, secondOwnerToken, d);
    const secondOwner = await success(admin, "query", "organizations:context", {
      slug: d.slug,
      contextKey,
    });
    const changes = await Promise.all(
      [
        [owner, d],
        [admin, secondOwner],
      ].map(async ([user, membership]) =>
        rpc(
          "mutation",
          "organizations:changeRole",
          {
            organizationId: d.id,
            membershipId: membership.membershipId,
            expectedVersion: membership.membershipVersion,
            role: "viewer",
          },
          await authorization(user),
        ),
      ),
    );
    assert.equal(changes.filter((result) => result.status === "success").length, 1);
    assert.equal(changes.filter((result) => result.status === "error").length, 1);
    const after = await success(owner, "query", "organizations:context", {
      slug: d.slug,
      contextKey,
    });
    assert.equal(after.ownerCount, 1);
    assert.equal(after.memberCount, 2);
    const remainingMembers = await success(
      after.role === "owner" ? owner : admin,
      "query",
      "organizations:members",
      {
        organizationId: d.id,
        paginationOpts,
        contextKey,
      },
    );
    assert.equal(remainingMembers.page.filter((member) => member.role === "owner").length, 1);
    report.scenarios.push("two-concurrent-owner-demotions-preserve-exactly-one-owner");
    await admin.context.close();
    report.step = "phase: final captures";
    console.log(report.step);
    await visit(owner, `/app/${a.slug}/settings/members`);
    await owner.page.getByRole("heading", { name: "Membros", exact: true }).waitFor();
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
    await capture(owner, "members-owner");
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await capture(owner, "members-mobile");
    await visit(owner, `/accept-invitation`);
    await owner.page.getByLabel("Código do convite").waitFor();
    await capture(owner, "accept-invitation-mobile");
    report.scenarios.push(
      "green-theme-tokens-preserved",
      "desktop-mobile-accessibility-and-overflow",
    );
    report.result = "passed";
  } catch (error) {
    finalization.fail(error);
    await finalization.attempt(async () => {
      // Browser actions may contain credentials in diagnostics. Keep only the error class in the receipt.
      report.failure = error instanceof Error ? error.name : "UnknownError";
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
