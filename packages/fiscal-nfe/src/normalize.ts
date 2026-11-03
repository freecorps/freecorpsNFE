import policy from "./schema-policy.json" with { type: "json" };
import { decimal, type ExactDecimal } from "@freecorps/fiscal-core";
import {
  NORMALIZER_VERSION,
  PARSER_VERSION,
  type DeclaredTaxField,
  type NormalizedNfe,
  type NormalizedTaxField,
  type ParsedNfe,
} from "./types.js";
import { fail } from "./xml.js";

/** Field scales come from the pinned NF-e XSDs; conversion never rounds declared values. */
export const FIELD_SCALES = { amount: 2, quantity: 4, unitPrice: 10, taxRate: 4 } as const;
function optional(value: string | null, maximumScale: number): ExactDecimal | null {
  return value === null ? null : exact(value, maximumScale);
}
function exact(value: string, maximumScale: number): ExactDecimal {
  const result = decimal(value);
  if (result.scale > maximumScale) return fail("NORMALIZATION_SCALE_EXCEEDED");
  return result;
}
const decimalFields: Record<string, { scale: number; xsdType: string }> = policy.decimalFields;
function taxes(fields: DeclaredTaxField[], group: "imposto" | "total"): NormalizedTaxField[] {
  return fields.map((field) => ({
    ...field,
    value:
      field.representation === "decimal"
        ? exact(
            field.value,
            decimalFields[group + "." + field.path.replace(/\[\d+\]/g, "")]?.scale ?? -1,
          )
        : field.value,
  }));
}
/** Creates a separate model. Parsing structures and original bytes are never mutated. */
export function normalizeNfe(parsed: ParsedNfe): NormalizedNfe {
  if (
    parsed.metadata.versions.parser !== PARSER_VERSION ||
    parsed.metadata.versions.normalizer !== null
  )
    return fail("NORMALIZATION_INPUT_UNSUPPORTED");
  const result = structuredClone(parsed),
    doc = result.document;
  result.metadata.versions.normalizer = NORMALIZER_VERSION;
  if (doc.kind === "invoice")
    return {
      metadata: result.metadata,
      document: {
        ...doc,
        total: exact(doc.total, FIELD_SCALES.amount),
        totals: taxes(doc.totals, "total"),
        // NT 2026.008: vProdLiqTot and vICMSPrevisto are 13v2, vUnComLiq 11v0-10, like vUnCom.
        nt2026008: { vProdLiqTot: optional(doc.nt2026008.vProdLiqTot, FIELD_SCALES.amount) },
        products: doc.products.map((item) => ({
          ...item,
          quantity: exact(item.quantity, FIELD_SCALES.quantity),
          unitPrice: exact(item.unitPrice, FIELD_SCALES.unitPrice),
          total: exact(item.total, FIELD_SCALES.amount),
          tributaryQuantity: exact(item.tributaryQuantity, FIELD_SCALES.quantity),
          tributaryUnitPrice: exact(item.tributaryUnitPrice, FIELD_SCALES.unitPrice),
          nt2026008: {
            vUnComLiq: optional(item.nt2026008.vUnComLiq, FIELD_SCALES.unitPrice),
            vProdLiq: optional(item.nt2026008.vProdLiq, FIELD_SCALES.amount),
            vICMSPrevisto: optional(item.nt2026008.vICMSPrevisto, FIELD_SCALES.amount),
          },
          taxes: taxes(item.taxes, "imposto"),
        })),
      },
    };
  if (doc.kind === "summary")
    return {
      metadata: result.metadata,
      document: { ...doc, total: exact(doc.total, FIELD_SCALES.amount) },
    };
  return { metadata: result.metadata, document: doc };
}
