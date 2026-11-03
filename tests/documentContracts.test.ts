import { describe, expect, it } from "vite-plus/test";
import {
  nfeCreditNoteTypeLabels,
  nfeDebitNoteTypeLabels,
  nfePaymentMeansLabels,
  nfePaymentMeansLabelsSource,
  nfePurposeLabels,
  projectNfePayload,
  projectNfeItem,
} from "../packages/contracts/src/documents";
import { nfeItem, nfePayload } from "../packages/contracts/src/external";
import { processNfe } from "../packages/fiscal-nfe/src/index";
import { fixture } from "./helpers/nfe-corpus";

it("public projection preserves specific NF-e fields and exact decimals without internal fields", () => {
  const model = processNfe(fixture("invoice-monophase")).normalized!.document;
  if (model.kind !== "invoice") throw new Error("invoice required");
  const payload = projectNfePayload({ ...model, storageId: "private", secret: "secret" });
  const item = projectNfeItem({ ...model.products[0]!, sourceKeyId: "private", hidden: {} });
  expect(payload.kind).toBe("invoice");
  expect(JSON.stringify(payload)).not.toMatch(/storageId|secret|products/);
  expect(JSON.stringify(item)).not.toMatch(/sourceKeyId|hidden/);
  expect(item.cest).toBe(model.products[0]!.cest);
  expect(item.purchaseOrder).toBe(model.products[0]!.purchaseOrder);
  expect(item.tributaryUnitPrice).toBe(model.products[0]!.tributaryUnitPrice.declared);
  expect(item.taxes.length).toBe(model.products[0]!.taxes.length);
});
it("projection refuses incompatible model/kind and inconsistent decimal representations", () => {
  const model = processNfe(fixture("invoice-authorized")).normalized!.document;
  if (model.kind !== "invoice") throw new Error("invoice required");
  expect(() =>
    projectNfePayload({ ...model, key: model.key.slice(0, 20) + "65" + model.key.slice(22) }),
  ).toThrow("DOCUMENT_MODEL_INVALID");
  expect(() => projectNfePayload({ ...model, kind: "nfse" })).toThrow();
  expect(() =>
    projectNfeItem({
      ...model.products[0]!,
      quantity: { ...model.products[0]!.quantity, coefficient: "999" },
    }),
  ).toThrow("DOCUMENT_INVALID");
});
describe("NF-e totals and purpose in the public projection", () => {
  const invoiceFrom = (xml: string) => {
    const model = processNfe(Buffer.from(xml)).normalized!.document;
    if (model.kind !== "invoice") throw new Error("invoice required");
    return model;
  };
  const base = fixture("invoice-unsigned").toString();
  const withTotals = (vNF: string, vNFTot: string | null) =>
    base
      .replace(/<vNF>[^<]*<\/vNF>/, `<vNF>${vNF}</vNF>`)
      .replace("</ICMSTot>", "</ICMSTot>" + (vNFTot === null ? "" : `<vNFTot>${vNFTot}</vNFTot>`));
  it.each([
    ["distinct values", "24.69", "27.15", "27.15"],
    ["absent vNFTot", "24.69", null, null],
    ["legitimate zero", "0.00", "0.00", "0.00"],
    ["exact precision", "9999999999999.99", "0.10", "0.10"],
  ])("declares vNF and vNFTot as declared: %s", (_, vNF, vNFTot, expected) => {
    const payload = projectNfePayload(invoiceFrom(withTotals(vNF, vNFTot)));
    if (payload.kind !== "invoice") throw new Error("invoice required");
    expect(payload.total).toBe(vNF);
    expect(payload.declaredTotals).toEqual({ vNF, vNFTot: expected });
    expect(nfePayload.parse(payload)).toEqual(payload);
  });
  it("refuses a stored vNFTot that is not one declared decimal", () => {
    const model = invoiceFrom(withTotals("24.69", "27.15"));
    const vNFTot = model.totals.find((field) => field.path === "vNFTot")!;
    expect(() => projectNfePayload({ ...model, totals: [...model.totals, vNFTot] })).toThrow(
      "DOCUMENT_INVALID",
    );
    expect(() =>
      projectNfePayload({
        ...model,
        totals: model.totals.map((field) =>
          field === vNFTot ? { ...field, representation: "text", value: "27.15" } : field,
        ),
      }),
    ).toThrow("DOCUMENT_INVALID");
  });
  const withPurpose = (ide: string) => base.replace("<finNFe>1</finNFe>", ide);
  it.each(Object.entries(nfePurposeLabels))("labels purpose %s as %s", (code, label) => {
    const payload = projectNfePayload(invoiceFrom(withPurpose(`<finNFe>${code}</finNFe>`)));
    if (payload.kind !== "invoice") throw new Error("invoice required");
    // Purpose 5 and 6 without their type break B25.2-20 and B25.1-20.
    const expected = code === "5" ? ["B25.2-20"] : code === "6" ? ["B25.1-20"] : [];
    expect(payload.purpose).toEqual({
      code,
      label,
      creditNoteType: null,
      debitNoteType: null,
      inconsistencies: expected,
    });
    expect(payload.operation).toBe("VENDA SINTETICA");
  });
  it("labels credit and debit note types and names the broken combination rules", () => {
    const project = (ide: string) => {
      const payload = projectNfePayload(invoiceFrom(withPurpose(ide)));
      if (payload.kind !== "invoice") throw new Error("invoice required");
      expect(nfePayload.parse(payload)).toEqual(payload);
      return payload.purpose!;
    };
    for (const [code, label] of Object.entries(nfeCreditNoteTypeLabels))
      expect(project(`<finNFe>5</finNFe><tpNFCredito>${code}</tpNFCredito>`)).toMatchObject({
        creditNoteType: { code, label },
        debitNoteType: null,
        inconsistencies: [],
      });
    for (const [code, label] of Object.entries(nfeDebitNoteTypeLabels))
      expect(project(`<finNFe>6</finNFe><tpNFDebito>${code}</tpNFDebito>`)).toMatchObject({
        creditNoteType: null,
        debitNoteType: { code, label },
        inconsistencies: [],
      });
    expect(project("<finNFe>1</finNFe><tpNFCredito>04</tpNFCredito>").inconsistencies).toEqual([
      "B25.2-10",
    ]);
    expect(project("<finNFe>5</finNFe><tpNFDebito>04</tpNFDebito>").inconsistencies).toEqual([
      "B25.1-10",
      "B25.2-20",
    ]);
    expect(project("<finNFe>7</finNFe><tpNFDebito>09</tpNFDebito>")).toEqual({
      code: "7",
      label: null,
      creditNoteType: null,
      debitNoteType: { code: "09", label: null },
      inconsistencies: ["B25.1-10"],
    });
    expect(project("")).toEqual({
      code: null,
      label: null,
      creditNoteType: null,
      debitNoteType: null,
      inconsistencies: [],
    });
  });
  /**
   * NT 2025.002 v1.52 (RTC), section 7 "Regras de Validação", group B, page 32. Official text:
   *   B25.1-10: "Se informado tipo de nota de débito (tag: tpNFDebito) - Finalidade <> 6-Nota de
   *             débito (tag:finNFe)". Rejeição 1139: "Tipo de nota de débito informado indevidamente".
   *   B25.1-20: "Se finalidade = 6-Nota de débito (tag:finNFe) - Não informado tipo de nota de
   *             débito (tag: tpNFDebito)". Rejeição 1009.
   *   B25.2-10: "Se informado tipo de nota de crédito (tag: tpNFCredito) - Finalidade <> 5-Nota de
   *             crédito (tag:finNFe)". Rejeição 1163: "Tipo de nota de crédito informado indevidamente".
   *   B25.2-20: "Se finalidade = 5-Nota de crédito (tag:finNFe) - Não informado tipo de nota de
   *             crédito (tag: tpNFCredito)". Rejeição 1164.
   * Each rule is checked in both directions, for every purpose of TFinNFe.
   */
  it.each([
    ["B25.1-10", (code: string) => `<finNFe>${code}</finNFe><tpNFDebito>01</tpNFDebito>`, ["6"]],
    ["B25.1-20", (code: string) => `<finNFe>${code}</finNFe>`, ["1", "2", "3", "4", "5"]],
    ["B25.2-10", (code: string) => `<finNFe>${code}</finNFe><tpNFCredito>01</tpNFCredito>`, ["5"]],
    ["B25.2-20", (code: string) => `<finNFe>${code}</finNFe>`, ["1", "2", "3", "4", "6"]],
  ] as const)("applies %s exactly as the NT states it", (rule, ide, compliant) => {
    for (const code of ["1", "2", "3", "4", "5", "6"]) {
      const payload = projectNfePayload(invoiceFrom(withPurpose(ide(code))));
      if (payload.kind !== "invoice") throw new Error("invoice required");
      expect(payload.purpose!.inconsistencies.includes(rule)).toBe(
        !(compliant as readonly string[]).includes(code),
      );
    }
  });
  it("reports a purpose never extracted as null, apart from one absent in the XML", () => {
    const { purpose: _purpose, ...stored } = invoiceFrom(base);
    const payload = projectNfePayload(stored);
    if (payload.kind !== "invoice") throw new Error("invoice required");
    expect(payload.purpose).toBeNull();
    expect(payload.declaredTotals).toEqual({ vNF: "24.69", vNFTot: null });
    expect(nfePayload.parse(payload)).toEqual(payload);
  });
});
describe("NT 2026.008 fields in the public projection", () => {
  const model = processNfe(fixture("invoice-net-values")).normalized!.document;
  if (model.kind !== "invoice") throw new Error("invoice required");
  it("projects the declared net values and the advance-payment ICMS as exact text", () => {
    const payload = projectNfePayload(model);
    if (payload.kind !== "invoice") throw new Error("invoice required");
    expect(payload.nt2026008).toEqual({ vProdLiqTot: "22.45" });
    expect(nfePayload.parse(payload)).toEqual(payload);
    const item = projectNfeItem(model.products[0]);
    expect(item.nt2026008).toEqual({
      vUnComLiq: "11.2233445566",
      vProdLiq: "22.45",
      vICMSPrevisto: "4.44",
    });
    expect(nfeItem.parse(item)).toEqual(item);
  });
  it("tells absence in the XML apart from a version processed before nfe-parser/4", () => {
    const older = processNfe(fixture("invoice-authorized")).normalized!.document;
    if (older.kind !== "invoice") throw new Error("invoice required");
    expect(projectNfePayload(older)).toMatchObject({ nt2026008: { vProdLiqTot: null } });
    expect(projectNfeItem(older.products[0]).nt2026008).toEqual({
      vUnComLiq: null,
      vProdLiq: null,
      vICMSPrevisto: null,
    });
    const { nt2026008: _total, ...stored } = model;
    const { nt2026008: _item, ...storedItem } = model.products[0]!;
    expect(projectNfePayload(stored)).toMatchObject({ nt2026008: null });
    expect(projectNfeItem(storedItem).nt2026008).toBeNull();
  });
});
describe("NT 2026.006 gPgtoVinc in the public projection", () => {
  const model = processNfe(fixture("invoice-payment-link")).normalized!.document;
  if (model.kind !== "invoice") throw new Error("invoice required");
  it("projects each payment as declared text, leading zeros included", () => {
    const payload = projectNfePayload(model);
    if (payload.kind !== "invoice") throw new Error("invoice required");
    expect(payload.nt2026006?.gPgtoVinc).toHaveLength(2);
    expect(payload.nt2026006?.gPgtoVinc?.[0]).toEqual({
      nPag: "1",
      idTransacao: "000123-SINTETICA",
      tpMeioPgto: "03",
      tpMeioPgtoLabel: null,
      CNPJReceb: "11444777000161",
      CNPJBasePSP: "12345678",
    });
    expect(payload.nt2026006?.gPgtoVinc?.[1]).toMatchObject({
      tpMeioPgto: "17",
      tpMeioPgtoLabel: "Pix QRCode",
    });
    expect(nfePayload.parse(payload)).toEqual(payload);
  });
  const withMeans = (code: string) => {
    const payload = projectNfePayload(
      processNfe(
        Buffer.from(
          fixture("invoice-payment-link")
            .toString()
            .replace("<tpMeioPgto>03</tpMeioPgto>", `<tpMeioPgto>${code}</tpMeioPgto>`),
        ),
      ).normalized!.document,
    );
    expect(nfePayload.parse(payload)).toEqual(payload);
    return payload.kind === "invoice" ? payload.nt2026006!.gPgtoVinc![0]! : undefined;
  };
  it("labels the six codes of the IT DFe 2026.001 v1.01 table with its descriptions", () => {
    expect(nfePaymentMeansLabelsSource).toBe("IT DFe 2026.001 v1.01");
    // IT DFe 2026.001 v1.01, page 3, without the asterisk of the new codes 23 and 24.
    expect(nfePaymentMeansLabels).toEqual({
      "15": "Boleto",
      "17": "Pix QRCode",
      "18": "TED",
      "20": "PIX chave ou QRCode estático",
      "23": "Pix automático",
      "24": "TEF / booktransfer",
    });
  });
  it.each(Object.entries(nfePaymentMeansLabels))("labels tpMeioPgto %s as %s", (code, label) => {
    expect(withMeans(code)).toMatchObject({ tpMeioPgto: code, tpMeioPgtoLabel: label });
  });
  it("keeps a code outside the IT table as declared, with a null label", () => {
    for (const code of ["99", "01", "16"])
      expect(withMeans(code)).toMatchObject({ tpMeioPgto: code, tpMeioPgtoLabel: null });
  });
  it("accepts in the response every value the parser accepts, at the XSD limits", () => {
    const edge = processNfe(
      Buffer.from(
        fixture("invoice-payment-link")
          .toString()
          .replace('nPag="1"', 'nPag="990"')
          .replace('idTransacao="000123-SINTETICA"', 'idTransacao="ID ção 01"'),
      ),
    ).normalized!.document;
    const payload = projectNfePayload(edge);
    expect(nfePayload.parse(payload)).toEqual(payload);
    const link = payload.kind === "invoice" ? payload.nt2026006?.gPgtoVinc?.[0] : undefined;
    expect(link).toMatchObject({ nPag: "990", idTransacao: "ID ção 01" });
    for (const idTransacao of [" ID-01", "ID-01 ", "9".repeat(36)])
      expect(() =>
        nfePayload.parse({ ...payload, nt2026006: { gPgtoVinc: [{ ...link, idTransacao }] } }),
      ).toThrow();
  });
  it("tells an omitted group, a declared empty one and a version before nfe-parser/6 apart", () => {
    const older = processNfe(fixture("invoice-authorized")).normalized!.document;
    expect(projectNfePayload(older)).toMatchObject({ nt2026006: { gPgtoVinc: null } });
    expect(projectNfePayload({ ...model, nt2026006: { gPgtoVinc: [] } })).toMatchObject({
      nt2026006: { gPgtoVinc: [] },
    });
    const { nt2026006: _link, ...stored } = model;
    const payload = projectNfePayload(stored);
    expect(payload).toMatchObject({ nt2026006: null });
    expect(nfePayload.parse(payload)).toEqual(payload);
  });
});
