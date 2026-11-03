/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import {
  ISSUANCE_SCOPES,
  issuerScope,
  platformTest,
  syntheticApiKey,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";

/**
 * Audited production gate (ADR 0004 §8, amendments of 21/10/2026, #198). The versioned plan names
 * no deployment today; here it names a synthetic one, only to prove what the switch demands on
 * the fiscal production deployment. Every organization, company, login and run is synthetic.
 */
vi.mock("../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));

const production = {
  APP_ENV: "installation",
  PRODUCT_ENV: "production",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  WEBHOOK_MODE: "https",
  EMAIL_MODE: "disabled",
  AUTH_PROXY_MODE: "signed",
  AUTH_PROXY_SECRET: "c".repeat(64),
  SITE_URL: "https://console.producao.invalid",
  CONVEX_SITE_URL: "https://brave-otter-123.convex.site",
  CONVEX_CLOUD_URL: "https://brave-otter-123.convex.cloud",
  API_URL: "https://api.producao.invalid",
  FNFE_ISSUANCE_ENV: "production",
};
const target50 = {
  APP_ENV: "validation",
  PRODUCT_ENV: "production",
  FNFE_PROOF_FISCAL_ENV: "production",
  FISCAL_ENV: "disabled",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
  CONVEX_CLOUD_URL: "https://modest-seal-118.convex.cloud",
};
const stub = (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
};
const NOW = Date.UTC(2026, 10, 3, 15);

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3259",
  secret: "synthetic-issuance-gate",
  now: NOW,
});

/** Organization with a company, created on the loopback stack. */
async function company(t: PlatformTest, kind: "declared" | "demonstration" = "declared") {
  return issuerScope(t, {
    keyHash: await hashApiKey(syntheticApiKey("e")),
    kind,
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: ISSUANCE_SCOPES,
  });
}
type Scope = Awaited<ReturnType<typeof company>>;

type Change = {
  kind: "enable" | "emergency_disable";
  operator: string;
  actor?: string;
  approver?: string;
  reason: string;
  runId: string;
  runAttempt: number;
};
const enable: Change = {
  kind: "enable",
  operator: "operador-freecorps",
  approver: "aprovador-freecorps",
  reason: "Primeira nota real da Freecorps (#198)",
  runId: "4242",
  runAttempt: 1,
};
const emergency: Change = {
  kind: "emergency_disable",
  operator: "plantonista",
  reason: "Emergência: nota com dado errado",
  runId: "4243",
  runAttempt: 1,
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string }; message?: string }) =>
      error.data?.code ?? error.message ?? "ERROR",
  );

async function fixture() {
  const t = platformTest();
  const scope = await company(t);
  const switchGate = (
    change: Change,
    target: Pick<Scope, "organizationId" | "companyId"> = scope,
  ) =>
    t.mutation(internal.issuance.setProductionGate, {
      organizationId: target.organizationId,
      companyId: target.companyId,
      ...change,
    });
  const state = () =>
    t.run(async (ctx) => ({
      events: await ctx.db.query("issuanceGateEvents").collect(),
      gates: await ctx.db.query("issuanceGates").collect(),
      audit: (await ctx.db.query("operationalAudit").collect())
        .filter((row) => row.action.startsWith("issuance.production_"))
        .map((row) => `${row.action}:${row.actor}`),
    }));
  /** The fiscal production profile; `null` leaves the list of companies unset. */
  const onProduction = (companies: string | null = scope.companyId) =>
    stub({ ...production, FNFE_NFSE_PRODUCTION_COMPANIES: companies ?? undefined });
  return { t, scope, switchGate, state, onProduction };
}
const untouched = { events: [], gates: [], audit: [] };

describe("gate de produção auditado", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fora do deployment de produção fiscal, nenhuma troca é aceita nem registrada", async () => {
    const f = await fixture();
    for (const change of [enable, emergency]) {
      // Loopback sandbox, as every test deployment.
      expect(await code(f.switchGate(change))).toBe("ISSUANCE_GATE_DEPLOYMENT_DENIED");
      // The #50 capture target: production data, never the issuance switch.
      stub(target50);
      expect(await code(f.switchGate(change))).toBe("ISSUANCE_GATE_DEPLOYMENT_DENIED");
      // The named deployment without the mark does not run at all.
      stub({ ...production, FNFE_PROOF_FISCAL_ENV: undefined, FNFE_ISSUANCE_ENV: undefined });
      expect(await code(f.switchGate(change))).toBe(
        "Invalid platform configuration: FNFE_ISSUANCE_ENV",
      );
      // The list of companies belongs to the production deployment only.
      stub({ ...target50, FNFE_ISSUANCE_ENV: undefined, FNFE_NFSE_PRODUCTION_COMPANIES: "x1" });
      expect(await code(f.switchGate(change))).toBe(
        "Invalid platform configuration: FNFE_NFSE_PRODUCTION_COMPANIES",
      );
      vi.unstubAllEnvs();
      stub({
        APP_ENV: "development",
        PRODUCT_ENV: "sandbox",
        FISCAL_ENV: "disabled",
        FNFE_CRONS: "off",
        EMAIL_MODE: "local",
        WEBHOOK_MODE: "disabled",
        SITE_URL: "http://localhost:5199",
        CONVEX_SITE_URL: "http://127.0.0.1:3259",
        BETTER_AUTH_SECRET: "synthetic-issuance-gate",
      });
    }
    expect(await f.state()).toEqual(untouched);
  });

  it("recusa empresa de outra organização e empresa de demonstração", async () => {
    const f = await fixture();
    const other = await company(f.t);
    const demonstration = await company(f.t, "demonstration");
    f.onProduction(`${f.scope.companyId},${demonstration.companyId}`);
    for (const change of [enable, emergency]) {
      expect(
        await code(
          f.switchGate(change, {
            organizationId: other.organizationId,
            companyId: f.scope.companyId,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await code(f.switchGate(change, demonstration))).toBe("ISSUANCE_DEMONSTRATION_DENIED");
    }
    expect(await f.state()).toEqual(untouched);
  });

  it.each([
    ["ausente", null],
    ["vazia", ""],
    ["com outra empresa", "outra1"],
    ["malformada", "../x"],
  ])("ligar exige a empresa na lista do deployment (lista %s)", async (_, list) => {
    const f = await fixture();
    f.onProduction(list);
    expect(await code(f.switchGate(enable))).toBe("ISSUANCE_GATE_COMPANY_DENIED");
    expect(await f.state()).toEqual(untouched);
  });

  it("um item inválido anula a lista inteira, mesmo com a empresa nela", async () => {
    const f = await fixture();
    for (const list of [`${f.scope.companyId},../x`, `${f.scope.companyId},`]) {
      f.onProduction(list);
      expect(await code(f.switchGate(enable))).toBe("ISSUANCE_GATE_COMPANY_DENIED");
    }
    expect(await f.state()).toEqual(untouched);
  });

  it("ligar recusa organização em encerramento; o desligamento de emergência continua", async () => {
    const f = await fixture();
    f.onProduction();
    await f.t.run((ctx) =>
      ctx.db.insert("organizationClosures", {
        organizationId: f.scope.organizationId,
        state: "closing",
        requestedAt: NOW,
        exportUntil: NOW + 30 * 86_400_000,
        purgeBy: NOW + 37 * 86_400_000,
        generation: 1,
      }),
    );
    expect(await code(f.switchGate(enable))).toBe("ORGANIZATION_CLOSED");
    expect(await f.state()).toEqual(untouched);
    expect(await f.switchGate(emergency)).toEqual({ production: false, version: 1 });
  });

  it.each([
    ["sem aprovador", { approver: undefined }],
    ["aprovador vazio", { approver: " " }],
    ["aprovador igual ao operador", { approver: "operador-freecorps" }],
    ["aprovador igual ao operador em outra caixa", { approver: "Operador-Freecorps" }],
    ["aprovador igual a quem iniciou o run", { actor: "iniciador", approver: "Iniciador" }],
    ["aprovador malformado", { approver: "aprovador@freecorps" }],
  ])("ligar exige um aprovador diferente de quem disparou (%s)", async (_, change) => {
    const f = await fixture();
    f.onProduction();
    expect(await code(f.switchGate({ ...enable, ...change }))).toBe(
      "ISSUANCE_GATE_APPROVER_INVALID",
    );
    expect(await f.state()).toEqual(untouched);
  });

  it("o desligamento de emergência dispensa aprovador, mas recusa um malformado", async () => {
    const f = await fixture();
    f.onProduction();
    expect(await code(f.switchGate({ ...emergency, approver: "aprovador@freecorps" }))).toBe(
      "ISSUANCE_GATE_APPROVER_INVALID",
    );
    expect(await f.state()).toEqual(untouched);
    expect(await f.switchGate(emergency)).toEqual({ production: false, version: 1 });
  });

  it.each([
    ["run id vazio", { runId: "" }],
    ["run id com letras", { runId: "run-42" }],
    ["run id zero", { runId: "0" }],
    ["run id longo", { runId: "1".repeat(21) }],
    ["tentativa zero", { runAttempt: 0 }],
    ["tentativa negativa", { runAttempt: -1 }],
    ["tentativa fracionária", { runAttempt: 1.5 }],
    ["tentativa grande demais", { runAttempt: 10_001 }],
  ])("toda troca exige o run e a tentativa (%s)", async (_, change) => {
    const f = await fixture();
    f.onProduction();
    for (const base of [enable, emergency])
      expect(await code(f.switchGate({ ...base, ...change }))).toBe("ISSUANCE_GATE_RUN_INVALID");
    expect(await f.state()).toEqual(untouched);
  });

  it.each([
    ["operador vazio", { operator: "" }],
    ["operador com e-mail", { operator: "operador@freecorps" }],
    ["operador com hífen no fim", { operator: "operador-" }],
    ["operador longo", { operator: "o".repeat(40) }],
    ["iniciador malformado", { actor: "iniciador@freecorps" }],
    ["motivo curto", { reason: "curto" }],
    ["motivo longo", { reason: "m".repeat(501) }],
    ["motivo com controle C0", { reason: "Motivo sintético\u0007 com controle" }],
    ["motivo com controle C1", { reason: "Motivo sintético\u0085 com controle" }],
    ["motivo com sobreposição bidi", { reason: "Motivo sintético \u202e invertido" }],
    ["motivo com isolamento bidi", { reason: "Motivo sintético \u2066 isolado" }],
    ["motivo com marca da esquerda para a direita", { reason: "Motivo sintético \u200e marcado" }],
    ["motivo com marca da direita para a esquerda", { reason: "Motivo sintético \u200f marcado" }],
    ["motivo com marca de letra árabe", { reason: "Motivo sintético \u061c marcado" }],
  ])("recusa pessoa ou motivo inválido (%s)", async (_, change) => {
    const f = await fixture();
    f.onProduction();
    for (const base of [enable, emergency])
      expect(await code(f.switchGate({ ...base, ...change }))).toBe("INVALID_REQUEST");
    expect(await f.state()).toEqual(untouched);
  });

  it("liga pelo workflow aprovado e desliga pelo de emergência, com histórico só de acréscimo", async () => {
    const f = await fixture();
    f.onProduction();
    // A re-run: the operator triggered attempt 2 of a run first dispatched by someone else
    // (`github.actor`).
    expect(await f.switchGate({ ...enable, actor: "iniciador", runAttempt: 2 })).toEqual({
      production: true,
      version: 1,
    });
    const on = await f.state();
    expect(on.events).toHaveLength(1);
    expect(on.events[0]).toMatchObject({
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      version: 1,
      kind: "enable",
      production: true,
      operator: "operador-freecorps",
      actor: "iniciador",
      approver: "aprovador-freecorps",
      reason: "Primeira nota real da Freecorps (#198)",
      runId: "4242",
      runAttempt: 2,
      buildSha: null,
      deployment: "https://brave-otter-123.convex.cloud",
      createdAt: NOW,
    });
    expect(on.gates).toEqual([
      expect.objectContaining({
        production: true,
        actor: "operator:freecorps",
        version: 1,
        eventId: on.events[0]!._id,
      }),
    ]);
    expect(on.audit).toEqual(["issuance.production_enabled:operator:freecorps"]);

    // Emergency: the company already left the list, and one person closes it, without approval.
    f.onProduction("");
    vi.setSystemTime(NOW + 3_600_000);
    expect(await f.switchGate({ ...emergency, actor: "plantonista" })).toEqual({
      production: false,
      version: 2,
    });
    const off = await f.state();
    expect(off.events[0]).toEqual(on.events[0]);
    expect(off.events[1]).toMatchObject({
      version: 2,
      kind: "emergency_disable",
      production: false,
      operator: "plantonista",
      runId: "4243",
      runAttempt: 1,
      createdAt: NOW + 3_600_000,
    });
    // No approval, and the actor equal to the operator is not repeated.
    expect(off.events[1]).not.toHaveProperty("approver");
    expect(off.events[1]).not.toHaveProperty("actor");
    expect(off.gates).toEqual([
      expect.objectContaining({ production: false, version: 2, eventId: off.events[1]!._id }),
    ]);
    expect(off.audit).toEqual([
      "issuance.production_enabled:operator:freecorps",
      "issuance.production_disabled:operator:freecorps",
    ]);

    // Turning it on again needs the list and the approved workflow again.
    expect(await code(f.switchGate(enable))).toBe("ISSUANCE_GATE_COMPANY_DENIED");
    f.onProduction();
    expect(await f.switchGate(enable)).toEqual({ production: true, version: 3 });
    expect((await f.state()).events.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("os logins da equipe ficam só no histórico, fora do que o cliente vê", async () => {
    const f = await fixture();
    f.onProduction();
    await f.switchGate({ ...enable, actor: "iniciador" });
    await f.switchGate({ ...emergency, approver: "revisora" });
    const logins = [
      "operador-freecorps",
      "aprovador-freecorps",
      "iniciador",
      "plantonista",
      "revisora",
    ];
    const visible = await f.t.run(async (ctx) =>
      JSON.stringify({
        gates: await ctx.db.query("issuanceGates").collect(),
        audit: await ctx.db.query("operationalAudit").collect(),
      }),
    );
    for (const login of logins) expect(visible).not.toContain(login);
    const history = JSON.stringify((await f.state()).events);
    for (const login of logins) expect(history).toContain(login);
  });

  it("numera pela história mesmo com o estado derivado apagado ou regredido", async () => {
    const f = await fixture();
    f.onProduction();
    await f.switchGate(emergency);
    await f.switchGate(emergency);
    // The derived state is lost: the history still numbers the change.
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db.query("issuanceGates").collect())
        await ctx.db.delete("issuanceGates", row._id);
    });
    expect(await f.switchGate(emergency)).toEqual({ production: false, version: 3 });
    // The derived state is restored older than the history.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("issuanceGates").first())!;
      await ctx.db.patch("issuanceGates", row._id, { version: 1 });
    });
    expect(await f.switchGate(emergency)).toEqual({ production: false, version: 4 });
    // A derived state ahead of the history (an older history restored) is not reused either.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("issuanceGates").first())!;
      await ctx.db.patch("issuanceGates", row._id, { version: 9 });
    });
    expect(await f.switchGate(emergency)).toEqual({ production: false, version: 10 });
    const versions = (await f.state()).events.map((row) => row.version);
    expect(versions).toEqual([1, 2, 3, 4, 10]);
  });
});
