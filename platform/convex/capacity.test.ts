import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { getDocumentSize } from "convex/values";
import schema from "./schema";
import { internal } from "./_generated/api";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import {
  reserveCapacity,
  commitCapacity,
  releaseCapacity,
  ensureCapacityReady,
  getCapacityUsage,
  trackStoredFile,
  releaseStoredFile,
  insertFiscal,
  patchFiscal,
  deleteFiscal,
  capacityTotal,
} from "./lib/capacityCore";
import { requireActivePlan } from "./lib/usageCore";
import { DOCUMENT_CONTENT_FORMAT, encodeDocumentContent } from "./lib/documentContent";
import { importTask } from "./lib/importValues";
import type { MutationCtx } from "./_generated/server";
import { modules } from "../../tests/helpers/convex-modules";

const defaults = { ...PLATFORM_PLANS.free.capacity };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
async function enable(ctx: MutationCtx) {
  await ctx.db.insert("platformPlanSettings", {
    key: "platform",
    enabled: true,
    version: 1,
    filesBytes: 1e12,
    databaseBytes: 1e12,
    custodyCents: 1e9,
    freeMonthlyCents: 1e9,
    allocatedFilesBytes: 0,
    allocatedDatabaseBytes: 0,
    allocatedCustodyCents: 0,
    allocatedFreeMonthlyCents: 0,
    admissionsUntil: Date.now() + 86400000,
    evidence: "synthetic-capacity-proof",
    updatedAt: Date.now(),
  });
}
async function fixture(capacity: Partial<typeof defaults> = {}) {
  const t = convexTest(schema, modules);
  const organizationId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Empresa fictícia",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ensureCapacityReady(ctx, id);
    await ctx.db.insert("usagePlans", {
      organizationId: id,
      catalogTier: "free",
      name: "Prova sintética",
      startsAt: 0,
      endsAt: null,
      limits: { imports: 100, captures: 100, registry: 100, bytes: 1e9, deliveries: 100 },
      capacity: { ...defaults, ...capacity },
      concurrency: 2,
      version: 1,
      updatedAt: Date.now(),
    });
    await enable(ctx);
    return id;
  });
  const { companyId, projectId } = await t.run(async (ctx) => {
    const companyId = await ctx.db.insert("companies", {
      organizationId,
      cnpj: "00000000000191",
      name: "Empresa sintética",
      kind: "demonstration",
      declaredBy: "proof",
      declaredAt: 0,
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade",
        state: "SP",
        postalCode: "01000000",
      },
      fieldSources: { name: "demonstration", address: "demonstration" },
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    const membership = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: "synthetic",
      name: "Prova",
      email: "proof@development.invalid",
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: 0,
      updatedAt: 0,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Prova",
      externalReference: "proof",
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: membership,
      creatorEpoch: 0,
      createdAt: 0,
    });
    return { companyId, projectId };
  });
  const total = (metric: Parameters<typeof capacityTotal>[2]) =>
    t.run((ctx) => capacityTotal(ctx, organizationId, metric, Date.now()));
  return { t, organizationId, companyId, projectId, total };
}
it("preserva ausência de plano com política desligada e exige plano finito quando ativada", async () => {
  const t = convexTest(schema, modules);
  const id = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Fictícia",
      slug: "ficticia",
      ownerCount: 1,
      memberCount: 1,
      createdAt: 0,
      updatedAt: 0,
    }),
  );
  expect(await t.run((ctx) => requireActivePlan(ctx, id))).toBeNull();
  await t.run(enable);
  await expect(t.run((ctx) => requireActivePlan(ctx, id))).rejects.toThrow("PLAN_REQUIRED");
  await expect(
    t.run((ctx) => reserveCapacity(ctx, id, "downloadsBytes", "download", 1)),
  ).rejects.toThrow("PLAN_REQUIRED");
});
it("reserva uma vez, mede bytes físicos do blob uma vez e libera só após exclusão", async () => {
  const f = await fixture({ filesBytes: 10 });
  await f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "filesBytes", "import:a", 10));
  await f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "filesBytes", "import:a", 10));
  expect(await f.total("filesBytes")).toMatchObject({ reserved: 10, committed: 0 });
  const blob = await f.t.run((ctx) => ctx.storage.store(new Blob(["123456"])));
  await f.t.run(async (ctx) => {
    await trackStoredFile(ctx, f.organizationId, blob, "import:a");
    await trackStoredFile(ctx, f.organizationId, blob, "import:a");
    await commitCapacity(ctx, f.organizationId, "filesBytes", "import:a", 0);
  });
  expect(await f.total("filesBytes")).toMatchObject({ reserved: 0, committed: 6 });
  await expect(f.t.run((ctx) => releaseStoredFile(ctx, f.organizationId, blob))).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  await f.t.run(async (ctx) => {
    await ctx.storage.delete(blob);
    await releaseStoredFile(ctx, f.organizationId, blob);
    await releaseStoredFile(ctx, f.organizationId, blob);
  });
  expect(await f.total("filesBytes")).toMatchObject({ reserved: 0, committed: 0 });
});
it("reservas concorrentes compartilham saldo e outra organização permanece isolada", async () => {
  const f = await fixture({ filesBytes: 10 });
  const results = await Promise.allSettled(
    ["a", "b"].map((key) =>
      f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "filesBytes", key, 6)),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const other = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Outra fictícia",
      slug: "outra",
      ownerCount: 1,
      memberCount: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    const plan = (await ctx.db.query("usagePlans").first())!;
    const { _id, _creationTime, ...fields } = plan;
    await ctx.db.insert("usagePlans", { ...fields, organizationId: id });
    await reserveCapacity(ctx, id, "filesBytes", "a", 10);
    return id;
  });
  expect(await f.total("filesBytes")).toMatchObject({ reserved: 6 });
  expect(await f.t.run((ctx) => capacityTotal(ctx, other, "filesBytes", Date.now()))).toMatchObject(
    { reserved: 10 },
  );
});
it("rejeição libera reserva uma vez, e devolução tardia não altera mês seguinte", async () => {
  const f = await fixture({ exportsCount: 2 });
  await f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "exportsCount", "old", 1));
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  await f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "exportsCount", "new", 1));
  await f.t.run(async (ctx) => {
    await releaseCapacity(ctx, f.organizationId, "exportsCount", "old");
    await releaseCapacity(ctx, f.organizationId, "exportsCount", "old");
  });
  expect(await f.total("exportsCount")).toMatchObject({ reserved: 1 });
});
it("inventário legado percorre páginas, soma ambientes e deduplica originais compartilhados", async () => {
  const f = await fixture({ filesBytes: 1000 });
  const blob = await f.t.run((ctx) =>
    ctx.storage.store(new Blob(["original de ambos os ambientes"])),
  );
  const size = new Blob(["original de ambos os ambientes"]).size;
  const productionBlob = await f.t.run((ctx) => ctx.storage.store(new Blob(["produção"])));
  const productionSize = new Blob(["produção"]).size;
  await f.t.run(async (ctx) => {
    const account = (await ctx.db.query("capacityAccounts").first())!;
    await ctx.db.delete("capacityAccounts", account._id);
    // Legacy artifacts, with synthetic foreign keys only used as selectors by this inventory.
    for (let n = 0; n < 60; n++) {
      await ctx.db.insert("documentArtifacts", {
        organizationId: f.organizationId,
        companyId: f.companyId,
        projectId: f.projectId,
        environment: n % 2 ? "sandbox" : "production",
        source: "imported-xml",
        storageId: n % 2 ? blob : productionBlob,
        size: n % 2 ? size : productionSize,
        sha256: "a".repeat(64),
        importedAt: 0,
      });
    }
    // A real legacy source proves this organization is not new.
    await ctx.db.insert("fiscalDocuments", {
      organizationId: f.organizationId,
      companyId: f.companyId,
      environment: "sandbox",
      model: "55",
      fiscalKey: "synthetic",
      completeness: 0,
      createdAt: 0,
    });
    expect(await ensureCapacityReady(ctx, f.organizationId)).toBe(false);
  });
  await expect(
    f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "filesBytes", "new", 1)),
  ).rejects.toThrow("CAPACITY_INVENTORY_REQUIRED");
  let pages = 0;
  while (
    !(await f.t.mutation(internal.capacity.inventory, { organizationId: f.organizationId })).ready
  ) {
    if (++pages > 30) throw new Error("Inventory did not terminate");
  }
  expect(pages).toBeGreaterThan(10);
  expect(await f.total("filesBytes")).toMatchObject({ committed: size + productionSize });
  expect((await f.t.run((ctx) => getCapacityUsage(ctx, f.organizationId))).ready).toBe(true);
});
it("inventário legado conta um arquivo de cada tabela, o blob de conteúdo pelo tamanho comprimido", async () => {
  const f = await fixture();
  const content = await encodeDocumentContent({
    result: JSON.stringify({ document: { total: "1234.56" }, filler: "x".repeat(4096) }),
    items: [],
  });
  expect(content.storedSize).toBeLessThan(content.contentSize);
  await f.t.run(async (ctx) => {
    const account = (await ctx.db.query("capacityAccounts").first())!;
    await ctx.db.delete("capacityAccounts", account._id);
    // One file per table, each of a distinct size, so the totals tell them apart.
    const store = (bytes: number) => ctx.storage.store(new Blob([new Uint8Array(bytes)]));
    const scope = {
      organizationId: f.organizationId,
      companyId: f.companyId,
      projectId: f.projectId,
      environment: "sandbox" as const,
    };
    const artifactId = await ctx.db.insert("documentArtifacts", {
      ...scope,
      source: "imported-xml",
      storageId: await store(1),
      size: 1,
      sha256: "a".repeat(64),
      importedAt: 0,
    });
    const importId = await ctx.db.insert("imports", {
      ...scope,
      key: "synthetic",
      requestHash: "synthetic",
      createdAt: 0,
    });
    await ctx.db.insert("importFiles", {
      importId,
      position: 0,
      name: "nota.xml",
      size: 10,
      sha256: "a".repeat(64),
      state: "accepted",
      expiresAt: 0,
      storageId: await store(10),
    });
    const operationId = await ctx.db.insert("operations", {
      ...scope,
      task: importTask,
      request: "{}",
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "succeeded",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 3,
      leaseUntil: 0,
      nextAttemptAt: 0,
      backoffMs: 1,
      jitterMs: 1,
      uncertain: false,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.insert("documentVersions", {
      artifactId,
      operationId,
      state: "complete",
      code: "IMPORTED",
      kind: "invoice",
      completeness: 1,
      schema: null,
      parserVersion: "synthetic",
      normalizerVersion: null,
      processorVersion: "synthetic",
      result: "{}",
      itemCount: 0,
      writtenItems: 0,
      createdAt: 0,
      contentStorageId: await ctx.storage.store(new Blob([Uint8Array.from(content.bytes)])),
      contentSha256: content.contentSha256,
      contentSize: content.contentSize,
      contentFormat: DOCUMENT_CONTENT_FORMAT,
    });
    const streamId = await ctx.db.insert("captureStreams", {
      ...scope,
      identity: "synthetic-capacity",
      service: "nfe-distribution",
      state: "paused",
      version: 1,
      checkpoint: "0",
      mode: "distNSU",
      nextAllowedAt: 0,
      received: 0,
      createdAt: 0,
    });
    await ctx.db.insert("captureBatches", {
      streamId,
      operationId,
      ownerVersion: 1,
      requestNsu: "0",
      mode: "distNSU",
      rawId: await store(100),
      rawHash: "synthetic",
      saved: 0,
      committed: true,
      createdAt: 0,
    });
    const issuanceId = await ctx.db.insert("issuances", {
      ...scope,
      operationId,
      state: "authorized",
      transport: "simulated",
      target: "sefin-nacional",
      series: "1",
      number: 1,
      dpsId: "DPS3550308211222333000181000010000000000000001",
      snapshot: "{}",
      snapshotSha256: "synthetic",
      submissions: 1,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.insert("issuanceArtifacts", {
      organizationId: f.organizationId,
      issuanceId,
      kind: "dps",
      storageId: await store(1000),
      sha256: "synthetic",
      size: 1000,
      signed: false,
      createdAt: 0,
    });
    const exportId = await ctx.db.insert("documentExports", {
      organizationId: f.organizationId,
      environment: "sandbox",
      selection: { kind: "organization" },
      actor: "synthetic",
      key: "synthetic",
      state: "succeeded",
      checkpoint: "0",
      sequence: 1,
      bytes: 10_000,
      createdAt: 0,
      expiresAt: Date.now() + 86_400_000,
    });
    await ctx.db.insert("exportParts", {
      exportId,
      sequence: 0,
      storageId: await store(10_000),
      sha256: "synthetic",
      size: 10_000,
    });
  });
  for (let pages = 0; ; pages++) {
    if (pages > 30) throw new Error("Inventory did not terminate");
    const { ready } = await f.t.mutation(internal.capacity.inventory, {
      organizationId: f.organizationId,
    });
    if (ready) break;
  }
  // Originals, the capture answer, the issuance artifact and the content blob as stored, never
  // its uncompressed size; the export part only as temporary.
  expect(await f.total("filesBytes")).toMatchObject({
    committed: 1 + 10 + 100 + 1000 + content.storedSize,
  });
  expect(await f.total("temporaryBytes")).toMatchObject({ committed: 10_000 });
  expect(await f.t.run(async (ctx) => (await ctx.db.query("capacityFiles").collect()).length)).toBe(
    6,
  );
});

it("mede registro Convex materializado, aplica deltas e preserva o registro ao recusar crescimento", async () => {
  const f = await fixture({ databaseBytes: 1000 });
  const value = {
    organizationId: f.organizationId,
    companyId: f.companyId,
    environment: "sandbox" as const,
    model: "55" as const,
    fiscalKey: "synthetic",
    completeness: 0,
    createdAt: 0,
  };
  const id = await f.t.run((ctx) => insertFiscal(ctx, "fiscalDocuments", value));
  const record = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", id)))!;
  expect(await f.total("databaseBytes")).toMatchObject({ committed: getDocumentSize(record) });
  await f.t.run((ctx) => patchFiscal(ctx, "fiscalDocuments", id, { fiscalKey: "synthetic" }));
  expect(await f.total("databaseBytes")).toMatchObject({ committed: getDocumentSize(record) });
  await expect(
    f.t.run((ctx) => patchFiscal(ctx, "fiscalDocuments", id, { fiscalKey: "a".repeat(2000) })),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", id))).toEqual(record);
  await f.t.run((ctx) => deleteFiscal(ctx, "fiscalDocuments", id));
  expect(await f.total("databaseBytes")).toMatchObject({ committed: 0 });
});

it("restauração reconcilia ponteiros omitidos e removidos e recalcula saldo antes de admitir", async () => {
  const f = await fixture();
  const original = await f.t.run((ctx) => ctx.storage.store(new Blob(["original preservado"])));
  const temporary = await f.t.run((ctx) => ctx.storage.store(new Blob(["temporário expirado"])));
  await f.t.run(async (ctx) => {
    await ctx.db.insert("documentArtifacts", {
      organizationId: f.organizationId,
      projectId: f.projectId,
      companyId: f.companyId,
      environment: "production",
      source: "imported-xml",
      storageId: original,
      sha256: "b".repeat(64),
      size: 19,
      importedAt: 0,
    });
    await trackStoredFile(ctx, f.organizationId, original);
    await trackStoredFile(ctx, f.organizationId, temporary);
    const pointer = (await ctx.db
      .query("capacityFiles")
      .withIndex("by_organizationId_and_storageId", (q) =>
        q.eq("organizationId", f.organizationId).eq("storageId", original),
      )
      .unique())!;
    await ctx.db.delete("capacityFiles", pointer._id);
    await ctx.storage.delete(temporary);
    await reserveCapacity(
      ctx,
      f.organizationId,
      "temporaryBytes",
      "export:omitted-temporary-job:0",
      100,
    );
    await reserveCapacity(ctx, f.organizationId, "exportsCount", "export:omitted-temporary-job", 1);
    const stale = await insertFiscal(ctx, "fiscalDocuments", {
      organizationId: f.organizationId,
      companyId: f.companyId,
      environment: "sandbox",
      model: "55",
      fiscalKey: "stale",
      completeness: 0,
      createdAt: 0,
    });
    await ctx.db.delete("fiscalDocuments", stale);
    const account = (await ctx.db.query("capacityAccounts").first())!;
    await ctx.db.patch("capacityAccounts", account._id, { ready: false, phase: 0, cursor: null });
  });
  let done = false;
  for (let page = 0; page < 40 && !done; page++)
    done = (await f.t.mutation(internal.capacity.inventory, { organizationId: f.organizationId }))
      .ready;
  expect(done).toBe(true);
  expect(await f.total("filesBytes")).toMatchObject({ committed: 19, reserved: 0 });
  const records = await f.t.run((ctx) => ctx.db.query("capacityRecords").collect());
  expect(records).toHaveLength(1);
  expect(await f.total("exportsCount")).toMatchObject({ reserved: 0 });
  expect(await f.total("temporaryBytes")).toMatchObject({ committed: 0, reserved: 0 });
  expect(await f.total("databaseBytes")).toMatchObject({
    committed: records[0]!.size,
    reserved: 0,
  });
});

it("arquivo frio bloqueia novas escritas e só restauração autoriza o inventário interno", async () => {
  const f = await fixture();
  const blob = await f.t.run((ctx) => ctx.storage.store(new Blob(["original preservado"])));
  const runId = await f.t.run(async (ctx) => {
    await ctx.db.insert("documentArtifacts", {
      organizationId: f.organizationId,
      projectId: f.projectId,
      companyId: f.companyId,
      environment: "sandbox",
      source: "imported-xml",
      storageId: blob,
      size: 19,
      sha256: "a".repeat(64),
      importedAt: 0,
    });
    const account = (await ctx.db.query("capacityAccounts").first())!;
    await ctx.db.patch("capacityAccounts", account._id, { ready: false, phase: 0, cursor: null });
    return ctx.db.insert("coldArchiveRuns", {
      organizationId: f.organizationId,
      key: "synthetic-cold",
      version: 1,
      state: "frozen",
      reason: "free_inactive",
      noticeAt: 0,
      eligibleAt: 0,
      retainUntil: Date.now() + 86400000,
      createdAt: 0,
      updatedAt: 0,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    });
  });
  await expect(
    f.t.run((ctx) => reserveCapacity(ctx, f.organizationId, "filesBytes", "new", 1)),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  await expect(f.t.run((ctx) => trackStoredFile(ctx, f.organizationId, blob))).rejects.toThrow(
    "ORGANIZATION_ARCHIVED",
  );
  await expect(
    f.t.mutation(internal.capacity.inventory, { organizationId: f.organizationId }),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", runId, { state: "restoring" }));
  let ready = false;
  for (let page = 0; page < 40 && !ready; page++)
    ready = (await f.t.mutation(internal.capacity.inventory, { organizationId: f.organizationId }))
      .ready;
  expect(ready).toBe(true);
  expect(await f.total("filesBytes")).toMatchObject({ committed: 19 });
  await expect(f.t.run((ctx) => trackStoredFile(ctx, f.organizationId, blob))).rejects.toThrow(
    "ORGANIZATION_ARCHIVED",
  );
});
