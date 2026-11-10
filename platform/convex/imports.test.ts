import { legacyNfseImport, nfseXml } from "../../tests/helpers/nfse";
import { routes } from "../../packages/contracts/src/external";
import { demonstrationCompany } from "../../packages/contracts/src/companies";
/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import {
  companyGrant,
  person,
  platformTest,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import {
  processNfe,
  deriveFiscalSituation,
  RULE_VERSION,
} from "../../packages/fiscal-nfe/src/index";
import { MAX_IMPORT_BYTES, IMPORT_MIME } from "./lib/importValues";
import { LEASE_MS } from "./lib/operationValues";
import type { Id } from "./_generated/dataModel";
import { importStates, importSummary, requestCleanup } from "./lib/importCore";
import { importBatchOutcome } from "./lib/importOutcome";
import type { QueryCtx } from "./_generated/server";
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-import-secret",
});
/** `legacy`: NFS-e batches go through the retired ABRASF reader (`legacyNfseImport`). */
async function fixture(bytes = xmlFixture("invoice-signed"), legacy = false) {
  const t = platformTest(legacy ? legacyNfseImport() : {});
  const secret = `fnfe_${"b".repeat(43)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await t.run((ctx) => ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document }));
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  };
  async function request(path: string, method = "POST", body?: unknown, key = "first") {
    return t.fetch(path, {
      method,
      headers: { ...headers, "Idempotency-Key": key },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  async function reserve(data = bytes, key = "first") {
    const response = await request(
      "/v1/imports",
      "POST",
      {
        companyId: scope.companyId,
        files: [
          {
            name: "nota.xml",
            size: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        ],
      },
      key,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
      reused: boolean;
    };
  }
  async function upload(batch: Awaited<ReturnType<typeof reserve>>, data = bytes) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    );
    expect(response.status).toBe(200);
    const ticket = (await response.json()).data as { token: string };
    return t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(data),
    });
  }
  async function confirm(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as { operationId: Id<"operations">; reused: boolean };
  }
  async function result(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(`/v1/imports/${batch.importId}`, "GET");
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      files: Array<{
        code: string;
        state: string;
        result: string | null;
        documentId: string | null;
        versionId: string | null;
      }>;
    };
  }
  return { t, scope, bytes, request, reserve, upload, confirm, result, keyHash };
}

async function completedImport() {
  const f = await fixture();
  const batch = await f.reserve(xmlFixture("invoice-authorized"));
  await f.upload(batch, xmlFixture("invoice-authorized"));
  const accepted = await f.confirm(batch);
  await f.t.action(internal.operationWorker.run, {
    operationId: accepted.operationId,
    generation: 1,
  });
  const owner = await person(f.t, f.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const full = await owner.query(api.imports.get, { importId: batch.importId });
  const file = full.files[0]!;
  if (!file.versionId) throw new Error("Expected completed version");
  return {
    ...f,
    integration: f.scope,
    batch,
    owner,
    scope,
    full,
    detailArgs: { fileId: file.id, versionId: file.versionId, expectedScope: scope },
  };
}

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

// Count returned database documents and their JSON bytes, not Convex billing or wire deltas.
function measuredDb(db: QueryCtx["db"]) {
  const reads = { queries: 0, documents: 0, jsonBytes: 0, entries: 0 };
  function trace<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, object, args);
          if (["get", "unique", "take"].includes(String(key))) {
            reads.queries++;
            return Promise.resolve(result).then((value: unknown) => {
              for (const doc of Array.isArray(value) ? value : value === null ? [] : [value]) {
                reads.documents++;
                reads.jsonBytes += Buffer.byteLength(JSON.stringify(doc));
                // Published entries of a batch version (NF-e 55 has one, an ABRASF batch many).
                if (doc && typeof doc === "object" && "parentVersionId" in doc) reads.entries++;
              }
              return value;
            });
          }
          return result && typeof result === "object" ? trace(result) : result;
        };
      },
    });
  }
  return { db: trace(db), reads };
}

it.each(["fixture", "synthetic-large"])(
  "measures a 20-file %s batch without pretending to reduce DB reads",
  async (scenario) => {
    const f = await completedImport();
    await f.t.run(async (ctx) => {
      const file = (await ctx.db.get("importFiles", f.detailArgs.fileId))!;
      const operation = (await ctx.db.get("operations", file.operationId!))!;
      const version = (await ctx.db.get("documentVersions", f.detailArgs.versionId))!;
      const { _id: _fileId, _creationTime: _fileTime, ...fileData } = file;
      const { _id: _opId, _creationTime: _opTime, ...operationData } = operation;
      const { _id: _versionId, _creationTime: _versionTime, ...versionData } = version;
      const result =
        scenario === "fixture"
          ? version.result
          : JSON.stringify({ diagnostic: "x".repeat(120000) });
      await ctx.db.patch("documentVersions", version._id, { result });
      for (let i = 1; i < 20; i++) {
        const operationId = await ctx.db.insert("operations", operationData);
        await ctx.db.insert("importFiles", {
          ...fileData,
          position: i,
          name: `nota-${i}.xml`,
          operationId,
        });
        await ctx.db.insert("documentVersions", { ...versionData, operationId, result });
      }
    });
    const measure = (includeResults: boolean) =>
      f.t.run(async (ctx) => {
        const batch = (await ctx.db.get("imports", f.batch.importId))!;
        const tracked = measuredDb(ctx.db);
        const summary = await importSummary({ ...ctx, db: tracked.db }, batch, includeResults);
        return {
          payloadBytes: Buffer.byteLength(JSON.stringify(summary)),
          ...tracked.reads,
          summary,
        };
      });
    const before = await measure(true),
      after = await measure(false);
    expect(after.summary.files).toHaveLength(20);
    expect(
      after.summary.files.every((file) => file.result === null && file.versionId !== null),
    ).toBe(true);
    expect(after.documents).toBe(60);
    expect(after.jsonBytes).toBe(before.jsonBytes);
    expect(after.payloadBytes).toBeLessThan(before.payloadBytes / 10);
    process.stdout.write(
      JSON.stringify({
        scenario,
        before: {
          payloadBytes: before.payloadBytes,
          documents: before.documents,
          readJsonBytes: before.jsonBytes,
        },
        after: {
          payloadBytes: after.payloadBytes,
          documents: after.documents,
          readJsonBytes: after.jsonBytes,
        },
      }) + "\n",
    );
  },
);
it.each(["nfe-55", "abrasf"] as const)(
  "recent reads ten 20-file %s batches without published entries and keeps state and code",
  async (model) => {
    const f = await fixture(undefined, model === "abrasf");
    const xml = model === "abrasf" ? Buffer.from(nfseXml()) : xmlFixture("invoice-authorized");
    if (model === "abrasf")
      await f.t.run((ctx) =>
        ctx.db.patch("companies", f.scope.companyId, { cnpj: "11222333000181" }),
      );
    const first = await f.reserve(xml);
    await f.upload(first, xml);
    const accepted = await f.confirm(first);
    await f.t.action(internal.operationWorker.run, {
      operationId: accepted.operationId,
      generation: 1,
    });
    // Ten batches of twenty files, each a copy of the processed one with its published entries,
    // then varied outcomes: pending, rejected, superseded by a reprocess, reserved and partial.
    await f.t.run(async (ctx) => {
      const strip = <T extends { _id: unknown; _creationTime: number }>({
        _id: _unused,
        _creationTime: _time,
        ...rest
      }: T) => rest;
      const batch = (await ctx.db.get("imports", first.importId))!;
      const file = (await ctx.db.get("importFiles", first.fileIds[0]!))!;
      const operation = (await ctx.db.get("operations", file.operationId!))!;
      const version = (await ctx.db
        .query("documentVersions")
        .withIndex("by_operationId_entryIndex", (q) =>
          q.eq("operationId", operation._id).eq("entryIndex", undefined),
        )
        .unique())!;
      const entries = await ctx.db
        .query("documentVersions")
        .withIndex("by_parentVersionId", (q) => q.eq("parentVersionId", version._id))
        .take(20);
      // An NF-e 55 version is the document itself; an ABRASF batch publishes one entry per invoice.
      expect(entries).toHaveLength(model === "abrasf" ? 7 : 0);
      if (entries[0])
        await ctx.db.patch("documentVersions", entries[0]._id, { publishedAt: undefined });
      for (let b = 0; b < 10; b++) {
        const importId =
          b === 0 ? batch._id : await ctx.db.insert("imports", { ...strip(batch), key: `r-${b}` });
        for (let i = b === 0 ? 1 : 0; i < 20; i++) {
          const outcome = (b + i) % 5;
          if (outcome === 4) {
            await ctx.db.insert("importFiles", {
              ...strip(file),
              importId,
              position: i,
              state: "reserved",
              operationId: undefined,
              processingOperationId: undefined,
            });
            continue;
          }
          const operationId = await ctx.db.insert("operations", {
            ...strip(operation),
            ...(outcome === 1 ? { state: "running" as const, code: undefined } : {}),
            ...(outcome === 2 ? { state: "failed" as const, code: "COMPANY_MISMATCH" } : {}),
          });
          await ctx.db.insert("importFiles", {
            ...strip(file),
            importId,
            position: i,
            operationId,
            processingOperationId: undefined,
          });
          const versionId = await ctx.db.insert("documentVersions", {
            ...strip(version),
            operationId,
            ...(outcome === 3 ? { state: "staging" as const } : {}),
          });
          for (const entry of entries)
            await ctx.db.insert("documentVersions", {
              ...strip(entry),
              parentVersionId: versionId,
            });
        }
      }
    });
    const measure = (path: "summary" | "states") =>
      f.t.run(async (ctx) => {
        const tracked = measuredDb(ctx.db);
        const batches = await ctx.db
          .query("imports")
          .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
            q
              .eq("organizationId", f.scope.organizationId)
              .eq("companyId", f.scope.companyId)
              .eq("environment", "sandbox"),
          )
          .order("desc")
          .take(10);
        const rows = [];
        for (const batch of batches)
          rows.push(
            path === "states"
              ? await importStates({ ...ctx, db: tracked.db }, batch)
              : (await importSummary({ ...ctx, db: tracked.db }, batch, false)).files.map(
                  ({ state, code }) => ({ state, code }),
                ),
          );
        return { rows, ...tracked.reads };
      });
    const before = await measure("summary"),
      after = await measure("states");
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.flat()).toHaveLength(200);
    expect(new Set(after.rows.flat().map((row) => row.state))).toEqual(
      new Set(["succeeded", "running", "failed", "reserved"]),
    );
    expect(after.entries).toBe(0);
    expect(before.entries).toBe(model === "abrasf" ? 7 * 40 : 0);
    // One entry lookup less for each of the 40 files with a visible result.
    expect(after.queries).toBe(before.queries - 40);
    expect(after.documents).toBe(before.documents - before.entries);
    if (model === "abrasf") expect(after.jsonBytes).toBeLessThan(before.jsonBytes);
    else expect(after.jsonBytes).toBe(before.jsonBytes);
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const scope = {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    };
    expect((await owner.query(api.imports.recent, scope)).map((row) => row.files)).toEqual(
      after.rows,
    );
    const operator = await person(f.t, f.scope.organizationId, "operator");
    await expect(operator.query(api.imports.recent, scope)).rejects.toThrow("NOT_FOUND");
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: `other-recent-${model}`,
      suffix: `other-recent-${model}`,
    });
    const outsider = await person(f.t, other.organizationId, "owner");
    await expect(outsider.query(api.imports.recent, scope)).rejects.toThrow();
    expect(
      await outsider.query(api.imports.recent, {
        organizationId: other.organizationId,
        companyId: other.companyId,
        environment: "sandbox",
      }),
    ).toEqual([]);
    // Documents read, not Convex billing or latency: those were not measured here.
    process.stdout.write(
      JSON.stringify({
        model,
        batches: 10,
        filesPerBatch: 20,
        before: {
          queries: before.queries,
          documents: before.documents,
          entries: before.entries,
          readJsonBytes: before.jsonBytes,
        },
        after: {
          queries: after.queries,
          documents: after.documents,
          entries: after.entries,
          readJsonBytes: after.jsonBytes,
        },
      }) + "\n",
    );
  },
);
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
it("limpeza remove órfão de upload interrompido e preserva o blob vinculado", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  await f.upload(batch);
  const orphan = await f.t.run((ctx) =>
    ctx.storage.store(new Blob(["orphan"], { type: IMPORT_MIME })),
  );
  // convex-test 0.0.56 omits Blob.type from system metadata; native storage preserves it.
  await f.t.run((ctx) => ctx.db.patch(orphan as never, { contentType: IMPORT_MIME } as never));
  vi.setSystemTime(Date.now() + 1000);
  await f.t.mutation(internal.importUpload.sweep, { cursor: null, before: Date.now() });
  expect(await f.t.run(async (ctx) => !!(await ctx.db.system.get("_storage", orphan)))).toBe(false);
  const file = (await f.t.run((ctx) => ctx.db.get("importFiles", batch.fileIds[0]!)))!;
  expect(
    await f.t.run(async (ctx) => !!(await ctx.db.system.get("_storage", file.storageId!))),
  ).toBe(true);
});
it("sessão humana reserva sem API key e perda do acesso pausa o worker", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "human",
    files: [
      {
        name: "nota.xml",
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    ],
  });
  const ticket = await owner.mutation(api.imports.upload, { fileId: batch.fileIds[0]! });
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(200);
  const accepted = await owner.mutation(api.imports.confirm, { fileId: batch.fileIds[0]! });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
  expect(op.sourceKeyId).toBeUndefined();
  expect(op.sourceMembershipId).toBe(owner.membershipId);
  // The console batch and its operation belong to the organization's console project.
  const owned = await f.t.run(async (ctx) => ({
    batch: (await ctx.db.get("imports", batch.importId))!.projectId,
    project: (await ctx.db.get("projects", op.projectId))!,
  }));
  expect(owned.batch).toBe(op.projectId);
  expect(owned.project).toMatchObject({ kind: "console", externalReference: "" });
  // No API key reaches what the console imported, even the organization's own key.
  expect(
    (await f.request(`/v1/imports/${batch.importId}`, "GET", undefined, "console-read")).status,
  ).toBe(404);
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { state: "removed", version: 2 }),
  );
  await f.t.action(internal.operationWorker.run, { operationId: op._id, generation: 1 });
  expect((await f.t.run((ctx) => ctx.db.get("operations", op._id)))!.state).toBe("paused");
  await expect(owner.query(api.imports.get, { importId: batch.importId })).rejects.toThrow();
});
it("cancelamento do painel distingue arquivo aceito e não reabre o envio cancelado", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const spec = (name: string) => ({
    name,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  });
  const batch = await owner.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "cancel-race",
    files: [spec("a.xml"), spec("b.xml")],
  });
  const [a, b] = batch.fileIds as [Id<"importFiles">, Id<"importFiles">];
  const ticket = await owner.mutation(api.imports.upload, { fileId: a });
  const late = await owner.mutation(api.imports.upload, { fileId: b });
  await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": ticket.token },
    body: new Uint8Array(f.bytes),
  });
  const accepted = await owner.mutation(api.imports.confirm, { fileId: a });
  // A confirmed before the cancel reached the server: it keeps its real state.
  await expect(owner.mutation(api.imports.cancel, { fileId: a })).rejects.toThrow(
    "ALREADY_ACCEPTED",
  );
  await owner.mutation(api.imports.cancel, { fileId: b });
  // Repeating the cancel is harmless, and a ticket issued before it no longer uploads.
  await owner.mutation(api.imports.cancel, { fileId: b });
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": late.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).not.toBe(200);
  await expect(owner.mutation(api.imports.upload, { fileId: b })).rejects.toThrow("UPLOAD_EXPIRED");
  await expect(owner.mutation(api.imports.confirm, { fileId: b })).rejects.toThrow(
    "UPLOAD_EXPIRED",
  );
  const files = await f.t.run(async (ctx) => [
    await ctx.db.get("importFiles", a),
    await ctx.db.get("importFiles", b),
  ]);
  expect(files.map((file) => [file?.state, file?.operationId ?? null])).toEqual([
    ["accepted", accepted.operationId],
    ["expired", null],
  ]);
  // Confirming A again recovers the same operation instead of creating another.
  expect(await owner.mutation(api.imports.confirm, { fileId: a })).toEqual({
    operationId: accepted.operationId,
    reused: true,
  });
});
it("envio sem resposta: reconsulta, ticket novo e confirmação não duplicam o arquivo", async () => {
  const f = await fixture(),
    owner = await person(f.t, f.scope.organizationId, "owner");
  const spec = (name: string) => ({
    name,
    size: f.bytes.length,
    sha256: createHash("sha256").update(f.bytes).digest("hex"),
  });
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const batch = await owner.mutation(api.imports.reserve, {
    ...scope,
    key: "no-answer",
    files: [spec("a.xml"), spec("b.xml")],
  });
  const [a, b] = batch.fileIds as [Id<"importFiles">, Id<"importFiles">];
  const send = (token: string) =>
    f.t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": token },
      body: new Uint8Array(f.bytes),
    });
  const stored = () =>
    f.t.run(async (ctx) => (await ctx.db.system.query("_storage").take(10)).length);
  const states = async () =>
    (
      await owner.query(api.imports.get, {
        importId: batch.importId,
        expectedScope: scope,
        includeResults: false,
      })
    ).files.map((file) => file.state);
  // A arrived, but the browser gave up before the answer. The re-query says so.
  const first = await owner.mutation(api.imports.upload, { fileId: a });
  expect((await send(first.token)).status).toBe(200);
  expect(await states()).toEqual(["uploaded", "reserved"]);
  // Even a client that resends anyway gets no second blob and no second ticket.
  expect((await send(first.token)).status).not.toBe(200);
  await expect(owner.mutation(api.imports.upload, { fileId: a })).rejects.toThrow("UPLOAD_EXPIRED");
  expect(await stored()).toBe(1);
  const accepted = await owner.mutation(api.imports.confirm, { fileId: a });
  expect(await owner.mutation(api.imports.confirm, { fileId: a })).toEqual({
    ...accepted,
    reused: true,
  });
  // Reading the state is open to a viewer of the company; a new ticket is not.
  const viewer = await person(f.t, f.scope.organizationId, "viewer");
  await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: viewer.membershipId,
  });
  expect(
    (await viewer.query(api.imports.get, { importId: batch.importId })).files.map((x) => x.state),
  ).toEqual(["queued", "reserved"]);
  await expect(viewer.mutation(api.imports.upload, { fileId: b })).rejects.toThrow("SCOPE_DENIED");
  // B's request never reached the server before the timeout; resuming asks for a new ticket.
  const lost = await owner.mutation(api.imports.upload, { fileId: b });
  const retry = await owner.mutation(api.imports.upload, { fileId: b });
  // The lost request lands late: its token was replaced, so it stores nothing.
  expect((await send(lost.token)).status).not.toBe(200);
  expect(await stored()).toBe(1);
  expect((await send(retry.token)).status).toBe(200);
  await owner.mutation(api.imports.confirm, { fileId: b });
  expect(await stored()).toBe(2);
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").take(5))).toHaveLength(2);
  expect(await f.t.run((ctx) => ctx.db.query("operations").take(5))).toHaveLength(2);
  // The re-query reads nothing of another organization, and a viewer cannot take a ticket.
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-no-answer-key",
    suffix: "other-no-answer",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(
    outsider.query(api.imports.get, { importId: batch.importId, includeResults: false }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    owner.query(api.imports.get, {
      importId: batch.importId,
      expectedScope: { ...scope, companyId: other.companyId },
    }),
  ).rejects.toThrow("NOT_FOUND");
});
it("leitura não reserva importação e operador precisa da concessão da empresa", async () => {
  const f = await fixture(),
    viewer = await person(f.t, f.scope.organizationId, "viewer"),
    operator = await person(f.t, f.scope.organizationId, "operator");
  const args = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
    key: "human",
    files: [
      {
        name: "nota.xml",
        size: f.bytes.length,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      },
    ],
  };
  await expect(viewer.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  await expect(operator.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  for (const member of [viewer, operator])
    await companyGrant(f.t, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: member.membershipId,
    });
  // The integration's grant does not matter to people: revoke it entirely.
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { active: false });
  });
  await expect(viewer.mutation(api.imports.reserve, args)).rejects.toThrow("SCOPE_DENIED");
  const reserved = await operator.mutation(api.imports.reserve, args);
  expect(reserved).toHaveProperty("importId");
  // Same key, same request: the console namespace returns the same reservation.
  expect(await operator.mutation(api.imports.reserve, args)).toMatchObject({
    importId: reserved.importId,
    reused: true,
  });
  expect(
    await viewer.query(api.imports.recent, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
    }),
  ).toEqual([
    {
      id: reserved.importId,
      createdAt: expect.any(Number),
      // Made in the console: the list says so and gives each file's state and result code.
      origin: { kind: "console", integration: null },
      files: [{ state: "reserved", code: null }],
    },
  ]);
  // A developer with access to the company works through integrations, not the console.
  const developer = await person(f.t, f.scope.organizationId, "owner");
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", developer.membershipId, { role: "developer" }),
  );
  await expect(developer.mutation(api.imports.reserve, args)).rejects.toThrow("NOT_FOUND");
  await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: developer.membershipId,
  });
  await expect(developer.mutation(api.imports.reserve, args)).rejects.toThrow("SCOPE_DENIED");
  await expect(
    developer.query(api.imports.recent, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  // Another organization's owner reaches nothing here.
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-reserve-key",
    suffix: "other-reserve",
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(outsider.mutation(api.imports.reserve, args)).rejects.toThrow();
});
it("o XML de exemplo do painel segue a concessão e o papel na empresa de demonstração (#510)", async () => {
  // The console fetches the public example and reserves it like any chosen file: the server
  // decides by the company grant, not by the file being public.
  const example = readFileSync(
      new URL("../../apps/console/public/examples/nfe-demonstracao.xml", import.meta.url),
    ),
    f = await fixture(example);
  const demo = await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const { _id, _creationTime, ...fields } = company;
    return ctx.db.insert("companies", {
      ...fields,
      kind: "demonstration",
      cnpj: demonstrationCompany.cnpj,
      name: demonstrationCompany.name,
    });
  });
  const operator = await person(f.t, f.scope.organizationId, "operator"),
    viewer = await person(f.t, f.scope.organizationId, "viewer");
  const grant = (member: { membershipId: Id<"memberships"> }, companyId: Id<"companies">) =>
    companyGrant(f.t, {
      organizationId: f.scope.organizationId,
      companyId,
      membershipId: member.membershipId,
    });
  await grant(operator, f.scope.companyId);
  const reserve = (
    member: typeof operator,
    companyId: Id<"companies">,
    key = `exemplo-${companyId}`,
  ) =>
    member.mutation(api.imports.reserve, {
      organizationId: f.scope.organizationId,
      companyId,
      environment: "sandbox" as const,
      key,
      files: [
        {
          name: "nfe-demonstracao.xml",
          size: example.length,
          sha256: createHash("sha256").update(example).digest("hex"),
        },
      ],
    });
  // Granted only company A: the demonstration company is not found, and nothing is reserved.
  await expect(reserve(operator, demo)).rejects.toThrow("NOT_FOUND");
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(1))).toEqual([]);
  // The grant the operator does hold still takes the same file.
  expect(await reserve(operator, f.scope.companyId)).toMatchObject({ reused: false });
  // Granted the demonstration company, the operator imports into it like any other company.
  await grant(operator, demo);
  expect(await reserve(operator, demo)).toMatchObject({ reused: false });
  // A viewer never reserves: without the grant the company is not found, with it the role is refused.
  await expect(reserve(viewer, demo, "viewer")).rejects.toThrow("NOT_FOUND");
  await grant(viewer, demo);
  await expect(reserve(viewer, demo, "viewer")).rejects.toThrow("SCOPE_DENIED");
  expect(await f.t.run((ctx) => ctx.db.query("imports").take(3))).toHaveLength(2);
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
it("renovar tokens compartilha uma limpeza incremental, sem varredura por token", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  for (let index = 0; index < 10; index++)
    expect(
      (await f.request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`)).status,
    ).toBe(200);
  const maintenance = await f.t.run((ctx) => ctx.db.query("importMaintenance").take(2));
  expect(maintenance).toHaveLength(1);
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(50));
  expect(jobs.filter((job) => job.name === "importUpload:cleanup")).toHaveLength(1);
  expect(jobs.filter((job) => job.name === "importUpload:sweep")).toHaveLength(0);
  vi.setSystemTime(maintenance[0]!.nextAt!);
  await f.t.mutation(internal.importUpload.cleanup, {});
  const next = (await f.t.run((ctx) => ctx.db.query("importMaintenance").first()))!;
  expect(next.lastSweptAt).toBeGreaterThan(maintenance[0]!.lastSweptAt);
});
it("cleanup coverage is coalesced, extends monotonically, and rearms after the scanner stops", async () => {
  const f = await fixture();
  const until = Date.now() + 90_001;
  const requestedUntil = Math.ceil(until / 60_000) * 60_000;
  await f.t.run((ctx) => requestCleanup(ctx, until));
  const state = (await f.t.run((ctx) => ctx.db.query("importMaintenance").unique()))!;
  expect(state.requestedUntil).toBe(requestedUntil);
  await f.t.run((ctx) => requestCleanup(ctx, until + 1));
  expect(await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id))).toEqual(state);
  await f.t.run((ctx) => requestCleanup(ctx, requestedUntil + 1));
  const extended = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(extended.requestedUntil).toBe(requestedUntil + 60_000);
  expect(extended.nextAt).toBe(state.nextAt);
  vi.setSystemTime(extended.requestedUntil + 30 * 60_000);
  await f.t.mutation(internal.importUpload.cleanup, {});
  const stopped = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(stopped.nextAt).toBeUndefined();
  expect(stopped.lastSweptAt).toBe(extended.requestedUntil);
  await f.t.run((ctx) => requestCleanup(ctx, until));
  const rearmed = (await f.t.run((ctx) => ctx.db.get("importMaintenance", state._id)))!;
  expect(rearmed.nextAt).toBeGreaterThan(Date.now());
  expect(rearmed.requestedUntil).toBe(extended.requestedUntil);
});
it("token expirado não aceita bytes e reserva vencida remove upload não confirmado", async () => {
  const f = await fixture(),
    batch = await f.reserve();
  const response = await f.request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    ),
    ticket = (await response.json()).data;
  vi.setSystemTime(ticket.expiresAt);
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": ticket.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(409);
  expect((await f.upload(batch)).status).toBe(200);
  const file = (await f.t.run((ctx) => ctx.db.get("importFiles", batch.fileIds[0]!)))!;
  vi.setSystemTime(file.expiresAt);
  await f.t.mutation(internal.imports.expire, { importId: batch.importId });
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", file.storageId!))).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get("importFiles", file._id)))!.state).toBe("expired");
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
