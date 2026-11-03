import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { requireReadProof } from "./operationProof";
import { headroomRead, headroomRef } from "./documentHeadroomValues";

/** The same reader path as `documentHeadroomNode.read`, in the default (V8) runtime. */
export const read = internalAction({
  args: { ref: headroomRef },
  returns: v.string(),
  handler: async (ctx, { ref }) => {
    requireReadProof();
    return JSON.stringify(await headroomRead(ctx.storage, ref, { runtime: "convex-v8" }));
  },
});

/**
 * Removes a blob of the proof; the runner calls it after every size, passed or failed. A file some
 * version holds is never a proof blob, so it is refused.
 */
export const remove = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { storageId }) => {
    requireReadProof();
    const holder = await ctx.db
      .query("documentVersions")
      .withIndex("by_contentStorageId", (q) => q.eq("contentStorageId", storageId))
      .first();
    if (holder) throw new Error("HEADROOM_SCOPE");
    await ctx.storage.delete(storageId);
    return null;
  },
});
