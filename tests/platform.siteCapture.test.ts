/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { capturePlan, person } from "./helpers/platform";
import { fixture as corpus } from "./helpers/nfe-corpus";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { requirePlatformEnvironment } from "../platform/convex/environment";
import { SITE_CAPTURE_ACTION, SITE_CAPTURE_HOURLY_LIMIT } from "../platform/convex/lib/siteCapture";
import {
  CAPTURE_TERMS_ARCHIVE,
  CAPTURE_TERMS_REACCEPT_DAYS,
  CAPTURE_TERMS_VERSION,
} from "../platform/convex/lib/fiscalCaptureRelease";
import * as certificateRuntime from "../platform/convex/lib/certificateRuntime";
import * as certificateAccess from "../platform/convex/lib/certificateAccess";
import * as siteCapture from "../platform/convex/lib/siteCapture";
import * as certificateTransport from "../platform/convex/lib/certificateTransport";
import * as certificateCrypto from "../platform/convex/lib/certificateCrypto";
import { defaultThresholds } from "../platform/convex/lib/operationalMetrics";
import { distributionXml, nsu } from "./helpers/distribution";
import { parseDistribution } from "../packages/fiscal-nfe/src/distribution";
import { createHash } from "node:crypto";
import { captureProcessingTask } from "../platform/convex/lib/captureValues";
import { gunzipSync } from "node:zlib";
import type { Claim } from "../platform/convex/lib/operationCore";
import { recordUsage, requireQuota } from "../platform/convex/lib/usageCore";
import { publicError } from "../platform/convex/lib/publicErrors";
import { ConvexError } from "convex/values";
import { signApiRequest } from "../platform/auth-transport";
import { errorResponse, routes } from "../packages/contracts/src/external";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import { usagePeriod } from "../platform/convex/lib/usageValues";

/**
 * ADR 0007, phase 4: on the hosted site, a released company's production stream reaches the
 * distribution in production through its own policy, never the #50 one. Synthetic transport only.
 */
vi.mock("../platform/convex/buildInfo", () => ({ buildSha: "a".repeat(40) }));
const modules = import.meta.glob("../platform/convex/**/*.ts");
const CNPJ = "00000000000191";
const development = {
  APP_ENV: "development",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "local",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "http://localhost:5209",
  CONVEX_SITE_URL: "http://127.0.0.1:3269",
  BETTER_AUTH_SECRET: "synthetic-site-capture",
};
const site = {
  APP_ENV: "installation",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "b".repeat(64),
  SITE_URL: "https://console.operator.invalid",
  CONVEX_SITE_URL: "https://api.operator.invalid",
  API_URL: "https://rest.operator.invalid",
  BETTER_AUTH_SECRET: "synthetic-site-capture",
  FNFE_CAPTURE_FISCAL: "enabled",
  FNFE_CAPTURE_TRANSPORT: "sefaz",
};
const stub = (profile: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(profile)) vi.stubEnv(name, value);
};
beforeEach(() => {
  vi.useFakeTimers();
  stub(development);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A released company with a production key, built locally, then served by the site profile. */
async function siteFixture(options: { released?: boolean; plan?: boolean } = {}) {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`;
  const keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  await t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    const scopes = [...key.scopes, "connections:read", "documents:read"] as const;
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      environment: "production",
      expiresAt: Date.now() + 10 * 86400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...scopes],
      environments: ["sandbox", "production"],
    });
    await ctx.db.patch("companies", scope.companyId, { kind: "declared", cnpj: CNPJ });
    const id = await ctx.db.insert("certificates", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      version: 1,
      state: "active",
      uploaderId: "proof",
      membershipId: key.creatorMembershipId,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "test",
        cnpj: CNPJ,
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 30 * 86400_000,
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
  });
  const setRelease = (released: boolean, minIntervalHours = 1) =>
    t.run(async (ctx) => {
      const prior = await ctx.db
        .query("captureReleases")
        .withIndex("by_companyId", (q) => q.eq("companyId", scope.companyId))
        .unique();
      const version = (prior?.version ?? 0) + 1;
      const base = {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        released,
        blocked: false,
        minIntervalHours,
      };
      const eventId = await ctx.db.insert("captureReleaseEvents", {
        ...base,
        version,
        kind: released ? "console_release" : "console_withdraw",
        ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
        revokedKeys: 0,
        reason: "Liberação sintética",
        buildSha: null,
        deployment: "",
        createdAt: Date.now(),
      });
      const state = {
        ...base,
        releasedBefore: true,
        actor: "member:synthetic",
        reason: "Liberação sintética",
        version,
        updatedAt: Date.now(),
        eventId,
      };
      if (prior) await ctx.db.replace("captureReleases", prior._id, state);
      else await ctx.db.insert("captureReleases", state);
    });
  if (options.released ?? true) await setRelease(true);
  // Production capture requires the organization's plan with finite quotas (#429); the tests
  // without it pass `plan: false`.
  if (options.plan ?? true) await capturePlan(t, scope.organizationId);
  stub(site);
  const command = async (environment: "sandbox" | "production", action?: "activate") =>
    JSON.parse(
      await t.mutation(internal.captureRest.dispatch, {
        keyHash,
        environment,
        companyId: scope.companyId,
        ...(action ? { action } : {}),
      }),
    ) as { id: Id<"captureStreams">; operationId: Id<"operations"> };
  const claim = async (operationId: Id<"operations">) => {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    const claimed = (await t.mutation(internal.operations.claim, {
      operationId,
      generation: op.generation,
    }))!;
    const token = { operationId, generation: claimed.generation, fence: claimed.fence };
    await t.mutation(internal.operations.beginEffect, token);
    return token;
  };
  return { t, scope, keyHash, secret, command, claim, setRelease };
}
type SiteFixture = Awaited<ReturnType<typeof siteFixture>>;
/** The public REST of the site, signed like the Worker: an installation refuses direct calls. */
async function rest(f: SiteFixture, secret: string, method: "GET" | "POST", body?: unknown) {
  const path =
    method === "GET" ? `/v1/connections/nfe?companyId=${f.scope.companyId}` : "/v1/connections/nfe";
  const signed = await signApiRequest(
    { method, url: site.CONVEX_SITE_URL + path },
    "203.0.113.9",
    site.AUTH_PROXY_SECRET,
  );
  const response = await f.t.fetch(path, {
    method,
    headers: {
      ...signed,
      Authorization: `Bearer ${secret}`,
      "X-Environment": "production",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
/**
 * A production key for `f`'s company held by someone else: another project of the same
 * organization, granted the company, or a project of another organization, granted nothing here.
 */
async function foreignKey(f: SiteFixture, owner: "project" | "organization") {
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "b")}`;
  const keyHash = await hashApiKey(secret);
  const scopes = ["connections:read", "connections:write", "documents:read"] as const;
  if (owner === "organization") {
    // The synthetic organization is prepared on the local profile, as `siteFixture` does.
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash,
      suffix: crypto.randomUUID(),
    });
    vi.unstubAllEnvs();
    stub(site);
    await f.t.run((ctx) =>
      ctx.db.patch("apiKeys", other.keyId, {
        scopes: [...scopes],
        environment: "production",
        expiresAt: Date.now() + 10 * 86400_000,
      }),
    );
    return secret;
  }
  await f.t.run(async (ctx) => {
    const own = (await ctx.db.get("projects", f.scope.projectId))!;
    const projectId = await ctx.db.insert("projects", {
      ...pick(own),
      name: "Outro projeto",
      externalReference: crypto.randomUUID(),
    });
    await ctx.db.insert("projectCompanies", {
      organizationId: f.scope.organizationId,
      projectId,
      companyId: f.scope.companyId,
      scopes: [...scopes],
      environments: ["production"],
      active: true,
      version: 1,
      accessEpoch: 0,
    });
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.insert("apiKeys", {
      ...pick(key),
      projectId,
      keyHash,
      scopes: [...scopes],
      environment: "production",
      companyIds: [f.scope.companyId],
      grantEpochs: [0],
      expiresAt: Date.now() + 10 * 86400_000,
    });
  });
  return secret;
}
const pick = <T extends { _id: unknown; _creationTime: unknown }>({
  _id,
  _creationTime,
  ...rest
}: T) => rest;
const transportOk = () =>
  vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0, environment: "1" }),
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
  const forbidden = (await import("../platform/convex/lib/issuanceProduction"))
    .issuanceProductionForbiddenVariables as readonly string[];
  expect(forbidden).toContain("FNFE_CAPTURE_FISCAL");
});

/** A durable source response through prepare, raw, describe, outcome and checkpoint. */
async function respond(f: Awaited<ReturnType<typeof siteFixture>>, token: Claim, bytes: Buffer) {
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
  for (const [position, e] of parsed.envelopes.entries()) {
    const storageId = await f.t.run((ctx) => ctx.storage.store(new Blob([Uint8Array.from(e.xml)])));
    expect(
      await f.t.mutation(internal.captureProcessing.envelope, {
        ...token,
        batchId,
        position,
        nsu: e.nsu,
        schema: e.schema,
        sha256: e.sha256,
        size: e.xml.length,
        storageId,
      }),
    ).toBe(true);
  }
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await f.t.mutation(internal.operations.checkpoint, token);
}
const streamOf = (f: Awaited<ReturnType<typeof siteFixture>>, id: Id<"captureStreams">) =>
  f.t.run(async (ctx) => (await ctx.db.get("captureStreams", id))!);

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

/**
 * #418: a production capture never stops in silence. Each pause turns the stream to attention,
 * with its code and one `connection.attention_required`; the next queries follow the company's
 * release and its current A1, not the person who clicked "Iniciar"; a quota pause comes back by
 * itself when the quota does.
 */
describe("continuidade da captura em Produção", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const ATTENTION = "connection.attention_required";
  const attentionEvents = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("outboxEvents").collect()).filter((event) => event.type === ATTENTION),
    );
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  const headOf = (f: Fixture) =>
    f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!,
    );
  /** The owner starts the company's production capture in the console. */
  async function consoleStart(f: Fixture) {
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const view = await owner.mutation(api.captures.activate, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
    });
    return { owner, streamId: view.id, operationId: view.operationId! };
  }
  /** One query answered with 137 and published: returns the next one the stream scheduled. */
  async function cycle(f: Fixture, streamId: Id<"captureStreams">, operationId: Id<"operations">) {
    const token = await f.claim(operationId);
    await respond(f, token, distributionXml({ status: "137", environment: "1" }));
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const stream = await streamOf(f, streamId);
    expect(stream.state).toBe("active");
    expect(stream.operationId).not.toBe(operationId);
    return stream.operationId!;
  }
  /** Claims the operation at its time; null when the claim refused it. */
  async function claimAt(f: Fixture, id: Id<"operations">) {
    const op = await opOf(f, id);
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    const claimed = await f.t.mutation(internal.operations.claim, {
      operationId: id,
      generation: op.generation,
    });
    return claimed
      ? { operationId: id, generation: claimed.generation, fence: claimed.fence }
      : null;
  }
  /** The company renews its A1: a new certificate with `cnpj` becomes the active one. */
  const renew = (f: Fixture, cnpj = CNPJ) =>
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
        metadata: {
          ...old.metadata!,
          fingerprint: "d".repeat(64),
          cnpj,
          notAfter: Date.now() + 365 * 86400_000,
        },
      });
      await ctx.db.patch("certificates", old._id, { state: "replaced" });
      await ctx.db.patch("certificateHeads", head._id, {
        activeId: id,
        latestId: id,
        nextVersion: head.nextVersion + 1,
      });
      return id;
    });
  /** The stream's automatic resumption the server scheduled, if any. */
  const scheduledResume = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const rows = await ctx.db.system.query("_scheduled_functions").collect();
      const row = rows
        .filter((r) => r.name.includes("resumeEligible") && r.state.kind === "pending")
        .at(-1);
      return row
        ? {
            args: row.args[0] as { streamId: Id<"captureStreams">; version: number },
            at: row.scheduledTime,
          }
        : null;
    });

  it("renovação do A1 da própria empresa: a consulta seguinte usa o certificado novo", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const renewed = await renew(f);
    const token = await claimAt(f, next);
    expect(token).not.toBeNull();
    expect((await opOf(f, next)).certificate?.id).toBe(renewed);
    expect((await f.t.mutation(internal.certificateUse.authorize, token!))?._id).toBe(renewed);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
    expect(await attentionEvents(f)).toHaveLength(0);
  });

  it("A1 ativo de outro CNPJ ou vencido não passa: a captura entra em atenção", async () => {
    for (const change of ["foreign", "expired"] as const) {
      vi.unstubAllEnvs();
      stub(development);
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      if (change === "foreign") await renew(f, "99888777000166");
      else {
        const head = await headOf(f);
        const due = (await opOf(f, next)).nextAttemptAt;
        await f.t.run(async (ctx) => {
          const cert = (await ctx.db.get("certificates", head.activeId!))!;
          await ctx.db.patch("certificates", cert._id, {
            metadata: { ...cert.metadata!, notAfter: due - 1 },
          });
        });
      }
      expect(await claimAt(f, next), change).toBeNull();
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: "CERTIFICATE_UNAVAILABLE",
      });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "CERTIFICATE_UNAVAILABLE",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    }
  });

  it("um A1 válido da empresa ativado depois da atenção retoma a captura sozinho", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const expired = await headOf(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("certificates", expired.activeId!, { state: "expired" });
      await ctx.db.patch("certificateHeads", expired._id, { activeId: undefined });
    });
    expect(await claimAt(f, next)).toBeNull();
    expect((await streamOf(f, streamId)).code).toBe("CERTIFICATE_UNAVAILABLE");
    expect(await scheduledResume(f)).toBeNull();
    // The owner uploads the renewed A1; the vault validates it and makes it active.
    const uploaded = await f.t.run(async (ctx) => {
      const old = (await ctx.db.get("certificates", expired.latestId!))!;
      const { _id, _creationTime, metadata, ...copy } = old;
      const id = await ctx.db.insert("certificates", {
        ...copy,
        version: expired.nextVersion,
        state: "validating",
        membershipId: owner.membershipId,
        membershipVersion: 1,
      });
      await ctx.db.patch("certificateHeads", expired._id, {
        latestId: id,
        nextVersion: expired.nextVersion + 1,
      });
      return { id, metadata: { ...metadata!, notAfter: Date.now() + 365 * 86400_000 } };
    });
    await f.t.mutation(internal.certificates.finish, uploaded);
    const resume = (await scheduledResume(f))!;
    expect(resume).not.toBeNull();
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    const token = await claimAt(f, stream.operationId!);
    expect((await f.t.mutation(internal.certificateUse.authorize, token!))?._id).toBe(uploaded.id);
  });

  it("troca de papel e saída de quem iniciou não param as consultas seguintes", async () => {
    for (const change of ["viewer", "removed"] as const) {
      vi.unstubAllEnvs();
      stub(development);
      const f = await siteFixture();
      const { owner, streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await f.t.run(async (ctx) => {
        const membership = (await ctx.db.get("memberships", owner.membershipId))!;
        await ctx.db.patch("memberships", membership._id, {
          ...(change === "viewer"
            ? { role: "viewer" as const }
            : {
                state: "removed" as const,
                companyAccessEpoch: (membership.companyAccessEpoch ?? 0) + 1,
              }),
          version: membership.version + 1,
        });
      });
      const token = await claimAt(f, next);
      expect(token, change).not.toBeNull();
      expect(await f.t.mutation(internal.certificateUse.authorize, token!)).not.toBeNull();
      // The documents of that query are processed under the same release.
      expect(await f.t.mutation(internal.operations.beginEffect, token!)).toBe(true);
      await respond(
        f,
        token!,
        distributionXml({
          environment: "1",
          envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }],
        }),
      );
      const [envelope] = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
      expect(envelope?.operationId, change).toBeDefined();
      const child = await opOf(f, envelope!.operationId!);
      expect(
        await f.t.mutation(internal.operations.claim, {
          operationId: child._id,
          generation: child.generation,
        }),
      ).not.toBeNull();
      expect(await attentionEvents(f)).toHaveLength(0);
    }
  });

  it("a liberação continua cortando: retirar e liberar de novo não ressuscita a consulta", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    await f.setRelease(false);
    await f.setRelease(true);
    expect(await claimAt(f, next)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "ACCESS_REVOKED",
    });
  });

  /**
   * #425: the runbook's general cut by variable. A query whose turn comes during the cut stops in
   * attention with a webhook and a Freecorps alert; putting the variables back, or lifting the
   * general stop, resumes nothing; a person's "Retomar captura" goes on from the checkpoint.
   */
  describe("corte geral por variável e religar (#425)", () => {
    const halt = (f: Fixture, kind: "halt" | "resume") =>
      f.t.mutation(internal.captureRelease.setHalt, {
        kind,
        operator: "ana-freecorps",
        reason: "Parada sintética de todas as empresas",
        runId: "425",
        runAttempt: 1,
      });
    /**
     * The capture as the console reads it (`captures.get`), by a person of the organization: a
     * new owner by default, since the clock of these tests outlives a session.
     */
    const consoleView = async (f: Fixture, who?: Awaited<ReturnType<typeof person>>) =>
      (await (who ?? (await person(f.t, f.scope.organizationId, "owner"))).query(api.captures.get, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
      }))!;
    const home = (who: Awaited<ReturnType<typeof person>>, organizationId: Id<"organizations">) =>
      who.query(api.consoleHome.summary, {
        organizationId,
        monthStart: Date.now() - 86_400_000,
        asOf: Date.now(),
        contextKey: "601",
      });
    const alertsOf = (f: Fixture) =>
      f.t.run(async (ctx) =>
        (await ctx.db.query("captureAlerts").collect()).map((a) => [a.kind, a.code]),
      );
    const cuts = [
      { cut: ["FNFE_CAPTURE_TRANSPORT"], code: "FISCAL_TRANSPORT_DISABLED", claimed: true },
      { cut: ["FNFE_CAPTURE_FISCAL"], code: "ACCESS_REVOKED", claimed: false },
      {
        cut: ["FNFE_CAPTURE_FISCAL", "FNFE_CAPTURE_TRANSPORT"],
        code: "ACCESS_REVOKED",
        claimed: false,
      },
    ];
    it.each(cuts)("sem $cut: atenção $code, um webhook, e religar não retoma", async (c) => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      const checkpoint = (await streamOf(f, streamId)).checkpoint;
      for (const name of c.cut) vi.stubEnv(name, undefined);
      // The query's turn comes during the cut.
      const token = await claimAt(f, next);
      expect(token !== null).toBe(c.claimed);
      if (token) expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: c.code,
        uncertain: false,
      });
      const stopped = await streamOf(f, streamId);
      expect(stopped).toMatchObject({ state: "attention", code: c.code, checkpoint });
      expect(await attentionEvents(f)).toHaveLength(1);
      expect(await alertsOf(f)).toEqual([["attention", c.code]]);
      // Variables back, and even the general stop's resume: nothing comes back by itself.
      stub(site);
      await halt(f, "halt");
      await halt(f, "resume");
      vi.setSystemTime(Date.now() + 25 * 3_600_000);
      expect(await scheduledResume(f)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: c.code,
        version: stopped.version,
        operationId: next,
      });
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: c.code });
      // The console tells the cut apart (#601): the same code, marked by the server.
      const operator = await person(f.t, f.scope.organizationId, "operator", {
        companyId: f.scope.companyId,
      });
      expect(await consoleView(f, operator)).toMatchObject({ code: c.code, freecorpsCut: true });
      // "Retomar captura" in the console, by anyone who operates the company (a session of now):
      // the next query asks from the same checkpoint.
      const resumed = await operator.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: stopped.version,
      });
      expect(resumed).toMatchObject({ state: "active" });
      expect(await consoleView(f, operator)).toMatchObject({ freecorpsCut: false });
      const stream = await streamOf(f, streamId);
      expect(JSON.parse((await opOf(f, stream.operationId!)).request)).toMatchObject({
        previousOperationId: next,
      });
      const resumedToken = await claimAt(f, stream.operationId!);
      expect(await f.t.mutation(internal.captureProcessing.prepare, resumedToken!)).toMatchObject({
        nsu: checkpoint,
        mode: "distNSU",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    });

    it("captura ativada por chave sem FNFE_CAPTURE_FISCAL: também ACCESS_REVOKED", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const next = await cycle(f, stream.id, stream.operationId);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      expect(await claimAt(f, next)).toBeNull();
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
      // Back on: the console says it was the cut (#601), the REST connection stays as it was.
      stub(site);
      expect(await consoleView(f)).toMatchObject({
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      const connection = await rest(f, f.secret, "GET");
      expect(connection.status).toBe(200);
      const data = connection.body.data as Record<string, unknown>;
      expect(data).toMatchObject({ id: stream.id, state: "attention", code: "ACCESS_REVOKED" });
      expect(data).not.toHaveProperty("freecorpsCut");
    });

    /**
     * #601: the console says the Freecorps cut only once the capture is on again, only for the
     * attention the cut caused, and only to the organization of the company.
     */
    it("o console diz que foi o corte só com as duas variáveis de volta", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      expect(await claimAt(f, next)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      // Only the fiscal switch back: a resume would stop again, so the code keeps its words.
      vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
      expect(await consoleView(f)).toMatchObject({ freecorpsCut: false });
      stub(site);
      expect(await consoleView(f)).toMatchObject({ freecorpsCut: true });
      // The Início says it too, for this organization only.
      expect(
        (
          await home(await person(f.t, f.scope.organizationId, "owner"), f.scope.organizationId)
        ).pending.filter((item) => item.kind === "capture-attention"),
      ).toEqual([
        expect.objectContaining({
          companyId: f.scope.companyId,
          code: "ACCESS_REVOKED",
          freecorpsCut: true,
        }),
      ]);
      // Another organization reads neither the capture nor the mark.
      vi.unstubAllEnvs();
      stub(development);
      const other = await f.t.mutation(internal.testing.operationProof.prepare, {
        keyHash: await hashApiKey(`fnfe_${"d".repeat(43)}`),
        suffix: crypto.randomUUID(),
      });
      vi.unstubAllEnvs();
      stub(site);
      // Its own released company stopped with the same code, by a real revocation: no mark.
      const otherStream = await f.t.run(async (ctx) => {
        await ctx.db.patch("companies", other.companyId, {
          kind: "declared",
          cnpj: "11222333000181",
        });
        await ctx.db.insert("captureReleases", {
          organizationId: other.organizationId,
          companyId: other.companyId,
          released: true,
          blocked: false,
          minIntervalHours: 1,
          releasedBefore: true,
          actor: "member:synthetic",
          reason: "Liberação sintética",
          version: 1,
          updatedAt: Date.now(),
          eventId: await ctx.db.insert("captureReleaseEvents", {
            organizationId: other.organizationId,
            companyId: other.companyId,
            released: true,
            blocked: false,
            minIntervalHours: 1,
            version: 1,
            kind: "console_release",
            terms: CAPTURE_TERMS_VERSION,
            revokedKeys: 0,
            reason: "Liberação sintética",
            buildSha: null,
            deployment: "",
            createdAt: Date.now(),
          }),
        });
        return await ctx.db.insert("captureStreams", {
          organizationId: other.organizationId,
          projectId: other.projectId,
          companyId: other.companyId,
          environment: "production",
          identity: "11222333000181",
          service: "nfe-distribution",
          state: "attention",
          version: 2,
          checkpoint: "000000000000000",
          mode: "distNSU",
          nextAllowedAt: Date.now(),
          code: "ACCESS_REVOKED",
          received: 0,
          createdAt: Date.now(),
        });
      });
      const stranger = await person(f.t, other.organizationId, "owner");
      await expect(consoleView(f, stranger)).rejects.toThrow();
      const strangerPending = (await home(stranger, other.organizationId)).pending.filter(
        (item) => item.kind === "capture-attention",
      );
      expect(strangerPending).toEqual([
        expect.objectContaining({
          companyId: other.companyId,
          recordId: otherStream,
          code: "ACCESS_REVOKED",
        }),
      ]);
      expect(strangerPending[0]).not.toHaveProperty("freecorpsCut");
      // And the first organization still reads its own mark, not the other's attention.
      expect(
        (
          await home(await person(f.t, f.scope.organizationId, "owner"), f.scope.organizationId)
        ).pending.filter((item) => item.kind === "capture-attention"),
      ).toEqual([expect.objectContaining({ companyId: f.scope.companyId, freecorpsCut: true })]);
    });

    /**
     * The worker refuses the transport in an action and `failed` writes the attention in another
     * transaction: the mark comes from the worker's reading, even when the variables are back by
     * the time `failed` runs (#601).
     */
    it("o corte lido pelo worker fica marcado mesmo com as variáveis regravadas antes de failed", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      const real = siteCapture.siteCaptureProfile;
      // The cut happens after `prepare`, right when the worker reads the switches, and the
      // operator writes them again before the worker's next step reaches the database.
      const profile = vi.spyOn(siteCapture, "siteCaptureProfile").mockImplementationOnce(() => {
        vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
        queueMicrotask(() => stub(site));
        return real();
      });
      try {
        const result = await f.t.action(internal.captureWorker.execute, {
          ...token,
          request: "{}",
        });
        expect(result).toMatchObject({ code: "FISCAL_TRANSPORT_DISABLED" });
      } finally {
        profile.mockRestore();
      }
      expect(process.env.FNFE_CAPTURE_TRANSPORT).toBe("sefaz");
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
      expect(await consoleView(f)).toMatchObject({
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
    });

    /**
     * The vault decides `ACCESS_REVOKED` in `certificateUse.authorizeTransport` and
     * `refusedBeforeSend` writes the attention in another transaction: the mark comes from the
     * vault's reading, even when the variables are back by the time the pause is written (#601).
     */
    it("o corte lido pelo cofre fica marcado mesmo com as variáveis regravadas antes da pausa", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      // The cut happens after the worker chose the transport, right before the vault reads the
      // release; the operator writes the variables again as soon as the vault has decided.
      const real = certificateRuntime.transportWithCertificate;
      const transport = vi
        .spyOn(certificateRuntime, "transportWithCertificate")
        .mockImplementationOnce((ctx, claim, target) => {
          vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
          return real(ctx, claim, target);
        });
      const audit = certificateAccess.certificateAudit;
      const decided = vi
        .spyOn(certificateAccess, "certificateAudit")
        .mockImplementation(async (...args) => {
          await audit(...args);
          if (args[3] === "denied") stub(site);
        });
      try {
        const result = await f.t.action(internal.captureWorker.execute, {
          ...token,
          request: "{}",
        });
        expect(result).toMatchObject({ kind: "definitive", code: "ACCESS_REVOKED" });
        expect(decided).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          SITE_CAPTURE_ACTION,
          "denied",
          expect.anything(),
          stream.operationId,
        );
      } finally {
        transport.mockRestore();
        decided.mockRestore();
      }
      expect(process.env.FNFE_CAPTURE_FISCAL).toBe(site.FNFE_CAPTURE_FISCAL);
      expect(await opOf(f, stream.operationId)).toMatchObject({
        state: "paused",
        code: "ACCESS_REVOKED",
        uncertain: false,
      });
      expect(await streamOf(f, stream.id)).toMatchObject({
        state: "attention",
        code: "ACCESS_REVOKED",
        freecorpsCut: true,
      });
      expect(await consoleView(f)).toMatchObject({ code: "ACCESS_REVOKED", freecorpsCut: true });
    });

    it("failed só grava a marca do corte para os códigos do corte", async () => {
      const f = await siteFixture();
      const stream = await f.command("production", "activate");
      const token = await f.claim(stream.operationId);
      await f.t.mutation(internal.captureProcessing.failed, {
        ...token,
        code: "BATCH_UNAVAILABLE",
        cut: true,
      });
      const stopped = await streamOf(f, stream.id);
      expect(stopped).toMatchObject({ state: "attention", code: "BATCH_UNAVAILABLE" });
      expect(stopped.freecorpsCut).toBeUndefined();
    });

    it("revogação real com as variáveis presentes: ACCESS_REVOKED sem a marca do corte", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      let next = await cycle(f, streamId, operationId);
      // First the cut, resumed by a person: the mark goes with that attention.
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        code: "FISCAL_TRANSPORT_DISABLED",
        freecorpsCut: true,
      });
      stub(site);
      const operator = await person(f.t, f.scope.organizationId, "operator", {
        companyId: f.scope.companyId,
      });
      await operator.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: (await streamOf(f, streamId)).version,
      });
      next = await cycle(f, streamId, (await streamOf(f, streamId)).operationId!);
      // Then a real loss of access, with both variables present: withdrawn and released again.
      await f.setRelease(false);
      await f.setRelease(true);
      expect(await claimAt(f, next)).toBeNull();
      const revoked = await streamOf(f, streamId);
      expect(revoked).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
      expect(revoked.freecorpsCut).toBeUndefined();
      expect(await consoleView(f)).toMatchObject({
        code: "ACCESS_REVOKED",
        freecorpsCut: false,
      });
    });

    it("uma consulta que não chegou à vez durante o corte segue sozinha", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      const due = (await opOf(f, next)).nextAttemptAt;
      expect(due).toBeGreaterThan(Date.now());
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
      stub(site);
      const token = await claimAt(f, next);
      expect(token).not.toBeNull();
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
      expect(await attentionEvents(f)).toHaveLength(0);
    });

    it("consulta já enviada: sem transporte ela termina; sem FNFE_CAPTURE_FISCAL fica incerta em atenção", async () => {
      for (const name of ["FNFE_CAPTURE_TRANSPORT", "FNFE_CAPTURE_FISCAL"] as const) {
        vi.unstubAllEnvs();
        stub(development);
        const f = await siteFixture();
        const { streamId, operationId } = await consoleStart(f);
        const next = await cycle(f, streamId, operationId);
        // The request left (`beginEffect`); the variable goes before the answer is recorded.
        const token = await f.claim(next);
        expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
        vi.stubEnv(name, undefined);
        if (name === "FNFE_CAPTURE_TRANSPORT") {
          await respond(f, token, distributionXml({ status: "137", environment: "1" }));
          expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
          expect(await opOf(f, next)).toMatchObject({ state: "succeeded" });
          expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
          expect(await attentionEvents(f)).toHaveLength(0);
          continue;
        }
        const rawId = await f.t.run((ctx) => ctx.storage.store(new Blob(["<retDistDFeInt/>"])));
        expect(
          await f.t.mutation(internal.captureProcessing.raw, {
            ...token,
            rawId,
            rawHash: "0".repeat(64),
            nsu: nsu(0),
            mode: "distNSU",
          }),
        ).toBeNull();
        await f.t.mutation(internal.operations.recordOutcome, {
          ...token,
          outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
        });
        expect(await opOf(f, next)).toMatchObject({
          state: "paused",
          code: "ACCESS_REVOKED",
          uncertain: true,
        });
        expect(await streamOf(f, streamId)).toMatchObject({
          state: "attention",
          code: "ACCESS_REVOKED",
        });
        expect(await attentionEvents(f)).toHaveLength(1);
      }
    });

    it("apagar a variável por cima da parada geral põe em atenção em vez de adiar", async () => {
      const f = await siteFixture();
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await halt(f, "halt");
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "FISCAL_TRANSPORT_DISABLED",
      });
      expect(await attentionEvents(f)).toHaveLength(1);
    });
  });

  it("A1 renovado com a consulta já enviada: atenção ACCESS_REVOKED e a retomada reconcilia com o A1 novo (#425)", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    // The worker has the vault's answer and the request left (`beginEffect`, stage `calling`).
    const token = await f.claim(next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
    const renewed = await renew(f);
    expect(
      await f.t.mutation(internal.operations.recordOutcome, {
        ...token,
        outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
      }),
    ).toBe(false);
    expect(await opOf(f, next)).toMatchObject({
      state: "paused",
      code: "ACCESS_REVOKED",
      uncertain: true,
    });
    const stopped = await streamOf(f, streamId);
    expect(stopped).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
    expect(await attentionEvents(f)).toHaveLength(1);
    expect(await scheduledResume(f)).toBeNull();
    const operator = await person(f.t, f.scope.organizationId, "operator", {
      companyId: f.scope.companyId,
    });
    await operator.mutation(api.captures.control, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
      action: "resume",
      expectedVersion: stopped.version,
    });
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active", mode: "consNSU" });
    const resumed = await claimAt(f, stream.operationId!);
    expect((await f.t.mutation(internal.certificateUse.authorize, resumed!))?._id).toBe(renewed);
  });

  it("mudar o intervalo não corta a consulta agendada, não a antecipa e um maior a adia (#432)", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const answered = await streamOf(f, streamId);
    expect(answered.nextAllowedAt).toBe(answered.lastSuccessAt! + 3_600_000);
    const release = () =>
      f.t.run(
        async (ctx) =>
          (await ctx.db
            .query("captureReleases")
            .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
            .unique())!,
      );
    const pinned = (await release()).version;
    // More than a page of rows without an answer since then (#494): the end of the queue the
    // answer reached still counts.
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 24; i++)
        await ctx.db.insert("captureAudit", {
          streamId,
          organizationId: answered.organizationId,
          action: "fiscal_halt_deferred",
          actor: "system",
          checkpoint: answered.checkpoint,
          createdAt: Date.now(),
        });
    });
    const change = (minIntervalHours: number) =>
      owner.mutation(api.captureRelease.updateInterval, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        minIntervalHours,
      });
    // Longer: the stream waiting at the end of the queue waits the new interval.
    expect(await change(6)).toEqual({
      minIntervalHours: 6,
      changed: true,
      nextAllowedAt: answered.lastSuccessAt! + 6 * 3_600_000,
    });
    expect((await streamOf(f, streamId)).nextAllowedAt).toBe(
      answered.lastSuccessAt! + 6 * 3_600_000,
    );
    // Shorter: nothing comes earlier than it was going to.
    expect(await change(2)).toMatchObject({ changed: true, nextAllowedAt: null });
    expect((await streamOf(f, streamId)).nextAllowedAt).toBe(
      answered.lastSuccessAt! + 6 * 3_600_000,
    );
    // The release keeps the version the queued query pinned: it is not cut.
    expect((await release()).version).toBe(pinned);
    // At its old time the queued query wakes, finds the window ahead and sends nothing.
    const early = await f.claim(next);
    expect(Date.now()).toBeLessThan(answered.lastSuccessAt! + 6 * 3_600_000);
    expect(await f.t.mutation(internal.captureProcessing.prepare, early)).toMatchObject({
      waitUntil: answered.lastSuccessAt! + 6 * 3_600_000,
    });
    expect((await streamOf(f, streamId)).lastAttemptAt).toBe(answered.lastAttemptAt);
  });

  it("quem iniciou perde o papel antes da primeira consulta: atenção com um único webhook", async () => {
    const f = await siteFixture();
    const { owner, streamId, operationId } = await consoleStart(f);
    expect(await attentionEvents(f)).toHaveLength(0);
    await f.t.run(async (ctx) => {
      const membership = (await ctx.db.get("memberships", owner.membershipId))!;
      await ctx.db.patch("memberships", membership._id, {
        role: "viewer",
        version: membership.version + 1,
      });
    });
    const before = await opOf(f, operationId);
    expect(await claimAt(f, operationId)).toBeNull();
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "attention", code: "ACCESS_REVOKED" });
    const events = await attentionEvents(f);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.body)).toMatchObject({
      environment: "production",
      resource: { type: "connection", id: streamId, version: stream.version },
    });
    // A late dispatch or watchdog of the paused attempt adds nothing.
    await f.t.mutation(internal.operations.claim, { operationId, generation: before.generation });
    await f.t.mutation(internal.operations.recoverOne, { operationId });
    expect(await attentionEvents(f)).toHaveLength(1);
    expect((await streamOf(f, streamId)).version).toBe(stream.version);
  });

  it("captura iniciada por chave continua com a chave, e revogar a chave corta", async () => {
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const next = await cycle(f, stream.id, stream.operationId);
    expect(await opOf(f, next)).toMatchObject({ sourceKeyId: f.scope.keyId });
    expect((await opOf(f, next)).sourceCaptureReleaseId).toBeUndefined();
    const after = await cycle(f, stream.id, next);
    expect(await opOf(f, after)).toMatchObject({ sourceKeyId: f.scope.keyId });
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
    expect(await claimAt(f, after)).toBeNull();
    expect(await opOf(f, after)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    expect(await streamOf(f, stream.id)).toMatchObject({
      state: "attention",
      code: "ACCESS_REVOKED",
    });
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  it("operação de pessoa fora do projeto do console mantém a pessoa como origem", async () => {
    // `operations.reserve` never records this today; the rule stays the same as in
    // `executionAllowed`, so such a continuation is not switched to a source it would refuse.
    const f = await siteFixture();
    const stream = await f.command("production", "activate");
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await f.t.run(async (ctx) => {
      const membership = (await ctx.db.get("memberships", owner.membershipId))!;
      await ctx.db.patch("operations", stream.operationId, {
        sourceKeyId: undefined,
        sourceMembershipId: membership._id,
        sourceAccessVersion: `manager:${membership.version}`,
      });
    });
    const next = await cycle(f, stream.id, stream.operationId);
    const child = await opOf(f, next);
    expect(child).toMatchObject({ sourceMembershipId: owner.membershipId });
    expect(child.sourceCaptureReleaseId).toBeUndefined();
    expect(await claimAt(f, next)).not.toBeNull();
  });

  const plan = (
    f: Fixture,
    captures: number,
    expectedVersion: number,
    endsAt: number | null = Date.UTC(2027, 11, 31),
  ) =>
    f.t.mutation(internal.usage.assignPlan, {
      organizationId: f.scope.organizationId,
      name: "Plano sintético",
      startsAt: Date.UTC(2026, 0, 1),
      endsAt,
      limits: { imports: null, bytes: 1e12, captures, registry: null, deliveries: null },
      concurrency: 2,
      actor: "test",
      reason: "cota sintética",
      expectedVersion,
    });
  /** A quota of one capture, spent by the first query: the second pauses in attention. */
  async function exhausted(endsAt?: number | null) {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    await plan(f, 1, 1, endsAt);
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "QUOTA_EXCEEDED",
    });
    expect(await attentionEvents(f)).toHaveLength(1);
    return { f, streamId, paused: next };
  }

  it("cota esgotada: atenção com webhook; no período seguinte a captura volta sozinha", async () => {
    const { f, streamId, paused } = await exhausted();
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBe(Date.UTC(2026, 10, 1));
    // Early, nothing changes.
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    expect(await streamOf(f, streamId)).toMatchObject({ state: "attention" });
    vi.setSystemTime(resume.at);
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(paused);
    const token = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    // The same check run again resumes nothing more.
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    expect((await streamOf(f, streamId)).operationId).toBe(stream.operationId);
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  // #429: a plan without an end (the permanent free tier) keeps the monthly quota: a capture
  // paused by it resumes in the next period, with that month's units only. The many-month term
  // is proved in platform.usage.test.ts.
  it("plano sem vencimento: cota esgotada retoma no mês seguinte, sem acumular cota", async () => {
    const { f, streamId, paused } = await exhausted(null);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBe(Date.UTC(2026, 10, 1));
    vi.setSystemTime(resume.at);
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(paused);
    // November's single unit is spent; the next query pauses again instead of using a unit left
    // over from October, and waits for December.
    const next = await cycle(f, streamId, stream.operationId!);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
    expect(await streamOf(f, streamId)).toMatchObject({
      state: "attention",
      code: "QUOTA_EXCEEDED",
    });
    const pending = await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (r) => r.name.includes("resumeEligible") && r.state.kind === "pending",
      ),
    );
    expect(pending.map((r) => r.scheduledTime)).toContain(Date.UTC(2026, 11, 1));
  });

  // #429: the same plan limit is counted in each environment's own balance.
  it("cota esgotada no sandbox não pausa a captura em produção", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    await plan(f, 2, 1);
    for (const key of ["sandbox-query-1", "sandbox-query-2"])
      await f.t.run((ctx) => recordUsage(ctx, f.scope.organizationId, "sandbox", "captures", key));
    await expect(
      f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures")),
    ).rejects.toThrow("QUOTA_EXCEEDED");
    // The first cycle spends production's first unit; the second query still has its own.
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
    expect(await streamOf(f, streamId)).toMatchObject({ state: "active" });
    // Each environment's balance is the sum of its lanes (#559).
    const totals = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
    const committed = (environment: string) =>
      totals
        .filter((row) => row.metric === "captures" && row.environment === environment)
        .reduce((sum, row) => sum + row.committed, 0);
    expect({ sandbox: committed("sandbox"), production: committed("production") }).toEqual({
      sandbox: 2,
      production: 2,
    });
  });

  it("cota esgotada em produção não bloqueia o sandbox", async () => {
    const { f } = await exhausted();
    await expect(
      f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "production", "captures")),
    ).rejects.toThrow("QUOTA_EXCEEDED");
    // Throws QUOTA_EXCEEDED if the sandbox shared production's balance.
    await f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures"));
  });

  it("cota restabelecida por novo plano: a captura volta sem esperar o período", async () => {
    const { f, streamId } = await exhausted();
    await plan(f, 10, 2);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBeLessThanOrEqual(Date.now());
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    const token = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
  });

  // ADR 0010, decisions 10 and 11: the free tier caps Production by 100 new notes a month, one per
  // company and access key, instead of its 100 capture queries, which stay the sandbox's quota.
  describe("cota de notas do Gratuito", () => {
    /** A site fixture under the free tier's catalog limits, with `notes` already counted. */
    async function freeTier(notes: number, now = Date.UTC(2026, 9, 23, 12)) {
      vi.setSystemTime(now);
      const f = await siteFixture({ plan: false });
      await capturePlan(f.t, f.scope.organizationId, PLATFORM_PLANS.free.limits);
      await f.t.run(async (ctx) => {
        for (let i = 0; i < notes; i++)
          await recordUsage(
            ctx,
            f.scope.organizationId,
            "production",
            "documents",
            `earlier:${i}`,
            1,
            true,
          );
      });
      return f;
    }
    /** New notes of the month in Production, as Uso e limites shows them. */
    async function notes(f: Fixture) {
      const owner = await person(f.t, f.scope.organizationId, "owner");
      const view = await owner.query(api.usage.overview, {
        organizationId: f.scope.organizationId,
        period: usagePeriod(Date.now()),
        contextKey: "test",
      });
      const row = view.environments.production.find((r) => r.metric === "documents")!;
      return row.committed + row.reserved;
    }
    /** What the capture panel and the Início say of the production stream. */
    async function shown(f: Fixture) {
      const owner = await person(f.t, f.scope.organizationId, "owner");
      const stream = (await owner.query(api.captures.get, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
      }))!;
      const item = (
        await owner.query(api.consoleHome.summary, {
          organizationId: f.scope.organizationId,
          monthStart: Date.now() - 86_400_000,
          asOf: Date.now(),
          contextKey: "notes",
        })
      ).pending.find((entry) => entry.kind === "capture-attention");
      return { stream, item };
    }
    /** Every `documents.capture` the checkpoint created, run by the worker. */
    async function processReceived(f: Fixture) {
      for (const envelope of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())) {
        const op = await opOf(f, envelope.operationId!);
        vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
        await f.t.action(internal.operationWorker.run, {
          operationId: op._id,
          generation: op.generation,
        });
        expect(await opOf(f, op._id)).toMatchObject({ state: "succeeded" });
      }
    }

    it("com 99 notas a consulta sai; com 100 a seguinte pausa e volta no mês seguinte", async () => {
      const f = await freeTier(99);
      // The queries themselves no longer count against the free tier in Production.
      await f.t.run(async (ctx) => {
        for (let i = 0; i < 100; i++)
          await recordUsage(ctx, f.scope.organizationId, "production", "captures", `q:${i}`);
      });
      const { streamId, operationId } = await consoleStart(f);
      const next = await cycle(f, streamId, operationId);
      await f.t.run((ctx) =>
        recordUsage(ctx, f.scope.organizationId, "production", "documents", "earlier:99", 1, true),
      );
      const token = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "QUOTA_EXCEEDED",
      });
      // The panel and the Início name the notes limit.
      const paused = await shown(f);
      expect(paused.stream).toMatchObject({ countsNotes: true, notesQuota: true });
      expect(paused.item).toMatchObject({ code: "QUOTA_EXCEEDED", notesQuota: true });
      // The sandbox stays outside the notes: its own 100 queries still admit.
      await f.t.run((ctx) => requireQuota(ctx, f.scope.organizationId, "sandbox", "captures"));
      const resume = (await scheduledResume(f))!;
      expect(resume.at).toBe(Date.UTC(2026, 10, 1));
      vi.setSystemTime(resume.at);
      await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
      const stream = await streamOf(f, streamId);
      expect(stream).toMatchObject({ state: "active" });
      const again = await claimAt(f, stream.operationId!);
      expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).not.toBeNull();
    });

    it("parada por outra cota no Gratuito, a captura não diz que foi a de notas", async () => {
      const f = await freeTier(10);
      // The month's bytes leave less than the 18 MiB a query reserves.
      await f.t.run((ctx) =>
        recordUsage(
          ctx,
          f.scope.organizationId,
          "production",
          "bytes",
          "earlier:bytes",
          PLATFORM_PLANS.free.limits.bytes - 1,
          true,
        ),
      );
      const { streamId, operationId } = await consoleStart(f);
      const token = await claimAt(f, operationId);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({ code: "QUOTA_EXCEEDED" });
      const { stream, item } = await shown(f);
      expect(stream.countsNotes).toBe(true);
      expect(stream.notesQuota).toBeUndefined();
      expect(item).toMatchObject({ code: "QUOTA_EXCEEDED", countsNotes: true });
      expect(item?.notesQuota).toBeUndefined();
    });

    it("pausada pelas notas no fim de outubro, continua marcada em novembro até retomar", async () => {
      const f = await freeTier(100, Date.UTC(2026, 9, 31, 22));
      const { streamId, operationId } = await consoleStart(f);
      const token = await claimAt(f, operationId);
      expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "attention",
        code: "QUOTA_EXCEEDED",
      });
      expect((await shown(f)).stream).toMatchObject({ notesQuota: true });
      // November has no notes yet, but the pause was October's: no resume ran, so it still says why.
      vi.setSystemTime(Date.UTC(2026, 10, 1, 1));
      expect(await streamOf(f, streamId)).toMatchObject({ state: "attention" });
      expect((await shown(f)).stream).toMatchObject({ countsNotes: true, notesQuota: true });
    });

    it("a consulta admitida com 99 notas entra inteira; resumo, XML e evento da mesma chave contam uma", async () => {
      const f = await freeTier(99);
      const { streamId, operationId } = await consoleStart(f);
      const token = await f.claim(operationId);
      await respond(
        f,
        token,
        distributionXml({
          environment: "1",
          envelopes: [
            { nsu: 1, xml: corpus("summary-authorized") },
            { nsu: 2, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
            { nsu: 3, xml: corpus("event-110111"), schema: "procEventoNFe_v1.00.xsd" },
            // Another access key: a second new note of the same answer.
            { nsu: 4, xml: corpus("invoice-alphanumeric"), schema: "procNFe_v4.00.xsd" },
          ],
        }),
      );
      expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
      await processReceived(f);
      const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
      expect(docs).toHaveLength(2);
      expect(await notes(f)).toBe(101);
      // The completion of each processing delivered again (the workpool's callback is at least
      // once) publishes nothing new and counts no note. Reprocessing a captured document is an
      // import purpose, which the site never serves in Production (`environmentServed`).
      for (const envelope of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
        await f.t.mutation(internal.importProcessing.published, {
          operationId: envelope.operationId!,
        });
      expect(await notes(f)).toBe(101);
      const owner = await person(f.t, f.scope.organizationId, "owner");
      await expect(
        owner.mutation(api.documents.reprocess, {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          environment: "production",
          documentId: docs[0]!._id,
          key: "reprocess-captured",
        }),
      ).rejects.toThrow("NOT_FOUND");
      expect(await notes(f)).toBe(101);
      // Still active: the console knows the plan counts notes, but nothing stopped on them yet.
      const active = (await shown(f)).stream;
      expect(active.countsNotes).toBe(true);
      expect(active.notesQuota).toBeUndefined();
      const next = (await streamOf(f, streamId)).operationId!;
      const again = await claimAt(f, next);
      expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).toBeNull();
      expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "QUOTA_EXCEEDED" });
      expect((await shown(f)).stream).toMatchObject({ countsNotes: true, notesQuota: true });
    });
  });

  // #429: production capture requires the organization's plan with finite quotas, the free tier
  // included; the sandbox keeps metering without one.
  const written = (f: Fixture) =>
    f.t.run(async (ctx) => ({
      streams: (await ctx.db.query("captureStreams").collect()).length,
      operations: (await ctx.db.query("operations").collect()).length,
      usage: (await ctx.db.query("usageEvents").collect()).length,
    }));
  it("sem plano, Produção recusa ativar no console e pela API sem gravar nada; o sandbox segue", async () => {
    const f = await siteFixture({ plan: false });
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
    // The sandbox, without a plan, is admitted and metered as before.
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { environment: "sandbox" }));
    const sandbox = await f.command("sandbox", "activate");
    expect(
      await f.t.mutation(internal.captureProcessing.prepare, await f.claim(sandbox.operationId)),
    ).not.toBeNull();
    expect(await opOf(f, sandbox.operationId)).toMatchObject({
      environment: "sandbox",
      state: "running",
    });
    const metered = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(metered.map((e) => [e.environment, e.metric])).toEqual(
      expect.arrayContaining([["sandbox", "captures"]]),
    );
    expect(publicError(new ConvexError({ code: "PLAN_REQUIRED" }))).toMatchObject({
      status: 403,
      error: { code: "SCOPE_DENIED", message: expect.stringContaining("exige um plano") },
    });
  });

  it.each([
    ["consultas", { captures: null }],
    ["bytes", { bytes: null }],
  ] as const)("plano sem cota finita de %s não admite a captura em Produção", async (_, limits) => {
    const f = await siteFixture({ plan: false });
    await capturePlan(f.t, f.scope.organizationId, limits);
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
  });

  it("plano vencido recusa com PLAN_INACTIVE; o plano vigente admite a consulta", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture({ plan: false });
    await f.t.mutation(internal.usage.assignPlan, {
      organizationId: f.scope.organizationId,
      name: "Piloto encerrado",
      startsAt: Date.UTC(2026, 0, 1),
      endsAt: Date.UTC(2026, 5, 1),
      limits: { imports: null, bytes: 1e12, captures: 10, registry: null, deliveries: null },
      concurrency: 2,
      actor: "test",
      reason: "piloto sintético",
      expectedVersion: 0,
    });
    await expect(consoleStart(f)).rejects.toThrow("PLAN_INACTIVE");
    expect(await written(f)).toEqual({ streams: 0, operations: 0, usage: 0 });
    await capturePlan(f.t, f.scope.organizationId, {}, 1);
    const { operationId } = await consoleStart(f);
    const token = await claimAt(f, operationId);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).not.toBeNull();
  });

  it("o plano de outra organização não admite a captura desta", async () => {
    const f = await siteFixture({ plan: false });
    vi.unstubAllEnvs();
    stub(development);
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "b")}`),
      suffix: crypto.randomUUID(),
    });
    vi.unstubAllEnvs();
    stub(site);
    expect(other.organizationId).not.toBe(f.scope.organizationId);
    await capturePlan(f.t, other.organizationId);
    await expect(consoleStart(f)).rejects.toThrow("PLAN_REQUIRED");
    await expect(f.command("production", "activate")).rejects.toThrow("PLAN_REQUIRED");
  });

  it("plano trocado por um sem cotas pausa a consulta seguinte; só um novo plano a retoma", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    await capturePlan(f.t, f.scope.organizationId, { captures: null }, 1);
    const token = await claimAt(f, next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token!)).toBeNull();
    expect(await opOf(f, next)).toMatchObject({ state: "paused", code: "PLAN_REQUIRED" });
    const paused = await streamOf(f, streamId);
    expect(paused).toMatchObject({ state: "attention", code: "PLAN_REQUIRED" });
    expect(await attentionEvents(f)).toHaveLength(1);
    // Neither time nor a person brings it back while the plan has no quota.
    expect(await scheduledResume(f)).toBeNull();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await expect(
      owner.mutation(api.captures.control, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        action: "resume",
        expectedVersion: paused.version,
      }),
    ).rejects.toThrow("PLAN_REQUIRED");
    await capturePlan(f.t, f.scope.organizationId, {}, 2);
    const resume = (await scheduledResume(f))!;
    expect(resume.at).toBeLessThanOrEqual(Date.now());
    await f.t.mutation(internal.captureProcessing.resumeEligible, resume.args);
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active" });
    expect(stream.operationId).not.toBe(next);
    const again = await claimAt(f, stream.operationId!);
    expect(await f.t.mutation(internal.captureProcessing.prepare, again!)).not.toBeNull();
    expect(await attentionEvents(f)).toHaveLength(1);
  });

  it("consulta incerta já admitida reconcilia mesmo com o plano sem cotas, sem nova cobrança", async () => {
    const f = await siteFixture();
    const { streamId, operationId } = await consoleStart(f);
    const next = await cycle(f, streamId, operationId);
    const token = await f.claim(next);
    expect(await f.t.mutation(internal.captureProcessing.prepare, token)).not.toBeNull();
    await renew(f);
    await f.t.mutation(internal.operations.recordOutcome, {
      ...token,
      outcome: { kind: "uncertain", code: "CAPTURE_CHANGED" },
    });
    expect(await opOf(f, next)).toMatchObject({ state: "paused", uncertain: true });
    const charged = (await opOf(f, next)).usageCaptureKey;
    expect(charged).toBeDefined();
    await capturePlan(f.t, f.scope.organizationId, { captures: null, bytes: null }, 1);
    const events = async () =>
      (await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).filter(
        (e) => e.metric === "captures",
      ).length;
    const before = await events();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    await owner.mutation(api.captures.control, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
      action: "resume",
      expectedVersion: (await streamOf(f, streamId)).version,
    });
    const stream = await streamOf(f, streamId);
    expect(stream).toMatchObject({ state: "active", mode: "consNSU" });
    // At the source window, so `prepare` reaches the usage check.
    vi.setSystemTime(Math.max(Date.now(), stream.nextAllowedAt));
    const resumed = (await claimAt(f, stream.operationId!))!;
    expect(await f.t.mutation(internal.captureProcessing.prepare, resumed)).toMatchObject({
      mode: "consNSU",
    });
    expect(await opOf(f, stream.operationId!)).toMatchObject({ usageCaptureKey: charged });
    expect(await f.t.mutation(internal.certificateUse.authorize, resumed)).not.toBeNull();
    expect(await events()).toBe(before);
  });
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

/**
 * #420: what the capture already received stays available. The envelopes behind the checkpoint
 * become documents in Documentos and in the export even after the release is withdrawn or the
 * deployment is cut, without querying the source or opening the vault, while closure, a company
 * that left, a revoked project or grant and a purged release still cut them.
 */
describe("documentos já recebidos depois da retirada", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  /** A summary and the full invoice of the same NF-e, as NSU 1 and 2. */
  const received = () =>
    distributionXml({
      environment: "1",
      envelopes: [
        { nsu: 1, xml: corpus("summary-authorized") },
        { nsu: 2, xml: corpus("invoice-authorized") },
      ],
    });
  /**
   * The owner starts the production capture in the console and the first query receives two
   * envelopes: the checkpoint moves past them and creates their `documents.capture`.
   */
  async function receivedByConsole() {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const view = await owner.mutation(api.captures.activate, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
    });
    return { f, owner, ...(await receive(f, view.id, view.operationId!)) };
  }
  async function receive(
    f: Fixture,
    streamId: Id<"captureStreams">,
    operationId: Id<"operations">,
  ) {
    const token = await f.claim(operationId);
    await respond(f, token, received());
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    expect((await streamOf(f, streamId)).checkpoint).toBe("000000000000002");
    const children = await f.t.run(async (ctx) =>
      (await ctx.db.query("captureEnvelopes").collect()).map((e) => e.operationId!),
    );
    expect(children).toHaveLength(2);
    return { streamId, children };
  }
  /** Runs one operation through the worker at its time. */
  async function run(f: Fixture, id: Id<"operations">) {
    const op = await opOf(f, id);
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await f.t.action(internal.operationWorker.run, { operationId: id, generation: op.generation });
    return opOf(f, id);
  }
  /** What a person sees in Documentos › Produção. */
  const listed = async (f: Fixture, owner: Awaited<ReturnType<typeof person>>) =>
    (
      await owner.query(api.documents.list, {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        environment: "production",
        cursor: null,
        limit: 10,
      })
    ).page;
  /** The organization export in Produção, finished, as text. */
  async function exported(f: Fixture, owner: Awaited<ReturnType<typeof person>>) {
    const job = await owner.mutation(api.exports.create, {
      organizationId: f.scope.organizationId,
      selection: { kind: "organization" },
      environment: "production",
      key: crypto.randomUUID(),
    });
    for (let n = 0; n < 30; n++) {
      const current = (await f.t.run((ctx) => ctx.db.get("documentExports", job.id)))!;
      if (current.state !== "running") break;
      await f.t.action(internal.exportWorker.run, {
        exportId: job.id,
        sequence: current.sequence,
      });
    }
    return f.t.run(async (ctx) => {
      const job2 = (await ctx.db.get("documentExports", job.id))!;
      expect(job2.state).toBe("succeeded");
      const texts: string[] = [];
      for (const part of await ctx.db
        .query("exportParts")
        .filter((q) => q.eq(q.field("exportId"), job.id))
        .collect()) {
        const blob = (await ctx.storage.get(part.storageId))!;
        texts.push(gunzipSync(Buffer.from(await blob.arrayBuffer())).toString());
      }
      return texts.join("\n");
    });
  }
  const certificateAudits = (f: Fixture) =>
    f.t.run(async (ctx) => (await ctx.db.query("certificateAudit").collect()).length);
  /** Every way to the source or the vault, watched while the stored documents are processed. */
  const watchVault = () => ({
    vault: vi.spyOn(certificateRuntime, "withCertificate"),
    transport: vi.spyOn(certificateRuntime, "transportWithCertificate"),
  });
  const withdraw = (f: Fixture, owner: Awaited<ReturnType<typeof person>>) =>
    owner.mutation(api.captureRelease.disable, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
    });
  /** Both documents processed, one NF-e in Documentos and in the export, nothing from the vault. */
  async function expectAvailable(
    f: Fixture,
    owner: Awaited<ReturnType<typeof person>>,
    children: Id<"operations">[],
  ) {
    const audits = await certificateAudits(f);
    const watched = watchVault();
    for (const id of children) {
      const op = await run(f, id);
      expect(op).toMatchObject({ state: "succeeded", task: { name: "documents.capture" } });
      expect(op.certificate).toBeUndefined();
    }
    expect(watched.vault).not.toHaveBeenCalled();
    expect(watched.transport).not.toHaveBeenCalled();
    expect(await certificateAudits(f)).toBe(audits);
    const page = await listed(f, owner);
    expect(page).toHaveLength(1);
    const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ environment: "production", completeness: 2 });
    expect(await exported(f, owner)).toContain(`"id":"${docs[0]!._id}"`);
  }

  it("retirar logo depois do checkpoint: as notas aparecem em Documentos e na exportação", async () => {
    const { f, owner, children } = await receivedByConsole();
    // The continuations run under the company's release, pinned by its version.
    for (const id of children) expect((await opOf(f, id)).sourceCaptureReleaseId).toBeDefined();
    await withdraw(f, owner);
    await expectAvailable(f, owner, children);
  });

  it("emergência da Freecorps: o bloqueio também mantém o que foi recebido", async () => {
    const { f, owner, children } = await receivedByConsole();
    await f.t.mutation(internal.captureRelease.set, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      kind: "emergency_withdraw",
      operator: "ana-freecorps",
      reason: "Suspensão sintética da captura",
      runId: "4242",
      runAttempt: 1,
    });
    await expectAvailable(f, owner, children);
  });

  it("corte geral: sem FNFE_CAPTURE_FISCAL nem transporte, as notas aparecem", async () => {
    const { f, owner, children } = await receivedByConsole();
    vi.stubEnv("FNFE_CAPTURE_FISCAL", undefined);
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", undefined);
    await expectAvailable(f, owner, children);
  });

  it("parada geral da Freecorps (#424): as notas aparecem, com ou sem retirada", async () => {
    for (const withdrawn of [false, true]) {
      vi.unstubAllEnvs();
      stub(development);
      const { f, owner, children } = await receivedByConsole();
      await f.t.mutation(internal.captureRelease.setHalt, {
        kind: "halt",
        operator: "ana-freecorps",
        reason: "Parada sintética de todas as empresas",
        runId: "4242",
        runAttempt: 1,
      });
      expect(
        ((await (await f.t.fetch("/health")).json()) as { captureFiscal: string }).captureFiscal,
      ).toBe("halted");
      if (withdrawn) await withdraw(f, owner);
      await expectAvailable(f, owner, children);
    }
  });

  it("captura de chave retirada: as notas aparecem pela origem da chave", async () => {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const stream = await f.command("production", "activate");
    const { children } = await receive(f, stream.id, stream.operationId);
    expect((await opOf(f, children[0]!)).sourceKeyId).toBe(f.scope.keyId);
    await withdraw(f, owner);
    await expectAvailable(f, owner, children);
  });

  it("encerramento, empresa fora, projeto ou concessão revogados e liberação expurgada continuam cortando", async () => {
    const cuts: Record<string, (f: Fixture) => Promise<void>> = {
      closure: (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.insert("organizationClosures", {
            organizationId: f.scope.organizationId,
            state: "closing",
            requestedAt: Date.now(),
            exportUntil: Date.now() + 30 * 86_400_000,
            purgeBy: Date.now() + 37 * 86_400_000,
            generation: 1,
          });
        }),
      companyLeft: (f) =>
        f.t.run(async (ctx) => {
          const other = await ctx.db.insert("organizations", {
            name: "Outra organização",
            slug: crypto.randomUUID(),
            ownerCount: 1,
            memberCount: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          await ctx.db.patch("companies", f.scope.companyId, { organizationId: other });
        }),
      projectRevoked: (f) =>
        f.t.run(async (ctx) => {
          const op = (await ctx.db.query("captureEnvelopes").first())!;
          const child = (await ctx.db.get("operations", op.operationId!))!;
          const project = (await ctx.db.get("projects", child.projectId))!;
          await ctx.db.patch("projects", project._id, { accessEpoch: project.accessEpoch + 1 });
        }),
      releasePurged: (f) =>
        f.t.run(async (ctx) => {
          const release = (await ctx.db
            .query("captureReleases")
            .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
            .unique())!;
          await ctx.db.delete("captureReleases", release._id);
        }),
    };
    for (const [name, cut] of Object.entries(cuts)) {
      vi.unstubAllEnvs();
      stub(development);
      const { f, owner, children } = await receivedByConsole();
      await withdraw(f, owner);
      await cut(f);
      for (const id of children)
        expect(await run(f, id), name).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
      // The one-time resumption leaves them paused too.
      expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {}), name).toEqual({
        resumed: 0,
        refused: 2,
        stillPaused: {},
        isDone: true,
      });
      // The read-only list names them for whoever decides.
      const listedPaused = await f.t.query(internal.captures.pausedStoredDocuments, {});
      expect(
        listedPaused.page.map((row) => row.code),
        name,
      ).toEqual(["ACCESS_REVOKED", "ACCESS_REVOKED"]);
      expect(await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect()), name).toEqual([]);
    }
    // A key capture whose grant was revoked: same cut, through the grant.
    vi.unstubAllEnvs();
    stub(development);
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const stream = await f.command("production", "activate");
    const { children } = await receive(f, stream.id, stream.operationId);
    await withdraw(f, owner);
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { accessEpoch: grant.accessEpoch + 1 });
    });
    for (const id of children)
      expect(await run(f, id)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
  });

  it("o processamento não abre o cofre: com certificado, nem a tarefa vale como leitura", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    const head = await f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!,
    );
    await f.t.run((ctx) =>
      ctx.db.patch("operations", children[0]!, {
        certificate: { id: head.activeId!, version: 1 },
      }),
    );
    expect(await run(f, children[0]!)).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
    // No caller reserves the processing of a stored document by itself.
    await expect(
      f.t.mutation(internal.operations.reserve, {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        keyHash: f.keyHash,
        key: "reserve-capture-processing",
        request: JSON.stringify({ artifactId: "x", processorVersion: "xml-import/3" }),
        task: captureProcessingTask,
      }),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it("filhas presas antes da correção voltam uma vez, sem duplicar a nota", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    // As the code before #420 left them: paused at the claim with ACCESS_REVOKED.
    await f.t.run(async (ctx) => {
      for (const id of children) {
        const op = (await ctx.db.get("operations", id))!;
        await ctx.db.patch("operations", id, {
          state: "paused",
          code: "ACCESS_REVOKED",
          generation: op.generation + 1,
          recoveryAt: undefined,
        });
      }
    });
    const result = await f.t.mutation(internal.captures.resumeStoredDocuments, {});
    expect(result).toEqual({ resumed: 2, refused: 0, stillPaused: {}, isDone: true });
    // Running it again touches nothing.
    expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {})).toEqual({
      resumed: 0,
      refused: 0,
      stillPaused: {},
      isDone: true,
    });
    // The first child is lost after staging its version: the retry reuses it.
    const first = await opOf(f, children[0]!);
    vi.setSystemTime(Math.max(Date.now(), first.nextAttemptAt));
    const claimed = (await f.t.mutation(internal.operations.claim, {
      operationId: first._id,
      generation: first.generation,
    }))!;
    const token = { operationId: first._id, generation: claimed.generation, fence: claimed.fence };
    expect(await f.t.mutation(internal.operations.beginEffect, token)).toBe(true);
    await f.t.action(internal.importWorker.execute, { ...token, request: first.request });
    vi.setSystemTime(Date.now() + 60_001);
    await f.t.mutation(internal.operations.recoverOne, { operationId: first._id });
    await expectAvailable(f, owner, children);
    const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
    expect(versions.filter((row) => row.operationId === first._id)).toHaveLength(1);
    expect(versions).toHaveLength(2);
  });

  it("filha presa sem orçamento de recuperação continua pausada e não conta como retomada", async () => {
    const { f, owner, children } = await receivedByConsole();
    await withdraw(f, owner);
    await f.t.run(async (ctx) => {
      for (const [index, id] of children.entries()) {
        const op = (await ctx.db.get("operations", id))!;
        await ctx.db.patch("operations", id, {
          state: "paused",
          code: "ACCESS_REVOKED",
          generation: op.generation + 1,
          recoveryAttempts: index === 0 ? 12 : 0,
          recoveryAt: undefined,
        });
      }
    });
    expect(await f.t.mutation(internal.captures.resumeStoredDocuments, {})).toEqual({
      resumed: 1,
      refused: 0,
      stillPaused: { RECOVERY_BUDGET_EXHAUSTED: 1 },
      isDone: true,
    });
    expect(await opOf(f, children[0]!)).toMatchObject({
      state: "paused",
      code: "RECOVERY_BUDGET_EXHAUSTED",
    });
    // The read-only list shows it, with its code and source; the resumed one is gone from it.
    expect((await f.t.query(internal.captures.pausedStoredDocuments, {})).page).toEqual([
      {
        operationId: children[0],
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        code: "RECOVERY_BUDGET_EXHAUSTED",
        source: "release",
      },
    ]);
  });
});

/**
 * #424, from end to end on the site profile: the Freecorps emergency stops a capture that is
 * running, the unblock only lifts the block, and the capture comes back only through a new
 * release and a person, from the NSU where it stopped. Repeating the stop or the unblock never
 * touches the stream, the operation or the webhooks again.
 */
describe("parada, desbloqueio e retomada pela Freecorps (#424)", () => {
  type Fixture = Awaited<ReturnType<typeof siteFixture>>;
  const run = {
    operator: "ana-freecorps",
    reason: "Ensaio sintético da emergência",
    runId: "4242",
    runAttempt: 1,
  };
  const freecorps = (f: Fixture, kind: "emergency_withdraw" | "unblock") =>
    f.t.mutation(internal.captureRelease.set, { companyId: f.scope.companyId, kind, ...run });
  const opOf = (f: Fixture, id: Id<"operations">) =>
    f.t.run(async (ctx) => (await ctx.db.get("operations", id))!);
  const releaseOf = (f: Fixture) =>
    f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("captureReleases")
          .withIndex("by_companyId", (q) => q.eq("companyId", f.scope.companyId))
          .unique())!,
    );
  /** What a stop or an unblock may touch besides the release: stream, operation and webhooks. */
  const effects = (f: Fixture, streamId: Id<"captureStreams">, operationId: Id<"operations">) =>
    f.t.run(async (ctx) => ({
      stream: await ctx.db.get("captureStreams", streamId),
      operation: await ctx.db.get("operations", operationId),
      events: (await ctx.db.query("outboxEvents").collect()).map((e) => e.type),
      audit: (await ctx.db.query("captureAudit").collect()).map((a) => a.action),
    }));
  /**
   * The owner starts the production capture in the console; the first query receives NSU 1 and
   * 2 of the 4 the source has, so the stream schedules the next query right away.
   */
  async function capturing() {
    const f = await siteFixture();
    const owner = await person(f.t, f.scope.organizationId, "owner", {
      companyId: f.scope.companyId,
    });
    const view = await owner.mutation(api.captures.activate, {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "production",
    });
    const token = await f.claim(view.operationId!);
    await respond(
      f,
      token,
      distributionXml({
        environment: "1",
        max: 4,
        envelopes: [
          { nsu: 1, xml: corpus("summary-authorized") },
          { nsu: 2, xml: corpus("invoice-authorized") },
        ],
      }),
    );
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const stream = await streamOf(f, view.id);
    expect(stream).toMatchObject({ state: "active", checkpoint: nsu(2) });
    expect(stream.operationId).not.toBe(view.operationId);
    return { f, owner, streamId: view.id, next: stream.operationId! };
  }

  it("a emergência para a captura em andamento; repetir só registra de novo", async () => {
    const { f, streamId, next } = await capturing();
    const transport = vi.spyOn(certificateRuntime, "transportWithCertificate");
    try {
      expect(await freecorps(f, "emergency_withdraw")).toMatchObject({
        released: false,
        blocked: true,
      });
      expect(await streamOf(f, streamId)).toMatchObject({
        state: "paused",
        code: "CAPTURE_RELEASE_WITHDRAWN",
        checkpoint: nsu(2),
      });
      expect(await opOf(f, next)).toMatchObject({
        state: "paused",
        code: "CAPTURE_RELEASE_WITHDRAWN",
      });
      const stopped = await effects(f, streamId, next);
      expect(stopped.events.filter((type) => type === "connection.release_withdrawn")).toHaveLength(
        1,
      );
      expect(stopped.audit.filter((action) => action === "release_withdrawn")).toHaveLength(1);
      // The scheduled query never runs: the operation is no longer claimable.
      const op = await opOf(f, next);
      vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
      expect(
        await f.t.mutation(internal.operations.claim, {
          operationId: next,
          generation: op.generation,
        }),
      ).toBeNull();
      // A second dispatch is a new line of the history, never a second stop.
      const version = (await releaseOf(f)).version;
      expect(await freecorps(f, "emergency_withdraw")).toMatchObject({
        released: false,
        blocked: true,
        version: version + 1,
      });
      expect(await effects(f, streamId, next)).toEqual(stopped);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });

  it("o desbloqueio só tira o bloqueio; repetir é recusado sem gravar nada", async () => {
    const { f, owner, streamId, next } = await capturing();
    await freecorps(f, "emergency_withdraw");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const enable = () =>
      owner.mutation(api.captureRelease.enable, {
        ...ids,
        minIntervalHours: 1,
        terms: CAPTURE_TERMS_VERSION,
      });
    await expect(enable()).rejects.toThrow("CAPTURE_RELEASE_BLOCKED");
    const blocked = await effects(f, streamId, next);
    expect(await freecorps(f, "unblock")).toMatchObject({ released: false, blocked: false });
    expect(await effects(f, streamId, next)).toEqual(blocked);
    expect(await owner.query(api.captureRelease.status, ids)).toMatchObject({
      state: "withdrawn",
      blocked: false,
    });
    const release = await releaseOf(f);
    const history = await f.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect());
    await expect(freecorps(f, "unblock")).rejects.toThrow("CAPTURE_RELEASE_NOT_BLOCKED");
    expect(await releaseOf(f)).toEqual(release);
    expect(await f.t.run((ctx) => ctx.db.query("captureReleaseEvents").collect())).toEqual(history);
    expect(await effects(f, streamId, next)).toEqual(blocked);
  });

  it("a retomada vem de nova liberação e de uma pessoa, do mesmo NSU, sem lacuna", async () => {
    const { f, owner, streamId, next } = await capturing();
    await freecorps(f, "emergency_withdraw");
    await freecorps(f, "unblock");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const { version } = await owner.mutation(api.captureRelease.enable, {
      ...ids,
      minIntervalHours: 1,
      terms: CAPTURE_TERMS_VERSION,
    });
    // A new release resumes nothing by itself: the stream waits for a person.
    const paused = await streamOf(f, streamId);
    expect(paused).toMatchObject({ state: "paused", code: "CAPTURE_RELEASE_WITHDRAWN" });
    expect(paused.operationId).toBe(next);
    const resumed = await owner.mutation(api.captures.control, {
      ...ids,
      environment: "production",
      action: "resume",
      expectedVersion: paused.version,
    });
    expect(resumed).toMatchObject({ state: "active" });
    const stream = await streamOf(f, streamId);
    expect(stream.operationId).not.toBe(next);
    expect(JSON.parse((await opOf(f, stream.operationId!)).request)).toMatchObject({
      previousOperationId: next,
    });
    // The query asks from the NSU where the capture stopped and receives what came after it.
    const token = await f.claim(stream.operationId!);
    await respond(
      f,
      token,
      distributionXml({
        environment: "1",
        max: 4,
        envelopes: [
          { nsu: 3, xml: corpus("summary-authorized") },
          { nsu: 4, xml: corpus("invoice-authorized") },
        ],
      }),
    );
    expect(await f.t.mutation(internal.operations.publish, token)).toBe(true);
    const batches = await f.t.run((ctx) => ctx.db.query("captureBatches").collect());
    expect(batches.map((b) => [b.requestNsu, b.lastNsu])).toEqual([
      [nsu(0), nsu(2)],
      [nsu(2), nsu(4)],
    ]);
    const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
    expect(envelopes.map((e) => e.nsu).sort()).toEqual([1, 2, 3, 4].map(nsu));
    const after = await streamOf(f, streamId);
    expect(after).toMatchObject({ state: "active", checkpoint: nsu(4) });
    // The queries the stream schedules from now on run under the new release.
    expect(await opOf(f, after.operationId!)).toMatchObject({
      sourceAccessVersion: `release:${version}`,
    });
  });

  it("só gestor libera de novo; quem só lê não retoma; outra organização não alcança", async () => {
    const { f, streamId } = await capturing();
    await freecorps(f, "emergency_withdraw");
    await freecorps(f, "unblock");
    const ids = { organizationId: f.scope.organizationId, companyId: f.scope.companyId };
    const member = (role: "admin" | "operator" | "developer" | "viewer") =>
      person(f.t, f.scope.organizationId, role, { companyId: f.scope.companyId });
    type Member = Awaited<ReturnType<typeof member>>;
    const enable = (who: Member) =>
      who.mutation(api.captureRelease.enable, {
        ...ids,
        minIntervalHours: 1,
        terms: CAPTURE_TERMS_VERSION,
      });
    for (const role of ["operator", "developer", "viewer"] as const)
      await expect(enable(await member(role))).rejects.toThrow("SCOPE_DENIED");
    // The owner of another organization, in the same deployment, built with the local proof.
    vi.unstubAllEnvs();
    stub(development);
    const outsider = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(`fnfe_${"z".repeat(43)}`),
      suffix: crypto.randomUUID(),
    });
    stub(site);
    const stranger = await person(f.t, outsider.organizationId, "owner");
    await expect(enable(stranger)).rejects.toThrow("ACCESS_DENIED");
    expect((await releaseOf(f)).released).toBe(false);
    await enable(await member("admin"));
    const resume = async (who: Member) =>
      who.mutation(api.captures.control, {
        ...ids,
        environment: "production",
        action: "resume",
        expectedVersion: (await streamOf(f, streamId)).version,
      });
    await expect(resume(await member("viewer"))).rejects.toThrow("SCOPE_DENIED");
    await expect(resume(stranger)).rejects.toThrow("ACCESS_DENIED");
    expect(await streamOf(f, streamId)).toMatchObject({ state: "paused" });
    expect(await resume(await member("operator"))).toMatchObject({ state: "active" });
  });
});
