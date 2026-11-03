import { describe, expect, it } from "vite-plus/test";
import { inspectPdf } from "../../tests/helpers/pdf";
import { buildDps, type DpsInput } from "./src/index";
import { consultaPublicaUrl, formatDecimal, readNfseForDanfse, renderDanfse } from "./src/danfse";
import { campinasInput, exportInput, nationalInput } from "./tests/inputs";

/**
 * NFS-e sintética no formato do ADN: infNFSe com o grupo emit, valores calculados
 * e a DPS embutida. Chave, nomes e valores são fictícios; nada aqui foi autorizado.
 */
const CHAVE = "35503082112223330001810000000000000042260800000001";
/**
 * `inspectPdf` measures text boxes without rotation, so the diagonal watermark looks wider
 * than it is; its geometry is centered on the page in the renderer. Everything else must fit.
 */
const outside = (pages: Array<{ outside: string[] }>) =>
  pages.flatMap((p) => p.outside).filter((item) => item !== "SEM VALOR FISCAL");
function nfseXml(dps: DpsInput, extra = "", tail = "") {
  const inner = buildDps(dps).xml;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}">` +
    `<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>42</nNFSe>` +
    `<xTribNac>Licenciamento ou cessão de direito de uso de programas de computação.</xTribNac>` +
    `<ambGer>2</ambGer><cStat>100</cStat><dhProc>2026-08-29T10:00:05-03:00</dhProc>` +
    `<emit><CNPJ>${dps.prest.cnpj}</CNPJ><xNome>Prestador Sintético Ltda</xNome></emit>` +
    `<valores><vBC>${dps.valores.vServ}</vBC><vISSQN>7.94</vISSQN><vLiq>389.06</vLiq></valores>` +
    extra +
    `${inner}${tail}</infNFSe></NFSe>`
  );
}

describe("leitura do XML para o DANFSe", () => {
  it("lê chave, número, partes, serviço e valores do XML autorizado", () => {
    const data = readNfseForDanfse(nfseXml(campinasInput));
    expect(data).toMatchObject({
      chaveAcesso: CHAVE,
      nNFSe: "42",
      tpAmb: 2,
      serie: "10001",
      nDPS: "1",
      prestador: {
        name: "Prestador Sintético Ltda",
        documentLabel: "CNPJ",
        document: "11.222.333/0001-81",
        email: "fiscal@prestador.example",
        municipio: "3509502",
      },
      tomador: {
        name: "Tomador Sintético Ltda",
        document: "11.444.777/0001-61",
        address: "Rua Exemplo, 10, Bairro Exemplo · Município IBGE 3509502 · CEP 13000-000",
      },
      servico: { cTribNac: "010501", cTribMun: "001", cNBS: "111032200" },
      // The DPS group is read, not the `valores` of the invoice (direct children only).
      valores: {
        vServ: "397.00",
        pAliq: "2.00",
        retido: true,
        vISSQN: "7.94",
        vLiq: "389.06",
        moeda: null,
      },
    });
  });

  it("recusa XML ilegível, sem DPS ou sem chave", () => {
    expect(() => readNfseForDanfse("<NFSe")).toThrow(/ilegível/);
    expect(() =>
      readNfseForDanfse(`<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe/></NFSe>`),
    ).toThrow(expect.objectContaining({ code: "DANFSE_XML_INVALID" }));
    expect(() => readNfseForDanfse(nfseXml(nationalInput).replace(`NFS${CHAVE}`, "NFS1"))).toThrow(
      /chave de acesso/,
    );
    const withoutPrest = nfseXml(nationalInput).replace(/<prest>[\s\S]*?<\/prest>/, "");
    expect(() => readNfseForDanfse(withoutPrest)).toThrow(
      expect.objectContaining({ code: "DANFSE_XML_INVALID", message: "prest ausente na DPS." }),
    );
  });

  it("formata decimal sem ponto flutuante", () => {
    expect(formatDecimal("1234567.5")).toBe("1.234.567,50");
    expect(formatDecimal("0.1")).toBe("0,10");
    expect(formatDecimal("2.0125", 2)).toBe("2,0125");
  });
});

describe("DANFSe em PDF", () => {
  it("imprime os dados, o QR de consulta e a marca da produção restrita", async () => {
    const bytes = await renderDanfse(nfseXml(campinasInput));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const [page, ...more] = await inspectPdf(bytes);
    expect(more).toEqual([]);
    for (const piece of [
      "DANFSe",
      "3550308211 2223330001 8100000000 0000004226 0800000001",
      "Prestador Sintético Ltda",
      "CNPJ 11.222.333/0001-81",
      "Tomador Sintético Ltda",
      "Licenciamento de software (teste)",
      "R$ 397,00",
      "Alíquota 2,00%",
      "ISSQN retido pelo tomador",
      "Valor líquido R$ 389,06",
      "Tributação nacional 010501 · municipal 001 · NBS 111032200",
      "29/08/2026 10:00:05 (-03:00)",
      "SEM VALOR FISCAL — PRODUÇÃO RESTRITA",
    ])
      expect(page!.text).toContain(piece);
    expect(page!.qr).toBe(consultaPublicaUrl(CHAVE));
    expect(outside([page!])).toEqual([]);
  });

  it("marca o documento do simulador e não esconde a marca em produção restrita", async () => {
    const simulated = await inspectPdf(
      await renderDanfse(nfseXml(nationalInput), { mark: "simulated" }),
    );
    expect(simulated[0]!.text).toContain("SEM VALOR FISCAL — SANDBOX/SIMULADO");
    const production = await inspectPdf(
      await renderDanfse(nfseXml({ ...nationalInput, tpAmb: 1 })),
    );
    expect(production[0]!.text).not.toContain("SEM VALOR FISCAL");
    expect(production[0]!.text).toContain("Ambiente: produção");
  });

  it("exportação mostra moeda de origem e a não incidência do ISS", async () => {
    const [page] = await inspectPdf(await renderDanfse(nfseXml(exportInput)));
    expect(page!.text).toContain("Valor na moeda da operação: 49,00 USD");
    expect(page!.text).toContain("Exportação de serviço — ISS não incidente");
    expect(page!.text).toContain("NIF 98-7654321");
    expect(page!.text).toContain("San Francisco");
  });

  it("descrição longa continua na página seguinte, sem truncar", async () => {
    // Prova da paginação do renderizador: o texto passa do limite da DPS (TSDesc2000)
    // de propósito, por isso entra direto no XML da NFS-e sintética, sem buildDps.
    const long = Array.from({ length: 160 }, (_, i) => `item-${i}`).join(" descrição longa ");
    const xml = nfseXml(nationalInput).replace(
      /<xDescServ>[^<]*<\/xDescServ>/,
      `<xDescServ>${long}</xDescServ>`,
    );
    const pages = await inspectPdf(await renderDanfse(xml));
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.map((p) => p.text).join(" ");
    expect(all).toContain("item-0");
    expect(all).toContain("item-159");
    expect(pages[1]!.text).toContain("DANFSe (continuação)");
    expect(outside(pages)).toEqual([]);
  });

  it("é determinístico e troca caracteres fora da fonte por ?", async () => {
    const xml = nfseXml({
      ...nationalInput,
      serv: { ...nationalInput.serv, xDescServ: "Serviço 漢字 🚀 com acento" },
    });
    const a = await renderDanfse(xml, { mark: "simulated" });
    const b = await renderDanfse(xml, { mark: "simulated" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const [page] = await inspectPdf(a);
    expect(page!.text).toContain("Serviço ?? ? com acento");
  });

  it("traz as informações complementares da NFS-e", async () => {
    const xml = nfseXml(
      nationalInput,
      "<xOutInf>NFS-e simulada pelo sandbox da freecorpsNFE, sem validade fiscal.</xOutInf>",
    );
    const [page] = await inspectPdf(await renderDanfse(xml, { mark: "simulated" }));
    expect(page!.text).toContain("Informações complementares");
    expect(page!.text).toContain("sem validade fiscal");
  });
});
