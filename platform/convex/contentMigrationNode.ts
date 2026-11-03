"use node";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { readStoredContent } from "./lib/documentContentRead";

/** Versions per audit step; each is one query and, with a blob, one storage read. */
const AUDIT_BATCH = 20;

/**
 * One audit step of B7 (`contentMigration.ts`): for each version, the blob is read through the
 * codec (size, hash and canonical form) and its hash compared with the inline content encoded
 * now. Counts:
 *
 * - `verified`: equal, and the version gets `contentVerifiedAt`;
 * - `inlineOnly`: no blob, a normal state (over the cap, item gaps, archived when written);
 * - `cleaned`: the inline copy is already gone (after B8) and the blob reads;
 * - `missing`, `corrupt`, `mismatch`, `unverified`: the blob is gone, damaged, different from
 *   the inline content, or the inline content cannot be encoded to compare. Each blocks B8.
 */
export const auditStep = internalAction({
  args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { cursor, generation }) => {
    const counts: Record<string, number> = {};
    const add = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
    const verified: { id: Id<"documentVersions">; contentSha256: string }[] = [];
    // A blob that no longer reads, or differs, loses an earlier verification (the writer's).
    const failed: Id<"documentVersions">[] = [];
    let at = cursor,
      isDone = false;
    try {
      for (let n = 0; n < AUDIT_BATCH && !isDone; n++) {
        const page = await ctx.runQuery(internal.contentMigration.auditPage, { cursor: at });
        at = page.cursor;
        isDone = page.isDone;
        const version = page.version;
        if (!version) continue;
        add("scanned");
        if (!version.published) {
          add("unpublished");
          continue;
        }
        if (version.partial) {
          add("corrupt");
          failed.push(version.id);
          continue;
        }
        if (!version.ref) {
          add("inlineOnly");
          continue;
        }
        try {
          await readStoredContent(ctx.storage, version.ref, version.ref);
        } catch (error) {
          const code = error instanceof ConvexError ? (error.data as { code?: string }).code : null;
          if (code === "BLOB_MISSING") add("missing");
          else if (code === "DOCUMENT_CONTENT_CORRUPT") add("corrupt");
          else throw error;
          failed.push(version.id);
          continue;
        }
        if (version.inlineGone) add("cleaned");
        else if (!version.inline) {
          add("unverified");
          failed.push(version.id);
        } else if (
          version.inline.contentSha256 !== version.ref.contentSha256 ||
          version.inline.contentSize !== version.ref.contentSize
        ) {
          add("mismatch");
          failed.push(version.id);
        } else {
          verified.push({ id: version.id, contentSha256: version.ref.contentSha256 });
          add("verified");
        }
      }
    } catch (error) {
      await ctx.runMutation(internal.contentMigration.fail, {
        kind: "audit",
        generation,
        from: cursor,
        error: error instanceof Error ? error.message : "AUDIT_STEP_FAILED",
      });
      return null;
    }
    await ctx.runMutation(internal.contentMigration.auditProgress, {
      generation,
      from: cursor,
      cursor: at!,
      isDone,
      counts,
      verified,
      failed,
    });
    return null;
  },
});
