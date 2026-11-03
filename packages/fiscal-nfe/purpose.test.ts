import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { fiscalEvidenceIdentity, parseNfeModel, processNfe } from "./src/index";

/** The signed fixture keeps a Signature element, so the XSD check judges only the edited fields. */
function invoice(ide: string, base = "invoice-signed") {
  const xml = fixture(base).toString();
  if (!xml.includes("<finNFe>1</finNFe>")) throw new Error("fixture without finNFe");
  return Buffer.from(xml.replace("<finNFe>1</finNFe>", ide));
}
function purpose(bytes: Buffer) {
  const document = parseNfeModel(bytes).document;
  if (document.kind !== "invoice") throw new Error("invoice required");
  return document.purpose;
}

describe("NF-e purpose (finNFe, tpNFCredito, tpNFDebito)", () => {
  it.each(["1", "2", "3", "4", "5", "6"])("keeps finNFe %s as the declared code", (code) => {
    expect(purpose(invoice(`<finNFe>${code}</finNFe>`))).toEqual({
      code,
      creditType: null,
      debitType: null,
    });
  });
  it.each(["01", "02", "03", "04", "05", "06"])("reads credit note type %s", (code) => {
    const bytes = invoice(`<finNFe>5</finNFe><tpNFCredito>${code}</tpNFCredito>`);
    expect(purpose(bytes)).toEqual({ code: "5", creditType: code, debitType: null });
    expect(processNfe(bytes).checks.xsd.status).toBe("passed");
  });
  it.each(["01", "02", "03", "04", "05", "06", "07", "08"])("reads debit note type %s", (code) => {
    const bytes = invoice(`<finNFe>6</finNFe><tpNFDebito>${code}</tpNFDebito>`);
    expect(purpose(bytes)).toEqual({ code: "6", creditType: null, debitType: code });
    expect(processNfe(bytes).checks.xsd.status).toBe("passed");
  });
  it("tells an absent field apart from a code and records the fields as supported", () => {
    const parsed = parseNfeModel(invoice(""));
    if (parsed.document.kind !== "invoice") throw new Error("invoice required");
    expect(parsed.document.purpose).toEqual({ code: null, creditType: null, debitType: null });
    expect(processNfe(invoice("")).checks.xsd.status).toBe("failed");
    const declared = parseNfeModel(invoice("<finNFe>6</finNFe><tpNFDebito>04</tpNFDebito>"));
    expect(declared.metadata.unsupportedFields.filter((path) => path.includes("ide."))).toEqual(
      parseNfeModel(fixture("invoice-signed")).metadata.unsupportedFields.filter((path) =>
        path.includes("ide."),
      ),
    );
    expect(declared.metadata.unsupportedFields.join()).not.toMatch(/finNFe|tpNFDebito/);
  });
  it("keeps combinations and codes the schema rejects, leaving the verdict to the XSD check", () => {
    // B25.2-10: credit note type on a normal NF-e. The pinned XSD accepts the combination.
    const combined = invoice("<finNFe>1</finNFe><tpNFCredito>01</tpNFCredito>");
    expect(purpose(combined)).toEqual({ code: "1", creditType: "01", debitType: null });
    expect(processNfe(combined).checks.xsd.status).toBe("passed");
    // Both types at once and a code outside TFinNFe/TTpNFDebito reach the XSD check.
    const both = invoice(
      "<finNFe>6</finNFe><tpNFDebito>09</tpNFDebito><tpNFCredito>01</tpNFCredito>",
    );
    expect(purpose(both)).toEqual({ code: "6", creditType: "01", debitType: "09" });
    expect(processNfe(both).checks.xsd.status).toBe("failed");
    const future = invoice("<finNFe>7</finNFe>");
    expect(purpose(future).code).toBe("7");
    expect(processNfe(future).checks.xsd.status).toBe("failed");
  });
  it.each([
    ["finNFe", "<finNFe>N</finNFe>"],
    ["finNFe", "<finNFe>10</finNFe>"],
    ["tpNFCredito", "<finNFe>5</finNFe><tpNFCredito>1</tpNFCredito>"],
    ["tpNFDebito", "<finNFe>6</finNFe><tpNFDebito>A1</tpNFDebito>"],
  ])("refuses a %s that is not shaped like a code", (field, ide) => {
    expect(() => parseNfeModel(invoice(ide))).toThrow(
      expect.objectContaining({ code: "XML_FIELD_INVALID", field }),
    );
  });
});

describe("fiscal evidence fingerprints across the parser upgrade", () => {
  // SHA-256 of fiscalEvidenceIdentity computed by nfe-parser/2 (origin/main at bb02130).
  const before: Record<string, string> = {
    "invoice-prefixed": "4e15d58ca224dc71c77778511852cbd65179ba20b7c1c664c31bd89b8814dda9",
    "invoice-signed": "eb4c910a27837fefc6c2a6cfa0c11dab3444430c9b900a7f5252b6ae28c572fa",
    "invoice-authorized": "0e8ac6ad5f03be6b20d4c9c4194998c3bc63b66c0d8b3427dbcb054c788f650b",
    "invoice-alphanumeric": "493467e1e537161f68e87f5ed2e10456fc5ac20c355dceedf1c16ba902b37735",
    "invoice-monophase": "b55a9fce14a14e5ed39130ccc7a253cfd630764fc08923b5602b5f9e3b893a39",
    "invoice-unsigned": "fe4a18afc8065dfe23767c9eb9722d050192207fb55d2087129665ed0aa9555a",
    "summary-authorized": "0208cfc901f2b5a5ac0e63acbcab18b29913c26f479e60cf93c3bfbe2f83999b",
    "event-110111": "faf4f9dc702f56a9b08f268492af3ee47946d790ee8c3ec6103bf6b25b71b129",
  };
  it.each(Object.keys(before))(
    "reprocessing %s keeps the fingerprint recorded before the purpose existed",
    (id) => {
      const processed = processNfe(fixture(id), { evaluatedAt: corpus.evaluatedAt });
      expect(createHash("sha256").update(fiscalEvidenceIdentity(processed)).digest("hex")).toBe(
        before[id],
      );
    },
  );
  it("still separates interpretations that disagree on a fiscal claim", () => {
    const processed = processNfe(fixture("invoice-authorized"), {
      evaluatedAt: corpus.evaluatedAt,
    });
    const document = processed.parsing!.document;
    if (document.kind !== "invoice") throw new Error("invoice required");
    const purposeOnly = {
      ...processed,
      parsing: {
        ...processed.parsing!,
        document: { ...document, purpose: { ...document.purpose, code: "5" } },
      },
    };
    const total = {
      ...processed,
      parsing: { ...processed.parsing!, document: { ...document, total: "0.01" } },
    };
    expect(fiscalEvidenceIdentity(purposeOnly)).toBe(fiscalEvidenceIdentity(processed));
    expect(fiscalEvidenceIdentity(total)).not.toBe(fiscalEvidenceIdentity(processed));
  });
});
