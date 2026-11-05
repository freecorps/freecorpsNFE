export type MarkupLimits = { readonly depth: number; readonly nodes: number };

/**
 * Conta profundidade e elementos antes de um parser tocar o XML, numa passada
 * só. Comentários e CDATA não contam; `<!` e `<?` também não. Cada caractere é
 * lido uma vez: um regex que recomeçava em cada `<` depois de uma falha ficava
 * quadrático com milhares de aberturas sem fechamento ou de aspas abertas.
 *
 * Devolve `"malformed"` para o que nenhum XML bem formado tem (seção ou tag sem
 * fechamento, `<` dentro de tag fora de aspas, tag sem nome) e `"limit"` quando
 * a profundidade ou o número de elementos passa do limite.
 */
export function scanMarkup(xml: string, limits: MarkupLimits): "malformed" | "limit" | null {
  let depth = 0,
    nodes = 0;
  for (let at = xml.indexOf("<"); at >= 0;) {
    let end: number;
    if (xml.startsWith("<!--", at)) {
      end = sectionEnd(xml, at + 4, "-->");
    } else if (xml.startsWith("<![CDATA[", at)) {
      end = sectionEnd(xml, at + 9, "]]>");
    } else if (xml[at + 1] === "!" || xml[at + 1] === "?") {
      end = at + 1;
    } else {
      const closing = xml[at + 1] === "/";
      end = tagEnd(xml, closing ? at + 2 : at + 1);
      if (end < 0) return "malformed";
      if (closing) depth--;
      else {
        nodes++;
        if (xml[end - 2] !== "/") depth++;
      }
      if (depth > limits.depth || nodes > limits.nodes) return "limit";
    }
    if (end < 0) return "malformed";
    at = xml.indexOf("<", end);
  }
  return null;
}

function sectionEnd(xml: string, from: number, close: string): number {
  const at = xml.indexOf(close, from);
  return at < 0 ? -1 : at + close.length;
}

// Posição logo depois do `>` da tag cujo nome começa em `from`, ou -1.
function tagEnd(xml: string, from: number): number {
  if (from >= xml.length || /[\s<>!?/]/u.test(xml[from]!)) return -1;
  for (let at = from + 1; at < xml.length; at++) {
    const c = xml[at];
    if (c === ">") return at + 1;
    if (c === "<") return -1;
    if (c === '"' || c === "'") {
      at = xml.indexOf(c, at + 1);
      if (at < 0) return -1;
    }
  }
  return -1;
}
