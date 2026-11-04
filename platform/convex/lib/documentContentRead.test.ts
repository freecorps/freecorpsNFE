import { describe, expect, it } from "vite-plus/test";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { readSelected } from "../documentContentNode";
import { importAll, nfeWithItems } from "../../../tests/helpers/document-footprint";
import { usePlatformEnvironment } from "../../../tests/helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-content-read",
});

const secret = `fnfe_${"b".repeat(43)}`;
type Imported = Awaited<ReturnType<typeof importAll>>;

async function setup(items: number, contentBlobs = true) {
  const imported = await importAll([nfeWithItems(items).full], { contentBlobs });
  const { t } = imported;
  const { company, doc, version } = await t.run(async (ctx) => {
    // The proof key imports; reading needs `documents:read` on the key and the grant.
    const scopes = ["documents:import", "documents:read"] as const;
    for (const key of await ctx.db.query("apiKeys").collect())
      await ctx.db.patch("apiKeys", key._id, { scopes: [...scopes] });
    for (const grant of await ctx.db.query("projectCompanies").collect())
      await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    const company = (await ctx.db.query("companies").first())!;
    const doc = (await ctx.db.query("fiscalDocuments").first())!;
    const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
    return { company, doc, version };
  });
  const get = async (path: string, query: Record<string, string> = {}) => {
    const search = new URLSearchParams({ companyId: company._id, ...query });
    const response = await t.fetch(`${path}?${search}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...imported, company, doc, version, get };
}

/** Rewrites the inline copy only: a response that still shows the original read the blob. */
async function tamperInline(t: Imported["t"], version: Doc<"documentVersions">) {
  await t.run(async (ctx) => {
    const result = JSON.parse(version.result!) as {
      document: { issuer: { name: string } };
    };
    result.document.issuer.name = "ADULTERADO NA LINHA";
    await ctx.db.patch("documentVersions", version._id, { result: JSON.stringify(result) });
    for (const item of await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
      .collect())
      await ctx.db.patch("documentItems", item._id, {
        data: item.data.replace(/"description":"[^"]*"/, '"description":"ADULTERADO"'),
      });
  });
}

describe("phase B readers (ADR 0010, B5)", () => {
  it("serves detail, items and versions from the blob, with the content of the import", async () => {
    const f = await setup(30);
    expect(f.version.contentStorageId).toBeDefined();
    const detail = await f.get(`/v1/documents/${f.doc._id}`);
    expect(detail.status).toBe(200);
    const items: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await f.get(`/v1/documents/${f.doc._id}/items`, {
        versionId: f.version._id,
        limit: "12",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status).toBe(200);
      items.push(...page.body.data.page);
      cursor = page.body.data.nextCursor;
    } while (cursor);
    const versions = await f.get(`/v1/documents/${f.doc._id}/versions`);
    expect(versions.status).toBe(200);

    await tamperInline(f.t, f.version);
    const again = await f.get(`/v1/documents/${f.doc._id}`);
    expect(again.body.data).toEqual(detail.body.data);
    expect(JSON.stringify(again.body)).not.toContain("ADULTERADO");
    const blobItems: unknown[] = [];
    cursor = null;
    do {
      const page = await f.get(`/v1/documents/${f.doc._id}/items`, {
        versionId: f.version._id,
        limit: "12",
        ...(cursor ? { cursor } : {}),
      });
      blobItems.push(...page.body.data.page);
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(blobItems).toHaveLength(30);
    expect(blobItems).toEqual(items);
    expect((await f.get(`/v1/documents/${f.doc._id}/versions`)).body.data).toEqual(
      versions.body.data,
    );
  });

  it("refuses a missing or damaged blob instead of answering inline", async () => {
    const f = await setup(3);
    await f.t.run((ctx) =>
      ctx.db.patch("documentVersions", f.version._id, { contentSha256: "0".repeat(64) }),
    );
    for (const path of [`/v1/documents/${f.doc._id}`, `/v1/documents/${f.doc._id}/versions`]) {
      const response = await f.get(path);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("UNAVAILABLE");
    }
    await f.t.run(async (ctx) => {
      await ctx.db.patch("documentVersions", f.version._id, {
        contentSha256: f.version.contentSha256,
      });
      await ctx.storage.delete(f.version.contentStorageId!);
    });
    const items = await f.get(`/v1/documents/${f.doc._id}/items`, { versionId: f.version._id });
    expect(items.status).toBe(503);
    // A partial reference is corruption, never "no blob".
    await f.t.run((ctx) =>
      ctx.db.patch("documentVersions", f.version._id, { contentSha256: undefined }),
    );
    expect((await f.get(`/v1/documents/${f.doc._id}`)).status).toBe(503);
  });

  it("reads a version without a blob inline, a normal state", async () => {
    const f = await setup(4, false);
    expect(f.version.contentStorageId).toBeUndefined();
    const detail = await f.get(`/v1/documents/${f.doc._id}`);
    expect(detail.status).toBe(200);
    const page = await f.get(`/v1/documents/${f.doc._id}/items`, {
      versionId: f.version._id,
      limit: "3",
    });
    expect(page.body.data.page).toHaveLength(3);
    const rest = await f.get(`/v1/documents/${f.doc._id}/items`, {
      versionId: f.version._id,
      cursor: page.body.data.nextCursor,
    });
    expect(rest.body.data.page).toHaveLength(1);
    expect(rest.body.data.nextCursor).toBeNull();
  });

  it("binds the item cursor to the document, the version and a position inside it", async () => {
    const f = await setup(2);
    const cursor = (binding: string, position: string) =>
      btoa(JSON.stringify({ binding, cursor: position }));
    for (const value of [
      cursor(`${f.doc._id}:${f.version._id}`, "2"),
      cursor(`${f.doc._id}:${f.version._id}`, "-1"),
      cursor(`${f.doc._id}:${f.version._id}`, "01"),
      cursor(`other:${f.version._id}`, "1"),
      "not-base64",
    ]) {
      const response = await f.get(`/v1/documents/${f.doc._id}/items`, {
        versionId: f.version._id,
        cursor: value,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_CURSOR");
    }
  });

  it("serves the import summary and the file history from the blob", async () => {
    const f = await setup(2);
    const { importId, fileId } = f.imported[0]!;
    const get = (path: string) =>
      f.t
        .fetch(path, { headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" } })
        .then(async (response) => ({ status: response.status, body: await response.json() }));
    const before = await get(`/v1/imports/${importId}`);
    const history = await get(`/v1/imports/${importId}/files/${fileId}/history`);
    expect(before.status).toBe(200);
    expect(history.status).toBe(200);
    await tamperInline(f.t, f.version);
    expect((await get(`/v1/imports/${importId}`)).body.data).toEqual(before.body.data);
    expect((await get(`/v1/imports/${importId}/files/${fileId}/history`)).body.data).toEqual(
      history.body.data,
    );
    expect(JSON.stringify(history.body)).not.toContain("ADULTERADO");
    const withBody = await f.t.fetch(`/v1/imports/${importId}?x=1`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
    expect(withBody.status).toBe(400);
  });

  it("keeps the listing on the card, without the content", async () => {
    const f = await setup(1);
    await tamperInline(f.t, f.version);
    const list = await f.get(`/v1/documents`);
    expect(list.status).toBe(200);
    expect(list.body.data.page[0].issuer).not.toBe("ADULTERADO NA LINHA");
    expect(list.body.data.page[0].issuer).toBe(f.version.card!.issuer);
  });
});

describe("readSelected", () => {
  const storage = { get: async () => null };
  it("returns a selection without a plan as it is", async () => {
    expect(await readSelected(async () => JSON.stringify({ a: 1 }), storage)).toBe('{"a":1}');
  });
  it("renders a stable plan and gives up when the selection keeps changing", async () => {
    const plan = (tag: number) =>
      JSON.stringify({
        $plan: {
          renderer: "history",
          data: [{ id: `v${tag}`, processorVersion: "p", completedAt: 1, code: "C" }],
          needs: [{ key: "v0", want: { result: true }, inline: { result: '{"x":1}' } }],
        },
      });
    expect(JSON.parse(await readSelected(async () => plan(1), storage))).toEqual([
      { id: "v1", processorVersion: "p", completedAt: 1, code: "C", result: '{"x":1}' },
    ]);
    let calls = 0;
    await expect(readSelected(async () => plan(calls++), storage)).rejects.toThrow();
    expect(calls).toBe(4);
  });
});

it("rebuilds the fiscal projection from the blob, not from the inline copy", async () => {
  const f = await setup(1);
  // Inline text a worker could not interpret: only the blob holds the real content.
  await f.t.run(async (ctx) => {
    await ctx.db.patch("documentVersions", f.version._id, { result: "{}", fiscalEvidence: "{}" });
    await ctx.db.patch("fiscalDocuments", f.doc._id, { projectionState: "pending" });
  });
  const doc = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.doc._id)))!;
  await f.t.action(internal.documentProjectionWorker.rebuild, {
    documentId: doc._id,
    generation: doc.projectionGeneration ?? 0,
    originals: true,
  });
  const after = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.doc._id)))!;
  expect(after.projectionState).toBe("ready");
});
