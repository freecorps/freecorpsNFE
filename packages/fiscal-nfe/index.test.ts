import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { parseNfe, MAX_XML_BYTES } from "./src/index";
const xml = readFileSync(new URL("./fixtures/minimal.xml", import.meta.url), "utf8");
it("extracts the synthetic document without losing identifiers, precision or entity text", () => {
  const doc = parseNfe(xml);
  expect(doc.number).toBe("000000001");
  expect(doc.issuer).toEqual({ cnpj: "00000000000000", name: "Empresa & Exemplo" });
  expect(doc.items[0].unitPrice).toBe("12.3456789012");
  expect(doc.total).toBe("24.69");
  expect(doc.validation).toEqual({
    wellFormed: true,
    schema: "not-checked",
    signature: "not-checked",
    authorization: "not-checked",
  });
  expect(
    parseNfe(
      `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">${xml.replace(/<\?xml[^>]+>/, "")}</nfeProc>`,
    ),
  ).toEqual(doc);
});
it.each([
  ["<!DOCTYPE NFe [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]>" + xml, "XML_UNSAFE"],
  ["<a>".repeat(65) + "</a>".repeat(65), "XML_UNSAFE"],
  ['<a note="/>">'.repeat(65) + "</a>".repeat(65), "XML_UNSAFE"],
  ["<é>".repeat(65) + "</é>".repeat(65), "XML_UNSAFE"],
  ["<a>" + "<b/>".repeat(50_001) + "</a>", "XML_UNSAFE"],
  [" ".repeat(MAX_XML_BYTES + 1), "XML_TOO_LARGE"],
  ["ç".repeat(MAX_XML_BYTES / 2 + 1), "XML_TOO_LARGE"],
  [xml.replace("</NFe>", "</other>"), "XML_MALFORMED"],
  [xml.replace('versao="4.00"', 'versao="9.99"'), "XML_UNSUPPORTED"],
  [xml.replace("<mod>55", "<mod>65"), "XML_UNSUPPORTED"],
  [xml.replace("12.3456789012", "1e10"), "XML_FIELD_INVALID"],
  [xml.replace("<nNF>000000001</nNF>", "<nNF>1</nNF><nNF>2</nNF>"), "XML_FIELD_INVALID"],
])(
  "rejects unsafe, unsupported or malformed input without returning its contents",
  (input, code) => {
    expect(() => parseNfe(input)).toThrow(code);
  },
);
