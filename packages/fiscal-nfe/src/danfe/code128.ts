/**
 * CODE-128 da chave de acesso no DANFE. A chave numérica sai inteira no conjunto C (pares de
 * dígitos). A chave com CNPJ alfanumérico usa o modelo híbrido da NT Conjunta 2025.001, seção 6:
 * começa em C e troca para o conjunto A (código 101) nas letras, voltando a C (código 99) em
 * sequências de quatro dígitos ou mais.
 *
 * Larguras dos 107 símbolos conforme a ISO/IEC 15417 (barra, espaço, barra...). A tabela
 * impressa na NT 2025.001 tem larguras trocadas e não serve de referência; a própria NT remete
 * ao conjunto padrão.
 */
const PATTERNS = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 " +
  "221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 " +
  "221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 " +
  "212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 " +
  "231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
  "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 " +
  "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 " +
  "214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 " +
  "114131 311141 411131 211412 211214 211232 2331112"
).split(" ");

export const CODE128 = { codeC: 99, codeA: 101, startA: 103, startC: 105, stop: 106 } as const;

/** Larguras (em módulos) do símbolo de valor `value`, de 0 a 106. */
export function code128Widths(value: number): number[] {
  const pattern = PATTERNS[value];
  if (pattern === undefined) throw new RangeError("CODE128_VALUE");
  return Array.from(pattern, Number);
}

/** Valor do caractere no conjunto A: ASCII 32..95 → 0..63. */
function setA(char: string) {
  const code = char.charCodeAt(0);
  if (code < 32 || code > 95) throw new RangeError("CODE128_CHAR");
  return code - 32;
}

/**
 * Valores dos símbolos de `text`, com início, dígito verificador (módulo 103) e parada. Aceita
 * dígitos e o conjunto A (letras maiúsculas). Segue as regras de troca da NT 2025.001.
 */
export function code128Values(text: string): number[] {
  if (!/^[0-9A-Z]+$/.test(text)) throw new RangeError("CODE128_CHAR");
  const digitsAt = (from: number) => /^\d*/.exec(text.slice(from))![0].length;
  const values: number[] = [];
  let i = 0;
  let set: "A" | "C";
  if (digitsAt(0) >= 2) {
    set = "C";
    values.push(CODE128.startC);
  } else {
    set = "A";
    values.push(CODE128.startA);
  }
  while (i < text.length) {
    const run = digitsAt(i);
    if (set === "C") {
      if (run >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      // Dígito ímpar no fim da sequência numérica ou letra: muda para A.
      values.push(CODE128.codeA);
      set = "A";
      continue;
    }
    // Conjunto A: volta para C em quatro dígitos ou mais (ou no fim, com dois ou mais e par).
    const toEnd = i + run === text.length;
    if (run >= 4 || (toEnd && run >= 2 && run % 2 === 0)) {
      if (run % 2 === 1) values.push(setA(text[i++]!));
      values.push(CODE128.codeC);
      set = "C";
      continue;
    }
    values.push(setA(text[i++]!));
  }
  const sum = values.reduce((total, value, index) => total + value * (index || 1), 0);
  values.push(sum % 103, CODE128.stop);
  return values;
}

/** Barras como pares [início, largura] em módulos, sem a zona de silêncio. */
export function code128Bars(text: string): { bars: Array<[number, number]>; modules: number } {
  const bars: Array<[number, number]> = [];
  let x = 0;
  for (const value of code128Values(text)) {
    code128Widths(value).forEach((width, index) => {
      if (index % 2 === 0) bars.push([x, width]);
      x += width;
    });
  }
  return { bars, modules: x };
}
