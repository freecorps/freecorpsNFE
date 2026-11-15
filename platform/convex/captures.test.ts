import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { internal } from "./_generated/api";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { fixture as corpus } from "../../tests/helpers/nfe-corpus";
import { payload } from "./lib/documentCore";
import { fixture, claim, raw, persist, expireAndRerun } from "../../tests/helpers/captures";

/**
 * NF-e distribution capture: identity, persistence and publication, quotas, cooldown and the
 * raw answer after a crash.
 * Companies, keys and documents are synthetic; nothing here reaches a tax authority.
 */
vi.mock("./buildInfo", () => ({ buildSha: "a".repeat(40) }));
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5198",
    CONVEX_SITE_URL: "http://127.0.0.1:3255",
    BETTER_AUTH_SECRET: "synthetic-capture",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("isolates the fiscal identity globally and deduplicates concurrent manual activation", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.command("activate"), f.command("activate")]);
  expect(a.id).toBe(b.id);
  expect(a.operationId).toBe(b.operationId);
  const other = await fixture(f.t);
  await expect(other.command("activate")).rejects.toThrow("STREAM_CONFLICT");
  expect(await f.t.run((ctx) => ctx.db.query("captureStreams").collect())).toHaveLength(1);
});
it("persists envelopes before monotonic checkpoint and publishes each document only once", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const bytes = distributionXml({
    envelopes: [
      { nsu: 1, xml: corpus("summary-authorized") },
      { nsu: 2, xml: corpus("invoice-authorized") },
    ],
  });
  await persist(f, token, bytes);
  expect((await f.command()).checkpoint).toBe(nsu(0));
  await f.t.mutation(internal.operations.checkpoint, token);
  expect((await f.command()).checkpoint).toBe(nsu(2));
  await f.t.mutation(internal.operations.publish, token);
  expect(await f.t.mutation(internal.operations.publish, token)).toBe(false);
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  for (const e of envelopes)
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const docs = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(docs).toHaveLength(1);
  expect(docs[0]?.completeness).toBe(2);
  const artifacts = await f.t.run((ctx) => ctx.db.query("documentArtifacts").collect());
  expect(artifacts.every((a) => a.source === "distribution-xml")).toBe(true);
  const usage = await f.t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(usage.filter((event) => event.metric === "captures")).toHaveLength(1);
  expect(usage.filter((event) => event.metric === "documents")).toHaveLength(1);
  expect(usage.find((event) => event.metric === "bytes")).toMatchObject({
    state: "committed",
    quantity: bytes.length + artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
  });
  expect(await f.t.run((ctx) => ctx.db.query("outboxEvents").collect())).toHaveLength(2);
});
it("captures an NF-e with its purpose and both declared totals in the public payload", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  // Credit note with vNFTot apart from vNF; the edited XML loses its signature, not its identity.
  const xml = corpus("invoice-authorized")
    .toString()
    .replace("<finNFe>1</finNFe>", "<finNFe>5</finNFe><tpNFCredito>04</tpNFCredito>")
    .replace("</ICMSTot>", "</ICMSTot><vNFTot>27.15</vNFTot>");
  await persist(f, token, distributionXml({ envelopes: [{ nsu: 1, xml: Buffer.from(xml) }] }));
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.purpose).toEqual({
    code: "5",
    label: "Nota de crédito",
    creditNoteType: { code: "04", label: "Redução de valores" },
    debitNoteType: null,
    inconsistencies: [],
  });
  expect(data.total).toBe("24.69");
  expect(data.declaredTotals).toEqual({ vNF: "24.69", vNFTot: "27.15" });
});
it("captures an NT 2026.008 invoice valid for PL_010g and publishes its net values", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("invoice-net-values") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  expect(version.code).toBe("IMPORTED");
  expect(JSON.parse(version.result!).checks.xsd.code).toBe("XSD_VALID");
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.nt2026008).toEqual({ vProdLiqTot: "22.45" });
  const [item] = await f.t.run((ctx) => ctx.db.query("documentItems").collect());
  expect(JSON.parse(item!.data).nt2026008.vProdLiq.declared).toBe("22.45");
});
it("captures an NT 2026.006 invoice and publishes its payment links", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("invoice-payment-link") }] }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  const version = (await f.t.run((ctx) =>
    ctx.db.get("documentVersions", doc!.publishedVersionId!),
  ))!;
  expect(version.code).toBe("IMPORTED");
  expect(JSON.parse(version.result!).checks.xsd.code).toBe("XSD_VALID");
  const data = payload(version);
  if (data.kind !== "invoice") throw new Error("invoice required");
  expect(data.nt2026006?.gPgtoVinc?.map((link) => [link.nPag, link.tpMeioPgto])).toEqual([
    ["1", "03"],
    ["2", "17"],
  ]);
});
it("captures a supplier RTC event summary into the history of the captured NF-e (#389)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const unsupported = corpus("event-summary-112150")
    .toString()
    .replace("<tpEvento>112150</tpEvento>", "<tpEvento>211110</tpEvento>");
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-summary-112150"), schema: "resEvento_v1.01.xsd" },
        { nsu: 3, xml: unsupported, schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  const byCode = Object.fromEntries(versions.map((v) => [v.kind + ":" + v.code, v]));
  expect(byCode["event-summary:IMPORTED"]?.documentId).toBe(doc!._id);
  // The deferred type keeps its original and its code, outside the document history.
  const rejected = versions.find((v) => v.code === "XML_EVENT_UNSUPPORTED")!;
  expect(rejected.documentId).toBeUndefined();
  // Fiscal data is not lost: the envelope's exact bytes stay stored, hashed and downloadable.
  const sha256 = createHash("sha256").update(unsupported).digest("hex");
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  expect(envelopes.find((e) => e.nsu === nsu(3))).toMatchObject({
    sha256,
    artifactId: rejected.artifactId,
  });
  const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", rejected.artifactId)))!;
  expect(artifact).toMatchObject({ sha256, source: "distribution-xml" });
  const stored = await f.t.run(async (ctx) =>
    (await ctx.storage.get(artifact.storageId!))!.arrayBuffer(),
  );
  expect(Buffer.from(stored)).toEqual(Buffer.from(unsupported));
  const headers = { Authorization: `Bearer ${f.secret}`, "X-Environment": "sandbox" };
  const listed = (
    await (
      await f.t.fetch(`/v1/document-artifacts?companyId=${f.scope.companyId}`, { headers })
    ).json()
  ).data.page.find((entry: { id: string }) => entry.id === String(artifact._id));
  expect(listed).toMatchObject({ sha256, code: "XML_EVENT_UNSUPPORTED", originalAvailable: true });
  const original = await f.t.fetch(
    `/v1/document-artifacts/${artifact._id}/original?companyId=${f.scope.companyId}`,
    { headers },
  );
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(Buffer.from(unsupported));
  const event = payload(byCode["event-summary:IMPORTED"]!);
  expect(event).toMatchObject({
    kind: "event-summary",
    type: "112150",
    description: "Atualização da Data de Previsão de Entrega",
  });
});
it("captures a 110300 payment link event and its summary into the captured NF-e history (#405)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-110300"), schema: "procEventoNFe_v1.00.xsd" },
        { nsu: 3, xml: corpus("event-summary-110300"), schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  const byCode = Object.fromEntries(versions.map((v) => [v.kind + ":" + v.code, v]));
  for (const kind of ["event", "event-summary"]) {
    expect(byCode[kind + ":IMPORTED"]?.documentId).toBe(doc!._id);
    expect(payload(byCode[kind + ":IMPORTED"]!)).toMatchObject({
      kind,
      type: "110300",
      description: "Vinculação Pagamento",
    });
  }
});
it("keeps a captured issuer's event by another CNPJ outside the NF-e history (#532)", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(
    f,
    token,
    distributionXml({
      envelopes: [
        { nsu: 1, xml: corpus("invoice-authorized"), schema: "procNFe_v4.00.xsd" },
        { nsu: 2, xml: corpus("event-110111-other-author"), schema: "procEventoNFe_v1.00.xsd" },
        { nsu: 3, xml: corpus("event-summary-other-author"), schema: "resEvento_v1.01.xsd" },
      ],
    }),
  );
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  for (const e of await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect()))
    await f.t.action(internal.operationWorker.run, { operationId: e.operationId!, generation: 1 });
  const [doc, ...others] = await f.t.run((ctx) => ctx.db.query("fiscalDocuments").collect());
  expect(others).toEqual([]);
  const versions = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
  expect(versions.filter((v) => v.documentId === doc!._id).map((v) => v.kind)).toEqual(["invoice"]);
  const refused = versions.filter((v) => v.code === "IDENTITY_INVALID");
  expect(refused).toHaveLength(2);
  const envelopes = await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect());
  for (const version of refused) {
    expect(version.documentId).toBeUndefined();
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", version.artifactId)))!;
    expect(envelopes.map((e) => e.artifactId)).toContain(artifact._id);
  }
});
it("checks capture and byte quotas before reserving the source window", async () => {
  const f = await fixture();
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Quota",
    startsAt: Date.now() - 1,
    endsAt: Date.now() + 100000,
    limits: { imports: null, bytes: 0, captures: 10, registry: null, deliveries: null },
    concurrency: 2,
    actor: "test",
    reason: "quota",
    expectedVersion: 0,
  });
  await f.command("activate");
  const token = await claim(f);
  const before = await f.command();
  expect(await f.t.mutation(internal.captureProcessing.prepare, token)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get("operations", token.operationId))).toMatchObject({
    state: "paused",
    code: "QUOTA_EXCEEDED",
    uncertain: false,
  });
  expect((await f.command()).nextAllowedAt).toBe(before.nextAllowedAt);
  expect(
    (await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).filter(
      (e) => e.metric === "captures" || e.metric === "bytes",
    ),
  ).toHaveLength(0);
});
it("does not checkpoint an incomplete raw batch", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  const batchId = await raw(f, token, distributionXml());
  await f.t.mutation(internal.captureProcessing.describe, {
    ...token,
    batchId,
    status: "138",
    lastNsu: nsu(1),
    maxNsu: nsu(1),
    count: 1,
  });
  await f.t.mutation(internal.operations.recordOutcome, {
    ...token,
    outcome: { kind: "success", response: "{}" },
  });
  await expect(f.t.mutation(internal.operations.checkpoint, token)).rejects.toThrow(
    "BATCH_INCOMPLETE",
  );
  expect((await f.command()).checkpoint).toBe(nsu(0));
});
it("cooldown survives manual sync, pause/resume and generic operation retry", async () => {
  const f = await fixture();
  await f.command("activate");
  const token = await claim(f);
  await persist(f, token, distributionXml());
  await f.t.mutation(internal.operations.checkpoint, token);
  await f.t.mutation(internal.operations.publish, token);
  let state = await f.command();
  const until = state.nextAllowedAt;
  expect(until).toBeGreaterThan(Date.now());
  expect((await f.command("sync", state.version)).operationId).toBe(state.operationId);
  state = await f.command("pause", state.version);
  state = await f.command("resume", state.version);
  const newer = await claim(f);
  const input = (await f.t.mutation(internal.captureProcessing.prepare, newer))!;
  expect(input.waitUntil).toBe(until);
  expect(input.waitUntil).toBeGreaterThan(Date.now());
});
it("recovers raw response after crash without another source call; old lease cannot commit", async () => {
  const f = await fixture();
  await f.command("activate");
  const old = await claim(f);
  await raw(
    f,
    old,
    distributionXml({ envelopes: [{ nsu: 1, xml: corpus("summary-authorized") }] }),
  );
  await expireAndRerun(f, old);
  expect((await f.command()).checkpoint).toBe(nsu(1));
  expect(await f.t.mutation(internal.operations.checkpoint, old)).toBe(false);
  expect(await f.t.run((ctx) => ctx.db.query("captureEnvelopes").collect())).toHaveLength(1);
});
