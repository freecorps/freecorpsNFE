import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { api } from "./_generated/api";
import { readBatch, start } from "./exportSource";
import { stepArgs } from "./exports";
import { fixture, actor } from "../../tests/helpers/export-fixture";
import { benchmarkLimits } from "../../scripts/lib/budget.mjs";

// Tetos em budget.json: aumentar um pede a label budget-increase na PR.
const LIMITS = benchmarkLimits("exports", [
  "maxReadRows",
  "batchedCallsPercentOfBaseline",
] as const);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5201",
    CONVEX_SITE_URL: "http://127.0.0.1:3261",
    BETTER_AUTH_SECRET: "synthetic-export-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("measures the complete export worker with published versions, items and originals", async () => {
  let calls = 0,
    responseBytes = 0,
    databaseBytes = 0,
    databaseRows = 0,
    maxReadBytes = 0,
    maxReadRows = 0;
  const measuredRead = internalQuery({
    args: {
      ...stepArgs,
      now: v.number(),
      checkpoint: v.string(),
      maxSteps: v.optional(v.number()),
      maxBytes: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
      calls++;
      const page = await readBatch(ctx, args);
      responseBytes += Buffer.byteLength(JSON.stringify(page));
      const metrics = await ctx.meta.getTransactionMetrics();
      databaseBytes += metrics.bytesRead.used;
      databaseRows += metrics.documentsRead.used;
      maxReadBytes = Math.max(maxReadBytes, metrics.bytesRead.used);
      maxReadRows = Math.max(maxReadRows, metrics.documentsRead.used);
      return page;
    },
  });
  const f = await fixture({
    "../../platform/convex/exportSource.ts": async () => ({ read: measuredRead, start }),
  });
  const owner = await actor(f);
  // Clone a document produced by the real importer, including its immutable
  // projections and stored XML. This measures exports, not repeated imports.
  await f.t.run(async (ctx) => {
    const original = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const version = (await ctx.db.get("documentVersions", original.publishedVersionId!))!;
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    const item = (await ctx.db.query("documentItems").first())!;
    const { _id: docId, _creationTime: docTime, ...docFields } = original;
    const { _id: versionId, _creationTime: versionTime, ...versionFields } = version;
    const { _id: artifactId, _creationTime: artifactTime, ...artifactFields } = artifact;
    void [docId, docTime, versionId, versionTime, artifactId, artifactTime];
    for (let n = 0; n < 100; n++) {
      const documentId =
        n === 0
          ? f.documentId
          : await ctx.db.insert("fiscalDocuments", {
              ...docFields,
              fiscalKey: String(n).padStart(44, "0"),
              publishedVersionId: undefined,
            });
      const storedArtifact =
        n === 0
          ? artifact._id
          : await ctx.db.insert("documentArtifacts", {
              ...artifactFields,
              documentId,
              fileId: undefined,
              storageId: await ctx.storage.store(new Blob([new Uint8Array(f.bytes)])),
            });
      for (let revision = 0; revision < 2; revision++) {
        const storedVersion =
          n === 0 && revision === 0
            ? version._id
            : await ctx.db.insert("documentVersions", {
                ...versionFields,
                documentId,
                artifactId: storedArtifact,
              });
        for (let position = n === 0 && revision === 0 ? 1 : 0; position < 30; position++)
          await ctx.db.insert("documentItems", {
            versionId: storedVersion,
            position,
            data: item.data,
          });
        await ctx.db.patch("documentVersions", storedVersion, { itemCount: 30, writtenItems: 30 });
        await ctx.db.patch("fiscalDocuments", documentId, { publishedVersionId: storedVersion });
      }
    }
    await ctx.db.insert("documentArtifacts", {
      ...artifactFields,
      documentId: undefined,
      fileId: undefined,
    });
  });
  const job = await owner.client.mutation(api.exports.create, {
    organizationId: f.scope.organizationId,
    selection: { kind: "organization" },
    key: "benchmark-125",
  });
  const measure = async (pagination?: "keyset-v1") => {
    calls = responseBytes = databaseBytes = databaseRows = maxReadBytes = maxReadRows = 0;
    await f.t.run(async (ctx) => {
      const previous = await ctx.db
        .query("exportParts")
        .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
        .collect();
      for (const part of previous) {
        await ctx.storage.delete(part.storageId);
        await ctx.db.delete("exportParts", part._id);
      }
      await ctx.db.patch("documentExports", job.id, {
        state: "running",
        sequence: 0,
        bytes: 0,
        checkpoint: JSON.stringify({
          phase: "documents",
          cursor: null,
          ...(pagination ? { pagination } : {}),
        }),
      });
    });
    const begun = performance.now();
    expect((await f.finish(job.id)).state).toBe("succeeded");
    const durationMs = performance.now() - begun;
    const parts = await f.t.run((ctx) =>
      ctx.db
        .query("exportParts")
        .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job.id))
        .collect(),
    );
    let compressedBytes = 0,
      uncompressedBytes = 0;
    const counts: Record<string, number> = {};
    const partHashes: string[] = [];
    const content = createHash("sha256");
    for (const part of parts) {
      const bytes = Buffer.from(
        await f.t.run(async (ctx) => (await ctx.storage.get(part.storageId))!.arrayBuffer()),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(part.sha256);
      partHashes.push(part.sha256);
      content.update(bytes);
      compressedBytes += bytes.length;
      const text = gunzipSync(bytes).toString();
      uncompressedBytes += Buffer.byteLength(text);
      for (const line of text.trim().split("\n")) {
        const row = JSON.parse(line);
        counts[row.type] = (counts[row.type] ?? 0) + 1;
        if (row.type === "original")
          expect(
            createHash("sha256").update(Buffer.from(row.content, "base64")).digest("hex"),
          ).toBe(row.sha256);
      }
    }
    expect(counts).toMatchObject({
      document: 100,
      version: 200,
      item: 6000,
      artifact: 100,
      original: 101,
    });
    const report = {
      calls,
      responseBytes,
      databaseBytes,
      databaseRows,
      maxReadBytes,
      maxReadRows,
      contentSha256: content.digest("hex"),
      partHashes,
      parts: parts.length,
      compressedBytes,
      uncompressedBytes,
      durationMs: Math.round(durationMs),
      counts,
    };
    return report;
  };
  const baseline = await measure();
  const batched = await measure("keyset-v1");
  expect(batched.calls).toBeLessThan((baseline.calls * LIMITS.batchedCallsPercentOfBaseline) / 100);
  expect(batched.partHashes).toEqual(baseline.partHashes);
  expect(batched.counts).toEqual(baseline.counts);
  expect(batched.uncompressedBytes).toBe(baseline.uncompressedBytes);
  expect(batched.maxReadRows).toBeLessThanOrEqual(LIMITS.maxReadRows);
  const report = {
    runtime: "convex-test; real worker, gzip and storage; no network latency",
    baseline,
    batched,
  };
  if (process.env.EXPORT_BENCHMARK) {
    mkdirSync(".ci-results/125", { recursive: true });
    writeFileSync(".ci-results/125/comparison.json", JSON.stringify(report, null, 2) + "\n");
  }
});
