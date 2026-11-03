import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { deriveFiscalSituation, processNfe } from "./src/index";

const process = (bytes: Uint8Array) =>
  processNfe(bytes, { source: "synthetic", evaluatedAt: corpus.evaluatedAt });
const event = (id: string) => process(fixture(id));
const supplier = "11222333000181";

// NT 2025.002 v1.40 (RTC): supplier events that concern the buyer, with the official descEvento.
const rtc = [
  [
    "112110",
    "Informação de efetivo pagamento integral para liberar crédito presumido do adquirente",
  ],
  ["112120", "Importação em ALC/ZFM não convertida em isenção"],
  ["112130", "Perecimento, perda, roubo ou furto durante o transporte contratado pelo fornecedor"],
  ["112140", "Fornecimento não realizado com pagamento antecipado"],
  ["112150", "Atualização da Data de Previsão de Entrega"],
] as const;

describe("supplier events of the tax reform (NT 2025.002 v1.40)", () => {
  it.each(rtc)("accepts %s with the envelope and the official detail schema", (type, name) => {
    const result = event("event-" + type);
    expect(result.checks.parsing.code).toBe("XML_PARSED");
    expect(result.checks.xsd.code).toBe("XSD_VALID");
    expect(result.checks.signature.code).toBe("SIGNATURE_INTEGRITY_VALID");
    expect(result.checks.fiscalEvidence.code).toBe("PRESERVED_FISCAL_CLAIM_CONSISTENT");
    expect(result.normalized?.document).toMatchObject({
      kind: "event",
      type,
      description: name,
      author: { kind: "CNPJ", document: supplier },
      sequence: "1",
      cancellation: null,
      correction: null,
      manifestation: null,
      receipt: { type, status: "135", number: "135260000000070" },
    });
    // The typed model does not interpret the RTC detail; the paths say what stays in the XML.
    expect(result.metadata?.unsupportedFields).toContain("infEvento.detEvento.tpAutor");
  });

  it("validates the detail against its own schema, not only the envelope", () => {
    const missingDate = event("event-112150-invalid-detail");
    expect(missingDate.checks.parsing.status).toBe("passed");
    expect(missingDate.checks.signature.status).toBe("passed");
    expect(missingDate.checks.xsd.code).toBe("XSD_INVALID");
    const situation = deriveFiscalSituation([event("invoice-authorized"), missingDate]);
    expect(situation.excluded).toContainEqual({
      id: missingDate.metadata!.originalSha256,
      reason: "TECHNICAL_VALIDATION_FAILED",
    });
    expect(situation.reportedStatus).toBe("authorized");
  });

  it("records the event in the history without changing the reported status", () => {
    const invoice = event("invoice-authorized");
    const events = rtc.map(([type]) => event("event-" + type));
    const situation = deriveFiscalSituation([invoice, ...events]);
    expect(situation).toMatchObject({ reportedStatus: "authorized", conflicts: [] });
    for (const item of events)
      expect(situation.excluded).toContainEqual({
        id: item.metadata!.originalSha256,
        reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS",
      });
    // Control: the same evidence with an accepted cancellation does change the status.
    expect(deriveFiscalSituation([invoice, ...events, event("event-110111")]).reportedStatus).toBe(
      "cancelled",
    );
  });

  it("accepts the distribution summary of a supported RTC event", () => {
    const summary = event("event-summary-112150");
    expect(summary.checks.xsd.code).toBe("XSD_VALID");
    expect(summary.normalized?.document).toMatchObject({
      kind: "event-summary",
      type: "112150",
      description: "Atualização da Data de Previsão de Entrega",
      author: { document: supplier },
    });
    expect(deriveFiscalSituation([event("summary-authorized"), summary]).reportedStatus).toBe(
      "authorized",
    );
  });

  it.each([
    ["110001", "cancels another event; the link to it is not modeled yet"],
    ["211110", "buyer's own request, deferred"],
    ["110130", "delivery proof, deferred"],
    ["610600", "tax authority event without an official package"],
  ])("keeps %s unsupported (%s)", (type) => {
    const asEvent = fixture("event-112150").toString().replaceAll("112150", type);
    const asSummary = fixture("event-summary-112150")
      .toString()
      .replace("<tpEvento>112150</tpEvento>", `<tpEvento>${type}</tpEvento>`);
    for (const xml of [asEvent, asSummary]) {
      const result = process(Buffer.from(xml));
      expect(result.checks.parsing).toEqual({
        status: "unsupported",
        code: "XML_EVENT_UNSUPPORTED",
      });
      expect(result.normalized).toBeNull();
      expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
    }
  });
});
