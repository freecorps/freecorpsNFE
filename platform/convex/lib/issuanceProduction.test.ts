import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requirePlatformEnvironment } from "../environment";
import { issuanceProductionForbiddenVariables } from "./issuanceProduction";
import { hashApiKey } from "./apiKeyCrypto";
import * as certificateRuntime from "./certificateRuntime";
// Same source module the platform resolves under test, so the XSD catalog is registered once.
import { validateDpsXml } from "../../../packages/fiscal-nfse/src/index";
import { inspectPdf } from "../../../tests/helpers/pdf";
import {
  person,
  platformTest,
  syntheticApiKey,
  usePlatformEnvironment,
} from "../../../tests/helpers/platform";
import { modules } from "../../../tests/helpers/convex-modules";
import {
  NAMED,
  NAMED_URL,
  production,
  target50,
  stub,
  MARK_REFUSED,
  NOW,
  SEFIN,
  KEY,
  nationalTaker,
  campinasProfile,
  fixture,
  code,
  authority,
  authorized,
} from "../../../tests/helpers/issuanceProduction";

/**
 * Profile of the NFS-e fiscal production deployment (ADR 0004 §8, phase 4, #198). The versioned
 * plan names no deployment today; here it names a synthetic one, only to prove what the profile
 * demands once one is named. Every company, key and certificate is synthetic, and the mTLS call
 * is replaced: nothing here reaches a tax authority.
 */
vi.mock("../../../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));

describe("perfil de produção fiscal da emissão", () => {
  beforeEach(() => stub(production));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["com barra final", `${NAMED_URL}/`],
    ["em maiúsculas", NAMED_URL.toUpperCase()],
    ["em http", NAMED_URL.replace("https", "http")],
    ["com região", `https://${NAMED}.eu-west-1.convex.cloud`],
    ["com sufixo", `${NAMED_URL}.invalid`],
    ["de outro número", "https://brave-otter-1234.convex.cloud"],
    ["do sandbox hospedado", "https://elated-possum-295.convex.cloud"],
    ["ausente", undefined],
  ])("recusa o marcador numa URL %s", (_, url) => {
    vi.stubEnv("CONVEX_CLOUD_URL", url);
    expect(() => requirePlatformEnvironment()).toThrow(MARK_REFUSED);
  });

  it("recusa o marcador no alvo da #50, que sem ele continua como antes", () => {
    stub({ ...target50, FNFE_ISSUANCE_ENV: "production" });
    expect(() => requirePlatformEnvironment()).toThrow(MARK_REFUSED);
    vi.stubEnv("FNFE_ISSUANCE_ENV", undefined);
    expect(requirePlatformEnvironment()).toMatchObject({
      profile: "validation",
      productEnv: "production",
      issuanceEnv: "disabled",
    });
  });

  it("entrega as listas de empresas só onde cada transporte pode existir", () => {
    vi.stubEnv("FNFE_NFSE_PRODUCTION_COMPANIES", "emp1, emp2");
    expect(requirePlatformEnvironment()).toMatchObject({
      deploymentUrl: NAMED_URL,
      fiscalTarget: "homologation",
      productionCompanies: new Set(["emp1", "emp2"]),
      restrictedCompanies: new Set(),
    });
    // Malformed fails closed for every company.
    vi.stubEnv("FNFE_NFSE_PRODUCTION_COMPANIES", "emp1,../x");
    expect(requirePlatformEnvironment().productionCompanies).toEqual(new Set());
    // The #50 target carries production data: the restricted production of the sandbox never
    // opens there, even with both of its variables.
    stub({
      ...target50,
      FNFE_ISSUANCE_ENV: undefined,
      FNFE_NFSE_PRODUCTION_COMPANIES: undefined,
      FNFE_NFSE_SANDBOX_TRANSPORT: "producao-restrita",
      FNFE_NFSE_RESTRICTED_COMPANIES: "emp1",
    });
    expect(requirePlatformEnvironment()).toMatchObject({
      deploymentUrl: target50.CONVEX_CLOUD_URL,
      fiscalTarget: "production",
      productionCompanies: new Set(),
      restrictedCompanies: new Set(),
    });
  });

  it.each([undefined, "", " ", " production", "production ", "producao", "PRODUCTION"])(
    "recusa o deployment nomeado com o marcador %j, sem virar sandbox",
    (mark) => {
      vi.stubEnv("FNFE_ISSUANCE_ENV", mark);
      expect(() => requirePlatformEnvironment()).toThrow(MARK_REFUSED);
      vi.stubEnv("PRODUCT_ENV", "sandbox");
      expect(() => requirePlatformEnvironment()).toThrow(MARK_REFUSED);
    },
  );

  it.each([["development"], ["validation"], [undefined]])(
    "recusa o deployment nomeado e marcado com APP_ENV=%s",
    (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      expect(() => requirePlatformEnvironment()).toThrow(MARK_REFUSED);
    },
  );

  it.each([
    ...issuanceProductionForbiddenVariables.flatMap((name) => [
      [name, "x"],
      [name, ""],
    ]),
    ["FNFE_CAPTURE_TRANSPORT", "sefaz"],
  ])("recusa %s=%j no deployment de produção", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => requirePlatformEnvironment()).toThrow(`Invalid platform configuration: ${name}`);
  });

  it.each([
    ["PRODUCT_ENV", "sandbox", "Invalid platform configuration: PRODUCT_ENV"],
    ["FNFE_CRONS", "on", "Invalid platform configuration: FNFE_CRONS"],
    ["FISCAL_ENV", "production", "disabled fiscal transport required"],
    ["FISCAL_ENV", "homologation", "disabled fiscal transport required"],
    ["AUTH_PROXY_MODE", "disabled", "signed proxy"],
  ])("recusa %s=%s no deployment de produção", (name, value, message) => {
    vi.stubEnv(name, value);
    expect(() => requirePlatformEnvironment()).toThrow(message);
  });

  it.each([undefined, "", "disabled"])(
    "serve produção com FNFE_CAPTURE_TRANSPORT %j e a captura desligada",
    async (capture) => {
      vi.stubEnv("FNFE_CAPTURE_TRANSPORT", capture);
      const t = convexTest(schema, modules);
      expect(await (await t.fetch("/health")).json()).toMatchObject({
        status: "ok",
        appEnv: "installation",
        productEnv: "production",
        fiscalEnv: "disabled",
        issuanceEnv: "production",
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Issuance in `production`. The data is prepared on the loopback stack, then the deployment
// profile is switched; the requests come from an API key, which needs no session.

describe("emissão em production", () => {
  usePlatformEnvironment({
    siteUrl: "http://localhost:5199",
    convexSiteUrl: "http://127.0.0.1:3258",
    secret: "synthetic-issuance-production",
    now: NOW,
  });
  afterEach(() => vi.restoreAllMocks());

  // -------------------------------------------------------------------------------------------
  // Refused before any number is reserved.

  it("no alvo da #50, emitir e cancelar em production terminam em NOT_FOUND antes do número", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const before = await f.rows();
    stub({ ...target50, FNFE_ISSUANCE_ENV: undefined, FNFE_NFSE_PRODUCTION_COMPANIES: undefined });
    for (const on of [false, true]) {
      await f.gateRow(on);
      expect(await code(f.request(`alvo-50-${on}`))).toBe("NOT_FOUND");
      expect(await code(f.cancel(`alvo-50-cancelar-${on}`, issuance.id))).toBe("NOT_FOUND");
    }
    const after = await f.rows();
    expect(after.numbers).toEqual(before.numbers);
    expect(after.issuances).toHaveLength(1);
    expect(after.cancellations).toEqual([]);
  });

  it("no deployment nomeado sem o marcador, nada roda", async () => {
    const f = await fixture();
    stub({ ...production, FNFE_ISSUANCE_ENV: undefined });
    expect(await code(f.request("sem-marcador"))).toBe(MARK_REFUSED);
    expect((await f.rows()).issuances).toEqual([]);
  });

  it.each([
    ["ausente", null],
    ["vazia", ""],
    ["com outra empresa", "outra1"],
  ])("empresa fora da lista (%s): emitir é recusado mesmo com o gate ligado", async (_, list) => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    f.onProduction(list);
    expect(await code(f.request("fora-da-lista"))).toBe("ISSUANCE_PRODUCTION_DISABLED");
    const after = await f.rows();
    expect(after.issuances).toEqual([]);
    expect(after.numbers).toEqual([]);
  });

  it("gate desligado recusa emitir antes do número", async () => {
    const f = await fixture();
    f.onProduction();
    expect(await code(f.request("gate-nunca-ligado"))).toBe("ISSUANCE_PRODUCTION_DISABLED");
    await f.gate(true);
    await f.gate(false);
    expect(await code(f.request("gate-desligado"))).toBe("ISSUANCE_PRODUCTION_DISABLED");
    const after = await f.rows();
    expect(after.issuances).toEqual([]);
    expect(after.numbers).toEqual([]);
  });

  it("empresa de demonstração não emite em production", async () => {
    const f = await fixture({ kind: "demonstration" });
    f.onProduction();
    await f.gateRow(true);
    expect(await code(f.request("demonstracao"))).toBe("NOT_FOUND");
    expect((await f.rows()).numbers).toEqual([]);
  });

  it("recusa o canal de Campinas em production, sem forçar outro canal", async () => {
    const f = await fixture({ profile: campinasProfile });
    f.onProduction();
    await f.gate(true);
    const campinas = {
      ...nationalTaker,
      address: { ...nationalTaker.address, municipalityCode: "3509502", postalCode: "13100-030" },
    };
    expect(await code(f.request("campinas", { taker: campinas, issRate: "2" }))).toBe(
      "NFSE_ROUTE_UNSUPPORTED",
    );
    const after = await f.rows();
    expect(after.issuances).toEqual([]);
    expect(after.numbers).toEqual([]);
  });

  it.each(["[simular:timeout]", "Licença [SIMULAR:rejeicao] de outubro", "[Simular:perda]"])(
    "recusa o marcador do simulador na descrição (%s)",
    async (description) => {
      const f = await fixture();
      f.onProduction();
      await f.gate(true);
      expect(await code(f.request("marcador", { description }))).toBe("ISSUANCE_FIELD_INVALID");
      expect((await f.rows()).numbers).toEqual([]);
    },
  );

  // -------------------------------------------------------------------------------------------
  // Transport.

  it("autoriza na Sefin de produção com tpAmb 1, o A1 do cofre e a origem fixa", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("primeira");
    fake.track(accepted.issuance.id);
    expect(accepted.issuance).toMatchObject({
      transport: "producao",
      target: "sefin-nacional",
      state: "processing",
    });
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      accessKey: KEY,
    });
    const dps = await f.dpsOf(accepted.issuance.id);
    expect(validateDpsXml(dps)).toEqual({ valid: true });
    expect(dps).toContain("<tpAmb>1</tpAmb>");
    expect(dps).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
    expect(fake.calls()).toEqual([`POST ${SEFIN}/nfse`]);
    for (const [target] of fake.spy.mock.calls)
      expect(target.allowedOrigins).toEqual(["https://sefin.nfse.gov.br"]);
    expect((await f.rows()).uses).toEqual([
      "nfse-production:authorized",
      "nfse-production:success",
    ]);
  });

  it("o DANFSe da nota de produção sai sem a marca de teste", async () => {
    const f = await fixture();
    const issuance = await authorized(f, "danfse");
    const buffer = await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("issuanceArtifacts")
        .withIndex("by_issuanceId_and_kind", (q) =>
          q.eq("issuanceId", issuance.id as Id<"issuances">).eq("kind", "danfse"),
        )
        .first();
      return (await ctx.storage.get(row!.storageId))!.arrayBuffer();
    });
    const [page] = await inspectPdf(new Uint8Array(buffer));
    expect(page!.text).toContain("Tomador Sintético Ltda");
    expect(page!.text).not.toMatch(/SEM VALOR FISCAL|sem validade fiscal/i);
  });

  it("timeout no envio vai à reconciliação, que acha a nota sem reenviar", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f, { submit: "timeout" });
    const accepted = await f.request("timeout");
    fake.track(accepted.issuance.id);
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("reconciling");
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      accessKey: KEY,
      recoveredByConsult: true,
      submissions: 1,
    });
    expect(fake.calls()).toEqual([
      `POST ${SEFIN}/nfse`,
      `GET ${SEFIN}/dps/${accepted.issuance.dpsId}`,
      `GET ${SEFIN}/nfse/${KEY}`,
    ]);
  });

  it.each(["gate", "lista"] as const)(
    "%s fechado antes da tentativa: falha de vez, nada enviado",
    async (close) => {
      const f = await fixture();
      f.onProduction();
      await f.gate(true);
      const fake = authority(f);
      const accepted = await f.request(`fecha-${close}`);
      if (close === "gate") await f.gate(false);
      else f.onProduction("");
      expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
        state: "failed",
        code: "ISSUANCE_TRANSPORT_DISABLED",
      });
      expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
        state: "rejected",
        submissions: 0,
      });
      expect(fake.spy).not.toHaveBeenCalled();
      expect((await f.rows()).uses).toEqual([]);
    },
  );

  it("emissão congelada para outro canal em production nunca sai, mesmo com tudo liberado", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("outro-canal");
    // As if a row had been written for Campinas (an older version, a restore).
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, {
        target: "campinas-adn",
      }),
    );
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(fake.spy).not.toHaveBeenCalled();
    expect((await f.rows()).uses).toEqual([]);
  });

  it("gate fechado durante a tentativa: o cofre nega o A1 e a emissão falha de vez", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("fecha-na-tentativa");
    // The executor already read the policy open; the emergency workflow closes it before the vault.
    const real = certificateRuntime.withCertificate;
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async (...args) => {
      await f.gate(false);
      return real(...args);
    });
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect((await f.rows()).uses).toEqual(["nfse-production:denied"]);
    expect(fake.spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------------------------
  // What the console reads of the deployment and of the gate.

  it("o console lê o ambiente do deployment: sandbox, alvo da #50 e produção fiscal", async () => {
    const t = platformTest();
    const current = () => t.query(api.deployment.current, {});
    expect(await current()).toEqual({ environment: "sandbox", fiscalProduction: false });
    stub(target50);
    expect(await current()).toEqual({ environment: "production", fiscalProduction: false });
    stub({ ...production, FNFE_PROOF_FISCAL_ENV: undefined });
    expect(await current()).toEqual({ environment: "production", fiscalProduction: true });
  });

  it("owner e admin veem o gate só leitura, sem login; operador e sandbox não veem", async () => {
    const f = await fixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const admin = await person(f.t, f.scope.organizationId, "admin");
    const operator = await person(f.t, f.scope.organizationId, "operator", {
      companyId: f.scope.companyId,
    });
    const context = (client: typeof owner) =>
      client.query(api.issuanceConsole.context, {
        organizationId: f.scope.organizationId,
        company: f.scope.companyId,
      });
    // Sandbox: no gate to show, simulated transport.
    expect(await context(owner)).toMatchObject({ transport: "simulated", productionGate: null });
    f.onProduction();
    for (const reader of [owner, admin])
      expect(await context(reader)).toMatchObject({
        transport: "producao",
        productionGate: { open: false, since: null },
      });
    await f.gate(true);
    const released = await f.t.run((ctx) => ctx.db.query("issuanceGates").first());
    const open = await context(owner);
    expect(open.productionGate).toEqual({ open: true, since: released!.updatedAt });
    // Neither the operator nor the approver logins reach the console.
    expect(JSON.stringify(open)).not.toMatch(/operador-freecorps|aprovador-freecorps|4242/);
    expect(await context(operator)).toMatchObject({ transport: "producao", productionGate: null });
    // Off the list, the gate row stays but the company is closed.
    f.onProduction("");
    expect((await context(owner)).productionGate).toEqual({ open: false, since: null });
    f.onProduction();
    await f.gate(false);
    expect((await context(admin)).productionGate).toEqual({ open: false, since: null });
  });

  it("viewer e developer não veem o gate; outra organização não lê nem libera a empresa", async () => {
    const f = await fixture();
    // Another organization, made while the deployment is still the local one.
    const other = await f.t.mutation(internal.testing.operationProof.prepare, {
      keyHash: await hashApiKey(syntheticApiKey("e")),
      suffix: crypto.randomUUID(),
    });
    f.onProduction();
    await f.gate(true);
    const context = (
      client: Awaited<ReturnType<typeof person>>,
      organizationId = f.scope.organizationId,
    ) => client.query(api.issuanceConsole.context, { organizationId, company: f.scope.companyId });
    for (const role of ["viewer", "developer"] as const) {
      const member = await person(f.t, f.scope.organizationId, role, {
        companyId: f.scope.companyId,
      });
      expect((await context(member)).productionGate).toBeNull();
    }
    // The owner of another organization: in its own organization the company does not exist; in
    // this one it is not a member.
    const stranger = await person(f.t, other.organizationId, "owner");
    expect(await context(stranger, other.organizationId)).toMatchObject({
      companyId: null,
      productionGate: null,
    });
    expect(await code(context(stranger))).not.toBe("OK");
    // A gate row of another organization never opens this company for its owner.
    const owner = await person(f.t, f.scope.organizationId, "owner");
    expect((await context(owner)).productionGate).toMatchObject({ open: true });
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("issuanceGates").first())!;
      await ctx.db.patch("issuanceGates", row._id, { organizationId: other.organizationId });
    });
    expect((await context(owner)).productionGate).toEqual({ open: false, since: null });
  });

  it("num deployment de produção sem emissão (alvo da #50), o console não oferece emitir", async () => {
    const f = await fixture();
    const owner = await person(f.t, f.scope.organizationId, "owner");
    const context = () =>
      owner.query(api.issuanceConsole.context, {
        organizationId: f.scope.organizationId,
        company: f.scope.companyId,
      });
    f.onProduction();
    expect(await context()).toMatchObject({ canIssue: true, transport: "producao" });
    stub({ ...target50, FNFE_ISSUANCE_ENV: undefined, FNFE_NFSE_PRODUCTION_COMPANIES: undefined });
    expect(await context()).toMatchObject({ canIssue: false, productionGate: null });
  });
});
