import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Id } from "./_generated/dataModel";
import { platformTest } from "../../tests/helpers/platform";
import { ARCHIVE_DAY } from "./lib/coldArchiveCore";
import { restoreIsolated } from "../../scripts/lib/cold-archive.mjs";
import { extractZip } from "../../scripts/lib/offsite-backup-zip.mjs";
import {
  scratch,
  type T,
  type Source,
  adapter,
  memoryStore,
  copy,
  openOrganization,
  snapshot,
  archive,
  rehydrateWith,
  run,
  mapEntries,
  newIdOf,
} from "../../tests/helpers/coldArchiveRehydration";

/**
 * Isolated restore of an archived open organization (ADR 0009, §7): read-only, in `archived`,
 * in `restoring` and in a second cycle.
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
