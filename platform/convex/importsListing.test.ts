import { nfseXml } from "../../tests/helpers/nfse";
import { createHash } from "node:crypto";
import { it, expect } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { companyGrant, person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { processNfe } from "../../packages/fiscal-nfe/src/index";
import type { Id } from "./_generated/dataModel";
import { importBatchOutcome } from "./lib/importOutcome";
import { fixture, completedImport } from "../../tests/helpers/imports";

/** How the console lists imports: results, files without a document and the Início. */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});

it("keeps REST complete, leaves results out of the console queries and loads one detail on demand", async () => {
  const f = await completedImport();
  // B6: a result is a version's content, read by the console only through
  // `documentContentNode.importDetailRead`; the console queries never carry it.
  const expected = { ...f.full, files: f.full.files.map((file) => ({ ...file, result: null })) };
  expect(f.full).toEqual(expected);
  const rest = (await f.result(f.batch)) as typeof f.full;
  expect(typeof rest.files[0]!.result).toBe("string");
  // The console's view adds who created the batch and the processor of each visible result; the
  // REST summary (`get`, `/v1/imports/{id}`) keeps its contract.
  const projectName = await f.t.run(
    async (ctx) => (await ctx.db.get("projects", f.integration.projectId))!.name,
  );
  const forConsole = (value: typeof f.full) => ({
    ...value,
    origin: { kind: "integration", integration: projectName },
    currentProcessor: "xml-import/3",
    files: value.files.map((file) => ({ ...file, processorVersion: "xml-import/3" })),
  });
  expect(
    await f.owner.query(api.imports.selected, { ...f.scope, batch: f.batch.importId }),
  ).toEqual(forConsole(f.full));
  expect(
    await f.owner.query(api.imports.selected, {
      ...f.scope,
      batch: f.batch.importId,
      includeResults: false,
    }),
  ).toEqual(forConsole(expected));
  expect(f.full).not.toHaveProperty("origin");
  expect(
    await f.owner.query(api.imports.get, {
      importId: f.batch.importId,
      expectedScope: f.scope,
      includeResults: false,
    }),
  ).toEqual(expected);
  expect({ ...rest, files: rest.files.map((file) => ({ ...file, result: null })) }).toEqual(
    expected,
  );
  expect(await f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs)).toEqual({
    versionId: f.detailArgs.versionId,
    result: rest.files[0]!.result,
  });
  const viewer = await person(f.t, f.scope.organizationId, "viewer");
  await expect(
    viewer.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow();
  const grantId = await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: viewer.membershipId,
  });
  expect(
    await viewer.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).not.toBeNull();
  await f.t.run((ctx) => ctx.db.patch("companyGrants", grantId, { active: false }));
  await expect(
    viewer.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow();
  await expect(
    f.t.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch("memberships", f.owner.membershipId, { state: "removed" }));
  await expect(
    f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs),
  ).rejects.toThrow();
});

it("hides staging, failed and superseded results while preserving completed history", async () => {
  const f = await completedImport();
  await f.t.run((ctx) =>
    ctx.db.patch("documentVersions", f.detailArgs.versionId, { state: "staging" }),
  );
  expect(await f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs)).toBeNull();
  await f.t.run((ctx) =>
    ctx.db.patch("documentVersions", f.detailArgs.versionId, { state: "complete" }),
  );
  // The batch is the integration's: the console does not reprocess it; the integration does.
  await expect(
    f.owner.mutation(api.importProcessing.reprocess, {
      fileId: f.detailArgs.fileId,
      key: "detail-reprocess",
    }),
  ).rejects.toThrow("INTEGRATION_RECORD");
  const response = await f.request(
    `/v1/imports/${f.batch.importId}/files/${f.detailArgs.fileId}/reprocess`,
    "POST",
    {},
    "detail-reprocess",
  );
  const next = (await response.json()).data as { operationId: Id<"operations"> };
  expect(await f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs)).toBeNull();
  const pending = await f.owner.query(api.imports.get, {
    importId: f.batch.importId,
    includeResults: false,
  });
  expect(pending.files[0]!.versionId).toBeNull();
  await f.t.action(internal.operationWorker.run, { operationId: next.operationId, generation: 1 });
  const complete = await f.owner.query(api.imports.get, {
    importId: f.batch.importId,
    includeResults: false,
  });
  const versionId = complete.files[0]!.versionId!;
  expect(versionId).not.toBe(f.detailArgs.versionId);
  expect(await f.owner.action(api.documentContentNode.importDetailRead, f.detailArgs)).toBeNull();
  expect(
    await f.owner.action(api.documentContentNode.importDetailRead, { ...f.detailArgs, versionId }),
  ).not.toBeNull();
  expect(
    (
      await f.owner.action(api.documentContentNode.importHistoryRead, {
        fileId: f.detailArgs.fileId,
      })
    ).map((version) => version.id),
  ).toContain(f.detailArgs.versionId);
  await f.t.run((ctx) => ctx.db.patch("operations", next.operationId, { state: "failed" }));
  expect(
    await f.owner.action(api.documentContentNode.importDetailRead, { ...f.detailArgs, versionId }),
  ).toBeNull();
});

it("conta os arquivos sem documento que a lista mostra, só no escopo de quem lê", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual({
    count: 0,
    more: false,
    latestAt: null,
  });
  // A recognized NF-e is a document, not a refusal: it does not count.
  const recognized = await f.reserve();
  await f.upload(recognized);
  const first = await f.confirm(recognized);
  await f.t.action(internal.operationWorker.run, { operationId: first.operationId, generation: 1 });
  for (const name of ["a", "b"]) {
    const bytes = Buffer.from(`<desconhecido versao="9.99" id="${name}"/>`);
    const batch = await f.reserve(bytes, name);
    await f.upload(batch, bytes);
    const op = await f.confirm(batch);
    await f.t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
  }
  const counted = await owner.query(api.documents.unclassifiedCount, scope);
  const listed = await owner.query(api.documents.unclassified, {
    ...scope,
    cursor: null,
    limit: 20,
  });
  expect(counted).toEqual({ count: 2, more: false, latestAt: listed.page[0]!.importedAt });
  expect(Math.max(...listed.page.map((file) => file.importedAt))).toBe(counted.latestAt);
  expect(listed.page).toHaveLength(counted.count);
  // Production is another context, closed to a company that never released its capture.
  await expect(
    owner.query(api.documents.unclassifiedCount, { ...scope, environment: "production" }),
  ).rejects.toThrow();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-unclassified-key",
    suffix: "other-unclassified",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(outsider.query(api.documents.unclassifiedCount, scope)).rejects.toThrow();
});

it("conta até 20 arquivos sem documento e diz que há outros", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const add = (count: number, environment: "sandbox" | "production" = "sandbox") =>
    f.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", f.scope.companyId))!;
      for (let index = 0; index < count; index++)
        await ctx.db.insert("documentArtifacts", {
          organizationId: company.organizationId,
          projectId: f.scope.projectId,
          companyId: company._id,
          environment,
          sha256: `${index}`.padStart(64, "0"),
          size: 1,
          source: "distribution-xml",
          importedAt: 1_000 + index,
        });
    });
  await add(20);
  // Another environment is another range.
  await add(3, "production");
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual({
    count: 20,
    more: false,
    latestAt: 1_019,
  });
  await add(1);
  expect(await owner.query(api.documents.unclassifiedCount, scope)).toEqual({
    count: 20,
    more: true,
    latestAt: 1_019,
  });
});

it("o console lista os lotes da empresa de todos os projetos, sem os de outra empresa", async () => {
  const f = await fixture(),
    batch = await f.reserve(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  await f.t.run(async (ctx) => {
    const original = (await ctx.db.get("imports", batch.importId))!;
    const project = (await ctx.db.get("projects", f.scope.projectId))!;
    const { _id: _projectId, _creationTime: _projectTime, ...projectFields } = project;
    const otherProject = await ctx.db.insert("projects", {
      ...projectFields,
      externalReference: "other",
    });
    const { _id: _batchId, _creationTime: _batchTime, ...fields } = original;
    for (let index = 0; index < 3; index++)
      await ctx.db.insert("imports", { ...fields, projectId: otherProject, key: `other-${index}` });
    const {
      _id: _companyId,
      _creationTime: _companyTime,
      ...company
    } = (await ctx.db.get("companies", f.scope.companyId))!;
    const otherCompany = await ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    for (let index = 0; index < 21; index++)
      await ctx.db.insert("imports", { ...fields, companyId: otherCompany, key: `c-${index}` });
  });
  const rows = await owner.query(api.imports.recent, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
  });
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.id)).toContain(batch.importId);
  // A batch of an integration names it, so the console can say who manages it.
  const integration = await f.t.run(
    async (ctx) => (await ctx.db.get("projects", f.scope.projectId))!.name,
  );
  expect(rows.find((row) => row.id === batch.importId)!.origin).toEqual({
    kind: "integration",
    integration,
  });
});

it("o Início lista uma vez cada lote com XML recusado e acompanha o resultado atual (#507)", async () => {
  // Legacy NFS-e batches keep their outcomes on the files imported before the retirement.
  const f = await fixture(undefined, true);
  const nfe = xmlFixture("invoice-authorized");
  const issuer = processNfe(nfe).normalized!.document;
  if (issuer.kind !== "invoice") throw new Error("Expected invoice");
  const company = issuer.issuer.document;
  const nfse = Buffer.from(nfseXml([1, 2], company));
  const otherCompany = "55444333000122";
  const mismatch = Buffer.from(nfseXml([9], otherCompany));
  const unknownSchema = xmlFixture("schema-unknown");
  /** Reserves a batch through REST and processes each file with the real worker. */
  async function batch(key: string, files: Buffer[], send = files.length) {
    const reserved = await f.request(
      "/v1/imports",
      "POST",
      {
        companyId: f.scope.companyId,
        files: files.map((data, i) => ({
          name: `arquivo-${i}.xml`,
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        })),
      },
      key,
    );
    const { importId, fileIds } = (await reserved.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
    };
    for (const [i, fileId] of fileIds.slice(0, send).entries()) {
      const path = `/v1/imports/${importId}/files/${fileId}`;
      const ticket = (await (await f.request(`${path}/upload`, "POST", {}, `${key}-u${i}`)).json())
        .data as { token: string };
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(files[i]!),
      });
      const { operationId } = (
        await (await f.request(`${path}/confirm`, "POST", {}, `${key}-c${i}`)).json()
      ).data as { operationId: Id<"operations"> };
      await f.t.action(internal.operationWorker.run, { operationId, generation: 1 });
    }
    return { importId, fileIds };
  }
  // NF-e and NFS-e ABRASF side by side: imported, two refusals after a finished processing.
  const mixed = await batch("mixed", [
    nfe,
    nfse,
    unknownSchema,
    Buffer.from(nfseXml([3], otherCompany)),
  ]);
  // The same notes again (duplicate NF-e, NFS-e batch imported with duplicate notes) and a file
  // reserved and never sent: in progress, not a pending item.
  const repeated = await batch("repeated", [nfe, nfse, Buffer.from(nfseXml([4], company))], 2);
  // A refusal while another file still waits for its upload: pending now, once.
  const waiting = await batch(
    "waiting",
    [Buffer.from(nfseXml([7], otherCompany)), Buffer.from(nfseXml([8], company))],
    1,
  );
  // Only refused: the company does not take part in the NFS-e.
  const refused = await batch("refused", [mismatch]);

  const owner = await person(f.t, f.scope.organizationId, "owner");
  const files = async (importId: Id<"imports">) =>
    (await owner.query(api.imports.get, { importId })).files.map(({ state, code }) => ({
      state,
      code,
    }));
  expect(await files(mixed.importId)).toEqual([
    { state: "succeeded", code: "IMPORTED" },
    { state: "succeeded", code: "NFSE_BATCH_IMPORTED" },
    { state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" },
    { state: "succeeded", code: "COMPANY_MISMATCH" },
  ]);
  expect(await files(repeated.importId)).toEqual([
    { state: "succeeded", code: "DUPLICATE" },
    { state: "succeeded", code: "NFSE_BATCH_IMPORTED" },
    { state: "reserved", code: null },
  ]);
  expect(await files(waiting.importId)).toEqual([
    { state: "succeeded", code: "COMPANY_MISMATCH" },
    { state: "reserved", code: null },
  ]);
  expect(await files(refused.importId)).toEqual([{ state: "succeeded", code: "COMPANY_MISMATCH" }]);

  const now = Date.now();
  const home = (actor: typeof owner, organizationId = f.scope.organizationId) =>
    actor.query(api.consoleHome.summary, {
      organizationId,
      monthStart: now - 86_400_000,
      asOf: now + 60_000,
      contextKey: "imports-507",
    });
  const pendingImports = async () => {
    const summary = await home(owner);
    const items = summary.pending.filter((item) => item.kind === "import-failed");
    return { count: summary.month!.failedImports, records: items.map((item) => item.recordId) };
  };
  // Each batch once, linked to itself; the screen's rule agrees on every batch.
  const listed = [mixed.importId, waiting.importId, refused.importId];
  expect(await pendingImports()).toEqual({ count: 3, records: expect.arrayContaining(listed) });
  expect((await pendingImports()).records).toHaveLength(3);
  for (const [id, state] of [
    [mixed.importId, "attention"],
    [repeated.importId, "running"],
    [waiting.importId, "attention"],
    [refused.importId, "attention"],
  ] as const)
    expect(importBatchOutcome(await files(id)).state).toBe(state);

  // The company grant decides: an operator sees the batches only once granted the company, and
  // the owner of another organization never does.
  const operator = await person(f.t, f.scope.organizationId, "operator");
  expect((await home(operator)).pending).toEqual([]);
  const granted = await person(f.t, f.scope.organizationId, "operator", {
    companyId: f.scope.companyId,
  });
  expect((await home(granted)).pending.filter((item) => item.kind === "import-failed").length).toBe(
    3,
  );
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-home-507",
    suffix: "other-home-507",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  expect((await home(outsider, other.organizationId)).month!.failedImports).toBe(0);
  await expect(home(outsider)).rejects.toThrow();
  // An operation whose response lacks the code (written before it carried one) reads the version.
  const refusedOperation = (await f.t.run((ctx) => ctx.db.get("importFiles", refused.fileIds[0]!)))!
    .operationId!;
  await f.t.run((ctx) => ctx.db.patch("operations", refusedOperation, { response: undefined }));
  expect((await pendingImports()).records).toContain(refused.importId);

  // A newer accepted result replaces the refusal only when the reprocess moves the file's
  // `processingOperationId` (the #499 contract). The company now takes part in the NFS-e.
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { cnpj: otherCompany }));
  // By the integration, in the batch's project: the pointer moves and the batch leaves.
  const retry = await f.request(
    `/v1/imports/${refused.importId}/files/${refused.fileIds[0]}/reprocess`,
    "POST",
    {},
    "refused-again",
  );
  const operationId = (await retry.json()).data.operationId as Id<"operations">;
  await f.t.action(internal.operationWorker.run, { operationId, generation: 1 });
  expect(await files(refused.importId)).toEqual([
    { state: "succeeded", code: "NFSE_BATCH_IMPORTED" },
  ]);
  expect(await pendingImports()).toEqual({
    count: 2,
    records: expect.arrayContaining([mixed.importId, waiting.importId]),
  });
});
