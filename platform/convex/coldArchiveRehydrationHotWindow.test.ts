import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { platformTest } from "../../tests/helpers/platform";
import { ARCHIVE_DAY, assertOrganizationHot } from "./lib/coldArchiveCore";
import { DOCUMENT_CONTENT_FORMAT, encodeDocumentContent } from "./lib/documentContent";
import { contentObjectKey, originalObjectKey } from "./lib/coldObjects";
import { readStoredContent } from "./lib/documentContentRead";
import { encodeOriginal, originalSourceOf, readOriginal } from "./lib/documentOriginalRead";
import { DOCUMENT_CONTENT_MIME } from "./lib/documentValues";
import {
  type T,
  type Source,
  adapter,
  memoryStore,
  openOrganization,
  type Org,
  snapshot,
  count,
  archive,
  rehydrateWith,
  run,
  newIdOf,
  COLD_BUCKET,
} from "../../tests/helpers/coldArchiveRehydration";

/**
 * Only the plan's hot window comes back hot; older notes come back cold (ADR 0010, decision 5,
 * phase C2).
 * Setup as in coldArchiveRehydration.test.ts: only `Date` is faked, and the executor's streams
 * run on real timers.
 */
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
});

const COLD_ENDPOINT = "https://cold.r2.test";
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
