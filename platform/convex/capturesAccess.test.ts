import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { consoleProjectFor } from "../../tests/helpers/console";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import type { Id } from "./_generated/dataModel";
import { human, fixture, claim, persist, moveStream } from "../../tests/helpers/captures";

/**
 * Who reads and controls a capture, and the transfer of a stream between projects.
 * Companies, keys and documents are synthetic; nothing here reaches a tax authority.
 */
vi.mock("./buildInfo", () => ({ buildSha: "a".repeat(40) }));
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5198",
    CONVEX_SITE_URL: "http://127.0.0.1:3255",
    BETTER_AUTH_SECRET: "synthetic-capture",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("preserves cursor on source conflict and exposes no other customer's identity", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(f, token, distributionXml({ status: "656", last: 10, max: 10 }));
  await f.t.mutation(internal.operations.checkpoint, token);
  const stream = await f.command();
  expect(stream).toMatchObject({ checkpoint: nsu(0), state: "attention" });
  expect(stream.nextAllowedAt).toBeGreaterThan(Date.now());
  const events = await f.t.run((ctx) => ctx.db.query("outboxEvents").collect());
  expect(events[0]?.type).toBe("connection.attention_required");
  expect(events[0]?.body).not.toContain("cnpj");
});
it("revoked key, wrong scope and foreign company cannot read or resume", async () => {
  const f = await fixture();
  await f.command("activate");
  const other = await fixture(f.t);
  await expect(
    f.t.mutation(internal.captureRest.dispatch, { ...f.args, companyId: other.scope.companyId }),
  ).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  await expect(f.command()).rejects.toThrow("SCOPE_DENIED");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  await expect(f.command()).rejects.toThrow("INVALID_API_KEY");
});

it("o console lê a captura de integração, mas só controla a do projeto do console", async () => {
  const f = await fixture();
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const grantTo = (
    membershipId: Id<"memberships">,
    organizationId = f.scope.organizationId,
    companyId = f.scope.companyId,
  ) =>
    f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId,
        companyId,
        membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
  // The integration activates through its key: the stream belongs to its project.
  const active = await f.command("activate");
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    operator = await human(f.t, f.scope.organizationId, "operator"),
    viewer = await human(f.t, f.scope.organizationId, "viewer"),
    developer = await human(f.t, f.scope.organizationId, "developer"),
    stranger = await human(f.t, f.scope.organizationId, "operator");
  for (const person of [operator, viewer, developer]) await grantTo(person.membershipId);
  // The console sees who controls it before any action.
  const integration = await f.t.run(
    async (ctx) => (await ctx.db.get("projects", f.scope.projectId))!.name,
  );
  expect(await viewer.client.query(api.captures.get, scope)).toMatchObject({
    id: active.id,
    origin: { kind: "integration", integration },
  });
  await expect(developer.client.query(api.captures.get, scope)).rejects.toThrow("SCOPE_DENIED");
  await expect(stranger.client.query(api.captures.get, scope)).rejects.toThrow("NOT_FOUND");
  const control = (
    person: typeof operator,
    action: "pause" | "resume",
    version: number,
    where = scope,
  ) => person.client.mutation(api.captures.control, { ...where, action, expectedVersion: version });
  await expect(control(viewer, "pause", active.version)).rejects.toThrow("SCOPE_DENIED");
  await expect(control(developer, "pause", active.version)).rejects.toThrow("SCOPE_DENIED");
  await expect(control(stranger, "pause", active.version)).rejects.toThrow("NOT_FOUND");
  // Writing on the integration's stream belongs to the integration, for every role.
  await expect(control(operator, "pause", active.version)).rejects.toThrow("INTEGRATION_RECORD");
  await expect(control(owner, "pause", active.version)).rejects.toThrow("Prova de operações");
  await expect(
    owner.client.mutation(api.captures.release, { ...scope, expectedVersion: active.version }),
  ).rejects.toThrow("INTEGRATION_RECORD");
  expect((await f.command()).state).not.toBe("paused");
  // A stream activated in the console belongs to the console project: people control it, and
  // another integration's key does not see or take it.
  const second = await fixture(f.t);
  // Another CNPJ: the stream identity is the CNPJ, environment and service.
  await f.t.run((ctx) =>
    ctx.db.patch("companies", second.scope.companyId, { cnpj: "11444777000161" }),
  );
  const where = {
    organizationId: second.scope.organizationId,
    companyId: second.scope.companyId,
    environment: "sandbox" as const,
  };
  const manager = await human(f.t, second.scope.organizationId, "owner");
  const worker = await human(f.t, second.scope.organizationId, "operator");
  const reader = await human(f.t, second.scope.organizationId, "viewer");
  for (const person of [worker, reader])
    await grantTo(person.membershipId, second.scope.organizationId, second.scope.companyId);
  const created = await manager.client.mutation(api.captures.activate, where);
  const stream = await f.t.run(async (ctx) => {
    const row = (await ctx.db.get("captureStreams", created.id))!;
    const op = (await ctx.db.get("operations", row.operationId!))!;
    return { row, op, project: (await ctx.db.get("projects", row.projectId))! };
  });
  expect(stream.project.kind).toBe("console");
  expect(stream.op.projectId).toBe(stream.row.projectId);
  await expect(second.command("activate")).rejects.toThrow("STREAM_CONFLICT");
  expect(await second.command()).toBeNull();
  await expect(control(reader, "pause", created.version, where)).rejects.toThrow("SCOPE_DENIED");
  const paused = await control(worker, "pause", created.version, where);
  expect(paused.state).toBe("paused");
  const resumed = await control(worker, "resume", paused.version, where);
  const op = (await f.t.run((ctx) => ctx.db.get("operations", resumed.operationId!)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  expect(
    await f.t.mutation(internal.operations.claim, { operationId: op._id, generation: 1 }),
  ).not.toBeNull();
  // Only managers authorize a transfer.
  await expect(
    worker.client.mutation(api.captures.release, { ...where, expectedVersion: resumed.version }),
  ).rejects.toThrow();
});

it("transfers only with both managers, once, preserving checkpoint/window and isolating old ownership", async () => {
  const f = await fixture(),
    other = await fixture(f.t);
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      last: 1,
      max: 3,
      envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const before = await f.command();
  // Transfers are a console write: only a stream of the console project is released.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  const owner = await human(f.t, f.scope.organizationId, "owner");
  const recipient = await human(f.t, other.scope.organizationId, "owner");
  const viewer = await human(f.t, f.scope.organizationId, "viewer");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const target = {
    ...scope,
    organizationId: other.scope.organizationId,
    companyId: other.scope.companyId,
  };
  await expect(
    viewer.client.mutation(api.captures.release, { ...scope, expectedVersion: before.version }),
  ).rejects.toThrow();
  await expect(
    viewer.client.mutation(api.captures.control, {
      ...scope,
      action: "pause",
      expectedVersion: before.version,
    }),
  ).rejects.toThrow();
  const released = await owner.client.mutation(api.captures.release, {
    ...scope,
    expectedVersion: before.version,
  });
  await expect(
    recipient.client.mutation(api.captures.activate, { ...target, transferToken: "wrong" }),
  ).rejects.toThrow("STREAM_CONFLICT");
  const transferred = await recipient.client.mutation(api.captures.activate, {
    ...target,
    transferToken: released.token,
  });
  expect(transferred).toMatchObject({
    state: "paused",
    checkpoint: before.checkpoint,
    nextAllowedAt: before.nextAllowedAt,
    received: 0,
    operationId: null,
  });
  // The same CNPJ's source: its end of queue goes with the checkpoint (#494). Guards against
  // a transfer resetting `sourceMaxNsu`, which would hide the queue from the receiver.
  expect(await recipient.client.query(api.captures.get, target)).toMatchObject({
    checkpoint: nsu(1),
    sourceMaxNsu: nsu(3),
  });
  expect(await owner.client.query(api.captures.get, scope)).toBeNull();
  await expect(
    owner.client.mutation(api.captures.activate, { ...scope, transferToken: released.token }),
  ).rejects.toThrow("STREAM_CONFLICT");
  const resumed = await recipient.client.mutation(api.captures.control, {
    ...target,
    action: "resume",
    expectedVersion: transferred.version,
  });
  const operation = await f.t.run((ctx) => ctx.db.get("operations", resumed.operationId!));
  expect(operation?.organizationId).toBe(other.scope.organizationId);
  expect(
    (await f.t.run((ctx) => ctx.db.get("certificates", operation!.certificate!.id)))?.companyId,
  ).toBe(other.scope.companyId);
});

it("blocks transfer during uncertain IO and rejects an expired authorization", async () => {
  const f = await fixture(),
    other = await fixture(f.t);
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    recipient = await human(f.t, other.scope.organizationId, "owner");
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const state = await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  // The worker's operation and the stream move together to the console project.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  const view = () => owner.client.query(api.captures.get, scope).then((row) => row!);
  await expect(
    owner.client.mutation(api.captures.release, { ...scope, expectedVersion: state.version }),
  ).rejects.toThrow("RECONCILIATION_REQUIRED");
  await persist(f, token, distributionXml());
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  const current = await view();
  expect(current.origin).toEqual({ kind: "console", integration: null });
  const released = await owner.client.mutation(api.captures.release, {
    ...scope,
    expectedVersion: current.version,
  });
  vi.setSystemTime(released.expiresAt + 1);
  await expect(
    recipient.client.mutation(api.captures.activate, {
      ...scope,
      organizationId: other.scope.organizationId,
      companyId: other.scope.companyId,
      transferToken: released.token,
    }),
  ).rejects.toThrow("STREAM_CONFLICT");
});

it("refuses a transfer code with nothing to receive, writing nothing (#461)", async () => {
  const f = await fixture();
  const owner = await human(f.t, f.scope.organizationId, "owner"),
    operator = await human(f.t, f.scope.organizationId, "operator");
  // The operator reaches the company, so only the role decides.
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: operator.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const rows = () =>
    f.t.run(async (ctx) => ({
      streams: await ctx.db.query("captureStreams").collect(),
      audit: (await ctx.db.query("captureAudit").collect()).length,
      operations: (await ctx.db.query("operations").collect()).length,
      projects: (await ctx.db.query("projects").collect()).length,
    }));
  // No stream for the CNPJ: a code (any, even empty) neither creates nor resumes a capture.
  const empty = await rows();
  expect(empty.streams).toEqual([]);
  for (const transferToken of ["codigo-errado", ""])
    await expect(
      owner.client.mutation(api.captures.activate, { ...scope, transferToken }),
    ).rejects.toThrow("TRANSFER_NOT_FOUND");
  // Receiving is for managers, as with a stream to receive.
  await expect(
    operator.client.mutation(api.captures.activate, { ...scope, transferToken: "codigo" }),
  ).rejects.toThrow("ACCESS_DENIED");
  // Not even the console project of the first console write.
  expect(await rows()).toEqual(empty);
  // Without a code, the activation is the same as before.
  const started = await operator.client.mutation(api.captures.activate, scope);
  expect(started).toMatchObject({ state: "active" });
  // The stream is already this company's: the code does not show it as received.
  const own = await rows();
  for (const transferToken of ["codigo-errado", ""])
    await expect(
      owner.client.mutation(api.captures.activate, { ...scope, transferToken }),
    ).rejects.toThrow("TRANSFER_NOT_FOUND");
  expect(await rows()).toEqual(own);
  expect(await owner.client.mutation(api.captures.activate, scope)).toMatchObject({
    version: started.version,
  });
});
