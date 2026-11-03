import { expect, it } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import { importAll, nfeWithItems, writeContent } from "./helpers/document-footprint";
import { usePlatformEnvironment } from "./helpers/platform";
import { nfseXml } from "./helpers/nfse";
import { fixture as xmlFixture } from "./helpers/nfe-corpus";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-content-migration",
});

type Test = Awaited<ReturnType<typeof importAll>>["t"];
const run = (t: Test, kind: "backfill" | "audit" | "cleanup") =>
  t.run(async (ctx) =>
    ctx.db
      .query("contentMigrations")
      .withIndex("by_kind", (q) => q.eq("kind", kind))
      .unique(),
  );
/** Drives a run step by step, as the scheduler would, until it leaves `running`. */
async function drive(t: Test, kind: "backfill" | "audit") {
  for (let n = 0; n < 500; n++) {
    const current = (await run(t, kind))!;
    if (current.state !== "running") return current;
    const step = { cursor: current.cursor, generation: current.generation };
    if (kind === "backfill") await t.mutation(internal.contentMigration.backfillStep, step);
    else await t.action(internal.contentMigrationNode.auditStep, step);
  }
  throw new Error("run did not finish");
}
/** Published versions as B4 left them before the release: some without a blob. */
async function withoutBlobs(t: Test, count: number) {
  return t.run(async (ctx) => {
    const versions = (await ctx.db.query("documentVersions").collect()).filter(
      (version) => version.contentStorageId,
    );
    for (const version of versions.slice(0, count)) {
      await ctx.storage.delete(version.contentStorageId!);
      await ctx.db.patch("documentVersions", version._id, {
        contentStorageId: undefined,
        contentSha256: undefined,
        contentSize: undefined,
        contentFormat: undefined,
        card: undefined,
      });
    }
    return versions.length;
  });
}

it("backfills the versions without a blob, then audits every blob against its inline content", async () => {
  const { t } = await importAll([nfeWithItems(3).full, Buffer.from(nfseXml([1, 2]))], {
    contentBlobs: true,
  });
  const total = await withoutBlobs(t, 2);
  expect(total).toBeGreaterThan(2);

  await t.mutation(internal.contentMigration.start, { kind: "backfill" });
  const backfill = await drive(t, "backfill");
  expect(backfill.state).toBe("done");
  expect(backfill.counts.scheduled).toBe(2);
  // The scheduled writers, run here directly (see `writeContent`).
  await writeContent(t);
  const versions = await t.run((ctx) => ctx.db.query("documentVersions").collect());
  const published = versions.filter((version) => version.publishedAt !== undefined);
  expect(published.every((version) => version.contentStorageId)).toBe(true);
  // A batch version has no document, so no card; every document version has one.
  expect(published.filter((v) => v.documentId).every((v) => v.card)).toBe(true);

  // A finished run does not start again without `restart`.
  expect(await t.mutation(internal.contentMigration.start, { kind: "backfill" })).toMatchObject({
    state: "done",
  });

  await t.mutation(internal.contentMigration.start, { kind: "audit" });
  const audit = await drive(t, "audit");
  expect(audit.state).toBe("done");
  expect(audit.counts.verified).toBe(published.length);
  for (const name of ["mismatch", "missing", "corrupt", "unverified"])
    expect(audit.counts[name] ?? 0).toBe(0);
  const after = await t.run((ctx) => ctx.db.query("documentVersions").collect());
  expect(after.filter((v) => v.publishedAt !== undefined).every((v) => v.contentVerifiedAt)).toBe(
    true,
  );
});

it("counts a blob gone, damaged or different from the inline content, and never verifies it", async () => {
  const { t } = await importAll(
    [nfeWithItems(2).full, nfeWithItems(4).full, nfeWithItems(5).full],
    { contentBlobs: true },
  );
  const [gone, damaged, different] = await t.run(async (ctx) => {
    const versions = (await ctx.db.query("documentVersions").collect()).filter(
      (version) => version.contentStorageId,
    );
    await ctx.storage.delete(versions[0]!.contentStorageId!);
    await ctx.db.patch("documentVersions", versions[1]!._id, { contentSha256: "0".repeat(64) });
    await ctx.db.patch("documentVersions", versions[2]!._id, {
      result: versions[2]!.result!.replace("}", ',"adulterado":true}'),
    });
    return versions;
  });
  await t.mutation(internal.contentMigration.start, { kind: "audit" });
  const audit = await drive(t, "audit");
  expect(audit.counts).toMatchObject({ missing: 1, corrupt: 1, mismatch: 1 });
  const after = await t.run((ctx) => ctx.db.query("documentVersions").collect());
  for (const version of [gone, damaged, different])
    expect(after.find((row) => row._id === version!._id)!.contentVerifiedAt).toBeUndefined();
  // B8 refuses to start over this audit.
  await expect(t.mutation(internal.contentMigration.start, { kind: "cleanup" })).rejects.toThrow(
    "CONTENT_AUDIT_REQUIRED",
  );
});

it("resumes a failed run from its cursor and ignores any step of an earlier generation", async () => {
  const { t } = await importAll([nfeWithItems(1).full, nfeWithItems(2).full], {
    contentBlobs: true,
  });
  await t.mutation(internal.contentMigration.start, { kind: "audit" });
  const first = (await run(t, "audit"))!;
  await t.mutation(internal.contentMigration.fail, {
    kind: "audit",
    generation: first.generation,
    from: null,
    error: "simulated",
  });
  expect((await run(t, "audit"))!).toMatchObject({ state: "failed", error: "simulated" });
  // A step of the stopped run changes nothing.
  await t.action(internal.contentMigrationNode.auditStep, {
    cursor: null,
    generation: first.generation,
  });
  expect((await run(t, "audit"))!.counts).toEqual({});
  await t.mutation(internal.contentMigration.start, { kind: "audit" });
  const resumed = (await run(t, "audit"))!;
  expect(resumed).toMatchObject({ state: "running", cursor: null });
  expect(resumed.generation).toBe(first.generation + 1);
  // The step scheduled before the resume, at the same cursor, belongs to another generation.
  await t.action(internal.contentMigrationNode.auditStep, {
    cursor: null,
    generation: first.generation,
  });
  expect((await run(t, "audit"))!.counts).toEqual({});
  const done = await drive(t, "audit");
  expect(done.state).toBe("done");
  await t.action(internal.contentMigrationNode.auditStep, {
    cursor: null,
    generation: done.generation,
  });
  expect((await run(t, "audit"))!.counts).toEqual(done.counts);
  expect(
    (await t.mutation(internal.contentMigration.start, { kind: "audit", restart: true })).cursor,
  ).toBeNull();
});

it("counts a partial blob reference as corrupt in the backfill and in the audit", async () => {
  const { t } = await importAll([nfeWithItems(1).full], { contentBlobs: true });
  await t.run(async (ctx) => {
    const version = (await ctx.db.query("documentVersions").collect()).find(
      (row) => row.contentStorageId,
    )!;
    await ctx.db.patch("documentVersions", version._id, { contentSha256: undefined });
  });
  await t.mutation(internal.contentMigration.start, { kind: "backfill" });
  expect((await drive(t, "backfill")).counts.corrupt).toBe(1);
  await t.mutation(internal.contentMigration.start, { kind: "audit" });
  expect((await drive(t, "audit")).counts.corrupt).toBe(1);
  await expect(t.mutation(internal.contentMigration.start, { kind: "cleanup" })).rejects.toThrow(
    "CONTENT_AUDIT_REQUIRED",
  );
});

it("rewrites an event card written before B5, which lacks the cancellation flag", async () => {
  const { t } = await importAll(
    [Buffer.from(xmlFixture("invoice-authorized")), Buffer.from(xmlFixture("event-110111"))],
    { contentBlobs: true },
  );
  const event = await t.run(async (ctx) => {
    const event = (await ctx.db.query("documentVersions").collect()).find(
      (version) => version.kind === "event",
    )!;
    const { cancellation: _flag, ...card } = event.card!;
    await ctx.db.patch("documentVersions", event._id, { card });
    return event;
  });
  await t.mutation(internal.contentMigration.start, { kind: "backfill" });
  expect((await drive(t, "backfill")).counts.cardRefreshed).toBe(1);
  const after = await t.run((ctx) => ctx.db.get("documentVersions", event._id));
  expect(after!.card).toEqual(event.card);
});
