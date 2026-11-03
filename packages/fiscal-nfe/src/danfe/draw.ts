import { rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { code128Bars } from "./code128.js";

/** Medidas em pontos (1/72 pol.). A4 retrato. */
export const PAGE = { width: 595.28, height: 841.89, margin: 14 } as const;
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
export const INK = rgb(0, 0, 0);
export const MUTED = rgb(0.3, 0.3, 0.3);
export const ALERT = rgb(0.75, 0.1, 0.1);
/** Altura padrão de um campo: rótulo em cima, valor embaixo. */
export const CELL_HEIGHT = 19;
export const TITLE_HEIGHT = 9;
export const LABEL_SIZE = 5;
export const VALUE_SIZE = 7.5;
/** Menor corpo aceito ao encolher um valor longo para caber no campo. */
const MIN_SIZE = 4.5;

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Troca o que a fonte padrão (WinAnsi) não codifica por "?" e controles por espaço. */
  safe: (value: string) => string;
}

export function encoder(font: PDFFont) {
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

const widths = new WeakMap<PDFFont, Map<string, number>>();

/**
 * Largura de um texto somando a de cada caractere, guardada por fonte. É a largura desenhada:
 * o pdf-lib não aplica kerning ao escrever. Linear no tamanho do texto.
 */
export function textWidth(text: string, font: PDFFont, size: number): number {
  let cache = widths.get(font);
  if (!cache) widths.set(font, (cache = new Map()));
  let total = 0;
  for (const char of text) {
    let width = cache.get(char);
    if (width === undefined) cache.set(char, (width = font.widthOfTextAtSize(char, 1)));
    total += width;
  }
  return total * size;
}

/** Quebra em linhas que cabem em `width`, medindo com a fonte e o corpo dados. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  return breakLines(text, width, (part) => textWidth(part, font, size));
}

/**
 * Quebra em linhas cuja largura, segundo `measure`, cabe em `width`; palavra maior que a linha é
 * cortada caractere a caractere. Cada palavra é medida inteira uma vez e, se for cortada, cada
 * caractere dela mais uma: o custo é linear no tamanho do texto.
 */
export function breakLines(
  text: string,
  width: number,
  measure: (part: string) => number,
): string[] {
  const lines: string[] = [];
  const space = measure(" ");
  for (const paragraph of text.split("\n")) {
    let current = "";
    let currentWidth = 0;
    const push = () => {
      if (current) lines.push(current);
      current = "";
      currentWidth = 0;
    };
    for (const word of paragraph.replace(/\s+/g, " ").trim().split(" ")) {
      if (!word) continue;
      const wordWidth = measure(word);
      if (current && currentWidth + space + wordWidth <= width) {
        current += " " + word;
        currentWidth += space + wordWidth;
        continue;
      }
      push();
      if (wordWidth <= width) {
        current = word;
        currentWidth = wordWidth;
        continue;
      }
      // Palavra maior que a linha: pedaços tão longos quanto couberem, ao menos um caractere.
      for (const char of word) {
        const charWidth = measure(char);
        if (current && currentWidth + charWidth > width) push();
        current += char;
        currentWidth += charWidth;
      }
    }
    push();
  }
  return lines;
}

/** Corta o fim de `text` e acrescenta "…" até caber em `width`. */
export function ellipsize(text: string, font: PDFFont, size: number, width: number): string {
  let chars = Array.from(text);
  while (chars.length && textWidth(chars.join("") + "…", font, size) > width)
    chars = chars.slice(0, -1);
  return chars.join("").trimEnd() + "…";
}

export interface Cell {
  label: string;
  value: string;
  /** Peso na divisão da largura da linha. */
  weight?: number;
  align?: "left" | "right" | "center";
  bold?: boolean;
}

/**
 * Linha de campos com moldura. Um valor longo diminui de corpo até `MIN_SIZE`; se ainda não
 * couber, quebra em duas linhas, e a segunda termina em "…" se faltar espaço. Devolve a altura usada.
 */
export function drawCells(
  page: PDFPage,
  fonts: Fonts,
  x: number,
  top: number,
  width: number,
  cells: Cell[],
  height = CELL_HEIGHT,
) {
  const total = cells.reduce((sum, cell) => sum + (cell.weight ?? 1), 0);
  let left = x;
  for (const cell of cells) {
    const w = (width * (cell.weight ?? 1)) / total;
    page.drawRectangle({
      x: left,
      y: top - height,
      width: w,
      height,
      borderColor: INK,
      borderWidth: 0.5,
    });
    // Rótulo longo em campo estreito diminui de corpo para não invadir o vizinho.
    const label = fonts.safe(cell.label);
    const labelSize = Math.min(
      LABEL_SIZE,
      ((w - 3) / fonts.bold.widthOfTextAtSize(label, 1)) * 0.98,
    );
    page.drawText(label, {
      x: left + 1.5,
      y: top - 6,
      size: labelSize,
      font: fonts.bold,
      color: INK,
    });
    const font = cell.bold ? fonts.bold : fonts.regular;
    const value = fonts.safe(cell.value);
    let size = VALUE_SIZE;
    while (size > MIN_SIZE && font.widthOfTextAtSize(value, size) > w - 3) size -= 0.25;
    let lines =
      font.widthOfTextAtSize(value, size) > w - 3 ? wrap(value, font, size, w - 3) : [value];
    // Último recurso, fora dos tamanhos máximos do leiaute: duas linhas e reticências.
    if (lines.length > 2) lines = [lines[0]!, ellipsize(lines[1]!, font, size, w - 3)];
    lines.forEach((line, index) => {
      const lineWidth = font.widthOfTextAtSize(line, size);
      const dx =
        cell.align === "right"
          ? w - 1.5 - lineWidth
          : cell.align === "center"
            ? (w - lineWidth) / 2
            : 1.5;
      const baseline = lines.length > 1 ? top - 11 - index * (size + 0.5) : top - height + 4;
      page.drawText(line, { x: left + dx, y: baseline, size, font, color: INK });
    });
    left += w;
  }
  return height;
}

export function drawTitle(page: PDFPage, fonts: Fonts, x: number, top: number, title: string) {
  page.drawText(fonts.safe(title), { x, y: top - 7, size: 6, font: fonts.bold, color: INK });
  return TITLE_HEIGHT;
}

/**
 * Código de barras CODE-128 com zona de silêncio de 10 módulos de cada lado. O módulo é a maior
 * largura que cabe em `width`; barras como retângulos vetoriais.
 */
export function drawBarcode(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { bars, modules } = code128Bars(text);
  const unit = width / (modules + 20);
  const start = x + (width - modules * unit) / 2;
  for (const [offset, size] of bars)
    page.drawRectangle({ x: start + offset * unit, y, width: size * unit, height, color: INK });
  return unit;
}
