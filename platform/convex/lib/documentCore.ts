import { insertFiscal, patchFiscal, deleteFiscal } from "./capacityCore";
import {
  projectDocumentPayload,
  type PublicDocumentSummary,
  type PublicDocumentVersion,
} from "@freecorps/contracts";
import { accessKeyNumber } from "@freecorps/fiscal-core";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { keyAccess, memberAccess } from "./operationAccess";
import { currentRow } from "./coldArchiveCurrent";
import { originalId } from "./coldArchiveOrigin";
import { deny } from "./organizationAccess";
import { ConvexError } from "convex/values";
import { originalAvailable } from "./documentOriginalRead";

/** `projectId` comes from the API key's project; the console reads the company without one. */
export type DocumentScope = {
  organizationId: Id<"organizations">;
  companyId: Id<"companies">;
  projectId?: Id<"projects">;
  environment: "sandbox" | "production";
};
export const readTask = {
  name: "documents.read",
  scope: "documents:read",
  workload: "import",
} as const;
/** Keys read under their project's grant; people read the company (`memberAccess`). */
export async function documentAccess(ctx: QueryCtx, scope: DocumentScope, keyHash?: string) {
  if (keyHash) {
    if (!scope.projectId) return deny("NOT_FOUND");
    await keyAccess(ctx, keyHash, { ...scope, projectId: scope.projectId, task: readTask });
    return null;
  }
  return memberAccess(ctx, { ...scope, task: readTask }, false);
}
export async function loadDocument(
  ctx: QueryCtx,
  scope: DocumentScope,
  value: string,
  keyHash?: string,
) {
  await documentAccess(ctx, scope, keyHash);
  return loadScopedDocument(ctx, scope, value);
}
/**
 * Caller authorizes the page once; every persisted document still proves its own scope. An ID the
 * document had before a rehydration resolves through the organization's ID map (ADR 0009, §6).
 */
export async function loadScopedDocument(ctx: QueryCtx, scope: DocumentScope, value: string) {
  const doc = await currentRow(ctx, scope.organizationId, "fiscalDocuments", value);
  if (
    !doc ||
    doc.organizationId !== scope.organizationId ||
    doc.companyId !== scope.companyId ||
    doc.environment !== scope.environment ||
    !doc.publishedVersionId
  )
    return deny("NOT_FOUND");
  const version = await ctx.db.get("documentVersions", doc.publishedVersionId);
  const op = version ? await ctx.db.get("operations", version.operationId) : null;
  if (!version || version.state !== "complete" || op?.state !== "succeeded")
    return deny("NOT_FOUND");
  return { doc, version };
}
/** The public payload of a version, from its stored `result` text (inline or from the blob). */
export function payloadOf(result: string) {
  const stored = JSON.parse(result) as { document: unknown };
  return projectDocumentPayload(stored.document);
}
/** Inline only: callers that still read `result` from the row (before B6 moves them). */
export function payload(version: Doc<"documentVersions">) {
  if (version.result === undefined)
    throw new ConvexError({ code: "DOCUMENT_CONTENT_CORRUPT", reason: "inline content" });
  return payloadOf(version.result);
}
/**
 * The listing of a document. B4 writes the version's `card` with these same fields when it
 * stores the blob, so a listing never needs the content; a version without a card yet (no blob)
 * reads them from the inline `result`.
 */
export function summary(
  doc: Doc<"fiscalDocuments">,
  version: Doc<"documentVersions">,
): PublicDocumentSummary {
  const card = version.card ?? cardOf(doc, version);
  return {
    id: String(doc._id),
    ...originalId(doc),
    model: doc.model,
    key: doc.fiscalKey,
    kind: card.kind,
    importedAt: doc.createdAt,
    issuedAt: card.issuedAt,
    number: card.number,
    issuer: card.issuer,
    total: card.total,
    completeness:
      card.kind === "invoice" || card.kind === "service-invoice"
        ? ("full-xml" as const)
        : card.kind === "summary"
          ? ("summary" as const)
          : ("event-only" as const),
    source: card.source,
    fiscalStatus:
      doc.projectionState === "ready"
        ? (doc.fiscalSituation?.reportedStatus ?? "unknown")
        : "unknown",
    projectionState: doc.projectionState ?? ("pending" as const),
    versionId: String(version._id),
    resourceVersion: doc.publicVersion ?? 0,
    processing: "complete" as const,
  };
}
export type DocumentCard = Pick<
  PublicDocumentSummary,
  "kind" | "issuedAt" | "number" | "issuer" | "total" | "source"
> & { cancellation?: boolean };
/** The card of a version from its inline `result`, as the writer (B4) stores it. */
export function cardOf(
  doc: Doc<"fiscalDocuments">,
  version: Doc<"documentVersions">,
): DocumentCard {
  const data = payload(version);
  return {
    kind: data.kind,
    issuedAt:
      data.kind === "invoice" || data.kind === "summary" || data.kind === "service-invoice"
        ? data.issuedAt
        : null,
    // A summary or an event names its NF-e only by the key; the number comes from it (#462).
    number:
      data.kind === "invoice" || data.kind === "service-invoice"
        ? data.number
        : doc.model === "55"
          ? (accessKeyNumber(doc.fiscalKey)?.number ?? null)
          : null,
    issuer:
      data.kind === "invoice" || data.kind === "summary" || data.kind === "service-invoice"
        ? data.issuer.name
        : null,
    total:
      data.kind === "invoice" || data.kind === "summary" || data.kind === "service-invoice"
        ? data.total
        : null,
    source:
      (
        JSON.parse(version.result!) as {
          metadata?: { source?: "imported-xml" | "distribution-xml" };
        }
      ).metadata?.source ?? "imported-xml",
    // Always present on an event: a card without it predates B5 and is read inline instead.
    ...(data.kind === "event" ? { cancellation: Boolean(data.cancellation && data.receipt) } : {}),
  };
}
export async function versionInfo(
  ctx: QueryCtx,
  version: Doc<"documentVersions">,
): Promise<PublicDocumentVersion> {
  const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
  return {
    id: String(version._id),
    ...originalId(version),
    operationId: String(version.operationId),
    artifactId: String(artifact._id),
    sha256: artifact.sha256,
    source: artifact.source,
    importedAt: artifact.importedAt,
    publishedAt: version.publishedAt ?? version.completedAt!,
    parserVersion: version.parserVersion,
    normalizerVersion: version.normalizerVersion,
    processorVersion: version.processorVersion,
    schema: version.schema,
    code: version.code,
    kind: version.kind,
    itemCount: version.itemCount,
    originalAvailable: await originalAvailable(ctx, artifact),
  };
}
export async function updateListings(ctx: MutationCtx, doc: Doc<"fiscalDocuments">) {
  const rows = await ctx.db
    .query("documentListings")
    .withIndex("by_documentId", (q) => q.eq("documentId", doc._id))
    .take(5);
  for (const row of rows) await deleteFiscal(ctx, "documentListings", row._id);
  const status =
    doc.projectionState === "ready"
      ? (doc.fiscalSituation?.reportedStatus ?? "unknown")
      : "unknown";
  const version = doc.publishedVersionId
    ? await ctx.db.get("documentVersions", doc.publishedVersionId)
    : null;
  const artifact = version ? await ctx.db.get("documentArtifacts", version.artifactId) : null;
  const source = artifact?.source ?? "imported-xml";
  for (const filterKey of [`*:*`, `*:${source}`, `${status}:*`, `${status}:${source}`])
    await insertFiscal(ctx, "documentListings", {
      documentId: doc._id,
      companyId: doc.companyId,
      environment: doc.environment,
      filterKey,
      date: doc.createdAt,
    });
  await patchFiscal(ctx, "fiscalDocuments", doc._id, { listedAt: Date.now() });
}

/** The published version of a document, or `versionId` of the same document when given. */
export async function resolveDocumentVersion(
  ctx: QueryCtx,
  args: DocumentScope & { documentId: string; versionId?: string },
  keyHash?: string,
) {
  const { doc, version: current } = await loadDocument(ctx, args, args.documentId, keyHash);
  if (!args.versionId) return { doc, version: current };
  const candidate = await currentRow(ctx, args.organizationId, "documentVersions", args.versionId);
  const op = candidate ? await ctx.db.get("operations", candidate.operationId) : null;
  if (
    !candidate ||
    candidate.documentId !== doc._id ||
    candidate.state !== "complete" ||
    op?.state !== "succeeded"
  )
    return deny("NOT_FOUND");
  return { doc, version: candidate };
}
