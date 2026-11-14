import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requirePlatformEnvironment } from "../environment";
import { SITE_CAPTURE_ACTION, SITE_CAPTURE_HOURLY_LIMIT } from "./siteCapture";
import {
  CAPTURE_TERMS_ARCHIVE,
  CAPTURE_TERMS_REACCEPT_DAYS,
  CAPTURE_TERMS_VERSION,
} from "./fiscalCaptureRelease";
import { distributionXml, nsu } from "../../../tests/helpers/distribution";
import { errorResponse, routes } from "../../../packages/contracts/src/external";
import {
  development,
  site,
  stub,
  siteFixture,
  rest,
  foreignKey,
  transportOk,
  respond,
  streamOf,
} from "../../../tests/helpers/siteCapture";

/**
 * ADR 0007, phase 4: on the hosted site, a released company's production stream reaches the
 * distribution in production through its own policy, never the #50 one. Synthetic transport only.
 */
vi.mock("../buildInfo", () => ({ buildSha: "a".repeat(40) }));

beforeEach(() => {
  vi.useFakeTimers();
  stub(development);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("perfil do site", () => {
  it("aceita o transporte real com FISCAL_ENV desligado e informa captureFiscal", () => {
    stub(site);
    expect(requirePlatformEnvironment()).toMatchObject({
      fiscalEnv: "disabled",
      captureFiscal: "enabled",
    });
    for (const [name, value] of [
      ["FNFE_CAPTURE_TRANSPORT", "disabled"],
      ["FNFE_CAPTURE_TRANSPORT", undefined],
      ["FNFE_CAPTURE_FISCAL", undefined],
    ] as const) {
      stub(site);
      vi.stubEnv(name, value);
      expect(requirePlatformEnvironment().captureFiscal, `${name}=${value}`).toBe("disabled");
    }
  });
  it("recusa a política da #50, transporte desconhecido e FISCAL_ENV ligado", () => {
    for (const [name, value, error] of [
      ["FNFE_FISCAL_PROOF", "{}", "FNFE_FISCAL_PROOF"],
      ["FNFE_CAPTURE_TRANSPORT", "simulated", "FNFE_CAPTURE_TRANSPORT"],
      ["FISCAL_ENV", "production", "disabled fiscal transport required"],
    ] as const) {
      vi.unstubAllEnvs();
      stub(site);
      vi.stubEnv(name, value);
      expect(() => requirePlatformEnvironment(), name).toThrow(error);
    }
  });
});

describe("transporte real no site", () => {
  it("empresa liberada consulta www1 com tpAmb=1, auditada como captura do site", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).not.toBeNull();
    await f.t.mutation(internal.certificateUse.complete, { ...token, result: "success" });
    const transport = transportOk();
    try {
      const result = await f.t.action(internal.captureWorker.execute, { ...token, request: "{}" });
      expect(result.kind).toBe("success");
      expect(transport).toHaveBeenCalledTimes(1);
      const request = transport.mock.calls[0]![2];
      expect(request.url).toBe(
        "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
      );
      expect(request.body).toContain("<tpAmb>1</tpAmb>");
    } finally {
      transport.mockRestore();
    }
    const audit = await f.t.run((ctx) => ctx.db.query("certificateAudit").collect());
    expect(audit.map((a) => [a.action, a.result])).toEqual(
      expect.arrayContaining([[SITE_CAPTURE_ACTION, "authorized"]]),
    );
    expect(audit.some((a) => a.action === "transport")).toBe(false);
  });
  it("stream de sandbox no site continua sem transporte fiscal", async () => {
    const f = await siteFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("apiKeys", f.scope.keyId, { environment: "sandbox" });
    });
    const stream = await f.command("sandbox", "activate");
    const token = await f.claim(stream.operationId);
    const transport = transportOk();
    try {
      const result = await f.t.action(internal.captureWorker.execute, { ...token, request: "{}" });
      expect(result).toMatchObject({ code: "FISCAL_TRANSPORT_DISABLED" });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });
  it("sem FNFE_CAPTURE_TRANSPORT, prepare pausa sem reservar a janela", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const before = (await f.t.run((ctx) => ctx.db.get("captureStreams", stream.id)))!;
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
    const [op, after] = await f.t.run(async (ctx) => [
      await ctx.db.get("operations", stream.operationId),
      await ctx.db.get("captureStreams", stream.id),
    ]);
    expect(op).toMatchObject({
      state: "paused",
      code: "FISCAL_TRANSPORT_DISABLED",
      uncertain: false,
    });
    expect(after!.nextAllowedAt).toBe(before.nextAllowedAt);
    expect(op!.usageCaptureKey).toBeUndefined();
  });
  it("sem FNFE_CAPTURE_FISCAL a empresa vale como retirada: nada é preparado nem autorizado", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const before = (await f.t.run((ctx) => ctx.db.get("captureStreams", stream.id)))!;
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    const after = (await f.t.run((ctx) => ctx.db.get("captureStreams", stream.id)))!;
    expect(after.nextAllowedAt).toBe(before.nextAllowedAt);
  });
  it("a parada geral persistida fecha prepare e authorize sem editar variável (#424)", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const before = (await f.t.run((ctx) => ctx.db.get("captureStreams", stream.id)))!;
    const halt = (kind: "halt" | "resume") =>
      f.t.mutation(internal.captureRelease.setHalt, {
        kind,
        operator: "ana-freecorps",
        reason: "Parada sintética de todas as empresas",
        runId: "4242",
        runAttempt: 1,
      });
    const health = async () =>
      ((await (await f.t.fetch("/health")).json()) as { captureFiscal: string }).captureFiscal;
    const view = async () =>
      JSON.parse(
        await f.t.mutation(internal.captureRest.dispatch, {
          keyHash: f.keyHash,
          environment: "production",
          companyId: f.scope.companyId,
        }),
      ) as { state: string; code: string | null };
    expect(await health()).toBe("enabled");
    await halt("halt");
    expect(await health()).toBe("halted");
    expect(await view()).toMatchObject({ state: "active", code: "CAPTURE_FISCAL_HALTED" });
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    const deferred = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
    expect(deferred.waitUntil).toBe(Date.now() + 3_600_000);
    const [op, after, audit, events] = await f.t.run(async (ctx) => [
      await ctx.db.get("operations", stream.operationId),
      await ctx.db.get("captureStreams", stream.id),
      await ctx.db.query("captureAudit").collect(),
      await ctx.db.query("outboxEvents").collect(),
    ]);
    // Postponed, not paused: no attention, no webhook, no usage nor window spent.
    expect(op!.state).toBe("running");
    expect(op!.usageCaptureKey).toBeUndefined();
    expect(after).toMatchObject({ state: "active", nextAllowedAt: deferred.waitUntil });
    expect(after!.code).toBeUndefined();
    expect(audit.map((a) => a.action)).toContain("fiscal_halt_deferred");
    expect(audit.map((a) => a.action)).not.toContain("budget_deferred");
    expect(events.some((e) => e.type === "connection.attention_required")).toBe(false);
    expect(before.nextAllowedAt).toBeLessThanOrEqual(Date.now());
    await halt("resume");
    expect(await health()).toBe("enabled");
    // Without the variables, the resume opens nothing and /health keeps saying disabled.
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
    await halt("halt");
    expect(await health()).toBe("disabled");
  });
  it("passado o prazo dos novos termos, prepare e authorize adiam até o aceite (#428)", async () => {
    const deadline =
      Date.parse(`${CAPTURE_TERMS_ARCHIVE[CAPTURE_TERMS_VERSION]!.since}T00:00:00-03:00`) +
      CAPTURE_TERMS_REACCEPT_DAYS * 86_400_000;
    vi.setSystemTime(Math.max(Date.now(), deadline));
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const accepted = (terms: string) =>
      f.t.run(async (ctx) => {
        const event = (await ctx.db
          .query("captureReleaseEvents")
          .withIndex("by_companyId_and_version", (q) => q.eq("companyId", f.scope.companyId))
          .order("desc")
          .first())!;
        await ctx.db.patch("captureReleaseEvents", event._id, { terms });
      });
    await accepted("captura-fiscal-2026-01-01");
    const view = async () =>
      JSON.parse(
        await f.t.mutation(internal.captureRest.dispatch, {
          keyHash: f.keyHash,
          environment: "production",
          companyId: f.scope.companyId,
        }),
      ) as { state: string; code: string | null };
    expect(await view()).toMatchObject({ state: "active", code: "CAPTURE_TERMS_PENDING" });
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    const deferred = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
    expect(deferred.waitUntil).toBe(Date.now() + 3_600_000);
    const [op, after, audit] = await f.t.run(async (ctx) => [
      await ctx.db.get("operations", stream.operationId),
      await ctx.db.get("captureStreams", stream.id),
      await ctx.db.query("captureAudit").collect(),
    ]);
    // Postponed, not paused: no attention, no usage spent.
    expect(op!.state).toBe("running");
    expect(op!.usageCaptureKey).toBeUndefined();
    expect(after).toMatchObject({ state: "active", nextAllowedAt: deferred.waitUntil });
    expect(audit.map((a) => a.action)).toContain("terms_deferred");
    await accepted(CAPTURE_TERMS_VERSION);
    expect(await view()).toMatchObject({ state: "active", code: null });
  });
  it("uma parada longa só adia: não esgota a operação, e depois do resume o próximo tick consulta", async () => {
    const f = await siteFixture();
    const person = {
      operator: "ana-freecorps",
      reason: "Parada sintética",
      runId: "1",
      runAttempt: 1,
    };
    const stream = await f.command("production", "activate");
    await f.t.mutation(internal.captureRelease.setHalt, { kind: "halt", ...person });
    const transport = transportOk();
    try {
      // More deferrals than the operation's attempts (6) and recovery budget (12).
      for (let hour = 0; hour < 14; hour++) {
        const token = await f.claim(stream.operationId);
        const result = await f.t.action(internal.captureWorker.execute, {
          ...token,
          request: "{}",
        });
        expect(result).toMatchObject({ kind: "wait", code: "SOURCE_COOLDOWN" });
        await f.t.mutation(internal.operations.recordOutcome, { ...token, outcome: result });
      }
      expect(transport).not.toHaveBeenCalled();
      const [op, view, failures, events] = await f.t.run(async (ctx) => [
        await ctx.db.get("operations", stream.operationId),
        await ctx.db.get("captureStreams", stream.id),
        await ctx.db.query("certificateAudit").collect(),
        await ctx.db.query("outboxEvents").collect(),
      ]);
      // No attempt nor recovery spent by any deferral, and no failure for the monitors (#421).
      expect(op).toMatchObject({
        state: "retry_wait",
        code: "SOURCE_COOLDOWN",
        attempts: 0,
        recoveryAttempts: 0,
        maxAttempts: 6,
      });
      expect(await f.t.run((ctx) => ctx.db.query("operationalFailures").collect())).toEqual([]);
      expect(view!.state).toBe("active");
      expect(failures.some((row) => row.result === "authorized")).toBe(false);
      expect(events.some((e) => e.type === "connection.attention_required")).toBe(false);
      const usage = await f.t.run((ctx) =>
        ctx.db
          .query("usageEvents")
          .filter((q) => q.eq(q.field("metric"), "captures"))
          .collect(),
      );
      expect(usage).toEqual([]);
      await f.t.mutation(internal.captureRelease.setHalt, { kind: "resume", ...person });
      // The next tick queries: nothing to reschedule, and the customer did nothing.
      const token = await f.claim(stream.operationId);
      const result = await f.t.action(internal.captureWorker.execute, { ...token, request: "{}" });
      expect(result.kind).toBe("success");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      transport.mockRestore();
    }
  });
  it("desbloquear empresa liberada é recusado e o stream segue ativo (#424)", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    await expect(
      f.t.mutation(internal.captureRelease.set, {
        companyId: f.scope.companyId,
        kind: "unblock",
        operator: "ana-freecorps",
        reason: "Desbloqueio sintético indevido",
        runId: "4242",
        runAttempt: 1,
      }),
    ).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    expect(await f.t.run((ctx) => ctx.db.get("captureStreams", stream.id))).toMatchObject({
      state: "active",
    });
  });
  it("empresa retirada não consulta: prepare e authorize recusam", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    await f.setRelease(false);
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
  });
  it("certificado de outro CNPJ ou vencido não abre o cofre", async () => {
    for (const change of [{ cnpj: "99888777000166" }, { notAfter: Date.now() - 1 }]) {
      vi.unstubAllEnvs();
      stub(development);
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      await f.t.run(async (ctx) => {
        const op = (await ctx.db.get("operations", stream.operationId))!;
        const cert = (await ctx.db.get("certificates", op.certificate!.id))!;
        await ctx.db.patch("certificates", cert._id, {
          metadata: { ...cert.metadata!, ...change },
        });
      });
      expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    }
  });
  it("o teto por hora adia a consulta sem gastar cota nem janela", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const oldest = Date.now() - 10 * 60_000;
    await f.t.run(async (ctx) => {
      const op = (await ctx.db.get("operations", stream.operationId))!;
      const cert = (await ctx.db.get("certificates", op.certificate!.id))!;
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
    const input = (await f.t.mutation(internal.captureProcessing.prepare, token))!;
    expect(input.waitUntil).toBe(oldest + 3_600_000);
    const op = (await f.t.run((ctx) => ctx.db.get("operations", stream.operationId)))!;
    expect(op.usageCaptureKey).toBeUndefined();
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
  });
  it("a política da #50 não vale no site, e a do site não vale na validação", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    stub({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
      FISCAL_ENV: "production",
    });
    // Without the #50 policy, the validation target refuses the same released company.
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    const audit = await f.t.run((ctx) => ctx.db.query("certificateAudit").collect());
    expect(audit.at(-1)).toMatchObject({ action: "transport", result: "denied" });
  });
});

it("a produção fiscal da NFS-e recusa a chave da captura do site", async () => {
  const forbidden = (await import("./issuanceProduction"))
    .issuanceProductionForbiddenVariables as readonly string[];
  expect(forbidden).toContain("FNFE_CAPTURE_FISCAL");
});

describe("agenda, 656 e retirada", () => {
  it("um intervalo fora de 1 a 24 h gravado no banco é limitado", async () => {
    const f = await siteFixture({ released: false });
    await f.setRelease(true, 10_000);
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const now = Date.now();
    await respond(f, token, distributionXml({ status: "137", environment: "1" }));
    expect((await streamOf(f, stream.id)).nextAllowedAt).toBeLessThanOrEqual(
      now + 24 * 3_600_000 + 1000,
    );
  });
  it("no fim da fila espera o intervalo da empresa", async () => {
    const f = await siteFixture({ released: false });
    await f.setRelease(true, 6);
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const now = Date.now();
    await respond(f, token, distributionXml({ status: "137", environment: "1" }));
    expect((await streamOf(f, stream.id)).nextAllowedAt).toBeGreaterThanOrEqual(
      now + 6 * 3_600_000,
    );
  });
  it("um 999 repete a consulta só depois do intervalo da empresa, sem alerta (#195)", async () => {
    const f = await siteFixture({ released: false });
    await f.setRelease(true, 6);
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    const now = Date.now();
    await respond(f, token, distributionXml({ status: "999", environment: "1" }));
    const retrying = await streamOf(f, stream.id);
    expect(retrying).toMatchObject({ state: "active", code: "SOURCE_999", sourceErrors: 1 });
    // The source's hour is not enough: the retry spends no more queries than the release allows.
    expect(retrying.nextAllowedAt).toBeGreaterThanOrEqual(now + 6 * 3_600_000);
    expect(await f.t.run((ctx) => ctx.db.query("captureAlerts").collect())).toEqual([]);
  });
  it("656 entra em atenção, conta como falha da fonte e só retoma depois da janela", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    await respond(f, token, distributionXml({ status: "656", environment: "1" }));
    const blocked = await streamOf(f, stream.id);
    expect(blocked).toMatchObject({ state: "attention", code: "SOURCE_CONSUMPTION_BLOCKED" });
    const failures = await f.t.run((ctx) => ctx.db.query("operationalFailures").collect());
    expect(failures.map((row) => [row.source, row.code])).toContainEqual([
      "nfe-distribution",
      "SOURCE_CONSUMPTION_BLOCKED",
    ]);
    const resume = () =>
      f.t.mutation(internal.captureRest.dispatch, {
        keyHash: f.keyHash,
        environment: "production",
        companyId: f.scope.companyId,
        action: "resume",
        expectedVersion: blocked.version,
      });
    await expect(resume()).rejects.toThrow("SOURCE_COOLDOWN");
    vi.setSystemTime(blocked.nextAllowedAt + 1);
    await expect(resume()).resolves.toBeTruthy();
  });
  it("pela API, sourceMaxNsu fica null até a primeira resposta e só o projeto dono o lê (#494)", async () => {
    const f = await siteFixture();
    const read = async (secret = f.secret) => {
      const answer = await rest(f, secret, "GET");
      return { ...answer, parsed: routes.getCapture.output.safeParse(answer.body) };
    };
    expect((await read()).body.data).toBeNull();
    const stream = await f.command("production", "activate");
    const pending = await read();
    expect(pending.parsed.success && pending.parsed.data.data).toMatchObject({
      sourceMaxNsu: null,
    });
    const token = await f.claim(stream.operationId);
    await respond(f, token, distributionXml({ status: "137", last: 3, max: 3, environment: "1" }));
    const answered = await read();
    expect(answered.status).toBe(200);
    expect(answered.parsed.success && answered.parsed.data.data).toMatchObject({
      sourceMaxNsu: nsu(3),
    });
    // Another project of the organization sees no stream; another organization, no company.
    const project = await read(await foreignKey(f, "project"));
    expect(project.status).toBe(200);
    expect(project.body.data).toBeNull();
    const organization = await read(await foreignKey(f, "organization"));
    expect(organization.status).toBe(404);
    expect(errorResponse.parse(organization.body).error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(organization.body)).not.toContain(nsu(3));
  });
  it("pela API, retomar antes da janela do 656 recebe SOURCE_COOLDOWN com nextAllowedAt (#494)", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const token = await f.claim(stream.operationId);
    await respond(f, token, distributionXml({ status: "656", environment: "1" }));
    const blocked = await streamOf(f, stream.id);
    const resume = (secret: string) =>
      rest(f, secret, "POST", {
        companyId: f.scope.companyId,
        action: "resume",
        expectedVersion: blocked.version,
      });
    const refused = await resume(f.secret);
    expect(refused.status).toBe(409);
    expect(errorResponse.parse(refused.body).error).toMatchObject({
      code: "SOURCE_COOLDOWN",
      retryable: true,
      nextAllowedAt: blocked.nextAllowedAt,
    });
    // Neither another project of the organization nor another organization learns the window.
    for (const owner of ["project", "organization"] as const) {
      const other = await resume(await foreignKey(f, owner));
      expect(other.status, owner).toBe(404);
      expect(errorResponse.parse(other.body).error.code, owner).toBe("NOT_FOUND");
      expect(JSON.stringify(other.body), owner).not.toContain("nextAllowedAt");
      expect(JSON.stringify(other.body), owner).not.toContain("SOURCE_COOLDOWN");
    }
    expect((await streamOf(f, stream.id)).version).toBe(blocked.version);
    vi.setSystemTime(blocked.nextAllowedAt + 1);
    const resumed = await resume(f.secret);
    expect(resumed.status).toBe(200);
    expect(routes.controlCapture.output.parse(resumed.body).data.state).toBe("active");
  });
  it("656: uma hora contada da resposta, alerta da Freecorps, e outro 656 depois da retomada para de novo (#425)", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const resume = (expectedVersion: number) =>
      f.t.mutation(internal.captureRest.dispatch, {
        keyHash: f.keyHash,
        environment: "production",
        companyId: f.scope.companyId,
        action: "resume",
        expectedVersion,
      });
    const blockedOnce = async (operationId: Id<"operations">) => {
      const token = await f.claim(operationId);
      await respond(f, token, distributionXml({ status: "656", environment: "1" }));
      const blocked = await streamOf(f, stream.id);
      expect(blocked).toMatchObject({ state: "attention", code: "SOURCE_CONSUMPTION_BLOCKED" });
      expect(blocked.nextAllowedAt).toBe(Date.now() + 3_600_000);
      return blocked;
    };
    const first = await blockedOnce(stream.operationId);
    const [alerts, audit] = await f.t.run(async (ctx) => [
      await ctx.db.query("captureAlerts").collect(),
      await ctx.db.query("captureAudit").collect(),
    ]);
    expect(alerts.map((a) => [a.kind, a.code])).toEqual([
      ["attention", "SOURCE_CONSUMPTION_BLOCKED"],
    ]);
    expect(audit.map((a) => a.action)).toContain("recovery_backoff");
    vi.setSystemTime(first.nextAllowedAt);
    await resume(first.version);
    const again = await blockedOnce((await streamOf(f, stream.id)).operationId!);
    expect(again.version).toBeGreaterThan(first.version);
    await expect(resume(again.version)).rejects.toThrow("SOURCE_COOLDOWN");
    const events = await f.t.run(async (ctx) =>
      (await ctx.db.query("outboxEvents").collect()).filter(
        (e) => e.type === "connection.attention_required",
      ),
    );
    expect(events).toHaveLength(2);
  });
  it("retirar a liberação pausa o stream e a operação", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    await f.t.mutation(internal.captureRelease.set, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética da captura",
      runId: "4242",
      runAttempt: 1,
    });
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "paused",
      code: "CAPTURE_RELEASE_WITHDRAWN",
    });
    // A withdrawal is a decision, not a source failure for the monitors.
    const failures = await f.t.run((ctx) => ctx.db.query("operationalFailures").collect());
    expect(failures.some((row) => row.code === "CAPTURE_RELEASE_WITHDRAWN")).toBe(false);
    const op = (await f.t.run((ctx) => ctx.db.get("operations", stream.operationId)))!;
    expect(op.state).toBe("paused");
  });
});
