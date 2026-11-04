import { v, type Infer } from "convex/values";
import { stream } from "convex-helpers/server/stream";
import schema from "./schema";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { exportAllowed } from "./lib/exportAccess";
import { readTask, versionInfo } from "./lib/documentCore";
import { contentNeed, type ContentNeed } from "./lib/documentContentPlan";
import { environmentServed } from "./lib/environmentAccess";
import { deny } from "./lib/organizationAccess";
import { originalSource, originalSourceOf, type OriginalSource } from "./lib/documentOriginalRead";
import { stepArgs } from "./exports";
import type { assistedCompany } from "./lib/exportSchema";

/** Items per export step; the worker writes each as one `item` record. */
const EXPORT_ITEMS = 25;
type Cursor = {
  pagination?: "keyset-v1";
  phase: "documents" | "versions" | "items" | "artifacts" | "companies" | "unclassified" | "done";
  cursor: string | null;
  documentCursor?: string | null;
  documentsDone?: boolean;
  documentId?: Id<"fiscalDocuments">;
  versionId?: Id<"documentVersions">;
  versionCursor?: string | null;
  versionsDone?: boolean;
  companyId?: Id<"companies">;
  companyCursor?: string | null;
  companiesDone?: boolean;
};
export const read = internalQuery({
  args: {
    ...stepArgs,
    // The worker's clock: a query never reads it (#45).
    now: v.number(),
    checkpoint: v.string(),
    maxSteps: v.optional(v.number()),
    maxBytes: v.optional(v.number()),
  },
  returns: v.object({
    records: v.string(),
    // ADR 0010, B5: JSON `ContentNeed[]` of the `$content` records, resolved by the Node worker.
    needs: v.string(),
    steps: v.number(),
    checkpoint: v.string(),
    done: v.boolean(),
    // The original's location, hot or cold (ADR 0010, decision 8), read by the worker.
    original: v.optional(v.object({ artifactId: v.string(), source: originalSource })),
  }),
  handler: readBatch,
});

export async function readBatch(
  ctx: QueryCtx,
  args: {
    exportId: Id<"documentExports">;
    sequence: number;
    now: number;
    checkpoint: string;
    maxSteps?: number;
    maxBytes?: number;
  },
) {
  const job = await ctx.db.get("documentExports", args.exportId);
  if (
    !job ||
    job.state !== "running" ||
    job.sequence !== args.sequence ||
    job.expiresAt <= args.now
  )
    return deny("NOT_FOUND");
  await exportAllowed(ctx, job, args.now);
  let state = JSON.parse(args.checkpoint) as Cursor;
  const maxSteps = args.maxSteps ?? 8;
  const maxBytes = args.maxBytes ?? 512 * 1024;
  if (
    !Number.isSafeInteger(maxSteps) ||
    maxSteps < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return deny("INVALID_REQUEST");
  const limit = state.pagination === "keyset-v1" ? Math.min(maxSteps, 8) : 1;
  const records: string[] = [];
  const needs: ContentNeed[] = [];
  let bytes = 0;
  for (let steps = 1; ; steps++) {
    const page = await readPage(ctx, job, state, args.now);
    if (page.records) {
      records.push(page.records);
      bytes += new TextEncoder().encode(page.records).byteLength + 1;
    }
    needs.push(...page.needs);
    const metrics = await ctx.meta.getTransactionMetrics();
    // Leave room for one indivisible phase (including point reads of large
    // versions/operations). Originals are loaded only by the Node worker.
    if (
      steps >= limit ||
      page.done ||
      page.original ||
      bytes >= Math.min(maxBytes, 512 * 1024) ||
      metrics.bytesRead.used >= 4 * 1024 * 1024 ||
      metrics.documentsRead.used >= 64
    ) {
      return { ...page, records: records.join("\n"), needs: JSON.stringify(needs), steps };
    }
    state = JSON.parse(page.checkpoint) as Cursor;
  }
}

type CompanyCopy = Infer<typeof assistedCompany>;
/**
 * A company as the export reads it: the row, or, in the isolated destination of an assisted
 * export (ADR 0009, §7), the origin's copy the job carries, because the package holds only the
 * `fiscal` class. `served` is `environmentServed` for the job's environment, read where it is
 * decided: in the origin for the copy, here for the row.
 */
function exportCompany(
  ctx: QueryCtx,
  job: Doc<"documentExports">,
  row: Doc<"companies"> | CompanyCopy,
) {
  if ("_id" in row)
    return {
      _id: row._id,
      organizationId: row.organizationId,
      cnpj: row.cnpj,
      name: row.name,
      createdAt: row.createdAt,
      served: () => environmentServed(ctx, row, job.environment, readTask.scope),
    };
  return {
    _id: row.id,
    organizationId: job.organizationId,
    cnpj: row.cnpj,
    name: row.name,
    createdAt: row.createdAt,
    served: async () => row.served,
  };
}
async function companyById(ctx: QueryCtx, job: Doc<"documentExports">, id: Id<"companies">) {
  const row = job.assisted
    ? job.assisted.companies.find((copy) => copy.id === id)
    : await ctx.db.get("companies", id);
  return row ? exportCompany(ctx, job, row) : null;
}
/** The assisted job's companies, one per step, with the position as the cursor. */
function assistedCompanies(job: Doc<"documentExports">, cursor: string | null) {
  const companies = job.assisted!.companies;
  const index = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(index) || index < 0) return deny("INVALID_REQUEST");
  const copy = companies[index];
  return {
    page: copy ? [copy] : [],
    isDone: index + 1 >= companies.length,
    continueCursor: String(index + 1),
  };
}

// Native cursors remain readable for jobs accepted before batching was deployed.
// Keyset pagination supports multiple dependent pages in the same transaction.
async function readPage(
  ctx: QueryCtx,
  job: Doc<"documentExports">,
  state: Cursor,
  observedAt: number,
) {
  const pages = state.pagination === "keyset-v1" ? stream(ctx.db, schema) : ctx.db;
  const finish = (
    records: unknown[],
    next: Cursor,
    original?: { artifactId: string; source: OriginalSource },
    needs: ContentNeed[] = [],
  ) => ({
    needs,
    records: records.map((r) => JSON.stringify(r)).join("\n"),
    checkpoint: JSON.stringify({
      ...next,
      ...(state.pagination ? { pagination: state.pagination } : {}),
    }),
    done: next.phase === "done",
    ...(original ? { original } : {}),
  });
  if (state.phase === "done") return finish([], state);
  const afterDocuments =
    job.selection.kind === "organization" ? ("companies" as const) : ("done" as const);
  if (state.phase === "companies") {
    if (job.selection.kind !== "organization") return deny("NOT_FOUND");
    const batch = job.assisted
      ? assistedCompanies(job, state.cursor)
      : await pages
          .query("companies")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", job.organizationId))
          .paginate({
            cursor: state.cursor,
            numItems: 1,
            maximumRowsRead: 1,
            maximumBytesRead: 200_000,
          });
    const row = batch.page[0];
    const company = row ? exportCompany(ctx, job, row) : null;
    // Outside the base environment, an organization export reads only the companies served there.
    if (!company || company.createdAt > job.createdAt || !(await company.served()))
      return finish([], {
        phase: batch.isDone ? "done" : "companies",
        cursor: batch.continueCursor,
      });
    return finish([], {
      phase: "unclassified",
      cursor: null,
      companyId: company._id,
      companyCursor: batch.continueCursor,
      companiesDone: batch.isDone,
    });
  }
  if (state.phase === "unclassified") {
    const company = state.companyId ? await companyById(ctx, job, state.companyId) : null;
    if (
      job.selection.kind !== "organization" ||
      !company ||
      company.organizationId !== job.organizationId
    )
      return deny("NOT_FOUND");
    const batch = await pages
      .query("documentArtifacts")
      .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
        q
          .eq("companyId", company._id)
          .eq("environment", job.environment)
          .eq("documentId", undefined)
          .lte("importedAt", job.createdAt),
      )
      .paginate({
        cursor: state.cursor,
        numItems: 1,
        maximumRowsRead: 1,
        maximumBytesRead: 200_000,
      });
    const artifact = batch.page[0];
    if (artifact && artifact.organizationId !== job.organizationId) return deny("NOT_FOUND");
    return finish(
      artifact
        ? [
            {
              type: "unclassified-artifact",
              companyId: company._id,
              id: artifact._id,
              sha256: artifact.sha256,
              size: artifact.size,
              source: artifact.source,
              importedAt: artifact.importedAt,
            },
          ]
        : [],
      batch.isDone
        ? {
            phase: state.companiesDone ? "done" : "companies",
            cursor: state.companyCursor ?? null,
          }
        : { ...state, cursor: batch.continueCursor },
      exportedOriginal(artifact),
    );
  }
  if (state.phase === "documents") {
    const page =
      job.selection.kind === "document"
        ? {
            page: [(await ctx.db.get("fiscalDocuments", job.selection.documentId))!],
            isDone: true,
            continueCursor: "",
          }
        : await pages
            .query("fiscalDocuments")
            .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
              q.eq("organizationId", job.organizationId),
            )
            .paginate({
              cursor: state.cursor,
              numItems: 1,
              maximumRowsRead: 1,
              maximumBytesRead: 500_000,
            });
    const doc = page.page[0];
    const next: Cursor = {
      phase: page.isDone ? afterDocuments : "documents",
      cursor: page.isDone ? null : page.continueCursor,
    };
    if (!doc || doc.createdAt > job.createdAt || doc.environment !== job.environment) {
      if (job.selection.kind === "document") return deny("NOT_FOUND");
      return finish([], next);
    }
    if (
      doc.organizationId !== job.organizationId ||
      (job.selection.kind === "document" && doc.companyId !== job.selection.companyId)
    )
      return deny("NOT_FOUND");
    const company = await companyById(ctx, job, doc.companyId);
    if (!company || company.organizationId !== job.organizationId) return deny("NOT_FOUND");
    if (job.selection.kind === "organization" && !(await company.served())) return finish([], next);
    const published = doc.publishedVersionId
      ? await ctx.db.get("documentVersions", doc.publishedVersionId)
      : null;
    return finish(
      [
        {
          type: "document",
          observedAt,
          id: doc._id,
          company: { id: company._id, cnpj: company.cnpj, name: company.name },
          model: doc.model,
          key: doc.fiscalKey,
          environment: doc.environment,
          createdAt: doc.createdAt,
          projectionState: doc.projectionState ?? "pending",
          fiscalSituation: doc.fiscalSituation ?? null,
          publishedVersionId:
            published?.publishedAt && published.publishedAt <= job.createdAt ? published._id : null,
        },
      ],
      {
        phase: "versions",
        cursor: null,
        documentId: doc._id,
        documentCursor: page.continueCursor,
        documentsDone: page.isDone,
      },
    );
  }
  if (!state.documentId) return deny("INVALID_REQUEST");
  const doc = await ctx.db.get("fiscalDocuments", state.documentId);
  if (
    !doc ||
    doc.organizationId !== job.organizationId ||
    doc.environment !== job.environment ||
    (job.selection.kind === "document" && doc._id !== job.selection.documentId)
  )
    return deny("NOT_FOUND");
  if (state.phase === "versions") {
    const batch = await pages
      .query("documentVersions")
      .withIndex("by_documentId_publishedAt", (q) =>
        q.eq("documentId", doc._id).gt("publishedAt", 0).lte("publishedAt", job.createdAt),
      )
      .paginate({
        cursor: state.cursor,
        numItems: 1,
        maximumRowsRead: 1,
        maximumBytesRead: 800_000,
      });
    const version = batch.page[0];
    const next: Cursor = {
      ...state,
      phase: batch.isDone ? "artifacts" : "versions",
      cursor: batch.isDone ? null : batch.continueCursor,
    };
    if (!version) return finish([], next);
    const op = await ctx.db.get("operations", version.operationId);
    if (version.state !== "complete" || op?.state !== "succeeded") return finish([], next);
    // The payload comes from the version's content: the worker fills the `$content` record.
    const need = await contentNeed(ctx, `${version._id}:payload`, version, { result: true });
    return finish(
      [
        {
          $content: need.key,
          type: "version",
          documentId: doc._id,
          version: await versionInfo(ctx, version),
        },
      ],
      {
        ...state,
        phase: "items",
        cursor: null,
        versionId: version._id,
        versionCursor: batch.continueCursor,
        versionsDone: batch.isDone,
      },
      undefined,
      [need],
    );
  }
  if (state.phase === "items") {
    if (!state.versionId) return deny("INVALID_REQUEST");
    const version = await ctx.db.get("documentVersions", state.versionId);
    if (!version || version.documentId !== doc._id) return deny("NOT_FOUND");
    // B5: the item cursor is the next position. A job checkpointed with the database cursor of
    // before cannot resume without repeating items, so it fails and is requested again.
    if (state.cursor !== null && !/^(0|[1-9][0-9]{0,8})$/.test(state.cursor))
      return deny("INVALID_CURSOR");
    const from = Number(state.cursor ?? 0);
    const next = from + EXPORT_ITEMS;
    const after: Cursor =
      next >= version.itemCount
        ? {
            ...state,
            phase: state.versionsDone ? "artifacts" : "versions",
            cursor: state.versionsDone ? null : (state.versionCursor ?? null),
          }
        : { ...state, cursor: String(next) };
    if (from >= version.itemCount) return finish([], after);
    const need = await contentNeed(ctx, `${version._id}:items:${from}`, version, {
      items: { from, limit: EXPORT_ITEMS, maxBytes: Number.MAX_SAFE_INTEGER },
    });
    return finish(
      [
        {
          $content: need.key,
          $items: {
            versionId: version._id,
            from,
            count: Math.min(EXPORT_ITEMS, version.itemCount - from),
          },
        },
      ],
      after,
      undefined,
      [need],
    );
  }
  const batch = await pages
    .query("documentArtifacts")
    .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
      q
        .eq("companyId", doc.companyId)
        .eq("environment", doc.environment)
        .eq("documentId", doc._id)
        .lte("importedAt", job.createdAt),
    )
    .paginate({
      cursor: state.cursor,
      numItems: 1,
      maximumRowsRead: 1,
      maximumBytesRead: 200_000,
    });
  const artifact = batch.page[0];
  if (artifact && artifact.organizationId !== job.organizationId) return deny("NOT_FOUND");
  return finish(
    artifact
      ? [
          {
            type: "artifact",
            id: artifact._id,
            documentId: doc._id,
            sha256: artifact.sha256,
            size: artifact.size,
            source: artifact.source,
            importedAt: artifact.importedAt,
          },
        ]
      : [],
    batch.isDone
      ? {
          phase: state.documentsDone ? afterDocuments : "documents",
          cursor: state.documentsDone ? null : (state.documentCursor ?? null),
        }
      : { ...state, cursor: batch.continueCursor },
    exportedOriginal(artifact),
  );
}
/** The original an export record carries; one with no stored copy fails the part, as before. */
function exportedOriginal(artifact: Doc<"documentArtifacts"> | undefined) {
  if (!artifact) return undefined;
  const source = originalSourceOf(artifact);
  if (!source) throw new Error("EXPORT_ORIGINAL_UNAVAILABLE");
  return { artifactId: artifact._id, source };
}
export const start = internalQuery({
  args: { ...stepArgs, now: v.number() },
  returns: v.union(v.null(), v.object({ checkpoint: v.string(), header: v.string() })),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("documentExports", args.exportId);
    if (
      !job ||
      job.sequence !== args.sequence ||
      job.state !== "running" ||
      job.expiresAt <= args.now
    )
      return null;
    await exportAllowed(ctx, job, args.now);
    return {
      checkpoint: job.checkpoint,
      header: JSON.stringify({
        type: "manifest",
        format: "freecorps-documents/1",
        // An assisted export names the origin's job, the one the owner downloads (ADR 0009, §7).
        exportId: job.assisted?.exportId ?? job._id,
        part: job.sequence,
        organizationId: job.organizationId,
        selection: job.selection,
        environment: job.environment,
        requestedAt: job.createdAt,
        expiresAt: job.expiresAt,
        consistency: "published-before-request; metadata-observed-during-export",
        certificatesIncluded: false,
      }),
    };
  },
});
