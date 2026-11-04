// Run through the collaborative browser's evaluate tool against a local Vite console.
// No admin credential, mocked backend, or external fiscal transport is used here.
import { authClient } from "../src/auth.ts";
import { nfseXml } from "../../../tests/helpers/nfse.ts";
import { routes } from "../../../packages/contracts/src/external.ts";
import { termsAcceptance } from "../../../scripts/lib/organization-terms.mjs";

const storageKey = "fnfe-import-consultation-proof";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const read = () => JSON.parse(sessionStorage.getItem(storageKey));
const save = (state) => sessionStorage.setItem(storageKey, JSON.stringify(state));
export const hash = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const bytes = (text) => new TextEncoder().encode(text);
export async function rpc(kind, path, args) {
  const state = read();
  const token = (await authClient.convex.token()).data?.token;
  check(token, "Authenticated local session required");
  const response = await fetch(`${state.cloud}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const result = await response.json();
  check(result.status === "success", `${path}: ${result.errorMessage}`);
  return result.value;
}
export async function setup(cloud, site, apiSite = "http://127.0.0.1:5431") {
  for (const url of [location.origin, cloud, site, apiSite])
    check(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Local proof only");
  check(!sessionStorage.getItem(storageKey), "Proof already initialized");
  save({ cloud, site, apiSite, receipts: [], checks: [], scopes: {} });
  const org = await rpc("mutation", "organizations:create", {
    name: "Jornada NF-e sintética",
    slug: `journey-${crypto.randomUUID()}`,
    ...(await termsAcceptance((path, args) => rpc("query", path, args))),
  });
  const demo = await rpc("mutation", "onboarding:start", {
    organizationId: org.organizationId,
    mode: "demonstration",
    expectedVersion: 0,
  });
  const state = read();
  state.org = org;
  for (const [model, companyId] of [["nfe", demo.companyId]]) {
    const { projectId } = await rpc("mutation", "projects:create", {
      organizationId: org.organizationId,
      name: `Jornada ${model}`,
      externalReference: crypto.randomUUID(),
    });
    const scope = {
      organizationId: org.organizationId,
      companyId,
      projectId,
      environment: "sandbox",
    };
    await rpc("mutation", "projects:grantCompany", {
      organizationId: org.organizationId,
      companyId,
      projectId,
      scopes: ["documents:import", "documents:read"],
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    const key = await rpc("action", "keys:create", {
      organizationId: org.organizationId,
      projectId,
      name: `Prova ${model}`,
      scopes: ["documents:import", "documents:read"],
      environment: "sandbox",
      companyIds: [companyId],
      expiresAt: Date.now() + 7200000,
    });
    state.scopes[model] = { scope, keyId: key.keyId, secret: key.secretOnce };
  }
  state.xml = {
    nfe: await (await fetch("/examples/nfe-demonstracao.xml")).text(),
    // ABRASF import was retired on 02/11/2026: this batch must be refused.
    abrasf: nfseXml(),
  };
  save(state);
  return urls();
}
export function urls(model = "nfe", documentId) {
  const { org, scopes } = read(),
    { scope, batch } = scopes[model];
  // Console sem projeto: the screens take only the company.
  const query = `company=${scope.companyId}`;
  return {
    imports: `${location.origin}/app/${org.slug}/imports?${query}${batch ? `&batch=${batch.id}` : ""}`,
    documents: `${location.origin}/app/${org.slug}/documents?${query}${documentId ? `&document=${documentId}` : ""}`,
  };
}
export async function rest(model, route, path, body, key = crypto.randomUUID()) {
  const state = read();
  const response = await fetch(state.apiSite + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${state.scopes[model].secret}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(response.ok, `${path}: HTTP ${response.status}`);
  return routes[route].output.parse(await response.json()).data;
}
/** HTTP status of a key read, without throwing on refusal. */
async function status(model, path) {
  const state = read();
  const response = await fetch(state.apiSite + path, {
    headers: { Authorization: `Bearer ${state.scopes[model].secret}`, "X-Environment": "sandbox" },
  });
  return response.status;
}
// DataTransfer supplies synthetic files to the real input/change handler.
// With loseResponse, the real upload succeeds, then only its onload notification fails.
function uploadInput() {
  const input = document.querySelector("#import-files");
  check(
    input && !input.disabled && input.getAttribute("aria-disabled") !== "true",
    "Upload input unavailable",
  );
  return input;
}
function dispatchFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { files: Array.from(input.files, (f) => f.name) };
}
export function selectFiles(model, loseResponse = false) {
  const state = read(),
    input = uploadInput();
  if (loseResponse) {
    // eslint-disable-next-line typescript/unbound-method -- Each call below supplies the original XHR receiver.
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (body instanceof File && body.name === `${model}.xml`) {
        XMLHttpRequest.prototype.send = send;
        const originalLoad = this.onload;
        this.onload = (event) => {
          if (this.status !== 200) return originalLoad.call(this, event);
          window.__lostUploadResponse = true;
          this.onerror(new ProgressEvent("error"));
        };
      }
      return send.call(this, body);
    };
  }
  return dispatchFiles(input, [
    new File([state.xml[model]], `${model}.xml`, { type: "application/xml" }),
    new File(["<desconhecido/>"], "desconhecido.xml", { type: "application/xml" }),
  ]);
}
// The ABRASF batch goes through the same panel upload; the platform no longer imports it.
export function selectRetiredAbrasf() {
  const state = read();
  return dispatchFiles(uploadInput(), [
    new File([state.xml.abrasf], "abrasf.xml", { type: "application/xml" }),
  ]);
}
export async function inspectRetiredAbrasf() {
  const id = new URL(location.href).searchParams.get("batch");
  check(id, "Import not present in URL");
  const state = read();
  check(id !== state.scopes.nfe.batch?.id, "URL still points to the NF-e import");
  const batch = await rpc("query", "imports:get", { importId: id, includeResults: true });
  const [file] = batch.files;
  check(batch.files.length === 1 && file.state === "succeeded", "Processing incomplete");
  check(file.code === "XML_NAMESPACE_UNSUPPORTED", "ABRASF batch was not refused");
  check(!file.documentId && !file.documents?.length, "Refused ABRASF batch created a document");
  state.receipts.push({ model: "abrasf", phase: "retired-refused", batch });
  state.checks.push("abrasf: batch refused with XML_NAMESPACE_UNSUPPORTED and no document");
  save(state);
  return { id, file: { name: file.name, state: file.state, code: file.code } };
}
// ADR 0005: the panel's batch belongs to the console project. The session reads it; the
// integration key must not (404). The resulting documents stay readable by company.
export async function inspectImport(model, partial = false) {
  const id = new URL(location.href).searchParams.get("batch");
  check(id, "Import not present in URL");
  const batch = await rpc("query", "imports:get", { importId: id, includeResults: true });
  const keyStatus = await status(model, `/v1/imports/${id}`);
  check(keyStatus === 404, "Integration key reached the console's import");
  if (partial) {
    check(window.__lostUploadResponse, "Response loss not exercised");
    check(batch.files[0].state === "uploaded", "Original must already be stored");
  } else {
    check(
      batch.files.every((f) => f.state === "succeeded"),
      "Processing incomplete",
    );
    check(batch.files[0].code === "IMPORTED", "Import result mismatch");
    check(batch.files[1].code.includes("UNSUPPORTED"), "Unknown XML diagnostic missing");
  }
  const state = read();
  state.scopes[model].batch = batch;
  state.receipts.push({
    model,
    phase: partial ? "upload-response-lost" : "partial-success",
    batch,
    integrationKeyStatus: keyStatus,
  });
  if (!partial)
    state.checks.push(`${model}: panel batch read by the session; integration key gets 404`);
  save(state);
  return {
    id,
    integrationKeyStatus: keyStatus,
    files: batch.files.map(({ name, state, code, documents }) => ({
      name,
      state,
      code,
      documents,
    })),
  };
}
export async function repeatThroughApi(model) {
  const state = read(),
    scope = state.scopes[model],
    xml = bytes(state.xml[model]);
  const body = {
    companyId: scope.scope.companyId,
    files: [{ name: `${model}.xml`, size: xml.length, sha256: await hash(xml) }],
  };
  const intent = crypto.randomUUID();
  const reserved = await rest(model, "reserveImport", "/v1/imports", body, intent);
  const replay = await rest(model, "reserveImport", "/v1/imports", body, intent);
  check(replay.reused && replay.importId === reserved.importId, "Reservation idempotency failed");
  const base = `/v1/imports/${reserved.importId}/files/${reserved.fileIds[0]}`;
  const ticket = await rest(model, "createUpload", `${base}/upload`, {});
  check(
    (
      await fetch(ticket.url, {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: xml,
      })
    ).status === 200,
    "Upload failed",
  );
  await rest(model, "confirmImport", `${base}/confirm`, {});
  scope.apiImport = reserved;
  save(state);
  return { importId: reserved.importId, reused: replay.reused };
}
export async function verifyApi(model) {
  const state = read(),
    scope = state.scopes[model];
  const batch = await rest(model, "getImport", `/v1/imports/${scope.apiImport.importId}`);
  check(batch.files[0].state === "succeeded", "API processing incomplete");
  // The console reads every batch of the company, including the integration's.
  const fromConsole = await rpc("query", "imports:get", {
    importId: scope.apiImport.importId,
    includeResults: true,
  });
  check(
    JSON.stringify(canonical(fromConsole)) === JSON.stringify(canonical(batch)),
    "Console and API read the integration's batch differently",
  );
  const original = scope.batch.files[0],
    repeated = batch.files[0];
  const ids = [original.documentId];
  check(repeated.documentId === original.documentId, "API and panel document identities differ");
  check(repeated.code === "DUPLICATE", "Deduplication failed");
  const details = [],
    downloads = [];
  for (const id of ids) {
    const query = `companyId=${scope.scope.companyId}`;
    const detail = await rest(model, "getDocument", `/v1/documents/${id}?${query}`);
    check(detail.summary.projectionState === "ready", "Projection not ready");
    const response = await fetch(
      `${state.apiSite}/v1/document-artifacts/${detail.version.artifactId}/original?${query}`,
      {
        headers: { Authorization: `Bearer ${scope.secret}`, "X-Environment": "sandbox" },
      },
    );
    check(response.status === 200, "Original unavailable");
    const digest = await hash(await response.arrayBuffer());
    check(digest === (await hash(bytes(state.xml[model]))), "Original bytes differ");
    check(response.headers.get("cache-control") === "no-store", "Private original can be cached");
    details.push(detail);
    downloads.push({ documentId: id, sha256: digest, cacheControl: "no-store" });
  }
  scope.details = details;
  state.receipts.push({ model, phase: "api-equivalence", batch, details, downloads });
  state.checks.push(
    `${model}: API/panel identity, idempotency, DTO contract, original hashes; console reads the API batch`,
  );
  save(state);
  return { documents: ids.length, urls: urls(model, ids[0]), downloads };
}
export async function verifyVisibleJson(model) {
  const state = read(),
    scope = state.scopes[model];
  const id = new URL(location.href).searchParams.get("document");
  const panel = JSON.parse(document.querySelector('[role="tabpanel"] pre').textContent);
  const api = await rest(
    model,
    "getDocument",
    `/v1/documents/${id}?companyId=${scope.scope.companyId}`,
  );
  check(
    JSON.stringify(canonical(panel)) === JSON.stringify(canonical(api)),
    "Visible JSON differs from REST",
  );
  state.receipts.push({ model, phase: "visible-json", document: panel });
  state.checks.push(`${model}: visible JSON equals REST after direct navigation/refresh`);
  save(state);
  return { model: panel.model, payload: panel.payload, versionId: panel.version.id };
}
// Observe the actual Blob handed to the browser download without changing it.
export function observeDownload() {
  const original = URL.createObjectURL.bind(URL);
  window.__originalDownload = null;
  URL.createObjectURL = function (blob) {
    URL.createObjectURL = original;
    window.__originalDownload = blob
      .arrayBuffer()
      .then(async (buffer) => ({ sha256: await hash(buffer), size: buffer.byteLength }));
    return original.call(this, blob);
  };
}
export async function verifyDownload(model) {
  check(window.__originalDownload, "Browser download not observed");
  const result = await window.__originalDownload,
    state = read();
  check(
    result.sha256 === (await hash(bytes(state.xml[model]))),
    "Panel downloaded different original",
  );
  state.receipts.push({ model, phase: "panel-download", ...result });
  save(state);
  return result;
}
export async function verifyReprocess(model) {
  const state = read(),
    scope = state.scopes[model],
    file = scope.batch.files[0];
  // The panel's batch belongs to the console project: the session reads it, not the key.
  const current = await rpc("query", "imports:get", { importId: scope.batch.id });
  check(current.files[0].versionId !== file.versionId, "No new completed file version");
  const history = await rpc("query", "importHistory:get", { fileId: file.id });
  check(
    history.some((v) => v.id === file.versionId && v.result === file.result),
    "Previous result not preserved",
  );
  const versions = [];
  for (const detail of scope.details) {
    const list = await rest(
      model,
      "documentVersions",
      `/v1/documents/${detail.summary.id}/versions?companyId=${scope.scope.companyId}`,
    );
    check(list.page.length >= 2, "Document history not advanced");
    check(
      list.page.some((v) => v.version.id === detail.version.id),
      "Previous document version missing",
    );
    versions.push({ documentId: detail.summary.id, ids: list.page.map((v) => v.version.id) });
  }
  state.receipts.push({ model, phase: "reprocessed", current, history, versions });
  state.checks.push(
    `${model}: original result preserved, ${versions.length} document histories advanced`,
  );
  save(state);
  return { history: history.length, versions };
}
export function report() {
  const { receipts, checks } = read();
  return {
    environment: "anonymous-local",
    url: location.origin,
    dataset: "Synthetic NF-e 55; retired ABRASF batch refused",
    checks,
    receipts,
  };
}

export async function verifyReads(model) {
  const state = read(),
    { scope, details } = state.scopes[model];
  const query = `companyId=${scope.companyId}`;
  const pages = [];
  let cursor = null;
  do {
    const page = await rest(
      model,
      "listDocuments",
      `/v1/documents?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    check(page.page.length <= 2, "Unbounded document page");
    pages.push(page);
    cursor = page.nextCursor;
    check(pages.length <= 10, "Pagination did not finish");
  } while (cursor);
  check(
    pages.flatMap((p) => p.page).length === details.length,
    "Unexpected logical document count",
  );
  const detail = details[0];
  const filtered = await rest(
    model,
    "listDocuments",
    `/v1/documents?${query}&key=${encodeURIComponent(detail.summary.key)}`,
  );
  check(
    filtered.page.length === 1 && filtered.page[0].id === detail.summary.id,
    "Key filter differs",
  );
  const items = await rest(
    model,
    "documentItems",
    `/v1/documents/${detail.summary.id}/items?${query}&versionId=${detail.version.id}&limit=10`,
  );
  check(items.page.length === 1, "Wrong items for document model");
  state.receipts.push({ model, phase: "reads", pages, filtered, items });
  save(state);
  return { pages: pages.length, documents: details.length, items: items.page.length };
}

export async function verifyDenials(model) {
  const state = read(),
    selected = state.scopes[model],
    { scope, details, secret, keyId } = selected;
  const detail = details[0];
  const headers = { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" };
  const documentPath = `/v1/documents/${detail.summary.id}?companyId=${scope.companyId}`;
  const originalPath = `/v1/document-artifacts/${detail.version.artifactId}/original?companyId=${scope.companyId}`;
  const ticket = await rpc("mutation", "documentDownloads:ticket", {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    environment: "sandbox",
    artifactId: detail.version.artifactId,
  });
  const ticketHeaders = { "X-Download-Token": ticket.token };
  check(
    (await fetch(`${state.site}/v1/document-download`, { headers: ticketHeaders })).status === 200,
    "Warm human download failed",
  );
  await rpc("mutation", "keys:revoke", {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    keyId,
  });
  const denied = [];
  // The key's own batch, readable until the revocation (the panel's never was).
  for (const path of [documentPath, originalPath, `/v1/imports/${selected.apiImport.importId}`]) {
    const response = await fetch(state.apiSite + path, { headers });
    check(response.status === 401, "Revoked key still grants access");
    denied.push({ path, status: response.status });
  }
  await rpc("mutation", "projects:revokeCompany", {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    expectedVersion: 1,
  });
  check(Date.now() < ticket.expiresAt, "Ticket expired before revocation test");
  // The console depends on the member's access to the company, not on the integration's grant.
  const revoked = await fetch(`${state.site}/v1/document-download`, { headers: ticketHeaders });
  check(revoked.status === 200, "Integration revocation must not remove console access");
  state.receipts.push({
    model,
    phase: "denied",
    denied,
    humanTicketStatus: revoked.status,
  });
  delete selected.secret;
  save(state);
  return {
    denied: denied.length,
    humanTicketStatus: revoked.status,
  };
}
