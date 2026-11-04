import { insertFiscal, patchFiscal } from "./lib/capacityCore";
import { readStoredContent } from "./lib/documentContentRead";
import {
  clearInlineContent,
  markVerified,
  stagedVersionChanged,
} from "./lib/documentContentCleanup";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { activeClaim, executionAllowed } from "./lib/operationCore";
import { claimFields } from "./lib/operationValues";
import { deny, requireMembership } from "./lib/organizationAccess";
import { ensureConsoleProject } from "./lib/projectAccess";
import { getFile } from "./lib/importCore";
import { importTask, PROCESSOR_VERSION } from "./lib/importValues";
import schema from "./schema";
import { requestProjection, recordEvidence } from "./documentProjection";
import { documentEvent, completeImport } from "./lib/webhookOutbox";
import { recordUsage } from "./lib/usageCore";
import { releaseBatchNotes, releasePendingNote } from "./lib/importCore";
import { firstId } from "./lib/coldArchiveOrigin";
import { syncNfseBatch } from "./lib/unclassifiedArtifacts";
import { encodeDocumentContent, type DocumentContentError } from "./lib/documentContent";
import {
  attachVersionContent,
  requestContentWindow,
  scheduleVersionContent,
  writerRetryDelay,
  versionContentSource,
} from "./lib/documentContentWriter";
import { DOCUMENT_CONTENT_MIME } from "./lib/documentValues";

export const load = internalMutation({
  args: claimFields,
  returns: v.union(
    v.null(),
    v.object({
      artifact: schema.doc("documentArtifacts"),
      company: schema.doc("companies"),
      evaluatedAt: v.string(),
      processorVersion: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || !(await executionAllowed(ctx, op))) return null;
    const request = JSON.parse(op.request) as {
      artifactId: Id<"documentArtifacts">;
      processorVersion: string;
    };
    const artifact = await ctx.db.get("documentArtifacts", request.artifactId);
    if (
      !artifact ||
      artifact.organizationId !== op.organizationId ||
      artifact.companyId !== op.companyId ||
      artifact.environment !== op.environment
    )
      return deny("NOT_FOUND");
    const company = (await ctx.db.get("companies", op.companyId))!;
    return {
      artifact,
      company,
      evaluatedAt: new Date(op.createdAt).toISOString(),
      processorVersion: request.processorVersion,
    };
  },
});
export const stage = internalMutation({
  args: {
    ...claimFields,
    artifactId: v.id("documentArtifacts"),
    fiscalKey: v.union(v.string(), v.null()),
    code: v.string(),
    kind: v.string(),
    completeness: v.number(),
    schema: v.union(v.string(), v.null()),
    parserVersion: v.string(),
    normalizerVersion: v.union(v.string(), v.null()),
    processorVersion: v.string(),
    result: v.string(),
    outputHash: v.string(),
    fiscalEvidence: v.optional(v.string()),
    fiscalFingerprint: v.optional(v.string()),
    itemCount: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({ versionId: v.id("documentVersions"), writtenItems: v.number() }),
    v.object({ code: v.literal("PROCESSING_CHANGED") }),
  ),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || !(await executionAllowed(ctx, op))) return null;
    const request = JSON.parse(op.request) as { artifactId: string; processorVersion: string };
    if (
      request.artifactId !== args.artifactId ||
      request.processorVersion !== args.processorVersion
    )
      return deny("INVALID_REQUEST");
    const existing = await ctx.db
      .query("documentVersions")
      .withIndex("by_operationId_entryIndex", (q) =>
        q.eq("operationId", op._id).eq("entryIndex", undefined),
      )
      .unique();
    if (existing) {
      // ADR 0010, B8: a version whose inline copy went compares by hash, never an absent field
      // against the new text. `outputHash` covers `result` and the items; the evidence compares
      // with `fiscalEvidenceSha256`, and a cleared version takes no late evidence.
      const cleared = existing.result === undefined;
      if (await stagedVersionChanged(existing, args))
        return { code: "PROCESSING_CHANGED" as const };
      if (!cleared && existing.fiscalEvidence === undefined && args.fiscalEvidence)
        await patchFiscal(ctx, "documentVersions", existing._id, {
          fiscalEvidence: args.fiscalEvidence,
          ...(args.fiscalFingerprint ? { fiscalFingerprint: args.fiscalFingerprint } : {}),
        });
      return { versionId: existing._id, writtenItems: existing.writtenItems };
    }
    const artifact = (await ctx.db.get("documentArtifacts", args.artifactId))!;
    let documentId: Id<"fiscalDocuments"> | undefined;
    if (args.fiscalKey) {
      const doc = await ctx.db
        .query("fiscalDocuments")
        .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
          q
            .eq("organizationId", op.organizationId)
            .eq("companyId", op.companyId)
            .eq("environment", op.environment)
            .eq("model", "55")
            .eq("fiscalKey", args.fiscalKey!),
        )
        .unique();
      documentId =
        doc?._id ??
        (await insertFiscal(ctx, "fiscalDocuments", {
          organizationId: op.organizationId,
          companyId: op.companyId,
          environment: op.environment,
          model: "55",
          fiscalKey: args.fiscalKey,
          completeness: -1,
          createdAt: Date.now(),
        }));
      if (artifact.documentId && artifact.documentId !== documentId)
        return deny("DOCUMENT_CONFLICT");
      await patchFiscal(ctx, "documentArtifacts", artifact._id, { documentId });
    }
    const versionId = await insertFiscal(ctx, "documentVersions", {
      artifactId: artifact._id,
      operationId: op._id,
      ...(documentId ? { documentId } : {}),
      state: "staging",
      code: args.code,
      kind: args.kind,
      completeness: args.completeness,
      schema: args.schema,
      parserVersion: args.parserVersion,
      normalizerVersion: args.normalizerVersion,
      processorVersion: args.processorVersion,
      result: args.result,
      outputHash: args.outputHash,
      ...(args.fiscalEvidence ? { fiscalEvidence: args.fiscalEvidence } : {}),
      ...(args.fiscalFingerprint ? { fiscalFingerprint: args.fiscalFingerprint } : {}),
      itemCount: args.itemCount,
      writtenItems: 0,
      createdAt: Date.now(),
    });
    return { versionId, writtenItems: 0 };
  },
});
export const items = internalMutation({
  args: {
    ...claimFields,
    versionId: v.id("documentVersions"),
    offset: v.number(),
    items: v.array(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const op = await activeClaim(ctx, args);
    if (!op || !(await executionAllowed(ctx, op))) return false;
    const version = await ctx.db.get("documentVersions", args.versionId);
    if (
      !version ||
      version.operationId !== op._id ||
      version.state !== "staging" ||
      args.offset !== version.writtenItems ||
      args.items.length > 25 ||
      args.offset + args.items.length > version.itemCount
    )
      return deny("OPERATION_CONFLICT");
    for (const [index, data] of args.items.entries())
      await insertFiscal(ctx, "documentItems", {
        versionId: version._id,
        position: args.offset + index,
        data,
      });
    await patchFiscal(ctx, "documentVersions", version._id, {
      writtenItems: args.offset + args.items.length,
    });
    return true;
  },
});
export const checkpoint = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op = await ctx.db.get("operations", args.operationId);
    const version = await ctx.db
      .query("documentVersions")
      .withIndex("by_operationId_entryIndex", (q) =>
        q.eq("operationId", args.operationId).eq("entryIndex", undefined),
      )
      .unique();
    if (
      !op ||
      op.state !== "running" ||
      op.stage !== "response" ||
      !version ||
      version.writtenItems !== version.itemCount
    )
      return deny("OPERATION_CONFLICT");
    if (version.state === "complete") return null;
    await patchFiscal(ctx, "documentVersions", version._id, {
      state: "complete",
      completedAt: Date.now(),
    });
    const entries = await ctx.db
      .query("documentVersions")
      .withIndex("by_parentVersionId", (q) => q.eq("parentVersionId", version._id))
      .take(21);
    if (entries.length > 20) return deny("OPERATION_CONFLICT");
    for (const entry of entries)
      await patchFiscal(ctx, "documentVersions", entry._id, {
        state: "complete",
        completedAt: Date.now(),
      });
    await ctx.db.patch("operations", op._id, {
      response: JSON.stringify({
        versionId: version._id,
        documentId: version.documentId ?? null,
        code: version.code,
        itemCount: version.itemCount,
      }),
    });
    return null;
  },
});
export const published = internalMutation({
  args: { operationId: v.id("operations") },
  returns: v.null(),
  handler: async (ctx, { operationId }) => {
    const operation = await ctx.db.get("operations", operationId);
    const version = await ctx.db
      .query("documentVersions")
      .withIndex("by_operationId_entryIndex", (q) =>
        q.eq("operationId", operationId).eq("entryIndex", undefined),
      )
      .unique();
    if (operation?.state !== "succeeded" || version?.state !== "complete")
      return deny("OPERATION_CONFLICT");
    const entries = await ctx.db
      .query("documentVersions")
      .withIndex("by_parentVersionId", (q) => q.eq("parentVersionId", version._id))
      .take(21);
    if (entries.length > 20 || entries.some((entry) => entry.state !== "complete"))
      return deny("OPERATION_CONFLICT");
    for (const entry of entries) await publishVersion(ctx, operation, entry);
    await publishVersion(ctx, operation, version);
    const published = (await ctx.db.get("documentVersions", version._id))!;
    await ctx.db.patch("operations", operation._id, {
      response: JSON.stringify({
        versionId: version._id,
        documentId: version.documentId ?? null,
        code: published.code,
        itemCount: version.itemCount,
      }),
    });
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    // An accepted NFS-e batch stays without a document: marked, it leaves the files without a
    // recognized document (`lib/unclassifiedArtifacts.ts`).
    await syncNfseBatch(ctx, artifact._id);
    if (artifact.fileId) {
      const file = (await ctx.db.get("importFiles", artifact.fileId))!;
      // The published versions above counted the file's real notes; the provisional one ends, and
      // so do the notes held by an NFS-e batch staged before that import was retired.
      await releasePendingNote(ctx, operation.organizationId, file._id);
      await releaseBatchNotes(ctx, operation.organizationId, operation._id);
      await completeImport(ctx, file.importId);
    }
    return null;
  },
});
export async function reprocessArtifact(
  ctx: MutationCtx,
  fileId: Id<"importFiles">,
  key: string,
  keyHash?: string,
): Promise<{ operationId: Id<"operations">; reused: boolean }> {
  const { file, batch } = await getFile(ctx, fileId, keyHash);
  if (file.state !== "accepted") return deny("OPERATION_CONFLICT");
  const artifact = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_fileId", (q) => q.eq("fileId", fileId))
    .unique();
  if (!artifact) return deny("NOT_FOUND");
  // An accepted ABRASF NFS-e batch has an artifact per invoice. Its parser is retired, so a new
  // version would read the file as refused while its documents stay: the batch is read-only.
  const entry = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_parentArtifactId_entryIndex", (q) => q.eq("parentArtifactId", artifact._id))
    .first();
  if (entry) return deny("OPERATION_CONFLICT");
  // A key reprocesses in its project; a person, in the organization's console project.
  const projectId = keyHash
    ? batch.projectId
    : await ensureConsoleProject(
        ctx,
        (await requireMembership(ctx, batch.organizationId)).membership,
      );
  const result: { operationId: Id<"operations">; reused: boolean } = await ctx.runMutation(
    internal.operations.reserve,
    {
      organizationId: batch.organizationId,
      projectId,
      companyId: batch.companyId,
      environment: batch.environment,
      ...(keyHash ? { keyHash } : {}),
      key,
      task: { ...importTask, name: "documents.reprocess" },
      request: JSON.stringify({ artifactId: artifact._id, processorVersion: PROCESSOR_VERSION }),
      // The caller names the file, not the artifact: the hash compares the artifact by its first
      // ID, so a repetition after a rehydration keeps the hash of before (ADR 0009, §6). Without a
      // rehydration it is the request itself.
      idempotencyRequest: JSON.stringify({
        artifactId: firstId(artifact),
        processorVersion: PROCESSOR_VERSION,
      }),
    },
  );
  // The batch shows only work of its own project: an integration never sees a console operation.
  if (!result.reused && projectId === batch.projectId) {
    await ctx.db.patch("importFiles", file._id, { processingOperationId: result.operationId });
    // A moved pointer can take a batch out of its accepted outcome (`lib/unclassifiedArtifacts`).
    await syncNfseBatch(ctx, artifact._id);
  }
  return result;
}
export const reprocess = mutation({
  args: { fileId: v.id("importFiles"), key: v.string() },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: (ctx, args) => reprocessArtifact(ctx, args.fileId, args.key),
});

async function publishVersion(
  ctx: MutationCtx,
  operation: Doc<"operations">,
  version: Doc<"documentVersions">,
) {
  if (version.publishedAt === undefined) {
    let code = version.code;
    if (version.documentId) {
      const doc = (await ctx.db.get("fiscalDocuments", version.documentId))!;
      // One unit per document, by its first ID (ADR 0009, §5, item 5): a document rehydrated
      // under a new ID that publishes again is not counted twice.
      await recordUsage(
        ctx,
        operation.organizationId,
        operation.environment,
        "documents",
        firstId(doc),
        1,
        true,
      );
      const current = doc.publishedVersionId
        ? await ctx.db.get("documentVersions", doc.publishedVersionId)
        : null;
      const oldArtifact = current
        ? await ctx.db.get("documentArtifacts", current.artifactId)
        : null;
      const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
      if (
        !current ||
        version.completeness > doc.completeness ||
        (current.artifactId === version.artifactId && version.createdAt >= current.createdAt)
      ) {
        await patchFiscal(ctx, "fiscalDocuments", doc._id, {
          publishedVersionId: version._id,
          completeness: version.completeness,
        });
        if (!current || current.outputHash !== version.outputHash)
          await documentEvent(
            ctx,
            doc,
            current ? "document.updated" : "document.received",
            `version:${version._id}`,
          );
      } else if (
        (oldArtifact?.entrySha256 ?? oldArtifact?.sha256) ===
        (artifact.entrySha256 ?? artifact.sha256)
      )
        code = "DUPLICATE";
      else if (
        version.completeness === doc.completeness &&
        (version.kind === "invoice" || version.kind === "service-invoice")
      )
        code = "ARTIFACT_CONFLICT";
    }
    await patchFiscal(ctx, "documentVersions", version._id, { publishedAt: Date.now(), code });
    if (version.documentId && version.fiscalEvidence && version.fiscalFingerprint)
      await recordEvidence(ctx, version, version.fiscalEvidence, version.fiscalFingerprint);
    else if (version.documentId && version.kind !== "service-invoice")
      await patchFiscal(ctx, "fiscalDocuments", version.documentId, { evidenceBackfill: true });
    if (version.documentId) await requestProjection(ctx, version.documentId);
    await scheduleVersionContent(ctx, version._id);
  }
}

const documentContent = v.object({
  result: v.string(),
  fiscalEvidence: v.optional(v.string()),
  items: v.array(v.string()),
  snapshot: v.optional(v.string()),
});
export const contentSource = internalQuery({
  args: { versionId: v.id("documentVersions") },
  returns: v.union(
    v.null(),
    v.object({
      skip: v.union(v.literal("TOO_LARGE"), v.literal("ITEM_POSITIONS"), v.literal("INLINE_GONE")),
    }),
    documentContent,
  ),
  handler: (ctx, { versionId }) => versionContentSource(ctx, versionId),
});
/**
 * Stores the content blob of a published version (ADR 0010, B4). A crash between the store and
 * the attach leaves a blob with the content MIME that no version holds; the storage sweep of
 * `importUpload.ts` deletes it once older than the upload window.
 */
export const storeContent = internalAction({
  args: { versionId: v.id("documentVersions"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { versionId, attempt }) => {
    try {
      return await storeVersionContent(ctx, versionId, attempt);
    } catch (error) {
      // A transient failure (a write conflict on the organization's capacity, storage): the pool
      // does not retry the writer, so it queues itself again, spread out. Every step
      // repeats safely: a version that already holds a blob is skipped, and an unattached blob
      // goes to the sweep. Past the last try the version stays inline, a normal state that the
      // backfill (B7) picks up.
      const delay = writerRetryDelay(attempt);
      if (delay !== null) await scheduleVersionContent(ctx, versionId, attempt + 1, delay);
      throw error;
    }
  },
});
async function storeVersionContent(
  ctx: ActionCtx,
  versionId: Id<"documentVersions">,
  attempt: number,
): Promise<null> {
  const source = await ctx.runQuery(internal.importProcessing.contentSource, { versionId });
  if (!source) return null;
  if ("skip" in source) {
    // Over the cap or with item gaps: the version stays inline-only, and the import stands.
    console.warn(`document content of ${versionId} stays inline: ${source.skip}`);
    return null;
  }
  let encoded: Awaited<ReturnType<typeof encodeDocumentContent>>;
  try {
    encoded = await encodeDocumentContent(source);
  } catch (error) {
    const data = (error as { data?: DocumentContentError }).data;
    if (data?.code !== "DOCUMENT_CONTENT_TOO_LARGE") throw error;
    console.warn(`document content of ${versionId} stays inline: TOO_LARGE`);
    return null;
  }
  await ctx.runMutation(internal.importProcessing.contentWindow, {});
  const storageId = await ctx.storage.store(
    new Blob([encoded.bytes as Uint8Array<ArrayBuffer>], { type: DOCUMENT_CONTENT_MIME }),
  );
  // A failure here may follow a commit; the blob is left to the sweep, never deleted blindly.
  const outcome = await ctx.runMutation(internal.importProcessing.attachContent, {
    versionId,
    storageId,
    contentSha256: encoded.contentSha256,
    contentSize: encoded.contentSize,
    storedSha256: encoded.storedSha256,
    storedSize: encoded.storedSize,
    attempt,
  });
  if (outcome !== "attached") return null;
  // B8: the blob read back through the codec is the verification; only then the inline copy
  // goes. A read that fails leaves the version inline, and the audit (B7) reports it.
  const ref = {
    contentSha256: encoded.contentSha256,
    contentSize: encoded.contentSize,
    format: encoded.format,
  };
  try {
    await readStoredContent(ctx.storage, storageId, ref);
  } catch {
    console.warn(`document content of ${versionId} did not read back; stays inline`);
    return null;
  }
  await ctx.runMutation(internal.importProcessing.verifiedContent, {
    versionId,
    contentSha256: encoded.contentSha256,
  });
  return null;
}
/**
 * A blob `storeContent` read back equal to what it encoded from the inline copy: the version is
 * verified and its inline copy goes (B8). Nothing if the version now holds another blob.
 */
export const verifiedContent = internalMutation({
  args: { versionId: v.id("documentVersions"), contentSha256: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId, contentSha256 }) => {
    if (!(await markVerified(ctx, versionId, contentSha256))) return null;
    await clearInlineContent(ctx, (await ctx.db.get("documentVersions", versionId))!);
    return null;
  },
});
/** The sweep window of the blob `storeContent` is about to store. */
export const contentWindow = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requestContentWindow(ctx);
    return null;
  },
});
export const attachContent = internalMutation({
  args: {
    versionId: v.id("documentVersions"),
    storageId: v.id("_storage"),
    contentSha256: v.string(),
    contentSize: v.number(),
    storedSha256: v.string(),
    storedSize: v.number(),
    attempt: v.number(),
  },
  returns: v.union(
    v.literal("attached"),
    v.literal("already"),
    v.literal("duplicate"),
    v.literal("foreign"),
    v.literal("mismatch"),
    v.literal("gone"),
    v.literal("changed"),
    v.literal("archived"),
  ),
  handler: (ctx, args) => attachVersionContent(ctx, args),
});
