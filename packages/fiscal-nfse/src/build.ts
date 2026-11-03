import { DPS_LAYOUT_DEFAULT, assembleDps, type BuiltXml, type DpsInput } from "./dps.js";
import { assertSchema } from "./schema.js";

/**
 * Monta a DPS sem assinatura e a confere no XSD oficial 1.01 do leiaute
 * escolhido (`input.layout`, ausente o de produção). Desvio do
 * esquema lança `NfseError` `DPS_SCHEMA_INVALID`, antes de assinar ou enviar:
 * o fisco recusaria o lote inteiro com L9999. Mesma entrada, mesmos bytes.
 */
export function buildDps(input: DpsInput): BuiltXml {
  const built = assembleDps(input);
  assertSchema(built.xml, "DPS", input.layout ?? DPS_LAYOUT_DEFAULT);
  return built;
}
