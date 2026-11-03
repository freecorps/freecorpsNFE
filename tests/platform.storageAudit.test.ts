import { expect, it } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import { importTask } from "../platform/convex/lib/importValues";
import { issuerScope, platformTest, usePlatformEnvironment } from "./helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-storage-audit",
});

/** Files of `bytes` bytes: one held by a reference version, one only by the quota, one by nothing. */
async function storageFixture() {
  const t = platformTest();
  await t.run(async (ctx) => {
    const store = (bytes: number) => ctx.storage.store(new Blob([new Uint8Array(bytes)]));
    const now = Date.now();
    await ctx.db.insert("referenceVersions", {
      storageId: await store(10),
      dataset: "ncm",
      version: "sintetica",
      manifest: "{}",
      count: 0,
      imported: 0,
      lastCode: "",
      state: "candidate",
      publishedAt: null,
      createdAt: now,
    });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Organização sintética",
      slug: "auditoria-de-arquivos",
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const quota = await store(20);
    await ctx.db.insert("capacityFiles", { organizationId, storageId: quota, size: 20 });
    await store(30);
  });
  return t;
}

it("counts the file no holder references as the only orphan, with its bytes", async () => {
  const t = await storageFixture();
  expect(await t.action(internal.backupInventory.storageAudit, {})).toEqual({
    blobs: 3,
    bytes: 60,
    held: 2,
    accountingOnly: 1,
    accountingOnlyBytes: 20,
    orphans: 1,
    orphanBytes: 30,
    pages: 1,
  });
});

it("sums the same totals one file per page", async () => {
  const t = await storageFixture();
  const { pages, ...totals } = await t.action(internal.backupInventory.storageAudit, {
    pageSize: 1,
  });
  expect(pages).toBeGreaterThanOrEqual(3);
  expect(totals).toEqual({
    blobs: 3,
    bytes: 60,
    held: 2,
    accountingOnly: 1,
    accountingOnlyBytes: 20,
    orphans: 1,
    orphanBytes: 30,
  });
  const first = await t.query(internal.backupInventory.storageAuditPage, {
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(first).toMatchObject({ blobs: 1, isDone: false });
});

it("counts a file held only by a rehydration upload intent as held", async () => {
  const t = platformTest();
  await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Organização sintética",
      slug: "auditoria-de-reidratacao",
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: "synthetic-storage-audit",
      version: 1,
      state: "frozen",
      reason: "paid_expired",
      noticeAt: now,
      eligibleAt: now,
      retainUntil: now,
      createdAt: now,
      updatedAt: now,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    });
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(40)]));
    await ctx.db.insert("coldArchiveUploads", {
      organizationId,
      runId,
      previousId: "arquivo-anterior",
      previousCreationTime: now,
      attempt: 1,
      sha256: "0".repeat(64),
      size: 40,
      startedAt: now,
      storageId,
    });
  });
  expect(await t.action(internal.backupInventory.storageAudit, {})).toMatchObject({
    blobs: 1,
    held: 1,
    accountingOnly: 0,
    orphans: 0,
  });
});

it("counts the content blob of a document version as held (ADR 0010, phase B)", async () => {
  const t = platformTest();
  const { organizationId, projectId, companyId } = await issuerScope(t, {
    keyHash: crypto.randomUUID(),
    kind: "demonstration",
    grantScopes: [],
    keyScopes: [],
  });
  const { versionId, contentStorageId } = await t.run(async (ctx) => {
    const scope = { organizationId, projectId, companyId, environment: "sandbox" as const };
    const artifactId = await ctx.db.insert("documentArtifacts", {
      ...scope,
      storageId: await ctx.storage.store(new Blob(["<NFe/>"])),
      size: 6,
      sha256: "synthetic",
      source: "imported-xml",
      importedAt: 0,
    });
    const operationId = await ctx.db.insert("operations", {
      ...scope,
      task: importTask,
      request: "{}",
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "succeeded",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 3,
      leaseUntil: 0,
      nextAttemptAt: 0,
      backoffMs: 1,
      jitterMs: 1,
      uncertain: false,
      createdAt: 0,
      updatedAt: 0,
    });
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
      result: "{}",
      itemCount: 0,
      writtenItems: 0,
      createdAt: 0,
    });
    const contentStorageId = await ctx.storage.store(new Blob([new Uint8Array(50)]));
    return { versionId, contentStorageId };
  });
  // Before the version names it, the blob is an orphan; once it does, it is held.
  const audit = () => t.action(internal.backupInventory.storageAudit, {});
  const before = await audit();
  expect(before).toMatchObject({ orphans: 1, orphanBytes: 50 });
  await t.run((ctx) => ctx.db.patch("documentVersions", versionId, { contentStorageId }));
  expect(await audit()).toMatchObject({ held: before.held + 1, orphans: 0, orphanBytes: 0 });
});

it("refuses an end cursor, which would stretch the page past its size", async () => {
  const t = await storageFixture();
  const { continueCursor } = await t.query(internal.backupInventory.storageAuditPage, {
    paginationOpts: { numItems: 1, cursor: null },
  });
  await expect(
    t.query(internal.backupInventory.storageAuditPage, {
      paginationOpts: { numItems: 1, cursor: null, endCursor: continueCursor },
    }),
  ).rejects.toThrow("STORAGE_AUDIT_PAGE_LIMIT");
});

it.each([0, 1.5, 129])("refuses a page of %s files before reading", async (size) => {
  const t = platformTest();
  await expect(
    t.query(internal.backupInventory.storageAuditPage, {
      paginationOpts: { numItems: size, cursor: null },
    }),
  ).rejects.toThrow("STORAGE_AUDIT_PAGE_LIMIT");
  await expect(t.action(internal.backupInventory.storageAudit, { pageSize: size })).rejects.toThrow(
    "STORAGE_AUDIT_PAGE_LIMIT",
  );
});
