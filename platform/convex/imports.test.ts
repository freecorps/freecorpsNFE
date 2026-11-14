/// <reference types="vite/client" />
import { routes } from "../../packages/contracts/src/external";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import {
  processNfe,
  deriveFiscalSituation,
  RULE_VERSION,
} from "../../packages/fiscal-nfe/src/index";
import { MAX_IMPORT_BYTES } from "./lib/importValues";
import { LEASE_MS } from "./lib/operationValues";
import type { Id } from "./_generated/dataModel";
import { fixture, completedImport } from "../../tests/helpers/imports";

/** XML import through REST: private bytes, idempotency, processor versions, resumption and isolation. */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});

it("isolates detail selectors by organization, company and file, without a project grant", async () => {
  const f = await completedImport();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-detail-key",
    suffix: "other-detail",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(
    outsider.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow();
  for (const field of ["organizationId", "companyId"] as const) {
    await expect(
      f.owner.action(api.documentContentNode.importDetailRead, {
        ...f.detailArgs,
        expectedScope: { ...f.scope, [field]: other[field] },
      }),
    ).rejects.toThrow("NOT_FOUND");
  }
  const second = await f.reserve(f.bytes, "second-detail");
  await f.upload(second);
  const op = await f.confirm(second);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  expect(
    await f.owner.action(api.documentContentNode.importDetailRead, {
      ...f.detailArgs,
      fileId: second.fileIds[0]!,
    }),
  ).toBeNull();
  const projectGrant = await f.t.run((ctx) =>
    ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.integration.projectId).eq("companyId", f.scope.companyId),
      )
      .unique(),
  );
  // People read the company's batches without the integration's grant.
  await f.t.run((ctx) => ctx.db.patch("projectCompanies", projectGrant!._id, { active: false }));
  expect(
    await f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).not.toBeNull();
  // A member without access to the company does not.
  const operator = await person(f.t, f.scope.organizationId, "operator");
  await expect(
    operator.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow("NOT_FOUND");
});

it("API reserva, envia bytes privados, confirma e processa o mesmo conteúdo do pacote", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  expect((await f.upload(batch)).status).toBe(200);
  const op = await f.confirm(batch);
  expect((await f.result(batch)).files[0]!.result).toBeNull();
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const file = (await f.result(batch)).files[0]!;
  expect(file.state).toBe("succeeded");
  expect(file.code).toBe("IMPORTED");
  const operation = (await f.t.run((ctx) => ctx.db.get("operations", op.operationId)))!;
  const expected = processNfe(f.bytes, {
    source: "imported-xml",
    evaluatedAt: new Date(operation.createdAt).toISOString(),
  });
  const actual = JSON.parse(file.result!);
  expect(actual.checks).toEqual(expected.checks);
  expect(actual.metadata).toEqual(expected.metadata);
  const items = await f.t.run((ctx) => ctx.db.query("documentItems").take(1000));
  expect({ ...actual.document, products: items.map((item) => JSON.parse(item.data)) }).toEqual(
    expected.normalized!.document,
  );
  const artifact = (await f.t.run((ctx) => ctx.db.query("documentArtifacts").first()))!;
  const original = await f.t.run(async (ctx) =>
    (await ctx.storage.get(artifact.storageId!))!.arrayBuffer(),
  );
  expect(new Uint8Array(original)).toEqual(new Uint8Array(f.bytes));
  expect(JSON.stringify(await f.result(batch))).not.toContain(artifact.storageId);
});
it("mesma intenção retoma após perda da resposta; confirmação repetida não duplica", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  expect(await f.reserve()).toEqual({ ...batch, reused: true });
  expect((await f.upload(batch)).status).toBe(200);
  const first = await f.confirm(batch),
    second = await f.confirm(batch);
  expect(second).toEqual({ ...first, reused: true });
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(3))).toHaveLength(1);
});
it("mesma Idempotency-Key com corpo divergente retorna 409 pelo HTTP sem reservar outra importação", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  const other = xmlFixture("invoice-authorized");
  const conflict = await f.request("/v1/imports", "POST", {
    companyId: f.scope.companyId,
    files: [
      {
        name: "nota.xml",
        size: other.length,
        sha256: createHash("sha256").update(other).digest("hex"),
      },
    ],
  });
  expect(conflict.status).toBe(409);
  const body = (await conflict.json()) as { error: { code: string }; requestId: string };
  expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  expect(body.requestId).toBeTruthy();
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(3))).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("importFiles").take(3))).toHaveLength(1);
  // A intenção original continua recuperável com a mesma chave.
  expect(await f.reserve()).toEqual({ ...batch, reused: true });
});
it("quickstart distingue avanço da projeção de efeitos de uma confirmação repetida", async () => {
  const f = await fixture(
    readFileSync(
      new URL("../../apps/console/public/examples/nfe-demonstracao.xml", import.meta.url),
    ),
  );
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
  const batch = await f.reserve();
  await f.upload(batch);
  const accepted = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, {
    operationId: accepted.operationId,
    generation: 1,
  });
  const imported = (await f.result(batch)).files[0]!;
  const documentId = imported.documentId as Id<"fiscalDocuments">;
  const get = async () => {
    const response = await f.request(
      `/v1/documents/${documentId}/json?companyId=${f.scope.companyId}`,
      "GET",
    );
    expect(response.status).toBe(200);
    return routes.documentJson.output.parse(await response.json()).data;
  };
  const before = await get();
  expect(before.summary.resourceVersion).toBe(1);
  expect(before.summary.projectionState).toBe("pending");
  expect(await f.reserve()).toEqual({ ...batch, reused: true });
  expect(await f.confirm(batch)).toEqual({ ...accepted, reused: true });
  expect(await get()).toEqual(before);

  const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId,
    generation: doc.projectionGeneration!,
  });
  const projected = await get();
  expect(projected.summary.resourceVersion).toBe(2);
  expect(projected.summary.projectionState).toBe("ready");
  expect(projected.version).toEqual(before.version);
  expect(await f.reserve()).toEqual({ ...batch, reused: true });
  expect(await f.confirm(batch)).toEqual({ ...accepted, reused: true });
  expect(await get()).toEqual(projected);
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId,
    generation: doc.projectionGeneration!,
  });
  expect(await get()).toEqual(projected);
  const events = await f.t.run((ctx) => ctx.db.query("outboxEvents").take(10));
  expect(
    events
      .filter((event) => event.resourceId === documentId)
      .map((event) => [event.type, event.resourceVersion]),
  ).toEqual([
    ["document.received", 1],
    ["document.updated", 2],
  ]);
  expect(await f.t.run((ctx) => ctx.db.query("documentVersions").take(3))).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(3))).toHaveLength(1);
  expect((await f.result(batch)).files[0]).toEqual(imported);
});
it("idempotências distintas e workers concorrentes convergem para uma nota lógica", async () => {
  const f = await fixture(),
    a = await f.reserve(),
    b = await f.reserve(f.bytes, "other");
  await f.upload(a);
  await f.upload(b);
  const ops = await Promise.all([f.confirm(a), f.confirm(b)]);
  await Promise.all(
    ops.map((op) =>
      f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 }),
    ),
  );
  const first = (await f.result(a)).files[0]!,
    second = (await f.result(b)).files[0]!;
  expect(first.documentId).toBe(second.documentId);
  expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").take(3))).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(3))).toHaveLength(2);
  expect([first.code, second.code].sort()).toEqual(["DUPLICATE", "IMPORTED"]);
});
it("arquivo de outra importação e storage já vinculado são recusados", async () => {
  const f = await fixture(),
    a = await f.reserve(),
    b = await f.reserve(f.bytes, "other");
  expect((await f.request(`/v1/imports/${a.importId}/files/${b.fileIds[0]}/upload`)).status).toBe(
    404,
  );
  await f.upload(a);
  const ticket = (
    await (await f.request(`/v1/imports/${b.importId}/files/${b.fileIds[0]}/upload`)).json()
  ).data;
  const original = (await f.t.run((ctx) => ctx.db.get("importFiles", a.fileIds[0]!)))!;
  await expect(
    f.t.mutation(internal.importUpload.attach, {
      tokenHash: await hashApiKey(ticket.token),
      storageId: original.storageId!,
    }),
  ).rejects.toThrow("INVALID_FILE");
});
it("limite de bytes é medido no corpo e hash divergente não gera blob", async () => {
  const f = await fixture(),
    a = await f.reserve();
  expect((await f.upload(a, Buffer.alloc(MAX_IMPORT_BYTES + 1))).status).toBe(413);
  expect((await f.upload(a, Buffer.from("<errado/>"))).status).toBe(400);
  expect(await f.t.run((ctx) => ctx.db.system.query("_storage").take(10))).toHaveLength(0);
});
it("token expira e revogação da chave invalida upload já reservado", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  const response = await f.request(
    `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
  );
  const token = (await response.json()).data.token;
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(401);
});
it("empresa incompatível preserva original, mas não publica nem expõe dados normalizados", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: "00000000000191" }));
  const batch = await f.reserve();
  await f.upload(batch);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const file = (await f.result(batch)).files[0]!;
  expect(file.code).toBe("COMPANY_MISMATCH");
  expect(file.documentId).toBeNull();
  expect(JSON.parse(file.result!).document).toBeNull();
});
it("schema desconhecido produz diagnóstico por arquivo e preserva bytes", async () => {
  const f = await fixture(),
    bytes = Buffer.from('<desconhecido versao="9.99"/>');
  const batch = await f.reserve(bytes);
  await f.upload(batch, bytes);
  const op = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const file = (await f.result(batch)).files[0]!;
  expect(file.state).toBe("succeeded");
  expect(file.documentId).toBeNull();
  expect(file.code).toMatch(/UNSUPPORTED/);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(2))).toHaveLength(1);
});

it("duas versões reais do processador preservam original e resultado anterior", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const first = await f.t.mutation(internal.testing.importProof.confirmV1, {
    fileId: batch.fileIds[0]!,
    keyHash: f.keyHash,
  });
  await f.t.action(internal.operationWorker.run, { operationId: first.operationId, generation: 1 });
  const before = JSON.parse(
    await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
  );
  expect(before.versions[0].processorVersion).toBe("xml-import/1");
  expect(JSON.parse(before.versions[0].result)).not.toHaveProperty("fiscalSituation");
  const response = await f.request(
    `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/reprocess`,
    "POST",
    {},
    "version-two",
  );
  expect(response.status).toBe(200);
  const second = (await response.json()).data;
  const during = JSON.parse(
    await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
  );
  expect(during.document.publishedVersionId).toBe(before.document.publishedVersionId);
  await f.t.action(internal.operationWorker.run, {
    operationId: second.operationId,
    generation: 1,
  });
  const after = JSON.parse(
    await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
  );
  expect(after.artifact).toEqual(before.artifact);
  expect(after.versions[0]).toEqual(before.versions[0]);
  expect(after.versions[1].processorVersion).toBe("xml-import/3");
  expect(JSON.parse(after.versions[1].result)).toHaveProperty("fiscalSituation");
  expect(after.document.publishedVersionId).toBe(after.versions[1]._id);
  const publicResult = (await f.result(batch)).files[0]!;
  expect(publicResult.versionId).toBe(after.versions[1]._id);
  expect(JSON.parse(publicResult.result!)).toHaveProperty("fiscalSituation");
  const history = await f.request(
    `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/history`,
    "GET",
  );
  expect((await history.json()).data).toHaveLength(2);
  const original = await f.t.run(async (ctx) =>
    (await ctx.storage.get(after.artifact.storageId))!.arrayBuffer(),
  );
  expect(createHash("sha256").update(new Uint8Array(original)).digest("hex")).toBe(
    after.artifact.sha256,
  );
});
it("historico preserva versao publicada apos mais de dez reprocessamentos sem sucesso", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const accepted = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, {
    operationId: accepted.operationId,
    generation: 1,
  });
  const original = (await f.t.run((ctx) =>
    ctx.db
      .query("documentVersions")
      .withIndex("by_operationId", (q) => q.eq("operationId", accepted.operationId))
      .unique(),
  ))!;
  for (let index = 0; index < 12; index++) {
    const response = await f.request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/reprocess`,
      "POST",
      {},
      `failed-${index}`,
    );
    const operationId = (await response.json()).data.operationId as Id<"operations">;
    await f.t.run(async (ctx) => {
      const {
        _id: _versionId,
        _creationTime: _created,
        publishedAt: _published,
        ...version
      } = original;
      await ctx.db.insert("documentVersions", {
        ...version,
        operationId,
        state: "staging",
        writtenItems: 0,
      });
      await ctx.db.patch("operations", operationId, {
        state: "failed",
        code: "PROCESSING_CHANGED",
      });
    });
  }
  const history = await f.request(
    `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/history`,
    "GET",
  );
  expect((await history.json()).data.map((version: { id: string }) => version.id)).toEqual([
    original._id,
  ]);
});
it("seletores de URL invalidos, obsoletos ou de outra tabela retornam selecao vazia", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const context = (company: string) =>
    owner.query(api.consoleCompany.context, {
      organizationId: f.scope.organizationId,
      company,
      contextKey: "imports",
    });
  for (const company of ["invalid", f.scope.projectId]) expect(await context(company)).toBeNull();
  expect(await context(f.scope.companyId)).toMatchObject({
    id: f.scope.companyId,
    canRead: true,
    canWrite: true,
    canManage: true,
  });
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  expect(await owner.query(api.imports.selected, { ...scope, batch: "invalid" })).toBeNull();
  expect(
    await owner.query(api.imports.selected, { ...scope, batch: f.scope.companyId }),
  ).toBeNull();
  await f.t.run((ctx) => ctx.db.delete("companies", f.scope.companyId));
  expect(await context(f.scope.companyId)).toBeNull();
});
it("membership removido invalida token emitido antes de receber os bytes", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  // A console batch: people upload only into the console project.
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "token-member",
    files: [
      {
        name: "nota.xml",
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    ],
  });
  const integration = await f.reserve();
  await expect(
    owner.mutation(api.imports.upload, { fileId: integration.fileIds[0]! }),
  ).rejects.toThrow("INTEGRATION_RECORD");
  await expect(
    owner.mutation(api.imports.cancel, { fileId: integration.fileIds[0]! }),
  ).rejects.toThrow("INTEGRATION_RECORD");
  const ticket = await owner.mutation(api.imports.upload, { fileId: batch.fileIds[0]! });
  await f.t.run((ctx) => ctx.db.patch("memberships", owner.membershipId, { state: "removed" }));
  const response = await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": ticket.token },
    body: new Uint8Array(f.bytes),
  });
  expect(response.status).not.toBe(200);
  expect(await f.t.run((ctx) => ctx.db.system.query("_storage").take(1))).toHaveLength(0);
});
it("revogacao entre resultado e checkpoint impede publicacao na mesma transacao", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const accepted = await f.confirm(batch);
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: accepted.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: 1, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  const outcome = await f.t.action(internal.importWorker.execute, {
    ...claim,
    request: op.request,
  });
  expect(await f.t.mutation(internal.operations.recordOutcome, { ...claim, outcome })).toBe(true);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(await f.t.mutation(internal.operations.checkpoint, claim)).toBe(false);
  const version = (await f.t.run((ctx) =>
    ctx.db
      .query("documentVersions")
      .withIndex("by_operationId", (q) => q.eq("operationId", op._id))
      .unique(),
  ))!;
  expect(version.state).toBe("staging");
  expect(
    (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", version.documentId!)))!
      .publishedVersionId,
  ).toBeUndefined();
  expect((await f.t.run((ctx) => ctx.db.get("operations", op._id)))!.state).toBe("paused");
});
it("outro artefato da mesma chave conserva hash e resultado sem sobrescrever o publicado", async () => {
  const f = await fixture(),
    a = await f.reserve();
  await f.upload(a);
  const opA = await f.confirm(a);
  await f.t.action(internal.operationWorker.run, { operationId: opA.operationId, generation: 1 });
  const original = (await f.result(a)).files[0]!;
  const distinct = Buffer.concat([Buffer.from("<!-- outra procedencia sintetica -->\n"), f.bytes]);
  const b = await f.reserve(distinct, "distinct");
  await f.upload(b, distinct);
  const opB = await f.confirm(b);
  await f.t.action(internal.operationWorker.run, { operationId: opB.operationId, generation: 1 });
  const next = (await f.result(b)).files[0]!;
  expect(next.documentId).toBe(original.documentId);
  expect(next.code).toBe("ARTIFACT_CONFLICT");
  const proof = JSON.parse(
    await f.t.query(internal.testing.importProof.inspect, { fileId: b.fileIds[0]! }),
  );
  expect(proof.document.publishedVersionId).toBe(original.versionId);
  expect(proof.artifact.sha256).not.toBe(createHash("sha256").update(f.bytes).digest("hex"));
});
it("resumo evolui para XML completo mantendo os dois artefatos", async () => {
  const f = await fixture(),
    summary = xmlFixture("summary-authorized"),
    a = await f.reserve(summary);
  await f.upload(a, summary);
  const first = await f.confirm(a);
  await f.t.action(internal.operationWorker.run, { operationId: first.operationId, generation: 1 });
  const previous = (await f.result(a)).files[0]!;
  const b = await f.reserve(f.bytes, "full");
  await f.upload(b);
  const next = await f.confirm(b);
  await f.t.action(internal.operationWorker.run, { operationId: next.operationId, generation: 1 });
  const result = (await f.result(b)).files[0]!;
  expect(previous.documentId).toBe(result.documentId);
  const proof = JSON.parse(
    await f.t.query(internal.testing.importProof.inspect, { fileId: b.fileIds[0]! }),
  );
  expect(proof.document.completeness).toBe(2);
  expect(proof.document.publishedVersionId).toBe(result.versionId);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(3))).toHaveLength(2);
});
it.each([false, true])(
  "retomada dos lotes preserva a saída completa; produtos alterados: %s",
  async (changedProducts) => {
    const f = await fixture();
    const xml = xmlFixture("invoice-unsigned").toString("utf8");
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await f.t.run((ctx) =>
      ctx.db.insert("onboarding", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        mode: "manual",
        guidanceDismissed: false,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    const originalItem = xml.match(/<det nItem="1">[\s\S]*?<\/det>/)![0];
    const bytes = Buffer.from(
      xml.replace(
        originalItem,
        Array.from({ length: 60 }, (_, index) =>
          originalItem.replace('nItem="1"', `nItem="${index + 1}"`),
        ).join(""),
      ),
    );
    const batch = await f.reserve(bytes);
    await f.upload(batch, bytes);
    const accepted = await f.confirm(batch);
    const op = (await f.t.mutation(internal.operations.claim, {
      operationId: accepted.operationId,
      generation: 1,
    }))!;
    const claim = { operationId: op._id, generation: 1, fence: op.fence };
    await f.t.mutation(internal.operations.beginEffect, claim);
    const source = (await f.t.mutation(internal.importProcessing.load, claim))!;
    const parsed = processNfe(bytes, { source: "imported-xml", evaluatedAt: source.evaluatedAt });
    const doc = parsed.normalized!.document;
    if (doc.kind !== "invoice") throw new Error("Expected invoice");
    const result = JSON.stringify({
      metadata: parsed.metadata,
      document: { ...doc, products: undefined },
      checks: parsed.checks,
      signature: parsed.signature,
      fiscalSituation: deriveFiscalSituation([parsed], RULE_VERSION),
    });
    const historicalProducts = doc.products.map((product, index) =>
      changedProducts && index === 0
        ? { ...product, description: "Saída da revisão anterior" }
        : product,
    );
    const historicalItems = historicalProducts.map((item) => JSON.stringify(item));
    const outputHash = createHash("sha256")
      .update(JSON.stringify({ result, items: historicalItems }))
      .digest("hex");
    const staged = (await f.t.mutation(internal.importProcessing.stage, {
      ...claim,
      artifactId: source.artifact._id,
      fiscalKey: doc.key,
      code: "IMPORTED",
      kind: doc.kind,
      completeness: 2,
      schema: JSON.stringify(parsed.metadata!.versions.schema),
      parserVersion: parsed.metadata!.versions.parser,
      normalizerVersion: parsed.metadata!.versions.normalizer,
      processorVersion: "xml-import/3",
      result,
      outputHash,
      itemCount: 60,
    }))!;
    if ("code" in staged) throw new Error("Expected initial staging");
    await f.t.mutation(internal.importProcessing.items, {
      ...claim,
      versionId: staged.versionId,
      offset: 0,
      items: historicalItems.slice(0, 25),
    });
    expect((await f.result(batch)).files[0]!.versionId).toBeNull();
    const pending = JSON.parse(
      await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
    );
    expect(pending.document.publishedVersionId).toBeUndefined();
    expect(pending.versions[0].writtenItems).toBe(25);
    expect(
      (
        await owner.query(api.onboarding.get, {
          organizationId: f.scope.organizationId,
          contextKey: "staged",
        })
      ).firstDocument,
    ).toBe("pending-import");
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    await f.t.mutation(internal.operations.recoverOne, { operationId: op._id });
    const recovered = (await f.t.run((ctx) => ctx.db.get("operations", op._id)))!;
    vi.setSystemTime(recovered.nextAttemptAt);
    expect(
      await f.t.mutation(internal.importProcessing.items, {
        ...claim,
        versionId: staged.versionId,
        offset: 25,
        items: [],
      }),
    ).toBe(false);
    const resumed = f.t.action(internal.operationWorker.run, {
      operationId: op._id,
      generation: recovered.generation,
    });
    if (changedProducts) {
      await resumed;
      const unchanged = JSON.parse(
        await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
      );
      expect(unchanged.versions[0].state).toBe("staging");
      expect(unchanged.versions[0].writtenItems).toBe(25);
      expect(unchanged.versions[0].items.map((item: { data: string }) => item.data)).toEqual(
        historicalItems.slice(0, 25),
      );
      expect(unchanged.document.publishedVersionId).toBeUndefined();
      expect((await f.result(batch)).files[0]).toMatchObject({
        state: "failed",
        code: "PROCESSING_CHANGED",
        result: null,
      });
      await f.t.mutation(internal.operations.recoverOne, { operationId: op._id });
      expect((await f.result(batch)).files[0]!.state).toBe("failed");
      expect(
        (
          await owner.query(api.onboarding.get, {
            organizationId: f.scope.organizationId,
            contextKey: "failed",
          })
        ).firstDocument,
      ).toBe("pending-import");
      return;
    }
    await resumed;
    const complete = JSON.parse(
      await f.t.query(internal.testing.importProof.inspect, { fileId: batch.fileIds[0]! }),
    );
    expect(complete.versions).toHaveLength(1);
    expect(complete.versions[0].state).toBe("complete");
    expect(
      complete.versions[0].items.map((item: { data: string }) => JSON.parse(item.data)),
    ).toEqual(doc.products);
    expect((await f.result(batch)).files[0]!.state).toBe("succeeded");
    expect(
      (
        await owner.query(api.onboarding.get, {
          organizationId: f.scope.organizationId,
          contextKey: "complete",
        })
      ).firstDocument,
    ).toBe("imported");
  },
);
it("mesmo hash em outra organização não revela existência nem concede acesso", async () => {
  const f = await fixture(),
    first = await f.reserve();
  await f.upload(first);
  const accepted = await f.confirm(first);
  await f.t.action(internal.operationWorker.run, {
    operationId: accepted.operationId,
    generation: 1,
  });
  const secret = `fnfe_${"c".repeat(43)}`,
    scope = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(secret),
      suffix: crypto.randomUUID(),
    });
  const company = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  await f.t.run((ctx) => ctx.db.patch("companies", scope.companyId, { cnpj: company.cnpj }));
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
    "Idempotency-Key": "another-org",
  };
  expect((await f.t.fetch(`/v1/imports/${first.importId}`, { headers })).status).toBe(404);
  const created = await f.t.fetch("/v1/imports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      companyId: scope.companyId,
      files: [
        {
          name: "nota.xml",
          size: f.bytes.length,
          sha256: createHash("sha256").update(f.bytes).digest("hex"),
        },
      ],
    }),
  });
  expect(created.status).toBe(200);
  const other = (await created.json()).data;
  expect(other.reused).toBe(false);
  const filePath = `/v1/imports/${other.importId}/files/${other.fileIds[0]}`;
  const ticket = (await (await f.t.fetch(`${filePath}/upload`, { method: "POST", headers })).json())
    .data;
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(200);
  const op = (await (await f.t.fetch(`${filePath}/confirm`, { method: "POST", headers })).json())
    .data;
  await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  const result = (await (await f.t.fetch(`/v1/imports/${other.importId}`, { headers })).json())
    .data;
  expect(result.files[0].code).toBe("IMPORTED");
  expect(result.files[0].documentId).not.toBe((await f.result(first)).files[0]!.documentId);
});
it("lote acima de 20, ZIP e metadados excessivos são rejeitados antes da reserva", async () => {
  const f = await fixture(),
    file = {
      name: "nota.xml",
      size: f.bytes.length,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
    };
  expect(
    (
      await f.request("/v1/imports", "POST", {
        companyId: f.scope.companyId,
        files: Array(21).fill(file),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("/v1/imports", "POST", {
        companyId: f.scope.companyId,
        files: [{ ...file, name: "notas.zip" }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("/v1/imports", "POST", {
        companyId: f.scope.companyId,
        files: [{ ...file, size: MAX_IMPORT_BYTES + 1 }],
      })
    ).status,
  ).toBe(400);
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(2))).toHaveLength(0);
});
it("revogação depois do efeito iniciado pausa em vez de transformar em falha definitiva", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const accepted = await f.confirm(batch);
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: accepted.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: 1, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  const outcome = await f.t.action(internal.importWorker.execute, {
    ...claim,
    request: op.request,
  });
  await f.t.mutation(internal.operations.recordOutcome, { ...claim, outcome });
  const final = (await f.t.run((ctx) => ctx.db.get("operations", op._id)))!;
  expect(final.state).toBe("paused");
  expect(final.code).toBe("ACCESS_REVOKED");
});
