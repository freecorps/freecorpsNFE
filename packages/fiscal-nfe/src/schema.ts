import {
  XmlBufferInputProvider,
  XmlDocument,
  XsdValidator,
  xmlRegisterInputProvider,
} from "libxml2-wasm";
import type { CheckResult } from "@freecorps/fiscal-core";
import schemas from "./schemas.json" with { type: "json" };
import { child, dom, parseOptions, required, serialize } from "./xml.js";
import type { ParsedNfe } from "./types.js";
import { eventSchemaPackage } from "./parser.js";

const base = "https://schemas.freecorps.invalid/";
const catalog: Record<string, string> = { ...schemas };
const provider = new XmlBufferInputProvider(
  Object.fromEntries(
    Object.entries(catalog).map(([path, xml]) => [base + path, new TextEncoder().encode(xml)]),
  ),
);
xmlRegisterInputProvider(provider);

// Compilado uma vez por esquema e processo, como em fiscal-nfse; o catálogo é
// imutável. Compilar o XSD custava mais que validar o documento.
const validators = new Map<string, XsdValidator>();
function validatorFor(schemaText: string, path: string): XsdValidator {
  let validator = validators.get(path);
  if (!validator) {
    const schema = XmlDocument.fromString(schemaText, { ...parseOptions, url: base + path });
    try {
      validator = XsdValidator.fromDoc(schema);
    } finally {
      schema.dispose();
    }
    validators.set(path, validator);
  }
  return validator;
}

function validate(xml: string, schemaText: string, path: string): void {
  const validator = validatorFor(schemaText, path);
  const doc = XmlDocument.fromString(xml, parseOptions);
  try {
    validator.validate(doc);
  } finally {
    doc.dispose();
  }
}
export function validateSchema(xml: string, parsed: ParsedNfe): CheckResult {
  const spec = parsed.metadata.versions.schema!;
  let path: string, schemaText: string;
  if (spec.id === "NFe" || spec.id === "nfeProc") {
    path = "nfe-4.00-010g/" + (spec.id === "NFe" ? "nfe_v4.00.xsd" : "procNFe_v4.00.xsd");
    schemaText = catalog[path]!;
  } else if (spec.id === "evento" || spec.id === "procEventoNFe") {
    path =
      "events-1.00-alphanumeric/" +
      (spec.id === "evento" ? "evento_v1.00.xsd" : "procEventoNFe_v1.00.xsd");
    schemaText = catalog[path]!;
  } else {
    path = spec.package + "/" + spec.id + "_v" + spec.version + ".xsd";
    schemaText = catalog[path]!;
  }
  if (!schemaText) return { status: "unsupported", code: "XML_SCHEMA_UNSUPPORTED" };
  try {
    validate(xml, schemaText, path);
    if (parsed.document.kind === "event") {
      const type = parsed.document.type;
      const group = eventSchemaPackage(type);
      const detailPath = `${group}/e${type}_v1.00.xsd`;
      if (!group || !catalog[detailPath])
        return { status: "unsupported", code: "XML_SCHEMA_UNSUPPORTED" };
      const root = dom(xml).documentElement;
      const event = child(root, "evento", true) ?? root;
      const detail = required(required(event, "infEvento"), "detEvento");
      validate(serialize(detail), catalog[detailPath]!, detailPath);
    }
    return { status: "passed", code: "XSD_VALID" };
  } catch {
    return { status: "failed", code: "XSD_INVALID" };
  }
}

export function validateDistributionSchema(xml: string, root: "distDFeInt" | "retDistDFeInt") {
  const path = `distribution-1.04/${root}_v1.01.xsd`;
  try {
    validate(xml, catalog[path]!, path);
  } catch {
    throw new Error("DISTRIBUTION_SCHEMA_INVALID");
  }
}
