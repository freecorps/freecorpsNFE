import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import {
  SYNTHETIC_ISSUER_CNPJ as ISSUER_CNPJ,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";
import {
  PARAMETER_BODY_LIMIT,
  boundedBody,
  parameterCompetence,
  parameterServiceCode,
} from "./issuanceProbe";
import {
  fixture,
  type Fixture,
  code,
  installCertificate,
  openRestricted,
  certificateUses,
  fakeAuthority,
} from "../../tests/helpers/issuance";

/**
 * issuanceProbe.verify: mTLS and adhesion, and the municipal parameters.
 * Every company, CNPJ, CPF and taker is synthetic; nothing here reaches a tax authority, so
 * nothing here proves an authorization.
 */
const NOW = Date.UTC(2026, 9, 8, 15); // Thursday, 08/10/2026 12:00 in Brasília

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-issuance",
  now: NOW,
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
