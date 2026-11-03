import { getDocumentSize } from "convex/values";
import { describe, expect, it } from "vite-plus/test";
import { internal } from "../platform/convex/_generated/api";
import type { Doc } from "../platform/convex/_generated/dataModel";
import { stagedVersionChanged } from "../platform/convex/lib/documentContentCleanup";
import { importAll, nfeWithItems } from "./helpers/document-footprint";
import { usePlatformEnvironment } from "./helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-content-cleanup",
});

const secret = `fnfe_${"b".repeat(43)}`;
type Test = Awaited<ReturnType<typeof importAll>>["t"];

async function readable(t: Test) {
  return t.run(async (ctx) => {
    const scopes = ["documents:import", "documents:read"] as const;
    for (const key of await ctx.db.query("apiKeys").collect())
      await ctx.db.patch("apiKeys", key._id, { scopes: [...scopes] });
    for (const grant of await ctx.db.query("projectCompanies").collect())
      await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    return (await ctx.db.query("companies").first())!._id;
  });
}
const rest =
  (t: Test, company: string) =>
  async (path: string, query: Record<string, string> = {}) => {
    const search = new URLSearchParams({ companyId: company, ...query });
    const response = await t.fetch(`${path}?${search}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
    return { status: response.status, body: await response.json() };
  };
/** Bytes the fiscal tables hold, as the capacity counts them (`getDocumentSize`). */
const fiscalBytes = (t: Test) =>
  t.run(async (ctx) => {
    let total = 0;
    for (const table of ["documentVersions", "documentItems", "documentFiscalEvidence"] as const)
      for (const row of await ctx.db.query(table).collect())
        total += getDocumentSize(row as unknown as Parameters<typeof getDocumentSize>[0]);
    return total;
  });

describe("B8, the inline copy leaves", () => {
  it("clears a new version once its blob reads back, and every reader still answers", async () => {
    const f = await importAll([nfeWithItems(5).full], { contentBlobs: true, cleanup: true });
    const company = await readable(f.t);
    const { doc, version, items, evidence } = await f.t.run(async (ctx) => {
      const doc = (await ctx.db.query("fiscalDocuments").first())!;
      const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
      const items = await ctx.db
        .query("documentItems")
        .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
        .collect();
      const evidence = (await ctx.db.query("documentFiscalEvidence").collect()).find(
        (row) => row.versionId === version._id,
      );
      return { doc, version, items, evidence };
    });
    expect(version).toMatchObject({ contentFormat: "document-content/1" });
    expect(version.result).toBeUndefined();
    expect(version.fiscalEvidence).toBeUndefined();
    expect(version.fiscalEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version.contentVerifiedAt).toBeDefined();
    expect(items).toEqual([]);
    expect(evidence?.snapshot).toBeUndefined();
    expect(evidence?.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    const get = rest(f.t, company);
    const detail = await get(`/v1/documents/${doc._id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.payload.kind).toBe("invoice");
    const page = await get(`/v1/documents/${doc._id}/items`, { versionId: version._id });
    expect(page.body.data.page).toHaveLength(5);
    expect((await get(`/v1/documents/${doc._id}/versions`)).status).toBe(200);
    expect((await get(`/v1/documents`)).body.data.page[0].issuer).toBe(version.card!.issuer);
    const { importId, fileId } = f.imported[0]!;
    // The import routes take no query string.
    const plain = (path: string) =>
      f.t
        .fetch(path, { headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" } })
        .then(async (response) => ({ status: response.status, body: await response.json() }));
    const summary = await plain(`/v1/imports/${importId}`);
    expect(typeof summary.body.data.files[0].result).toBe("string");
    expect((await plain(`/v1/imports/${importId}/files/${fileId}/history`)).status).toBe(200);

    // The projection reads the evidence snapshot back from the blob, checked by its hash.
    await f.t.run((ctx) =>
      ctx.db.patch("fiscalDocuments", doc._id, { projectionState: "pending" }),
    );
    const current = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", doc._id)))!;
    await f.t.action(internal.documentProjectionWorker.rebuild, {
      documentId: doc._id,
      generation: current.projectionGeneration ?? 0,
      originals: true,
    });
    expect((await f.t.run((ctx) => ctx.db.get("fiscalDocuments", doc._id)))!.projectionState).toBe(
      "ready",
    );
  });

  it("runs the cleanup only over verified versions with a complete card, and frees the bytes", async () => {
    const f = await importAll([nfeWithItems(4).full, nfeWithItems(6).full, nfeWithItems(8).full], {
      contentBlobs: true,
    });
    await f.t.mutation(internal.contentMigration.start, { kind: "audit" });
    for (let n = 0; n < 50; n++) {
      const run = (await f.t.run((ctx) =>
        ctx.db
          .query("contentMigrations")
          .withIndex("by_kind", (q) => q.eq("kind", "audit"))
          .unique(),
      ))!;
      if (run.state !== "running") break;
      await f.t.action(internal.contentMigrationNode.auditStep, {
        cursor: run.cursor,
        generation: run.generation,
      });
    }
    const [kept, unverified] = await f.t.run(async (ctx) => {
      const versions = (await ctx.db.query("documentVersions").collect()).filter(
        (version) => version.contentStorageId,
      );
      // A version left without a blob (over the cap) and one written after the audit.
      await ctx.storage.delete(versions[0]!.contentStorageId!);
      await ctx.db.patch("documentVersions", versions[0]!._id, {
        contentStorageId: undefined,
        contentSha256: undefined,
        contentSize: undefined,
        contentFormat: undefined,
        contentVerifiedAt: undefined,
      });
      await ctx.db.patch("documentVersions", versions[1]!._id, { contentVerifiedAt: undefined });
      return versions;
    });
    const before = await fiscalBytes(f.t);
    await f.t.mutation(internal.contentMigration.start, { kind: "cleanup" });
    let run: Doc<"contentMigrations"> | null = null;
    for (let n = 0; n < 50; n++) {
      run = await f.t.run((ctx) =>
        ctx.db
          .query("contentMigrations")
          .withIndex("by_kind", (q) => q.eq("kind", "cleanup"))
          .unique(),
      );
      if (run!.state !== "running") break;
      await f.t.mutation(internal.contentMigration.cleanupStep, {
        cursor: run!.cursor,
        generation: run!.generation,
      });
    }
    expect(run!.state).toBe("done");
    expect(run!.counts).toMatchObject({ noBlob: 1, unverified: 1, cleared: 1 });
    const after = await f.t.run((ctx) => ctx.db.query("documentVersions").collect());
    expect(after.find((row) => row._id === kept!._id)!.result).toBeDefined();
    expect(after.find((row) => row._id === unverified!._id)!.result).toBeDefined();
    expect(after.filter((row) => row.result === undefined)).toHaveLength(1);
    expect(await fiscalBytes(f.t)).toBeLessThan(before);
  });
});

describe("PROCESSING_CHANGED after the cleanup", () => {
  const output = {
    outputHash: "h",
    result: '{"document":{}}',
    fiscalEvidence: '{"e":1}',
    fiscalFingerprint: "fp",
    schema: "s",
    parserVersion: "p",
    normalizerVersion: "n",
    itemCount: 2,
  };
  const staged = (fields: Partial<Doc<"documentVersions">>) =>
    ({ ...output, ...fields }) as unknown as Doc<"documentVersions">;
  it("compares the text while it is inline", async () => {
    expect(await stagedVersionChanged(staged({}), output)).toBe(false);
    expect(await stagedVersionChanged(staged({}), { ...output, result: "{}" })).toBe(true);
  });
  it("compares by hash once the inline copy went, never an absent field with the new text", async () => {
    const { sha256 } = await import("../platform/convex/lib/documentContent");
    const cleared = staged({
      result: undefined,
      fiscalEvidence: undefined,
      fiscalEvidenceSha256: await sha256(new TextEncoder().encode(output.fiscalEvidence)),
    });
    expect(await stagedVersionChanged(cleared, output)).toBe(false);
    expect(await stagedVersionChanged(cleared, { ...output, fiscalEvidence: '{"e":2}' })).toBe(
      true,
    );
    expect(await stagedVersionChanged(cleared, { ...output, outputHash: "other" })).toBe(true);
    // Evidence the cleared version never had is a change, not a late addition.
    const without = staged({ result: undefined, fiscalEvidence: undefined });
    expect(await stagedVersionChanged(without, output)).toBe(true);
    expect(await stagedVersionChanged(staged({ outputHash: undefined }), output)).toBe(true);
  });
});

it("keeps the inline copy of a version with a partial blob reference and goes on", async () => {
  const f = await importAll([nfeWithItems(2).full], { contentBlobs: true });
  const version = await f.t.run(async (ctx) => {
    const version = (await ctx.db.query("documentVersions").collect()).find(
      (row) => row.contentStorageId,
    )!;
    await ctx.db.patch("documentVersions", version._id, { contentSha256: undefined });
    return version;
  });
  const { clearInlineContent } = await import("../platform/convex/lib/documentContentCleanup");
  const outcome = await f.t.run(async (ctx) =>
    clearInlineContent(ctx, (await ctx.db.get("documentVersions", version._id))!),
  );
  expect(outcome).toBe("corrupt");
  expect(
    (await f.t.run((ctx) => ctx.db.get("documentVersions", version._id)))!.result,
  ).toBeDefined();
});

it("keeps an inline copy that changed after its verification, such as a late evidence", async () => {
  const f = await importAll([nfeWithItems(2).full], { contentBlobs: true });
  const version = await f.t.run(async (ctx) => {
    const version = (await ctx.db.query("documentVersions").collect()).find(
      (row) => row.contentVerifiedAt,
    )!;
    await ctx.db.patch("documentVersions", version._id, {
      fiscalEvidence: `${version.fiscalEvidence ?? "{}"} `,
    });
    return version;
  });
  const { clearInlineContent } = await import("../platform/convex/lib/documentContentCleanup");
  const outcome = await f.t.run(async (ctx) =>
    clearInlineContent(ctx, (await ctx.db.get("documentVersions", version._id))!),
  );
  expect(outcome).toBe("changed");
  expect(
    (await f.t.run((ctx) => ctx.db.get("documentVersions", version._id)))!.result,
  ).toBeDefined();
});

it("spreads the writer's retries and stops after the last try", async () => {
  const { writerRetryDelay } = await import("../platform/convex/lib/documentContentWriter");
  const first = writerRetryDelay(1)!;
  const second = writerRetryDelay(2)!;
  expect(first).toBeGreaterThanOrEqual(4_000);
  expect(first).toBeLessThan(5_000);
  expect(second).toBeGreaterThanOrEqual(8_000);
  expect(writerRetryDelay(3)).toBeNull();
});
