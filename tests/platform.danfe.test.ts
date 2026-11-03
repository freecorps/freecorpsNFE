/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { components, internal, api } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import { DANFE_RENDERS_PER_MINUTE, DANFE_VERSION } from "../platform/convex/lib/danfeValues";
import { serveDanfe } from "../platform/convex/documentDanfe";
import { DANFE_GENERATOR_VERSION } from "../packages/fiscal-nfe/src/danfe";
import { processNfe } from "../packages/fiscal-nfe/src/index";
import { errorResponse } from "../packages/contracts/src/external";
import { FreecorpsClient } from "../packages/sdk/src/index";
import type { Id } from "../platform/convex/_generated/dataModel";
import { fixture as xmlFixture } from "./helpers/nfe-corpus";
import { companyGrant } from "./helpers/platform";
import { inspectPdf } from "./helpers/pdf";
import { keepInline, writeContent } from "./helpers/document-footprint";

/**
 * DANFE delivery (#402): REST, SDK and console ticket over the synthetic corpus. The corpus
 * invoice and cancellation share one key; nothing here was authorized by a tax authority.
 */
const modules = import.meta.glob("../platform/convex/**/*.ts");
const SITE_URL = "http://localhost:5190";
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL,
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-danfe-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const database = (overrides: typeof modules = {}) =>
  convexTest(schema, { ...modules, ...overrides });
type Test = ReturnType<typeof database>;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** An organization with a key reading and importing documents of one company. */
async function organization(t: Test) {
  const secret = `fnfe_${crypto.randomUUID().replaceAll("-", "")}${"d".repeat(11)}`,
    keyHash = await hashApiKey(secret);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  const model = processNfe(xmlFixture("invoice-authorized")).normalized!.document;
  if (model.kind !== "invoice") throw new Error("Expected invoice");
  await t.run(async (ctx) => {
    await ctx.db.patch("companies", scope.companyId, { cnpj: model.issuer.document });
    const key = (await ctx.db.get("apiKeys", scope.keyId))!;
    await ctx.db.patch("apiKeys", key._id, { scopes: [...key.scopes, "documents:read"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: [...grant.scopes, "documents:read"],
    });
  });
  const headers = { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" };
  async function request(
    path: string,
    init: { method?: string; body?: unknown; key?: string } = {},
  ) {
    return t.fetch(path, {
      method: init.method ?? "GET",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Idempotency-Key": init.key ?? crypto.randomUUID(),
      },
      ...(init.method && init.method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    });
  }
  async function importXml(bytes: Uint8Array) {
    const key = crypto.randomUUID();
    const reserved = await request("/v1/imports", {
      method: "POST",
      key,
      body: {
        companyId: scope.companyId,
        files: [{ name: "nota.xml", size: bytes.length, sha256: sha256(bytes) }],
      },
    });
    const batch = (await reserved.json()).data as {
      importId: Id<"imports">;
      fileIds: Id<"importFiles">[];
    };
    const path = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
    const ticket = (await (await request(`${path}/upload`, { method: "POST", key })).json()).data;
    expect(
      (
        await t.fetch("/v1/import-upload", {
          method: "POST",
          headers: { "X-Upload-Token": ticket.token },
          body: new Uint8Array(bytes),
        })
      ).status,
    ).toBe(200);
    const confirmed = (await (await request(`${path}/confirm`, { method: "POST", key })).json())
      .data as { operationId: Id<"operations"> };
    await t.action(internal.operationWorker.run, {
      operationId: confirmed.operationId,
      generation: 1,
    });
    const file = (await (await request(`/v1/imports/${batch.importId}`)).json()).data.files[0];
    const documentId = file.documentId as Id<"fiscalDocuments">;
    const doc = (await t.run((ctx) => ctx.db.get("fiscalDocuments", documentId)))!;
    await t.action(internal.documentProjectionWorker.rebuild, {
      documentId,
      generation: doc.projectionGeneration!,
    });
    return { documentId, versionId: file.versionId as Id<"documentVersions"> };
  }
  const danfe = (documentId: string, extra = "") =>
    request(`/v1/documents/${documentId}/danfe?companyId=${scope.companyId}${extra}`);
  const rows = () => t.run((ctx) => ctx.db.query("documentDanfes").collect());
  return { t, scope, secret, keyHash, request, importXml, danfe, rows };
}
async function setup(overrides: typeof modules = {}) {
  const t = database(overrides);
  register(t);
  return organization(t);
}
async function pdfOf(response: Response) {
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  return bytes;
}
async function textOf(bytes: Uint8Array) {
  return (await inspectPdf(bytes)).map((page) => page.text).join(" ");
}
async function errorOf(response: Response) {
  return { status: response.status, code: errorResponse.parse(await response.json()).error.code };
}
/** A member of the organization with a Better Auth session, as the console signs in. */
async function member(
  t: Test,
  organizationId: Id<"organizations"> | null,
  role: "owner" | "viewer" = "owner",
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
  const membershipId = organizationId
    ? await t.run((ctx) =>
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
      )
    : null;
  const client = t.withIdentity({
    subject: user._id,
    sessionId: session._id,
    issuer: "http://127.0.0.1:3239",
  });
  return Object.assign(client, { membershipId });
}

it("pins the platform's copy of the generator version to the package", () => {
  expect(DANFE_VERSION).toBe(DANFE_GENERATOR_VERSION);
});

it("renders the DANFE once, serves it from the cache and renders again for new evidence", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const key = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", invoice.documentId)))!
    .fiscalKey;

  const first = await f.danfe(invoice.documentId);
  expect(first.headers.get("content-type")).toBe("application/pdf");
  expect(first.headers.get("content-disposition")).toBe(`attachment; filename="danfe-${key}.pdf"`);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  const authorized = await pdfOf(first);
  const text = await textOf(authorized);
  expect(text).not.toContain("CANCELADA");
  expect(text).not.toContain("SEM VALOR FISCAL - documento não autorizado");
  const [row] = await f.rows();
  expect(row).toMatchObject({
    documentId: invoice.documentId,
    generatorVersion: DANFE_VERSION,
    eventCount: 0,
    origin: null,
    pdfSha256: sha256(authorized),
    size: authorized.byteLength,
  });
  const original = (await f.t.run(async (ctx) => {
    const version = (await ctx.db.get("documentVersions", invoice.versionId))!;
    return ctx.db.get("documentArtifacts", version.artifactId);
  }))!;
  expect(row!.sourceSha256).toBe(original.sha256);

  // Cached: the same bytes from the same file, without a new rendering.
  vi.setSystemTime(Date.now() + 60_000);
  expect(await pdfOf(await f.danfe(invoice.documentId))).toEqual(authorized);
  expect(await f.rows()).toEqual([row]);

  // A preserved cancellation is new evidence: a new PDF replaces the cached one.
  await f.importXml(xmlFixture("event-110111"));
  const cancelled = await pdfOf(await f.danfe(invoice.documentId));
  expect(sha256(cancelled)).not.toBe(sha256(authorized));
  const cancelledText = await textOf(cancelled);
  expect(cancelledText).toContain("NF-e CANCELADA");
  expect(cancelledText).toContain("evento de cancelamento preservado na plataforma");
  const [replaced] = await f.rows();
  expect(replaced).toMatchObject({ eventCount: 1, pdfSha256: sha256(cancelled) });
  expect(replaced!.evidenceSha256).not.toBe(row!.evidenceSha256);
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", row!.storageId!))).toBeNull();

  // A generator version change renders again; the XML original never changes.
  await f.t.run((ctx) => ctx.db.patch("documentDanfes", replaced!._id, { generatorVersion: "0" }));
  expect(await pdfOf(await f.danfe(invoice.documentId))).toEqual(cancelled);
  const [again] = await f.rows();
  expect(again!.generatorVersion).toBe(DANFE_VERSION);
  expect(again!.storageId).not.toBe(replaced!.storageId);
  const after = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", original._id)))!;
  expect(after).toEqual(original);

  // The SDK reads the same file.
  const client = new FreecorpsClient({
    apiKey: f.secret,
    environment: "sandbox",
    baseUrl: "https://api.example.invalid",
    fetch: (input, init) => {
      const url = input as URL;
      return f.t.fetch(url.pathname + url.search, init);
    },
  });
  expect(
    await client.downloadDanfe({ documentId: invoice.documentId, companyId: f.scope.companyId }),
  ).toEqual(cancelled);
});

it("marks an XML without authorization and refuses documents that have no DANFE", async () => {
  const f = await setup();
  const unsigned = await f.importXml(xmlFixture("invoice-signed"));
  const text = await textOf(await pdfOf(await f.danfe(unsigned.documentId)));
  expect(text).toContain("SEM VALOR FISCAL");

  const summary = await setup().then(async (g) => ({
    g,
    imported: await g.importXml(xmlFixture("summary-authorized")),
  }));
  expect(await errorOf(await summary.g.danfe(summary.imported.documentId))).toEqual({
    status: 409,
    code: "DANFE_UNAVAILABLE",
  });
  // The rule holds for an NFS-e document too (model patched on a synthetic document).
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", unsigned.documentId, { model: "nfse" }));
  expect(await errorOf(await f.danfe(unsigned.documentId))).toEqual({
    status: 409,
    code: "DANFE_UNAVAILABLE",
  });
  expect((await f.danfe(unsigned.documentId, "&extra=1")).status).toBe(400);
});

it("isolates the DANFE by key, grant, organization, company and environment", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const other = await organization(f.t);
  // Another organization's key, with its own company or the document's company.
  expect(
    (
      await other.request(
        `/v1/documents/${invoice.documentId}/danfe?companyId=${other.scope.companyId}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await other.request(
        `/v1/documents/${invoice.documentId}/danfe?companyId=${f.scope.companyId}`,
      )
    ).status,
  ).toBe(404);
  // Wrong environment header.
  const wrongEnvironment = await f.t.fetch(
    `/v1/documents/${invoice.documentId}/danfe?companyId=${f.scope.companyId}`,
    { headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "production" } },
  );
  expect((await errorOf(wrongEnvironment)).code).toBe("ENVIRONMENT_DENIED");
  // Grant without documents:read.
  await f.t.run(async (ctx) => {
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", f.scope.projectId).eq("companyId", f.scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: grant.scopes.filter((scope) => scope !== "documents:read"),
    });
  });
  expect(await errorOf(await f.danfe(invoice.documentId))).toEqual({
    status: 404,
    code: "NOT_FOUND",
  });
  expect(await f.rows()).toEqual([]);
  // Key without the scope, then revoked.
  const g = await setup();
  const imported = await g.importXml(xmlFixture("invoice-authorized"));
  const key = (await g.t.run((ctx) => ctx.db.get("apiKeys", g.scope.keyId)))!;
  await g.t.run((ctx) =>
    ctx.db.patch("apiKeys", key._id, {
      scopes: key.scopes.filter((scope) => scope !== "documents:read"),
    }),
  );
  expect(await errorOf(await g.danfe(imported.documentId))).toEqual({
    status: 403,
    code: "SCOPE_DENIED",
  });
  await g.t.run((ctx) => ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now() }));
  expect((await g.danfe(imported.documentId)).status).toBe(401);
  expect(await g.rows()).toEqual([]);
});

it("serves Production on the hosted sandbox only where documents:read is served", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await f.t.run(async (ctx) => {
    await ctx.db.patch("apiKeys", f.scope.keyId, { environment: "production" });
    await ctx.db.patch("fiscalDocuments", invoice.documentId, { environment: "production" });
  });
  // No capture release for the company: Production does not serve its documents here.
  const response = await f.t.fetch(
    `/v1/documents/${invoice.documentId}/danfe?companyId=${f.scope.companyId}`,
    { headers: { Authorization: `Bearer ${f.secret}`, "X-Environment": "production" } },
  );
  expect(response.status).toBe(404);
  expect(await f.rows()).toEqual([]);
});

it("limits renderings per organization; a cached DANFE is not counted", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await pdfOf(await f.danfe(invoice.documentId));
  const args = {
    keyHash: f.keyHash,
    environment: "sandbox",
    company: f.scope.companyId,
    documentId: invoice.documentId,
  };
  // Cached answers do not take from the budget.
  for (let i = 0; i < DANFE_RENDERS_PER_MINUTE + 5; i++)
    expect((await f.t.mutation(internal.documentRest.danfe, args)).state).toBe("ready");
  await f.t.run(async (ctx) => {
    const [row] = await ctx.db.query("documentDanfes").collect();
    await ctx.db.patch("documentDanfes", row!._id, { generatorVersion: "0" });
  });
  // The first render of the minute was the download above.
  for (let i = 1; i < DANFE_RENDERS_PER_MINUTE; i++)
    expect((await f.t.mutation(internal.documentRest.danfe, args)).state).toBe("render");
  await expect(f.t.mutation(internal.documentRest.danfe, args)).rejects.toThrow("RATE_LIMITED");
  expect(await errorOf(await f.danfe(invoice.documentId))).toEqual({
    status: 429,
    code: "RATE_LIMITED",
  });
});

it("downloads the DANFE in the console with a one-minute ticket of a member", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const owner = await member(f.t, f.scope.organizationId);
  const { token } = await owner.mutation(api.documentDownloads.danfeTicket, {
    ...scope,
    documentId: invoice.documentId,
  });
  const download = (value: string) =>
    f.t.fetch("/v1/document-download", {
      headers: { "X-Download-Token": value, Origin: SITE_URL },
    });
  const response = await download(token);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("access-control-allow-origin")).toBe(SITE_URL);
  const bytes = await pdfOf(response);
  // The REST download reuses the file the console rendered.
  expect(await pdfOf(await f.danfe(invoice.documentId))).toEqual(bytes);
  expect(await f.rows()).toHaveLength(1);

  // A login without membership, or a document without DANFE, gets no ticket.
  const stranger = await member(f.t, null);
  await expect(
    stranger.mutation(api.documentDownloads.danfeTicket, {
      ...scope,
      documentId: invoice.documentId,
    }),
  ).rejects.toThrow();
  const summary = await f.importXml(xmlFixture("summary-conflicting-total"));
  if (summary.documentId !== invoice.documentId)
    await expect(
      owner.mutation(api.documentDownloads.danfeTicket, {
        ...scope,
        documentId: summary.documentId,
      }),
    ).rejects.toThrow("DANFE_UNAVAILABLE");
  // A ticket stops working when it expires.
  const late = await owner.mutation(api.documentDownloads.danfeTicket, {
    ...scope,
    documentId: invoice.documentId,
  });
  vi.setSystemTime(Date.now() + 61_000);
  expect((await download(late.token)).status).toBe(404);
});

it("removes the DANFE cache with the organization's closure", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await pdfOf(await f.danfe(invoice.documentId));
  const [row] = await f.rows();
  // A remembered refusal has no file: the purge must drop that row too.
  await f.t.run((ctx) =>
    ctx.db.insert("documentDanfes", {
      organizationId: f.scope.organizationId,
      companyId: f.scope.companyId,
      environment: "sandbox",
      documentId: invoice.documentId,
      generatorVersion: DANFE_VERSION,
      sourceSha256: "0".repeat(64),
      evidenceSha256: "0".repeat(64),
      eventCount: 0,
      origin: null,
      refusal: "DANFE_XML_INVALID",
      generatedAt: Date.now(),
    }),
  );
  expect(await f.rows()).toHaveLength(2);
  await f.t.mutation(internal.organizationClosure.reapply, {
    organizationId: f.scope.organizationId,
    requestedAt: Date.now() - 40 * DAY,
  });
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(1);
    await f.t.finishInProgressScheduledFunctions();
  }
  expect(await f.rows()).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", row!.storageId!))).toBeNull();
});

/** The XML original's artifact of the document's published version. */
async function originalOf(f: Awaited<ReturnType<typeof setup>>, documentId: Id<"fiscalDocuments">) {
  return f.t.run(async (ctx) => {
    const doc = (await ctx.db.get("fiscalDocuments", documentId))!;
    const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
    return (await ctx.db.get("documentArtifacts", version.artifactId))!;
  });
}

it("records a refusal of the generator and answers it again without rendering", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  // The stored original swapped for bytes the generator refuses (an event, not an NF-e).
  const refused = xmlFixture("event-110111");
  const original = await originalOf(f, invoice.documentId);
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(refused)]));
    await ctx.db.patch("documentArtifacts", original._id, { storageId, sha256: sha256(refused) });
  });
  expect(await errorOf(await f.danfe(invoice.documentId))).toEqual({
    status: 409,
    code: "DANFE_UNAVAILABLE",
  });
  const [row] = await f.rows();
  expect(row).toMatchObject({ refusal: "DANFE_XML_INVALID", generatorVersion: DANFE_VERSION });
  expect(row!.storageId).toBeUndefined();
  // The retry answers from the record: no render token is taken.
  const args = {
    keyHash: f.keyHash,
    environment: "sandbox",
    company: f.scope.companyId,
    documentId: invoice.documentId,
  };
  for (let i = 0; i < DANFE_RENDERS_PER_MINUTE + 2; i++)
    await expect(f.t.mutation(internal.documentRest.danfe, args)).rejects.toThrow(
      "DANFE_UNAVAILABLE",
    );
});

it("refuses a missing original before rendering", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const original = await originalOf(f, invoice.documentId);
  await f.t.run((ctx) => ctx.storage.delete(original.storageId!));
  expect(await errorOf(await f.danfe(invoice.documentId))).toEqual({
    status: 404,
    code: "ORIGINAL_UNAVAILABLE",
  });
  expect(await f.rows()).toEqual([]);
});

it("answers UNAVAILABLE instead of a stale PDF in each race of serveDanfe", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await pdfOf(await f.danfe(invoice.documentId));
  const [row] = await f.rows();
  const storageId = row!.storageId!;
  const sources = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
    documentId: invoice.documentId,
    original: { storageId, sha256: "0".repeat(64), size: 1 },
    events: [],
    origin: null,
    evidenceSha256: "0".repeat(64),
  };
  const ready = { state: "ready" as const, storageId, name: "danfe.pdf" };
  const render = { state: "render" as const, sources, name: "danfe.pdf" };
  const blob = new Blob(["%PDF-"]);
  const ctx = (stored: Blob | null) => ({
    runAction: (async () => null) as never,
    storage: { get: async () => stored } as never,
  });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "OK",
      (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
    );
  // The evidence changed while rendering.
  expect(await code(serveDanfe(ctx(blob), async () => render))).toBe("UNAVAILABLE");
  // The file was replaced between the resolution and the read.
  expect(await code(serveDanfe(ctx(null), async () => ready))).toBe("UNAVAILABLE");
  // The key changed while the bytes were read.
  const steps = [ready, render];
  expect(await code(serveDanfe(ctx(blob), async () => steps.shift()!))).toBe("UNAVAILABLE");
  const replaced = [ready, { ...ready, storageId: "replaced" as Id<"_storage"> }];
  expect(await code(serveDanfe(ctx(blob), async () => replaced.shift()!))).toBe("UNAVAILABLE");
  // A consistent pair serves the bytes.
  expect(await code(serveDanfe(ctx(blob), async () => ready))).toBe("OK");
});

it("drops a slow old rendering instead of replacing the current row", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  // The render of the key before the cancellation finishes after the cancellation arrived.
  const before = await f.t.mutation(internal.documentRest.danfe, {
    keyHash: f.keyHash,
    environment: "sandbox",
    company: f.scope.companyId,
    documentId: invoice.documentId,
  });
  if (before.state !== "render") throw new Error("Expected a render");
  await f.importXml(xmlFixture("event-110111"));
  await pdfOf(await f.danfe(invoice.documentId));
  const [current] = await f.rows();
  expect(current!.eventCount).toBe(1);
  await f.t.action(internal.danfeWorker.render, { sources: before.sources });
  expect(await f.rows()).toEqual([current]);
  // Its file was deleted with it: only the current PDF and the originals stay stored.
  const files = await f.t.run((ctx) => ctx.db.system.query("_storage").collect());
  const pdfs = [];
  for (const file of files)
    if (
      (await f.t.run(async (ctx) => (await ctx.storage.get(file._id))?.type)) === "application/pdf"
    )
      pdfs.push(file._id);
  expect(pdfs).toEqual([current!.storageId]);
});

it("audits each DANFE download with its own action and the document as target", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await pdfOf(await f.danfe(invoice.documentId));
  const owner = await member(f.t, f.scope.organizationId);
  const { token } = await owner.mutation(api.documentDownloads.danfeTicket, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    documentId: invoice.documentId,
  });
  await pdfOf(
    await f.t.fetch("/v1/document-download", {
      headers: { "X-Download-Token": token, Origin: SITE_URL },
    }),
  );
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .filter((q) => q.eq(q.field("action"), "http.danfeDownload"))
      .collect(),
  );
  expect(audit.map((entry) => [entry.actor, entry.target])).toEqual([
    [`key:${f.scope.keyId}`, invoice.documentId],
    [owner.membershipId, invoice.documentId],
  ]);
  const downloads = await f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .filter((q) => q.eq(q.field("action"), "http.documentDownload"))
      .collect(),
  );
  expect(downloads).toEqual([]);
});

it("gives a viewer the original and the DANFE only through a company grant", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const original = await originalOf(f, invoice.documentId);
  const scope = {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox" as const,
  };
  const viewer = await member(f.t, f.scope.organizationId, "viewer");
  await expect(
    viewer.mutation(api.documentDownloads.ticket, { ...scope, artifactId: original._id }),
  ).rejects.toThrow();
  await expect(
    viewer.mutation(api.documentDownloads.danfeTicket, {
      ...scope,
      documentId: invoice.documentId,
    }),
  ).rejects.toThrow();
  await companyGrant(f.t, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    membershipId: viewer.membershipId!,
  });
  const download = (token: string) =>
    f.t.fetch("/v1/document-download", {
      headers: { "X-Download-Token": token, Origin: SITE_URL },
    });
  const xml = await viewer.mutation(api.documentDownloads.ticket, {
    ...scope,
    artifactId: original._id,
  });
  expect((await download(xml.token)).status).toBe(200);
  const danfe = await viewer.mutation(api.documentDownloads.danfeTicket, {
    ...scope,
    documentId: invoice.documentId,
  });
  await pdfOf(await download(danfe.token));
});

it("refuses a second company of the same organization without its grant", async () => {
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const second = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
    return ctx.db.insert("companies", { ...company, name: "Segunda empresa sintética" });
  });
  const response = await f.request(`/v1/documents/${invoice.documentId}/danfe?companyId=${second}`);
  expect(await errorOf(response)).toEqual({ status: 404, code: "NOT_FOUND" });
  expect(await f.rows()).toEqual([]);
});

it("ignores a cancellation of the same key in another company or environment", async () => {
  // Another company (in another organization) holds the cancellation: this note stays valid.
  const f = await setup();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const other = await organization(f.t);
  const foreign = await other.importXml(xmlFixture("event-110111"));
  expect(foreign.documentId).not.toBe(invoice.documentId);
  expect(await textOf(await pdfOf(await f.danfe(invoice.documentId)))).not.toContain("CANCELADA");
  expect((await f.rows())[0]!.eventCount).toBe(0);
  // A cancellation linked to the document whose original is of another environment is ignored.
  const g = await setup();
  const own = await g.importXml(xmlFixture("invoice-authorized"));
  const event = await g.importXml(xmlFixture("event-110111"));
  await g.t.run(async (ctx) => {
    const version = (await ctx.db.get("documentVersions", event.versionId))!;
    await ctx.db.patch("documentArtifacts", version.artifactId, { environment: "production" });
  });
  expect(await textOf(await pdfOf(await g.danfe(own.documentId)))).not.toContain("CANCELADA");
  expect((await g.rows())[0]!.eventCount).toBe(0);
});

it("finds the cancellation through the version card, without the event's content (B5)", async () => {
  const f = await setup(keepInline("../"));
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  await f.importXml(xmlFixture("event-110111"));
  await writeContent(f.t);
  const event = await f.t.run(async (ctx) =>
    (await ctx.db.query("documentVersions").collect()).find((row) => row.kind === "event"),
  );
  expect(event?.card?.cancellation).toBe(true);
  // The inline copy no longer says so: only the card can.
  await f.t.run(async (ctx) => {
    const result = JSON.parse(event!.result!) as { document: Record<string, unknown> };
    result.document.cancellation = null;
    await ctx.db.patch("documentVersions", event!._id, { result: JSON.stringify(result) });
  });
  expect(await textOf(await pdfOf(await f.danfe(invoice.documentId)))).toContain("NF-e CANCELADA");
  // A card from before B5, without the flag, is read inline again.
  await f.t.run(async (ctx) => {
    const { cancellation: _flag, ...card } = event!.card!;
    await ctx.db.patch("documentVersions", event!._id, { card });
  });
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("documentDanfes").collect())
      await ctx.db.patch("documentDanfes", row._id, { generatorVersion: "0" });
  });
  expect(await textOf(await pdfOf(await f.danfe(invoice.documentId)))).not.toContain(
    "NF-e CANCELADA",
  );
});
