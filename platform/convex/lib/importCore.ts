import { releaseCapacity, releaseStoredFile } from "./capacityCore";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { keyAccess, humanAccess } from "./operationAccess";
import { completeImport } from "./webhookOutbox";
import { deny } from "./organizationAccess";
import { importResult, importTask, MAX_IMPORT_FILES } from "./importValues";
import { releaseUsage } from "./usageCore";
import { originalId } from "./coldArchiveOrigin";
import { ConvexError, type Infer } from "convex/values";
import { contentNeed, type ContentPlan } from "./documentContentPlan";
import { renderInline, type ImportSummaryData } from "./documentRender";

/**
 * Usage key of the provisional note an import file holds in Production under a plan with `notes`
 * (ADR 0010, decision 10), from its admission until its processing ends or it expires. The note
 * keys of documents are their ids, so the prefix never collides with one.
 */
export const pendingNoteKey = (fileId: Id<"importFiles">) => `import:${fileId}`;
/**
 * The file left the pending notes: it expired, or its processing ended, publishing the real notes
 * in the same transaction or none. A file that never held one, or already gave it back, is a no-op.
 */
export const releasePendingNote = (
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  fileId: Id<"importFiles">,
) => releaseUsage(ctx, organizationId, "documents", pendingNoteKey(fileId));
/**
 * Usage key of the new notes an NFS-e batch held from its staging until its processing ended
 * (#649), one per operation. The ABRASF import is retired and nothing reserves under it anymore;
 * the release stays so an operation staged before the retirement still ends its hold.
 */
export const batchNotesKey = (operationId: Id<"operations">) => `import-batch:${operationId}`;
/** The operation ended, publishing the batch's real notes in the same transaction or none. */
export const releaseBatchNotes = (
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  operationId: Id<"operations">,
) => releaseUsage(ctx, organizationId, "documents", batchNotesKey(operationId));

export async function importAccess(
  ctx: QueryCtx,
  batch: Doc<"imports">,
  keyHash?: string,
  write = true,
) {
  const scope = { ...batch, task: importTask };
  if (keyHash) await keyAccess(ctx, keyHash, scope);
  else await humanAccess(ctx, scope, write);
}
export async function getFile(
  ctx: QueryCtx,
  fileId: Id<"importFiles">,
  keyHash?: string,
  write = true,
) {
  const file = await ctx.db.get("importFiles", fileId);
  const batch = file ? await ctx.db.get("imports", file.importId) : null;
  if (!file || !batch) return deny("NOT_FOUND");
  await importAccess(ctx, batch, keyHash, write);
  return { file, batch };
}
function batchFiles(ctx: QueryCtx, batch: Doc<"imports">) {
  return ctx.db
    .query("importFiles")
    .withIndex("by_importId", (q) => q.eq("importId", batch._id))
    .take(MAX_IMPORT_FILES);
}
/**
 * A file's current operation and, when that operation succeeded with a complete version, the
 * version it published. State and result code come from here for both the summary and the
 * console's recent list; the published entries are read only by `importSummary`.
 */
async function fileOutcome(ctx: QueryCtx, file: Doc<"importFiles">) {
  const operationId = file.processingOperationId ?? file.operationId;
  const op = operationId ? await ctx.db.get("operations", operationId) : null;
  const version = op
    ? await ctx.db
        .query("documentVersions")
        .withIndex("by_operationId_entryIndex", (q) =>
          q.eq("operationId", op._id).eq("entryIndex", undefined),
        )
        .unique()
    : null;
  const visible = version?.state === "complete" && op?.state === "succeeded" ? version : null;
  return {
    op,
    visible,
    state: op?.state ?? file.state,
    code: visible ? visible.code : (op?.code ?? null),
  };
}
/** Result code an import operation records in its response when it publishes (`published`). */
function responseCode(response: string | undefined) {
  try {
    const code: unknown = response ? JSON.parse(response).code : undefined;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
/**
 * Current state and result code of one file, the input of `importFileOutcome`, for the Início
 * (#507). It follows the file's current operation (`processingOperationId`, moved by a
 * reprocessing), so a newer result replaces an older refusal there as in the import screen. A
 * succeeded operation carries the published code in its response, the same code its version
 * has; reading the version, which holds the whole result (up to 128 KB), would not fit a query
 * over 1,000 files. Every import operation has written `code` in its response since the first
 * import commit (1c69202), so the version read below is not expected; it stays for safety.
 */
export async function importFileState(ctx: QueryCtx, file: Doc<"importFiles">) {
  const operationId = file.processingOperationId ?? file.operationId;
  const op = operationId ? await ctx.db.get("operations", operationId) : null;
  if (op?.state !== "succeeded") return { state: op?.state ?? file.state, code: op?.code ?? null };
  const code = responseCode(op.response);
  if (code !== null) return { state: op.state, code };
  const { state, code: stored } = await fileOutcome(ctx, file);
  return { state, code: stored };
}
/** State and result code of each file of a batch, without its published documents. */
export async function importStates(ctx: QueryCtx, batch: Doc<"imports">) {
  return Promise.all(
    (await batchFiles(ctx, batch)).map(async (file) => {
      const { state, code } = await fileOutcome(ctx, file);
      return { state, code };
    }),
  );
}
/**
 * The summary of a batch answered in the query itself: without `includeResults`, nothing in it
 * is a version's content. With it, REST reads the plan through `documentContentNode.importRead`.
 */
export async function importSummary(
  ctx: QueryCtx,
  batch: Doc<"imports">,
  includeResults = true,
): Promise<Infer<typeof importResult>> {
  return renderInline(await importSummaryPlan(ctx, batch, includeResults));
}
/**
 * The summary of a batch as a content plan (ADR 0010, B5): each file's `result` comes from its
 * version's content (`f<index>`), and an entry's number from the version's card.
 */
export async function importSummaryPlan(
  ctx: QueryCtx,
  batch: Doc<"imports">,
  includeResults = true,
): Promise<ContentPlan<ImportSummaryData>> {
  const visible: Doc<"documentVersions">[] = [];
  const summary = await summaryData(ctx, batch, includeResults, visible);
  const needs = [];
  for (const [index, file] of summary.files.entries())
    if (file.result === true)
      needs.push(await contentNeed(ctx, `f${index}`, visible[index]!, { result: true }));
  return { renderer: "importSummary", data: { summary }, needs };
}
/** The number of a published entry of a batch, from its card or, without one, its `result`. */
function entryNumber(entry: Doc<"documentVersions">) {
  if (entry.card) return entry.card.number;
  if (entry.result === undefined)
    throw new ConvexError({ code: "DOCUMENT_CONTENT_CORRUPT", reason: "entry card" });
  return (JSON.parse(entry.result) as { document: { number: string } }).document.number;
}
/** `visible[index]` receives the version of each file whose `result` the plan reads. */
async function summaryData(
  ctx: QueryCtx,
  batch: Doc<"imports">,
  includeResults: boolean,
  visibleSink: Doc<"documentVersions">[],
) {
  const files = await batchFiles(ctx, batch);
  return {
    id: batch._id,
    ...originalId(batch),
    createdAt: batch.createdAt,
    files: await Promise.all(
      files.map(async (file, index) => {
        const { op, visible, state, code } = await fileOutcome(ctx, file);
        if (visible && includeResults) visibleSink[index] = visible;
        const entries = visible
          ? await ctx.db
              .query("documentVersions")
              .withIndex("by_parentVersionId", (q) => q.eq("parentVersionId", visible._id))
              .take(20)
          : [];
        return {
          documents: entries
            .filter(
              (entry) =>
                entry.state === "complete" && entry.publishedAt !== undefined && entry.documentId,
            )
            .map((entry) => ({
              documentId: String(entry.documentId),
              versionId: String(entry._id),
              number: entryNumber(entry),
              code: entry.code,
            })),
          id: file._id,
          ...originalId(file),
          name: file.name,
          size: file.size,
          sha256: file.sha256,
          state,
          operationId: op?._id ?? null,
          generation: op?.generation ?? 0,
          code,
          documentId: visible ? (visible.documentId ?? null) : null,
          versionId: visible ? visible._id : null,
          // `true`: the renderer takes it from the version's content (`importSummaryPlan`).
          result: visible && includeResults ? (true as const) : null,
        };
      }),
    ),
  };
}
export async function expireFile(ctx: MutationCtx, file: Doc<"importFiles">) {
  if (file.state === "accepted" || file.state === "expired") return;
  const batch = (await ctx.db.get("imports", file.importId))!;
  await releaseUsage(ctx, batch.organizationId, "imports", String(file._id));
  await releaseUsage(ctx, batch.organizationId, "bytes", String(file._id));
  await releasePendingNote(ctx, batch.organizationId, file._id);
  await releaseCapacity(ctx, batch.organizationId, "filesBytes", `import:${file._id}`);
  if (file.storageId) {
    await ctx.storage.delete(file.storageId);
    await releaseStoredFile(ctx, batch.organizationId, file.storageId);
  }
  await ctx.db.patch("importFiles", file._id, {
    state: "expired",
    storageId: undefined,
    tokenHash: undefined,
    tokenExpiresAt: undefined,
  });
  await completeImport(ctx, file.importId);
}
