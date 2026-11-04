import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  signWebhook,
  verifyWebhook,
  type WebhookEnvelope,
} from "../../../packages/contracts/src/webhooks";
import { internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import { hashApiKey } from "./apiKeyCrypto";
import { ARCHIVE_TABLES, isArchiveFence } from "./coldArchiveCore";
import { originFor } from "./coldArchiveOrigin";
import { documentEvent } from "./webhookOutbox";
import { fixture } from "../../../tests/helpers/export-fixture";

/**
 * Old IDs in the REST after a rehydration, and `originalId` (ADR 0009, §6). The document comes in
 * through the real import routes (`export-fixture`); each archiving cycle is then simulated in
 * the database the way the rehydration leaves it (`coldArchiveRehydration.ts`, proved end to end
 * in `platform/convex/coldArchiveRehydration.test.ts`): every fiscal row of the organization recreated
 * under a new ID with its "first ID / first creation" pair, an entry of the ID map per row, the
 * references rewritten and the run back in `hot`. Organizations and keys are synthetic.
 */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5209",
    CONVEX_SITE_URL: "http://127.0.0.1:3271",
    BETTER_AUTH_SECRET: "synthetic-archive-ids",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type F = Awaited<ReturnType<typeof fixture>>;
type Body = { data?: Record<string, unknown>; error?: { code: string } };
const DAY = 86_400_000;

/**
 * Every string equal to a key of `ids`, at any depth, becomes its new ID; nothing else changes.
 * `originId` is the row's first ID, written once and never rewritten (§5, item 6).
 */
function rewrite(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, ids));
  if (value && typeof value === "object" && !(value instanceof ArrayBuffer))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "originId" ? v : rewrite(v, ids)]),
    );
  return value;
}

/**
 * One archiving cycle of `organizationId`, as the rehydration leaves it: returns old ID → new ID.
 * The fence (`dpsSequences`, `captureStreams`) keeps its IDs, and so do stored files here.
 */
async function cycle(f: F, organizationId: Id<"organizations">, n: number) {
  const pairs = await f.t.run(async (ctx) => {
    const now = Date.now();
    const runId = await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `synthetic-ids-${organizationId}-${n}`,
      version: 1,
      state: "hot",
      reason: "free_inactive",
      noticeAt: now - 40 * DAY,
      eligibleAt: now - 10 * DAY,
      retainUntil: now + 365 * DAY,
      createdAt: now - 40 * DAY,
      updatedAt: now,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
      restoredAt: now,
    });
    const ids = new Map<string, string>();
    const created: { table: TableNames; id: string }[] = [];
    const tables = ARCHIVE_TABLES.filter((table) => !isArchiveFence(table));
    for (const table of tables)
      for (const row of await ctx.db.query(table).collect()) {
        if ("organizationId" in row && row.organizationId !== organizationId) continue;
        const { _id, _creationTime, ...fields } = row as Record<string, unknown> & {
          _id: string;
          _creationTime: number;
        };
        const id = await ctx.db.insert(table, {
          ...fields,
          ...originFor({ _id, _creationTime, ...fields }),
        } as never);
        await ctx.db.insert("coldArchiveIdMap", {
          organizationId,
          runId,
          table,
          previousId: _id,
          previousCreationTime: _creationTime,
          newId: id,
        });
        await ctx.db.delete(table, _id as never);
        ids.set(_id, id);
        created.push({ table, id });
      }
    for (const { table, id } of created) {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(table, id as never))!;
      await ctx.db.replace(table, id as never, rewrite(fields, ids) as never);
    }
    for (const table of ["idempotencyRecords", "documentExports"] as const)
      for (const row of await ctx.db.query(table).collect()) {
        const { _id, _creationTime, ...fields } = row;
        await ctx.db.replace(table, _id, rewrite(fields, ids) as never);
      }
    return Object.fromEntries(ids);
  });
  return new Map(Object.entries(pairs));
}

/** The document, its version, artifact, batch, file and import operation, as the routes name them. */
async function resources(f: F) {
  const batch = (await (await f.request(`/v1/imports/${await importId(f)}`)).json()).data;
  const file = batch.files[0];
  const detail = (
    await (await f.request(`/v1/documents/${f.documentId}?companyId=${f.scope.companyId}`)).json()
  ).data;
  return {
    documentId: detail.summary.id as string,
    versionId: detail.version.id as string,
    artifactId: detail.version.artifactId as string,
    importId: batch.id as string,
    fileId: file.id as string,
    operationId: file.operationId as string,
  };
}
const importId = (f: F) =>
  f.t.run(async (ctx) => (await ctx.db.query("imports").first())!._id as string);

const read = async (f: F, path: string, request = f.request) => {
  const response = await request(path);
  return { status: response.status, body: (await response.json()) as Body };
};

/** Another organization with its own key, project and company. */
async function stranger(f: F) {
  const secret = `fnfe_${"c".repeat(43)}`;
  const scope = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
  await f.t.run(async (ctx) => {
    const scopes = ["documents:read", "documents:import"] as const;
    await ctx.db.patch("apiKeys", scope.keyId, {
      scopes: [...scopes],
      expiresAt: Date.now() + 7 * DAY,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", scope.projectId).eq("companyId", scope.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
  });
  const request = (path: string) =>
    f.t.fetch(path, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
  return { scope, request };
}

it("answers the current resource under its new id for an old id, with originalId", async () => {
  const f = await fixture();
  const before = await resources(f);
  const company = `companyId=${f.scope.companyId}`;
  // Never archived: no originalId anywhere.
  const fresh = await read(f, `/v1/documents/${before.documentId}?${company}`);
  expect(fresh.body.data!.summary).not.toHaveProperty("originalId");
  expect(fresh.body.data!.version).not.toHaveProperty("originalId");
  expect((await read(f, `/v1/operations/${before.operationId}`)).body.data).not.toHaveProperty(
    "originalId",
  );

  const ids = await cycle(f, f.scope.organizationId, 1);
  const now = Object.fromEntries(
    Object.entries(before).map(([name, id]) => [name, ids.get(id)!]),
  ) as typeof before;
  for (const id of Object.values(now)) expect(id).toBeTruthy();

  const detail = await read(f, `/v1/documents/${before.documentId}?${company}`);
  expect(detail.status).toBe(200);
  expect(detail.body.data!.summary).toMatchObject({
    id: now.documentId,
    originalId: before.documentId,
    versionId: now.versionId,
  });
  expect(detail.body.data!.version).toMatchObject({
    id: now.versionId,
    originalId: before.versionId,
    artifactId: now.artifactId,
  });
  // The new id answers the same resource, still with the first one.
  const current = await read(f, `/v1/documents/${now.documentId}?${company}`);
  expect(current.body.data!.summary).toMatchObject({ originalId: before.documentId });
  // An old version id in the query, and the old ids of the subresources.
  expect(
    (await read(f, `/v1/documents/${before.documentId}?${company}&versionId=${before.versionId}`))
      .body.data!.version,
  ).toMatchObject({ id: now.versionId });
  const items = await read(
    f,
    `/v1/documents/${before.documentId}/items?${company}&versionId=${before.versionId}`,
  );
  expect(items.status).toBe(200);
  expect(items.body.data!.versionId).toBe(now.versionId);
  const files = await read(f, `/v1/documents/${before.documentId}/files?${company}`);
  expect(files.body.data!.page).toEqual([
    expect.objectContaining({ id: now.artifactId, originalId: before.artifactId }),
  ]);
  const versions = await read(f, `/v1/documents/${before.documentId}/versions?${company}`);
  expect(versions.body.data!.page).toEqual([
    expect.objectContaining({
      version: expect.objectContaining({ id: now.versionId, originalId: before.versionId }),
    }),
  ]);
  const original = await f.request(
    `/v1/document-artifacts/${before.artifactId}/original?${company}`,
  );
  expect(original.status).toBe(200);
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(f.bytes));

  const operation = await read(f, `/v1/operations/${before.operationId}`);
  expect(operation.status).toBe(200);
  expect(operation.body.data).toMatchObject({
    id: now.operationId,
    originalId: before.operationId,
    state: "succeeded",
  });
  const batch = await read(f, `/v1/imports/${before.importId}`);
  expect(batch.body.data).toMatchObject({ id: now.importId, originalId: before.importId });
  expect((batch.body.data!.files as unknown[])[0]).toMatchObject({
    id: now.fileId,
    originalId: before.fileId,
    operationId: now.operationId,
    documentId: now.documentId,
  });
  const history = await read(f, `/v1/imports/${before.importId}/files/${before.fileId}/history`);
  expect(history.status).toBe(200);

  // An id that never existed, and a well-formed id of a deleted row without a map entry.
  expect((await read(f, `/v1/documents/naoexiste?${company}`)).body.error!.code).toBe("NOT_FOUND");
  const orphan = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("coldArchiveRuns", {
      organizationId: f.scope.organizationId,
      key: "synthetic-ids-orphan",
      version: 1,
      state: "hot",
      reason: "free_inactive",
      noticeAt: 0,
      eligibleAt: 0,
      retainUntil: 0,
      createdAt: 0,
      updatedAt: 0,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    });
    const { _id, _creationTime, ...fields } = (await ctx.db.get(
      "fiscalDocuments",
      now.documentId as Id<"fiscalDocuments">,
    ))!;
    const gone = await ctx.db.insert("fiscalDocuments", fields);
    await ctx.db.delete("fiscalDocuments", gone);
    await ctx.db.delete("coldArchiveRuns", id);
    return gone;
  });
  const missing = await read(f, `/v1/documents/${orphan}?${company}`);
  expect(missing.status).toBe(404);
  expect(missing.body.error!.code).toBe("NOT_FOUND");
});

it("never resolves an old id of another organization", async () => {
  const f = await fixture();
  const before = await resources(f);
  const ids = await cycle(f, f.scope.organizationId, 1);
  const other = await stranger(f);
  const company = `companyId=${other.scope.companyId}`;
  for (const path of [
    `/v1/documents/${before.documentId}?${company}`,
    `/v1/documents/${ids.get(before.documentId)}?${company}`,
    `/v1/document-artifacts/${before.artifactId}/original?${company}`,
    `/v1/operations/${before.operationId}`,
    `/v1/imports/${before.importId}`,
  ]) {
    const answer = await read(f, path, other.request);
    expect([path, answer.status, answer.body.error?.code]).toEqual([path, 404, "NOT_FOUND"]);
  }
  // Even an entry of the other organization's map naming the first one's old id does not leak.
  await f.t.run(async (ctx) => {
    const runId = (await ctx.db.query("coldArchiveRuns").first())!._id;
    await ctx.db.insert("coldArchiveIdMap", {
      organizationId: other.scope.organizationId,
      runId,
      table: "fiscalDocuments",
      previousId: `${before.documentId}x`,
      previousCreationTime: 0,
      newId: ids.get(before.documentId)!,
    });
  });
  const crossed = await read(f, `/v1/documents/${before.documentId}x?${company}`, other.request);
  expect([crossed.status, crossed.body.error?.code]).toEqual([404, "NOT_FOUND"]);
});

it("follows the chain across two cycles, from the first and from an intermediate id", async () => {
  const f = await fixture();
  const before = await resources(f);
  const first = await cycle(f, f.scope.organizationId, 1);
  const second = await cycle(f, f.scope.organizationId, 2);
  const middle = first.get(before.documentId)!;
  const last = second.get(middle)!;
  expect(new Set([before.documentId, middle, last]).size).toBe(3);
  const company = `companyId=${f.scope.companyId}`;
  for (const id of [before.documentId, middle, last]) {
    const answer = await read(f, `/v1/documents/${id}?${company}`);
    expect(answer.status).toBe(200);
    // The id is the current one, and originalId stays the very first, not the intermediate.
    expect(answer.body.data!.summary).toMatchObject({ id: last, originalId: before.documentId });
  }
  const operation = await read(f, `/v1/operations/${before.operationId}`);
  expect(operation.body.data).toMatchObject({
    id: second.get(first.get(before.operationId)!),
    originalId: before.operationId,
  });
});

it("keeps idempotency over the id as sent: a repetition with the old id is reused", async () => {
  const f = await fixture();
  const before = await resources(f);
  const company = `companyId=${f.scope.companyId}`;
  const reprocessDocument = (id: string, key: string) =>
    f.request(`/v1/documents/${id}/reprocess?${company}`, "POST", undefined, key);
  const reprocessFile = (key: string) =>
    f.request(
      `/v1/imports/${before.importId}/files/${before.fileId}/reprocess`,
      "POST",
      undefined,
      key,
    );
  const documentRun = (await (await reprocessDocument(before.documentId, "reprocess-doc")).json())
    .data.operationId as string;
  const fileRun = (await (await reprocessFile("reprocess-file")).json()).data.operationId as string;
  const ids = await cycle(f, f.scope.organizationId, 1);

  const again = await reprocessDocument(before.documentId, "reprocess-doc");
  expect(again.status).toBe(202);
  expect((await again.json()).data).toEqual({
    operationId: ids.get(documentRun),
    reused: true,
  });
  const fileAgain = await reprocessFile("reprocess-file");
  expect(fileAgain.status).toBe(200);
  expect((await fileAgain.json()).data).toEqual({ operationId: ids.get(fileRun), reused: true });
  // The hash is over the id exactly as sent: the new id with the same key is another request.
  const renamed = await reprocessDocument(ids.get(before.documentId)!, "reprocess-doc");
  expect(renamed.status).toBe(409);
  expect((await renamed.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");

  // An export by the old id selects the current document, and its repetition is the same export.
  const created = await f.request(
    "/v1/exports",
    "POST",
    { companyId: f.scope.companyId, documentId: before.documentId },
    "export-old-id",
  );
  expect(created.status).toBe(200);
  const job = (await created.json()).data;
  expect(job.selection.documentId).toBe(ids.get(before.documentId));
  const repeated = await f.request(
    "/v1/exports",
    "POST",
    { companyId: f.scope.companyId, documentId: ids.get(before.documentId) },
    "export-old-id",
  );
  expect((await repeated.json()).data.id).toBe(job.id);
});

it("carries originalId in the webhook of a rehydrated resource, and the SDK verifies it", async () => {
  const f = await fixture();
  const before = await resources(f);
  const body = (id: string, key: string) =>
    f.t.run(async (ctx) => {
      const doc = (await ctx.db.get("fiscalDocuments", id as Id<"fiscalDocuments">))!;
      await documentEvent(ctx, doc, "document.updated", key);
      const event = await ctx.db
        .query("outboxEvents")
        .withIndex("by_logicalKey", (q) => q.eq("logicalKey", `document:${doc._id}:${key}`))
        .unique();
      return JSON.parse(event!.body) as WebhookEnvelope;
    });
  expect((await body(before.documentId, "fresh")).resource).not.toHaveProperty("originalId");
  const ids = await cycle(f, f.scope.organizationId, 1);
  const event = await body(ids.get(before.documentId)!, "after");
  expect(event.resource).toMatchObject({
    type: "document",
    id: ids.get(before.documentId),
    originalId: before.documentId,
  });

  const secrets = [{ version: 1, secret: "synthetic-webhook-secret" }];
  const verify = async (envelope: WebhookEnvelope) => {
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const headers = await signWebhook(
      bytes,
      {
        "x-fnfe-event-id": envelope.eventId,
        "x-fnfe-delivery-id": "synthetic-delivery",
        "x-fnfe-resource-version": String(envelope.resource.version),
        "x-fnfe-webhook-version": "1",
      },
      secrets,
      envelope.occurredAt,
    );
    return verifyWebhook({
      body: bytes,
      headers: { ...headers },
      secrets,
      now: envelope.occurredAt,
    });
  };
  expect(await verify(event)).toMatchObject({ ok: true });
  expect(
    await verify({ ...event, resource: { ...event.resource, originalId: event.resource.id } }),
  ).toEqual({ ok: false, code: "BODY_INVALID" });
});
