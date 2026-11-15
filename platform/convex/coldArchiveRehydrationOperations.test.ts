import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { platformTest } from "../../tests/helpers/platform";
import { ARCHIVE_DAY, assertOrganizationHot } from "./lib/coldArchiveCore";
import {
  MAP_SIDE_LIMIT,
  ORPHAN_SCAN_PAGE,
  ORPHAN_SCAN_TIES,
  orphanScanStep,
} from "./lib/coldArchiveRehydration";
import { collectOrphans } from "../../scripts/lib/cold-archive.mjs";
import {
  type Source,
  adapter,
  XML_A,
  openOrganization,
  archive,
  uploader,
  rehydrateWith,
  run,
  newIdOf,
} from "../../tests/helpers/coldArchiveRehydration";

/**
 * Rehydration's bookkeeping: receipts and registry calls, orphan collection and the orphan
 * scan's window, the canonical check and plan admission.
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
