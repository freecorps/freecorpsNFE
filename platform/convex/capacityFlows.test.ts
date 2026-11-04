import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { capacityTotal, getCapacityUsage } from "./lib/capacityCore";
import { fixture, actor } from "../../tests/helpers/export-fixture";
import type { Doc } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { CAPTURE_RESERVED_BYTES } from "./captureProcessing";
import { createHash } from "node:crypto";

beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5201",
    CONVEX_SITE_URL: "http://127.0.0.1:3261",
    BETTER_AUTH_SECRET: "synthetic-capacity-flows",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function activate(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<NonNullable<Doc<"usagePlans">["capacity"]>> = {},
) {
  return f.t.run(async (ctx) => {
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
      evidence: "synthetic-capacity-flows",
      updatedAt: Date.now(),
    });
    return ctx.db.insert("usagePlans", {
      organizationId: f.scope.organizationId,
      catalogTier: "free",
      name: "Prova",
      startsAt: 0,
      endsAt: null,
      limits: PLATFORM_PLANS.free.limits,
      concurrency: 1,
      capacity: { ...PLATFORM_PLANS.free.capacity, ...overrides },
      version: 1,
      updatedAt: Date.now(),
    });
  });
}

it("download REST e console debita cada transferência no mesmo saldo, antes de entregar bytes", async () => {
  const f = await fixture();
  const person = await actor(f);
  const artifact = (await f.t.run((ctx) =>
    ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first(),
  ))!;
  const ticket = await person.client.mutation(api.documentDownloads.ticket, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    artifactId: artifact._id,
  });
  await activate(f, { downloadsBytes: f.bytes.length * 2 });
  const path = `/v1/document-artifacts/${artifact._id}/original?companyId=${f.scope.companyId}`;
  const rest = await f.request(path);
  expect(rest.status).toBe(200);
  expect(new Uint8Array(await rest.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
  const consoleDownload = await f.t.fetch("/v1/document-download", {
    headers: { Origin: "http://localhost:5201", "X-Download-Token": ticket.token },
  });
  expect(consoleDownload.status).toBe(200);
  expect(new Uint8Array(await consoleDownload.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
  const refused = await f.request(path);
  expect(refused.status).toBe(429);
  expect((await refused.json()).error.code).toBe("RATE_LIMITED");
  expect(
    await f.t.run((ctx) =>
      capacityTotal(ctx, f.scope.organizationId, "downloadsBytes", Date.now()),
    ),
  ).toMatchObject({ committed: f.bytes.length * 2, reserved: 0 });
});

it("exportação reserva antes da geração, confirma tamanho real e expiração libera só arquivo temporário", async () => {
  const f = await fixture();
  const before = (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals
    .filesBytes!.committed;
  // The original stock is completely full; the export has a separate temporary allowance.
  await activate(f, { exportsCount: 1, filesBytes: before });
  const job = await f.create();
  expect((await f.create()).id).toBe(job.id);
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const part = (await f.t.run((ctx) =>
    ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
      .first(),
  ))!;
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "exportsCount", Date.now())),
  ).toMatchObject({ committed: 1, reserved: 0 });
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "exportsBytes", Date.now())),
  ).toMatchObject({ committed: part.size, reserved: 0 });
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "filesBytes", Date.now())),
  ).toMatchObject({ committed: before, reserved: 0 });
  expect(
    await f.t.run((ctx) =>
      capacityTotal(ctx, f.scope.organizationId, "temporaryBytes", Date.now()),
    ),
  ).toMatchObject({ committed: part.size, reserved: 0 });
  const denied = await f.request(
    "/v1/exports",
    "POST",
    { companyId: f.scope.companyId, documentId: f.documentId },
    "second-export",
  );
  expect(denied.status).toBe(429);
  const token = await f.ticket(part._id);
  expect((await f.download(token)).status).toBe(200);
  expect(
    await f.t.run((ctx) =>
      capacityTotal(ctx, f.scope.organizationId, "downloadsBytes", Date.now()),
    ),
  ).toMatchObject({ committed: part.size });
  vi.setSystemTime(Date.now() + 86400001);
  await f.t.mutation(internal.exports.expire, { exportId: job.id });
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "filesBytes", Date.now())),
  ).toMatchObject({ committed: before, reserved: 0 });
  expect(
    await f.t.run((ctx) =>
      capacityTotal(ctx, f.scope.organizationId, "temporaryBytes", Date.now()),
    ),
  ).toMatchObject({ committed: 0, reserved: 0 });
});

it("limite de geração recusa antes de criar partes e não apaga o original aceito", async () => {
  const f = await fixture();
  await activate(f, { exportsBytes: 1 });
  const job = await f.create();
  const before = (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals
    .filesBytes;
  await expect(
    f.t.action(internal.exportWorker.run, { exportId: job.id, sequence: 0 }),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  expect(await f.t.run((ctx) => ctx.db.query("exportParts").collect())).toHaveLength(0);
  expect(
    (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals.filesBytes,
  ).toEqual(before);
  const original = (await f.t.run((ctx) => ctx.db.query("documentArtifacts").first()))!;
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", original.storageId!))).not.toBeNull();
});

it("com a política ligada, admissões simultâneas reservam estoque na admissão e param no limite (#559)", async () => {
  const f = await fixture();
  const before = (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals
    .filesBytes!.committed;
  await activate(f, { filesBytes: before + 30 });
  const body = {
    companyId: f.scope.companyId,
    files: [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }],
  };
  const statuses = await Promise.all(
    Array.from(
      { length: 8 },
      async (_, i) => (await f.request("/v1/imports", "POST", body, `gated-${i}`)).status,
    ),
  );
  expect(statuses.filter((s) => s === 200)).toHaveLength(3);
  expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "filesBytes", Date.now())),
  ).toMatchObject({ committed: before, reserved: 30 });
});
it("cancelamento de upload libera reserva para outro pedido e duplica intent sem duplicar estoque", async () => {
  const f = await fixture();
  const before = (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals
    .filesBytes!.committed;
  await activate(f, { filesBytes: before + 10 });
  const body = {
    companyId: f.scope.companyId,
    files: [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }],
  };
  const first = await f.request("/v1/imports", "POST", body, "new-upload");
  expect(first.status).toBe(200);
  const batch = (await first.json()).data;
  expect(
    (await (await f.request("/v1/imports", "POST", body, "new-upload")).json()).data.reused,
  ).toBe(true);
  expect((await f.request("/v1/imports", "POST", body, "overflow-upload")).status).toBe(429);
  // Expiry uses the same domain release as console cancellation, including upload bytes.
  vi.setSystemTime(Date.now() + 86400001);
  await f.t.mutation(internal.imports.expire, { importId: batch.importId });
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "filesBytes", Date.now())),
  ).toMatchObject({ committed: before, reserved: 0 });
});

async function captureClaim(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "connections:write"] as const;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...scopes] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", company._id),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    await ctx.db.patch("companies", company._id, { kind: "declared" });
    const certificate = await ctx.db.insert("certificates", {
      organizationId: f.scope.organizationId,
      companyId: company._id,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "synthetic",
        subject: "test",
        cnpj: company.cnpj,
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 86400000,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: f.scope.organizationId,
      companyId: company._id,
      nextVersion: 2,
      activeId: certificate,
      latestId: certificate,
    });
  });
  const view = JSON.parse(
    await f.t.mutation(internal.captureRest.dispatch, {
      keyHash: await hashApiKey(`fnfe_${"a".repeat(43)}`),
      environment: "sandbox",
      companyId: f.scope.companyId,
      action: "activate",
    }),
  ) as { operationId: Doc<"operations">["_id"]; id: Doc<"captureStreams">["_id"] };
  const operation = (await f.t.run((ctx) => ctx.db.get("operations", view.operationId)))!;
  const claimed = (await f.t.mutation(internal.operations.claim, {
    operationId: operation._id,
    generation: operation.generation,
  }))!;
  const claim = {
    operationId: operation._id,
    generation: claimed.generation,
    fence: claimed.fence,
  };
  await f.t.mutation(internal.operations.beginEffect, claim);
  return { claim, streamId: view.id };
}

it("captura exige os 18 MiB antes da janela fiscal e recusa sem criar incerteza", async () => {
  const f = await fixture();
  const before = (await f.t.run((ctx) => getCapacityUsage(ctx, f.scope.organizationId))).totals
    .filesBytes!.committed;
  await activate(f, { filesBytes: before + CAPTURE_RESERVED_BYTES - 1 });
  const { claim, streamId } = await captureClaim(f);
  const stream = (await f.t.run((ctx) => ctx.db.get("captureStreams", streamId)))!;
  expect(await f.t.mutation(internal.captureProcessing.prepare, claim)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get("operations", claim.operationId))).toMatchObject({
    state: "paused",
    code: "QUOTA_EXCEEDED",
    uncertain: false,
  });
  expect((await f.t.run((ctx) => ctx.db.get("captureStreams", streamId)))!.nextAllowedAt).toBe(
    stream.nextAllowedAt,
  );
  expect(
    await f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, "filesBytes", Date.now())),
  ).toMatchObject({ committed: before, reserved: 0 });
});

it("resposta fiscal admitida permanece durável se o limite mudar durante o transporte", async () => {
  const f = await fixture();
  const planId = await activate(f);
  const { claim } = await captureClaim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, claim))!;
  expect(input).not.toBeNull();
  const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob(["resposta fiscal sintética"])));
  await f.t.run(async (ctx) => {
    const plan = (await ctx.db.get("usagePlans", planId))!;
    await ctx.db.patch("usagePlans", planId, {
      capacity: { ...plan.capacity!, filesBytes: 0, databaseBytes: 0 },
    });
  });
  const batchId = await f.t.mutation(internal.captureProcessing.raw, {
    ...claim,
    rawId,
    rawHash: "a".repeat(64),
    nsu: input.nsu,
    mode: input.mode,
  });
  expect(batchId).not.toBeNull();
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", rawId))).not.toBeNull();
  expect((await f.t.run((ctx) => ctx.db.query("captureBatches").first()))!.rawId).toBe(rawId);
});

it("importação admitida antes do vencimento conclui versões e itens após a virada do mês", async () => {
  vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
  const f = await fixture();
  const planId = await activate(f);
  await f.t.run((ctx) =>
    ctx.db.patch("usagePlans", planId, { endsAt: Date.parse("2026-11-01T00:00:00Z") }),
  );
  const reserved = await f.request(
    "/v1/imports",
    "POST",
    {
      companyId: f.scope.companyId,
      files: [
        {
          name: "reenvio.xml",
          size: f.bytes.length,
          sha256: createHash("sha256").update(f.bytes).digest("hex"),
        },
      ],
    },
    "month-crossing",
  );
  expect(reserved.status).toBe(200);
  const batch = (await reserved.json()).data;
  const upload = (
    await (
      await f.request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`, "POST")
    ).json()
  ).data;
  expect(
    (
      await f.t.fetch("/v1/import-upload", {
        method: "POST",
        headers: { "X-Upload-Token": upload.token },
        body: new Uint8Array(f.bytes),
      })
    ).status,
  ).toBe(200);
  const confirmed = (
    await (
      await f.request(`/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`, "POST")
    ).json()
  ).data;
  vi.setSystemTime(new Date("2026-11-01T00:00:01Z"));
  await f.t.action(internal.operationWorker.run, {
    operationId: confirmed.operationId,
    generation: 1,
  });
  expect(await f.t.run((ctx) => ctx.db.get("operations", confirmed.operationId))).toMatchObject({
    state: "succeeded",
  });
  const version = (await f.t.run((ctx) =>
    ctx.db
      .query("documentVersions")
      .withIndex("by_operationId", (q) => q.eq("operationId", confirmed.operationId))
      .first(),
  ))!;
  expect(version.state).toBe("complete");
  expect(version.writtenItems).toBe(version.itemCount);
  expect(version.itemCount).toBeGreaterThan(0);
});
