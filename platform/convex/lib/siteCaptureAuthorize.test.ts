import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { capturePlan, person } from "../../../tests/helpers/platform";
import { fixture as corpus } from "../../../tests/helpers/nfe-corpus";
import { SITE_CAPTURE_ACTION, SITE_CAPTURE_HOURLY_LIMIT } from "./siteCapture";
import * as certificateRuntime from "./certificateRuntime";
import * as certificateTransport from "./certificateTransport";
import * as certificateCrypto from "./certificateCrypto";
import { defaultThresholds } from "./operationalMetrics";
import { distributionXml, nsu } from "../../../tests/helpers/distribution";
import {
  development,
  stub,
  siteFixture,
  respond,
  streamOf,
} from "../../../tests/helpers/siteCapture";

vi.mock("../buildInfo", () => ({ buildSha: "a".repeat(40) }));

beforeEach(() => {
  vi.useFakeTimers();
  stub(development);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * #421: a 656 keeps mode and cursor; a refusal of the vault between `prepare` and the request is
 * neither uncertain nor reconciled, and gives the window and the quota back; a wait is never a
 * failure; the cursor monitor follows the company's interval.
 */
describe("656, recusa antes do envio e esperas", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const HOUR = 3_600_000;
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  /** One full worker run of the operation at its time: claim, effect, outcome, checkpoint. */
  async function run(f: Fixture, id: Id<"operations">) {
    const op = await opOf(f, id);
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await f.t.action(internal.operationWorker.run, { operationId: id, generation: op.generation });
    return opOf(f, id);
  }
  const failures = (f: Fixture) => f.t.run((ctx) => ctx.db.query("operationalFailures").collect());
  const usage = (f: Fixture, metric: "captures" | "bytes") =>
    f.t.run(async (ctx) => {
      const rows = (await ctx.db.query("usageTotals").collect()).filter(
        (row) => row.organizationId === f.scope.organizationId && row.metric === metric,
      );
      return {
        committed: rows.reduce((n, row) => n + row.committed, 0),
        reserved: rows.reduce((n, row) => n + row.reserved, 0),
      };
    });
  /**
   * The vault opens a synthetic A1 and the mTLS request, the only IO, answers 137: both are
   * observed, so a test sees whether the A1 was opened and whether a request left.
   */
  const transport = () => {
    vi.spyOn(certificateCrypto, "currentCertificateKeyring").mockReturnValue({} as never);
    const decrypt = vi.spyOn(certificateCrypto, "decryptCertificate").mockReturnValue({
      pfx: Buffer.alloc(0),
      password: Buffer.alloc(0),
      dispose() {},
    });
    const request = vi.spyOn(certificateTransport, "certificateRequest").mockResolvedValue({
      status: 200,
      body: distributionXml({ status: "137", environment: "1" }),
    });
    return { decrypt, request };
  };
  /** The real transport, after `change` ran between `prepare` and the vault's authorization. */
  const changeBeforeAuthorize = (change: () => Promise<unknown>) => {
    const real = certificateRuntime.transportWithCertificate;
    return vi
      .spyOn(certificateRuntime, "transportWithCertificate")
      .mockImplementation(async (...args) => {
        await change();
        return real(...args);
      });
  };
  const fillHourlyCeiling = (f: Fixture, oldest: number) =>
    f.t.run(async (ctx) => {
      const head = (await ctx.db
        .query("certificateHeads")
        .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
        .unique())!;
      const cert = (await ctx.db.get("certificates", head.activeId!))!;
      for (let n = 0; n < SITE_CAPTURE_HOURLY_LIMIT; n++)
        await ctx.db.insert("certificateAudit", {
          organizationId: cert.organizationId,
          companyId: cert.companyId,
          certificateId: cert._id,
          version: cert.version,
          actor: "system",
          action: SITE_CAPTURE_ACTION,
          result: "authorized",
          createdAt: oldest + n,
        });
    });
  /** The company renews its A1: a new certificate of its own becomes the active one. */
  const renewCertificate = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const head = (await ctx.db
        .query("certificateHeads")
        .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
        .unique())!;
      const old = (await ctx.db.get("certificates", head.activeId!))!;
      const { _id, _creationTime, ...copy } = old;
      const id = await ctx.db.insert("certificates", {
        ...copy,
        version: head.nextVersion,
        metadata: { ...old.metadata!, fingerprint: "d".repeat(64) },
      });
      await ctx.db.patch("certificates", old._id, { state: "replaced" });
      await ctx.db.patch("certificateHeads", head._id, {
        activeId: id,
        latestId: id,
        nextVersion: head.nextVersion + 1,
      });
      return id;
    });
  const dispatch = async (f: Fixture, streamId: Id<"captureStreams">, action: "pause" | "resume") =>
    JSON.parse(
      await f.t.mutation(internal.captureRest.dispatch, {
        keyHash: f.keyHash,
        environment: "production",
        companyId: f.scope.companyId,
        action,
        expectedVersion: (await streamOf(f, streamId)).version,
      }),
    ) as { operationId: Id<"operations"> };
  afterEach(() => vi.restoreAllMocks());

  it("656 com ultNSU acima do checkpoint mantém cursor e modo e só espera a janela", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    await respond(
      f,
      token,
      distributionXml({
        environment: "1",
        envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
      }),
    );
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const before = await streamOf(f, stream.id);
    expect(before).toMatchObject({ checkpoint: nsu(1), mode: "distNSU" });
    const next = await f.claim(before.operationId!);
    const at = Date.now();
    await respond(f, next, distributionXml({ status: "656", last: 40, max: 90, environment: "1" }));
    const blocked = await streamOf(f, stream.id);
    expect(blocked).toMatchObject({
      state: "attention",
      code: "SOURCE_CONSUMPTION_BLOCKED",
      checkpoint: nsu(1),
      mode: "distNSU",
    });
    expect(blocked.sourceCursor).toBe(before.sourceCursor);
    expect(blocked.nextAllowedAt).toBeGreaterThanOrEqual(at + HOUR);
    // After the window, the resumed query reads the queue from the checkpoint with distNSU.
    vi.setSystemTime(blocked.nextAllowedAt + 1);
    const resumed = await dispatch(f, stream.id, "resume");
    const again = await f.claim(resumed.operationId);
    expect(await f.t.mutation(internal.captureProcessing.prepare, again)).toMatchObject({
      mode: "distNSU",
      nsu: nsu(1),
    });
  });

  it("656 durante uma recuperação mantém o consNSU e o cursor conhecido", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    await f.t.run((ctx) =>
      ctx.db.patch("captureStreams", stream.id, {
        mode: "consNSU",
        checkpoint: nsu(3),
        sourceCursor: nsu(7),
      }),
    );
    const token = await f.claim(stream.operationId);
    await respond(
      f,
      token,
      distributionXml({ status: "656", last: 50, max: 90, environment: "1" }),
    );
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "attention",
      checkpoint: nsu(3),
      mode: "consNSU",
      sourceCursor: nsu(7),
    });
  });

  it("teto por hora atingido entre prepare e authorize: espera o deferUntil, sem reconciliar nem gastar cota", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const oldest = Date.now() - 10 * 60_000;
    const { decrypt, request } = transport();
    changeBeforeAuthorize(() => fillHourlyCeiling(f, oldest));
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(op).toMatchObject({
      state: "retry_wait",
      code: "SOURCE_COOLDOWN",
      uncertain: false,
      attempts: 0,
      recoveryAttempts: 0,
      nextAttemptAt: oldest + HOUR,
    });
    expect(op.usageCaptureKey).toBeUndefined();
    const waiting = await streamOf(f, stream.id);
    expect(waiting).toMatchObject({
      state: "active",
      mode: "distNSU",
      nextAllowedAt: oldest + HOUR,
    });
    expect(waiting.lastAttemptAt).toBeUndefined();
    expect(await usage(f, "captures")).toEqual({ committed: 0, reserved: 0 });
    expect(await usage(f, "bytes")).toEqual({ committed: 0, reserved: 0 });
    expect(await failures(f)).toHaveLength(0);
    // At the deferral the same operation queries with distNSU and is charged once.
    vi.restoreAllMocks();
    const { request: sent } = transport();
    const done = await run(f, stream.operationId);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![0].body).toContain("<distNSU>");
    expect(done).toMatchObject({ state: "succeeded", uncertain: false, attempts: 1 });
    expect(await usage(f, "captures")).toEqual({ committed: 1, reserved: 0 });
  });

  it("plano sem cotas entre prepare e authorize: a consulta nova não sai, a cota volta e pausa (#429)", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const { decrypt, request } = transport();
    changeBeforeAuthorize(() => capturePlan(f.t, f.scope.organizationId, { bytes: null }, 1));
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(op).toMatchObject({ state: "paused", code: "PLAN_REQUIRED", uncertain: false });
    expect(await usage(f, "captures")).toEqual({ committed: 0, reserved: 0 });
    expect(await usage(f, "bytes")).toEqual({ committed: 0, reserved: 0 });
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "attention",
      code: "PLAN_REQUIRED",
    });
  });

  it("parada geral entre prepare e authorize: só adia, como no prepare", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const { decrypt, request } = transport();
    changeBeforeAuthorize(() =>
      f.t.mutation(internal.captureRelease.setHalt, {
        kind: "halt",
        operator: "ana-freecorps",
        reason: "Parada sintética",
        runId: "1",
        runAttempt: 1,
      }),
    );
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(op).toMatchObject({
      state: "retry_wait",
      code: "SOURCE_COOLDOWN",
      uncertain: false,
      attempts: 0,
      recoveryAttempts: 0,
      nextAttemptAt: Date.now() + HOUR,
    });
    expect(await streamOf(f, stream.id)).toMatchObject({ state: "active" });
    const audit = await f.t.run((ctx) => ctx.db.query("captureAudit").collect());
    expect(audit.map((row) => row.action)).toContain("fiscal_halt_deferred");
    expect(await usage(f, "captures")).toEqual({ committed: 0, reserved: 0 });
    expect(await failures(f)).toHaveLength(0);
  });

  it("A1 trocado entre prepare e authorize: a consulta segue logo depois com o A1 novo", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const { decrypt, request } = transport();
    let renewed: Id<"certificates"> | undefined;
    changeBeforeAuthorize(async () => {
      if (!renewed) renewed = await renewCertificate(f);
    });
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(op).toMatchObject({
      state: "retry_wait",
      code: "CERTIFICATE_CHANGED",
      uncertain: false,
      attempts: 0,
    });
    expect(op.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await usage(f, "captures")).toEqual({ committed: 0, reserved: 0 });
    const done = await run(f, stream.operationId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(done).toMatchObject({ state: "succeeded", certificate: { id: renewed } });
  });

  it("A1 vencido entre prepare e authorize: atenção por certificado, sem incerteza", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const { request } = transport();
    changeBeforeAuthorize(() =>
      f.t.run(async (ctx) => {
        const op = (await ctx.db.get("operations", stream.operationId))!;
        const cert = (await ctx.db.get("certificates", op.certificate!.id))!;
        await ctx.db.patch("certificates", cert._id, {
          metadata: { ...cert.metadata!, notAfter: Date.now() - 1 },
        });
      }),
    );
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(op).toMatchObject({
      state: "paused",
      code: "CERTIFICATE_UNAVAILABLE",
      uncertain: false,
    });
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "attention",
      code: "CERTIFICATE_UNAVAILABLE",
    });
  });

  it("empresa retirada entre prepare e authorize: pausa sem incerteza, janela e cota devolvidas", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const before = await streamOf(f, stream.id);
    const { decrypt, request } = transport();
    changeBeforeAuthorize(() => f.setRelease(false));
    const op = await run(f, stream.operationId);
    expect(request).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(op).toMatchObject({ state: "paused", code: "ACCESS_REVOKED", uncertain: false });
    const paused = await streamOf(f, stream.id);
    expect(paused).toMatchObject({
      state: "attention",
      code: "ACCESS_REVOKED",
      mode: "distNSU",
      nextAllowedAt: before.nextAllowedAt,
    });
    expect(paused.lastAttemptAt).toBe(before.lastAttemptAt);
    expect(await usage(f, "captures")).toEqual({ committed: 0, reserved: 0 });
    expect(await usage(f, "bytes")).toEqual({ committed: 0, reserved: 0 });
    // Released again, the resume queries with distNSU: no reconciliation of a request that
    // never left.
    vi.restoreAllMocks();
    await f.setRelease(true);
    const resumed = await dispatch(f, stream.id, "resume");
    const { request: sent } = transport();
    const done = await run(f, resumed.operationId);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![0].body).toContain("<distNSU>");
    expect(done).toMatchObject({ state: "succeeded", uncertain: false });
    expect(await usage(f, "captures")).toEqual({ committed: 1, reserved: 0 });
  });

  it("uma falha depois do envio continua incerta", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const { request } = transport();
    request.mockRejectedValue(new Error("socket hang up"));
    const op = await run(f, stream.operationId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(op).toMatchObject({ state: "reconciling", uncertain: true });
    expect(await usage(f, "captures")).toEqual({ committed: 1, reserved: 0 });
    expect((await failures(f)).map((row) => row.code)).toContain("SOURCE_RESULT_UNCERTAIN");
  });

  it("retomada dentro da janela espera sem falha nem tentativa, mesmo além do limite de tentativas", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    await respond(f, token, distributionXml({ status: "137", environment: "1" }));
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    await dispatch(f, stream.id, "pause");
    const resumed = await dispatch(f, stream.id, "resume");
    const window = (await streamOf(f, stream.id)).nextAllowedAt;
    expect(window).toBeGreaterThan(Date.now());
    const { request } = transport();
    // More waits than `maxAttempts`: none of them is spent.
    for (let n = 0; n < 8; n++) {
      const op = await opOf(f, resumed.operationId);
      await f.t.action(internal.operationWorker.run, {
        operationId: resumed.operationId,
        generation: op.generation,
      });
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(request).not.toHaveBeenCalled();
    expect(await opOf(f, resumed.operationId)).toMatchObject({
      state: "retry_wait",
      code: "SOURCE_COOLDOWN",
      attempts: 0,
      recoveryAttempts: 0,
      nextAttemptAt: window,
    });
    expect((await failures(f)).filter((row) => row.code === "SOURCE_COOLDOWN")).toHaveLength(0);
    // At the window, the query runs and counts as one attempt.
    const done = await run(f, resumed.operationId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(done).toMatchObject({ state: "succeeded", attempts: 1 });
  });

  describe("limiar do monitor de cursor", () => {
    async function monitored(hours: number) {
      const f = await siteFixture({ released: false });
      await f.setRelease(true, hours);
      const stream = await f.command("production", "activate");
      const owner = await person(f.t, f.scope.organizationId, "owner");
      const monitorId = await f.t.run((ctx) =>
        ctx.db.insert("operationalMonitors", {
          organizationId: f.scope.organizationId,
          projectId: f.scope.projectId,
          companyId: f.scope.companyId,
          environment: "production",
          ownerMembershipId: owner.membershipId,
          enabled: true,
          notify: false,
          thresholds: defaultThresholds,
          generation: 1,
          metrics: [],
          createdAt: Date.now(),
        }),
      );
      /** Evaluates with the last success `ago` ms back: the open cursor alert's threshold. */
      return async (ago: number) => {
        await f.t.run((ctx) =>
          ctx.db.patch("captureStreams", stream.id, { lastSuccessAt: Date.now() - ago }),
        );
        const monitor = (await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId)))!;
        await f.t.mutation(internal.observability.evaluate, {
          monitorId,
          generation: monitor.generation,
        });
        const alert = await f.t.run((ctx) =>
          ctx.db
            .query("operationalAlerts")
            .withIndex("by_monitorId_and_kind", (q) =>
              q.eq("monitorId", monitorId).eq("kind", "cursor"),
            )
            .unique(),
        );
        return alert?.state === "open" ? alert.threshold : null;
      };
    }
    it("intervalo de 1 h: alerta a partir de 2 h sem sucesso", async () => {
      const firesAfter = await monitored(1);
      expect(await firesAfter(1.5 * HOUR)).toBeNull();
      expect(await firesAfter(2.5 * HOUR)).toBe(2 * HOUR);
    });
    it("intervalo de 24 h: a espera normal não alerta; 25 h sem sucesso, sim", async () => {
      const firesAfter = await monitored(24);
      expect(await firesAfter(23.5 * HOUR)).toBeNull();
      expect(await firesAfter(25.5 * HOUR)).toBe(25 * HOUR);
    });
  });
});
