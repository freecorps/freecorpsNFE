"use node";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { projectNfeItem } from "@freecorps/contracts";
import { resolveParts } from "./documentContentNode";
import { part, type ContentNeed } from "./lib/documentContentPlan";
import { payloadOf } from "./lib/documentCore";
import { readOriginal } from "./lib/documentOriginalRead";

export const run = internalAction({
  args: { exportId: v.id("documentExports"), sequence: v.number() },
  returns: v.null(),
  handler: runExport,
});

/**
 * Fills the `$content` records of a page (ADR 0010, B5): a version's payload, or the items of a
 * position range, read from the version's content. Other records pass through unchanged.
 */
async function resolveRecords(ctx: ActionCtx, records: string, needs: string) {
  const plan = { renderer: "export", data: null, needs: JSON.parse(needs) as ContentNeed[] };
  if (!plan.needs.length) return records;
  const parts = await resolveParts(ctx.storage, plan);
  return records
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith('{"$content"')) return [line];
      const {
        $content: key,
        $items: range,
        ...record
      } = JSON.parse(line) as {
        $content: string;
        $items?: { versionId: string; from: number; count: number };
      } & Record<string, unknown>;
      if (!range)
        return [JSON.stringify({ ...record, payload: payloadOf(part(parts, key, "result")) })];
      const items = part(parts, key, "items");
      // The checkpoint already moved past `count` items: fewer would skip some for good.
      if (items.length !== range.count) throw new Error("EXPORT_ITEMS_INCOMPLETE");
      return items.map((item, index) =>
        JSON.stringify({
          type: "item",
          versionId: range.versionId,
          position: range.from + index,
          data: projectNfeItem(JSON.parse(item)),
        }),
      );
    })
    .join("\n");
}
export async function runExport(
  ctx: ActionCtx,
  args: { exportId: Id<"documentExports">; sequence: number },
): Promise<null> {
  const start = await ctx.runQuery(internal.exportSource.start, { ...args, now: Date.now() });
  if (!start) return null;
  if (!(await ctx.runMutation(internal.exports.reservePart, args))) return null;
  let checkpoint = start.checkpoint,
    done = false,
    bytes = 0;
  const lines: string[] = [start.header];
  for (let n = 0; n < 40 && bytes < 4 * 1024 * 1024 && !done;) {
    const page = await ctx.runQuery(internal.exportSource.read, {
      ...args,
      now: Date.now(),
      checkpoint,
      maxSteps: 40 - n,
      maxBytes: 4 * 1024 * 1024 - bytes,
    });
    n += page.steps;
    const records = await resolveRecords(ctx, page.records, page.needs);
    if (records) {
      lines.push(records);
      bytes += Buffer.byteLength(records);
    }
    if (page.original) {
      if (page.original.source.size > 10 * 1024 * 1024)
        throw new Error("EXPORT_ORIGINAL_TOO_LARGE");
      // Hot or cold (ADR 0010, decision 8): a cold object is checked by `readOriginal` too.
      const stored = await readOriginal(ctx.storage, page.original.source);
      if (!stored || stored.length !== page.original.source.size)
        throw new Error("EXPORT_ORIGINAL_UNAVAILABLE");
      const original = Buffer.from(stored);
      const sha256 = createHash("sha256").update(original).digest("hex");
      if (sha256 !== page.original.source.sha256) throw new Error("EXPORT_ORIGINAL_HASH_MISMATCH");
      const record = JSON.stringify({
        type: "original",
        artifactId: page.original.artifactId,
        sha256,
        encoding: "base64",
        content: original.toString("base64"),
      });
      lines.push(record);
      bytes += Buffer.byteLength(record);
    }
    checkpoint = page.checkpoint;
    done = page.done;
  }
  lines.push(JSON.stringify({ type: "part-end", final: done }));
  const compressed = gzipSync(lines.join("\n") + "\n");
  if (compressed.length > 20 * 1024 * 1024) throw new Error("EXPORT_LIMIT_EXCEEDED");
  const storageId = await ctx.storage.store(
    new Blob([Uint8Array.from(compressed)], { type: "application/vnd.freecorps.export+gzip" }),
  );
  // A lost response may retry this step. The sequence fence commits one part only.
  await ctx.runMutation(internal.exports.commit, {
    ...args,
    checkpoint,
    done,
    part: {
      storageId,
      sha256: createHash("sha256").update(compressed).digest("hex"),
      size: compressed.length,
    },
  });
  return null;
}
