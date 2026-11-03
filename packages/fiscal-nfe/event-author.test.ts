import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import { deriveFiscalSituation, processNfe, type ProcessedNfe } from "./src/index";

const process = (bytes: Uint8Array) =>
  processNfe(bytes, { source: "synthetic", evaluatedAt: corpus.evaluatedAt });
const event = (id: string) => process(fixture(id));
const notIssuer = { status: "failed", code: "NFE_EVENT_AUTHOR_NOT_ISSUER" };

// #532: the SEFAZ refuses (574) an issuer's event whose author is not the CNPJ in the access key.
describe("author of an event only the NF-e issuer registers", () => {
  it.each([
    "event-110111-other-author",
    "event-110110-other-author",
    "event-112110-other-author",
    "event-110300-other-author",
    "event-summary-other-author",
  ])("refuses %s at the identity step, after the XSD accepted it", (id) => {
    const result = event(id);
    expect(result.checks.xsd.code).toBe("XSD_VALID");
    expect(result.checks.identity).toEqual(notIssuer);
    const situation = deriveFiscalSituation([event("invoice-authorized"), result]);
    expect(situation.excluded).toContainEqual({
      id: result.metadata!.originalSha256,
      reason: "TECHNICAL_VALIDATION_FAILED",
    });
    expect(situation).toMatchObject({ reportedStatus: "authorized", conflicts: [] });
  });

  it("does not let an accepted cancellation by another CNPJ cancel the NF-e", () => {
    const situation = deriveFiscalSituation([
      event("invoice-authorized"),
      event("event-110111-other-author"),
    ]);
    expect(situation.reportedStatus).toBe("authorized");
  });

  it("checks an event without receipt too", () => {
    const xml = fixture("event-110300-other-author").toString();
    const bare = xml.match(/<evento[\s\S]*<\/evento>/)![0];
    expect(process(Buffer.from(bare)).checks.identity).toEqual(notIssuer);
  });

  it("keeps a rejected event with another author, which is the fisco refusing it", () => {
    const rejected = event("event-rejected-conflicting-claims");
    expect(rejected.parsing?.document).toMatchObject({
      author: { document: "00000000000191" },
      receipt: { status: "573" },
    });
    expect(rejected.checks.identity.code).toBe("NFE_IDENTITY_VALID");
  });

  it("does not compare the recipient's manifestation with the issuer in the key", () => {
    expect(event("event-210200-other-author").checks.identity.code).toBe("NFE_IDENTITY_VALID");
  });

  it("changes the fingerprint, so an earlier acceptance of the same bytes is a disagreement", () => {
    const current = event("event-110111-other-author");
    const earlier: ProcessedNfe = {
      ...current,
      checks: { ...current.checks, identity: { status: "passed", code: "NFE_IDENTITY_VALID" } },
    };
    const situation = deriveFiscalSituation([event("invoice-authorized"), earlier, current]);
    expect(situation.reportedStatus).toBe("conflict");
    expect(situation.conflicts).toContain(
      "PROCESSING_DISAGREEMENT:" + current.metadata!.originalSha256,
    );
  });
});
