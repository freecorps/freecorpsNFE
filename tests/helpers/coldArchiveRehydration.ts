import { expect, onTestFinished } from "vite-plus/test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionReference } from "convex/server";
import { internal } from "../../platform/convex/_generated/api";
import type { Id, TableNames } from "../../platform/convex/_generated/dataModel";
import { platformTest, issuerScope } from "./platform";
import {
  ARCHIVE_DAY,
  ARCHIVE_TABLES,
  archiveStatus,
} from "../../platform/convex/lib/coldArchiveCore";
import { archivedIdEntry } from "../../platform/convex/lib/coldArchiveIdMap";
import {
  DOCUMENT_CONTENT_FORMAT,
  encodeDocumentContent,
} from "../../platform/convex/lib/documentContent";
import { importTask } from "../../platform/convex/lib/importValues";
import {
  compactCatalog,
  createArchive,
  publishArchive,
  rehydrate,
  removeHot,
  verifyArchive,
} from "../../scripts/lib/cold-archive.mjs";
import { sha256 } from "../../scripts/lib/offsite-backup.mjs";

/**
 * Rehydration of an archived open organization (ADR 0009, §5 to §7): the executor of
 * `scripts/lib/cold-archive.mjs` over convex-test, with R2 in memory and age replaced by a copy.
 * A synthetic open organization, its archive and its rehydration. Each test file sets the
 * environment and the clock (see coldArchiveRehydration.test.ts).
 */

/** A temporary directory of the running test, removed when the test finishes. */
export const scratch = async () => {
  const path = await mkdtemp(join(tmpdir(), "fnfe-rehydrate-test-"));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
};
export type T = ReturnType<typeof platformTest>;
export type Source = {
  query: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>;
};
/** The executor's Convex client, by function path, over convex-test. */
export function adapter(t: T): Source {
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
export function memoryStore() {
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
export const copy = async (from: string, to: string) => copyFile(from, to);
const recipients = ["synthetic-custodian-one", "synthetic-custodian-two"];

export const XML_A = "<NFe>original sintético A ç</NFe>";
export const RAW_B = "<retDistDFeInt>lote sintético</retDistDFeInt>";
/**
 * An open Free organization, 100 days without activity, with Production usage (not Sandbox only)
 * and a notice already past its 30 days. Its fiscal rows cover the reference kinds of §5: a
 * forward reference (artifact → operation), stored files, the fence (stream) and its children,
 * and hot rows of other classes pointing into the archive. `audits` adds rows to cross batches.
 */
export async function openOrganization(t: T, audits = 4) {
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
export type Org = Awaited<ReturnType<typeof openOrganization>>;

/** Every row of the organization's archived tables and its files, keyed by table. */
export async function snapshot(t: T, org: Org) {
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
export const count = (tables: Awaited<ReturnType<typeof snapshot>>) =>
  Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows!.length]));

/**
 * Freeze, scan, seal, prove, remove and compact with the executor: the organization archived.
 * `coldStore` reads the cold tier's bucket, for a package with notes already cold (ADR 0010,
 * decision 6).
 */
export async function archive(
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
export const uploader =
  (t: T) =>
  async ({ path }: { path: string }) => {
    const bytes = await readFile(path);
    return t.run((ctx) => ctx.storage.store(new Blob([bytes], { type: "application/xml" })));
  };
export async function rehydrateWith(
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
export const run = (t: T, org: Org) => t.run((ctx) => archiveStatus(ctx, org.organizationId));
export const mapEntries = (t: T, runId: Id<"coldArchiveRuns">) =>
  t.run((ctx) =>
    ctx.db
      .query("coldArchiveIdMap")
      .withIndex("by_runId_and_previousId", (q) => q.eq("runId", runId))
      .collect(),
  );
export async function newIdOf(t: T, org: Org, previousId: string) {
  const entry = await t.run((ctx) => archivedIdEntry(ctx, org.organizationId, previousId));
  expect(entry, previousId).not.toBeNull();
  return entry!.newId;
}

export const COLD_BUCKET = "fnfe-cold-test";
