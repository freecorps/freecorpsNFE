import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requirePlatformEnvironment } from "../environment";
import { issuanceProductionForbiddenVariables } from "./issuanceProduction";
import { hashApiKey } from "./apiKeyCrypto";
import { encryptCertificate } from "./certificateCrypto";
import * as certificateRuntime from "./certificateRuntime";
import * as certificateTransport from "./certificateTransport";
import type { IssuanceInput } from "./issuanceValues";
// Same source module the platform resolves under test, so the XSD catalog is registered once.
import * as fiscalNfse from "../../../packages/fiscal-nfse/src/index";
import { gzipB64, validateDpsXml } from "../../../packages/fiscal-nfse/src/index";
import { syntheticCertificate } from "../../../tests/helpers/certificates";
import { inspectPdf } from "../../../tests/helpers/pdf";
import {
  ISSUANCE_SCOPES,
  SYNTHETIC_ISSUER_CNPJ,
  issuerScope,
  nfseProfile,
  person,
  platformTest,
  projectGrant,
  softwareLicense,
  syntheticApiKey,
  usePlatformEnvironment,
} from "../../../tests/helpers/platform";
import { modules } from "../../../tests/helpers/convex-modules";

/**
 * Profile of the NFS-e fiscal production deployment (ADR 0004 §8, phase 4, #198). The versioned
 * plan names no deployment today; here it names a synthetic one, only to prove what the profile
 * demands once one is named. Every company, key and certificate is synthetic, and the mTLS call
 * is replaced: nothing here reaches a tax authority.
 */
const NAMED = "brave-otter-123";
const NAMED_URL = `https://${NAMED}.convex.cloud`;
vi.mock("../../../deploy/issuance-production.json", () => ({
  default: {
    version: 1,
    deployment: "brave-otter-123",
    url: "https://brave-otter-123.convex.cloud",
  },
}));

/** The named deployment, marked: the hosted installation profile in fiscal production. */
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
  CONVEX_SITE_URL: `https://${NAMED}.convex.site`,
  CONVEX_CLOUD_URL: NAMED_URL,
  API_URL: "https://api.producao.invalid",
  FNFE_ISSUANCE_ENV: "production",
};
/** The #50 capture target: validation profile with production data, transport closed. */
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
const MARK_REFUSED = "Invalid platform configuration: FNFE_ISSUANCE_ENV";

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

const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília
const KEYRING = { active: "k1", keys: { k1: "ab".repeat(32) } };
const SEFIN = "https://sefin.nfse.gov.br/SefinNacional";
const KEY = `3550308${"4".repeat(43)}`;
const nationalTaker = {
  kind: "national" as const,
  document: "11.444.777/0001-61",
  name: "Tomador Sintético Ltda",
  address: {
    municipalityCode: "3550308",
    postalCode: "01001-000",
    street: "Praça da Sé",
    number: "100",
    district: "Sé",
  },
};
const domestic = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issuerEmail: "fiscal@prestador.example",
  market: "domestic",
  taker: nationalTaker,
  description: "Licença de uso de software, outubro de 2026",
  amount: { currency: "BRL", value: "1000" },
  issRate: "2.5",
  issWithheld: false,
  ...overrides,
});
/** Not a Simples company in Campinas: from 01/10/2026 its channel is `campinas-adn` (C2). */
const campinasProfile = {
  municipalityCode: "3509502",
  campinasDpsSeries: "10001",
  activities: [
    {
      ...softwareLicense,
      cTribMun: "001",
      ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
    },
  ],
};
const json = (status: number, body: unknown) => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
  contentType: "application/json",
});
const nfseOf = (dps: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
  `<nNFSe>11</nNFSe>${dps.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;

describe("emissão em production", () => {
  usePlatformEnvironment({
    siteUrl: "http://localhost:5199",
    convexSiteUrl: "http://127.0.0.1:3258",
    secret: "synthetic-issuance-production",
    now: NOW,
  });
  afterEach(() => vi.restoreAllMocks());

  /** Company with profile and active synthetic A1, and a production key granted to it. */
  async function fixture(
    options: { kind?: "declared" | "demonstration"; profile?: Record<string, unknown> } = {},
  ) {
    const t = platformTest();
    const keyHash = await hashApiKey(syntheticApiKey("d"));
    const scope = await issuerScope(t, {
      keyHash,
      kind: options.kind ?? "declared",
      grantScopes: ISSUANCE_SCOPES,
      keyScopes: ISSUANCE_SCOPES,
    });
    await nfseProfile(t, scope, options.profile ?? {});
    const grant = await projectGrant(t, scope.projectId, scope.companyId);
    vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(KEYRING));
    const material = syntheticCertificate({ cnpj: SYNTHETIC_ISSUER_CNPJ });
    await t.run(async (ctx) => {
      await ctx.db.patch("projectCompanies", grant._id, {
        environments: ["sandbox", "production"],
      });
      await ctx.db.patch("apiKeys", scope.keyId, { environment: "production" });
      const membership = (await ctx.db.query("memberships").first())!;
      const now = Date.now();
      const id = await ctx.db.insert("certificates", {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        version: 1,
        state: "active",
        uploaderId: "synthetic",
        membershipId: membership._id,
        membershipVersion: 1,
        metadata: {
          fingerprint: "c".repeat(64),
          subject: "Synthetic certificate, no fiscal validity",
          cnpj: SYNTHETIC_ISSUER_CNPJ,
          notBefore: now - 86400_000,
          notAfter: now + 86400_000,
        },
        envelopeRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const envelope = encryptCertificate(
        KEYRING,
        { organizationId: scope.organizationId, companyId: scope.companyId, id, version: 1 },
        material.pfx,
        material.password,
      );
      await ctx.db.patch("certificates", id, { envelope });
      await ctx.db.insert("certificateHeads", {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        nextVersion: 2,
        latestId: id,
        activeId: id,
      });
    });
    const where = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      companyId: scope.companyId,
      environment: "production" as const,
      keyHash,
    };
    const request = (key: string, overrides: Partial<IssuanceInput> = {}) =>
      t.mutation(internal.issuance.request, {
        ...where,
        idempotencyKey: key,
        input: domestic(overrides),
      });
    const cancel = (
      key: string,
      issuanceId: string,
      reason = "Prova sintética do cancelamento em produção",
    ) =>
      t.mutation(internal.issuance.cancel, {
        ...where,
        idempotencyKey: key,
        issuanceId,
        reasonCode: "1",
        reason,
      });
    /** The fiscal production deployment; `list` is the content of FNFE_NFSE_PRODUCTION_COMPANIES. */
    const onProduction = (list: string | null = scope.companyId) =>
      stub({ ...production, FNFE_NFSE_PRODUCTION_COMPANIES: list ?? undefined });
    /** Through the real switch, from the workflow; the list must already have the company. */
    const gate = (on: boolean) =>
      t.mutation(internal.issuance.setProductionGate, {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        kind: on ? "enable" : "emergency_disable",
        operator: "operador-freecorps",
        ...(on ? { approver: "aprovador-freecorps" } : {}),
        runId: "4242",
        runAttempt: 1,
        reason: "Prova sintética da produção fiscal",
      });
    /** A gate row as a restore could leave it, where no switch may run. */
    const gateRow = (on: boolean) =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("issuanceGates")
          .withIndex("by_companyId", (q) => q.eq("companyId", scope.companyId))
          .unique();
        const fields = {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          production: on,
          actor: "operator:freecorps",
          reason: "Linha sintética de gate",
          version: (row?.version ?? 0) + 1,
          updatedAt: Date.now(),
        };
        if (row) await ctx.db.replace("issuanceGates", row._id, fields);
        else await ctx.db.insert("issuanceGates", fields);
      });
    const rows = () =>
      t.run(async (ctx) => ({
        issuances: await ctx.db.query("issuances").collect(),
        numbers: await ctx.db.query("dpsSequences").collect(),
        cancellations: await ctx.db.query("issuanceCancellations").collect(),
        operations: await ctx.db.query("operations").collect(),
        uses: (await ctx.db.query("certificateAudit").collect()).map(
          (row) => `${row.action}:${row.result}`,
        ),
      }));
    const dpsOf = async (issuanceId: string) =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("issuanceArtifacts")
          .withIndex("by_issuanceId_and_kind", (q) =>
            q.eq("issuanceId", issuanceId as Id<"issuances">).eq("kind", "dps"),
          )
          .first();
        return row ? (await ctx.storage.get(row.storageId))!.text() : "";
      });
    /** Runs the operation like the worker pool would, one claimed attempt at a time. */
    const drive = async (operationId: string, steps = 1) => {
      const id = operationId as Id<"operations">;
      for (let i = 0; i < steps; i++) {
        const op = (await t.run((ctx) => ctx.db.get("operations", id)))!;
        if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
        vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
        await t.action(internal.operationWorker.run, {
          operationId: id,
          generation: op.generation,
        });
      }
      return (await t.run((ctx) => ctx.db.get("operations", id)))!;
    };
    const issuanceRow = (issuanceId: string) =>
      t.run((ctx) => ctx.db.get("issuances", issuanceId as Id<"issuances">));
    return {
      t,
      scope,
      request,
      cancel,
      onProduction,
      gate,
      gateRow,
      rows,
      dpsOf,
      drive,
      issuanceRow,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "OK",
      (error: { data?: { code?: string }; message?: string }) =>
        error.data?.code ?? error.message ?? "ERROR",
    );
  /** The Sefin of production, replaced: authorizes, finds and registers events. */
  function authority(f: Fixture, behaviour: { submit?: "authorize" | "timeout" } = {}) {
    let sent = "";
    let issuanceId = "";
    const spy = vi
      .spyOn(certificateTransport, "certificateRequest")
      .mockImplementation(async (target) => {
        if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
          sent = await f.dpsOf(issuanceId);
          if (behaviour.submit === "timeout") throw new Error("CERTIFICATE_TIMEOUT");
          return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfseOf(sent)) });
        }
        if (target.url.startsWith(`${SEFIN}/dps/`) && target.body === undefined)
          return sent
            ? json(200, { tipoAmbiente: 1, chaveAcesso: KEY })
            : json(404, {
                tipoAmbiente: 1,
                erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
              });
        if (target.url === `${SEFIN}/nfse/${KEY}` && target.body === undefined)
          return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(sent)) });
        if (target.url === `${SEFIN}/nfse/${KEY}/eventos` && target.body !== undefined)
          return json(201, { eventoXmlGZipB64: gzipB64("<evento>sintético</evento>") });
        return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
      });
    return {
      spy,
      track: (id: string) => {
        issuanceId = id;
      },
      calls: () =>
        spy.mock.calls.map(
          ([target]) => `${target.body === undefined ? "GET" : "POST"} ${target.url}`,
        ),
    };
  }
  /** Accepted and authorized in the fiscal production, through the real path. */
  async function authorized(f: Fixture, key = "autorizada") {
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request(key);
    fake.track(accepted.issuance.id);
    await f.drive(accepted.issuance.operationId);
    vi.restoreAllMocks();
    return accepted.issuance;
  }

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
  // Reconciliation of a submitted issuance: a consultation under the cancellation rule (the list,
  // not the gate); a resend is a new submission and needs the gate on.

  /** The Sefin of production, scripted: each submission in turn, and whether the DPS exists. */
  function scripted(f: Fixture, submits: Array<"timeout" | "authorize" | "duplicate">) {
    const state = { issuanceId: "", sent: "", exists: false };
    const spy = vi
      .spyOn(certificateTransport, "certificateRequest")
      .mockImplementation(async (target) => {
        if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
          state.sent = await f.dpsOf(state.issuanceId);
          const next = submits.shift() ?? "authorize";
          if (next === "timeout") {
            state.exists = true;
            throw new Error("CERTIFICATE_TIMEOUT");
          }
          if (next === "duplicate")
            return json(400, {
              tipoAmbiente: 1,
              erros: [
                {
                  codigo: "E0014",
                  mensagem: "Já existe NFS-e emitida para esta DPS.",
                  complemento: null,
                },
              ],
            });
          state.exists = true;
          return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfseOf(state.sent)) });
        }
        if (target.url.startsWith(`${SEFIN}/dps/`) && target.body === undefined)
          return state.exists
            ? json(200, { tipoAmbiente: 1, chaveAcesso: KEY })
            : json(404, {
                tipoAmbiente: 1,
                erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
              });
        if (target.url === `${SEFIN}/nfse/${KEY}` && target.body === undefined)
          return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(state.sent)) });
        return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
      });
    const posts = () =>
      spy.mock.calls.filter(([target]) => target.body !== undefined).map(([target]) => target.url);
    return { spy, state, posts };
  }
  /** Accepted with the gate on, and the first submission lost on the way back. */
  async function timedOut(f: Fixture, key: string, lost: { exists: boolean }) {
    f.onProduction();
    await f.gate(true);
    const fake = scripted(f, ["timeout"]);
    const accepted = await f.request(key);
    fake.state.issuanceId = accepted.issuance.id;
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("reconciling");
    fake.state.exists = lost.exists;
    return { fake, accepted };
  }

  it("timeout e gate desligado: a consulta acha a NFS-e e autoriza, sem reenviar", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-gate-desligado", { exists: true });
    await f.gate(false);
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      accessKey: KEY,
      recoveredByConsult: true,
      submissions: 1,
    });
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
  });

  it("timeout e gate desligado: a consulta não acha e nada é reenviado até religar", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-404", { exists: false });
    await f.gate(false);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_RESEND_BLOCKED",
    });
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_RESEND_BLOCKED",
    });
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
    // With the gate on again, the 404 allows one resend of the same DPS, and it is authorized.
    await f.gate(true);
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`, `${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      submissions: 2,
    });
  });

  it("timeout e empresa fora da lista: nada sai, nem a consulta", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "timeout-fora-da-lista", { exists: true });
    const calls = fake.spy.mock.calls.length;
    f.onProduction("");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(fake.spy.mock.calls.length).toBe(calls);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({ state: "processing" });
  });

  it('"DPS já existe" vai à reconciliação, que acha a nota sem novo envio', async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = scripted(f, ["duplicate"]);
    const accepted = await f.request("dps-ja-existe");
    fake.state.issuanceId = accepted.issuance.id;
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "DPS_ALREADY_EXISTS",
    });
    fake.state.exists = true;
    expect((await f.drive(accepted.issuance.operationId)).state).toBe("succeeded");
    expect(fake.posts()).toEqual([`${SEFIN}/nfse`]);
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
    });
  });

  it("gate ligado em outra organização não libera a empresa, no pedido nem na tentativa", async () => {
    const f = await fixture();
    const other = await f.t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra organização sintética",
        slug: `outra-${crypto.randomUUID()}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const moveGate = (organizationId: Id<"organizations">) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.query("issuanceGates").first())!;
        await ctx.db.patch("issuanceGates", row._id, { organizationId });
      });
    f.onProduction();
    await f.gate(true);
    await moveGate(other);
    expect(await code(f.request("gate-alheio"))).toBe("ISSUANCE_PRODUCTION_DISABLED");
    await moveGate(f.scope.organizationId);
    const fake = authority(f);
    const accepted = await f.request("gate-alheio-na-tentativa");
    await moveGate(other);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("a trava de origem numa emissão já enviada mantém a reconciliação, sem novo envio", async () => {
    const f = await fixture();
    const { fake, accepted } = await timedOut(f, "origem-ja-enviada", { exists: false });
    const posts = fake.posts().length;
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "ISSUANCE_TARGET_INVALID",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
    expect(vault).not.toHaveBeenCalled();
    expect(fake.posts()).toHaveLength(posts);
  });

  /** Closes the list after the vault handed out the A1, before the submission is marked. */
  function closeListInsideTheVault(f: Fixture) {
    const real = certificateRuntime.withCertificate;
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(
      async (ctx, claim, use) =>
        real(ctx, claim, async (material) => {
          f.onProduction("");
          return use(material);
        }),
    );
  }

  it("a marca do envio confere a política na mesma transação: lista fechada no meio, nada sai", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("fecha-antes-da-marca");
    closeListInsideTheVault(f);
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("a marca do cancelamento confere a política na mesma transação: lista fechada no meio, nada sai", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = authority(f);
    await f.cancel("cancelar-fecha-antes-da-marca", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    closeListInsideTheVault(f);
    expect(await f.drive(cancellation!.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "authorized" });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  it("emissão marcada como enviada sem a DPS gravada nunca monta nem envia DPS nova", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("enviada-sem-dps");
    // As if the submission had been marked and the persisted DPS were lost.
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, { submissions: 1 }),
    );
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "DPS_UNAVAILABLE",
    });
    expect(await f.dpsOf(accepted.issuance.id)).toBe("");
    expect(fake.spy).not.toHaveBeenCalled();
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "processing",
      submissions: 1,
    });
  });

  it("a trava de origem recusa outro host de produção antes do cofre", async () => {
    const f = await fixture();
    f.onProduction();
    await f.gate(true);
    const fake = authority(f);
    const accepted = await f.request("outro-host");
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    expect(await f.drive(accepted.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TARGET_INVALID",
    });
    expect(await f.issuanceRow(accepted.issuance.id)).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(vault).not.toHaveBeenCalled();
    expect(fake.spy).not.toHaveBeenCalled();
    expect((await f.rows()).uses).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Cancellation of a real invoice: the gate is not needed, the list is (ADR 0004 §8, 3rd amendment).

  it("recusa o marcador do simulador no motivo do cancelamento de nota real", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    for (const reason of [
      "Cancelamento sintético [simular:rejeicao]",
      "Motivo [SIMULAR:timeout] de teste",
    ])
      expect(await code(f.cancel(`motivo-${reason.length}`, issuance.id, reason))).toBe(
        "CANCEL_REASON_INVALID",
      );
    expect((await f.rows()).cancellations).toEqual([]);
  });

  it("cancela nota real com o gate desligado, se a empresa continua na lista", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    await f.gate(false);
    const fake = authority(f);
    fake.track(issuance.id);
    await f.cancel("cancelar-gate-desligado", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    expect(await f.drive(cancellation!.operationId)).toMatchObject({ state: "succeeded" });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "cancelled" });
    expect(fake.calls()).toEqual([`POST ${SEFIN}/nfse/${KEY}/eventos`]);
    expect((await f.rows()).uses.slice(-2)).toEqual([
      "nfse-production:authorized",
      "nfse-production:success",
    ]);
  });

  it("recusa cancelar nota real com a empresa fora da lista, antes e durante a operação", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = authority(f);
    f.onProduction("");
    expect(await code(f.cancel("cancelar-fora-da-lista", issuance.id))).toBe(
      "ISSUANCE_PRODUCTION_DISABLED",
    );
    expect((await f.rows()).cancellations).toEqual([]);
    // Accepted while listed, then the company leaves the list: nothing is sent.
    f.onProduction();
    await f.cancel("cancelar-e-sair-da-lista", issuance.id);
    const [cancellation] = (await f.rows()).cancellations;
    f.onProduction("");
    expect(await f.drive(cancellation!.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.issuanceRow(issuance.id)).toMatchObject({ state: "authorized" });
    expect(fake.spy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------------------------
  // Operator probe and read-only verification on the fiscal production deployment.

  const ADN = "https://adn.nfse.gov.br";
  const probeArgs = (f: Fixture, extra: Record<string, unknown> = {}) => ({
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    operator: "operador-freecorps",
    reason: "Fase 4 (#198): prova de mTLS e adesão em produção",
    ...extra,
  });
  const probe = (f: Fixture, extra: Record<string, unknown> = {}) =>
    f.t.action(internal.issuanceProbe.verify, probeArgs(f, extra));
  const verifyIssued = (f: Fixture, issuanceId: string, extra: Record<string, unknown> = {}) =>
    f.t.action(internal.issuanceProbe.verifyIssued, {
      ...probeArgs(f, { reason: "Fase 4 (#198): conferência da nota autorizada", ...extra }),
      issuanceId: issuanceId as Id<"issuances">,
    });
  const history = (f: Fixture) => f.t.run((ctx) => ctx.db.query("issuanceProbeEvents").collect());
  const certificateActors = (f: Fixture) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("certificateAudit").collect())
        .filter((row) => row.action.startsWith("nfse-probe"))
        .map((row) => `${row.action}:${row.result}:${row.actor}`),
    );
  /** The authorities of production, replaced; every call is recorded. */
  function productionAuthority(answers: { dpsKey?: string | null; nfse?: string | null } = {}) {
    return vi
      .spyOn(certificateTransport, "certificateRequest")
      .mockImplementation(async (target) => {
        if (target.url.startsWith(`${SEFIN}/dps/`))
          return answers.dpsKey
            ? json(200, { tipoAmbiente: 1, chaveAcesso: answers.dpsKey })
            : json(404, {
                tipoAmbiente: 1,
                erros: [{ Codigo: "E2220", Descricao: "Não encontrada" }],
              });
        if (target.url.startsWith(`${SEFIN}/nfse/`) && answers.nfse)
          return json(200, { nfseXmlGZipB64: gzipB64(answers.nfse) });
        if (target.url.endsWith("/convenio"))
          return json(200, {
            parametrosConvenio: { aderenteAmbienteNacional: 1, aderenteEmissorNacional: 1 },
          });
        if (target.url.startsWith(`${ADN}/parametrizacao/`)) return json(200, { Aliq: 2 });
        return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
      });
  }

  it("o probe de produção recusa empresa fora da lista e registra a recusa só no histórico", async () => {
    const f = await fixture();
    const fake = productionAuthority();
    f.onProduction("");
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect(await certificateActors(f)).toEqual(["nfse-probe-production:denied:operator:freecorps"]);
    expect(await history(f)).toEqual([
      expect.objectContaining({
        kind: "probe",
        environment: "producao",
        result: "denied",
        code: "ISSUANCE_PROBE_DISABLED",
        operator: "operador-freecorps",
      }),
    ]);
  });

  it("fora do deployment de produção fiscal não há probe de produção nem verificação", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = productionAuthority({ dpsKey: KEY });
    stub({ ...target50, FNFE_ISSUANCE_ENV: undefined, FNFE_NFSE_PRODUCTION_COMPANIES: undefined });
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).map((row) => `${row.kind}:${row.environment}:${row.result}`)).toEqual(
      ["probe:producao-restrita:denied", "verify-issued:producao-restrita:denied"],
    );
  });

  it("recusa operador ou motivo inválido e empresa de demonstração, sem histórico", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    for (const extra of [
      { operator: "operador@freecorps" },
      { reason: "curto" },
      { reason: "Motivo sintético ‮ invertido" },
    ])
      expect(await code(probe(f, extra))).toBe("INVALID_REQUEST");
    expect(await history(f)).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  });

  it("verifica só emissão autorizada em production, da própria empresa", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.gate(true);
    const fake = productionAuthority({ dpsKey: KEY });
    // Still processing: nothing to verify.
    const processing = await f.request("ainda-processando");
    expect(await code(verifyIssued(f, processing.issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
    // An issuance of another company is never found, nor read.
    const other = await f.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", f.scope.companyId))!;
      const { _id, _creationTime, ...rest } = company;
      return ctx.db.insert("companies", { ...rest, cnpj: "11444777000161" });
    });
    expect(
      await code(
        f.t.action(internal.issuanceProbe.verifyIssued, {
          ...probeArgs(f, { companyId: other }),
          issuanceId: issuance.id as Id<"issuances">,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(fake).not.toHaveBeenCalled();
  });

  it("probe de produção: só GET, só Sefin e ADN de produção, histórico com o login", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    const result = await probe(f, {
      municipalityCode: "3550308",
      productionAdhesion: true,
      parameters: { serviceCode: "010501", competence: "2026-10", production: true },
    });
    expect(result.consultations).toEqual([
      expect.objectContaining({
        target: "sefin-nacional",
        host: "sefin.nfse.gov.br",
        outcome: "not-found",
        httpStatus: 404,
      }),
    ]);
    expect(result.adhesion).toEqual([
      expect.objectContaining({
        source: "adn-producao",
        host: "adn.nfse.gov.br",
        aderenteEmissorNacional: 1,
      }),
    ]);
    expect(new Set(result.parameters.map((row) => row.host))).toEqual(new Set(["adn.nfse.gov.br"]));
    for (const [target] of fake.mock.calls) {
      expect(target.body).toBeUndefined();
      expect(["https://sefin.nfse.gov.br", "https://adn.nfse.gov.br"]).toContain(
        new URL(target.url).origin,
      );
      expect(target.allowedOrigins).toEqual([new URL(target.url).origin]);
    }
    const rows = await history(f);
    expect(rows.map((row) => row.result)).toEqual(["authorized", "success"]);
    expect(rows[1]).toMatchObject({
      kind: "probe",
      environment: "producao",
      operator: "operador-freecorps",
      startedId: rows[0]!._id,
    });
    expect(rows[1]!.reads!.length).toBe(fake.mock.calls.length);
    // The customer's certificate audit carries the generic operator only.
    // The customer sees that the A1 was used against the production, never by whom.
    expect(await certificateActors(f)).toEqual([
      "nfse-probe-production:authorized:operator:freecorps",
      "nfse-probe-production:success:operator:freecorps",
    ]);
    expect((await f.rows()).numbers).toEqual([]);
  });

  it("verifica a nota autorizada: uma única NFS-e para o Id, só com GET, sem mudar nada", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const before = await f.issuanceRow(issuance.id);
    f.onProduction();
    const dps = await f.dpsOf(issuance.id);
    const fake = productionAuthority({ dpsKey: KEY, nfse: nfseOf(dps) });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({
      dpsId: issuance.dpsId,
      accessKey: KEY,
      dps: { outcome: "found", accessKey: KEY },
      nfse: { outcome: "found", dpsMatches: true },
      single: true,
    });
    expect(fake.mock.calls.map(([target]) => [target.body, target.url])).toEqual([
      [undefined, `${SEFIN}/dps/${issuance.dpsId}`],
      [undefined, `${SEFIN}/nfse/${KEY}`],
    ]);
    expect(await f.issuanceRow(issuance.id)).toEqual(before);
    const rows = await history(f);
    expect(rows[1]).toMatchObject({
      kind: "verify-issued",
      result: "success",
      issuanceId: issuance.id,
      single: true,
    });
  });

  it("verificação aponta quando a Sefin responde outra nota para o Id", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const otherKey = `3550308${"5".repeat(43)}`;
    const foreign = nfseOf('<DPS><infDPS Id="DPS-outra"></infDPS></DPS>');
    productionAuthority({ dpsKey: otherKey, nfse: foreign });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({
      dps: { outcome: "found", accessKey: otherKey },
      nfse: { dpsMatches: false },
      single: false,
    });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: false });
  });

  it("verifica só nota autorizada ou cancelada, em production", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const fake = productionAuthority({ dpsKey: KEY });
    const id = issuance.id as Id<"issuances">;
    for (const change of [{ state: "rejected" as const }, { environment: "sandbox" as const }]) {
      const before = (await f.issuanceRow(issuance.id))!;
      await f.t.run((ctx) => ctx.db.patch("issuances", id, change));
      expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
      await f.t.run((ctx) =>
        ctx.db.patch("issuances", id, { state: before.state, environment: before.environment }),
      );
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("o probe de produção recusa um host fora da lista fixa, sem chamada", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    const real = fiscalNfse.resolveEndpoint;
    vi.spyOn(fiscalNfse, "resolveEndpoint").mockImplementation((target) => ({
      ...real(target),
      host: "sefin.nfse.example",
    }));
    expect(await code(probe(f))).toBe("PROBE_HOST_DENIED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).map((row) => row.result)).toEqual(["authorized", "failed"]);
  });

  it("o transporte do probe só faz GET sem corpo", async () => {
    const f = await fixture();
    f.onProduction();
    const fake = productionAuthority();
    vi.spyOn(fiscalNfse.nacional, "consultByDps").mockImplementation(async (_, io) => {
      await io.transport({ method: "POST", url: `${SEFIN}/nfse`, headers: {}, body: "{}" });
      throw new Error("unreachable");
    });
    expect(await code(probe(f))).toBe("PROBE_GET_ONLY");
    expect(fake).not.toHaveBeenCalled();
  });

  it("falha de transporte na verificação grava failed, sem single", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    vi.spyOn(certificateTransport, "certificateRequest").mockImplementation(async () => {
      throw new Error("CERTIFICATE_TIMEOUT");
    });
    const result = await verifyIssued(f, issuance.id);
    expect(result).toMatchObject({ single: null, dps: { transportError: "CERTIFICATE_TIMEOUT" } });
    const last = (await history(f)).at(-1)!;
    expect(last).toMatchObject({ kind: "verify-issued", result: "failed" });
    expect(last).not.toHaveProperty("single");
  });

  it("toda recusa depois do operador válido fica no histórico, com o código", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.gate(true);
    const fake = productionAuthority({ dpsKey: KEY });
    const other = await f.t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra organização sintética",
        slug: `outra-${crypto.randomUUID()}`,
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const processing = await f.request("ainda-processando-historico");
    expect(await code(probe(f, { organizationId: other }))).toBe("NOT_FOUND");
    expect(
      await code(
        f.t.action(internal.issuanceProbe.verifyIssued, {
          ...probeArgs(f, { organizationId: other }),
          issuanceId: issuance.id as Id<"issuances">,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await code(verifyIssued(f, processing.issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
    // Without a usable certificate.
    await f.t.run(async (ctx) => {
      const head = (await ctx.db.query("certificateHeads").first())!;
      await ctx.db.patch("certificateHeads", head._id, { activeId: undefined });
    });
    expect(await code(probe(f))).toBe("CERTIFICATE_UNAVAILABLE");
    f.onProduction("");
    expect(await code(probe(f))).toBe("CERTIFICATE_UNAVAILABLE");
    expect(fake).not.toHaveBeenCalled();
    const rows = await history(f);
    expect(rows.map((row) => `${row.kind}:${row.result}:${row.code}`)).toEqual([
      "probe:denied:NOT_FOUND",
      "verify-issued:denied:NOT_FOUND",
      "verify-issued:denied:ISSUANCE_NOT_AUTHORIZED",
      "probe:denied:CERTIFICATE_UNAVAILABLE",
      "probe:denied:CERTIFICATE_UNAVAILABLE",
    ]);
    expect(rows.every((row) => row.operator === "operador-freecorps")).toBe(true);
  });

  it("empresa de demonstração: recusa com histórico", async () => {
    const f = await fixture({ kind: "demonstration" });
    f.onProduction();
    expect(await code(probe(f))).toBe("ISSUANCE_DEMONSTRATION_DENIED");
    expect((await history(f)).map((row) => `${row.result}:${row.code}`)).toEqual([
      "denied:ISSUANCE_DEMONSTRATION_DENIED",
    ]);
  });

  it("verificação recusa empresa fora da lista, com histórico", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    const fake = productionAuthority({ dpsKey: KEY });
    f.onProduction("");
    expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(fake).not.toHaveBeenCalled();
    expect((await history(f)).at(-1)).toMatchObject({
      kind: "verify-issued",
      result: "denied",
      code: "ISSUANCE_PROBE_DISABLED",
      issuanceId: issuance.id,
    });
  });

  it("verifica só emissão para producao e sefin-nacional, com chave", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const fake = productionAuthority({ dpsKey: KEY });
    const id = issuance.id as Id<"issuances">;
    const before = (await f.issuanceRow(issuance.id))!;
    for (const change of [
      { transport: "producao-restrita" as const },
      { target: "campinas-adn" },
      { accessKey: undefined },
    ]) {
      await f.t.run((ctx) => ctx.db.patch("issuances", id, change));
      expect(await code(verifyIssued(f, issuance.id))).toBe("ISSUANCE_NOT_AUTHORIZED");
      await f.t.run((ctx) =>
        ctx.db.patch("issuances", id, {
          transport: before.transport,
          target: before.target,
          accessKey: before.accessKey,
        }),
      );
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("verifica nota cancelada", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", issuance.id as Id<"issuances">, { state: "cancelled" }),
    );
    productionAuthority({ dpsKey: KEY, nfse: nfseOf(await f.dpsOf(issuance.id)) });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({ single: true });
  });

  it.each([
    ["a mesma chave, mas a NFS-e de outra DPS", { sameKey: true, sameDps: false }],
    ["outra chave, com a NFS-e da mesma DPS", { sameKey: false, sameDps: true }],
  ])("single é falso com %s", async (_, answer) => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    const dps = await f.dpsOf(issuance.id);
    productionAuthority({
      dpsKey: answer.sameKey ? KEY : `3550308${"6".repeat(43)}`,
      nfse: nfseOf(answer.sameDps ? dps : '<DPS><infDPS Id="DPS-outra"></infDPS></DPS>'),
    });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({ single: false });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: false });
  });

  it("DPS sem resposta conclusiva deixa single nulo", async () => {
    const f = await fixture();
    const issuance = await authorized(f);
    f.onProduction();
    productionAuthority({ dpsKey: null, nfse: null });
    expect(await verifyIssued(f, issuance.id)).toMatchObject({
      dps: { outcome: "not-found" },
      single: null,
    });
    expect((await history(f)).at(-1)).toMatchObject({ result: "success", single: null });
  });

  it("o fechamento só vale para uma linha autorizada da mesma empresa, uma vez", async () => {
    const f = await fixture();
    f.onProduction();
    productionAuthority();
    await probe(f);
    const rows = await history(f);
    const started = rows[0]!;
    const certificate = (await f.t.run((ctx) => ctx.db.query("certificates").first()))!;
    const close = (
      eventId: Id<"issuanceProbeEvents">,
      companyId = f.scope.companyId,
      certificateId = certificate._id,
    ) =>
      f.t.mutation(internal.certificateUse.completeProbe, {
        organizationId: f.scope.organizationId,
        companyId,
        eventId,
        certificateId,
        version: certificate.version,
        result: "success",
        reads: [],
      });
    // A second closing, a closing of the closing row itself, or by another company, adds nothing.
    const other = await f.t.run(async (ctx) => {
      const company = (await ctx.db.get("companies", f.scope.companyId))!;
      const { _id, _creationTime, ...rest } = company;
      return ctx.db.insert("companies", { ...rest, cnpj: "11444777000161" });
    });
    // Another company with its own certificate cannot close a run still open of this company.
    const otherCertificate = await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = certificate;
      return ctx.db.insert("certificates", { ...rest, companyId: other });
    });
    const open = await f.t.mutation(internal.certificateUse.authorizeProbe, {
      ...probeArgs(f),
      kind: "probe",
    });
    if ("denied" in open) throw new Error("expected an authorized run");
    await close(open.eventId, other, otherCertificate);
    expect((await history(f)).filter((row) => row.startedId === open.eventId)).toEqual([]);
    await close(started._id);
    await close(rows[1]!._id);
    // A denied row is never closed.
    f.onProduction("");
    await code(probe(f));
    const denied = (await history(f)).at(-1)!;
    await close(denied._id);
    expect((await history(f)).length).toBe(4);
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
