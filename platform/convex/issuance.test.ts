/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vite-plus/test";
import type { Id } from "./_generated/dataModel";
import {
  SYNTHETIC_ISSUER_CNPJ as ISSUER_CNPJ,
  platformTest,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";
import { type IssuanceInput, VER_APLIC } from "./lib/issuanceValues";
import { createHash } from "node:crypto";
import { inspectPdf } from "../../tests/helpers/pdf";
// Same source module the platform resolves under test (vite.config.ts aliases the
// workspace packages to src), so the XSD catalog is registered once.
import { VER_APLIC_MAX, validateDpsXml } from "../../packages/fiscal-nfse/src/index";
import {
  PRODREST,
  fixture,
  nationalTaker,
  domestic,
  exported,
  code,
  request,
  view,
  drive,
  xmlOf,
  simulation,
  campinasProfile,
  campinasTaker,
} from "../../tests/helpers/issuance";

/**
 * NFS-e issuance in the sandbox with the simulated transport (ADR 0004, phase 2). Every company,
 * CNPJ, CPF and taker is synthetic; nothing here reaches a tax authority, so nothing here proves
 * an authorization.
 */
/** Lets one test make the PDF renderer fail, to prove the authorization does not wait on it. */
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
      "NFS-e SEM VALIDADE JURÍDICA",
      "SIMULADA",
      done.accessKey!,
      "11.222.333/0001-81",
      "Tomador Sintético Ltda",
      "R$ 1.000,00",
      "2,50%",
      "Inf. A. T. Mun.: NFS-e simulada pelo sandbox da freecorpsNFE, sem validade fiscal.",
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
