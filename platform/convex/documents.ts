import { v, ConvexError } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { companyScopeFields } from "./lib/operationValues";
import {
  documentAccess,
  loadDocument,
  loadScopedDocument,
  resolveDocumentVersion,
  summary,
  versionInfo,
  type DocumentScope,
} from "./lib/documentCore";
import { documentSummary, filters, originalIdField } from "./lib/documentValues";
import { contentNeed, ITEMS_PAGE_BYTES, type ContentPlan } from "./lib/documentContentPlan";
import type { DetailData, ItemsData, VersionsData } from "./lib/documentRender";
import { originalId } from "./lib/coldArchiveOrigin";
import { deny } from "./lib/organizationAccess";
import { ensureConsoleProject } from "./lib/projectAccess";
import { requestProjection } from "./documentProjection";
import { mutation } from "./_generated/server";
import { limitOrganizationAction } from "./lib/organizationAccess";
import { keyAccess, memberAccess } from "./lib/operationAccess";
import { importTask, PROCESSOR_VERSION } from "./lib/importValues";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { originalAvailable } from "./lib/documentOriginalRead";

export type ListFilters = {
  status?: "unknown" | "authorized" | "cancelled" | "denied" | "conflict";
  source?: "imported-xml" | "distribution-xml";
  from?: number;
  to?: number;
  key?: string;
  /** Console only (#433): NF-e that arrived only as the summary, without items. */
  completeness?: "summary";
};
/** `fiscalDocuments.completeness` of a document whose best version is the summary (`resNFe`). */
const SUMMARY_COMPLETENESS = 1;
type ListArgs = DocumentScope & ListFilters & { cursor: string | null; limit: number };
type ListedRow = { doc: Doc<"fiscalDocuments">; summary: ReturnType<typeof summary> };
/** The REST page (v1, frozen): the summaries only. */
export async function listDocuments(ctx: QueryCtx, args: ListArgs, keyHash?: string) {
  const result = await listDocumentRows(ctx, args, keyHash);
  return { ...result, page: result.page.map((row) => row.summary) };
}
/** A page of documents, each with the row it was read from, so the console reads it only once. */
async function listDocumentRows(ctx: QueryCtx, args: ListArgs, keyHash?: string) {
  await documentAccess(ctx, args, keyHash);
  if (
    !Number.isSafeInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > 50 ||
    (args.from !== undefined && (!Number.isSafeInteger(args.from) || args.from < 0)) ||
    (args.to !== undefined && (!Number.isSafeInteger(args.to) || args.to < (args.from ?? 0))) ||
    (args.key !== undefined &&
      !(
        /^[0-9A-Z]{44}$/.test(args.key) ||
        /^nfse:[0-9]{7}:[0-9]{14}:[A-Za-z0-9.%_-]*:[0-9]{1,15}$/.test(args.key)
      ))
  )
    return deny("INVALID_REQUEST");
  const unindexed = await ctx.db
    .query("fiscalDocuments")
    .withIndex("by_companyId_environment_listedAt", (q) =>
      q
        .eq("companyId", args.companyId)
        .eq("environment", args.environment)
        .eq("listedAt", undefined),
    )
    .take(1);
  const binding = JSON.stringify([
    args.organizationId,
    args.companyId,
    args.projectId,
    args.environment,
    args.status ?? null,
    args.source ?? null,
    args.from ?? null,
    args.to ?? null,
    args.key ?? null,
    args.completeness ?? null,
  ]);
  let cursor: string | null = null;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || typeof decoded.cursor !== "string") throw new Error();
      cursor = decoded.cursor;
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  if (args.key) {
    if (cursor) return deny("INVALID_CURSOR");
    const doc = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("companyId", args.companyId)
          .eq("environment", args.environment)
          .eq("model", args.key!.startsWith("nfse:") ? "nfse" : "55")
          .eq("fiscalKey", args.key!),
      )
      .unique();
    let rows: ListedRow[] = [];
    if (doc?.publishedVersionId) {
      const value = summary(doc, (await loadDocument(ctx, args, doc._id, keyHash)).version);
      if (
        (!args.status || value.fiscalStatus === args.status) &&
        (!args.completeness || value.completeness === args.completeness) &&
        doc.createdAt >= (args.from ?? 0) &&
        doc.createdAt <= (args.to ?? Number.MAX_SAFE_INTEGER)
      )
        rows = [{ doc, summary: value }];
    }
    return { page: rows, nextCursor: null, indexing: unindexed.length > 0 };
  }
  if (args.completeness === "summary") {
    // The summaries come from the document's own index, newest first; the other filters apply
    // to each row read, so a page may come shorter than the limit and still have a next one.
    const batch = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_companyId_and_environment_and_completeness", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("companyId", args.companyId)
          .eq("environment", args.environment)
          .eq("completeness", SUMMARY_COMPLETENESS),
      )
      .order("desc")
      .paginate({ cursor, numItems: args.limit, maximumRowsRead: 50, maximumBytesRead: 250_000 });
    const rows: ListedRow[] = [];
    for (const doc of batch.page) {
      if (
        !doc.publishedVersionId ||
        doc.direction === "emitted" ||
        doc.createdAt < (args.from ?? 0) ||
        doc.createdAt > (args.to ?? Number.MAX_SAFE_INTEGER)
      )
        continue;
      const { version } = await loadScopedDocument(ctx, args, doc._id);
      const value = summary(doc, version);
      if (
        (!args.status || value.fiscalStatus === args.status) &&
        (!args.source || value.source === args.source)
      )
        rows.push({ doc, summary: value });
    }
    return {
      page: rows,
      nextCursor: batch.isDone
        ? null
        : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
      indexing: unindexed.length > 0,
    };
  }
  const filterKey = `${args.status ?? "*"}:${args.source ?? "*"}`;
  const batch = await ctx.db
    .query("documentListings")
    .withIndex("by_companyId_environment_filterKey_date", (q) =>
      q
        .eq("companyId", args.companyId)
        .eq("environment", args.environment)
        .eq("filterKey", filterKey)
        .gte("date", args.from ?? 0)
        .lte("date", args.to ?? Number.MAX_SAFE_INTEGER),
    )
    .order("desc")
    .paginate({ cursor, numItems: args.limit, maximumRowsRead: 50, maximumBytesRead: 250_000 });
  const rows = await Promise.all(
    batch.page.map(async (row) => {
      const { doc, version } = await loadScopedDocument(ctx, args, row.documentId);
      return { doc, summary: summary(doc, version) };
    }),
  );
  return {
    page: rows,
    nextCursor: batch.isDone
      ? null
      : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
    indexing: unindexed.length > 0,
  };
}
/**
 * Console only: the summary plus where its content is (ADR 0010, phase C). The published REST
 * contract (v1) is frozen, so the tier stays out of it; reading is the same in both tiers.
 */
const consoleDocumentSummary = documentSummary.extend({
  storageTier: v.union(v.literal("hot"), v.literal("cold")),
});
export const list = query({
  args: {
    ...companyScopeFields,
    ...filters,
    completeness: v.optional(v.literal("summary")),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  returns: v.object({
    page: v.array(consoleDocumentSummary),
    nextCursor: v.union(v.string(), v.null()),
    indexing: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await listDocumentRows(ctx, args);
    // A note still moving reads as hot: each version is read from wherever it is.
    const page = result.page.map(({ doc, summary: row }) => ({
      ...row,
      storageTier: doc.coldState === "cold" ? ("cold" as const) : ("hot" as const),
    }));
    return { ...result, page };
  },
});

/** At most this many summaries are counted; above it the console shows "100+". */
const SUMMARY_COUNTED = 100;
/** Rows of the index read at most: past it the count says there may be others. */
const SUMMARY_SCANNED = 1_000;
/**
 * Console (#433): how many documents of the company and environment arrived only as the summary
 * (`resNFe`), without items, for the link of the capture panel. Counted up to `SUMMARY_COUNTED`;
 * `more` says there are others. Rows the list hides (not published yet, emitted) are skipped and
 * do not take the place of the ones it shows, up to `SUMMARY_SCANNED` rows read. The same access
 * as the list.
 */
export const summaryCount = query({
  args: companyScopeFields,
  returns: v.object({ count: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    await documentAccess(ctx, args);
    const rows = ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_companyId_and_environment_and_completeness", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("companyId", args.companyId)
          .eq("environment", args.environment)
          .eq("completeness", SUMMARY_COMPLETENESS),
      );
    let count = 0,
      scanned = 0;
    for await (const doc of rows) {
      if (++scanned > SUMMARY_SCANNED) return { count, more: true };
      if (!doc.publishedVersionId || doc.direction === "emitted") continue;
      if (++count > SUMMARY_COUNTED) return { count: SUMMARY_COUNTED, more: true };
    }
    return { count, more: false };
  },
});

/**
 * The detail of a document, at its published version or `versionId`, as a content plan
 * (`lib/documentContentPlan.ts`): the payload comes from the version's content.
 */
export async function getDocument(
  ctx: QueryCtx,
  args: DocumentScope & { documentId: string; versionId?: string },
  keyHash?: string,
): Promise<ContentPlan<DetailData>> {
  const { doc, version } = await resolveDocumentVersion(ctx, args, keyHash);
  return {
    renderer: "detail",
    data: {
      model: doc.model,
      summary: summary(doc, version),
      version: await versionInfo(ctx, version),
      fiscalSituation: doc.projectionState === "ready" ? (doc.fiscalSituation ?? null) : null,
      previousFiscalSituation:
        doc.projectionState !== "ready" ? (doc.fiscalSituation ?? null) : null,
    },
    needs: [await contentNeed(ctx, "v", version, { result: true })],
  };
}
/**
 * One page of the items of a version, in position order. The cursor is the next position, bound
 * to the document and version; a page holds at most `limit` items and about 400 KB.
 */
export async function documentItems(
  ctx: QueryCtx,
  args: DocumentScope & {
    documentId: string;
    versionId: string;
    cursor: string | null;
    limit: number;
  },
  keyHash?: string,
): Promise<ContentPlan<ItemsData>> {
  const { version } = await resolveDocumentVersion(ctx, args, keyHash);
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 25)
    return deny("INVALID_PAGINATION");
  const binding = `${args.documentId}:${version._id}`;
  let from = 0;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || !/^(0|[1-9][0-9]{0,8})$/.test(decoded.cursor))
        throw new Error();
      from = Number(decoded.cursor);
      if (from >= version.itemCount) throw new Error();
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  return {
    renderer: "items",
    data: { binding, versionId: String(version._id), from, itemCount: version.itemCount },
    needs:
      version.itemCount === 0
        ? [{ key: "v", want: {}, inline: { items: [] } }]
        : [
            await contentNeed(ctx, "v", version, {
              items: { from, limit: args.limit, maxBytes: ITEMS_PAGE_BYTES },
            }),
          ],
  };
}
export async function documentVersions(
  ctx: QueryCtx,
  args: DocumentScope & { documentId: string; kind?: string; cursor: string | null; limit: number },
  keyHash?: string,
): Promise<ContentPlan<VersionsData>> {
  const { doc } = await loadDocument(ctx, args, args.documentId, keyHash);
  if (
    !Number.isSafeInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > 20 ||
    (args.kind && !["event", "event-summary"].includes(args.kind))
  )
    return deny("INVALID_REQUEST");
  const binding = `${doc._id}:${args.kind ?? "*"}`;
  let cursor: string | null = null;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || typeof decoded.cursor !== "string") throw new Error();
      cursor = decoded.cursor;
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  const query = args.kind
    ? ctx.db
        .query("documentVersions")
        .withIndex("by_documentId_kind_publishedAt", (q) =>
          q.eq("documentId", doc._id).eq("kind", args.kind!).gt("publishedAt", 0),
        )
    : ctx.db
        .query("documentVersions")
        .withIndex("by_documentId_publishedAt", (q) =>
          q.eq("documentId", doc._id).gt("publishedAt", 0),
        );
  const batch = await query
    .order("desc")
    .paginate({ cursor, numItems: args.limit, maximumRowsRead: 20, maximumBytesRead: 500_000 });
  return {
    renderer: "versions",
    data: {
      page: await Promise.all(batch.page.map((version) => versionInfo(ctx, version))),
      nextCursor: batch.isDone
        ? null
        : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
    },
    needs: await Promise.all(
      batch.page.map((version, index) => contentNeed(ctx, `v${index}`, version, { result: true })),
    ),
  };
}
export const rebuild = mutation({
  args: { ...companyScopeFields, documentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { doc } = await loadDocument(ctx, args, args.documentId);
    await memberAccess(ctx, { ...args, task: importTask }, true);
    await limitOrganizationAction(ctx, "documents-rebuild", args.organizationId, 10);
    await requestProjection(ctx, doc._id, true);
    return null;
  },
});
export const canProcess = query({
  args: companyScopeFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await documentAccess(ctx, args);
    try {
      await memberAccess(ctx, { ...args, task: importTask }, true);
      return true;
    } catch (error) {
      if (error instanceof ConvexError && ["NOT_FOUND", "SCOPE_DENIED"].includes(error.data?.code))
        return false;
      throw error;
    }
  },
});
export async function reprocessDocument(
  ctx: MutationCtx,
  args: DocumentScope & { projectId: Id<"projects">; documentId: string; key: string },
  keyHash?: string,
): Promise<{ operationId: Id<"operations">; reused: boolean }> {
  const { version } = await loadDocument(ctx, args, args.documentId, keyHash);
  if (keyHash) await keyAccess(ctx, keyHash, { ...args, task: importTask });
  else await memberAccess(ctx, { ...args, task: importTask }, true);
  const selectedArtifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
  const artifact = selectedArtifact.parentArtifactId
    ? (await ctx.db.get("documentArtifacts", selectedArtifact.parentArtifactId))!
    : selectedArtifact;
  const result = await ctx.runMutation(internal.operations.reserve, {
    organizationId: args.organizationId,
    companyId: args.companyId,
    projectId: args.projectId,
    environment: args.environment,
    key: args.key,
    ...(keyHash ? { keyHash } : {}),
    task: { ...importTask, name: "documents.reprocess" },
    // The ID exactly as the caller sent it (ADR 0009, §6): a repetition after a rehydration with
    // the ID of before keeps the hash of before. Without a rehydration it is `doc._id`.
    idempotencyRequest: JSON.stringify({ documentId: args.documentId }),
    request: JSON.stringify({ artifactId: artifact._id, processorVersion: PROCESSOR_VERSION }),
  });
  if (!result.reused && artifact.fileId && artifact.projectId === args.projectId)
    await ctx.db.patch("importFiles", artifact.fileId, {
      processingOperationId: result.operationId,
    });
  return result;
}
/** Console reprocessing: the operation and its idempotency key belong to the console project. */
export const reprocess = mutation({
  args: { ...companyScopeFields, documentId: v.string(), key: v.string() },
  returns: v.object({ operationId: v.id("operations"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    const { membership } = await memberAccess(ctx, { ...args, task: importTask }, true);
    return reprocessDocument(ctx, {
      ...args,
      projectId: await ensureConsoleProject(ctx, membership),
    });
  },
});
export const unclassifiedValue = v.object({
  id: v.string(),
  ...originalIdField,
  name: v.string(),
  sha256: v.string(),
  importedAt: v.number(),
  size: v.number(),
  code: v.string(),
  originalAvailable: v.boolean(),
});
export const fileValue = v.object({
  id: v.string(),
  ...originalIdField,
  name: v.string(),
  sha256: v.string(),
  size: v.number(),
  source: v.union(v.literal("imported-xml"), v.literal("distribution-xml")),
  importedAt: v.number(),
  originalAvailable: v.boolean(),
});
export async function documentFiles(
  ctx: QueryCtx,
  args: DocumentScope & { documentId: string; cursor: string | null; limit: number },
  keyHash?: string,
) {
  const { doc } = await loadDocument(ctx, args, args.documentId, keyHash);
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 20)
    return deny("INVALID_PAGINATION");
  const binding = `${args.organizationId}:${args.companyId}:${args.projectId}:${args.environment}:${doc._id}:files`;
  let cursor: string | null = null;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || typeof decoded.cursor !== "string") throw new Error();
      cursor = decoded.cursor;
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  const batch = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
      q
        .eq("companyId", args.companyId)
        .eq("environment", args.environment)
        .eq("documentId", doc._id),
    )
    .order("desc")
    .paginate({ cursor, numItems: args.limit, maximumRowsRead: 20, maximumBytesRead: 200_000 });
  return {
    page: await Promise.all(
      batch.page.map(async (artifact) => {
        const file = artifact.fileId ? await ctx.db.get("importFiles", artifact.fileId) : null;
        return {
          id: String(artifact._id),
          ...originalId(artifact),
          name:
            file?.name ??
            (artifact.parentArtifactId
              ? "Lote original de NFS-e.xml"
              : "Documento da distribuição.xml"),
          sha256: artifact.sha256,
          size: artifact.size,
          source: artifact.source,
          importedAt: artifact.importedAt,
          originalAvailable: await originalAvailable(ctx, artifact),
        };
      }),
    ),
    nextCursor: batch.isDone
      ? null
      : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
  };
}
export const files = query({
  args: {
    ...companyScopeFields,
    documentId: v.string(),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  returns: v.object({ page: v.array(fileValue), nextCursor: v.union(v.string(), v.null()) }),
  handler: (ctx, args) => documentFiles(ctx, args),
});
/**
 * What an artifact without a document came from: its import file, the operation that read it and
 * the version that operation wrote. A succeeded NFS-e batch is the batch file of documents that
 * were recognized one by one, not a refusal: it is not listed nor counted.
 */
async function unclassifiedOrigin(ctx: QueryCtx, artifact: Doc<"documentArtifacts">) {
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
export async function unclassifiedArtifacts(
  ctx: QueryCtx,
  args: DocumentScope & { cursor: string | null; limit: number },
  keyHash?: string,
) {
  await documentAccess(ctx, args, keyHash);
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 20)
    return deny("INVALID_PAGINATION");
  const binding = `${args.companyId}:${args.environment}:unclassified`;
  let cursor: string | null = null;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(atob(args.cursor)) as { binding: string; cursor: string };
      if (decoded.binding !== binding || typeof decoded.cursor !== "string") throw new Error();
      cursor = decoded.cursor;
    } catch {
      return deny("INVALID_CURSOR");
    }
  }
  const batch = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
      q
        .eq("companyId", args.companyId)
        .eq("environment", args.environment)
        .eq("documentId", undefined),
    )
    .order("desc")
    .paginate({ cursor, numItems: args.limit, maximumRowsRead: 20, maximumBytesRead: 200_000 });
  const page = await Promise.all(
    batch.page.map(async (artifact) => {
      const { file, op, version, listed } = await unclassifiedOrigin(ctx, artifact);
      if (!listed) return null;
      return {
        id: String(artifact._id),
        ...originalId(artifact),
        name: file?.name ?? "Envelope da distribuição.xml",
        sha256: artifact.sha256,
        importedAt: artifact.importedAt,
        size: artifact.size,
        code:
          version?.state === "complete" && op?.state === "succeeded"
            ? version.code
            : (op?.code ?? op?.state ?? "PROCESSING_PENDING"),
        originalAvailable: await originalAvailable(ctx, artifact),
      };
    }),
  );
  return {
    page: page.filter((entry) => entry !== null),
    nextCursor: batch.isDone
      ? null
      : btoa(JSON.stringify({ binding, cursor: batch.continueCursor })),
  };
}
/** At most this many files without a document are counted; above it the console says "20+". */
const UNCLASSIFIED_COUNTED = 20;
/** Artifacts read at most: past it the count says there may be others. */
const UNCLASSIFIED_SCANNED = 100;
/**
 * Console: how many files of the company and environment were kept without a recognized
 * document, for the notice of the documents list, which points to them in the import page.
 * Counted up to `UNCLASSIFIED_COUNTED`, with the same rows `unclassified` lists; `more` says there
 * are others; `latestAt`, when the newest of them arrived, lets the console show its notice again
 * after the person closed it. The same access as the list.
 */
export const unclassifiedCount = query({
  args: companyScopeFields,
  returns: v.object({
    count: v.number(),
    more: v.boolean(),
    latestAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    await documentAccess(ctx, args);
    const rows = ctx.db
      .query("documentArtifacts")
      .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
        q
          .eq("companyId", args.companyId)
          .eq("environment", args.environment)
          .eq("documentId", undefined),
      )
      .order("desc");
    let count = 0,
      scanned = 0,
      latestAt: number | null = null;
    for await (const artifact of rows) {
      if (++scanned > UNCLASSIFIED_SCANNED) return { count, more: true, latestAt };
      if (!(await unclassifiedOrigin(ctx, artifact)).listed) continue;
      // Newest first: the first one counted is the latest arrival.
      latestAt ??= artifact.importedAt;
      if (++count > UNCLASSIFIED_COUNTED)
        return { count: UNCLASSIFIED_COUNTED, more: true, latestAt };
    }
    return { count, more: false, latestAt };
  },
});
export const unclassified = query({
  args: { ...companyScopeFields, cursor: v.union(v.string(), v.null()), limit: v.number() },
  returns: v.object({
    page: v.array(unclassifiedValue),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: (ctx, args) => unclassifiedArtifacts(ctx, args),
});
