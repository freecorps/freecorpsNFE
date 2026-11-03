"use node";
import { createHash } from "node:crypto";
import { v } from "convex/values";
import { renderDanfe } from "@freecorps/fiscal-nfe/danfe";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireReadProof } from "./operationProof";
import { readOriginal } from "../lib/documentOriginalRead";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The two Node readers of a note's original in the cold-tier proof (#689): the DANFE, rendered by
 * the generator `danfeWorker.render` uses, and the export's `original` record, built as
 * `exportWorker.runExport` builds it. Both read through `readOriginal`, hot or cold, and only
 * their hashes come back, to compare before and after the passage.
 */
export const render = internalAction({
  args: { documentId: v.id("fiscalDocuments") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireReadProof();
    const { original, artifactId } = await ctx.runQuery(internal.testing.coldTierProof.note, args);
    const stored = await readOriginal(ctx.storage, original);
    if (!stored || stored.length !== original.size || sha256(stored) !== original.sha256)
      throw new Error("ORIGINAL_UNAVAILABLE");
    const pdf = await renderDanfe(stored);
    const record = JSON.stringify({
      type: "original",
      artifactId,
      sha256: sha256(stored),
      encoding: "base64",
      content: Buffer.from(stored).toString("base64"),
    });
    return JSON.stringify({
      danfeSha256: sha256(pdf),
      danfeBytes: pdf.byteLength,
      exportRecordSha256: sha256(record),
    });
  },
});
