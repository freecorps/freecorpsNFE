import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { parseReferencePayload } from "../../lib/reference-dataset";
import type { Id } from "./_generated/dataModel";

/** Operator-only ingestion. No URLs supplied by clients, credentials, or automatic publication. */
export const stage = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.id("referenceVersions"),
  handler: async (ctx, args): Promise<Id<"referenceVersions">> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob || blob.size > 8_000_000) throw new Error("REFERENCE_FILE_UNAVAILABLE");
    const { manifest, entries } = await parseReferencePayload(await blob.text());
    const versionId = await ctx.runMutation(internal.referenceImport.begin, {
      manifest: JSON.stringify(manifest),
      storageId: args.storageId,
    });
    for (let offset = 0; offset < entries.length; offset += 100)
      await ctx.runMutation(internal.referenceImport.append, {
        versionId,
        offset,
        entries: entries.slice(offset, offset + 100),
      });
    await ctx.runMutation(internal.referenceImport.finish, { versionId });
    return versionId;
  },
});
