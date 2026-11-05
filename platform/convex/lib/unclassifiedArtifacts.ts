import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { linkOriginal } from "./originalStore";

/**
 * What an artifact without a document came from: its import file, the operation that read it and
 * the version that operation wrote. A succeeded NFS-e batch is the batch file of documents that
 * were recognized one by one, not a refusal: it is not listed nor counted.
 *
 * `documentArtifacts.nfseBatch` keeps that answer on the artifact, so the count reads only the
 * index (`documents.unclassifiedCount`, #44). The answer changes only when the operation the file
 * points to succeeds or the pointer moves to another one: `syncNfseBatch` runs at each of these
 * (`importProcessing.published`, `reprocessArtifact`, `reprocessDocument`, `refusalReprocess`),
 * and `unclassifiedMigration.markNfseBatches` marked the batches imported before the field.
 */
export async function unclassifiedOrigin(
  ctx: Pick<QueryCtx, "db">,
  artifact: Doc<"documentArtifacts">,
) {
  const file = artifact.fileId ? await ctx.db.get("importFiles", artifact.fileId) : null;
  const operation =
    file?.processingOperationId ?? file?.operationId ?? artifact.processingOperationId;
  const op = operation ? await ctx.db.get("operations", operation) : null;
  const version = operation
    ? await ctx.db
        .query("documentVersions")
        .withIndex("by_operationId_entryIndex", (q) =>
          q.eq("operationId", operation).eq("entryIndex", undefined),
        )
        .unique()
    : null;
  const listed = !(version?.code === "NFSE_BATCH_IMPORTED" && op?.state === "succeeded");
  return { file, op, version, listed };
}

/**
 * Writes on the artifact what `unclassifiedOrigin` answers now: `nfseBatch` on an accepted batch,
 * absent on anything else without a document. A batch is always an imported file: a note of it
 * has its own document, and a captured original never was one, so both are left alone. Patches
 * only when the answer changed, so an ordinary file costs no write.
 */
export async function syncNfseBatch(ctx: MutationCtx, artifactId: Id<"documentArtifacts">) {
  const artifact = await ctx.db.get("documentArtifacts", artifactId);
  if (!artifact?.fileId || artifact.documentId || artifact.parentArtifactId) return;
  if (artifact.source !== "imported-xml") return;
  const batch = !(await unclassifiedOrigin(ctx, artifact)).listed;
  if (batch !== !!artifact.nfseBatch)
    await linkOriginal(ctx, artifact._id, {
      nfseBatch: batch ? true : undefined,
    });
}
