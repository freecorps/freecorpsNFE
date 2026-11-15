import { createHash } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { processNfe, deriveFiscalSituation } from "../../packages/fiscal-nfe/src/index";
import { requestProjection } from "./documentProjection";
import type { Id } from "./_generated/dataModel";
import { routes, errorResponse } from "../../packages/contracts/src/external";
import { testDatabase, actor, documentsFixture } from "../../tests/helpers/documents";

/** Fiscal documents: projection, listing, indexing, reprocessing and the public contract. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-import-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("rejects unsupported document and download methods at the public router", async () => {
  const t = testDatabase();
  for (const path of ["/v1/documents", "/v1/documents/example", "/v1/document-download"])
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect((await t.fetch(path, { method })).status).toBe(404);
});

it("projects an exact typed document, paginates items and downloads original bytes with read scope", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const listing = await f.get();
  expect(listing.status).toBe(200);
  const list = (await listing.json()).data;
  expect(list.page).toHaveLength(1);
  expect(list.page[0].projectionState).toBe("ready");
  const response = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(response.status).toBe(200);
  const detail = (await response.json()).data;
  expect(detail.contractVersion).toBe("documents/1");
  expect(detail.payload.kind).toBe("invoice");
  const processed = processNfe(xmlFixture("invoice-authorized"));
  expect(detail.fiscalSituation).toEqual(deriveFiscalSituation([processed]));
  expect(detail.payload.total).toBe(
    (processed.normalized!.document as { total: { declared: string } }).total.declared,
  );
  const itemResponse = await f.get(
    `/v1/documents/${detail.summary.id}/items`,
    `&versionId=${detail.version.id}&limit=1`,
  );
  expect(itemResponse.status).toBe(200);
  const items = (await itemResponse.json()).data;
  expect(items.page).toHaveLength(1);
  expect(typeof items.page[0].unitPrice).toBe("string");
  expect(items.page[0].taxes.every((tax: { basis: string }) => tax.basis === "declared")).toBe(
    true,
  );
  const download = await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`);
  expect(download.status).toBe(200);
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(
    createHash("sha256")
      .update(new Uint8Array(await download.arrayBuffer()))
      .digest("hex"),
  ).toBe(detail.version.sha256);
  expect(JSON.stringify(detail)).not.toMatch(
    /storageId|keyHash|sourceKeyId|tokenHash|fiscalEvidence|_creationTime/,
  );
});

it("rejects foreign documents, versions and artifacts without revealing their existence", async () => {
  const f = await documentsFixture(),
    other = await documentsFixture(f.t);
  const original = await f.importXml(),
    foreign = await other.importXml();
  expect((await f.get(`/v1/documents/${foreign.file.documentId}`)).status).toBe(404);
  expect(
    (
      await f.get(
        `/v1/documents/${original.file.documentId}`,
        `&versionId=${foreign.file.versionId}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.get(`/v1/document-artifacts/${foreign.version.artifactId}/original`)).status,
  ).toBe(404);
  expect((await f.request(`/v1/documents?companyId=${other.scope.companyId}`, "GET")).status).toBe(
    404,
  );
  // A corrupt/forged listing must not turn page-level authorization into cross-tenant access.
  await f.t.run((ctx) =>
    ctx.db.insert("documentListings", {
      documentId: foreign.file.documentId as Id<"fiscalDocuments">,
      companyId: f.scope.companyId,
      environment: "sandbox",
      filterKey: "*:*",
      date: Date.now() + 1,
    }),
  );
  expect((await f.get()).status).toBe(404);
});

it("reindexes existing publications and rebuilds from original bytes without rewriting their versions", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) =>
        q.eq("documentId", imported.file.documentId as Id<"fiscalDocuments">),
      )
      .collect();
    for (const row of rows) await ctx.db.delete("documentListings", row._id);
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    await ctx.db.patch("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">, {
      listedAt: undefined,
      projectionGeneration: undefined,
      projectionState: undefined,
      fiscalSituation: undefined,
    });
    await ctx.db.patch("documentVersions", imported.version._id, {
      publishedAt: undefined,
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
    });
  });
  expect((await f.get()).status).toBe(200);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId: imported.file.documentId as Id<"fiscalDocuments">,
    generation: 1,
    cursor: null,
  });
  const backfillDoc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId: backfillDoc._id,
    generation: backfillDoc.projectionGeneration!,
    cursor: null,
  });
  await f.rebuild(imported.file.documentId!);
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.summary.projectionState).toBe("ready");
  expect(detail.summary.fiscalStatus).toBe("authorized");
  const stored = (await f.t.run((ctx) => ctx.db.get("documentVersions", imported.version._id)))!;
  expect(stored.result).toBe(imported.version.result);
  expect(stored.outputHash).toBe(imported.version.outputHash);
});
it("bounded filters and cursors reject changed context and malformed input", async () => {
  const f = await documentsFixture();
  await f.importXml();
  expect((await f.get("/v1/documents", "&limit=10000")).status).toBe(400);
  expect((await f.get("/v1/documents", "&from=NaN")).status).toBe(400);
  expect((await f.get("/v1/documents", "&key=invalid")).status).toBe(400);
  expect((await f.get("/v1/documents", "&status=made-up")).status).toBe(400);
  expect((await f.get("/v1/documents", "&cursor=invalid")).status).toBe(400);
  expect((await f.get("/v1/documents", "&storageId=private")).status).toBe(400);
  const noMatch = (await (await f.get("/v1/documents", "&status=cancelled")).json()).data;
  expect(noMatch.page).toEqual([]);
});
it("unavailable original preserves the completed result and cannot produce a download URL", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db.get("documentArtifacts", imported.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
  });
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.payload.kind).toBe("invoice");
  expect(detail.version.originalAvailable).toBe(false);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    404,
  );
});
it("never indexes stale authorization while rebuilding and refuses viewer processing", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await expect(
    viewer.client.mutation(api.documents.rebuild, {
      ...f.queryScope,
      documentId: imported.file.documentId!,
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  expect(await viewer.client.query(api.documents.canProcess, f.queryScope)).toBe(false);
  const owner = await actor(f.t, f.scope.organizationId);
  await owner.client.mutation(api.documents.rebuild, {
    ...f.queryScope,
    documentId: imported.file.documentId!,
  });
  const pending = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(pending.summary.fiscalStatus).toBe("unknown");
  expect(pending.fiscalSituation).toBeNull();
  expect(pending.previousFiscalSituation.reportedStatus).toBe("authorized");
  expect((await (await f.get("/v1/documents", "&status=authorized")).json()).data.page).toEqual([]);
  const doc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId: doc._id,
    generation: doc.projectionGeneration!,
    originals: true,
  });
  expect((await (await f.get(`/v1/documents/${doc._id}`)).json()).data.fiscalSituation).toEqual(
    deriveFiscalSituation([processNfe(xmlFixture("invoice-authorized"))]),
  );
});
it("deduplicates fiscal interpretations independently of history and preserves disagreements", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const record = {
    versionId: imported.version._id,
    snapshot: imported.version.fiscalEvidence!,
    fingerprint: imported.version.fiscalFingerprint!,
  };
  for (let i = 0; i < 260; i++) await f.t.mutation(internal.documentProjection.record, record);
  expect(await f.t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect())).toHaveLength(1);
  await f.rebuild(imported.file.documentId!);
  expect(
    (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data.summary
      .fiscalStatus,
  ).toBe("authorized");
  // Even differences outside the compact fiscal snapshot remain a processing disagreement.
  await f.t.mutation(internal.documentProjection.record, {
    ...record,
    fingerprint: "f".repeat(64),
  });
  await f.rebuild(imported.file.documentId!);
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("conflict");
  expect(detail.fiscalSituation.conflicts).toContain(
    `PROCESSING_DISAGREEMENT:${imported.version.fiscalEvidence ? JSON.parse(imported.version.fiscalEvidence).metadata.originalSha256 : ""}`,
  );
  for (let i = 2; i < 257; i++)
    await f.t.mutation(internal.documentProjection.record, {
      ...record,
      fingerprint: i.toString(16).padStart(64, "0"),
    });
  await f.rebuild(imported.file.documentId!);
  const limited = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(limited.summary.projectionState).toBe("limit-exceeded");
  expect(limited.fiscalSituation).toBeNull();
  expect(limited.previousFiscalSituation.reportedStatus).toBe("conflict");
});
it("reprocesses through HTTP 202 using one operation and keeps old versions and exact items", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const path = `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`;
  const first = await f.request(path, "POST", {}, "doc-reprocess");
  expect(first.status).toBe(202);
  const reservation = (await first.json()).data;
  const repeated = await f.request(path, "POST", {}, "doc-reprocess");
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data).toEqual({ ...reservation, reused: true });
  await f.t.action(internal.operationWorker.run, {
    operationId: reservation.operationId,
    generation: 1,
  });
  const history = (await (await f.get(`/v1/documents/${imported.file.documentId}/versions`)).json())
    .data;
  expect(history.page).toHaveLength(2);
  expect(history.page.map((r: { version: { id: string } }) => r.version.id)).toContain(
    imported.version._id,
  );
  const files = (await (await f.get(`/v1/documents/${imported.file.documentId}/files`)).json())
    .data;
  expect(files.page).toHaveLength(1);
  expect(Object.keys(files.page[0]).sort()).toEqual([
    "id",
    "importedAt",
    "name",
    "originalAvailable",
    "sha256",
    "size",
    "source",
  ]);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  expect((await f.request(path, "POST", {}, "denied")).status).toBe(403);
});
it("preserves and serves unknown-schema originals without inventing a logical NF-e", async () => {
  const f = await documentsFixture(),
    bytes = Buffer.from("<unknown><script>globalThis.compromised=true</script></unknown>");
  await f.importXml(bytes);
  const list = (await (await f.get("/v1/document-artifacts")).json()).data;
  expect(list.page).toHaveLength(1);
  expect(list.page[0].code).toBe("XML_NAMESPACE_UNSUPPORTED");
  const original = await f.get(`/v1/document-artifacts/${list.page[0].id}/original`);
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  expect((await (await f.get()).json()).data.page).toEqual([]);
});
it("paginates sixty exact items and binds real cursors to the selected version", async () => {
  const f = await documentsFixture();
  const xml = xmlFixture("invoice-authorized").toString("utf8");
  const item = xml.match(/<det nItem="1">[\s\S]*?<\/det>/)![0];
  const bytes = Buffer.from(
    xml.replace(
      item,
      Array.from({ length: 60 }, (_, i) => item.replace('nItem="1"', `nItem="${i + 1}"`)).join(""),
    ),
  );
  const imported = await f.importXml(bytes),
    products = processNfe(bytes).normalized!.document;
  if (products.kind !== "invoice") throw new Error("Expected invoice");
  const { projectNfeItem } = await import("../../packages/contracts/src/documents");
  const rows: unknown[] = [];
  let cursor: string | null = null,
    firstCursor: string | null = null,
    pages = 0;
  do {
    const response = await f.get(
      `/v1/documents/${imported.file.documentId}/items`,
      `&versionId=${imported.version._id}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(response.status).toBe(200);
    const batch = (await response.json()).data;
    rows.push(...batch.page);
    cursor = batch.nextCursor;
    firstCursor ??= cursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(rows).toEqual(products.products.map(projectNfeItem));
  const newer = await f.importXml(bytes);
  expect(
    (
      await f.get(
        `/v1/documents/${imported.file.documentId}/items`,
        `&versionId=${newer.version._id}&cursor=${encodeURIComponent(firstCursor!)}`,
      )
    ).status,
  ).toBe(400);
});
it("backfills a legacy operation completing after the document was already migrated", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    await ctx.db.patch("documentVersions", imported.version._id, {
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
      publishedAt: undefined,
    });
  });
  await f.t.mutation(internal.importProcessing.published, {
    operationId: imported.version.operationId,
  });
  const doc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  expect(doc.evidenceBackfill).toBe(true);
  expect(doc.projectionState).toBe("pending");
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId: doc._id,
    generation: doc.projectionGeneration!,
    cursor: null,
  });
  await f.rebuild(doc._id);
  expect((await (await f.get(`/v1/documents/${doc._id}`)).json()).data.summary.fiscalStatus).toBe(
    "authorized",
  );
});
it("replays the same logical reprocess intention after a summary evolves to a full XML", async () => {
  const f = await documentsFixture(),
    summary = await f.importXml(xmlFixture("summary-authorized"));
  const path = `/v1/documents/${summary.file.documentId}/reprocess?companyId=${f.scope.companyId}`;
  const first = await f.request(path, "POST", {}, "stable-logical-document");
  expect(first.status).toBe(202);
  const accepted = (await first.json()).data;
  const full = await f.importXml(xmlFixture("invoice-authorized"));
  expect(full.file.documentId).toBe(summary.file.documentId);
  const repeated = await f.request(path, "POST", {}, "stable-logical-document");
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data).toEqual({ ...accepted, reused: true });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
  expect(JSON.parse(op.request).artifactId).toBe(summary.version.artifactId);
  const next = await f.request(path, "POST", {}, "new-intention");
  expect(next.status).toBe(202);
  const nextOperation = (await next.json()).data;
  expect(
    JSON.parse(
      (await f.t.run((ctx) => ctx.db.get("operations", nextOperation.operationId)))!.request,
    ).artifactId,
  ).toBe(full.version.artifactId);
});

it("refuses silently ignored API filters", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  for (const suffix of ["versions", "files"])
    expect(
      (await f.get(`/v1/documents/${imported.file.documentId}/${suffix}`, "&kind=garbage")).status,
    ).toBe(400);
});
it("keeps the published version readable between checkpoint and operation success", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const accepted = await f.request(
    `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`,
    "POST",
    {},
    "checkpoint-window",
  );
  const { operationId } = (await accepted.json()).data;
  const op = (await f.t.mutation(internal.operations.claim, { operationId, generation: 1 }))!;
  const claim = { operationId, generation: 1, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  const outcome = await f.t.action(internal.importWorker.execute, {
    ...claim,
    request: op.request,
  });
  expect(outcome.kind).toBe("success");
  await f.t.mutation(internal.operations.recordOutcome, { ...claim, outcome });
  expect(await f.t.mutation(internal.operations.checkpoint, claim)).toBe(true);
  const during = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(during.status).toBe(200);
  expect((await during.json()).data.version.id).toBe(imported.version._id);
  expect((await (await f.get()).json()).data.page[0].versionId).toBe(imported.version._id);
  expect(await f.t.mutation(internal.operations.publish, claim)).toBe(true);
  const after = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(after.status).toBe(200);
  expect((await after.json()).data.version.id).not.toBe(imported.version._id);
});

it("fences stale history index jobs and restarts indexing when a new projection is requested", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const documentId = imported.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  await f.t.run(async (ctx) => {
    await ctx.db.patch("fiscalDocuments", documentId, {
      historyIndexing: true,
      evidenceBackfill: true,
      projectionGeneration: 10,
    });
    await ctx.db.patch("documentVersions", imported.version._id, { publishedAt: undefined });
  });
  await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 10,
    cursor: null,
  });
  const stale = await f.t.run(async (ctx) => ({
    doc: await ctx.db.get("fiscalDocuments", documentId),
    version: await ctx.db.get("documentVersions", imported.version._id),
    jobs: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
  expect(stale.doc).toMatchObject({ historyIndexing: true, projectionGeneration: 11 });
  expect(stale.version?.publishedAt).toBeUndefined();
  expect(
    stale.jobs.some(
      (job) => job.name.includes("backfillVersions") && job.args[0]?.generation === 11,
    ),
  ).toBe(true);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 11,
    cursor: null,
  });
  const current = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
  expect(current).toMatchObject({ historyIndexing: false, projectionGeneration: 12 });
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 11,
    cursor: null,
  });
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toEqual(current);
});

it("keeps failed evidence backfill incomplete until the missing cancellation original is restored", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const cancellation = await f.importXml(xmlFixture("event-110111"));
  const documentId = invoice.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  const before = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    const artifact = (await ctx.db.get("documentArtifacts", cancellation.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
    await ctx.db.patch("documentVersions", cancellation.version._id, {
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
    });
    await ctx.db.patch("fiscalDocuments", documentId, { evidenceBackfill: true });
  });
  async function attempt() {
    await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
    const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
    await f.t.action(internal.documentProjectionWorker.backfill, {
      documentId,
      generation: doc.projectionGeneration!,
      cursor: null,
    });
  }
  for (let i = 0; i < 2; i++) {
    await attempt();
    const doc = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
    expect(doc).toMatchObject({ evidenceBackfill: true, projectionState: "unavailable" });
    const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
    expect(detail.summary.fiscalStatus).toBe("unknown");
    expect(detail.fiscalSituation).toBeNull();
    expect(detail.previousFiscalSituation).toEqual(before.fiscalSituation);
  }
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(xmlFixture("event-110111"))]),
    );
    await ctx.db.patch("documentArtifacts", cancellation.version.artifactId, { storageId });
  });
  await attempt();
  await f.rebuild(documentId);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toMatchObject({
    evidenceBackfill: false,
    projectionState: "ready",
  });
  const restored = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(restored.fiscalSituation.reportedStatus).toBe("cancelled");
});

it("limits ticket writes per organization and membership without exhausting another reader's budget", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const first = await actor(f.t, f.scope.organizationId),
    second = await actor(f.t, f.scope.organizationId);
  const args = { ...f.queryScope, artifactId: imported.version.artifactId };
  for (let i = 0; i < 60; i++) await first.client.mutation(api.documentDownloads.ticket, args);
  await expect(first.client.mutation(api.documentDownloads.ticket, args)).rejects.toThrow(
    "RATE_LIMITED",
  );
  expect(await f.t.run((ctx) => ctx.db.query("documentDownloads").collect())).toHaveLength(60);
  await expect(second.client.mutation(api.documentDownloads.ticket, args)).resolves.toMatchObject({
    expiresAt: Date.now() + 60_000,
  });
});

it("resolves authorized deep-linked summaries outside the first selector page", async () => {
  const f = await documentsFixture(),
    owner = await actor(f.t, f.scope.organizationId);
  const selected = await f.t.mutation(internal.testing.documentProof.selectorPages, {
    companyId: f.scope.companyId,
    projectId: f.scope.projectId,
  });
  const companies = await owner.client.query(api.companies.list, {
    organizationId: f.scope.organizationId,
    contextKey: "proof",
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(companies.page.map((row) => row.id)).not.toContain(selected.companyId);
  const args = {
    organizationId: f.scope.organizationId,
    company: selected.companyId,
    contextKey: "proof",
  };
  expect(await owner.client.query(api.consoleCompany.context, args)).toMatchObject({
    id: selected.companyId,
    name: "Empresa paginada 21",
    canRead: true,
  });
  const other = await documentsFixture(f.t);
  expect(
    await owner.client.query(api.consoleCompany.context, {
      ...args,
      company: other.scope.companyId,
    }),
  ).toBeNull();
});

it("links document reprocessing to its import only when the project matches", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const owner = await actor(f.t, f.scope.organizationId);
  const original = (await f.t.run((ctx) => ctx.db.get("importFiles", imported.batch.fileIds[0]!)))!;
  // The import came from the integration; the console reprocesses in its own project and the
  // integration's batch never shows the console operation.
  const fromConsole = await owner.client.mutation(api.documents.reprocess, {
    ...f.queryScope,
    documentId: imported.file.documentId!,
    key: "console",
  });
  await f.t.action(internal.operationWorker.run, {
    operationId: fromConsole.operationId,
    generation: 1,
  });
  const consoleProject = await f.t.run(async (ctx) => {
    const op = (await ctx.db.get("operations", fromConsole.operationId))!;
    return (await ctx.db.get("projects", op.projectId))!;
  });
  expect(consoleProject.kind).toBe("console");
  expect(
    (await f.t.run((ctx) => ctx.db.get("importFiles", original._id)))!.processingOperationId,
  ).toBeUndefined();
  // The same project's key links the new processing to its import.
  const response = await f.request(
    `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`,
    "POST",
    {},
    "same-project",
  );
  expect(response.status).toBe(202);
  const byKey = (await response.json()).data as { operationId: Id<"operations"> };
  await f.t.action(internal.operationWorker.run, { operationId: byKey.operationId, generation: 1 });
  const after = (await f.t.run((ctx) => ctx.db.get("importFiles", original._id)))!;
  expect(after.operationId).toBe(original.operationId);
  expect(after.processingOperationId).toBe(byKey.operationId);
  const summary = (await (await f.request(`/v1/imports/${imported.batch.importId}`, "GET")).json())
    .data;
  expect(summary.files[0]).toMatchObject({ operationId: byKey.operationId, state: "succeeded" });
});

it("preserves manual original verification through indexing and a concurrent automatic request", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = imported.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db.get("documentArtifacts", imported.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
    await ctx.db.patch("fiscalDocuments", documentId, {
      historyIndexing: true,
      evidenceBackfill: true,
      projectionGeneration: 20,
    });
  });
  await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
  await f.t.run((ctx) => requestProjection(ctx, documentId));
  const requested = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
  expect(requested).toMatchObject({ projectionGeneration: 22, projectionVerifyOriginals: true });
  await f.t.mutation(internal.documentProjection.finish, {
    documentId,
    generation: 21,
    state: "unavailable",
    situation: null,
  });
  expect(
    (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!.projectionVerifyOriginals,
  ).toBe(true);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 22,
    cursor: null,
  });
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId,
    generation: 23,
    cursor: null,
  });
  // Saved snapshots suffice for backfill; the final rebuild must still reopen the original.
  await f.rebuild(documentId);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toMatchObject({
    historyIndexing: false,
    evidenceBackfill: false,
    projectionVerifyOriginals: false,
    projectionState: "unavailable",
  });
  const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("unknown");
  expect(detail.fiscalSituation).toBeNull();
  expect(detail.previousFiscalSituation.reportedStatus).toBe("authorized");
});

it("starts the legacy listing backfill on a read only when unindexed documents exist", async () => {
  const f = await documentsFixture();
  const imported = await f.importXml(xmlFixture("invoice-authorized"));
  const id = imported.version.documentId!;
  await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) => q.eq("documentId", id))
      .collect();
    for (const row of rows) await ctx.db.delete("documentListings", row._id);
    await ctx.db.patch("fiscalDocuments", id, { listedAt: undefined });
  });
  const response = await f.get();
  expect(response.status).toBe(200);
  expect((await response.json()).data.page).toHaveLength(1);
  expect((await f.t.run((ctx) => ctx.db.get("fiscalDocuments", id)))!.listedAt).toBeDefined();
});

it("validates real responses and errors against the independent public contract", async () => {
  const f = await documentsFixture();
  const imported = await f.importXml(xmlFixture("invoice-authorized"));
  const docId = imported.file.documentId!;
  const response = await f.get(`/v1/documents/${docId}`);
  expect(response.status).toBe(200);
  const detail = routes.getDocument.output.parse(await response.json());
  const inputs = [
    [routes.listDocuments.output, await f.get()],
    [
      routes.documentItems.output,
      await f.get(`/v1/documents/${docId}/items`, `&versionId=${detail.data.version.id}`),
    ],
    [routes.documentVersions.output, await f.get(`/v1/documents/${docId}/versions`)],
    [routes.documentFiles.output, await f.get(`/v1/documents/${docId}/files`)],
    [routes.listArtifacts.output, await f.get("/v1/document-artifacts")],
  ] as const;
  for (const [contract, result] of inputs) {
    expect(result.status).toBe(200);
    const body: unknown = await result.json();
    expect(contract.safeParse(body).success).toBe(true);
    expect(result.headers.get("X-Request-Id")).toBe((body as { requestId: string }).requestId);
  }
  const tampered = structuredClone(detail);
  Object.assign(tampered.data.summary, { total: 24.69 });
  expect(routes.getDocument.output.safeParse(tampered).success).toBe(false);
  Object.assign(tampered.data, { storageId: "private" });
  expect(routes.getDocument.output.safeParse(tampered).success).toBe(false);
  const caps = await f.request("/v1/capabilities", "GET");
  expect(caps.status).toBe(200);
  expect(routes.getCapabilities.output.parse(await caps.json()).data.models).toEqual([
    "55",
    "nfse",
  ]);
  const stranger = await documentsFixture();
  const denied = await stranger.get(`/v1/documents/${docId}`);
  expect(denied.status).toBe(404);
  expect(errorResponse.parse(await denied.json()).error.code).toBe("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  for (const result of [
    await f.get(`/v1/documents/${docId}`),
    await f.request("/v1/capabilities", "GET"),
  ]) {
    expect(result.status).toBe(401);
    expect(errorResponse.parse(await result.json()).error.code).toBe("INVALID_API_KEY");
  }
});

it("tells the console which tier holds each listed note (ADR 0010, phase C)", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
  const tier = async () =>
    (await viewer.client.query(api.documents.list, { ...f.queryScope, cursor: null, limit: 10 }))
      .page[0]!.storageTier;
  expect(await tier()).toBe("hot");
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", documentId, { coldState: "cold" }));
  expect(await tier()).toBe("cold");
  // A note still moving reads as hot: each version is read from wherever it is.
  await f.t.run((ctx) =>
    ctx.db.patch("fiscalDocuments", documentId, { coldState: "moving", coldClaimedAt: 0 }),
  );
  expect(await tier()).toBe("hot");
});
