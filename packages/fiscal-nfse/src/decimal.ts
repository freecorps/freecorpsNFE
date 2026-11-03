import {
  decimal,
  multiply,
  quantize,
  type ExactDecimal,
  type Rounding,
} from "@freecorps/fiscal-core";
import { fail } from "./errors.js";

function parse(value: string, field: string): ExactDecimal {
  try {
    const parsed = decimal(value);
    if (parsed.coefficient.startsWith("-")) throw new Error("negative");
    return parsed;
  } catch {
    return fail(
      "DECIMAL_INVALID",
      `${field} deve ser decimal não negativo em texto, como "67.60".`,
    );
  }
}

/**
 * Formata um decimal em texto com a escala do leiaute. Casas além da escala
 * são recusadas (`reject`): o documento não arredonda valores em silêncio.
 */
export function fixed(value: string, scale: number, field: string): string {
  const parsed = parse(value, field);
  try {
    return quantize(parsed, scale, "reject");
  } catch {
    return fail("DECIMAL_PRECISION", `${field} aceita no máximo ${scale} casas decimais.`);
  }
}

/** Valor monetário do leiaute: 2 casas, ponto decimal. */
export const money = (value: string, field: string) => fixed(value, 2, field);

/** Produto exato de dois decimais, arredondado explicitamente na escala pedida. */
export function multiplyRounded(
  left: string,
  right: string,
  scale: number,
  rounding: Rounding,
  fields: [string, string],
): string {
  const product = multiply(parse(left, fields[0]), parse(right, fields[1]));
  return quantize(product, scale, rounding);
}
