import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { processNfe, deriveFiscalSituation } from "../../../packages/fiscal-nfe/dist/index.js";
import { currentOrganization, switchOrganization } from "./shell.mjs";
import { allowTypeScriptSourceImports } from "./ts-source-imports.mjs";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

allowTypeScriptSourceImports();
const { projectNfePayload, projectNfeItem } =
  await import("../../../packages/contracts/src/documents.ts");

export async function documentsJourney({
  page,
  site,
  urls,
  scope,
  slug,
  keyId,
  apiKey,
  bytes,
  file,
  rest,
  rpc,
  capture,
  report,
}) {
  console.log("documents: public DTO, items, original and responsive tabs");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const base = `${site}/app/${slug}/documents`,
    query = `companyId=${scope.companyId}`;
  const path = `/v1/documents/${file.documentId}`;
  const get = (suffix = "", extra = "") => rest(`${path}${suffix}?${query}${extra}`);
  async function ready() {
    for (let i = 0; i < 60; i++) {
      const detail = await get();
      if (detail.summary.projectionState === "ready") return detail;
      await delay(500);
    }
    throw new Error("Document projection did not settle");
  }
  const detail = await ready(),
    model = processNfe(bytes);
  assert.deepEqual(detail.payload, projectNfePayload(model.normalized.document));
  assert.deepEqual(detail.fiscalSituation, deriveFiscalSituation([model]));
  assert.ok(!JSON.stringify(detail).includes("storageId"));
  const items = await get("/items", `&versionId=${detail.version.id}&limit=1`);
  assert.deepEqual(items.page, model.normalized.document.products.slice(0, 1).map(projectNfeItem));
  const headers = { Authorization: `Bearer ${apiKey}`, "X-Environment": "sandbox" };
  const downloadPath = `/v1/document-artifacts/${detail.version.artifactId}/original?${query}`;
  const downloaded = await fetch(urls.site + downloadPath, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(bytes));
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  const selected = await rpc(
    "mutation",
    "testing/documentProof:selectorPages",
    { companyId: scope.companyId, projectId: scope.integrationProjectId },
    true,
  );
  const firstCompanies = await rpc("query", "companies:list", {
    organizationId: scope.organizationId,
    contextKey: "document-proof",
    paginationOpts: { cursor: null, numItems: 20 },
  });
  assert.ok(!firstCompanies.page.some((row) => row.id === selected.companyId));
  // Console sem projeto: the deep link carries only the company.
  await page.goto(`${base}?company=${selected.companyId}`);
  await page.getByRole("option", { name: /^Empresa paginada 21/ }).waitFor({ state: "attached" });
  assert.equal(await page.getByLabel("Empresa dos documentos").inputValue(), selected.companyId);
  assert.equal(await page.getByLabel("Projeto com acesso de leitura").count(), 0);
  await capture("documents-deep-link-outside-first-page");
  report.scenarios.push("documents-deep-linked-company-outside-first-page");
  await page.goto(`${base}?company=invalid`);
  await page.getByRole("heading", { name: "Documentos fiscais", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Empresa indisponível", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Empresa dos documentos").inputValue(), "");
  await page.goto(`${base}?company=${scope.companyId}`);
  await page.getByRole("button", { name: "NF-e 69", exact: true }).waitFor();
  await capture("documents-list-desktop");
  // The refused files live in the import page; the list only points to them.
  await page.getByRole("link", { name: "Ver arquivos recusados", exact: true }).click();
  await page.getByRole("heading", { name: "Arquivos recusados", exact: true }).waitFor();
  await page.getByText("Original e SHA-256", { exact: true }).first().click();
  await page.getByText("XML sem documento reconhecido.", { exact: false }).first().waitFor();
  await capture("documents-unknown-original");
  await page.goto(`${base}?company=${scope.companyId}`);
  await page.getByRole("button", { name: "NF-e 69", exact: true }).click();
  await page.getByRole("tab", { name: "Dados", exact: true }).waitFor();
  await capture("documents-detail-desktop");
  await page.getByRole("tab", { name: "Itens", exact: true }).click();
  await page
    .getByRole("heading", { name: `1. ${items.page[0].description}`, exact: true })
    .waitFor();
  await capture("documents-items-desktop");
  // The detail is the document's own page: its title, no list title or company picker.
  await page.getByRole("heading", { level: 1, name: "NF-e 69", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Empresa dos documentos").count(), 0);
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByRole("tabpanel").locator("pre").waitFor();
  // The JSON tab is the public DTO, the same body as GET /v1/documents/{id}/json.
  assert.deepEqual(
    JSON.parse(await page.getByRole("tabpanel").locator("pre").textContent()),
    detail,
  );
  await capture("documents-json-desktop");
  await page.getByRole("tab", { name: "Arquivos e histórico", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar original", exact: true }).first().click();
  const browserDownload = await downloadEvent;
  assert.equal(hash(readFileSync(await browserDownload.path())), hash(bytes));
  await page.getByRole("button", { name: "Exibir XML como texto", exact: true }).first().click();
  await page.getByRole("tabpanel").locator("pre").waitFor();
  assert.equal(
    await page.getByRole("tabpanel").locator("pre").first().textContent(),
    bytes.toString("utf8"),
  );
  assert.equal(await page.locator("NFe, infNFe, script[xmlns]").count(), 0);
  await capture("documents-original-text");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("documents-detail-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforeRebuild = await rpc(
    "query",
    "testing/documentProof:projection",
    { documentId: file.documentId },
    true,
  );
  await page
    .getByRole("button", { name: "Reconstruir a situação pelos originais", exact: true })
    .click();
  let rebuilt;
  for (let i = 0; i < 60; i++) {
    rebuilt = await rpc(
      "query",
      "testing/documentProof:projection",
      { documentId: file.documentId },
      true,
    );
    if (rebuilt.generation > beforeRebuild.generation && rebuilt.state === "ready") break;
    await delay(500);
  }
  assert.ok(rebuilt.generation > beforeRebuild.generation);
  assert.equal(rebuilt.state, "ready");
  assert.deepEqual((await ready()).fiscalSituation, detail.fiscalSituation);
  console.log("documents: reconstruction and asynchronous reprocessing");
  await page.getByRole("button", { name: "Reprocessar XML atual", exact: true }).click();
  await page.getByText("Reprocessamento: concluído.", { exact: true }).waitFor();
  await ready();
  const versions = await get("/versions");
  assert.ok(versions.page.some((row) => row.version.id === detail.version.id));
  assert.ok(versions.page.length >= 2);
  await page.getByRole("button", { name: "Reprocessar XML atual", exact: true }).click();
  let repeatedVersions;
  for (let i = 0; i < 60; i++) {
    repeatedVersions = await get("/versions");
    if (repeatedVersions.page.length > versions.page.length) break;
    await delay(500);
  }
  assert.ok(repeatedVersions.page.length > versions.page.length);
  await page.getByText("Reprocessamento: concluído.", { exact: true }).waitFor();
  await capture("documents-reprocess-history");
  report.receipts.push({
    documents: { detail, items, originalSha256: hash(bytes), versions, repeatedVersions },
  });
  report.scenarios.push(
    "documents-package-api-panel-contract-equivalence",
    "documents-native-original-and-browser-download-hash",
    "documents-native-rebuild-originals-equals-consulted-state",
    "documents-native-reprocess-keeps-history",
    "documents-native-reprocess-again-without-reload",
    "documents-desktop-mobile-axe-no-overflow",
    "documents-malformed-context-clears-selection",
  );
  const singleItem = bytes.toString("utf8").match(/<det nItem="1">[\s\S]*?<\/det>/)[0];
  const oldKey = model.normalized.document.key,
    keyBase = oldKey.slice(0, 25) + "000000072" + oldKey.slice(34, 43);
  let sum = 0;
  for (let i = keyBase.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
    sum += (keyBase.charCodeAt(i) - 48) * weight;
  const digit = String(sum % 11 < 2 ? 0 : 11 - (sum % 11)),
    newKey = keyBase + digit;
  const manyBytes = Buffer.from(
    bytes
      .toString("utf8")
      .replace(/<Signature\b[\s\S]*?<\/Signature>/, "")
      .replaceAll(oldKey, newKey)
      .replace("<nNF>69</nNF>", "<nNF>72</nNF>")
      .replace(/<cDV>\d<\/cDV>/, `<cDV>${digit}</cDV>`)
      .replace(
        singleItem,
        Array.from({ length: 60 }, (_, i) =>
          singleItem
            .replace('nItem="1"', `nItem="${i + 1}"`)
            .replace(/<xProd>[^<]*<\/xProd>/, "<xProd>&lt;img src=x onerror=alert(1)&gt;</xProd>"),
        ).join(""),
      ),
  );
  const many = await rest("/v1/imports", "POST", {
    companyId: scope.companyId,
    files: [{ name: "sessenta-itens.xml", size: manyBytes.length, sha256: hash(manyBytes) }],
  });
  assert.equal(processNfe(manyBytes).checks.identity.status, "passed");
  const manyPath = `/v1/imports/${many.importId}/files/${many.fileIds[0]}`;
  const uploadTicket = await rest(`${manyPath}/upload`, "POST");
  assert.equal(
    (
      await fetch(uploadTicket.url, {
        method: "POST",
        headers: { "X-Upload-Token": uploadTicket.token },
        body: manyBytes,
      })
    ).status,
    200,
  );
  await rest(`${manyPath}/confirm`, "POST");
  let manyDetail;
  for (let i = 0; i < 60; i++) {
    const current = await rest(`/v1/imports/${many.importId}`);
    if (current.files[0].state === "succeeded")
      manyDetail = await rest(`/v1/documents/${current.files[0].documentId}?${query}`);
    if (manyDetail?.version.itemCount === 60 && manyDetail.summary.projectionState === "ready")
      break;
    await delay(500);
  }
  assert.equal(manyDetail.version.itemCount, 60);
  let cursor = null,
    pages = 0;
  const exactItems = [];
  do {
    const batch = await rest(
      `/v1/documents/${manyDetail.summary.id}/items?${query}&versionId=${manyDetail.version.id}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    exactItems.push(...batch.page);
    cursor = batch.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(
    exactItems,
    processNfe(manyBytes).normalized.document.products.map(projectNfeItem),
  );
  await page.goto(`${base}?company=${scope.companyId}&document=${manyDetail.summary.id}`);
  await page.getByRole("tab", { name: "Itens", exact: true }).click();
  await page
    .getByRole("heading", { name: "1. <img src=x onerror=alert(1)>", exact: true })
    .waitFor();
  // Every list of the console pages with the same previous/next control.
  await page
    .getByRole("navigation", { name: "Páginas de itens" })
    .getByRole("button", { name: "Próxima página", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "11. <img src=x onerror=alert(1)>", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("tabpanel").locator("img").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("documents-many-items-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.receipts.push({
    manyItems: {
      count: exactItems.length,
      pages,
      originalSha256: hash(manyBytes),
      first: exactItems[0],
      last: exactItems.at(-1),
    },
  });
  report.scenarios.push(
    "documents-sixty-items-three-api-pages-exact",
    "documents-item-cursor-ui-next-page",
    "documents-html-like-description-is-text",
  );
  const other = await rpc("mutation", "organizations:create", {
    name: "Outro contexto sintético",
    slug: `docs-other-${crypto.randomUUID()}`,
    ...(await termsAcceptance((path, args) => rpc("query", path, args))),
  });
  await switchOrganization(page, other.slug);
  await currentOrganization(page, "Outro contexto sintético").waitFor();
  // Nothing of the document survives: no tab panel, document table or JSON/XML block.
  assert.equal(
    await page.locator("main [role=tabpanel], main table, main pre, main .fiscal-key").count(),
    0,
  );
  await capture("documents-organization-switch");
  await page.goto(`${base}?company=${scope.companyId}&document=${manyDetail.summary.id}`);
  await page.getByRole("tab", { name: "Dados", exact: true }).waitFor();
  report.scenarios.push("documents-organization-switch-clears-warm-private-content");
  console.log("documents: warm access revocation");
  // Warm both the API key and human ticket, then revoke the integration's access paths: the key
  // stops, the console keeps reading the company.
  await rpc("mutation", "keys:revoke", {
    organizationId: scope.organizationId,
    projectId: scope.integrationProjectId,
    keyId,
  });
  for (const deniedPath of [`${path}?${query}`, downloadPath]) {
    const response = await fetch(urls.site + deniedPath, { headers });
    assert.equal(response.status, 401);
  }
  const ticket = await rpc("mutation", "documentDownloads:ticket", {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    environment: "sandbox",
    artifactId: detail.version.artifactId,
  });
  await rpc(
    "mutation",
    "projects:revokeCompany",
    {
      organizationId: scope.organizationId,
      projectId: scope.integrationProjectId,
      companyId: scope.companyId,
      expectedVersion: 1,
    },
    false,
    true,
  );
  assert.ok(Date.now() < ticket.expiresAt, "Revocation proof must run before ticket expiration");
  await page.getByRole("tab", { name: "Dados", exact: true }).waitFor();
  const consoleTicket = await fetch(`${urls.site}/v1/document-download`, {
    headers: { Origin: site, "X-Download-Token": ticket.token },
  });
  assert.equal(consoleTicket.status, 200, "The console reads the company without the grant");
  await capture("documents-integration-revoked-console-kept");
  report.scenarios.push(
    "documents-warm-key-revocation-denies-data-and-original",
    "documents-integration-grant-revocation-keeps-console-access",
  );
}
