/**
 * DANFSe em PDF, gerado a partir do XML da NFS-e autorizada (a API nacional do
 * DANFSe foi descontinuada em 07/2026).
 * Portado de `convex/engine/danfse.ts` (legado congelado), com três mudanças
 * deliberadas:
 *
 * - a entrada é o XML autorizado, não um resumo montado pelo chamador: o PDF
 *   mostra o que o fisco devolveu, e só isso;
 * - valores saem do texto decimal do XML, sem ponto flutuante nem centavos;
 * - o PDF é determinístico (sem data de criação nem produtor) e não consulta o
 *   relógio; a descrição longa continua em páginas seguintes, sem truncar.
 *
 * Layout A4 próprio com os elementos do documento auxiliar: chave de acesso e
 * QR de consulta pública, prestador, tomador, serviço e valores. Documento de
 * produção restrita (`tpAmb` 2) ou do simulador sai sempre com a marca
 * "SEM VALOR FISCAL"; ela não pode ser desligada para esses documentos.
 */
import { DOMParser } from "@xmldom/xmldom";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { BACEN_CURRENCY, NFSE_NS } from "./dps.js";
import { fail } from "./errors.js";
import { breakLines } from "./lineBreak.js";

/** Origem do documento quando não é produção: muda o texto da marca. */
export type DanfseMark = "simulated" | "restricted";

export interface DanfseOptions {
  /**
   * `simulated`: NFS-e do provedor simulado (sandbox). `restricted`: produção
   * restrita. Sem valor, o ambiente do XML decide (`tpAmb` 2 vira `restricted`).
   */
  mark?: DanfseMark;
}

export interface DanfseParty {
  document: string | null; // CPF, CNPJ ou NIF, já formatado
  documentLabel: string; // "CNPJ", "CPF", "NIF" ou "Sem NIF"
  name: string | null;
  email: string | null;
  address: string | null;
}

/** O que o DANFSe mostra, lido do XML. Exportado para conferência em testes. */
export interface DanfseData {
  chaveAcesso: string;
  nNFSe: string | null;
  dhProc: string | null;
  xLocEmi: string | null;
  tpAmb: 1 | 2;
  dhEmi: string;
  dCompet: string;
  serie: string;
  nDPS: string;
  prestador: DanfseParty & { municipio: string };
  tomador: DanfseParty | null;
  servico: {
    cTribNac: string;
    xTribNac: string | null;
    cTribMun: string | null;
    cNBS: string | null;
    descricao: string;
    localPrestacao: string;
  };
  valores: {
    vServ: string;
    tribISSQN: string;
    pAliq: string | null;
    retido: boolean;
    vISSQN: string | null;
    vLiq: string | null;
    moeda: { codigo: string; sigla: string | null; valor: string } | null;
  };
  informacoes: string | null;
}

const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 40;
const FOOTER = MARGIN + 30;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const LINE = rgb(0.8, 0.8, 0.84);
const ALERT = rgb(0.75, 0.2, 0.2);

const MARK_TEXT: Record<DanfseMark, string> = {
  simulated: "SEM VALOR FISCAL — SANDBOX/SIMULADO",
  restricted: "SEM VALOR FISCAL — PRODUÇÃO RESTRITA",
};

const TRIB_ISSQN: Record<string, string> = {
  "1": "Operação tributável",
  "2": "Imunidade",
  "3": "Exportação de serviço — ISS não incidente (LC 116/2003, art. 2º, I)",
  "4": "Não incidência",
};

/**
 * URL de consulta pública da NFS-e nacional, a mesma do legado. Não foi
 * conferida no portal: o PDF é nosso e o endereço é ajustável.
 */
export const consultaPublicaUrl = (chave: string) =>
  `https://www.nfse.gov.br/consultapublica?tpc=1&chave=${chave}`;

// ---------------------------------------------------------------------------
// Leitura do XML

type El = { getElementsByTagNameNS(ns: string, name: string): ArrayLike<El> } & {
  textContent: string | null;
  getAttribute(name: string): string | null;
  childNodes: ArrayLike<{ nodeType: number; localName?: string | null }>;
};

const first = (scope: El | null | undefined, name: string): El | null =>
  scope ? (scope.getElementsByTagNameNS(NFSE_NS, name)[0] ?? null) : null;

/** Filho direto, para não confundir `valores` da NFS-e com `valores` da DPS. */
function child(scope: El | null | undefined, name: string): El | null {
  if (!scope) return null;
  for (let i = 0; i < scope.childNodes.length; i++) {
    const node = scope.childNodes[i] as unknown as El & { nodeType: number; localName?: string };
    if (node.nodeType === 1 && node.localName === name) return node;
  }
  return null;
}
const textOf = (scope: El | null | undefined, name: string) => {
  const value = first(scope, name)?.textContent?.trim();
  return value ? value : null;
};

const fmtCnpj = (d: string) =>
  /^\d{14}$/.test(d)
    ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    : d;
const fmtCpf = (d: string) =>
  /^\d{11}$/.test(d) ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
const fmtCep = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 5)}-${d.slice(5)}` : d);
/** Chave em grupos de 10 para conferência manual. */
const fmtChave = (c: string) => c.replace(/(\d{10})(?=\d)/g, "$1 ");

/**
 * "1234567" → "1.234.567". Laço em grupos de três a partir da esquerda: o valor vem do XML sem
 * limite de tamanho, e uma regex com lookahead revarreria o resto do número em cada posição.
 */
function groupThousands(digits: string): string {
  const head = digits.length % 3 || 3;
  let grouped = digits.slice(0, head);
  for (let i = head; i < digits.length; i += 3) grouped += `.${digits.slice(i, i + 3)}`;
  return grouped;
}

/** "1234.5" → "1.234,50": texto decimal, sem ponto flutuante. */
export function formatDecimal(value: string, places = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, int, frac = ""] = match;
  const grouped = groupThousands(int!.replace(/^0+(?=\d)/, ""));
  const decimals = frac.length >= places ? frac : frac.padEnd(places, "0");
  return `${sign}${grouped}${decimals ? `,${decimals}` : ""}`;
}
const brl = (value: string) => `R$ ${formatDecimal(value)}`;
/**
 * Alíquota com as casas do XML, sem zeros à direita além de duas: "2.5000" → "2,50%". Só as
 * casas depois do último ponto, se forem todas dígitos, perdem zeros; o resto passa intacto.
 * Percorre o texto uma vez, em vez de uma regex preguiçosa que recua a cada casa.
 */
function percent(value: string): string {
  const dot = value.lastIndexOf(".");
  const frac = value.slice(dot + 1);
  let end = frac.length;
  if (dot >= 0 && /^\d+$/.test(frac)) while (end > 2 && frac[end - 1] === "0") end--;
  return `${formatDecimal(value.slice(0, dot + 1) + frac.slice(0, end), 2)}%`;
}
/** "2026-10-08T12:00:00-03:00" → "08/10/2026 12:00:00 (-03:00)". */
function dateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2}|Z)?)?/.exec(value);
  if (!match) return value;
  const date = `${match[3]}/${match[2]}/${match[1]}`;
  return match[4] ? `${date} ${match[4]}${match[5] ? ` (${match[5]})` : ""}` : date;
}

function party(group: El | null): DanfseParty | null {
  if (!group) return null;
  const cnpj = textOf(group, "CNPJ"),
    cpf = textOf(group, "CPF"),
    nif = textOf(group, "NIF"),
    semNif = textOf(group, "cNaoNIF");
  const nac = first(group, "endNac"),
    ext = first(group, "endExt");
  const street = [textOf(group, "xLgr"), textOf(group, "nro"), textOf(group, "xBairro")]
    .filter(Boolean)
    .join(", ");
  const place = nac
    ? [
        textOf(nac, "cMun") && `Município IBGE ${textOf(nac, "cMun")}`,
        textOf(nac, "CEP") && `CEP ${fmtCep(textOf(nac, "CEP")!)}`,
      ]
    : ext
      ? [
          textOf(ext, "xCidade"),
          textOf(ext, "xEstProvReg"),
          textOf(ext, "cEndPost"),
          textOf(ext, "cPais") && `País ${textOf(ext, "cPais")}`,
        ]
      : [];
  const address = [street, ...place.filter(Boolean)].filter(Boolean).join(" · ");
  return {
    document: cnpj ? fmtCnpj(cnpj) : cpf ? fmtCpf(cpf) : nif,
    documentLabel: cnpj ? "CNPJ" : cpf ? "CPF" : nif ? "NIF" : semNif ? "Sem NIF" : "Documento",
    name: textOf(group, "xNome"),
    email: textOf(group, "email"),
    address: address || null,
  };
}

/** Lê do XML da NFS-e autorizada tudo o que o DANFSe mostra. */
export function readNfseForDanfse(nfseXml: string): DanfseData {
  let doc: El;
  try {
    doc = new DOMParser({
      errorHandler: {
        warning: () => undefined,
        error: (message: string) => {
          throw new Error(message);
        },
        fatalError: (message: string) => {
          throw new Error(message);
        },
      },
    }).parseFromString(nfseXml, "text/xml") as unknown as El;
  } catch {
    return fail("DANFSE_XML_INVALID", "XML da NFS-e ilegível.");
  }
  const inf = first(doc, "infNFSe");
  const infDps = first(inf, "infDPS");
  if (!inf || !infDps) return fail("DANFSE_XML_INVALID", "XML sem infNFSe ou sem a DPS.");
  const chave = /^NFS(\d{50})$/.exec(inf.getAttribute("Id") ?? "")?.[1];
  if (!chave) return fail("DANFSE_XML_INVALID", "infNFSe sem Id com a chave de acesso.");
  const tpAmb = textOf(infDps, "tpAmb");
  if (tpAmb !== "1" && tpAmb !== "2") return fail("DANFSE_XML_INVALID", "tpAmb ausente na DPS.");
  const prest = first(infDps, "prest"),
    emit = child(inf, "emit");
  const serv = first(infDps, "serv"),
    cServ = first(serv, "cServ"),
    comExt = first(serv, "comExt");
  const dpsValores = child(infDps, "valores"),
    tribMun = first(dpsValores, "tribMun"),
    nfseValores = child(inf, "valores");
  const required = (scope: El | null, name: string) =>
    textOf(scope, name) ?? fail("DANFSE_XML_INVALID", `${name} ausente na DPS.`);
  const tpMoeda = textOf(comExt, "tpMoeda");
  const prestDoc = party(prest) ?? fail("DANFSE_XML_INVALID", "prest ausente na DPS.");
  return {
    chaveAcesso: chave,
    nNFSe: textOf(inf, "nNFSe"),
    dhProc: textOf(inf, "dhProc"),
    xLocEmi: child(inf, "xLocEmi")?.textContent?.trim() || null,
    tpAmb: tpAmb === "1" ? 1 : 2,
    dhEmi: required(infDps, "dhEmi"),
    dCompet: required(infDps, "dCompet"),
    serie: required(infDps, "serie"),
    nDPS: required(infDps, "nDPS"),
    prestador: {
      ...prestDoc,
      // O nome do prestador vem da NFS-e (grupo emit); a DPS não o traz.
      name: textOf(emit, "xNome") ?? prestDoc.name,
      email: prestDoc.email ?? textOf(emit, "email"),
      municipio: required(infDps, "cLocEmi"),
    },
    tomador: party(first(infDps, "toma")),
    servico: {
      cTribNac: required(cServ, "cTribNac"),
      xTribNac: child(inf, "xTribNac")?.textContent?.trim() || null,
      cTribMun: textOf(cServ, "cTribMun"),
      cNBS: textOf(cServ, "cNBS"),
      descricao: required(cServ, "xDescServ"),
      localPrestacao:
        child(inf, "xLocPrestacao")?.textContent?.trim() || required(serv, "cLocPrestacao"),
    },
    valores: {
      vServ: required(dpsValores, "vServ"),
      tribISSQN: required(tribMun, "tribISSQN"),
      pAliq: textOf(tribMun, "pAliq") ?? textOf(nfseValores, "pAliqAplic"),
      retido: textOf(tribMun, "tpRetISSQN") === "2",
      vISSQN: textOf(nfseValores, "vISSQN"),
      vLiq: textOf(nfseValores, "vLiq"),
      moeda: tpMoeda
        ? {
            codigo: tpMoeda,
            sigla: Object.entries(BACEN_CURRENCY).find(([, code]) => code === tpMoeda)?.[0] ?? null,
            valor: required(comExt, "vServMoeda"),
          }
        : null,
    },
    informacoes: child(inf, "xOutInf")?.textContent?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Desenho

/**
 * As fontes padrão do PDF só codificam WinAnsi. Caracteres fora dela (emoji,
 * CJK) viram "?" em vez de derrubar a geração; controles viram espaço.
 */
function encoder(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return (value: string) =>
    Array.from(value)
      .map((char) => {
        const code = char.codePointAt(0)!;
        if (code < 32 || code === 127) return " ";
        return supported.has(code) ? char : "?";
      })
      .join("");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  return breakLines(text, maxWidth, size / 1000, (part) => font.widthOfTextAtSize(part, 1000));
}

/** Módulos do QR desenhados como retângulos: vetorial, sem PNG embutido. */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const quiet = 2;
  const cell = size / (count + 2 * quiet);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.modules.get(row, col))
        page.drawRectangle({
          x: x + (col + quiet) * cell,
          y: y + size - (row + quiet + 1) * cell,
          width: cell,
          height: cell,
          color: rgb(0, 0, 0),
        });
}

/**
 * Gera o DANFSe em PDF a partir do XML da NFS-e autorizada. Função pura e
 * determinística: o mesmo XML e as mesmas opções dão os mesmos bytes.
 */
export async function renderDanfse(nfseXml: string, options: DanfseOptions = {}) {
  const data = readNfseForDanfse(nfseXml);
  // Produção restrita nunca sai sem a marca, mesmo que o chamador não peça.
  const mark: DanfseMark | null = options.mark ?? (data.tpAmb === 2 ? "restricted" : null);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`DANFSe ${data.chaveAcesso}`);
  doc.setLanguage("pt-BR");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = encoder(font);
  const contentWidth = A4.width - 2 * MARGIN;
  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  const decorate = (target: PDFPage) => {
    if (mark) {
      // Diagonal centered on the page: the baseline starts half the text length before the
      // center, along the 40° direction, so the rotated text stays inside the A4 box.
      const size = 52,
        angle = (40 * Math.PI) / 180,
        width = bold.widthOfTextAtSize("SEM VALOR FISCAL", size);
      target.drawText("SEM VALOR FISCAL", {
        x: A4.width / 2 - (width / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
        y: A4.height / 2 - (width / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
        size,
        font: bold,
        color: ALERT,
        opacity: 0.12,
        rotate: degrees(40),
      });
    }
    target.drawLine({
      start: { x: MARGIN, y: FOOTER - 12 },
      end: { x: A4.width - MARGIN, y: FOOTER - 12 },
      thickness: 0.7,
      color: LINE,
    });
    target.drawText(
      safe(
        `Chave de acesso ${data.chaveAcesso} · consulta em www.nfse.gov.br. ` +
          "Documento auxiliar gerado pela freecorpsNFE.",
      ),
      { x: MARGIN, y: FOOTER - 24, size: 7, font, color: MUTED },
    );
    if (mark)
      target.drawText(safe(MARK_TEXT[mark]), {
        x: MARGIN,
        y: FOOTER - 34,
        size: 7,
        font: bold,
        color: ALERT,
      });
  };
  decorate(page);
  /** Garante espaço na página; senão continua na próxima. */
  const room = (height: number) => {
    if (y - height >= FOOTER) return;
    page = doc.addPage([A4.width, A4.height]);
    decorate(page);
    y = A4.height - MARGIN;
    text("DANFSe (continuação)", { size: 9, font: bold, color: MUTED });
    y -= 18;
  };
  function text(
    value: string,
    opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {},
  ) {
    page.drawText(safe(value), {
      x: opts.x ?? MARGIN,
      y,
      size: opts.size ?? 9,
      font: opts.font ?? font,
      color: opts.color ?? INK,
    });
  }
  const line = (value: string, opts: Parameters<typeof text>[1] = {}) => {
    room(12);
    text(value, opts);
    y -= 12;
  };
  const section = (title: string) => {
    room(48);
    y -= 10;
    text(title, { size: 10, font: bold });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.width - MARGIN, y },
      thickness: 0.7,
      color: LINE,
    });
    y -= 14;
  };
  const paragraph = (value: string, size = 9, maxLines = Infinity) => {
    const lines = wrap(safe(value), font, size, contentWidth);
    for (const item of lines.slice(0, maxLines)) line(item, { size });
  };

  // Cabeçalho, com o QR no canto superior direito.
  const qrSize = 92;
  drawQr(
    page,
    consultaPublicaUrl(data.chaveAcesso),
    A4.width - MARGIN - qrSize,
    A4.height - MARGIN - qrSize,
    qrSize,
  );
  text("DANFSe", { size: 20, font: bold });
  y -= 16;
  text("Documento Auxiliar da Nota Fiscal de Serviço Eletrônica — Padrão Nacional", {
    size: 9,
    color: MUTED,
  });
  y -= 13;
  text(data.tpAmb === 1 ? "Ambiente: produção" : "Ambiente: produção restrita", {
    size: 8.5,
    color: MUTED,
  });
  if (mark) {
    y -= 14;
    text(MARK_TEXT[mark], { size: 10, font: bold, color: ALERT });
  }
  y = Math.min(y, A4.height - MARGIN - qrSize) - 4;

  section("Identificação");
  text("Chave de acesso", { size: 7.5, color: MUTED });
  y -= 11;
  text(fmtChave(data.chaveAcesso), { size: 9.5, font: bold });
  y -= 16;
  const pairs: Array<[string, string]> = [
    ["Número da NFS-e", data.nNFSe ?? "—"],
    ["Autorização", data.dhProc ? dateTime(data.dhProc) : "—"],
    ["Emissão da DPS", dateTime(data.dhEmi)],
    ["Competência", dateTime(data.dCompet)],
  ];
  const col = contentWidth / pairs.length;
  pairs.forEach(([label, value], i) => {
    text(label, { x: MARGIN + i * col, size: 7.5, color: MUTED });
    page.drawText(safe(value), { x: MARGIN + i * col, y: y - 11, size: 8.5, font, color: INK });
  });
  y -= 24;
  line(`DPS série ${data.serie}, número ${data.nDPS}`, { size: 8, color: MUTED });
  if (data.xLocEmi) line(`Local de emissão: ${data.xLocEmi}`, { size: 8, color: MUTED });

  const partyBlock = (title: string, p: DanfseParty, extra?: string) => {
    section(title);
    line(p.name ?? "Nome não informado no XML", { font: bold });
    line(
      [p.document ? `${p.documentLabel} ${p.document}` : p.documentLabel, extra]
        .filter(Boolean)
        .join(" · "),
    );
    if (p.address) paragraph(p.address, 8.5);
    if (p.email) line(p.email, { color: MUTED });
  };
  partyBlock("Prestador de serviços", data.prestador, `Município IBGE ${data.prestador.municipio}`);
  if (data.tomador) partyBlock("Tomador de serviços", data.tomador);
  else {
    section("Tomador de serviços");
    line("Tomador não identificado na DPS.", { color: MUTED });
  }

  section("Serviço");
  line(
    [
      `Tributação nacional ${data.servico.cTribNac}`,
      data.servico.cTribMun && `municipal ${data.servico.cTribMun}`,
      data.servico.cNBS && `NBS ${data.servico.cNBS}`,
    ]
      .filter(Boolean)
      .join(" · "),
    { size: 8, color: MUTED },
  );
  if (data.servico.xTribNac) paragraph(data.servico.xTribNac, 8);
  line(`Local da prestação: ${data.servico.localPrestacao}`, { size: 8, color: MUTED });
  y -= 2;
  paragraph(data.servico.descricao);

  section("Valores");
  text("Valor do serviço", { size: 7.5, color: MUTED });
  y -= 14;
  text(brl(data.valores.vServ), { size: 13, font: bold });
  y -= 16;
  if (data.valores.moeda)
    line(
      `Valor na moeda da operação: ${formatDecimal(data.valores.moeda.valor)} ` +
        `${data.valores.moeda.sigla ?? `(código BACEN ${data.valores.moeda.codigo})`}`,
      { size: 8.5 },
    );
  line(TRIB_ISSQN[data.valores.tribISSQN] ?? `Tributação do ISSQN ${data.valores.tribISSQN}`, {
    size: 8.5,
    font: bold,
  });
  const iss = [
    data.valores.pAliq && `Alíquota ${percent(data.valores.pAliq)}`,
    data.valores.vISSQN && `ISSQN ${brl(data.valores.vISSQN)}`,
    data.valores.retido ? "ISSQN retido pelo tomador" : "ISSQN não retido",
    data.valores.vLiq && `Valor líquido ${brl(data.valores.vLiq)}`,
  ].filter(Boolean);
  line(iss.join(" · "), { size: 8.5 });

  if (data.informacoes) {
    section("Informações complementares");
    paragraph(data.informacoes, 8.5, 20);
  }

  return doc.save({ useObjectStreams: false });
}
