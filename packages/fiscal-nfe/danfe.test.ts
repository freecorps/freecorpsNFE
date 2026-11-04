import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { inspectPdf } from "../../tests/helpers/pdf";
import {
  DANFE_GENERATOR_VERSION,
  MAX_EVENTS,
  MAX_ORIGIN_LENGTH,
  code128Values,
  formatDecimal,
  readNfeForDanfe,
  renderDanfe,
} from "./src/danfe";
import { code128Bars, code128Widths } from "./src/danfe/code128";
import { breakLines } from "./src/danfe/draw";
import { splitDateTime } from "./src/danfe/format";
import { accessKey, eventXml, nfeXml, type FixtureOptions } from "./tests/danfeFixtures";

const KEY = accessKey();
const ALPHA_KEY = accessKey("12ABC34501DE35");
const ORIGIN = "evento preservado pela plataforma, sem consulta ao fisco";
const WATERMARKS = new Set(["SEM VALOR FISCAL", "NF-e CANCELADA", "NF-e DENEGADA"]);
const FOOTER_TOP = 20;

type Pages = Awaited<ReturnType<typeof inspectPdf>>;

/**
 * Nenhum texto se sobrepõe a outro nem desce até o rodapé: blocos que invadem a tabela de itens
 * ou o rodapé aparecem como textos encavalados. A marca diagonal fica de fora, porque o leitor a
 * mede sem a rotação.
 */
function overlaps(pages: Pages) {
  const found: string[] = [];
  pages.forEach((page, p) => {
    const boxes = page.boxes.filter((b) => b.str.trim() && !WATERMARKS.has(b.str));
    const footer = boxes.filter((b) => b.y < FOOTER_TOP);
    if (footer.length !== 1 || !footer[0]!.str.startsWith("DANFE gerado"))
      found.push(`folha ${p + 1}: rodapé com ${footer.map((b) => b.str).join(" | ")}`);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!,
          b = boxes[j]!;
        if (
          a.x < b.x + b.width - 0.3 &&
          b.x < a.x + a.width - 0.3 &&
          a.y < b.y + b.height - 0.3 &&
          b.y < a.y + a.height - 0.3
        )
          found.push(`folha ${p + 1}: "${a.str}" x "${b.str}"`);
      }
  });
  return found;
}

/**
 * Renderiza e lê o PDF com outro motor (pdf.js). Com `DANFE_PNG_DIR`, grava cada folha em PNG
 * para conferência visual; a pasta fica fora do Git.
 */
async function render(name: string, xml: string, evidence?: Parameters<typeof renderDanfe>[1]) {
  const bytes = await renderDanfe(xml, evidence);
  const pages = await inspectPdf(bytes);
  const dir = process.env.DANFE_PNG_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.pdf`), bytes);
    pages.forEach((page, i) => writeFileSync(path.join(dir, `${name}-${i + 1}.png`), page.png));
  }
  expect(pages.flatMap((p) => p.outside).filter((item) => !WATERMARKS.has(item))).toEqual([]);
  expect(overlaps(pages)).toEqual([]);
  return { bytes, pages, text: pages.map((p) => p.text).join(" ") };
}
const xmlWith = (options: FixtureOptions) => nfeXml(options);
const cancellation = (key = KEY, options: Parameters<typeof eventXml>[1] = {}) => ({
  events: [eventXml(key, options)],
  origin: ORIGIN,
});

/** Lê de volta as barras desenhadas: larguras → símbolos → valores → texto da chave. */
function decodeBars(text: string) {
  const { bars, modules } = code128Bars(text);
  const widths: number[] = [];
  bars.forEach(([start, width], i) => {
    widths.push(width);
    const next = bars[i + 1];
    if (next) widths.push(next[0] - start - width);
  });
  if (widths.reduce((a, b) => a + b) !== modules) throw new Error("barras fora da conta");
  const table = new Map(
    Array.from({ length: 107 }, (_, v) => [code128Widths(v).join(""), v] as const),
  );
  const values: number[] = [];
  for (let i = 0; i < widths.length;) {
    const size = widths.length - i === 7 ? 7 : 6;
    const value = table.get(widths.slice(i, i + size).join(""));
    if (value === undefined) throw new Error(`símbolo desconhecido na posição ${i}`);
    values.push(value);
    i += size;
  }
  const [start, ...rest] = values;
  const stop = rest.pop();
  const check = rest.pop()!;
  const sum = [start!, ...rest].reduce((total, v, i) => total + v * (i || 1), 0);
  let set = start === 105 ? "C" : "A";
  let decoded = "";
  for (const v of rest) {
    if (set === "C" && v === 101) set = "A";
    else if (set === "A" && v === 99) set = "C";
    else decoded += set === "C" ? String(v).padStart(2, "0") : String.fromCharCode(v + 32);
  }
  return { decoded, checksumOk: sum % 103 === check, stop };
}

describe("CODE-128 da chave de acesso", () => {
  it("valor decimal ausente fica em branco; item sem quantidade é recusado antes do leiaute", async () => {
    expect(formatDecimal("")).toBe("");
    expect(formatDecimal(null)).toBe("");
    const xml = nfeXml({})
      .replace(/<qCom>[^<]*<\/qCom>/, "")
      .replace(/<vProd>[^<]*<\/vProd>/, "");
    await expect(renderDanfe(xml)).rejects.toThrow("XML_FIELD_INVALID");
  });

  it("reproduz o exemplo da NT 2025.001: C, troca para A nas letras e DV 30", () => {
    expect(code128Values("5225AB83")).toEqual([105, 52, 25, 101, 33, 34, 99, 83, 30, 106]);
  });

  it("codifica a chave numérica inteira no conjunto C, com DV módulo 103", () => {
    const values = code128Values(KEY);
    expect(values[0]).toBe(105);
    expect(values.slice(1, 23)).toEqual(KEY.match(/\d\d/g)!.map(Number));
    const sum = values.slice(0, 23).reduce((total, v, i) => total + v * (i || 1), 0);
    expect(values.slice(23)).toEqual([sum % 103, 106]);
  });

  it("chave com CNPJ alfanumérico alterna para A nas letras e volta a C", () => {
    // 352610 | 12ABC34501DE35 | ...: dígito ímpar antes da letra fica em A.
    expect(code128Values(ALPHA_KEY).slice(0, 12)).toEqual([
      105, 35, 26, 10, 12, 101, 33, 34, 35, 19, 99, 45,
    ]);
    expect(code128Values("123A")).toEqual([105, 12, 101, 19, 33, expect.any(Number), 106]);
  });

  it("as barras desenhadas decodificam de volta para a chave, com DV e parada", () => {
    for (const key of [KEY, ALPHA_KEY, "5225AB83"])
      expect(decodeBars(key)).toEqual({ decoded: key, checksumOk: true, stop: 106 });
  });

  it("tabela de símbolos: 11 módulos, barras somando par e padrões distintos", () => {
    const seen = new Set<string>();
    for (let v = 0; v <= 105; v++) {
      const widths = code128Widths(v);
      expect(widths.reduce((a, b) => a + b)).toBe(11);
      expect((widths[0]! + widths[2]! + widths[4]!) % 2).toBe(0);
      seen.add(widths.join(""));
    }
    expect(seen.size).toBe(106);
    expect(code128Widths(106)).toEqual([2, 3, 3, 1, 1, 1, 2]);
    expect(code128Bars(KEY).modules).toBe(24 * 11 + 13);
  });
});

describe("leitura do XML para o DANFE", () => {
  it("lê partes, protocolo, totais e itens com o texto decimal do XML", () => {
    const data = readNfeForDanfe(xmlWith({ rtc: true }));
    expect(data).toMatchObject({
      key: KEY,
      status: {
        kind: "authorized",
        protocol: { number: "135260000000123", receivedAt: "2026-10-30T23:31:05-03:00" },
      },
      totals: { vNF: "1234567.89", vFrete: "12.34", vFCP: "0.00", vICMSUFDest: null },
      ibsCbsTotals: { vCBS: "0.72", vIS: "10.00", vIBSMono: null },
    });
    expect(data.items[0]).toMatchObject({
      cst: "000",
      quantity: "2.0000",
      unitValue: "50.0000000001",
      // gRed informado: a alíquota impressa é a efetiva, não a vigente (NT 2026.010, 4.3).
      ibsCbs: { rateCbs: "0.3600", rateUf: "0.1000", classTrib: "000001" },
      is: { rate: "10.0000", value: "10.00" },
    });
  });

  it("recusa outro modelo, chave com DV errado e valor não decimal", () => {
    const xml = xmlWith({});
    expect(() => readNfeForDanfe(xml.replace("<mod>55</mod>", "<mod>65</mod>"))).toThrow(
      expect.objectContaining({ code: "DANFE_MODEL_UNSUPPORTED" }),
    );
    expect(() => readNfeForDanfe(xml.replace(`NFe${KEY}`, `NFe${KEY.slice(0, 43)}0`))).toThrow(
      expect.objectContaining({ code: "DANFE_XML_INVALID", field: "Id" }),
    );
    expect(() => readNfeForDanfe(xml.replace("<vFrete>12.34", "<vFrete>12,34"))).toThrow(
      expect.objectContaining({ code: "DANFE_XML_INVALID", field: "vFrete" }),
    );
  });

  it("formata decimal sem arredondar nem passar por ponto flutuante", () => {
    expect(formatDecimal("1234567.89")).toBe("1.234.567,89");
    expect(formatDecimal("50.0000000001")).toBe("50,0000000001");
    expect(formatDecimal("0.1")).toBe("0,10");
    expect(formatDecimal("9007199254740993.01")).toBe("9.007.199.254.740.993,01");
  });

  it("data só é reformatada quando é de calendário; senão sai o texto do XML", () => {
    expect(splitDateTime("2028-02-29T10:00:00-03:00")).toEqual({
      date: "29/02/2028",
      time: "10:00:00",
    });
    expect(splitDateTime("2026-02-30")).toEqual({ date: "2026-02-30", time: "" });
    expect(splitDateTime("2026-13-01")).toEqual({ date: "2026-13-01", time: "" });
  });
});

describe("situação impressa: mesmas regras da importação", () => {
  const statusOf = (xml: string, evidence?: Parameters<typeof readNfeForDanfe>[1]) =>
    readNfeForDanfe(xml, evidence).status;

  it("assinatura, protocolo completo e digVal válidos: autorizada", () => {
    expect(statusOf(xmlWith({}))).toMatchObject({ kind: "authorized" });
  });

  it("protocolo sem digVal, com digVal errado ou sem nProt não autoriza", () => {
    expect(statusOf(xmlWith({ protocol: { digVal: null } }))).toEqual({
      kind: "unauthorized",
      reason: "identidade da chave e do protocolo não confere (NFE_PROTOCOL_INCOMPLETE)",
    });
    expect(statusOf(xmlWith({ protocol: { digVal: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" } }))).toEqual({
      kind: "unauthorized",
      reason: "identidade da chave e do protocolo não confere (NFE_PROTOCOL_DIGEST_MISMATCH)",
    });
    expect(statusOf(xmlWith({ protocol: { nProt: null } }))).toEqual({
      kind: "unauthorized",
      reason: "identidade da chave e do protocolo não confere (NFE_PROTOCOL_INCOMPLETE)",
    });
  });

  it("XML alterado depois de assinado, mantendo o DigestValue, não sai como autorizado", () => {
    const tampered = xmlWith({
      tamper: (signed) => signed.replace("PRODUTO SINTETICO 1<", "PRODUTO ADULTERADO 1<"),
    });
    expect(statusOf(tampered)).toEqual({
      kind: "unauthorized",
      reason: "assinatura XML não confere (SIGNATURE_INVALID_OR_UNSUPPORTED)",
    });
  });

  it("sem protocolo, protocolo de outro ambiente ou cStat que não autoriza", () => {
    expect(statusOf(xmlWith({ protocol: null }))).toEqual({
      kind: "unauthorized",
      reason: "sem protocolo de autorização de uso",
    });
    expect(statusOf(xmlWith({ protocol: { tpAmb: "2" } }))).toMatchObject({
      kind: "unauthorized",
      reason: expect.stringContaining("NFE_PROTOCOL_MISMATCH"),
    });
    expect(statusOf(xmlWith({ protocol: { cStat: "204" } }))).toEqual({
      kind: "unauthorized",
      reason: "protocolo com cStat 204, que não autoriza o uso",
    });
  });

  it("denegada (110, 301, 302, 303) é DENEGADA", () => {
    for (const cStat of ["110", "301", "302", "303"])
      expect(statusOf(xmlWith({ protocol: { cStat } }))).toMatchObject({ kind: "denied", cStat });
  });

  it("cancelamento registrado sobre autorização comprovada: CANCELADA com protocolo", () => {
    expect(statusOf(xmlWith({}), cancellation())).toEqual({
      kind: "cancelled",
      event: { number: "135260000000999", registeredAt: "2026-10-31T09:00:07-03:00" },
      origin: ORIGIN,
      authorization: { number: "135260000000123", receivedAt: "2026-10-30T23:31:05-03:00" },
    });
  });

  it("cancelamento sem autorização comprovada continua SEM VALOR FISCAL", () => {
    expect(statusOf(xmlWith({ protocol: null }), cancellation())).toMatchObject({
      kind: "cancelled",
      authorization: { missing: "sem protocolo de autorização de uso" },
    });
    // Evento de outro ambiente sobre nota não comprovada: conflito, não cancelamento.
    expect(statusOf(xmlWith({ protocol: null }), cancellation(KEY, { tpAmb: "2" }))).toEqual({
      kind: "conflict",
      conflicts: ["ENVIRONMENT_MISMATCH"],
    });
  });

  it("evento de outro ambiente ou de outro protocolo é conflito", () => {
    expect(statusOf(xmlWith({}), cancellation(KEY, { tpAmb: "2" }))).toEqual({
      kind: "conflict",
      conflicts: ["ENVIRONMENT_MISMATCH"],
    });
    expect(statusOf(xmlWith({}), cancellation(KEY, { nProt: "135260000000777" }))).toEqual({
      kind: "conflict",
      conflicts: ["CANCELLATION_PROTOCOL_CONFLICT"],
    });
  });

  it("evento de outro ambiente que não contaria é ignorado, como na derivação", () => {
    const xml = xmlWith({});
    const tamperedEvent = eventXml(KEY, { tpAmb: "2" }).replace(
      "CANCELAMENTO DE FIXTURE SINTETICA",
      "CANCELAMENTO ADULTERADO SINTETICO",
    );
    for (const event of [
      eventXml(KEY, { tpAmb: "2", cStat: "573" }),
      eventXml(KEY, { tpAmb: "2", cStat: "136" }),
      tamperedEvent,
    ])
      expect(statusOf(xml, { events: [event], origin: ORIGIN })).toMatchObject({
        kind: "authorized",
      });
    // O mesmo cancelamento, registrado e íntegro, continua em conflito.
    expect(statusOf(xml, cancellation(KEY, { tpAmb: "2" }))).toEqual({
      kind: "conflict",
      conflicts: ["ENVIRONMENT_MISMATCH"],
    });
  });

  it("conflito de ambiente mostra também os demais códigos", () => {
    const events = [
      eventXml(KEY, { tpAmb: "2" }),
      eventXml(KEY, { nProt: "135260000000777", sequence: 2 }),
    ];
    expect(statusOf(xmlWith({}), { events, origin: ORIGIN })).toEqual({
      kind: "conflict",
      conflicts: ["CANCELLATION_PROTOCOL_CONFLICT", "ENVIRONMENT_MISMATCH"],
    });
  });

  it("evento de outra nota é recusado, mesmo com a nota não comprovada", () => {
    const foreign = cancellation(accessKey("11444777000161"));
    const tampered = xmlWith({
      tamper: (signed) => signed.replace("PRODUTO SINTETICO 1<", "PRODUTO ADULTERADO 1<"),
    });
    for (const xml of [xmlWith({}), xmlWith({ protocol: null }), tampered])
      expect(() => statusOf(xml, foreign)).toThrow(
        expect.objectContaining({ code: "DANFE_EVIDENCE_INVALID", field: "chNFe" }),
      );
    // Nota adulterada com evento da mesma chave em outro ambiente: conflito.
    expect(statusOf(tampered, cancellation(KEY, { tpAmb: "2" }))).toEqual({
      kind: "conflict",
      conflicts: ["ENVIRONMENT_MISMATCH"],
    });
    // Nota adulterada com cancelamento próprio: CANCELADA sem autorização comprovada.
    expect(statusOf(tampered, cancellation())).toMatchObject({
      kind: "cancelled",
      authorization: { missing: "assinatura XML não confere (SIGNATURE_INVALID_OR_UNSUPPORTED)" },
    });
  });

  it("dois cancelamentos registrados: o de menor sequência, em qualquer ordem", async () => {
    const xml = xmlWith({});
    const first = eventXml(KEY, { sequence: 1 });
    const second = eventXml(KEY, { sequence: 2 });
    expect(statusOf(xml, { events: [second, first], origin: ORIGIN })).toMatchObject({
      kind: "cancelled",
      event: { number: "135260000000999" },
    });
    const a = await renderDanfe(xml, { events: [first, second], origin: ORIGIN });
    const b = await renderDanfe(xml, { events: [second, first], origin: ORIGIN });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("limita a quantidade de eventos e recusa origem sem evento", () => {
    const xml = xmlWith({});
    const limit = Array.from({ length: MAX_EVENTS }, (_, i) => eventXml(KEY, { sequence: i + 1 }));
    expect(statusOf(xml, { events: limit, origin: ORIGIN })).toMatchObject({
      kind: "cancelled",
      event: { number: "135260000000999" },
    });
    const many = [...limit, eventXml(KEY, { sequence: MAX_EVENTS + 1 })];
    expect(() => statusOf(xml, { events: many, origin: ORIGIN })).toThrow(
      expect.objectContaining({ code: "DANFE_EVIDENCE_INVALID", field: "events" }),
    );
    expect(() => statusOf(xml, { origin: ORIGIN })).toThrow(
      expect.objectContaining({ code: "DANFE_EVIDENCE_INVALID", field: "origin" }),
    );
  });

  it("aceita os bytes preservados e produz o mesmo PDF do texto", async () => {
    const xml = xmlWith({});
    const fromText = await renderDanfe(xml, cancellation());
    const fromBytes = await renderDanfe(new TextEncoder().encode(xml), cancellation());
    expect(Buffer.from(fromBytes).equals(Buffer.from(fromText))).toBe(true);
  });

  it("denegada com cancelamento é conflito, como na situação do documento", () => {
    expect(statusOf(xmlWith({ protocol: { cStat: "302" } }), cancellation())).toEqual({
      kind: "conflict",
      conflicts: ["FISCAL_STATUS_CONFLICT"],
    });
  });

  it("evento 136, rejeitado ou que não é cancelamento não muda a situação", () => {
    for (const options of [{ cStat: "136" }, { cStat: "573" }, { tpEvento: "110110" }])
      expect(statusOf(xmlWith({}), cancellation(KEY, options))).toMatchObject({
        kind: "authorized",
      });
  });

  it("evento exige origem curta e XML de evento", async () => {
    const xml = xmlWith({});
    expect(() => statusOf(xml, { events: [eventXml(KEY)] })).toThrow(
      expect.objectContaining({ code: "DANFE_EVIDENCE_INVALID", field: "origin" }),
    );
    expect(() => statusOf(xml, { events: [xml], origin: ORIGIN })).toThrow(
      expect.objectContaining({ code: "DANFE_EVIDENCE_INVALID", field: "procEventoNFe" }),
    );
    // Origem de 13 mil caracteres: recusada na hora, sem paginar.
    // oxlint-disable-next-line freecorps/no-wall-clock-in-tests -- limite de tempo real contra paginação patológica da origem
    const started = performance.now();
    await expect(
      renderDanfe(xml, { events: [eventXml(KEY)], origin: "x".repeat(13_000) }),
    ).rejects.toMatchObject({ code: "DANFE_EVIDENCE_INVALID", field: "origin" });
    // oxlint-disable-next-line freecorps/no-wall-clock-in-tests -- limite de tempo real contra paginação patológica da origem
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(
      statusOf(xml, { events: [eventXml(KEY)], origin: "o".repeat(MAX_ORIGIN_LENGTH) }),
    ).toMatchObject({ kind: "cancelled" });
  });
});

describe("DANFE em PDF", () => {
  it("nota simples autorizada: quadros, valores exatos e protocolo, sem marca", async () => {
    const { pages, text } = await render("simples", xmlWith({ infCpl: "Pedido 42." }));
    expect(pages).toHaveLength(1);
    for (const piece of [
      "RECEBEMOS DE EMITENTE SINTETICO DE TESTE LTDA",
      "DANFE",
      "Nº 000.000.123",
      "SÉRIE 001",
      "FOLHA 1/1",
      "11.222.333/0001-81",
      "11.444.777/0001-61",
      "135260000000123 - 30/10/2026 23:31:05",
      "VENDA DE MERCADORIA SINTETICA",
      "3 - REGIME NORMAL",
      // Data e hora do XML, sem conversão de fuso.
      "30/10/2026",
      "31/10/2026",
      "08:15:00",
      "1.234.567,89",
      "12,34",
      "50,0000000001",
      "2,0000",
      "ICMS 18,00%",
      "IPI 5,00%",
      "0 - Remetente (CIF)",
      "ABC1D23",
      "12.345.678/0001-95",
      "13,250",
      "Inf. ao fisco: DOCUMENTO SINTETICO",
      "Pedido 42.",
    ])
      expect(text).toContain(piece);
    expect(text).toContain(KEY.replace(/(.{4})(?=.)/g, "$1 "));
    expect(text).not.toContain("SEM VALOR FISCAL");
    expect(text).not.toContain("TOTAL DO IBS / CBS / IS");
    expect(text).not.toContain("FATURA / DUPLICATAS");
    expect(text).not.toContain("CÁLCULO DO ISSQN");
  });

  it("é determinístico e registra a versão do gerador no rodapé", async () => {
    const xml = xmlWith({ rtc: true, duplicates: 4 });
    const a = await renderDanfe(xml);
    const b = await renderDanfe(xml);
    expect(createHash("sha256").update(a).digest("hex")).toBe(
      createHash("sha256").update(b).digest("hex"),
    );
    const [page] = await inspectPdf(a);
    expect(page!.text).toContain(`gerador versão ${DANFE_GENERATOR_VERSION}`);
  });

  it("muitos itens continuam em outras folhas, com cabeçalho e Folha N/M", async () => {
    const { pages, text } = await render("muitos-itens", xmlWith({ items: 90, rtc: true }));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((page, i) => {
      expect(page.text).toContain(`FOLHA ${i + 1}/${pages.length}`);
      expect(page.text).toContain("DADOS DOS PRODUTOS / SERVIÇOS");
      expect(page.text).toContain("CHAVE DE ACESSO");
    });
    expect(pages[1]!.text).not.toContain("RECEBEMOS DE");
    expect(pages[1]!.text).not.toContain("TOTAL DO ICMS / IPI");
    for (let n = 1; n <= 90; n++) expect(text).toContain(`COD-${n} - PRODUTO SINTETICO ${n}`);
  });

  it("descrições e informações complementares longas continuam sem perda", async () => {
    const infCpl = Array.from({ length: 180 }, (_, i) => `obs-${i}`).join(" linha complementar ");
    const { pages, text } = await render(
      "textos-longos",
      xmlWith({ items: 6, longDescriptions: true, infCpl }),
    );
    expect(pages.length).toBeGreaterThan(1);
    expect(text).toContain("obs-0");
    expect(text).toContain("obs-179");
    expect(text).toContain("(continua em DADOS ADICIONAIS (CONTINUAÇÃO))");
    expect(pages.at(-1)!.text).toContain("DADOS ADICIONAIS (CONTINUAÇÃO)");
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("mantendo todas as palavras do XML");
    expect(flat.match(/Item 6:/g)).toHaveLength(1);
  });

  it("120 duplicatas e 200 volumes: folha 1 limitada e o resto em continuação", async () => {
    const { pages, text } = await render(
      "duplicatas-volumes",
      xmlWith({ duplicates: 120, volumes: 200 }),
    );
    expect(pages[0]!.text).toContain(
      "FATURA / DUPLICATAS (6 de 120; as demais em FATURA / DUPLICATAS (CONTINUAÇÃO))",
    );
    expect(pages[0]!.text).toContain("(2 de 200 volumes;");
    expect(pages[0]!.text).toContain("COD-1 - PRODUTO SINTETICO 1");
    for (let n = 1; n <= 120; n++) expect(text).toContain(String(n).padStart(3, "0"));
    for (let n = 1; n <= 200; n++) expect(text).toContain(`${n}/3`);
    expect(text).toContain("28/02/2027");
    expect(text).toContain("VOLUMES TRANSPORTADOS (CONTINUAÇÃO)");
  });

  it("emitente com nome e endereço longos fica dentro do quadro", async () => {
    const { text } = await render(
      "emitente-longo",
      xmlWith({
        emitterName: "EMITENTE SINTETICO DE NOME LONGO PARA TESTAR O QUADRO LTDA M",
        emitterStreet: "Avenida de Logradouro Sintetico Muito Longo Para Testar Quad",
      }),
    );
    expect(text).toContain("EMITENTE SINTETICO DE NOME LONGO");
    expect(text).not.toContain("SEM VALOR FISCAL");
  });

  it("grupos RTC: total do IBS/CBS/IS e tributos alinhados por item", async () => {
    const { text, pages } = await render("rtc", xmlWith({ rtc: true }));
    for (const piece of [
      "TOTAL DO IBS / CBS / IS",
      "VALOR DA CBS",
      "0,72",
      "VALOR DO IMPOSTO SELETIVO",
      "10,00",
      "cClassTrib 000001",
      "CBS 0,3600%",
      "IBS UF 0,1000%",
      "IBS MUN 0,0000%",
      "IS 10,0000%",
      "IBS/CBS 100,00",
    ])
      expect(text).toContain(piece);
    expect(text).not.toContain("VALOR DO IBS MONOFÁSICO");
    // Base, alíquota e valor de cada tributo na mesma linha de base.
    const y = (str: string) => pages[0]!.boxes.find((b) => b.str === str)!.y;
    expect(y("IS 100,00")).toBe(y("IS 10,0000%"));
    expect(y("IPI 100,00")).toBe(y("IPI 5,00%"));
    expect(y("IBS/CBS 100,00")).toBe(y("CBS 0,3600%"));
  });

  it("CNPJ alfanumérico na chave e no emitente", async () => {
    const { text } = await render("cnpj-alfanumerico", xmlWith({ cnpj: "12ABC34501DE35" }));
    expect(text).toContain("12.ABC.345/01DE-35");
    expect(text).toContain(ALPHA_KEY.replace(/(.{4})(?=.)/g, "$1 "));
    expect(text).not.toContain("SEM VALOR FISCAL");
  });

  it("sem autorização comprovada: SEM VALOR FISCAL e o motivo", async () => {
    const none = await render("sem-protocolo", xmlWith({ protocol: null }));
    expect(none.text).toContain(
      "SEM VALOR FISCAL - documento não autorizado: sem protocolo de autorização de uso.",
    );
    expect(none.text).toContain("NÃO AUTORIZADA - SEM PROTOCOLO VÁLIDO");
    const tampered = await render(
      "adulterada",
      xmlWith({ tamper: (s) => s.replace("PRODUTO SINTETICO 1<", "PRODUTO ADULTERADO 1<") }),
    );
    expect(tampered.text).toContain("assinatura XML não confere");
    expect(tampered.text).not.toContain("135260000000123 - 30/10/2026");
  });

  it("denegada: marca DENEGADA e SEM VALOR FISCAL", async () => {
    const { text } = await render("denegada", xmlWith({ protocol: { cStat: "302" } }));
    expect(text).toContain(
      "NF-e DENEGADA - uso denegado pelo fisco (cStat 302). SEM VALOR FISCAL.",
    );
    expect(text).toContain("DENEGADA - 135260000000123 - 30/10/2026 23:31:05");
  });

  it("homologação sai sempre com SEM VALOR FISCAL", async () => {
    const { pages } = await render("homologacao", xmlWith({ tpAmb: "2", items: 40 }));
    for (const page of pages)
      expect(page.text).toContain("SEM VALOR FISCAL - NF-e emitida em ambiente de homologação.");
    expect(pages[0]!.text).toContain("NF-e EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL.");
  });

  it("cancelada: marca, protocolo do evento e origem; sem autorização, SEM VALOR FISCAL", async () => {
    const xml = xmlWith({});
    const before = xml.slice();
    const { text } = await render("cancelada", xml, cancellation());
    expect(text).toContain(
      `NF-e CANCELADA - evento de cancelamento registrado sob o protocolo 135260000000999 em 31/10/2026 09:00:07. Origem da informação: ${ORIGIN}.`,
    );
    expect(text).not.toContain("SEM VALOR FISCAL");
    expect(xml).toBe(before);
    const loose = await render(
      "cancelada-sem-autorizacao",
      xmlWith({ protocol: null }),
      cancellation(),
    );
    expect(loose.text).toContain("NF-e CANCELADA");
    expect(loose.text).toContain(
      "SEM VALOR FISCAL - autorização da NF-e não comprovada: sem protocolo de autorização de uso.",
    );
    const conflict = await render("conflito", xml, cancellation(KEY, { tpAmb: "2" }));
    expect(conflict.text).toContain(
      "SEM VALOR FISCAL - evidências fiscais em conflito: ENVIRONMENT_MISMATCH.",
    );
    expect(conflict.text).not.toContain("NF-e CANCELADA -");
  });

  it("fatura com duplicatas e cálculo do ISSQN", async () => {
    const { text } = await render("duplicatas-issqn", xmlWith({ duplicates: 7, issqn: true }));
    for (const piece of [
      "FATURA / DUPLICATAS",
      "VALOR ORIGINAL",
      "001",
      "007",
      "01/11/2026",
      "07/11/2026",
      "10,01",
      "CÁLCULO DO ISSQN",
      "12345",
      "300,00",
      "15,00",
    ])
      expect(text).toContain(piece);
  });
});

/**
 * Mede como o laço de quebra de linha cresce sem depender do relógio: conta os caracteres que ele
 * pede para medir. A medida de mentira dá 1 a cada caractere.
 */
function measuredWrap(text: string, width: number) {
  let measured = 0;
  const lines = breakLines(text, width, (part) => {
    measured += part.length;
    return part.length;
  });
  return { lines, measured };
}

describe("desempenho da quebra de linha", () => {
  // Hoje cada palavra é medida inteira e, se for cortada, cada caractere dela mais uma vez: duas
  // medidas por caractere. Medir a linha crescente a cada caractere custa de 18 a 53 por caractere
  // nesses casos, e procurar o maior prefixo que cabe custa de 1.500 a 43 mil.
  const BUDGET = 3;

  it.each([
    { name: "infCpl de 5.000 caracteres sem espaço", text: "A".repeat(5000), width: 100 },
    { name: "infAdProd de 500 caracteres sem espaço", text: "B".repeat(500), width: 30 },
    { name: "texto de 5.000 palavras", text: "palavra ".repeat(5000), width: 100 },
  ])(`$name mede cada caractere no máximo ${BUDGET} vezes`, ({ text, width }) => {
    const { lines, measured } = measuredWrap(text, width);
    expect(measured).toBeLessThanOrEqual(BUDGET * text.length);
    expect(lines.every((line) => line.length <= width)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  });

  it("o custo dobra quando o texto dobra", () => {
    const small = measuredWrap("C".repeat(5000), 100).measured;
    const large = measuredWrap("C".repeat(10_000), 100).measured;
    expect(large).toBeLessThanOrEqual(2 * small + 1);
  });

  it("infCpl de 5.000 caracteres sem espaço sai inteiro no PDF", async () => {
    const bytes = await renderDanfe(xmlWith({ infCpl: "A".repeat(5000) }));
    const pages = await inspectPdf(bytes);
    const printed = pages.flatMap((p) => p.boxes).filter((b) => /^A+$/.test(b.str));
    expect(printed.reduce((total, b) => total + b.str.length, 0)).toBe(5000);
  });

  it("600 itens com infAdProd de 500 caracteres sem espaço geram o PDF", async () => {
    const bytes = await renderDanfe(xmlWith({ items: 600, itemExtra: "B".repeat(500) }));
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 60_000);
});
