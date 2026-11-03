"use node";
import { getHeapStatistics } from "node:v8";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type QueryCtx } from "../_generated/server";
import {
  encodeDocumentContent,
  MAX_DOCUMENT_CONTENT_BYTES,
  decodeDocumentContent,
  type DocumentContent,
  type DocumentContentRef,
} from "../lib/documentContent";

// Instantaneous samples, not peaks. RSS is process-wide; fields overlap.
function sample(phase: string) {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    phase,
    ...memory,
    usedHeapSize: heap.used_heap_size,
    heapSizeLimit: heap.heap_size_limit,
    externalMemory: heap.external_memory,
  };
}

export const read = internalAction({
  args: { versionId: v.id("documentVersions"), inline: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const samples = [sample("entry")];
    const resolved: {
      storageId?: Id<"_storage">;
      ref: DocumentContentRef;
      content: DocumentContent;
      metrics: Awaited<ReturnType<QueryCtx["meta"]["getTransactionMetrics"]>>;
    } = JSON.parse(await ctx.runQuery(internal.testing.documentReadProof.resolve, args));
    samples.push(sample("resolved"));
    let content: DocumentContent = resolved.content;
    let storedSize = 0;
    if (resolved.storageId) {
      const blob = await ctx.storage.get(resolved.storageId);
      if (!blob) throw new Error("BLOB_MISSING");
      samples.push(sample("storage"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      samples.push(sample("buffer"));
      storedSize = bytes.length;
      content = await decodeDocumentContent(bytes, resolved.ref);
      samples.push(sample("decoded"));
    }
    // Full projection crosses the action boundary and is parsed/compared by the caller.
    const value = {
      source: resolved.storageId ? "blob" : "inline",
      storedSize,
      metrics: resolved.metrics,
      projection: {
        result: JSON.parse(content.result),
        items: content.items.map((item) => JSON.parse(item)),
        ...(content.fiscalEvidence === undefined
          ? {}
          : { fiscalEvidence: JSON.parse(content.fiscalEvidence) }),
        ...(content.snapshot === undefined ? {} : { snapshot: JSON.parse(content.snapshot) }),
      },
    };
    samples.push(sample("projected"));
    const payload = JSON.stringify(value);
    samples.push(sample("stringified"));
    return JSON.stringify({
      payload,
      samples,
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
      },
    });
  },
});

export const calibrate = internalAction({
  args: { versionId: v.id("documentVersions") },
  returns: v.string(),
  handler: async (ctx, { versionId }): Promise<string> => {
    // Query enforces local environment and synthetic scope before any fixture allocation.
    await ctx.runQuery(internal.testing.documentReadProof.resolve, { versionId, inline: false });
    const before = sample("before");
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(73);
    const afterBuffer = sample("buffer");
    const objects = Array.from({ length: 100000 }, (_, i) => ({ i, text: `synthetic-${i}` }));
    const afterObjects = sample("objects");
    return JSON.stringify({
      before,
      afterBuffer,
      afterObjects,
      allocatedBytes: bytes.byteLength,
      objects: objects.length,
      checksum: bytes[0] + objects[99999].i,
    });
  },
});

// Bounded codec/projection adversaries. No claim about storage or SDK coverage here.
export const adversaries = internalAction({
  args: { versionId: v.id("documentVersions") },
  returns: v.string(),
  handler: async (ctx, { versionId }): Promise<string> => {
    await ctx.runQuery(internal.testing.documentReadProof.resolve, { versionId, inline: false });
    const results = [];
    for (const kind of ["cap", "objects", "unicode"] as const) {
      const empty = { result: JSON.stringify(""), items: [] as string[] };
      const overhead = (await encodeDocumentContent(empty)).contentSize;
      const content =
        kind === "cap"
          ? { ...empty, result: JSON.stringify("x".repeat(MAX_DOCUMENT_CONTENT_BYTES - overhead)) }
          : {
              ...empty,
              result: JSON.stringify(
                kind === "objects"
                  ? Array.from({ length: 100000 }, (_, i) => ({ i, value: "0.0012300" }))
                  : '\u6f22\u{1f600}\\"\n'.repeat(100000),
              ),
            };
      const encoded = await encodeDocumentContent(content);
      const samples = [sample("encoded")];
      const decoded = await decodeDocumentContent(encoded.bytes, encoded);
      samples.push(sample("decoded"));
      const projected = JSON.parse(decoded.result);
      samples.push(sample("projected"));
      if (JSON.stringify(projected) !== content.result) throw new Error("ADVERSARY_MISMATCH");
      let overCapRejected = false;
      if (kind === "cap") {
        if (encoded.contentSize !== MAX_DOCUMENT_CONTENT_BYTES) throw new Error("CAP_MISMATCH");
        try {
          await decodeDocumentContent(encoded.bytes, {
            ...encoded,
            contentSize: MAX_DOCUMENT_CONTENT_BYTES + 1,
          });
        } catch (error) {
          overCapRejected = String(error).includes("DOCUMENT_CONTENT_TOO_LARGE");
        }
        if (!overCapRejected) throw new Error("CAP_NOT_ENFORCED");
      }
      results.push({ kind, contentSize: encoded.contentSize, samples, overCapRejected });
    }
    return JSON.stringify(results);
  },
});
