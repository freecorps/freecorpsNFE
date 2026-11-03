import { fail } from "./errors.js";

/**
 * Montagem mínima de XML por texto. A ordem dos filhos é a ordem do leiaute
 * (validada pelo XSD do fisco), então o builder só concatena na ordem dada:
 * sem pretty-print, sem prolog — o prolog entra depois da assinatura (E1229).
 */
export type XmlNode = string;

// XML 1.0 recusa controles fora de TAB/LF/CR, U+FFFE/U+FFFF e surrogates
// soltos (no modo `u`, o intervalo de surrogates só casa os desemparelhados).
// O documento ficaria malformado e seria recusado pelo fisco de forma opaca.
// eslint-disable-next-line no-control-regex -- controles são justamente o alvo
const INVALID_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿\uD800-\uDFFF]/u;

function escape(value: string, attribute: boolean): string {
  if (INVALID_XML_CHAR.test(value))
    fail("XML_CHAR_INVALID", "Texto contém caractere não permitido em XML.");
  const text = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return attribute ? text.replaceAll('"', "&quot;") : text;
}

/** Elemento com texto (escapado) ou filhos já montados. `undefined` some. */
export function el(
  name: string,
  content: string | readonly (XmlNode | undefined | false)[],
  attributes: Record<string, string> = {},
): XmlNode {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escape(value, true)}"`)
    .join("");
  const body =
    typeof content === "string"
      ? escape(content, false)
      : content.filter((node): node is XmlNode => typeof node === "string").join("");
  return `<${name}${attrs}>${body}</${name}>`;
}

/** Elemento opcional: some quando o valor não foi informado. */
export const opt = (name: string, value: string | undefined): XmlNode | undefined =>
  value === undefined ? undefined : el(name, value);
