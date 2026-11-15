import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { internal, api } from "./_generated/api";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { consoleProjectFor } from "../../tests/helpers/console";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import { parseDistribution } from "../../packages/fiscal-nfe/src/distribution";
import {
  human,
  fixture,
  claim,
  raw,
  deliver,
  describeBatch,
  persist,
  expireAndRerun,
  moveStream,
} from "../../tests/helpers/captures";

/**
 * Recovery of a capture: uncertain answers, 589, gaps by consNSU, repeated NSU, fences and
 * partially persisted batches.
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

it("reconciles an uncertain source response with consNSU only after the global window", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, old);
  vi.setSystemTime(Date.now() + 60_001);
  await f.t.mutation(internal.operations.recoverOne, { operationId: old.operationId });
  const newer = await claim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, newer))!;
  expect(input.mode).toBe("consNSU");
  expect(input.nsu).toBe(nsu(1));
  expect(input.waitUntil).toBeGreaterThan(Date.now());
  const reserved = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(reserved.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(reserved.find((event) => event.metric === "bytes")).toMatchObject({
    state: "reserved",
    quantity: 18 * 1024 * 1024,
  });
  vi.setSystemTime(input.waitUntil!);
  await f.t.mutation(internal.operations.recoverOne, { operationId: newer.operationId });
  const final = await claim(f);
  const bytes = distributionXml();
  await persist(f, final, bytes);
  const committed = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(committed.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(committed.filter((event) => event.metric === "bytes")).toHaveLength(1);
  expect(committed.find((event) => event.metric === "bytes")).toMatchObject({
    state: "committed",
    quantity: bytes.length,
  });
  const total = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(total.find((row) => row.metric === "bytes")).toMatchObject({
    committed: bytes.length,
    reserved: 0,
  });
});
it("releases capture byte reservation when transport is disabled before receiving a batch", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await f.t.mutation(internal.captureProcessing.prepare, token);
  await f.t.mutation(internal.captureProcessing.failed, {
    ...token,
    code: "FISCAL_TRANSPORT_DISABLED",
  });
  const events = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(events.find((event) => event.metric === "bytes")?.state).toBe("released");
  const totals = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(totals.find((row) => row.metric === "bytes")).toMatchObject({ committed: 0, reserved: 0 });
});

it.each(["app", "backoffice", "persisted-before-fix"] as const)(
  "resumes distribution after uncertain first IO and 589 at maxNSU zero via %s",
  async (entry) => {
    const f = await fixture();
    await f.command("activate");
    const old = await claim(f);
    await f.t.mutation(internal.captureProcessing.prepare, old);
    await f.t.mutation(internal.operations.recordOutcome, {
      ...old,
      outcome: {
        kind: "uncertain",
        code: "SOURCE_RESULT_UNCERTAIN",
        notBefore: Date.now() + 3600_000,
      },
    });
    const active = await f.command();
    const paused = await f.command("pause", active.version);
    vi.setSystemTime(paused.nextAllowedAt);
    await f.command("resume", paused.version);
    const token = await claim(f);
    const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
    expect(input).toMatchObject({ mode: "consNSU", nsu: nsu(1) });
    await persist(f, token, distributionXml({ status: "589", last: 0, max: 0 }));
    await f.t.mutation(internal.operations.checkpoint, token);
    await f.t.mutation(internal.operations.publish, token);
    const view = await f.command();
    const stored = await f.t.run((ctx) => ctx.db.get("captureStreams", view.id));
    expect(stored).toMatchObject({
      state: "attention",
      code: "SOURCE_589",
      checkpoint: nsu(0),
      mode: "distNSU",
    });
    expect(view.nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3600_000);
    if (entry === "persisted-before-fix") {
      await f.t.run((ctx) =>
        ctx.db.patch("captureStreams", view.id, { mode: "consNSU", sourceCursor: undefined }),
      );
    }
    if (entry === "backoffice") {
      // The stream is the integration's: the console reads it but does not resume it.
      const owner = await human(f.t, f.scope.organizationId, "owner");
      await expect(
        owner.client.mutation(api.captures.control, {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          environment: "sandbox",
          action: "resume",
          expectedVersion: view.version,
        }),
      ).rejects.toThrow("INTEGRATION_RECORD");
    }
    await f.command("resume", view.version);
    const waiting = await claim(f);
    const beforeWindow = (await f.t.mutation(internal.captureProcessing.prepare, waiting))!;
    expect(beforeWindow).toMatchObject({
      mode: "distNSU",
      nsu: nsu(0),
      waitUntil: view.nextAllowedAt,
    });
    await f.t.mutation(internal.operations.recordOutcome, {
      ...waiting,
      outcome: { kind: "wait", code: "SOURCE_COOLDOWN", notBefore: view.nextAllowedAt },
    });
    vi.setSystemTime(view.nextAllowedAt);
    const retry = await claim(f);
    expect(await f.t.mutation(internal.captureProcessing.prepare, retry)).toMatchObject({
      mode: "distNSU",
      nsu: nsu(0),
    });
    await persist(f, retry, distributionXml({ status: "137", last: 0, max: 0 }));
    await f.t.mutation(internal.operations.checkpoint, retry);
    expect((await f.command()).checkpoint).toBe(nsu(0));
    expect(await f.t.run((ctx) => ctx.db.get("captureStreams", view.id))).toMatchObject({
      code: "NO_DOCUMENTS",
      mode: "distNSU",
    });
    expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(0);
  },
);

it.each(["known-gap", "regressed-max", "inconsistent-boundary", "distNSU"])(
  "589 does not discard reconciliation evidence for %s",
  async (scenario) => {
    const f = await fixture();
    const view = await f.command("activate");
    await f.t.run((ctx) =>
      ctx.db.patch("captureStreams", view.id, {
        mode: scenario === "distNSU" ? "distNSU" : "consNSU",
        checkpoint: nsu(scenario === "regressed-max" ? 2 : 0),
        ...(scenario === "known-gap" ? { sourceCursor: nsu(3) } : {}),
      }),
    );
    const token = await claim(f);
    const bytes = distributionXml({
      status: "589",
      last: 0,
      max: scenario === "inconsistent-boundary" ? 1 : 0,
    });
    await persist(f, token, bytes);
    await f.t.mutation(internal.operations.checkpoint, token);
    const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", view.id));
    expect(stream).toMatchObject({
      state: "attention",
      code: "SOURCE_589",
      mode: scenario === "distNSU" ? "distNSU" : "consNSU",
      checkpoint: nsu(scenario === "regressed-max" ? 2 : 0),
    });
    if (scenario === "known-gap") expect(stream?.sourceCursor).toBe(nsu(3));
    expect(stream!.nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3600_000);
  },
);

it("recovers a gap by consNSU and does not duplicate the already persisted later envelope", async () => {
  const f = await fixture();
  await f.command("activate");
  const first = await claim(f);
  await persist(
    f,
    first,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("summary-authorized") },
        { nsu: 3, xml: corpus("invoice-authorized") },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, first);
  await f.t.mutation(internal.operations.publish, first);
  expect((await f.command()).checkpoint).toBe(nsu(1));
  const manager = await human(f.t, f.scope.organizationId, "owner");
  const version = (await f.command()).version;
  const release = () =>
    manager.client.mutation(api.captures.release, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      expectedVersion: version,
    });
  // The integration's stream is not the console's to release.
  await expect(release()).rejects.toThrow("INTEGRATION_RECORD");
  // Even in the console project, a known gap blocks the transfer.
  await moveStream(f, await consoleProjectFor(f.t, f.scope.organizationId));
  await expect(release()).rejects.toThrow("RECONCILIATION_REQUIRED");
  await moveStream(f, f.scope.projectId);
  // One consNSU for the missing NSU 2; the NSU 3 already stored goes in sequence without
  // another query (#419), and the stream is back to distNSU at the cursor.
  const state = await f.command();
  vi.setSystemTime(state.nextAllowedAt);
  const next = await claim(f);
  expect(await f.t.mutation(internal.captureProcessing.prepare, next)).toMatchObject({
    mode: "consNSU",
    nsu: nsu(2),
  });
  await persist(
    f,
    next,
    distributionXml({ last: 3, max: 3, envelopes: [{ nsu: 2, xml: corpus("event-110111") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, next);
  await f.t.mutation(internal.operations.publish, next);
  expect(await f.command()).toMatchObject({ checkpoint: nsu(3), state: "active" });
  const stream = await f.t.run(async (ctx) => (await ctx.db.query("captureStreams").first())!);
  expect(stream.mode).toBe("distNSU");
  expect(stream.recovery).toBeUndefined();
  const saved = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  expect(saved).toHaveLength(3);
  expect(saved.every((e) => e.operationId)).toBe(true);
});

it("stops repeated NSU without shortening the window or duplicating an import", async () => {
  const f = await fixture();
  await f.command("activate");
  const bytes = distributionXml({
    envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
    max: 10,
  });
  for (let i = 0; i < 2; i++) {
    const current = await f.command();
    vi.setSystemTime(Math.max(Date.now(), current.nextAllowedAt));
    const token = await claim(f);
    await persist(f, token, bytes);
    await f.t.mutation(internal.operations.checkpoint, token);
    await f.t.mutation(internal.operations.publish, token);
  }
  expect(await f.command()).toMatchObject({ state: "attention", checkpoint: nsu(1) });
  expect((await f.command()).nextAllowedAt).toBeGreaterThanOrEqual(Date.now() + 3_600_000);
  expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(1);
});

it("certificate revocation fences a reserved source call", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await f.t.run(async (ctx) => {
    const cert = (await ctx.db.query("certificates").first())!;
    await ctx.db.patch("certificates", cert._id, { state: "revoked" });
  });
  expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
  expect(
    await f.t.mutation(internal.operations.recordOutcome, {
      ...token,
      outcome: { kind: "uncertain", code: "SYNTHETIC_RESPONSE" },
    }),
  ).toBe(false);
  expect((await f.command()).state).toBe("attention");
  expect((await f.command()).checkpoint).toBe(nsu(0));
});

it("resumes a partially persisted batch without leaking or duplicating the first envelope", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  const bytes = distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
    ],
  });
  const batchId = await raw(f, old, bytes);
  await f.t.mutation(internal.captureProcessing.describe, {
    ...old,
    batchId,
    status: "138",
    lastNsu: nsu(2),
    maxNsu: nsu(2),
    count: 2,
  });
  const e = parseDistribution(bytes, "sandbox").envelopes[0]!;
  const storageId = await f.t.run((ctx) =>
    ctx.storage.store(new Blob([Uint8Array.from(e.xml)], { type: "application/xml" })),
  );
  await f.t.mutation(internal.captureProcessing.envelope, {
    ...old,
    batchId,
    position: 0,
    nsu: e.nsu,
    schema: e.schema,
    sha256: e.sha256,
    storageId,
    size: e.xml.length,
  });
  await expireAndRerun(f, old);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  expect(await f.t.run((ctx) => ctx.db.query("documentArtifacts").collect())).toHaveLength(2);
  expect(
    await f.t.mutation(internal.captureProcessing.envelope, {
      ...old,
      batchId,
      position: 0,
      nsu: e.nsu,
      schema: e.schema,
      sha256: e.sha256,
      storageId,
      size: e.xml.length,
    }),
  ).toBe(false);
});

const twoEnvelopes = () =>
  distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
    ],
  });

it("o envelope repetido na mesma posição não grava outro e tem o arquivo apagado (#123)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const bytes = twoEnvelopes();
  const batchId = await raw(f, token, bytes);
  expect(await describeBatch(f, token, batchId, bytes)).toBe(true);
  // convex-test serializes mutations, as OCC orders the real ones: the repetition comes second.
  const first = await deliver(f, token, batchId, bytes, 0);
  const repeated = await deliver(f, token, batchId, bytes, 0);
  expect([first.saved, repeated.saved]).toEqual([true, true]);
  expect((await deliver(f, token, batchId, bytes, 1)).saved).toBe(true);
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await f.t.mutation(internal.operations.checkpoint, token);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  const rows = await f.t.run(async (ctx) => ({
    envelopes: (await ctx.db.query("captureEnvelopes").collect()).map((e) => e.nsu).sort(),
    artifacts: (await ctx.db.query("documentArtifacts").collect()).length,
    // The raw response and one file per envelope.
    files: (await ctx.db.system.query("_storage").collect()).length,
    first: await ctx.storage.getUrl(first.storageId),
    repeated: await ctx.storage.getUrl(repeated.storageId),
  }));
  expect(rows).toMatchObject({
    envelopes: [nsu(1), nsu(2)],
    artifacts: 2,
    files: 3,
    repeated: null,
  });
  expect(rows.first).not.toBeNull();
});

it("a interrupção entre o describe e os envelopes retoma do lote guardado, sem outra consulta à fonte (#123)", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  const bytes = twoEnvelopes();
  const batchId = await raw(f, old, bytes);
  expect(await describeBatch(f, old, batchId, bytes)).toBe(true);
  // The worker stops here: the batch is described and no envelope is durable. The simulated
  // source is open and would answer a new query with one NSU more.
  const stream = (await f.command()).id;
  await f.t.mutation(internal.testing.captureProof.set, {
    streamId: stream,
    xml: distributionXml({
      last: 3,
      max: 3,
      envelopes: [{ nsu: 3, xml: corpus("event-110111") }],
    }).toString(),
  });
  await f.t.mutation(internal.testing.captureProof.allowNow, { streamId: stream });
  await expireAndRerun(f, old);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  const proof = await f.t.query(internal.testing.captureProof.inspect, { streamId: stream });
  expect(proof.calls).toBe(0);
  expect(proof.envelopes.map((e) => e.nsu)).toEqual([nsu(1), nsu(2)]);
  expect(await f.t.run((ctx) => ctx.db.query("captureBatches").collect())).toHaveLength(1);
});

it("um bruto tardio da mesma claim não substitui o lote guardado nem leva o checkpoint além dele (#123)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const first = twoEnvelopes();
  const batchId = await raw(f, token, first);
  // A repeated execution of this claim stores a later answer, with one NSU more. A fenced claim
  // never gets here: `captureClaim` refuses it first.
  const late = distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
      { nsu: 3, xml: corpus("event-110111") },
    ],
  });
  const lateId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(late)])));
  expect(
    await f.t.mutation(internal.captureProcessing.raw, {
      ...token,
      rawId: lateId,
      rawHash: createHash("sha256").update(late).digest("hex"),
      nsu: nsu(0),
      mode: "distNSU",
    }),
  ).toBe(batchId);
  expect(
    await f.t.run(async (ctx) => ({
      batches: (await ctx.db.query("captureBatches").collect()).map((b) => b.rawHash),
      late: await ctx.storage.getUrl(lateId),
    })),
  ).toEqual({ batches: [createHash("sha256").update(first).digest("hex")], late: null });
  await expireAndRerun(f, token);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  expect(
    (await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).map((e) => e.nsu).sort(),
  ).toEqual([nsu(1), nsu(2)]);
});

it("keeps an unavailable persisted batch in attention instead of silently querying again", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const batchId = await raw(f, token, distributionXml());
  await f.t.run(async (ctx) => {
    const batch = (await ctx.db.get("captureBatches", batchId))!;
    await ctx.storage.delete(batch.rawId);
  });
  const result = await f.t.action(internal.captureWorker.execute, { ...token, request: "{}" });
  expect(result).toEqual({ kind: "definitive", code: "BATCH_UNAVAILABLE" });
  expect(await f.command()).toMatchObject({ state: "attention", checkpoint: nsu(0) });
});
