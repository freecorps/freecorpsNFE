import { nfseXml } from "../../tests/helpers/nfse";
import { routes } from "../../packages/contracts/src/external";
import { it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import type { Id } from "./_generated/dataModel";
import { fixture } from "../../tests/helpers/imports";

/** Legacy ABRASF NFS-e batches: still readable, counted and migrated, never imported again. */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});

it("um lote NFS-e aceito não conta como arquivo sem documento, e a migração marca os antigos (#44)", async () => {
  const f = await fixture(undefined, true),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const empty = { count: 0, more: false, latestAt: null };
  const listed = async () =>
    (await owner.query(api.documents.unclassified, { ...scope, cursor: null, limit: 20 })).page;
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }));
  const xml = Buffer.from(nfseXml());
  const batch = await f.reserve(xml);
  await f.upload(batch, xml);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  expect((await f.result(batch)).files[0]!.code).toBe("NFSE_BATCH_IMPORTED");
  // Published, the batch is marked and leaves the index range of the count and the list.
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual(empty);
  expect(await listed()).toEqual([]);
  // A refused file beside it is counted and listed, before and after the migration.
  const bytes = Buffer.from('<desconhecido versao="9.99"/>');
  const refused = await f.reserve(bytes, "refused");
  await f.upload(refused, bytes);
  const second = await f.confirm(refused);
  await f.t.action(internal.operationWorker.run, {
    operationId: second.operationId,
    generation: 1,
  });
  const one = await owner.query(api.documents.unclassifiedCount, scope);
  expect(one).toMatchObject({ count: 1, more: false });
  expect((await listed()).map((file) => file.importedAt)).toEqual([one.latestAt]);
  // A batch imported before the field has no mark: counted until the migration, never listed.
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_fileId", (q) => q.eq("fileId", batch.fileIds[0]!))
      .unique())!;
    expect(artifact.nfseBatch).toBe(true);
    await ctx.db.patch("documentArtifacts", artifact._id, { nfseBatch: undefined });
  });
  expect((await owner.query(api.documents.unclassifiedCount, scope)).count).toBe(2);
  expect(await listed()).toHaveLength(1);
  expect(
    await f.t.mutation(internal.unclassifiedMigration.markNfseBatches, { cursor: null }),
  ).toMatchObject({ marked: 1, isDone: true });
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual(one);
  expect(await listed()).toHaveLength(1);
  // Repeating it marks nothing else.
  expect(
    await f.t.mutation(internal.unclassifiedMigration.markNfseBatches, { cursor: null }),
  ).toMatchObject({ marked: 0, isDone: true });
  // Reprocessing a note rereads the batch: the file follows its new operation, as the import
  // page does, while it runs and once it ends.
  const note = await f.t.run(async (ctx) => (await ctx.db.query("fiscalDocuments").first())!._id);
  // From the console, the operation is of the console project: the file keeps its outcome.
  await owner.mutation(api.documents.reprocess, {
    ...scope,
    documentId: String(note),
    key: "note-console",
  });
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual(one);
  // From the batch's own project, the file follows the new operation.
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:read"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, "documents:read"],
    });
  });
  const reprocessed = await f.request(
    `/v1/documents/${note}/reprocess?companyId=${f.scope.companyId}`,
    "POST",
    {},
    "note-again",
  );
  expect(reprocessed.status).toBe(202);
  const again = (await reprocessed.json()).data as { operationId: Id<"operations"> };
  expect((await owner.query(api.documents.unclassifiedCount, scope)).count).toBe(2);
  await f.t.action(internal.operationWorker.run, { operationId: again.operationId, generation: 1 });
  // The legacy reader of this test accepts the batch again, so it leaves the count once more.
  expect((await f.result(batch)).files[0]!.code).toBe("NFSE_BATCH_IMPORTED");
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual(one);
  expect(await listed()).toHaveLength(1);
});
it("a migração dos lotes NFS-e percorre várias páginas e pula a organização sob custódia", async () => {
  const f = await fixture(undefined, true);
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }));
  const xml = Buffer.from(nfseXml());
  const batch = await f.reserve(xml);
  await f.upload(batch, xml);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const unmark = () =>
    f.t.run(async (ctx) => {
      const artifact = (await ctx.db
        .query("documentArtifacts")
        .withIndex("by_fileId", (q) => q.eq("fileId", batch.fileIds[0]!))
        .unique())!;
      await ctx.db.patch("documentArtifacts", artifact._id, { nfseBatch: undefined });
      return artifact._id;
    });
  const batchArtifact = await unmark();
  // More than a page of files without a document, all inserted after the batch.
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 120; index++)
      await ctx.db.insert("documentArtifacts", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "sandbox",
        sha256: `${index}`.padStart(64, "0"),
        size: 1,
        source: "distribution-xml",
        importedAt: 1_000 + index,
      });
  });
  const mark = async () => {
    const first = await f.t.mutation(internal.unclassifiedMigration.markNfseBatches, {
      cursor: null,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    return first;
  };
  // In custody, the organization's rows stay as they are, and the chain still reaches the end.
  const run = await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId: f.scope.organizationId,
      key: "synthetic-mark-run",
      reason: "free_inactive",
      state: "frozen",
      version: 1,
      noticeAt: Date.now(),
      eligibleAt: Date.now(),
      retainUntil: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    }),
  );
  vi.useFakeTimers();
  try {
    expect(await mark()).toMatchObject({ scanned: 100, marked: 0, isDone: false });
    expect(
      (await f.t.run((ctx) => ctx.db.get("documentArtifacts", batchArtifact)))!.nfseBatch,
    ).toBeUndefined();
    // Restored, it is marked on the next run, whichever page holds the batch.
    await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", run, { state: "hot" }));
    expect(await mark()).toMatchObject({ scanned: 100, isDone: false });
  } finally {
    vi.useRealTimers();
  }
  const rows = await f.t.run((ctx) => ctx.db.query("documentArtifacts").collect());
  expect(rows.filter((row) => row.nfseBatch).map((row) => row._id)).toEqual([batchArtifact]);
});

it("keeps a legacy seven-invoice NFS-e batch readable through HTTP, with separate documents and private originals", async () => {
  const f = await fixture(undefined, true);
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:read"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, "documents:read"],
    });
  });
  const xml = Buffer.from(nfseXml());
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }));
  const batch = await f.reserve(xml);
  expect((await f.upload(batch, xml)).status).toBe(200);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const response = await f.request(`/v1/imports/${batch.importId}`, "GET");
  const output = routes.getImport.output.parse(await response.json()).data.files[0]!;
  expect(output.code).toBe("NFSE_BATCH_IMPORTED");
  expect(output.documents).toHaveLength(7);
  expect(new Set(output.documents!.map((d) => d.documentId)).size).toBe(7);
  for (const row of output.documents!) {
    const read = await f.request(
      `/v1/documents/${row.documentId}?companyId=${f.scope.companyId}`,
      "GET",
    );
    expect(read.status).toBe(200);
    const document = routes.getDocument.output.parse(await read.json()).data;
    expect(document.model).toBe("nfse");
    expect(document.payload).toMatchObject({
      kind: "service-invoice",
      number: row.number,
      total: "1234.56",
    });
    expect(document.summary.fiscalStatus).toBe("unknown");
    expect(document.summary.projectionState).toBe("ready");
    const versions = await f.request(
      `/v1/documents/${row.documentId}/versions?companyId=${f.scope.companyId}`,
      "GET",
    );
    expect(versions.status).toBe(200);
    expect(
      routes.documentVersions.output.parse(await versions.json()).data.page[0]!.payload.kind,
    ).toBe("service-invoice");
    const filtered = await f.request(
      `/v1/documents?companyId=${f.scope.companyId}&key=${encodeURIComponent(document.summary.key)}`,
      "GET",
    );
    expect(
      routes.listDocuments.output.parse(await filtered.json()).data.page.map((doc) => doc.id),
    ).toEqual([row.documentId]);
    const download = await f.request(
      `/v1/document-artifacts/${document.version.artifactId}/original?companyId=${f.scope.companyId}`,
      "GET",
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array(xml));
    const stored = await f.t.run((ctx) =>
      ctx.db.get("documentVersions", row.versionId as Id<"documentVersions">),
    );
    const original = await f.t.run(async (ctx) => {
      const artifact = (await ctx.db.get("documentArtifacts", stored!.artifactId))!;
      return (await ctx.storage.get(artifact.storageId!))!.arrayBuffer();
    });
    expect(new Uint8Array(original)).toEqual(new Uint8Array(xml));
  }
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect())).toHaveLength(7);
  const stranger = await fixture();
  expect(
    (
      await stranger.request(
        `/v1/documents/${output.documents![0]!.documentId}?companyId=${stranger.scope.companyId}`,
        "GET",
      )
    ).status,
  ).toBe(404);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.request(`/v1/imports/${batch.importId}`, "GET")).status).toBe(401);
});

it("refuses an ABRASF NFS-e batch since that import was retired, without documents or participants", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }));
  const xml = Buffer.from(nfseXml());
  const batch = await f.reserve(xml);
  await f.upload(batch, xml);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const file = (await f.result(batch)).files[0]!;
  expect(file.code).toBe("XML_NAMESPACE_UNSUPPORTED");
  expect(file.result).not.toContain("11222333000181");
  expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect())).toHaveLength(0);
});
it("refuses to reprocess a legacy NFS-e batch and keeps its documents and history", async () => {
  const f = await fixture(undefined, true);
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }));
  const xml = Buffer.from(nfseXml());
  const batch = await f.reserve(xml);
  await f.upload(batch, xml);
  const initial = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, {
    operationId: initial.operationId,
    generation: 1,
  });
  expect((await f.result(batch)).files[0]!.code).toBe("NFSE_BATCH_IMPORTED");
  const before = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  const retry = await f.request(
    `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/reprocess`,
    "POST",
    {},
    "retired-reprocess",
  );
  expect(retry.status).toBe(409);
  expect((await retry.json()).error.code).toBe("OPERATION_CONFLICT");
  expect(await f.t.run((ctx) => ctx.db.query("documentVersions").collect())).toEqual(before);
  expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect())).toHaveLength(7);
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const history = await owner.action(api.documentContentNode.importHistoryRead, {
    fileId: batch.fileIds[0]!,
  });
  expect(history.map((version) => version.code)).toEqual(["NFSE_BATCH_IMPORTED"]);
});
