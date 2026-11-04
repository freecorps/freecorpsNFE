/**
 * Exportação sintética de ponta a ponta: tomador fictício no Canadá, valor em
 * CAD convertido pela PTAX de uma resposta Olinda sintética, DPS montada,
 * assinada e enviada por transporte simulado; a estrutura é conferida por DOM
 * e pela ordem do leiaute. Depois, a exportação de um optante do Simples de
 * Campinas a partir de 01/11/2026 (regra C6): rota, XSD oficial e assinatura.
 */
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vite-plus/test";
import {
  BACEN_CURRENCY,
  COM_EXT_DEFAULTS,
  NFSE_NS,
  convertToBrl,
  gunzipB64,
  gzipB64,
  nacional,
  ptaxSaleForIssue,
  resolveRoute,
  subitemFromCTribNac,
  validateDpsXml,
  verifySignature,
  type DpsInput,
  type NfseHttpRequest,
  type TomaExterior,
} from "./src/index";
import { nationalInput, signerKeys } from "./tests/inputs";

const ptaxBody = readFileSync(
  new URL("./fixtures/ptax-cad-2026-08-28.json", import.meta.url),
  "utf8",
);

it("DPS de exportação para o Canadá com PTAX de fixture", async () => {
  const olinda = async (request: NfseHttpRequest) => ({
    status: 200,
    body: request.url.includes("'08-28-2026'") ? ptaxBody : '{"value":[]}',
  });
  // Fato gerador na segunda 31/08: vale o boletim de sexta, 28/08.
  const quote = await ptaxSaleForIssue("CAD", "2026-08-31", olinda);
  expect(quote).toEqual({ currency: "CAD", rate: "3.987600", quoteDate: "2026-08-28" });
  const vServ = convertToBrl("1000.00", quote.rate);
  expect(vServ).toBe("3987.60");

  const dps: DpsInput = {
    ...nationalInput,
    dhEmi: "2026-08-31T10:00:00-03:00",
    dCompet: "2026-08-31",
    nDPS: 7,
    toma: {
      tipo: "NIF",
      nif: "123456789RC0001",
      xNome: "Maple Leaf Synthetic Inc.",
      cPais: "CA",
      cEndPost: "M5V 0A1",
      xCidade: "Toronto",
      xEstProvReg: "ON",
      xLgr: "King St W",
      nro: "100",
      xBairro: "Downtown",
      email: "billing@maple.example",
    },
    serv: {
      cLocPrestacao: nationalInput.serv.cLocPrestacao,
      cTribNac: "010501",
      xDescServ: "Licenciamento de software - agosto/2026",
      comExt: { ...COM_EXT_DEFAULTS, tpMoeda: BACEN_CURRENCY.CAD!, vServMoeda: "1000.00" },
    },
    valores: {
      vServ,
      tribISSQN: 3,
      cPaisResult: "CA",
      tpRetISSQN: 1,
      vTotTribFed: "0",
      vTotTribEst: "0",
      vTotTribMun: "0",
    },
  };

  let sent = "";
  const sefin = async (request: NfseHttpRequest) => {
    sent = gunzipB64(JSON.parse(request.body!).dpsXmlGZipB64);
    return {
      status: 201,
      body: JSON.stringify({ chaveAcesso: "1".repeat(50), nfseXmlGZipB64: gzipB64("<NFSe/>") }),
    };
  };
  const outcome = await nacional.issue(
    { dps },
    {
      signer: signerKeys(),
      transport: sefin,
      target: { id: "sefin-nacional", environment: "producao-restrita" },
    },
  );
  expect(outcome.kind).toBe("success");
  expect(verifySignature(sent, signerKeys().certificatePem)).toBe(true);

  const doc = new DOMParser().parseFromString(sent, "text/xml");
  const one = (name: string) => {
    const list = doc.getElementsByTagNameNS(NFSE_NS, name);
    expect(list.length).toBe(1);
    return list[0]!;
  };
  const childNames = (name: string) =>
    Array.from(one(name).childNodes)
      .filter((node) => node.nodeType === 1)
      .map((node) => (node as unknown as { localName: string }).localName);
  expect(childNames("toma")).toEqual(["NIF", "xNome", "end", "email"]);
  expect(childNames("end")).toEqual(["endExt", "xLgr", "nro", "xBairro"]);
  expect(childNames("endExt")).toEqual(["cPais", "cEndPost", "xCidade", "xEstProvReg"]);
  expect(childNames("serv")).toEqual(["locPrest", "cServ", "comExt"]);
  expect(childNames("comExt")).toEqual([
    "mdPrestacao",
    "vincPrest",
    "tpMoeda",
    "vServMoeda",
    "mecAFComexP",
    "mecAFComexT",
    "movTempBens",
    "mdic",
  ]);
  expect(childNames("tribMun")).toEqual(["tribISSQN", "cPaisResult", "tpRetISSQN"]);
  expect(one("tpMoeda").textContent).toBe("165");
  expect(one("vServMoeda").textContent).toBe("1000.00");
  expect(one("vServ").textContent).toBe("3987.60");
  expect(one("cPaisResult").textContent).toBe("CA");
});

/**
 * Fase 3 na Sefin (#197): a partir de 01/11/2026, o optante do Simples de
 * Campinas exporta pelo Emissor Nacional (regra C6). O teste prova a rota nos
 * dois lados da data, o XSD oficial e a assinatura RSA-SHA256 para cada forma
 * de identificar o tomador no exterior (NIF, cNaoNIF 1 e 2; o 0 é vedado pelo
 * E0226 e pelo tipo). O conteúdo de negócio da DPS da plataforma é provado em
 * `platform/convex/issuance.test.ts`. Dados sintéticos; nada aqui prova autorização.
 */
describe("exportação de Simples de Campinas à Sefin Nacional (C6, desde 01/11/2026)", () => {
  const CAMPINAS = "3509502";
  const foreign: TomaExterior = {
    tipo: "NIF",
    nif: "98-7654321",
    xNome: "Example Grocery LLC",
    cPais: "US",
    cEndPost: "94105",
    xCidade: "San Francisco",
    xEstProvReg: "CA",
    xLgr: "Market St",
    nro: "548",
    xBairro: "SoMa",
  };
  const sefinExport = (toma: TomaExterior): DpsInput => ({
    ...nationalInput,
    // A produção restrita valida o leiaute da NT 009 desde 20/10/2026 (E1235 em 02/11, #197).
    layout: "nfse-1.01-prodrest-20261020",
    dhEmi: "2026-11-03T10:00:00-03:00",
    dCompet: "2026-11-03",
    cLocEmi: CAMPINAS,
    prest: { ...nationalInput.prest, opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 },
    toma,
    serv: {
      cLocPrestacao: CAMPINAS,
      cTribNac: "010501",
      xDescServ: "Licenciamento de software - novembro/2026",
      cNBS: "111032200",
      comExt: { ...COM_EXT_DEFAULTS, tpMoeda: BACEN_CURRENCY.USD!, vServMoeda: "1.00" },
    },
    valores: {
      vServ: "5.43",
      tribISSQN: 3,
      cPaisResult: "US",
      tpRetISSQN: 1,
      vTotTribFed: "0.00",
      vTotTribEst: "0.00",
      vTotTribMun: "0.00",
    },
  });
  const variants: Record<string, [TomaExterior, string]> = {
    NIF: [foreign, "<toma><NIF>98-7654321</NIF>"],
    "cNaoNIF 1": [
      { ...foreign, tipo: "semNIF", nif: undefined, cNaoNIF: 1 },
      "<toma><cNaoNIF>1</cNaoNIF>",
    ],
    "cNaoNIF 2": [
      { ...foreign, tipo: "semNIF", nif: undefined, cNaoNIF: 2 },
      "<toma><cNaoNIF>2</cNaoNIF>",
    ],
  };

  it("31/10/2026 ainda vai à IMA (C5); de 01/11/2026 em diante, à Sefin Nacional (C6)", () => {
    const input = {
      municipioIbge: CAMPINAS,
      regime: "simples-nacional" as const,
      subitem: subitemFromCTribNac("010501"),
    };
    expect(resolveRoute({ ...input, date: "2026-10-31" })).toMatchObject({
      target: "campinas-adn",
      ruleId: "campinas-c5-simples",
    });
    for (const date of ["2026-11-01", "2026-11-03", "2027-01-04"])
      expect(resolveRoute({ ...input, date })).toMatchObject({
        kind: "nacional",
        target: "sefin-nacional",
        alternatives: [],
        ruleId: "campinas-c6-simples",
      });
  });

  for (const [name, [toma, identity]] of Object.entries(variants))
    it(`tomador com ${name}: vai à Sefin restrita no XSD oficial, assinada em RSA-SHA256`, async () => {
      const requests: NfseHttpRequest[] = [];
      const outcome = await nacional.issue(
        { dps: sefinExport(toma) },
        {
          signer: signerKeys(),
          target: { id: "sefin-nacional", environment: "producao-restrita" },
          transport: async (request) => {
            requests.push(request);
            return {
              status: 201,
              body: JSON.stringify({
                chaveAcesso: "1".repeat(50),
                nfseXmlGZipB64: gzipB64("<NFSe/>"),
              }),
            };
          },
        },
      );
      expect(outcome.kind).toBe("success");
      expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse",
      ]);
      const sent = gunzipB64(JSON.parse(requests[0]!.body!).dpsXmlGZipB64);
      expect(validateDpsXml(sent, "nfse-1.01-prodrest-20261020")).toEqual({ valid: true });
      expect(sent).toMatch(/<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe><cLocEmi>/);
      expect(sent).toMatch(/<cNBS>111032200<\/cNBS><xDescServ>/);
      expect(sent).toContain("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256");
      expect(verifySignature(sent, signerKeys().certificatePem)).toBe(true);
      expect(sent).toContain(identity);
    });
});
