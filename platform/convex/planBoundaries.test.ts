import { describe, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { capacityEvent, capacityTotal } from "./lib/capacityCore";
import type { IssuanceInput } from "./lib/issuanceValues";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { consoleProjectFor } from "../../tests/helpers/console";
import {
  ISSUANCE_SCOPES,
  issuerScope,
  nfseProfile,
  person,
  platformTest,
  syntheticApiKey,
  usePlatformEnvironment,
  type PlatformTest,
} from "../../tests/helpers/platform";

const NOW = Date.UTC(2026, 9, 8, 15);
const MiB = 2 ** 20;
const ISSUANCE_BYTES = 18 * MiB;
const CANCELLATION_BYTES = 16 * MiB;

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-plan-boundaries",
  now: NOW,
});

const domestic = (description = "Licença de software sintética"): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issuerEmail: "fiscal@prestador.example",
  market: "domestic",
  taker: {
    kind: "national",
    document: "11.444.777/0001-61",
    name: "Tomador Sintético Ltda",
    address: {
      municipalityCode: "3550308",
      postalCode: "01001-000",
      street: "Praça da Sé",
      number: "100",
      district: "Sé",
    },
  },
  description,
  amount: { currency: "BRL", value: "1000.00" },
  issRate: "2.5",
  issWithheld: false,
});

async function fixture(
  options: {
    capacity?: Partial<NonNullable<Doc<"usagePlans">["capacity"]>>;
    endsAt?: number;
    noPlan?: boolean;
  } = {},
  t = platformTest(),
) {
  const key = syntheticApiKey();
  const keyHash = await hashApiKey(key);
  const scope = await issuerScope(t, {
    keyHash,
    kind: "declared",
    grantScopes: [...ISSUANCE_SCOPES, "documents:read", "companies:read"],
    keyScopes: [...ISSUANCE_SCOPES, "documents:read", "companies:read"],
  });
  await nfseProfile(t, scope);
  const owner = await person(t, scope.organizationId, "owner");
  const where = {
    organizationId: scope.organizationId,
    projectId: await consoleProjectFor(t, scope.organizationId),
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  const planId = await t.run(async (ctx) => {
    if (!(await ctx.db.query("platformPlanSettings").unique())) {
      await ctx.db.insert("platformPlanSettings", {
        key: "platform",
        enabled: true,
        version: 1,
        filesBytes: 10 * 2 ** 30,
        databaseBytes: 2 ** 30,
        custodyCents: 100_000,
        freeMonthlyCents: 10_000,
        allocatedFilesBytes: 0,
        allocatedDatabaseBytes: 0,
        allocatedCustodyCents: 0,
        allocatedFreeMonthlyCents: 0,
        admissionsUntil: NOW + 86_400_000,
        evidence: "synthetic-plan-boundaries",
        updatedAt: NOW,
      });
    }
    await ctx.db.insert("capacityAccounts", {
      organizationId: scope.organizationId,
      ready: true,
      phase: 0,
      cursor: null,
      updatedAt: NOW,
    });
    if (options.noPlan) return null;
    return ctx.db.insert("usagePlans", {
      organizationId: scope.organizationId,
      catalogTier: "free",
      name: "Plano sintético finito",
      startsAt: NOW - 1,
      endsAt: options.endsAt ?? null,
      limits: PLATFORM_PLANS.free.limits,
      concurrency: 1,
      capacity: { ...PLATFORM_PLANS.free.capacity, ...options.capacity },
      version: 1,
      updatedAt: NOW,
    });
  });
  return { t, scope, owner, where, key, keyHash, planId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const request = (f: Fixture, idempotencyKey: string, input = domestic()) =>
  f.owner.mutation(internal.issuance.request, { ...f.where, idempotencyKey, input });
const view = (f: Fixture, issuanceId: Id<"issuances">) =>
  f.owner.query(internal.issuance.get, { ...f.where, issuanceId });
const total = (f: Fixture, metric: "filesBytes" | "restReads" = "filesBytes") =>
  f.t.run((ctx) => capacityTotal(ctx, f.scope.organizationId, metric, Date.now()));
const reservation = (f: Fixture, operationId: Id<"operations">) =>
  f.t.run((ctx) =>
    capacityEvent(ctx, f.scope.organizationId, "filesBytes", `issuance:${operationId}`),
  );
const get = (f: Fixture, path = "/v1/companies") =>
  f.t.fetch(path, {
    headers: { Authorization: `Bearer ${f.key}`, "X-Environment": "sandbox" },
  });

async function drive(f: Fixture, operationId: Id<"operations">) {
  const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  await f.t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  return (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
}

async function fiscalState(t: PlatformTest) {
  return t.run(async (ctx) => ({
    sequences: await ctx.db.query("dpsSequences").collect(),
    operations: await ctx.db.query("operations").collect(),
    issuances: await ctx.db.query("issuances").collect(),
    simulations: await ctx.db.query("issuanceSimulations").collect(),
    documents: await ctx.db.query("fiscalDocuments").collect(),
    files: await ctx.db.query("capacityFiles").collect(),
  }));
}

async function storedBytes(f: Fixture, issuanceId: Id<"issuances">) {
  return f.t.run(async (ctx) => {
    const artifacts = await ctx.db
      .query("issuanceArtifacts")
      .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuanceId))
      .collect();
    const ids = [...new Set(artifacts.map((artifact) => artifact.storageId))];
    const metadata = await Promise.all(ids.map((id) => ctx.db.system.get("_storage", id)));
    expect(metadata.every((file) => file !== null)).toBe(true);
    return metadata.reduce((sum, file) => sum + file!.size, 0);
  });
}

describe("fronteiras do plano na emissão", () => {
  it.each([0, ISSUANCE_BYTES - 1])(
    "recusa com %i bytes antes de reservar número, operação ou efeito fiscal",
    async (filesBytes) => {
      const f = await fixture({ capacity: { filesBytes } });
      await expect(request(f, "sem-saldo")).rejects.toMatchObject({
        data: { code: "QUOTA_EXCEEDED", metric: "filesBytes" },
      });
      expect(await fiscalState(f.t)).toEqual({
        sequences: [],
        operations: [],
        issuances: [],
        simulations: [],
        documents: [],
        files: [],
      });
      expect(await total(f)).toBeNull();
      expect(await f.t.run((ctx) => ctx.db.query("capacityEvents").collect())).toEqual([]);
    },
  );

  it("POST REST de emissão também recusa antes de criar qualquer efeito fiscal", async () => {
    const f = await fixture({ capacity: { filesBytes: ISSUANCE_BYTES - 1 } });
    const response = await f.t.fetch("/v1/issuances", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.key}`,
        "X-Environment": "sandbox",
        "Idempotency-Key": "emissao-rest-sem-saldo",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ companyId: f.scope.companyId, ...domestic() }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: false },
    });
    expect(await fiscalState(f.t)).toEqual({
      sequences: [],
      operations: [],
      issuances: [],
      simulations: [],
      documents: [],
      files: [],
    });
    expect(await total(f)).toBeNull();
  });

  it("duas admissões concorrentes disputam uma reserva de 18 MiB sem duplicar por idempotência", async () => {
    const f = await fixture({ capacity: { filesBytes: ISSUANCE_BYTES } });
    const results = await Promise.allSettled([
      request(f, "concorrente-a"),
      request(f, "concorrente-b"),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ data: { code: "QUOTA_EXCEEDED" } });
    const issuance = accepted[0]!.value.issuance;
    const key = results[0]!.status === "fulfilled" ? "concorrente-a" : "concorrente-b";
    expect(await request(f, key)).toMatchObject({ reused: true, issuance: { id: issuance.id } });
    expect(await total(f)).toMatchObject({ committed: 0, reserved: ISSUANCE_BYTES });
    const state = await fiscalState(f.t);
    expect(state.operations).toHaveLength(1);
    expect(state.issuances).toHaveLength(1);
    expect(state.sequences).toMatchObject([{ last: 1 }]);
    expect(state.simulations).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("capacityEvents").collect())).toHaveLength(1);
  });

  it("uma autorização consome os bytes persistidos e libera a sobra uma única vez", async () => {
    const f = await fixture({ capacity: { filesBytes: ISSUANCE_BYTES } });
    const accepted = await request(f, "autorizar");
    expect((await drive(f, accepted.issuance.operationId)).state).toBe("succeeded");
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    expect(done.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "danfse",
      "dps",
      "nfse",
    ]);
    const bytes = await storedBytes(f, done.id);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(ISSUANCE_BYTES);
    expect(await total(f)).toMatchObject({ committed: bytes, reserved: 0 });
    expect(await reservation(f, done.operationId)).toMatchObject({
      state: "released",
      remaining: 0,
    });
    const before = await total(f);
    expect(await request(f, "autorizar")).toMatchObject({
      reused: true,
      issuance: { id: done.id },
    });
    await drive(f, done.operationId);
    expect(await total(f)).toEqual(before);
    expect((await fiscalState(f.t)).documents).toHaveLength(1);
  });

  it("rejeição definitiva libera a sobra e preserva os bytes da DPS e seu número", async () => {
    const f = await fixture({ capacity: { filesBytes: ISSUANCE_BYTES } });
    const accepted = await request(f, "rejeitar", domestic("Teste [simular:rejeicao]"));
    expect(await drive(f, accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ADN_REJECTED",
    });
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "rejected", number: 1 });
    const bytes = await storedBytes(f, accepted.issuance.id);
    expect(bytes).toBeGreaterThan(0);
    expect(await total(f)).toMatchObject({ committed: bytes, reserved: 0 });
    expect(await reservation(f, accepted.issuance.operationId)).toMatchObject({
      state: "released",
      remaining: 0,
    });
    const state = await fiscalState(f.t);
    expect(state.sequences).toMatchObject([{ last: 1 }]);
    expect(state.documents).toEqual([]);
  });

  it("timeout preserva a reserva até reconciliar, inclusive após o vencimento do plano", async () => {
    const f = await fixture({ capacity: { filesBytes: ISSUANCE_BYTES }, endsAt: NOW + 60_000 });
    const input = domestic("Teste [simular:timeout]");
    const accepted = await request(f, "incerto", input);
    expect(await drive(f, accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      uncertain: true,
    });
    const dpsBytes = await storedBytes(f, accepted.issuance.id);
    expect(dpsBytes).toBeGreaterThan(0);
    expect(await total(f)).toMatchObject({
      committed: dpsBytes,
      reserved: ISSUANCE_BYTES - dpsBytes,
    });
    expect(await reservation(f, accepted.issuance.operationId)).toMatchObject({
      state: "reserved",
      remaining: ISSUANCE_BYTES - dpsBytes,
    });
    await expect(request(f, "outro-pedido")).rejects.toMatchObject({
      data: { code: "QUOTA_EXCEEDED" },
    });

    vi.setSystemTime(NOW + 60_001);
    await expect(request(f, "apos-vencimento")).rejects.toMatchObject({
      data: { code: "PLAN_INACTIVE" },
    });
    expect(await request(f, "incerto", input)).toMatchObject({
      reused: true,
      issuance: { id: accepted.issuance.id },
    });
    expect((await drive(f, accepted.issuance.operationId)).state).toBe("succeeded");
    const done = await view(f, accepted.issuance.id);
    expect(done).toMatchObject({ state: "authorized", number: 1 });
    expect(done.documentId).not.toBeNull();
    const bytes = await storedBytes(f, done.id);
    expect(bytes).toBeGreaterThan(dpsBytes);
    expect(await total(f)).toMatchObject({ committed: bytes, reserved: 0 });
    const state = await fiscalState(f.t);
    expect(state.simulations).toMatchObject([{ posts: 1 }]);
    expect(state.documents).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
  });

  it("cancelamento exige 16 MiB antes de aceitar e libera a sobra após registrar o evento", async () => {
    const f = await fixture();
    const accepted = await request(f, "emitir-para-cancelar");
    expect((await drive(f, accepted.issuance.operationId)).state).toBe("succeeded");
    const before = (await total(f))!.committed;
    const cancel = () =>
      f.owner.mutation(internal.issuance.cancel, {
        ...f.where,
        idempotencyKey: "cancelar",
        issuanceId: accepted.issuance.id,
        reasonCode: "1",
        reason: "Cancelamento sintético para prova de capacidade",
      });
    const setLimit = (filesBytes: number) =>
      f.t.run(async (ctx) => {
        const plan = (await ctx.db.get("usagePlans", f.planId!))!;
        await ctx.db.patch("usagePlans", plan._id, { capacity: { ...plan.capacity!, filesBytes } });
      });
    await setLimit(before + CANCELLATION_BYTES - 1);
    await expect(cancel()).rejects.toMatchObject({ data: { code: "QUOTA_EXCEEDED" } });
    expect(await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).toEqual([]);
    expect((await fiscalState(f.t)).operations).toHaveLength(1);
    await setLimit(before + CANCELLATION_BYTES);
    const cancellation = await cancel();
    const operationId = cancellation.issuance.cancellation!.operationId;
    expect(await cancel()).toMatchObject({ reused: true });
    expect(await total(f)).toMatchObject({ committed: before, reserved: CANCELLATION_BYTES });
    expect((await drive(f, operationId)).state).toBe("succeeded");
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "cancelled" });
    expect(await total(f)).toMatchObject({
      committed: await storedBytes(f, accepted.issuance.id),
      reserved: 0,
    });
    expect(await reservation(f, operationId)).toMatchObject({ state: "released", remaining: 0 });
  });
});

describe("fronteiras do plano no GET REST autenticado", () => {
  it("cota esgotada retorna 429 não retentável e não debita outra organização", async () => {
    const f = await fixture({ capacity: { restReads: 1 } });
    const other = await fixture({ capacity: { restReads: 2 } }, f.t);
    expect((await get(f)).status).toBe(200);
    expect(await total(f, "restReads")).toMatchObject({ committed: 1, reserved: 0 });
    const refused = await get(f);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: false },
    });
    expect(await total(f, "restReads")).toMatchObject({ committed: 1, reserved: 0 });
    expect(await total(other, "restReads")).toBeNull();
    expect((await get(other)).status).toBe(200);
    expect(await total(other, "restReads")).toMatchObject({ committed: 1, reserved: 0 });
  });

  it("sem plano retorna 403 em vez de 503 e não usa o saldo de outra organização", async () => {
    const f = await fixture({ noPlan: true });
    const other = await fixture({}, f.t);
    const refused = await get(f);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "SCOPE_DENIED", retryable: false },
    });
    expect(await total(f, "restReads")).toBeNull();
    expect(await total(other, "restReads")).toBeNull();
    expect((await get(other)).status).toBe(200);
  });

  it("um seletor de empresa alheia não muda a organização cobrada nem concede acesso", async () => {
    const f = await fixture({ capacity: { restReads: 2 } });
    const other = await fixture({}, f.t);
    const refused = await get(f, `/v1/documents?companyId=${other.scope.companyId}`);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await total(f, "restReads")).toMatchObject({ committed: 1, reserved: 0 });
    expect(await total(other, "restReads")).toBeNull();
  });
});
