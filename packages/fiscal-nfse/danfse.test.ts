import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { describe, expect, it } from "vite-plus/test";
import { inspectPdf } from "../../tests/helpers/pdf";
import { buildDps, type DpsInput } from "./src/index";
import { breakLines } from "./src/lineBreak";
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

  it("agrupa os milhares como o agrupamento por regex, em qualquer tamanho", () => {
    // Referência: a regex de antes, que revarria o resto do número em cada posição.
    const legacy = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    for (let length = 1; length <= 40; length++) {
      const digits = "9876543210".repeat(4).slice(0, length);
      expect(formatDecimal(`-${digits}.5`)).toBe(`-${legacy(digits)},50`);
    }
    expect(formatDecimal("000012345.678")).toBe("12.345,678");
    expect(formatDecimal("0")).toBe("0,00");
  });

  it("formata um valor de 300 mil dígitos", () => {
    expect(formatDecimal("1".repeat(300_000))).toBe(`${Array(100_000).fill("111").join(".")},00`);
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

/** XML sintético com a alíquota trocada direto no texto, sem passar pela validação da DPS. */
const withRate = (pAliq: string) =>
  nfseXml(campinasInput).replace(/<pAliq>[^<]*<\/pAliq>/, `<pAliq>${pAliq}</pAliq>`);

describe("alíquota no DANFSe", () => {
  it.each([
    { name: "2.00", pAliq: "2.00", printed: "2,00%" },
    { name: "2.5000", pAliq: "2.5000", printed: "2,50%" },
    { name: "2.0125", pAliq: "2.0125", printed: "2,0125%" },
    { name: "2.01250", pAliq: "2.01250", printed: "2,0125%" },
    { name: "5", pAliq: "5", printed: "5,00%" },
    { name: "2.000000", pAliq: "2.000000", printed: "2,00%" },
  ])("pAliq $name sai como $printed", async ({ pAliq, printed }) => {
    const [page] = await inspectPdf(await renderDanfse(withRate(pAliq)));
    expect(page!.text).toContain(`Alíquota ${printed} ·`);
  });

  it("alíquota com 200 mil casas que não terminam em zero começa com as casas do XML", async () => {
    // O caso que fazia a regex de antes recuar a cada casa. A linha passa da página e a extração do
    // PDF só devolve o começo dela; o fim da limpeza dos zeros fica nos casos curtos acima.
    const [page] = await inspectPdf(await renderDanfse(withRate(`2.${"0".repeat(200_000)}1`)));
    expect(page!.text).toContain(`Alíquota 2,${"0".repeat(100)}`);
  });
});

/**
 * Mede como a quebra de linha cresce sem depender do relógio: conta os caracteres que ela pede
 * para medir. A medida de mentira dá 1 a cada caractere.
 */
function measuredBreak(text: string, width: number) {
  let measured = 0;
  const lines = breakLines(text, width, 1, (part) => {
    measured += part.length;
    return part.length;
  });
  return { lines, measured };
}

/** A quebra anterior, que remedia cada linha candidata: referência das linhas esperadas. */
function remeasuringWrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      if (current) lines.push(current);
      lines.push(rest.slice(0, cut));
      current = "";
      rest = rest.slice(cut);
    }
    const candidate = current ? `${current} ${rest}` : rest;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
    else {
      if (current) lines.push(current);
      current = rest;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
/** Largura útil da página do DANFSe (A4 menos as margens de 40 pt). */
const CONTENT_WIDTH = 595.28 - 2 * 40;

describe("desempenho da quebra de linha do DANFSe", () => {
  // Cada palavra é medida inteira uma vez e a junção com a anterior em cinco caracteres ("x y", x
  // e y); a palavra cortada mede ainda cada caractere sozinho e com o anterior. No pior caso,
  // quatro por caractere. A quebra de antes media nesses casos de 8 a 43 mil por caractere.
  const BUDGET = 4;

  it.each([
    { name: "descrição de 5.000 caracteres sem espaço", text: "A".repeat(5000), width: 100 },
    { name: "palavra de 500 caracteres sem espaço", text: "B".repeat(500), width: 30 },
    { name: "texto de 5.000 palavras", text: "palavra ".repeat(5000), width: 100 },
    { name: "texto de 5.000 letras soltas", text: "a ".repeat(5000), width: 100 },
  ])(`$name mede cada caractere no máximo ${BUDGET} vezes`, ({ text, width }) => {
    const { lines, measured } = measuredBreak(text, width);
    expect(measured).toBeLessThanOrEqual(BUDGET * text.length);
    expect(lines.every((line) => line.length <= width)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  });

  it("as medidas dobram quando o texto dobra", () => {
    const small = measuredBreak("C".repeat(5000), 100).measured;
    const large = measuredBreak("C".repeat(10_000), 100).measured;
    expect(large).toBeLessThanOrEqual(2 * small + BUDGET);
  });

  it("na Helvetica, todo caractere alarga o texto, com ou sem kerning", async () => {
    // O corte da palavra longa para na primeira medida que passa da linha: vale só se nenhum par
    // com kerning encolhe o texto ao ganhar um caractere.
    const font = await helvetica();
    const chars = font
      .getCharacterSet()
      .filter((code) => code >= 32 && code !== 127)
      .map((code) => String.fromCodePoint(code));
    for (const a of chars)
      for (const b of chars)
        expect(font.widthOfTextAtSize(a + b, 1000)).toBeGreaterThan(
          font.widthOfTextAtSize(a, 1000),
        );
  });

  it("dá as mesmas linhas que remedir cada candidata", async () => {
    const font = await helvetica();
    const texts = [
      Array.from({ length: 160 }, (_, i) => `item-${i}`).join(" descrição longa "),
      "AVATAR To. Yo, Wa Te L’L’ “Av” ff, rv. ".repeat(40),
      // Curtas: a referência remede prefixos e fica cúbica nas palavras longas.
      "W".repeat(150),
      "i".repeat(300),
      "AV".repeat(100),
      "L’".repeat(100),
      `Serviço de manutenção ${"X".repeat(120)} fim ${"Á".repeat(90)}`,
      "Rua Exemplo, 10, Bairro Exemplo · Município IBGE 3509502 · CEP 13000-000",
      "",
      "  espaços\tem\nexcesso  ",
    ];
    for (const size of [8, 8.5, 9])
      for (const width of [CONTENT_WIDTH, 60, 4])
        for (const text of texts)
          expect(
            breakLines(text, width, size / 1000, (part) => font.widthOfTextAtSize(part, 1000)),
          ).toEqual(remeasuringWrap(text, font, size, width));
  });

  it("descrição de 20.000 caracteres sem espaço sai inteira no PDF", async () => {
    const xml = nfseXml(nationalInput).replace(
      /<xDescServ>[^<]*<\/xDescServ>/,
      `<xDescServ>${"A".repeat(20_000)}</xDescServ>`,
    );
    const pages = await inspectPdf(await renderDanfse(xml));
    const printed = pages.flatMap((p) => p.boxes).filter((b) => /^A+$/.test(b.str));
    expect(printed.reduce((total, b) => total + b.str.length, 0)).toBe(20_000);
    expect(outside(pages)).toEqual([]);
  });
});
