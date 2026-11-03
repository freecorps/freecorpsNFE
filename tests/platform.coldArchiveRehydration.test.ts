import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionReference } from "convex/server";
import { internal } from "../platform/convex/_generated/api";
import type { Doc, Id, TableNames } from "../platform/convex/_generated/dataModel";
import { platformTest, issuerScope } from "./helpers/platform";
import {
  ARCHIVE_DAY,
  ARCHIVE_TABLES,
  archiveStatus,
  assertOrganizationHot,
} from "../platform/convex/lib/coldArchiveCore";
import { archivedIdEntry } from "../platform/convex/lib/coldArchiveIdMap";
import { firstCreation, firstId } from "../platform/convex/lib/coldArchiveOrigin";
import {
  HOT_CUSTODY_UNREAD,
  MAP_SIDE_LIMIT,
  ORPHAN_SCAN_PAGE,
  ORPHAN_SCAN_TIES,
  orphanScanStep,
  HOT_REFERENCE_SOURCES,
  MAP_SIDE_REFERENCES,
  REWRITTEN_PATHS,
  rehydratedTable,
} from "../platform/convex/lib/coldArchiveRehydration";
import { attemptUsageKey } from "../platform/convex/lib/captureValues";
import {
  DOCUMENT_CONTENT_FORMAT,
  decodeDocumentContent,
  encodeDocumentContent,
} from "../platform/convex/lib/documentContent";
import { importTask } from "../platform/convex/lib/importValues";
import { contentObjectKey, originalObjectKey } from "../platform/convex/lib/coldObjects";
import { readStoredContent } from "../platform/convex/lib/documentContentRead";
import {
  encodeOriginal,
  originalSourceOf,
  readOriginal,
} from "../platform/convex/lib/documentOriginalRead";
import { DOCUMENT_CONTENT_MIME } from "../platform/convex/lib/documentValues";
import { retentionClass } from "../platform/convex/lib/retentionClasses";
import {
  collectOrphans,
  compactCatalog,
  createArchive,
  publishArchive,
  rehydrate,
  removeHot,
  restoreIsolated,
  verifyArchive,
} from "../scripts/lib/cold-archive.mjs";
import { sha256 } from "../scripts/lib/offsite-backup.mjs";
import { extractZip } from "../scripts/lib/offsite-backup-zip.mjs";

/**
 * Rehydration of an archived open organization under new IDs (ADR 0009, §5 and §6), end to end:
 * the administrative executor of `scripts/lib/cold-archive.mjs` against the real Convex functions
 * in convex-test, with R2 in memory and age replaced by a copy (encryption has its own tests in
 * `scripts/cold-archive.test.ts`). Only `Date` is faked, so the clock can jump past the orphan
 * grace while the executor's streams run on real timers.
 */
const directories: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.UTC(2026, 9, 30, 12));
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5198",
    CONVEX_SITE_URL: "http://127.0.0.1:3253",
    BETTER_AUTH_SECRET: "synthetic-cold-rehydration",
    FNFE_COLD_ARCHIVE: "enabled",
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const scratch = async () => {
  const path = await mkdtemp(join(tmpdir(), "fnfe-rehydrate-test-"));
  directories.push(path);
  return path;
};
type T = ReturnType<typeof platformTest>;
type Source = {
  query: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>;
};
/** The executor's Convex client, by function path, over convex-test. */
function adapter(t: T): Source {
  type Args = Record<string, unknown>;
  const ref = <K extends "query" | "mutation">(path: string) => {
    const [module, name] = path.split(":");
    const functions = internal as unknown as Record<
      string,
      Record<string, FunctionReference<K, "internal", Args>>
    >;
    return functions[module!]![name!]!;
  };
  return {
    query: async (path, args) =>
      path === "_system/frontend/getTableMapping"
        ? JSON.stringify({ 1: "documentArtifacts" })
        : t.query(ref<"query">(path), args),
    mutation: (path, args) => t.mutation(ref<"mutation">(path), args),
  };
}
/** R2 with conditional writes, in memory. */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  const digest = (bytes: Buffer) => ({ sha256: sha256(bytes), bytes: bytes.length });
  return {
    objects,
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async putFile(key: string, path: string) {
      if (objects.has(key)) return false;
      objects.set(key, await readFile(path));
      return true;
    },
    async putImmutable(key: string, bytes: Buffer) {
      if (objects.has(key)) return false;
      objects.set(key, bytes);
      return true;
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    async getFile(key: string, path: string) {
      const bytes = await this.get(key);
      await writeFile(path, Buffer.from(bytes), { flag: "wx" });
      return digest(bytes);
    },
    async verifyFile(key: string, expected: { sha256: string; bytes: number }) {
      expect(digest(await this.get(key))).toEqual(expected);
    },
  };
}
const copy = async (from: string, to: string) => copyFile(from, to);
const recipients = ["synthetic-custodian-one", "synthetic-custodian-two"];

const XML_A = "<NFe>original sintético A ç</NFe>";
const RAW_B = "<retDistDFeInt>lote sintético</retDistDFeInt>";
/**
 * An open Free organization, 100 days without activity, with Production usage (not Sandbox only)
 * and a notice already past its 30 days. Its fiscal rows cover the reference kinds of §5: a
 * forward reference (artifact → operation), stored files, the fence (stream) and its children,
 * and hot rows of other classes pointing into the archive. `audits` adds rows to cross batches.
 */
async function openOrganization(t: T, audits = 4) {
  const scope = await issuerScope(t, {
    keyHash: crypto.randomUUID(),
    kind: "demonstration",
    grantScopes: [],
    keyScopes: [],
  });
  const { organizationId, projectId, companyId } = scope;
  const old = Date.now() - 100 * ARCHIVE_DAY;
  return t.run(async (ctx) => {
    await ctx.db.patch("organizations", organizationId, { updatedAt: old });
    const planId = await ctx.db.insert("usagePlans", {
      organizationId,
      catalogTier: "free",
      name: "Gratuito",
      startsAt: 0,
      endsAt: null,
      limits: { imports: 100, captures: 0, registry: 0, bytes: 1e8, deliveries: 0 },
      concurrency: 1,
      version: 1,
      updatedAt: old,
    });
    await ctx.db.insert("usageTotals", {
      organizationId,
      environment: "production",
      period: "2026-01",
      metric: "imports",
      committed: 1,
      reserved: 0,
      updatedAt: old,
      startedAt: old,
    });
    const storageId = await ctx.storage.store(new Blob([XML_A], { type: "application/xml" }));
    const rawId = await ctx.storage.store(new Blob([RAW_B], { type: "application/xml" }));
    const streamId = await ctx.db.insert("captureStreams", {
      organizationId,
      projectId,
      companyId,
      environment: "production",
      identity: `synthetic-${crypto.randomUUID()}`,
      service: "nfe-distribution",
      state: "active",
      version: 3,
      checkpoint: "000000000000042",
      mode: "distNSU",
      nextAllowedAt: old,
      received: 42,
      createdAt: old,
    });
    const artifactId = await ctx.db.insert("documentArtifacts", {
      organizationId,
      companyId,
      projectId,
      environment: "production",
      storageId,
      sha256: "synthetic",
      size: XML_A.length,
      source: "imported-xml",
      importedAt: old,
    });
    const operationId = await ctx.db.insert("operations", {
      organizationId,
      projectId,
      companyId,
      environment: "production",
      task: importTask,
      request: JSON.stringify({ artifactId }),
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "succeeded",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 3,
      leaseUntil: old,
      nextAttemptAt: 0,
      backoffMs: 1,
      jitterMs: 1,
      uncertain: false,
      createdAt: old,
      updatedAt: old,
    });
    // A forward reference: the artifact (scanned first) points to the operation (scanned later).
    await ctx.db.patch("documentArtifacts", artifactId, { processingOperationId: operationId });
    // A version whose content also sits in a compressed blob (ADR 0010, phase B).
    const result = JSON.stringify({ document: { kind: "invoice", artifactId } });
    const content = await encodeDocumentContent({ result, items: [] });
    const contentStorageId = await ctx.storage.store(
      new Blob([Uint8Array.from(content.bytes)], { type: "application/gzip" }),
    );
    const versionId = await ctx.db.insert("documentVersions", {
      artifactId,
      operationId,
      state: "complete",
      code: "IMPORTED",
      kind: "invoice",
      completeness: 1,
      schema: null,
      parserVersion: "synthetic",
      normalizerVersion: null,
      processorVersion: "synthetic",
      // After B8: no inline copy, only the verified blob carries the content.
      itemCount: 0,
      writtenItems: 0,
      createdAt: old,
      contentVerifiedAt: old,
      contentStorageId,
      contentSha256: content.contentSha256,
      contentSize: content.contentSize,
      contentFormat: DOCUMENT_CONTENT_FORMAT,
    });
    await ctx.db.insert("operationAttempts", {
      operationId,
      generation: 1,
      fence: 1,
      mode: "execute",
      startedAt: old,
      finishedAt: old,
    });
    for (let i = 0; i < audits; i++)
      await ctx.db.insert("operationAudit", {
        operationId,
        generation: 1,
        actor: "synthetic",
        action: `step-${i}`,
        createdAt: old + i,
      });
    const batchId = await ctx.db.insert("captureBatches", {
      streamId,
      operationId,
      ownerVersion: 1,
      requestNsu: "000000000000001",
      mode: "distNSU",
      rawId,
      rawHash: "synthetic",
      saved: 0,
      committed: true,
      createdAt: old,
    });
    // Hot rows of other classes, kept through the custody, pointing into the archive.
    const idempotencyId = await ctx.db.insert("idempotencyRecords", {
      organizationId,
      projectId,
      name: "documents.import",
      key: "synthetic-client-key",
      requestHash: "synthetic",
      operationId,
    });
    const receiptId = await ctx.db.insert("operationReceipts", {
      operationId,
      organizationId,
      projectId,
      kind: "result",
      createdAt: old,
    });
    const auditId = await ctx.db.insert("operationalAudit", {
      organizationId,
      actor: "synthetic",
      action: "documents.import",
      target: String(artifactId),
      operationId,
      createdAt: old,
      expiresAt: old + 365 * ARCHIVE_DAY,
    });
    const runId = await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `synthetic-${crypto.randomUUID()}`,
      reason: "free_inactive",
      planVersion: 1,
      state: "notice",
      version: 1,
      noticeAt: Date.now() - 31 * ARCHIVE_DAY,
      eligibleAt: Date.now() - ARCHIVE_DAY,
      retainUntil: Date.now() + 6 * 365 * ARCHIVE_DAY,
      createdAt: Date.now() - 31 * ARCHIVE_DAY,
      updatedAt: Date.now() - 31 * ARCHIVE_DAY,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    });
    return {
      ...scope,
      planId,
      runId,
      storageId,
      rawId,
      streamId,
      artifactId,
      operationId,
      batchId,
      versionId,
      contentStorageId,
      hot: { idempotencyId, receiptId, auditId },
    };
  });
}
type Org = Awaited<ReturnType<typeof openOrganization>>;

/** Every row of the organization's archived tables and its files, keyed by table. */
async function snapshot(t: T, org: Org) {
  return t.run(async (ctx) => {
    const tables: Partial<Record<TableNames, Record<string, unknown>[]>> = {};
    for (const table of ARCHIVE_TABLES)
      for (const row of await ctx.db.query(table).collect()) {
        const owner =
          "organizationId" in row
            ? row.organizationId
            : "operationId" in row
              ? (await ctx.db.get("operations", row.operationId as Id<"operations">))
                  ?.organizationId
              : "streamId" in row
                ? (await ctx.db.get("captureStreams", row.streamId as Id<"captureStreams">))
                    ?.organizationId
                : undefined;
        if (owner === org.organizationId) (tables[table] ??= []).push(row);
      }
    return tables;
  });
}
const count = (tables: Awaited<ReturnType<typeof snapshot>>) =>
  Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows!.length]));

/**
 * Freeze, scan, seal, prove, remove and compact with the executor: the organization archived.
 * `coldStore` reads the cold tier's bucket, for a package with notes already cold (ADR 0010,
 * decision 6).
 */
async function archive(
  t: T,
  org: Org,
  store = memoryStore(),
  coldStore?: { verifyFile(key: string, expected: { sha256: string; bytes: number }): unknown },
) {
  const source = adapter(t);
  const dir = await scratch();
  await t.mutation(internal.coldArchive.freeze, { runId: org.runId, version: 1 });
  const created = await createArchive({
    source,
    runId: org.runId,
    directory: join(dir, "package"),
    download: async (item: { originalId: string }, path: string) => {
      const bytes = await t.run(async (ctx) => {
        const blob = await ctx.storage.get(item.originalId as Id<"_storage">);
        return await blob!.arrayBuffer();
      });
      await writeFile(path, Buffer.from(bytes), { flag: "wx" });
    },
  });
  const manifest = await publishArchive({
    source,
    store,
    archive: created,
    directory: dir,
    prefix: "synthetic/cold/",
    recipients,
    encrypt: copy,
    ...(coldStore ? { coldBucket: COLD_BUCKET, coldStore } : {}),
  });
  // The isolated import is the scripts' business; here the package itself is the re-export.
  await verifyArchive({
    source,
    store,
    manifest,
    directory: join(dir, "proof"),
    decrypt: copy,
    restoreAndExport: async (zip: string) => zip,
    verifierRunId: "synthetic-proof-001",
  });
  await removeHot(source, manifest);
  await compactCatalog({
    source,
    store,
    runId: org.runId,
    packageManifest: manifest,
    directory: join(dir, "catalog"),
    recipients,
    encrypt: copy,
    decrypt: copy,
  });
  return { store, manifest, source };
}
/** The executor's upload over convex-test: stores the bytes, returns the new storage ID. */
const uploader =
  (t: T) =>
  async ({ path }: { path: string }) => {
    const bytes = await readFile(path);
    return t.run((ctx) => ctx.storage.store(new Blob([bytes], { type: "application/xml" })));
  };
async function rehydrateWith(
  t: T,
  org: Org,
  archived: Awaited<ReturnType<typeof archive>>,
  options: {
    source?: Source;
    upload?: ReturnType<typeof uploader>;
    coldBatchBytes?: number;
  } = {},
) {
  return rehydrate({
    source: options.source ?? archived.source,
    store: archived.store,
    runId: org.runId,
    packageManifest: archived.manifest,
    directory: await scratch(),
    decrypt: copy,
    upload: options.upload ?? uploader(t),
    coldBatchBytes: options.coldBatchBytes,
    // A batch's passage runs in scheduled actions: waiting is letting them finish.
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await t.finishInProgressScheduledFunctions();
    },
  });
}
const run = (t: T, org: Org) => t.run((ctx) => archiveStatus(ctx, org.organizationId));
const mapEntries = (t: T, runId: Id<"coldArchiveRuns">) =>
  t.run((ctx) =>
    ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_runId_and_previousId", (q) => q.eq("runId", runId))
      .collect(),
  );
async function newIdOf(t: T, org: Org, previousId: string) {
  const entry = await t.run((ctx) => archivedIdEntry(ctx, org.organizationId, previousId));
  expect(entry, previousId).not.toBeNull();
  return entry!.newId;
}

it("archives an open organization and brings it back under new IDs with its whole history", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const before = await snapshot(t, org);
  const archived = await archive(t, org);
  // Archived: every row but the fence left, and the files with them.
  expect((await run(t, org))?.state).toBe("archived");
  expect(count(await snapshot(t, org))).toEqual({ captureStreams: 1 });
  expect(await t.run((ctx) => ctx.db.system.get("_storage", org.storageId))).toBeNull();
  expect(await t.run((ctx) => ctx.db.system.get("_storage", org.contentStorageId))).toBeNull();
  await expect(t.run((ctx) => assertOrganizationHot(ctx, org.organizationId))).rejects.toThrow(
    "ORGANIZATION_ARCHIVED",
  );

  const result = await rehydrateWith(t, org, archived);
  const after = (await run(t, org))!;
  expect(after).toMatchObject({ state: "hot", version: 2 });
  expect(after.rehydration).toMatchObject({ stage: "checked", files: 3, checkedFiles: 3 });
  expect(result).toMatchObject({
    rows: after.rows,
    files: 3,
    orphansDeleted: 0,
    orphansPending: 0,
  });
  await t.run((ctx) => assertOrganizationHot(ctx, org.organizationId));

  // The whole history is back: same tables, same counts, every row under a new ID with its
  // first ID and first creation, and the same content.
  const rehydrated = await snapshot(t, org);
  expect(count(rehydrated)).toEqual(count(before));
  for (const [table, rows] of Object.entries(before)) {
    if (table === "captureStreams") continue;
    for (const row of rows!) {
      const id = String(row._id);
      const back = rehydrated[table as TableNames]!.find((r) => r.originId === id)!;
      expect(back, `${table} ${id}`).toBeDefined();
      expect(back._id).not.toBe(id);
      expect(back.originCreationTime).toBe(row._creationTime);
      expect(firstId(back as never)).toBe(id);
      expect(firstCreation(back as never)).toBe(row._creationTime);
      expect(await newIdOf(t, org, id)).toBe(back._id);
    }
  }
  // References were rewritten: a forward one, files, children; the fence kept its ID.
  const operationId = await newIdOf(t, org, org.operationId);
  const artifactId = await newIdOf(t, org, org.artifactId);
  const storageId = await newIdOf(t, org, org.storageId);
  const rawId = await newIdOf(t, org, org.rawId);
  const artifact = (await t.run((ctx) =>
    ctx.db.get("documentArtifacts", artifactId as Id<"documentArtifacts">),
  ))!;
  expect(artifact).toMatchObject({ processingOperationId: operationId, storageId });
  const batchId = (await newIdOf(t, org, org.batchId)) as Id<"captureBatches">;
  const batch = (await t.run((ctx) => ctx.db.get("captureBatches", batchId)))!;
  expect(batch).toMatchObject({ operationId, rawId, streamId: org.streamId });
  expect(rehydrated.operationAttempts!.every((row) => row.operationId === operationId)).toBe(true);
  expect(await t.run((ctx) => ctx.db.get("captureStreams", org.streamId))).not.toBeNull();
  // The originals came back byte for byte under new storage IDs.
  for (const [id, text] of [
    [storageId, XML_A],
    [rawId, RAW_B],
  ] as const)
    expect(await t.run(async (ctx) => (await ctx.storage.get(id as Id<"_storage">))!.text())).toBe(
      text,
    );
  // The content blob too: the version points to its new storage ID, and the bytes, never
  // rewritten, still decode to the same hash.
  const contentStorageId = await newIdOf(t, org, org.contentStorageId);
  const versionId = (await newIdOf(t, org, org.versionId)) as Id<"documentVersions">;
  const version = (await t.run((ctx) => ctx.db.get("documentVersions", versionId)))!;
  expect(version).toMatchObject({ contentStorageId, artifactId, operationId });
  const blob = await t.run(async (ctx) =>
    (await ctx.storage.get(contentStorageId as Id<"_storage">))!.arrayBuffer(),
  );
  const decoded = await decodeDocumentContent(new Uint8Array(blob), {
    contentSha256: version.contentSha256!,
    contentSize: version.contentSize!,
    format: version.contentFormat!,
  });
  expect(version.result).toBeUndefined();
  expect(JSON.parse(decoded.result)).toMatchObject({ document: { kind: "invoice" } });
  // Hot rows of other classes point to the new operation.
  const hot = await t.run(async (ctx) => ({
    idempotency: await ctx.db.get("idempotencyRecords", org.hot.idempotencyId),
    receipt: await ctx.db.get("operationReceipts", org.hot.receiptId),
    audit: await ctx.db.get("operationalAudit", org.hot.auditId),
  }));
  expect(hot.idempotency?.operationId).toBe(operationId);
  expect(hot.receipt?.operationId).toBe(operationId);
  expect(hot.audit?.operationId).toBe(operationId);
  // Text kept as it was: the audit target still names the previous artifact, and the operation's
  // JSON still the previous one; whoever reads them resolves through the map.
  expect(hot.audit?.target).toBe(String(org.artifactId));
  // One map entry per rehydrated row and file; the fence has none.
  const entries = await mapEntries(t, org.runId);
  expect(entries).toHaveLength(after.rows - 1 + after.files);
  expect(entries.some((entry) => entry.previousId === org.streamId)).toBe(false);
  // The stock is rebuilt for the new IDs of the document tables and the map.
  const records = await t.run((ctx) =>
    ctx.db
      .query("capacityRecords")
      .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", org.organizationId))
      .collect(),
  );
  expect(records.map((r) => r.key)).toContain(`documentArtifacts:${artifactId}`);
  expect(records.filter((r) => r.key.startsWith("coldArchiveIdMap:"))).toHaveLength(entries.length);
  const files = await t.run((ctx) =>
    ctx.db
      .query("capacityFiles")
      .withIndex("by_organizationId_and_storageId", (q) =>
        q.eq("organizationId", org.organizationId),
      )
      .collect(),
  );
  expect(files.map((f) => f.storageId).sort()).toEqual([rawId, storageId, contentStorageId].sort());
});

it("resumes after a crash in the middle and never duplicates a row, a file or a map entry", async () => {
  const t = platformTest();
  const org = await openOrganization(t, 40);
  const before = count(await snapshot(t, org));
  const archived = await archive(t, org);
  const source = adapter(t);
  // The executor dies on the second batch of rows, after the first committed.
  let rowsCalls = 0;
  const crashing: Source = {
    query: source.query,
    mutation: async (path, args) => {
      if (path === "coldArchiveRehydration:rows" && ++rowsCalls === 2)
        throw new Error("synthetic crash");
      return source.mutation(path, args);
    },
  };
  await expect(rehydrateWith(t, org, archived, { source: crashing })).rejects.toThrow(
    "synthetic crash",
  );
  const halfway = (await run(t, org))!;
  expect(halfway.state).toBe("restoring");
  expect(halfway.rehydration).toMatchObject({ stage: "rows", files: 3 });
  expect(halfway.rehydration!.rows).toBeGreaterThan(0);
  expect(halfway.rehydration!.rows).toBeLessThan(halfway.rows);
  // Admissions stay refused while restoring.
  await expect(t.run((ctx) => assertOrganizationHot(ctx, org.organizationId))).rejects.toThrow(
    "ORGANIZATION_ARCHIVED",
  );
  // A lost response: the server applied the batch, the executor did not hear back.
  let lost = 0;
  const losing: Source = {
    query: source.query,
    mutation: async (path, args) => {
      const result = await source.mutation(path, args);
      if (["coldArchiveRehydration:rows", "coldArchiveRehydration:check"].includes(path) && !lost++)
        throw new Error("synthetic lost response");
      return result;
    },
  };
  await rehydrateWith(t, org, archived, { source: losing });
  expect(lost).toBeGreaterThan(0);
  const after = (await run(t, org))!;
  expect(after).toMatchObject({ state: "hot", version: 2 });
  expect(count(await snapshot(t, org))).toEqual(before);
  expect(await mapEntries(t, org.runId)).toHaveLength(after.rows - 1 + after.files);
  // The files were uploaded once: the second run reused the recorded intents.
  const intents = await t.run((ctx) => ctx.db.query("coldArchiveUploads").collect());
  expect(intents).toHaveLength(3);
  expect(intents.every((intent) => intent.attempt === 1 && intent.storageId)).toBe(true);
});

it("repeats every step without effect and refuses to run again once hot", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const archived = await archive(t, org);
  await rehydrateWith(t, org, archived);
  const done = (await run(t, org))!;
  const rows = count(await snapshot(t, org));
  const entries = (await mapEntries(t, org.runId)).length;
  // The old fence acts on nothing; `finish` repeated is a no-op; a new `begin` is stale.
  await t.mutation(internal.coldArchiveRehydration.finish, { runId: org.runId, version: 1 });
  for (const call of [
    () =>
      t.mutation(internal.coldArchiveRehydration.rows, {
        runId: org.runId,
        version: 1,
        offset: 0,
        rows: [],
      }),
    () =>
      t.mutation(internal.coldArchiveRehydration.begin, {
        runId: org.runId,
        version: 1,
        databaseBytes: 0,
        fileBytes: 0,
      }),
  ])
    await expect(call()).rejects.toThrow("ARCHIVE_STALE_FENCE");
  await expect(
    t.mutation(internal.coldArchiveRehydration.references, { runId: org.runId, version: 2 }),
  ).rejects.toThrow("ARCHIVE_NOT_RESTORING");
  // The executor refuses a run that is not archived nor restoring, before touching anything.
  await expect(rehydrateWith(t, org, archived)).rejects.toThrow(/archived ou restoring/);
  expect(await run(t, org)).toEqual(done);
  expect(count(await snapshot(t, org))).toEqual(rows);
  expect(await mapEntries(t, org.runId)).toHaveLength(entries);
});

it("replays a batch of rows and of the check without writing twice", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const archived = await archive(t, org);
  const source = adapter(t);
  // Records every mutation and replays each `rows` and `check` call right after it.
  const replaying: Source = {
    query: source.query,
    mutation: async (path, args) => {
      const result = await source.mutation(path, args);
      if (path === "coldArchiveRehydration:rows" || path === "coldArchiveRehydration:check")
        expect(await source.mutation(path, args)).toEqual(result);
      return result;
    },
  };
  await rehydrateWith(t, org, archived, { source: replaying });
  const after = (await run(t, org))!;
  expect(after.state).toBe("hot");
  expect(await mapEntries(t, org.runId)).toHaveLength(after.rows - 1 + after.files);
});

it("keeps two organizations apart: one rehydrates, the other stays archived and untouched", async () => {
  const t = platformTest();
  const one = await openOrganization(t);
  const two = await openOrganization(t);
  const store = memoryStore();
  const first = await archive(t, one, store);
  const second = await archive(t, two, store);
  const twoArchived = count(await snapshot(t, two));
  const twoHot = await t.run((ctx) => ctx.db.get("idempotencyRecords", two.hot.idempotencyId));
  // A row of the other organization slipped into a batch is refused before anything is written.
  await t.mutation(internal.coldArchiveRehydration.begin, {
    runId: one.runId,
    version: 1,
    databaseBytes: 0,
    fileBytes: 0,
  });
  // Canonical (keys sorted), so only the organization refuses it.
  const foreign = JSON.stringify({
    _creationTime: 1,
    _id: two.artifactId,
    organizationId: two.organizationId,
  });
  await t.run((ctx) =>
    ctx.db.patch("coldArchiveRuns", one.runId, {
      rehydration: {
        stage: "rows",
        startedAt: Date.now(),
        files: 2,
        rows: 0,
        digest: "",
        phase: 0,
        cursor: null,
        checked: 0,
        checkDigest: "",
        checkedFiles: 0,
      },
    }),
  );
  await expect(
    t.mutation(internal.coldArchiveRehydration.rows, {
      runId: one.runId,
      version: 1,
      offset: 0,
      rows: [{ table: "documentArtifacts", json: foreign }],
    }),
  ).rejects.toThrow("ARCHIVE_ROW_FOREIGN");
  // A blob of the other organization can never be claimed as an upload of this one.
  await t.run((ctx) =>
    ctx.db.patch("coldArchiveRuns", one.runId, {
      rehydration: {
        stage: "files",
        startedAt: Date.now(),
        files: 0,
        rows: 0,
        digest: "",
        phase: 0,
        cursor: null,
        checked: 0,
        checkDigest: "",
        checkedFiles: 0,
      },
    }),
  );
  const held = await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([XML_A]));
    await ctx.db.insert("documentArtifacts", {
      organizationId: two.organizationId,
      companyId: two.companyId,
      projectId: two.projectId,
      environment: "production",
      storageId: id,
      sha256: "synthetic",
      size: XML_A.length,
      source: "imported-xml",
      importedAt: Date.now(),
    });
    return { id, metadata: (await ctx.db.system.get("_storage", id))! };
  });
  const start = await t.mutation(internal.coldArchiveRehydration.beginUpload, {
    runId: one.runId,
    version: 1,
    metadata: { ...held.metadata, _id: one.storageId },
  });
  expect("attempt" in start).toBe(true);
  await expect(
    t.mutation(internal.coldArchiveRehydration.recordUpload, {
      runId: one.runId,
      version: 1,
      previousId: one.storageId,
      attempt: 1,
      storageId: held.id,
    }),
  ).rejects.toThrow("ARCHIVE_UPLOAD_FOREIGN");
  await t.run(async (ctx) => {
    for (const intent of await ctx.db.query("coldArchiveUploads").collect())
      await ctx.db.delete("coldArchiveUploads", intent._id);
    await ctx.db.patch("coldArchiveRuns", one.runId, { state: "archived", rehydration: undefined });
  });

  await rehydrateWith(t, one, first);
  expect((await run(t, one))?.state).toBe("hot");
  // The other organization stays archived: no row back, no map entry, hot rows untouched, and
  // the first organization's previous IDs never resolve for it.
  expect((await run(t, two))?.state).toBe("archived");
  const twoNow = await snapshot(t, two);
  expect(count(twoNow)).toEqual({ ...twoArchived, documentArtifacts: 1 });
  expect(await mapEntries(t, two.runId)).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get("idempotencyRecords", two.hot.idempotencyId))).toEqual(
    twoHot,
  );
  expect(
    await t.run((ctx) => archivedIdEntry(ctx, two.organizationId, String(one.operationId))),
  ).toBeNull();
  // Then the second one comes back on its own, with its own map.
  await rehydrateWith(t, two, second);
  expect((await run(t, two))?.state).toBe("hot");
  expect(await newIdOf(t, two, two.operationId)).not.toBe(await newIdOf(t, one, one.operationId));
  expect(
    await t.run((ctx) => archivedIdEntry(ctx, one.organizationId, String(two.operationId))),
  ).toBeNull();
});

/**
 * The isolated restore of ADR 0009, §7, over convex-test: the destination is a local extraction of
 * the package the executor would import, so the test sees exactly which rows and files it gets.
 * The source is wrapped to record every mutation; the restore must call none.
 */
async function restoreInIsolation(t: T, runId: Id<"coldArchiveRuns">, store: MemoryStore) {
  const source = adapter(t);
  const mutations: string[] = [];
  const recording: Source = {
    query: source.query,
    mutation: async (path, args) => {
      mutations.push(path);
      return source.mutation(path, args);
    },
  };
  const destination = new Map<string, string[]>();
  const result = await restoreIsolated({
    source: recording,
    store,
    runId,
    directory: await scratch(),
    decrypt: copy,
    restoreAndExport: async (zip: string) => {
      const entries = await extractZip(zip, join(await scratch(), "destination"), 1e8);
      for (const [name, path] of entries)
        destination.set(
          name,
          name.endsWith(".jsonl") ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : [],
        );
      return zip;
    },
  });
  const rows = (table: string) =>
    (destination.get(`${table}/documents.jsonl`) ?? []).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
  return { result, mutations, destination, rows };
}
type MemoryStore = ReturnType<typeof memoryStore>;

it("restores an open organization in isolation, read-only, archived, restoring and in a second cycle", async () => {
  const t = platformTest();
  const one = await openOrganization(t, 40);
  const two = await openOrganization(t);
  const store = memoryStore();
  const first = await archive(t, one, store);
  await archive(t, two, store);
  const twoArchived = await snapshot(t, two);
  const twoRun = await run(t, two);

  // Archived: the package of this organization only, with its original IDs, its originals and
  // the fence as the scan read it; nothing written to the origin.
  const archived = await restoreInIsolation(t, one.runId, store);
  const runOne = (await run(t, one))!;
  expect(archived.mutations).toEqual([]);
  expect(archived.result).toMatchObject({
    state: "restored_isolated",
    reason: "free_inactive",
    runState: "archived",
    catalog: "compacted",
    rows: runOne.rows,
    files: 3,
    rehydratedRows: 0,
    sameOriginReactivationSupported: false,
  });
  expect(archived.rows("documentArtifacts").map((row) => row._id)).toEqual([one.artifactId]);
  expect(archived.rows("captureStreams").map((row) => row._id)).toEqual([one.streamId]);
  expect(archived.rows("operationAudit")).toHaveLength(40);
  const owners = new Set(
    [...archived.destination.keys()]
      .filter((name) => name.endsWith("/documents.jsonl") && !name.startsWith("_"))
      .flatMap((name) => archived.rows(name.slice(0, -"/documents.jsonl".length)))
      .map((row) => row.organizationId)
      .filter((owner) => owner !== undefined),
  );
  expect([...owners]).toEqual([one.organizationId]);
  expect(
    archived
      .rows("_storage")
      .map((row) => String(row._id))
      .sort(),
  ).toEqual([String(one.storageId), String(one.rawId), String(one.contentStorageId)].sort());
  expect(await run(t, one)).toEqual(runOne);

  // Repeated, the same result and still nothing written.
  const again = await restoreInIsolation(t, one.runId, store);
  expect(again.result).toEqual(archived.result);
  expect(again.mutations).toEqual([]);

  // Restoring: halfway through a rehydration, the restore reads the same package and leaves the
  // rehydration where it was, which then resumes to `hot`.
  let rowsCalls = 0;
  const source = adapter(t);
  const crashing: Source = {
    query: source.query,
    mutation: async (path, args) => {
      if (path === "coldArchiveRehydration:rows" && ++rowsCalls === 2)
        throw new Error("synthetic crash");
      return source.mutation(path, args);
    },
  };
  await expect(rehydrateWith(t, one, first, { source: crashing })).rejects.toThrow(
    "synthetic crash",
  );
  const halfway = (await run(t, one))!;
  expect(halfway.state).toBe("restoring");
  const during = await restoreInIsolation(t, one.runId, store);
  expect(during.mutations).toEqual([]);
  expect(during.result).toMatchObject({ runState: "restoring", rows: runOne.rows, files: 3 });
  expect(await run(t, one)).toEqual(halfway);
  await rehydrateWith(t, one, first);
  expect((await run(t, one))?.state).toBe("hot");

  // Hot again: the data is back in the origin; the restore refuses before reading R2.
  let reads = 0;
  const counting: MemoryStore = {
    ...store,
    get: async (key: string) => {
      reads++;
      return store.get(key);
    },
  };
  await expect(restoreInIsolation(t, one.runId, counting)).rejects.toThrow(
    "ARCHIVE_ORGANIZATION_HOT",
  );
  expect(reads).toBe(0);

  // The other organization stayed archived and untouched, and restores only its own package.
  expect(await run(t, two)).toEqual(twoRun);
  expect(await snapshot(t, two)).toEqual(twoArchived);
  const other = await restoreInIsolation(t, two.runId, store);
  expect(other.rows("documentArtifacts").map((row) => row._id)).toEqual([two.artifactId]);
  expect(other.result).toMatchObject({ rehydratedRows: 0 });

  // A second cycle: the reactivated organization is archived again under a new run. Its package
  // carries the IDs of the first cycle, with the first ID in `originId`; the map stays hot.
  vi.setSystemTime(Date.now() + 120 * ARCHIVE_DAY);
  const cycle = await t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId: one.organizationId,
      key: `synthetic-${crypto.randomUUID()}`,
      reason: "free_inactive",
      planVersion: 1,
      state: "notice",
      version: 1,
      noticeAt: Date.now() - 31 * ARCHIVE_DAY,
      eligibleAt: Date.now() - ARCHIVE_DAY,
      retainUntil: Date.now() + 6 * 365 * ARCHIVE_DAY,
      createdAt: Date.now() - 31 * ARCHIVE_DAY,
      updatedAt: Date.now() - 31 * ARCHIVE_DAY,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    }),
  );
  const mapBefore = (await mapEntries(t, one.runId)).length;
  await archive(t, { ...one, runId: cycle }, store);
  const second = await restoreInIsolation(t, cycle, store);
  expect(second.mutations).toEqual([]);
  const cycleRun = (await run(t, one))!;
  expect(cycleRun._id).toBe(cycle);
  // Every row but the fence came back by the first rehydration.
  expect(second.result).toMatchObject({ runState: "archived", rows: cycleRun.rows, files: 3 });
  expect(second.result.rehydratedRows).toBe(cycleRun.rows - 1);
  const [artifact] = second.rows("documentArtifacts");
  expect(artifact).toMatchObject({
    _id: await newIdOf(t, one, one.artifactId),
    originId: one.artifactId,
    storageId: await newIdOf(t, one, one.storageId),
  });
  expect(second.rows("captureStreams").map((row) => row._id)).toEqual([one.streamId]);
  expect(await mapEntries(t, one.runId)).toHaveLength(mapBefore);
});

it("rewrites every receipt and registry call of an operation, and stops above the bound", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const extra = (count: number, operationId: Id<"operations">) =>
    t.run(async (ctx) => {
      const ids: { receipts: Id<"operationReceipts">[]; calls: Id<"registryCalls">[] } = {
        receipts: [],
        calls: [],
      };
      for (let i = 0; i < count; i++) {
        ids.receipts.push(
          await ctx.db.insert("operationReceipts", {
            operationId,
            organizationId: org.organizationId,
            projectId: org.projectId,
            kind: i % 2 ? "usage" : "result",
            createdAt: Date.now(),
          }),
        );
        ids.calls.push(
          await ctx.db.insert("registryCalls", {
            operationId,
            organizationId: org.organizationId,
            provider: "opencnpj",
            startedAt: Date.now(),
            state: "responded",
            costMinor: 0,
          }),
        );
      }
      return ids;
    });
  // More than the 10 the first version read: every one points to the new operation.
  const ids = await extra(12, org.operationId);
  const archived = await archive(t, org);
  await rehydrateWith(t, org, archived);
  const operationId = await newIdOf(t, org, org.operationId);
  const rows = await t.run(async (ctx) => [
    ...(await Promise.all(ids.receipts.map((id) => ctx.db.get("operationReceipts", id)))),
    ...(await Promise.all(ids.calls.map((id) => ctx.db.get("registryCalls", id)))),
  ]);
  expect(rows).toHaveLength(24);
  expect(rows.every((row) => row?.operationId === operationId)).toBe(true);
  // Past the bound, the rehydration stops instead of leaving rows with the previous ID.
  const other = await openOrganization(t);
  await extra(MAP_SIDE_LIMIT + 1, other.operationId);
  const stopped = await archive(t, other);
  await expect(rehydrateWith(t, other, stopped)).rejects.toThrow("ARCHIVE_REFERENCE_SCAN_LIMIT");
  expect((await run(t, other))?.state).toBe("restoring");
});

it("collects the orphan of an upload interrupted before its intent was completed", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const other = await openOrganization(t);
  const archived = await archive(t, org);
  // The first upload stores the blob and dies before `recordUpload`: an orphan.
  const store = uploader(t);
  let uploads = 0;
  const crashing = async (args: { path: string }) => {
    const id = await store(args);
    if (++uploads === 1) throw new Error("synthetic crash after the upload");
    return id;
  };
  await expect(rehydrateWith(t, org, archived, { upload: crashing })).rejects.toThrow(
    "synthetic crash",
  );
  const orphan = await t.run(
    async (ctx) => (await ctx.db.system.query("_storage").order("desc").first())!,
  );
  // Inside the window, the same bytes held by another organization's row, and the same bytes
  // created outside any attempt: neither is touched.
  const sibling = await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([XML_A], { type: "application/xml" }));
    await ctx.db.insert("documentArtifacts", {
      organizationId: other.organizationId,
      companyId: other.companyId,
      projectId: other.projectId,
      environment: "production",
      storageId: id,
      sha256: "synthetic",
      size: XML_A.length,
      source: "imported-xml",
      importedAt: Date.now(),
    });
    return id;
  });
  // `_storage` is global: other uploads in the same window fill more than one page of the
  // collection, and a second orphan with the original's bytes sits after them.
  const fillers = await t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < ORPHAN_SCAN_PAGE + 44; i++)
      ids.push(await ctx.storage.store(new Blob([`<outro>${i}</outro>`])));
    return ids;
  });
  const lateOrphan = await t.run((ctx) =>
    ctx.storage.store(new Blob([XML_A], { type: "application/xml" })),
  );
  const result = await rehydrateWith(t, org, archived, { upload: crashing });
  // The storage's clock and the mutation's are not the same: a blob stored just before the next
  // attempt may carry a creation time a little after its `startedAt` (seen in CI, with the
  // clock in 20 ms steps). Pin that boundary: the next attempt starts 1 ms before the late orphan.
  await t.run(async (ctx) => {
    const late = (await ctx.db.system.get("_storage", lateOrphan))!;
    const next = (await ctx.db.query("coldArchiveUploads").collect()).find(
      (intent) => intent.attempt === 2,
    )!;
    await ctx.db.patch("coldArchiveUploads", next._id, { startedAt: late._creationTime - 1 });
  });
  // Too recent to judge: another flow could still be about to record a blob like it.
  expect(result).toMatchObject({ orphansDeleted: 0, orphansPending: 1 });
  expect(await t.run((ctx) => ctx.db.system.get("_storage", orphan._id))).not.toBeNull();
  const intents = await t.run((ctx) => ctx.db.query("coldArchiveUploads").collect());
  expect(intents.filter((intent) => intent.attempt === 2)).toHaveLength(1);
  vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
  const late = await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([XML_A], { type: "application/xml" }));
    return id;
  });
  let calls = 0;
  const counting: Source = {
    query: archived.source.query,
    mutation: (path, args) => {
      if (path === "coldArchiveRehydration:collectUploadOrphans") calls++;
      return archived.source.mutation(path, args);
    },
  };
  expect(await collectOrphans({ source: counting, runId: org.runId })).toEqual({
    orphansDeleted: 2,
    orphansPending: 0,
  });
  // The only attempt left took two calls, one page of its window each; nothing was refused for
  // the window's size.
  expect(calls).toBe(2);
  for (const id of [orphan._id, lateOrphan])
    expect(await t.run((ctx) => ctx.db.system.get("_storage", id))).toBeNull();
  for (const id of [...fillers, sibling, late, await newIdOf(t, org, org.storageId)])
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", id as Id<"_storage">)),
    ).not.toBeNull();
  // Collecting again changes nothing.
  expect(await collectOrphans({ source: archived.source, runId: org.runId })).toEqual({
    orphansDeleted: 0,
    orphansPending: 0,
  });
});

it("stops the canonical check when a rehydrated row differs from the package", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const archived = await archive(t, org);
  const source = adapter(t);
  // Something changes a rehydrated row between the second pass and the check.
  const tampering: Source = {
    query: source.query,
    mutation: async (path, args) => {
      if (path === "coldArchiveRehydration:check") {
        const id = await newIdOf(t, org, org.artifactId);
        await t.run((ctx) =>
          ctx.db.patch("documentArtifacts", id as Id<"documentArtifacts">, { size: 999 }),
        );
      }
      return source.mutation(path, args);
    },
  };
  await expect(rehydrateWith(t, org, archived, { source: tampering })).rejects.toThrow(
    "ARCHIVE_CHECK_MISMATCH",
  );
  expect((await run(t, org))?.state).toBe("restoring");
  await expect(t.run((ctx) => assertOrganizationHot(ctx, org.organizationId))).rejects.toThrow(
    "ORGANIZATION_ARCHIVED",
  );
});

it("admits only an active paid plan and a package that fits the plan's capacity", async () => {
  const t = platformTest();
  const org = await openOrganization(t);
  const archived = await archive(t, org);
  const args = { runId: org.runId, version: 1, databaseBytes: 50 * 2 ** 20, fileBytes: 10 };
  await t.run(async (ctx) => {
    await ctx.db.patch("usagePlans", org.planId, {
      catalogTier: "intermediate",
      endsAt: Date.now() - ARCHIVE_DAY,
    });
  });
  await expect(t.mutation(internal.coldArchiveRehydration.begin, args)).rejects.toThrow(
    "PLAN_INACTIVE",
  );
  await t.run(async (ctx) => {
    await ctx.db.patch("usagePlans", org.planId, {
      catalogTier: "free",
      endsAt: null,
      capacity: {
        filesBytes: 128 * 2 ** 20,
        databaseBytes: 32 * 2 ** 20,
        companies: 1,
        members: 2,
        projects: 1,
        downloadsBytes: 1,
        exportsCount: 1,
        exportsBytes: 1,
        restReads: 1,
      },
    });
    await ctx.db.insert("platformPlanSettings", {
      key: "platform",
      enabled: true,
      version: 1,
      filesBytes: 0,
      databaseBytes: 0,
      custodyCents: 0,
      freeMonthlyCents: 0,
      allocatedFilesBytes: 0,
      allocatedDatabaseBytes: 0,
      allocatedCustodyCents: 0,
      allocatedFreeMonthlyCents: 0,
      admissionsUntil: 0,
      evidence: "synthetic",
      updatedAt: Date.now(),
    });
  });
  const refused = await t
    .mutation(internal.coldArchiveRehydration.begin, args)
    .catch((error: { data?: unknown }) => error.data);
  expect(refused).toMatchObject({
    code: "QUOTA_EXCEEDED",
    metric: "databaseBytes",
    plan: "intermediate",
  });
  expect((await run(t, org))?.state).toBe("archived");
  // A closed organization never reopens.
  await t.run((ctx) =>
    ctx.db.insert("organizationClosures", {
      organizationId: org.organizationId,
      state: "closing",
      requestedAt: Date.now(),
      exportUntil: Date.now() + 30 * ARCHIVE_DAY,
      purgeBy: Date.now() + 37 * ARCHIVE_DAY,
      generation: 1,
    }),
  );
  await expect(
    t.mutation(internal.coldArchiveRehydration.begin, { ...args, databaseBytes: 0 }),
  ).rejects.toThrow("ARCHIVE_CLOSED_NOT_REACTIVATABLE");
  await expect(rehydrateWith(t, org, archived)).rejects.toThrow("ARCHIVE_CLOSED_NOT_REACTIVATABLE");
  expect((await run(t, org))?.state).toBe("archived");
});

it("covers every rewritten reference with the rehydrated rows or a hot source", () => {
  const covered = new Set([
    ...HOT_REFERENCE_SOURCES.map((source) => source.table),
    ...MAP_SIDE_REFERENCES.map((field) => field.split(".")[0]!),
    ...HOT_CUSTODY_UNREAD,
  ]);
  for (const table of REWRITTEN_PATHS.keys())
    expect(rehydratedTable(table) || covered.has(table), table).toBe(true);
  // A hot table that is not archived must have its own source: the rehydrated rows don't cover it.
  for (const table of REWRITTEN_PATHS.keys())
    if (!(ARCHIVE_TABLES as readonly string[]).includes(table))
      expect(covered.has(table), table).toBe(true);
  expect(retentionClass.coldArchiveUploads).toBe("control");
});

it("composes usage and idempotency keys with the first ID", () => {
  const op = { _id: "synthetic_new", originId: "synthetic_first", fence: 3 } as Doc<"operations">;
  expect(attemptUsageKey(op)).toBe("synthetic_first:3");
  expect(attemptUsageKey({ ...op, originId: undefined })).toBe("synthetic_new:3");
});

it("walks a window whose page ends among blobs of the same instant, without losing or repeating one", () => {
  // `_storage` in index order: three at 10, then five at 20, then one at 30.
  const store = [
    ...["a", "b", "c"].map((id) => ({ _id: id, _creationTime: 10 })),
    ...["d", "e", "f", "g", "h"].map((id) => ({ _id: id, _creationTime: 20 })),
    { _id: "i", _creationTime: 30 },
  ];
  // What the collection reads: from `through` on (gte), `page + seen` blobs.
  const read = (cursor: { through: number; seenAtThrough: string[] } | undefined, page: number) =>
    store
      .filter((blob) => blob._creationTime >= (cursor?.through ?? 0))
      .slice(0, page + (cursor?.seenAtThrough.length ?? 0));
  for (const page of [1, 2, 3, 4, 8, 9, 20]) {
    const judged: string[] = [];
    let cursor: { through: number; seenAtThrough: string[] } | undefined;
    for (let call = 0; ; call++) {
      expect(call, `page ${page}`).toBeLessThan(20);
      const step = orphanScanStep(read(cursor, page), cursor, page);
      judged.push(...step.judge.map((blob) => blob._id));
      if (!step.next) break;
      cursor = step.next;
    }
    expect(judged, `page ${page}`).toEqual(store.map((blob) => blob._id));
  }
  // A page cut inside the run at 20 keeps the instant and the IDs already judged there.
  const first = orphanScanStep(read(undefined, 5), undefined, 5);
  expect(first.next).toEqual({ through: 20, seenAtThrough: ["d", "e"] });
  // More equal instants than the cursor may hold stops instead of looping.
  const ties = Array.from({ length: ORPHAN_SCAN_TIES + 2 }, (_, i) => ({
    _id: `t${i}`,
    _creationTime: 5,
  }));
  expect(() => orphanScanStep(ties, undefined, ORPHAN_SCAN_TIES + 1)).toThrow(
    "ARCHIVE_ORPHAN_SCAN_TIE",
  );
});

const COLD_ENDPOINT = "https://cold.r2.test";
const COLD_BUCKET = "fnfe-cold-test";
const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/**
 * The cold tier's bucket (ADR 0010, phase C) in memory, behind `fetch`, checking the signed payload
 * hash as R2 does. `failPuts` refuses that many writes first, as a bucket that fails for a while.
 */
function coldBucket() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const control = { failPuts: 0 };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (url.origin !== COLD_ENDPOINT) return real(input, init);
    const key = url.pathname.slice(`/${COLD_BUCKET}/`.length);
    const headers = new Headers(init?.headers);
    calls.push(`${init?.method} ${key}`);
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=test-key/"))
      return new Response(null, { status: 403 });
    if (init?.method === "PUT") {
      if (control.failPuts > 0) {
        control.failPuts--;
        return new Response(null, { status: 500 });
      }
      const body = new Uint8Array(init.body as ArrayBuffer);
      if (hex(body) !== headers.get("x-amz-content-sha256"))
        return new Response(null, { status: 400 });
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    if (init?.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    return object
      ? new Response(object as Uint8Array<ArrayBuffer>, { status: 200 })
      : new Response(null, { status: 404 });
  });
  /** The executor's read of the bucket when it seals a package with cold notes. */
  const reader = {
    async verifyFile(key: string, expected: { sha256: string; bytes: number }) {
      const bytes = objects.get(key);
      expect(bytes && { sha256: hex(bytes), bytes: bytes.length }).toEqual(expected);
    },
  };
  return { objects, calls, control, reader };
}
type Bucket = ReturnType<typeof coldBucket>;
function enableColdTier(lockedThrough = "2100") {
  vi.stubEnv("FNFE_COLD_TIER", "enabled");
  vi.stubEnv("FNFE_COLD_R2_ENDPOINT", COLD_ENDPOINT);
  vi.stubEnv("FNFE_COLD_R2_BUCKET", COLD_BUCKET);
  vi.stubEnv("FNFE_COLD_R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("FNFE_COLD_R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", lockedThrough);
}

/**
 * An imported note as phase B leaves it after B8: the note, its listing, the import and its file,
 * the XML original (held by the artifact and the import file) and one published version whose
 * content is only in its verified blob. `bytes` is what both files weigh in storage.
 */
async function addNote(
  t: T,
  org: Org,
  options: { createdAt: number; environment?: "sandbox" | "production" },
) {
  const environment = options.environment ?? "sandbox";
  const xml = `<NFe>nota sintética ${crypto.randomUUID()} ç</NFe>`;
  const raw = new TextEncoder().encode(xml);
  const result = JSON.stringify({ document: { kind: "invoice", synthetic: xml } });
  const content = await encodeDocumentContent({ result, items: [] });
  const fiscalKey = Array.from({ length: 44 }, () => Math.floor(Math.random() * 10)).join("");
  const ids = await t.run(async (ctx) => {
    const { organizationId, projectId, companyId } = org;
    const xmlId = await ctx.storage.store(new Blob([raw], { type: "application/xml" }));
    const blobId = await ctx.storage.store(
      new Blob([Uint8Array.from(content.bytes)], { type: DOCUMENT_CONTENT_MIME }),
    );
    const importId = await ctx.db.insert("imports", {
      organizationId,
      projectId,
      companyId,
      environment,
      key: `synthetic-${crypto.randomUUID()}`,
      requestHash: "synthetic",
      createdAt: options.createdAt,
      completedAt: options.createdAt,
    });
    const fileId = await ctx.db.insert("importFiles", {
      importId,
      position: 0,
      name: "nota.xml",
      size: raw.length,
      sha256: hex(raw),
      state: "accepted",
      expiresAt: options.createdAt,
      storageId: xmlId,
    });
    const documentId = await ctx.db.insert("fiscalDocuments", {
      organizationId,
      companyId,
      environment,
      model: "55",
      fiscalKey,
      completeness: 1,
      createdAt: options.createdAt,
      listedAt: options.createdAt,
    });
    const artifactId = await ctx.db.insert("documentArtifacts", {
      organizationId,
      projectId,
      companyId,
      environment,
      documentId,
      fileId,
      storageId: xmlId,
      sha256: hex(raw),
      size: raw.length,
      source: "imported-xml",
      importedAt: options.createdAt,
    });
    const versionId = await ctx.db.insert("documentVersions", {
      artifactId,
      operationId: org.operationId,
      documentId,
      state: "complete",
      code: "IMPORTED",
      kind: "invoice",
      completeness: 1,
      schema: null,
      parserVersion: "synthetic",
      normalizerVersion: null,
      processorVersion: "synthetic",
      itemCount: 0,
      writtenItems: 0,
      createdAt: options.createdAt,
      publishedAt: options.createdAt,
      contentVerifiedAt: options.createdAt,
      contentStorageId: blobId,
      contentSha256: content.contentSha256,
      contentSize: content.contentSize,
      contentFormat: DOCUMENT_CONTENT_FORMAT,
    });
    await ctx.db.patch("fiscalDocuments", documentId, { publishedVersionId: versionId });
    await ctx.db.insert("documentListings", {
      documentId,
      companyId,
      environment,
      filterKey: "all",
      date: options.createdAt,
    });
    return { xmlId, blobId, importId, fileId, documentId, artifactId, versionId };
  });
  return {
    ...ids,
    ...options,
    environment,
    xml,
    raw,
    result,
    content,
    fiscalKey,
    bytes: raw.length + content.bytes.length,
  };
}
type Note = Awaited<ReturnType<typeof addNote>>;
/** A note the cold tier's passage moved before the archiving: both objects in the bucket. */
async function makeCold(t: T, org: Org, note: Note, bucket: Bucket) {
  const place = {
    environment: "sandbox" as const,
    guardYear: null,
    organizationId: org.organizationId,
  };
  const contentKey = contentObjectKey({
    ...place,
    versionId: note.versionId,
    contentSha256: note.content.contentSha256,
  });
  const original = await encodeOriginal(note.raw);
  const originalKey = originalObjectKey({
    ...place,
    artifactId: note.artifactId,
    sha256: hex(note.raw),
  });
  bucket.objects.set(contentKey, note.content.bytes);
  bucket.objects.set(originalKey, original.bytes);
  await t.run(async (ctx) => {
    await ctx.db.patch("documentVersions", note.versionId, {
      contentStorageId: undefined,
      contentObjectKey: contentKey,
      contentObjectSha256: hex(note.content.bytes),
      contentObjectSize: note.content.bytes.length,
    });
    await ctx.db.patch("documentArtifacts", note.artifactId, {
      storageId: undefined,
      objectKey: originalKey,
      objectSha256: original.objectSha256,
      objectSize: original.objectSize,
    });
    await ctx.db.patch("importFiles", note.fileId, { storageId: undefined });
    await ctx.db.patch("fiscalDocuments", note.documentId, {
      coldState: "cold",
      coldAt: note.createdAt + ARCHIVE_DAY,
    });
    await ctx.storage.delete(note.blobId);
    await ctx.storage.delete(note.xmlId);
  });
  return { contentKey, originalKey };
}
/** The rows a note came back as, under their new IDs. */
async function rehydratedNote(t: T, org: Org, note: Note) {
  const ids = {
    documentId: (await newIdOf(t, org, note.documentId)) as Id<"fiscalDocuments">,
    versionId: (await newIdOf(t, org, note.versionId)) as Id<"documentVersions">,
    artifactId: (await newIdOf(t, org, note.artifactId)) as Id<"documentArtifacts">,
    fileId: (await newIdOf(t, org, note.fileId)) as Id<"importFiles">,
  };
  return t.run(async (ctx) => ({
    ids,
    doc: (await ctx.db.get("fiscalDocuments", ids.documentId))!,
    version: (await ctx.db.get("documentVersions", ids.versionId))!,
    artifact: (await ctx.db.get("documentArtifacts", ids.artifactId))!,
    file: (await ctx.db.get("importFiles", ids.fileId))!,
    listings: await ctx.db
      .query("documentListings")
      .withIndex("by_documentId", (q) => q.eq("documentId", ids.documentId))
      .collect(),
    // Deduplication finds the note by its key, as import and capture look it up.
    dedup: await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
        q
          .eq("organizationId", org.organizationId)
          .eq("companyId", org.companyId)
          .eq("environment", note.environment)
          .eq("model", "55")
          .eq("fiscalKey", note.fiscalKey),
      )
      .collect(),
  }));
}
type Back = Awaited<ReturnType<typeof rehydratedNote>>;
/** Content and original of a note, through the readers every route uses, from either tier. */
async function readBack(t: T, bucket: Bucket, back: Back) {
  return t.run(async (ctx) => {
    const storage = {
      get: (id: Id<"_storage">) => ctx.storage.get(id),
      object: async (key: string) => bucket.objects.get(key) ?? null,
    };
    const { version } = back;
    const content = await readStoredContent(
      storage,
      version.contentObjectKey !== undefined
        ? { objectKey: version.contentObjectKey }
        : { storageId: version.contentStorageId! },
      {
        contentSha256: version.contentSha256!,
        contentSize: version.contentSize!,
        format: version.contentFormat!,
      },
    );
    const original = await readOriginal(storage, originalSourceOf(back.artifact)!);
    return { result: content.result, original: new TextDecoder().decode(original!) };
  });
}
async function capacity(t: T, org: Org, filesBytes: number) {
  await t.run(async (ctx) => {
    await ctx.db.patch("usagePlans", org.planId, {
      capacity: {
        filesBytes,
        databaseBytes: 2 ** 30,
        companies: 1,
        members: 2,
        projects: 1,
        downloadsBytes: 1,
        exportsCount: 1,
        exportsBytes: 1,
        restReads: 1,
      },
    });
    if (await ctx.db.query("platformPlanSettings").first()) return;
    await ctx.db.insert("platformPlanSettings", {
      key: "platform",
      enabled: true,
      version: 1,
      filesBytes: 0,
      databaseBytes: 0,
      custodyCents: 0,
      freeMonthlyCents: 0,
      allocatedFilesBytes: 0,
      allocatedDatabaseBytes: 0,
      allocatedCustodyCents: 0,
      allocatedFreeMonthlyCents: 0,
      admissionsUntil: 0,
      evidence: "synthetic",
      updatedAt: Date.now(),
    });
  });
}
const filesStock = (t: T, org: Org) =>
  t.run(async (ctx) => {
    const total = await ctx.db
      .query("capacityTotals")
      .withIndex("by_organizationId_and_period_and_metric", (q) =>
        q.eq("organizationId", org.organizationId).eq("period", "stock").eq("metric", "filesBytes"),
      )
      .unique();
    return (total?.committed ?? 0) + (total?.reserved ?? 0);
  });
const stored = (t: T, id: string) =>
  t.run((ctx) => ctx.db.system.get("_storage", id as Id<"_storage">));

describe("only the plan's hot window comes back (ADR 0010, decision 5, phase C2)", () => {
  it("brings the window back hot and the older notes cold, with every note's residue", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    const bucket = coldBucket();
    enableColdTier();
    const now = Date.now();
    // Free keeps 3 months: 10 days is inside, 100 days outside (and inside a paid plan's 12).
    const recent = await addNote(t, org, { createdAt: now - 10 * ARCHIVE_DAY });
    const old = await addNote(t, org, { createdAt: now - 100 * ARCHIVE_DAY });
    const frozen = await addNote(t, org, { createdAt: now - 400 * ARCHIVE_DAY });
    const frozenKeys = await makeCold(t, org, frozen, bucket);
    const before = await snapshot(t, org);
    const archived = await archive(t, org, memoryStore(), bucket.reader);
    expect(archived.manifest.coldDocuments).toMatchObject({ bucket: COLD_BUCKET, count: 2 });
    const objectsBefore = new Map(bucket.objects);
    bucket.calls.length = 0;

    const result = await rehydrateWith(t, org, archived);
    const after = (await run(t, org))!;
    expect(after).toMatchObject({ state: "hot", version: 2 });
    expect(after.rehydration).toMatchObject({ stage: "checked", checkedFiles: after.files });
    // The executor deferred exactly the old note's two files, and the server moved that note.
    expect(result.cold).toEqual({
      deferredFiles: 2,
      deferredBytes: old.bytes,
      batchBytes: old.bytes,
      moved: 1,
      kept: 0,
    });
    expect(result).toMatchObject({ orphansDeleted: 0, orphansPending: 0 });

    // The residue of every note is back: same tables, same counts; listing and dedup unchanged.
    expect(count(await snapshot(t, org))).toEqual(count(before));
    const notes = {
      recent: await rehydratedNote(t, org, recent),
      old: await rehydratedNote(t, org, old),
      frozen: await rehydratedNote(t, org, frozen),
    };
    for (const back of Object.values(notes)) {
      expect(back.listings).toHaveLength(1);
      expect(back.dedup.map((doc) => doc._id)).toEqual([back.ids.documentId]);
    }

    // Inside the window: hot, as before C2.
    expect(notes.recent.doc.coldState).toBeUndefined();
    expect(notes.recent.version.contentStorageId).toBeDefined();
    expect(await stored(t, notes.recent.version.contentStorageId!)).not.toBeNull();
    expect(notes.recent.artifact.storageId).toBe(notes.recent.file.storageId);
    expect(await stored(t, notes.recent.artifact.storageId!)).not.toBeNull();

    // Outside: cold under the new IDs, keyed as the passage keys them, its files gone from
    // storage and from the stock.
    const place = {
      environment: "sandbox" as const,
      guardYear: null,
      organizationId: org.organizationId,
    };
    const contentKey = contentObjectKey({
      ...place,
      versionId: notes.old.ids.versionId,
      contentSha256: old.content.contentSha256,
    });
    const originalKey = originalObjectKey({
      ...place,
      artifactId: notes.old.ids.artifactId,
      sha256: hex(old.raw),
    });
    expect(notes.old.doc).toMatchObject({ coldState: "cold" });
    expect(notes.old.version).toMatchObject({
      contentObjectKey: contentKey,
      contentObjectSha256: hex(old.content.bytes),
      contentObjectSize: old.content.bytes.length,
    });
    expect(notes.old.version.contentStorageId).toBeUndefined();
    expect(notes.old.artifact).toMatchObject({ objectKey: originalKey });
    expect(notes.old.artifact.storageId).toBeUndefined();
    expect(notes.old.file.storageId).toBeUndefined();
    expect(bucket.objects.get(contentKey)).toEqual(old.content.bytes);
    expect(bucket.calls.filter((call) => call.startsWith("PUT")).sort()).toEqual(
      [`PUT ${contentKey}`, `PUT ${originalKey}`].sort(),
    );
    for (const previous of [old.blobId, old.xmlId])
      expect(await stored(t, await newIdOf(t, org, previous))).toBeNull();
    const capacityFiles = await t.run((ctx) =>
      ctx.db
        .query("capacityFiles")
        .withIndex("by_organizationId_and_storageId", (q) =>
          q.eq("organizationId", org.organizationId),
        )
        .collect(),
    );
    expect(capacityFiles.map((row) => row.storageId).sort()).toEqual(
      [
        await newIdOf(t, org, org.storageId),
        await newIdOf(t, org, org.rawId),
        await newIdOf(t, org, org.contentStorageId),
        notes.recent.version.contentStorageId!,
        notes.recent.artifact.storageId!,
      ].sort(),
    );
    expect(await filesStock(t, org)).toBe(archived.manifest.fileBytes - old.bytes);

    // Already cold in the package: the same keys and objects, untouched.
    expect(notes.frozen.version.contentObjectKey).toBe(frozenKeys.contentKey);
    expect(notes.frozen.artifact.objectKey).toBe(frozenKeys.originalKey);
    expect(notes.frozen.doc.coldAt).toBe(frozen.createdAt + ARCHIVE_DAY);
    for (const [key, bytes] of objectsBefore) expect(bucket.objects.get(key)).toEqual(bytes);

    // Every note reads byte for byte from its tier, content and original alike.
    for (const [name, note] of [
      ["recent", recent],
      ["old", old],
      ["frozen", frozen],
    ] as const)
      expect(await readBack(t, bucket, notes[name])).toEqual({
        result: note.result,
        original: note.xml,
      });
  });

  it("admits the hot files plus one batch and refuses what does not fit", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    coldBucket();
    enableColdTier();
    const now = Date.now();
    await addNote(t, org, { createdAt: now - 10 * ARCHIVE_DAY });
    const one = await addNote(t, org, { createdAt: now - 100 * ARCHIVE_DAY });
    const two = await addNote(t, org, { createdAt: now - 120 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    const stock = await filesStock(t, org);
    const hot = archived.manifest.fileBytes - one.bytes - two.bytes;
    // A batch of one note (budget of 1 byte): the slack is the larger of the two.
    const batch = Math.max(one.bytes, two.bytes);
    // The whole package would not fit; before C2 this organization could not come back.
    await capacity(t, org, stock + hot + batch - 1);
    const refused = await rehydrateWith(t, org, archived, { coldBatchBytes: 1 }).catch(
      (error: { data?: unknown }) => error.data,
    );
    expect(refused).toMatchObject({
      code: "QUOTA_EXCEEDED",
      metric: "filesBytes",
      required: stock + hot + batch,
    });
    expect((await run(t, org))?.state).toBe("archived");

    await capacity(t, org, stock + hot + batch);
    expect(archived.manifest.fileBytes).toBeGreaterThan(hot + batch);
    const result = await rehydrateWith(t, org, archived, { coldBatchBytes: 1 });
    expect(result.cold).toMatchObject({ deferredFiles: 4, batchBytes: batch, moved: 2 });
    // Each batch left storage before the next came in; the stock is the window's.
    expect(await filesStock(t, org)).toBe(stock + hot);
  });

  it("keeps hot what cannot move, and the admission counts it hot", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    coldBucket();
    // No lock rule confirmed: no Production object may reach the bucket.
    enableColdTier("");
    const now = Date.now();
    const production = await addNote(t, org, {
      createdAt: now - 100 * ARCHIVE_DAY,
      environment: "production",
    });
    const sandbox = await addNote(t, org, { createdAt: now - 100 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    const source = adapter(t);
    let admission: Record<string, unknown> | undefined;
    const watching: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (path === "coldArchiveRehydration:begin") admission = args;
        return source.mutation(path, args);
      },
    };
    const result = await rehydrateWith(t, org, archived, { source: watching });
    expect(admission).toMatchObject({
      fileBytes: archived.manifest.fileBytes - sandbox.bytes,
      cold: { lockedThrough: null, files: 2, bytes: sandbox.bytes, batchBytes: sandbox.bytes },
    });
    expect(result.cold).toMatchObject({ deferredFiles: 2, moved: 1, kept: 1 });
    const held = await rehydratedNote(t, org, production);
    expect(held.doc.coldState).toBeUndefined();
    expect(await stored(t, held.version.contentStorageId!)).not.toBeNull();
    expect(await stored(t, held.artifact.storageId!)).not.toBeNull();
    expect((await rehydratedNote(t, org, sandbox)).doc.coldState).toBe("cold");
    // A plan made under another rule is refused before anything is written.
    const other = await openOrganization(t);
    const otherArchived = await archive(t, other);
    await expect(
      t.mutation(internal.coldArchiveRehydration.begin, {
        runId: other.runId,
        version: 1,
        databaseBytes: 0,
        fileBytes: otherArchived.manifest.fileBytes,
        cold: { cutoff: Date.now(), lockedThrough: null, files: 0, bytes: 0, batchBytes: 0 },
      }),
    ).rejects.toMatchObject({ data: { code: "ARCHIVE_REHYDRATE_COLD_POLICY" } });
    expect((await run(t, other))?.state).toBe("archived");
  });

  it("moves with the server's own pass a note the plan kept hot, once it can move", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    const bucket = coldBucket();
    enableColdTier("");
    const production = await addNote(t, org, {
      createdAt: Date.now() - 100 * ARCHIVE_DAY,
      environment: "production",
    });
    const archived = await archive(t, org);
    const source = adapter(t);
    // The lock rule is confirmed after `begin`: the plan kept the note hot, its files came back
    // in the files stage, and the server's pass now moves it and frees them.
    const confirming: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (path === "coldArchiveRehydration:coldBatch")
          vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "2100");
        return source.mutation(path, args);
      },
    };
    const result = await rehydrateWith(t, org, archived, { source: confirming });
    expect(result.cold).toMatchObject({ deferredFiles: 0, moved: 1, kept: 0 });
    const back = await rehydratedNote(t, org, production);
    expect(back.doc.coldState).toBe("cold");
    expect(back.version.contentObjectKey).toMatch(/^documents\/production\/guard-\d{4}\//);
    expect(await stored(t, await newIdOf(t, org, production.blobId))).toBeNull();
    expect(await filesStock(t, org)).toBe(archived.manifest.fileBytes - production.bytes);
    expect(await readBack(t, bucket, back)).toEqual({
      result: production.result,
      original: production.xml,
    });
  });

  it("brings everything back hot with the cold tier off", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    const old = await addNote(t, org, { createdAt: Date.now() - 100 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    const result = await rehydrateWith(t, org, archived);
    expect(result.cold).toBeUndefined();
    expect((await run(t, org))?.rehydration?.cold).toBeUndefined();
    const back = await rehydratedNote(t, org, old);
    expect(back.doc.coldState).toBeUndefined();
    expect(await stored(t, back.version.contentStorageId!)).not.toBeNull();
  });

  it("keeps a held organization's notes hot, held before or during the rehydration", async () => {
    const t = platformTest();
    const bucket = coldBucket();
    enableColdTier();
    const hold = (org: Org) =>
      t.run((ctx) =>
        ctx.db.insert("retentionHolds", {
          organizationId: org.organizationId,
          reference: "synthetic-hold",
          reviewAt: Date.now() + ARCHIVE_DAY,
          createdAt: Date.now(),
        }),
      );
    // Held before: no cold stage at all, every file comes back in the files stage.
    const before = await openOrganization(t);
    const first = await addNote(t, before, { createdAt: Date.now() - 100 * ARCHIVE_DAY });
    const firstArchived = await archive(t, before);
    await hold(before);
    expect(
      await t.query(internal.coldArchiveRehydration.coldPolicy, {
        runId: before.runId,
        now: Date.now(),
      }),
    ).toEqual({ enabled: false, reason: "legalHold" });
    expect((await rehydrateWith(t, before, firstArchived)).cold).toBeUndefined();
    expect((await rehydratedNote(t, before, first)).doc.coldState).toBeUndefined();
    // Held during the cold stage: the deferred files come back hot after all.
    const during = await openOrganization(t);
    const second = await addNote(t, during, { createdAt: Date.now() - 100 * ARCHIVE_DAY });
    const secondArchived = await archive(t, during);
    const source = adapter(t);
    let placed = false;
    const holding: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (path === "coldArchiveRehydration:coldBatch" && !placed) {
          placed = true;
          await hold(during);
        }
        return source.mutation(path, args);
      },
    };
    const result = await rehydrateWith(t, during, secondArchived, { source: holding });
    expect(result.cold).toMatchObject({ deferredFiles: 2, moved: 0, kept: 1 });
    const back = await rehydratedNote(t, during, second);
    expect(back.doc.coldState).toBeUndefined();
    expect(await readBack(t, bucket, back)).toEqual({
      result: second.result,
      original: second.xml,
    });
    expect(bucket.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
  });

  it("resumes a batch cut in the middle, outlasts a failing bucket and repeats steps harmlessly", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    const bucket = coldBucket();
    enableColdTier();
    const now = Date.now();
    const old = await addNote(t, org, { createdAt: now - 100 * ARCHIVE_DAY });
    const older = await addNote(t, org, { createdAt: now - 150 * ARCHIVE_DAY });
    await addNote(t, org, { createdAt: now - 10 * ARCHIVE_DAY });
    const before = count(await snapshot(t, org));
    const archived = await archive(t, org);
    const source = adapter(t);
    // The executor dies in the first batch, after its first file was recorded.
    const crashing: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (
          path === "coldArchiveRehydration:beginUpload" &&
          (args.metadata as { _id: string })._id === String(old.xmlId)
        )
          throw new Error("synthetic crash");
        return source.mutation(path, args);
      },
    };
    await expect(
      rehydrateWith(t, org, archived, { source: crashing, coldBatchBytes: 1 }),
    ).rejects.toThrow("synthetic crash");
    const halfway = (await run(t, org))!;
    expect(halfway.state).toBe("restoring");
    expect(halfway.rehydration).toMatchObject({ stage: "cold" });
    expect(halfway.rehydration!.cold!.batch!.files.sort()).toEqual(
      [String(old.blobId), String(old.xmlId)].sort(),
    );
    await expect(t.run((ctx) => assertOrganizationHot(ctx, org.organizationId))).rejects.toThrow(
      "ORGANIZATION_ARCHIVED",
    );
    // The bucket refuses the next write; every step of the cold stage is sent twice.
    bucket.control.failPuts = 1;
    const replaying: Source = {
      query: source.query,
      mutation: async (path, args) => {
        const result = await source.mutation(path, args);
        if (["coldArchiveRehydration:coldStep", "coldArchiveRehydration:coldBatch"].includes(path))
          return source.mutation(path, args);
        return result;
      },
    };
    const result = await rehydrateWith(t, org, archived, {
      source: replaying,
      coldBatchBytes: 1,
    });
    expect(result.cold).toMatchObject({ deferredFiles: 4, moved: 2 });
    expect((await run(t, org))?.state).toBe("hot");
    expect(count(await snapshot(t, org))).toEqual(before);
    for (const note of [old, older]) {
      const back = await rehydratedNote(t, org, note);
      expect(back.doc.coldState).toBe("cold");
      expect(await readBack(t, bucket, back)).toEqual({ result: note.result, original: note.xml });
    }
    // Each file was sent once, through one intent.
    const intents = await t.run((ctx) =>
      ctx.db
        .query("coldArchiveUploads")
        .withIndex("by_runId_and_collectedAt", (q) => q.eq("runId", org.runId))
        .collect(),
    );
    expect(intents).toHaveLength(archived.manifest.files);
    expect(intents.every((intent) => intent.attempt === 1 && intent.storageId)).toBe(true);
    // Four objects, and the one write the bucket refused.
    expect(bucket.calls.filter((call) => call.startsWith("PUT"))).toHaveLength(5);
  });

  it("stops before overfilling the plan when deferred files must come back hot after all", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    coldBucket();
    enableColdTier();
    const now = Date.now();
    const one = await addNote(t, org, { createdAt: now - 100 * ARCHIVE_DAY });
    const two = await addNote(t, org, { createdAt: now - 120 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    const stock = await filesStock(t, org);
    const hot = archived.manifest.fileBytes - one.bytes - two.bytes;
    const batch = Math.max(one.bytes, two.bytes);
    await capacity(t, org, stock + hot + batch);
    const source = adapter(t);
    let placed = false;
    // A legal hold arrives once the cold stage began: neither note may move any more.
    const holding: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (path === "coldArchiveRehydration:coldBatch" && !placed) {
          placed = true;
          await t.run((ctx) =>
            ctx.db.insert("retentionHolds", {
              organizationId: org.organizationId,
              reviewAt: Date.now() + ARCHIVE_DAY,
              createdAt: Date.now(),
            }),
          );
        }
        return source.mutation(path, args);
      },
    };
    const refused = await rehydrateWith(t, org, archived, {
      source: holding,
      coldBatchBytes: 1,
    }).catch((error: { data?: unknown }) => error.data);
    expect(refused).toMatchObject({ code: "QUOTA_EXCEEDED", metric: "filesBytes" });
    // Stopped in the cold stage, the plan never overfilled; a larger plan lets it finish.
    expect((await run(t, org))?.rehydration?.stage).toBe("cold");
    expect(await filesStock(t, org)).toBeLessThanOrEqual(stock + hot + batch);
    await capacity(t, org, stock + archived.manifest.fileBytes);
    const result = await rehydrateWith(t, org, archived, { coldBatchBytes: 1 });
    expect(result.cold).toMatchObject({ moved: 0, kept: 2 });
    expect(await filesStock(t, org)).toBe(stock + archived.manifest.fileBytes);
  });

  it("stops on a bucket that keeps failing and resumes the same batch later", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    const bucket = coldBucket();
    enableColdTier();
    const old = await addNote(t, org, { createdAt: Date.now() - 100 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    bucket.control.failPuts = 1_000;
    await expect(rehydrateWith(t, org, archived)).rejects.toThrow("ARCHIVE_REHYDRATE_COLD_STALLED");
    // The note stayed whole: claimed by the batch, its files hot and recorded, nothing cold.
    const halfway = (await run(t, org))!;
    expect(halfway.rehydration).toMatchObject({ stage: "cold", files: halfway.files });
    expect(halfway.rehydration!.cold!.batch!.attempt).toBeGreaterThan(3);
    const stuck = await rehydratedNote(t, org, old);
    expect(stuck.doc.coldState).not.toBe("cold");
    expect(await stored(t, stuck.version.contentStorageId!)).not.toBeNull();
    bucket.control.failPuts = 0;
    const result = await rehydrateWith(t, org, archived);
    expect(result.cold).toMatchObject({ moved: 1 });
    const back = await rehydratedNote(t, org, old);
    expect(back.doc.coldState).toBe("cold");
    expect(await readBack(t, bucket, back)).toEqual({ result: old.result, original: old.xml });
  });

  it("stops the check when a moved row differs from what the passage recorded", async () => {
    const t = platformTest();
    const org = await openOrganization(t);
    coldBucket();
    enableColdTier();
    const old = await addNote(t, org, { createdAt: Date.now() - 100 * ARCHIVE_DAY });
    const archived = await archive(t, org);
    const source = adapter(t);
    const tampering: Source = {
      query: source.query,
      mutation: async (path, args) => {
        if (path === "coldArchiveRehydration:check") {
          const id = (await newIdOf(t, org, old.versionId)) as Id<"documentVersions">;
          await t.run(async (ctx) => {
            const version = (await ctx.db.get("documentVersions", id))!;
            await ctx.db.patch("documentVersions", id, {
              contentObjectSize: version.contentObjectSize! + 1,
            });
          });
        }
        return source.mutation(path, args);
      },
    };
    await expect(rehydrateWith(t, org, archived, { source: tampering })).rejects.toThrow(
      "ARCHIVE_CHECK_MISMATCH",
    );
    expect((await run(t, org))?.state).toBe("restoring");
  });
});
