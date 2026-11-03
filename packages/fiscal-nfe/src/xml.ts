import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { XmlDocument, ParseOption } from "libxml2-wasm";

export const NFE_NS = "http://www.portalfiscal.inf.br/nfe";
export const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
export const LIMITS = { bytes: 2 * 1024 * 1024, depth: 64, nodes: 50_000, items: 990 } as const;
export class NfeError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, field: string | null = null) {
    super(code);
    this.name = "NfeError";
    this.code = code;
    this.field = field;
  }
}
export function fail(code: string, field: string | null = null): never {
  throw new NfeError(code, field);
}
export const parseOptions = {
  option:
    ParseOption.XML_PARSE_NO_XXE |
    ParseOption.XML_PARSE_NONET |
    ParseOption.XML_PARSE_NO_SYS_CATALOG |
    ParseOption.XML_PARSE_NOERROR |
    ParseOption.XML_PARSE_NOWARNING,
};
export function decodeXml(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) return fail("XML_INPUT_INVALID");
  if (bytes.byteLength > LIMITS.bytes) return fail("XML_TOO_LARGE");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("XML_ENCODING_INVALID");
  }
  const encoding = /^\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
  if (encoding && !/^utf-8$/i.test(encoding)) return fail("XML_ENCODING_UNSUPPORTED");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return fail("XML_UNSAFE");
  if (/<\?(?!xml\s)/i.test(xml)) return fail("XML_PROCESSING_INSTRUCTION_UNSUPPORTED");
  let depth = 0,
    nodes = 0;
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const m of markup.matchAll(/<\/?[^!?/\s<>](?:[^"'<>]|"[^"]*"|'[^']*')*>/gu)) {
    const tag = m[0];
    if (tag.startsWith("</")) depth--;
    else {
      nodes++;
      if (!tag.endsWith("/>")) depth++;
    }
    if (depth > LIMITS.depth || nodes > LIMITS.nodes) return fail("XML_LIMIT_EXCEEDED");
  }
  let doc: XmlDocument | undefined;
  try {
    doc = XmlDocument.fromString(xml, parseOptions);
  } catch {
    return fail("XML_MALFORMED");
  } finally {
    doc?.dispose();
  }
  return xml;
}
export function dom(xml: string): Document {
  let bad = false;
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {
        bad = true;
      },
      error: () => {
        bad = true;
      },
      fatalError: () => {
        bad = true;
      },
    },
  }).parseFromString(xml, "application/xml");
  if (bad || !doc.documentElement) return fail("XML_MALFORMED");
  return doc;
}
export function children(node: Element, local?: string, ns = NFE_NS): Element[] {
  return Array.from(node.childNodes).filter(
    (n): n is Element =>
      n.nodeType === 1 &&
      (n as Element).namespaceURI === ns &&
      (!local || (n as Element).localName === local),
  );
}
export function child(node: Element, local: string, optional = false): Element | null {
  const found = children(node, local);
  if (found.length > 1 || (!optional && !found.length)) return fail("XML_FIELD_INVALID", local);
  return found[0] ?? null;
}
export function required(node: Element, local: string): Element {
  return child(node, local)!;
}
export function value(node: Element, local: string, optional = false): string | null {
  const found = child(node, local, optional);
  if (!found) return null;
  if (Array.from(found.childNodes).some((n) => n.nodeType === 1))
    return fail("XML_FIELD_INVALID", local);
  const text = found.textContent ?? "";
  if (!text || text.length > 10_000) return fail("XML_FIELD_INVALID", local);
  return text;
}
export function text(node: Element, local: string): string {
  return value(node, local)!;
}
export function serialize(node: Node): string {
  return new XMLSerializer().serializeToString(node);
}
export function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.getElementsByTagName("*"))];
}
export function assertUniqueIds(root: Element) {
  const seen = new Set<string>();
  for (const node of descendants(root)) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.localName?.toLowerCase() !== "id") continue;
      if (!attribute.value || seen.has(attribute.value)) return fail("XML_DUPLICATE_ID");
      seen.add(attribute.value);
    }
  }
}
