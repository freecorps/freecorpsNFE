export { normalizeCnpj } from "./cnpj.js";
export { validCpf } from "./cpf.js";
export {
  accessKeyDigit,
  accessKeyNumber,
  accessKeyStates,
  validateAccessKey,
  type AccessKeyIssuer,
  type AccessKeyParts,
  type AccessKeyReason,
  type AccessKeyResult,
} from "./accessKey.js";
/** Coefficient is serialized as a string: neither JSON nor Convex carries arbitrary BigInt. */
export interface ExactDecimal {
  coefficient: string;
  scale: number;
  declared: string;
}
export type Rounding = "reject" | "truncate" | "half-up" | "half-even";
export function decimal(value: string): ExactDecimal {
  if (!/^-?\d{1,40}(?:\.\d{1,20})?$/.test(value)) throw new Error("DECIMAL_INVALID");
  const [integer, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(integer + fraction).toString(),
    scale: fraction.length,
    declared: value,
  };
}
function parts(value: ExactDecimal) {
  const parsed = decimal(value.declared);
  if (parsed.coefficient !== value.coefficient || parsed.scale !== value.scale)
    throw new Error("DECIMAL_INVALID");
  return BigInt(value.coefficient);
}
function digits(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? "-" : "";
  const value = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  return sign + (scale ? value.slice(0, -scale) + "." + value.slice(-scale) : value);
}
export function quantize(value: ExactDecimal, scale: number, rounding: Rounding): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 20) throw new Error("DECIMAL_SCALE");
  if (!["reject", "truncate", "half-up", "half-even"].includes(rounding))
    throw new Error("DECIMAL_ROUNDING");
  const coefficient = parts(value);
  if (scale >= value.scale) return digits(coefficient * 10n ** BigInt(scale - value.scale), scale);
  const divisor = 10n ** BigInt(value.scale - scale);
  let quotient = coefficient / divisor;
  const remainder = coefficient % divisor;
  const absolute = remainder < 0n ? -remainder : remainder;
  if (rounding === "reject" && remainder !== 0n) throw new Error("DECIMAL_PRECISION_LOSS");
  if (
    (rounding === "half-up" && absolute * 2n >= divisor) ||
    (rounding === "half-even" &&
      (absolute * 2n > divisor || (absolute * 2n === divisor && quotient % 2n !== 0n)))
  )
    quotient += coefficient < 0n ? -1n : 1n;
  return digits(quotient, scale);
}
export function add(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const coefficient =
    parts(left) * 10n ** BigInt(scale - left.scale) +
    parts(right) * 10n ** BigInt(scale - right.scale);
  return decimal(digits(coefficient, scale));
}
/**
 * Produto exato: coeficientes multiplicados em bigint e escalas somadas, sem
 * arredondar. Recusa resultado fora dos limites de `decimal`; arredonde depois
 * com `quantize` e um modo explícito.
 */
export function multiply(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = left.scale + right.scale;
  if (scale > 20) throw new Error("DECIMAL_SCALE");
  return decimal(digits(parts(left) * parts(right), scale));
}
export interface CheckResult {
  status: "passed" | "failed" | "not_checked" | "not_applicable" | "unsupported";
  code: string;
}
export interface ProcessingVersions {
  parser: string;
  normalizer: string | null;
  schema: { id: string; version: string; package: string; catalogSha256: string } | null;
}
