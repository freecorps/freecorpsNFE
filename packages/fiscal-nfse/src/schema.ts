/**
 * Validação contra os XSD oficiais da NFS-e nacional, com o mesmo mecanismo de `@freecorps/fiscal-nfe`: libxml2-wasm
 * e um catálogo offline (`schemas.json`), gerado por
 * `scripts/sync-nfse-schemas.py` a partir dos originais em `schemas/`. São dois
 * pacotes do Portal NFS-e: o de produção (v1.01-20260209) e o da produção restrita
 * de 20/10/2026, com o leiaute da NT 009; `DpsLayout` escolhe qual. Nada é
 * baixado em runtime. O catálogo distribuído traz os originais intactos (CC BY-ND
 * 3.0, decisão de 20/10/2026); só ao carregar, em memória, o BOM sai e o padrão de
 * `TSSerieDPS` perde as âncoras que o manifesto registra.
 */
import {
  ParseOption,
  XmlBufferInputProvider,
  XmlDocument,
  XmlValidateError,
  XsdValidator,
  xmlRegisterInputProvider,
} from "libxml2-wasm";
import { fail } from "./errors.js";
import schemas from "./schemas.json" with { type: "json" };

import { DPS_LAYOUT_DEFAULT, type DpsLayout } from "./dps.js";

/** Pacote do leiaute padrão (produção); o da produção restrita é `DpsLayout`. */
export const NFSE_SCHEMA_PACKAGE: DpsLayout = DPS_LAYOUT_DEFAULT;

// Prefixo próprio: fiscal-nfe registra o seu catálogo no mesmo processo.
const base = "https://schemas.freecorps.invalid/nfse/";
// XSD regular expressions are implicitly anchored and have no ^/$ metacharacters
// (XML Schema Part 2, appendix F). The official TSSerieDPS writes them anyway; libxml2
// reads them as literals and would refuse every series.
const serieOriginal = '<xs:pattern value="^0{0,4}\\d{1,5}$"/>';
const serieLoaded = '<xs:pattern value="0{0,4}\\d{1,5}"/>';
// Spelled by code point: formatters may turn an escaped BOM into the invisible character.
const BOM = String.fromCharCode(0xfeff);
/** The in-memory copy libxml2 compiles; the distributed catalog keeps the original. */
export function loadSchemaText(path: string, original: string): string {
  const text = original.startsWith(BOM) ? original.slice(1) : original;
  if (path !== `${NFSE_SCHEMA_PACKAGE}/tiposSimples_v1.01.xsd`) return text;
  if (text.split(serieOriginal).length !== 2) throw new Error("TSSerieDPS fora do original");
  return text.replace(serieOriginal, serieLoaded);
}
const catalog: Record<string, string> = Object.fromEntries(
  Object.entries(schemas as Record<string, string>).map(([path, xml]) => [
    path,
    loadSchemaText(path, xml),
  ]),
);
xmlRegisterInputProvider(
  new XmlBufferInputProvider(
    Object.fromEntries(
      Object.entries(catalog).map(([path, xml]) => [base + path, new TextEncoder().encode(xml)]),
    ),
  ),
);

const parseOptions = {
  option:
    ParseOption.XML_PARSE_NO_XXE |
    ParseOption.XML_PARSE_NONET |
    ParseOption.XML_PARSE_NO_SYS_CATALOG |
    ParseOption.XML_PARSE_NOERROR |
    ParseOption.XML_PARSE_NOWARNING,
};

type Root = "DPS" | "pedRegEvento";
const entrypoints: Record<Root, string> = {
  DPS: "DPS_v1.01.xsd",
  pedRegEvento: "pedRegEvento_v1.01.xsd",
};
// Compilado uma vez por processo e pacote; o esquema é imutável.
const validators = new Map<string, XsdValidator>();
function validatorFor(root: Root, layout: DpsLayout): XsdValidator {
  const path = `${layout}/${entrypoints[root]}`;
  let validator = validators.get(path);
  if (!validator) {
    const schema = XmlDocument.fromString(catalog[path]!, { ...parseOptions, url: base + path });
    try {
      validator = XsdValidator.fromDoc(schema);
    } finally {
      schema.dispose();
    }
    validators.set(path, validator);
  }
  return validator;
}

/** Um desvio do XSD: elemento (nome local) e a mensagem do libxml2, sem o namespace. */
export interface SchemaIssue {
  element: string | null;
  message: string;
  line: number | null;
}

export type SchemaResult = { valid: true } | { valid: false; issues: SchemaIssue[] };

const NAMESPACED = /\{[^}]*\}/g;
function issueOf(message: string, line: number | null): SchemaIssue {
  const element = /Element '(?:\{[^}]*\})?([^']+)'/.exec(message)?.[1] ?? null;
  return { element, message: message.replace(NAMESPACED, "").trim(), line };
}

function validate(xml: string, root: Root, layout: DpsLayout): SchemaResult {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromString(xml, parseOptions);
  } catch {
    return { valid: false, issues: [{ element: null, message: "XML malformado.", line: null }] };
  }
  try {
    if (doc.root.name !== root)
      return {
        valid: false,
        issues: [{ element: doc.root.name, message: `Raiz esperada: ${root}.`, line: null }],
      };
    validatorFor(root, layout).validate(doc);
    return { valid: true };
  } catch (error) {
    if (!(error instanceof XmlValidateError)) throw error;
    return {
      valid: false,
      issues: error.details.map((detail) => issueOf(detail.message, detail.line ?? null)),
    };
  } finally {
    doc.dispose();
  }
}

/** DPS (assinada ou não, com ou sem prolog) contra `DPS_v1.01.xsd` do pacote do leiaute. */
export function validateDpsXml(xml: string, layout: DpsLayout = DPS_LAYOUT_DEFAULT): SchemaResult {
  return validate(xml, "DPS", layout);
}

/** Pedido de registro de evento contra `pedRegEvento_v1.01.xsd` do pacote do leiaute. */
export function validatePedRegEventoXml(
  xml: string,
  layout: DpsLayout = DPS_LAYOUT_DEFAULT,
): SchemaResult {
  return validate(xml, "pedRegEvento", layout);
}

/** Usado na montagem: recusa localmente, antes de assinar e de qualquer envio. */
export function assertSchema(
  xml: string,
  root: Root,
  layout: DpsLayout = DPS_LAYOUT_DEFAULT,
): void {
  const result = validate(xml, root, layout);
  if (result.valid) return;
  const [first] = result.issues;
  const where = first?.element ? ` em ${first.element}` : "";
  fail(
    root === "DPS" ? "DPS_SCHEMA_INVALID" : "EVENT_SCHEMA_INVALID",
    `${root === "DPS" ? "DPS" : "Pedido de evento"} em desacordo com o XSD oficial ` +
      `${layout}${where}: ${first?.message ?? "erro sem detalhe"}`,
  );
}
