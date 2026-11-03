import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { DocumentContent, DocumentContentRef } from "./documentContent";
import type { ContentLocation } from "./documentContentRead";

/**
 * Phase B readers (ADR 0010, B5). A query cannot read file storage, so every reader of a
 * version's content runs in three steps:
 *
 * 1. a query selects: it checks access, paginates and returns a plan, the metadata the response
 *    needs plus one `ContentNeed` per version whose content it uses;
 * 2. a Node action reads each blob the plan names, whole, through the codec, and keeps only the
 *    parts the plan asked for (`extractParts`);
 * 3. a pure renderer builds the response from the plan and the parts, and the action runs the
 *    query again: the response goes out only if the second plan is the same (access, version and
 *    blob unchanged in between).
 *
 * A version without a blob (published before B4, over the cap, a failed writer) is a normal
 * state: its need carries the parts read inline, and no storage read happens. A version with a
 * blob is always read from the blob, even while the inline copy still exists (until B8).
 */
export type ItemsWant = { from: number; limit: number; maxBytes: number };
export type ContentWant = {
  result?: true;
  fiscalEvidence?: true;
  items?: ItemsWant;
};
export type ContentParts = {
  result?: string;
  fiscalEvidence?: string | null;
  items?: string[];
};
/** A blob reference: hot (`storageId`) or, after the passage of phase C, cold (`objectKey`). */
export type StoredContentRef = DocumentContentRef & ContentLocation;
export type ContentNeed = { key: string; want: ContentWant } & (
  | { inline: ContentParts }
  | { blob: StoredContentRef }
);
export type ContentPlan<D = unknown> = { renderer: string; data: D; needs: ContentNeed[] };
export type PlannedParts = Record<string, ContentParts>;

/** Items of a page, as `/items` returned them before: at most `limit`, about `maxBytes`. */
export const ITEMS_PAGE_BYTES = 400_000;

const corrupt = (reason: string): never => {
  throw new ConvexError({ code: "DOCUMENT_CONTENT_CORRUPT", reason });
};

/**
 * The blob reference of a version, `null` without one; a partial reference is corruption. The
 * blob is in exactly one place: file storage while hot, the cold tier's bucket once moved.
 */
export function storedRef(version: Doc<"documentVersions">): StoredContentRef | null {
  const location = [version.contentStorageId, version.contentObjectKey];
  const fields = [version.contentSha256, version.contentSize, version.contentFormat];
  const placed = location.filter((field) => field !== undefined).length;
  if (placed === 0 && fields.every((field) => field === undefined)) return null;
  if (placed !== 1 || fields.some((field) => field === undefined)) return corrupt("reference");
  const ref = {
    contentSha256: version.contentSha256!,
    contentSize: version.contentSize!,
    format: version.contentFormat!,
  };
  return version.contentStorageId !== undefined
    ? { storageId: version.contentStorageId, ...ref }
    : { objectKey: version.contentObjectKey!, ...ref };
}

/** Takes items from `from` while under `limit` and, after the first, under `maxBytes`. */
function pageOf(items: string[], want: ItemsWant) {
  const page: string[] = [];
  let bytes = 0;
  for (let position = want.from; position < items.length && page.length < want.limit; position++) {
    const size = items[position]!.length;
    if (page.length && bytes + size > want.maxBytes) break;
    page.push(items[position]!);
    bytes += size;
  }
  return page;
}

/** Keeps only what the plan asked for of one decoded content; the rest is dropped at once. */
export function extractParts(content: DocumentContent, want: ContentWant): ContentParts {
  return {
    ...(want.result ? { result: content.result } : {}),
    ...(want.fiscalEvidence ? { fiscalEvidence: content.fiscalEvidence ?? null } : {}),
    ...(want.items ? { items: pageOf(content.items, want.items) } : {}),
  };
}

/**
 * The need of one version. With a blob, the reference; without, the parts read now, inline. The
 * evidence snapshot is not a part: only the projection worker reads it, from its evidence row
 * (`lib/documentContentLoad.ts`).
 */
export async function contentNeed(
  ctx: QueryCtx,
  key: string,
  version: Doc<"documentVersions">,
  want: ContentWant,
): Promise<ContentNeed> {
  const ref = storedRef(version);
  if (ref) return { key, want, blob: ref };
  if (version.result === undefined) return corrupt("inline content");
  let items: string[] | undefined;
  if (want.items) {
    // Row by row, stopping at the same page bounds the blob path applies, so a page of large
    // items never reads more rows than it returns. Positions run 0, 1, 2… (B4 checks it before
    // encoding); a gap here is corruption.
    const { from, limit, maxBytes } = want.items;
    items = [];
    let bytes = 0;
    for await (const row of ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) =>
        q.eq("versionId", version._id).gte("position", from),
      )) {
      if (row.position !== from + items.length) corrupt("item position");
      if (items.length && bytes + row.data.length > maxBytes) break;
      items.push(row.data);
      bytes += row.data.length;
      if (items.length >= limit) break;
    }
  }
  return {
    key,
    want,
    inline: {
      ...(want.result ? { result: version.result } : {}),
      ...(want.fiscalEvidence ? { fiscalEvidence: version.fiscalEvidence ?? null } : {}),
      ...(items ? { items } : {}),
    },
  };
}

/** The parts of a need already answered inline, for renderers that run without the action. */
export function inlineParts(plan: ContentPlan): PlannedParts | null {
  const parts: PlannedParts = {};
  for (const need of plan.needs) {
    if (!("inline" in need)) return null;
    parts[need.key] = need.inline;
  }
  return parts;
}

/** A part the renderer needs; its absence is a bug of the plan, never an empty response. */
export function part<K extends keyof ContentParts>(
  parts: PlannedParts,
  key: string,
  name: K,
): NonNullable<ContentParts[K]> {
  const value = parts[key]?.[name];
  if (value === undefined || value === null) return corrupt(`part ${key}.${name}`);
  return value as NonNullable<ContentParts[K]>;
}
