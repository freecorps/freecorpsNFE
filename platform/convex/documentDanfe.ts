import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { chargeDownload } from "./lib/capacityCore";
import { inCustody } from "./lib/coldArchiveCore";
import { cardOf, type DocumentScope } from "./lib/documentCore";
import { sha256 } from "./lib/documentContent";
import { originalAvailable, originalSourceOf } from "./lib/documentOriginalRead";
import {
  DANFE_ORIGIN,
  DANFE_RENDERS_PER_MINUTE,
  DANFE_VERSION,
  MAX_DANFE_EVENTS,
  MAX_DANFE_EVENT_VERSIONS,
  danfeRendering,
  danfeResolution,
  danfeSources,
} from "./lib/danfeValues";
import { deny, limitOrganizationAction } from "./lib/organizationAccess";
import { recordAudit } from "./lib/operationalAudit";

/**
 * DANFE delivery (#402, docs/plataforma/DANFE.md). The PDF is derived from the preserved NF-e
 * XML and the preserved cancellation events of the same document; it is rendered on the first
 * download by `danfeWorker.render`, kept in `documentDanfes` and served again while the
 * generator version, the XML and the evidence stay the same. The callers (REST and the console
 * ticket) authorize the scope and load the published document first.
 */
type Resolution = Infer<typeof danfeResolution>;
type Sources = Infer<typeof danfeSources>;
type Scope = DocumentScope & { organizationId: Doc<"organizations">["_id"] };
type Row = Doc<"documentDanfes">;

/** A file name built from the access key only: 44 characters of [0-9A-Z]. */
function fileName(doc: Doc<"fiscalDocuments">) {
  return `danfe-${doc.fiscalKey.replace(/[^0-9A-Za-z]/g, "").slice(0, 44) || "nfe"}.pdf`;
}

/**
 * The XML original of the published NF-e and the distinct cancellation events (`procEventoNFe`
 * with a SEFAZ reply) linked to the same document in the same organization, company and
 * environment, sorted by SHA-256. The generator decides whether each one counts, as the import
 * does; a bare `evento` or a summary has no reply to show and is left out. Anything but a
 * complete NF-e 55 has no DANFE. A file that is no longer stored refuses before any rendering:
 * a DANFE without a preserved cancellation would show the note as valid.
 */
async function sources(
  ctx: MutationCtx,
  scope: Scope,
  doc: Doc<"fiscalDocuments">,
  version: Doc<"documentVersions">,
): Promise<Sources> {
  if (doc.model !== "55" || version.kind !== "invoice") return deny("DANFE_UNAVAILABLE");
  const original = await ctx.db.get("documentArtifacts", version.artifactId);
  if (
    !original ||
    original.organizationId !== scope.organizationId ||
    original.companyId !== scope.companyId ||
    original.environment !== scope.environment
  )
    return deny("NOT_FOUND");
  const originalFile = originalSourceOf(original);
  if (!originalFile || !(await originalAvailable(ctx, original)))
    return deny("ORIGINAL_UNAVAILABLE");
  const versions = await ctx.db
    .query("documentVersions")
    .withIndex("by_documentId_kind_publishedAt", (q) =>
      q.eq("documentId", doc._id).eq("kind", "event").gt("publishedAt", 0),
    )
    .take(MAX_DANFE_EVENT_VERSIONS + 1);
  if (versions.length > MAX_DANFE_EVENT_VERSIONS) return deny("DANFE_EVIDENCE_LIMIT");
  const events = new Map<string, Sources["events"][number]>();
  for (const event of versions) {
    if (event.state !== "complete") continue;
    // The card says it once the blob exists (ADR 0010, B5); before, the inline content does.
    if (!(event.card?.cancellation ?? cardOf(doc, event).cancellation)) continue;
    const artifact = await ctx.db.get("documentArtifacts", event.artifactId);
    if (
      !artifact ||
      artifact.organizationId !== scope.organizationId ||
      artifact.companyId !== scope.companyId ||
      artifact.environment !== scope.environment
    )
      continue;
    const file = originalSourceOf(artifact);
    if (!file || !(await originalAvailable(ctx, artifact))) return deny("ORIGINAL_UNAVAILABLE");
    events.set(artifact.sha256, file);
  }
  if (events.size > MAX_DANFE_EVENTS) return deny("DANFE_EVIDENCE_LIMIT");
  const sorted = [...events.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
  const origin = sorted.length ? DANFE_ORIGIN : null;
  const evidence = JSON.stringify({ events: sorted.map((event) => event.sha256), origin });
  return {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    environment: scope.environment,
    documentId: doc._id,
    original: originalFile,
    events: sorted,
    origin,
    evidenceSha256: await sha256(new TextEncoder().encode(evidence)),
  };
}

async function cached(ctx: MutationCtx, documentId: Doc<"fiscalDocuments">["_id"]) {
  return ctx.db
    .query("documentDanfes")
    .withIndex("by_documentId", (q) => q.eq("documentId", documentId))
    .unique();
}
const sameKey = (row: Row, found: Sources) =>
  row.generatorVersion === DANFE_VERSION &&
  row.sourceSha256 === found.original.sha256 &&
  row.evidenceSha256 === found.evidenceSha256;

/**
 * The stored PDF when its key still matches, charged as a download under `transferKey`; else
 * what to render, under the organization's render budget. A refusal of the generator recorded
 * for the same key answers again without rendering. `recheck` (the access check after the bytes
 * were read) and `rendered` (the step right after this request's own rendering) neither charge
 * the render budget nor render again, so one request takes at most one render token.
 */
export async function resolveDanfe(
  ctx: MutationCtx,
  scope: Scope,
  doc: Doc<"fiscalDocuments">,
  version: Doc<"documentVersions">,
  options: { transferKey?: string; recheck?: boolean; rendered?: boolean },
): Promise<Resolution> {
  const found = await sources(ctx, scope, doc, version);
  const row = await cached(ctx, doc._id);
  const name = fileName(doc);
  if (row && sameKey(row, found)) {
    if (row.refusal) return deny("DANFE_UNAVAILABLE");
    if (row.storageId && (await ctx.db.system.get("_storage", row.storageId))) {
      if (options.transferKey && !options.recheck)
        await chargeDownload(ctx, scope.organizationId, row.storageId, options.transferKey);
      return { state: "ready", storageId: row.storageId, name };
    }
  }
  if (!options.recheck && !options.rendered)
    await limitOrganizationAction(
      ctx,
      "danfe-render",
      scope.organizationId,
      DANFE_RENDERS_PER_MINUTE,
    );
  return { state: "render", sources: found, name };
}

/**
 * Serves the DANFE through `step`, the caller's authorizing mutation: resolve (and charge),
 * render once when the cache misses, read the bytes, then check the access again. `first` is a
 * resolution the caller already made with `transferKey`, so it is neither repeated nor charged
 * twice. Any race with a newer rendering or newer evidence answers `UNAVAILABLE` (503,
 * retryable): the PDF read is never sent once its key is stale.
 */
export async function serveDanfe(
  ctx: Pick<ActionCtx, "runAction" | "storage">,
  /** `recheck` names the file read; the caller audits the download when it is still current. */
  step: (options: {
    transferKey?: string;
    recheck?: Id<"_storage">;
    rendered?: boolean;
  }) => Promise<Resolution>,
  first?: { found: Resolution; transferKey: string },
) {
  const transferKey = first?.transferKey ?? crypto.randomUUID();
  let found = first?.found ?? (await step({ transferKey }));
  if (found.state === "render") {
    const failed = await ctx.runAction(internal.danfeWorker.render, { sources: found.sources });
    if (failed) return deny(failed);
    // A refusal the worker recorded answers here as DANFE_UNAVAILABLE.
    found = await step({ transferKey, rendered: true });
    // The evidence changed while rendering: the next request renders the new one.
    if (found.state === "render") return deny("UNAVAILABLE");
  }
  // Replaced by a newer rendering between the two steps.
  const blob = await ctx.storage.get(found.storageId);
  if (!blob) return deny("UNAVAILABLE");
  const after = await step({ recheck: found.storageId });
  // The key changed while the bytes were read: they are stale.
  if (after.state !== "ready" || after.storageId !== found.storageId) return deny("UNAVAILABLE");
  return { blob, name: found.name };
}

export const danfeHeaders = (name: string) => ({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "application/pdf",
  "Content-Disposition": `attachment; filename="${name}"`,
});

/** The audit entry of a DANFE download, on the recheck after the bytes were read. */
export async function auditDanfe(
  ctx: MutationCtx,
  entry: Scope & { projectId: Doc<"projects">["_id"]; actor: string; requestId: string },
  doc: Doc<"fiscalDocuments">,
) {
  await recordAudit(ctx, {
    ...entry,
    action: "http.danfeDownload",
    target: doc._id,
    status: 200,
  });
}

/**
 * Records a rendering, or a refusal of the generator, under the key it was made from, replacing
 * the previous row of the document (and its file). Dropped, with its file, when the document is
 * gone, the organization is in cold custody, the version is not this deployment's, or the key is
 * no longer the document's current one: a slow old rendering never replaces a newer row. A
 * repeated rendering of the current key keeps the first file.
 */
export const record = internalMutation({
  args: { sources: danfeSources, generatorVersion: v.string(), result: danfeRendering },
  returns: v.null(),
  handler: async (ctx, { sources: rendered, generatorVersion, result }) => {
    const storageId = result.kind === "pdf" ? result.storageId : undefined;
    const drop = async () => {
      if (storageId) await ctx.storage.delete(storageId);
      return null;
    };
    const doc = await ctx.db.get("fiscalDocuments", rendered.documentId);
    if (
      !doc ||
      generatorVersion !== DANFE_VERSION ||
      doc.organizationId !== rendered.organizationId ||
      doc.companyId !== rendered.companyId ||
      doc.environment !== rendered.environment ||
      !doc.publishedVersionId ||
      (await inCustody(ctx, rendered.organizationId))
    )
      return drop();
    const version = await ctx.db.get("documentVersions", doc.publishedVersionId);
    if (!version) return drop();
    let current: Sources;
    try {
      current = await sources(ctx, rendered, doc, version);
    } catch {
      return drop();
    }
    if (
      current.original.sha256 !== rendered.original.sha256 ||
      current.evidenceSha256 !== rendered.evidenceSha256
    )
      return drop();
    const row = await cached(ctx, doc._id);
    // The same key is already recorded: a refusal, or a file still stored, stays.
    if (
      row &&
      sameKey(row, current) &&
      (row.refusal !== undefined ||
        (row.storageId && (await ctx.db.system.get("_storage", row.storageId))))
    )
      return drop();
    if (row) {
      if (row.storageId && (await ctx.db.system.get("_storage", row.storageId)))
        await ctx.storage.delete(row.storageId);
      await ctx.db.delete("documentDanfes", row._id);
    }
    await ctx.db.insert("documentDanfes", {
      organizationId: rendered.organizationId,
      companyId: rendered.companyId,
      environment: rendered.environment,
      documentId: rendered.documentId,
      generatorVersion,
      sourceSha256: rendered.original.sha256,
      evidenceSha256: rendered.evidenceSha256,
      eventCount: rendered.events.length,
      origin: rendered.origin,
      generatedAt: Date.now(),
      ...(result.kind === "pdf"
        ? { storageId: result.storageId, pdfSha256: result.pdfSha256, size: result.size }
        : { refusal: result.code }),
    });
    return null;
  },
});
