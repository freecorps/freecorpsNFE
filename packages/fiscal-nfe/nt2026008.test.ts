import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import {
  deriveFiscalSituation,
  fiscalEvidenceIdentity,
  parseNfeModel,
  processNfe,
  SCHEMA_CATALOGS,
  type ProcessedNfe,
} from "./src/index";
import policy from "./src/schema-policy.json" with { type: "json" };

const options = { evaluatedAt: corpus.evaluatedAt };
const netValues = fixture("invoice-net-values").toString();
const advancePaymentIcms =
  "<ICMSPrevistoPagtoAntecip><vICMSPrevisto>4.44</vICMSPrevisto></ICMSPrevistoPagtoAntecip>";
const simplesIcms = "<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>";
/** The same signed invoice and purpose in the layout before NT 2026.008. */
const withoutNewLayout = netValues
  .replace("<vUnComLiq>11.2233445566</vUnComLiq><vProdLiq>22.45</vProdLiq>", "")
  .replace(advancePaymentIcms, simplesIcms)
  .replace("<vProdLiqTot>22.45</vProdLiqTot>", "");
/**
 * What `processNfe` recorded for the same bytes on 26/10/2026, with PL_010f still pinned
 * (`docs/v1.0/evidence/395/reproduzir.ts`). The platform keeps this kind of evidence in
 * `documentFiscalEvidence` for documents imported before the catalog changed.
 */
const pinnedBefore = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/nfe/pl010f/invoice-net-values.processed.json", import.meta.url),
    "utf8",
  ),
) as ProcessedNfe;
function invoice(xml: string) {
  const processed = processNfe(Buffer.from(xml), options);
  const document = processed.normalized?.document;
  if (document?.kind !== "invoice") throw new Error("invoice required");
  return { processed, document };
}

describe("NT 2026.008 layout against the pinned PL_010g", () => {
  it("passes every step with the four elements, and the earlier layout still passes", () => {
    const { processed } = invoice(netValues);
    expect(processed.checks.parsing).toEqual({ status: "passed", code: "XML_PARSED" });
    expect(processed.checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
    expect(processed.checks.fiscalEvidence).toEqual({
      status: "passed",
      code: "PRESERVED_FISCAL_CLAIM_CONSISTENT",
    });
    expect(processed.metadata!.versions.schema).toMatchObject({ package: "nfe-4.00-010g" });
    expect(deriveFiscalSituation([processed]).reportedStatus).toBe("authorized");
    expect(invoice(withoutNewLayout).processed.checks.xsd.status).toBe("passed");
  });
  it("refuses the advance-payment group next to another ICMS group, as the XSD choice requires", () => {
    // PL_010g puts ICMSPrevistoPagtoAntecip in the ICMS choice: it replaces ICMS00...ICMSSN900.
    const both = netValues.replace(advancePaymentIcms, simplesIcms + advancePaymentIcms);
    const { processed, document } = invoice(both);
    expect(processed.checks.xsd).toEqual({ status: "failed", code: "XSD_INVALID" });
    expect(document.products[0]!.nt2026008.vICMSPrevisto).toEqual({
      coefficient: "444",
      scale: 2,
      declared: "4.44",
    });
    expect(deriveFiscalSituation([processed]).excluded).toEqual([
      { id: processed.metadata!.originalSha256, reason: "TECHNICAL_VALIDATION_FAILED" },
    ]);
  });
  it("reads the four fields as exact declared decimals, also in the generic collections", () => {
    const { processed, document } = invoice(netValues);
    expect(document.nt2026008).toEqual({
      vProdLiqTot: { coefficient: "2245", scale: 2, declared: "22.45" },
    });
    expect(document.products[0]!.nt2026008).toEqual({
      vUnComLiq: { coefficient: "112233445566", scale: 10, declared: "11.2233445566" },
      vProdLiq: { coefficient: "2245", scale: 2, declared: "22.45" },
      vICMSPrevisto: { coefficient: "444", scale: 2, declared: "4.44" },
    });
    expect(processed.metadata!.unsupportedFields.join()).not.toMatch(/Liq|Previsto/);
    expect(document.totals).toContainEqual({
      path: "vProdLiqTot",
      value: { coefficient: "2245", scale: 2, declared: "22.45" },
      representation: "decimal",
    });
    expect(document.products[0]!.taxes).toContainEqual({
      path: "ICMS.ICMSPrevistoPagtoAntecip.vICMSPrevisto",
      value: { coefficient: "444", scale: 2, declared: "4.44" },
      representation: "decimal",
    });
  });
  it("keeps every earlier corpus invoice readable, with the new fields absent", () => {
    const invoices = corpus.cases.filter(
      (entry) => entry.expected.parsing === "passed" && entry.id.startsWith("invoice-"),
    );
    expect(invoices.length).toBeGreaterThan(5);
    for (const entry of invoices.filter((entry) => entry.id !== "invoice-net-values")) {
      const document = parseNfeModel(fixture(entry.id)).document;
      if (document.kind !== "invoice") throw new Error("invoice required");
      expect(document.nt2026008).toEqual({ vProdLiqTot: null });
      for (const product of document.products)
        expect(product.nt2026008).toEqual({
          vUnComLiq: null,
          vProdLiq: null,
          vICMSPrevisto: null,
        });
    }
  });
  it("keeps a legitimate zero apart from absence", () => {
    const zero = invoice(
      netValues.replace(
        "<vICMSPrevisto>4.44</vICMSPrevisto>",
        "<vICMSPrevisto>0.00</vICMSPrevisto>",
      ),
    );
    expect(zero.processed.checks.xsd.status).toBe("passed");
    expect(zero.document.products[0]!.nt2026008.vICMSPrevisto).toEqual({
      coefficient: "0",
      scale: 2,
      declared: "0.00",
    });
    expect(invoice(withoutNewLayout).document.products[0]!.nt2026008.vICMSPrevisto).toBeNull();
  });
  it.each([
    ["vProdLiq", "<vProdLiq>22.45</vProdLiq>", "<vProdLiq>22,45</vProdLiq>"],
    ["vProdLiqTot", "<vProdLiqTot>22.45</vProdLiqTot>", "<vProdLiqTot>-1.00</vProdLiqTot>"],
    ["vICMSPrevisto", "<vICMSPrevisto>4.44</vICMSPrevisto>", "<vICMSPrevisto>x</vICMSPrevisto>"],
  ])("refuses a %s that is not a declared decimal", (field, from, to) => {
    expect(() => parseNfeModel(Buffer.from(netValues.replace(from, to)))).toThrow(
      expect.objectContaining({ code: "XML_DECIMAL_INVALID", field }),
    );
  });
  it("refuses a scale beyond the XSD size, in the XSD and in normalization, never rounding", () => {
    const processed = processNfe(
      Buffer.from(netValues.replace("<vProdLiq>22.45</vProdLiq>", "<vProdLiq>22.451</vProdLiq>")),
      options,
    );
    expect(processed.checks.xsd).toEqual({ status: "failed", code: "XSD_INVALID" });
    expect(processed.checks.normalization).toEqual({
      status: "failed",
      code: "NORMALIZATION_INVALID",
    });
  });
});

describe("nfe-status/2: a newer schema catalog replaces a refusal by an older one", () => {
  const now = processNfe(Buffer.from(netValues), options);
  const id = now.metadata!.originalSha256;
  const disagreement = [`PROCESSING_DISAGREEMENT:${id}`];
  const variant = (from: ProcessedNfe, change: (copy: ProcessedNfe) => void) => {
    const copy = structuredClone(from);
    change(copy);
    return copy;
  };
  const relabel = (copy: ProcessedNfe, catalogSha256: string) => {
    copy.metadata!.versions.schema!.catalogSha256 = catalogSha256;
  };
  const invoiceOf = (copy: ProcessedNfe) => {
    if (copy.parsing?.document.kind !== "invoice") throw new Error("invoice required");
    return copy.parsing.document;
  };

  it("orders catalogs by the recorded catalogSha256, with the runtime catalog last", () => {
    expect(SCHEMA_CATALOGS.map((catalog) => catalog.package)).toEqual([
      "nfe-4.00-010f",
      "nfe-4.00-010f",
      "nfe-4.00-010g",
      "nfe-4.00-010g",
    ]);
    expect(SCHEMA_CATALOGS.at(-1)!.catalogSha256).toBe(policy.catalogSha256);
    expect(now.metadata!.versions.schema!.catalogSha256).toBe(policy.catalogSha256);
    expect(pinnedBefore.metadata!.versions.schema).toMatchObject({
      package: "nfe-4.00-010f",
      catalogSha256: SCHEMA_CATALOGS[0]!.catalogSha256,
    });
    for (const catalog of SCHEMA_CATALOGS)
      for (const path of catalog.decimalFieldsAdded)
        expect(policy.decimalFields).toHaveProperty([path]);
  });
  it("lets the PL_010g interpretation replace the real PL_010f one, in any order and repetition", () => {
    expect(pinnedBefore.metadata!.originalSha256).toBe(id);
    expect(pinnedBefore.checks.xsd).toEqual({ status: "failed", code: "XSD_INVALID" });
    expect(fiscalEvidenceIdentity(pinnedBefore)).not.toBe(fiscalEvidenceIdentity(now));
    expect(deriveFiscalSituation([pinnedBefore]).reportedStatus).toBe("unknown");
    const expected = deriveFiscalSituation([now]);
    expect(expected).toMatchObject({ ruleVersion: "nfe-status/2", reportedStatus: "authorized" });
    for (const order of [
      [pinnedBefore, now],
      [now, pinnedBefore],
      [pinnedBefore, now, now, pinnedBefore],
    ])
      expect(deriveFiscalSituation(order)).toEqual(expected);
    // nfe-status/1 stays reproducible: the same evidence is still a disagreement there.
    expect(deriveFiscalSituation([pinnedBefore, now], "nfe-status/1")).toMatchObject({
      ruleVersion: "nfe-status/1",
      reportedStatus: "conflict",
      conflicts: disagreement,
    });
    // Same refusal recorded by the PL_010f catalog with the #389 events (what main recorded
    // between #498 and this change): the NF-e layout is the same, so it is replaced too.
    const withRtcEvents = variant(pinnedBefore, (copy) =>
      relabel(copy, SCHEMA_CATALOGS[1]!.catalogSha256),
    );
    expect(deriveFiscalSituation([withRtcEvents, now])).toEqual(expected);
  });
  it.each([
    ["the total differs", (copy: ProcessedNfe) => void (invoiceOf(copy).total = "24.70")],
    [
      "an item differs",
      (copy: ProcessedNfe) => void (invoiceOf(copy).products[0]!.quantity = "3.0000"),
    ],
    [
      "another technical step differs",
      (copy: ProcessedNfe) =>
        void (copy.checks.signature = {
          status: "failed",
          code: "SIGNATURE_INVALID_OR_UNSUPPORTED",
        }),
    ],
    ["the older catalog is not registered", (copy: ProcessedNfe) => relabel(copy, "0".repeat(64))],
    [
      "both come from the same catalog",
      (copy: ProcessedNfe) => relabel(copy, SCHEMA_CATALOGS.at(-1)!.catalogSha256),
    ],
  ])("keeps a conflict when %s", (_case, change) => {
    const older = variant(pinnedBefore, change);
    for (const order of [
      [older, now],
      [now, older],
    ])
      expect(deriveFiscalSituation(order)).toMatchObject({
        reportedStatus: "conflict",
        conflicts: disagreement,
      });
  });
  it("keeps a conflict between two interpretations that passed the XSD step", () => {
    const other = variant(now, (copy) => void (invoiceOf(copy).total = "24.70"));
    expect(deriveFiscalSituation([now, other]).conflicts).toEqual(disagreement);
  });
  it("never turns a newer catalog refusing what an older one accepted into a replacement", () => {
    const acceptedByOlder = variant(now, (copy) =>
      relabel(copy, SCHEMA_CATALOGS[0]!.catalogSha256),
    );
    const refusedByNewer = variant(now, (copy) => {
      copy.checks.xsd = { status: "failed", code: "XSD_INVALID" };
      copy.checks.fiscalEvidence = { status: "failed", code: "FISCAL_EVIDENCE_INCONSISTENT" };
    });
    expect(deriveFiscalSituation([acceptedByOlder, refusedByNewer])).toMatchObject({
      reportedStatus: "conflict",
      conflicts: disagreement,
    });
  });
});
