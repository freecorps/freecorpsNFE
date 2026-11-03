import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MAX_XML_BYTES = 2 * 1024 * 1024;
export type XmlErrorCode =
  | "XML_TOO_LARGE"
  | "XML_UNSAFE"
  | "XML_MALFORMED"
  | "XML_UNSUPPORTED"
  | "XML_FIELD_INVALID";
export class FiscalXmlError extends Error {
  readonly code: XmlErrorCode;
  readonly field?: string;
  constructor(code: XmlErrorCode, field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = "FiscalXmlError";
    this.code = code;
    this.field = field;
  }
}
export interface NfeDocument {
  format: "nfe-4.00";
  key: string;
  number: string;
  series: string;
  issuedAt: string;
  issuer: { cnpj: string; name: string };
  total: string;
  items: Array<{
    number: string;
    code: string;
    description: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }>;
  validation: {
    wellFormed: true;
    schema: "not-checked";
    signature: "not-checked";
    authorization: "not-checked";
  };
}
type Node = Record<string, unknown>;
const fail = (code: XmlErrorCode, field?: string): never => {
  throw new FiscalXmlError(code, field);
};
function object(value: unknown, field: string): Node {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("XML_FIELD_INVALID", field);
  return value as Node;
}
function text(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value)))
    return fail("XML_FIELD_INVALID", field);
  return value;
}
const decimal = /^\d{1,30}(?:\.\d{1,10})?$/;

/** Structural extraction only. Strings preserve identifiers and decimal precision. */
export function parseNfe(xml: string): NfeDocument {
  if (typeof xml !== "string") return fail("XML_MALFORMED");
  if (xml.length > MAX_XML_BYTES || new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES)
    return fail("XML_TOO_LARGE");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return fail("XML_UNSAFE");
  // Bound nesting before either parser touches untrusted input.
  let depth = 0,
    nodes = 0;
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const match of markup.matchAll(/<\/?[^!?/\s<>](?:[^"'<>]|"[^"]*"|'[^']*')*>/gu)) {
    const tag = match[0];
    if (tag.startsWith("</")) depth--;
    else {
      nodes++;
      if (!tag.endsWith("/>")) depth++;
    }
    if (depth > 64 || nodes > 50_000) return fail("XML_UNSAFE");
  }
  if (XMLValidator.validate(xml) !== true) return fail("XML_MALFORMED");
  let parsed: Node;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: true,
    }).parse(xml);
  } catch {
    return fail("XML_MALFORMED");
  }
  // Default namespace is supported in this first package; prefixed variants fail explicitly.
  const envelope = parsed.nfeProc ? object(parsed.nfeProc, "nfeProc") : parsed;
  const nfe = object(envelope.NFe, "NFe");
  const namespace = nfe["@_xmlns"] ?? envelope["@_xmlns"];
  if (namespace !== "http://www.portalfiscal.inf.br/nfe")
    return fail("XML_UNSUPPORTED", "namespace");
  const info = object(nfe.infNFe, "infNFe");
  if (info["@_versao"] !== "4.00") return fail("XML_UNSUPPORTED", "version");
  const ide = object(info.ide, "ide"),
    emit = object(info.emit, "emit");
  if (ide.mod !== "55") return fail("XML_UNSUPPORTED", "model");
  const details = Array.isArray(info.det) ? info.det : [info.det];
  if (details.length > 990) return fail("XML_UNSUPPORTED", "items");
  const seen = new Set<string>();
  return {
    format: "nfe-4.00",
    key: text(info["@_Id"], "Id", /^NFe\d{44}$/).slice(3),
    number: text(ide.nNF, "nNF", /^\d{1,9}$/),
    series: text(ide.serie, "serie", /^\d{1,3}$/),
    issuedAt: text(ide.dhEmi, "dhEmi", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
    issuer: {
      cnpj: text(emit.CNPJ, "emit.CNPJ", /^[A-Z0-9]{12}\d{2}$/),
      name: text(emit.xNome, "emit.xNome"),
    },
    total: text(object(object(info.total, "total").ICMSTot, "ICMSTot").vNF, "vNF", decimal),
    items: details.map((value) => {
      const det = object(value, "det"),
        product = object(det.prod, "prod");
      const number = text(det["@_nItem"], "nItem", /^[1-9]\d{0,2}$/);
      if (seen.has(number)) return fail("XML_FIELD_INVALID", "nItem");
      seen.add(number);
      return {
        number,
        code: text(product.cProd, "cProd"),
        description: text(product.xProd, "xProd"),
        quantity: text(product.qCom, "qCom", decimal),
        unitPrice: text(product.vUnCom, "vUnCom", decimal),
        total: text(product.vProd, "vProd", decimal),
      };
    }),
    validation: {
      wellFormed: true,
      schema: "not-checked",
      signature: "not-checked",
      authorization: "not-checked",
    },
  };
}
