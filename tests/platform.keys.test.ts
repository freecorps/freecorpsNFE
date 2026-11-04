import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, components, internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import type { Id } from "../platform/convex/_generated/dataModel";
import type { MembershipRole } from "../packages/contracts/src/organizations";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { apiUsageExpiresAt } from "../platform/convex/lib/apiUsageRetention";
import { signApiRequest } from "../platform/auth-transport";
import { modules } from "./helpers/convex-modules";
const proxySecret = "a".repeat(64);
const contextKey = "keys-proof",
  paginationOpts = { numItems: 50, cursor: null };
const input = {
  cnpj: "00000000000191",
  name: "Empresa sintética",
  address: {
    street: "Rua sintética",
    number: "1",
    complement: "",
    district: "Centro",
    city: "Cidade sintética",
    state: "SP",
    postalCode: "01000-000",
  },
};
beforeEach(() => {
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5187",
    CONVEX_SITE_URL: "http://127.0.0.1:3233",
    BETTER_AUTH_SECRET: "synthetic-secret-for-local-company-tests",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function setup() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
async function actor(t: ReturnType<typeof setup>, verified = true) {
  const now = Date.now(),
    email = `${crypto.randomUUID()}@development.invalid`;
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa de teste",
        email,
        emailVerified: verified,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return {
    user,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3233",
    }),
  };
}
async function fixture(t = setup()) {
  const owner = await actor(t);
  const org = await owner.client.mutation(api.organizations.create, {
    name: "Equipe sintética",
    slug: `org-${crypto.randomUUID()}`,
  });
  const created = await owner.client.mutation(api.companies.create, {
    ...input,
    organizationId: org.organizationId,
  });
  return {
    t,
    owner,
    org,
    scope: { organizationId: org.organizationId, companyId: created.companyId },
  };
}
async function member(
  t: ReturnType<typeof setup>,
  organizationId: Id<"organizations">,
  role: MembershipRole,
) {
  const person = await actor(t);
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      authUserId: person.user._id,
      name: person.user.name,
      email: person.user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  // Denormalized membership count is part of the fixture, as in a real acceptance transaction.
  await t.run(async (ctx) => {
    const org = (await ctx.db.get("organizations", organizationId))!;
    await ctx.db.patch("organizations", organizationId, {
      memberCount: org.memberCount + 1,
      ownerCount: org.ownerCount + Number(role === "owner"),
    });
  });
  return { ...person, membershipId };
}

async function projectFixture(t = setup()) {
  const f = await fixture(t);
  const { projectId } = await f.owner.client.mutation(api.projects.create, {
    organizationId: f.scope.organizationId,
    name: "Integração sintética",
    externalReference: "test",
  });
  const projectScope = { organizationId: f.scope.organizationId, projectId };
  await f.owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: f.scope.companyId,
    scopes: ["companies:read", "documents:read", "documents:import"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  // A grant that names Produção without the fiscal capture released, as saved before #493: the
  // key and REST checks below must hold on their own.
  await t.run(async (ctx) => {
    const grant = await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", projectId).eq("companyId", f.scope.companyId),
      )
      .unique();
    await ctx.db.patch("projectCompanies", grant!._id, { environments: ["sandbox", "production"] });
  });
  const keyArgs = {
    ...projectScope,
    name: "Chave sintética",
    companyIds: [f.scope.companyId],
    scopes: ["companies:read" as const],
    environment: "sandbox" as const,
    expiresAt: Date.now() + 7 * 86400_000,
  };
  const key = await f.owner.client.action(api.keys.create, keyArgs);
  return { ...f, projectScope, keyArgs, key };
}
async function rest(
  t: ReturnType<typeof setup>,
  secret: string,
  path = "/v1/companies",
  environment = "sandbox",
) {
  const response = await t.fetch(path, {
    headers: { Authorization: `Bearer ${secret}`, "X-Environment": environment },
  });
  const body = await response.json();
  expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return { response, body };
}
it("limita as 130 consultas da reprodução antes da validação e não grava por recusa", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_789_075_210_000);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const f = await projectFixture();
  for (let i = 0; i < 130; i++) {
    const result = await rest(f.t, f.key.secretOnce);
    expect(result.response.status).toBe(i < 60 ? 200 : 429);
    if (i >= 60) {
      expect(result.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
      expect(result.response.headers.get("Retry-After")).toBe("1");
    }
  }
  const rows = () =>
    f.t.run(async (ctx) => ({
      receipts: await ctx.db.query("apiUsageEvents").collect(),
      audit: (await ctx.db.query("operationalAudit").collect()).filter((r) =>
        r.action.startsWith("http."),
      ),
    }));
  const before = await rows();
  expect(before.receipts).toHaveLength(60);
  expect(before.audit).toHaveLength(61);
  expect(before.audit.filter((r) => r.action === "http.rateLimited")).toHaveLength(1);
  log.mockClear();
  for (const path of [
    "/v1/companies?limit=invalid",
    "/v1/references/invalid",
    "/v1/capabilities",
    "/v1/documents",
    "/v1/document-artifacts/invalid/original",
    "/v1/exports/invalid",
  ]) {
    expect((await rest(f.t, f.key.secretOnce, path)).response.status).toBe(429);
  }
  expect(await rows()).toEqual(before);
  expect(log).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 999);
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(429);
  vi.setSystemTime(Date.now() + 1);
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(200);
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(429);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.key.keyId, { revokedAt: Date.now() }));
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(401);
});

it("compartilha o limite entre chaves e projetos, com concorrência e isolamento organizacional", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = await projectFixture();
  const project = await f.owner.client.mutation(api.projects.create, {
    organizationId: f.scope.organizationId,
    name: "Outro projeto",
    externalReference: "second",
  });
  await f.owner.client.mutation(api.projects.grantCompany, {
    organizationId: f.scope.organizationId,
    projectId: project.projectId,
    companyId: f.scope.companyId,
    scopes: ["companies:read"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const second = await f.owner.client.action(api.keys.create, {
    ...f.keyArgs,
    projectId: project.projectId,
  });
  const third = await f.owner.client.action(api.keys.create, f.keyArgs);
  const other = await projectFixture(f.t);
  const burst = async (secret: string, count: number) =>
    Promise.all(Array.from({ length: count }, () => rest(f.t, secret)));
  const first = await burst(f.key.secretOnce, 65);
  expect(first.filter((r) => r.response.status === 200)).toHaveLength(60);
  expect(first.filter((r) => r.response.status === 429)).toHaveLength(5);
  // Refusals from the first key must not consume the remaining organization budget.
  const next = await burst(second.secretOnce, 60);
  expect(next.every((r) => r.response.status === 200)).toBe(true);
  expect((await rest(f.t, third.secretOnce)).response.status).toBe(429);
  expect((await rest(f.t, other.key.secretOnce)).response.status).toBe(200);
  vi.setSystemTime(Date.now() + 60_000);
  expect((await rest(f.t, third.secretOnce)).response.status).toBe(200);
  expect(
    (await rest(f.t, third.secretOnce, `/v1/companies/${other.scope.companyId}`)).response.status,
  ).toBe(404);
});

it("erros de escopo e parâmetros consomem o limite técnico sem depender de plano vigente", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = await projectFixture();
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Vencido",
    startsAt: 0,
    endsAt: 1,
    limits: { imports: 0, captures: 0, registry: 0, bytes: 0, deliveries: 0 },
    concurrency: 1,
    expectedVersion: 0,
    actor: "test",
    reason: "Plano sintético vencido",
  });
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(200);
  for (let i = 0; i < 59; i++)
    expect((await rest(f.t, f.key.secretOnce, "/v1/companies", "production")).response.status).toBe(
      403,
    );
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(429);
  const second = await f.owner.client.action(api.keys.create, f.keyArgs);
  for (let i = 0; i < 60; i++)
    expect(
      (await rest(f.t, second.secretOnce, "/v1/companies?limit=invalid")).response.status,
    ).toBe(400);
  expect((await rest(f.t, second.secretOnce)).response.status).toBe(429);
  expect(await f.t.run((ctx) => ctx.db.query("apiUsageEvents").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(0);
});

it("compacta recibos legados em lotes, preserva totais e não mistura organizações ou rotas", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const f = await projectFixture();
  const other = await projectFixture(f.t);
  const oldDay = "2026-08-30";
  const insert = async (
    owner: typeof f,
    count: number,
    day: string,
    route: "companies.list" | "companies.get",
  ) =>
    f.t.run(async (ctx) => {
      for (let i = 0; i < count; i++)
        await ctx.db.insert("apiUsageEvents", {
          organizationId: owner.scope.organizationId,
          projectId: owner.projectScope.projectId,
          keyId: owner.key.keyId,
          requestId: crypto.randomUUID(),
          route,
          environment: "sandbox",
          day,
          shard: i % 16,
          createdAt: Date.parse(`${day}T12:00:00Z`),
        });
    });
  await insert(f, 121, oldDay, "companies.list");
  await insert(f, 2, oldDay, "companies.get");
  await insert(other, 3, oldDay, "companies.list");
  await insert(f, 1, "2026-09-01", "companies.list");
  const beforeDomain = await f.t.run((ctx) => ctx.db.query("organizationAudit").collect());
  // No expiresAt or prior retention schedule is needed for these old receipts.
  const migration = await f.t.mutation(internal.telemetryRetention.backfillApiUsage, {
    cursor: null,
  });
  expect(migration).toEqual({ scanned: 100, isDone: false });
  const sweep = async () => {
    const job = await f.t.run((ctx) =>
      ctx.db
        .query("operationalRetention")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
        .unique(),
    );
    expect(job).not.toBeNull();
    vi.setSystemTime(Math.max(Date.now(), job!.nextAt));
    await f.t.mutation(internal.telemetryRetention.sweep, {
      organizationId: f.scope.organizationId,
      generation: job!.generation,
    });
    // A duplicate delivery of the old generation cannot compact twice.
    expect(
      await f.t.mutation(internal.telemetryRetention.sweep, {
        organizationId: f.scope.organizationId,
        generation: job!.generation,
      }),
    ).toBe(0);
  };
  await sweep();
  expect(await f.t.run((ctx) => ctx.db.query("apiUsageEvents").collect())).toHaveLength(77);
  await sweep();
  await sweep();
  const totals = await f.t.run((ctx) => ctx.db.query("apiUsageTotals").collect());
  expect(totals).toHaveLength(2);
  expect(totals.find((r) => r.route === "companies.list")).toMatchObject({
    count: 121,
    organizationId: f.scope.organizationId,
  });
  expect(totals.find((r) => r.route === "companies.get")).toMatchObject({
    count: 2,
    organizationId: f.scope.organizationId,
  });
  expect(await f.t.run((ctx) => ctx.db.query("apiUsageEvents").collect())).toHaveLength(4);
  expect(await f.t.run((ctx) => ctx.db.query("organizationAudit").collect())).toEqual(beforeDomain);
  const job = await f.t.run((ctx) =>
    ctx.db
      .query("operationalRetention")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
      .unique(),
  );
  expect(job?.nextAt).toBe(apiUsageExpiresAt("2026-09-01"));
  await sweep();
  expect(
    (await f.t.run((ctx) => ctx.db.query("apiUsageTotals").collect())).find(
      (r) => r.route === "companies.list",
    )?.count,
  ).toBe(122);
  expect(await f.t.run((ctx) => ctx.db.query("apiUsageTotals").collect())).toHaveLength(2);
  await f.t.mutation(internal.telemetryRetention.backfillApiUsage, { cursor: null });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const finalTotals = await f.t.run((ctx) => ctx.db.query("apiUsageTotals").collect());
  expect(finalTotals).toHaveLength(3);
  expect(finalTotals.find((r) => r.organizationId === other.scope.organizationId)?.count).toBe(3);
  expect(await f.t.run((ctx) => ctx.db.query("apiUsageEvents").collect())).toHaveLength(0);
  const remainingJobs = await f.t.run((ctx) => ctx.db.query("operationalRetention").collect());
  // Domain audit still needs its own 365-day deadline.
  expect(remainingJobs.every((job) => job.nextAt > Date.now() + 300 * 86_400_000)).toBe(true);
});
it("uma chave criada pela gestão reserva uma operação de importação e mantém a identidade após rotação", async () => {
  vi.useFakeTimers();
  const f = await projectFixture();
  const keyArgs = { ...f.keyArgs, scopes: ["documents:import" as const] };
  const key = await f.owner.client.action(api.keys.create, keyArgs);
  const request = {
    ...f.projectScope,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
    keyHash: await hashApiKey(key.secretOnce),
    key: "import-intent-68",
    request: JSON.stringify({ artifact: "synthetic-reservation-only" }),
    task: {
      name: "proof.import",
      workload: "import" as const,
      scope: "documents:import" as const,
      executor: "testing/operationTransport:execute",
      reconciler: "testing/operationTransport:reconcile",
      checkpoint: "testing/operationProof:checkpoint",
    },
  };
  const first = await f.t.mutation(internal.operations.reserve, request);
  expect(first.reused).toBe(false);
  const path = `/v1/operations/${first.operationId}`;
  expect((await rest(f.t, key.secretOnce, path)).response.status).toBe(200);
  expect((await rest(f.t, f.key.secretOnce, path)).response.status).toBe(403);
  const rotated = await f.owner.client.action(api.keys.rotate, {
    ...keyArgs,
    keyId: key.keyId,
    overlapMs: 0,
  });
  await expect(f.t.mutation(internal.operations.reserve, request)).rejects.toThrow(
    "INVALID_API_KEY",
  );
  expect((await rest(f.t, key.secretOnce, path)).response.status).toBe(401);
  expect(
    await f.t.mutation(internal.operations.reserve, {
      ...request,
      keyHash: await hashApiKey(rotated.secretOnce),
    }),
  ).toEqual({ operationId: first.operationId, reused: true });
  expect((await rest(f.t, rotated.secretOnce, path)).response.status).toBe(200);
  await f.owner.client.mutation(api.keys.revoke, { ...f.projectScope, keyId: rotated.keyId });
  expect((await rest(f.t, rotated.secretOnce, path)).response.status).toBe(401);
  expect(await f.t.run((ctx) => ctx.db.query("operations").take(10))).toHaveLength(1);
});

it("creates cryptographic secrets once and lists only safe metadata", async () => {
  const { t, owner, projectScope, key, keyArgs } = await projectFixture();
  const second = await owner.client.action(api.keys.create, keyArgs);
  expect(key.secretOnce).toMatch(/^fnfe_[A-Za-z0-9_-]{43}$/);
  expect(key.secretOnce).not.toBe(second.secretOnce);
  const stored = await t.run((ctx) => ctx.db.get("apiKeys", key.keyId));
  expect(stored?.keyHash).toBe(await hashApiKey(key.secretOnce));
  const list = await owner.client.query(api.keys.list, {
    ...projectScope,
    contextKey,
    paginationOpts,
  });
  const audit = await t.run((ctx) => ctx.db.query("integrationAudit").take(50));
  for (const artifact of [stored, list, audit])
    expect(JSON.stringify(artifact)).not.toContain(key.secretOnce);
  expect(JSON.stringify(list)).not.toContain(stored!.keyHash);
  expect(list.page[0]).not.toHaveProperty("_id");
});
it("authenticates real HTTP handlers, returns public DTOs and writes partitionable receipts", async () => {
  const { t, key, scope } = await projectFixture();
  const list = await rest(t, key.secretOnce);
  expect(list.response.status).toBe(200);
  expect(list.body.data).toEqual([
    {
      id: scope.companyId,
      name: input.name,
      cnpj: input.cnpj,
      kind: "declared",
      registryStatus: "not-consulted",
      fiscalAccess: "not-configured",
    },
  ]);
  const detail = await rest(t, key.secretOnce, `/v1/companies/${scope.companyId}`);
  expect(detail.body.data).toEqual(list.body.data[0]);
  const usage = await t.run((ctx) => ctx.db.query("apiUsageEvents").take(10));
  expect(usage).toHaveLength(2);
  expect(usage.every((e) => e.shard >= 0 && e.shard < 16)).toBe(true);
  expect(JSON.stringify(usage)).not.toContain(key.secretOnce);
  expect(JSON.stringify(usage)).not.toContain("keyHash");
});
it.each(["", "anything", "fnfe_short", `fnfe_${"x".repeat(43)}`])(
  "refuses absent/malformed/unknown key %s without internal errors",
  async (secret) => {
    const { t } = await projectFixture();
    const result = await rest(t, secret);
    expect(result.response.status).toBe(401);
    expect(result.body.error).toEqual({
      code: "INVALID_API_KEY",
      message: "Chave ausente, inválida ou expirada.",
      retryable: false,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/stack|Convex|_creationTime|keyHash/);
  },
);
it("refuses expiration at the exact server deadline and revocation on new calls", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  const { t, owner, key, keyArgs, projectScope } = await projectFixture();
  vi.setSystemTime(keyArgs.expiresAt - 1);
  expect((await rest(t, key.secretOnce)).response.status).toBe(200);
  vi.setSystemTime(keyArgs.expiresAt);
  expect((await rest(t, key.secretOnce)).response.status).toBe(401);
  vi.setSystemTime(keyArgs.expiresAt - 7 * 86400_000);
  const next = await owner.client.action(api.keys.create, {
    ...keyArgs,
    expiresAt: Date.now() + 3600_000,
  });
  await owner.client.mutation(api.keys.revoke, { ...projectScope, keyId: next.keyId });
  expect((await rest(t, next.secretOnce)).response.status).toBe(401);
});
it("isolates two organizations, projects and companies including forged IDs", async () => {
  const f = await projectFixture();
  const outsider = await member(f.t, f.scope.organizationId, "viewer");
  const otherOrg = await outsider.client.mutation(api.organizations.create, {
    name: "Outra equipe",
    slug: `other-${crypto.randomUUID()}`,
  });
  const otherCompany = await outsider.client.mutation(api.companies.create, {
    ...input,
    organizationId: otherOrg.organizationId,
  });
  const secondCompany = await f.owner.client.mutation(api.companies.create, {
    ...input,
    cnpj: "12ABC34501DE35",
    name: "Outra empresa",
    organizationId: f.scope.organizationId,
  });
  for (const id of [
    otherCompany.companyId,
    secondCompany.companyId,
    "forged",
    f.projectScope.projectId,
  ])
    expect((await rest(f.t, f.key.secretOnce, `/v1/companies/${id}`)).response.status).toBe(404);
  await expect(
    f.owner.client.action(api.keys.create, { ...f.keyArgs, companyIds: [otherCompany.companyId] }),
  ).rejects.toThrow();
  await expect(
    f.owner.client.mutation(api.projects.grantCompany, {
      ...f.projectScope,
      companyId: otherCompany.companyId,
      scopes: ["companies:read"],
      environments: ["sandbox"],
      expectedVersion: 0,
    }),
  ).rejects.toThrow();
  for (const client of [f.t, outsider.client]) {
    await expect(
      client.query(api.projects.list, {
        organizationId: f.scope.organizationId,
        contextKey,
        paginationOpts,
      }),
    ).rejects.toThrow();
    await expect(
      client.query(api.keys.list, { ...f.projectScope, contextKey, paginationOpts }),
    ).rejects.toThrow();
    await expect(client.action(api.keys.create, f.keyArgs)).rejects.toThrow();
    await expect(
      client.mutation(api.keys.revoke, { ...f.projectScope, keyId: f.key.keyId }),
    ).rejects.toThrow();
  }
  const otherProject = await f.owner.client.mutation(api.projects.create, {
    organizationId: f.scope.organizationId,
    name: "Outro",
    externalReference: "other",
  });
  await expect(
    f.owner.client.mutation(api.keys.revoke, {
      ...f.projectScope,
      projectId: otherProject.projectId,
      keyId: f.key.keyId,
    }),
  ).rejects.toThrow();
});
it("separates scope and product environment without enabling production fiscal access", async () => {
  const { t, owner, key, keyArgs } = await projectFixture();
  for (const env of ["", "production", "homologation", "forged"])
    expect((await rest(t, key.secretOnce, "/v1/companies", env)).response.status).toBe(403);
  // The hosted sandbox issues no production key for a company without the fiscal capture
  // released (ADR 0007); one that predates the rule is still refused by REST.
  await expect(
    owner.client.action(api.keys.create, { ...keyArgs, environment: "production" }),
  ).rejects.toThrow("ENVIRONMENT_DENIED");
  const production = await owner.client.action(api.keys.create, keyArgs);
  await t.run((ctx) => ctx.db.patch("apiKeys", production.keyId, { environment: "production" }));
  expect((await rest(t, production.secretOnce, "/v1/companies", "sandbox")).response.status).toBe(
    403,
  );
  expect(
    (await rest(t, production.secretOnce, "/v1/companies", "production")).response.status,
  ).toBe(403);
  const limited = await owner.client.action(api.keys.create, {
    ...keyArgs,
    scopes: ["documents:read"],
  });
  expect((await rest(t, limited.secretOnce)).response.status).toBe(403);
});
it("informa ao painel o único ambiente do deployment, só para quem gere o projeto", async () => {
  const { t, owner, org, projectScope } = await projectFixture();
  const args = { ...projectScope, projectId: projectScope.projectId as string, contextKey };
  const project = await owner.client.query(api.projects.get, args);
  // The console offers only this environment; REST refuses keys for any other (test above).
  expect(project?.deploymentEnvironment).toBe("sandbox");
  const viewer = await member(t, org.organizationId, "viewer");
  await expect(viewer.client.query(api.projects.get, args)).rejects.toThrow();
  const outsider = await actor(t);
  await expect(outsider.client.query(api.projects.get, args)).rejects.toThrow();
  const developer = await member(t, org.organizationId, "developer");
  // A developer outside the project's creator sees nothing, not even the environment.
  expect(await developer.client.query(api.projects.get, args)).toBeNull();
});
it("informa o tipo de cada empresa concedida só a quem já lê as concessões do projeto", async () => {
  const { t, owner, org, scope, projectScope } = await projectFixture();
  const { companyId: demo } = await owner.client.mutation(api.onboarding.start, {
    organizationId: scope.organizationId,
    mode: "demonstration",
    expectedVersion: 1,
  });
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: demo!,
    scopes: ["documents:import", "documents:read"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const args = { ...projectScope, contextKey, paginationOpts };
  const listed = await owner.client.query(api.projects.companies, args);
  expect(Object.fromEntries(listed.page.map((g) => [g.companyId, g.kind]))).toEqual({
    [scope.companyId]: "declared",
    [demo!]: "demonstration",
  });
  // No new reader: the same refusals as before the field existed.
  const viewer = await member(t, org.organizationId, "viewer");
  await expect(viewer.client.query(api.projects.companies, args)).rejects.toThrow();
  await expect((await actor(t)).client.query(api.projects.companies, args)).rejects.toThrow();
  const developer = await member(t, org.organizationId, "developer");
  await expect(developer.client.query(api.projects.companies, args)).rejects.toThrow();
  // The owner of another organization gets nothing for this project, under either organization.
  const other = await fixture(t);
  await expect(
    other.owner.client.query(api.projects.companies, {
      ...args,
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow();
  await expect(other.owner.client.query(api.projects.companies, args)).rejects.toThrow();
  // A developer's own project lists only the companies the developer can see, kind included.
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: developer.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  const own = await developer.client.mutation(api.projects.create, {
    organizationId: scope.organizationId,
    name: "Developer",
    externalReference: "dev-kind",
  });
  const ownScope = { organizationId: scope.organizationId, projectId: own.projectId };
  for (const [companyId, expectedVersion] of [
    [scope.companyId, 0],
    [demo!, 0],
  ] as const)
    await owner.client.mutation(api.projects.grantCompany, {
      ...ownScope,
      companyId,
      scopes: ["documents:read"],
      environments: ["sandbox"],
      expectedVersion,
    });
  const seen = await developer.client.query(api.projects.companies, {
    ...ownScope,
    contextKey,
    paginationOpts,
  });
  expect(seen.page.map((g) => [g.companyId, g.kind])).toEqual([[scope.companyId, "declared"]]);
});
it("bounds pagination and refuses a cursor copied from another project key", async () => {
  const { t, owner, scope, projectScope, keyArgs } = await projectFixture();
  const second = await owner.client.mutation(api.companies.create, {
    ...input,
    organizationId: scope.organizationId,
    cnpj: "12ABC34501DE35",
  });
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: second.companyId,
    scopes: ["companies:read"],
    environments: ["sandbox"],
    expectedVersion: 0,
  });
  const args = { ...keyArgs, companyIds: [scope.companyId, second.companyId] };
  const key = await owner.client.action(api.keys.create, args),
    other = await owner.client.action(api.keys.create, args);
  const first = await rest(t, key.secretOnce, "/v1/companies?limit=1");
  expect(first.body.data).toHaveLength(1);
  const path = `/v1/companies?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`;
  expect((await rest(t, key.secretOnce, path)).body.data[0].id).toBe(second.companyId);
  expect((await rest(t, other.secretOnce, path)).response.status).toBe(400);
  for (const query of [
    "limit=0",
    "limit=51",
    "limit=1.5",
    "limit=2&limit=3",
    "cursor=garbage",
    "organizationId=other",
    "limit=",
  ])
    expect((await rest(t, key.secretOnce, `/v1/companies?${query}`)).response.status).toBe(400);
});
it("rotation coexists only until the approved deadline and cannot rotate the predecessor twice", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  const { t, owner, key, keyArgs } = await projectFixture();
  const rotationArgs = { ...keyArgs, keyId: key.keyId, overlapMs: 3600_000 };
  const next = await owner.client.action(api.keys.rotate, rotationArgs);
  expect((await rest(t, key.secretOnce)).response.status).toBe(200);
  expect((await rest(t, next.secretOnce)).response.status).toBe(200);
  await expect(owner.client.action(api.keys.rotate, rotationArgs)).rejects.toThrow(
    "KEY_UNAVAILABLE",
  );
  vi.setSystemTime(Date.now() + 3600_000);
  expect((await rest(t, key.secretOnce)).response.status).toBe(401);
  expect((await rest(t, next.secretOnce)).response.status).toBe(200);
});
it("rotation with zero overlap immediately blocks the predecessor", async () => {
  const { t, owner, key, keyArgs } = await projectFixture();
  const next = await owner.client.action(api.keys.rotate, {
    ...keyArgs,
    keyId: key.keyId,
    overlapMs: 0,
  });
  expect((await rest(t, key.secretOnce)).response.status).toBe(401);
  expect((await rest(t, next.secretOnce)).response.status).toBe(200);
});
it("caps overlap at original expiration and refuses escalation or excessive windows", async () => {
  const { t, owner, keyArgs } = await projectFixture();
  const args = { ...keyArgs, expiresAt: Date.now() + 60_000 };
  const key = await owner.client.action(api.keys.create, args);
  for (const overrides of [
    { overlapMs: 86400_001 },
    { overlapMs: -1 },
    { overlapMs: 0.5 },
    { scopes: ["documents:import" as const] },
    { environment: "production" as const },
    { expiresAt: args.expiresAt + 1 },
  ])
    await expect(
      owner.client.action(api.keys.rotate, {
        ...args,
        keyId: key.keyId,
        overlapMs: 0,
        ...overrides,
      }),
    ).rejects.toThrow();
  await owner.client.action(api.keys.rotate, { ...args, keyId: key.keyId, overlapMs: 86400_000 });
  expect((await t.run((ctx) => ctx.db.get("apiKeys", key.keyId)))!.expiresAt).toBe(args.expiresAt);
});
it("reuses the fiscal proof project after losing its creation response", async () => {
  const { t, owner, scope } = await fixture();
  const args = {
    organizationId: scope.organizationId,
    name: "Consulta manual NF-e",
    externalReference: "issue-50",
  };
  // The first response was not saved by the runner.
  await owner.client.mutation(api.projects.create, args);
  const recovered = await owner.client.mutation(api.projects.create, args);
  expect(recovered.reused).toBe(true);
  const projects = await t.run((ctx) => ctx.db.query("projects").collect());
  expect(projects).toHaveLength(1);
  expect(projects[0]!._id).toBe(recovered.projectId);
  await expect(
    owner.client.mutation(api.projects.create, { ...args, name: "Different" }),
  ).rejects.toThrow("PROJECT_CONFLICT");
});

it("serializes concurrent rotation and project reference reservation", async () => {
  const { owner, key, keyArgs, projectScope } = await projectFixture();
  const rotations = await Promise.allSettled(
    [1, 2].map(() =>
      owner.client.action(api.keys.rotate, { ...keyArgs, keyId: key.keyId, overlapMs: 0 }),
    ),
  );
  expect(rotations.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const projects = await Promise.all(
    [1, 2].map(() =>
      owner.client.mutation(api.projects.create, {
        organizationId: projectScope.organizationId,
        name: "Concurrent",
        externalReference: "concurrent",
      }),
    ),
  );
  expect(projects[0]!.projectId).toBe(projects[1]!.projectId);
});
it("grant revocation and project disablement do not revive old keys on reactivation", async () => {
  const { t, owner, scope, key, keyArgs, projectScope } = await projectFixture();
  await owner.client.mutation(api.projects.revokeCompany, {
    ...projectScope,
    companyId: scope.companyId,
    expectedVersion: 1,
  });
  expect((await rest(t, key.secretOnce, `/v1/companies/${scope.companyId}`)).response.status).toBe(
    404,
  );
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: scope.companyId,
    scopes: ["companies:read"],
    environments: ["sandbox"],
    expectedVersion: 2,
  });
  expect((await rest(t, key.secretOnce, `/v1/companies/${scope.companyId}`)).response.status).toBe(
    404,
  );
  await expect(
    owner.client.action(api.keys.rotate, { ...keyArgs, keyId: key.keyId, overlapMs: 0 }),
  ).rejects.toThrow("GRANT_DENIED");
  const next = await owner.client.action(api.keys.create, keyArgs);
  expect((await rest(t, next.secretOnce)).response.status).toBe(200);
  await owner.client.mutation(api.projects.update, {
    ...projectScope,
    name: "Disabled",
    state: "disabled",
    expectedVersion: 1,
  });
  expect((await rest(t, next.secretOnce)).response.status).toBe(401);
  await owner.client.mutation(api.projects.update, {
    ...projectScope,
    name: "Active",
    state: "active",
    expectedVersion: 2,
  });
  expect((await rest(t, next.secretOnce)).response.status).toBe(401);
  const listed = await owner.client.query(api.keys.list, {
    ...projectScope,
    contextKey,
    paginationOpts,
  });
  expect(listed.page.every((k) => k.projectInvalidated)).toBe(true);
});
it("a developer only delegates granted companies and role scopes, not another developer's project", async () => {
  const { t, owner, scope, projectScope } = await projectFixture();
  const developer = await member(t, scope.organizationId, "developer");
  const project = await developer.client.mutation(api.projects.create, {
    organizationId: scope.organizationId,
    name: "Developer",
    externalReference: "dev",
  });
  const grantArgs = {
    organizationId: scope.organizationId,
    projectId: project.projectId,
    companyId: scope.companyId,
    scopes: ["companies:read" as const],
    environments: ["sandbox" as const],
    expectedVersion: 0,
  };
  await expect(developer.client.mutation(api.projects.grantCompany, grantArgs)).rejects.toThrow();
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: developer.membershipId,
    allowed: true,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 0,
  });
  await developer.client.mutation(api.projects.grantCompany, grantArgs);
  await expect(
    developer.client.mutation(api.projects.grantCompany, {
      ...grantArgs,
      expectedVersion: 1,
      scopes: ["documents:import"],
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  await expect(
    developer.client.query(api.keys.list, { ...projectScope, contextKey, paginationOpts }),
  ).rejects.toThrow();
  const args = {
    organizationId: scope.organizationId,
    projectId: project.projectId,
    name: "Developer",
    companyIds: [scope.companyId],
    scopes: ["companies:read" as const],
    environment: "sandbox" as const,
    expiresAt: Date.now() + 3600_000,
  };
  const key = await developer.client.action(api.keys.create, args);
  await owner.client.mutation(api.companies.setGrant, {
    ...scope,
    membershipId: developer.membershipId,
    allowed: false,
    expectedMembershipVersion: 1,
    expectedGrantVersion: 1,
  });
  await expect(developer.client.action(api.keys.create, args)).rejects.toThrow();
  // The credential belongs to the organization/project, independently of a human session.
  expect((await rest(t, key.secretOnce)).response.status).toBe(200);
  await t.run((ctx) =>
    ctx.db.patch("memberships", developer.membershipId, {
      state: "removed",
      companyAccessEpoch: 1,
    }),
  );
  await expect(
    developer.client.query(api.projects.list, {
      organizationId: scope.organizationId,
      contextKey,
      paginationOpts,
    }),
  ).rejects.toThrow();
});
it("current grant reductions apply to existing keys, and empty or malformed permissions fail", async () => {
  const { t, owner, scope, key, keyArgs, projectScope } = await projectFixture();
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: scope.companyId,
    scopes: ["documents:read"],
    environments: ["sandbox"],
    expectedVersion: 1,
  });
  expect((await rest(t, key.secretOnce)).body.data).toEqual([]);
  for (const overrides of [
    { scopes: [] },
    { companyIds: [] },
    { expiresAt: Date.now() - 1 },
    { companyIds: [scope.companyId, scope.companyId] },
  ])
    await expect(
      owner.client.action(api.keys.create, { ...keyArgs, ...overrides }),
    ).rejects.toThrow();
});
it("deduplicates usage by server requestId without changing the key row", async () => {
  const { t, key, scope } = await projectFixture();
  const before = await t.run((ctx) => ctx.db.get("apiKeys", key.keyId));
  const args = {
    keyHash: await hashApiKey(key.secretOnce),
    requestId: crypto.randomUUID(),
    environment: "sandbox",
    companyId: scope.companyId,
    cursor: null,
    limit: 20,
  };
  await t.mutation(internal.rest.companies, args);
  await t.mutation(internal.rest.companies, args);
  expect(await t.run((ctx) => ctx.db.query("apiUsageEvents").take(10))).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.get("apiKeys", key.keyId))).toEqual(before);
});

it("lists current grant changes so rotation never starts with hidden, ineligible companies", async () => {
  const { owner, scope, keyArgs, key, projectScope } = await projectFixture();
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: scope.companyId,
    scopes: ["documents:read"],
    environments: ["sandbox"],
    expectedVersion: 1,
  });
  const reduced = await owner.client.query(api.keys.list, {
    ...projectScope,
    contextKey,
    paginationOpts,
  });
  expect(reduced.page[0]).toMatchObject({
    concessionsChanged: true,
    currentCompanyIds: [scope.companyId],
    rotationAvailable: false,
  });
  await owner.client.mutation(api.projects.revokeCompany, {
    ...projectScope,
    companyId: scope.companyId,
    expectedVersion: 2,
  });
  await owner.client.mutation(api.projects.grantCompany, {
    ...projectScope,
    companyId: scope.companyId,
    scopes: ["companies:read"],
    environments: ["sandbox"],
    expectedVersion: 3,
  });
  const invalidated = await owner.client.query(api.keys.list, {
    ...projectScope,
    contextKey,
    paginationOpts,
  });
  expect(invalidated.page[0]).toMatchObject({
    concessionsChanged: true,
    currentCompanyIds: [],
    rotationAvailable: false,
  });
  await expect(
    owner.client.action(api.keys.rotate, { ...keyArgs, keyId: key.keyId, overlapMs: 0 }),
  ).rejects.toThrow("GRANT_DENIED");
});
it.each(["owner", "admin", "developer", "operator", "viewer"] as const)(
  "enforces direct project/key management for role %s",
  async (role) => {
    const { t, owner, scope } = await fixture();
    const person = await member(t, scope.organizationId, role);
    const args = {
      organizationId: scope.organizationId,
      name: "Role project",
      externalReference: role,
    };
    if (role === "operator" || role === "viewer") {
      await expect(person.client.mutation(api.projects.create, args)).rejects.toThrow();
      return;
    }
    if (role === "developer")
      await owner.client.mutation(api.companies.setGrant, {
        ...scope,
        membershipId: person.membershipId,
        allowed: true,
        expectedMembershipVersion: 1,
        expectedGrantVersion: 0,
      });
    const project = await person.client.mutation(api.projects.create, args);
    const projectScope = { organizationId: scope.organizationId, projectId: project.projectId };
    await person.client.mutation(api.projects.grantCompany, {
      ...projectScope,
      companyId: scope.companyId,
      scopes: ["companies:read"],
      environments: ["sandbox"],
      expectedVersion: 0,
    });
    const key = await person.client.action(api.keys.create, {
      ...projectScope,
      companyIds: [scope.companyId],
      scopes: ["companies:read"],
      environment: "sandbox",
      name: "Role key",
      expiresAt: Date.now() + 3600_000,
    });
    expect((await rest(t, key.secretOnce)).response.status).toBe(200);
  },
);
it("grava data, hora e IP das chamadas pelo endereço público e recusa assinatura forjada", async () => {
  const f = await projectFixture();
  const records = () => f.t.run((ctx) => ctx.db.query("accessRecords").collect());
  const signed = async (ip: string, secret: string, path = "/v1/companies") => {
    const headers = await signApiRequest(
      { method: "GET", url: `https://backend.example.invalid${path}` },
      ip,
      secret,
    );
    return f.t.fetch(path, {
      headers: {
        Authorization: `Bearer ${f.key.secretOnce}`,
        "X-Environment": "sandbox",
        ...headers,
      },
    });
  };
  // Signature present without a configured proxy is never trusted.
  expect((await signed("203.0.113.9", proxySecret)).status).toBe(400);
  vi.stubEnv("APP_ENV", "validation");
  vi.stubEnv("SITE_URL", "https://freecorpsnfe-validation.freecorps.workers.dev");
  vi.stubEnv("EMAIL_MODE", "disabled");
  vi.stubEnv("AUTH_PROXY_MODE", "signed");
  vi.stubEnv("AUTH_PROXY_SECRET", proxySecret);
  expect((await rest(f.t, f.key.secretOnce)).response.status).toBe(200);
  expect(await records()).toEqual([]);
  expect((await signed("203.0.113.9", proxySecret)).status).toBe(200);
  expect((await signed("203.0.113.9", proxySecret)).status).toBe(200);
  expect((await signed("203.0.113.9", "b".repeat(64))).status).toBe(400);
  const rows = await records();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: `key:${f.key.keyId}`, ip: "203.0.113.9" });
  expect(rows[0]!.userId).toBeUndefined();
  expect(rows[0]!.expiresAt - rows[0]!.at).toBe(184 * 86_400_000);
});
