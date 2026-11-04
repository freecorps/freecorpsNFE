import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { inCustody } from "./lib/coldArchiveCore";
import { syncNfseBatch } from "./lib/unclassifiedArtifacts";

const progress = v.object({
  scanned: v.number(),
  marked: v.number(),
  skipped: v.number(),
  isDone: v.boolean(),
});

/**
 * Marks `nfseBatch` on the accepted ABRASF NFS-e batches imported before the field (#44), so
 * `documents.unclassifiedCount` and `documents.unclassified` leave them out by the index alone.
 * Run once after the rollout on each deployment, with `{"cursor":null}`; it goes through the
 * artifacts 100 at a time, each page scheduling the next. Safe to repeat and to run beside new
 * traffic: it writes only what the rule of `lib/unclassifiedArtifacts.ts` answers, which the
 * flows that change that answer keep up to date after the rollout. Until it ends, a batch not yet
 * marked counts as a file without a document, but stays out of the list.
 *
 * An organization in the cold archive's custody (ADR 0009) is skipped and counted in `skipped`:
 * its rows cannot change while the package is made or restored. Its batches come back unmarked
 * from a package made before the field, so the migration runs again after each restoration.
 */
export const markNfseBatches = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: progress,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("documentArtifacts")
      .paginate({ cursor: args.cursor, numItems: 100 });
    let marked = 0,
      skipped = 0;
    const custody = new Map<Id<"organizations">, boolean>();
    for (const artifact of page.page) {
      // An entry of a batch has its note's document; a marked batch is done.
      if (artifact.documentId || artifact.parentArtifactId || artifact.nfseBatch) continue;
      if (!custody.has(artifact.organizationId))
        custody.set(artifact.organizationId, await inCustody(ctx, artifact.organizationId));
      if (custody.get(artifact.organizationId)) {
        skipped++;
        continue;
      }
      await syncNfseBatch(ctx, artifact._id);
      if ((await ctx.db.get("documentArtifacts", artifact._id))?.nfseBatch) marked++;
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.unclassifiedMigration.markNfseBatches, {
        cursor: page.continueCursor,
      });
    const result = { scanned: page.page.length, marked, skipped, isDone: page.isDone };
    console.info(JSON.stringify({ type: "nfse_batch_mark", ...result }));
    return result;
  },
});
