import { expect, it } from "vite-plus/test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import schema from "../platform/convex/schema";
import { platformTest, usePlatformEnvironment, issuerScope } from "./helpers/platform";
import {
  ARCHIVE_FENCE_TABLES,
  ARCHIVE_STORAGE_FIELDS,
  ARCHIVE_TABLES,
  archiveHash,
  archiveRowJson,
  archiveStorageIds,
  isArchiveFence,
} from "../platform/convex/lib/coldArchiveCore";
import {
  ARCHIVE_ID_REFERENCES,
  ARCHIVE_TEXT_REFERENCES,
  ARCHIVE_TEXT_UNRELATED,
  archiveReferenceCoverage,
  archiveReferences,
  archiveTextCandidates,
} from "../platform/convex/lib/coldArchiveReferences";
import {
  archivedIdEntry,
  firstCreation,
  firstId,
  originFor,
  recordArchiveId,
} from "../platform/convex/lib/coldArchiveIdMap";
import { storageHolders } from "../platform/convex/lib/storageHolders";
import type { Id } from "../platform/convex/_generated/dataModel";

usePlatformEnvironment({
  siteUrl: "http://localhost:5197",
  convexSiteUrl: "http://127.0.0.1:3252",
  secret: "synthetic-cold-references",
  now: Date.UTC(2026, 9, 29, 12),
});
const scopeOptions = () => ({
  keyHash: crypto.randomUUID(),
  kind: "demonstration" as const,
  grantScopes: [],
  keyScopes: [],
});

const clean = {
  unclassified: [],
  stale: [],
  fenceRewritten: [],
  textUnclassified: [],
  textStale: [],
};

it("classifies every schema reference to an archived table or a stored file", () => {
  expect(archiveReferenceCoverage(schema)).toEqual(clean);
  // References to the fence keep their IDs; storage of the capacity inventory is recreated.
  for (const { table, path, target } of archiveReferences(schema))
    if (isArchiveFence(target))
      expect(ARCHIVE_ID_REFERENCES[`${table}.${path}` as keyof typeof ARCHIVE_ID_REFERENCES]).toBe(
        "kept",
      );
  expect(ARCHIVE_ID_REFERENCES["capacityFiles.storageId"]).toBe("recreated");
  // Every storage field of an archived table is rewritten, and listed in ARCHIVE_STORAGE_FIELDS.
  for (const [table, fields] of Object.entries(ARCHIVE_STORAGE_FIELDS))
    for (const field of fields!)
      expect(ARCHIVE_ID_REFERENCES[`${table}.${field}` as keyof typeof ARCHIVE_ID_REFERENCES]).toBe(
        "rewritten",
      );
});

it("walks nested objects, arrays, records, unions and optionals of a synthetic schema", () => {
  const synthetic = defineSchema({
    sample: defineTable({
      direct: v.id("operations"),
      optional: v.optional(v.id("documentVersions")),
      nested: v.object({ inner: v.array(v.id("fiscalDocuments")) }),
      either: v.union(v.id("documentArtifacts"), v.id("issuanceArtifacts"), v.null()),
      byKey: v.record(v.id("imports"), v.id("_storage")),
      fence: v.id("captureStreams"),
      unrelated: v.id("companies"),
      text: v.string(),
    }),
    branches: defineTable(
      v.union(
        v.object({ kind: v.literal("a"), ref: v.id("operations") }),
        v.object({ kind: v.literal("b"), ref: v.optional(v.id("operations")) }),
      ),
    ),
  });
  expect(archiveReferences(synthetic)).toEqual([
    { table: "branches", path: "ref", target: "operations" },
    { table: "sample", path: "byKey{key}", target: "imports" },
    { table: "sample", path: "byKey{}", target: "_storage" },
    { table: "sample", path: "direct", target: "operations" },
    { table: "sample", path: "either", target: "documentArtifacts" },
    { table: "sample", path: "either", target: "issuanceArtifacts" },
    { table: "sample", path: "fence", target: "captureStreams" },
    { table: "sample", path: "nested.inner[]", target: "fiscalDocuments" },
    { table: "sample", path: "optional", target: "documentVersions" },
  ]);
  const ids = {
    "branches.ref": "rewritten",
    "sample.byKey{key}": "rewritten",
    "sample.byKey{}": "rewritten",
    "sample.direct": "rewritten",
    "sample.either": "rewritten",
    "sample.fence": "kept",
    "sample.nested.inner[]": "rewritten",
    "sample.optional": "rewritten",
  } as const;
  expect(archiveReferenceCoverage(synthetic, ids, {}, [])).toEqual(clean);
  // A new v.id field without classification fails, as a table without retention class does.
  const grown = defineSchema({
    ...synthetic.tables,
    added: defineTable({ organizationId: v.id("organizations"), batchId: v.id("captureBatches") }),
  });
  expect(archiveReferenceCoverage(grown, ids, {}, []).unclassified).toEqual(["added.batchId"]);
  // A classification of a field the schema no longer has, or a rewritten fence, fails too.
  expect(
    archiveReferenceCoverage(synthetic, { ...ids, "sample.gone": "rewritten" }, {}, []).stale,
  ).toEqual(["sample.gone"]);
  expect(
    archiveReferenceCoverage(synthetic, { ...ids, "sample.fence": "rewritten" }, {}, [])
      .fenceRewritten,
  ).toEqual(["sample.fence"]);
});

it("requires a decision for every text field that may hold an archived ID", () => {
  // ADR 0009, §5, item 5: the explicit rules for references stored as text.
  expect(ARCHIVE_TEXT_REFERENCES).toMatchObject({
    "capacityRecords.key": "recreated",
    "outboxEvents.resourceId": "kept",
    "outboxEvents.logicalKey": "kept",
    "outboxEvents.body": "kept",
    "capacityEvents.key": "kept",
    "idempotencyRecords.key": "firstId",
    "operations.request": "kept",
    "operations.response": "kept",
  });
  // No field is in both lists, and every candidate the guard finds is decided.
  const both = Object.keys(ARCHIVE_TEXT_REFERENCES).filter((field) =>
    (ARCHIVE_TEXT_UNRELATED as readonly string[]).includes(field),
  );
  expect(both).toEqual([]);
  const candidates = archiveTextCandidates(schema);
  expect(candidates).toEqual(expect.arrayContaining(Object.keys(ARCHIVE_TEXT_REFERENCES)));
  // A new string named like an ID, in a table of an organization, needs a decision.
  const grown = defineSchema({
    ...schema.tables,
    synthetic: defineTable({
      organizationId: v.id("organizations"),
      documentKey: v.string(),
      label: v.string(),
    }),
  });
  expect(archiveReferenceCoverage(grown).textUnclassified).toEqual(["synthetic.documentKey"]);
  expect(
    archiveReferenceCoverage(schema, ARCHIVE_ID_REFERENCES, {
      ...ARCHIVE_TEXT_REFERENCES,
      "operations.gone": "kept",
    }).textStale,
  ).toEqual(["operations.gone"]);
});

it("reads every stored-file field of a table and holds every one of them", () => {
  const row = { storageId: "s1", rawId: "s2", other: "x" };
  expect(archiveStorageIds("documentArtifacts", row)).toEqual(["s1"]);
  expect(archiveStorageIds("captureBatches", row)).toEqual(["s2"]);
  expect(archiveStorageIds("fiscalDocuments", row)).toEqual([]);
  // ADR 0010, phase B: a table with more than one file field yields each file once.
  const fields = ARCHIVE_STORAGE_FIELDS as Record<string, readonly string[]>;
  const previous = fields.documentArtifacts;
  fields.documentArtifacts = ["storageId", "rawId", "storageId"];
  try {
    expect(archiveStorageIds("documentArtifacts", row)).toEqual(["s1", "s2"]);
    expect(archiveStorageIds("documentArtifacts", { storageId: "s1", rawId: "s1" })).toEqual([
      "s1",
    ]);
  } finally {
    fields.documentArtifacts = previous!;
  }
  // `exclusiveFile` reads the holders of a file before deleting it: every archived file table.
  const fake = {
    db: {
      query: (table: string) => ({ withIndex: () => ({ table }) }),
    },
  } as unknown as Parameters<typeof storageHolders>[0];
  const holders = storageHolders(fake, "s1" as Id<"_storage">).map(({ table }) => table);
  expect(holders).toEqual(expect.arrayContaining(Object.keys(ARCHIVE_STORAGE_FIELDS)));
});

it("puts the origin pair on every archived table but the fence and leaves existing hashes alone", async () => {
  for (const table of ARCHIVE_TABLES) {
    const validator = schema.tables[table].validator;
    if (validator.kind !== "object") throw new Error(`${table} is not an object table`);
    const fields = validator.fields as Record<string, { kind: string; isOptional: string }>;
    if ((ARCHIVE_FENCE_TABLES as readonly string[]).includes(table)) {
      expect(fields.originId, table).toBeUndefined();
      continue;
    }
    expect([fields.originId?.kind, fields.originId?.isOptional], table).toEqual([
      "string",
      "optional",
    ]);
    expect([fields.originCreationTime?.kind, fields.originCreationTime?.isOptional]).toEqual([
      "float64",
      "optional",
    ]);
  }
  const t = platformTest();
  const scope = await issuerScope(t, scopeOptions());
  const row = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["<NFe/>"]));
    const id = await ctx.db.insert("documentArtifacts", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      environment: "sandbox",
      storageId,
      sha256: "synthetic",
      size: 6,
      source: "imported-xml",
      importedAt: Date.now(),
    });
    return (await ctx.db.get("documentArtifacts", id))!;
  });
  // A row never rehydrated has no origin field: its JSON and hash are those of before PR 5.
  const json = archiveRowJson(row);
  expect(json).not.toContain("origin");
  const { originId, originCreationTime, ...before } = row;
  expect([originId, originCreationTime]).toEqual([undefined, undefined]);
  expect(await archiveHash(archiveRowJson(before))).toBe(await archiveHash(json));
  // It is its own origin; the first cycle writes its pair, and a later cycle keeps it.
  expect(firstId(row)).toBe(row._id);
  expect(firstCreation(row)).toBe(row._creationTime);
  const first = originFor(row);
  expect(first).toEqual({ originId: row._id, originCreationTime: row._creationTime });
  const rehydrated = {
    ...row,
    _id: "synthetic_new",
    _creationTime: row._creationTime + 1,
    ...first,
  };
  expect(originFor(rehydrated)).toEqual(first);
  expect(firstCreation(rehydrated)).toBe(row._creationTime);
});

async function mapFixture() {
  const t = platformTest();
  const one = await issuerScope(t, scopeOptions());
  const two = await issuerScope(t, scopeOptions());
  const run = (organizationId: Id<"organizations">, state: "restoring" | "archived") =>
    t.run((ctx) =>
      ctx.db.insert("coldArchiveRuns", {
        organizationId,
        key: `synthetic-${crypto.randomUUID()}`,
        reason: "free_inactive",
        state,
        version: 1,
        noticeAt: Date.now(),
        eligibleAt: Date.now(),
        retainUntil: Date.now() + 365 * 86_400_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        phase: 0,
        cursor: null,
        rows: 0,
        files: 0,
        bytes: 0,
        digest: "",
      }),
    );
  const artifact = (scope: typeof one) =>
    t.run(async (ctx) =>
      ctx.db.insert("documentArtifacts", {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        projectId: scope.projectId,
        environment: "sandbox",
        storageId: await ctx.storage.store(new Blob(["<NFe/>"])),
        sha256: "synthetic",
        size: 6,
        source: "imported-xml",
        importedAt: Date.now(),
        originId: "synthetic_previous_artifact",
        originCreationTime: Date.UTC(2025, 0, 1),
      }),
    );
  return { t, one, two, run, artifact };
}
const stock = (t: ReturnType<typeof platformTest>, organizationId: Id<"organizations">) =>
  t.run(async (ctx) => {
    const total = await ctx.db
      .query("capacityTotals")
      .withIndex("by_organizationId_and_period_and_metric", (q) =>
        q.eq("organizationId", organizationId).eq("period", "stock").eq("metric", "databaseBytes"),
      )
      .unique();
    const records = await ctx.db
      .query("capacityRecords")
      .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
      .collect();
    return {
      committed: total?.committed ?? 0,
      keys: records.map((r) => r.key.split(":")[0]),
      size: records.reduce((sum, r) => sum + r.size, 0),
    };
  });

it("records an ID map entry with the new row, once, as stock of its organization only", async () => {
  const { t, one, two, run, artifact } = await mapFixture();
  const runId = await run(one.organizationId, "restoring");
  const entry = {
    organizationId: one.organizationId,
    runId,
    table: "documentArtifacts",
    previousId: "synthetic_previous_artifact",
    previousCreationTime: Date.UTC(2025, 0, 1),
  };
  // Inserted together with the row, in one transaction.
  const { id, newId } = await t.run(async (ctx) => {
    const created = await ctx.db.insert("documentArtifacts", {
      organizationId: one.organizationId,
      companyId: one.companyId,
      projectId: one.projectId,
      environment: "sandbox",
      storageId: await ctx.storage.store(new Blob(["<NFe/>"])),
      sha256: "synthetic",
      size: 6,
      source: "imported-xml",
      importedAt: Date.now(),
      ...originFor({ _id: entry.previousId, _creationTime: entry.previousCreationTime }),
    });
    return { id: await recordArchiveId(ctx, { ...entry, newId: created }), newId: created };
  });
  // A repeated batch finds the entry; nothing new is written or counted.
  const counted = await stock(t, one.organizationId);
  expect(counted.keys).toEqual(["coldArchiveIdMap"]);
  expect(counted.committed).toBe(counted.size);
  expect(counted.size).toBeGreaterThan(0);
  expect(await t.run((ctx) => recordArchiveId(ctx, { ...entry, newId }))).toBe(id);
  expect(await stock(t, one.organizationId)).toEqual(counted);
  expect(await t.run((ctx) => ctx.db.query("coldArchiveIdMap").collect())).toHaveLength(1);
  // The same previous ID to another row, or another previous ID to the same row, conflicts.
  const other = await artifact(one);
  await expect(t.run((ctx) => recordArchiveId(ctx, { ...entry, newId: other }))).rejects.toThrow(
    "ARCHIVE_MAP_CONFLICT",
  );
  await expect(
    t.run((ctx) => recordArchiveId(ctx, { ...entry, previousId: "synthetic_other", newId })),
  ).rejects.toThrow("ARCHIVE_MAP_CONFLICT");
  // The lookup only resolves inside the organization that had the ID.
  expect(
    await t.run((ctx) => archivedIdEntry(ctx, one.organizationId, entry.previousId)),
  ).toMatchObject({ newId, table: "documentArtifacts", runId });
  expect(await t.run((ctx) => archivedIdEntry(ctx, two.organizationId, entry.previousId))).toBe(
    null,
  );
  // A run of another organization, a run not restoring, the fence or a missing row: refused.
  const foreign = await run(two.organizationId, "restoring");
  await expect(
    t.run((ctx) => recordArchiveId(ctx, { ...entry, runId: foreign, newId: other })),
  ).rejects.toThrow("ARCHIVE_MAP_RUN_MISMATCH");
  const archived = await run(one.organizationId, "archived");
  await expect(
    t.run((ctx) => recordArchiveId(ctx, { ...entry, runId: archived, newId: other })),
  ).rejects.toThrow("ARCHIVE_MAP_NOT_RESTORING");
  await expect(
    t.run((ctx) =>
      recordArchiveId(ctx, {
        ...entry,
        table: "captureStreams",
        previousId: "synthetic_stream",
        newId: other,
      }),
    ),
  ).rejects.toThrow("ARCHIVE_MAP_INVALID");
  await expect(
    t.run(async (ctx) => {
      await ctx.db.delete("documentArtifacts", other);
      return recordArchiveId(ctx, { ...entry, previousId: "synthetic_gone", newId: other });
    }),
  ).rejects.toThrow("ARCHIVE_MAP_MISSING");
  expect((await stock(t, two.organizationId)).keys).toEqual([]);
});

it("maps a stored file by its storage ID", async () => {
  const { t, one, run } = await mapFixture();
  const runId = await run(one.organizationId, "restoring");
  const id = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["<NFe/>"]));
    return recordArchiveId(ctx, {
      organizationId: one.organizationId,
      runId,
      table: "_storage",
      previousId: "synthetic_previous_storage",
      previousCreationTime: Date.UTC(2025, 0, 1),
      newId: storageId,
    });
  });
  expect(await t.run((ctx) => ctx.db.get("coldArchiveIdMap", id))).toMatchObject({
    table: "_storage",
  });
});
