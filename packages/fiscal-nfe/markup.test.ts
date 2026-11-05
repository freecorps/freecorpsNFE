import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parseNfe, processNfe } from "./src/index";
import { scanMarkup } from "./src/markup";
import { LIMITS, decodeXml } from "./src/xml";

const encode = (xml: string) => new TextEncoder().encode(xml);
// O limite de bytes cheio de um trecho repetido, dentro de `<a>…</a>`.
const flood = (piece: string) =>
  `<a>${piece.repeat(Math.floor((LIMITS.bytes - 7) / encode(piece).byteLength))}</a>`;

describe("scanMarkup", () => {
  it("counts depth and elements of well-formed markup", () => {
    const limits = { depth: 2, nodes: 3 };
    expect(scanMarkup(`<?xml version="1.0"?><a x='>' y="/>"><b/><c></c></a>`, limits)).toBeNull();
    expect(scanMarkup("<a><b><c/></b></a>", limits)).toBeNull();
    expect(scanMarkup("<a><b><c></c></b></a>", limits)).toBe("limit");
    expect(scanMarkup("<a><b/><b/><b/></a>", limits)).toBe("limit");
  });
  it("ignores tags inside comments and CDATA", () => {
    const hidden = "<a>".repeat(LIMITS.depth + 1);
    const xml = `<r><!--${hidden}<![CDATA[--><![CDATA[${hidden}<!--]]><x/></r>`;
    expect(scanMarkup(xml, LIMITS)).toBeNull();
    expect(decodeXml(encode(xml))).toBe(xml);
    expect(scanMarkup(`<r>${hidden}</r>`, LIMITS)).toBe("limit");
  });
  it("reads a processing instruction up to its first `?>`", () => {
    const hidden = "<b/>".repeat(4);
    expect(scanMarkup(`<?pi <a><a><a> <!-- ?><r/>`, { depth: 1, nodes: 1 })).toBeNull();
    expect(scanMarkup(`<r><?pi <!--?>${hidden}<!----></r>`, { depth: 2, nodes: 4 })).toBe("limit");
    const xml = readFileSync(new URL("./fixtures/minimal.xml", import.meta.url), "utf8");
    expect(parseNfe(xml.replace("<NFe", "<?note a < b?><NFe")).number).toBe("000000001");
  });
  it("counts elements whose name starts with a character JavaScript calls space", () => {
    expect(scanMarkup("<r><﻿/>< /></r>", { depth: 1, nodes: 3 })).toBeNull();
    expect(scanMarkup("<﻿>".repeat(3), { depth: 2, nodes: 3 })).toBe("limit");
  });
  it.each([
    ["an unclosed comment", "<a><!-- </a>"],
    ["an unclosed processing instruction", "<a><?pi </a>"],
    ["an unclosed CDATA section", "<a><![CDATA[ </a>"],
    ["an unclosed tag", "<a><b"],
    ["an unclosed attribute value", '<a x="1></a>'],
    ["a tag without a name", "<a>< b/></a>"],
    ["a `<` inside a tag", "<a <b/>></a>"],
  ])("reports %s as malformed", (_label, xml) => {
    expect(scanMarkup(xml, LIMITS)).toBe("malformed");
  });
});

// Com o regex que recomeçava em cada `<` depois de uma falha, esses arquivos no
// limite de bytes ocupavam a importação por minutos; o custo linear foi medido
// na PR, não aqui. Aqui fica o desfecho nas três entradas: a recusa na
// primeira abertura sem fechamento.
describe.each([
  ["comments", "<!--"],
  ["CDATA sections", "<![CDATA["],
  ["double-quoted tag names", '<"x"'],
  ["single-quoted tag names", "<'x'"],
  ["attribute values", '<b x="'],
])("a flood of unclosed %s", (_label, piece) => {
  const xml = flood(piece);
  it("is rejected as malformed on import", () => {
    expect(encode(xml).byteLength).toBeLessThanOrEqual(LIMITS.bytes);
    expect(() => decodeXml(encode(xml))).toThrow(
      expect.objectContaining({ code: "XML_MALFORMED" }),
    );
    expect(processNfe(encode(xml)).checks.parsing.code).toBe("XML_MALFORMED");
  });
  it("is rejected as malformed by the legacy parser", () => {
    expect(() => parseNfe(xml)).toThrow("XML_MALFORMED");
  });
});
