// Quantities of the Uso e limites screen, in pt-BR. Bytes go through BigInt and integer rounding,
// so a limit shows the same unit and decimal on every machine; no step uses floating point.

const integer = new Intl.NumberFormat("pt-BR");
const units = ["KiB", "MiB", "GiB", "TiB"] as const;

/**
 * `count` and the noun in the right number: "1 reservado", "0 reservados", "3.945 reservados".
 * Not `Intl.PluralRules("pt-BR")`: CLDR puts 0 in the singular for Portuguese ("0 reservado"),
 * which is not how the console writes. Counts here are whole numbers, so only 1 is singular.
 */
export function counted(count: number, one: string, other: string) {
  return `${integer.format(count)} ${count === 1 ? one : other}`;
}

/**
 * Bytes in binary units with one decimal, rounded half up: 9.805 is "9,6 KiB", 1.048.576 is
 * "1 MiB". Below 1 KiB it stays in bytes. The unit only goes up when the rounded value reaches
 * 1.024 of the one below, so 1.048.575 bytes reads "1 MiB", never "1.024 KiB".
 */
export function formatBytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "";
  if (bytes < 1024) return counted(bytes, "byte", "bytes");
  const value = BigInt(bytes);
  let index = 0;
  let size = 1024n;
  while (index < units.length - 1 && value >= size * 1024n) {
    index++;
    size *= 1024n;
  }
  // Tenths of the unit, half up: (value * 10 + size / 2) / size, all integers.
  let tenths = (value * 10n + size / 2n) / size;
  if (tenths >= 10240n && index < units.length - 1) {
    index++;
    size *= 1024n;
    tenths = (value * 10n + size / 2n) / size;
  }
  const whole = tenths / 10n;
  const decimal = tenths % 10n;
  return `${integer.format(whole)}${decimal ? `,${decimal}` : ""} ${units[index]}`;
}

/**
 * Whole percent of the limit used, rounded down: 99,6% reads 99%, so "100% usado" only appears
 * when the limit is really reached. Integers up to 1e12 times 100 stay exact in a double.
 */
export function usedPercent(used: number, limit: number) {
  // A limit of zero blocks every new unit: it is reached from the start.
  if (limit <= 0) return 100;
  return Math.min(100, Math.floor((used * 100) / limit));
}
