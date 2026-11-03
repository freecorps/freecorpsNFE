"use node";
import { randomBytes } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { encodeDocumentContent } from "../lib/documentContent";
import { requireReadProof } from "./operationProof";
import { headroomRead, headroomRef, headroomShape } from "./documentHeadroomValues";

/**
 * Headroom proof of the phase B reader (ADR 0010, #642), only in the local backend or the marked
 * disposable preview (`requireReadProof`). `store` writes synthetic content of `size` canonical
 * bytes, past the cap when asked, and `read` runs the reader path of the Node runtime on it.
 * The runner raises `size` until the first failure; the margin is that size over the cap.
 *
 * Worst case on purpose: random base64 (gzip keeps about 3/4 of it) and an emoji in each item,
 * which turns every string two-byte in V8, so the decoded text weighs twice its UTF-8 size.
 */
export const store = internalAction({
  args: { size: v.number(), shape: headroomShape },
  returns: headroomRef,
  handler: async (ctx, { size, shape }) => {
    requireReadProof();
    if (!Number.isSafeInteger(size) || size < 1024 || size > 128 * 1024 * 1024)
      throw new Error("HEADROOM_SIZE");
    const width = shape === "wide" ? Math.ceil(size / 16) : 8 * 1024;
    const result = JSON.stringify({ document: { kind: "synthetic" }, note: "Prova de margem" });
    const items: string[] = [];
    // Each item adds its text plus the escaped JSON around it; stop just short of `size`.
    let total = 64 + result.length * 2;
    for (let position = 0; total < size; position++) {
      const text = `😀${randomBytes(Math.ceil((width * 3) / 4))
        .toString("base64")
        .slice(0, Math.max(1, Math.min(width, size - total - 64)))}`;
      const item = JSON.stringify({ position, decimal: "12345678901234567890.0012300", text });
      items.push(item);
      total += Buffer.byteLength(JSON.stringify(item)) + 1;
    }
    const encoded = await encodeDocumentContent({ result, items }, size + 1024 * 1024);
    const storageId = await ctx.storage.store(
      new Blob([encoded.bytes as Uint8Array<ArrayBuffer>], {
        type: "application/vnd.freecorps.document-content+gzip",
      }),
    );
    return {
      storageId,
      contentSha256: encoded.contentSha256,
      contentSize: encoded.contentSize,
      format: encoded.format,
      storedSize: encoded.storedSize,
      items: items.length,
    };
  },
});

export const read = internalAction({
  args: { ref: headroomRef },
  returns: v.string(),
  handler: async (ctx, { ref }) => {
    requireReadProof();
    return JSON.stringify(
      await headroomRead(ctx.storage, ref, {
        node: process.version,
        v8: process.versions.v8,
        heapLimit: (await import("node:v8")).getHeapStatistics().heap_size_limit,
      }),
    );
  },
});
