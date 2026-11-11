/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { captureAttention } from "./lib/captureAttention";
import { raiseCaptureAlert } from "./lib/captureSupervision";
import { CAPTURE_TERMS_VERSION } from "./lib/fiscalCaptureRelease";
import type { Claim } from "./lib/operationCore";
import { endpointAllowed } from "./lib/webhookAccess";
import { defaultThresholds } from "./lib/operationalMetrics";
import { parseDistribution } from "../../packages/fiscal-nfe/src/distribution";
import { distributionXml } from "../../tests/helpers/distribution";
import { capturePlan, person, platformTest, syntheticApiKey } from "../../tests/helpers/platform";

/**
 * #422: the supervisor of the site's production capture and its signals. Freecorps hears of
 * every attention and of what a periodic check of each released company finds (30 and 50 days
 * without a query, paused included; a gap close to 90 days; the A1 30 and 7 days before
 * expiring; an active stream whose operation stopped), once per finding. The customer sees it in
 * the Início; an integration gets a last `connection.release_withdrawn` it can still receive;
 * monitors of a withdrawn company say why they stopped. Synthetic data, clock and transport.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 5, 15);
const CNPJ = "00000000000191";
const development = {
  APP_ENV: "development",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "local",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "http://localhost:5211",
  CONVEX_SITE_URL: "http://127.0.0.1:3271",
  BETTER_AUTH_SECRET: "synthetic-capture-supervisor",
  FNFE_CAPTURE_FISCAL: "enabled",
};
const site = {
  APP_ENV: "installation",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "https",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "b".repeat(64),
  SITE_URL: "https://console.operator.invalid",
  CONVEX_SITE_URL: "https://api.operator.invalid",
  API_URL: "https://rest.operator.invalid",
  BETTER_AUTH_SECRET: "synthetic-capture-supervisor",
  FNFE_CAPTURE_FISCAL: "enabled",
  FNFE_CAPTURE_TRANSPORT: "sefaz",
};
/** The site with the operational e-mail configured (`captureAlertDestination`). */
const mail = {
  EMAIL_MODE: "mail",
  MAIL_API_URL: "https://mail.development.invalid",
  MAIL_API_KEY: "synthetic-email-token-0123456789",
  ACCOUNT_EMAIL_FROM: "nao-responda@operator.invalid",
  ACCOUNT_EMAIL_RECIPIENTS: "pessoa@operator.invalid",
  FNFE_CAPTURE_ALERT_EMAIL: "operacao@operator.invalid, plantao@operator.invalid",
};
const stub = (profile: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(profile)) vi.stubEnv(name, value);
};
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  stub(development);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * A declared company with its own A1, an integration project with a key, and an owner with
 * access, on the hosted site. `release` turns the capture on in the console as the owner;
 * `production` then gives the key and its grant production, as a key issued after the release.
 */
async function fixture(options: { certificateDays?: number } = {}) {
  const t = platformTest();
  const keyHash = await hashApiKey(syntheticApiKey());
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  // Production capture requires the organization's plan with finite quotas (#429).
  await capturePlan(t, scope.organizationId);
  const certificateId = await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, { kind: "declared", cnpj: CNPJ });
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "sintetico",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "CN=Empresa sintética",
        cnpj: CNPJ,
        notBefore: Date.now() - DAY,
        notAfter: Date.now() + (options.certificateDays ?? 365) * DAY,
      },
      envelope: {
        format: 1,
        keyVersion: "synthetic",
        pfx: new ArrayBuffer(0),
        password: new ArrayBuffer(0),
        wrappedKey: new ArrayBuffer(0),
      },
      envelopeRevision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      nextVersion: 2,
      activeId: id,
      latestId: id,
    });
    return id;
  });
  stub(site);
  const owner = await person(t, scope.organizationId, "owner", { companyId: scope.companyId });
  const ids = { organizationId: scope.organizationId, companyId: scope.companyId };
  const release = () =>
    owner.mutation(api.captureRelease.enable, {
      ...ids,
      minIntervalHours: 1,
      terms: CAPTURE_TERMS_VERSION,
    });
  const withdraw = () => owner.mutation(api.captureRelease.disable, ids);
  const production = () =>
    t.run(async (ctx) => {
      const scopes = ["connections:read", "connections:write", "documents:read"] as const;
      await ctx.db.patch("apiKeys", scope.keyId, {
        scopes: [...scopes],
        environment: "production",
        revokedAt: null,
        expiresAt: Date.now() + 400 * DAY,
      });
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, {
        scopes: [...scopes, "webhooks:manage"],
        environments: ["sandbox", "production"],
      });
    });
  const command = async (action?: "activate" | "pause", expectedVersion?: number) =>
    JSON.parse(
      await t.mutation(internal.captureRest.dispatch, {
        keyHash,
        environment: "production",
        companyId: scope.companyId,
        ...(action ? { action } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      }),
    ) as { id: Id<"captureStreams">; operationId: Id<"operations">; version: number };
  /** A production stream written as it is, for the clock scenarios. */
  const stream = (fields: Partial<Doc<"captureStreams">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("captureStreams", {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        companyId: scope.companyId,
        environment: "production",
        identity: CNPJ,
        service: "nfe-distribution",
        state: "paused",
        code: "PAUSED_BY_USER",
        version: 2,
        checkpoint: "000000000000010",
        mode: "distNSU",
        nextAllowedAt: 0,
        lastSuccessAt: Date.now(),
        received: 10,
        createdAt: Date.now() - DAY,
        ...fields,
      }),
    );
  const supervision = () =>
    t.run((ctx) =>
      ctx.db
        .query("captureSupervision")
        .withIndex("by_companyId", (q) => q.eq("companyId", scope.companyId))
        .unique(),
    );
  /** The scheduled run of the current generation, as the scheduler would start it. */
  const check = async () => {
    const row = (await supervision())!;
    await t.mutation(internal.captureSupervisor.check, {
      companyId: scope.companyId,
      generation: row.generation,
    });
  };
  const alerts = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("captureAlerts").collect()).map((alert) => ({
        kind: alert.kind,
        code: alert.code ?? null,
        days: alert.days ?? null,
        delivery: alert.delivery,
      })),
    );
  /** Pending scheduled runs of a `captureSupervisor` function, by its export name. */
  const jobs = (name: "check" | "deliver") =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) =>
          /^captureSupervisor(\.js)?:/.test(job.name) &&
          job.name.endsWith(`:${name}`) &&
          job.state.kind === "pending",
      ),
    );
  const at = (ms: number) => vi.setSystemTime(ms);
  return {
    t,
    scope,
    keyHash,
    certificateId,
    owner,
    ids,
    release,
    withdraw,
    production,
    command,
    stream,
    supervision,
    check,
    alerts,
    jobs,
    at,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A durable source response through prepare, raw, describe, outcome and checkpoint. */
async function respond(f: Fixture, token: Claim, bytes: Buffer) {
  const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
  const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(bytes)])));
  const batchId = (await f.t.mutation(internal.captureProcessing.raw, {
    ...token,
    rawId,
    rawHash: createHash("sha256").update(bytes).digest("hex"),
    nsu: input.nsu,
    mode: input.mode,
  }))!;
  const parsed = parseDistribution(bytes, "production");
  await f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: parsed.status,
    lastNsu: parsed.lastNsu,
    maxNsu: parsed.maxNsu,
    count: parsed.envelopes.length,
  });
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await f.t.mutation(internal.operations.checkpoint, token);
}
async function claim(f: Fixture, operationId: Id<"operations">) {
  const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = (await f.t.mutation(internal.operations.claim, {
    operationId,
    generation: op.generation,
  }))!;
  const token = { operationId, generation: claimed.generation, fence: claimed.fence };
  await f.t.mutation(internal.operations.beginEffect, token);
  return token;
}

describe("agenda do supervisor", () => {
  it("a liberação arma a verificação; repetir não cria outra cadeia e cada geração roda uma vez", async () => {
    const f = await fixture();
    await f.release();
    const armed = (await f.supervision())!;
    expect(armed).toMatchObject({ generation: 1, organizationId: f.scope.organizationId });
    expect(await f.jobs("check")).toHaveLength(1);
    // The internal view arms only what is missing.
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).armed).toBe(0);
    expect(await f.jobs("check")).toHaveLength(1);
    await f.check();
    const next = (await f.supervision())!;
    expect(next.generation).toBe(2);
    expect(next.checkedAt).toBe(T0);
    const scheduled = (await f.t.run((ctx) =>
      ctx.db.system.get("_scheduled_functions", next.scheduledId!),
    ))!;
    expect(scheduled.scheduledTime).toBe(T0 + 6 * HOUR);
    // The run of generation 1, delivered again, finds generation 2 and does nothing.
    await f.t.mutation(internal.captureSupervisor.check, {
      companyId: f.scope.companyId,
      generation: 1,
    });
    expect((await f.supervision())!.generation).toBe(2);
  });

  it("retirada a liberação, a verificação para sozinha; liberar de novo arma outra", async () => {
    const f = await fixture();
    await f.release();
    await f.withdraw();
    await f.check();
    const stopped = (await f.supervision())!;
    expect(stopped.scheduledId).toBeUndefined();
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).armed).toBe(0);
    await f.release();
    expect((await f.supervision())!.scheduledId).toBeDefined();
    expect((await f.supervision())!.generation).toBe(stopped.generation + 1);
  });

  it("a lista não arma a verificação de uma organização encerrada", async () => {
    const f = await fixture();
    await f.release();
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("captureSupervision").unique())!;
      await ctx.scheduler.cancel(row.scheduledId!);
      await ctx.db.delete("captureSupervision", row._id);
    });
    const slug = (await f.t.run((ctx) => ctx.db.get("organizations", f.scope.organizationId)))!
      .slug;
    await f.owner.mutation(api.organizationClosure.close, {
      organizationId: f.scope.organizationId,
      confirmation: slug,
    });
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).armed).toBe(0);
    expect(await f.jobs("check")).toEqual([]);
  });

  it("uma empresa liberada antes do supervisor é armada pela lista, uma vez", async () => {
    const f = await fixture();
    await f.release();
    // As before #422: the release exists, the supervision does not.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("captureSupervision").unique())!;
      await ctx.scheduler.cancel(row.scheduledId!);
      await ctx.db.delete("captureSupervision", row._id);
    });
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).armed).toBe(1);
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).armed).toBe(0);
  });

  it("uma avaliação que lança ainda agenda a próxima geração e avisa uma vez por sequência de falhas", async () => {
    const f = await fixture();
    await f.release();
    await f.stream({ lastSuccessAt: T0 });
    // An unexpected record: a second head makes the certificate's `.unique()` throw.
    const brokenHead = () =>
      f.t.run((ctx) =>
        ctx.db.insert("certificateHeads", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          nextVersion: 2,
          activeId: f.certificateId,
          latestId: f.certificateId,
        }),
      );
    /** The run the row names is pending and is the row's generation: the chain goes on. */
    const scheduledNext = async () => {
      const row = (await f.supervision())!;
      const job = await f.t.run((ctx) =>
        ctx.db.system.get("_scheduled_functions", row.scheduledId!),
      );
      return job?.state.kind === "pending" && job.args[0].generation === row.generation;
    };
    let duplicate = await brokenHead();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    f.at(T0 + 31 * DAY);
    await f.check();
    const failed = (await f.supervision())!;
    expect(failed).toMatchObject({ generation: 2, failingSince: 1, checkedAt: T0 + 31 * DAY });
    expect(await scheduledNext()).toBe(true);
    // The evaluation rolled back whole: the 30-day finding is not half-recorded.
    expect(await f.alerts()).toEqual([
      { kind: "supervisor", code: "SUPERVISION_FAILED", days: null, delivery: "unconfigured" },
    ]);
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual([
      expect.objectContaining({
        type: "capture_supervisor_error",
        companyId: f.scope.companyId,
        generation: 1,
        failingSince: 1,
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(CNPJ);
    const listed = await f.t.mutation(internal.captureSupervisor.survey, {});
    // The list still answers, with the company's error and what it could read.
    expect(listed.companies[0]!).toMatchObject({
      supervision: { armed: true, failing: true },
      certificate: null,
      error: expect.stringContaining("unique()"),
    });
    expect(listed.companies[0]!.alerts.map((a) => a.kind)).toEqual(["supervisor"]);
    expect(listed.armed).toBe(0);
    // Generation 1 delivered again does nothing; generation 2 failing again is the same streak.
    await f.t.mutation(internal.captureSupervisor.check, {
      companyId: f.scope.companyId,
      generation: 1,
    });
    await f.check();
    expect((await f.supervision())!).toMatchObject({ generation: 3, failingSince: 1 });
    expect((await f.alerts()).map((a) => a.kind)).toEqual(["supervisor"]);
    expect(await scheduledNext()).toBe(true);
    // Repaired, the check evaluates again and the streak ends; a new failure alerts again.
    await f.t.run((ctx) => ctx.db.delete("certificateHeads", duplicate));
    await f.check();
    expect((await f.supervision())!.failingSince).toBeUndefined();
    expect((await f.alerts()).map((a) => a.kind)).toEqual(["supervisor", "quiet"]);
    duplicate = await brokenHead();
    await f.check();
    expect((await f.supervision())!.failingSince).toBe(4);
    expect((await f.alerts()).map((a) => a.kind)).toEqual(["supervisor", "quiet", "supervisor"]);
    expect(await scheduledNext()).toBe(true);
  });

  it("uma transição do stream rearma uma cadeia perdida, e só ela", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    // The chain gone without a trace, as a run that failed outside the evaluation would leave it.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("captureSupervision").unique())!;
      await ctx.scheduler.cancel(row.scheduledId!);
    });
    expect(await f.jobs("check")).toEqual([]);
    const started = await f.command("activate");
    expect(await f.jobs("check")).toHaveLength(1);
    // With a run scheduled, the next transition adds nothing.
    await f.command("pause", started.version);
    expect(await f.jobs("check")).toHaveLength(1);
  });
});

describe("o que o supervisor encontra", () => {
  it("30 e 50 dias sem consulta, com a captura pausada: um alerta por limite e por período", async () => {
    const f = await fixture();
    await f.release();
    const id = await f.stream({ lastSuccessAt: T0 });
    f.at(T0 + 29 * DAY);
    await f.check();
    expect(await f.alerts()).toEqual([]);
    f.at(T0 + 30 * DAY);
    await f.check();
    f.at(T0 + 31 * DAY);
    await f.check();
    expect(await f.alerts()).toEqual([
      { kind: "quiet", code: "PAUSED_BY_USER", days: 30, delivery: "unconfigured" },
    ]);
    f.at(T0 + 50 * DAY);
    await f.check();
    await f.check();
    expect((await f.alerts()).map((a) => a.days)).toEqual([30, 50]);
    // An answered query starts another quiet period, which warns again at 30 days.
    await f.t.run((ctx) => ctx.db.patch("captureStreams", id, { lastSuccessAt: T0 + 51 * DAY }));
    f.at(T0 + 81 * DAY);
    await f.check();
    expect((await f.alerts()).map((a) => a.days)).toEqual([30, 50, 30]);
  });

  it("um stream de sandbox parado não gera alerta: só Produção é supervisionada", async () => {
    const f = await fixture();
    await f.release();
    await f.stream({ environment: "sandbox", lastSuccessAt: T0 });
    f.at(T0 + 55 * DAY);
    await f.check();
    expect(await f.alerts()).toEqual([]);
  });

  it("stream ativo com a operação atrasada, pausada ou falha: um alerta por situação", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const started = await f.command("activate");
    await f.check();
    expect(await f.alerts()).toEqual([]);
    // The operation's turn passed two hours ago and nobody claimed it.
    f.at(Date.now() + 2 * HOUR);
    await f.check();
    await f.check();
    expect(await f.alerts()).toEqual([
      { kind: "stalled", code: "OVERDUE", days: null, delivery: "unconfigured" },
    ]);
    for (const state of ["paused", "failed"] as const) {
      await f.t.run((ctx) =>
        ctx.db.patch("operations", started.operationId, { state, code: "ATTEMPTS_EXHAUSTED" }),
      );
      await f.check();
      await f.check();
    }
    expect((await f.alerts()).map((a) => a.code)).toEqual([
      "OVERDUE",
      "ATTEMPTS_EXHAUSTED",
      "ATTEMPTS_EXHAUSTED",
    ]);
  });

  it("lacuna perto de 90 dias desde a última consulta", async () => {
    const f = await fixture();
    await f.release();
    await f.stream({
      state: "active",
      code: "RECONCILING_GAP",
      mode: "consNSU",
      recovery: { detectedAt: T0, quietSince: T0 - 70 * DAY, queuePending: false },
    });
    f.at(T0 + 9 * DAY);
    await f.check();
    expect((await f.alerts()).filter((a) => a.kind === "gap")).toEqual([]);
    f.at(T0 + 10 * DAY);
    await f.check();
    f.at(T0 + 11 * DAY);
    await f.check();
    expect((await f.alerts()).filter((a) => a.kind === "gap")).toEqual([
      { kind: "gap", code: null, days: 80, delivery: "unconfigured" },
    ]);
  });

  it("A1 a 30 e a 7 dias e vencido: um alerta em cada limite", async () => {
    const f = await fixture({ certificateDays: 40 });
    await f.release();
    const days = async () =>
      (await f.alerts()).filter((a) => a.kind === "certificate").map((a) => a.days);
    f.at(T0 + 9 * DAY);
    await f.check();
    expect(await days()).toEqual([]);
    f.at(T0 + 10 * DAY);
    await f.check();
    f.at(T0 + 20 * DAY);
    await f.check();
    expect(await days()).toEqual([30]);
    f.at(T0 + 33 * DAY);
    await f.check();
    await f.check();
    expect(await days()).toEqual([30, 7]);
    f.at(T0 + 40 * DAY);
    await f.check();
    expect(await days()).toEqual([30, 7, 0]);
  });

  it("perder o A1 próprio uma segunda vez avisa de novo", async () => {
    const f = await fixture();
    await f.release();
    const lose = () =>
      f.t.run(async (ctx) => {
        const head = (await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!;
        await ctx.db.patch("certificates", head.activeId!, { state: "revoked" });
        await ctx.db.patch("certificateHeads", head._id, { activeId: undefined });
      });
    const reinstall = () =>
      f.t.run(async (ctx) => {
        const head = (await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!;
        const old = (await ctx.db.get("certificates", head.latestId!))!;
        const { _id, _creationTime, ...fields } = old;
        void [_id, _creationTime];
        const id = await ctx.db.insert("certificates", { ...fields, state: "active", version: 2 });
        await ctx.db.patch("certificateHeads", head._id, { activeId: id, latestId: id });
      });
    const missing = async () =>
      (await f.alerts()).filter((a) => a.kind === "certificate" && a.days === 0).length;
    await lose();
    await f.check();
    await f.check();
    expect(await missing()).toBe(1);
    await reinstall();
    await f.check();
    await lose();
    await f.check();
    expect(await missing()).toBe(2);
  });

  it("liberada com 5 dias de A1, só o alerta de 7 dias", async () => {
    const f = await fixture({ certificateDays: 5 });
    await f.release();
    await f.check();
    expect(await f.alerts()).toEqual([
      { kind: "certificate", code: null, days: 7, delivery: "unconfigured" },
    ]);
  });
});

describe("sinal de atenção para a Freecorps", () => {
  it("656 vira alerta e uma linha de log estruturada, sem CNPJ, uma vez por transição", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = await f.command("activate");
    const token = await claim(f, started.operationId);
    await respond(f, token, distributionXml({ status: "656", environment: "1" }));
    expect(await f.alerts()).toEqual([
      {
        kind: "attention",
        code: "SOURCE_CONSUMPTION_BLOCKED",
        days: null,
        delivery: "unconfigured",
      },
    ]);
    const lines = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"capture_alert"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "capture_alert",
      kind: "attention",
      code: "SOURCE_CONSUMPTION_BLOCKED",
      companyId: f.scope.companyId,
      streamState: "attention",
    });
    expect(lines[0]).not.toContain(CNPJ);
    // The same attention again is no transition and no alert.
    await f.t.run(async (ctx) =>
      captureAttention(
        ctx,
        (await ctx.db.get("captureStreams", started.id))!,
        "SOURCE_CONSUMPTION_BLOCKED",
      ),
    );
    expect(await f.alerts()).toHaveLength(1);
  });

  it("CAPTURE_FISCAL_DENIED vira alerta; atenção de sandbox não", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const started = await f.command("activate");
    const token = await claim(f, started.operationId);
    // A stream whose identity is not the company's CNPJ is refused by the site's gate.
    await f.t.run((ctx) =>
      ctx.db.patch("captureStreams", started.id, { identity: "11222333000181" }),
    );
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
    expect(await f.alerts()).toEqual([
      { kind: "attention", code: "CAPTURE_FISCAL_DENIED", days: null, delivery: "unconfigured" },
    ]);
    const sandbox = await f.stream({ environment: "sandbox", state: "active" });
    await f.t.run(async (ctx) =>
      captureAttention(ctx, (await ctx.db.get("captureStreams", sandbox))!, "NSU_GAP"),
    );
    expect(await f.alerts()).toHaveLength(1);
  });
});

describe("e-mail operacional", () => {
  const ok = () => vi.fn(async () => Response.json({ success: true, result: { delivered: [] } }));
  async function raised(f: Fixture, key: string) {
    return (await f.t.run((ctx) =>
      raiseCaptureAlert(
        ctx,
        { _id: f.scope.companyId, organizationId: f.scope.organizationId },
        { kind: "attention", key, code: "SOURCE_CONSUMPTION_BLOCKED", streamState: "attention" },
      ),
    ))!;
  }
  const delivery = (f: Fixture, id: Id<"captureAlerts">) =>
    f.t.run(async (ctx) => (await ctx.db.get("captureAlerts", id))!.delivery);

  it("vai uma vez aos endereços da Freecorps, com ids e código e sem CNPJ nem nome", async () => {
    const f = await fixture();
    stub(mail);
    const fetch = ok();
    vi.stubGlobal("fetch", fetch);
    const id = await raised(f, "attention:sintetico:1");
    expect(await delivery(f, id)).toBe("pending");
    expect(await f.jobs("deliver")).toHaveLength(1);
    // The same finding again is the same alert, with no second e-mail scheduled.
    expect(await raised(f, "attention:sintetico:1")).toBeNull();
    await f.t.action(internal.captureSupervisor.deliver, { alertId: id });
    await f.t.action(internal.captureSupervisor.deliver, { alertId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await delivery(f, id)).toBe("sent");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(["operacao@operator.invalid", "plantao@operator.invalid"]);
    expect(body.subject).toContain("SOURCE_CONSUMPTION_BLOCKED");
    expect(body.text).toContain(f.scope.companyId);
    expect(JSON.stringify(body)).not.toContain(CNPJ);
    expect(JSON.stringify(body)).not.toContain("Empresa sintética");
  });

  it("sem resposta fica incerto, 4xx falha, e nenhum dos dois é reenviado", async () => {
    const f = await fixture();
    stub(mail);
    const timeout = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", timeout);
    const uncertain = await raised(f, "attention:sintetico:2");
    await f.t.action(internal.captureSupervisor.deliver, { alertId: uncertain });
    await f.t.action(internal.captureSupervisor.deliver, { alertId: uncertain });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(await delivery(f, uncertain)).toBe("uncertain");
    const refused = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", refused);
    const failed = await raised(f, "attention:sintetico:3");
    await f.t.action(internal.captureSupervisor.deliver, { alertId: failed });
    expect(await delivery(f, failed)).toBe("failed");
  });

  it("passado o teto por hora, o alerta fica suprimido, registrado e no log", async () => {
    const f = await fixture();
    stub(mail);
    const fetch = ok();
    vi.stubGlobal("fetch", fetch);
    await f.t.run(async (ctx) => {
      for (let n = 0; n < 20; n++)
        await ctx.db.insert("captureAlerts", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          kind: "attention",
          key: `anterior:${n}`,
          delivery: "sent",
          sentAt: Date.now() - 10 * 60_000,
          createdAt: Date.now() - 10 * 60_000,
        });
    });
    const id = await raised(f, "attention:sintetico:4");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.t.action(internal.captureSupervisor.deliver, { alertId: id });
    expect(fetch).not.toHaveBeenCalled();
    expect(await delivery(f, id)).toBe("suppressed");
    // The operator sees it in the log and in the list's summary, never by e-mail.
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      type: "capture_alert_delivery",
      alertId: id,
      delivery: "suppressed",
    });
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).suppressed).toBe(1);
    warn.mockRestore();
    // An hour later the ceiling has room again for the next alert.
    f.at(Date.now() + HOUR);
    const later = await raised(f, "attention:sintetico:5");
    await f.t.action(internal.captureSupervisor.deliver, { alertId: later });
    expect(await delivery(f, later)).toBe("sent");
  });

  it("sem destino configurado, o alerta fica registrado e nada é agendado", async () => {
    const f = await fixture();
    const id = await raised(f, "attention:sintetico:6");
    expect(await delivery(f, id)).toBe("unconfigured");
    expect(await f.jobs("deliver")).toEqual([]);
    // Development never sends, even with every variable.
    stub({ ...development, ...mail, EMAIL_MODE: "local" });
    expect(await delivery(f, await raised(f, "attention:sintetico:7"))).toBe("unconfigured");
    // Configured when raised, removed before its turn: nothing is sent and it is not left pending.
    stub({ ...site, ...mail });
    const fetch = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    const removed = await raised(f, "attention:sintetico:8");
    expect(await delivery(f, removed)).toBe("pending");
    vi.stubEnv("FNFE_CAPTURE_ALERT_EMAIL", undefined);
    await f.t.action(internal.captureSupervisor.deliver, { alertId: removed });
    expect(fetch).not.toHaveBeenCalled();
    expect(await delivery(f, removed)).toBe("unconfigured");
  });

  describe("teste do e-mail (#463)", () => {
    const run = { operator: "ana-freecorps", runId: "4242", runAttempt: 2 };
    const alerts = (f: Fixture) => f.t.run((ctx) => ctx.db.query("captureAlerts").take(10));

    it("vai uma vez aos endereços pelo mesmo envio, com o run e sem empresa nem registro", async () => {
      const f = await fixture();
      stub(mail);
      const fetch = ok();
      vi.stubGlobal("fetch", fetch);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await f.t.action(internal.captureSupervisor.sendTestAlert, run)).toEqual({
        alertDestination: "email",
        recipients: 2,
        delivery: "sent",
        sentAt: Date.now(),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toBe("https://mail.development.invalid/emails");
      const body = JSON.parse(init.body as string) as {
        to: string[];
        subject: string;
        text: string;
      };
      expect(body.to).toEqual(["operacao@operator.invalid", "plantao@operator.invalid"]);
      expect(body.subject).toBe("[Freecorps Fiscal] Teste do alerta da captura: run 4242/2");
      expect(body.text).toContain("Nenhuma empresa está em alerta.");
      expect(body.text).toContain("ana-freecorps");
      // It points to the procedure, never to an issue that will close (#192).
      expect(body.text).toContain(
        'docs/operacao/captura-fiscal.md, seção "Testar o e-mail dos alertas"',
      );
      expect(body.text).not.toMatch(/#\d/);
      expect(JSON.stringify(body)).not.toContain(f.scope.companyId);
      expect(JSON.stringify(body)).not.toContain(CNPJ);
      // It is not an alert: nothing recorded, the hourly ceiling untouched.
      expect(await alerts(f)).toEqual([]);
      // The log names the run and the count, never the addresses.
      const lines = warn.mock.calls.map(([line]) => String(line));
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          type: "capture_alert_test",
          runId: "4242",
          runAttempt: 2,
          delivery: "sent",
          recipients: 2,
        },
      ]);
      expect(lines.join("\n")).not.toContain("operator.invalid");
    });

    it("sem destino não envia; 4xx falha e sem resposta fica incerto", async () => {
      const f = await fixture();
      const fetch = ok();
      vi.stubGlobal("fetch", fetch);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await f.t.action(internal.captureSupervisor.sendTestAlert, run)).toEqual({
        alertDestination: "unconfigured",
        recipients: 0,
        delivery: null,
        sentAt: null,
      });
      stub({ ...development, ...mail, EMAIL_MODE: "local" });
      expect(
        (await f.t.action(internal.captureSupervisor.sendTestAlert, run)).alertDestination,
      ).toBe("unconfigured");
      expect(fetch).not.toHaveBeenCalled();
      stub({ ...site, ...mail });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 403 })),
      );
      expect((await f.t.action(internal.captureSupervisor.sendTestAlert, run)).delivery).toBe(
        "failed",
      );
      const timeout = vi.fn(async () => {
        throw new DOMException("timeout", "TimeoutError");
      });
      vi.stubGlobal("fetch", timeout);
      expect((await f.t.action(internal.captureSupervisor.sendTestAlert, run)).delivery).toBe(
        "uncertain",
      );
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(await alerts(f)).toEqual([]);
    });
  });
});

describe("evento final da captura em Produção", () => {
  /** A production endpoint of the key's project, subscribed to `events`. */
  async function endpoint(
    f: Fixture,
    events: Doc<"webhookEndpoints">["events"],
    environment: "sandbox" | "production" = "production",
  ) {
    return f.t.run((ctx) =>
      ctx.db.insert("webhookEndpoints", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment,
        name: "Integração sintética",
        url: "https://receiver.operator.invalid/hook",
        events,
        active: true,
        version: 1,
        secretVersion: 1,
        secret: "synthetic-webhook-secret",
        projectEpoch: 0,
        grantEpoch: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
  const finalEvents = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("outboxEvents").collect()).filter(
        (event) => event.type === "connection.release_withdrawn",
      ),
    );
  const deliveriesOf = (f: Fixture, endpointId: Id<"webhookEndpoints">) =>
    f.t.run((ctx) =>
      ctx.db
        .query("webhookDeliveries")
        .filter((q) => q.eq(q.field("endpointId"), endpointId))
        .collect(),
    );

  it("desativar no console emite um evento que ainda é entregue depois da retirada", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const started = await f.command("activate");
    const subscribed = await endpoint(f, [
      "connection.release_withdrawn",
      "connection.attention_required",
    ]);
    const other = await endpoint(f, ["connection.attention_required"]);
    const sandbox = await endpoint(f, ["connection.release_withdrawn"], "sandbox");
    await f.withdraw();
    const [event, ...more] = await finalEvents(f);
    expect(more).toEqual([]);
    const paused = (await f.t.run((ctx) => ctx.db.get("captureStreams", started.id)))!;
    expect(paused).toMatchObject({ state: "paused", code: "CAPTURE_RELEASE_WITHDRAWN" });
    expect(event).toMatchObject({
      environment: "production",
      projectId: f.scope.projectId,
      resourceType: "connection",
      resourceId: started.id,
      resourceVersion: paused.version,
    });
    expect(await deliveriesOf(f, other)).toEqual([]);
    expect(await deliveriesOf(f, sandbox)).toEqual([]);
    const [queued] = await deliveriesOf(f, subscribed);
    // After the withdrawal, only this event keeps the endpoint's permission.
    const allowed = (type: string) =>
      f.t.run(async (ctx) =>
        endpointAllowed(ctx, (await ctx.db.get("webhookEndpoints", subscribed))!, type),
      );
    expect(await allowed("connection.release_withdrawn")).toBe(true);
    expect(await allowed("connection.attention_required")).toBe(false);
    const claimed = await f.t.mutation(internal.webhookDelivery.claim, {
      deliveryId: queued!._id,
      generation: 1,
    });
    expect(claimed?.event.type).toBe("connection.release_withdrawn");
    // The Freecorps emergency after the console withdrawal has no release to withdraw again.
    await f.t.mutation(internal.captureRelease.set, {
      ...f.ids,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética",
      runId: "4242",
      runAttempt: 1,
    });
    expect(await finalEvents(f)).toHaveLength(1);
  });

  it("a emergência emite o evento também com a captura já pausada; sem webhooks:manage não entrega", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const started = await f.command("activate");
    await f.command("pause", started.version);
    const subscribed = await endpoint(f, ["connection.release_withdrawn"]);
    await f.t.mutation(internal.captureRelease.set, {
      ...f.ids,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética",
      runId: "4242",
      runAttempt: 1,
    });
    const [event] = await finalEvents(f);
    const paused = (await f.t.run((ctx) => ctx.db.get("captureStreams", started.id)))!;
    // The code the company paused with stays; the version moves with the event.
    expect(paused.code).toBe("PAUSED_BY_USER");
    expect(event!.resourceVersion).toBe(paused.version);
    expect(paused.version).toBe(started.version + 2);
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, {
        scopes: grant.scopes.filter((scope) => scope !== "webhooks:manage"),
      });
    });
    const [queued] = await deliveriesOf(f, subscribed);
    expect(
      await f.t.mutation(internal.webhookDelivery.claim, {
        deliveryId: queued!._id,
        generation: 1,
      }),
    ).toBeNull();
    expect((await f.t.run((ctx) => ctx.db.get("webhookDeliveries", queued!._id)))!).toMatchObject({
      state: "paused",
      code: "ACCESS_REVOKED",
    });
  });

  it("liberar e retirar de novo emite outro evento, com versão maior, que o receptor não descarta", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    await f.command("activate");
    await endpoint(f, ["connection.release_withdrawn"]);
    await f.withdraw();
    // Released again, the stream stays paused: a release never resumes it.
    await f.release();
    await f.withdraw();
    const events = await finalEvents(f);
    expect(events).toHaveLength(2);
    expect(events[1]!.resourceVersion).toBeGreaterThan(events[0]!.resourceVersion);
    expect(events[1]!.logicalKey).not.toBe(events[0]!.logicalKey);
  });

  it("empresa nunca liberada: bloquear não emite evento", async () => {
    const f = await fixture();
    await f.stream({ state: "paused" });
    await f.t.mutation(internal.captureRelease.set, {
      ...f.ids,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética",
      runId: "4242",
      runAttempt: 1,
    });
    expect(await finalEvents(f)).toEqual([]);
  });
});

describe("monitores de empresa retirada", () => {
  it("param e dizem no painel que a captura foi retirada; reconfigurar limpa o aviso", async () => {
    const f = await fixture();
    await f.release();
    await f.production();
    const monitorId = await f.owner.mutation(api.observability.configure, {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "production",
      ownerMembershipId: f.owner.membershipId,
      enabled: true,
      notify: false,
      thresholds: defaultThresholds,
      expectedGeneration: 0,
    });
    await f.withdraw();
    const generation = (await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId)))!
      .generation;
    await f.t.mutation(internal.observability.evaluate, { monitorId, generation });
    const overview = await f.owner.query(api.observability.overview, {
      organizationId: f.scope.organizationId,
      contextKey: "monitores",
    });
    expect(overview.monitors[0]).toMatchObject({
      enabled: false,
      stopped: { code: "CAPTURE_RELEASE_WITHDRAWN", at: Date.now() },
    });
    await f.release();
    const stopped = overview.monitors[0]!;
    await f.owner.mutation(api.observability.configure, {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "production",
      ownerMembershipId: f.owner.membershipId,
      enabled: true,
      notify: false,
      thresholds: defaultThresholds,
      expectedGeneration: stopped.generation,
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId)))!.stopped,
    ).toBeUndefined();
  });

  it("outra perda de acesso é ACCESS_REVOKED, também em sandbox", async () => {
    const f = await fixture();
    const monitorId = await f.owner.mutation(api.observability.configure, {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      ownerMembershipId: f.owner.membershipId,
      enabled: true,
      notify: false,
      thresholds: defaultThresholds,
      expectedGeneration: 0,
    });
    await f.t.run((ctx) =>
      ctx.db.patch("memberships", f.owner.membershipId, { role: "operator", version: 2 }),
    );
    const generation = (await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId)))!
      .generation;
    await f.t.mutation(internal.observability.evaluate, { monitorId, generation });
    expect(
      (await f.t.run((ctx) => ctx.db.get("operationalMonitors", monitorId)))!.stopped?.code,
    ).toBe("ACCESS_REVOKED");
  });
});

describe("visão interna", () => {
  it("lista a empresa com liberação, stream, certificado, supervisão e alertas, sem CNPJ", async () => {
    const f = await fixture({ certificateDays: 20 });
    await f.release();
    await f.stream({ lastSuccessAt: T0 });
    f.at(T0 + 31 * DAY);
    await f.check();
    const survey = await f.t.mutation(internal.captureSupervisor.survey, {});
    expect(survey.deployment).toEqual({
      captureFiscal: true,
      transport: true,
      halted: false,
      alertDestination: "unconfigured",
    });
    expect(survey.companies).toHaveLength(1);
    expect(survey.companies[0]).toMatchObject({
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      release: "released",
      minIntervalHours: 1,
      stream: { state: "paused", code: "PAUSED_BY_USER", lastSuccessAt: T0 },
      certificate: { own: true, notAfter: T0 + 20 * DAY },
      supervision: { armed: true, checkedAt: T0 + 31 * DAY, failing: false },
    });
    expect(survey.companies[0]!.alerts.map((a) => a.kind).sort()).toEqual(["certificate", "quiet"]);
    expect(survey.recent).toEqual(
      expect.arrayContaining([
        { kind: "quiet", code: "PAUSED_BY_USER", count: 1 },
        { kind: "certificate", code: "0d", count: 1 },
      ]),
    );
    expect(JSON.stringify(survey)).not.toContain(CNPJ);
    await f.t.mutation(internal.captureRelease.set, {
      ...f.ids,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética",
      runId: "4242",
      runAttempt: 1,
    });
    expect((await f.t.mutation(internal.captureSupervisor.survey, {})).companies[0]!.release).toBe(
      "blocked",
    );
  });
});
