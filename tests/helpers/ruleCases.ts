/**
 * Edge cases of the pure rules shared by the console and the server. The same table runs
 * against the rule itself, the server normalization and the console form, so a divergence on
 * either side fails the test of that side.
 */
export type RuleCase = readonly [value: string, valid: boolean];

export const cpfCases: readonly RuleCase[] = [
  ["52998224725", true],
  ["52998224724", false], // second check digit
  ["52998224715", false], // first check digit
  ["11111111111", false], // repeated digits pass the modulo but are refused
  ["5299822472", false],
  ["529982247250", false],
  ["5299822472A", false],
];

export const calendarDateCases: readonly RuleCase[] = [
  ["2026-02-28", true],
  ["2024-02-29", true],
  ["2025-02-29", false],
  ["2026-02-30", false],
  ["2026-13-01", false],
  ["2026-00-10", false],
  ["2026-1-01", false],
  ["26-01-01", false],
  ["2026-01-01T00:00", false],
];

export const emailCases: readonly RuleCase[] = [
  ["fiscal@prestador.example", true],
  [`${"a".repeat(68)}@empresa.com`, true], // 80 characters
  [`${"a".repeat(69)}@empresa.com`, false], // 81 characters
  ["sem-arroba", false],
  ["nome@dominio", false],
  ["nome @empresa.com", false],
  ["<nome>@empresa.com", false],
  ["nome@empresa.com\u0001", false], // control character: not whitespace, refused anyway
  ["nome@empresa.com\u007f", false],
];

export const municipalityCases: readonly RuleCase[] = [
  ["3550308", true],
  ["5300108", true],
  ["9950308", false], // no state under 99
  ["3450308", false], // 34 is not an IBGE state
  ["355030", false],
  ["35503080", false],
  ["355030A", false],
];

/** LC 116 item as typed → normalized item, or `null` when refused. */
export const lc116Cases: readonly (readonly [string, string | null])[] = [
  ["01.05", "01.05"],
  ["1.05", "01.05"],
  ["0105", "01.05"],
  [" 40.01 ", "40.01"],
  ["41.01", null],
  ["00.05", null],
  ["01.00", null],
  ["1.5", null],
  ["01-05", null],
];

export const amountCases: readonly RuleCase[] = [
  ["0.01", true],
  ["1500.25", true],
  ["9999999999999.99", true],
  ["10000000000000", false], // 14 integer digits
  ["0", false],
  ["0.00", false],
  ["1.234", false],
  ["1e3", false],
  ["-1", false],
];

export const issRateCases: readonly RuleCase[] = [
  ["0.01", true],
  ["2.5", true],
  ["2.0100", true], // 3rd and 4th places only as zeros
  ["5", true],
  ["5.0000", true],
  ["2.0101", false],
  ["5.01", false],
  ["5.0001", false],
  ["0", false],
  ["0.00", false],
  ["6", false],
  ["10", false],
];

export const competenceCases: readonly RuleCase[] = [
  ["2026-10", true],
  ["2026-01", true],
  ["2026-13", false],
  ["2026-00", false],
  ["2026-1", false],
  ["26-10", false],
];
