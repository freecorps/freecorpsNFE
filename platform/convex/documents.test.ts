import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "./schema";
import { internal, api, components } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import {
  processNfe,
  deriveFiscalSituation,
  fiscalEvidenceIdentity,
  PARSER_VERSION,
  SCHEMA_CATALOGS,
  type Invoice,
  type ProcessedNfe,
} from "../../packages/fiscal-nfe/src/index";
import { NFE_PARSER_VERSION } from "./lib/importValues";
import { accessKeyDigit } from "../../packages/fiscal-nfe/src/identity";
import { EVENT_SCHEMAS } from "../../packages/fiscal-nfe/src/parser";
import { requestProjection } from "./documentProjection";
import type { Id } from "./_generated/dataModel";
import { routes, errorResponse } from "../../packages/contracts/src/external";
import { FreecorpsClient } from "../../packages/sdk/src/index";
import { CAPTURE_TERMS_VERSION } from "./lib/fiscalCaptureRelease";
import { modules } from "../../tests/helpers/convex-modules";
import { insertFiscal, patchFiscal } from "./lib/capacityCore";
import { insertOriginal } from "./lib/originalStore";
function testDatabase() {
  return convexTest(schema, modules);
}
it("rejects unsupported document and download methods at the public router", async () => {
  const t = testDatabase();
  for (const path of ["/v1/documents", "/v1/documents/example", "/v1/document-download"])
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect((await t.fetch(path, { method })).status).toBe(404);
});
async function actor(
  t: ReturnType<typeof testDatabase>,
  organizationId: Id<"organizations">,
  role: "owner" | "admin" | "operator" | "developer" | "viewer" = "owner",
) {
  const now = Date.now();
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role,
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  return {
    client: t.withIdentity({
      subject: user._id,
      sessionId: session._id,
      issuer: "http://127.0.0.1:3239",
    }),
    membershipId,
  };
}
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
async function fixture(database?: ReturnType<typeof testDatabase>) {
  const t = database ?? convexTest(schema, modules);
  if (!database) register(t);
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "")}${"b".repeat(11)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const bytes = xmlFixture("invoice-signed");
  const model = processNfe(bytes).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await t.run((ctx) => ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document }));
  const headers = {
    Authorization: `Bearer ${secret}`,
    "X-Environment": "sandbox",
    "Content-Type": "application/json",
  };
  async function request(path: string, method = "POST", body?: unknown, key = "first") {
    return t.fetch(path, {
      method,
      headers: { ...headers, "Idempotency-Key": key },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  async function reserve(data = bytes, key = "first") {
    const response = await request(
      "/v1/imports",
      "POST",
      {
        companyId: scope.companyId,
        files: [
          {
            name: "nota.xml",
            size: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        ],
      },
      key,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
      reused: boolean;
    };
  }
  async function upload(batch: Awaited<ReturnType<typeof reserve>>, data = bytes) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/upload`,
    );
    expect(response.status).toBe(200);
    const ticket = (await response.json()).data as { token: string };
    return t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(data),
    });
  }
  async function confirm(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(
      `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}/confirm`,
    );
    expect(response.status).toBe(200);
    return (await response.json()).data as { operationId: Id<"operations">; reused: boolean };
  }
  async function result(batch: Awaited<ReturnType<typeof reserve>>) {
    const response = await request(`/v1/imports/${batch.importId}`, "GET");
    expect(response.status).toBe(200);
    return (await response.json()).data as {
      files: Array<{
        code: string;
        state: string;
        result: string | null;
        documentId: string | null;
        versionId: string | null;
      }>;
    };
  }
  return { t, scope, bytes, request, reserve, upload, confirm, result, keyHash, secret };
}
async function documentsFixture(database?: ReturnType<typeof testDatabase>) {
  const f = await fixture(database);
  await f.t.run(async (ctx) => {
    const key = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:read"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, "documents:read"],
    });
  });
  async function importXml(bytes = f.bytes) {
    const batch = await f.reserve(bytes, crypto.randomUUID());
    expect((await f.upload(batch, bytes)).status).toBe(200);
    const operation = await f.confirm(batch);
    await f.t.action(internal.operationWorker.run, {
      operationId: operation.operationId,
      generation: 1,
    });
    const file = (await f.result(batch)).files[0]!;
    const version = await f.t.run((ctx) =>
      ctx.db.get("documentVersions", file.versionId as Id<"documentVersions">),
    );
    if (file.documentId) await rebuild(file.documentId);
    return { batch, file, version: version! };
  }
  async function rebuild(documentId: string) {
    const doc = (await f.t.run((ctx) =>
      ctx.db.get("fiscalDocuments", documentId as Id<"fiscalDocuments">),
    ))!;
    await f.t.action(internal.documentProjectionWorker.rebuild, {
      documentId: doc._id,
      generation: doc.projectionGeneration!,
    });
  }
  async function get(path = "/v1/documents", extra = "") {
    return f.request(`${path}?companyId=${f.scope.companyId}${extra}`, "GET");
  }
  return {
    ...f,
    importXml,
    get,
    rebuild,
    // The console reads the company: no project.
    queryScope: {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox" as const,
    },
  };
}
it("projects an exact typed document, paginates items and downloads original bytes with read scope", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const listing = await f.get();
  expect(listing.status).toBe(200);
  const list = (await listing.json()).data;
  expect(list.page).toHaveLength(1);
  expect(list.page[0].projectionState).toBe("ready");
  const response = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(response.status).toBe(200);
  const detail = (await response.json()).data;
  expect(detail.contractVersion).toBe("documents/1");
  expect(detail.payload.kind).toBe("invoice");
  const processed = processNfe(xmlFixture("invoice-authorized"));
  expect(detail.fiscalSituation).toEqual(deriveFiscalSituation([processed]));
  expect(detail.payload.total).toBe(
    (processed.normalized!.document as { total: { declared: string } }).total.declared,
  );
  const itemResponse = await f.get(
    `/v1/documents/${detail.summary.id}/items`,
    `&versionId=${detail.version.id}&limit=1`,
  );
  expect(itemResponse.status).toBe(200);
  const items = (await itemResponse.json()).data;
  expect(items.page).toHaveLength(1);
  expect(typeof items.page[0].unitPrice).toBe("string");
  expect(items.page[0].taxes.every((tax: { basis: string }) => tax.basis === "declared")).toBe(
    true,
  );
  const download = await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`);
  expect(download.status).toBe(200);
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(
    createHash("sha256")
      .update(new Uint8Array(await download.arrayBuffer()))
      .digest("hex"),
  ).toBe(detail.version.sha256);
  expect(JSON.stringify(detail)).not.toMatch(
    /storageId|keyHash|sourceKeyId|tokenHash|fiscalEvidence|_creationTime/,
  );
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
it("requires documents:read independently of import rights and rejects revoked keys after warm reads", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:import"] }));
  expect((await f.get()).status).toBe(403);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    403,
  );
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  expect((await f.get()).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  expect((await f.get()).status).toBe(401);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    401,
  );
});
it.each(["key", "grant"] as const)(
  "revoking %s denies the warmed import-to-document journey, including outstanding upload tickets",
  async (revocation) => {
    const f = await documentsFixture(),
      imported = await f.importXml(),
      pending = await f.reserve(f.bytes, "pending");
    const filePath = `/v1/imports/${imported.batch.importId}/files/${imported.batch.fileIds[0]}`;
    const paths = [
      `/v1/imports/${imported.batch.importId}`,
      `${filePath}/history`,
      `/v1/documents?companyId=${f.scope.companyId}`,
      ...["", "/items", "/versions", "/events"].map(
        (suffix) =>
          `/v1/documents/${imported.file.documentId}${suffix}?companyId=${f.scope.companyId}${suffix === "/items" ? `&versionId=${imported.file.versionId}` : ""}`,
      ),
      `/v1/document-artifacts/${imported.version.artifactId}/original?companyId=${f.scope.companyId}`,
    ];
    for (const path of paths) expect((await f.request(path, "GET")).status, path).toBe(200);
    const uploadPath = `/v1/imports/${pending.importId}/files/${pending.fileIds[0]}/upload`;
    const ticket = (await (await f.request(uploadPath)).json()).data;
    await f.t.run(async (ctx) => {
      if (revocation === "key")
        await ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() });
      else {
        const grant = (await ctx.db
          .query("projectCompanies")
          .withIndex("by_projectId_and_companyId", (q) =>
            q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
          )
          .unique())!;
        await ctx.db.patch("projectCompanies", grant._id, { active: false });
      }
    });
    const status = revocation === "key" ? 401 : 404;
    for (const path of paths) {
      const response = await f.request(path, "GET");
      expect(response.status, path).toBe(status);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
    for (const path of [uploadPath, `${filePath}/confirm`, `${filePath}/reprocess`])
      expect((await f.request(path)).status, path).toBe(status);
    const response = await f.t.fetch("/v1/import-upload", {
      method: "POST",
      headers: { "X-Upload-Token": ticket.token },
      body: new Uint8Array(f.bytes),
    });
    expect(response.status).toBe(status);
    expect((await f.t.run((ctx) => ctx.db.get("importFiles", pending.fileIds[0]!)))!.state).toBe(
      "reserved",
    );
  },
);

it.each(["member", "company"] as const)(
  "revoking %s denies human history, items, resume and previously issued download tickets",
  async (revocation) => {
    const f = await documentsFixture(),
      imported = await f.importXml();
    // An operator reaches the company through its own grant, never the integration's.
    const owner = await actor(f.t, f.scope.organizationId, "operator");
    const companyGrant = await f.t.run((ctx) =>
      ctx.db.insert("companyGrants", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        membershipId: owner.membershipId,
        membershipEpoch: 0,
        active: true,
        version: 1,
        updatedAt: Date.now(),
      }),
    );
    const fileId = imported.batch.fileIds[0]!;
    const doc = { ...f.queryScope, documentId: imported.file.documentId! };
    const pagination = { cursor: null, limit: 10 };
    const reads = [
      () =>
        owner.client.query(api.imports.selected, {
          ...f.queryScope,
          batch: imported.batch.importId,
        }),
      () => owner.client.query(api.imports.recent, f.queryScope),
      () => owner.client.action(api.documentContentNode.importHistoryRead, { fileId }),
      () => owner.client.query(api.documents.list, { ...f.queryScope, ...pagination }),
      () => owner.client.action(api.documentContentNode.documentDetailRead, doc),
      () =>
        owner.client.action(api.documentContentNode.documentItemsRead, {
          ...doc,
          ...pagination,
          versionId: imported.file.versionId!,
        }),
      () =>
        owner.client.action(api.documentContentNode.documentVersionsRead, {
          ...doc,
          ...pagination,
        }),
    ];
    for (const read of reads) await expect(read()).resolves.toBeDefined();
    const downloadArgs = { ...f.queryScope, artifactId: imported.version.artifactId };
    const ticket = await owner.client.mutation(api.documentDownloads.ticket, downloadArgs);
    const download = () =>
      f.t.fetch("/v1/document-download", {
        headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
      });
    expect((await download()).status).toBe(200);
    const pending = await f.reserve(f.bytes, "paused");
    await f.upload(pending);
    // The batch is the integration's: people read it but do not change it.
    await expect(
      owner.client.mutation(api.imports.confirm, { fileId: pending.fileIds[0]! }),
    ).rejects.toThrow("INTEGRATION_RECORD");
    const accepted = await f.confirm(pending);
    await expect(
      owner.client.mutation(api.operations.control, {
        operationId: accepted.operationId,
        action: "pause",
        expectedGeneration: 1,
      }),
    ).rejects.toThrow("INTEGRATION_RECORD");
    await expect(
      owner.client.query(api.operations.get, { operationId: accepted.operationId }),
    ).resolves.toMatchObject({ id: accepted.operationId });
    // The integration pauses its own operation through the API.
    expect(
      (
        await f.request(`/v1/operations/${accepted.operationId}/pause`, "POST", {
          expectedGeneration: 1,
        })
      ).status,
    ).toBe(200);
    const operation = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
    await f.t.run(async (ctx) => {
      if (revocation === "member")
        await ctx.db.patch("memberships", owner.membershipId, { state: "removed" });
      else await ctx.db.patch("companyGrants", companyGrant, { active: false, version: 2 });
    });
    for (const read of reads) await expect(read()).rejects.toThrow();
    await expect(owner.client.mutation(api.imports.confirm, { fileId })).rejects.toThrow();
    await expect(
      owner.client.mutation(api.importProcessing.reprocess, { fileId, key: "denied" }),
    ).rejects.toThrow();
    await expect(
      owner.client.mutation(api.operations.control, {
        operationId: operation._id,
        action: "retry",
        expectedGeneration: operation.generation,
      }),
    ).rejects.toThrow();
    await expect(
      owner.client.mutation(api.documentDownloads.ticket, downloadArgs),
    ).rejects.toThrow();
    expect((await download()).status).toBe(404);
    expect((await f.t.run((ctx) => ctx.db.get("operations", operation._id)))!.state).toBe("paused");
  },
);
it("rejects foreign documents, versions and artifacts without revealing their existence", async () => {
  const f = await documentsFixture(),
    other = await documentsFixture(f.t);
  const original = await f.importXml(),
    foreign = await other.importXml();
  expect((await f.get(`/v1/documents/${foreign.file.documentId}`)).status).toBe(404);
  expect(
    (
      await f.get(
        `/v1/documents/${original.file.documentId}`,
        `&versionId=${foreign.file.versionId}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.get(`/v1/document-artifacts/${foreign.version.artifactId}/original`)).status,
  ).toBe(404);
  expect((await f.request(`/v1/documents?companyId=${other.scope.companyId}`, "GET")).status).toBe(
    404,
  );
  // A corrupt/forged listing must not turn page-level authorization into cross-tenant access.
  await f.t.run((ctx) =>
    ctx.db.insert("documentListings", {
      documentId: foreign.file.documentId as Id<"fiscalDocuments">,
      companyId: f.scope.companyId,
      environment: "sandbox",
      filterKey: "*:*",
      date: Date.now() + 1,
    }),
  );
  expect((await f.get()).status).toBe(404);
});
it("summary then full XML and repeated/out-of-order events preserve a reconstructible situation", async () => {
  const f = await documentsFixture();
  const ids = [
    "event-110111",
    "summary-authorized",
    "invoice-authorized",
    "event-110111",
    "summary-authorized",
  ];
  const imported = [];
  for (const id of ids) imported.push(await f.importXml(xmlFixture(id)));
  expect(new Set(imported.map((entry) => entry.file.documentId)).size).toBe(1);
  const detail = (await (await f.get(`/v1/documents/${imported[0]!.file.documentId}`)).json()).data;
  expect(detail.payload.kind).toBe("invoice");
  expect(detail.fiscalSituation).toEqual(
    deriveFiscalSituation(ids.map((id) => processNfe(xmlFixture(id)))),
  );
  expect(detail.summary.fiscalStatus).toBe("cancelled");
  const events = (
    await (await f.get(`/v1/documents/${detail.summary.id}/events`, "&limit=1")).json()
  ).data;
  expect(events.page).toHaveLength(1);
  expect(events.nextCursor).not.toBeNull();
  const history = (
    await (await f.get(`/v1/documents/${detail.summary.id}/versions`, "&limit=1")).json()
  ).data;
  expect(history.nextCursor).not.toBeNull();
  const old = (
    await (
      await f.get(`/v1/documents/${detail.summary.id}`, `&versionId=${imported[1]!.file.versionId}`)
    ).json()
  ).data;
  expect(old.payload.kind).toBe("summary");
  expect(old.summary.completeness).toBe("summary");
});
it("conflicting claims remain explicit and a stale reconstruction cannot overwrite a newer generation", async () => {
  const f = await documentsFixture(),
    first = await f.importXml(xmlFixture("summary-authorized"));
  const before = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", first.file.documentId as Id<"fiscalDocuments">),
  ))!;
  await f.importXml(xmlFixture("summary-conflicting-total"));
  const detail = (await (await f.get(`/v1/documents/${first.file.documentId}`)).json()).data;
  expect(detail.fiscalSituation.reportedStatus).toBe("conflict");
  await f.t.mutation(internal.documentProjection.finish, {
    documentId: before._id,
    generation: before.projectionGeneration!,
    state: "ready",
    situation: before.fiscalSituation!,
  });
  const after = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", before._id)))!;
  expect(after.fiscalSituation!.reportedStatus).toBe("conflict");
});
it.each(["event-rejected-conflicting-claims", "event-unlinked-conflicting-claims"])(
  "preserves excluded XML without polluting the persisted situation: %s",
  async (eventId) => {
    const f = await documentsFixture();
    const invoice = await f.importXml(xmlFixture("invoice-authorized"));
    const excluded = await f.importXml(xmlFixture(eventId));
    expect(excluded.file.documentId).toBe(invoice.file.documentId);
    let detail = (await (await f.get(`/v1/documents/${invoice.file.documentId}`)).json()).data;
    expect(detail.fiscalSituation.reportedStatus).toBe("authorized");
    await f.importXml(xmlFixture("event-110111"));
    detail = (await (await f.get(`/v1/documents/${invoice.file.documentId}`)).json()).data;
    expect(detail.fiscalSituation.reportedStatus).toBe("cancelled");
    expect(detail.fiscalSituation.conflicts).toEqual([]);
    expect(detail.fiscalSituation.excluded).toContainEqual({
      id: createHash("sha256").update(xmlFixture(eventId)).digest("hex"),
      reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS",
    });
    expect(await f.t.run((ctx) => ctx.db.get("documentVersions", excluded.version._id))).toEqual(
      excluded.version,
    );
    const stored = await f.t.run((ctx) =>
      ctx.db.get("fiscalDocuments", invoice.file.documentId as Id<"fiscalDocuments">),
    );
    expect(stored?.fiscalSituation?.reportedStatus).toBe("cancelled");
  },
);
it("download tickets expire and membership removal invalidates issued tickets", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId);
  const token = await viewer.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId: imported.version.artifactId,
  });
  const request = () =>
    f.t.fetch("/v1/document-download", {
      headers: { Origin: "http://localhost:5190", "X-Download-Token": token.token },
    });
  expect((await request()).status).toBe(200);
  await f.t.run((ctx) => ctx.db.patch("memberships", viewer.membershipId, { state: "removed" }));
  expect((await request()).status).toBe(404);
  await expect(
    viewer.client.action(api.documentContentNode.documentDetailRead, {
      ...f.queryScope,
      documentId: imported.file.documentId!,
    }),
  ).rejects.toThrow();
  const owner = await actor(f.t, f.scope.organizationId),
    expiring = await owner.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    });
  vi.setSystemTime(Date.now() + 60_001);
  expect(
    (
      await f.t.fetch("/v1/document-download", {
        headers: { Origin: "http://localhost:5190", "X-Download-Token": expiring.token },
      })
    ).status,
  ).toBe(404);
});
it("ticket de download desconhecido, fora do console, de outro original ou com acesso trocado responde 404 sem auditar nem cobrar (#134)", async () => {
  const f = await documentsFixture(),
    other = await documentsFixture(f.t);
  const imported = await f.importXml(),
    foreign = await other.importXml();
  const owner = await actor(f.t, f.scope.organizationId);
  const issue = () =>
    owner.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    });
  const download = (token: string, origin = "http://localhost:5190", search = "") =>
    f.t.fetch(`/v1/document-download${search}`, {
      headers: { Origin: origin, "X-Download-Token": token },
    });
  const refused = async (response: Response) => {
    expect(response.status).toBe(404);
    expect(errorResponse.parse(await response.json()).error.code).toBe("NOT_FOUND");
  };
  const effects = () =>
    f.t.run(async (ctx) => ({
      audits: (await ctx.db.query("operationalAudit").collect()).filter(
        (row) => row.action === "http.documentDownload",
      ).length,
      charges: (await ctx.db.query("capacityEvents").collect()).filter(
        (row) => row.metric === "downloadsBytes",
      ).length,
    }));
  // Control: an intact ticket downloads, and that download is audited and charged.
  const ticket = await issue();
  expect((await download(ticket.token)).status).toBe(200);
  const before = await effects();
  expect(before.audits).toBeGreaterThan(0);
  expect(before.charges).toBeGreaterThan(0);

  await refused(await download("x".repeat(72)));
  await refused(await download(ticket.token, "https://exemplo.invalid"));
  await refused(await download(ticket.token, "http://localhost:5190", "?download=1"));
  // A ticket whose row names another organization's original.
  const swapped = await issue(),
    swappedHash = await hashApiKey(swapped.token);
  await f.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("documentDownloads")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", swappedHash))
      .unique())!;
    await ctx.db.patch("documentDownloads", row._id, { artifactId: foreign.version.artifactId });
  });
  await refused(await download(swapped.token));
  // The member's access changed after the ticket was issued: still a manager, another version.
  const changed = await issue();
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", owner.membershipId, { role: "admin", version: 2 }),
  );
  await refused(await download(changed.token));
  expect(await effects()).toEqual(before);
});
it("refuses to serve a hot original whose stored file no longer matches the recorded hash (#110)", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const artifactId = imported.version.artifactId;
  const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifactId)))!;
  // `patchFiscal` and `insertFiscal` refuse the originals' rows in the type and at runtime: only
  // `lib/originalStore.ts` writes them.
  await expect(
    f.t.run((ctx) =>
      // @ts-expect-error The XML originals' rows are written only by lib/originalStore.ts.
      patchFiscal(ctx, "documentArtifacts", artifactId, { sha256: "0".repeat(64) }),
    ),
  ).rejects.toThrow("ORIGINAL_WRITER");
  const { _id, _creationTime, ...copy } = artifact;
  await expect(
    f.t.run((ctx) =>
      // @ts-expect-error The XML originals' rows are written only by lib/originalStore.ts.
      insertFiscal(ctx, "documentArtifacts", copy),
    ),
  ).rejects.toThrow("ORIGINAL_WRITER");
  // Its single writer records only a hash and size that describe the stored file.
  await expect(
    f.t.run((ctx) =>
      insertOriginal(ctx, { ...copy, storageId: artifact.storageId!, sha256: "0".repeat(64) }),
    ),
  ).rejects.toThrow("INVALID_FILE");
  // Nor a hot row that carries a cold object's hash or size.
  for (const cold of [{ objectSha256: "0".repeat(64) }, { objectSize: artifact.size }])
    await expect(
      f.t.run((ctx) => insertOriginal(ctx, { ...copy, storageId: artifact.storageId!, ...cold })),
    ).rejects.toThrow("INVALID_FILE");

  // A file swapped under the row, same size and other bytes, by a write outside ingestion.
  const swapped = await f.t.run(async (ctx) => {
    const bytes = new Uint8Array(await (await ctx.storage.get(artifact.storageId!))!.arrayBuffer());
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 1;
    const storageId = await ctx.storage.store(new Blob([bytes]));
    await ctx.db.patch("documentArtifacts", artifactId, { storageId });
    return storageId;
  });
  expect(swapped).not.toBe(artifact.storageId);
  const charges = () =>
    f.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("capacityEvents")
            .withIndex("by_organizationId_and_metric_and_key", (q) =>
              q.eq("organizationId", f.scope.organizationId).eq("metric", "downloadsBytes"),
            )
            .collect()
        ).length,
    );
  const before = await charges();
  const rest = await f.get(`/v1/document-artifacts/${artifactId}/original`);
  expect(rest.status).toBe(404);
  expect(errorResponse.parse(await rest.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");
  const owner = await actor(f.t, f.scope.organizationId);
  const ticket = await owner.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId,
  });
  const console = await f.t.fetch("/v1/document-download", {
    headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
  });
  expect(console.status).toBe(404);
  expect(errorResponse.parse(await console.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");
  // A refused download charges nothing.
  expect(await charges()).toBe(before);
  // A file of another size is refused the same way.
  await f.t.run(async (ctx) => {
    const bytes = await (await ctx.storage.get(artifact.storageId!))!.arrayBuffer();
    const storageId = await ctx.storage.store(new Blob([bytes, new Uint8Array([0x0a])]));
    await ctx.db.patch("documentArtifacts", artifactId, { storageId });
  });
  const longer = await f.get(`/v1/document-artifacts/${artifactId}/original`);
  expect(longer.status).toBe(404);
  expect(errorResponse.parse(await longer.json()).error.code).toBe("ORIGINAL_UNAVAILABLE");

  // The row back on its own file serves it again.
  await f.t.run((ctx) =>
    ctx.db.patch("documentArtifacts", artifactId, { storageId: artifact.storageId }),
  );
  expect((await f.get(`/v1/document-artifacts/${artifactId}/original`)).status).toBe(200);
});
it("limita downloads antes do storage e da auditoria, compartilhando o orçamento entre tickets", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const reader = await actor(f.t, f.scope.organizationId);
  const args = { ...f.queryScope, artifactId: imported.version.artifactId };
  const first = await reader.client.mutation(api.documentDownloads.ticket, args);
  const second = await reader.client.mutation(api.documentDownloads.ticket, args);
  const download = (token: string) =>
    f.t.fetch("/v1/document-download", {
      headers: { Origin: "http://localhost:5190", "X-Download-Token": token },
    });
  for (let i = 0; i < 60; i++) expect((await download(first.token)).status).toBe(200);
  const before = await f.t.run((ctx) => ctx.db.query("operationalAudit").collect());
  // If the handler reaches storage after saturation, it would report ORIGINAL_UNAVAILABLE.
  await f.t.run(async (ctx) => {
    const artifact = await ctx.db.get("documentArtifacts", imported.version.artifactId);
    await ctx.storage.delete(artifact!.storageId!);
  });
  for (let i = 0; i < 20; i++) {
    const denied = await download(second.token);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("1");
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5190");
  }
  const after = await f.t.run((ctx) => ctx.db.query("operationalAudit").collect());
  expect(after).toHaveLength(before.length + 1);
  expect(after.at(-1)?.action).toBe("http.rateLimited");
  await f.t.run((ctx) => ctx.db.patch("memberships", reader.membershipId, { state: "removed" }));
  expect((await download(second.token)).status).toBe(404);
});
it("reindexes existing publications and rebuilds from original bytes without rewriting their versions", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) =>
        q.eq("documentId", imported.file.documentId as Id<"fiscalDocuments">),
      )
      .collect();
    for (const row of rows) await ctx.db.delete("documentListings", row._id);
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    await ctx.db.patch("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">, {
      listedAt: undefined,
      projectionGeneration: undefined,
      projectionState: undefined,
      fiscalSituation: undefined,
    });
    await ctx.db.patch("documentVersions", imported.version._id, {
      publishedAt: undefined,
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
    });
  });
  expect((await f.get()).status).toBe(200);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId: imported.file.documentId as Id<"fiscalDocuments">,
    generation: 1,
    cursor: null,
  });
  const backfillDoc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId: backfillDoc._id,
    generation: backfillDoc.projectionGeneration!,
    cursor: null,
  });
  await f.rebuild(imported.file.documentId!);
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.summary.projectionState).toBe("ready");
  expect(detail.summary.fiscalStatus).toBe("authorized");
  const stored = (await f.t.run((ctx) => ctx.db.get("documentVersions", imported.version._id)))!;
  expect(stored.result).toBe(imported.version.result);
  expect(stored.outputHash).toBe(imported.version.outputHash);
});
it("bounded filters and cursors reject changed context and malformed input", async () => {
  const f = await documentsFixture();
  await f.importXml();
  expect((await f.get("/v1/documents", "&limit=10000")).status).toBe(400);
  expect((await f.get("/v1/documents", "&from=NaN")).status).toBe(400);
  expect((await f.get("/v1/documents", "&key=invalid")).status).toBe(400);
  expect((await f.get("/v1/documents", "&status=made-up")).status).toBe(400);
  expect((await f.get("/v1/documents", "&cursor=invalid")).status).toBe(400);
  expect((await f.get("/v1/documents", "&storageId=private")).status).toBe(400);
  const noMatch = (await (await f.get("/v1/documents", "&status=cancelled")).json()).data;
  expect(noMatch.page).toEqual([]);
});
it("unavailable original preserves the completed result and cannot produce a download URL", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db.get("documentArtifacts", imported.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
  });
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.payload.kind).toBe("invoice");
  expect(detail.version.originalAvailable).toBe(false);
  expect((await f.get(`/v1/document-artifacts/${detail.version.artifactId}/original`)).status).toBe(
    404,
  );
});
it("never indexes stale authorization while rebuilding and refuses viewer processing", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await expect(
    viewer.client.mutation(api.documents.rebuild, {
      ...f.queryScope,
      documentId: imported.file.documentId!,
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  expect(await viewer.client.query(api.documents.canProcess, f.queryScope)).toBe(false);
  const owner = await actor(f.t, f.scope.organizationId);
  await owner.client.mutation(api.documents.rebuild, {
    ...f.queryScope,
    documentId: imported.file.documentId!,
  });
  const pending = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(pending.summary.fiscalStatus).toBe("unknown");
  expect(pending.fiscalSituation).toBeNull();
  expect(pending.previousFiscalSituation.reportedStatus).toBe("authorized");
  expect((await (await f.get("/v1/documents", "&status=authorized")).json()).data.page).toEqual([]);
  const doc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId: doc._id,
    generation: doc.projectionGeneration!,
    originals: true,
  });
  expect((await (await f.get(`/v1/documents/${doc._id}`)).json()).data.fiscalSituation).toEqual(
    deriveFiscalSituation([processNfe(xmlFixture("invoice-authorized"))]),
  );
});
it("deduplicates fiscal interpretations independently of history and preserves disagreements", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const record = {
    versionId: imported.version._id,
    snapshot: imported.version.fiscalEvidence!,
    fingerprint: imported.version.fiscalFingerprint!,
  };
  for (let i = 0; i < 260; i++) await f.t.mutation(internal.documentProjection.record, record);
  expect(await f.t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect())).toHaveLength(1);
  await f.rebuild(imported.file.documentId!);
  expect(
    (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data.summary
      .fiscalStatus,
  ).toBe("authorized");
  // Even differences outside the compact fiscal snapshot remain a processing disagreement.
  await f.t.mutation(internal.documentProjection.record, {
    ...record,
    fingerprint: "f".repeat(64),
  });
  await f.rebuild(imported.file.documentId!);
  const detail = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("conflict");
  expect(detail.fiscalSituation.conflicts).toContain(
    `PROCESSING_DISAGREEMENT:${imported.version.fiscalEvidence ? JSON.parse(imported.version.fiscalEvidence).metadata.originalSha256 : ""}`,
  );
  for (let i = 2; i < 257; i++)
    await f.t.mutation(internal.documentProjection.record, {
      ...record,
      fingerprint: i.toString(16).padStart(64, "0"),
    });
  await f.rebuild(imported.file.documentId!);
  const limited = (await (await f.get(`/v1/documents/${imported.file.documentId}`)).json()).data;
  expect(limited.summary.projectionState).toBe("limit-exceeded");
  expect(limited.fiscalSituation).toBeNull();
  expect(limited.previousFiscalSituation.reportedStatus).toBe("conflict");
});
it("reprocesses through HTTP 202 using one operation and keeps old versions and exact items", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const path = `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`;
  const first = await f.request(path, "POST", {}, "doc-reprocess");
  expect(first.status).toBe(202);
  const reservation = (await first.json()).data;
  const repeated = await f.request(path, "POST", {}, "doc-reprocess");
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data).toEqual({ ...reservation, reused: true });
  await f.t.action(internal.operationWorker.run, {
    operationId: reservation.operationId,
    generation: 1,
  });
  const history = (await (await f.get(`/v1/documents/${imported.file.documentId}/versions`)).json())
    .data;
  expect(history.page).toHaveLength(2);
  expect(history.page.map((r: { version: { id: string } }) => r.version.id)).toContain(
    imported.version._id,
  );
  const files = (await (await f.get(`/v1/documents/${imported.file.documentId}/files`)).json())
    .data;
  expect(files.page).toHaveLength(1);
  expect(Object.keys(files.page[0]).sort()).toEqual([
    "id",
    "importedAt",
    "name",
    "originalAvailable",
    "sha256",
    "size",
    "source",
  ]);
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { scopes: ["documents:read"] }));
  expect((await f.request(path, "POST", {}, "denied")).status).toBe(403);
});
it("preserves and serves unknown-schema originals without inventing a logical NF-e", async () => {
  const f = await documentsFixture(),
    bytes = Buffer.from("<unknown><script>globalThis.compromised=true</script></unknown>");
  await f.importXml(bytes);
  const list = (await (await f.get("/v1/document-artifacts")).json()).data;
  expect(list.page).toHaveLength(1);
  expect(list.page[0].code).toBe("XML_NAMESPACE_UNSUPPORTED");
  const original = await f.get(`/v1/document-artifacts/${list.page[0].id}/original`);
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  expect((await (await f.get()).json()).data.page).toEqual([]);
});
it("paginates sixty exact items and binds real cursors to the selected version", async () => {
  const f = await documentsFixture();
  const xml = xmlFixture("invoice-authorized").toString("utf8");
  const item = xml.match(/<det nItem="1">[\s\S]*?<\/det>/)![0];
  const bytes = Buffer.from(
    xml.replace(
      item,
      Array.from({ length: 60 }, (_, i) => item.replace('nItem="1"', `nItem="${i + 1}"`)).join(""),
    ),
  );
  const imported = await f.importXml(bytes),
    products = processNfe(bytes).normalized!.document;
  if (products.kind !== "invoice") throw new Error("Expected invoice");
  const { projectNfeItem } = await import("../../packages/contracts/src/documents");
  const rows: unknown[] = [];
  let cursor: string | null = null,
    firstCursor: string | null = null,
    pages = 0;
  do {
    const response = await f.get(
      `/v1/documents/${imported.file.documentId}/items`,
      `&versionId=${imported.version._id}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(response.status).toBe(200);
    const batch = (await response.json()).data;
    rows.push(...batch.page);
    cursor = batch.nextCursor;
    firstCursor ??= cursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(rows).toEqual(products.products.map(projectNfeItem));
  const newer = await f.importXml(bytes);
  expect(
    (
      await f.get(
        `/v1/documents/${imported.file.documentId}/items`,
        `&versionId=${newer.version._id}&cursor=${encodeURIComponent(firstCursor!)}`,
      )
    ).status,
  ).toBe(400);
});
it("backfills a legacy operation completing after the document was already migrated", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    await ctx.db.patch("documentVersions", imported.version._id, {
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
      publishedAt: undefined,
    });
  });
  await f.t.mutation(internal.importProcessing.published, {
    operationId: imported.version.operationId,
  });
  const doc = (await f.t.run((ctx) =>
    ctx.db.get("fiscalDocuments", imported.file.documentId as Id<"fiscalDocuments">),
  ))!;
  expect(doc.evidenceBackfill).toBe(true);
  expect(doc.projectionState).toBe("pending");
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId: doc._id,
    generation: doc.projectionGeneration!,
    cursor: null,
  });
  await f.rebuild(doc._id);
  expect((await (await f.get(`/v1/documents/${doc._id}`)).json()).data.summary.fiscalStatus).toBe(
    "authorized",
  );
});
it("replays the same logical reprocess intention after a summary evolves to a full XML", async () => {
  const f = await documentsFixture(),
    summary = await f.importXml(xmlFixture("summary-authorized"));
  const path = `/v1/documents/${summary.file.documentId}/reprocess?companyId=${f.scope.companyId}`;
  const first = await f.request(path, "POST", {}, "stable-logical-document");
  expect(first.status).toBe(202);
  const accepted = (await first.json()).data;
  const full = await f.importXml(xmlFixture("invoice-authorized"));
  expect(full.file.documentId).toBe(summary.file.documentId);
  const repeated = await f.request(path, "POST", {}, "stable-logical-document");
  expect(repeated.status).toBe(202);
  expect((await repeated.json()).data).toEqual({ ...accepted, reused: true });
  const op = (await f.t.run((ctx) => ctx.db.get("operations", accepted.operationId)))!;
  expect(JSON.parse(op.request).artifactId).toBe(summary.version.artifactId);
  const next = await f.request(path, "POST", {}, "new-intention");
  expect(next.status).toBe(202);
  const nextOperation = (await next.json()).data;
  expect(
    JSON.parse(
      (await f.t.run((ctx) => ctx.db.get("operations", nextOperation.operationId)))!.request,
    ).artifactId,
  ).toBe(full.version.artifactId);
});
it("revoking the integration's grant stops its key, not the people of the company", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { active: false });
  });
  expect((await f.get()).status).toBe(404);
  const doc = { ...f.queryScope, documentId: imported.file.documentId! };
  expect(
    (await viewer.client.action(api.documentContentNode.documentDetailRead, doc)).summary.id,
  ).toBe(doc.documentId);
  expect(
    (await viewer.client.query(api.documents.list, { ...f.queryScope, cursor: null, limit: 10 }))
      .page,
  ).toHaveLength(1);
  const ticket = await viewer.client.mutation(api.documentDownloads.ticket, {
    ...f.queryScope,
    artifactId: imported.version.artifactId,
  });
  const download = await f.t.fetch("/v1/document-download", {
    headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
  });
  expect(download.status).toBe(200);
  // Reading is not writing: a viewer neither reprocesses nor rebuilds.
  await expect(
    viewer.client.mutation(api.documents.reprocess, { ...doc, key: "viewer" }),
  ).rejects.toThrow("SCOPE_DENIED");
  expect(await viewer.client.query(api.documents.canProcess, f.queryScope)).toBe(false);
  // A developer with access to the company reads through integrations, not the console.
  const developer = await actor(f.t, f.scope.organizationId, "owner");
  await f.t.run((ctx) =>
    ctx.db.patch("memberships", developer.membershipId, { role: "developer" }),
  );
  await expect(
    developer.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("NOT_FOUND");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: developer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  await expect(
    developer.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("SCOPE_DENIED");
  await expect(
    developer.client.mutation(api.documentDownloads.ticket, {
      ...f.queryScope,
      artifactId: imported.version.artifactId,
    }),
  ).rejects.toThrow("SCOPE_DENIED");
  // Another organization's member, or a login without membership, does not reach this company.
  const other = await documentsFixture(f.t);
  const outsider = await actor(other.t, other.scope.organizationId);
  await expect(
    outsider.client.action(api.documentContentNode.documentDetailRead, doc),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    outsider.client.action(api.documentContentNode.documentDetailRead, {
      ...doc,
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow("NOT_FOUND");
});
it("refuses silently ignored API filters", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  for (const suffix of ["versions", "files"])
    expect(
      (await f.get(`/v1/documents/${imported.file.documentId}/${suffix}`, "&kind=garbage")).status,
    ).toBe(400);
});
it("keeps the published version readable between checkpoint and operation success", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const accepted = await f.request(
    `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`,
    "POST",
    {},
    "checkpoint-window",
  );
  const { operationId } = (await accepted.json()).data;
  const op = (await f.t.mutation(internal.operations.claim, { operationId, generation: 1 }))!;
  const claim = { operationId, generation: 1, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  const outcome = await f.t.action(internal.importWorker.execute, {
    ...claim,
    request: op.request,
  });
  expect(outcome.kind).toBe("success");
  await f.t.mutation(internal.operations.recordOutcome, { ...claim, outcome });
  expect(await f.t.mutation(internal.operations.checkpoint, claim)).toBe(true);
  const during = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(during.status).toBe(200);
  expect((await during.json()).data.version.id).toBe(imported.version._id);
  expect((await (await f.get()).json()).data.page[0].versionId).toBe(imported.version._id);
  expect(await f.t.mutation(internal.operations.publish, claim)).toBe(true);
  const after = await f.get(`/v1/documents/${imported.file.documentId}`);
  expect(after.status).toBe(200);
  expect((await after.json()).data.version.id).not.toBe(imported.version._id);
});

it("fences stale history index jobs and restarts indexing when a new projection is requested", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const documentId = imported.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  await f.t.run(async (ctx) => {
    await ctx.db.patch("fiscalDocuments", documentId, {
      historyIndexing: true,
      evidenceBackfill: true,
      projectionGeneration: 10,
    });
    await ctx.db.patch("documentVersions", imported.version._id, { publishedAt: undefined });
  });
  await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 10,
    cursor: null,
  });
  const stale = await f.t.run(async (ctx) => ({
    doc: await ctx.db.get("fiscalDocuments", documentId),
    version: await ctx.db.get("documentVersions", imported.version._id),
    jobs: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
  expect(stale.doc).toMatchObject({ historyIndexing: true, projectionGeneration: 11 });
  expect(stale.version?.publishedAt).toBeUndefined();
  expect(
    stale.jobs.some(
      (job) => job.name.includes("backfillVersions") && job.args[0]?.generation === 11,
    ),
  ).toBe(true);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 11,
    cursor: null,
  });
  const current = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
  expect(current).toMatchObject({ historyIndexing: false, projectionGeneration: 12 });
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 11,
    cursor: null,
  });
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toEqual(current);
});

it("keeps failed evidence backfill incomplete until the missing cancellation original is restored", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const cancellation = await f.importXml(xmlFixture("event-110111"));
  const documentId = invoice.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  const before = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("documentFiscalEvidence").collect())
      await ctx.db.delete("documentFiscalEvidence", row._id);
    const artifact = (await ctx.db.get("documentArtifacts", cancellation.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
    await ctx.db.patch("documentVersions", cancellation.version._id, {
      fiscalEvidence: undefined,
      fiscalFingerprint: undefined,
    });
    await ctx.db.patch("fiscalDocuments", documentId, { evidenceBackfill: true });
  });
  async function attempt() {
    await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
    const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
    await f.t.action(internal.documentProjectionWorker.backfill, {
      documentId,
      generation: doc.projectionGeneration!,
      cursor: null,
    });
  }
  for (let i = 0; i < 2; i++) {
    await attempt();
    const doc = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
    expect(doc).toMatchObject({ evidenceBackfill: true, projectionState: "unavailable" });
    const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
    expect(detail.summary.fiscalStatus).toBe("unknown");
    expect(detail.fiscalSituation).toBeNull();
    expect(detail.previousFiscalSituation).toEqual(before.fiscalSituation);
  }
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([new Uint8Array(xmlFixture("event-110111"))]),
    );
    await ctx.db.patch("documentArtifacts", cancellation.version.artifactId, { storageId });
  });
  await attempt();
  await f.rebuild(documentId);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toMatchObject({
    evidenceBackfill: false,
    projectionState: "ready",
  });
  const restored = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(restored.fiscalSituation.reportedStatus).toBe("cancelled");
});

it("limits ticket writes per organization and membership without exhausting another reader's budget", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const first = await actor(f.t, f.scope.organizationId),
    second = await actor(f.t, f.scope.organizationId);
  const args = { ...f.queryScope, artifactId: imported.version.artifactId };
  for (let i = 0; i < 60; i++) await first.client.mutation(api.documentDownloads.ticket, args);
  await expect(first.client.mutation(api.documentDownloads.ticket, args)).rejects.toThrow(
    "RATE_LIMITED",
  );
  expect(await f.t.run((ctx) => ctx.db.query("documentDownloads").collect())).toHaveLength(60);
  await expect(second.client.mutation(api.documentDownloads.ticket, args)).resolves.toMatchObject({
    expiresAt: Date.now() + 60_000,
  });
});

it("resolves authorized deep-linked summaries outside the first selector page", async () => {
  const f = await documentsFixture(),
    owner = await actor(f.t, f.scope.organizationId);
  const selected = await f.t.mutation(internal.testing.documentProof.selectorPages, {
    companyId: f.scope.companyId,
    projectId: f.scope.projectId,
  });
  const companies = await owner.client.query(api.companies.list, {
    organizationId: f.scope.organizationId,
    contextKey: "proof",
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(companies.page.map((row) => row.id)).not.toContain(selected.companyId);
  const args = {
    organizationId: f.scope.organizationId,
    company: selected.companyId,
    contextKey: "proof",
  };
  expect(await owner.client.query(api.consoleCompany.context, args)).toMatchObject({
    id: selected.companyId,
    name: "Empresa paginada 21",
    canRead: true,
  });
  const other = await documentsFixture(f.t);
  expect(
    await owner.client.query(api.consoleCompany.context, {
      ...args,
      company: other.scope.companyId,
    }),
  ).toBeNull();
});

it("links document reprocessing to its import only when the project matches", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const owner = await actor(f.t, f.scope.organizationId);
  const original = (await f.t.run((ctx) => ctx.db.get("importFiles", imported.batch.fileIds[0]!)))!;
  // The import came from the integration; the console reprocesses in its own project and the
  // integration's batch never shows the console operation.
  const fromConsole = await owner.client.mutation(api.documents.reprocess, {
    ...f.queryScope,
    documentId: imported.file.documentId!,
    key: "console",
  });
  await f.t.action(internal.operationWorker.run, {
    operationId: fromConsole.operationId,
    generation: 1,
  });
  const consoleProject = await f.t.run(async (ctx) => {
    const op = (await ctx.db.get("operations", fromConsole.operationId))!;
    return (await ctx.db.get("projects", op.projectId))!;
  });
  expect(consoleProject.kind).toBe("console");
  expect(
    (await f.t.run((ctx) => ctx.db.get("importFiles", original._id)))!.processingOperationId,
  ).toBeUndefined();
  // The same project's key links the new processing to its import.
  const response = await f.request(
    `/v1/documents/${imported.file.documentId}/reprocess?companyId=${f.scope.companyId}`,
    "POST",
    {},
    "same-project",
  );
  expect(response.status).toBe(202);
  const byKey = (await response.json()).data as { operationId: Id<"operations"> };
  await f.t.action(internal.operationWorker.run, { operationId: byKey.operationId, generation: 1 });
  const after = (await f.t.run((ctx) => ctx.db.get("importFiles", original._id)))!;
  expect(after.operationId).toBe(original.operationId);
  expect(after.processingOperationId).toBe(byKey.operationId);
  const summary = (await (await f.request(`/v1/imports/${imported.batch.importId}`, "GET")).json())
    .data;
  expect(summary.files[0]).toMatchObject({ operationId: byKey.operationId, state: "succeeded" });
});

it("preserves manual original verification through indexing and a concurrent automatic request", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = imported.file.documentId as Id<"fiscalDocuments">;
  const owner = await actor(f.t, f.scope.organizationId);
  await f.t.run(async (ctx) => {
    const artifact = (await ctx.db.get("documentArtifacts", imported.version.artifactId))!;
    await ctx.storage.delete(artifact.storageId!);
    await ctx.db.patch("fiscalDocuments", documentId, {
      historyIndexing: true,
      evidenceBackfill: true,
      projectionGeneration: 20,
    });
  });
  await owner.client.mutation(api.documents.rebuild, { ...f.queryScope, documentId });
  await f.t.run((ctx) => requestProjection(ctx, documentId));
  const requested = await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId));
  expect(requested).toMatchObject({ projectionGeneration: 22, projectionVerifyOriginals: true });
  await f.t.mutation(internal.documentProjection.finish, {
    documentId,
    generation: 21,
    state: "unavailable",
    situation: null,
  });
  expect(
    (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!.projectionVerifyOriginals,
  ).toBe(true);
  await f.t.mutation(internal.documentProjection.backfillVersions, {
    documentId,
    generation: 22,
    cursor: null,
  });
  await f.t.action(internal.documentProjectionWorker.backfill, {
    documentId,
    generation: 23,
    cursor: null,
  });
  // Saved snapshots suffice for backfill; the final rebuild must still reopen the original.
  await f.rebuild(documentId);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", documentId))).toMatchObject({
    historyIndexing: false,
    evidenceBackfill: false,
    projectionVerifyOriginals: false,
    projectionState: "unavailable",
  });
  const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("unknown");
  expect(detail.fiscalSituation).toBeNull();
  expect(detail.previousFiscalSituation.reportedStatus).toBe("authorized");
});

it("starts the legacy listing backfill on a read only when unindexed documents exist", async () => {
  const f = await documentsFixture();
  const imported = await f.importXml(xmlFixture("invoice-authorized"));
  const id = imported.version.documentId!;
  await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) => q.eq("documentId", id))
      .collect();
    for (const row of rows) await ctx.db.delete("documentListings", row._id);
    await ctx.db.patch("fiscalDocuments", id, { listedAt: undefined });
  });
  const response = await f.get();
  expect(response.status).toBe(200);
  expect((await response.json()).data.page).toHaveLength(1);
  expect((await f.t.run((ctx) => ctx.db.get("fiscalDocuments", id)))!.listedAt).toBeDefined();
});

it("rejects a key that expires after a successful indexed page read", async () => {
  const f = await documentsFixture();
  await f.importXml();
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { expiresAt: Date.now() + 1000 }));
  expect((await f.get()).status).toBe(200);
  vi.setSystemTime(Date.now() + 1001);
  const response = await f.get();
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("INVALID_API_KEY");
});

it("keeps capabilities restricted to the sandbox validation environment", async () => {
  const f = await fixture();
  const sandbox = await f.request("/v1/capabilities", "GET");
  expect(sandbox.status).toBe(200);
  expect(routes.getCapabilities.output.parse(await sandbox.json()).data.environment).toBe(
    "sandbox",
  );
  await expect(
    f.t.query(internal.capabilityRest.authorize, {
      keyHash: f.keyHash,
      environment: "production",
    }),
  ).rejects.toThrow("ENVIRONMENT_DENIED");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { environment: "production" }));
  vi.stubEnv("PRODUCT_ENV", "production");
  await expect(
    f.t.query(internal.capabilityRest.authorize, {
      keyHash: f.keyHash,
      environment: "production",
    }),
  ).rejects.toThrow("Invalid platform configuration: PRODUCT_ENV");
  const denied = await f.request("/v1/capabilities", "GET");
  expect(denied.status).toBe(503);
  expect(errorResponse.parse(await denied.json()).error.code).toBe("UNAVAILABLE");
});

it("validates real responses and errors against the independent public contract", async () => {
  const f = await documentsFixture();
  const imported = await f.importXml(xmlFixture("invoice-authorized"));
  const docId = imported.file.documentId!;
  const response = await f.get(`/v1/documents/${docId}`);
  expect(response.status).toBe(200);
  const detail = routes.getDocument.output.parse(await response.json());
  const inputs = [
    [routes.listDocuments.output, await f.get()],
    [
      routes.documentItems.output,
      await f.get(`/v1/documents/${docId}/items`, `&versionId=${detail.data.version.id}`),
    ],
    [routes.documentVersions.output, await f.get(`/v1/documents/${docId}/versions`)],
    [routes.documentFiles.output, await f.get(`/v1/documents/${docId}/files`)],
    [routes.listArtifacts.output, await f.get("/v1/document-artifacts")],
  ] as const;
  for (const [contract, result] of inputs) {
    expect(result.status).toBe(200);
    const body: unknown = await result.json();
    expect(contract.safeParse(body).success).toBe(true);
    expect(result.headers.get("X-Request-Id")).toBe((body as { requestId: string }).requestId);
  }
  const tampered = structuredClone(detail);
  Object.assign(tampered.data.summary, { total: 24.69 });
  expect(routes.getDocument.output.safeParse(tampered).success).toBe(false);
  Object.assign(tampered.data, { storageId: "private" });
  expect(routes.getDocument.output.safeParse(tampered).success).toBe(false);
  const caps = await f.request("/v1/capabilities", "GET");
  expect(caps.status).toBe(200);
  expect(routes.getCapabilities.output.parse(await caps.json()).data.models).toEqual([
    "55",
    "nfse",
  ]);
  const stranger = await documentsFixture();
  const denied = await stranger.get(`/v1/documents/${docId}`);
  expect(denied.status).toBe(404);
  expect(errorResponse.parse(await denied.json()).error.code).toBe("NOT_FOUND");
  await f.t.run((ctx) => ctx.db.patch("apiKeys", f.scope.keyId, { revokedAt: Date.now() }));
  for (const result of [
    await f.get(`/v1/documents/${docId}`),
    await f.request("/v1/capabilities", "GET"),
  ]) {
    expect(result.status).toBe(401);
    expect(errorResponse.parse(await result.json()).error.code).toBe("INVALID_API_KEY");
  }
});

it("correlaciona evento fiscal à operação que o recebeu mesmo com outra versão publicada", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const event = await f.importXml(xmlFixture("event-110111"));
  expect(event.version.operationId).not.toBe(invoice.version.operationId);
  const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", invoice.version.documentId!)))!;
  expect(doc.publishedVersionId).toBe(invoice.version._id);
  const emitted = (await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_action_and_createdAt", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("action", "document.event_received"),
      )
      .first(),
  ))!;
  expect(emitted.operationId).toBe(event.version.operationId);
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const rows = await owner.client.query(api.observability.investigate, {
    organizationId: f.scope.organizationId,
    reference: emitted.eventId!,
    contextKey: "test",
  });
  expect(
    rows.some(
      (r) => r.operationId === event.version.operationId && r.action.startsWith("operation."),
    ),
  ).toBe(true);
});

it("attaches a supported RTC supplier event to the NF-e history without changing its status (#389)", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = invoice.file.documentId!;
  // 110001 (cancelamento de evento) stays unsupported: preserved original, no document link.
  const unsupported = await f.importXml(
    Buffer.from(xmlFixture("event-112150").toString().replaceAll("112150", "110001")),
  );
  expect(unsupported.file).toMatchObject({ code: "XML_EVENT_UNSUPPORTED", documentId: null });
  const update = await f.importXml(xmlFixture("event-112150"));
  const summary = await f.importXml(xmlFixture("event-summary-112150"));
  for (const entry of [update, summary])
    expect(entry.file).toMatchObject({ code: "IMPORTED", documentId });
  const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(detail.payload.kind).toBe("invoice");
  expect(detail.summary.fiscalStatus).toBe("authorized");
  expect(detail.fiscalSituation.conflicts).toEqual([]);
  for (const kind of ["event", "event-summary"]) {
    const path = `/v1/documents/${documentId}/events`;
    const events = (await (await f.get(path, `&kind=${kind}`)).json()).data;
    expect(events.page.map((item: { payload: unknown }) => item.payload)).toEqual([
      expect.objectContaining({
        kind,
        type: "112150",
        description: "Atualização da Data de Previsão de Entrega",
        author: expect.objectContaining({ document: "11222333000181" }),
      }),
    ]);
  }
  const received = await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_action_and_createdAt", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("action", "document.event_received"),
      )
      .collect(),
  );
  expect(received.map((row) => row.operationId)).toContain(update.version.operationId);
});

it("attaches a 110300 payment link event to the NF-e history and keeps an earlier refusal (#405)", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = invoice.file.documentId!;
  // Before nfe-parser/7 the type was not accepted: the same bytes were refused and preserved.
  const accepted: Record<string, string> = EVENT_SCHEMAS;
  delete accepted["110300"];
  let refused: Awaited<ReturnType<typeof f.importXml>>;
  try {
    refused = await f.importXml(xmlFixture("event-110300"));
  } finally {
    accepted["110300"] = "nfe-4.00-010g";
  }
  expect(refused.file).toMatchObject({ code: "XML_EVENT_UNSUPPORTED", documentId: null });
  const link = await f.importXml(xmlFixture("event-110300"));
  const summary = await f.importXml(xmlFixture("event-summary-110300"));
  for (const entry of [link, summary])
    expect(entry.file).toMatchObject({ code: "IMPORTED", documentId });
  expect(link.version.artifactId).not.toBe(refused.version.artifactId);
  const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(detail.payload.kind).toBe("invoice");
  expect(detail.summary.fiscalStatus).toBe("authorized");
  expect(detail.fiscalSituation.conflicts).toEqual([]);
  for (const kind of ["event", "event-summary"]) {
    const path = `/v1/documents/${documentId}/events`;
    const events = (await (await f.get(path, `&kind=${kind}`)).json()).data;
    expect(events.page.map((item: { payload: unknown }) => item.payload)).toEqual([
      expect.objectContaining({
        kind,
        type: "110300",
        description: "Vinculação Pagamento",
        author: expect.objectContaining({ document: "11222333000181" }),
      }),
    ]);
  }
  const received = await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_action_and_createdAt", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("action", "document.event_received"),
      )
      .collect(),
  );
  expect(received.map((row) => row.operationId)).toContain(link.version.operationId);
  // The earlier refusal stays as it was: its own artifact, outside the document, with the bytes.
  const artifacts = (await (await f.get("/v1/document-artifacts")).json()).data.page;
  expect(
    artifacts.find((entry: { id: string }) => entry.id === refused.version.artifactId),
  ).toMatchObject({ code: "XML_EVENT_UNSUPPORTED", originalAvailable: true });
  const original = await f.get(`/v1/document-artifacts/${refused.version.artifactId}/original`);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(xmlFixture("event-110300"));
  // A detail the XSD refuses (author other than the issuer) is preserved, but the situation
  // excludes it as a technical failure, like any event refused at the XSD step.
  await f.importXml(xmlFixture("event-110300-wrong-author"));
  const after = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(after.summary.fiscalStatus).toBe("authorized");
  expect(after.fiscalSituation.excluded).toContainEqual({
    id: createHash("sha256").update(xmlFixture("event-110300-wrong-author")).digest("hex"),
    reason: "TECHNICAL_VALIDATION_FAILED",
  });
});

it("refuses an issuer's event signed by another CNPJ and keeps its original (#532)", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = invoice.file.documentId!;
  for (const id of ["event-110111-other-author", "event-110300-other-author"]) {
    const refused = await f.importXml(xmlFixture(id));
    expect(refused.file).toMatchObject({ code: "IDENTITY_INVALID", documentId: null });
    const original = await f.get(`/v1/document-artifacts/${refused.version.artifactId}/original`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(xmlFixture(id));
  }
  // The cancellation by another CNPJ does not cancel the NF-e nor enter its history.
  const detail = (await (await f.get(`/v1/documents/${documentId}`)).json()).data;
  expect(detail.summary.fiscalStatus).toBe("authorized");
  expect(detail.fiscalSituation.conflicts).toEqual([]);
  const events = (await (await f.get(`/v1/documents/${documentId}/events`)).json()).data;
  expect(events.page).toEqual([]);
});

it("pins the parser the mutations compare to the NF-e package (#499)", () => {
  expect(NFE_PARSER_VERSION).toBe(PARSER_VERSION);
});

type DocumentsFixture = Awaited<ReturnType<typeof documentsFixture>>;
/**
 * A supported event original refused before #498, as `nfe-parser/4` did: the bytes of `fixture`
 * imported under a type the parser still refuses, then the artifact gets the supported bytes and
 * the version the older parser. `capture` turns the artifact into one received by the capture;
 * `keep` leaves the unsupported bytes, a type the current parser still refuses.
 */
async function olderRefusal(
  f: DocumentsFixture,
  fixture: string,
  { capture = false, keep = false } = {},
) {
  const unsupported = Buffer.from(xmlFixture(fixture).toString().replaceAll("112150", "110001"));
  const bytes = keep ? unsupported : xmlFixture(fixture);
  const refused = await f.importXml(unsupported);
  expect(refused.file).toMatchObject({ code: "XML_EVENT_UNSUPPORTED", documentId: null });
  const artifactId = refused.version.artifactId;
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)]));
    await ctx.db.patch("documentArtifacts", artifactId, {
      storageId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(capture
        ? {
            source: "distribution-xml" as const,
            fileId: undefined,
            processingOperationId: refused.version.operationId,
          }
        : {}),
    });
    await ctx.db.patch("documentVersions", refused.version._id, { parserVersion: "nfe-parser/4" });
  });
  return { artifactId, version: refused.version };
}
async function refusalChildren(f: DocumentsFixture, run: string) {
  const records = await f.t.run((ctx) => ctx.db.query("idempotencyRecords").collect());
  return records.filter(
    (r) => r.name === "documents.reprocess_refusals" && r.key.startsWith(`${run}:`),
  );
}
async function eventsReceived(f: DocumentsFixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_action_and_createdAt", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("action", "document.event_received"),
      )
      .collect(),
  );
}
async function artifactVersions(f: DocumentsFixture, artifactId: Id<"documentArtifacts">) {
  return f.t.run((ctx) =>
    ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .collect(),
  );
}
/** Runs the operation's attempts, each at its persisted time, until it leaves the queue. */
async function drive(f: DocumentsFixture, operationId: Id<"operations">) {
  for (let n = 0; n < 30; n++) {
    const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) return op;
    if (op.nextAttemptAt > Date.now()) vi.setSystemTime(op.nextAttemptAt);
    await f.t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
  throw new Error("operation did not settle");
}
async function driveChildren(f: DocumentsFixture, run: string) {
  const children = await refusalChildren(f, run);
  return Promise.all(children.map((child) => drive(f, child.operationId)));
}
/** The release state the approved workflow would leave (`captureRelease.set`). */
async function release(f: DocumentsFixture, released: boolean) {
  await f.t.run(async (ctx) => {
    const { organizationId, companyId } = f.scope;
    const prior = await ctx.db
      .query("captureReleases")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .unique();
    const version = (prior?.version ?? 0) + 1;
    const fields = { organizationId, companyId, released, blocked: false, minIntervalHours: 1 };
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      ...fields,
      version,
      kind: released ? "console_release" : "console_withdraw",
      ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
      revokedKeys: 0,
      reason: "Liberação sintética da captura",
      buildSha: null,
      deployment: "",
      createdAt: Date.now(),
    });
    const state = {
      ...fields,
      releasedBefore: true,
      actor: "operator:freecorps",
      reason: "Liberação sintética da captura",
      version,
      updatedAt: Date.now(),
      eventId,
    };
    if (prior) await ctx.db.replace("captureReleases", prior._id, state);
    else await ctx.db.insert("captureReleases", state);
  });
}

it("reprocesses technical refusals of an older parser into the NF-e history, once (#499)", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = invoice.file.documentId as Id<"fiscalDocuments">;
  const imported = await olderRefusal(f, "event-112150");
  const captured = await olderRefusal(f, "event-summary-112150", { capture: true });
  // Refused before and still unsupported: reprocessed once, refused again.
  const still = await olderRefusal(f, "event-112150", { keep: true });
  // Refused by the current parser: reprocessing would only repeat it.
  const current = await f.importXml(
    Buffer.from(xmlFixture("event-112150").toString().replaceAll("112150", "110001")),
  );
  // Out of reach: another environment, another company of the organization, another organization.
  const production = await olderRefusal(f, "event-112150");
  const otherCompany = await olderRefusal(f, "event-summary-112150");
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
    const companyId = await ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    await ctx.db.patch("documentArtifacts", production.artifactId, { environment: "production" });
    await ctx.db.patch("documentArtifacts", otherCompany.artifactId, { companyId });
  });
  const other = await documentsFixture(f.t);
  const foreign = await olderRefusal(other, "event-112150");
  const received = (await eventsReceived(f)).length;

  const owner = await actor(f.t, f.scope.organizationId, "owner");
  expect(await owner.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(true);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toBeNull();
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(run.reused).toBe(false);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: run.operationId,
    state: "queued",
    done: false,
    live: true,
    requested: 0,
  });
  // While the run is live, asking again returns it; two requests at once open one run.
  const [again, twin] = await Promise.all([
    owner.client.mutation(api.refusalReprocess.request, f.queryScope),
    owner.client.mutation(api.refusalReprocess.request, f.queryScope),
  ]);
  expect([again, twin]).toEqual([
    { operationId: run.operationId, reused: true },
    { operationId: run.operationId, reused: true },
  ]);
  const swept = await drive(f, run.operationId);
  expect(swept.state).toBe("succeeded");
  expect(JSON.parse(swept.response!)).toEqual({ requested: 3 });
  const children = await refusalChildren(f, run.operationId);
  expect(children.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [imported.artifactId, captured.artifactId, still.artifactId].sort(),
  );
  // The children start one at a time, never all at once.
  const starts = await f.t.run((ctx) =>
    Promise.all(children.map(async (r) => (await ctx.db.get("operations", r.operationId))!)),
  );
  expect(new Set(starts.map((op) => op.nextAttemptAt)).size).toBe(3);
  // Finished searching is not finished reprocessing: with children pending, the run is still
  // live, and asking again returns it.
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    live: true,
    requested: 3,
    busy: 0,
    pending: 3,
    reprocessed: 0,
  });
  expect(await owner.client.mutation(api.refusalReprocess.request, f.queryScope)).toEqual({
    operationId: run.operationId,
    reused: true,
  });

  const tasks = await driveChildren(f, run.operationId);
  expect(tasks.map((t) => `${t.task.name}:${t.state}`).sort((a, b) => a.localeCompare(b))).toEqual([
    "documents.capture:succeeded",
    "documents.reprocess:succeeded",
    "documents.reprocess:succeeded",
  ]);
  for (const refusal of [imported, captured]) {
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", refusal.artifactId)))!;
    expect(artifact.documentId).toBe(documentId);
    // The earlier refusal stays in the artifact's history; the new interpretation joins the NF-e.
    expect(
      (await artifactVersions(f, refusal.artifactId)).map((v) => [
        v.code,
        v.parserVersion,
        v.documentId ?? null,
      ]),
    ).toEqual([
      ["XML_EVENT_UNSUPPORTED", "nfe-parser/4", null],
      ["IMPORTED", PARSER_VERSION, documentId],
    ]);
  }
  for (const kind of ["event", "event-summary"]) {
    const path = `/v1/documents/${documentId}/events`;
    expect((await (await f.get(path, `&kind=${kind}`)).json()).data.page).toHaveLength(1);
  }
  // As in the normal ingestion, the event (not its summary) notifies `document.event_received`.
  const notified = (await eventsReceived(f)).slice(received);
  expect(notified.map((row) => row.operationId)).toEqual([
    children.find((r) => r.key.endsWith(imported.artifactId))!.operationId,
  ]);
  expect(
    (await artifactVersions(f, still.artifactId)).map((v) => [v.parserVersion, v.documentId]),
  ).toEqual([
    ["nfe-parser/4", undefined],
    [PARSER_VERSION, undefined],
  ]);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    live: false,
    requested: 3,
    reprocessed: 2,
    stillRefused: 1,
    failed: 0,
    pending: 0,
    partial: false,
  });

  // Asking again after it finished opens a run that finds nothing left: no version, no webhook.
  const versionCount = (await f.t.run((ctx) => ctx.db.query("documentVersions").collect())).length;
  const admin = await actor(f.t, f.scope.organizationId, "admin");
  const next = await admin.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(next).toMatchObject({ reused: false });
  expect(JSON.parse((await drive(f, next.operationId)).response!)).toEqual({ requested: 0 });
  expect(await refusalChildren(f, next.operationId)).toEqual([]);
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: next.operationId,
    done: true,
    requested: 0,
  });
  expect(await refusalChildren(f, run.operationId)).toHaveLength(3);
  expect((await f.t.run((ctx) => ctx.db.query("documentVersions").collect())).length).toBe(
    versionCount,
  );
  expect((await eventsReceived(f)).length).toBe(received + 1);

  // What it must not reach keeps its single refused version and no document.
  for (const [fixture, artifactId] of [
    [f, current.version.artifactId],
    [f, production.artifactId],
    [f, otherCompany.artifactId],
    [other, foreign.artifactId],
  ] as const) {
    expect(await artifactVersions(fixture, artifactId)).toHaveLength(1);
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifactId)))!;
    expect(artifact.documentId).toBeUndefined();
  }
});

it("resumes the sweep from the persisted cursor after a lost lease, page by page (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const refusals = [
    await olderRefusal(f, "event-112150"),
    await olderRefusal(f, "event-summary-112150"),
    await olderRefusal(f, "event-112150", { keep: true }),
  ];
  // A leftover version of an operation that finished does not hold an original back; one of an
  // operation still working does.
  const leftover = await olderRefusal(f, "event-summary-112150", { keep: true });
  const busy = await olderRefusal(f, "event-112150", { keep: true });
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  await f.t.run(async (ctx) => {
    for (const [refusal, operationId] of [
      [leftover, leftover.version.operationId],
      [busy, run.operationId],
    ] as const) {
      const { _id, _creationTime, publishedAt: _published, ...version } = refusal.version;
      await ctx.db.insert("documentVersions", {
        ...version,
        operationId,
        state: "staging",
        entryIndex: 9,
      });
    }
  });
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: run.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: op.generation, fence: op.fence };
  expect(await f.t.mutation(internal.operations.beginEffect, claim)).toBe(true);
  const first = await f.t.mutation(internal.refusalReprocess.sweep, { ...claim, pageSize: 2 });
  expect(first).toMatchObject({ kind: "page", done: false });
  const afterFirst = (await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!;
  expect(afterFirst.refusalSweep?.cursor).not.toBeNull();
  // The attempt is lost before its outcome: recovery reconciles from the cursor kept above.
  vi.setSystemTime(Date.now() + 61_000);
  await f.t.mutation(internal.operations.recoverOne, { operationId: run.operationId });
  expect((await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!.state).toBe(
    "reconciling",
  );
  const done = await drive(f, run.operationId);
  expect(done.state).toBe("succeeded");
  const children = await refusalChildren(f, run.operationId);
  const artifacts = children.flatMap((r) => r.key.split(":").slice(1, 2));
  expect(artifacts.sort()).toEqual(
    [...refusals.map((r) => r.artifactId), leftover.artifactId].sort(),
  );
  expect(JSON.parse(done.response!)).toEqual({ requested: 4 });
  expect(done.refusalSweep?.requested).toBe(4);
});

it("reads one page per attempt, waits for its children to start and counts partially (#499)", async () => {
  const f = await documentsFixture();
  const model = await olderRefusal(f, "event-112150", { keep: true });
  // 51 more originals refused by the older parser: two pages of the executor (50 each).
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...artifact } = (await ctx.db.get(
      "documentArtifacts",
      model.artifactId,
    ))!;
    const { _id: _v, _creationTime: _vc, ...version } = model.version;
    for (let n = 0; n < 51; n++) {
      const artifactId = await ctx.db.insert("documentArtifacts", artifact);
      await ctx.db.insert("documentVersions", {
        ...version,
        artifactId,
        parserVersion: "nfe-parser/4",
      });
    }
  });
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  const startedAt = Date.now();
  await f.t.action(internal.operationWorker.run, { operationId: run.operationId, generation: 1 });
  const waiting = (await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!;
  // A wait, not a failure: no attempt spent, the next page after the page's last child starts.
  expect(waiting).toMatchObject({ state: "retry_wait", code: "SWEEP_CONTINUES", attempts: 0 });
  expect(waiting.refusalSweep?.requested).toBe(50);
  expect(waiting.nextAttemptAt).toBeGreaterThanOrEqual(startedAt + 49 * 2_000);
  const firstPage = await refusalChildren(f, run.operationId);
  expect(firstPage).toHaveLength(50);
  const starts = await f.t.run((ctx) =>
    Promise.all(firstPage.map(async (r) => (await ctx.db.get("operations", r.operationId))!)),
  );
  const times = starts.map((op) => op.nextAttemptAt).sort((a, b) => a - b);
  expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(49 * 2_000);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    state: "retry_wait",
    done: false,
    requested: 50,
  });

  const done = await drive(f, run.operationId);
  expect(done.state).toBe("succeeded");
  expect(JSON.parse(done.response!)).toEqual({ requested: 52 });
  expect(await refusalChildren(f, run.operationId)).toHaveLength(52);

  // Past the 200 children the status reads, the counts are partial even with the sweep done.
  const pending = firstPage[0]!.operationId;
  await f.t.run(async (ctx) => {
    for (let n = 0; n < 150; n++)
      await ctx.db.insert("idempotencyRecords", {
        organizationId: f.scope.organizationId,
        projectId: done.projectId,
        name: "documents.reprocess_refusals",
        key: `${run.operationId}:extra${n}`,
        requestHash: done.requestHash,
        operationId: pending,
      });
  });
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    requested: 52,
    partial: true,
    pending: 200,
  });
});

it("opens a new run once the requester lost access mid-run (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const first = await olderRefusal(f, "event-112150");
  const second = await olderRefusal(f, "event-summary-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  // The first page reprocesses one original; then the requester loses the role mid-run.
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: runA.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: op.generation, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  await f.t.mutation(internal.refusalReprocess.sweep, { ...claim, pageSize: 1 });
  await driveChildren(f, runA.operationId);
  await f.t.run((ctx) => ctx.db.patch("memberships", owner.membershipId, { role: "viewer" }));
  vi.setSystemTime(Date.now() + 61_000);
  await f.t.mutation(internal.operations.recoverOne, { operationId: runA.operationId });
  const stopped = await drive(f, runA.operationId);
  expect(stopped).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
  // Paused for good: nobody can resume it, so it is not live.
  const admin = await actor(f.t, f.scope.organizationId, "admin");
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: false,
  });
  const runB = await admin.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect((await drive(f, runB.operationId)).state).toBe("succeeded");
  await driveChildren(f, runB.operationId);
  const reprocessed = [
    ...(await refusalChildren(f, runA.operationId)),
    ...(await refusalChildren(f, runB.operationId)),
  ].flatMap((r) => r.key.split(":").slice(1, 2));
  // Each original once, across both runs.
  expect(reprocessed.sort()).toEqual([first.artifactId, second.artifactId].sort());
  for (const refusal of [first, second])
    expect(await artifactVersions(f, refusal.artifactId)).toHaveLength(2);
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    done: true,
    reprocessed: 1,
  });
});

it("serves Production of the site while the release holds and after it is withdrawn (#499)", async () => {
  vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
  const f = await documentsFixture();
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { kind: "declared" }));
  const first = await olderRefusal(f, "event-112150", { capture: true });
  const second = await olderRefusal(f, "event-summary-112150", { capture: true });
  await f.t.run(async (ctx) => {
    for (const refusal of [first, second])
      await ctx.db.patch("documentArtifacts", refusal.artifactId, { environment: "production" });
  });
  const production = { ...f.queryScope, environment: "production" as const };
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  // Never released: Production does not exist for the company.
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(false);
  await expect(owner.client.mutation(api.refusalReprocess.request, production)).rejects.toThrow();
  await expect(owner.client.query(api.refusalReprocess.status, production)).rejects.toThrow();

  await release(f, true);
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(true);
  const run = await owner.client.mutation(api.refusalReprocess.request, production);
  expect((await drive(f, run.operationId)).state).toBe("succeeded");
  // Withdrawn before the children run: what was received still becomes a document.
  await release(f, false);
  const tasks = await driveChildren(f, run.operationId);
  expect(tasks.map((t) => [t.task.name, t.state, t.environment])).toEqual([
    ["documents.capture", "succeeded", "production"],
    ["documents.capture", "succeeded", "production"],
  ]);
  const doc = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", first.artifactId)))!;
  const fiscal = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", doc.documentId!)))!;
  expect(fiscal.environment).toBe("production");
  expect(await owner.client.query(api.refusalReprocess.status, production)).toMatchObject({
    done: true,
    reprocessed: 2,
  });
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(true);
  // After the withdrawal, a new request still opens a run, which finds nothing left.
  const again = await owner.client.mutation(api.refusalReprocess.request, production);
  expect(again.reused).toBe(false);
  expect(JSON.parse((await drive(f, again.operationId)).response!)).toEqual({ requested: 0 });
  // A viewer reads the status in Production and cannot ask.
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: viewer.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await viewer.client.query(api.refusalReprocess.canRequest, production)).toBe(false);
  expect(await viewer.client.query(api.refusalReprocess.status, production)).toMatchObject({
    operationId: again.operationId,
  });
});

it("lets only owner, admin and operator of the company ask for the reprocessing (#499)", async () => {
  const f = await documentsFixture();
  const other = await documentsFixture(f.t);
  for (const role of ["viewer", "developer"] as const) {
    const member = await actor(f.t, f.scope.organizationId, role);
    expect(await member.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
    await expect(
      member.client.mutation(api.refusalReprocess.request, f.queryScope),
    ).rejects.toThrow();
  }
  // A member of another organization reaches neither this company nor its status.
  const stranger = await actor(f.t, other.scope.organizationId, "owner");
  await expect(
    stranger.client.mutation(api.refusalReprocess.request, f.queryScope),
  ).rejects.toThrow();
  await expect(stranger.client.query(api.refusalReprocess.status, f.queryScope)).rejects.toThrow();
  await expect(
    stranger.client.query(api.refusalReprocess.canRequest, f.queryScope),
  ).rejects.toThrow();
  // Its own organization with this company as selector is not a way in either.
  await expect(
    stranger.client.mutation(api.refusalReprocess.request, {
      ...f.queryScope,
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow();
  const operator = await actor(f.t, f.scope.organizationId, "operator");
  // An operator acts on the companies granted to it.
  expect(await operator.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
  await expect(
    operator.client.mutation(api.refusalReprocess.request, f.queryScope),
  ).rejects.toThrow();
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: operator.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await operator.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(true);
  const run = await operator.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(run.reused).toBe(false);
  // Through the executor, with nothing to reprocess.
  await drive(f, run.operationId);
  expect(await operator.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    state: "succeeded",
    done: true,
    requested: 0,
    pending: 0,
  });
  const records = await f.t.run((ctx) => ctx.db.query("idempotencyRecords").collect());
  // The run's own reservation and the pointer of the company and environment, no child.
  expect(
    records.filter((r) => r.name === "documents.reprocess_refusals").map((r) => r.operationId),
  ).toEqual([run.operationId, run.operationId]);
});

it("lets a later run pick only the leftovers, and a resumed old run duplicate nothing (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const done = await olderRefusal(f, "event-112150");
  const stuck = await olderRefusal(f, "event-summary-112150");
  const byArtifact = await olderRefusal(f, "event-112150");
  const byFile = await olderRefusal(f, "event-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  // Reprocessings asked elsewhere (REST, the capture) that have not written a version yet.
  const queued = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...op } = (await ctx.db.get("operations", runA.operationId))!;
    const id = await ctx.db.insert("operations", { ...op, nextAttemptAt: Date.now() + 3_600_000 });
    await ctx.db.patch("documentArtifacts", byArtifact.artifactId, { processingOperationId: id });
    const artifact = (await ctx.db.get("documentArtifacts", byFile.artifactId))!;
    await ctx.db.patch("importFiles", artifact.fileId!, { processingOperationId: id });
    return id;
  });
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  // The two held originals are counted, not reprocessed.
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    requested: 2,
    busy: 2,
    live: true,
  });
  const childrenA = await refusalChildren(f, runA.operationId);
  expect(childrenA.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [done.artifactId, stuck.artifactId].sort(),
  );
  // One child stops for good; the operation that held the other two fails.
  const stuckChild = childrenA.find((r) => r.key.endsWith(stuck.artifactId))!.operationId;
  await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", stuckChild, {
      state: "paused",
      code: "ATTEMPTS_EXHAUSTED",
      attempts: 6,
    });
    await ctx.db.patch("operations", queued, { state: "failed", code: "TASK_FAILED" });
  });
  await drive(f, childrenA.find((r) => r.key.endsWith(done.artifactId))!.operationId);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: false,
    reprocessed: 1,
    failed: 1,
  });

  // A new run takes only what is left: the stuck original and the two no longer held.
  const runB = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect((await drive(f, runB.operationId)).state).toBe("succeeded");
  const childrenB = await refusalChildren(f, runB.operationId);
  expect(childrenB.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [stuck.artifactId, byArtifact.artifactId, byFile.artifactId].sort(),
  );
  // Run A comes back (a resumption by hand) while B's children are live: it adds none.
  await f.t.run((ctx) =>
    ctx.db.patch("operations", runA.operationId, {
      state: "queued",
      stage: "ready",
      attempts: 0,
      response: undefined,
      refusalSweep: { cursor: null, requested: 2 },
      nextAttemptAt: Date.now(),
    }),
  );
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  expect(await refusalChildren(f, runA.operationId)).toHaveLength(2);
  // Its second pass skips its own stuck original (its child exists) and finds the two others B
  // is handling: busy, not reprocessed.
  const resumed = (await f.t.run((ctx) => ctx.db.get("operations", runA.operationId)))!;
  expect(resumed.refusalSweep).toMatchObject({ requested: 2, busy: 2 });
  await driveChildren(f, runB.operationId);
  for (const refusal of [done, stuck, byArtifact, byFile])
    expect(await artifactVersions(f, refusal.artifactId)).toHaveLength(2);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    reprocessed: 3,
    failed: 0,
    pending: 0,
  });
});

it("lets a reader follow the reprocessing without asking for it (#499)", async () => {
  const f = await documentsFixture();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: viewer.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await viewer.client.query(api.refusalReprocess.canRead, f.queryScope)).toBe(true);
  expect(await viewer.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
  const developer = await actor(f.t, f.scope.organizationId, "developer");
  expect(await developer.client.query(api.refusalReprocess.canRead, f.queryScope)).toBe(false);
});

it("reports originals still held by an earlier operation instead of nothing left (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const held = await olderRefusal(f, "event-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  const [child] = await refusalChildren(f, runA.operationId);
  // A's child pauses by a person's hand: resumable, so A stays live and the console follows it.
  await f.t.run((ctx) =>
    ctx.db.patch("operations", child!.operationId, { state: "paused", code: "PAUSED_BY_USER" }),
  );
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: true,
    pending: 1,
  });
  expect(await owner.client.mutation(api.refusalReprocess.request, f.queryScope)).toEqual({
    operationId: runA.operationId,
    reused: true,
  });
  // Once nobody can resume the child, a new run opens; an outside operation holds the original.
  const outside = await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", child!.operationId, {
      state: "failed",
      code: "TASK_FAILED",
    });
    const { _id, _creationTime, ...op } = (await ctx.db.get("operations", runA.operationId))!;
    const id = await ctx.db.insert("operations", { ...op, state: "queued" });
    await ctx.db.patch("documentArtifacts", held.artifactId, { processingOperationId: id });
    return id;
  });
  expect(outside).toBeTruthy();
  const runB = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect(JSON.parse((await drive(f, runB.operationId)).response!)).toEqual({ requested: 0 });
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    done: true,
    live: false,
    requested: 0,
    busy: 1,
  });
});

it("tells the console which tier holds each listed note (ADR 0010, phase C)", async () => {
  const f = await documentsFixture(),
    imported = await f.importXml();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      membershipId: viewer.membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  const documentId = imported.file.documentId! as Id<"fiscalDocuments">;
  const tier = async () =>
    (await viewer.client.query(api.documents.list, { ...f.queryScope, cursor: null, limit: 10 }))
      .page[0]!.storageTier;
  expect(await tier()).toBe("hot");
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", documentId, { coldState: "cold" }));
  expect(await tier()).toBe("cold");
  // A note still moving reads as hot: each version is read from wherever it is.
  await f.t.run((ctx) =>
    ctx.db.patch("fiscalDocuments", documentId, { coldState: "moving", coldClaimedAt: 0 }),
  );
  expect(await tier()).toBe("hot");
});
