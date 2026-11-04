import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { monthsBefore } from "./coldTier";
import { signColdRequest } from "./lib/coldObjects";
import { signRequest } from "../../scripts/lib/offsite-backup.mjs";
import { importAll, nfeWithItems } from "../../tests/helpers/document-footprint";
import { actor } from "../../tests/helpers/export-fixture";
import { capturePlan, usePlatformEnvironment } from "../../tests/helpers/platform";

usePlatformEnvironment({
  siteUrl: "http://localhost:5190",
  convexSiteUrl: "http://127.0.0.1:3239",
  secret: "synthetic-cold-tier",
});

const ENDPOINT = "https://cold.r2.test";
const BUCKET = "fnfe-cold-test";
const MONTH = 31 * 86_400_000;
const secret = `fnfe_${"b".repeat(43)}`;
const XML = nfeWithItems(5).full;
const gunzip = (bytes: Uint8Array) => new Uint8Array(gunzipSync(bytes));

/**
 * An in-memory S3 bucket behind `fetch`: checks the signed payload hash, as R2 does. Installed
 * by `enable`, after the import, whose helper restores every mock.
 */
function useBucket() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const real = globalThis.fetch;
  beforeEach(() => {
    objects.clear();
    calls.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  const install = () => {
    if (vi.isMockFunction(globalThis.fetch)) return;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.origin !== ENDPOINT) return real(input, init);
      const key = url.pathname.slice(`/${BUCKET}/`.length);
      const headers = new Headers(init?.headers);
      calls.push(`${init?.method} ${key}`);
      if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=test-key/"))
        return new Response(null, { status: 403 });
      if (init?.method === "PUT") {
        const body = new Uint8Array(init.body as ArrayBuffer);
        const hash = createHash("sha256").update(body).digest("hex");
        if (hash !== headers.get("x-amz-content-sha256"))
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
  };
  return { objects, calls, install };
}
const bucket = useBucket();

function enable() {
  bucket.install();
  vi.stubEnv("FNFE_COLD_TIER", "enabled");
  vi.stubEnv("FNFE_COLD_R2_ENDPOINT", ENDPOINT);
  vi.stubEnv("FNFE_COLD_R2_BUCKET", BUCKET);
  vi.stubEnv("FNFE_COLD_R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("FNFE_COLD_R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "2100");
}

async function setup() {
  // `cleanup`: the writer verifies the blob and clears the inline copy, as after B7/B8.
  const imported = await importAll([XML], { contentBlobs: true, cleanup: true });
  const { t } = imported;
  const { company, doc } = await t.run(async (ctx) => {
    const scopes = ["documents:import", "documents:read"] as const;
    for (const key of await ctx.db.query("apiKeys").collect())
      await ctx.db.patch("apiKeys", key._id, { scopes: [...scopes] });
    for (const grant of await ctx.db.query("projectCompanies").collect())
      await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    return {
      company: (await ctx.db.query("companies").first())!,
      doc: (await ctx.db.query("fiscalDocuments").first())!,
    };
  });
  const get = async (path: string, query: Record<string, string> = {}) => {
    const search = new URLSearchParams({ companyId: company._id, ...query });
    const response = await t.fetch(`${path}?${search}`, {
      headers: { Authorization: `Bearer ${secret}`, "X-Environment": "sandbox" },
    });
    return { status: response.status, body: await response.json() };
  };
  const versions = () =>
    t.run((ctx) =>
      ctx.db
        .query("documentVersions")
        .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
        .collect(),
    );
  const note = () => t.run(async (ctx) => (await ctx.db.get("fiscalDocuments", doc._id))!);
  /** One sweep, as the scheduler runs it: start, steps and moves, then the hot file's grace. */
  const sweep = async (months: number) => {
    vi.setSystemTime(doc.createdAt + months * MONTH);
    const started = await t.mutation(internal.coldTier.start, {});
    // Steps, moves and the hot file's grace, well short of the next day's sweep.
    for (let n = 0; n < 30; n++) {
      vi.advanceTimersByTime(5 * 60_000);
      await t.finishInProgressScheduledFunctions();
    }
    return started;
  };
  const sweepRow = () => t.run((ctx) => ctx.db.query("coldTierSweeps").first());
  /** The note's XML original (ADR 0010, decision 8): one imported file, one artifact. */
  const artifact = () =>
    t.run(
      async (ctx) =>
        (await ctx.db
          .query("documentArtifacts")
          .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
          .unique())!,
    );
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    t.fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        ...init.headers,
      },
    });
  const originalPath = async () =>
    `/v1/document-artifacts/${(await artifact())._id}/original?companyId=${company._id}`;
  return {
    ...imported,
    company,
    doc,
    get,
    versions,
    note,
    sweep,
    sweepRow,
    artifact,
    request,
    originalPath,
  };
}

describe("cold tier passage (ADR 0010, phase C1)", () => {
  it("does nothing with the gate off, or without the bucket", async () => {
    const f = await setup();
    expect(await f.sweep(13)).toBe("disabled");
    vi.stubEnv("FNFE_COLD_TIER", "enabled");
    expect(await f.sweep(13)).toBe("disabled");
    expect(await f.sweepRow()).toBeNull();
    expect((await f.note()).coldState).toBeUndefined();
    expect(bucket.calls).toEqual([]);
  });

  it("moves every published version to the bucket and reads it back from there", async () => {
    const f = await setup();
    const before = {
      detail: await f.get(`/v1/documents/${f.doc._id}`),
      items: await f.get(`/v1/documents/${f.doc._id}/items`, {
        versionId: f.doc.publishedVersionId!,
      }),
    };
    expect(before.detail.status).toBe(200);
    const hot = (await f.versions()).filter((version) => version.publishedAt !== undefined);
    expect(hot.length).toBeGreaterThan(0);
    enable();
    expect(await f.sweep(13)).toBe("started");

    const note = await f.note();
    expect(note).toMatchObject({ coldState: "cold" });
    expect(note.coldAt).toBeDefined();
    const cold = (await f.versions()).filter((version) => version.publishedAt !== undefined);
    for (const version of cold) {
      expect(version.contentStorageId).toBeUndefined();
      expect(version.contentObjectKey).toBe(
        `documents/sandbox/${note.organizationId}/${version._id}/content-${version.contentSha256}.gz`,
      );
      const object = bucket.objects.get(version.contentObjectKey!)!;
      expect(version.contentObjectSize).toBe(object.length);
      expect(version.contentObjectSha256).toBe(createHash("sha256").update(object).digest("hex"));
    }
    // The listing reads the residue, which stayed hot; detail and items read the bucket.
    const list = await f.get("/v1/documents");
    expect(list.status).toBe(200);
    // The published v1 contract does not change: no tier in the REST summary.
    expect(JSON.stringify(list.body)).not.toContain("storageTier");
    const detail = await f.get(`/v1/documents/${f.doc._id}`);
    const items = await f.get(`/v1/documents/${f.doc._id}/items`, {
      versionId: f.doc.publishedVersionId!,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(before.detail.body.data);
    expect(items.body.data).toEqual(before.items.body.data);
    expect(bucket.calls.filter((call) => call.startsWith("GET")).length).toBeGreaterThan(0);

    // After the grace, the hot files are gone and nothing holds them.
    for (const version of hot)
      expect(
        await f.t.run((ctx) => ctx.db.system.get("_storage", version.contentStorageId!)),
      ).toBeNull();
    // The next sweep is already scheduled, a day later, and finds nothing more to move.
    expect((await f.sweepRow())!.next).toBeDefined();
    const puts = bucket.calls.filter((call) => call.startsWith("PUT")).length;
    await f.sweep(14);
    expect(bucket.calls.filter((call) => call.startsWith("PUT")).length).toBe(puts);
  });

  it("moves a Production note only under a confirmed lock year, keyed by its guard", async () => {
    const f = await setup();
    enable();
    vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "");
    await f.t.run((ctx) =>
      ctx.db.patch("fiscalDocuments", f.doc._id, { environment: "production" }),
    );
    // No lock rule confirmed: the action gives the claim back and nothing reaches the bucket.
    await f.sweep(13);
    expect((await f.note()).coldState).toBeUndefined();
    expect(bucket.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "2100");
    await f.sweep(14);
    expect((await f.note()).coldState).toBe("cold");
    for (const version of (await f.versions()).filter((row) => row.publishedAt !== undefined)) {
      // The guard of D01 ends on 31/12 of the fifth year after the issue (Brasília).
      const issued = new Date(Date.parse(version.card!.issuedAt!) - 3 * 3_600_000);
      expect(version.contentObjectKey).toMatch(
        new RegExp(`^documents/production/guard-${issued.getUTCFullYear() + 5}/`),
      );
    }
  });

  it("keeps the note hot inside the window of its plan", async () => {
    const f = await setup();
    enable();
    // No plan counts as 12 months: at 4 months the note stays hot.
    await f.sweep(4);
    expect((await f.note()).coldState).toBeUndefined();
    expect((await f.sweepRow())!.counts).toMatchObject({ hotWindow: 1 });
    // The Free plan keeps it 3 months.
    await capturePlan(f.t, f.doc.organizationId);
    await f.t.run(async (ctx) => {
      const plan = await ctx.db
        .query("usagePlans")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", f.doc.organizationId))
        .unique();
      if (plan) await ctx.db.patch("usagePlans", plan._id, { catalogTier: "free" });
      else throw new Error("plan expected");
    });
    await f.sweep(5);
    expect((await f.note()).coldState).toBe("cold");
  });

  it("does not move an organization under an active legal hold", async () => {
    const f = await setup();
    enable();
    await f.t.run((ctx) =>
      ctx.db.insert("retentionHolds", {
        organizationId: f.doc.organizationId,
        reference: "processo-sintetico",
        reviewAt: Date.UTC(2100, 0, 1),
        createdAt: Date.now(),
      }),
    );
    await f.sweep(13);
    expect((await f.note()).coldState).toBeUndefined();
    expect((await f.sweepRow())!.counts).toMatchObject({ legalHold: 1 });
    expect(bucket.calls).toEqual([]);
  });

  it("reads every hold: released ones never block, one active past many does", async () => {
    const f = await setup();
    enable();
    await f.t.run(async (ctx) => {
      for (let n = 0; n < 120; n++)
        await ctx.db.insert("retentionHolds", {
          organizationId: f.doc.organizationId,
          reference: `liberada-${String(n).padStart(3, "0")}`,
          reviewAt: Date.UTC(2100, 0, 1),
          createdAt: Date.now(),
          releasedAt: Date.now(),
        });
      await ctx.db.insert("retentionHolds", {
        organizationId: f.doc.organizationId,
        reference: "zz-ativa",
        reviewAt: Date.UTC(2100, 0, 1),
        createdAt: Date.now(),
      });
    });
    await f.sweep(13);
    expect((await f.note()).coldState).toBeUndefined();
    await f.t.run(async (ctx) => {
      const active = (await ctx.db.query("retentionHolds").collect()).find(
        (hold) => hold.releasedAt === undefined,
      )!;
      await ctx.db.patch("retentionHolds", active._id, { releasedAt: Date.now() });
    });
    await f.sweep(14);
    expect((await f.note()).coldState).toBe("cold");
  });

  it("refuses a missing or damaged cold object instead of answering anything", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    const [version] = (await f.versions()).filter((row) => row.contentObjectKey);
    const key = version!.contentObjectKey!;
    const original = bucket.objects.get(key)!;
    bucket.objects.set(key, original.slice(0, original.length - 4));
    const damaged = await f.get(`/v1/documents/${f.doc._id}`);
    expect(damaged.status).toBe(503);
    expect(damaged.body.error.code).toBe("UNAVAILABLE");
    bucket.objects.delete(key);
    expect((await f.get(`/v1/documents/${f.doc._id}`)).status).toBe(503);
  });

  it("keeps an organization with a note still moving out of the ADR 0009 archive", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const notice = () =>
      f.t.mutation(internal.coldArchive.notice, {
        organizationId: f.doc.organizationId,
        key: "aviso-sintetico",
      });
    await f.t.run((ctx) =>
      ctx.db.patch("fiscalDocuments", f.doc._id, { coldState: "moving", coldClaimedAt: 0 }),
    );
    await expect(notice()).rejects.toThrow("ARCHIVE_COLD_TIER_MOVING");
    // A cold note no longer blocks: the package references its objects by hash. Whatever the
    // eligibility answers now, it is not the cold tier's refusal.
    await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.doc._id, { coldState: "cold" }));
    await expect(notice()).rejects.not.toThrow("ARCHIVE_COLD_TIER");
  });

  it("gives the claim back when the bucket fails, and moves the note at the next sweep", async () => {
    const f = await setup();
    enable();
    vi.stubEnv("FNFE_COLD_R2_SECRET_ACCESS_KEY", "");
    vi.stubEnv("FNFE_COLD_R2_ACCESS_KEY_ID", "");
    vi.stubEnv("FNFE_COLD_R2_ENDPOINT", "");
    vi.stubEnv("FNFE_COLD_R2_BUCKET", "");
    expect(await f.sweep(13)).toBe("disabled");
    enable();
    vi.stubEnv("FNFE_COLD_R2_ACCESS_KEY_ID", "wrong-key");
    await f.sweep(13);
    expect((await f.note()).coldState).toBeUndefined();
    expect((await f.versions()).every((version) => !version.contentObjectKey)).toBe(true);
    enable();
    await f.sweep(14);
    expect((await f.note()).coldState).toBe("cold");
  });

  it("collects an object whose attach never came, and only that one", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    // A successful passage leaves no intent behind.
    expect(await f.t.run((ctx) => ctx.db.query("coldObjectUploads").collect())).toEqual([]);
    const [held] = (await f.versions()).filter((row) => row.contentObjectKey);
    const orphan = `documents/sandbox/${f.doc.organizationId}/${held!._id}/content-${"0".repeat(64)}.gz`;
    const locked = `documents/production/guard-2099/${f.doc.organizationId}/x/content-${"1".repeat(64)}.gz`;
    for (const key of [orphan, locked]) bucket.objects.set(key, new Uint8Array([1, 2, 3]));
    await f.t.run(async (ctx) => {
      for (const objectKey of [orphan, locked, held!.contentObjectKey!])
        await ctx.db.insert("coldObjectUploads", {
          organizationId: f.doc.organizationId,
          objectKey,
          retryAt: Date.now() - 1,
        });
    });
    await f.t.action(internal.coldTierWorker.collect, {});
    expect(bucket.objects.has(orphan)).toBe(false);
    // Held by a version: the intent goes, the object stays.
    expect(bucket.objects.has(held!.contentObjectKey!)).toBe(true);
    // Under the lock of its guard year: it waits until the lock ends.
    expect(bucket.objects.has(locked)).toBe(true);
    const left = await f.t.run((ctx) => ctx.db.query("coldObjectUploads").collect());
    expect(left.map((row) => [row.objectKey, row.retryAt])).toEqual([
      [locked, Date.UTC(2100, 0, 1, 3)],
    ]);
  });

  it("deletes the objects the fiscal guard queued", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    const [version] = (await f.versions()).filter((row) => row.contentObjectKey);
    await f.t.run((ctx) =>
      ctx.db.insert("coldObjectDeletions", {
        organizationId: f.doc.organizationId,
        objectKey: version!.contentObjectKey!,
        requestedAt: Date.now(),
      }),
    );
    expect(await f.t.action(internal.coldTierWorker.collect, {})).toBe(1);
    expect(bucket.objects.has(version!.contentObjectKey!)).toBe(false);
    expect(await f.t.run((ctx) => ctx.db.query("coldObjectDeletions").first())).toBeNull();
  });
});

describe("cold XML originals (ADR 0010, decision 8)", () => {
  type Fixture = Awaited<ReturnType<typeof setup>>;
  /** A console member of the note's organization, with a download ticket for the original. */
  async function consoleDownload(f: Fixture) {
    const member = await actor({
      t: f.t,
      scope: { organizationId: f.doc.organizationId },
    } as unknown as Parameters<typeof actor>[0]);
    const ticket = await member.client.mutation(api.documentDownloads.ticket, {
      organizationId: f.doc.organizationId,
      companyId: f.company._id,
      environment: "sandbox",
      artifactId: (await f.artifact())._id,
    });
    return f.t.fetch("/v1/document-download", {
      headers: { Origin: "http://localhost:5190", "X-Download-Token": ticket.token },
    });
  }
  /** Another row holding the original's file, as the batch file of an NFS-e batch does. */
  async function shareFile(f: Fixture) {
    return f.t.run(async (ctx) => {
      const {
        _id,
        _creationTime,
        documentId: _document,
        fileId: _file,
        ...rest
      } = (await ctx.db
        .query("documentArtifacts")
        .withIndex("by_documentId", (q) => q.eq("documentId", f.doc._id))
        .unique())!;
      return ctx.db.insert("documentArtifacts", rest);
    });
  }

  it("moves the original with the note, as the gzip of the raw XML, and drops the hot file", async () => {
    const f = await setup();
    const hot = await f.artifact();
    expect(hot.storageId).toBeDefined();
    enable();
    await f.sweep(13);

    expect((await f.note()).coldState).toBe("cold");
    const cold = await f.artifact();
    expect(cold.storageId).toBeUndefined();
    expect(cold.objectKey).toBe(
      `documents/sandbox/${f.doc.organizationId}/${cold._id}/original-${hot.sha256}.gz`,
    );
    const object = bucket.objects.get(cold.objectKey!)!;
    expect(cold.objectSize).toBe(object.length);
    expect(cold.objectSha256).toBe(createHash("sha256").update(object).digest("hex"));
    expect(gunzip(object)).toEqual(new Uint8Array(XML));
    // The raw hash and size keep describing the XML itself.
    expect(cold).toMatchObject({ sha256: hot.sha256, size: hot.size });
    await f.t.run(async (ctx) => {
      // The import file let go of the same stored file, which is gone after the grace.
      expect((await ctx.db.get("importFiles", hot.fileId!))!.storageId).toBeUndefined();
      expect(await ctx.db.system.get("_storage", hot.storageId!)).toBeNull();
      expect(await ctx.db.query("coldObjectUploads").collect()).toEqual([]);
    });
    // The console lists it as available.
    const files = await f.get(`/v1/documents/${f.doc._id}/files`);
    expect(files.body.data.page[0].originalAvailable).toBe(true);
  });

  it("serves the same bytes by REST and by a console ticket, and charges the raw size", async () => {
    const f = await setup();
    const before = await f.request(await f.originalPath());
    expect(before.status).toBe(200);
    const hotBytes = new Uint8Array(await before.arrayBuffer());
    expect(hotBytes).toEqual(new Uint8Array(XML));
    const headers = Object.fromEntries(
      ["Content-Type", "Content-Disposition", "Cache-Control"].map((name) => [
        name,
        before.headers.get(name),
      ]),
    );
    enable();
    await f.sweep(13);
    expect((await f.artifact()).objectKey).toBeDefined();

    const rest = await f.request(await f.originalPath());
    expect(rest.status).toBe(200);
    expect(new Uint8Array(await rest.arrayBuffer())).toEqual(hotBytes);
    for (const [name, value] of Object.entries(headers)) expect(rest.headers.get(name)).toBe(value);
    const consoleResponse = await consoleDownload(f);
    expect(consoleResponse.status).toBe(200);
    expect(new Uint8Array(await consoleResponse.arrayBuffer())).toEqual(hotBytes);
    expect(consoleResponse.headers.get("Content-Disposition")).toBe(headers["Content-Disposition"]);
    // Each download counts the raw XML, as when it was hot.
    const committed = await f.t.run(async (ctx) =>
      (
        await ctx.db
          .query("capacityEvents")
          .withIndex("by_organizationId_and_updatedAt", (q) =>
            q.eq("organizationId", f.doc.organizationId),
          )
          .collect()
      )
        .filter((event) => event.metric === "downloadsBytes")
        .map((event) => [event.quantity, event.state]),
    );
    expect(committed).toEqual(Array(3).fill([XML.length, "committed"]));
  });

  it("refuses a damaged or missing cold original instead of serving anything", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    const key = (await f.artifact()).objectKey!;
    const object = bucket.objects.get(key)!;
    // A valid gzip of other bytes: the object hash already refuses it.
    bucket.objects.set(key, new Uint8Array(object.slice(0, object.length - 1)));
    for (const response of [await f.request(await f.originalPath()), await consoleDownload(f)]) {
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("UNAVAILABLE");
    }
    bucket.objects.delete(key);
    expect((await f.request(await f.originalPath())).status).toBe(503);
  });

  it("keeps a shared original hot without blocking the note", async () => {
    const f = await setup();
    await shareFile(f);
    enable();
    await f.sweep(13);
    expect((await f.note()).coldState).toBe("cold");
    const original = await f.artifact();
    expect(original.objectKey).toBeUndefined();
    expect(
      await f.t.run((ctx) => ctx.db.system.get("_storage", original.storageId!)),
    ).not.toBeNull();
    expect([...bucket.objects.keys()].some((key) => key.includes("/original-"))).toBe(false);
    expect((await f.request(await f.originalPath())).status).toBe(200);
  });

  it("keeps an entry of an NFS-e batch hot, as its batch file", async () => {
    const f = await setup();
    const parent = await shareFile(f);
    await f.t.run(async (ctx) => {
      const original = (await ctx.db
        .query("documentArtifacts")
        .withIndex("by_documentId", (q) => q.eq("documentId", f.doc._id))
        .unique())!;
      await ctx.db.patch("documentArtifacts", original._id, { parentArtifactId: parent });
    });
    enable();
    await f.sweep(13);
    expect((await f.note()).coldState).toBe("cold");
    expect((await f.artifact()).objectKey).toBeUndefined();
    expect(
      (await f.t.run((ctx) => ctx.db.get("documentArtifacts", parent)))!.storageId,
    ).toBeDefined();
  });

  it("waits for the original's lock year, and only then makes the note cold", async () => {
    const f = await setup();
    // The note's versions go cold first while its original is shared, as a note moved before
    // decision 8 would be.
    const sharer = await shareFile(f);
    enable();
    await f.sweep(13);
    expect((await f.artifact()).objectKey).toBeUndefined();
    await f.t.run(async (ctx) => {
      await ctx.db.delete("documentArtifacts", sharer);
      await ctx.db.patch("fiscalDocuments", f.doc._id, {
        environment: "production",
        coldState: "moving",
        coldClaimedAt: 0,
      });
    });
    vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "");
    await f.sweep(14);
    // No lock rule for its year: the original stays hot, and the note stays `moving`.
    expect((await f.artifact()).objectKey).toBeUndefined();
    expect((await f.note()).coldState).toBe("moving");
    expect(bucket.calls.some((call) => call.startsWith("PUT") && call.includes("/original-"))).toBe(
      false,
    );
    vi.stubEnv("FNFE_COLD_LOCKED_THROUGH", "2100");
    await f.sweep(15);
    expect((await f.note()).coldState).toBe("cold");
    // The guard of D01 ends on 31/12 of the fifth year after the issue (Brasília).
    const [version] = await f.versions();
    const issued = new Date(Date.parse(version!.card!.issuedAt!) - 3 * 3_600_000);
    const year = issued.getUTCFullYear() + 5;
    expect((await f.artifact()).objectKey).toMatch(
      new RegExp(`^documents/production/guard-${year}/.+/original-[a-f0-9]{64}\\.gz$`),
    );
  });

  it("drops the DANFE cache when the note turns cold, and renders it again from the bucket", async () => {
    const f = await setup();
    const danfePath = `/v1/documents/${f.doc._id}/danfe?companyId=${f.company._id}`;
    const first = await f.request(danfePath);
    expect(first.status).toBe(200);
    const cached = (await f.t.run((ctx) => ctx.db.query("documentDanfes").unique()))!;
    expect(cached.storageId).toBeDefined();
    enable();
    await f.sweep(13);
    expect((await f.note()).coldState).toBe("cold");
    await f.t.run(async (ctx) => {
      expect(await ctx.db.query("documentDanfes").collect()).toEqual([]);
      expect(await ctx.db.system.get("_storage", cached.storageId!)).toBeNull();
    });
    const again = await f.request(danfePath);
    expect(again.status).toBe(200);
    expect(again.headers.get("Content-Type")).toBe("application/pdf");
    const rendered = (await f.t.run((ctx) => ctx.db.query("documentDanfes").unique()))!;
    expect(rendered.sourceSha256).toBe(cached.sourceSha256);
  });

  it("exports a cold note with its original", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    expect((await f.artifact()).objectKey).toBeDefined();
    const created = await f.request("/v1/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "export-cold" },
      body: JSON.stringify({ companyId: f.company._id, documentId: f.doc._id }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()).data;
    for (let n = 0; n < 30; n++) {
      const job = (await f.t.run((ctx) => ctx.db.get("documentExports", id)))!;
      if (job.state !== "running") break;
      await f.t.action(internal.exportWorker.run, { exportId: id, sequence: job.sequence });
    }
    expect((await f.t.run((ctx) => ctx.db.get("documentExports", id)))!.state).toBe("succeeded");
    const part = (await (await f.request(`/v1/exports/${id}/parts`)).json()).data.page[0];
    const token = (
      await (
        await f.request(`/v1/export-parts/${part.id}/ticket`, {
          method: "POST",
          headers: { "Idempotency-Key": "export-cold-ticket" },
        })
      ).json()
    ).data.token;
    const download = await f.t.fetch("/v1/export-download", {
      headers: { "X-Download-Token": token },
    });
    expect(download.status).toBe(200);
    const records = new TextDecoder()
      .decode(gunzip(new Uint8Array(await download.arrayBuffer())))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const original = records.find((record) => record.type === "original");
    expect(original.artifactId).toBe((await f.artifact())._id);
    expect(Buffer.from(original.content, "base64")).toEqual(XML);
  });

  it("reprocesses and projects a cold note from its cold original", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    expect((await f.artifact()).objectKey).toBeDefined();
    const generation = (await f.note()).projectionGeneration!;
    await f.t.action(internal.documentProjectionWorker.rebuild, {
      documentId: f.doc._id,
      generation,
      originals: true,
    });
    expect((await f.note()).projectionState).toBe("ready");

    const reprocess = await f.request(
      `/v1/documents/${f.doc._id}/reprocess?companyId=${f.company._id}`,
      { method: "POST", headers: { "Idempotency-Key": "reprocess-cold" } },
    );
    expect(reprocess.status).toBe(202);
    const { operationId } = (await reprocess.json()).data;
    await f.t.action(internal.operationWorker.run, { operationId, generation: 1 });
    // The publication's work (content blob, projection), well short of the next sweep.
    for (let n = 0; n < 10; n++) {
      vi.advanceTimersByTime(60_000);
      await f.t.finishInProgressScheduledFunctions();
    }
    const operation = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
    expect(operation).toMatchObject({ state: "succeeded" });
    // The original stays cold; the new version takes the note back to the sweep.
    expect((await f.artifact()).objectKey).toBeDefined();
    expect((await f.note()).coldState).toBe("moving");
    await f.sweep(14);
    expect((await f.note()).coldState).toBe("cold");
  });

  it("queues the original's deletion when the fiscal guard purges the note", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    const key = (await f.artifact()).objectKey!;
    const closureId = await f.t.run(async (ctx) => {
      await ctx.db.delete("organizations", f.doc.organizationId);
      return ctx.db.insert("organizationClosures", {
        organizationId: f.doc.organizationId,
        state: "purged",
        requestedAt: Date.now(),
        exportUntil: Date.now(),
        purgeBy: Date.now(),
        purgedAt: Date.now(),
        generation: 1,
        sandboxOnly: true,
      });
    });
    for (let n = 0; n < 20; n++) {
      const result = await f.t.mutation(internal.fiscalGuard.early, { closureId });
      if (result.done) break;
    }
    expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.doc._id))).toBeNull();
    const queued = await f.t.run((ctx) => ctx.db.query("coldObjectDeletions").collect());
    expect(queued.map((row) => row.objectKey)).toContain(key);
    await f.t.action(internal.coldTierWorker.collect, {});
    expect(bucket.objects.has(key)).toBe(false);
  });

  it("collects an orphan original, but never one an artifact holds", async () => {
    const f = await setup();
    enable();
    await f.sweep(13);
    const held = (await f.artifact()).objectKey!;
    const orphan = held.replace(/original-[a-f0-9]{64}/, `original-${"2".repeat(64)}`);
    bucket.objects.set(orphan, new Uint8Array([1, 2, 3]));
    await f.t.run(async (ctx) => {
      for (const objectKey of [held, orphan])
        await ctx.db.insert("coldObjectUploads", {
          organizationId: f.doc.organizationId,
          objectKey,
          retryAt: Date.now() - 1,
        });
    });
    await f.t.action(internal.coldTierWorker.collect, {});
    expect(bucket.objects.has(held)).toBe(true);
    expect(bucket.objects.has(orphan)).toBe(false);
    expect(await f.t.run((ctx) => ctx.db.query("coldObjectUploads").collect())).toEqual([]);
  });
});

describe("cold tier helpers", () => {
  it("signs as the backup's SigV4 does", async () => {
    const now = new Date(Date.UTC(2026, 10, 2, 12));
    const payload = createHash("sha256").update("conteudo").digest("hex");
    const config = {
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    };
    const key = "documents/org/version/content-abc.gz";
    const ours = await signColdRequest(
      config,
      "PUT",
      key,
      payload,
      { "content-type": "application/octet-stream" },
      now,
    );
    const theirs = signRequest({
      method: "PUT",
      url: `${ENDPOINT}/${BUCKET}/${key}`,
      headers: { "content-type": "application/octet-stream" },
      payloadHash: payload,
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      region: "auto",
      now,
    }) as Record<string, string>;
    expect(ours.headers.authorization).toBe(theirs.authorization);
  });

  it("counts calendar months in UTC, capping the day at the month's end", () => {
    expect(new Date(monthsBefore(Date.UTC(2026, 4, 31, 10), 3)).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(new Date(monthsBefore(Date.UTC(2027, 0, 15), 12)).toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
  });
});
