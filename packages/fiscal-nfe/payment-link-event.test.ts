import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { deriveFiscalSituation, PARSER_VERSION, processNfe } from "./src/index";
import manifest from "./schemas/manifest.json" with { type: "json" };

const process = (bytes: Uint8Array) =>
  processNfe(bytes, { source: "synthetic", evaluatedAt: corpus.evaluatedAt });
const event = (id: string) => process(fixture(id));

// NT 2026.006 v1.00, section 4: the issuer links the authorized NF-e to a payment transaction.
describe("event 110300, Vinculação Pagamento (NT 2026.006 v1.00)", () => {
  it("accepts it with the envelope and the official PL_010g detail schema", () => {
    const result = event("event-110300");
    expect(result.checks.parsing.code).toBe("XML_PARSED");
    expect(result.checks.xsd.code).toBe("XSD_VALID");
    expect(result.checks.signature.code).toBe("SIGNATURE_INTEGRITY_VALID");
    expect(result.checks.fiscalEvidence.code).toBe("PRESERVED_FISCAL_CLAIM_CONSISTENT");
    expect(result.metadata?.versions.parser).toBe(PARSER_VERSION);
    expect(result.normalized?.document).toMatchObject({
      kind: "event",
      type: "110300",
      description: "Vinculação Pagamento",
      author: { kind: "CNPJ", document: "11222333000181" },
      sequence: "1",
      cancellation: null,
      correction: null,
      manifestation: null,
      receipt: { type: "110300", status: "135", number: "135260000000070" },
    });
    // The typed model does not read the payment: it stays in the XML, and the paths say so,
    // including the NF-e protocol, which only the cancellation reads.
    expect(result.metadata?.unsupportedFields).toEqual(
      expect.arrayContaining(
        ["cOrgaoAutor", "tpAutor", "verAplic", "nProt", "gPgto"].map(
          (name) => "infEvento.detEvento." + name,
        ),
      ),
    );
  });

  it("pins only the 110300 detail and the tiposBasico it includes from PL_010g Evento/", () => {
    const fromEvento = manifest.files
      .filter((file) => file.archivePath?.startsWith("PL_010g_v1.03/Evento/"))
      .map((file) => [file.path, file.sha256]);
    expect(fromEvento).toEqual([
      [
        "nfe-4.00-010g/e110300_v1.00.xsd",
        "3def9bd3e19dfb3e78688afc540c049dc77f6fb11ae2603d85b6e759a7908fa6",
      ],
      [
        "nfe-4.00-010g/tiposBasico_v1.03.xsd",
        "88bae738184e4af32286a4825392adf7da458dc1fa763e2feca3b90708aa7fff",
      ],
    ]);
  });

  it.each([
    ["event-110300-wrong-author", "an author other than the issuer (tpAutor 2)"],
    ["event-110300-invalid-detail", "a detail without gPgto"],
  ])("refuses %s at the XSD step (%s)", (id) => {
    const refused = event(id);
    expect(refused.checks.parsing.status).toBe("passed");
    expect(refused.checks.signature.status).toBe("passed");
    expect(refused.checks.xsd.code).toBe("XSD_INVALID");
    const situation = deriveFiscalSituation([event("invoice-authorized"), refused]);
    expect(situation.excluded).toContainEqual({
      id: refused.metadata!.originalSha256,
      reason: "TECHNICAL_VALIDATION_FAILED",
    });
    expect(situation.reportedStatus).toBe("authorized");
  });

  it("records the link in the history without changing the reported status", () => {
    const invoice = event("invoice-authorized");
    const link = event("event-110300");
    const situation = deriveFiscalSituation([invoice, link]);
    expect(situation).toMatchObject({ reportedStatus: "authorized", conflicts: [] });
    expect(situation.excluded).toContainEqual({
      id: link.metadata!.originalSha256,
      reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS",
    });
  });

  it("accepts the distribution summary of the event", () => {
    const summary = event("event-summary-110300");
    expect(summary.checks.xsd.code).toBe("XSD_VALID");
    expect(summary.normalized?.document).toMatchObject({
      kind: "event-summary",
      type: "110300",
      description: "Vinculação Pagamento",
    });
    expect(deriveFiscalSituation([event("summary-authorized"), summary]).reportedStatus).toBe(
      "authorized",
    );
  });

  it("keeps 110001, the event that would cancel a 110300, unsupported", () => {
    const xml = fixture("event-110300").toString().replaceAll("110300", "110001");
    const result = process(Buffer.from(xml));
    expect(result.checks.parsing).toEqual({ status: "unsupported", code: "XML_EVENT_UNSUPPORTED" });
    expect(result.normalized).toBeNull();
  });
});
