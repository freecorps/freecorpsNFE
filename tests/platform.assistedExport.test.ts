/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id, TableNames } from "../platform/convex/_generated/dataModel";
import { retentionClass } from "../platform/convex/lib/retentionClasses";
import { ARCHIVE_DAY } from "../platform/convex/lib/coldArchiveCore";
import { companiesFor } from "../platform/convex/assistedExport";
import { actor, fixture } from "./helpers/export-fixture";

/**
 * The assisted export of an archived organization (ADR 0009, §7, decisions of 30/10/2026): the
 * normal generator in the isolated destination, the owner's request with the 30-day limit, and the
 * publication in the origin downloaded by the normal ticket.
 */
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    FNFE_COLD_ARCHIVE: "enabled",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5207",
    CONVEX_SITE_URL: "http://127.0.0.1:3267",
    BETTER_AUTH_SECRET: "synthetic-assisted-export-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
type F = Awaited<ReturnType<typeof fixture>>;

/** An owner and the organization in cold custody, with a sealed package (`archived`). */
async function archived(f: F) {
  const owner = await actor(f);
  const email = await f.t.run(
    async (ctx) => (await ctx.db.get("memberships", owner.membershipId))!.email,
  );
  const runId = await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId: f.scope.organizationId,
      key: "synthetic-assisted-run",
      reason: "free_inactive",
      planVersion: 1,
      state: "archived",
      version: 4,
      noticeAt: Date.now() - 40 * ARCHIVE_DAY,
      eligibleAt: Date.now() - 10 * ARCHIVE_DAY,
      retainUntil: Date.now() + 365 * 6 * ARCHIVE_DAY,
      createdAt: Date.now() - 40 * ARCHIVE_DAY,
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
      manifest: "{}",
      manifestSha256: "0".repeat(64),
    }),
  );
  const ask = (key: string, extra: Record<string, unknown> = {}) =>
    f.t.mutation(internal.assistedExport.request, {
      runId,
      key,
      email,
      basis: "owner",
      environments: ["sandbox"],
      ...extra,
    } as never);
  return { owner, email, runId, ask };
}
async function partsOf(f: F, exportId: Id<"documentExports">) {
  const parts = await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", exportId))
      .collect();
    const result = [];
    for (const part of rows) {
      const bytes = await (await ctx.storage.get(part.storageId))!.arrayBuffer();
      result.push({
        sequence: part.sequence,
        sha256: part.sha256,
        size: part.size,
        content: Buffer.from(bytes).toString("base64"),
      });
    }
    return result;
  });
  return parts.map(({ content, ...part }) => ({
    ...part,
    bytes: new Uint8Array(Buffer.from(content, "base64")),
  }));
}
/** Drives the destination job like the operator's command, step by step. */
async function generate(f: F, jobId: Id<"documentExports">) {
  for (let n = 0; n < 50; n++) {
    const progress = await f.t.query(internal.assistedExport.progress, { jobId, now: Date.now() });
    if (progress.state !== "running") return progress;
    await f.t.action(internal.exportWorker.run, { exportId: jobId, sequence: progress.sequence });
  }
  throw new Error("Generation did not end");
}
/** What the package leaves in the destination: only the `fiscal` class (ADR 0009, §2). */
async function leaveOnlyFiscal(f: F) {
  await f.t.run(async (ctx) => {
    for (const [table, kind] of Object.entries(retentionClass) as [TableNames, string][]) {
      if (kind === "fiscal") continue;
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(table, row._id);
    }
  });
}
const INTERNAL_FIELDS = [
  "storageId",
  "_creationTime",
  "originId",
  "originCreationTime",
  "keyHash",
  "tokenHash",
  "checkpoint",
  "digest",
  "manifestSha256",
  "membershipId",
  "projectId",
  "accessVersion",
  "rawId",
  "coldArchive",
  "assisted",
];
const RECORD_TYPES = new Set([
  "manifest",
  "document",
  "version",
  "item",
  "artifact",
  "unclassified-artifact",
  "original",
  "part-end",
]);
/** Every key at any depth of a JSON value. */
function keys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, found);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keys(item, found);
    }
  return found;
}

it("gera no destino isolado, só com a classe fiscal, os mesmos bytes da exportação normal", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const normal = await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "normal-organization",
  });
  const job = await f.finish(normal.id);
  expect(job.state).toBe("succeeded");
  const expected = await partsOf(f, normal.id);
  expect(expected.length).toBeGreaterThan(0);
  const companies = await f.t.run((ctx) =>
    companiesFor(ctx, f.scope.organizationId, job.environment),
  );
  const args = {
    exportId: normal.id,
    organizationId: f.scope.organizationId,
    environment: job.environment,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    companies,
  };
  // Where the organization exists (the origin), the isolated generation is refused.
  await expect(f.t.mutation(internal.assistedExport.generate, args)).rejects.toThrow(
    "ASSISTED_EXPORT_NOT_ISOLATED",
  );
  await leaveOnlyFiscal(f);
  const first = await f.t.mutation(internal.assistedExport.generate, args);
  expect(first.created).toBe(true);
  // Repeating returns the same destination job.
  expect(await f.t.mutation(internal.assistedExport.generate, args)).toEqual({
    jobId: first.jobId,
    created: false,
  });
  expect((await generate(f, first.jobId)).state).toBe("succeeded");
  const generated = await partsOf(f, first.jobId);
  // Same parts, byte for byte: same manifest (the origin's export ID), records and originals.
  expect(generated.map(({ sequence, sha256, size }) => ({ sequence, sha256, size }))).toEqual(
    expected.map(({ sequence, sha256, size }) => ({ sequence, sha256, size })),
  );
  const listed = await f.t.query(internal.assistedExport.parts, { jobId: first.jobId, after: -1 });
  expect(listed.map((part) => part.sha256)).toEqual(expected.map((part) => part.sha256));
  const rows = generated.flatMap((part) =>
    gunzipSync(part.bytes)
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
  expect(rows.find((row) => row.type === "manifest")).toMatchObject({
    exportId: normal.id,
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
  });
  expect(rows.find((row) => row.type === "document")).toMatchObject({
    company: { id: f.scope.companyId, name: "Empresa sintética" },
  });
  expect(rows.find((row) => row.type === "original")!.content).toBe(
    Buffer.from(f.bytes).toString("base64"),
  );
  // No internal field, control table or Convex JSONL reaches the delivered file.
  for (const row of rows) expect(RECORD_TYPES.has(String(row.type))).toBe(true);
  const found = keys(rows);
  for (const field of INTERNAL_FIELDS) expect(found.has(field)).toBe(false);
  expect(rows.some((row) => "_id" in row || "_table" in row)).toBe(false);
});

it("aceita só o Proprietário, pela conta, e um pedido a cada 30 dias, salvo o de titular", async () => {
  const f = await fixture();
  const a = await archived(f);
  const admin = await actor(f);
  await f.t.run(async (ctx) => ctx.db.patch("memberships", admin.membershipId, { role: "admin" }));
  const adminEmail = await f.t.run(
    async (ctx) => (await ctx.db.get("memberships", admin.membershipId))!.email,
  );
  const viewer = await actor(f, "viewer");
  const viewerEmail = await f.t.run(
    async (ctx) => (await ctx.db.get("memberships", viewer.membershipId))!.email,
  );
  for (const email of [adminEmail, viewerEmail, "ninguem@development.invalid"])
    await expect(a.ask("ticket-not-owner", { email })).rejects.toThrow("ASSISTED_EXPORT_NOT_OWNER");
  // A removed owner is no longer the owner.
  await f.t.run((ctx) => ctx.db.patch("memberships", a.owner.membershipId, { state: "removed" }));
  await expect(a.ask("ticket-removed")).rejects.toThrow("ASSISTED_EXPORT_NOT_OWNER");
  await f.t.run((ctx) => ctx.db.patch("memberships", a.owner.membershipId, { state: "active" }));

  const first = await a.ask("ticket-1");
  expect(first.repeated).toBe(false);
  // The same ticket repeats the request, even inside the window; another content conflicts.
  expect(await a.ask("ticket-1")).toEqual({ ...first, repeated: true });
  await expect(a.ask("ticket-1", { environments: ["production"] })).rejects.toThrow(
    "IDEMPOTENCY_CONFLICT",
  );
  await expect(a.ask("ticket-2")).rejects.toThrow("ASSISTED_EXPORT_RATE_LIMITED");
  // A data subject's request under RIGHTS.md is not limited, and needs its reference.
  await expect(a.ask("ticket-3", { basis: "rights" })).rejects.toThrow("INVALID_REQUEST");
  const rights = await a.ask("ticket-3", { basis: "rights", rightsReference: "D02-2026-0042" });
  expect(rights.repeated).toBe(false);
  vi.advanceTimersByTime(30 * ARCHIVE_DAY - 1);
  await expect(a.ask("ticket-4")).rejects.toThrow("ASSISTED_EXPORT_RATE_LIMITED");
  vi.advanceTimersByTime(1);
  expect((await a.ask("ticket-4")).repeated).toBe(false);
  const recorded = await f.t.run((ctx) =>
    ctx.db
      .query("assistedExports")
      .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", f.scope.organizationId))
      .collect(),
  );
  expect(recorded.map((row) => [row.key, row.basis, row.membershipId])).toEqual([
    ["ticket-1", "owner", a.owner.membershipId],
    ["ticket-3", "rights", a.owner.membershipId],
    ["ticket-4", "owner", a.owner.membershipId],
  ]);
});

it("recusa sem o arquivo econômico ligado e sem pacote selado", async () => {
  const f = await fixture();
  const a = await archived(f);
  vi.stubEnv("FNFE_COLD_ARCHIVE", "disabled");
  await expect(a.ask("ticket-off")).rejects.toThrow("ARCHIVE_DISABLED");
  vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", a.runId, { state: "frozen" }));
  await expect(a.ask("ticket-frozen")).rejects.toThrow("ARCHIVE_NOT_SEALED");
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", a.runId, { state: "hot" }));
  await expect(a.ask("ticket-hot")).rejects.toThrow("ARCHIVE_ORGANIZATION_HOT");
});

it("publica na origem e o Proprietário baixa pelo ticket normal, com a organização arquivada", async () => {
  const f = await fixture();
  // A normal export made before the archive keeps the archive refusal.
  const a = await archived(f);
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", a.runId, { state: "notice" }));
  const before = await a.owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "before-archive",
  });
  await f.finish(before.id);
  const beforePart = (await partsOf(f, before.id))[0]!;
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", a.runId, { state: "archived" }));

  const requested = await a.ask("ticket-publish");
  const prepared = await f.t.mutation(internal.assistedExport.prepare, {
    requestId: requested.requestId,
    environment: "sandbox",
  });
  expect(prepared).toMatchObject({ state: "running", sequence: 0, environment: "sandbox" });
  expect(prepared.companies).toEqual([
    expect.objectContaining({ id: f.scope.companyId, served: true }),
  ]);
  expect(prepared.expiresAt - prepared.createdAt).toBe(ARCHIVE_DAY);
  // Repeating returns the same origin export.
  expect(
    (
      await f.t.mutation(internal.assistedExport.prepare, {
        requestId: requested.requestId,
        environment: "sandbox",
      })
    ).exportId,
  ).toBe(prepared.exportId);

  // The part generated in the destination, here the normal one, uploaded to the origin.
  const upload = (bytes: Uint8Array) =>
    f.t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(bytes)], { type: "application/vnd.freecorps.export+gzip" }),
      ),
    );
  const attach = (storageId: Id<"_storage">, sha256 = beforePart.sha256) =>
    f.t.mutation(internal.assistedExport.attachPart, {
      exportId: prepared.exportId,
      sequence: 0,
      storageId,
      sha256,
      size: beforePart.size,
      done: true,
    });
  // Other bytes of the same size, or a hash the generated part did not have: refused, and the
  // blob removed. (`convex-test` keeps no MIME; the command uploads with the export's.)
  for (const [storageId, sha256] of [
    [await upload(new Uint8Array(beforePart.size)), beforePart.sha256],
    [await upload(beforePart.bytes), "0".repeat(64)],
  ] as const) {
    expect(await attach(storageId, sha256)).toEqual({
      ok: false,
      code: "ASSISTED_EXPORT_PART_MISMATCH",
    });
    expect(await f.t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
  }
  const storageId = await upload(beforePart.bytes);
  expect(await attach(storageId)).toEqual({ ok: true });
  // A lost response re-uploads the same part: the copy is dropped, nothing doubles.
  const copy = await upload(beforePart.bytes);
  expect(await attach(copy)).toEqual({ ok: true });
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", copy))).toBeNull();
  expect((await partsOf(f, prepared.exportId)).length).toBe(1);
  expect(
    (
      await f.t.mutation(internal.assistedExport.prepare, {
        requestId: requested.requestId,
        environment: "sandbox",
      })
    ).state,
  ).toBe("succeeded");

  // The owner sees it in Exportações and downloads it by the normal ticket, while archived.
  const listed = await a.owner.client.query(api.exports.list, {
    organizationId: f.scope.organizationId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(listed.page.map((job) => job.id)).toContain(prepared.exportId);
  const [part] = (
    await a.owner.client.query(api.exports.parts, {
      exportId: prepared.exportId,
      paginationOpts: { numItems: 10, cursor: null },
    })
  ).page;
  const { token } = await a.owner.client.mutation(api.exportDownloads.ticket, { partId: part!.id });
  const response = await f.download(token);
  expect(response.status).toBe(200);
  expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(beforePart.sha256);
  // The export made before the archive is still refused, as every other fiscal read.
  const old = await f.t.run((ctx) =>
    ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", before.id))
      .first(),
  );
  await expect(
    a.owner.client.mutation(api.exportDownloads.ticket, { partId: old!._id }),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  // Nobody else of the organization reaches it.
  const viewer = await actor(f, "viewer");
  await expect(
    viewer.client.mutation(api.exportDownloads.ticket, { partId: part!.id }),
  ).rejects.toThrow();

  // After its 24 hours, the same request is not delivered again: a new one, under the limit.
  vi.advanceTimersByTime(ARCHIVE_DAY);
  await expect(
    f.t.mutation(internal.assistedExport.prepare, {
      requestId: requested.requestId,
      environment: "sandbox",
    }),
  ).rejects.toThrow("ASSISTED_EXPORT_DELIVERED");
});

it("recomeça a exportação da origem quando o destino se perdeu depois de partes publicadas", async () => {
  const f = await fixture();
  const a = await archived(f);
  const { requestId } = await a.ask("ticket-restart");
  const prepare = (restart?: boolean) =>
    f.t.mutation(internal.assistedExport.prepare, {
      requestId,
      environment: "sandbox",
      ...(restart ? { restart } : {}),
    });
  const first = await prepare();
  const bytes = new Uint8Array([1, 2, 3]);
  const storageId = await f.t.run((ctx) =>
    ctx.storage.store(new Blob([bytes], { type: "application/vnd.freecorps.export+gzip" })),
  );
  expect(
    await f.t.mutation(internal.assistedExport.attachPart, {
      exportId: first.exportId,
      sequence: 0,
      storageId,
      sha256: hash(bytes),
      size: bytes.length,
      done: false,
    }),
  ).toEqual({ ok: true });
  // Without `restart`, the partial export is returned to continue from its next part.
  expect(await prepare()).toMatchObject({ exportId: first.exportId, sequence: 1 });
  const second = await prepare(true);
  expect(second.exportId).not.toBe(first.exportId);
  expect(second.sequence).toBe(0);
  const failed = await f.t.run((ctx) => ctx.db.get("documentExports", first.exportId));
  expect(failed).toMatchObject({ state: "failed", code: "ASSISTED_EXPORT_RESTARTED" });
});
