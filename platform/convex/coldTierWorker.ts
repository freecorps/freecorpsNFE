import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decodeDocumentContent } from "./lib/documentContent";
import { DOCUMENT_CONTENT_MIME } from "./lib/documentValues";
import { coldObjects, sha256Hex } from "./lib/coldObjects";
import { encodeOriginal, ORIGINAL_OBJECT_MIME } from "./lib/documentOriginalRead";

/**
 * Moves the published versions of one claimed note to the cold tier (ADR 0010, phase C1). For
 * each hot blob: read it, check it with the codec, write it to the bucket, read it back and
 * compare the bytes, then point the version at the object (`coldTier.attach`). The key is fixed
 * by organization, version and content hash, so a repeated action writes the same bytes to the
 * same key. Then the note's XML originals, the same way (`coldTier.attachOriginal`). Any failure
 * gives the claim back; a version or an original already moved stays cold. With `runId`, the
 * passage is the cold stage of that rehydration (ADR 0010, C2), driven by
 * `coldArchiveRehydration.coldStep`, under the same checks.
 */
export const move = internalAction({
  args: {
    documentId: v.id("fiscalDocuments"),
    claimedAt: v.number(),
    runId: v.optional(v.id("coldArchiveRuns")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const claim = { documentId: args.documentId, claimedAt: args.claimedAt };
    const plan = await ctx.runQuery(internal.coldTier.movePlan, args);
    if (plan.state === "skip") {
      await ctx.runMutation(internal.coldTier.giveBack, args);
      return plan.reason;
    }
    try {
      const bucket = coldObjects();
      for (const version of plan.versions) {
        const blob = await ctx.storage.get(version.storageId);
        if (!blob) throw new Error("COLD_TIER_BLOB_MISSING");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // Throws on a damaged blob: only content that reads back as phase B wrote it moves.
        await decodeDocumentContent(bytes, version);
        const key = version.objectKey;
        // The intent goes first: a write whose attach never comes is collected as an orphan.
        if (!(await ctx.runMutation(internal.coldTier.intend, { ...claim, objectKey: key })))
          throw new Error("COLD_TIER_INTENT_REFUSED");
        await bucket.put(key, bytes, DOCUMENT_CONTENT_MIME);
        const back = await bucket.get(key);
        const objectSha256 = await sha256Hex(bytes);
        if (!back || (await sha256Hex(back)) !== objectSha256)
          throw new Error("COLD_TIER_READBACK_MISMATCH");
        const attached = await ctx.runMutation(internal.coldTier.attach, {
          ...args,
          versionId: version.versionId,
          storageId: version.storageId,
          objectKey: key,
          objectSha256,
          objectSize: bytes.length,
        });
        // The claim or the version changed meanwhile; the object, unreferenced, is collected
        // with its intent (`coldTier.orphans`).
        if (!attached) throw new Error("COLD_TIER_ATTACH_REFUSED");
      }
      // The XML originals (ADR 0010, decision 8): the raw bytes, checked by their hash, go as
      // a deterministic gzip, so a repeated action writes the same object to the same key.
      for (const original of plan.originals) {
        const blob = await ctx.storage.get(original.storageId);
        if (!blob) throw new Error("COLD_TIER_ORIGINAL_MISSING");
        const raw = new Uint8Array(await blob.arrayBuffer());
        if (raw.length !== original.size || (await sha256Hex(raw)) !== original.sha256)
          throw new Error("COLD_TIER_ORIGINAL_MISMATCH");
        const object = await encodeOriginal(raw);
        const key = original.objectKey;
        if (!(await ctx.runMutation(internal.coldTier.intend, { ...claim, objectKey: key })))
          throw new Error("COLD_TIER_INTENT_REFUSED");
        await bucket.put(key, object.bytes, ORIGINAL_OBJECT_MIME);
        const back = await bucket.get(key);
        if (!back || (await sha256Hex(back)) !== object.objectSha256)
          throw new Error("COLD_TIER_READBACK_MISMATCH");
        const attached = await ctx.runMutation(internal.coldTier.attachOriginal, {
          ...args,
          artifactId: original.artifactId,
          storageId: original.storageId,
          objectKey: key,
          objectSha256: object.objectSha256,
          objectSize: object.objectSize,
        });
        if (!attached) throw new Error("COLD_TIER_ATTACH_REFUSED");
      }
    } catch (error) {
      console.warn(
        `cold tier: ${args.documentId} stays hot: ${error instanceof Error ? error.message : "unknown"}`,
      );
      await ctx.runMutation(internal.coldTier.giveBack, args);
      return "failed";
    }
    return await ctx.runMutation(internal.coldTier.finish, args);
  },
});

/** Deletes the objects the fiscal guard queued when it purged cold versions. */
export const collect = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.runQuery(internal.coldTier.deletions, {});
    const orphans = await ctx.runMutation(internal.coldTier.orphans, {});
    const bucket = coldObjects();
    const remove = async (key: string) => {
      try {
        await bucket.delete(key);
        return true;
      } catch {
        return false;
      }
    };
    let done = 0;
    for (const row of rows) {
      const ok = await remove(row.objectKey);
      await ctx.runMutation(internal.coldTier.deleted, { id: row.id, failed: !ok });
      if (ok) done++;
    }
    for (const orphan of orphans) {
      const ok = await remove(orphan.objectKey);
      await ctx.runMutation(internal.coldTier.orphanDone, { id: orphan.id, deleted: ok });
      if (ok) done++;
    }
    if (rows.length === 32 || orphans.length === 32)
      await ctx.scheduler.runAfter(60_000, internal.coldTierWorker.collect, {});
    return done;
  },
});
