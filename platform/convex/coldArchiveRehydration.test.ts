import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { platformTest } from "../../tests/helpers/platform";
import { ARCHIVE_TABLES, assertOrganizationHot } from "./lib/coldArchiveCore";
import { archivedIdEntry } from "./lib/coldArchiveIdMap";
import { firstCreation, firstId } from "./lib/coldArchiveOrigin";
import {
  HOT_CUSTODY_UNREAD,
  HOT_REFERENCE_SOURCES,
  MAP_SIDE_REFERENCES,
  REWRITTEN_PATHS,
  rehydratedTable,
} from "./lib/coldArchiveRehydration";
import { attemptUsageKey } from "./lib/captureValues";
import { decodeDocumentContent } from "./lib/documentContent";
import { retentionClass } from "./lib/retentionClasses";
import {
  type Source,
  adapter,
  memoryStore,
  XML_A,
  RAW_B,
  openOrganization,
  snapshot,
  count,
  archive,
  rehydrateWith,
  run,
  mapEntries,
  newIdOf,
} from "../../tests/helpers/coldArchiveRehydration";

/**
 * Rehydration of an archived open organization under new IDs (ADR 0009, §5 and §6), end to end:
 * the administrative executor of `scripts/lib/cold-archive.mjs` against the real Convex functions
 * in convex-test, with R2 in memory and age replaced by a copy (encryption has its own tests in
 * `scripts/cold-tier/cold-archive.test.ts`). Only `Date` is faked, so the clock can jump past the orphan
 * grace while the executor's streams run on real timers.
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
