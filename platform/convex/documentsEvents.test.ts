import { createHash } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { processNfe, deriveFiscalSituation } from "../../packages/fiscal-nfe/src/index";
import { EVENT_SCHEMAS } from "../../packages/fiscal-nfe/src/parser";
import type { Id } from "./_generated/dataModel";
import { actor, documentsFixture } from "../../tests/helpers/documents";

/** Fiscal events in the document history: summaries, conflicts, excluded XML and supplier events. */
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
