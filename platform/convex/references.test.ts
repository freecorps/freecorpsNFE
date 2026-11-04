import { convexTest } from "convex-test";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { api, internal, components } from "./_generated/api";
import { register } from "../test-setup";
import { referenceCorpus } from "../../tests/helpers/reference-corpus";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { canonicalEntries, sha256 } from "../../lib/reference-dataset";
import { FreecorpsClient } from "../../packages/sdk/src/index";
import { routes } from "../../packages/contracts/src/external";
import { referencePage, referenceLookup } from "../../packages/contracts/src/references";
import { modules } from "../../tests/helpers/convex-modules";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5195",
    CONVEX_SITE_URL: "http://127.0.0.1:3249",
    BETTER_AUTH_SECRET: "synthetic-secret-for-reference-tests",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${"r".repeat(43)}`;
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("apiKeys", scope.keyId, { scopes: ["references:read"] });
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique();
    await ctx.db.patch("projectCompanies", grant!._id, { scopes: ["references:read"] });
  });
  const args = {
    keyHash: await hashApiKey(secret),
    companyId: scope.companyId,
    environment: "sandbox" as const,
    dataset: "ncm" as const,
    date: "2026-09-22",
  };
  const read = async (extra = {}) => t.query(internal.references.rest, { ...args, ...extra });
  const load = async (corpus: Awaited<ReturnType<typeof referenceCorpus>>) => {
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([JSON.stringify(corpus)], { type: "application/json" })),
    );
    return t.action(internal.referenceLoad.stage, { storageId });
  };
  const stage = async (version = "v1") => load(await referenceCorpus("ncm", version));
  const publish = (versionId: Awaited<ReturnType<typeof stage>>, expectedGeneration: number) =>
    t.mutation(internal.referenceImport.publish, {
      versionId,
      expectedGeneration,
      reason: "Prova sintética",
    });
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return t.fetch(url.pathname + url.search, init);
  };
  const sdk = new FreecorpsClient({
    baseUrl: "http://localhost",
    apiKey: secret,
    environment: "sandbox",
    maxRetries: 0,
    fetch: fetcher,
  });
  return { t, scope, secret, args, read, stage, publish, sdk, load };
}
it("não expõe candidato ou atualização incompleta e conserva a versão publicada", async () => {
  const f = await fixture();
  await expect(f.read()).rejects.toThrow("REFERENCE_UNAVAILABLE");
  const first = await f.stage();
  await expect(f.read({ version: "v1" })).rejects.toThrow("REFERENCE_VERSION_UNAVAILABLE");
  await f.publish(first, 0);
  const corpus = await referenceCorpus("ncm", "interrupted");
  const partial = await f.t.mutation(internal.referenceImport.begin, {
    manifest: JSON.stringify(corpus.manifest),
  });
  await f.t.mutation(internal.referenceImport.append, {
    versionId: partial,
    offset: 0,
    entries: corpus.entries.slice(0, 2),
  });
  await expect(
    f.t.mutation(internal.referenceImport.finish, { versionId: partial }),
  ).rejects.toThrow("REFERENCE_INCOMPLETE");
  await expect(f.publish(partial, 1)).rejects.toThrow("REFERENCE_NOT_READY");
  expect((await f.read()).manifest.version).toBe("v1");
  await expect(f.read({ version: "interrupted" })).rejects.toThrow("REFERENCE_VERSION_UNAVAILABLE");
});
it("publica uma só geração concorrente, fixa páginas e comprova rollback", async () => {
  const f = await fixture(),
    first = await f.stage();
  await f.publish(first, 0);
  const page = referencePage.parse(await f.read({ limit: 2, q: "arvore" }));
  expect(page.page.map((r) => r.code)).toEqual(["99000000", "99000001"]);
  const changed = await referenceCorpus("ncm", "v2");
  changed.entries[2].description = "Descrição alterada na nova versão";
  changed.manifest.contentSha256 = await sha256(canonicalEntries(changed.entries));
  const second = await f.load(changed);
  changed.manifest.version = "v3";
  const third = await f.load(changed);
  const outcomes = await Promise.allSettled([f.publish(second, 1), f.publish(third, 1)]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await f.read()).manifest.version).not.toBe("v1");
  expect(referenceLookup.parse(await f.read({ code: "99000002" })).entry?.description).toBe(
    "Descrição alterada na nova versão",
  );
  const next = referencePage.parse(
    await f.read({ q: "ÁRVORE", limit: 2, cursor: page.nextCursor }),
  );
  expect(next.manifest.version).toBe("v1");
  expect(next.page[0].code).toBe("99000002");
  expect(next.page[0].description).toBe("Árvore de teste 02");
  await f.publish(first, 2);
  expect((await f.read()).manifest.version).toBe("v1");
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("referenceAudit")
      .withIndex("by_dataset", (q) => q.eq("dataset", "ncm"))
      .take(10),
  );
  expect(audit).toHaveLength(3);
  expect(audit[2].previousVersionId).not.toBe(first);
});
it("distingue inexistente, vigente, expirado, futuro e vigência desconhecida", async () => {
  const f = await fixture();
  await f.publish(await f.stage(), 0);
  for (const [code, date, status] of [
    ["99000000", "2026-09-22", "out_of_validity"],
    ["99000000", "2025-12-31", "valid"],
    ["99000001", "2024-12-31", "out_of_validity"],
    ["99000001", "2026-09-22", "valid"],
    ["99999999", "2026-09-22", "not_found"],
  ])
    expect(referenceLookup.parse(await f.read({ code, date })).status).toBe(status);
  const corpus = await referenceCorpus("municipalities");
  corpus.manifest.coverage = "snapshot";
  const id = await f.load(corpus);
  await f.publish(id, 0);
  expect(
    referenceLookup.parse(
      await f.read({ dataset: "municipalities", code: "9900001", date: "2026-09-23" }),
    ).status,
  ).toBe("validity_unknown");
});
it("rejeita hash, contagem, códigos duplicados, ordem, data inválida e versão repetida", async () => {
  const f = await fixture();
  for (const modify of [
    (c: Awaited<ReturnType<typeof referenceCorpus>>) => {
      c.manifest.contentSha256 = "0".repeat(64);
    },
    (c: Awaited<ReturnType<typeof referenceCorpus>>) => {
      c.entries.pop();
    },
    (c: Awaited<ReturnType<typeof referenceCorpus>>) => {
      c.entries[1] = c.entries[0];
    },
    (c: Awaited<ReturnType<typeof referenceCorpus>>) => {
      c.entries.reverse();
    },
    (c: Awaited<ReturnType<typeof referenceCorpus>>) => {
      c.entries[0].validFrom = "2026-02-30";
    },
  ]) {
    const c = await referenceCorpus();
    modify(c);
    await expect(f.load(c)).rejects.toThrow();
  }
  await f.stage();
  await expect(f.stage()).rejects.toThrow("REFERENCE_VERSION_EXISTS");
});
it("REST e SDK usam o contrato canônico e recusam cursores ou parâmetros inválidos", async () => {
  const f = await fixture();
  await f.publish(await f.stage(), 0);
  const input = {
    path: {},
    query: { companyId: f.scope.companyId, date: f.args.date, limit: 1 },
    body: {},
  };
  const result = await f.sdk.call("listNcm", input);
  expect(result.data.page).toHaveLength(1);
  const lookup = await f.sdk.call("getNcm", {
    ...input,
    path: { code: "99000000" },
    query: { companyId: f.scope.companyId, date: f.args.date },
  });
  expect(lookup.data.status).toBe("out_of_validity");
  for (const [route, path] of [
    [routes.listMunicipalities, {}],
    [routes.getMunicipality, { code: "9900000" }],
    [routes.listNcm, {}],
    [routes.getNcm, { code: "99000000" }],
  ] as const) {
    for (const version of ["v1", "2026-09-22.source_1", "", "has space", "a/b", "versão"]) {
      expect(
        route.input.safeParse({
          ...input,
          path,
          query: { companyId: f.scope.companyId, date: f.args.date, version },
        }).success,
      ).toBe(version === "v1" || version === "2026-09-22.source_1");
    }
  }
  for (const extra of [
    { cursor: "malformed" },
    { cursor: result.data.nextCursor!, date: "2026-09-23" },
    { limit: 51 },
    { date: "2026-02-30" },
    { version: "has space" },
    { version: "a/b" },
    { version: "versão" },
  ])
    await expect(f.read(extra)).rejects.toThrow();
  const missing = await f.t.fetch("/v1/references/ncm");
  expect(missing.status).toBe(401);
  const invalid = await f.t.fetch(`/v1/references/ncm?companyId=${f.scope.companyId}&limit=51`, {
    headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" },
  });
  expect(invalid.status).toBe(400);
  const absentVersion = await f.t.fetch(
    `/v1/references/ncm?companyId=${f.scope.companyId}&version=absent`,
    { headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" } },
  );
  expect(absentVersion.status).toBe(404);
  expect((await absentVersion.json()).error).toMatchObject({
    code: "NOT_FOUND",
    message: "Versão de referência não encontrada.",
  });
});
it("revalida chave, escopo, concessão, empresa e ambiente a cada página", async () => {
  const f = await fixture();
  await f.publish(await f.stage(), 0);
  await expect(f.read({ environment: "production" })).rejects.toThrow();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: crypto.randomUUID(),
  });
  await expect(f.read({ companyId: other.companyId })).rejects.toThrow();
  const page = referencePage.parse(await f.read({ limit: 1 }));
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["companies:read"] }));
  await expect(f.read({ cursor: page.nextCursor! })).rejects.toThrow("SCOPE_DENIED");
  await f.t.run((ctx) =>
    ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["references:read"], revokedAt: Date.now() }),
  );
  await expect(f.read()).rejects.toThrow("INVALID_API_KEY");
  await f.t.run((ctx) =>
    ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: null, expiresAt: Date.now() - 1 }),
  );
  // Admission compares the expiry with the action's clock; the query never reads it (#45).
  const expired = await f.t.fetch(`/v1/references/ncm?companyId=${f.scope.companyId}`, {
    headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" },
  });
  expect(expired.status).toBe(401);
  expect((await expired.json()).error.code).toBe("INVALID_API_KEY");
  await f.t.run(async (ctx) => {
    await ctx.db.patch("apiKeys", f.scope.keyId, { expiresAt: Date.now() + 3600000 });
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique();
    await ctx.db.patch("projectCompanies", grant!._id, { accessEpoch: grant!.accessEpoch + 1 });
  });
  await expect(f.read()).rejects.toThrow("NOT_FOUND");
});
it("consulta humana exige sessão e acesso à empresa, inclusive após remoção", async () => {
  const f = await fixture();
  await f.publish(await f.stage(), 0);
  const input = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    dataset: "ncm" as const,
    date: f.args.date,
    contextKey: "test",
  };
  await expect(f.t.query(api.references.search, input)).rejects.toThrow();
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Referências",
        email: "references@development.invalid",
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
  const actor = f.t.withIdentity({
    subject: user._id,
    sessionId: session._id,
    issuer: "http://127.0.0.1:3249",
  });
  await expect(actor.query(api.references.search, input)).rejects.toThrow();
  const member = await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: user._id,
      name: "Referências",
      email: user.email,
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  expect(referencePage.parse(await actor.query(api.references.search, input)).page).toHaveLength(
    20,
  );
  await f.t.run((ctx) => ctx.db.patch("memberships", member, { state: "removed" }));
  await expect(actor.query(api.references.search, input)).rejects.toThrow();
});
