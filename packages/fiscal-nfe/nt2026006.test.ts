import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import {
  deriveFiscalSituation,
  fiscalEvidenceIdentity,
  parseNfeModel,
  processNfe,
  type ProcessedNfe,
} from "./src/index";

const options = { evaluatedAt: corpus.evaluatedAt };
const linked = fixture("invoice-payment-link").toString();
const group = /<gPgtoVinc>[\s\S]*<\/gPgtoVinc>/.exec(linked)![0];
const first = /<gPgto nPag="1"[\s\S]*?<\/gPgto>/.exec(group)![0];
function invoice(xml: string) {
  const processed = processNfe(Buffer.from(xml), options);
  const document = processed.normalized?.document;
  if (document?.kind !== "invoice") throw new Error("invoice required");
  return { processed, document };
}

describe("NT 2026.006 gPgtoVinc in the NF-e", () => {
  it("passes every step and reads each payment as declared text, in the XML order", () => {
    const { processed, document } = invoice(linked);
    expect(processed.checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
    expect(deriveFiscalSituation([processed]).reportedStatus).toBe("authorized");
    expect(document.nt2026006).toEqual({
      gPgtoVinc: [
        {
          nPag: "1",
          idTransacao: "000123-SINTETICA",
          tpMeioPgto: "03",
          CNPJReceb: "11444777000161",
          CNPJBasePSP: "12345678",
        },
        {
          nPag: "2",
          idTransacao: "TX-SINTETICA-02",
          tpMeioPgto: "17",
          CNPJReceb: "11222333000181",
          CNPJBasePSP: "11222333",
        },
      ],
    });
    expect(processed.metadata!.unsupportedFields.join()).not.toMatch(/gPgto/);
  });
  it("gives null for every corpus invoice without the group", () => {
    const invoices = corpus.cases.filter(
      (entry) =>
        entry.expected.parsing === "passed" &&
        entry.id.startsWith("invoice-") &&
        entry.id !== "invoice-payment-link",
    );
    expect(invoices.length).toBeGreaterThan(5);
    for (const entry of invoices) {
      const document = parseNfeModel(fixture(entry.id)).document;
      if (document.kind !== "invoice") throw new Error("invoice required");
      expect(document.nt2026006).toEqual({ gPgtoVinc: null });
    }
  });
  it("keeps a declared group without payments apart from absence, and the XSD refuses it", () => {
    const { processed, document } = invoice(linked.replace(group, "<gPgtoVinc></gPgtoVinc>"));
    expect(document.nt2026006).toEqual({ gPgtoVinc: [] });
    expect(processed.checks.xsd).toEqual({ status: "failed", code: "XSD_INVALID" });
  });
  it("reads a repeated nPag and idTransacao as declared: the XSD uniqueness never applies", () => {
    // PL_010g declares xs:unique on gPgto/@nPag and gPgto/@idTransacao, but the unprefixed
    // selector "gPgto" names no namespace while the layout is elementFormDefault="qualified":
    // in XSD 1.0 the constraint selects nothing. Neither the XSD step nor the parser checks it.
    const repeated = linked.replace(group, `<gPgtoVinc>${first}${first}</gPgtoVinc>`);
    const { processed, document } = invoice(repeated);
    expect(document.nt2026006.gPgtoVinc).toHaveLength(2);
    expect(document.nt2026006.gPgtoVinc![1]).toEqual(document.nt2026006.gPgtoVinc![0]);
    expect(processed.checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
  });
  it.each([
    ["nPag 990", 'nPag="1"', 'nPag="990"'],
    [
      "idTransacao with inner spaces and Latin-1",
      'idTransacao="000123-SINTETICA"',
      'idTransacao="ID ção 01"',
    ],
    [
      "idTransacao of 35 characters",
      'idTransacao="000123-SINTETICA"',
      `idTransacao="${"9".repeat(35)}"`,
    ],
  ])("accepts %s, as the XSD does", (_case, from, to) => {
    const { processed } = invoice(linked.replace(from, to));
    expect(processed.checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
  });
  it("keeps a tpMeioPgto outside the IT DFe 2026.001 table as declared, without a label", () => {
    // The XSD only checks two digits; the IT provides for the rejection of codes outside its
    // table at authorization, a rule the parser does not evaluate. Labels belong to the public
    // projection.
    const { processed, document } = invoice(
      linked.replace("<tpMeioPgto>03</tpMeioPgto>", "<tpMeioPgto>99</tpMeioPgto>"),
    );
    expect(processed.checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
    expect(document.nt2026006.gPgtoVinc![0]).toEqual({
      nPag: "1",
      idTransacao: "000123-SINTETICA",
      tpMeioPgto: "99",
      CNPJReceb: "11444777000161",
      CNPJBasePSP: "12345678",
    });
  });
  it.each([
    ["tpMeioPgto", "<tpMeioPgto>03</tpMeioPgto>", "<tpMeioPgto>3</tpMeioPgto>"],
    ["nPag", 'nPag="1"', 'nPag="01"'],
    ["nPag", 'nPag="1"', 'nPag="991"'],
    ["idTransacao", 'idTransacao="000123-SINTETICA"', 'idTransacao="0"'],
    ["idTransacao", 'idTransacao="000123-SINTETICA"', `idTransacao="${"9".repeat(36)}"`],
    ["idTransacao", 'idTransacao="000123-SINTETICA"', 'idTransacao=" 000123-SINTETICA"'],
    ["idTransacao", 'idTransacao="000123-SINTETICA"', 'idTransacao="000123-SINTETICA "'],
    ["idTransacao", 'idTransacao="000123-SINTETICA"', 'idTransacao="ID-Ā"'],
    ["CNPJBasePSP", "<CNPJBasePSP>12345678</CNPJBasePSP>", "<CNPJBasePSP>1234567</CNPJBasePSP>"],
  ])("refuses a %s outside the TPgtoVinc shape (%s)", (field, from, to) => {
    expect(() => parseNfeModel(Buffer.from(linked.replace(from, to)))).toThrow(
      expect.objectContaining({ code: "XML_FIELD_INVALID", field }),
    );
  });
  it("refuses more than the 99 payments the XSD admits", () => {
    const payments = Array.from({ length: 100 }, (_, index) =>
      first.replace('nPag="1"', `nPag="${index + 1}"`),
    ).join("");
    expect(() =>
      parseNfeModel(Buffer.from(linked.replace(group, `<gPgtoVinc>${payments}</gPgtoVinc>`))),
    ).toThrow(expect.objectContaining({ code: "XML_LIMIT_EXCEEDED", field: "gPgto" }));
  });
  it("stays out of the fiscal evidence fingerprint, so reprocessing an old original agrees", () => {
    const now = processNfe(Buffer.from(linked), options);
    // What nfe-parser/5 recorded for the same bytes: no nt2026006 anywhere.
    const before: ProcessedNfe = structuredClone(now);
    const stored = before.parsing?.document;
    if (stored?.kind !== "invoice") throw new Error("invoice required");
    delete (stored as Partial<typeof stored>).nt2026006;
    expect(fiscalEvidenceIdentity(before)).toBe(fiscalEvidenceIdentity(now));
    expect(deriveFiscalSituation([before, now]).conflicts).toEqual([]);
  });
});
