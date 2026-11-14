import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { OPERATOR_CLOSURE_LIMIT } from "./organizationClosure";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { insertTerm } from "./lib/planTerms";
import { actor } from "../../tests/helpers/export-fixture";
import {
  DAY,
  fixture,
  type Fixture,
  settleNow,
  code,
  slug,
  closureOf,
} from "../../tests/helpers/closure";

/** The operator closes an organization through the same flow, and the refusals of both closers. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5203",
    CONVEX_SITE_URL: "http://127.0.0.1:3265",
    BETTER_AUTH_SECRET: "synthetic-closure-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const operatorArgs = { actor: "operacao-sintetica", reason: "Sobra sintética do teste de carga" };
it("o operador encerra pelo mesmo fluxo uma organização sem dado fiscal de produção", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"o".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  const close = (args: { organizationId: Id<"organizations">; actor?: string; reason?: string }) =>
    f.t.mutation(internal.organizationClosure.closeByOperator, { ...operatorArgs, ...args });

  expect(await code(close({ organizationId, actor: " " }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, actor: "a@b.invalid" }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, reason: "curto" }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, reason: "x".repeat(501) }))).toBe("INVALID_REQUEST");
  const missing = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Apagada",
      slug: crypto.randomUUID(),
      ownerCount: 0,
      memberCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.delete("organizations", id);
    return id;
  });
  expect(await code(close({ organizationId: missing }))).toBe("NOT_FOUND");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);

  // The fixture's only fiscal document is a sandbox one, and a free plan in force is no refusal.
  await f.t.run((ctx) => planInForce(ctx, f, "free"));
  const closed = await close({ organizationId });
  expect(closed.exportUntil - Date.now()).toBe(30 * DAY);
  expect(closed.purgeBy - closed.exportUntil).toBe(7 * DAY);
  expect(await closureOf(f)).toMatchObject({
    state: "closing",
    requestedBy: "operator:operacao-sintetica",
  });
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(jobs.map((job) => job.name)).toEqual(
    expect.arrayContaining(["organizationClosure:revoke", "organizationClosure:purge"]),
  );
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect(),
  );
  expect(audit).toEqual([
    expect.objectContaining({
      actorUserId: "operator:freecorps",
      action: "organization.closure-requested",
      target: organizationId,
    }),
  ]);
  expect(
    await code(
      owner.client.mutation(api.organizations.update, { organizationId, name: "Outro nome" }),
    ),
  ).toBe("ORGANIZATION_CLOSED");

  // A second call creates nothing.
  expect(await code(close({ organizationId }))).toBe("ORGANIZATION_CLOSED");
  await settleNow(f);
  const rows = await f.t.run((ctx) => ctx.db.query("organizationClosures").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ organizationId, revoked: true });

  // The other organization is untouched.
  const untouched = await f.t.run(async (ctx) => ({
    projects: await ctx.db
      .query("projects")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
    key: await ctx.db.get("apiKeys", other.keyId),
    audit: await ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
    closures: await ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
  }));
  expect(untouched.projects.length).toBeGreaterThan(0);
  expect(untouched.projects.every((p) => p.state === "active")).toBe(true);
  expect(untouched.key?.revokedAt).toBeNull();
  expect(untouched.audit).toEqual([]);
  expect(untouched.closures).toEqual([]);
});

const closeAsOperator = (f: Fixture, organizationId = f.scope.organizationId) =>
  f.t.mutation(internal.organizationClosure.closeByOperator, { organizationId, ...operatorArgs });
/** A second company of the fixture's organization, as the console would create it. */
async function anotherCompany(ctx: MutationCtx, f: Fixture) {
  const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
  return ctx.db.insert("companies", { ...company, cnpj: "11222333000181" });
}
function productionStream(f: Fixture, companyId = f.scope.companyId) {
  const now = Date.now();
  return {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    companyId,
    environment: "production" as const,
    identity: `operator-${companyId}`,
    service: "nfe-distribution" as const,
    state: "paused" as const,
    version: 1,
    checkpoint: "0",
    mode: "distNSU" as const,
    nextAllowedAt: now,
    received: 0,
    createdAt: now,
  };
}
/** An annual term starting on the 1st of `firstPeriod`'s month: in force now, or long ended. */
function annualTerm(ctx: MutationCtx, f: Fixture, firstPeriod: number) {
  const start = new Date(firstPeriod);
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return insertTerm(ctx, {
    organizationId: f.scope.organizationId,
    tier: "intermediate",
    firstPeriod: from,
    endsAt: Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 1),
    source: "stripe",
    references: ["synthetic-operator-term"],
    paidCents: 149000,
    purchasedAt: from,
    segments: [],
    state: "active",
  });
}
/** A plan of the organization that has not ended, with the given tier. */
function planInForce(
  ctx: MutationCtx,
  f: Fixture,
  catalogTier: "free" | "intermediate" | "custom" | undefined,
  endsAt: number | null = Date.now() + DAY,
) {
  return ctx.db.insert("usagePlans", {
    organizationId: f.scope.organizationId,
    catalogTier,
    name: "Plano sintético",
    startsAt: Date.now() - 2 * DAY,
    endsAt,
    limits: { imports: 10, captures: 10, registry: 10, bytes: 10, deliveries: 10 },
    concurrency: 1,
    version: 1,
    updatedAt: Date.now(),
  });
}
const operatorRefusals: [string, string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>][] = [
  [
    "documento de produção",
    "PRODUCTION_DATA",
    (ctx, f) => ctx.db.patch("fiscalDocuments", f.documentId, { environment: "production" }),
  ],
  [
    "artefato de produção sem documento",
    "PRODUCTION_DATA",
    async (ctx, f) =>
      ctx.db.insert("documentArtifacts", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        storageId: await ctx.storage.store(new Blob(["production"])),
        sha256: "synthetic",
        size: 10,
        source: "distribution-xml",
        importedAt: Date.now(),
      }),
  ],
  [
    "importação de produção",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      for (const row of await ctx.db
        .query("imports")
        .withIndex("by_organizationId_and_projectId_and_key", (q) =>
          q.eq("organizationId", f.scope.organizationId),
        )
        .collect())
        await ctx.db.patch("imports", row._id, { environment: "production" });
    },
  ],
  [
    "emissão de produção",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      const now = Date.now();
      const operation = (await ctx.db
        .query("operations")
        .withIndex("by_organizationId_and_projectId_and_environment", (q) =>
          q.eq("organizationId", f.scope.organizationId),
        )
        .first())!;
      await ctx.db.insert("issuances", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        operationId: operation._id,
        state: "authorized",
        transport: "simulated",
        target: "sefin-nacional",
        series: "1",
        number: 1,
        dpsId: "DPS3550308211222333000181000010000000000000001",
        snapshot: "{}",
        snapshotSha256: "synthetic",
        submissions: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    },
  ],
  [
    "stream de captura de produção",
    "PRODUCTION_DATA",
    (ctx, f) => ctx.db.insert("captureStreams", productionStream(f)),
  ],
  [
    "captura liberada antes e retirada",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      const now = Date.now();
      const eventId = await ctx.db.insert("captureReleaseEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        version: 2,
        kind: "emergency_withdraw",
        released: false,
        blocked: false,
        minIntervalHours: 1,
        revokedKeys: 0,
        operator: "operador-freecorps",
        reason: "Liberação sintética retirada",
        runId: "4243",
        runAttempt: 1,
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: now,
      });
      await ctx.db.insert("captureReleases", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        released: false,
        releasedBefore: true,
        blocked: false,
        minIntervalHours: 1,
        actor: "operator:freecorps",
        reason: "Liberação sintética retirada",
        version: 2,
        updatedAt: now,
        eventId,
      });
    },
  ],
  [
    "gate de emissão em produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        production: true,
        actor: "operator:freecorps",
        reason: "Gate sintético em produção",
        version: 1,
        updatedAt: Date.now(),
      }),
  ],
  [
    "sondagem de emissão em produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("issuanceProbeEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        kind: "probe",
        environment: "producao",
        result: "authorized",
        operator: "operador-freecorps",
        reason: "Sondagem sintética de produção",
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: Date.now(),
      }),
  ],
  [
    "produção só na segunda empresa",
    "PRODUCTION_DATA",
    async (ctx, f) =>
      ctx.db.insert("captureStreams", productionStream(f, await anotherCompany(ctx, f))),
  ],
  [
    "conexão Stripe de produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("stripeConnections", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        name: "Stripe sintético",
        active: false,
        config: {
          market: "domestic",
          description: "{itens}",
          invoices: true,
          checkouts: false,
          foreignWithoutNif: "hold",
          refundPolicy: "notify",
        },
        secret: "",
        projectEpoch: 0,
        grantEpoch: 0,
        version: 1,
        createdBy: "synthetic",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  ],
  ["plano intermediate vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, "intermediate")],
  ["plano custom vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, "custom")],
  ["plano sem tier vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, undefined)],
  ["termo anual em vigor", "PAID_PLAN", (ctx, f) => annualTerm(ctx, f, Date.now())],
  // Like a receipt: an annual term once paid keeps the operator out, even after it ended.
  ["termo anual já encerrado", "PAID_PLAN", (ctx, f) => annualTerm(ctx, f, Date.UTC(2020, 0, 1))],
  [
    "mais sondagens de emissão que o limite",
    "OPERATOR_CLOSURE_LIMIT",
    async (ctx, f) => {
      for (let i = 0; i <= OPERATOR_CLOSURE_LIMIT; i++)
        await ctx.db.insert("issuanceProbeEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          kind: "probe",
          environment: "producao-restrita",
          result: "authorized",
          operator: "operador-freecorps",
          reason: "Sondagem sintética de homologação",
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: Date.now(),
        });
    },
  ],
  // The card still charges: a subscription that renews, in either Stripe mode, or an open
  // Checkout (`cardBilling`).
  ...([true, false] as const).map(
    (livemode): [string, string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>] => [
      `assinatura do cartão que renova (livemode ${livemode})`,
      "PAID_PLAN",
      (ctx, f) =>
        ctx.db.insert("billingAccounts", {
          organizationId: f.scope.organizationId,
          customerId: `cus_operator_${livemode}`,
          livemode,
          subscription: {
            id: `sub_operator_${livemode}`,
            status: "active",
            tier: "intermediate",
            cancelAtPeriodEnd: false,
            periodEnd: Date.now() + 30 * DAY,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    ],
  ),
  [
    "Checkout do cartão aberto",
    "PAID_PLAN",
    (ctx, f) =>
      ctx.db.insert("billingCheckouts", {
        organizationId: f.scope.organizationId,
        key: "synthetic-operator-checkout",
        kind: "start",
        tier: "intermediate",
        grantCents: 14900,
        state: "open",
        expiresAt: Date.now() + DAY,
        requestedBy: "synthetic-operator-owner",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  ],
  [
    "recibo de plano da plataforma",
    "PAID_PLAN",
    (ctx, f) =>
      ctx.db.insert("platformPlanReceipts", {
        organizationId: f.scope.organizationId,
        paymentReference: "synthetic-operator-receipt",
        monthlyCents: 14900,
        baseCostCents: 8000,
        stressCostCents: 9000,
        custodyCents: 10800,
        planVersion: 1,
        createdAt: Date.now(),
      }),
  ],
  [
    "mais empresas que o limite",
    "OPERATOR_CLOSURE_LIMIT",
    async (ctx, f) => {
      for (let i = 0; i < OPERATOR_CLOSURE_LIMIT; i++) await anotherCompany(ctx, f);
    },
  ],
];
it("o owner não encerra organização com plano anual em vigor ou agendado", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => annualTerm(ctx, f, Date.now()));
  expect(
    await code(
      owner.client.mutation(api.organizationClosure.close, {
        organizationId: f.scope.organizationId,
        confirmation: await slug(f),
      }),
    ),
  ).toBe("ANNUAL_TERM_ACTIVE");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);
});
it("depois da rescisão pelo suporte, o owner volta a encerrar a organização", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const termId = await f.t.run((ctx) => annualTerm(ctx, f, Date.now()));
  const confirmation = await slug(f);
  const close = () =>
    owner.client.mutation(api.organizationClosure.close, {
      organizationId: f.scope.organizationId,
      confirmation,
    });
  expect(await code(close())).toBe("ANNUAL_TERM_ACTIVE");
  await f.t.mutation(internal.plans.rescindTerm, {
    termId,
    key: "rescission-before-closure",
    actor: "operador-sintetico",
    reason: "Cliente pediu a rescisão e o encerramento",
  });
  expect(await code(close())).toBe("OK");
  expect(await closureOf(f)).toMatchObject({ state: "closing" });
});
it.each(operatorRefusals)("o operador recusa organização com %s", async (_, refusal, setup) => {
  const f = await fixture();
  await f.t.run((ctx) => setup(ctx, f));
  expect(await code(closeAsOperator(f))).toBe(refusal);
  const left = await f.t.run(async (ctx) => ({
    closures: await ctx.db.query("organizationClosures").collect(),
    audit: await ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
      .collect(),
  }));
  expect(left).toEqual({ closures: [], audit: [] });
});

it("o operador encerra organização sem empresa e com plano pago já encerrado", async () => {
  const f = await fixture();
  const organizationId = await f.t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("organizations", {
      name: "Sobra sintética",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("usagePlans", {
      organizationId: id,
      catalogTier: "large",
      name: "Grande",
      startsAt: now - 2 * DAY,
      endsAt: now - DAY,
      limits: { imports: 10, captures: 10, registry: 10, bytes: 10, deliveries: 10 },
      concurrency: 1,
      version: 1,
      updatedAt: now,
    });
    return id;
  });
  const closed = await closeAsOperator(f, organizationId);
  expect(closed.exportUntil - Date.now()).toBe(30 * DAY);
  await settleNow(f);
  const closures = await f.t.run((ctx) => ctx.db.query("organizationClosures").collect());
  expect(closures).toEqual([
    expect.objectContaining({
      organizationId,
      revoked: true,
      requestedBy: "operator:operacao-sintetica",
    }),
  ]);
});

it("o operador não encerra fora de um perfil válido da plataforma", async () => {
  const f = await fixture();
  vi.stubEnv("APP_ENV", "installation");
  await expect(closeAsOperator(f)).rejects.toThrow("explicit HTTPS origin");
  vi.stubEnv("APP_ENV", "development");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);
});
