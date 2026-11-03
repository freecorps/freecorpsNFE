/// <reference types="vite/client" />
import { randomBytes, createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "../platform/convex/schema";
import { register } from "../platform/test-setup";
import { internal, api, components } from "../platform/convex/_generated/api";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { emitEvent } from "../platform/convex/lib/webhookOutbox";
import { verifyWebhook, webhookEvents } from "../packages/contracts/src/webhooks";
import { fixture as xmlFixture } from "./helpers/nfe-corpus";
import { processNfe } from "../packages/fiscal-nfe/src/index";
import type { Id } from "../platform/convex/_generated/dataModel";
const modules = import.meta.glob("../platform/convex/**/*.ts");
async function human(
  t: ReturnType<typeof testDatabase>,
  organizationId: Id<"organizations">,
  role: "owner" | "developer" | "viewer",
) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
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
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  return {
    membershipId,
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3245",
    }),
  };
}
const post = vi.hoisted(() => vi.fn());
vi.mock("../platform/convex/lib/webhookNetwork", () => ({
  postWebhook: post,
  WebhookNetworkError: class extends Error {
    code = "NETWORK_ERROR";
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  for (const [name, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "https",
    SITE_URL: "http://localhost:5193",
    CONVEX_SITE_URL: "http://127.0.0.1:3245",
    BETTER_AUTH_SECRET: "synthetic-secret",
    FNFE_WEBHOOK_MASTER_KEY: "ab".repeat(32),
  }))
    vi.stubEnv(name, value);
  post.mockReset();
  post.mockResolvedValue({ status: 204 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function testDatabase() {
  return convexTest(schema, modules);
}
async function fixture(database?: ReturnType<typeof testDatabase>) {
  const t = database ?? convexTest(schema, modules);
  if (!database) register(t);
  const secret = `fnfe_${randomBytes(32).toString("base64url")}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [
        ...key.scopes,
        "documents:read",
        "connections:read",
        "documents:issue",
        "documents:cancel",
      ],
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [
        ...grant.scopes,
        "documents:read",
        "connections:read",
        "documents:issue",
        "documents:cancel",
      ],
    });
  });
  async function rest(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey = "test-key-73",
    environment = "sandbox",
  ) {
    return t.fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": environment,
        "Idempotency-Key": idempotencyKey,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  }
  async function create() {
    const response = await rest("/v1/webhook-endpoints", "POST", {
      companyId: scope.companyId,
      name: "Destino sintético",
      url: "https://receiver.example.com/webhook",
      events: [...webhookEvents],
    });
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      endpoint: { id: Id<"webhookEndpoints">; version: number };
      secret: string;
    };
  }
  async function event(endpointId: Id<"webhookEndpoints">, key: string = crypto.randomUUID()) {
    const response = await rest(`/v1/webhook-endpoints/${endpointId}/test`, "POST", {}, key);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const deliveries = await t.run((ctx) =>
      ctx.db
        .query("webhookDeliveries")
        .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
        .collect(),
    );
    const delivery = await t.run(async (ctx) => {
      for (const d of deliveries)
        if ((await ctx.db.get("outboxEvents", d.eventId))!.eventId === data.eventId) return d;
      throw new Error("Missing delivery");
    });
    return delivery;
  }
  async function inspect(id: Id<"webhookDeliveries">) {
    return (await t.run((ctx) => ctx.db.get("webhookDeliveries", id)))!;
  }
  async function run(id: Id<"webhookDeliveries">) {
    const d = await inspect(id);
    return t.action(internal.webhookWorker.run, { deliveryId: id, generation: d.generation });
  }
  return { t, scope, keyHash, rest, create, event, inspect, run };
}
it("reports an invalid delivery cursor as a client error", async () => {
  const f = await fixture();
  const { endpoint } = await f.create();
  const response = await f.rest(`/v1/webhook-deliveries?endpointId=${endpoint.id}&cursor=garbage`);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_CURSOR", retryable: false },
  });
});
it("pauses unadmitted deliveries at quota without discarding the outbox or sending HTTP", async () => {
  const f = await fixture();
  const e = await f.create(),
    d = await f.event(e.endpoint.id);
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Quota",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 100000,
    limits: { imports: null, bytes: null, captures: null, registry: null, deliveries: 0 },
    concurrency: 2,
    actor: "test",
    reason: "quota",
    expectedVersion: 0,
  });
  await f.run(d._id);
  expect(post).not.toHaveBeenCalled();
  expect(await f.inspect(d._id)).toMatchObject({
    state: "paused",
    code: "QUOTA_EXCEEDED",
    attempts: 0,
  });
  expect(await f.t.run((ctx) => ctx.db.get("outboxEvents", d.eventId))).not.toBeNull();
});
it("persists encrypted secrets once, deduplicates the synthetic event and signs the stored bytes", async () => {
  const f = await fixture(),
    endpoint = await f.create();
  const d = await f.event(endpoint.endpoint.id, "same-test-key");
  expect((await f.event(endpoint.endpoint.id, "same-test-key"))._id).toBe(d._id);
  const rows = await f.t.run((ctx) => ctx.db.query("webhookEndpoints").collect());
  expect(JSON.stringify(rows)).not.toContain(endpoint.secret);
  const list = await f.rest(`/v1/webhook-endpoints?companyId=${f.scope.companyId}`);
  expect(await list.text()).not.toContain(endpoint.secret);
  await Promise.all([f.run(d._id), f.run(d._id)]);
  expect(post).toHaveBeenCalledTimes(1);
  const [, body, headers] = post.mock.calls[0]!;
  expect(
    await verifyWebhook({
      body: new TextEncoder().encode(body),
      headers,
      secrets: [{ version: 1, secret: endpoint.secret }],
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, event: { synthetic: true } });
  expect(await f.inspect(d._id)).toMatchObject({
    state: "delivered",
    attempts: 1,
    httpStatus: 204,
  });
});
it.each([400, 401, 403, 404, 410, 302])("does not automatically repeat HTTP %s", async (status) => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  post.mockResolvedValue({ status });
  await f.run(d._id);
  expect(await f.inspect(d._id)).toMatchObject({
    state: "failed",
    attempts: 1,
    code: `HTTP_${status}`,
  });
});
it("persists Retry-After, survives lost responses, fences old attempts and exhausts retries", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  post.mockResolvedValueOnce({ status: 429, retryAt: Date.now() + 120_000 });
  await f.run(d._id);
  let current = await f.inspect(d._id);
  expect(current.nextAttemptAt).toBe(Date.now() + 120_000);
  await f.run(d._id);
  expect(post).toHaveBeenCalledTimes(1);
  vi.setSystemTime(current.nextAttemptAt);
  const claimed = await f.t.mutation(internal.webhookDelivery.claim, {
    deliveryId: d._id,
    generation: current.generation,
  });
  expect(claimed).not.toBeNull();
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.webhookDelivery.recover, {
    deliveryId: d._id,
    generation: current.generation,
  });
  expect(
    await f.t.mutation(internal.webhookDelivery.outcome, {
      deliveryId: d._id,
      generation: current.generation,
      status: 200,
      durationMs: 1,
      code: "HTTP_RESPONSE",
    }),
  ).toBe(false);
  post.mockResolvedValue({ status: 503 });
  for (let i = 0; i < 4; i++) {
    current = await f.inspect(d._id);
    vi.setSystemTime(current.nextAttemptAt);
    await f.run(d._id);
  }
  expect(await f.inspect(d._id)).toMatchObject({ state: "failed", attempts: 6 });
  const attempts = await f.t.run((ctx) =>
    ctx.db
      .query("webhookAttempts")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", d._id))
      .collect(),
  );
  expect(attempts).toHaveLength(6);
});
it("retries a failed attempt with the same event bytes and identity, verifiable by the receiver", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  post.mockResolvedValueOnce({ status: 503 });
  await f.run(d._id);
  vi.setSystemTime((await f.inspect(d._id)).nextAttemptAt);
  await f.run(d._id);
  expect(post).toHaveBeenCalledTimes(2);
  const [, firstBody, firstHeaders] = post.mock.calls[0]!;
  const [, retryBody, retryHeaders] = post.mock.calls[1]!;
  // O receptor deduplica pelo evento: a retentativa não pode virar outro efeito.
  expect(retryBody).toBe(firstBody);
  expect(firstHeaders["x-fnfe-event-id"]).toBeTruthy();
  expect(retryHeaders["x-fnfe-event-id"]).toBe(firstHeaders["x-fnfe-event-id"]);
  for (const [body, headers] of [
    [firstBody, firstHeaders],
    [retryBody, retryHeaders],
  ] as const)
    expect(
      await verifyWebhook({
        body: new TextEncoder().encode(body),
        headers,
        secrets: [{ version: 1, secret: e.secret }],
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true });
  expect(await f.inspect(d._id)).toMatchObject({ state: "delivered", attempts: 2 });
});
it("manual resend preserves event and delivery and is audited and idempotent", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  await f.run(d._id);
  for (let n = 0; n < 3; n++) {
    const current = await f.inspect(d._id);
    const path = `/v1/webhook-deliveries/${d._id}/retry`;
    expect(
      (await f.rest(path, "POST", { expectedGeneration: current.generation }, `retry-key-${n}`))
        .status,
    ).toBe(200);
    const queued = await f.inspect(d._id);
    expect(queued.httpStatus).toBeUndefined();
    expect(queued.durationMs).toBeUndefined();
    expect(queued.response).toBeUndefined();
    expect(
      (await f.rest(path, "POST", { expectedGeneration: current.generation }, `retry-key-${n}`))
        .status,
    ).toBe(200);
    await f.run(d._id);
  }
  const current = await f.inspect(d._id);
  expect(current).toMatchObject({ eventId: d.eventId, attempts: 4, resends: 3 });
  const usage = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(usage.filter((event) => event.metric === "deliveries")).toHaveLength(1);
  expect(usage.filter((event) => event.metric === "attempts")).toHaveLength(4);
  expect(
    (
      await f.rest(
        `/v1/webhook-deliveries/${d._id}/retry`,
        "POST",
        { expectedGeneration: current.generation },
        "retry-key-last",
      )
    ).status,
  ).toBe(409);
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("integrationAudit")
      .withIndex("by_projectId", (q) => q.eq("projectId", f.scope.projectId))
      .collect(),
  );
  expect(audit.filter((a) => a.action === "webhook.retried")).toHaveLength(3);
});
it("rotates with coexistence, removes expired ciphertext and rejects competing rotation", async () => {
  const f = await fixture(),
    e = await f.create();
  const response = await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}/rotate-secret`, "POST", {
    expectedVersion: 1,
    overlapMs: 60_000,
  });
  expect(response.status).toBe(200);
  const newer = (await response.json()).data;
  expect(
    (
      await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}/rotate-secret`, "POST", {
        expectedVersion: 2,
        overlapMs: 60_000,
      })
    ).status,
  ).toBe(409);
  const d = await f.event(e.endpoint.id);
  await f.run(d._id);
  const [, body, headers] = post.mock.calls[0]!;
  for (const secret of [
    { version: 1, secret: e.secret },
    { version: 2, secret: newer.secret },
  ])
    expect(
      await verifyWebhook({
        body: new TextEncoder().encode(body),
        headers,
        secrets: [secret],
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true });
  vi.setSystemTime(Date.now() + 60_000);
  await f.t.mutation(internal.webhookDelivery.expireSecret, {
    endpointId: e.endpoint.id,
    version: 2,
  });
  const stored = await f.t.run((ctx) => ctx.db.get("webhookEndpoints", e.endpoint.id));
  expect(stored?.previousSecret).toBeUndefined();
});
it("denies another organization, revoked keys, wrong environment, missing scope and grants", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id),
    other = await fixture(f.t);
  expect((await other.rest(`/v1/webhook-endpoints/${e.endpoint.id}`)).status).toBe(404);
  expect(
    (
      await f.rest(
        `/v1/webhook-endpoints/${e.endpoint.id}`,
        "GET",
        undefined,
        "test-key-73",
        "production",
      )
    ).status,
  ).toBe(403);
  expect((await other.rest(`/v1/webhook-deliveries?endpointId=${e.endpoint.id}`)).status).toBe(404);
  expect(
    (await other.rest(`/v1/webhook-deliveries/${d._id}/retry`, "POST", { expectedGeneration: 1 }))
      .status,
  ).toBe(404);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  expect((await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}`)).status).toBe(403);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}`)).status).toBe(401);
  await f.t.run((ctx) => ctx.db.patch("projects", f.scope.projectId, { accessEpoch: 1 }));
  await f.run(d._id);
  expect(await f.inspect(d._id)).toMatchObject({
    state: "paused",
    code: "ACCESS_REVOKED",
    attempts: 0,
  });
  expect(post).not.toHaveBeenCalled();
});
it("refuses a company removed from the key and pauses queued delivery after grant revocation", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { companyIds: [] }));
  expect((await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}`)).status).toBe(404);
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: grant.accessEpoch + 1 });
  });
  await f.run(d._id);
  expect(await f.inspect(d._id)).toMatchObject({
    state: "paused",
    code: "ACCESS_REVOKED",
    attempts: 0,
  });
  expect(post).not.toHaveBeenCalled();
});
it("clears an earlier HTTP response when a subsequent attempt fails before receiving headers", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  post.mockResolvedValueOnce({ status: 503 });
  await f.run(d._id);
  const failed = await f.inspect(d._id);
  expect(failed.httpStatus).toBe(503);
  vi.setSystemTime(failed.nextAttemptAt);
  post.mockRejectedValueOnce(new Error("synthetic connection failure"));
  await f.run(d._id);
  const current = await f.inspect(d._id);
  expect(current).toMatchObject({ state: "retry_wait", code: "NETWORK_ERROR" });
  expect(current.httpStatus).toBeUndefined();
  expect(current.response).toBeUndefined();
});
it("keeps the disabled transport paused without pretending a successful test", async () => {
  const f = await fixture(),
    e = await f.create(),
    d = await f.event(e.endpoint.id);
  vi.stubEnv("WEBHOOK_MODE", "disabled");
  await f.run(d._id);
  expect(await f.inspect(d._id)).toMatchObject({
    state: "paused",
    code: "DELIVERY_DISABLED",
    attempts: 0,
  });
  expect(post).not.toHaveBeenCalled();
});
it("allows disabling after event access is revoked but rejects reactivation with forbidden subscriptions", async () => {
  const f = await fixture(),
    e = await f.create();
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: ["webhooks:manage"] });
  });
  const patch = {
    name: "Destino sintético",
    url: "https://receiver.example.com/webhook",
    events: [...webhookEvents],
    expectedVersion: 1,
    active: false,
  };
  expect((await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}`, "PATCH", patch)).status).toBe(200);
  expect(
    (
      await f.rest(`/v1/webhook-endpoints/${e.endpoint.id}`, "PATCH", {
        ...patch,
        expectedVersion: 2,
        active: true,
      })
    ).status,
  ).toBe(404);
});
it("authorizes humans at the backend and refuses viewers, unassigned developers and removed members", async () => {
  const f = await fixture(),
    e = await f.create();
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    viewer = await human(f.t, f.scope.organizationId, "viewer"),
    developer = await human(f.t, f.scope.organizationId, "developer");
  const args = {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  expect(await owner.client.query(api.webhooks.list, args)).toHaveLength(1);
  for (const client of [f.t, viewer.client, developer.client]) {
    await expect(client.query(api.webhooks.list, args)).rejects.toThrow();
    await expect(
      client.mutation(api.webhooks.test, { endpointId: e.endpoint.id, key: "denied-synthetic" }),
    ).rejects.toThrow();
  }
  await f.t.run((ctx) => ctx.db.patch("memberships", owner.membershipId, { state: "removed" }));
  await expect(owner.client.query(api.webhooks.list, args)).rejects.toThrow();
});
it("refuses unauthorized event changes on an inactive edit through the direct human mutation", async () => {
  const f = await fixture(),
    e = await f.create(),
    owner = await human(f.t, f.scope.organizationId, "owner");
  const input = {
    endpointId: e.endpoint.id,
    expectedVersion: 1,
    active: true,
    name: "Destino sintético",
    url: "https://receiver.example.com/webhook",
    events: ["document.received" as const],
  };
  await owner.client.mutation(api.webhooks.update, input);
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: ["webhooks:manage", "documents:read"],
    });
  });
  await expect(
    owner.client.mutation(api.webhooks.update, {
      ...input,
      expectedVersion: 2,
      active: false,
      events: ["document.received", "import.completed"],
    }),
  ).rejects.toThrow();
  const stored = await f.t.run((ctx) => ctx.db.get("webhookEndpoints", e.endpoint.id));
  expect(stored).toMatchObject({ active: true, version: 2, events: ["document.received"] });
  await expect(
    owner.client.mutation(api.webhooks.update, { ...input, expectedVersion: 2, active: false }),
  ).resolves.toMatchObject({ active: false });
});
it("fans document events to granted projects but isolates import events and delivery management", async () => {
  const f = await fixture(),
    other = await fixture(f.t),
    e = await f.create();
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", other.scope.projectId).eq("companyId", other.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projects", other.scope.projectId, {
      organizationId: f.scope.organizationId,
    });
    await ctx.db.patch("apiKeys", other.scope.keyId, {
      organizationId: f.scope.organizationId,
      companyIds: [f.scope.companyId],
    });
    await ctx.db.patch("projectCompanies", grant._id, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
    });
  });
  other.scope.organizationId = f.scope.organizationId;
  other.scope.companyId = f.scope.companyId;
  const e2 = await other.create();
  expect((await other.rest(`/v1/webhook-endpoints/${e.endpoint.id}`)).status).toBe(404);
  await f.t.run(async (ctx) => {
    const base = {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
      resourceId: "synthetic",
      resourceVersion: 1,
    };
    await emitEvent(ctx, {
      ...base,
      logicalKey: "shared-document",
      type: "document.received",
      resourceType: "document",
    });
    await emitEvent(ctx, {
      ...base,
      projectId: f.scope.projectId,
      logicalKey: "private-import",
      type: "import.completed",
      resourceType: "import",
    });
  });
  const first = await f.t.run((ctx) =>
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", e.endpoint.id))
      .collect(),
  );
  const second = await f.t.run((ctx) =>
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", e2.endpoint.id))
      .collect(),
  );
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(1);
  const shared = await f.t.run((ctx) => ctx.db.get("outboxEvents", second[0]!.eventId));
  expect(shared?.type).toBe("document.received");
});
it("rolls back public changes, outbox and scheduled deliveries together", async () => {
  const f = await fixture();
  await f.create();
  await expect(
    f.t.run(async (ctx) => {
      await ctx.db.patch("companies", f.scope.companyId, { name: "rollback" });
      await emitEvent(ctx, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "sandbox",
        logicalKey: "rollback-test",
        type: "document.updated",
        resourceType: "document",
        resourceId: "synthetic-document",
        resourceVersion: 1,
      });
      throw new Error("injected rollback");
    }),
  ).rejects.toThrow("injected rollback");
  expect(await f.t.run((ctx) => ctx.db.query("outboxEvents").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toEqual([]);
});
it("publishes document and import events from real XML processing without duplicate logical events", async () => {
  const f = await fixture();
  await f.create();
  const bytes = xmlFixture("invoice-authorized"),
    model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await f.t.run((ctx) =>
    ctx.db.patch("companies", f.scope.companyId, { cnpj: model.issuer.document }),
  );
  async function imported(key: string) {
    const reservation = await f.rest(
      "/v1/imports",
      "POST",
      {
        companyId: f.scope.companyId,
        files: [
          {
            name: "synthetic.xml",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
      key,
    );
    expect(reservation.status).toBe(200);
    const batch = (await reservation.json()).data;
    const ticket = await f.rest(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
      "POST",
    );
    const token = (await ticket.json()).data.token;
    expect(
      (
        await f.t.fetch("/v1/import-upload", {
          method: "POST",
          headers: { "X-Upload-Token": token },
          body: new Uint8Array(bytes),
        })
      ).status,
    ).toBe(200);
    const confirmation = await f.rest(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`,
      "POST",
    );
    const operation = (await confirmation.json()).data;
    await f.t.action(internal.operationWorker.run, {
      operationId: operation.operationId,
      generation: 1,
    });
    await f.t.mutation(internal.importProcessing.published, { operationId: operation.operationId });
    return batch;
  }
  await imported("first-import");
  let events = await f.t.run((ctx) => ctx.db.query("outboxEvents").collect());
  expect(events.filter((e) => e.type === "document.received")).toHaveLength(1);
  expect(events.filter((e) => e.type === "import.completed")).toHaveLength(1);
  await imported("duplicate-import");
  events = await f.t.run((ctx) => ctx.db.query("outboxEvents").collect());
  expect(events.filter((e) => e.type === "document.received")).toHaveLength(1);
  expect(events.filter((e) => e.type === "document.updated")).toHaveLength(0);
  expect(events.filter((e) => e.type === "import.completed")).toHaveLength(2);
});

it("preserva domínio e entrega quando a correlação opcional aponta para outro escopo", async () => {
  const f = await fixture(),
    other = await fixture(f.t),
    endpoint = await f.create();
  const reserved = await f.t.mutation(internal.operations.reserve, {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    keyHash: f.keyHash,
    key: "correlation-proof",
    request: "{}",
    task: {
      name: "proof.import",
      workload: "import",
      scope: "documents:import",
      executor: "testing/operationTransport:execute",
    },
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const operation = (await f.t.run((ctx) => ctx.db.get("operations", reserved.operationId)))!;
  const { _id, _creationTime: _time, ...fields } = operation;
  const variants = [
    { organizationId: other.scope.organizationId },
    { companyId: other.scope.companyId },
    { projectId: other.scope.projectId },
    { environment: "production" as const },
  ];
  for (const [i, variant] of variants.entries()) {
    const id = await f.t.run(async (ctx) => {
      const wrong = await ctx.db.insert("operations", { ...fields, ...variant });
      await ctx.db.patch("companies", f.scope.companyId, { name: `Committed-${i}` });
      return emitEvent(ctx, {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "sandbox",
        logicalKey: `bad-correlation-${i}`,
        type: "import.completed",
        resourceType: "import",
        resourceId: "synthetic",
        resourceVersion: 1,
        operationIds: [wrong],
      });
    });
    const event = (await f.t.run((ctx) => ctx.db.get("outboxEvents", id)))!;
    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("operationalAudit")
        .withIndex("by_organizationId_and_eventId", (q) =>
          q.eq("organizationId", f.scope.organizationId).eq("eventId", event.eventId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "CORRELATION_INCOMPLETE", projectId: f.scope.projectId });
    expect(rows[0]!.operationId).toBeUndefined();
    expect((await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId)))!.name).toBe(
      `Committed-${i}`,
    );
  }
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("webhookDeliveries")
        .withIndex("by_endpointId", (q) => q.eq("endpointId", endpoint.endpoint.id))
        .collect(),
    ),
  ).toHaveLength(4);
  expect(warn).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(endpoint.secret);
  warn.mockRestore();
});
