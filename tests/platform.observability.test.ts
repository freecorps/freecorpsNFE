/// <reference types="vite/client" />
import { consoleProjectFor } from "./helpers/console";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, internal, components } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { recordAudit, DAY } from "../platform/convex/lib/operationalAudit";
import { defaultThresholds } from "../platform/convex/lib/operationalMetrics";
import { finishAttempt } from "../platform/convex/lib/operationCore";
const modules = import.meta.glob("../platform/convex/**/*.ts");
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  for (const [k, v] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5200",
    CONVEX_SITE_URL: "http://127.0.0.1:3259",
    BETTER_AUTH_SECRET: "synthetic-observability-secret-offline",
    FNFE_WEBHOOK_MASTER_KEY: "ab".repeat(32),
  }))
    vi.stubEnv(k, v);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${"a".repeat(43)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Teste",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
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
        expiresAt: now + DAY,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const ownerMembershipId = await t.run(async (ctx) => {
    const member = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", scope.organizationId).eq("state", "active"),
      )
      .first())!;
    await ctx.db.patch("memberships", member._id, { authUserId: user._id });
    return member._id;
  });
  const client = t.withIdentity({ subject: user._id, sessionId: session._id });
  const args = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  return { t, client, scope, args, secret, keyHash, ownerMembershipId };
}
async function monitor(f: Awaited<ReturnType<typeof fixture>>) {
  return f.client.mutation(api.observability.configure, {
    ...f.args,
    ownerMembershipId: f.ownerMembershipId,
    enabled: true,
    notify: true,
    thresholds: defaultThresholds,
    expectedGeneration: 0,
  });
}
async function evaluate(
  f: Awaited<ReturnType<typeof fixture>>,
  monitorId: Awaited<ReturnType<typeof monitor>>,
) {
  const row = await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId));
  await f.t.mutation(internal.observability.evaluate, { monitorId, generation: row!.generation });
}
it("limita amostras ao limiar, mantém alertas com contagem truncada e reavalia limiar maior", async () => {
  const f = await fixture(),
    id = await monitor(f),
    now = Date.now();
  const op = await f.t.mutation(internal.operations.reserve, {
    ...f.args,
    keyHash: f.keyHash,
    key: "bounded-signals",
    request: "{}",
    task: {
      name: "proof.import",
      scope: "documents:import",
      workload: "import",
      executor: "testing/operationTransport:execute",
    },
  });
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...template } = (await ctx.db.get("operations", op.operationId))!;
    void _id;
    void _creationTime;
    for (let i = 0; i < 120; i++) {
      await ctx.db.insert("operations", { ...template, state: "running", leaseUntil: now - 1 });
      for (const source of ["nfe-distribution", "opencnpj", "xml-processing", "other"])
        await ctx.db.insert("operationalFailures", {
          ...f.args,
          operationId: op.operationId,
          source,
          code: "SYNTHETIC",
          createdAt: now,
          expiresAt: now + DAY,
        });
    }
  });
  await evaluate(f, id);
  let row = (await f.t.run((ctx) => ctx.db.get("operationalMonitors", id)))!;
  expect(row.metrics.find((m) => m.kind === "lease")).toMatchObject({ value: 2, capped: true });
  expect(row.metrics.find((m) => m.kind === "source")?.sources).toEqual(
    ["nfe-distribution", "opencnpj", "xml-processing", "other"].map((source) => ({
      source,
      count: 4,
      capped: true,
    })),
  );
  await f.client.mutation(api.observability.configure, {
    ...f.args,
    ownerMembershipId: f.ownerMembershipId,
    enabled: true,
    notify: true,
    thresholds: { ...defaultThresholds, lease: 100, source: 100 },
    expectedGeneration: row.generation,
  });
  await evaluate(f, id);
  row = (await f.t.run((ctx) => ctx.db.get("operationalMonitors", id)))!;
  expect(row.metrics.find((m) => m.kind === "lease")).toMatchObject({ value: 101, capped: true });
  expect(row.metrics.find((m) => m.kind === "source")).toMatchObject({ value: 101, capped: true });
  const overview = await f.client.query(api.observability.overview, {
    organizationId: f.scope.organizationId,
    contextKey: "bounded",
  });
  expect(overview.alerts.map((a) => a.kind).sort()).toEqual(["lease", "source"]);
  expect(overview.notifications).toHaveLength(2);
});
it("auditoria indexada restringe organização, papel, período, ação e ator", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 70; i++)
      await recordAudit(ctx, {
        organizationId: f.scope.organizationId,
        actor: i % 2 ? "system" : "operator",
        action: "controlled.failure",
        target: `target-${i}`,
      });
  });
  const args = {
    organizationId: f.scope.organizationId,
    from: Date.now() - 1000,
    until: Date.now() + 1000,
    contextKey: "test",
    paginationOpts: { cursor: null, numItems: 1000 },
  };
  const page = await f.client.query(api.observability.audit, args);
  expect(page.page).toHaveLength(50);
  expect(page.isDone).toBe(false);
  const filtered = await f.client.query(api.observability.audit, {
    ...args,
    actor: "operator",
    action: "controlled.failure",
  });
  expect(filtered.page).toHaveLength(35);
  await expect(f.t.query(api.observability.audit, args)).rejects.toThrow();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: crypto.randomUUID(),
  });
  await expect(
    f.client.query(api.observability.audit, { ...args, organizationId: other.organizationId }),
  ).rejects.toThrow();
  for (const role of ["viewer", "operator", "developer"] as const) {
    await f.t.run((ctx) => ctx.db.patch("memberships", f.ownerMembershipId, { role }));
    await expect(f.client.query(api.observability.audit, args)).rejects.toThrow();
  }
});
it("nomes de ator, empresa e projeto se resolvem só dentro da organização do gestor", async () => {
  const f = await fixture();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other-names",
    suffix: crypto.randomUUID(),
  });
  const [own, foreign] = await f.t.run(async (ctx) => {
    const load = async (scope: typeof f.scope) => {
      const member = (await ctx.db
        .query("memberships")
        .withIndex("by_organizationId_and_state", (q) =>
          q.eq("organizationId", scope.organizationId).eq("state", "active"),
        )
        .first())!;
      return {
        member,
        key: (await ctx.db.get("apiKeys", scope.keyId))!,
        company: (await ctx.db.get("companies", scope.companyId))!,
        project: (await ctx.db.get("projects", scope.projectId))!,
      };
    };
    return [await load(f.scope), await load(other)];
  });
  const args = {
    organizationId: f.scope.organizationId,
    contextKey: "test",
    actors: [
      `membership:${own.member._id}`,
      `member:${own.member._id}`,
      `user:${own.member.authUserId}`,
      own.member._id,
      `key:${own.key._id}`,
      "system",
      `membership:${foreign.member._id}`,
      `user:${foreign.member.authUserId}`,
      foreign.member._id,
      `key:${foreign.key._id}`,
      "key:invalido",
    ],
    companyIds: [own.company._id, foreign.company._id, "invalido"],
    projectIds: [own.project._id, foreign.project._id],
  };
  const names = await f.client.query(api.observability.names, args);
  expect(names.actors).toEqual([
    { ref: `membership:${own.member._id}`, name: own.member.name },
    { ref: `member:${own.member._id}`, name: own.member.name },
    { ref: `user:${own.member.authUserId}`, name: own.member.name },
    { ref: own.member._id, name: own.member.name },
    { ref: `key:${own.key._id}`, name: own.key.name },
  ]);
  expect(names.companies).toEqual([{ ref: own.company._id, name: own.company.name }]);
  expect(names.projects).toEqual([{ ref: own.project._id, name: own.project.name }]);
  // Sem sessão, de outra organização ou sem papel de gestor, a resolução é recusada.
  await expect(f.t.query(api.observability.names, args)).rejects.toThrow();
  await expect(
    f.client.query(api.observability.names, { ...args, organizationId: other.organizationId }),
  ).rejects.toThrow();
  await expect(
    f.client.query(api.observability.names, {
      ...args,
      actors: Array.from({ length: 101 }, (_, i) => `system-${i}`),
    }),
  ).rejects.toThrow();
  for (const role of ["viewer", "operator", "developer"] as const) {
    await f.t.run((ctx) => ctx.db.patch("memberships", f.ownerMembershipId, { role }));
    await expect(f.client.query(api.observability.names, args)).rejects.toThrow();
  }
});
it("alerta abre, deduplica, recupera e limita reabertura; geração antiga não agenda outra cadeia", async () => {
  const f = await fixture(),
    id = await monitor(f);
  const operationId = await f.t.run((ctx) =>
    ctx.db.insert("operations", {
      ...f.args,
      task: {
        name: "synthetic",
        workload: "import",
        scope: "documents:import",
        executor: "synthetic",
      },
      request: "secret-xml-not-for-logs",
      requestHash: "hash",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "queued",
      stage: "ready",
      generation: 1,
      fence: 0,
      attempts: 0,
      maxAttempts: 6,
      leaseUntil: 0,
      nextAttemptAt: Date.now() - 600_000,
      backoffMs: 0,
      jitterMs: 0,
      uncertain: false,
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now(),
    }),
  );
  await evaluate(f, id);
  await evaluate(f, id);
  let overview = await f.client.query(api.observability.overview, {
    organizationId: f.scope.organizationId,
    contextKey: "test",
  });
  expect(overview.alerts).toHaveLength(1);
  expect(overview.notifications).toHaveLength(1);
  expect(overview.alerts[0].kind).toBe("queue");
  const generation = overview.monitors[0].generation;
  await f.t.mutation(internal.observability.evaluate, { monitorId: id, generation: 1 });
  expect((await f.t.run((ctx) => ctx.db.get("operationalMonitors", id)))!.generation).toBe(
    generation,
  );
  await f.t.run((ctx) => ctx.db.patch("operations", operationId, { state: "succeeded" }));
  await evaluate(f, id);
  overview = await f.client.query(api.observability.overview, {
    organizationId: f.scope.organizationId,
    contextKey: "test",
  });
  expect(overview.alerts).toHaveLength(0);
  expect(overview.notifications).toHaveLength(2);
  await f.t.run((ctx) => ctx.db.patch("operations", operationId, { state: "queued" }));
  await evaluate(f, id);
  overview = await f.client.query(api.observability.overview, {
    organizationId: f.scope.organizationId,
    contextKey: "test",
  });
  expect(overview.alerts).toHaveLength(1);
  expect(overview.notifications).toHaveLength(2);
  expect(JSON.stringify(overview)).not.toContain("secret-xml");
  await f.t.run((ctx) => ctx.db.patch("operations", operationId, { state: "succeeded" }));
  await evaluate(f, id);
  expect(
    (
      await f.client.query(api.observability.overview, {
        organizationId: f.scope.organizationId,
        contextKey: "test",
      })
    ).notifications,
  ).toHaveLength(2);
  await f.t.run((ctx) => ctx.db.patch("operationalMonitors", id, { notify: false }));
  await f.t.run((ctx) => ctx.db.patch("operations", operationId, { state: "queued" }));
  await evaluate(f, id);
  overview = await f.client.query(api.observability.overview, {
    organizationId: f.scope.organizationId,
    contextKey: "test",
  });
  expect(overview.alerts).toHaveLength(1);
  expect(overview.notifications).toHaveLength(2);
  await f.t.run((ctx) => ctx.db.patch("memberships", f.ownerMembershipId, { state: "removed" }));
  await evaluate(f, id);
  expect((await f.t.run((ctx) => ctx.db.get("operationalMonitors", id)))!.enabled).toBe(false);
});
it("referência HTTP chega à operação sem copiar API key ou corpo de erro", async () => {
  const f = await fixture();
  const op = await f.t.mutation(internal.operations.reserve, {
    ...f.args,
    keyHash: f.keyHash,
    key: "synthetic",
    request: "{}",
    task: {
      name: "proof.import",
      workload: "import",
      scope: "documents:import",
      executor: "testing/operationTransport:execute",
    },
  });
  const response = await f.t.fetch(`/v1/operations/${op.operationId}`, {
    headers: {
      Authorization: `Bearer ${f.secret}`,
      "X-Environment": "sandbox",
      "X-Request-Id": "injected-secret",
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
  expect(body.requestId).not.toBe("injected-secret");
  const rows = await f.client.query(api.observability.investigate, {
    organizationId: f.scope.organizationId,
    reference: body.requestId,
    contextKey: "test",
  });
  expect(rows.some((r) => r.operationId === op.operationId && r.action.startsWith("http."))).toBe(
    true,
  );
  expect(rows.some((r) => r.action.startsWith("operation."))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(f.secret);
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(f.secret);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(
    (
      await f.t.fetch(`/v1/operations/${op.operationId}`, {
        headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" },
      })
    ).status,
  ).toBe(401);
});
it("limpeza de autenticação por lastRequest usa índice e conserva buckets recentes", async () => {
  const f = await fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 30; i++)
    await f.t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "rateLimit",
        data: { key: `synthetic-${i}`, count: 1, lastRequest: Date.now() - (i < 5 ? DAY : 0) },
      },
    });
  const result = await f.t.mutation(components.betterAuth.adapter.deleteMany, {
    input: {
      model: "rateLimit",
      where: [{ field: "lastRequest", operator: "lt", value: Date.now() - 60_000 }],
    },
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.count).toBe(5);
  expect(warn.mock.calls.flat().join(" ")).not.toContain("without an index");
  const recent = await f.t.query(components.betterAuth.adapter.findMany, {
    model: "rateLimit",
    paginationOpts: { cursor: null, numItems: 50 },
  });
  expect(recent.page).toHaveLength(25);
});
it("mede seis sinais, falhas por fonte e recuperação sem alterar cursor ou janela", async () => {
  const f = await fixture(),
    id = await monitor(f),
    now = Date.now();
  const op = await f.t.mutation(internal.operations.reserve, {
    ...f.args,
    keyHash: f.keyHash,
    key: "metrics",
    request: "{}",
    task: {
      name: "registry.lookup",
      workload: "import",
      scope: "documents:import",
      executor: "testing/operationTransport:execute",
    },
  });
  await f.t.run(async (ctx) => {
    const operation = (await ctx.db.get("operations", op.operationId))!;
    for (let i = 1; i <= 3; i++) {
      await ctx.db.insert("operationAttempts", {
        operationId: op.operationId,
        generation: i,
        fence: i,
        mode: "execute",
        startedAt: now,
      });
      await finishAttempt(ctx, { ...operation, generation: i, fence: i }, "SOURCE_UNAVAILABLE");
      await finishAttempt(ctx, { ...operation, generation: i, fence: i }, "SOURCE_UNAVAILABLE");
    }
    await ctx.db.patch("operations", operation._id, { state: "running", leaseUntil: now - 1 });
    const queued = { ...operation, nextAttemptAt: now - 600_000 };
    const { _id, _creationTime, ...fields } = queued;
    void _id;
    void _creationTime;
    await ctx.db.insert("operations", fields);
    await ctx.db.insert("captureStreams", {
      ...f.args,
      identity: "synthetic",
      service: "nfe-distribution",
      state: "active",
      version: 1,
      checkpoint: "000000000000005",
      mode: "distNSU",
      nextAllowedAt: now + DAY,
      received: 0,
      createdAt: now - 3 * 3_600_000,
    });
    const cert = await ctx.db.insert("certificates", {
      organizationId: f.args.organizationId,
      companyId: f.args.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic",
      membershipId: f.ownerMembershipId,
      membershipVersion: 1,
      envelopeRevision: 1,
      metadata: {
        fingerprint: "synthetic",
        subject: "synthetic",
        cnpj: "00000000000191",
        notBefore: now - DAY,
        notAfter: now + DAY,
      },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: f.args.organizationId,
      companyId: f.args.companyId,
      nextVersion: 2,
      activeId: cert,
    });
    const endpoint = await ctx.db.insert("webhookEndpoints", {
      ...f.args,
      name: "synthetic",
      url: "https://example.invalid",
      events: ["document.received"],
      active: true,
      version: 1,
      secretVersion: 1,
      secret: "synthetic-secret-not-for-support",
      projectEpoch: 0,
      grantEpoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    const event = await ctx.db.insert("outboxEvents", {
      organizationId: f.args.organizationId,
      companyId: f.args.companyId,
      environment: "sandbox",
      logicalKey: "synthetic",
      eventId: crypto.randomUUID(),
      type: "document.received",
      resourceType: "document",
      resourceId: "synthetic",
      resourceVersion: 1,
      body: "synthetic-private-payload",
      createdAt: now,
    });
    await ctx.db.insert("webhookDeliveries", {
      endpointId: endpoint,
      eventId: event,
      state: "queued",
      generation: 1,
      attempts: 0,
      resends: 0,
      cycleAttempts: 0,
      nextAttemptAt: now,
      leaseUntil: 0,
      createdAt: now - 1_800_000,
    });
  });
  await evaluate(f, id);
  const overview = await f.client.query(api.observability.overview, {
    organizationId: f.args.organizationId,
    contextKey: "test",
  });
  expect(overview.alerts.map((a) => a.kind).sort()).toEqual([
    "certificate",
    "cursor",
    "lease",
    "queue",
    "source",
    "webhook",
  ]);
  expect(overview.monitors[0].metrics.find((m) => m.kind === "source")?.sources).toContainEqual({
    source: "opencnpj",
    count: 3,
    capped: false,
  });
  expect(JSON.stringify(overview)).not.toContain("synthetic-secret");
  expect(JSON.stringify(overview)).not.toContain("synthetic-private-payload");
  const stream = await f.t.run((ctx) =>
    ctx.db
      .query("captureStreams")
      .withIndex("by_companyId_environment", (q) =>
        q.eq("companyId", f.args.companyId).eq("environment", "sandbox"),
      )
      .unique(),
  );
  expect(stream).toMatchObject({ checkpoint: "000000000000005", nextAllowedAt: now + DAY });
  await f.t.run(async (ctx) => {
    for (const op of await ctx.db.query("operations").collect())
      await ctx.db.patch("operations", op._id, { state: "succeeded" });
    await ctx.db.patch("captureStreams", stream!._id, { lastSuccessAt: now });
    for (const sample of await ctx.db.query("operationalFailures").collect())
      await ctx.db.delete("operationalFailures", sample._id);
    for (const delivery of await ctx.db.query("webhookDeliveries").collect())
      await ctx.db.patch("webhookDeliveries", delivery._id, { state: "delivered" });
    for (const cert of await ctx.db.query("certificates").collect())
      await ctx.db.patch("certificates", cert._id, {
        metadata: { ...cert.metadata!, notAfter: now + 90 * DAY },
      });
  });
  await evaluate(f, id);
  const recovered = await f.client.query(api.observability.overview, {
    organizationId: f.args.organizationId,
    contextKey: "test",
  });
  expect(recovered.alerts).toHaveLength(0);
  expect(recovered.notifications.filter((n) => n.transition === "recovered")).toHaveLength(6);
});
it("retém histórico de domínio e expurga apenas telemetria vencida em lotes", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 60; i++)
      await recordAudit(ctx, {
        organizationId: f.args.organizationId,
        actor: "system",
        action: "http.controlled",
        target: `test-${i}`,
      });
    await recordAudit(ctx, {
      organizationId: f.args.organizationId,
      actor: "system",
      action: "operation.controlled",
      target: "domain",
    });
  });
  vi.setSystemTime(Date.now() + 31 * DAY);
  const job = (await f.t.run((ctx) =>
    ctx.db
      .query("operationalRetention")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.args.organizationId))
      .unique(),
  ))!;
  expect(
    await f.t.mutation(internal.telemetryRetention.sweep, {
      organizationId: f.args.organizationId,
      generation: job.generation,
    }),
  ).toBe(50);
  const remaining = await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_createdAt", (q) =>
        q.eq("organizationId", f.args.organizationId),
      )
      .take(100),
  );
  expect(remaining).toHaveLength(11);
  expect(remaining.some((r) => r.target === "domain")).toBe(true);
  expect(await f.t.run((ctx) => ctx.db.get("organizations", f.args.organizationId))).not.toBeNull();
});
it("suporte não retorna resposta da operação e recusa escopos forjados e preferências inválidas", async () => {
  const f = await fixture();
  const op = await f.t.mutation(internal.operations.reserve, {
    ...f.args,
    keyHash: f.keyHash,
    key: "support",
    request: "{}",
    task: {
      name: "proof.import",
      workload: "import",
      scope: "documents:import",
      executor: "testing/operationTransport:execute",
    },
  });
  await f.t.run((ctx) =>
    ctx.db.patch("operations", op.operationId, {
      state: "succeeded",
      response: "private-xml-body",
    }),
  );
  expect(
    await f.client.query(api.observability.operation, {
      organizationId: f.args.organizationId,
      operationId: op.operationId,
    }),
  ).not.toHaveProperty("result");
  const foreign = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "foreign",
    suffix: crypto.randomUUID(),
  });
  const a = {
    ...f.args,
    ownerMembershipId: f.ownerMembershipId,
    enabled: true,
    notify: true,
    thresholds: defaultThresholds,
    expectedGeneration: 0,
  };
  await expect(
    f.client.mutation(api.observability.configure, { ...a, companyId: foreign.companyId }),
  ).rejects.toThrow();
  await expect(
    f.client.mutation(api.observability.configure, {
      ...a,
      thresholds: { ...defaultThresholds, source: 101 },
    }),
  ).rejects.toThrow();
  await expect(
    f.client.query(api.observability.operation, {
      organizationId: foreign.organizationId,
      operationId: op.operationId,
    }),
  ).rejects.toThrow();
});

it("captura e erros de transportes binários preservam a referência estruturada", async () => {
  const f = await fixture();
  for (const [path, method] of [
    [`/v1/connections/nfe?companyId=${f.scope.companyId}`, "GET"],
    ["/v1/import-upload", "POST"],
    ["/v1/document-download", "GET"],
  ]) {
    const response = await f.t.fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${f.secret}`,
        "X-Environment": "sandbox",
        "X-Request-Id": "injected",
      },
    });
    const body = await response.json();
    expect(body.requestId).toBe(response.headers.get("X-Request-Id"));
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      vi
        .mocked(console.info)
        .mock.calls.some(([line]) => JSON.parse(String(line)).requestId === body.requestId),
    ).toBe(true);
  }
});
it("requisição de teste de webhook alcança evento e tentativas sem copiar segredo", async () => {
  const f = await fixture();
  const headers = {
    Authorization: `Bearer ${f.secret}`,
    "X-Environment": "sandbox",
    "Idempotency-Key": "observability-webhook",
  };
  const created = await f.t.fetch("/v1/webhook-endpoints", {
    method: "POST",
    headers,
    body: JSON.stringify({
      companyId: f.scope.companyId,
      name: "Sintético",
      url: "https://receiver.example.com/webhook",
      events: ["import.completed"],
    }),
  });
  expect(created.status).toBe(200);
  const endpoint = (await created.json()).data;
  const response = await f.t.fetch(`/v1/webhook-endpoints/${endpoint.endpoint.id}/test`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  vi.stubEnv("WEBHOOK_MODE", "https");
  const delivery = (await f.t.run((ctx) =>
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", endpoint.endpoint.id))
      .first(),
  ))!;
  const attempt = { deliveryId: delivery._id, generation: delivery.generation };
  expect(await f.t.mutation(internal.webhookDelivery.claim, attempt)).not.toBeNull();
  expect(
    await f.t.mutation(internal.webhookDelivery.outcome, {
      ...attempt,
      status: 503,
      durationMs: 5,
      code: "HTTP_RESPONSE",
    }),
  ).toBe(true);
  const rows = await f.client.query(api.observability.investigate, {
    organizationId: f.scope.organizationId,
    reference: body.requestId,
    contextKey: "test",
  });
  expect(rows.some((r) => r.requestId === body.requestId && r.eventId === body.data.eventId)).toBe(
    true,
  );
  expect(rows.some((r) => r.action === "webhook.attempt")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(endpoint.secret);
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(endpoint.secret);
});

it("remoção de monitor pausado libera o escopo e preserva auditoria com autorização", async () => {
  const f = await fixture(),
    id = await monitor(f);
  const args = { organizationId: f.args.organizationId, monitorId: id, expectedGeneration: 1 };
  await expect(f.client.mutation(api.observability.remove, args)).rejects.toThrow();
  await f.client.mutation(api.observability.configure, {
    ...f.args,
    ownerMembershipId: f.ownerMembershipId,
    enabled: false,
    notify: true,
    thresholds: defaultThresholds,
    expectedGeneration: 1,
  });
  await expect(
    f.t.mutation(api.observability.remove, { ...args, expectedGeneration: 2 }),
  ).rejects.toThrow();
  await expect(f.client.mutation(api.observability.remove, args)).rejects.toThrow();
  await f.client.mutation(api.observability.remove, { ...args, expectedGeneration: 2 });
  expect(await f.t.run((ctx) => ctx.db.get("operationalMonitors", id))).toBeNull();
  expect(await monitor(f)).not.toBe(id);
  const rows = await f.client.query(api.observability.investigate, {
    organizationId: f.args.organizationId,
    reference: id,
    contextKey: "test",
  });
  expect(rows.some((r) => r.action === "monitor.removed")).toBe(true);
});

it("pausa humana encerra tentativa sem contar indisponibilidade da fonte", async () => {
  const f = await fixture();
  // People pause only work of the console project.
  const op = await f.client.mutation(internal.operations.reserve, {
    ...f.args,
    projectId: await consoleProjectFor(f.t, f.scope.organizationId),
    key: "human-pause",
    request: "{}",
    task: {
      name: "registry.lookup",
      workload: "import",
      scope: "documents:import",
      executor: "testing/operationTransport:execute",
    },
  });
  expect(
    await f.t.mutation(internal.operations.claim, { operationId: op.operationId, generation: 1 }),
  ).not.toBeNull();
  await f.client.mutation(api.operations.control, {
    operationId: op.operationId,
    action: "pause",
    expectedGeneration: 1,
  });
  expect(await f.t.run((ctx) => ctx.db.query("operationalFailures").collect())).toEqual([]);
  const attempts = await f.t.run((ctx) => ctx.db.query("operationAttempts").collect());
  expect(attempts[0]).toMatchObject({ code: "PAUSED_BY_USER", finishedAt: expect.any(Number) });
});
