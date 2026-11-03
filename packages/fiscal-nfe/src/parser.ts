import policy from "./schema-policy.json" with { type: "json" };
import { createHash } from "node:crypto";
import { decimal } from "@freecorps/fiscal-core";
import {
  assertUniqueIds,
  child,
  children,
  decodeXml,
  descendants,
  dom,
  fail,
  LIMITS,
  NFE_NS,
  required,
  text,
  value,
} from "./xml.js";
import {
  PARSER_VERSION,
  type DeclaredTaxField,
  type EventReceipt,
  type NfeModel,
  type ParsedNfe,
  type Party,
  type PaymentLink,
  type Protocol,
  type Source,
} from "./types.js";

/**
 * Accepted event types and the pinned package holding each `e<type>_v1.00.xsd` detail schema.
 * The RTC types are the supplier's (`tpAutor` 1) events of NT 2025.002 that concern the buyer;
 * 110300 is the issuer's link of the NF-e to a payment transaction (NT 2026.006), whose detail
 * ships in the Evento/ folder of PL_010g. The decision for every other type is in
 * docs/plataforma/NFE-SCHEMAS.md.
 */
export const EVENT_SCHEMAS = {
  "110111": "cancellation-1.01",
  "110110": "correction-1.01",
  "210200": "manifestation-1.01",
  "210210": "manifestation-1.01",
  "210220": "manifestation-1.01",
  "210240": "manifestation-1.01",
  "112110": "rtc-events-1.40",
  "112120": "rtc-events-1.40",
  "112130": "rtc-events-1.40",
  "112140": "rtc-events-1.40",
  "112150": "rtc-events-1.40",
  "110300": "nfe-4.00-010g",
} as const;
type EventType = keyof typeof EVENT_SCHEMAS;
const MANIFESTATIONS: readonly string[] = ["210200", "210210", "210220", "210240"];
function supportedEvent(type: string): type is EventType {
  return Object.hasOwn(EVENT_SCHEMAS, type);
}
/** Pinned package with the detail schema of an accepted event type; `null` for any other type. */
export function eventSchemaPackage(type: string): string | null {
  return supportedEvent(type) ? EVENT_SCHEMAS[type] : null;
}
const decimalFields: Record<string, { scale: number; xsdType: string }> = policy.decimalFields;
const numberPattern = /^\d+$/;
function checked(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) return fail("XML_FIELD_INVALID", field);
  return value;
}
export function environment(node: Element): "1" | "2" {
  const result = text(node, "tpAmb");
  if (result !== "1" && result !== "2") return fail("XML_FIELD_INVALID", "tpAmb");
  return result;
}
function decimalField(node: Element, name: string): string {
  const result = text(node, name);
  try {
    decimal(result);
  } catch {
    return fail("XML_DECIMAL_INVALID", name);
  }
  if (result.startsWith("-")) return fail("XML_DECIMAL_INVALID", name);
  return result;
}
function optionalDecimal(node: Element | null, name: string): string | null {
  return node && child(node, name, true) ? decimalField(node, name) : null;
}
function dateField(node: Element, name: string): string {
  const result = text(node, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    return fail("XML_FIELD_INVALID", name);
  const [year, month, day] = result.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day
  )
    return fail("XML_FIELD_INVALID", name);
  return result;
}
/** Official codes keep their declared text; only the shape of a code is checked here. */
function code(node: Element, name: string, pattern: RegExp): string | null {
  const result = value(node, name, true);
  return result === null ? null : checked(result, pattern, name);
}
function party(node: Element): Party {
  const cnpj = value(node, "CNPJ", true),
    cpf = value(node, "CPF", true);
  if ((!cnpj && !cpf) || (cnpj && cpf)) return fail("XML_FIELD_INVALID", "participant");
  return {
    kind: cnpj ? "CNPJ" : "CPF",
    document: cnpj ?? cpf!,
    name: value(node, "xNome", true),
    stateRegistration: value(node, "IE", true),
  };
}
/** Representation of a generic field that the schema policy does not type as decimal. */
export function undeclaredRepresentation(name: string): "code" | "text" {
  return /^(CST|CSOSN|orig|c[A-Z]|modBC)/.test(name) ? "code" : "text";
}
function fields(node: Element): DeclaredTaxField[] {
  const result: DeclaredTaxField[] = [];
  const walk = (element: Element, prefix: string) => {
    const counts = new Map<string, number>();
    const elements = children(element);
    const totals = new Map<string, number>();
    for (const item of elements) totals.set(item.localName, (totals.get(item.localName) ?? 0) + 1);
    for (const elementChild of elements) {
      const name = elementChild.localName;
      const index = counts.get(name) ?? 0;
      counts.set(name, index + 1);
      const siblings = totals.get(name)!;
      const path = prefix + name + (siblings > 1 ? `[${index}]` : "");
      if (children(elementChild).length) walk(elementChild, path + ".");
      else {
        const declared = elementChild.textContent ?? "";
        const representation = decimalFields[node.localName + "." + path.replace(/\[\d+\]/g, "")]
          ? "decimal"
          : undeclaredRepresentation(name);
        if (representation === "decimal") {
          try {
            decimal(declared);
          } catch {
            return fail("XML_DECIMAL_INVALID", "tax");
          }
        }
        result.push({ path, value: declared, representation });
      }
    }
  };
  walk(node, "");
  return result;
}
type Supported = (node: Element, names: string[], path: string) => void;
/** `gPgto/@nPag` of PL_010g: 1 to 990, no leading zero. */
const paymentNumber = /^(?:[1-9]\d?|[1-8]\d{2}|9[0-8]\d|990)$/;
/**
 * `gPgto/@idTransacao`: `TStringRTC` (U+0020 to U+00FF, no space at either end) with 2 to 35
 * characters, the XSD restriction written as one expression.
 */
const transactionId = /^[\u0021-\u00FF][\u0020-\u00FF]{0,33}[\u0021-\u00FF]$/;
/**
 * NT 2026.006 `gPgtoVinc`, read as declared text. Shapes follow `TPgtoVinc` of PL_010g. The
 * uniqueness of `nPag` and `idTransacao` is not checked: the PL_010g `xs:unique` selects no
 * element (unprefixed selector in a qualified layout), and NT rules are not evaluated here.
 */
function paymentLinks(node: Element, supported: Supported) {
  const payments = children(node, "gPgto");
  if (payments.length > 99) return fail("XML_LIMIT_EXCEEDED", "gPgto");
  supported(node, ["gPgto"], "infNFe.gPgtoVinc");
  return payments.map((payment): PaymentLink => {
    supported(payment, ["tpMeioPgto", "CNPJReceb", "CNPJBasePSP"], "infNFe.gPgtoVinc.gPgto");
    return {
      nPag: checked(payment.getAttribute("nPag") ?? "", paymentNumber, "nPag"),
      idTransacao: checked(payment.getAttribute("idTransacao") ?? "", transactionId, "idTransacao"),
      tpMeioPgto: checked(text(payment, "tpMeioPgto"), /^\d{2}$/, "tpMeioPgto"),
      CNPJReceb: checked(text(payment, "CNPJReceb"), /^[A-Z0-9]{12}\d{2}$/, "CNPJReceb"),
      CNPJBasePSP: checked(text(payment, "CNPJBasePSP"), /^[A-Z0-9]{8}$/, "CNPJBasePSP"),
    };
  });
}
function protocol(node: Element): Protocol {
  return {
    key: text(node, "chNFe"),
    environment: environment(node),
    status: text(node, "cStat"),
    number: value(node, "nProt", true),
    receivedAt: value(node, "dhRecbto", true),
    digest: value(node, "digVal", true),
  };
}
function receipt(node: Element): EventReceipt {
  return {
    key: text(node, "chNFe"),
    environment: environment(node),
    type: text(node, "tpEvento"),
    sequence: text(node, "nSeqEvento"),
    status: text(node, "cStat"),
    number: value(node, "nProt", true),
    registeredAt: value(node, "dhRegEvento", true),
  };
}
/** Parse supported NF-e structures; original bytes remain the complete source. No normalization here. */
export function parseNfeModel(bytes: Uint8Array, source: Source = "imported-xml"): ParsedNfe {
  if (!["imported-xml", "distribution-xml", "synthetic"].includes(source))
    return fail("XML_SOURCE_INVALID");
  const xml = decodeXml(bytes),
    root = dom(xml).documentElement;
  if (root.namespaceURI !== NFE_NS) return fail("XML_NAMESPACE_UNSUPPORTED");
  assertUniqueIds(root);
  const unsupported = new Set<string>();
  const supported: Supported = (node, names, path) => {
    for (const item of Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1)) {
      if (item.namespaceURI === "http://www.w3.org/2000/09/xmldsig#") continue;
      if (item.namespaceURI !== NFE_NS || !names.includes(item.localName)) {
        // Names are diagnostic paths, never arbitrary XML values.
        unsupported.add(path + "." + item.localName.slice(0, 80));
      }
    }
  };
  let document: NfeModel, schema: { id: string; version: string; package: string };
  if (root.localName === "NFe" || root.localName === "nfeProc") {
    const nfe = root.localName === "NFe" ? root : required(root, "NFe");
    const info = required(nfe, "infNFe"),
      ide = required(info, "ide"),
      emit = required(info, "emit");
    if (
      info.getAttribute("versao") !== "4.00" ||
      (root.localName === "nfeProc" && root.getAttribute("versao") !== "4.00")
    )
      return fail("XML_SCHEMA_UNSUPPORTED");
    if (text(ide, "mod") !== "55") return fail("XML_MODEL_UNSUPPORTED");
    const key = checked(
      info.getAttribute("Id") ?? "",
      /^NFe[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/,
      "Id",
    ).slice(3);
    const detail = children(info, "det");
    if (!detail.length || detail.length > LIMITS.items) return fail("XML_LIMIT_EXCEEDED", "det");
    const items = new Set<string>();
    const dest = child(info, "dest", true),
      total = required(info, "total"),
      paymentLink = child(info, "gPgtoVinc", true);
    const protocolRoot = root.localName === "nfeProc" ? child(root, "protNFe", true) : null;
    supported(nfe, ["infNFe"], "NFe");
    if (root.localName === "nfeProc") supported(root, ["NFe", "protNFe"], "nfeProc");
    if (protocolRoot)
      supported(
        required(protocolRoot, "infProt"),
        ["chNFe", "tpAmb", "cStat", "nProt", "dhRecbto", "digVal"],
        "protNFe.infProt",
      );
    supported(info, ["ide", "emit", "dest", "det", "total", "gPgtoVinc"], "infNFe");
    supported(emit, ["CNPJ", "CPF", "xNome", "IE"], "infNFe.emit");
    supported(
      ide,
      [
        "cUF",
        "cNF",
        "natOp",
        "mod",
        "serie",
        "nNF",
        "dhEmi",
        "tpEmis",
        "cDV",
        "tpAmb",
        "finNFe",
        "tpNFDebito",
        "tpNFCredito",
      ],
      "infNFe.ide",
    );
    if (dest) supported(dest, ["CNPJ", "CPF", "xNome", "IE"], "infNFe.dest");
    document = {
      kind: "invoice",
      key,
      environment: environment(ide),
      number: checked(text(ide, "nNF"), /^\d{1,9}$/, "nNF"),
      series: checked(text(ide, "serie"), /^\d{1,3}$/, "serie"),
      issuedAt: dateField(ide, "dhEmi"),
      operation: text(ide, "natOp"),
      purpose: {
        code: code(ide, "finNFe", /^\d$/),
        creditType: code(ide, "tpNFCredito", /^\d{2}$/),
        debitType: code(ide, "tpNFDebito", /^\d{2}$/),
      },
      issuer: party(emit),
      recipient: dest ? party(dest) : null,
      total: decimalField(required(total, "ICMSTot"), "vNF"),
      totals: fields(total),
      nt2026008: { vProdLiqTot: optionalDecimal(total, "vProdLiqTot") },
      nt2026006: { gPgtoVinc: paymentLink ? paymentLinks(paymentLink, supported) : null },
      products: detail.map((det) => {
        const product = required(det, "prod"),
          taxes = child(det, "imposto", true);
        const item = checked(det.getAttribute("nItem") ?? "", /^[1-9]\d{0,2}$/, "nItem");
        const icms = taxes ? child(taxes, "ICMS", true) : null,
          advance = icms ? child(icms, "ICMSPrevistoPagtoAntecip", true) : null;
        if (items.has(item)) return fail("XML_DUPLICATE_ITEM");
        items.add(item);
        supported(det, ["prod", "imposto"], `infNFe.det[${item}]`);
        supported(
          product,
          [
            "cProd",
            "xProd",
            "NCM",
            "CFOP",
            "CEST",
            "xPed",
            "nItemPed",
            "uCom",
            "qCom",
            "vUnCom",
            "vProd",
            "vUnComLiq",
            "vProdLiq",
            "uTrib",
            "qTrib",
            "vUnTrib",
          ],
          `infNFe.det[${item}].prod`,
        );
        return {
          item,
          code: text(product, "cProd"),
          description: text(product, "xProd"),
          ncm: text(product, "NCM"),
          cfop: text(product, "CFOP"),
          cest: value(product, "CEST", true),
          purchaseOrder: value(product, "xPed", true),
          purchaseOrderItem: value(product, "nItemPed", true),
          unit: text(product, "uCom"),
          quantity: decimalField(product, "qCom"),
          unitPrice: decimalField(product, "vUnCom"),
          total: decimalField(product, "vProd"),
          tributaryUnit: text(product, "uTrib"),
          tributaryQuantity: decimalField(product, "qTrib"),
          tributaryUnitPrice: decimalField(product, "vUnTrib"),
          nt2026008: {
            vUnComLiq: optionalDecimal(product, "vUnComLiq"),
            vProdLiq: optionalDecimal(product, "vProdLiq"),
            vICMSPrevisto: optionalDecimal(advance, "vICMSPrevisto"),
          },
          taxes: taxes ? fields(taxes) : [],
        };
      }),
      protocol: protocolRoot ? protocol(required(protocolRoot, "infProt")) : null,
    };
    schema = { id: root.localName, version: "4.00", package: "nfe-4.00-010g" };
  } else if (root.localName === "resNFe") {
    if (root.getAttribute("versao") !== "1.01") return fail("XML_SCHEMA_UNSUPPORTED");
    document = {
      kind: "summary",
      key: text(root, "chNFe"),
      issuer: party(root),
      issuedAt: dateField(root, "dhEmi"),
      total: decimalField(root, "vNF"),
      status: text(root, "cSitNFe"),
      protocolNumber: text(root, "nProt"),
      receivedAt: dateField(root, "dhRecbto"),
      digest: value(root, "digVal", true),
    };
    schema = { id: "resNFe", version: "1.01", package: "distribution-1.04" };
    supported(
      root,
      [
        "chNFe",
        "CNPJ",
        "CPF",
        "xNome",
        "IE",
        "dhEmi",
        "vNF",
        "cSitNFe",
        "nProt",
        "dhRecbto",
        "digVal",
      ],
      "resNFe",
    );
  } else if (root.localName === "evento" || root.localName === "procEventoNFe") {
    if (root.getAttribute("versao") !== "1.00") return fail("XML_SCHEMA_UNSUPPORTED");
    const event = root.localName === "evento" ? root : required(root, "evento");
    const info = required(event, "infEvento"),
      detail = required(info, "detEvento");
    const type = text(info, "tpEvento");
    if (
      !supportedEvent(type) ||
      text(info, "verEvento") !== "1.00" ||
      event.getAttribute("versao") !== "1.00"
    )
      return fail("XML_EVENT_UNSUPPORTED");
    const reply = root.localName === "procEventoNFe" ? child(root, "retEvento", true) : null;
    document = {
      kind: "event",
      key: text(info, "chNFe"),
      environment: environment(info),
      author: party(info),
      type,
      sequence: checked(text(info, "nSeqEvento"), /^[1-9]\d?$/, "nSeqEvento"),
      occurredAt: dateField(info, "dhEvento"),
      description: text(detail, "descEvento"),
      cancellation:
        type === "110111"
          ? { protocolNumber: text(detail, "nProt"), reason: text(detail, "xJust") }
          : null,
      correction:
        type === "110110"
          ? { text: text(detail, "xCorrecao"), conditions: text(detail, "xCondUso") }
          : null,
      manifestation: MANIFESTATIONS.includes(type)
        ? { reason: value(detail, "xJust", true) }
        : null,
      receipt: reply ? receipt(required(reply, "infEvento")) : null,
    };
    supported(
      info,
      [
        "CNPJ",
        "CPF",
        "chNFe",
        "tpAmb",
        "tpEvento",
        "nSeqEvento",
        "dhEvento",
        "verEvento",
        "detEvento",
      ],
      "infEvento",
    );
    // Only what the typed model reads counts as supported: the protocol of a 110300 is the
    // linked NF-e's, kept in the XML like the rest of that detail.
    supported(
      detail,
      [
        "descEvento",
        ...(type === "110111" ? ["nProt", "xJust"] : []),
        ...(type === "110110" ? ["xCorrecao", "xCondUso"] : []),
        ...(MANIFESTATIONS.includes(type) ? ["xJust"] : []),
      ],
      "infEvento.detEvento",
    );
    supported(event, ["infEvento"], "evento");
    if (root.localName === "procEventoNFe")
      supported(root, ["evento", "retEvento"], "procEventoNFe");
    if (reply)
      supported(
        required(reply, "infEvento"),
        ["chNFe", "tpAmb", "tpEvento", "nSeqEvento", "cStat", "nProt", "dhRegEvento"],
        "retEvento.infEvento",
      );
    schema = { id: root.localName, version: "1.00", package: "events-1.00-alphanumeric" };
  } else if (root.localName === "resEvento") {
    if (root.getAttribute("versao") !== "1.01") return fail("XML_SCHEMA_UNSUPPORTED");
    const type = text(root, "tpEvento");
    if (!supportedEvent(type)) return fail("XML_EVENT_UNSUPPORTED");
    document = {
      kind: "event-summary",
      key: text(root, "chNFe"),
      author: party(root),
      type,
      sequence: checked(text(root, "nSeqEvento"), numberPattern, "nSeqEvento"),
      occurredAt: dateField(root, "dhEvento"),
      description: text(root, "xEvento"),
      protocolNumber: text(root, "nProt"),
      registeredAt: dateField(root, "dhRecbto"),
    };
    supported(
      root,
      [
        "CNPJ",
        "CPF",
        "chNFe",
        "tpEvento",
        "nSeqEvento",
        "dhEvento",
        "xEvento",
        "nProt",
        "dhRecbto",
      ],
      "resEvento",
    );
    schema = { id: "resEvento", version: "1.01", package: "distribution-1.04" };
  } else return fail("XML_SCHEMA_UNSUPPORTED");
  // Foreign namespaces inside the document cannot silently masquerade as a supported NF-e field.
  for (const element of descendants(root)) {
    if (
      element.namespaceURI !== NFE_NS &&
      element.namespaceURI !== "http://www.w3.org/2000/09/xmldsig#"
    )
      unsupported.add("foreign-namespace");
  }
  return {
    metadata: {
      model: "55",
      source,
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      versions: {
        parser: PARSER_VERSION,
        normalizer: null,
        schema: { ...schema, catalogSha256: policy.catalogSha256 },
      },
      unsupportedFields: [...unsupported].sort(),
    },
    document,
  };
}
