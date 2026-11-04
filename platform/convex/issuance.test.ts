/// <reference types="vite/client" />
import { consoleProjectFor } from "../../tests/helpers/console";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ISSUANCE_SCOPES,
  SYNTHETIC_ISSUER_CNPJ as ISSUER_CNPJ,
  issuerScope,
  nfseProfile,
  person,
  platformTest,
  softwareLicense,
  syntheticApiKey,
  usePlatformEnvironment,
  type PlatformTest,
  type ProfileFields,
} from "../../tests/helpers/platform";
import { hashApiKey } from "./lib/apiKeyCrypto";
import type { IssuanceInput } from "./lib/issuanceValues";
import { createHash } from "node:crypto";
import https from "node:https";
import { inspectPdf } from "../../tests/helpers/pdf";
import { syntheticCertificate } from "../../tests/helpers/certificates";
import * as certificateTransport from "./lib/certificateTransport";
import * as certificateRuntime from "./lib/certificateRuntime";
import { encryptCertificate } from "./lib/certificateCrypto";
import {
  PARAMETER_BODY_LIMIT,
  boundedBody,
  parameterCompetence,
  parameterServiceCode,
} from "./issuanceProbe";
import {
  restrictedCompanies,
  restrictedTransportAllowed,
  transportModeFor,
} from "./lib/issuanceCore";
import { VER_APLIC } from "./lib/issuanceValues";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import {
  MAX_XML_BYTES,
  VER_APLIC_MAX,
  gzipB64,
  nacional,
  validateDpsXml,
  validatePedRegEventoXml,
} from "../../packages/fiscal-nfse/src/index";
import * as fiscalBuild from "../../packages/fiscal-nfse/src/build";
import * as fiscalEvents from "../../packages/fiscal-nfse/src/events";

/**
 * NFS-e issuance in the sandbox with the simulated transport (ADR 0004, phase 2). Every company,
 * CNPJ, CPF and taker is synthetic; nothing here reaches a tax authority, so nothing here proves
 * an authorization.
 */
/** Lets one test make the PDF renderer fail, to prove the authorization does not wait on it. */

/** Sefin produção restrita (and the simulated sandbox, tpAmb 2): NT 009 layout since 20/10/2026. */
const PRODREST = "nfse-1.01-prodrest-20261020" as const;
const danfseFault = vi.hoisted(() => ({ fail: false }));
// Under test the subpath resolves to the source file; the mock targets that same module.
vi.mock("../../packages/fiscal-nfse/src/danfse", async (original) => {
  const actual = await original<typeof import("../../packages/fiscal-nfse/src/danfse")>();
  return {
    ...actual,
    renderDanfse: (...args: Parameters<typeof actual.renderDanfse>) =>
      danfseFault.fail ? Promise.reject(new Error("synthetic")) : actual.renderDanfse(...args),
  };
});
const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance",
  now: NOW,
});
type T = PlatformTest;

/** Organization, project, declared company with an NFS-e profile in São Paulo (Sefin Nacional). */
async function fixture(
  t = platformTest(),
  options: { profile?: ProfileFields | null; demonstration?: boolean } = {},
) {
  const keyHash = await hashApiKey(syntheticApiKey("b"));
  // The project grant and the key carry the issuance scopes; tests narrow them when needed.
  const scope = await issuerScope(t, {
    keyHash,
    kind: options.demonstration ? "demonstration" : "declared",
    grantScopes: ISSUANCE_SCOPES,
    keyScopes: ISSUANCE_SCOPES,
  });
  if (options.profile !== null) await nfseProfile(t, scope, options.profile);
  const owner = await person(t, scope.organizationId, "owner");
  // People act through the organization's console project; the key, through its own project.
  const where = {
    organizationId: scope.organizationId,
    projectId: await consoleProjectFor(t, scope.organizationId),
    companyId: scope.companyId,
    environment: "sandbox" as const,
  };
  const keyWhere = { ...where, projectId: scope.projectId };
  return { t, scope, where, keyWhere, owner, keyHash };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const nationalTaker = {
  kind: "national" as const,
  document: "11.444.777/0001-61",
  name: "Tomador Sintético Ltda",
  email: "contas@tomador.example",
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
const exported = (overrides: Partial<IssuanceInput> = {}): IssuanceInput => ({
  activityCode: "licenca",
  competence: "2026-10",
  issueDate: "2026-10-05",
  issuerEmail: "fiscal@prestador.example",
  market: "export",
  taker: {
    kind: "foreign",
    nif: "98-7654321",
    name: "Example Grocery LLC",
    address: {
      country: "us",
      city: "San Francisco",
      postalCode: "94105",
      state: "CA",
      street: "Market St",
      number: "548",
      district: "SoMa",
    },
  },
  description: "Software subscription, October 2026",
  amount: { currency: "USD", value: "1000.00" },
  issWithheld: false,
  ...overrides,
});

function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
const request = (f: Fixture, key: string, input: IssuanceInput) =>
  f.owner.mutation(internal.issuance.request, { ...f.where, idempotencyKey: key, input });
const cancel = (f: Fixture, key: string, issuanceId: string, reason: string) =>
  f.owner.mutation(internal.issuance.cancel, {
    ...f.where,
    idempotencyKey: key,
    issuanceId,
    reasonCode: "1",
    reason,
  });
const view = (f: Fixture, issuanceId: string) =>
  f.owner.query(internal.issuance.get, { ...f.where, issuanceId });

/** Runs the operation like the worker pool would, one claimed attempt at a time. */
async function drive(t: T, operationId: Id<"operations">, steps = 1) {
  for (let i = 0; i < steps; i++) {
    const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) break;
    vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
    await t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
  return (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
}
async function xmlOf(t: T, issuanceId: Id<"issuances">, kind: Doc<"issuanceArtifacts">["kind"]) {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("issuanceArtifacts")
      .withIndex("by_issuanceId_and_kind", (q) => q.eq("issuanceId", issuanceId).eq("kind", kind))
      .collect();
    return Promise.all(rows.map(async (row) => (await ctx.storage.get(row.storageId))!.text()));
  });
}
async function simulation(t: T, dpsId: string) {
  return t.run(async (ctx) =>
    (await ctx.db.query("issuanceSimulations").collect()).find((row) => row.dpsId === dpsId),
  );
}

describe("emissão em sandbox", () => {
  it("autoriza uma NFS-e nacional e registra o documento emitido", async () => {
    const f = await fixture();
    const accepted = await request(f, "pedido-1", domestic());
    expect(accepted.reused).toBe(false);
    expect(accepted.issuance).toMatchObject({
      state: "processing",
      transport: "simulated",
      target: "sefin-nacional",
      series: "1",
      number: 1,
      issueDate: "2026-10-08",
      serviceBrl: "1000.00",
    });
    expect(accepted.issuance.dpsId).toBe(`DPS35503082${ISSUER_CNPJ}00001${"1".padStart(15, "0")}`);
    const op = await drive(f.t, accepted.issuance.operationId);
    expect(op.state).toBe("succeeded");
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    expect(done.accessKey).toMatch(/^\d{50}$/);
    expect(done.nfseNumber).toBe("1");
    const artifacts = done.artifacts.map((a) => `${a.kind}:${a.signed}`);
    expect(artifacts.sort((a, b) => a.localeCompare(b))).toEqual([
      "danfse:false",
      "dps:false",
      "nfse:true",
    ]);
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(dps).toContain(`Id="${done.dpsId}"`);
    expect(dps).toContain("<tpAmb>2</tpAmb>");
    expect(dps).toContain("<vServ>1000.00</vServ>");
    expect(dps).toContain("<tpRetISSQN>1</tpRetISSQN><pAliq>2.50</pAliq>");
    expect(dps).toContain(`<verAplic>${VER_APLIC}</verAplic>`);
    expect(validateDpsXml(dps!, PRODREST)).toEqual({ valid: true });
    expect(dps).toContain("<vTotTribMun>25.00</vTotTribMun>");
    expect(dps).toContain("<dCompet>2026-10-08</dCompet>");
    const [nfse] = await xmlOf(f.t, done.id, "nfse");
    expect(nfse).toContain(`Id="NFS${done.accessKey}"`);
    expect(nfse).toContain("sem validade fiscal");
    const state = await f.t.run(async (ctx) => ({
      document: await ctx.db.get("fiscalDocuments", done.documentId!),
      usage: await ctx.db.query("usageEvents").collect(),
      events: await ctx.db.query("issuanceEvents").collect(),
      audit: await ctx.db.query("operationalAudit").collect(),
      listings: await ctx.db.query("documentListings").collect(),
    }));
    // The emitted document stays out of `documents/1` until the contract exposes the direction.
    expect(state.document).toMatchObject({
      model: "nfse",
      direction: "emitted",
      fiscalKey: done.accessKey,
      completeness: -1,
    });
    expect(state.document?.publishedVersionId).toBeUndefined();
    expect(state.listings).toEqual([]);
    expect(state.usage.filter((u) => u.metric === "issuances")).toMatchObject([
      { key: `issuance:${done.id}`, quantity: 1, state: "committed" },
    ]);
    expect(state.events.map((e) => e.kind)).toEqual([
      "accepted",
      "dps_saved",
      "submitted",
      "danfse_saved",
      "authorized",
    ]);
    expect(state.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["issuance.accepted", "issuance.authorized"]),
    );
  });

  it("gera o DANFSe do XML autorizado, com a marca do simulador", async () => {
    const f = await fixture();
    const accepted = await request(f, "danfse-1", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    const danfse = done.artifacts.find((a) => a.kind === "danfse")!;
    const bytes = new Uint8Array(
      await f.t.run(async (ctx) => {
        const row = (await ctx.db.get("issuanceArtifacts", danfse.id))!;
        return (await ctx.storage.get(row.storageId))!.arrayBuffer();
      }),
    );
    expect(bytes.byteLength).toBe(danfse.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(danfse.sha256);
    const [page] = await inspectPdf(bytes);
    for (const piece of [
      "SEM VALOR FISCAL — SANDBOX/SIMULADO",
      done.accessKey!.slice(0, 10),
      "CNPJ 11.222.333/0001-81",
      "Tomador Sintético Ltda",
      "R$ 1.000,00",
      "Alíquota 2,50%",
      "sem validade fiscal",
    ])
      expect(page!.text).toContain(piece);
    expect(page!.qr).toContain(done.accessKey!);
    // The provider's name comes from the `emit` group the simulator writes, like the real one.
    const company = await f.t.run((ctx) => ctx.db.get("companies", f.scope.companyId));
    expect(page!.text).toContain(company!.name);
  });

  it("falha do PDF não segura a autorização e fica registrada", async () => {
    const f = await fixture();
    danfseFault.fail = true;
    try {
      const accepted = await request(f, "danfse-falha", domestic());
      expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
      const done = await view(f, accepted.issuance.id);
      expect(done.state).toBe("authorized");
      expect(done.artifacts.map((a) => a.kind)).not.toContain("danfse");
      const events = await f.t.run((ctx) => ctx.db.query("issuanceEvents").collect());
      expect(events.find((e) => e.kind === "danfse_failed")).toMatchObject({
        code: "DANFSE_RENDER_FAILED",
      });
    } finally {
      danfseFault.fail = false;
    }
  });

  it("exporta em USD com a PTAX simulada do dia útil anterior, congelada na emissão", async () => {
    const f = await fixture();
    const accepted = await request(f, "export-1", exported());
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    // 05/10/2026 is a Monday: the previous business day is Friday, 02/10.
    expect(done.exchange).toMatchObject({
      currency: "USD",
      amount: "1000.00",
      rate: "5.432100",
      quoteDate: "2026-10-02",
      brlAmount: "5432.10",
      source: "simulated",
    });
    expect(done.serviceBrl).toBe("5432.10");
    const [dps] = await xmlOf(f.t, done.id, "dps");
    for (const piece of [
      "<NIF>98-7654321</NIF>",
      "<cPais>US</cPais>",
      "<tpMoeda>220</tpMoeda>",
      "<vServMoeda>1000.00</vServMoeda>",
      "<vServ>5432.10</vServ>",
      "<tribISSQN>3</tribISSQN>",
      "<cPaisResult>US</cPaisResult>",
      "</endExt><xLgr>Market St</xLgr><nro>548</nro><xBairro>SoMa</xBairro></end>",
    ])
      expect(dps).toContain(piece);
    expect(dps).not.toContain("<pAliq>");
    expect(validateDpsXml(dps!, PRODREST)).toEqual({ valid: true });
  });

  it("valida o pedido no servidor antes de reservar número", async () => {
    const f = await fixture();
    const cases: Array<[IssuanceInput, string]> = [
      [domestic({ issRate: undefined }), "ISSUANCE_ISS_RATE_REQUIRED"],
      [domestic({ issRate: "5.01" }), "ISSUANCE_ISS_RATE_INVALID"],
      // The DPS carries 2 places (TSDec1V2): a third significant place would need rounding.
      [domestic({ issRate: "2.015" }), "ISSUANCE_ISS_RATE_INVALID"],
      [domestic({ amount: { currency: "BRL", value: "10.001" } }), "ISSUANCE_AMOUNT_INVALID"],
      [domestic({ amount: { currency: "BRL", value: "1e3" } }), "ISSUANCE_AMOUNT_INVALID"],
      [domestic({ amount: { currency: "USD", value: "10" } }), "ISSUANCE_CURRENCY_INVALID"],
      [domestic({ competence: "2026-11" }), "ISSUANCE_COMPETENCE_FUTURE"],
      [domestic({ issueDate: "2026-10-09" }), "ISSUANCE_DATE_FUTURE"],
      [exported({ issRate: "2" }), "ISSUANCE_ISS_NOT_LEVIED"],
      [exported({ amount: { currency: "BRL", value: "10" } }), "ISSUANCE_EXPORT_CURRENCY_REQUIRED"],
      [domestic({ market: "export" }), "ISSUANCE_EXPORT_TAKER_REQUIRED"],
      [
        domestic({ taker: { ...nationalTaker, document: "11444777000162" } }),
        "ISSUANCE_TAKER_DOCUMENT_INVALID",
      ],
      [domestic({ activityCode: "inexistente" }), "NFSE_ACTIVITY_NOT_FOUND"],
      [domestic({ issuerEmail: "fiscal\u0000@prestador.example" }), "ISSUANCE_FIELD_INVALID"],
    ];
    for (const [input, expected] of cases)
      expect(await code(request(f, crypto.randomUUID(), input))).toBe(expected);
    const left = await f.t.run(async (ctx) => ({
      sequences: await ctx.db.query("dpsSequences").collect(),
      issuances: await ctx.db.query("issuances").collect(),
      operations: await ctx.db.query("operations").collect(),
    }));
    expect(left).toEqual({ sequences: [], issuances: [], operations: [] });
  });

  it("recusa empresa sem perfil, empresa de demonstração e rota sem canal suportado", async () => {
    const none = await fixture(platformTest(), { profile: null });
    expect(await code(request(none, "a", domestic()))).toBe("NFSE_PROFILE_REQUIRED");
    const demo = await fixture(platformTest(), { demonstration: true });
    expect(await code(request(demo, "a", domestic()))).toBe("ISSUANCE_DEMONSTRATION_DENIED");
    // Campinas before 21/09/2026 only had the municipal ABRASF issuer (rule C1).
    const campinas = await fixture(platformTest(), { profile: { municipalityCode: "3509502" } });
    const old = domestic({ issueDate: "2026-09-15", competence: "2026-09" });
    await expect(request(campinas, "a", old)).rejects.toMatchObject({
      data: { code: "NFSE_ROUTE_UNSUPPORTED", reason: "ROUTE_ABRASF" },
    });
    // From 01/10/2026 the route is the Campinas ADN, which needs fields the profile lacks.
    expect(await code(request(campinas, "b", domestic()))).toBe("NFSE_ROUTE_PROFILE_INCOMPLETE");
    expect(await campinas.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
  });
});

/** Campinas profile with what its validator requires (codes from the legacy homolog test). */
const campinasProfile = (overrides: ProfileFields = {}): ProfileFields => ({
  municipalityCode: "3509502",
  campinasDpsSeries: "10001",
  activities: [
    {
      ...softwareLicense,
      cTribMun: "001",
      ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
    },
  ],
  ...overrides,
});
const campinasTaker = {
  ...nationalTaker,
  address: { ...nationalTaker.address, municipalityCode: "3509502", postalCode: "13100-030" },
};

describe("canal de Campinas (campinas-adn)", () => {
  it("emite para não optante com cTribMun e IBS/CBS no XSD oficial, sem dest nem cLocIncid", async () => {
    const f = await fixture(platformTest(), { profile: campinasProfile() });
    const accepted = await request(
      f,
      "campinas-1",
      domestic({ taker: campinasTaker, issRate: "2" }),
    );
    expect(accepted.issuance).toMatchObject({ target: "campinas-adn", series: "10001", number: 1 });
    expect(accepted.issuance.dpsId).toBe(`DPS35095022${ISSUER_CNPJ}10001${"1".padStart(15, "0")}`);
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(dps).toMatch(
      /<cServ><cTribNac>010501<\/cTribNac><cTribMun>001<\/cTribMun><xDescServ>[^<]+<\/xDescServ><cNBS>111032200<\/cNBS><\/cServ>/,
    );
    // indDest 0: the taker is the recipient, so no <dest> (E0910); the DPS has no cLocIncid.
    expect(dps).toMatch(/<\/toma><serv>/);
    expect(dps).not.toContain("<dest>");
    // Profile without IM: the DPS keeps omitting it.
    expect(dps).not.toContain("<IM>");
    expect(dps).toContain(
      "<tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun>",
    );
    expect(validateDpsXml(dps!)).toEqual({ valid: true });
    expect(dps).toMatch(
      /<IBSCBS><finNFSe>0<\/finNFSe><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS><\/trib><\/valores><\/IBSCBS><\/infDPS>/,
    );
  });

  it("o simulador atende os caminhos da IMA: a reconciliação encontra a nota sem reenviar", async () => {
    const f = await fixture(platformTest(), { profile: campinasProfile() });
    const accepted = await request(
      f,
      "campinas-timeout",
      domestic({ taker: campinasTaker, issRate: "2", description: "Teste [simular:duplicada]" }),
    );
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("reconciling");
    // First consultation: 404 with the national envelope, so the same DPS is resent.
    expect((await drive(f.t, accepted.issuance.operationId)).code).toBe("DPS_ALREADY_EXISTS");
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "authorized" });
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
  });

  it("leva a IM do perfil em <prest>, entre CNPJ e email, no XSD oficial", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ municipalRegistration: "1234567" }),
    });
    const accepted = await request(f, "im-1", domestic({ taker: campinasTaker, issRate: "2" }));
    expect(accepted.issuance.target).toBe("campinas-adn");
    await drive(f.t, accepted.issuance.operationId);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    expect(dps).toContain(`<prest><CNPJ>${ISSUER_CNPJ}</CNPJ><IM>1234567</IM><email>`);
    expect(validateDpsXml(dps!)).toEqual({ valid: true });
  });

  it("a IM vem do snapshot congelado: perfil alterado depois do aceite não muda a DPS", async () => {
    const f = await fixture(platformTest(), { profile: campinasProfile() });
    const accepted = await request(f, "im-2", domestic({ taker: campinasTaker, issRate: "2" }));
    await f.t.run(async (ctx) => {
      const profile = await ctx.db.query("nfseProfiles").first();
      await ctx.db.patch("nfseProfiles", profile!._id, { municipalRegistration: "7654321" });
    });
    await drive(f.t, accepted.issuance.operationId);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    expect(dps).not.toContain("<IM>");
  });

  it("Sefin Nacional não recebe os grupos de Campinas, mesmo com o perfil preenchido", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ municipalityCode: "3550308", municipalRegistration: "1234567" }),
    });
    const accepted = await request(f, "sp-1", domestic());
    expect(accepted.issuance).toMatchObject({ target: "sefin-nacional", series: "1" });
    await drive(f.t, accepted.issuance.operationId);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    // No <IM> either: E0120, the issuer has no CNC record at Sefin Nacional.
    for (const piece of ["<dest>", "<cTribMun>", "<cLocIncid>", "<IBSCBS>", "<IM>"])
      expect(dps).not.toContain(piece);
  });

  it("recusa antes de reservar número e diz o que falta no perfil", async () => {
    const bare = await fixture(platformTest(), { profile: { municipalityCode: "3509502" } });
    await expect(request(bare, "a", domestic({ taker: campinasTaker }))).rejects.toMatchObject({
      data: {
        code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
        missing: ["cTribMun", "ibsCbs", "campinasDpsSeries"],
      },
    });
    // Without a Campinas series, the main one serves when it is in the integration range.
    const main = await fixture(platformTest(), {
      profile: campinasProfile({ campinasDpsSeries: undefined, dpsSeries: "20000" }),
    });
    expect((await request(main, "b", domestic({ taker: campinasTaker }))).issuance.series).toBe(
      "20000",
    );
    expect(await bare.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
  });

  it("Simples sem retenção vai sem alíquota (L0006 em 09/10); retenção e não optante a exigem", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    expect(await code(request(f, "a", domestic({ taker: campinasTaker, issRate: "2" })))).toBe(
      "ISSUANCE_ISS_RATE_NOT_ALLOWED",
    );
    const accepted = await request(f, "b", domestic({ taker: campinasTaker, issRate: undefined }));
    expect(accepted.issuance.target).toBe("campinas-adn");
    await drive(f.t, accepted.issuance.operationId);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    expect(dps).toContain("<tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>");
    expect(dps).not.toContain("<pAliq>");
    expect(dps).toContain("<vTotTribMun>0.00</vTotTribMun>");
    expect(validateDpsXml(dps!)).toEqual({ valid: true });
    // Withholding states the rate, Simples or not.
    expect(
      await code(
        request(f, "c", domestic({ taker: campinasTaker, issRate: undefined, issWithheld: true })),
      ),
    ).toBe("ISSUANCE_ISS_RATE_REQUIRED");
    expect(
      (await request(f, "d", domestic({ taker: campinasTaker, issRate: "2", issWithheld: true })))
        .issuance.target,
    ).toBe("campinas-adn");
    // A non-opting provider in Campinas states the rate.
    const nonOpting = await fixture(platformTest(), { profile: campinasProfile() });
    expect(
      await code(request(nonOpting, "e", domestic({ taker: campinasTaker, issRate: undefined }))),
    ).toBe("ISSUANCE_ISS_RATE_REQUIRED");
  });

  it("exige CEP do tomador no exterior também do optante do Simples", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const foreign = exported();
    const taker = foreign.taker as Extract<IssuanceInput["taker"], { kind: "foreign" }>;
    const { postalCode: _postal, ...address } = taker.address;
    expect(await code(request(f, "f", { ...foreign, taker: { ...taker, address } }))).toBe(
      "ISSUANCE_FIELD_INVALID",
    );
    expect((await request(f, "g", foreign)).issuance.target).toBe("campinas-adn");
    // From 01/11/2026 the Simples goes to the Sefin Nacional (C6), outside this channel.
  });

  it("exportação equivalente à rejeitada com L9999 em 09/10 sai no XSD oficial", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ campinasDpsSeries: "20001" }),
    });
    const taker = {
      kind: "foreign" as const,
      nifAbsence: 2 as const,
      name: "Synthetic Buyer Inc.",
      address: {
        country: "US",
        city: "New York",
        postalCode: "10001",
        state: "NY",
        street: "Synthetic Avenue",
        number: "100",
        district: "N/A",
      },
    };
    const accepted = await request(f, "export-l9999", exported({ taker }));
    expect(accepted.issuance).toMatchObject({ target: "campinas-adn", series: "20001" });
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    const [dps] = await xmlOf(f.t, done.id, "dps");
    for (const piece of [
      "<serie>20001</serie>",
      "<toma><cNaoNIF>2</cNaoNIF>",
      "<endExt><cPais>US</cPais><cEndPost>10001</cEndPost><xCidade>New York</xCidade><xEstProvReg>NY</xEstProvReg></endExt><xLgr>Synthetic Avenue</xLgr><nro>100</nro><xBairro>N/A</xBairro>",
      "<cTribMun>001</cTribMun>",
      "<cNBS>111032200</cNBS>",
      "<tpMoeda>220</tpMoeda>",
      "<indDest>0</indDest>",
    ])
      expect(dps).toContain(piece);
    expect(VER_APLIC.length).toBeLessThanOrEqual(VER_APLIC_MAX);
    expect(validateDpsXml(dps!)).toEqual({ valid: true });
    // The same DPS without xBairro and with the old 25-character verAplic fails the XSD.
    const old = dps!
      .replace("<xBairro>N/A</xBairro>", "")
      .replace(
        `<verAplic>${VER_APLIC}</verAplic>`,
        "<verAplic>freecorpsNFE-plataforma/1</verAplic>",
      );
    const result = validateDpsXml(old);
    expect(result.valid ? [] : result.issues.map((i) => i.element)).toEqual(["verAplic", "end"]);
  });
});

/**
 * Group IBSCBS by regime, subitem and taxable event (Ato Conjunto RFB/CGIBS 4/2026, #338), on
 * any target. The classification codes are synthetic, the ones of the legacy homolog test.
 */
describe("grupo IBSCBS pelo Ato Conjunto 4/2026", () => {
  const IBS_CBS = { cIndOp: "100501", cst: "000", cClassTrib: "000001" };
  /** Subitem 17.01: alínea "d", from 01/10/2026 for the non-opting provider. */
  const consulting = {
    code: "consultoria",
    label: "Consultoria empresarial",
    cnae: "7020400",
    lc116Item: "17.01",
    cTribNac: "170101",
    nbs: "115011000",
  };
  const classified = (overrides: ProfileFields = {}): ProfileFields => ({
    activities: [
      { ...softwareLicense, ibsCbs: IBS_CBS },
      { ...consulting, ibsCbs: IBS_CBS },
    ],
    ...overrides,
  });
  const GROUP =
    /<IBSCBS><finNFSe>0<\/finNFSe><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS><\/trib><\/valores><\/IBSCBS><\/infDPS>/;
  /** The Sefin (tpAmb 2) gets the NT 009 shape: finNFSe left for infDPS, CST and cClassTrib in trib. */
  const SEFIN_GROUP =
    /<IBSCBS><cIndOp>100501<\/cIndOp><indDest>0<\/indDest><valores><trib><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/trib><\/valores><\/IBSCBS><\/infDPS>/;
  type Frozen = { ibsCbsGroup?: { required: boolean; ruleId: string }; dCompet: string };
  const frozenOf = (f: Fixture, id: string) =>
    f.t.run(async (ctx) => {
      const row = await ctx.db.get("issuances", id as Id<"issuances">);
      return JSON.parse(row!.snapshot) as Frozen;
    });
  /** Accepts, runs on the simulator and returns the DPS (checked against the XSD) and decision. */
  async function issued(f: Fixture, key: string, input: IssuanceInput) {
    const accepted = await request(f, key, input);
    await drive(f.t, accepted.issuance.operationId);
    const done = await view(f, accepted.issuance.id);
    expect(done.state).toBe("authorized");
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(validateDpsXml(dps!, done.target === "campinas-adn" ? undefined : PRODREST)).toEqual({
      valid: true,
    });
    return {
      target: done.target,
      dps: dps!,
      group: (await frozenOf(f, done.id)).ibsCbsGroup,
    };
  }
  const sequences = (f: Fixture) => f.t.run((ctx) => ctx.db.query("dpsSequences").collect());

  it('não optante na Sefin, alínea "d": o grupo segue o fato gerador (dCompet) desde 01/10/2026', async () => {
    const f = await fixture(platformTest(), { profile: classified() });
    // Issued on 01/10 for September: the taxable event is before the obligation.
    const september = await issued(
      f,
      "setembro",
      domestic({ activityCode: "consultoria", competence: "2026-09", issueDate: "2026-10-01" }),
    );
    expect(september.target).toBe("sefin-nacional");
    expect(september.dps).toContain("<dCompet>2026-09-30</dCompet>");
    expect(september.dps).not.toContain("<IBSCBS>");
    expect(september.group).toEqual({ required: false, ruleId: "ato4-iii-d" });
    const october = await issued(
      f,
      "outubro",
      domestic({ activityCode: "consultoria", competence: "2026-10", issueDate: "2026-10-01" }),
    );
    expect(october.dps).toContain("<dCompet>2026-10-01</dCompet>");
    expect(october.dps).toMatch(SEFIN_GROUP);
    expect(october.group).toEqual({ required: true, ruleId: "ato4-iii-d" });
    // Only the group: what is of the Campinas channel stays out of the Sefin.
    for (const piece of ["<cTribMun>", "<IM>", "<dest>"]) expect(october.dps).not.toContain(piece);
  });

  it('não optante na Sefin, alínea "b": o 1.05 leva o grupo só desde 01/12/2026', async () => {
    vi.setSystemTime(Date.UTC(2026, 11, 1, 15)); // 01/12/2026 12:00 in Brasília
    const f = await fixture(platformTest(), { profile: classified() });
    const before = await issued(f, "outubro", domestic({ issueDate: "2026-10-08" }));
    expect(before.dps).toContain("<dCompet>2026-10-08</dCompet>");
    expect(before.dps).not.toContain("<IBSCBS>");
    expect(before.group).toEqual({ required: false, ruleId: "ato4-iii-b" });
    const november = await issued(
      f,
      "novembro",
      domestic({ competence: "2026-11", issueDate: "2026-12-01" }),
    );
    expect(november.dps).toContain("<dCompet>2026-11-30</dCompet>");
    expect(november.dps).not.toContain("<IBSCBS>");
    const december = await issued(f, "dezembro", domestic({ competence: "2026-12" }));
    expect(december.dps).toContain("<dCompet>2026-12-01</dCompet>");
    expect(december.dps).toMatch(SEFIN_GROUP);
    expect(december.group).toEqual({ required: true, ruleId: "ato4-iii-b" });
  });

  it("recusa sem a classificação IBS/CBS só quando o grupo é obrigatório, antes de reservar número", async () => {
    const f = await fixture(platformTest(), {
      profile: { activities: [softwareLicense, consulting] },
    });
    await expect(
      request(f, "a", domestic({ activityCode: "consultoria", issueDate: "2026-10-01" })),
    ).rejects.toMatchObject({
      data: {
        code: "NFSE_ROUTE_PROFILE_INCOMPLETE",
        missing: ["ibsCbs"],
        message: expect.stringMatching(
          /fato gerador desde 01\/10\/2026.*classificação IBS\/CBS da atividade/,
        ),
      },
    });
    expect(await sequences(f)).toEqual([]);
    // Before the obligation, the same profile still issues, without the group.
    const september = domestic({
      activityCode: "consultoria",
      competence: "2026-09",
      issueDate: "2026-10-01",
    });
    expect((await request(f, "b", september)).issuance.target).toBe("sefin-nacional");
    expect((await request(f, "c", domestic())).issuance.target).toBe("sefin-nacional");
  });

  it("exportação com o grupo obrigatório é recusada com código próprio, sem reservar número", async () => {
    const refused = { data: { code: "ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED" } };
    const sefin = await fixture(platformTest(), { profile: classified() });
    await expect(
      request(sefin, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    // The Campinas channel of the non-opting provider too: its domestic classification would go.
    const campinas = await fixture(platformTest(), {
      profile: campinasProfile({
        activities: [{ ...consulting, cTribMun: "001", ibsCbs: IBS_CBS }],
      }),
    });
    await expect(
      request(campinas, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    // Without the classification the answer is the same: no profile change would make it issue.
    const bare = await fixture(platformTest(), {
      profile: { activities: [softwareLicense, consulting] },
    });
    await expect(
      request(bare, "a", exported({ activityCode: "consultoria" })),
    ).rejects.toMatchObject(refused);
    for (const f of [sefin, campinas, bare]) expect(await sequences(f)).toEqual([]);
    // Subitem 1.05 before 01/12: the export still goes, without the group.
    const licence = await issued(sefin, "b", exported());
    expect(licence.dps).not.toContain("<IBSCBS>");
    vi.setSystemTime(Date.UTC(2026, 11, 2, 15));
    const december = await fixture(platformTest(), { profile: classified() });
    await expect(
      request(december, "a", exported({ issueDate: "2026-12-01", competence: "2026-12" })),
    ).rejects.toMatchObject(refused);
  });

  it("Simples de Campinas exporta pela Sefin em 28/11/2026, sem o grupo; o Ato o alcança em 2027", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 28, 15)); // Saturday 28/11/2026 12:00 in Brasília
    const f = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const exportation = await issued(
      f,
      "exportacao",
      exported({ issueDate: "2026-11-28", competence: "2026-11" }),
    );
    expect(exportation.target).toBe("sefin-nacional");
    expect(exportation.dps).toContain("<tribISSQN>3</tribISSQN>");
    for (const piece of ["<IBSCBS>", "<cTribMun>", "<IM>"])
      expect(exportation.dps).not.toContain(piece);
    expect(exportation.group).toEqual({ required: false, ruleId: "ato4-simples" });
    // MEI is Simples too: the same answer for the last day of 2026.
    vi.setSystemTime(Date.UTC(2026, 11, 31, 15));
    const mei = await fixture(platformTest(), { profile: { opSimpNac: 2 } });
    const last = await issued(
      mei,
      "mei",
      exported({ issueDate: "2026-12-31", competence: "2026-12" }),
    );
    expect(last.group).toEqual({ required: false, ruleId: "ato4-simples" });
    // From 01/01/2027 the Simples has the group required (§ 1º): no export, and the profile
    // needs the classification for a domestic invoice.
    vi.setSystemTime(Date.UTC(2027, 0, 4, 15));
    const mei2027 = await fixture(platformTest(), { profile: { opSimpNac: 2 } });
    await expect(
      request(mei2027, "a", exported({ issueDate: "2027-01-04", competence: "2027-01" })),
    ).rejects.toMatchObject({ data: { code: "ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED" } });
    await expect(
      request(mei2027, "b", domestic({ competence: "2027-01", issRate: undefined })),
    ).rejects.toMatchObject({
      data: { code: "NFSE_ROUTE_PROFILE_INCOMPLETE", missing: ["ibsCbs"] },
    });
    const simples2027 = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const domestic2027 = await issued(
      simples2027,
      "nacional-2027",
      domestic({ competence: "2027-01", issRate: undefined }),
    );
    expect(domestic2027.dps).toMatch(SEFIN_GROUP);
    expect(domestic2027.group).toEqual({ required: true, ruleId: "ato4-simples" });
  });

  it("no canal de Campinas o grupo vai antes do Ato, pelo validador da IMA, e a decisão é congelada", async () => {
    const f = await fixture(platformTest(), {
      profile: campinasProfile({
        activities: [
          { ...softwareLicense, cTribMun: "001", ibsCbs: IBS_CBS },
          { ...consulting, cTribMun: "001", ibsCbs: IBS_CBS },
        ],
      }),
    });
    const licence = await issued(f, "a", domestic({ taker: campinasTaker, issRate: "2" }));
    expect(licence.target).toBe("campinas-adn");
    expect(licence.dps).toMatch(GROUP);
    expect(licence.group).toEqual({ required: true, ruleId: "campinas-ima" });
    const consultancy = await issued(
      f,
      "b",
      domestic({ activityCode: "consultoria", taker: campinasTaker, issRate: "2" }),
    );
    expect(consultancy.group).toEqual({ required: true, ruleId: "ato4-iii-d" });
    // The Simples in October (C5) exports through the IMA as before: the group goes with the
    // activity's classification, the case of the E0187 of 09/10 (ISSUANCE.md, #336).
    const simples = await fixture(platformTest(), {
      profile: campinasProfile({ opSimpNac: 3, regApTribSN: 1 }),
    });
    const exportation = await issued(simples, "c", exported());
    expect(exportation.target).toBe("campinas-adn");
    expect(exportation.dps).toMatch(GROUP);
    expect(exportation.group).toEqual({ required: true, ruleId: "campinas-ima" });
  });

  it("snapshot congelado sem a decisão (antes da #338) monta a DPS como na época", async () => {
    const forget = (f: Fixture, id: string) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.get("issuances", id as Id<"issuances">))!;
        const { ibsCbsGroup: _decision, ...old } = JSON.parse(row.snapshot) as Frozen;
        await ctx.db.patch("issuances", row._id, { snapshot: JSON.stringify(old) });
      });
    // Sefin: the old rule had no group, even where the Ato now requires it.
    const sefin = await fixture(platformTest(), { profile: classified() });
    const october = await request(sefin, "a", domestic({ activityCode: "consultoria" }));
    expect((await frozenOf(sefin, october.issuance.id)).ibsCbsGroup?.required).toBe(true);
    await forget(sefin, october.issuance.id);
    await drive(sefin.t, october.issuance.operationId);
    const [old] = await xmlOf(sefin.t, october.issuance.id as Id<"issuances">, "dps");
    expect(old).not.toContain("<IBSCBS>");
    expect(validateDpsXml(old!, PRODREST)).toEqual({ valid: true });
    // Campinas: the old rule already sent it.
    const campinas = await fixture(platformTest(), { profile: campinasProfile() });
    const ima = await request(campinas, "a", domestic({ taker: campinasTaker, issRate: "2" }));
    await forget(campinas, ima.issuance.id);
    await drive(campinas.t, ima.issuance.operationId);
    const [kept] = await xmlOf(campinas.t, ima.issuance.id as Id<"issuances">, "dps");
    expect(kept).toMatch(GROUP);
  });
});

describe("endereço do tomador no exterior", () => {
  const foreignTaker = () =>
    exported().taker as Extract<IssuanceInput["taker"], { kind: "foreign" }>;
  it("exige código postal, estado, logradouro, número e bairro, com o campo do erro", async () => {
    const f = await fixture();
    for (const field of ["postalCode", "state", "street", "number", "district"] as const) {
      for (const value of [undefined, "", "   "]) {
        const taker = foreignTaker();
        const address = { ...taker.address, [field]: value };
        await expect(
          request(f, crypto.randomUUID(), exported({ taker: { ...taker, address } })),
        ).rejects.toMatchObject({
          data: { code: "ISSUANCE_FIELD_INVALID", field: `taker.address.${field}` },
        });
      }
    }
    expect(await f.t.run((ctx) => ctx.db.query("issuances").collect())).toEqual([]);
  });

  it("aplica os tamanhos do XSD e aceita N/A no bairro", async () => {
    const f = await fixture();
    const limits = { postalCode: 11, city: 60, state: 60, street: 255, number: 60, district: 60 };
    for (const [field, max] of Object.entries(limits)) {
      const taker = foreignTaker();
      const long = { ...taker, address: { ...taker.address, [field]: "a".repeat(max + 1) } };
      await expect(
        request(f, crypto.randomUUID(), exported({ taker: long })),
      ).rejects.toMatchObject({
        data: { code: "ISSUANCE_FIELD_INVALID", field: `taker.address.${field}` },
      });
    }
    const taker = foreignTaker();
    const na = { ...taker, address: { ...taker.address, district: "N/A" } };
    const accepted = await request(f, "na", exported({ taker: na }));
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
  });
});

describe("e-mail do prestador e número inicial", () => {
  it("usa o e-mail do perfil quando o pedido não traz um, e o do pedido quando traz", async () => {
    const f = await fixture(platformTest(), {
      profile: { issuerEmail: "perfil@prestador.example" },
    });
    const { issuerEmail: _email, ...withoutEmail } = domestic();
    const fromProfile = await request(f, "sem-email", withoutEmail);
    const fromRequest = await request(f, "com-email", domestic());
    await drive(f.t, fromProfile.issuance.operationId);
    await drive(f.t, fromRequest.issuance.operationId);
    const [a] = await xmlOf(f.t, fromProfile.issuance.id as Id<"issuances">, "dps");
    const [b] = await xmlOf(f.t, fromRequest.issuance.id as Id<"issuances">, "dps");
    expect(a).toContain("<email>perfil@prestador.example</email>");
    expect(b).toContain("<email>fiscal@prestador.example</email>");
    const none = await fixture();
    expect(await code(request(none, "x", withoutEmail))).toBe("ISSUANCE_ISSUER_EMAIL_REQUIRED");
  });

  it("a primeira emissão usa o número inicial configurado e trava a configuração", async () => {
    const f = await fixture();
    const owner = f.owner;
    const target = { organizationId: f.where.organizationId, companyId: f.where.companyId };
    await owner.mutation(api.nfseProfiles.setDpsStart, {
      ...target,
      environment: "sandbox",
      series: "1",
      start: 1201,
    });
    const first = await request(f, "inicio-1", domestic());
    const second = await request(f, "inicio-2", domestic());
    expect([first.issuance.number, second.issuance.number]).toEqual([1201, 1202]);
    expect(first.issuance.dpsId.endsWith("1201".padStart(15, "0"))).toBe(true);
    expect(
      await code(
        owner.mutation(api.nfseProfiles.setDpsStart, {
          ...target,
          environment: "sandbox",
          series: "1",
          start: 1,
        }),
      ),
    ).toBe("DPS_START_LOCKED");
  });
});

describe("idempotência e numeração", () => {
  it("a mesma chave devolve o mesmo efeito, antes e depois da autorização", async () => {
    const f = await fixture();
    const first = await request(f, "same", domestic());
    const again = await request(
      f,
      "same",
      domestic({ description: "  Licença de uso de software,  outubro de 2026 " }),
    );
    expect(again).toMatchObject({ reused: true, issuance: { id: first.issuance.id, number: 1 } });
    await drive(f.t, first.issuance.operationId);
    // A later profile change does not reopen an accepted request.
    await f.t.run(async (ctx) => {
      const profile = (await ctx.db.query("nfseProfiles").first())!;
      await ctx.db.patch("nfseProfiles", profile._id, { activities: [] });
    });
    expect(await request(f, "same", domestic())).toMatchObject({
      reused: true,
      issuance: { id: first.issuance.id, state: "authorized" },
    });
    expect(
      await code(request(f, "same", domestic({ amount: { currency: "BRL", value: "999" } }))),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const counts = await f.t.run(async (ctx) => ({
      issuances: (await ctx.db.query("issuances").collect()).length,
      sequence: (await ctx.db.query("dpsSequences").first())?.last,
    }));
    expect(counts).toEqual({ issuances: 1, sequence: 1 });
  });

  it("pedidos concorrentes recebem números distintos e sequenciais", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(f, `concorrente-${i}`, domestic())),
    );
    const numbers = results.map((r) => r.issuance.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(results.map((r) => r.issuance.dpsId)).size).toBe(6);
    expect((await f.t.run((ctx) => ctx.db.query("dpsSequences").first()))?.last).toBe(6);
  });

  it("rejeição definitiva consome o número sem reutilizá-lo", async () => {
    const f = await fixture();
    const rejected = await request(
      f,
      "rejeitar",
      domestic({ description: "Teste [simular:rejeicao]" }),
    );
    const op = await drive(f.t, rejected.issuance.operationId);
    expect(op).toMatchObject({ state: "failed", code: "ADN_REJECTED" });
    const done = await view(f, rejected.issuance.id);
    expect(done).toMatchObject({ state: "rejected", code: "ADN_REJECTED", number: 1 });
    expect(done.rejections[0]).toMatchObject({ code: "SIM100" });
    expect(done.accessKey).toBeNull();
    const next = await request(f, "depois", domestic());
    expect(next.issuance.number).toBe(2);
    expect(await code(cancel(f, "c", rejected.issuance.id, "Cancelamento de nota rejeitada"))).toBe(
      "ISSUANCE_NOT_CANCELLABLE",
    );
  });
});

describe("limite de XML da emissão", () => {
  afterEach(() => vi.restoreAllMocks());
  // Multibyte text proves that the limit measures UTF-8 bytes, not string length.
  const oversized = () => "é".repeat(MAX_XML_BYTES / 2 + 1);

  it("rejeita DPS local acima do teto sem envio nem nova tentativa", async () => {
    const f = await fixture();
    const build = fiscalBuild.buildDps;
    vi.spyOn(fiscalBuild, "buildDps").mockImplementation((input) => ({
      ...build(input),
      xml: oversized(),
    }));
    const accepted = await request(f, "dps-grande", domestic());
    const operationId = accepted.issuance.operationId;
    expect(await drive(f.t, operationId, 2)).toMatchObject({
      state: "failed",
      code: "NFSE_XML_LIMIT",
      uncertain: false,
    });
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "rejected",
      code: "NFSE_XML_LIMIT",
      artifacts: [],
    });
    expect(await simulation(f.t, accepted.issuance.dpsId)).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("operationAttempts").collect())).toHaveLength(1);
  });

  it("rejeita pedido local de cancelamento acima do teto e preserva a nota", async () => {
    const f = await fixture();
    const accepted = await request(f, "nota", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const build = fiscalEvents.buildCancelEvent;
    vi.spyOn(fiscalEvents, "buildCancelEvent").mockImplementation((input) => ({
      ...build(input),
      xml: oversized(),
    }));
    const submit = vi.spyOn(nacional, "submitCancelEvent");
    const requested = await cancel(
      f,
      "cancelar",
      accepted.issuance.id,
      "Erro na emissão sintética",
    );
    expect(await drive(f.t, requested.issuance.cancellation!.operationId, 2)).toMatchObject({
      state: "failed",
      code: "NFSE_XML_LIMIT",
      uncertain: false,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "authorized",
      cancellation: { state: "rejected", code: "NFSE_XML_LIMIT" },
    });
    expect(await xmlOf(f.t, accepted.issuance.id, "cancel-request")).toEqual([]);
  });

  it("resposta autorizada acima do teto fica incerta e é recuperada sem reenviar DPS", async () => {
    const f = await fixture();
    const submit = nacional.submitDps.bind(nacional);
    const sent = vi.spyOn(nacional, "submitDps").mockImplementationOnce(async (...args) => {
      const result = await submit(...args);
      return result.kind === "success" ? { ...result, nfseXml: oversized() } : result;
    });
    const accepted = await request(f, "resposta-grande", domestic());
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "NFSE_XML_LIMIT",
      uncertain: true,
    });
    expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    expect(await xmlOf(f.t, accepted.issuance.id, "dps")).toHaveLength(1);
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "authorized" });
  });

  it("evento recebido acima do teto reconcilia o cancelamento com o pedido preservado", async () => {
    const f = await fixture();
    const accepted = await request(f, "nota", domestic());
    await drive(f.t, accepted.issuance.operationId);
    const submit = nacional.submitCancelEvent.bind(nacional);
    vi.spyOn(nacional, "submitCancelEvent").mockImplementationOnce(async (...args) => {
      const result = await submit(...args);
      return result.kind === "success" ? { ...result, eventXml: oversized() } : result;
    });
    const requested = await cancel(
      f,
      "cancelar",
      accepted.issuance.id,
      "Erro na emissão sintética",
    );
    const operationId = requested.issuance.cancellation!.operationId;
    expect(await drive(f.t, operationId)).toMatchObject({
      state: "reconciling",
      code: "NFSE_XML_LIMIT",
      uncertain: true,
    });
    const before = await xmlOf(f.t, accepted.issuance.id, "cancel-request");
    expect(before).toHaveLength(1);
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    expect(await xmlOf(f.t, accepted.issuance.id, "cancel-request")).toEqual(before);
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "cancelled" });
  });
});

describe("desfechos incertos e reconciliação", () => {
  it("indisponibilidade transitória volta a tentar, consultando antes de reenviar", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "503",
      domestic({ description: "Teste [simular:indisponivel]" }),
    );
    const first = await drive(f.t, accepted.issuance.operationId);
    expect(first).toMatchObject({ state: "retry_wait", code: "ADN_UNAVAILABLE", uncertain: false });
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
  });

  it("timeout com nota autorizada: a reconciliação encontra a NFS-e sem reenviar", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "timeout",
      domestic({ description: "Teste [simular:timeout]" }),
    );
    const lost = await drive(f.t, accepted.issuance.operationId);
    expect(lost).toMatchObject({
      state: "reconciling",
      uncertain: true,
      code: "TRANSPORT_UNCERTAIN",
    });
    expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    const recovered = await f.t.run((ctx) => ctx.db.get("issuances", accepted.issuance.id));
    expect(recovered).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
      submissions: 1,
    });
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(1);
    const attempts = await f.t.run((ctx) =>
      ctx.db
        .query("operationAttempts")
        .withIndex("by_operationId_and_generation_and_fence", (q) =>
          q.eq("operationId", accepted.issuance.operationId),
        )
        .collect(),
    );
    expect(attempts.map((a) => a.mode)).toEqual(["execute", "reconcile"]);
  });

  it("timeout sem nota: a consulta confirma ausência e reenvia o mesmo XML e nDPS", async () => {
    const f = await fixture();
    const accepted = await request(f, "perda", domestic({ description: "Teste [simular:perda]" }));
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("reconciling");
    const before = await xmlOf(f.t, accepted.issuance.id, "dps");
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
    const done = await view(f, accepted.issuance.id);
    expect(done).toMatchObject({ state: "authorized", number: 1 });
    expect(await xmlOf(f.t, accepted.issuance.id, "dps")).toEqual(before);
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
    expect((await f.t.run((ctx) => ctx.db.get("issuances", done.id)))?.submissions).toBe(2);
  });

  it("retomada manual de emissão incerta com tentativas esgotadas reconcilia sem reenviar (#197)", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "presa",
      domestic({ description: "Teste [simular:timeout]" }),
    );
    const operationId = accepted.issuance.operationId;
    expect((await drive(f.t, operationId)).state).toBe("reconciling");
    // The state observed on #197: every attempt spent, paused while uncertain.
    await f.t.run((ctx) =>
      ctx.db.patch("operations", operationId, {
        state: "paused",
        stage: "calling",
        code: "RECONCILIATION_REQUIRED",
        generation: 9,
        attempts: 6,
        maxAttempts: 6,
        recoveryAttempts: 5,
        uncertain: true,
        leaseUntil: 0,
        recoveryAt: undefined,
        workId: undefined,
      }),
    );
    const retry = (actor: typeof f.owner) =>
      actor.mutation(api.operations.control, {
        operationId,
        action: "retry",
        expectedGeneration: 9,
      });
    const viewer = await person(f.t, f.scope.organizationId, "viewer", {
      companyId: f.scope.companyId,
    });
    expect(await code(retry(viewer))).toBe("SCOPE_DENIED");
    const other = await fixture(f.t);
    expect(await code(retry(other.owner))).toBe("ACCESS_DENIED");
    expect((await f.t.run((ctx) => ctx.db.get("operations", operationId)))?.state).toBe("paused");
    await retry(f.owner);
    expect(await f.t.run((ctx) => ctx.db.get("operations", operationId))).toMatchObject({
      state: "reconciling",
      code: "MANUAL_RECONCILE",
      attempts: 6,
      maxAttempts: 7,
    });
    const done = await drive(f.t, operationId);
    expect(done).toMatchObject({ state: "succeeded", attempts: 7 });
    expect(await f.t.run((ctx) => ctx.db.get("issuances", accepted.issuance.id))).toMatchObject({
      state: "authorized",
      recoveredByConsult: true,
      submissions: 1,
    });
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(1);
    const attempts = await f.t.run((ctx) =>
      ctx.db
        .query("operationAttempts")
        .withIndex("by_operationId_and_generation_and_fence", (q) =>
          q.eq("operationId", operationId),
        )
        .collect(),
    );
    expect(attempts.map((a) => a.mode)).toEqual(["execute", "reconcile"]);
  });

  it("DPS duplicada no reenvio é incerta e se resolve pela consulta, nunca por rejeição", async () => {
    const f = await fixture();
    const accepted = await request(
      f,
      "dup",
      domestic({ description: "Teste [simular:duplicada]" }),
    );
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("reconciling");
    const second = await drive(f.t, accepted.issuance.operationId);
    expect(second).toMatchObject({ state: "reconciling", code: "DPS_ALREADY_EXISTS" });
    const done = await drive(f.t, accepted.issuance.operationId);
    expect(done.state).toBe("succeeded");
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect((await simulation(f.t, accepted.issuance.dpsId))?.posts).toBe(2);
  });
});

describe("cancelamento", () => {
  async function authorized(f: Fixture, key = "base") {
    const accepted = await request(f, key, domestic());
    await drive(f.t, accepted.issuance.operationId);
    return accepted.issuance.id;
  }

  it("cancela, preserva pedido e evento, e um pedido repetido não cria outro efeito", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const reason = "Serviço faturado em duplicidade";
    const requested = await cancel(f, "cancelar", id, reason);
    expect(requested).toMatchObject({
      reused: false,
      issuance: { state: "authorized", cancellation: { state: "processing", sequence: 1 } },
    });
    const op = await drive(f.t, requested.issuance.cancellation!.operationId);
    expect(op.state).toBe("succeeded");
    const done = await view(f, id);
    expect(done).toMatchObject({
      state: "cancelled",
      cancellation: { state: "registered", alreadyRegistered: false },
    });
    const [event] = await xmlOf(f.t, id, "cancel-request");
    expect(event).toContain(`Id="PRE${done.accessKey}101101"`);
    // The official XSD has no nPedRegEvento; the sequence stays internal.
    expect(event).not.toContain("nPedRegEvento");
    expect(event).toContain(`<verAplic>${VER_APLIC}</verAplic>`);
    expect(validatePedRegEventoXml(event!)).toEqual({ valid: true });
    expect(await xmlOf(f.t, id, "cancel-event")).toHaveLength(1);
    expect(await cancel(f, "cancelar", id, reason)).toMatchObject({ reused: true });
    expect(await cancel(f, "outra-chave", id, "Outro motivo qualquer de teste")).toMatchObject({
      reused: true,
      issuance: { state: "cancelled" },
    });
    expect((await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect())).length).toBe(
      1,
    );
  });

  it("cancelamento rejeitado mantém a nota autorizada e o próximo usa o pedido seguinte", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const rejected = await cancel(f, "c1", id, "Pedido sintético [simular:rejeicao]");
    const op = await drive(f.t, rejected.issuance.cancellation!.operationId);
    expect(op).toMatchObject({ state: "failed", code: "ADN_REJECTED" });
    const after = await view(f, id);
    expect(after).toMatchObject({
      state: "authorized",
      cancellation: { state: "rejected", code: "ADN_REJECTED" },
    });
    expect(after.cancellation?.rejections[0]?.code).toBe("SIM200");
    const retry = await cancel(f, "c2", id, "Erro na emissão da nota sintética");
    expect(retry.issuance.cancellation?.sequence).toBe(2);
    await drive(f.t, retry.issuance.cancellation!.operationId);
    expect((await view(f, id)).state).toBe("cancelled");
  });

  it("timeout no cancelamento reenvia o mesmo pedido e aceita 'evento já registrado'", async () => {
    const f = await fixture();
    const id = await authorized(f);
    const requested = await cancel(f, "c", id, "Pedido sintético [simular:timeout]");
    const operationId = requested.issuance.cancellation!.operationId;
    expect((await drive(f.t, operationId)).state).toBe("reconciling");
    expect((await drive(f.t, operationId)).state).toBe("succeeded");
    expect(await view(f, id)).toMatchObject({
      state: "cancelled",
      cancellation: { alreadyRegistered: true },
    });
    expect(await xmlOf(f.t, id, "cancel-request")).toHaveLength(1);
  });
});

describe("acesso, isolamento e gates", () => {
  it("isola organizações e empresas, recusa papéis sem escrita e mantém a concessão das API keys", async () => {
    const f = await fixture();
    const accepted = await request(f, "isolada", domestic());
    const other = await fixture(f.t);
    const ask = (client: Fixture["owner"], where: Fixture["where"], key: string) =>
      client.mutation(internal.issuance.request, {
        ...where,
        idempotencyKey: key,
        input: domestic(),
      });
    // Another organization's owner cannot use this company nor read this issuance.
    expect(await code(ask(other.owner, f.where, "x"))).not.toBe("OK");
    expect(
      await code(
        other.owner.query(internal.issuance.get, {
          ...other.where,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).toBe("NOT_FOUND");
    // With a project selector, the row still proves its own project.
    expect(
      await code(
        f.owner.query(internal.issuance.get, { ...f.keyWhere, issuanceId: accepted.issuance.id }),
      ),
    ).toBe("NOT_FOUND");
    // Another company of the same organization.
    expect(
      await code(
        f.owner.query(internal.issuance.get, {
          ...f.where,
          companyId: other.where.companyId,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).not.toBe("OK");
    // People need no project grant: company access and a writing role.
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, { scopes: ["documents:import"] });
    });
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(viewer, f.where, "v"))).toBe("SCOPE_DENIED");
    expect(
      (await viewer.query(internal.issuance.get, { ...f.where, issuanceId: accepted.issuance.id }))
        .id,
    ).toBe(accepted.issuance.id);
    const developer = await person(f.t, f.where.organizationId, "developer", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(developer, f.where, "d"))).toBe("SCOPE_DENIED");
    const operator = await person(f.t, f.where.organizationId, "operator", {
      companyId: f.where.companyId,
    });
    expect(await code(ask(operator, f.where, "o"))).toBe("OK");
    // A member without access to the company is not told it exists.
    const outsider = await person(f.t, f.where.organizationId, "operator");
    expect(await code(ask(outsider, f.where, "fora"))).toBe("NOT_FOUND");
    // A person never reserves under an integration project, even with its grant.
    expect(await code(ask(f.owner, f.keyWhere, "integracao"))).toBe("NOT_FOUND");
    // An API key still needs `documents:issue` in the key and in its project's grant.
    const byKey = (key: string) =>
      f.t.mutation(internal.issuance.request, {
        ...f.keyWhere,
        keyHash: f.keyHash,
        idempotencyKey: key,
        input: domestic(),
      });
    expect(await code(byKey("k-sem-concessao"))).toBe("NOT_FOUND");
    await f.t.run(async (ctx) => {
      const grant = (await ctx.db
        .query("projectCompanies")
        .withIndex("by_projectId_and_companyId", (q) =>
          q.eq("projectId", f.scope.projectId).eq("companyId", f.where.companyId),
        )
        .unique())!;
      await ctx.db.patch("projectCompanies", grant._id, {
        scopes: ["documents:import", "documents:issue", "documents:cancel"],
      });
      await ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:cancel"] });
    });
    expect(await code(byKey("k"))).toBe("SCOPE_DENIED");
    await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:issue"] }));
    expect(await code(byKey("k"))).toBe("OK");
    // The key's listing shows its project's issuances only; the console's are not there.
    const byKeyList = await f.t.query(internal.issuance.list, {
      ...f.keyWhere,
      keyHash: f.keyHash,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(byKeyList.page.map((row) => row.id)).not.toContain(accepted.issuance.id);
    // A key never reaches the console project.
    expect(
      await code(
        f.t.query(internal.issuance.get, {
          ...f.where,
          keyHash: f.keyHash,
          issuanceId: accepted.issuance.id,
        }),
      ),
    ).not.toBe("OK");
    // Without a session nothing is accepted.
    expect(
      await code(
        f.t.mutation(internal.issuance.request, {
          ...f.where,
          idempotencyKey: "n",
          input: domestic(),
        }),
      ),
    ).not.toBe("OK");
  });

  it("o gate de produção só é avaliado depois do acesso e não vaza o seu estado", async () => {
    const f = await fixture();
    const other = await fixture(f.t);
    const viewer = await person(f.t, f.where.organizationId, "viewer", {
      companyId: f.where.companyId,
    });
    const production = { ...f.where, environment: "production" as const };
    const ask = (client: Fixture["owner"], key: string) =>
      client.mutation(internal.issuance.request, {
        ...production,
        idempotencyKey: key,
        input: domestic(),
      });
    const askCancel = (client: Fixture["owner"], key: string) =>
      client.mutation(internal.issuance.cancel, {
        ...production,
        idempotencyKey: key,
        issuanceId: "inexistente",
        reasonCode: "1",
        reason: "Cancelamento sintético do gate de produção",
      });
    const answers = async (round: string) => ({
      owner: [await code(ask(f.owner, round)), await code(askCancel(f.owner, round))],
      viewer: [await code(ask(viewer, round)), await code(askCancel(viewer, round))],
      otherOrganization: [
        await code(ask(other.owner, round)),
        await code(askCancel(other.owner, round)),
      ],
    });
    const closed = await answers("fechado");
    // The sandbox deployment never changes the gate, from the workflow or otherwise.
    expect(
      await code(
        f.t.mutation(internal.issuance.setProductionGate, {
          organizationId: f.where.organizationId,
          companyId: f.where.companyId,
          kind: "enable",
          operator: "operador-freecorps",
          approver: "aprovador-freecorps",
          runId: "123",
          runAttempt: 1,
          reason: "Prova sintética do gate de produção",
        }),
      ),
    ).toBe("ISSUANCE_GATE_DEPLOYMENT_DENIED");
    // A gate row left open (e.g. by a restore) changes nothing here.
    await f.t.run((ctx) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.where.organizationId,
        companyId: f.where.companyId,
        production: true,
        actor: "operador-freecorps",
        reason: "Linha sintética de gate aberto",
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    const open = await answers("aberto");
    // Every deployment is sandbox: access refuses `production` before the gate, open or closed.
    expect(closed).toEqual({
      owner: ["NOT_FOUND", "NOT_FOUND"],
      viewer: ["NOT_FOUND", "NOT_FOUND"],
      otherOrganization: ["ACCESS_DENIED", "ACCESS_DENIED"],
    });
    expect(open).toEqual(closed);
    const state = await f.t.run(async (ctx) => ({
      events: await ctx.db.query("issuanceGateEvents").collect(),
      audit: (await ctx.db.query("operationalAudit").collect()).map((a) => a.action),
    }));
    expect(state.events).toEqual([]);
    expect(state.audit).not.toContain("issuance.production_enabled");
    expect(await code(request(f, "sandbox-segue", domestic()))).toBe("OK");
  });
});

// Phase 3: real transport to the restricted production. The certificate is synthetic, made in
// memory, and every call to the network is replaced: nothing here reaches a tax authority.

const KEYRING = { active: "k1", keys: { k1: "ab".repeat(32) } };

/** Active synthetic A1 of the company, sealed in the vault envelope like an upload. */
async function installCertificate(f: Fixture) {
  vi.stubEnv("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(KEYRING));
  const material = syntheticCertificate({ cnpj: ISSUER_CNPJ });
  return f.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").first())!;
    const now = Date.now();
    const id = await ctx.db.insert("certificates", {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic",
      membershipId: membership._id,
      membershipVersion: 1,
      metadata: {
        fingerprint: "c".repeat(64),
        subject: "Synthetic certificate, no fiscal validity",
        cnpj: ISSUER_CNPJ,
        notBefore: now - 86400_000,
        notAfter: now + 86400_000,
      },
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope = encryptCertificate(
      KEYRING,
      { organizationId: f.where.organizationId, companyId: f.where.companyId, id, version: 1 },
      material.pfx,
      material.password,
    );
    await ctx.db.patch("certificates", id, { envelope });
    await ctx.db.insert("certificateHeads", {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      nextVersion: 2,
      latestId: id,
      activeId: id,
    });
    return id;
  });
}
function openRestricted(...companies: string[]) {
  vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
  vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", companies.join(","));
}
async function certificateUses(f: Fixture) {
  const rows = await f.t.run((ctx) => ctx.db.query("certificateAudit").collect());
  return rows.map((row) => `${row.action}:${row.result}`);
}
async function claimOperation(t: T, operationId: Id<"operations">) {
  const op = (await t.run((ctx) => ctx.db.get("operations", operationId)))!;
  vi.setSystemTime(Math.max(Date.now(), op.nextAttemptAt));
  const claimed = (await t.mutation(internal.operations.claim, {
    operationId,
    generation: op.generation,
  }))!;
  const token = { operationId, generation: claimed.generation, fence: claimed.fence! };
  await t.mutation(internal.operations.beginEffect, token);
  return token;
}
/** Records each mTLS request instead of opening a socket; by default the authority is down. */
function fakeAuthority() {
  return vi
    .spyOn(certificateTransport, "certificateRequest")
    .mockImplementation(async () => ({ status: 503, body: Buffer.from("") }));
}

describe("produção restrita (fase 3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("só sai do simulador com a variável e a empresa na lista; produção nunca é restrita", () => {
    const company = "jd7abc" as Id<"companies">;
    const sandbox = { environment: "sandbox" as const, companyId: company };
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "outra1, jd7abc");
    expect([...restrictedCompanies()]).toEqual(["outra1", "jd7abc"]);
    expect(transportModeFor(sandbox)).toBe("producao-restrita");
    expect(transportModeFor({ ...sandbox, companyId: "outra2" as Id<"companies"> })).toBe(
      "simulated",
    );
    // A malformed list fails closed for everyone.
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "jd7abc,../x");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", company);
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao");
    expect(transportModeFor(sandbox)).toBe("simulated");
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "producao-restrita");
    vi.stubEnv("PRODUCT_ENV", "production");
    expect(restrictedTransportAllowed(company)).toBe(false);
    expect(transportModeFor({ environment: "production", companyId: company })).toBe("producao");
  });

  it("a variável sozinha não tira do simulador as empresas fora da lista", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted("outraempresa");
    const authority = fakeAuthority();
    const accepted = await request(f, "fora-da-lista", domestic());
    expect(accepted.issuance.transport).toBe("simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    expect(authority).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual([]);
  });

  it("emite pela Sefin de produção restrita com o A1 do cofre, assinado e só para a origem do alvo", async () => {
    const f = await fixture();
    const certificateId = await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "restrita-sefin", domestic());
    expect(accepted.issuance).toMatchObject({
      transport: "producao-restrita",
      target: "sefin-nacional",
    });
    const op = await f.t.run((ctx) => ctx.db.get("operations", accepted.issuance.operationId));
    expect(op?.certificate).toEqual({ id: certificateId, version: 1 });
    expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("retry_wait");
    expect(authority).toHaveBeenCalledTimes(1);
    const [target] = authority.mock.calls[0]!;
    expect(target.url).toBe("https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse");
    expect(target.allowedOrigins).toEqual(["https://sefin.producaorestrita.nfse.gov.br"]);
    expect(JSON.parse(target.body!)).toHaveProperty("dpsXmlGZipB64");
    const done = await view(f, accepted.issuance.id);
    expect(done.artifacts.find((a) => a.kind === "dps")?.signed).toBe(true);
    const [dps] = await xmlOf(f.t, done.id, "dps");
    expect(dps).toContain("<tpAmb>2</tpAmb>");
    expect(dps).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
    // Its own audited purpose: the capture proof budget (`transport`) is never spent.
    expect(await certificateUses(f)).toEqual([
      "nfse-transport:authorized",
      "nfse-transport:success",
    ]);
  });

  it("Campinas vai à homologação da IMA, com RSA-SHA1", async () => {
    const f = await fixture(platformTest(), { profile: campinasProfile() });
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(
      f,
      "restrita-ima",
      domestic({ taker: campinasTaker, issRate: "2" }),
    );
    expect(accepted.issuance).toMatchObject({
      transport: "producao-restrita",
      target: "campinas-adn",
    });
    await drive(f.t, accepted.issuance.operationId);
    const [target] = authority.mock.calls[0]!;
    expect(target.url).toBe("https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse");
    expect(target.allowedOrigins).toEqual(["https://preprod-nfseapi.ima.sp.gov.br"]);
    const [dps] = await xmlOf(f.t, accepted.issuance.id as Id<"issuances">, "dps");
    expect(dps).toContain("http://www.w3.org/2000/09/xmldsig#rsa-sha1");
  });

  /**
   * Phase 3 criterion (#197) from 01/11/2026: the Simples provider in Campinas exports through
   * the Sefin Nacional (rule C6). The restricted Sefin is simulated here; the real proof is the
   * runbook in docs/operacao/emissao-nfse.md, section 8. Foreign taker identified by NIF or by
   * cNaoNIF 1 or 2 (E0226 forbids 0).
   */
  describe("exportação de Simples de Campinas na Sefin restrita (C6)", () => {
    const SEFIN = "https://sefin.producaorestrita.nfse.gov.br/SefinNacional";
    const KEY = `3509502${"4".repeat(43)}`;
    const json = (status: number, body: unknown) => ({
      status,
      body: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
    });
    const simplesCampinas = () =>
      campinasProfile({ opSimpNac: 3, regApTribSN: 1, municipalRegistration: "1234567" });
    const base = exported().taker as Extract<IssuanceInput["taker"], { kind: "foreign" }>;
    const { nif: _nif, ...withoutNif } = base;
    const takers = {
      NIF: base,
      "cNaoNIF-1": { ...withoutNif, nifAbsence: 1 as const },
      "cNaoNIF-2": { ...withoutNif, nifAbsence: 2 as const },
    };
    /**
     * Olinda answers only for Friday 30/10/2026: 31/10 and 01/11 are a weekend and 02/11 is a
     * holiday (Finados), so an issue on 01/11 to 03/11 freezes the 30/10 bulletin.
     */
    function ptaxOnlyOn30October() {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        return Response.json(
          url.includes("'10-30-2026'")
            ? { value: [{ cotacaoVenda: 5.4321, tipoBoletim: "Fechamento" }] }
            : { value: [] },
        );
      });
    }

    it("a meia-noite de 01/11 em Brasília separa a IMA (C5) da Sefin (C6)", async () => {
      vi.setSystemTime(Date.parse("2026-11-01T02:59:59Z")); // 31/10 23:59:59 in Brasília
      const f = await fixture(platformTest(), { profile: simplesCampinas() });
      const before = await request(f, "c6-antes", exported({ issueDate: undefined }));
      expect(before.issuance).toMatchObject({ target: "campinas-adn", issueDate: "2026-10-31" });
      vi.setSystemTime(Date.parse("2026-11-01T03:00:00Z")); // 01/11 00:00:00 in Brasília
      const after = await request(
        f,
        "c6-depois",
        exported({ issueDate: undefined, competence: "2026-11" }),
      );
      expect(after.issuance).toMatchObject({ target: "sefin-nacional", issueDate: "2026-11-01" });
    });

    it("recusa alíquota na exportação do Simples sem retenção antes de reservar número", async () => {
      vi.setSystemTime(Date.UTC(2026, 10, 3, 15));
      const f = await fixture(platformTest(), { profile: simplesCampinas() });
      const input = exported({ issueDate: "2026-11-03", competence: "2026-11", issRate: "2" });
      expect(await code(request(f, "c6-aliquota", input))).toBe("ISSUANCE_ISS_NOT_LEVIED");
      expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toEqual([]);
    });

    // Tuesday 03/11 with each identification, and Sunday 01/11 (the first C6 day).
    const cases = [
      ...Object.entries(takers).map(([name, taker]) => ({ name, taker, day: 3 })),
      { name: "cNaoNIF-2-em-01-11", taker: takers["cNaoNIF-2"], day: 1 },
    ];
    // Olinda is asked from the day before the issue back to Friday 30/10.
    const lookback: Record<number, string[]> = {
      1: ["10-31-2026", "10-30-2026"],
      3: ["11-02-2026", "11-01-2026", "10-31-2026", "10-30-2026"],
    };

    for (const { name, taker, day } of cases)
      it(`tomador com ${name}: autoriza e cancela na Sefin restrita, sem IM, alíquota nem IBSCBS`, async () => {
        const issueDate = `2026-11-0${day}`;
        vi.setSystemTime(Date.UTC(2026, 10, day, 15)); // 12:00 in Brasília
        const f = await fixture(platformTest(), { profile: simplesCampinas() });
        await installCertificate(f);
        openRestricted(f.where.companyId);
        const olinda = ptaxOnlyOn30October();
        const accepted = await request(
          f,
          `c6-${name}`,
          exported({ taker, issueDate, competence: "2026-11" }),
        );
        expect(accepted.issuance).toMatchObject({
          transport: "producao-restrita",
          target: "sefin-nacional",
          series: "1",
          issueDate,
        });
        const id = accepted.issuance.id as Id<"issuances">;
        let sent = "";
        const authority = fakeAuthority().mockImplementation(async (target) => {
          if (target.url === `${SEFIN}/nfse` && target.body !== undefined) {
            sent = (await xmlOf(f.t, id, "dps"))[0]!;
            const nfse =
              `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
              `<nNFSe>11</nNFSe>${sent.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;
            return json(201, { chaveAcesso: KEY, nfseXmlGZipB64: gzipB64(nfse) });
          }
          if (target.url === `${SEFIN}/nfse/${KEY}/eventos` && target.body !== undefined)
            return json(201, { eventoXmlGZipB64: gzipB64("<evento>sintético</evento>") });
          return json(404, { erros: [{ Codigo: "E2220", Descricao: "Não encontrado" }] });
        });
        expect((await drive(f.t, accepted.issuance.operationId)).state).toBe("succeeded");
        const done = await view(f, accepted.issuance.id);
        expect(done).toMatchObject({ state: "authorized", accessKey: KEY, nfseNumber: "11" });
        expect(done.exchange).toMatchObject({
          rate: "5.432100",
          quoteDate: "2026-10-30",
          brlAmount: "5432.10",
          source: "ptax-bcb",
        });
        const asked = olinda.mock.calls.map(
          ([input]) =>
            /'(\d{2}-\d{2}-\d{4})'/.exec(
              input instanceof Request ? input.url : input.toString(),
            )?.[1],
        );
        expect(asked).toEqual(lookback[day]);

        expect(validateDpsXml(sent, PRODREST)).toEqual({ valid: true });
        expect(sent).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
        for (const piece of [
          "<tpAmb>2</tpAmb>",
          "<cLocEmi>3509502</cLocEmi>",
          "<serie>1</serie>",
          "<regApTribSN>1</regApTribSN>",
          "<cNBS>111032200</cNBS>",
          "<vServ>5432.10</vServ>",
          "<tpMoeda>220</tpMoeda><vServMoeda>1000.00</vServMoeda>",
          "<tribISSQN>3</tribISSQN><cPaisResult>US</cPaisResult><tpRetISSQN>1</tpRetISSQN></tribMun>",
          "nifAbsence" in taker
            ? `<toma><cNaoNIF>${taker.nifAbsence}</cNaoNIF>`
            : "<toma><NIF>98-7654321</NIF>",
        ])
          expect(sent).toContain(piece);
        // The profile has an IM, cTribMun and IBS/CBS: none of them reaches the Sefin.
        for (const piece of ["<IM>", "<pAliq>", "<cTribMun>", "<IBSCBS>", "<dest>"])
          expect(sent).not.toContain(piece);

        await cancel(
          f,
          `c6-cancelar-${name}`,
          accepted.issuance.id,
          "Teste de integração sem valor",
        );
        const cancellation = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").first());
        await drive(f.t, cancellation!.operationId);
        expect((await view(f, accepted.issuance.id)).state).toBe("cancelled");
        const [event] = await xmlOf(f.t, id, "cancel-request");
        expect(validatePedRegEventoXml(event!)).toEqual({ valid: true });
        expect(authority.mock.calls.map(([target]) => target.url)).toEqual([
          `${SEFIN}/nfse`,
          `${SEFIN}/nfse/${KEY}/eventos`,
        ]);
        for (const [target] of authority.mock.calls)
          expect(target.allowedOrigins).toEqual(["https://sefin.producaorestrita.nfse.gov.br"]);
      });
  });

  /**
   * Prova de 09/10/2026 (#197): o envio à IMA voltou 2xx fora do formato da Sefin e a consulta
   * ia a `/notafiscal-ws/dps/{id}`, rota inexistente; o 404 liberou o reenvio. Agora a consulta
   * vai a `{base}/dps/{id}`, baixa a NFS-e em `{base}/{chave}` e autoriza sem reenviar.
   */
  describe("reconciliação na IMA (#197)", () => {
    const BASE = "https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse";
    const KEY = `3509502${"2".repeat(43)}`;
    const json = (status: number, body: unknown) => ({
      status,
      body: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
    });
    const nfseOf = (dps: string) =>
      `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
      `<nNFSe>7</nNFSe>${dps.replace(/^<\?xml[^>]*\?>/, "")}</infNFSe></NFSe>`;
    async function campinasIssue(idempotencyKey: string) {
      const f = await fixture(platformTest(), { profile: campinasProfile() });
      await installCertificate(f);
      openRestricted(f.where.companyId);
      const accepted = await request(
        f,
        idempotencyKey,
        domestic({ taker: campinasTaker, issRate: "2" }),
      );
      return { f, accepted, id: accepted.issuance.id as Id<"issuances"> };
    }
    async function attemptsOf(f: Fixture, operationId: Id<"operations">) {
      return f.t.run((ctx) =>
        ctx.db
          .query("operationAttempts")
          .withIndex("by_operationId_and_generation_and_fence", (q) =>
            q.eq("operationId", operationId),
          )
          .collect(),
      );
    }

    it("envio ilegível guarda o diagnóstico; a consulta encontra, baixa e autoriza sem reenviar", async () => {
      const { f, accepted, id } = await campinasIssue("ima-reconcilia");
      let dps = "";
      const authority = fakeAuthority().mockImplementation(async (target) => {
        if (target.url === BASE && target.body !== undefined) {
          dps = (await xmlOf(f.t, id, "dps"))[0]!;
          return json(201, { tipoAmbiente: 2, idDps: accepted.issuance.dpsId, numero: "7" });
        }
        if (target.url === `${BASE}/dps/${accepted.issuance.dpsId}`)
          return json(200, { tipoAmbiente: 2, chaveAcesso: KEY });
        if (target.url === `${BASE}/${KEY}`)
          return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(dps)) });
        return { status: 404, body: Buffer.from("<html>Not Found</html>") };
      });
      const first = await drive(f.t, accepted.issuance.operationId);
      expect(first).toMatchObject({ state: "reconciling", code: "RESPONSE_UNREADABLE" });
      const [attempt] = await attemptsOf(f, accepted.issuance.operationId);
      expect(attempt).toMatchObject({
        mode: "execute",
        code: "RESPONSE_UNREADABLE",
        diagnostic: {
          httpStatus: 201,
          contentType: "application/json",
          body: "json-object",
          keys: ["tipoAmbiente", "idDps", "numero"],
        },
      });
      // Names only: neither the DPS Id nor the number reach the attempt.
      expect(JSON.stringify(attempt)).not.toContain(accepted.issuance.dpsId);
      const done = await drive(f.t, accepted.issuance.operationId);
      expect(done.state).toBe("succeeded");
      expect(await f.t.run((ctx) => ctx.db.get("issuances", id))).toMatchObject({
        state: "authorized",
        accessKey: KEY,
        recoveredByConsult: true,
        submissions: 1,
      });
      expect(authority.mock.calls.map(([target]) => target.url)).toEqual([
        BASE,
        `${BASE}/dps/${accepted.issuance.dpsId}`,
        `${BASE}/${KEY}`,
      ]);
    });

    it("404 sem o JSON do fisco na consulta não reenvia e guarda o diagnóstico", async () => {
      const { f, accepted } = await campinasIssue("ima-404");
      const authority = fakeAuthority().mockImplementation(async (target) =>
        target.body !== undefined
          ? json(201, {})
          : {
              status: 404,
              body: Buffer.from("<!DOCTYPE html><html><body>404</body></html>"),
              contentType: "text/html;charset=utf-8",
            },
      );
      await drive(f.t, accepted.issuance.operationId);
      const op = await drive(f.t, accepted.issuance.operationId, 2);
      expect(op).toMatchObject({ state: "reconciling", code: "CONSULT_INCONCLUSIVE" });
      const posts = authority.mock.calls.filter(([target]) => target.body !== undefined);
      expect(posts).toHaveLength(1);
      const attempts = await attemptsOf(f, accepted.issuance.operationId);
      expect(attempts.map((a) => [a.mode, a.code])).toEqual([
        ["execute", "RESPONSE_UNREADABLE"],
        ["reconcile", "CONSULT_INCONCLUSIVE"],
        ["reconcile", "CONSULT_INCONCLUSIVE"],
      ]);
      expect(attempts[1]!.diagnostic).toEqual({
        httpStatus: 404,
        contentType: "text/html",
        body: "html",
        keys: [],
      });
      expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    });

    it("'DPS já existe' continua levando a reconciliar, não a rejeitar", async () => {
      const { f, accepted } = await campinasIssue("ima-duplicada");
      fakeAuthority().mockImplementation(async (target) =>
        target.body !== undefined
          ? json(400, { erros: [{ Codigo: "E0014", Descricao: "DPS já existe" }] })
          : json(200, { tipoAmbiente: 2 }),
      );
      const op = await drive(f.t, accepted.issuance.operationId);
      expect(op).toMatchObject({
        state: "reconciling",
        code: "DPS_ALREADY_EXISTS",
        uncertain: true,
      });
      expect((await view(f, accepted.issuance.id)).state).toBe("processing");
    });

    it("chave de NFS-e de outra DPS não autoriza nem reenvia", async () => {
      const { f, accepted, id } = await campinasIssue("ima-outra-dps");
      let dps = "";
      const authority = fakeAuthority().mockImplementation(async (target) => {
        if (target.body !== undefined) {
          dps = (await xmlOf(f.t, id, "dps"))[0]!;
          return json(201, {});
        }
        if (target.url.includes("/dps/")) return json(200, { chaveAcesso: KEY });
        const other = dps.replaceAll(
          accepted.issuance.dpsId,
          `${accepted.issuance.dpsId.slice(0, -1)}9`,
        );
        return json(200, { nfseXmlGZipB64: gzipB64(nfseOf(other)) });
      });
      await drive(f.t, accepted.issuance.operationId);
      const op = await drive(f.t, accepted.issuance.operationId);
      expect(op).toMatchObject({ state: "reconciling", code: "NFSE_DPS_MISMATCH" });
      expect(await f.t.run((ctx) => ctx.db.get("issuances", id))).toMatchObject({
        state: "processing",
        submissions: 1,
      });
      expect(authority.mock.calls.filter(([target]) => target.body !== undefined)).toHaveLength(1);
    });
  });

  it("busca a PTAX na Olinda e só lá, sem certificado", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    fakeAuthority();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ value: [{ cotacaoVenda: 5.4321, tipoBoletim: "Fechamento" }] }),
      );
    const accepted = await request(f, "restrita-usd", exported());
    await drive(f.t, accepted.issuance.operationId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0]!;
    const url = input instanceof Request ? input.url : input.toString();
    expect(url).toMatch(/^https:\/\/olinda\.bcb\.gov\.br\/olinda\/servico\/PTAX\//);
    expect(url).toContain("'10-04-2026'");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect((await view(f, accepted.issuance.id)).exchange).toMatchObject({
      rate: "5.432100",
      quoteDate: "2026-10-04",
      source: "ptax-bcb",
      brlAmount: "5432.10",
    });
  });

  it("o simulado nunca abre rede nem o cofre, da PTAX ao cancelamento", async () => {
    const f = await fixture();
    await installCertificate(f);
    const authority = fakeAuthority();
    const vault = vi.spyOn(certificateRuntime, "withCertificate");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const socket = vi.spyOn(https, "request");
    const accepted = await request(f, "simulado", exported());
    expect(accepted.issuance.transport).toBe("simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("authorized");
    await cancel(f, "simulado-cancelar", accepted.issuance.id, "Teste do simulado sem rede");
    const cancellation = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").first());
    await drive(f.t, cancellation!.operationId);
    expect((await view(f, accepted.issuance.id)).state).toBe("cancelled");
    for (const spy of [authority, vault, fetchSpy, socket]) expect(spy).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual([]);
  });

  it("o cofre nega a emissão fora da política, inclusive produção, e audita a recusa", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const accepted = await request(f, "cofre", domestic());
    const token = await claimOperation(f.t, accepted.issuance.operationId);
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).not.toBeNull();
    // The company left the list while the operation waited.
    vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    // The capture homologation variables do not open the NFS-e purpose.
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "");
    vi.stubEnv("FISCAL_ENV", "homologation");
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "sefaz");
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    vi.stubEnv("FISCAL_ENV", "disabled");
    vi.stubEnv("FNFE_CAPTURE_TRANSPORT", "");
    // Real production is refused by the vault even with the restricted transport open.
    openRestricted(f.where.companyId);
    await f.t.run((ctx) =>
      ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, { transport: "producao" }),
    );
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    expect(await certificateUses(f)).toEqual([
      "nfse-transport:authorized",
      "nfse-transport:denied",
      "nfse-transport:denied",
      "nfse-transport:denied",
    ]);
  });

  it("o alvo da #50 nunca recebe o A1 da emissão, nem com o marcador de produção e o gate", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const accepted = await request(f, "alvo-50", domestic());
    const token = await claimOperation(f.t, accepted.issuance.operationId);
    // The gate as if open: no deployment but the fiscal production one can change it.
    await f.t.run((ctx) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.where.organizationId,
        companyId: f.where.companyId,
        production: true,
        actor: "operador-freecorps",
        reason: "Prova sintética: o alvo da #50 não emite",
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    // The issuance and its operation as if accepted in production on that target.
    await f.t.run(async (ctx) => {
      await ctx.db.patch("operations", token.operationId, { environment: "production" });
      await ctx.db.patch("issuances", accepted.issuance.id as Id<"issuances">, {
        environment: "production",
        transport: "producao",
      });
    });
    // The #50 capture target: validation profile, production data, capture transport open.
    for (const [name, value] of Object.entries({
      APP_ENV: "validation",
      PRODUCT_ENV: "production",
      FNFE_PROOF_FISCAL_ENV: "production",
      FISCAL_ENV: "production",
      FNFE_CAPTURE_TRANSPORT: "sefaz",
      EMAIL_MODE: "disabled",
      SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
      CONVEX_CLOUD_URL: "https://modest-seal-118.convex.cloud",
      FNFE_NFSE_SANDBOX_TRANSPORT: "",
      FNFE_NFSE_RESTRICTED_COMPANIES: "",
    }))
      vi.stubEnv(name, value);
    // Without the mark the target runs, and the vault refuses and audits the refusal.
    expect(await f.t.mutation(internal.certificateUse.authorize, token)).toBeNull();
    expect(await certificateUses(f)).toEqual(["nfse-production:denied"]);
    // With the mark the target does not even run: the profile refuses it before the vault.
    vi.stubEnv("FNFE_ISSUANCE_ENV", "production");
    await expect(f.t.mutation(internal.certificateUse.authorize, token)).rejects.toThrow(
      "FNFE_ISSUANCE_ENV",
    );
    expect(await certificateUses(f)).toEqual(["nfse-production:denied"]);
  });

  it("recusa do cofre no meio da tentativa: política fechada para de vez, certificado recusado espera", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    // The policy closes after the executor read it open, and the vault refuses.
    const closed = await request(f, "politica-fecha", domestic());
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
    expect(await drive(f.t, closed.issuance.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await view(f, closed.issuance.id)).toMatchObject({
      state: "rejected",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    // The policy stays open and only the certificate is refused: wait for a usable one.
    openRestricted(f.where.companyId);
    const waiting = await request(f, "certificado-recusado", domestic());
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
    expect(await drive(f.t, waiting.issuance.operationId)).toMatchObject({
      state: "retry_wait",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect((await view(f, waiting.issuance.id)).state).toBe("processing");
    expect(authority).not.toHaveBeenCalled();
  });

  /** The next vault use closes the restricted policy and refuses, as if both raced the attempt. */
  function closeOnNextVaultUse() {
    vi.spyOn(certificateRuntime, "withCertificate").mockImplementationOnce(async () => {
      vi.stubEnv("FNFE_NFSE_RESTRICTED_COMPANIES", "");
      throw new Error("CERTIFICATE_UNAVAILABLE");
    });
  }

  it("emissão já enviada uma vez não é rejeitada quando o cofre recusa e a política fecha", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "enviada-uma-vez", domestic());
    // The first attempt reaches the (synthetic, unavailable) authority: one submission.
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({ state: "retry_wait" });
    expect(authority).toHaveBeenCalled();
    const sent = await f.t.run((ctx) =>
      ctx.db.get("issuances", accepted.issuance.id as Id<"issuances">),
    );
    expect(sent!.submissions).toBe(1);
    closeOnNextVaultUse();
    expect(await drive(f.t, accepted.issuance.operationId)).toMatchObject({
      state: "reconciling",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect(await view(f, accepted.issuance.id)).toMatchObject({ state: "processing" });
  });

  it("cancelamento: sem envio, política fechada falha de vez e a nota segue autorizada; com envio, reconcilia", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "para-cancelar", domestic());
    const issuanceId = accepted.issuance.id as Id<"issuances">;
    // Authorized as if the restricted authority had answered.
    await f.t.run(async (ctx) => {
      await ctx.db.patch("issuances", issuanceId, {
        state: "authorized",
        accessKey: "3".repeat(50),
      });
      await ctx.db.patch("operations", accepted.issuance.operationId as Id<"operations">, {
        state: "succeeded",
      });
    });
    const cancellationOf = async (key: string) => {
      await cancel(f, key, issuanceId, "Prova sintética do cancelamento restrito");
      const rows = await f.t.run((ctx) => ctx.db.query("issuanceCancellations").collect());
      return rows.at(-1)!;
    };

    const unsent = await cancellationOf("cancelar-sem-envio");
    closeOnNextVaultUse();
    expect(await drive(f.t, unsent.operationId)).toMatchObject({
      state: "failed",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(await f.t.run((ctx) => ctx.db.get("issuanceCancellations", unsent._id))).toMatchObject({
      state: "rejected",
      submissions: 0,
    });
    expect(await view(f, issuanceId)).toMatchObject({ state: "authorized" });
    expect(authority).not.toHaveBeenCalled();

    openRestricted(f.where.companyId);
    const sent = await cancellationOf("cancelar-com-envio");
    expect(await drive(f.t, sent.operationId)).toMatchObject({ state: "retry_wait" });
    expect(authority).toHaveBeenCalled();
    expect(
      (await f.t.run((ctx) => ctx.db.get("issuanceCancellations", sent._id)))!.submissions,
    ).toBe(1);
    closeOnNextVaultUse();
    expect(await drive(f.t, sent.operationId)).toMatchObject({
      state: "reconciling",
      code: "CERTIFICATE_UNAVAILABLE",
    });
    expect(await f.t.run((ctx) => ctx.db.get("issuanceCancellations", sent._id))).toMatchObject({
      state: "processing",
    });
    expect(await view(f, issuanceId)).toMatchObject({ state: "authorized" });
  });

  it("desligar a variável com a emissão na fila para o executor antes de enviar", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = fakeAuthority();
    const accepted = await request(f, "revogada", domestic());
    vi.stubEnv("FNFE_NFSE_SANDBOX_TRANSPORT", "simulated");
    await drive(f.t, accepted.issuance.operationId);
    expect(await view(f, accepted.issuance.id)).toMatchObject({
      state: "rejected",
      code: "ISSUANCE_TRANSPORT_DISABLED",
    });
    expect(authority).not.toHaveBeenCalled();
  });
});

describe("verificação de mTLS e adesão (issuanceProbe.verify)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const probe = (
    f: Fixture,
    extra: { productionAdhesion?: boolean; operator?: string; reason?: string } = {},
  ) =>
    f.t.action(internal.issuanceProbe.verify, {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      operator: extra.operator ?? "operador-freecorps",
      reason: extra.reason ?? "Fase 3: prova de mTLS antes da primeira emissão",
      ...(extra.productionAdhesion ? { productionAdhesion: true } : {}),
    });
  const answers = () =>
    fakeAuthority().mockImplementation(async (target) => {
      // Sefin: 404 with the national envelope. IMA: a route 404 in HTML, which is inconclusive.
      if (target.url.includes("/SefinNacional/dps/"))
        return {
          status: 404,
          body: Buffer.from(JSON.stringify({ tipoAmbiente: 2, versaoAplicativo: "1.0" })),
          contentType: "application/json",
        };
      if (target.url.includes("/dps/"))
        return {
          status: 404,
          body: Buffer.from("<html><body>Not Found</body></html>"),
          contentType: "text/html",
        };
      if (target.url.startsWith("https://sefin."))
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              parametrosConvenio: { aderenteAmbienteNacional: 1, aderenteEmissorNacional: 0 },
            }),
          ),
        };
      throw new Error("CERTIFICATE_NETWORK_ERROR");
    });

  it("fica fechada sem a política do deployment e audita a recusa", async () => {
    const f = await fixture();
    await installCertificate(f);
    const authority = answers();
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    openRestricted("outraempresa");
    expect(await code(probe(f))).toBe("ISSUANCE_PROBE_DISABLED");
    expect(authority).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual(["nfse-probe:denied", "nfse-probe:denied"]);
    openRestricted(f.where.companyId);
    // The certificate audit, which the customer may see, never carries the login.
    const actors = await f.t.run(async (ctx) =>
      (await ctx.db.query("certificateAudit").collect()).map((row) => row.actor),
    );
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every((actor) => actor === "operator:freecorps")).toBe(true);
    // Same person and reason rules as the gate: a GitHub login and safe text.
    for (const operator of ["operador@freecorps", "", "-x"])
      expect(await code(probe(f, { operator }))).toBe("INVALID_REQUEST");
    for (const reason of [
      "curto",
      "Motivo sintético \u202e invertido",
      "Motivo sintético \u0085 C1",
      "Motivo sintético \u200f marcado",
    ])
      expect(await code(probe(f, { reason }))).toBe("INVALID_REQUEST");
  });

  it("consulta uma DPS inexistente e a adesão, só com GET e só na produção restrita", async () => {
    const f = await fixture();
    const certificateId = await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = answers();
    const result = await probe(f);
    const dpsId = `DPS35095022${ISSUER_CNPJ}99999${"9".repeat(15)}`;
    expect(result).toEqual({
      certificate: { id: certificateId, version: 1 },
      dpsId,
      consultations: [
        {
          target: "sefin-nacional",
          host: "sefin.producaorestrita.nfse.gov.br",
          outcome: "not-found",
          code: null,
          httpStatus: 404,
          transportError: null,
          diagnostic: null,
        },
        {
          target: "campinas-adn",
          host: "preprod-nfseapi.ima.sp.gov.br",
          outcome: "uncertain",
          code: "CONSULT_INCONCLUSIVE",
          httpStatus: 404,
          transportError: null,
          diagnostic: { httpStatus: 404, contentType: "text/html", body: "html", keys: [] },
        },
      ],
      adhesion: [
        {
          source: "sefin-producao-restrita",
          host: "sefin.producaorestrita.nfse.gov.br",
          httpStatus: 200,
          aderenteAmbienteNacional: 1,
          aderenteEmissorNacional: 0,
          code: null,
        },
        {
          source: "adn-producao-restrita",
          host: "adn.producaorestrita.nfse.gov.br",
          httpStatus: null,
          aderenteAmbienteNacional: null,
          aderenteEmissorNacional: null,
          code: "CERTIFICATE_NETWORK_ERROR",
        },
      ],
      parameters: [],
    });
    const urls = authority.mock.calls.map(([target]) => target.url);
    expect(urls).toEqual([
      `https://sefin.producaorestrita.nfse.gov.br/SefinNacional/dps/${dpsId}`,
      `https://preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse/dps/${dpsId}`,
      "https://sefin.producaorestrita.nfse.gov.br/SefinNacional/parametros_municipais/3509502/convenio",
      "https://adn.producaorestrita.nfse.gov.br/parametrizacao/3509502/convenio",
    ]);
    for (const [target] of authority.mock.calls) {
      expect(target.body).toBeUndefined();
      expect(target.allowedOrigins).toEqual([new URL(target.url).origin]);
    }
    // Nothing reserved, created or persisted besides the audit of the use.
    const state = await f.t.run(async (ctx) => ({
      operations: await ctx.db.query("operations").collect(),
      sequences: await ctx.db.query("dpsSequences").collect(),
    }));
    expect(state).toEqual({ operations: [], sequences: [] });
    expect(await certificateUses(f)).toEqual(["nfse-probe:authorized", "nfse-probe:success"]);
  });

  it("lê a adesão no ADN de produção só quando o operador pede, e nunca toca a Sefin de produção", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = answers();
    const result = await probe(f, { productionAdhesion: true });
    expect(result.adhesion.map((a) => a.source)).toEqual([
      "sefin-producao-restrita",
      "adn-producao-restrita",
      "adn-producao",
    ]);
    const hosts = authority.mock.calls.map(([target]) => new URL(target.url).host);
    expect(hosts).toContain("adn.nfse.gov.br");
    expect(hosts).not.toContain("sefin.nfse.gov.br");
    expect(hosts).not.toContain("nfseapi.campinas.sp.gov.br");
    expect(authority.mock.calls.at(-1)![0].url).toBe(
      "https://adn.nfse.gov.br/parametrizacao/3509502/convenio",
    );
  });
});

describe("parâmetros municipais (issuanceProbe.verify com parameters)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  type Parameters = {
    serviceCode: string;
    competence: string;
    benefitNumber?: string;
    production?: boolean;
  };
  const probe = (f: Fixture, parameters: Parameters) =>
    f.t.action(internal.issuanceProbe.verify, {
      organizationId: f.where.organizationId,
      companyId: f.where.companyId,
      operator: "operador-freecorps",
      reason: "Fase 3: alíquota do ISS que o fisco aplica em Campinas",
      parameters,
    });
  const rate = {
    aliquotas: {
      "01.05.01.001": [{ Incidencia: "SIM", Aliq: 2.0, DtIni: "2026-01-01T00:00:00", DtFim: null }],
    },
    mensagem: "Alíquotas recuperadas com sucesso.",
  };
  const bigBody = JSON.stringify({ retencoes: "é".repeat(6000) });
  const answers = () =>
    fakeAuthority().mockImplementation(async (target) => {
      const url = target.url;
      if (url.includes("/dps/")) return { status: 404, body: Buffer.from("") };
      if (url.endsWith("/convenio")) return { status: 200, body: Buffer.from("{}") };
      if (url.endsWith("/aliquota"))
        return { status: 200, body: Buffer.from(JSON.stringify(rate)) };
      if (url.endsWith("/historicoaliquotas")) return { status: 200, body: Buffer.from("<html>") };
      if (url.endsWith("/regimes_especiais"))
        return { status: 200, body: Buffer.from(JSON.stringify({ $id: "1", regimes: [] })) };
      if (url.endsWith("/retencoes")) return { status: 200, body: Buffer.from(bigBody) };
      throw new Error("CERTIFICATE_TIMEOUT");
    });

  it("normaliza o código do serviço e a competência como o ADN exige", () => {
    expect(parameterServiceCode("010501")).toBe("01.05.01.000");
    expect(parameterServiceCode("010501001")).toBe("01.05.01.001");
    expect(parameterServiceCode("01.05.01.001")).toBe("01.05.01.001");
    for (const bad of ["01050", "0105010010", "01-05-01", "1.05.01", "../convenio"])
      expect(parameterServiceCode(bad)).toBeNull();
    expect(parameterCompetence("2026-10")).toBe("2026-10-01");
    expect(parameterCompetence("2026-10-31")).toBe("2026-10-31");
    for (const bad of ["2026-13", "2026-02-30", "10-01-2026", "2026-10-01T00:00:00", "2026/10"])
      expect(parameterCompetence(bad)).toBeNull();
  });

  it("devolve o corpo parseado só até o limite, sem chaves inválidas no Convex", () => {
    expect(boundedBody('{"a":1}')).toEqual({
      bytes: 7,
      json: { a: 1 },
      text: null,
      truncated: false,
    });
    expect(boundedBody('{"$id":1}')).toMatchObject({
      json: null,
      text: '{"$id":1}',
      truncated: false,
    });
    const cut = boundedBody(bigBody);
    expect(cut.truncated).toBe(true);
    expect(cut.json).toBeNull();
    expect(Buffer.byteLength(cut.text!)).toBeLessThanOrEqual(PARAMETER_BODY_LIMIT);
    expect(cut.text!.endsWith("�")).toBe(false);
  });

  it("lê alíquota, histórico, regimes, retenções e benefício só com GET no ADN restrito", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = answers();
    const result = await probe(f, {
      serviceCode: "010501001",
      competence: "2026-10",
      benefitNumber: "35095020100001",
    });
    const base = "/parametrizacao/3509502";
    expect(result.parameters).toEqual([
      {
        source: "adn-producao-restrita",
        query: "aliquota",
        host: "adn.producaorestrita.nfse.gov.br",
        path: `${base}/01.05.01.001/2026-10-01/aliquota`,
        httpStatus: 200,
        bytes: Buffer.byteLength(JSON.stringify(rate)),
        json: rate,
        text: null,
        truncated: false,
        code: null,
      },
      expect.objectContaining({
        query: "historicoaliquotas",
        path: `${base}/01.05.01.001/historicoaliquotas`,
        json: null,
        text: "<html>",
      }),
      expect.objectContaining({
        query: "regimes_especiais",
        path: `${base}/01.05.01.001/2026-10-01/regimes_especiais`,
        json: null,
      }),
      expect.objectContaining({
        query: "retencoes",
        path: `${base}/2026-10-01/retencoes`,
        bytes: Buffer.byteLength(bigBody),
        json: null,
        truncated: true,
      }),
      {
        source: "adn-producao-restrita",
        query: "beneficio",
        host: "adn.producaorestrita.nfse.gov.br",
        path: `${base}/35095020100001/2026-10-01/beneficio`,
        httpStatus: null,
        bytes: null,
        json: null,
        text: null,
        truncated: false,
        code: "CERTIFICATE_TIMEOUT",
      },
    ]);
    for (const [target] of authority.mock.calls) {
      expect(target.body).toBeUndefined();
      expect(target.allowedOrigins).toEqual([new URL(target.url).origin]);
    }
    const hosts = new Set(authority.mock.calls.map(([target]) => new URL(target.url).host));
    expect(hosts).not.toContain("adn.nfse.gov.br");
    expect(hosts).not.toContain("sefin.nfse.gov.br");
    const state = await f.t.run(async (ctx) => ({
      operations: await ctx.db.query("operations").collect(),
      sequences: await ctx.db.query("dpsSequences").collect(),
    }));
    expect(state).toEqual({ operations: [], sequences: [] });
    expect(await certificateUses(f)).toEqual(["nfse-probe:authorized", "nfse-probe:success"]);
  });

  it("lê no ADN de produção só com production, e nunca toca a Sefin nem a IMA de produção", async () => {
    const f = await fixture();
    await installCertificate(f);
    openRestricted(f.where.companyId);
    const authority = answers();
    const result = await probe(f, {
      serviceCode: "010501",
      competence: "2026-10-15",
      production: true,
    });
    expect(result.parameters.map((read) => `${read.source} ${read.query}`)).toEqual([
      "adn-producao-restrita aliquota",
      "adn-producao-restrita historicoaliquotas",
      "adn-producao-restrita regimes_especiais",
      "adn-producao-restrita retencoes",
      "adn-producao aliquota",
      "adn-producao historicoaliquotas",
      "adn-producao regimes_especiais",
      "adn-producao retencoes",
    ]);
    const urls = authority.mock.calls.map(([target]) => target.url);
    expect(urls).toContain(
      "https://adn.nfse.gov.br/parametrizacao/3509502/01.05.01.000/2026-10-15/aliquota",
    );
    const hosts = urls.map((url) => new URL(url).host);
    expect(hosts).not.toContain("sefin.nfse.gov.br");
    expect(hosts).not.toContain("nfseapi.campinas.sp.gov.br");
  });

  it("recusa parâmetros inválidos antes do cofre e fica fechada fora da política", async () => {
    const f = await fixture();
    await installCertificate(f);
    const authority = answers();
    openRestricted(f.where.companyId);
    for (const parameters of [
      { serviceCode: "0105", competence: "2026-10" },
      { serviceCode: "010501", competence: "10/2026" },
      { serviceCode: "010501", competence: "2026-10", benefitNumber: "../convenio" },
    ])
      expect(await code(probe(f, parameters))).toBe("INVALID_REQUEST");
    expect(await certificateUses(f)).toEqual([]);
    openRestricted("outraempresa");
    expect(await code(probe(f, { serviceCode: "010501", competence: "2026-10" }))).toBe(
      "ISSUANCE_PROBE_DISABLED",
    );
    expect(authority).not.toHaveBeenCalled();
    expect(await certificateUses(f)).toEqual(["nfse-probe:denied"]);
  });
});
