import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { api, internal, components } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { lookupOpenCnpj } from "./lib/registryProvider";
import { CACHE_TTL, RETENTION } from "./lib/registryValues";
import { registryLookup } from "../../packages/contracts/src/registry";
import { modules } from "../../tests/helpers/convex-modules";
const cnpj = "00000000000191";
const raw = {
  cnpj,
  razao_social: "Nome da fonte sintética",
  situacao_cadastral: "Ativa",
  tipo_logradouro: "Rua",
  logradouro: "Sintética",
  numero: "7",
  complemento: "",
  bairro: "Centro",
  municipio: "São Paulo",
  uf: "SP",
  cep: "01000000",
  email: "never-store@development.invalid",
  QSA: [{ nome: "Não persistir" }],
};
const privacyDecision = {
  cnpj,
  blocked: true,
  reference: "D02-SYNTHETIC-001",
  actor: "privacy-test",
  expectedVersion: 0,
};
beforeEach(() => {
  vi.useFakeTimers();
  for (const [k, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5196",
    CONVEX_SITE_URL: "http://127.0.0.1:3251",
    BETTER_AUTH_SECRET: "synthetic-registry-secret",
  }))
    vi.stubEnv(k, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, {
      kind: "declared",
      fieldSources: { name: "declared", address: "declared" },
    });
    await ctx.db.patch("apiKeys", scope.keyId, {
      scopes: ["registry:read", "companies:read"],
      expiresAt: Date.now() + 40 * CACHE_TTL,
    });
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique();
    await ctx.db.patch("projectCompanies", grant!._id, {
      scopes: ["registry:read", "companies:read"],
    });
  });
  const args = { keyHash, environment: "sandbox", companyId: scope.companyId, cnpj };
  const reserve = async (key: string = crypto.randomUUID()) => {
    const result = await t.mutation(internal.registryRest.dispatch, { ...args, key });
    if (!("operationId" in result)) throw new Error("expected a reservation");
    return result;
  };
  const read = async () =>
    registryLookup.parse(await t.mutation(internal.registryRest.dispatch, args));
  const cache = () =>
    t.run((ctx) =>
      ctx.db
        .query("registryCache")
        .withIndex("by_provider_and_cnpj", (q) => q.eq("provider", "opencnpj").eq("cnpj", cnpj))
        .unique(),
    );
  const calls = () => t.run((ctx) => ctx.db.query("registryCalls").take(20));
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(raw));
  vi.stubGlobal("fetch", transport);
  const run = async (key: string = crypto.randomUUID()) => {
    const op = await reserve(key);
    await t.action(internal.operationWorker.run, { operationId: op.operationId, generation: 1 });
    return op;
  };
  return { t, scope, secret, args, reserve, read, run, cache, calls, transport };
}
async function owner(f: Awaited<ReturnType<typeof fixture>>) {
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Titular sintético",
        email: "owner@development.invalid",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await f.t.run(async (ctx) => {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("state", "active"),
      )
      .first();
    await ctx.db.patch("memberships", member!._id, { authUserId: user._id });
  });
  return f.t.withIdentity({ subject: user._id, sessionId: session._id });
}

it("liberar CNPJ sem bloqueio preserva o cache e não cria decisão nem altera sua versão", async () => {
  const f = await fixture();
  await f.run();
  const cached = await f.cache();
  const release = { ...privacyDecision, blocked: false };
  await expect(
    f.t.mutation(internal.registryStore.restrict, { ...release, expectedVersion: 1 }),
  ).rejects.toThrow("REGISTRY_CHANGED");
  expect(await f.t.mutation(internal.registryStore.restrict, release)).toEqual({
    version: 0,
    blocked: false,
  });
  expect(await f.cache()).toEqual(cached);
  expect(await f.t.run((ctx) => ctx.db.query("registryRestrictions").take(1))).toEqual([]);

  await f.t.mutation(internal.registryStore.restrict, privacyDecision);
  const released = { ...release, reference: "D02-RELEASE", expectedVersion: 1 };
  await f.t.mutation(internal.registryStore.restrict, released);
  await f.run();
  const fresh = await f.cache();
  const decision = await f.t.run((ctx) => ctx.db.query("registryRestrictions").take(1));
  expect(await f.t.mutation(internal.registryStore.restrict, released)).toEqual({
    version: 2,
    blocked: false,
  });
  expect(
    await f.t.mutation(internal.registryStore.restrict, {
      ...released,
      reference: "D02-RELEASE-AGAIN",
      expectedVersion: 2,
    }),
  ).toEqual({ version: 2, blocked: false });
  expect(await f.cache()).toEqual(fresh);
  expect(await f.t.run((ctx) => ctx.db.query("registryRestrictions").take(1))).toEqual(decision);
  expect((await f.read()).status).toBe("found");
  expect(f.transport).toHaveBeenCalledTimes(2);
});

it("oposição elimina cache e impede leitura, atualização e aplicação, inclusive em outra organização", async () => {
  const f = await fixture();
  const client = await owner(f);
  await f.run();
  const company = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  const cached = (await f.cache())!;
  const otherKey = await hashApiKey("synthetic-other-privacy-key");
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: otherKey,
    suffix: "other-privacy",
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch("companies", other.companyId, { kind: "declared" });
    await ctx.db.patch("apiKeys", other.keyId, { scopes: ["registry:read"] });
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", other.projectId).eq("companyId", other.companyId),
      )
      .unique();
    await ctx.db.patch("projectCompanies", grant!._id, { scopes: ["registry:read"] });
  });
  expect(await f.t.mutation(internal.registryStore.restrict, privacyDecision)).toEqual({
    version: 1,
    blocked: true,
  });
  // A restored cache stays unreadable; replaying D02 removes it again.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...data } = cached;
    await ctx.db.insert("registryCache", {
      ...data,
      expiryJobId: undefined,
      retentionJobId: undefined,
    });
  });
  expect(await f.read()).toMatchObject({ status: "unavailable", data: null });
  await f.t.mutation(internal.registryStore.restrict, privacyDecision);
  expect(await f.cache()).toBeNull();
  expect(await f.read()).toMatchObject({ status: "unavailable", data: null });
  expect(
    await client.query(api.registry.get, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      contextKey: "test",
    }),
  ).toMatchObject({ status: "unavailable", data: null });
  const otherArgs = { keyHash: otherKey, environment: "sandbox", companyId: other.companyId, cnpj };
  expect(await f.t.mutation(internal.registryRest.dispatch, otherArgs)).toMatchObject({
    status: "unavailable",
    data: null,
  });
  await expect(
    f.t.mutation(internal.registryRest.dispatch, { ...otherArgs, companyId: f.scope.companyId }),
  ).rejects.toThrow();
  await expect(
    f.t.mutation(internal.registryRest.dispatch, { ...otherArgs, key: "blocked" }),
  ).rejects.toThrow();
  await expect(f.reserve()).rejects.toThrow();
  await expect(
    client.mutation(api.registry.refresh, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      cnpj,
      key: "blocked",
      environment: "sandbox",
    }),
  ).rejects.toThrow();
  await expect(
    client.mutation(api.registry.apply, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      expectedCompanyVersion: company.version,
      expectedCacheVersion: cached.version,
      fields: ["name"],
    }),
  ).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId))).toEqual(company);
  expect(await f.t.mutation(internal.registryStore.restrict, privacyDecision)).toEqual({
    version: 1,
    blocked: true,
  });
  await expect(
    f.t.mutation(internal.registryStore.restrict, {
      ...privacyDecision,
      reference: "D02-SYNTHETIC-002",
      blocked: false,
    }),
  ).rejects.toThrow();
  // Releasing an active restriction must also discard data recovered from an old backup.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...data } = cached;
    await ctx.db.insert("registryCache", {
      ...data,
      expiryJobId: undefined,
      retentionJobId: undefined,
    });
  });
  await f.t.mutation(internal.registryStore.restrict, {
    ...privacyDecision,
    reference: "D02-SYNTHETIC-002",
    expectedVersion: 1,
    blocked: false,
  });
  expect(await f.cache()).toBeNull();
  await f.run();
  expect((await f.read()).status).toBe("found");
});

it("oposição cobre a fila e descarta resposta em trânsito mesmo depois de liberar nova consulta", async () => {
  const f = await fixture();
  const queued = await f.reserve();
  await f.t.mutation(internal.registryStore.restrict, privacyDecision);
  await f.t.action(internal.operationWorker.run, {
    operationId: queued.operationId,
    generation: 1,
  });
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.t.run((ctx) => ctx.db.get("operations", queued.operationId))).toMatchObject({
    state: "failed",
    code: "REGISTRY_RESTRICTED",
  });
  await f.t.mutation(internal.registryStore.restrict, {
    ...privacyDecision,
    blocked: false,
    expectedVersion: 1,
    reference: "D02-SYNTHETIC-002",
  });
  const reserved = await f.reserve();
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: reserved.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: reserved.operationId, generation: 1, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  expect(await f.t.mutation(internal.registryStore.begin, { ...claim, cnpj })).toBe("call");
  await f.t.mutation(internal.registryStore.restrict, {
    ...privacyDecision,
    expectedVersion: 2,
    reference: "D02-SYNTHETIC-003",
  });
  const response = await lookupOpenCnpj(cnpj, async () => Response.json(raw));
  expect(await f.t.mutation(internal.registryStore.complete, { ...claim, cnpj, ...response })).toBe(
    false,
  );
  await f.t.mutation(internal.registryStore.restrict, {
    ...privacyDecision,
    blocked: false,
    expectedVersion: 3,
    reference: "D02-SYNTHETIC-004",
  });
  expect(await f.t.mutation(internal.registryStore.complete, { ...claim, cnpj, ...response })).toBe(
    false,
  );
  expect(await f.cache()).toBeNull();
  await f.run();
  expect((await f.read()).status).toBe("found");
});

it("expurga histórico deferido em lotes sem apagar cadastro confirmado nem outra empresa", async () => {
  const f = await fixture();
  const client = await owner(f);
  await f.run();
  const company = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  await client.mutation(api.registry.apply, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    expectedCompanyVersion: company.version,
    expectedCacheVersion: (await f.read()).version,
    fields: ["name"],
  });
  const confirmed = (await f.t.run((ctx) => ctx.db.get("companies", company._id)))!;
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "synthetic-privacy-history",
    suffix: "privacy-history",
  });
  await f.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("registryApplications")
      .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
      .first())!;
    const { _id, _creationTime, ...data } = row;
    for (let i = 0; i < 100; i++) await ctx.db.insert("registryApplications", data);
    await ctx.db.insert("registryApplications", {
      ...data,
      companyId: other.companyId,
      organizationId: other.organizationId,
    });
  });
  const args = {
    organizationId: f.scope.organizationId,
    companyId: company._id,
    cnpj,
    expectedCompanyVersion: confirmed.version,
    reference: privacyDecision.reference,
  };
  await expect(
    f.t.mutation(internal.registryStore.eraseApplicationHistory, args),
  ).rejects.toThrow();
  await f.t.mutation(internal.registryStore.restrict, privacyDecision);
  await expect(
    f.t.mutation(internal.registryStore.eraseApplicationHistory, {
      ...args,
      organizationId: other.organizationId,
    }),
  ).rejects.toThrow();
  await expect(
    f.t.mutation(internal.registryStore.eraseApplicationHistory, {
      ...args,
      expectedCompanyVersion: company.version,
    }),
  ).rejects.toThrow();
  expect(await f.t.mutation(internal.registryStore.eraseApplicationHistory, args)).toEqual({
    removed: 100,
    done: false,
  });
  expect(await f.t.mutation(internal.registryStore.eraseApplicationHistory, args)).toEqual({
    removed: 1,
    done: true,
  });
  expect(await f.t.mutation(internal.registryStore.eraseApplicationHistory, args)).toEqual({
    removed: 0,
    done: true,
  });
  expect(await f.t.run((ctx) => ctx.db.get("companies", company._id))).toEqual(confirmed);
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("registryApplications")
        .withIndex("by_companyId", (q) => q.eq("companyId", other.companyId))
        .take(2),
    ),
  ).toHaveLength(1);
});
it("faz consulta real pelo pipeline de operações, minimiza payload e deduplica cache/uso", async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe("not_consulted");
  const first = await f.run("same-request");
  const result = await f.read();
  expect(result).toMatchObject({
    status: "found",
    freshness: "fresh",
    sourceUpdatedAt: null,
    data: { name: raw.razao_social },
  });
  expect(result.expiresAt).toBe(result.consultedAt! + CACHE_TTL);
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.transport.mock.calls[0]![0]).toBe(`https://api.opencnpj.org/${cnpj}?datasets=receita`);
  expect((await f.reserve("same-request")).operationId).toBe(first.operationId);
  await f.run();
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(await f.calls()).toHaveLength(1);
  const usage = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(
    usage.filter((event) => event.metric === "registry" && event.state === "committed"),
  ).toHaveLength(1);
  expect(JSON.stringify(await f.cache())).not.toMatch(/never-store|Não persistir|QSA/);
  expect(
    JSON.stringify(await f.t.run((ctx) => ctx.db.get("operations", first.operationId))),
  ).not.toContain(raw.razao_social);
});
it("pausa consulta sem chamar a fonte quando a cota externa está esgotada", async () => {
  const f = await fixture();
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Quota",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 100000,
    limits: { imports: null, bytes: null, captures: null, registry: 0, deliveries: null },
    concurrency: 2,
    actor: "test",
    reason: "quota",
    expectedVersion: 0,
  });
  const op = await f.run();
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.t.run((ctx) => ctx.db.get("operations", op.operationId))).toMatchObject({
    state: "paused",
    code: "QUOTA_EXCEEDED",
    uncertain: false,
  });
  expect(await f.calls()).toHaveLength(0);
});
it("cache vencido e fonte indisponível preservam o resultado anterior sem fingir atualização", async () => {
  const f = await fixture();
  await f.run();
  const first = await f.read(),
    cache = (await f.cache())!;
  vi.setSystemTime(Date.now() + CACHE_TTL + 1);
  await f.t.mutation(internal.registryStore.expire, { cacheId: cache._id });
  expect((await f.read()).freshness).toBe("stale");
  f.transport.mockResolvedValue(new Response("offline", { status: 503 }));
  await f.run();
  expect(await f.read()).toMatchObject({
    status: "unavailable",
    freshness: "stale",
    consultedAt: first.consultedAt,
    data: first.data,
  });
  const count = f.transport.mock.calls.length;
  await f.run();
  expect(f.transport).toHaveBeenCalledTimes(count);
  vi.setSystemTime(first.consultedAt! + RETENTION + 1);
  await f.t.mutation(internal.registryStore.expire, { cacheId: cache._id });
  expect(await f.cache()).toBeNull();
});
it.each([404, 429, 500, 400])(
  "diferencia ausência, erro e formato não suportado (%s)",
  async (status) => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("companies", f.scope.companyId, { cnpj: "12ABC34501DE35" }),
    );
    const args = { ...f.args, cnpj: "12ABC34501DE35", key: "alpha" };
    f.transport.mockResolvedValue(
      new Response("{}", { status, headers: { "content-type": "application/json" } }),
    );
    const reserved = await f.t.mutation(internal.registryRest.dispatch, args);
    if (!("operationId" in reserved)) throw new Error("expected a reservation");
    await f.t.action(internal.operationWorker.run, {
      operationId: reserved.operationId,
      generation: 1,
    });
    const result = registryLookup.parse(
      await f.t.mutation(internal.registryRest.dispatch, { ...args, key: undefined }),
    );
    expect(result.status).toBe(
      status === 404 ? "not_found" : status === 400 ? "unsupported_format" : "unavailable",
    );
    expect(result.data).toBeNull();
  },
);
it("preserva letras e zeros e recusa resposta vazia, divergente ou grande", async () => {
  for (const data of [{ ...raw, cnpj: "12ABC34501DE35" }, {}, { ...raw, cnpj: "wrong" }]) {
    const result = await lookupOpenCnpj("12ABC34501DE35", async () => Response.json(data));
    expect(result.status).toBe(
      "cnpj" in data && data.cnpj === "12ABC34501DE35" ? "found" : "unavailable",
    );
  }
  expect(
    (
      await lookupOpenCnpj(
        cnpj,
        async () =>
          new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }),
      )
    ).status,
  ).toBe("unavailable");
  const transport = vi.fn<typeof fetch>();
  expect((await lookupOpenCnpj("../../evil", transport)).status).toBe("unsupported_format");
  expect(transport).not.toHaveBeenCalled();
});
it("encerra timeout sem registrar sucesso vazio", async () => {
  const pending = lookupOpenCnpj(
    cnpj,
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("timeout"))),
      ),
  );
  await vi.advanceTimersByTimeAsync(10001);
  expect((await pending).status).toBe("unavailable");
});
it("nega chave revogada, escopo, ambiente, outra organização e CNPJ diferente mesmo com cache quente", async () => {
  const f = await fixture();
  await f.run();
  await expect(
    f.t.mutation(internal.registryRest.dispatch, { ...f.args, cnpj: "12ABC34501DE35" }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    f.t.mutation(internal.registryRest.dispatch, { ...f.args, environment: "production" }),
  ).rejects.toThrow("ENVIRONMENT_DENIED");
  const foreign = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "foreign",
    suffix: crypto.randomUUID(),
  });
  await expect(
    f.t.mutation(internal.registryRest.dispatch, { ...f.args, companyId: foreign.companyId }),
  ).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: [] }));
  await expect(f.read()).rejects.toThrow("SCOPE_DENIED");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  await expect(f.read()).rejects.toThrow("INVALID_API_KEY");
  await expect(f.reserve("repeated")).rejects.toThrow("INVALID_API_KEY");
});
it("bloqueia resposta atrasada e não retransmite chamada de resultado incerto", async () => {
  const f = await fixture(),
    reserved = await f.reserve();
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: reserved.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: op.generation, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  expect(await f.t.mutation(internal.registryStore.begin, { ...claim, cnpj })).toBe("call");
  vi.setSystemTime(op.leaseUntil + 1);
  const result = await lookupOpenCnpj(cnpj, async () => Response.json(raw));
  expect(await f.t.mutation(internal.registryStore.complete, { ...claim, cnpj, ...result })).toBe(
    false,
  );
  await f.t.mutation(internal.operations.recoverOne, { operationId: op._id });
  const next = (await f.t.run((ctx) => ctx.db.get("operations", op._id)))!;
  vi.setSystemTime(next.nextAttemptAt);
  await f.t.action(internal.operationWorker.run, {
    operationId: op._id,
    generation: next.generation,
  });
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.calls()).toHaveLength(1);
  expect((await f.t.run((ctx) => ctx.db.get("operations", op._id)))!.code).toBe(
    "REGISTRY_RESULT_UNKNOWN",
  );
});
it("dois executores não duplicam a chamada ao mesmo CNPJ", async () => {
  const f = await fixture();
  const first = await f.reserve(),
    second = await f.reserve();
  const claim = async (id: typeof first.operationId) => {
    const op = (await f.t.mutation(internal.operations.claim, { operationId: id, generation: 1 }))!;
    const args = { operationId: id, generation: 1, fence: op.fence, cnpj };
    await f.t.mutation(internal.operations.beginEffect, {
      operationId: id,
      generation: 1,
      fence: op.fence,
    });
    return args;
  };
  const a = await claim(first.operationId),
    b = await claim(second.operationId);
  const results = await Promise.all([
    f.t.mutation(internal.registryStore.begin, a),
    f.t.mutation(internal.registryStore.begin, b),
  ]);
  expect(results.sort()).toEqual(["call", "wait"]);
  expect(await f.calls()).toHaveLength(1);
});
it("aplica só os campos confirmados, preserva origem/histórico e recusa versão antiga ou usuário sem gestão", async () => {
  const f = await fixture();
  await f.run();
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa",
        email: "registry@development.invalid",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const client = f.t.withIdentity({ subject: user._id, sessionId: session._id });
  const memberId = await f.t.run(async (ctx) => {
    const member = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("state", "active"),
      )
      .first())!;
    await ctx.db.patch("memberships", member._id, { authUserId: user._id });
    return member._id;
  });
  const before = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  const args = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    expectedCompanyVersion: before.version,
    expectedCacheVersion: (await f.read()).version,
    fields: ["name" as const],
  };
  await client.mutation(api.registry.apply, args);
  const after = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  expect(after.name).toBe(raw.razao_social);
  expect(after.address).toEqual(before.address);
  expect(after.fieldSources).toEqual({ name: "registry", address: "declared" });
  const history = await f.t.run((ctx) =>
    ctx.db
      .query("registryApplications")
      .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
      .take(10),
  );
  expect(history[0]!.before.name).toBe(before.name);
  await client.mutation(api.companies.update, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    expectedVersion: after.version,
    name: ` ${after.name} `,
    address: {
      ...after.address,
      state: after.address.state.toLowerCase(),
      postalCode: "01000-000",
    },
  });
  const normalized = (await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!;
  expect(normalized.fieldSources).toEqual(after.fieldSources);
  await expect(client.mutation(api.registry.apply, args)).rejects.toThrow("COMPANY_CHANGED");
  await expect(
    client.mutation(api.registry.apply, {
      ...args,
      expectedCompanyVersion: normalized.version,
      expectedCacheVersion: 999,
    }),
  ).rejects.toThrow("REGISTRY_CHANGED");
  await f.t.run((ctx) => ctx.db.patch("memberships", memberId, { role: "viewer" }));
  await expect(
    client.mutation(api.registry.apply, { ...args, expectedCompanyVersion: after.version }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    f.t.query(api.registry.get, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      contextKey: "test",
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { kind: "demonstration" }));
  await expect(f.read()).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("memberships", memberId, { role: "owner" }));
  await expect(
    client.query(api.registry.get, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      contextKey: "test",
    }),
  ).rejects.toThrow("DEMONSTRATION_READ_ONLY");
});
it("REST valida contrato, consulta cache e reserva atualização idempotente", async () => {
  const f = await fixture();
  const headers = {
    Authorization: `Bearer ${f.secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
    "Idempotency-Key": "rest-lookup",
  };
  const path = `/v1/registry/cnpj/${cnpj}`;
  const post = () =>
    f.t.fetch(path + "/refresh", {
      method: "POST",
      headers,
      body: JSON.stringify({ companyId: f.scope.companyId }),
    });
  const first = await post();
  expect(first.status).toBe(200);
  const body = await first.json();
  const again = await (await post()).json();
  expect(again.data.operationId).toBe(body.data.operationId);
  await f.t.action(internal.operationWorker.run, {
    operationId: body.data.operationId,
    generation: 1,
  });
  const get = await f.t.fetch(`${path}?companyId=${f.scope.companyId}`, { headers });
  expect(get.status).toBe(200);
  expect(registryLookup.parse((await get.json()).data).status).toBe("found");
  const malformed = await f.t.fetch(path + "/refresh", {
    method: "POST",
    headers,
    body: '{"companyId":5}',
  });
  expect(malformed.status).toBe(400);
  const invalid = await f.t.fetch(
    `/v1/registry/cnpj/00000000000000?companyId=${f.scope.companyId}`,
    { headers },
  );
  expect(invalid.status).toBe(400);
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { kind: "demonstration" }));
  const demo = await f.t.fetch(`${path}?companyId=${f.scope.companyId}`, { headers });
  expect(demo.status).toBe(404);
  expect((await demo.json()).error).toMatchObject({ code: "NOT_FOUND", retryable: false });
});

it("revogação durante a chamada impede gravar o resultado e expor o cache", async () => {
  const f = await fixture();
  f.transport.mockImplementation(async () => {
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
    return Response.json(raw);
  });
  const reserved = await f.run();
  expect((await f.cache())!.data).toBeNull();
  expect((await f.calls())[0]!.state).toBe("dispatched_or_uncertain");
  expect((await f.t.run((ctx) => ctx.db.get("operations", reserved.operationId)))!.state).toBe(
    "paused",
  );
  await expect(f.read()).rejects.toThrow("INVALID_API_KEY");
});

it("mesma chave com outra empresa autorizada conflita, sem reservar outra chamada", async () => {
  const f = await fixture();
  await f.reserve("fixed-key");
  const companyId = await f.t.run(async (ctx) => {
    const company = (await ctx.db.get("companies", f.scope.companyId))!;
    const { _id, _creationTime, ...fields } = company;
    const id = await ctx.db.insert("companies", { ...fields, cnpj: "12ABC34501DE35" });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    const { _id: _grantId, _creationTime: _grantTime, ...grantFields } = grant;
    await ctx.db.insert("projectCompanies", { ...grantFields, companyId: id });
    await ctx.db.patch("apiKeys", f.scope.keyId, {
      companyIds: [f.scope.companyId, id],
      grantEpochs: [0, 0],
    });
    return id;
  });
  await expect(
    f.t.mutation(internal.registryRest.dispatch, {
      ...f.args,
      companyId,
      cnpj: "12ABC34501DE35",
      key: "fixed-key",
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(await f.calls()).toHaveLength(0);
});

it("renovação cancela agendamentos antigos e não cria cadeias de expurgo", async () => {
  const f = await fixture();
  await f.run();
  const first = (await f.cache())!;
  vi.setSystemTime(Date.now() + CACHE_TTL + 1);
  await f.run();
  const next = (await f.cache())!;
  expect(next.expiryJobId).not.toBe(first.expiryJobId);
  expect(next.retentionJobId).not.toBe(first.retentionJobId);
  for (const id of [first.expiryJobId!, first.retentionJobId!])
    expect((await f.t.run((ctx) => ctx.db.system.get(id)))!.state.kind).toBe("canceled");
  const before = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(100));
  await f.t.mutation(internal.registryStore.expire, { cacheId: next._id });
  const after = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(100));
  expect(after.length).toBe(before.length);
  expect((await f.read()).freshness).toBe("fresh");
});

it("expurgo durante consulta remove dados antigos sem liberar a chamada concorrente", async () => {
  const f = await fixture();
  await f.run();
  const cache = (await f.cache())!;
  vi.setSystemTime(cache.retainUntil - 1);
  const first = await f.reserve(),
    second = await f.reserve();
  const claim = async (operationId: typeof first.operationId) => {
    const op = (await f.t.mutation(internal.operations.claim, { operationId, generation: 1 }))!;
    const args = { operationId, generation: 1, fence: op.fence };
    await f.t.mutation(internal.operations.beginEffect, args);
    return { ...args, cnpj };
  };
  const a = await claim(first.operationId),
    b = await claim(second.operationId);
  expect(await f.t.mutation(internal.registryStore.begin, a)).toBe("call");
  vi.setSystemTime(cache.retainUntil + 1);
  await f.t.mutation(internal.registryStore.expire, { cacheId: cache._id });
  expect(await f.cache()).toMatchObject({
    data: null,
    consultedAt: null,
    pendingOperationId: a.operationId,
  });
  expect(await f.t.mutation(internal.registryStore.begin, b)).toBe("wait");
  const result = await lookupOpenCnpj(cnpj, async () => Response.json(raw));
  expect(await f.t.mutation(internal.registryStore.complete, { ...a, ...result })).toBe(true);
  expect((await f.read()).status).toBe("found");
});
