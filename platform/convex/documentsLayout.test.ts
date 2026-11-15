import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import {
  processNfe,
  fiscalEvidenceIdentity,
  SCHEMA_CATALOGS,
  type Invoice,
  type ProcessedNfe,
} from "../../packages/fiscal-nfe/src/index";
import { accessKeyDigit } from "../../packages/fiscal-nfe/src/identity";
import type { Id } from "./_generated/dataModel";
import { FreecorpsClient } from "../../packages/sdk/src/index";
import { documentsFixture } from "../../tests/helpers/documents";

/** NF-e layouts and parser versions: PL_010g fields, NT 2026.006 and 2026.008, older interpretations. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-import-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/**
 * Edits the unsigned fixture under its own key (`cNF` and check digit change together): another
 * artifact under an already published key would only be a conflicting version.
 */
function invoiceXml(cNF: string, ide: string, totals: { vNF?: string; vNFTot?: string } = {}) {
  let xml = xmlFixture("invoice-unsigned").toString().replace("<finNFe>1</finNFe>", ide);
  const key = /Id="NFe(\d{44})"/.exec(xml)![1]!,
    base = key.slice(0, 35) + cNF,
    digit = accessKeyDigit(base);
  xml = xml
    .replace(key, base + digit)
    .replace(/<cNF>\d{8}<\/cNF>/, `<cNF>${cNF}</cNF>`)
    .replace(/<cDV>\d<\/cDV>/, `<cDV>${digit}</cDV>`);
  if (totals.vNF) xml = xml.replace(/<vNF>[^<]*<\/vNF>/, `<vNF>${totals.vNF}</vNF>`);
  if (totals.vNFTot) xml = xml.replace("</ICMSTot>", `</ICMSTot><vNFTot>${totals.vNFTot}</vNFTot>`);
  return Buffer.from(xml);
}
it("round-trips the purpose and both declared totals through REST import, REST read and the SDK", async () => {
  const f = await documentsFixture();
  const sdk = new FreecorpsClient({
    baseUrl: "https://api.example.invalid",
    apiKey: f.secret,
    environment: "sandbox",
    fetch: (input, init) => {
      // The SDK always calls with a URL object.
      const url = input as URL;
      return f.t.fetch(url.pathname + url.search, init);
    },
  });
  const read = async (imported: { file: { code: string; documentId: string | null } }) => {
    expect(imported.file.code).toBe("IMPORTED");
    const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
    const response = await f.get(`/v1/documents/${documentId}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()).data;
    const viaSdk = await sdk.call("getDocument", {
      path: { documentId },
      query: { companyId: f.scope.companyId },
      body: {},
    });
    expect(viaSdk.data).toEqual(detail);
    return detail;
  };
  let detail = await read(await f.importXml(invoiceXml("10000001", "<finNFe>1</finNFe>")));
  expect(detail.summary.total).toBe("24.69");
  expect(detail.payload.declaredTotals).toEqual({ vNF: "24.69", vNFTot: null });
  expect(detail.payload.purpose).toEqual({
    code: "1",
    label: "NF-e normal",
    creditNoteType: null,
    debitNoteType: null,
    inconsistencies: [],
  });
  detail = await read(
    await f.importXml(
      invoiceXml("10000002", "<finNFe>6</finNFe><tpNFDebito>06</tpNFDebito>", {
        vNF: "1234567890123.40",
        vNFTot: "1234567890123.45",
      }),
    ),
  );
  // The listing keeps vNF; the payload names both values.
  expect(detail.summary.total).toBe("1234567890123.40");
  expect(detail.payload.total).toBe("1234567890123.40");
  expect(detail.payload.declaredTotals).toEqual({
    vNF: "1234567890123.40",
    vNFTot: "1234567890123.45",
  });
  expect(detail.payload.operation).toBe("VENDA SINTETICA");
  expect(detail.payload.purpose).toEqual({
    code: "6",
    label: "Nota de débito",
    creditNoteType: null,
    debitNoteType: { code: "06", label: "Pagamento antecipado" },
    inconsistencies: [],
  });
  const json = (await (await f.get(`/v1/documents/${detail.summary.id}/json`)).json()).data;
  expect(json.payload).toEqual(detail.payload);
  detail = await read(
    await f.importXml(
      invoiceXml("10000003", "<finNFe>1</finNFe><tpNFCredito>01</tpNFCredito>", {
        vNF: "0.00",
        vNFTot: "0.00",
      }),
    ),
  );
  expect(detail.payload.declaredTotals).toEqual({ vNF: "0.00", vNFTot: "0.00" });
  expect(detail.payload.purpose.inconsistencies).toEqual(["B25.2-10"]);
  // The declared combination is information only: it does not touch the fiscal situation.
  expect(detail.summary.fiscalStatus).toBe("unknown");
  expect(detail.fiscalSituation.conflicts).toEqual([]);
  const listed = (await (await f.get()).json()).data.page;
  expect(listed.map((row: { total: string }) => row.total).sort()).toEqual([
    "0.00",
    "1234567890123.40",
    "24.69",
  ]);
});
it("imports an NT 2026.008 invoice valid for PL_010g, with its net values and deduplication", async () => {
  const f = await documentsFixture(),
    bytes = xmlFixture("invoice-net-values");
  const imported = await f.importXml(bytes);
  expect(imported.file.code).toBe("IMPORTED");
  const checks = JSON.parse(imported.file.result!).checks;
  expect(checks.parsing.code).toBe("XML_PARSED");
  expect(checks.xsd).toEqual({ status: "passed", code: "XSD_VALID" });
  expect(checks.fiscalEvidence.code).toBe("PRESERVED_FISCAL_CLAIM_CONSISTENT");
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("authorized");
  expect(detail.fiscalSituation.excluded).toEqual([]);
  expect(detail.payload.nt2026008).toEqual({ vProdLiqTot: "22.45" });
  // The generic collection follows the new schema policy: a decimal, no longer text.
  expect(
    detail.payload.totals.find((field: { path: string }) => field.path === "vProdLiqTot"),
  ).toMatchObject({ representation: "decimal", value: "22.45" });
  expect(detail.payload.purpose.debitNoteType).toEqual({
    code: "06",
    label: "Pagamento antecipado",
  });
  const items = (
    await (
      await f.get(`/v1/documents/${detail.summary.id}/items`, `&versionId=${detail.version.id}`)
    ).json()
  ).data;
  expect(items.page[0].nt2026008).toEqual({
    vUnComLiq: "11.2233445566",
    vProdLiq: "22.45",
    vICMSPrevisto: "4.44",
  });
  const again = await f.importXml(bytes);
  expect(again.file.documentId).toBe(imported.file.documentId);
  expect(again.file.code).toBe("DUPLICATE");
});
it("imports an NT 2026.006 payment link through REST and the SDK, and reprocessing brings it to an older version", async () => {
  const f = await documentsFixture();
  const sdk = new FreecorpsClient({
    baseUrl: "https://api.example.invalid",
    apiKey: f.secret,
    environment: "sandbox",
    fetch: (input, init) => {
      const url = input as URL;
      return f.t.fetch(url.pathname + url.search, init);
    },
  });
  const imported = await f.importXml(xmlFixture("invoice-payment-link"));
  expect(imported.file.code).toBe("IMPORTED");
  const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
  const read = async () => (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  const detail = await read();
  expect(detail.summary.fiscalStatus).toBe("authorized");
  expect(detail.payload.nt2026006.gPgtoVinc).toEqual([
    {
      nPag: "1",
      idTransacao: "000123-SINTETICA",
      tpMeioPgto: "03",
      tpMeioPgtoLabel: null,
      CNPJReceb: "11444777000161",
      CNPJBasePSP: "12345678",
    },
    {
      nPag: "2",
      idTransacao: "TX-SINTETICA-02",
      tpMeioPgto: "17",
      tpMeioPgtoLabel: "Pix QRCode",
      CNPJReceb: "11222333000181",
      CNPJBasePSP: "11222333",
    },
  ]);
  const viaSdk = await sdk.call("getDocument", {
    path: { documentId },
    query: { companyId: f.scope.companyId },
    body: {},
  });
  expect(viaSdk.data).toEqual(detail);
  // Rewind the stored output to what nfe-parser/5 persisted: the group exists only in the XML.
  const strip = (json: string, path: (value: Record<string, any>) => Record<string, any>) => {
    const value = JSON.parse(json);
    delete path(value).nt2026006;
    return JSON.stringify(value);
  };
  await f.t.run(async (ctx) => {
    const version = (await ctx.db.get("documentVersions", imported.version._id))!;
    await ctx.db.patch("documentVersions", version._id, {
      parserVersion: "nfe-parser/5",
      result: strip(version.result!, (value) => value.document),
      fiscalEvidence: strip(version.fiscalEvidence!, (value) => value.parsing.document),
    });
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.patch("documentFiscalEvidence", row._id, {
        snapshot: strip(row.snapshot!, (value) => value.parsing.document),
      });
  });
  const old = await read();
  expect(old.payload.nt2026006).toBeNull();
  const path = `/v1/documents/${documentId}/reprocess?companyId=${f.scope.companyId}`;
  const reservation = (await (await f.request(path, "POST", {}, "payment-link")).json()).data;
  await f.t.action(internal.operationWorker.run, {
    operationId: reservation.operationId,
    generation: 1,
  });
  await f.rebuild(documentId);
  const current = await read();
  expect(current.version.id).not.toBe(old.version.id);
  expect(current.version.parserVersion).toBe("nfe-parser/8");
  expect(current.payload.nt2026006).toEqual(detail.payload.nt2026006);
  // One fingerprint for both versions of the same original: no processing disagreement.
  expect(await f.t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect())).toHaveLength(1);
  expect(current.summary.fiscalStatus).toBe("authorized");
  expect(current.fiscalSituation.conflicts).toEqual([]);
});
/**
 * A document imported while PL_010f was pinned: its stored evidence is the real PL_010f output for
 * the same bytes (XSD_INVALID), recorded on 26/10/2026. `change` alters that evidence to model a
 * real divergence.
 */
async function importedUnderPl010f(
  change: (before: ProcessedNfe) => void = () => {},
  id = "invoice-net-values",
  /** Evidence of that era built from today's, when none was recorded for the fixture. */
  recorded?: (today: ProcessedNfe) => ProcessedNfe,
) {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture(id));
  const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
  const before = recorded
    ? recorded(processNfe(xmlFixture(id)))
    : (JSON.parse(
        readFileSync(
          new URL(
            "../../tests/fixtures/nfe/pl010f/invoice-net-values.processed.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as ProcessedNfe);
  change(before);
  const fingerprint = createHash("sha256").update(fiscalEvidenceIdentity(before)).digest("hex");
  await f.t.run(async (ctx) => {
    const version = (await ctx.db.get("documentVersions", imported.version._id))!;
    const result = JSON.parse(version.result!);
    // The parser of that era did not know nt2026006 either.
    const { nt2026006: _link, ...document } = result.document;
    await ctx.db.patch("documentVersions", version._id, {
      parserVersion: before.metadata!.versions.parser,
      result: JSON.stringify({
        ...result,
        document,
        metadata: before.metadata,
        checks: before.checks,
      }),
      schema: JSON.stringify(before.metadata!.versions.schema),
      fiscalEvidence: JSON.stringify(before),
      fiscalFingerprint: fingerprint,
    });
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.patch("documentFiscalEvidence", row._id, {
        fingerprint,
        snapshot: JSON.stringify(before),
      });
  });
  await f.rebuild(documentId);
  const stored = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(stored.summary.fiscalStatus).toBe("unknown");
  expect(stored.fiscalSituation.excluded).toEqual([
    { id: stored.version.sha256, reason: "TECHNICAL_VALIDATION_FAILED" },
  ]);
  let reprocessed = 0;
  const reprocess = async (key: string) => {
    const path = `/v1/documents/${documentId}/reprocess?companyId=${f.scope.companyId}`;
    const reservation = (await (await f.request(path, "POST", {}, key)).json()).data;
    if (reservation.operationId && ++reprocessed)
      await f.t.action(internal.operationWorker.run, {
        operationId: reservation.operationId,
        generation: 1,
      });
    await f.rebuild(documentId);
  };
  const rebuildFromOriginals = async () => {
    const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
    await f.t.action(internal.documentProjectionWorker.rebuild, {
      documentId,
      generation: doc.projectionGeneration!,
      originals: true,
    });
  };
  const read = async () => (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  const evidence = () => f.t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect());
  return { f, documentId, stored, reprocess, rebuildFromOriginals, read, evidence };
}
it("lets the PL_010g interpretation replace a PL_010f-era refusal, keeping both in the history", async () => {
  const doc = await importedUnderPl010f();
  await doc.rebuildFromOriginals();
  const verified = await doc.read();
  expect(verified.summary.fiscalStatus).toBe("authorized");
  expect(verified.fiscalSituation).toMatchObject({
    ruleVersion: "nfe-status/2",
    evidenceIds: [doc.stored.version.sha256],
    excluded: [],
    conflicts: [],
  });
  // Reprocessing records the PL_010g interpretation as a version of its own.
  await doc.reprocess("pl010g-reprocess");
  const current = await doc.read();
  expect(current.version.id).not.toBe(doc.stored.version.id);
  expect(current.summary.fiscalStatus).toBe("authorized");
  expect(JSON.parse(current.version.schema)).toMatchObject({ package: "nfe-4.00-010g" });
  const history = (await (await doc.f.get(`/v1/documents/${doc.documentId}/versions`)).json()).data;
  const ids = history.page.map((row: { version: { id: string } }) => row.version.id);
  expect(ids).toHaveLength(2);
  expect(ids).toEqual(expect.arrayContaining([doc.stored.version.id, current.version.id]));
  const codes = (await doc.evidence()).map((row) => JSON.parse(row.snapshot!).checks.xsd.code);
  expect(codes).toHaveLength(2);
  expect(codes).toEqual(expect.arrayContaining(["XSD_INVALID", "XSD_VALID"]));
  // Repeating the same key, another reprocess and rebuilds from the originals change nothing.
  await doc.reprocess("pl010g-reprocess");
  await doc.reprocess("pl010g-reprocess-again");
  await doc.rebuildFromOriginals();
  await doc.rebuildFromOriginals();
  const repeated = await doc.read();
  expect(repeated.fiscalSituation).toEqual(current.fiscalSituation);
  expect(await doc.evidence()).toHaveLength(2);
  // The XML original stays the same bytes.
  const original = await doc.f.get(`/v1/document-artifacts/${current.version.artifactId}/original`);
  expect(
    createHash("sha256")
      .update(Buffer.from(await original.arrayBuffer()))
      .digest("hex"),
  ).toBe(doc.stored.version.sha256);
});
it("lets the PL_010g interpretation with gPgtoVinc replace a PL_010f-era refusal (#501)", async () => {
  // No PL_010f evidence was recorded for this fixture. PL_010f had no gPgtoVinc, so nfe-parser/5
  // with that catalog read the same bytes, listed the group as unsupported and failed the XSD.
  const doc = await importedUnderPl010f(undefined, "invoice-payment-link", (today) => {
    const before = structuredClone(today);
    const document = before.parsing!.document as Partial<Invoice>;
    delete document.nt2026006;
    for (const metadata of [before.metadata!, before.parsing!.metadata]) {
      metadata.versions.parser = "nfe-parser/5";
      metadata.versions.schema = {
        ...metadata.versions.schema!,
        package: "nfe-4.00-010f",
        catalogSha256: SCHEMA_CATALOGS[1]!.catalogSha256,
      };
      metadata.unsupportedFields = ["infNFe.gPgtoVinc"];
    }
    before.checks.xsd = { status: "failed", code: "XSD_INVALID" };
    before.checks.fiscalEvidence = { status: "failed", code: "FISCAL_EVIDENCE_INCONSISTENT" };
    return before;
  });
  expect(doc.stored.payload.nt2026006).toBeNull();
  await doc.reprocess("pl010g-payment-link");
  await doc.rebuildFromOriginals();
  const current = await doc.read();
  expect(current.version.id).not.toBe(doc.stored.version.id);
  expect(current.version.parserVersion).toBe("nfe-parser/8");
  expect(current.payload.nt2026006.gPgtoVinc).toHaveLength(2);
  expect(current.summary.fiscalStatus).toBe("authorized");
  expect(current.fiscalSituation).toMatchObject({
    ruleVersion: "nfe-status/2",
    excluded: [],
    conflicts: [],
  });
  const history = (await (await doc.f.get(`/v1/documents/${doc.documentId}/versions`)).json()).data;
  const ids = history.page.map((row: { version: { id: string } }) => row.version.id);
  expect(ids).toHaveLength(2);
  expect(ids).toEqual(expect.arrayContaining([doc.stored.version.id, current.version.id]));
  const codes = (await doc.evidence()).map((row) => JSON.parse(row.snapshot!).checks.xsd.code);
  expect(codes).toHaveLength(2);
  expect(codes).toEqual(expect.arrayContaining(["XSD_INVALID", "XSD_VALID"]));
});
it("keeps a conflict when the PL_010f-era evidence differs beyond the XSD step", async () => {
  const doc = await importedUnderPl010f((before) => {
    if (before.parsing?.document.kind !== "invoice") throw new Error("invoice required");
    before.parsing.document.total = "24.70";
  });
  await doc.reprocess("pl010g-divergent");
  await doc.rebuildFromOriginals();
  const verified = await doc.read();
  expect(verified.summary.fiscalStatus).toBe("conflict");
  expect(verified.fiscalSituation.conflicts).toEqual([
    `PROCESSING_DISAGREEMENT:${doc.stored.version.sha256}`,
  ]);
});
it("reads documents stored before nfe-parser/3 and extracts the new fields on reprocessing", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
  // Rewind the stored output to what nfe-parser/2 persisted: no purpose, no NT 2026.008/2026.006 fields.
  const strip = (json: string, path: (value: Record<string, any>) => Record<string, any>) => {
    const value = JSON.parse(json);
    delete path(value).purpose;
    delete path(value).nt2026008;
    delete path(value).nt2026006;
    return JSON.stringify(value);
  };
  await f.t.run(async (ctx) => {
    const version = (await ctx.db.get("documentVersions", imported.version._id))!;
    await ctx.db.patch("documentVersions", version._id, {
      parserVersion: "nfe-parser/2",
      result: strip(version.result!, (value) => value.document),
      fiscalEvidence: strip(version.fiscalEvidence!, (value) => value.parsing.document),
    });
    for (const row of await ctx.db.query("documentItems").collect())
      await ctx.db.patch("documentItems", row._id, { data: strip(row.data, (value) => value) });
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.patch("documentFiscalEvidence", row._id, {
        snapshot: strip(row.snapshot!, (value) => value.parsing.document),
      });
  });
  const old = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(old.version.parserVersion).toBe("nfe-parser/2");
  expect(old.payload.purpose).toBeNull();
  expect(old.payload.nt2026008).toBeNull();
  expect(old.payload.nt2026006).toBeNull();
  const oldItems = (
    await (await f.get(`/v1/documents/${documentId}/items`, `&versionId=${old.version.id}`)).json()
  ).data;
  expect(oldItems.page[0].nt2026008).toBeNull();
  expect(old.payload.declaredTotals).toEqual({ vNF: "24.69", vNFTot: null });
  expect(old.summary.fiscalStatus).toBe("authorized");
  const path = `/v1/documents/${documentId}/reprocess?companyId=${f.scope.companyId}`;
  const reservation = (await (await f.request(path, "POST", {}, "purpose-reprocess")).json()).data;
  await f.t.action(internal.operationWorker.run, {
    operationId: reservation.operationId,
    generation: 1,
  });
  await f.rebuild(documentId);
  const current = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(current.version.id).not.toBe(old.version.id);
  expect(current.version.parserVersion).toBe("nfe-parser/8");
  expect(current.payload.purpose).toMatchObject({ code: "1", label: "NF-e normal" });
  expect(current.payload.nt2026008).toEqual({ vProdLiqTot: null });
  expect(current.payload.nt2026006).toEqual({ gPgtoVinc: null });
  // Both versions keep one fingerprint for the same original: no processing disagreement.
  expect(await f.t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect())).toHaveLength(1);
  expect(current.summary.fiscalStatus).toBe("authorized");
  const doc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", documentId as Id<"fiscalDocuments">),
  ))!;
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId: doc._id,
    generation: doc.projectionGeneration!,
    originals: true,
  });
  const verified = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(verified.fiscalSituation.conflicts).toEqual([]);
  expect(verified.summary.fiscalStatus).toBe("authorized");
  const history = (await (await f.get(`/v1/documents/${documentId}/versions`)).json()).data;
  expect(
    history.page.find((row: { version: { id: string } }) => row.version.id === old.version.id)
      .payload.purpose,
  ).toBeNull();
});
