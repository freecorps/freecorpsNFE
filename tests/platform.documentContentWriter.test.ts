import { describe, expect, it, vi } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import type { Doc, Id } from "../platform/convex/_generated/dataModel";
import {
  decodeDocumentContent,
  encodeDocumentContent,
  type DocumentContent,
} from "../platform/convex/lib/documentContent";
import { summary } from "../platform/convex/lib/documentCore";
import { DOCUMENT_CONTENT_MIME } from "../platform/convex/lib/documentValues";
import { importAll, nfeWithItems, writeContent } from "./helpers/document-footprint";
import { nfseXml } from "./helpers/nfse";
import { usePlatformEnvironment, type PlatformTest } from "./helpers/platform";

/**
 * The dual write of ADR 0010, B4: every published version also holds its content as one
 * `document-content/1` blob, while the inline fields stay. Synthetic notes only.
 */
usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-content-writer-secret",
});

type Version = Doc<"documentVersions">;

const versions = (t: PlatformTest) => t.run((ctx) => ctx.db.query("documentVersions").collect());

/** The content as the database holds it inline, independently of the writer. */
async function inline(t: PlatformTest, version: Version): Promise<DocumentContent> {
  return t.run(async (ctx) => {
    const items = await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
      .collect();
    const evidence = (await ctx.db.query("documentFiscalEvidence").collect()).find(
      (row) => row.versionId === version._id,
    );
    return {
      result: version.result!,
      ...(version.fiscalEvidence === undefined ? {} : { fiscalEvidence: version.fiscalEvidence }),
      items: items.map((item) => item.data),
      ...(evidence ? { snapshot: evidence.snapshot! } : {}),
    };
  });
}

async function blobOf(t: PlatformTest, storageId: Id<"_storage">) {
  const buffer = await t.run(async (ctx) => (await ctx.storage.get(storageId))?.arrayBuffer());
  return buffer ? new Uint8Array(buffer) : null;
}
const exists = (t: PlatformTest, storageId: Id<"_storage">) =>
  t.run(async (ctx) => !!(await ctx.db.system.get("_storage", storageId)));

/** Every published version decodes to exactly its inline content, with its card and capacity. */
async function expectDualWrite(t: PlatformTest) {
  const all = await versions(t);
  expect(all.length).toBeGreaterThan(0);
  for (const version of all) {
    expect(version.publishedAt).toBeDefined();
    expect(version.contentStorageId).toBeDefined();
    expect(version.contentFormat).toBe("document-content/1");
    const bytes = (await blobOf(t, version.contentStorageId!))!;
    const decoded = await decodeDocumentContent(bytes, {
      contentSha256: version.contentSha256!,
      contentSize: version.contentSize!,
      format: version.contentFormat!,
    });
    expect(decoded).toEqual(await inline(t, version));
    expect(decoded.items).toHaveLength(version.itemCount);
    const facts = await t.run(async (ctx) => ({
      doc: version.documentId ? await ctx.db.get("fiscalDocuments", version.documentId) : null,
      capacity: await ctx.db
        .query("capacityFiles")
        .filter((q) => q.eq(q.field("storageId"), version.contentStorageId!))
        .unique(),
    }));
    if (facts.doc) {
      const { kind, issuedAt, number, issuer, total, source } = summary(facts.doc, version);
      expect(version.card).toEqual({ kind, issuedAt, number, issuer, total, source });
    } else expect(version.card).toBeUndefined();
    // Files capacity counts the blob at its compressed, stored size.
    expect(facts.capacity).toMatchObject({ size: bytes.length, kind: "original" });
  }
  return all;
}

describe("dual write of the version content", () => {
  it("NF-e summary and full XML each hold a blob equal to the inline content", async () => {
    const { full, summary: resumo } = nfeWithItems(5);
    const { t } = await importAll([resumo, full], { contentBlobs: true });
    const all = await expectDualWrite(t);
    const invoice = all.find((version) => version.kind === "invoice")!;
    expect(invoice.card).toMatchObject({ kind: "invoice", total: "123.45" });
    expect(all.find((version) => version.kind === "summary")!.card).toMatchObject({
      kind: "summary",
      total: "123.45",
    });
    // The snapshot in the blob is the evidence row's, which names it by hash.
    const evidence = await t.run((ctx) => ctx.db.query("documentFiscalEvidence").collect());
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(row.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("NFS-e alone and in a batch: every entry and the batch itself hold a blob", async () => {
    const single = await importAll([Buffer.from(nfseXml([1]))], { contentBlobs: true });
    expect(await expectDualWrite(single.t)).toHaveLength(2);
    const batch = await importAll(
      [Buffer.from(nfseXml(Array.from({ length: 20 }, (_, i) => i + 1)))],
      { contentBlobs: true },
    );
    const all = await expectDualWrite(batch.t);
    expect(all.filter((version) => version.kind === "service-invoice")).toHaveLength(20);
    expect(all.find((version) => version.kind === "service-invoice")!.card).toMatchObject({
      kind: "service-invoice",
    });
  }, 60_000);
});

/** One imported NF-e version, detached from its blob as before the attach, with its content. */
async function unattached(t: PlatformTest, version: Version) {
  await t.run(async (ctx) => {
    await ctx.storage.delete(version.contentStorageId!);
    await ctx.db.patch("documentVersions", version._id, {
      contentStorageId: undefined,
      contentSha256: undefined,
      contentSize: undefined,
      contentFormat: undefined,
      card: undefined,
    });
  });
  return inline(t, version);
}
async function store(t: PlatformTest, content: DocumentContent) {
  const encoded = await encodeDocumentContent(content);
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([Uint8Array.from(encoded.bytes)], { type: DOCUMENT_CONTENT_MIME })),
  );
  return { encoded, storageId };
}
const attach = (
  t: PlatformTest,
  versionId: Id<"documentVersions">,
  { encoded, storageId }: Awaited<ReturnType<typeof store>>,
  attempt = 1,
) =>
  t.mutation(internal.importProcessing.attachContent, {
    versionId,
    storageId,
    contentSha256: encoded.contentSha256,
    contentSize: encoded.contentSize,
    storedSha256: encoded.storedSha256,
    storedSize: encoded.storedSize,
    attempt,
  });
const blobCount = (t: PlatformTest) =>
  t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

describe("retries, crashes and refusals", () => {
  const imported = async () => {
    const { t } = await importAll([nfeWithItems(2).full], { contentBlobs: true });
    const [version] = await versions(t);
    return { t, version: version! };
  };

  it("local proof reports BLOB_MISSING for a deleted blob and an inline-only version", async () => {
    const { t, version } = await imported();
    await t.run((ctx) => ctx.storage.delete(version.contentStorageId!));
    await expect(
      t.action(internal.testing.documentContentProof.verify, { versionId: version._id }),
    ).rejects.toThrow("BLOB_MISSING");
    await t.run((ctx) =>
      ctx.db.patch("documentVersions", version._id, { contentStorageId: undefined }),
    );
    await expect(
      t.action(internal.testing.documentContentProof.verify, { versionId: version._id }),
    ).rejects.toThrow("BLOB_MISSING");
  });

  it("a repeated store or a second blob for the same version leaves one blob", async () => {
    const { t, version } = await imported();
    const before = await blobCount(t);
    await t.action(internal.importProcessing.storeContent, { versionId: version._id, attempt: 1 });
    expect(await blobCount(t)).toBe(before);
    // Two actions that both stored before either attached: the second blob is deleted.
    const copy = await store(t, await inline(t, version));
    expect(await attach(t, version._id, copy)).toBe("duplicate");
    expect(await exists(t, copy.storageId)).toBe(false);
    const after = (await t.run((ctx) => ctx.db.get("documentVersions", version._id)))!;
    expect(after.contentStorageId).toBe(version.contentStorageId);
    expect(await exists(t, version.contentStorageId!)).toBe(true);
    // Repeating the attach that committed is a no-op.
    expect(
      await t.mutation(internal.importProcessing.attachContent, {
        versionId: version._id,
        storageId: version.contentStorageId!,
        contentSha256: version.contentSha256!,
        contentSize: version.contentSize!,
        storedSha256: "unused",
        storedSize: 0,
        attempt: 1,
      }),
    ).toBe("already");
    expect(await blobCount(t)).toBe(before);
  }, 60_000);

  it("content that changed after the encode is refused and encoded again", async () => {
    const { t, version } = await imported();
    const content = await unattached(t, version);
    const stale = await store(t, { ...content, result: `${content.result} ` });
    expect(await attach(t, version._id, stale)).toBe("changed");
    expect(await exists(t, stale.storageId)).toBe(false);
    expect(
      (await t.run((ctx) => ctx.db.get("documentVersions", version._id)))!.contentStorageId,
    ).toBeUndefined();
    // The refusal queued a second attempt in the content pool, which attaches the current content.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expectDualWrite(t);
  }, 60_000);

  it("after the third attempt a changed content is refused without a new encode", async () => {
    const { t, version } = await imported();
    const content = await unattached(t, version);
    const stale = await store(t, { ...content, result: `${content.result} ` });
    expect(await attach(t, version._id, stale, 3)).toBe("changed");
    expect(await exists(t, stale.storageId)).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await t.run((ctx) => ctx.db.get("documentVersions", version._id)))!.contentStorageId,
    ).toBeUndefined();
  }, 60_000);

  it("a version gone or a stored file that differs refuses the blob and deletes it", async () => {
    const { t, version } = await imported();
    const content = await unattached(t, version);
    const wrongHash = await store(t, content);
    expect(
      await attach(t, version._id, {
        ...wrongHash,
        encoded: { ...wrongHash.encoded, storedSha256: "0".repeat(64) },
      }),
    ).toBe("mismatch");
    expect(await exists(t, wrongHash.storageId)).toBe(false);
    const wrongSize = await store(t, content);
    expect(
      await attach(t, version._id, {
        ...wrongSize,
        encoded: { ...wrongSize.encoded, storedSize: wrongSize.encoded.storedSize + 1 },
      }),
    ).toBe("mismatch");
    expect(await exists(t, wrongSize.storageId)).toBe(false);
    // The version was removed between the store and the attach (a purge, for example).
    const late = await store(t, content);
    await t.run((ctx) => ctx.db.delete("documentVersions", version._id));
    expect(await attach(t, version._id, late)).toBe("gone");
    expect(await exists(t, late.storageId)).toBe(false);
  }, 60_000);

  it("an organization in archive custody takes no blob: nothing is written and the sweep keeps its turn", async () => {
    const { t, version } = await imported();
    const content = await unattached(t, version);
    const blob = await store(t, content);
    const organizationId = (await t.run((ctx) => ctx.db.get("operations", version.operationId)))!
      .organizationId;
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("coldArchiveRuns", {
        organizationId,
        key: "synthetic-archived",
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
    });
    expect(await attach(t, version._id, blob)).toBe("archived");
    // Left for the sweep, uncounted and unattached.
    expect(await exists(t, blob.storageId)).toBe(true);
    const after = await t.run(async (ctx) => ({
      version: (await ctx.db.get("documentVersions", version._id))!,
      capacity: await ctx.db
        .query("capacityFiles")
        .filter((q) => q.eq(q.field("storageId"), blob.storageId))
        .first(),
    }));
    expect(after.version.contentStorageId).toBeUndefined();
    expect(after.capacity).toBeNull();
  }, 60_000);

  it("a blob another version holds is refused and stays with its holder", async () => {
    const note = nfeWithItems(2);
    const { t } = await importAll([note.summary, note.full], { contentBlobs: true });
    const [holder, other] = await versions(t);
    await unattached(t, other!);
    const foreign = {
      storageId: holder!.contentStorageId!,
      encoded: {
        contentSha256: holder!.contentSha256!,
        contentSize: holder!.contentSize!,
        storedSha256: "unused",
        storedSize: 0,
      },
    } as Awaited<ReturnType<typeof store>>;
    expect(await attach(t, other!._id, foreign)).toBe("foreign");
    expect(await exists(t, holder!.contentStorageId!)).toBe(true);
    expect(
      (await t.run((ctx) => ctx.db.get("documentVersions", other!._id)))!.contentStorageId,
    ).toBeUndefined();
  }, 60_000);

  it("content over the cap or with an item gap stays inline, and the import stands", async () => {
    const { t, version } = await imported();
    await unattached(t, version);
    const big = "x".repeat(200_000);
    await t.run(async (ctx) => {
      for (let position = version.itemCount; position < version.itemCount + 45; position++)
        await ctx.db.insert("documentItems", { versionId: version._id, position, data: big });
      await ctx.db.patch("documentVersions", version._id, {
        itemCount: version.itemCount + 45,
        writtenItems: version.itemCount + 45,
      });
    });
    const before = await blobCount(t);
    await t.action(internal.importProcessing.storeContent, { versionId: version._id, attempt: 1 });
    expect(await blobCount(t)).toBe(before);
    const after = (await t.run((ctx) => ctx.db.get("documentVersions", version._id)))!;
    expect(after.contentStorageId).toBeUndefined();
    expect(after.result).toBe(version.result);
    expect((await t.run((ctx) => ctx.db.get("operations", version.operationId)))!.state).toBe(
      "succeeded",
    );
    // Under the cap in UTF-8 but over it once JSON escapes each quote: the codec refuses it.
    const quotes = '"'.repeat(150_000);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("documentItems")
        .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
        .collect();
      for (const row of rows.slice(version.itemCount))
        await ctx.db.delete("documentItems", row._id);
      for (let position = version.itemCount; position < version.itemCount + 30; position++)
        await ctx.db.insert("documentItems", { versionId: version._id, position, data: quotes });
      await ctx.db.patch("documentVersions", version._id, {
        itemCount: version.itemCount + 30,
        writtenItems: version.itemCount + 30,
      });
    });
    await t.action(internal.importProcessing.storeContent, { versionId: version._id, attempt: 1 });
    expect(await blobCount(t)).toBe(before);
    // A gap in the positions: the writer refuses to encode a list it cannot place.
    await t.run(async (ctx) => {
      const first = await ctx.db
        .query("documentItems")
        .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
        .first();
      await ctx.db.delete("documentItems", first!._id);
      await ctx.db.patch("documentVersions", version._id, { itemCount: 1, writtenItems: 1 });
    });
    await t.action(internal.importProcessing.storeContent, { versionId: version._id, attempt: 1 });
    expect(await blobCount(t)).toBe(before);
  }, 60_000);

  it("the cleanup each store asks for collects a blob stored without attach, unless a rehydration intent holds it", async () => {
    // A reprocessing days after the import publishes a new version with no import window open:
    // only the store asks the storage sweep to cover its blobs.
    const { t, call, imported } = await importAll([nfeWithItems(2).full], { contentBlobs: true });
    const [{ importId, fileId }] = imported as [{ importId: string; fileId: string }];
    vi.setSystemTime(Date.now() + 3 * 86_400_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { operationId } = await call(`/v1/imports/${importId}/files/${fileId}/reprocess`);
    await t.action(internal.operationWorker.run, { operationId, generation: 1 });
    // The publication runs now; the scheduled cleanup waits for the upload window.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await writeContent(t);
    const reprocessed = (await versions(t)).find((row) => row.operationId === operationId)!;
    expect(reprocessed.contentStorageId).toBeDefined();
    // A crash between store and attach, twice: one with a rehydration intent (paused).
    const content = await inline(t, reprocessed);
    const orphan = await store(t, content);
    const intended = await store(t, content);
    await t.run(async (ctx) => {
      // convex-test omits Blob.type from system metadata; native storage preserves it.
      for (const id of [orphan.storageId, intended.storageId, reprocessed.contentStorageId!])
        await ctx.db.patch(id as never, { contentType: DOCUMENT_CONTENT_MIME } as never);
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Organização sintética",
        slug: "reidratacao-pausada",
        ownerCount: 1,
        memberCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      const runId = await ctx.db.insert("coldArchiveRuns", {
        organizationId,
        key: "synthetic-paused-rehydration",
        version: 1,
        state: "restoring",
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
      await ctx.db.insert("coldArchiveUploads", {
        organizationId,
        runId,
        previousId: "conteudo-anterior",
        previousCreationTime: now,
        attempt: 1,
        sha256: "0".repeat(64),
        size: intended.encoded.storedSize,
        contentType: DOCUMENT_CONTENT_MIME,
        startedAt: now,
        storageId: intended.storageId,
      });
    });
    expect(await exists(t, orphan.storageId)).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await exists(t, orphan.storageId)).toBe(false);
    expect(await exists(t, intended.storageId)).toBe(true);
    expect(await exists(t, reprocessed.contentStorageId!)).toBe(true);
    // The reprocessing got its own blob, beside the first version's.
    await expectDualWrite(t);
  }, 60_000);
});
