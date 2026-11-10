import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { internal, api, components } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { canonicalRequest, LEASE_MS, RECOVERY_BATCH } from "./lib/operationValues";
import { publicError } from "./lib/publicErrors";
import { modules } from "../../tests/helpers/convex-modules";
import {
  abandonBeforeEffect,
  patchOperationDomain,
  RESPONSE_LIMIT_BYTES,
  setResult,
} from "./lib/operationCore";
beforeEach(() => {
  vi.useFakeTimers();
  for (const [k, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-operations-secret",
  }))
    vi.stubEnv(k, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const task = {
  name: "proof.import",
  workload: "import" as const,
  scope: "documents:import" as const,
  executor: "testing/operationTransport:execute",
  reconciler: "testing/operationTransport:reconcile",
  checkpoint: "testing/operationProof:checkpoint",
};
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${"a".repeat(43)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const args = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: "sandbox" as const,
    keyHash,
    key: "request-1",
    request: '{"b":2,"a":1}',
    task,
  };
  const reserved = await t.mutation(internal.operations.reserve, args);
  return { t, scope, args, secret, ...reserved };
}
async function claim(f: Awaited<ReturnType<typeof fixture>>) {
  const value = (await f.t.mutation(internal.operations.claim, {
    operationId: f.operationId,
    generation: 1,
  }))!;
  return { operationId: f.operationId, generation: value.generation, fence: value.fence };
}
async function inspect(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.query(internal.testing.operationProof.inspect, { operationId: f.operationId });
}
async function due(f: Awaited<ReturnType<typeof fixture>>) {
  vi.setSystemTime(Date.now() + LEASE_MS + 1);
  await f.t.mutation(internal.operations.recoverOne, { operationId: f.operationId });
  const op = (await inspect(f)).operation!;
  vi.setSystemTime(op.nextAttemptAt);
  return f.t.mutation(internal.operations.claim, {
    operationId: f.operationId,
    generation: op.generation,
  });
}
it("reserva equivalente recupera a mesma operação; conteúdo divergente retorna conflito 409", async () => {
  const f = await fixture();
  expect(
    await f.t.mutation(internal.operations.reserve, { ...f.args, request: '{ "a":1, "b":2 }' }),
  ).toEqual({ operationId: f.operationId, reused: true });
  await expect(
    f.t.mutation(internal.operations.reserve, { ...f.args, request: '{"a":2}' }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(publicError(new ConvexError({ code: "IDEMPOTENCY_CONFLICT" })).status).toBe(409);
  expect((await f.t.run((ctx) => ctx.db.query("idempotencyRecords").take(10))).length).toBe(1);
});
it("distingue arrays, tipos e limites do JSON, incluindo chaves especiais", () => {
  expect(canonicalRequest('{"__proto__":1,"a":2}')).toBe('{"__proto__":1,"a":2}');
  expect(canonicalRequest("[1,2]")).not.toBe(canonicalRequest("[2,1]"));
  expect(canonicalRequest('"1"')).not.toBe(canonicalRequest("1"));
  expect(() => canonicalRequest("1e999")).toThrow();
  expect(() => canonicalRequest('"' + "a".repeat(33_000) + '"')).toThrow();
});
it("dois claims e agendamento duplicado têm um único vencedor", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.t.mutation(internal.operations.claim, { operationId: f.operationId, generation: 1 }),
    f.t.mutation(internal.operations.claim, { operationId: f.operationId, generation: 1 }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await inspect(f)).attempts).toHaveLength(1);
  await f.t.action(internal.operationWorker.run, { operationId: f.operationId, generation: 1 });
  expect((await inspect(f)).operation?.attempts).toBe(1);
});
it.each(["ready", "calling", "response", "checkpoint"] as const)(
  "retoma após falha na etapa %s sem duplicar documento/resultado/uso",
  async (stage) => {
    const f = await fixture(),
      old = await claim(f);
    if (stage !== "ready") await f.t.mutation(internal.operations.beginEffect, old);
    if (["response", "checkpoint"].includes(stage))
      await f.t.mutation(internal.operations.recordOutcome, {
        ...old,
        outcome: { kind: "success", response: '{"synthetic":true}' },
      });
    if (stage === "checkpoint") await f.t.mutation(internal.operations.checkpoint, old);
    const newer = (await due(f))!;
    const current = {
      operationId: f.operationId,
      generation: newer.generation,
      fence: newer.fence,
    };
    expect(newer.generation).toBe(2);
    expect(newer.uncertain).toBe(stage === "calling");
    expect(
      await f.t.mutation(internal.operations.recordOutcome, {
        ...old,
        outcome: { kind: "success", response: "late" },
      }),
    ).toBe(false);
    expect(await f.t.mutation(internal.operations.checkpoint, old)).toBe(false);
    expect(await f.t.mutation(internal.operations.publish, old)).toBe(false);
    if (["ready", "calling"].includes(stage)) {
      await f.t.mutation(internal.operations.beginEffect, current);
      await f.t.mutation(internal.operations.recordOutcome, {
        ...current,
        outcome: { kind: "success", response: '{"synthetic":true}' },
      });
    }
    if (stage !== "checkpoint") await f.t.mutation(internal.operations.checkpoint, current);
    expect(await f.t.mutation(internal.operations.publish, current)).toBe(true);
    expect(await f.t.mutation(internal.operations.publish, current)).toBe(false);
    const final = await inspect(f);
    expect(final.operation?.state).toBe("succeeded");
    expect(final.documents).toHaveLength(1);
    expect(final.receipts.map((r) => r.kind).sort()).toEqual(["result", "usage"]);
    await f.t.mutation(internal.operations.recoverOne, { operationId: f.operationId });
    expect((await inspect(f)).receipts).toHaveLength(2);
  },
);
it("lease vencida rejeita resposta mesmo antes de recuperar a geração", async () => {
  const f = await fixture(),
    old = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, old);
  vi.setSystemTime(Date.now() + LEASE_MS);
  expect(
    await f.t.mutation(internal.operations.recordOutcome, {
      ...old,
      outcome: { kind: "success", response: "late" },
    }),
  ).toBe(false);
});
it("falha da transação desfaz reserva, operação e agendamento juntos", async () => {
  const f = await fixture();
  await expect(
    f.t.run(async (ctx) => {
      await ctx.runMutation(internal.operations.reserve, { ...f.args, key: "rolled-back" });
      throw new Error("ROLLBACK_PROOF");
    }),
  ).rejects.toThrow("ROLLBACK_PROOF");
  expect(await f.t.run((ctx) => ctx.db.query("idempotencyRecords").take(10))).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("operations").take(10))).toHaveLength(1);
});
it("escrita parcial do checkpoint reverte e a resposta persistida continua disponível", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.run((ctx) =>
    ctx.db.patch("operations", f.operationId, {
      task: { ...task, checkpoint: "testing/operationProof:failCheckpoint" },
    }),
  );
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "persisted" },
  });
  await expect(f.t.mutation(internal.operations.checkpoint, token)).rejects.toThrow(
    "SYNTHETIC_CHECKPOINT_FAILURE",
  );
  const observed = await inspect(f);
  expect(observed.operation).toMatchObject({ stage: "response", response: "persisted" });
  expect(observed.documents).toHaveLength(0);
  expect(observed.receipts).toHaveLength(0);
});
it("publicação revertida não deixa evento ou consumo parcial", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "persisted" },
  });
  await f.t.mutation(internal.operations.checkpoint, token);
  await expect(
    f.t.run(async (ctx) => {
      await ctx.runMutation(internal.operations.publish, token);
      throw new Error("AFTER_PUBLICATION_ROLLBACK");
    }),
  ).rejects.toThrow("AFTER_PUBLICATION_ROLLBACK");
  const observed = await inspect(f);
  expect(observed.operation?.stage).toBe("checkpoint");
  expect(observed.receipts).toHaveLength(0);
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
});
it("chave revogada entre o checkpoint e a publicação pausa sem publicar, mesmo sem certificado", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "persisted" },
  });
  expect(await f.t.mutation(internal.operations.checkpoint, token)).toBe(true);
  expect((await inspect(f)).operation?.certificate).toBeUndefined();
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(false);
  const observed = await inspect(f);
  expect(observed.operation).toMatchObject({
    state: "paused",
    stage: "checkpoint",
    code: "ACCESS_REVOKED",
  });
  expect(observed.receipts).toHaveLength(0);
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(false);
});
it("mesma chave em outro projeto da organização reserva outra operação sem ampliar leitura", async () => {
  const f = await fixture();
  const otherHash = await hashApiKey(`fnfe_${"c".repeat(43)}`);
  const otherProject = await f.t.run(async (ctx) => {
    const project = (await ctx.db.get("projects", f.scope.projectId))!;
    const { _id, _creationTime, ...fields } = project;
    const projectId = await ctx.db.insert("projects", { ...fields, externalReference: "second" });
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const { _id: _keyId, _creationTime: _keyCreated, ...keyFields } = key;
    await ctx.db.insert("apiKeys", { ...keyFields, projectId, keyHash: otherHash });
    await ctx.db.insert("projectCompanies", {
      organizationId: f.scope.organizationId,
      projectId,
      companyId: f.scope.companyId,
      active: true,
      scopes: ["documents:import"],
      environments: ["sandbox"],
      version: 1,
      accessEpoch: 0,
    });
    return projectId;
  });
  const second = await f.t.mutation(internal.operations.reserve, {
    ...f.args,
    keyHash: otherHash,
    projectId: otherProject,
  });
  expect(second.operationId).not.toBe(f.operationId);
  await expect(
    f.t.mutation(internal.operationRest.access, {
      keyHash: otherHash,
      environment: "sandbox",
      id: f.operationId,
    }),
  ).rejects.toThrow("NOT_FOUND");
});
it("falha transitória e ausência na reconciliação nunca liberam nova execução", async () => {
  const f = await fixture(),
    initial = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, initial);
  let op = (await due(f))!;
  let token = { operationId: f.operationId, generation: op.generation, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "transient", code: "LOOKUP_UNAVAILABLE" },
  });
  op = (await inspect(f)).operation!;
  expect(op.uncertain).toBe(true);
  vi.setSystemTime(op.nextAttemptAt);
  op = (await f.t.mutation(internal.operations.claim, {
    operationId: f.operationId,
    generation: op.generation,
  }))!;
  token = { operationId: f.operationId, generation: op.generation, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "absent", code: "ABSENCE_CONFIRMED" },
  });
  expect((await inspect(f)).operation).toMatchObject({ state: "reconciling", uncertain: true });
});
it("janela exata usa scheduler antes de enfileirar e dispatch duplicado não duplica work", async () => {
  const f = await fixture(),
    token = await claim(f),
    notBefore = Date.now() + 3_600_037;
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "transient", code: "WINDOW", notBefore },
  });
  const op = (await inspect(f)).operation!;
  expect(op.workId).toBeUndefined();
  await f.t.mutation(internal.operations.dispatch, {
    operationId: f.operationId,
    generation: op.generation,
  });
  expect((await inspect(f)).operation?.workId).toBeUndefined();
  vi.setSystemTime(notBefore);
  await f.t.mutation(internal.operations.dispatch, {
    operationId: f.operationId,
    generation: op.generation,
  });
  const workId = (await inspect(f)).operation?.workId;
  expect(workId).toBeDefined();
  await f.t.mutation(internal.operations.dispatch, {
    operationId: f.operationId,
    generation: op.generation,
  });
  expect((await inspect(f)).operation?.workId).toBe(workId);
});
it("orçamento de recuperação limita falha persistente de checkpoint", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "saved" },
  });
  await f.t.run((ctx) => ctx.db.patch("operations", f.operationId, { recoveryAttempts: 12 }));
  expect(await due(f)).toBeNull();
  expect((await inspect(f)).operation).toMatchObject({
    state: "paused",
    code: "RECOVERY_BUDGET_EXHAUSTED",
    response: "saved",
  });
});
it("callback perdido é recuperado; callback duplicado não rouba lease vigente", async () => {
  const f = await fixture(),
    old = await claim(f),
    op = (await inspect(f)).operation!;
  await f.t.mutation(internal.operations.onComplete, {
    context: { operationId: f.operationId, generation: 1 },
    workId: op.workId!,
    result: { kind: "success", returnValue: null },
  });
  expect((await inspect(f)).operation?.generation).toBe(1);
  expect((await due(f))?.generation).toBe(2);
  expect(await f.t.mutation(internal.operations.beginEffect, old)).toBe(false);
});
it("resultado incerto sem reconciliador pausa e recusa retry manual", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.run((ctx) =>
    ctx.db.patch("operations", f.operationId, { task: { ...task, reconciler: undefined } }),
  );
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "uncertain", code: "TIMEOUT" },
  });
  const op = (await inspect(f)).operation!;
  expect(op.state).toBe("paused");
  expect(op.uncertain).toBe(true);
  await expect(
    f.t.mutation(internal.operationRest.access, {
      keyHash: f.args.keyHash,
      environment: "sandbox",
      id: f.operationId,
      action: "retry",
      expectedGeneration: op.generation,
    }),
  ).rejects.toThrow("RECONCILIATION_REQUIRED");
});
/** Paused uncertain operation that spent every attempt during `calling`, as observed on #197. */
async function exhaustedUncertain(f: Awaited<ReturnType<typeof fixture>>, recoveryAttempts = 5) {
  await claim(f);
  await f.t.run((ctx) =>
    ctx.db.patch("operations", f.operationId, {
      request: '{"url":"http://127.0.0.1:9/effect"}',
      state: "paused",
      stage: "calling",
      code: "RECONCILIATION_REQUIRED",
      generation: 7,
      attempts: 6,
      maxAttempts: 6,
      recoveryAttempts,
      uncertain: true,
      leaseUntil: 0,
      recoveryAt: undefined,
      workId: undefined,
    }),
  );
  return (await inspect(f)).operation!;
}
const retryByKey = (f: Awaited<ReturnType<typeof fixture>>, expectedGeneration: number) =>
  f.t.mutation(internal.operationRest.access, {
    keyHash: f.args.keyHash,
    environment: "sandbox",
    id: f.operationId,
    action: "retry",
    expectedGeneration,
  });
it("retomada de incerta esgotada com reconciliador concede uma reconciliação, sem executar", async () => {
  const f = await fixture(),
    paused = await exhaustedUncertain(f);
  const resumed = await retryByKey(f, paused.generation);
  expect(resumed).toMatchObject({ state: "reconciling", uncertain: true, attempts: 6 });
  let op = (await inspect(f)).operation!;
  expect(op).toMatchObject({
    state: "reconciling",
    stage: "ready",
    code: "MANUAL_RECONCILE",
    attempts: 6,
    maxAttempts: 7,
    recoveryAttempts: 6,
  });
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("operationAudit")
      .withIndex("by_operationId", (q) => q.eq("operationId", f.operationId))
      .collect(),
  );
  expect(audit.map((row) => row.action).slice(-2)).toEqual(["retry_requested", "MANUAL_RECONCILE"]);
  // The worker consults (GET) through the reconciler; the executor (POST) never runs.
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return new Response("", { status: 404 });
  });
  try {
    vi.setSystemTime(op.nextAttemptAt);
    await f.t.action(internal.operationWorker.run, {
      operationId: f.operationId,
      generation: op.generation,
    });
  } finally {
    vi.unstubAllGlobals();
  }
  expect(methods).toEqual(["GET"]);
  const attempts = (await inspect(f)).attempts;
  expect(attempts.at(-1)?.mode).toBe("reconcile");
  op = (await inspect(f)).operation!;
  // Absence observed by the reconciler keeps the uncertainty and pauses again: one grant per resumption.
  expect(op).toMatchObject({
    state: "paused",
    code: "RECONCILIATION_REQUIRED",
    uncertain: true,
    attempts: 7,
    maxAttempts: 7,
  });
  await expect(retryByKey(f, op.generation)).resolves.toMatchObject({ state: "reconciling" });
});
it("retomada de incerta esgotada sem reconciliador ou sem orçamento de recuperação é recusada", async () => {
  const f = await fixture(),
    paused = await exhaustedUncertain(f, 12);
  await expect(retryByKey(f, paused.generation)).rejects.toThrow("RECOVERY_BUDGET_EXHAUSTED");
  await f.t.run((ctx) =>
    ctx.db.patch("operations", f.operationId, {
      recoveryAttempts: 5,
      task: { ...task, reconciler: undefined },
    }),
  );
  await expect(retryByKey(f, paused.generation)).rejects.toThrow("RECONCILIATION_REQUIRED");
  expect((await inspect(f)).operation).toMatchObject({
    state: "paused",
    attempts: 6,
    maxAttempts: 6,
    recoveryAttempts: 5,
  });
});
it("backoff, jitter e janela externa persistem; orçamento não reinicia no retry", async () => {
  const f = await fixture(),
    token = await claim(f),
    notBefore = Date.now() + 3_600_000;
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "transient", code: "COOLDOWN", notBefore },
  });
  const op = (await inspect(f)).operation!;
  expect(op.nextAttemptAt).toBe(notBefore);
  expect(op.backoffMs).toBeGreaterThan(0);
  expect(op.jitterMs).toBeGreaterThanOrEqual(0);
  expect(
    await f.t.mutation(internal.operations.claim, {
      operationId: f.operationId,
      generation: op.generation,
    }),
  ).toBeNull();
  await f.t.run((ctx) =>
    ctx.db.patch("operations", f.operationId, { attempts: 6, state: "paused" }),
  );
  await expect(
    f.t.mutation(internal.operationRest.access, {
      keyHash: f.args.keyHash,
      environment: "sandbox",
      id: f.operationId,
      action: "retry",
      expectedGeneration: op.generation,
    }),
  ).rejects.toThrow("ATTEMPTS_EXHAUSTED");
});
it("rejeição definitiva não agenda nova tentativa", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, token);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "definitive", code: "REJECTED" },
  });
  expect((await inspect(f)).operation).toMatchObject({ state: "failed", code: "REJECTED" });
  expect((await inspect(f)).operation?.recoveryAt).toBeUndefined();
});
it.each(["key", "grant", "project"])(
  "revogar %s bloqueia a execução já enfileirada",
  async (target) => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      if (target === "key") await ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() });
      if (target === "project")
        await ctx.db.patch("projects", f.scope.projectId, { state: "disabled" });
      if (target === "grant") {
        const grant = (await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
          )
          .unique())!;
        await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: 1 });
      }
    });
    expect(
      await f.t.mutation(internal.operations.claim, { operationId: f.operationId, generation: 1 }),
    ).toBeNull();
    expect((await inspect(f)).operation?.state).toBe("paused");
  },
);
it("pausa durante chamada invalida a resposta e mantém necessidade de reconciliação", async () => {
  const f = await fixture(),
    token = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, token);
  const paused = await f.t.mutation(internal.operationRest.access, {
    keyHash: f.args.keyHash,
    environment: "sandbox",
    id: f.operationId,
    action: "pause",
    expectedGeneration: 1,
  });
  expect(paused).toMatchObject({ state: "paused", uncertain: true, generation: 2 });
  expect(
    await f.t.mutation(internal.operations.recordOutcome, {
      ...token,
      outcome: { kind: "success", response: "late" },
    }),
  ).toBe(false);
  const resumed = await f.t.mutation(internal.operationRest.access, {
    keyHash: f.args.keyHash,
    environment: "sandbox",
    id: f.operationId,
    action: "retry",
    expectedGeneration: 2,
  });
  expect(resumed.state).toBe("reconciling");
});
it("HTTP recusa ID de outro cliente, ambiente errado e chave revogada", async () => {
  const f = await fixture();
  const otherSecret = `fnfe_${"b".repeat(43)}`,
    keyHash = await hashApiKey(otherSecret);
  await f.t.mutation(internal.testing.operationProof.prepare, { keyHash, suffix: "other" });
  const read = (secret: string, environment = "sandbox") =>
    f.t.fetch(`/v1/operations/${f.operationId}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": environment },
    });
  expect((await read(f.secret)).status).toBe(200);
  expect((await read(otherSecret)).status).toBe(404);
  expect((await read(f.secret, "production")).status).toBe(403);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await read(f.secret)).status).toBe(401);
  await expect(f.t.mutation(internal.operations.reserve, f.args)).rejects.toThrow(
    "INVALID_API_KEY",
  );
});
it("chave inválida não distingue operação existente de ID inexistente", async () => {
  const f = await fixture();
  const headers = { Authorization: `Bearer fnfe_${"z".repeat(43)}`, "X-Environment": "sandbox" };
  const existing = await f.t.fetch(`/v1/operations/${f.operationId}`, { headers });
  const absent = await f.t.fetch("/v1/operations/not-an-id", { headers });
  expect(existing.status).toBe(401);
  expect(absent.status).toBe(401);
  expect((await existing.json()).error).toEqual((await absent.json()).error);
});
it("retry com chave nova não aceita trabalho cuja chave original foi revogada", async () => {
  const f = await fixture(),
    otherHash = await hashApiKey("replacement-key");
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    const { _id, _creationTime, ...fields } = key;
    await ctx.db.insert("apiKeys", { ...fields, keyHash: otherHash });
    await ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now() });
  });
  expect(
    await f.t.mutation(internal.operations.claim, { operationId: f.operationId, generation: 1 }),
  ).toBeNull();
  const before = (await inspect(f)).operation!;
  await expect(
    f.t.mutation(internal.operationRest.access, {
      keyHash: otherHash,
      environment: "sandbox",
      id: f.operationId,
      action: "retry",
      expectedGeneration: before.generation,
    }),
  ).rejects.toThrow("ACCESS_REVOKED");
  expect((await inspect(f)).operation).toEqual(before);
});
it("erro de integridade não é classificado como revogação de acesso", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    const { _id, _creationTime, ...fields } = grant;
    await ctx.db.insert("projectCompanies", fields);
  });
  await expect(
    f.t.mutation(internal.operations.claim, { operationId: f.operationId, generation: 1 }),
  ).rejects.toThrow();
  expect((await inspect(f)).operation).toMatchObject({ state: "queued", generation: 1 });
});
it("recuperação lê no máximo um lote indexado, sem alterar operações futuras", async () => {
  const f = await fixture(),
    op = (await inspect(f)).operation!;
  const { _id, _creationTime, ...data } = op;
  await f.t.run(async (ctx) => {
    for (let i = 0; i < RECOVERY_BATCH + 3; i++)
      await ctx.db.insert("operations", {
        ...data,
        workId: undefined,
        recoveryAt: Date.now(),
        nextAttemptAt: Date.now(),
      });
  });
  expect(await f.t.mutation(internal.operations.recoverBatch, {})).toBe(RECOVERY_BATCH);
  const remaining = await f.t.run((ctx) =>
    ctx.db
      .query("operations")
      .withIndex("by_recoveryAt", (q) => q.gt("recoveryAt", 0).lte("recoveryAt", Date.now()))
      .take(RECOVERY_BATCH),
  );
  expect(remaining).toHaveLength(3);
  expect((await inspect(f)).operation?.generation).toBe(1);
});
it("sessão humana permitida consulta; viewer não pausa, membro removido não consulta", async () => {
  const f = await fixture(),
    now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Teste",
        email: "person@development.invalid",
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
        token: crypto.randomUUID(),
        expiresAt: now + 3600_000,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const actor = f.t.withIdentity({ subject: user._id, sessionId: session._id });
  const memberId = await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: user._id,
      name: "Teste",
      email: user.email,
      role: "admin",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  expect((await actor.query(api.operations.get, { operationId: f.operationId })).state).toBe(
    "queued",
  );
  await f.t.run(async (ctx) => {
    await ctx.db.patch("memberships", memberId, { role: "viewer" });
    await ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: memberId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: now,
    });
  });
  await expect(
    actor.mutation(api.operations.control, {
      operationId: f.operationId,
      action: "pause",
      expectedGeneration: 1,
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  await f.t.run((ctx) => ctx.db.patch("memberships", memberId, { state: "removed" }));
  await expect(actor.query(api.operations.get, { operationId: f.operationId })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  await expect(f.t.query(api.operations.get, { operationId: f.operationId })).rejects.toThrow(
    "UNAUTHENTICATED",
  );
});
it("abandonBeforeEffect volta a ready e pausa antes do efeito, nunca depois da resposta", async () => {
  const f = await fixture(),
    current = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, current);
  await f.t.run(async (ctx) =>
    abandonBeforeEffect(ctx, (await ctx.db.get("operations", f.operationId))!, "PLAN_REQUIRED"),
  );
  const paused = (await inspect(f)).operation!;
  expect(paused).toMatchObject({ state: "paused", stage: "ready", uncertain: false });
  expect(paused.code).toBe("PLAN_REQUIRED");

  // An earlier send of the same operation keeps it uncertain.
  const g = await fixture(),
    other = await claim(g);
  await g.t.mutation(internal.operations.beginEffect, other);
  await g.t.run(async (ctx) =>
    abandonBeforeEffect(ctx, (await ctx.db.get("operations", g.operationId))!, "ACCESS_REVOKED", {
      uncertain: true,
    }),
  );
  expect((await inspect(g)).operation).toMatchObject({ state: "paused", uncertain: true });

  const h = await fixture(),
    answered = await claim(h);
  await h.t.mutation(internal.operations.beginEffect, answered);
  await h.t.mutation(internal.operations.recordOutcome, {
    ...answered,
    outcome: { kind: "success", response: '{"synthetic":true}' },
  });
  await expect(
    h.t.run(async (ctx) =>
      abandonBeforeEffect(ctx, (await ctx.db.get("operations", h.operationId))!, "PLAN_REQUIRED"),
    ),
  ).rejects.toThrow("past the effect");
  expect((await inspect(h)).operation).toMatchObject({ state: "running", stage: "response" });
});
it("setResult só grava na resposta ou depois do sucesso, dentro do limite", async () => {
  const f = await fixture(),
    current = await claim(f);
  await f.t.mutation(internal.operations.beginEffect, current);
  const write = (response: string) =>
    f.t.run(async (ctx) =>
      setResult(ctx, (await ctx.db.get("operations", f.operationId))!, response),
    );
  await expect(write('{"early":true}')).rejects.toThrow("no result to write");
  await f.t.mutation(internal.operations.recordOutcome, {
    ...current,
    outcome: { kind: "success", response: '{"synthetic":true}' },
  });
  await expect(write(`"${"x".repeat(RESPONSE_LIMIT_BYTES)}"`)).rejects.toThrow("over the limit");
  await write('{"checkpoint":true}');
  expect((await inspect(f)).operation?.response).toBe('{"checkpoint":true}');
  await f.t.mutation(internal.operations.checkpoint, current);
  await f.t.mutation(internal.operations.publish, current);
  await write('{"published":true}');
  expect((await inspect(f)).operation).toMatchObject({
    state: "succeeded",
    response: '{"published":true}',
  });
});
it("patchOperationDomain grava só na tentativa em execução", async () => {
  const f = await fixture();
  await claim(f);
  const sweep = { cursor: null, requested: 2, busy: 0 };
  const written = await f.t.run(async (ctx) =>
    patchOperationDomain(ctx, (await ctx.db.get("operations", f.operationId))!, {
      refusalSweep: sweep,
    }),
  );
  expect(written.refusalSweep).toEqual(sweep);
  expect((await inspect(f)).operation?.refusalSweep).toEqual(sweep);
  await f.t.run(async (ctx) =>
    abandonBeforeEffect(ctx, (await ctx.db.get("operations", f.operationId))!, "PAUSED_BY_USER"),
  );
  await expect(
    f.t.run(async (ctx) =>
      patchOperationDomain(ctx, (await ctx.db.get("operations", f.operationId))!, {
        refusalSweep: undefined,
      }),
    ),
  ).rejects.toThrow("operation is paused");
  expect((await inspect(f)).operation?.refusalSweep).toEqual(sweep);
});
