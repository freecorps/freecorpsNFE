import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { CAPTURE_RESERVED_BYTES } from "./captureProcessing";
import { hashApiKey } from "./lib/apiKeyCrypto";
import {
  capacityEvent,
  capacityTotal,
  checkCapacity,
  commitCapacity,
  reserveCapacity,
} from "./lib/capacityCore";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { actor, fixture } from "../../tests/helpers/export-fixture";
import { usePlatformEnvironment } from "../../tests/helpers/platform";

const NOW = Date.UTC(2026, 9, 27, 12);
const DAY = 86_400_000;
const ORIGIN = "http://localhost:5201";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Capacity = NonNullable<Doc<"usagePlans">["capacity"]>;
type Metric = Parameters<typeof capacityTotal>[2];
const accessMetrics = [
  "restReads",
  "downloadsBytes",
  "exportsCount",
  "exportsBytes",
  "temporaryBytes",
] as const;
usePlatformEnvironment({
  siteUrl: ORIGIN,
  convexSiteUrl: "http://127.0.0.1:3261",
  secret: "synthetic-capacity-regression",
  now: NOW,
});

async function activate(f: Fixture, overrides: Partial<Capacity> = {}, expired = true) {
  await f.t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 20 * 2 ** 30,
    databaseBytes: 2 * 2 ** 30,
    custodyCents: 100_000,
    freeMonthlyCents: 10_000,
    admissionsUntil: NOW + DAY,
    evidence: "synthetic-capacity-regression",
  });
  return f.t.run((ctx) =>
    ctx.db.insert("usagePlans", {
      organizationId: f.scope.organizationId,
      catalogTier: "intermediate",
      name: "Plano sintético",
      startsAt: NOW - DAY,
      endsAt: expired ? NOW - 1 : NOW + 60 * DAY,
      limits: { ...PLATFORM_PLANS.intermediate.limits },
      capacity: { ...PLATFORM_PLANS.intermediate.capacity, ...overrides },
      concurrency: 2,
      version: 1,
      updatedAt: NOW,
    }),
  );
}

function total(f: Fixture, metric: Metric) {
  return f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, metric, Date.now()));
}

async function original(f: Fixture) {
  return f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const blob = (await ctx.storage.get(artifact.storageId!))!;
    return {
      artifact,
      hash: createHash("sha256")
        .update(new Uint8Array(await blob.arrayBuffer()))
        .digest("hex"),
    };
  });
}

async function freeze(f: Fixture) {
  await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId: f.scope.organizationId,
      key: "synthetic-capacity-cold",
      version: 1,
      state: "frozen",
      reason: "paid_expired",
      noticeAt: NOW - 40 * DAY,
      eligibleAt: NOW - DAY,
      retainUntil: NOW + 365 * DAY,
      createdAt: NOW - 40 * DAY,
      updatedAt: NOW,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    }),
  );
}

describe("acesso ao acervo após o vencimento", () => {
  it.each(accessMetrics)(
    "permite %s até o limite e mantém a recusa atômica ao excedê-lo",
    async (metric) => {
      const f = await fixture();
      const field = metric === "temporaryBytes" ? "exportsBytes" : metric;
      await activate(f, { [field]: 10 });
      await f.t.run(async (ctx) => {
        await reserveCapacity(ctx, f.scope.organizationId, metric, "existing-access", 10);
        await commitCapacity(ctx, f.scope.organizationId, metric, "existing-access");
      });
      const before = await total(f, metric);
      expect(before).toMatchObject({ committed: 10, reserved: 0 });
      await expect(
        f.t.run((ctx) =>
          reserveCapacity(ctx, f.scope.organizationId, metric, "overflow-access", 1),
        ),
      ).rejects.toThrow("QUOTA_EXCEEDED");
      expect(await total(f, metric)).toEqual(before);
      expect(
        await f.t.run((ctx) =>
          capacityEvent(ctx, f.scope.organizationId, metric, "overflow-access"),
        ),
      ).toBeNull();
    },
  );

  it.each(accessMetrics)(
    "continua exigindo plano e respeitando arquivo frio para %s",
    async (metric) => {
      const f = await fixture();
      const planId = await activate(f);
      const plan = (await f.t.run((ctx) => ctx.db.get("usagePlans", planId)))!;
      await f.t.run((ctx) => ctx.db.delete("usagePlans", planId));
      await expect(
        f.t.run((ctx) => checkCapacity(ctx, f.scope.organizationId, metric, 1)),
      ).rejects.toThrow("PLAN_REQUIRED");
      await f.t.run((ctx) => {
        const { _id, _creationTime, ...fields } = plan;
        return ctx.db.insert("usagePlans", fields);
      });
      await freeze(f);
      await expect(
        f.t.run((ctx) => checkCapacity(ctx, f.scope.organizationId, metric, 1)),
      ).rejects.toThrow("ORGANIZATION_ARCHIVED");
    },
  );

  it("serve documento pela REST após vencer e continua cobrando cada leitura", async () => {
    const f = await fixture();
    await activate(f, { restReads: 1 });
    const path = `/v1/documents/${f.documentId}?companyId=${f.scope.companyId}`;
    const read = await f.request(path);
    expect(read.status).toBe(200);
    expect((await read.json()).data).toBeTruthy();
    const denied = await f.request(path);
    expect(denied.status).toBe(429);
    expect((await denied.json()).error.code).toBe("RATE_LIMITED");
    expect(await total(f, "restReads")).toMatchObject({ committed: 1, reserved: 0 });
  });

  it("baixa o mesmo original pela REST e pelo console vencidos, sem ultrapassar a cota de saída", async () => {
    const f = await fixture();
    const before = await original(f);
    const human = await actor(f);
    await activate(f, { downloadsBytes: f.bytes.length * 2 });
    const ticket = await human.client.mutation(api.documentDownloads.ticket, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      artifactId: before.artifact._id,
    });
    const path = `/v1/document-artifacts/${before.artifact._id}/original?companyId=${f.scope.companyId}`;
    const rest = await f.request(path);
    const consoleDownload = await f.t.fetch("/v1/document-download", {
      headers: { Origin: ORIGIN, "X-Download-Token": ticket.token },
    });
    for (const response of [rest, consoleDownload]) {
      expect(response.status).toBe(200);
      expect(
        createHash("sha256")
          .update(new Uint8Array(await response.arrayBuffer()))
          .digest("hex"),
      ).toBe(before.hash);
    }
    const denied = await f.request(path);
    expect(denied.status).toBe(429);
    expect((await denied.json()).error.code).toBe("RATE_LIMITED");
    expect(await total(f, "downloadsBytes")).toMatchObject({
      committed: 2 * f.bytes.length,
      reserved: 0,
    });
    expect(await original(f)).toEqual(before);
  });

  it.each([false, true])(
    "gera exportação vencida, baixa e limpa só o temporário; encerramento=%s",
    async (closing) => {
      const f = await fixture();
      const human = await actor(f);
      const before = await original(f);
      const stock = await total(f, "filesBytes");
      await activate(f, { exportsCount: 1 });
      if (closing)
        await f.t.run((ctx) =>
          ctx.db.insert("organizationClosures", {
            organizationId: f.scope.organizationId,
            state: "closing",
            requestedAt: NOW,
            exportUntil: NOW + 30 * DAY,
            purgeBy: NOW + 37 * DAY,
            generation: 1,
          }),
        );
      const args = {
        organizationId: f.scope.organizationId,
        selection: { kind: "organization" as const },
        key: "expired-console-export",
      };
      const job = await human.client.mutation(api.exports.create, args);
      expect((await human.client.mutation(api.exports.create, args)).id).toBe(job.id);
      expect((await f.finish(job.id)).state).toBe("succeeded");
      const part = (await f.t.run((ctx) =>
        ctx.db
          .query("exportParts")
          .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
          .first(),
      ))!;
      expect(part.size).toBeGreaterThan(0);
      expect(await total(f, "exportsCount")).toMatchObject({ committed: 1, reserved: 0 });
      expect(await total(f, "exportsBytes")).toMatchObject({ committed: part.size, reserved: 0 });
      expect(await total(f, "temporaryBytes")).toMatchObject({ committed: part.size, reserved: 0 });
      expect(await total(f, "filesBytes")).toEqual(stock);
      await expect(
        human.client.mutation(api.exports.create, { ...args, key: "second-expired-export" }),
      ).rejects.toThrow("QUOTA_EXCEEDED");
      expect(await f.t.run((ctx) => ctx.db.query("documentExports").collect())).toHaveLength(1);
      const ticket = await human.client.mutation(api.exportDownloads.ticket, { partId: part._id });
      const download = await f.t.fetch("/v1/export-download", {
        headers: { Origin: ORIGIN, "X-Download-Token": ticket.token },
      });
      expect(download.status).toBe(200);
      expect((await download.arrayBuffer()).byteLength).toBe(part.size);
      expect(await total(f, "downloadsBytes")).toMatchObject({ committed: part.size, reserved: 0 });
      vi.setSystemTime(NOW + DAY + 1);
      await f.t.mutation(internal.exports.expire, { exportId: job.id });
      expect(await total(f, "temporaryBytes")).toMatchObject({ committed: 0, reserved: 0 });
      expect(await f.t.run((ctx) => ctx.storage.get(part.storageId))).toBeNull();
      expect(await original(f)).toEqual(before);
    },
  );

  it("encerra a exceção de exportação no fim da janela de fechamento", async () => {
    const f = await fixture();
    const human = await actor(f);
    await activate(f);
    await f.t.run((ctx) =>
      ctx.db.insert("organizationClosures", {
        organizationId: f.scope.organizationId,
        state: "closing",
        requestedAt: NOW - 30 * DAY,
        exportUntil: NOW,
        purgeBy: NOW + 7 * DAY,
        generation: 1,
      }),
    );
    await expect(
      human.client.mutation(api.exports.create, {
        organizationId: f.scope.organizationId,
        selection: { kind: "organization" },
        key: "closed-window",
      }),
    ).rejects.toThrow("ORGANIZATION_CLOSED");
    expect(await f.t.run((ctx) => ctx.db.query("documentExports").collect())).toEqual([]);
  });

  it("o arquivo frio continua recusando exportação e ticket emitido antes do congelamento", async () => {
    const f = await fixture();
    const human = await actor(f);
    await activate(f);
    const before = await original(f);
    const ticket = await human.client.mutation(api.documentDownloads.ticket, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      artifactId: before.artifact._id,
    });
    await freeze(f);
    await expect(
      human.client.mutation(api.exports.create, {
        organizationId: f.scope.organizationId,
        selection: { kind: "organization" },
        key: "cold-export",
      }),
    ).rejects.toThrow("ORGANIZATION_ARCHIVED");
    const denied = await f.t.fetch("/v1/document-download", {
      headers: { Origin: ORIGIN, "X-Download-Token": ticket.token },
    });
    // ADR 0009, §3: the archive has its own public answer, no longer SCOPE_DENIED.
    expect(denied.status).toBe(409);
    expect((await denied.json()).error.code).toBe("ORGANIZATION_ARCHIVED");
    expect(await original(f)).toEqual(before);
    expect(await total(f, "downloadsBytes")).toBeNull();
  });

  it("novas importações continuam recusadas sem criar lote ou consumir estoque", async () => {
    const f = await fixture();
    await activate(f);
    const before = await f.t.run(async (ctx) => ({
      imports: await ctx.db.query("imports").collect(),
      files: await ctx.db.query("importFiles").collect(),
      stock: await capacityTotal(ctx, f.scope.organizationId, "filesBytes", NOW),
    }));
    const denied = await f.request(
      "/v1/imports",
      "POST",
      {
        companyId: f.scope.companyId,
        files: [{ name: "nova.xml", size: 10, sha256: "a".repeat(64) }],
      },
      "expired-import",
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("SCOPE_DENIED");
    expect(
      await f.t.run(async (ctx) => ({
        imports: await ctx.db.query("imports").collect(),
        files: await ctx.db.query("importFiles").collect(),
        stock: await capacityTotal(ctx, f.scope.organizationId, "filesBytes", NOW),
      })),
    ).toEqual(before);
  });
});

async function captureClaim(f: Fixture) {
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
    const certificateId = await ctx.db.insert("certificates", {
      organizationId: f.scope.organizationId,
      companyId: company._id,
      version: 1,
      state: "active",
      uploaderId: "synthetic-regression",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "synthetic",
        subject: "test",
        cnpj: company.cnpj,
        notBefore: NOW - DAY,
        notAfter: NOW + 60 * DAY,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: f.scope.organizationId,
      companyId: company._id,
      nextVersion: 2,
      activeId: certificateId,
      latestId: certificateId,
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
  expect(await f.t.mutation(internal.operations.beginEffect, claim)).toBe(true);
  return { claim, streamId: view.id };
}

async function captureFixture(withRaw: boolean) {
  const f = await fixture();
  const before = (await total(f, "filesBytes"))!.committed;
  await activate(f, { filesBytes: before + CAPTURE_RESERVED_BYTES }, false);
  const { claim } = await captureClaim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, claim))!;
  expect(input).not.toBeNull();
  const blob = new Blob(["resposta inválida sintética"]);
  const rawId = withRaw ? await f.t.run((ctx) => ctx.storage.store(blob)) : null;
  if (rawId)
    await f.t.mutation(internal.captureProcessing.raw, {
      ...claim,
      rawId,
      rawHash: "a".repeat(64),
      nsu: input.nsu,
      mode: input.mode,
    });
  const operation = (await f.t.run((ctx) => ctx.db.get("operations", claim.operationId)))!;
  expect(operation.usageCaptureKey).toBeTruthy();
  const key = `capture:${operation.usageCaptureKey}`;
  const rawBytes = withRaw ? blob.size : 0;
  expect(await total(f, "filesBytes")).toMatchObject({
    committed: before + rawBytes,
    reserved: CAPTURE_RESERVED_BYTES - rawBytes,
  });
  return { ...f, claim, key, rawId, rawBytes, before, rawText: await blob.text() };
}

describe("reserva da captura após resposta definitiva ou incerta", () => {
  it("vencimento anterior ao preparo recusa nova captura sem reservar janela nem bytes", async () => {
    const f = await fixture();
    const planId = await activate(f, {}, false);
    const { claim, streamId } = await captureClaim(f);
    const stream = (await f.t.run((ctx) => ctx.db.get("captureStreams", streamId)))!;
    const before = await total(f, "filesBytes");
    await f.t.run((ctx) => ctx.db.patch("usagePlans", planId, { endsAt: NOW - 1 }));
    expect(await f.t.mutation(internal.captureProcessing.prepare, claim)).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.get("operations", claim.operationId))).toMatchObject({
      state: "paused",
      code: "PLAN_INACTIVE",
      uncertain: false,
    });
    expect((await f.t.run((ctx) => ctx.db.get("captureStreams", streamId)))!.nextAllowedAt).toBe(
      stream.nextAllowedAt,
    );
    expect(await total(f, "filesBytes")).toEqual(before);
  });

  it.each([false, true])(
    "falha definitiva libera somente reserva remanescente, com raw=%s",
    async (withRaw) => {
      const f = await captureFixture(withRaw);
      const originalBefore = await original(f);
      await f.t.mutation(internal.captureProcessing.failed, {
        ...f.claim,
        code: "SOURCE_RESPONSE_INVALID",
      });
      const args = {
        ...f.claim,
        outcome: { kind: "definitive" as const, code: "SOURCE_RESPONSE_INVALID" },
      };
      expect(await f.t.mutation(internal.operations.recordOutcome, args)).toBe(false);
      expect(await f.t.run((ctx) => ctx.db.get("operations", f.claim.operationId))).toMatchObject({
        state: "failed",
        uncertain: false,
        code: "SOURCE_RESPONSE_INVALID",
      });
      expect(await total(f, "filesBytes")).toMatchObject({
        committed: f.before + f.rawBytes,
        reserved: 0,
      });
      const event = await f.t.run((ctx) =>
        capacityEvent(ctx, f.scope.organizationId, "filesBytes", f.key),
      );
      expect(event).toMatchObject({
        state: "committed",
        remaining: 0,
        quantity: CAPTURE_RESERVED_BYTES,
      });
      const after = await total(f, "filesBytes");
      await f.t.mutation(internal.operations.recordOutcome, args);
      expect(await total(f, "filesBytes")).toEqual(after);
      expect(
        await f.t.run((ctx) => capacityEvent(ctx, f.scope.organizationId, "filesBytes", f.key)),
      ).toEqual(event);
      if (f.rawId) {
        expect(await f.t.run(async (ctx) => (await ctx.storage.get(f.rawId!))?.text())).toBe(
          f.rawText,
        );
        expect(
          await f.t.run((ctx) =>
            ctx.db
              .query("captureBatches")
              .withIndex("by_operationId", (q) => q.eq("operationId", f.claim.operationId))
              .unique(),
          ),
        ).toMatchObject({ rawId: f.rawId });
      }
      expect(await original(f)).toEqual(originalBefore);
      await f.t.run((ctx) =>
        reserveCapacity(
          ctx,
          f.scope.organizationId,
          "filesBytes",
          "next-import",
          CAPTURE_RESERVED_BYTES - f.rawBytes,
        ),
      );
      expect(await total(f, "filesBytes")).toMatchObject({
        committed: f.before + f.rawBytes,
        reserved: CAPTURE_RESERVED_BYTES - f.rawBytes,
      });
      await expect(
        f.t.run((ctx) => checkCapacity(ctx, f.scope.organizationId, "filesBytes", 1)),
      ).rejects.toThrow("QUOTA_EXCEEDED");
    },
  );

  it.each([false, true])(
    "incerteza mantém a reserva inclusive no mês seguinte, com raw=%s",
    async (withRaw) => {
      const f = await captureFixture(withRaw);
      const before = await total(f, "filesBytes");
      await f.t.mutation(internal.operations.recordOutcome, {
        ...f.claim,
        outcome: { kind: "uncertain", code: "SOURCE_TIMEOUT" },
      });
      expect(await f.t.run((ctx) => ctx.db.get("operations", f.claim.operationId))).toMatchObject({
        state: "reconciling",
        uncertain: true,
      });
      expect(await total(f, "filesBytes")).toEqual(before);
      expect(
        await f.t.run((ctx) => capacityEvent(ctx, f.scope.organizationId, "filesBytes", f.key)),
      ).toMatchObject({ state: "reserved", remaining: CAPTURE_RESERVED_BYTES - f.rawBytes });
      vi.setSystemTime(NOW + 32 * DAY);
      expect(await total(f, "filesBytes")).toEqual(before);
      await expect(
        f.t.run((ctx) => checkCapacity(ctx, f.scope.organizationId, "filesBytes", 1)),
      ).rejects.toThrow("QUOTA_EXCEEDED");
      if (f.rawId)
        expect(await f.t.run(async (ctx) => (await ctx.storage.get(f.rawId!))?.text())).toBe(
          f.rawText,
        );
    },
  );
});
