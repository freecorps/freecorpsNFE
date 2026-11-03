import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage } from "pdf-lib";
import { fail } from "../xml.js";
import {
  ALERT,
  CELL_HEIGHT,
  CONTENT_WIDTH,
  INK,
  MUTED,
  PAGE,
  TITLE_HEIGHT,
  drawBarcode,
  drawCells,
  drawTitle,
  ellipsize,
  encoder,
  textWidth,
  wrap,
  type Cell,
  type Fonts,
} from "./draw.js";
import {
  formatCep,
  formatDateTime,
  formatDecimal,
  formatDocument,
  formatKey,
  formatNumber,
  formatPercent,
  formatPhone,
  formatSeries,
  splitDateTime,
} from "./format.js";
import { readNfeForDanfe, type DanfeData, type DanfeEvidence, type DanfeItem } from "./read.js";

/**
 * Versão do leiaute e das regras deste gerador. Muda sempre que o mesmo XML e as mesmas
 * evidências passarem a produzir outro PDF; serve de chave de cache para quem guarda o arquivo.
 */
export const DANFE_GENERATOR_VERSION = "4";

const X = PAGE.margin;
const TOP = PAGE.height - PAGE.margin;
const FOOTER = PAGE.margin + 8;
const ADDITIONAL_HEIGHT = 84;
const ITEM_SIZE = 6;
const ITEM_LINE = 7;
const TABLE_HEADER = 11;
/** Título "DADOS DOS PRODUTOS / SERVIÇOS": 2 pt de folga e a linha do título. */
const ITEMS_TITLE = 2 + TITLE_HEIGHT;
/** Folga e título de cada seção de continuação. */
const TITLE_GAP = 4 + TITLE_HEIGHT;
const TEXT_LINE = 7.5;
/** Menor área de itens aceita numa folha, em linhas de item. */
const MIN_ITEM_LINES = 3;
/** Linhas de duplicatas (três por linha) e de volumes na folha 1; o resto vai para a continuação. */
const FIRST_DUPLICATE_ROWS = 2;
const FIRST_VOLUME_ROWS = 2;

const CRT: Record<string, string> = {
  "1": "1 - SIMPLES NACIONAL",
  "2": "2 - SIMPLES NACIONAL - EXCESSO DE SUBLIMITE",
  "3": "3 - REGIME NORMAL",
  "4": "4 - SIMPLES NACIONAL - MEI",
};
const FREIGHT: Record<string, string> = {
  "0": "0 - Remetente (CIF)",
  "1": "1 - Destinatário (FOB)",
  "2": "2 - Terceiros",
  "3": "3 - Próprio, remetente",
  "4": "4 - Próprio, destinatário",
  "9": "9 - Sem transporte",
};
const TP_EMIS: Record<string, string> = {
  "2": "contingência FS-IA",
  "3": "contingência SCAN",
  "4": "contingência EPEC",
  "5": "contingência FS-DA",
  "6": "contingência SVC-AN",
  "7": "contingência SVC-RS",
  "9": "contingência off-line da NFC-e",
};

/** Colunas do quadro de produtos no modelo retrato da NT 2026.010 (larguras em pontos). */
const COLUMNS: Array<{ title: string; width: number; align: "left" | "right" }> = [
  { title: "DESCRIÇÃO DO PRODUTO / SERVIÇO", width: 172, align: "left" },
  { title: "CST / CFOP", width: 36, align: "left" },
  { title: "QTD / UN", width: 48, align: "right" },
  { title: "VLR UNIT", width: 52, align: "right" },
  { title: "VLR TOTAL", width: 50, align: "right" },
  { title: "BASES DE CÁLCULO", width: 70, align: "left" },
  { title: "ALÍQUOTAS", width: 64, align: "left" },
  { title: "VALOR DOS TRIBUTOS", width: CONTENT_WIDTH - 492, align: "left" },
];

/** Textos das cinco primeiras colunas. */
function plainCells(item: DanfeItem): string[][] {
  return [
    [
      `${item.code} - ${item.description}`,
      ...(item.extra ? [item.extra] : []),
      [`NCM ${item.ncm}`, item.ibsCbs && `cClassTrib ${item.ibsCbs.classTrib}`]
        .filter(Boolean)
        .join("  "),
    ],
    [`CST ${item.cst}`, `CFOP ${item.cfop}`],
    [formatDecimal(item.quantity, 0), item.unit],
    [formatDecimal(item.unitValue)],
    [formatDecimal(item.total)],
  ];
}

/**
 * Uma faixa por tributo presente no item, com base, alíquota e valor na mesma altura: ICMS
 * sempre; IBS/CBS (três faixas: CBS, IBS UF e IBS MUN, com a base única na primeira), IS e IPI
 * só quando o XML traz o grupo.
 */
function taxSlots(item: DanfeItem): Array<[string, string, string]> {
  const slots: Array<[string, string, string]> = [
    [
      `ICMS ${formatDecimal(item.icms.base)}`,
      `ICMS ${formatPercent(item.icms.rate)}`,
      `ICMS ${formatDecimal(item.icms.value)}`,
    ],
  ];
  const rtc = item.ibsCbs;
  if (rtc)
    slots.push(
      [
        `IBS/CBS ${formatDecimal(rtc.base)}`,
        `CBS ${formatPercent(rtc.rateCbs)}`,
        `CBS ${formatDecimal(rtc.valueCbs)}`,
      ],
      ["", `IBS UF ${formatPercent(rtc.rateUf)}`, `IBS UF ${formatDecimal(rtc.valueUf)}`],
      ["", `IBS MUN ${formatPercent(rtc.rateMun)}`, `IBS MUN ${formatDecimal(rtc.valueMun)}`],
    );
  if (item.is)
    slots.push([
      `IS ${formatDecimal(item.is.base)}`,
      `IS ${formatPercent(item.is.rate)}`,
      `IS ${formatDecimal(item.is.value)}`,
    ]);
  if (item.ipi)
    slots.push([
      `IPI ${formatDecimal(item.ipi.base)}`,
      `IPI ${formatPercent(item.ipi.rate)}`,
      `IPI ${formatDecimal(item.ipi.value)}`,
    ]);
  return slots;
}

type Row = string[][];

function itemRow(item: DanfeItem, fonts: Fonts): Row {
  const fit = (text: string, column: number) =>
    wrap(fonts.safe(text), fonts.regular, ITEM_SIZE, COLUMNS[column]!.width - 3);
  const row: Row = plainCells(item).map((texts, c) => texts.flatMap((text) => fit(text, c)));
  const tax: Row = [[], [], []];
  for (const slot of taxSlots(item)) {
    const lines = slot.map((text, i) => (text ? fit(text, 5 + i) : []));
    const height = Math.max(...lines.map((l) => l.length));
    lines.forEach((l, i) => tax[i]!.push(...l, ...Array<string>(height - l.length).fill("")));
  }
  return [...row, ...tax];
}

const rowHeight = (row: Row) => Math.max(...row.map((lines) => lines.length)) * ITEM_LINE + 3;

/** Texto das marcas de situação, impresso em todas as folhas. */
function banners(data: DanfeData): string[] {
  const status = data.status;
  const lines: string[] = [];
  if (status.kind === "cancelled") {
    lines.push(
      `NF-e CANCELADA - evento de cancelamento registrado sob o protocolo ${status.event.number} ` +
        `em ${formatDateTime(status.event.registeredAt)}. Origem da informação: ${status.origin}.`,
    );
    if ("missing" in status.authorization)
      lines.push(
        `SEM VALOR FISCAL - autorização da NF-e não comprovada: ${status.authorization.missing}.`,
      );
  }
  if (status.kind === "unauthorized")
    lines.push(`SEM VALOR FISCAL - documento não autorizado: ${status.reason}.`);
  if (status.kind === "denied")
    lines.push(
      `NF-e DENEGADA - uso denegado pelo fisco (cStat ${status.cStat}). SEM VALOR FISCAL.`,
    );
  if (status.kind === "conflict") {
    const shown = status.conflicts.slice(0, 3).map((code) => code.slice(0, 60));
    const more = status.conflicts.length - shown.length;
    lines.push(
      `SEM VALOR FISCAL - evidências fiscais em conflito: ${shown.join(", ")}` +
        `${more > 0 ? ` e mais ${more}` : ""}.`,
    );
  }
  if (data.tpAmb === "2") lines.push("SEM VALOR FISCAL - NF-e emitida em ambiente de homologação.");
  return lines;
}

function watermark(data: DanfeData) {
  if (data.status.kind === "cancelled") return "NF-e CANCELADA";
  if (data.status.kind === "denied") return "NF-e DENEGADA";
  if (data.status.kind !== "authorized" || data.tpAmb === "2") return "SEM VALOR FISCAL";
  return null;
}

function protocolText(data: DanfeData) {
  const status = data.status;
  const show = (p: { number: string; receivedAt: string }) =>
    `${p.number} - ${formatDateTime(p.receivedAt)}`;
  if (status.kind === "authorized") return show(status.protocol);
  if (status.kind === "denied") return `DENEGADA - ${show(status.protocol)}`;
  if (status.kind === "cancelled" && !("missing" in status.authorization))
    return show(status.authorization);
  if (status.kind === "conflict") return "SITUAÇÃO EM CONFLITO - SEM VALOR FISCAL";
  return "NÃO AUTORIZADA - SEM PROTOCOLO VÁLIDO";
}

function additionalText(data: DanfeData) {
  const parts: string[] = [];
  if (data.tpAmb === "2") parts.push("NF-e EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL.");
  if (data.tpEmis !== "1")
    parts.push(`Emitida em ${TP_EMIS[data.tpEmis] ?? `contingência (tpEmis ${data.tpEmis})`}.`);
  if (data.additional.fisco) parts.push(`Inf. ao fisco: ${data.additional.fisco}`);
  if (data.additional.complementary) parts.push(data.additional.complementary);
  return parts.join("\n");
}

const money = (label: string, value: string | null, weight = 1): Cell => ({
  label,
  value: formatDecimal(value),
  weight,
  align: "right",
});

function chunk<T>(list: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, i * size + size),
  );
}

function duplicateRows(data: DanfeData): Cell[][] {
  return chunk(data.installments, 3).map((group) =>
    [...group, ...Array<null>(3 - group.length).fill(null)].flatMap((dup): Cell[] => [
      { label: "DUPLICATA", value: dup?.number ?? "", weight: 1 },
      {
        label: "VENCIMENTO",
        value: dup ? splitDateTime(dup.due).date : "",
        weight: 1,
        align: "center",
      },
      money("VALOR", dup?.value ?? null),
    ]),
  );
}

function volumeRows(data: DanfeData): Cell[][] {
  return data.transport.volumes.map((vol): Cell[] => [
    { label: "QUANTIDADE", value: vol.quantity ?? "", weight: 1, align: "right" },
    { label: "ESPÉCIE", value: vol.species ?? "", weight: 1.5 },
    { label: "MARCA", value: vol.brand ?? "", weight: 1.5 },
    { label: "NUMERAÇÃO", value: vol.numbering ?? "", weight: 1.5 },
    { label: "PESO BRUTO", value: formatDecimal(vol.gross, 3), weight: 1.2, align: "right" },
    { label: "PESO LÍQUIDO", value: formatDecimal(vol.net, 3), weight: 1.2, align: "right" },
  ]);
}

/** Seção que continua depois dos itens: linhas de texto ou linhas de campos. */
type Flow =
  | { title: string; kind: "text"; units: string[] }
  | { title: string; kind: "cells"; units: Cell[][] };

const flowUnit = (flow: Flow) => (flow.kind === "text" ? TEXT_LINE : CELL_HEIGHT);
const flowPadding = (flow: Flow) => (flow.kind === "text" ? 4 : 0);
const overflow = (): never => fail("DANFE_LAYOUT_OVERFLOW");

/**
 * Gera o DANFE A4 retrato da NF-e modelo 55 a partir do XML original. Função pura e
 * determinística: o mesmo XML e as mesmas evidências dão os mesmos bytes.
 *
 * A situação impressa vem da verificação que a importação usa (`processNfe` e
 * `deriveFiscalSituation`): sem assinatura XML válida, protocolo completo da mesma chave e
 * ambiente e `digVal` igual ao digest assinado, a nota sai com "SEM VALOR FISCAL". A assinatura
 * é conferida contra o certificado embutido; a cadeia ICP-Brasil não é verificada. `xml` pode ser
 * o texto ou os bytes preservados; os bytes são o que a verificação recebe.
 */
export async function renderDanfe(
  xml: string | Uint8Array,
  evidence: DanfeEvidence = {},
): Promise<Uint8Array> {
  const data = readNfeForDanfe(xml, evidence);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`DANFE ${data.key}`);
  doc.setLanguage("pt-BR");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold, safe: encoder(regular) };
  const marks = banners(data).flatMap((line) => wrap(fonts.safe(line), bold, 7, CONTENT_WIDTH - 4));
  const bannerHeight = marks.length ? marks.length * 8.5 + 3 : 0;

  const rows = data.items.map((item) => itemRow(item, fonts));
  const additionalLines = additionalText(data)
    .split("\n")
    .flatMap((paragraph) => wrap(fonts.safe(paragraph), regular, 6.5, CONTENT_WIDTH * 0.7 - 4));
  const firstCapacity = Math.floor((ADDITIONAL_HEIGHT - 9 - 8) / TEXT_LINE);
  const duplicates = duplicateRows(data);
  const volumes = volumeRows(data);
  const split = {
    duplicates: FIRST_DUPLICATE_ROWS,
    volumes: FIRST_VOLUME_ROWS,
  };
  const flows: Flow[] = [
    {
      title: "FATURA / DUPLICATAS (CONTINUAÇÃO)",
      kind: "cells",
      units: duplicates.slice(split.duplicates),
    },
    {
      title: "VOLUMES TRANSPORTADOS (CONTINUAÇÃO)",
      kind: "cells",
      units: volumes.slice(split.volumes),
    },
    {
      title: "DADOS ADICIONAIS (CONTINUAÇÃO)",
      kind: "text",
      units: additionalLines.slice(firstCapacity),
    },
  ];

  // Altura dos quadros fixos: medida desenhando numa página descartável.
  const scratch = await PDFDocument.create({ updateMetadata: false });
  const scratchFonts: Fonts = {
    regular: await scratch.embedFont(StandardFonts.Helvetica),
    bold: await scratch.embedFont(StandardFonts.HelveticaBold),
    safe: fonts.safe,
  };
  const probe = scratch.addPage([PAGE.width, PAGE.height]);
  const draw = { data, marks, bannerHeight, duplicates, volumes, split };
  const firstBlocksBottom = drawFirstPageBlocks(probe, scratchFonts, draw, 1, 1);
  const nextBlocksBottom = drawHeaderBlocks(probe, scratchFonts, draw, TOP, 1, 1);

  // Áreas úteis. Uma folha que não comporta nem as linhas mínimas recusa o documento em vez de
  // paginar sem fim.
  const firstArea =
    firstBlocksBottom - ITEMS_TITLE - TABLE_HEADER - (FOOTER + ADDITIONAL_HEIGHT + 4);
  const nextItemsArea = nextBlocksBottom - ITEMS_TITLE - TABLE_HEADER - (FOOTER + 4);
  const nextFlowArea = nextBlocksBottom - (FOOTER + 4);
  if (Math.min(firstArea, nextItemsArea) < MIN_ITEM_LINES * ITEM_LINE + 3) overflow();

  type Segment = { flow: Flow; units: Array<string | Cell[]> };
  const pages: Array<{ rows: Row[]; segments: Segment[] }> = [{ rows: [], segments: [] }];
  let room = firstArea;
  let fresh = true;
  const newPage = (area: number) => {
    pages.push({ rows: [], segments: [] });
    room = area;
    fresh = true;
  };
  for (const row of rows) {
    let pending = row;
    while (pending.some((lines) => lines.length)) {
      const height = rowHeight(pending);
      if (height <= room) {
        pages.at(-1)!.rows.push(pending);
        room -= height;
        fresh = false;
        break;
      }
      const fit = Math.floor((room - 3) / ITEM_LINE);
      if (fit < MIN_ITEM_LINES || height <= nextItemsArea) {
        if (fresh && fit < MIN_ITEM_LINES) overflow();
        newPage(nextItemsArea);
        continue;
      }
      // Item maior que a folha: as linhas seguem na próxima.
      const head = pending.map((lines) => lines.slice(0, fit));
      pages.at(-1)!.rows.push(head);
      pending = pending.map((lines) => lines.slice(fit));
      newPage(nextItemsArea);
    }
  }
  for (const flow of flows) {
    let pending: Array<string | Cell[]> = flow.units;
    while (pending.length) {
      const fit = Math.floor((room - TITLE_GAP - flowPadding(flow)) / flowUnit(flow));
      if (fit < 1) {
        if (fresh) overflow();
        newPage(nextFlowArea);
        continue;
      }
      const units = pending.slice(0, fit);
      pages.at(-1)!.segments.push({ flow, units });
      room -= TITLE_GAP + flowPadding(flow) + units.length * flowUnit(flow);
      fresh = false;
      pending = pending.slice(fit);
    }
  }

  const total = pages.length;
  pages.forEach((plan, index) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const sheet = index + 1;
    const blocksBottom =
      sheet === 1
        ? drawFirstPageBlocks(page, fonts, draw, sheet, total)
        : drawHeaderBlocks(page, fonts, draw, TOP, sheet, total);
    const areaBottom = sheet === 1 ? FOOTER + ADDITIONAL_HEIGHT + 4 : FOOTER + 4;
    let y = blocksBottom;
    const mark = watermark(data);
    if (mark) drawWatermark(page, fonts, mark, (blocksBottom + areaBottom) / 2);
    if (plan.rows.length || sheet === 1) y = drawItems(page, fonts, y, plan.rows);
    for (const segment of plan.segments) {
      y -= 4;
      y -= drawTitle(page, fonts, X, y, segment.flow.title);
      if (segment.flow.kind === "cells") {
        for (const cells of segment.units as Cell[][])
          y -= drawCells(page, fonts, X, y, CONTENT_WIDTH, cells);
        continue;
      }
      const height = segment.units.length * TEXT_LINE + 4;
      page.drawRectangle({
        x: X,
        y: y - height,
        width: CONTENT_WIDTH,
        height,
        borderColor: INK,
        borderWidth: 0.5,
      });
      (segment.units as string[]).forEach((line, i) =>
        page.drawText(line, {
          x: X + 2,
          y: y - 7 - i * TEXT_LINE,
          size: 6.5,
          font: regular,
          color: INK,
        }),
      );
      y -= height;
    }
    if (sheet === 1)
      drawAdditional(
        page,
        fonts,
        additionalLines.slice(0, firstCapacity),
        additionalLines.length > firstCapacity,
      );
    page.drawText(
      fonts.safe(
        `DANFE gerado pela freecorpsNFE a partir do XML original da NF-e (gerador versão ${DANFE_GENERATOR_VERSION}). ` +
          "O DANFE é representação auxiliar e não substitui o XML.",
      ),
      { x: X, y: PAGE.margin, size: 5, font: regular, color: MUTED },
    );
  });
  return doc.save({ useObjectStreams: false });
}

function drawWatermark(page: PDFPage, fonts: Fonts, text: string, centerY: number) {
  const size = 54;
  const angle = (35 * Math.PI) / 180;
  const width = fonts.bold.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: PAGE.width / 2 - (width / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
    y: centerY - (width / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
    size,
    font: fonts.bold,
    color: ALERT,
    opacity: 0.15,
    rotate: degrees(35),
  });
}

function drawItems(page: PDFPage, fonts: Fonts, top: number, rows: Row[]) {
  let y = top - 2;
  y -= drawTitle(page, fonts, X, y, "DADOS DOS PRODUTOS / SERVIÇOS");
  const tableTop = y;
  let x = X;
  for (const column of COLUMNS) {
    page.drawText(fonts.safe(column.title), {
      x: x + 1.5,
      y: y - 6,
      size: 5,
      font: fonts.bold,
      color: INK,
    });
    x += column.width;
  }
  y -= TABLE_HEADER;
  page.drawLine({
    start: { x: X, y },
    end: { x: X + CONTENT_WIDTH, y },
    thickness: 0.5,
    color: INK,
  });
  for (const row of rows) {
    x = X;
    row.forEach((lines, c) => {
      const column = COLUMNS[c]!;
      lines.forEach((line, i) => {
        if (!line) return;
        const width = textWidth(line, fonts.regular, ITEM_SIZE);
        page.drawText(line, {
          x: column.align === "right" ? x + column.width - 1.5 - width : x + 1.5,
          y: y - 6.5 - i * ITEM_LINE,
          size: ITEM_SIZE,
          font: fonts.regular,
          color: INK,
        });
      });
      x += column.width;
    });
    y -= rowHeight(row);
    page.drawLine({
      start: { x: X, y },
      end: { x: X + CONTENT_WIDTH, y },
      thickness: 0.3,
      color: rgb(0.6, 0.6, 0.6),
    });
  }
  page.drawRectangle({
    x: X,
    y,
    width: CONTENT_WIDTH,
    height: tableTop - y,
    borderColor: INK,
    borderWidth: 0.5,
  });
  x = X;
  for (const column of COLUMNS.slice(0, -1)) {
    x += column.width;
    page.drawLine({ start: { x, y: tableTop }, end: { x, y }, thickness: 0.5, color: INK });
  }
  return y;
}

function drawAdditional(page: PDFPage, fonts: Fonts, lines: string[], continues: boolean) {
  const top = FOOTER + ADDITIONAL_HEIGHT;
  drawTitle(page, fonts, X, top, "DADOS ADICIONAIS");
  const boxTop = top - 9;
  const height = ADDITIONAL_HEIGHT - 9;
  const left = CONTENT_WIDTH * 0.7;
  drawCells(
    page,
    fonts,
    X,
    boxTop,
    CONTENT_WIDTH,
    [
      { label: "INFORMAÇÕES COMPLEMENTARES", value: "", weight: 7 },
      { label: "RESERVADO AO FISCO", value: "", weight: 3 },
    ],
    height,
  );
  lines.forEach((line, i) =>
    page.drawText(line, {
      x: X + 2,
      y: boxTop - 13 - i * TEXT_LINE,
      size: 6.5,
      font: fonts.regular,
      color: INK,
    }),
  );
  if (continues)
    page.drawText(fonts.safe("(continua em DADOS ADICIONAIS (CONTINUAÇÃO))"), {
      x: X + left - 4 - textWidth("(continua em DADOS ADICIONAIS (CONTINUAÇÃO))", fonts.bold, 5.5),
      y: boxTop - height + 2,
      size: 5.5,
      font: fonts.bold,
      color: INK,
    });
}

interface DrawContext {
  data: DanfeData;
  marks: string[];
  bannerHeight: number;
  duplicates: Cell[][];
  volumes: Cell[][];
  split: { duplicates: number; volumes: number };
}

/** Quadros que se repetem em todas as folhas: emitente, DANFE, chave, natureza e inscrições. */
function drawHeaderBlocks(
  page: PDFPage,
  fonts: Fonts,
  context: DrawContext,
  top: number,
  sheet: number,
  total: number,
) {
  const { data, marks, bannerHeight } = context;
  const { regular, bold, safe } = fonts;
  const height = 112;
  const leftW = CONTENT_WIDTH * 0.39;
  const midW = CONTENT_WIDTH * 0.19;
  const rightW = CONTENT_WIDTH - leftW - midW;
  const box = (x: number, w: number, h = height, y = top) =>
    page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: INK, borderWidth: 0.5 });
  const text = (value: string, x: number, y: number, size: number, font = regular, color = INK) =>
    page.drawText(value, { x, y, size, font, color });
  const centered = (value: string, x: number, w: number, y: number, size: number, font = regular) =>
    text(value, x + (w - font.widthOfTextAtSize(value, size)) / 2, y, size, font);

  // Emitente
  box(X, leftW);
  text(safe("IDENTIFICAÇÃO DO EMITENTE"), X + 2, top - 7, 5, bold);
  let y = top - 22;
  // Nome em até três linhas e endereço no espaço que sobra no quadro, diminuindo o corpo antes
  // de cortar; o que ainda não couber termina em "…".
  const name = wrap(safe(data.emitter.name), bold, 10, leftW - 8);
  if (name.length > 3) name.splice(2, name.length - 2, ellipsize(name[2]!, bold, 10, leftW - 8));
  for (const line of name) {
    centered(line, X, leftW, y, 10, bold);
    y -= 12;
  }
  y -= 4;
  const address = [
    data.emitter.street,
    [data.emitter.district, data.emitter.cep && `CEP ${formatCep(data.emitter.cep)}`]
      .filter(Boolean)
      .join(" - "),
    `${data.emitter.city} - ${data.emitter.uf}`,
    data.emitter.phone ? `Fone: ${formatPhone(data.emitter.phone)}` : "",
  ];
  const room = y - (top - height + 4) + 7;
  let size = 7;
  let lines: string[] = [];
  for (; size >= 5; size -= 0.5) {
    lines = address.filter(Boolean).flatMap((l) => wrap(safe(l), regular, size, leftW - 8));
    if (lines.length * (size + 2) <= room) break;
  }
  size = Math.max(size, 5);
  const capacity = Math.floor(room / (size + 2));
  if (lines.length > capacity)
    lines.splice(
      capacity - 1,
      lines.length,
      ellipsize(lines[capacity - 1]!, regular, size, leftW - 8),
    );
  for (const line of lines) {
    centered(line, X, leftW, y, size);
    y -= size + 2;
  }

  // DANFE, entrada/saída, número, série e folha
  const mx = X + leftW;
  box(mx, midW);
  centered("DANFE", mx, midW, top - 17, 14, bold);
  wrap(safe("DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA"), regular, 6.5, midW - 8).forEach(
    (line, i) => centered(line, mx, midW, top - 27 - i * 7.5, 6.5),
  );
  text("0 - ENTRADA", mx + 8, top - 52, 6.5);
  text(safe("1 - SAÍDA"), mx + 8, top - 61, 6.5);
  page.drawRectangle({
    x: mx + midW - 28,
    y: top - 64,
    width: 16,
    height: 16,
    borderColor: INK,
    borderWidth: 0.7,
  });
  centered(safe(data.tpNF), mx + midW - 28, 16, top - 60, 10, bold);
  centered(safe(`Nº ${formatNumber(data.number)}`), mx, midW, top - 80, 8.5, bold);
  centered(safe(`SÉRIE ${formatSeries(data.series)}`), mx, midW, top - 91, 8, bold);
  centered(safe(`FOLHA ${sheet}/${total}`), mx, midW, top - 102, 8, bold);

  // Código de barras, chave e consulta
  const rx = mx + midW;
  box(rx, rightW, 42);
  drawBarcode(page, data.key, rx + 4, top - 38, rightW - 8, 32);
  box(rx, rightW, 22, top - 42);
  text("CHAVE DE ACESSO", rx + 2, top - 48, 5, bold);
  centered(formatKey(data.key), rx, rightW, top - 60, 8, bold);
  box(rx, rightW, 48, top - 64);
  wrap(
    safe(
      "Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora",
    ),
    regular,
    7,
    rightW - 12,
  ).forEach((line, i) => centered(line, rx, rightW, top - 80 - i * 9, 7));

  y = top - height;
  if (marks.length) {
    marks.forEach((line, i) => text(line, X + 2, y - 8 - i * 8.5, 7, bold, ALERT));
    y -= bannerHeight;
  }
  const protocol = protocolText(data);
  y -= drawCells(page, fonts, X, y, CONTENT_WIDTH, [
    { label: "NATUREZA DA OPERAÇÃO", value: data.natOp, weight: 6 },
    {
      label: "PROTOCOLO DE AUTORIZAÇÃO DE USO",
      value: protocol,
      weight: 4,
      align: "center",
      bold: true,
    },
  ]);
  y -= drawCells(page, fonts, X, y, CONTENT_WIDTH, [
    { label: "INSCRIÇÃO ESTADUAL", value: data.emitter.ie ?? "", weight: 2 },
    { label: "INSC. ESTADUAL DO SUBST. TRIBUTÁRIO", value: data.emitter.ieSt ?? "", weight: 2 },
    { label: "CNPJ / CPF", value: formatDocument(data.emitter.document), weight: 2 },
    {
      label: "CÓDIGO DO REGIME TRIBUTÁRIO",
      value: data.crt ? (CRT[data.crt] ?? data.crt) : "",
      weight: 2.6,
    },
    { label: "TIPO DE REGIME DE APURAÇÃO DO IBS E DA CBS", value: "", weight: 2.4 },
  ]);
  return y;
}

/** Folha 1: canhoto, cabeçalho e os quadros de destinatário, cobrança, totais e transporte. */
function drawFirstPageBlocks(
  page: PDFPage,
  fonts: Fonts,
  context: DrawContext,
  sheet: number,
  total: number,
) {
  const { data, duplicates, volumes, split } = context;
  const { safe, regular, bold } = fonts;
  // Canhoto
  const stubW = CONTENT_WIDTH * 0.82;
  page.drawRectangle({
    x: X,
    y: TOP - 22,
    width: stubW,
    height: 22,
    borderColor: INK,
    borderWidth: 0.5,
  });
  wrap(
    safe(
      `RECEBEMOS DE ${data.emitter.name} OS PRODUTOS/SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO`,
    ),
    regular,
    6,
    stubW - 4,
  )
    .flatMap((line, i, all) =>
      i > 1 ? [] : i === 1 && all.length > 2 ? [ellipsize(line, regular, 6, stubW - 4)] : [line],
    )
    .forEach((line, i) =>
      page.drawText(line, { x: X + 2, y: TOP - 8 - i * 7, size: 6, font: regular, color: INK }),
    );
  drawCells(
    page,
    fonts,
    X,
    TOP - 22,
    stubW,
    [
      { label: "DATA DE RECEBIMENTO", value: "", weight: 1 },
      { label: "IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR", value: "", weight: 3 },
    ],
    22,
  );
  const sx = X + stubW;
  const sw = CONTENT_WIDTH - stubW;
  page.drawRectangle({
    x: sx,
    y: TOP - 44,
    width: sw,
    height: 44,
    borderColor: INK,
    borderWidth: 0.5,
  });
  const center = (value: string, y: number, size: number) =>
    page.drawText(value, {
      x: sx + (sw - bold.widthOfTextAtSize(value, size)) / 2,
      y,
      size,
      font: bold,
      color: INK,
    });
  center("NF-e", TOP - 13, 11);
  center(safe(`Nº ${formatNumber(data.number)}`), TOP - 26, 8);
  center(safe(`SÉRIE ${formatSeries(data.series)}`), TOP - 37, 8);
  for (let x = X; x < X + CONTENT_WIDTH; x += 6)
    page.drawLine({
      start: { x, y: TOP - 49 },
      end: { x: x + 3, y: TOP - 49 },
      thickness: 0.5,
      color: INK,
    });

  let y = drawHeaderBlocks(page, fonts, context, TOP - 54, sheet, total);
  const W = CONTENT_WIDTH;
  const section = (title: string, rows: Cell[][]) => {
    y -= drawTitle(page, fonts, X, y, title);
    for (const cells of rows) y -= drawCells(page, fonts, X, y, W, cells);
  };
  const money = (label: string, value: string | null, weight = 1): Cell => ({
    label,
    value: formatDecimal(value),
    weight,
    align: "right",
  });

  const r = data.recipient;
  const issued = splitDateTime(data.issuedAt);
  const moved = splitDateTime(data.movedAt);
  section("DESTINATÁRIO / REMETENTE", [
    [
      { label: "NOME / RAZÃO SOCIAL", value: r?.name ?? "", weight: 5 },
      { label: "CNPJ / CPF", value: formatDocument(r?.document ?? null), weight: 2 },
      { label: "DATA DA EMISSÃO", value: issued.date, weight: 1.3, align: "center" },
    ],
    [
      { label: "ENDEREÇO", value: r?.street ?? "", weight: 4 },
      { label: "BAIRRO / DISTRITO", value: r?.district ?? "", weight: 2 },
      { label: "CEP", value: formatCep(r?.cep ?? null), weight: 1 },
      { label: "DATA DA SAÍDA / ENTRADA", value: moved.date, weight: 1.3, align: "center" },
    ],
    [
      { label: "MUNICÍPIO", value: r?.city ?? "", weight: 3 },
      { label: "FONE / FAX", value: formatPhone(r?.phone ?? null), weight: 1.5 },
      { label: "UF", value: r?.uf ?? "", weight: 0.5, align: "center" },
      { label: "INSCRIÇÃO ESTADUAL", value: r?.ie ?? "", weight: 2 },
      { label: "HORA DA SAÍDA / ENTRADA", value: moved.time, weight: 1.3, align: "center" },
    ],
  ]);

  if (data.invoice || duplicates.length) {
    const rows: Cell[][] = [];
    if (data.invoice)
      rows.push([
        { label: "FATURA", value: data.invoice.number ?? "", weight: 1 },
        money("VALOR ORIGINAL", data.invoice.original),
        money("DESCONTO", data.invoice.discount),
        money("VALOR LÍQUIDO", data.invoice.net),
      ]);
    rows.push(...duplicates.slice(0, split.duplicates));
    const shown = Math.min(data.installments.length, split.duplicates * 3);
    section(
      shown < data.installments.length
        ? `FATURA / DUPLICATAS (${shown} de ${data.installments.length}; as demais em FATURA / DUPLICATAS (CONTINUAÇÃO))`
        : "FATURA / DUPLICATAS",
      rows,
    );
  }

  const t = data.totals;
  section("TOTAL DOS PRODUTOS E TOTAL DA NOTA", [
    [
      money("VALOR TOTAL DOS PRODUTOS", t.vProd!),
      money("VALOR DO FRETE", t.vFrete!),
      money("VALOR DO SEGURO", t.vSeg!),
      money("DESCONTO", t.vDesc!),
      money("OUTRAS DESPESAS ACESSÓRIAS", t.vOutro!),
      { ...money("VALOR TOTAL DA NOTA", t.vNF!), bold: true },
    ],
  ]);
  const icms: Cell[] = [
    money("BASE DE CÁLCULO DO ICMS", t.vBC!),
    money("VALOR DO ICMS", t.vICMS!),
    money("BASE DE CÁLCULO DO ICMS ST", t.vBCST!),
    money("VALOR DO ICMS ST", t.vST!),
    money("VALOR DO IPI", t.vIPI!),
  ];
  // Campos de exibição condicionada (NT 2026.010, 4.4): só quando a tag existe no XML.
  for (const [field, label] of [
    ["vFCP", "VALOR DO FCP"],
    ["vFCPST", "VALOR DO FCP RETIDO POR ST"],
    ["vICMSUFDest", "VALOR DO DIFAL NA UF DE DESTINO"],
    ["vFCPUFDest", "VALOR DO FCP NA UF DE DESTINO"],
    ["qBCMono", "BC DO ICMS MONOFÁSICO"],
    ["vICMSMono", "VALOR DO ICMS MONOFÁSICO"],
    ["qBCMonoReten", "BC DO ICMS MONOFÁSICO POR RETENÇÃO"],
    ["vICMSMonoReten", "VALOR DO ICMS MONOFÁSICO POR RETENÇÃO"],
  ] as const)
    if (t[field] !== null) icms.push(money(label, t[field]!));
  section("TOTAL DO ICMS / IPI", chunk(icms, 7));

  if (data.ibsCbsTotals) {
    const v = data.ibsCbsTotals;
    const cells = [
      money("VALOR DA CBS", v.vCBS!),
      money("VALOR DO IBS UF", v.vIBSUF!),
      money("VALOR DO IBS MUNICÍPIO", v.vIBSMun!),
      money("VALOR DO IMPOSTO SELETIVO", v.vIS!),
    ];
    if (data.hasMonophase)
      cells.push(
        money("VALOR DO IBS MONOFÁSICO", v.vIBSMono!),
        money("VALOR DA CBS MONOFÁSICA", v.vCBSMono!),
        money("VALOR DO IBS MONOFÁSICO POR RETENÇÃO", v.vIBSMonoReten!),
        money("VALOR DA CBS MONOFÁSICA POR RETENÇÃO", v.vCBSMonoReten!),
      );
    section("TOTAL DO IBS / CBS / IS", chunk(cells, 4));
  }

  if (data.issqn)
    section("CÁLCULO DO ISSQN", [
      [
        { label: "INSCRIÇÃO MUNICIPAL", value: data.issqn.im ?? "", weight: 1 },
        money("VALOR TOTAL DOS SERVIÇOS", data.issqn.services),
        money("BASE DE CÁLCULO DO ISSQN", data.issqn.base),
        money("VALOR DO ISSQN", data.issqn.value),
      ],
    ]);

  const { carrier, vehicle } = data.transport;
  const shownVolumes = Math.min(volumes.length, split.volumes);
  section(
    shownVolumes < volumes.length
      ? `TRANSPORTADOR / VOLUMES TRANSPORTADOS (${shownVolumes} de ${volumes.length} volumes; os demais em VOLUMES TRANSPORTADOS (CONTINUAÇÃO))`
      : "TRANSPORTADOR / VOLUMES TRANSPORTADOS",
    [
      [
        { label: "RAZÃO SOCIAL", value: carrier?.name ?? "", weight: 4 },
        {
          label: "FRETE POR CONTA",
          value: FREIGHT[data.transport.modFrete] ?? data.transport.modFrete,
          weight: 2.2,
        },
        { label: "CÓDIGO ANTT", value: vehicle?.rntc ?? "", weight: 1.3 },
        { label: "PLACA DO VEÍCULO", value: vehicle?.plate ?? "", weight: 1.3 },
        { label: "UF", value: vehicle?.uf ?? "", weight: 0.5, align: "center" },
        { label: "CNPJ / CPF", value: formatDocument(carrier?.document ?? null), weight: 2.2 },
      ],
      [
        { label: "ENDEREÇO", value: carrier?.address ?? "", weight: 5.5 },
        { label: "MUNICÍPIO", value: carrier?.city ?? "", weight: 3 },
        { label: "UF", value: carrier?.uf ?? "", weight: 0.5, align: "center" },
        { label: "INSCRIÇÃO ESTADUAL", value: carrier?.ie ?? "", weight: 2.5 },
      ],
      ...volumes.slice(0, split.volumes),
    ],
  );
  return y;
}
