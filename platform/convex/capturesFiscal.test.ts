import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { consoleProjectFor } from "../../tests/helpers/console";
import { capturePlan } from "../../tests/helpers/platform";
import { requirePlatformEnvironment } from "./environment";
import type { FiscalProofPolicy } from "./lib/fiscalProof";
import * as certificateRuntime from "./lib/certificateRuntime";
import { fixture, claim } from "../../tests/helpers/captures";

/**
 * Homologation and fiscal production: transport opt-in, the validation target and the fiscal
 * proof; and the validation of the public capture commands (`/v1/connections/nfe`).
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

it("homologation requires explicit transport opt-in and rejects local synthetic mutation there", async () => {
  expect(requirePlatformEnvironment().fiscalEnv).toBe("disabled");
  vi.stubEnv("FISCAL_ENV", "homologation");
  expect(() => requirePlatformEnvironment()).toThrow();
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
  expect(requirePlatformEnvironment().fiscalEnv).toBe("homologation");
  const f = await fixture();
  const stream = await f.command("activate");
  await expect(
    f.t.mutation(internal.testing.captureProof.set, { streamId: stream.id, xml: "<synthetic/>" }),
  ).rejects.toThrow("SYNTHETIC_FISCAL_ENV_REQUIRED");
  vi.stubEnv("FISCAL_ENV", "production");
  expect(() => requirePlatformEnvironment()).toThrow();
});

async function fiscalFixture() {
  const f = await fixture();
  const stream = await f.command("activate");
  const token = await claim(f);
  const certificate = await f.t.run(async (ctx) => {
    const op = (await ctx.db.get("operations", token.operationId))!;
    const cert = (await ctx.db.get("certificates", op.certificate!.id))!;
    await ctx.db.patch("certificates", cert._id, {
      metadata: { ...cert.metadata!, fingerprint: "b".repeat(64) },
    });
    return cert;
  });
  const policy: FiscalProofPolicy = {
    deploymentUrl: "https://synthetic-fiscal-123.convex.cloud",
    fiscalEnvironment: "homologation",
    sha: "a".repeat(40),
    ...f.scope,
    certificateId: certificate._id,
    certificateVersion: certificate.version,
    fingerprint: "b".repeat(64),
    cnpj: "00000000000191",
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 2 * 3600_000,
    maxRequests: 1,
  };
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "disabled",
    FISCAL_ENV: "homologation",
    FNFE_CAPTURE_TRANSPORT: "sefaz",
    CONVEX_CLOUD_URL: policy.deploymentUrl,
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    FNFE_FISCAL_PROOF: JSON.stringify(policy),
  }))
    vi.stubEnv(name, value);
  return { ...f, stream, token, policy, certificate };
}

/** The dedicated #50 target marked for fiscal production: platform environment production too. */
async function productionFiscalFixture() {
  const f = await fixture();
  const certificate = await f.t.run(async (ctx) => {
    await ctx.db.patch("apiKeys", f.scope.keyId, { environment: "production" });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { environments: ["production"] });
    const head = (await ctx.db
      .query("certificateHeads")
      .filter((q) => q.eq(q.field("companyId"), f.scope.companyId))
      .unique())!;
    const cert = (await ctx.db.get("certificates", head.activeId!))!;
    await ctx.db.patch("certificates", cert._id, {
      metadata: { ...cert.metadata!, fingerprint: "b".repeat(64) },
    });
    return cert;
  });
  // The proof's production query, like any production capture, needs the plan (#429).
  await capturePlan(f.t, f.scope.organizationId);
  const policy: FiscalProofPolicy = {
    deploymentUrl: "https://synthetic-fiscal-123.convex.cloud",
    fiscalEnvironment: "production",
    sha: "a".repeat(40),
    ...f.scope,
    certificateId: certificate._id,
    certificateVersion: certificate.version,
    fingerprint: "b".repeat(64),
    cnpj: "00000000000191",
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 2 * 3600_000,
    maxRequests: 2,
  };
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    PRODUCT_ENV: "production",
    FNFE_PROOF_FISCAL_ENV: "production",
    EMAIL_MODE: "disabled",
    FISCAL_ENV: "production",
    FNFE_CAPTURE_TRANSPORT: "sefaz",
    CONVEX_CLOUD_URL: policy.deploymentUrl,
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
    FNFE_FISCAL_PROOF: JSON.stringify(policy),
  }))
    vi.stubEnv(name, value);
  f.args.environment = "production";
  const stream = await f.command("activate");
  const token = await claim(f);
  return { ...f, stream, token, policy, certificate };
}

it("fiscal production exists only on the marked validation target, with production data", () => {
  vi.stubEnv("FNFE_PROOF_FISCAL_ENV", "production");
  // Local development cannot carry the mark.
  expect(() => requirePlatformEnvironment()).toThrow("FNFE_PROOF_FISCAL_ENV");
  for (const [name, value] of Object.entries({
    APP_ENV: "validation",
    EMAIL_MODE: "disabled",
    SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
  }))
    vi.stubEnv(name, value);
  // The marked target serves production data even with transport off.
  expect(() => requirePlatformEnvironment()).toThrow("PRODUCT_ENV");
  vi.stubEnv("PRODUCT_ENV", "production");
  expect(requirePlatformEnvironment()).toMatchObject({
    profile: "validation",
    productEnv: "production",
    fiscalEnv: "disabled",
  });
  vi.stubEnv("FISCAL_ENV", "homologation");
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
  expect(() => requirePlatformEnvironment()).toThrow("FISCAL_ENV");
  vi.stubEnv("FISCAL_ENV", "production");
  expect(requirePlatformEnvironment().fiscalEnv).toBe("production");
  vi.stubEnv("FNFE_PROOF_FISCAL_ENV", "homologation");
  expect(() => requirePlatformEnvironment()).toThrow("FNFE_PROOF_FISCAL_ENV");
});

it("fiscal production proof reads the production distribution under its own policy", async () => {
  const f = await productionFiscalFixture();
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).not.toBeNull();
  await f.t.mutation(internal.certificateUse.complete, { ...f.token, result: "success" });
  const transport = vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0, environment: "1" }),
  });
  try {
    const result = await f.t.action(internal.captureWorker.execute, { ...f.token, request: "{}" });
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
});

it.each([
  ["homologation policy", { fiscalEnvironment: "homologation" }],
  ["policy without fiscal environment", { fiscalEnvironment: undefined }],
] as const)("fiscal production refuses a %s", async (_, change) => {
  const f = await productionFiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, ...change }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("a production policy does not open the homologation target", async () => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, fiscalEnvironment: "production" }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("successful fiscal production step pauses without a continuation", async () => {
  const f = await productionFiscalFixture();
  await f.t.run((ctx) => ctx.db.patch("operations", f.token.operationId, { state: "succeeded" }));
  await f.t.mutation(internal.captureProcessing.published, { operationId: f.token.operationId });
  expect(await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id))).toMatchObject({
    state: "paused",
    code: "FISCAL_PROOF_STEP_COMPLETE",
  });
  expect(await f.t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(1);
});

it("the proof runner names the console project only on a validation target", async () => {
  const f = await fixture();
  const call = () =>
    f.t.mutation(internal.captureProcessing.proofConsoleProject, {
      organizationId: f.scope.organizationId,
    });
  await expect(call()).rejects.toThrow("FISCAL_PROOF_DENIED");
  vi.stubEnv("APP_ENV", "validation");
  const id = await call();
  expect(await call()).toBe(id);
  expect(id).toBe(await consoleProjectFor(f.t, f.scope.organizationId));
});

it("fiscal proof consumes its transport budget even when the first request fails", async () => {
  const f = await fiscalFixture();
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).not.toBeNull();
  await f.t.mutation(internal.certificateUse.complete, { ...f.token, result: "failed" });
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
  vi.stubEnv(
    "FNFE_FISCAL_PROOF",
    JSON.stringify({ ...f.policy, startsAt: Date.now(), expiresAt: Date.now() + 3600_000 }),
  );
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("the capture action reads the current Node environment after its object is replaced", async () => {
  const f = await fiscalFixture();
  const previousEnv = process.env;
  vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "disabled");
  process.env = { ...previousEnv, FNFE_CAPTURE_TRANSPORT: "sefaz" };
  const transport = vi.spyOn(certificateRuntime, "transportWithCertificate").mockResolvedValue({
    status: 200,
    body: distributionXml({ status: "137", last: 0, max: 0 }),
  });
  try {
    const result = await f.t.action(internal.captureWorker.execute, { ...f.token, request: "{}" });
    expect(result.kind).toBe("success");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await f.t.run((ctx) => ctx.db.query("captureBatches").collect())).toHaveLength(1);
  } finally {
    process.env = previousEnv;
    transport.mockRestore();
  }
});

it.each(["disabled", "production", ""])(
  "fiscal mode %s prevents a previously started worker from obtaining the certificate",
  async (fiscalEnv) => {
    const f = await fiscalFixture();
    vi.stubEnv("FISCAL_ENV", fiscalEnv);
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "disabled");
    const authorization = f.t.mutation(internal.certificateUse.authorize, f.token);
    if (fiscalEnv === "disabled") await expect(authorization).resolves.toBeNull();
    else await expect(authorization).rejects.toThrow("Invalid platform configuration: FISCAL_ENV");
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("certificateAudit")
          .withIndex("by_certificateId_and_action_and_result", (q) =>
            q
              .eq("certificateId", f.certificate._id)
              .eq("action", "transport")
              .eq("result", "authorized"),
          )
          .collect(),
      ),
    ).toHaveLength(0);
  },
);

it.each([
  ["sha", "c".repeat(40)],
  ["deploymentUrl", "https://other-target-123.convex.cloud"],
  ["cnpj", "11111111000191"],
  ["companyId", "foreign"],
  ["projectId", "foreign"],
  ["organizationId", "foreign"],
  ["certificateId", "foreign"],
  ["certificateVersion", 2],
  ["fingerprint", "c".repeat(64)],
  ["maxRequests", 3],
  ["maxRequests", 0],
] as const)("fiscal proof refuses mismatched or invalid %s", async (field, value) => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify({ ...f.policy, [field]: value }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("fiscal proof fails closed for absent policy, future or expired windows and revoked access", async () => {
  const f = await fiscalFixture();
  for (const policy of [
    "",
    "{",
    JSON.stringify({ ...f.policy, startsAt: Date.now() + 1000 }),
    JSON.stringify({ ...f.policy, startsAt: Date.now() - 2000, expiresAt: Date.now() }),
    JSON.stringify({ ...f.policy, expiresAt: Date.now() + 4 * 3600_000 }),
  ]) {
    vi.stubEnv("FNFE_FISCAL_PROOF", policy);
    expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
  }
  vi.stubEnv("FNFE_FISCAL_PROOF", JSON.stringify(f.policy));
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect(await f.t.mutation(internal.certificateUse.authorize, f.token)).toBeNull();
});

it("fiscal proof denial before IO preserves the source window and does not invent uncertainty", async () => {
  const f = await fiscalFixture();
  vi.stubEnv("FNFE_FISCAL_PROOF", "");
  expect(await f.t.mutation(internal.captureProcessing.prepare, f.token)).toBeNull();
  const op = await f.t.run((ctx) => ctx.db.get("operations", f.token.operationId));
  expect(op).toMatchObject({ state: "paused", uncertain: false, code: "FISCAL_PROOF_DENIED" });
  const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id));
  expect(stream?.nextAllowedAt).toBe(f.stream.nextAllowedAt);
});

it("successful fiscal proof pauses without a continuation or changing persisted checkpoint/cooldown", async () => {
  const f = await fiscalFixture();
  const nextAllowedAt = Date.now() + 3600_000;
  await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", f.token.operationId, { state: "succeeded" });
    await ctx.db.patch("captureStreams", f.stream.id, { checkpoint: nsu(2), nextAllowedAt });
  });
  await f.t.mutation(internal.captureProcessing.published, { operationId: f.token.operationId });
  const stream = await f.t.run((ctx) => ctx.db.get("captureStreams", f.stream.id));
  expect(stream).toMatchObject({
    state: "paused",
    checkpoint: nsu(2),
    nextAllowedAt,
    operationId: f.token.operationId,
    code: "FISCAL_PROOF_STEP_COMPLETE",
  });
  expect(await f.t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(1);
});

it("public HTTP validates environment, selector and manual version without accepting a cursor", async () => {
  const f = await fixture();
  const call = (body: unknown, environment = "sandbox") =>
    f.t.fetch("/v1/connections/nfe", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": environment },
      body: JSON.stringify(body),
    });
  const activated = await call({ companyId: f.scope.companyId, action: "activate" });
  expect(activated.status).toBe(200);
  expect(
    (await call({ companyId: f.scope.companyId, action: "sync", checkpoint: nsu(100) })).status,
  ).toBe(400);
  expect(
    (await call({ companyId: f.scope.companyId, action: "activate" }, "production")).status,
  ).toBe(403);
});
