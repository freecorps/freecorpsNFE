import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function usageJourney({
  page,
  site,
  urls,
  scope,
  slug,
  apiKey,
  bytes,
  file,
  rpc,
  capture,
  report,
  output,
}) {
  const args = {
    organizationId: scope.organizationId,
    period: new Date().toISOString().slice(0, 7),
    contextKey: "usage-proof",
  };
  const get = () => rpc("query", "usage:overview", args);
  await page.goto(`${site}/app/${slug}/usage`);
  await page.getByRole("heading", { name: "Uso e limites", exact: true }).waitFor();
  await capture("usage-before-plan");
  const before = await get();
  // Committed at each confirmation: pendente.xml, the two files of the panel batch, the API
  // duplicate and the historical v1 file (reprocessing commits nothing).
  assert.equal(before.environments.sandbox.find((r) => r.metric === "imports").committed, 5);
  assert.equal(before.environments.sandbox.find((r) => r.metric === "documents").committed, 2);
  assert.ok(before.environments.sandbox.find((r) => r.metric === "attempts").committed >= 5);
  assert.equal(before.environments.sandbox.find((r) => r.metric === "imports").reserved, 0);
  const plan = {
    organizationId: scope.organizationId,
    name: "Plano assistido de teste",
    startsAt: Date.now() - 60000,
    endsAt: Date.now() + 3600000,
    // One unit above the five committed: of 20 parallel reservations, exactly one fits.
    limits: { imports: 6, captures: 1, registry: 1, bytes: 1024 * 1024, deliveries: 1 },
    concurrency: 2,
    actor: "native-proof",
    reason: "Jornada sintética de limite",
    expectedVersion: 0,
  };
  await rpc("mutation", "usage:assignPlan", plan, true);
  const request = {
    companyId: scope.companyId,
    files: [
      {
        name: "limite.xml",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const reserveThroughApi = (key) =>
    fetch(`${urls.site}/v1/imports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Environment": "sandbox",
        "Idempotency-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  const reservedImports = async () =>
    (await get()).environments.sandbox.find((r) => r.metric === "imports").reserved;
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => reserveThroughApi(`quota-${i}`)),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => r.status === 429).length, 19);
  const accepted = await responses.find((r) => r.status === 200).json();
  const totals = await get();
  assert.equal(totals.environments.sandbox.find((r) => r.metric === "imports").reserved, 1);
  await page.getByText("Limite atingido em Sandbox. Novas operações", { exact: false }).waitFor();
  // The shell's drawer slides out when the viewport crosses 960 px: a photo taken right after the
  // resize catches it halfway (#471). Record that, then wait for every transition before the photo
  // and check that 390 px has no horizontal scroll.
  const layout = {};
  async function settle() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
  }
  const measure = () =>
    page.evaluate(() => {
      const sidebar = getComputedStyle(document.querySelector(".app-sidebar"));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        sidebarVisibility: sidebar.visibility,
        sidebarTransform: sidebar.transform,
        running: document.getAnimations().length,
        tabsScrollWidth: document.querySelector(".ui-tabs__list").scrollWidth,
        tabsClientWidth: document.querySelector(".ui-tabs__list").clientWidth,
      };
    });
  async function both(name) {
    await settle();
    await capture(`${name}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    layout[name] ??= { afterResize: await measure() };
    await settle();
    const settled = await measure();
    layout[name].settled = settled;
    assert.ok(settled.scrollWidth <= settled.clientWidth, `${name}: horizontal scroll at 390 px`);
    assert.equal(settled.sidebarVisibility, "hidden", `${name}: drawer still on screen`);
    assert.ok(
      settled.tabsScrollWidth <= settled.tabsClientWidth,
      `${name}: environment tabs cut at 390 px`,
    );
    await capture(`${name}-mobile`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle();
  }
  await both("usage-limit");
  // #429: production has its own balance under the same limits; the sandbox limit stays where it is.
  for (const [metric, quantity] of [
    ["captures", 1],
    ["bytes", 524288],
  ])
    await rpc(
      "mutation",
      "testing/usageProof:record",
      {
        organizationId: scope.organizationId,
        environment: "production",
        metric,
        key: `production-${metric}`,
        quantity,
      },
      true,
    );
  const split = await get();
  assert.equal(split.environments.production.find((r) => r.metric === "captures").committed, 1);
  assert.equal(split.environments.production.find((r) => r.metric === "imports").committed, 0);
  assert.equal(split.environments.sandbox.find((r) => r.metric === "captures").committed, 0);
  assert.equal(split.environments.sandbox.find((r) => r.metric === "imports").reserved, 1);
  const sandboxTab = page.getByRole("tab", { name: /^Sandbox/ });
  await sandboxTab.focus();
  await page.keyboard.press("ArrowRight");
  const productionTab = page.getByRole("tab", { name: /^Produção/ });
  assert.equal(await productionTab.getAttribute("aria-selected"), "true");
  await page.getByText("Limite atingido em Produção. Novas operações", { exact: false }).waitFor();
  await page.locator(".gestao-metric__value", { hasText: "512 KiB" }).waitFor();
  await both("usage-production");
  await productionTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByText("Limite atingido em Sandbox. Novas operações", { exact: false }).waitFor();
  // Usage written before #429, without environment: the notice, then the backfill clears it.
  const legacyBytes = 4096;
  await rpc(
    "mutation",
    "testing/usageProof:legacy",
    {
      organizationId: scope.organizationId,
      fileId: accepted.data.fileIds[0],
      quantity: legacyBytes,
    },
    true,
  );
  const unattributed = await get();
  assert.equal(unattributed.unattributed, true);
  const sandboxBytes = (overview) =>
    overview.environments.sandbox.find((r) => r.metric === "bytes").committed;
  const productionBytes = (overview) =>
    overview.environments.production.find((r) => r.metric === "bytes").committed;
  assert.equal(sandboxBytes(unattributed), sandboxBytes(split) + legacyBytes);
  assert.equal(productionBytes(unattributed), productionBytes(split) + legacyBytes);
  await page.getByText("Consumo anterior em atribuição.", { exact: true }).waitFor();
  await both("usage-unattributed");
  await rpc("mutation", "usageMigration:backfillEnvironment", { cursor: null }, true);
  await page
    .getByText("Consumo anterior em atribuição.", { exact: true })
    .waitFor({ state: "detached" });
  const attributed = await get();
  assert.equal(attributed.unattributed, false);
  // The legacy key names a sandbox import file: its bytes stay in the sandbox only.
  assert.equal(sandboxBytes(attributed), sandboxBytes(split) + legacyBytes);
  assert.equal(productionBytes(attributed), productionBytes(split));
  const backfill = {
    legacyBytes,
    before: { sandbox: sandboxBytes(unattributed), production: productionBytes(unattributed) },
    after: { sandbox: sandboxBytes(attributed), production: productionBytes(attributed) },
  };
  await page.goto(`${site}/app/${slug}/imports?company=${scope.companyId}`);
  await page
    .getByLabel("Arraste os XMLs aqui ou escolha os arquivos")
    .setInputFiles({ name: "bloqueado.xml", mimeType: "application/xml", buffer: bytes });
  await page.getByRole("button", { name: "Importar arquivos", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "atingiu o limite do plano" }).waitFor();
  await capture("usage-blocked-import");
  // The reserved import came from the API key: a person in the console cannot cancel it
  // (INTEGRATION_RECORD, #223), so the reservation stays with the integration.
  await assert.rejects(
    rpc("mutation", "imports:cancel", { fileId: accepted.data.fileIds[0] }),
    /INTEGRATION_RECORD/,
  );
  assert.equal(await reservedImports(), 1);
  // Cancellation still releases the quota through a valid path: the console cancels a batch
  // the console created. Two more units let the console reserve two files; A's upload is held
  // and the person cancels while it is in flight (#506): B must never be sent.
  await rpc(
    "mutation",
    "usage:assignPlan",
    {
      ...plan,
      limits: { ...plan.limits, imports: 8 },
      startsAt: Date.now() - 60000,
      expectedVersion: 1,
    },
    true,
  );
  await page.goto(`${site}/app/${slug}/imports?company=${scope.companyId}`);
  const context = page.context();
  const held = [];
  await context.route("**/v1/import-upload", (route) =>
    route.request().method() === "POST" ? held.push(route) : route.continue(),
  );
  await page.getByLabel("Arraste os XMLs aqui ou escolha os arquivos").setInputFiles([
    { name: "cancelavel-a.xml", mimeType: "application/xml", buffer: bytes },
    { name: "cancelavel-b.xml", mimeType: "application/xml", buffer: bytes },
  ]);
  await page.getByRole("button", { name: "Importar arquivos", exact: true }).click();
  await page.waitForURL(/[?&]batch=/);
  const consoleBatch = new URL(page.url()).searchParams.get("batch");
  assert.ok(consoleBatch, "The console reservation must be in the URL");
  for (let attempt = 0; attempt < 30 && !held.length; attempt++) await delay(250);
  assert.equal(held.length, 1, "A's upload must be in flight");
  assert.equal(await reservedImports(), 3);
  const whileFull = await reserveThroughApi("quota-console-pending");
  assert.equal(whileFull.status, 429);
  // Mid-upload the drop area is unavailable and says why, with its text at full contrast (#526).
  await page.getByText("Aguarde o fim do envio.").waitFor();
  await settle();
  await capture("usage-console-pending");
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  await capture("usage-console-pending-mobile");
  // The "Sistema" theme follows the system, so both themes are checked on the same held upload.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await settle();
  await capture("usage-console-pending-dark-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settle();
  await capture("usage-console-pending-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await settle();
  await page.getByRole("button", { name: "Cancelar uploads pendentes", exact: true }).click();
  const cancelText = "2 envios cancelados; esses arquivos não serão processados.";
  await page.getByText(cancelText, { exact: true }).waitFor();
  // Whatever the server or the network answers late, the sequence does not resume.
  await delay(2000);
  assert.equal(held.length, 1, "Cancelling during A must never start B");
  // Focus reads the notice out, so it carries no live region that would repeat it.
  const focused = await page.evaluate(() =>
    document.activeElement === document.body
      ? null
      : {
          text: document.activeElement?.textContent,
          live: !!document.activeElement?.querySelector("[role=status],[role=alert]"),
        },
  );
  assert.deepEqual(focused, { text: cancelText, live: false }, "Focus must land on the notice");
  await Promise.all(held.map((route) => route.abort("failed").catch(() => {})));
  let released;
  for (let attempt = 0; attempt < 30; attempt++) {
    released = await reservedImports();
    if (released === 1) break;
    await delay(500);
  }
  assert.equal(released, 1, "Cancelling the console batch must release its reservation");
  await context.unroute("**/v1/import-upload");
  const cancelled = await rpc("query", "imports:get", { importId: consoleBatch });
  assert.deepEqual(
    cancelled.files.map((item) => item.state),
    ["expired", "expired"],
  );
  const afterCancel = await reserveThroughApi("quota-after-console-cancel");
  assert.equal(afterCancel.status, 200, "The released unit must be admitted again");
  assert.equal(await reservedImports(), 2);
  // The screen shows the persisted outcome of each cancelled file, and the batch, with nothing
  // imported, says the same instead of "Concluída" (#507). The recent list repeats the badge, so
  // each check is scoped to its own block.
  const fileOutcome = page
    .locator(".fiscal-import-file")
    .getByText("Envio não concluído", { exact: true });
  await fileOutcome.first().waitFor();
  assert.equal(await fileOutcome.count(), 2);
  const batchOutcome = page.locator(".fiscal-import-summary");
  await batchOutcome.getByText("Envio não concluído", { exact: true }).waitFor();
  assert.match(await batchOutcome.innerText(), /2 não enviados/);
  await capture("usage-console-cancelled");
  await rpc(
    "mutation",
    "usage:assignPlan",
    { ...plan, startsAt: Date.now() - 60000, endsAt: Date.now() - 1, expectedVersion: 2 },
    true,
  );
  await page.goto(`${site}/app/${slug}/usage`);
  await page.getByRole("alert").filter({ hasText: "Plano fora da vigência" }).waitFor();
  await capture("usage-expired-plan");
  const read = await fetch(
    `${urls.site}/v1/documents/${file.documentId}?companyId=${scope.companyId}`,
    { headers: { Authorization: `Bearer ${apiKey}`, "X-Environment": "sandbox" } },
  );
  assert.equal(read.status, 200);
  const document = (await read.json()).data;
  const original = await fetch(
    `${urls.site}/v1/document-artifacts/${document.version.artifactId}/original?companyId=${scope.companyId}`,
    { headers: { Authorization: `Bearer ${apiKey}`, "X-Environment": "sandbox" } },
  );
  assert.equal(original.status, 200);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await original.arrayBuffer()))
      .digest("hex"),
    createHash("sha256").update(bytes).digest("hex"),
  );
  await page.reload();
  await page.getByRole("heading", { name: "Uso e limites", exact: true }).waitFor();
  report.scenarios.push(
    "usage-subscription-corresponds-to-domain-events",
    "twenty-concurrent-http-requests-reserve-only-last-unit",
    "quota-message-in-import-ui",
    "console-cannot-cancel-integration-import",
    "console-cancellation-releases-quota",
    "console-cancel-stops-upload-sequence",
    "expired-plan-preserves-authorized-document-and-original",
    "usage-direct-route-mobile-and-reload",
    "usage-environments-separate-balances",
    "usage-unattributed-notice-cleared-by-backfill",
  );
  report.usage = {
    observedBeforePlan: before.environments.sandbox,
    productionBeside: split.environments.production,
    concurrentRequests: 20,
    accepted: 1,
    refused: 19,
    consoleCancellation: {
      importId: consoleBatch,
      whileFull: 429,
      afterCancel: 200,
      uploadsRequested: held.length,
      notice: cancelText,
    },
    afterConsoleCancellation: (await get()).environments.sandbox,
    layout,
    backfill,
  };
  writeFileSync(
    join(output, "load-source.json"),
    JSON.stringify({ sourceId: file.documentId, codeSha: report.codeSha, localOnly: true }) + "\n",
    "utf8",
  );
}
