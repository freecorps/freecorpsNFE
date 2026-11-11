"use node";
import { createHash } from "node:crypto";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { DocumentContent } from "./lib/documentContent";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { readStoredContent, type ContentStorage } from "./lib/documentContentRead";
import {
  extractParts,
  storedRef,
  type ContentPlan,
  type PlannedParts,
} from "./lib/documentContentPlan";
import { renderPlan } from "./lib/documentRender";
import { action } from "./_generated/server";
import {
  documentDetail,
  historyResult,
  importDetailResult,
  itemsPage,
  versionsPage,
} from "./lib/documentValues";
import { readerArgs } from "./contentReadArgs";

/**
 * The parts of every need of a plan: inline as the query read them, or from the blob, one version
 * at a time, keeping only what the plan asked for. The runtime is Node: the headroom proof of
 * ADR 0010 (docs/v1.0/evidence/642/margin-hosted.md) measured 3x the cap here.
 */
export async function resolveParts(storage: ContentStorage, plan: ContentPlan) {
  const parts: PlannedParts = {};
  for (const need of plan.needs)
    parts[need.key] =
      "inline" in need
        ? need.inline
        : extractParts(await readStoredContent(storage, need.blob, need.blob), need.want);
  return parts;
}

/** A selection answered with `{ $plan }`; anything else is already the response. */
function unwrap(selected: string): ContentPlan | null {
  const value = JSON.parse(selected) as { $plan?: ContentPlan };
  return value && typeof value === "object" && value.$plan ? value.$plan : null;
}

/** Three tries before giving up when the document keeps changing between selections. */
const MAX_TRIES = 3;

/**
 * Selects, reads, renders, then selects again: the response leaves only when both selections are
 * the same text, so access, the version and its blob held from the selection to the response.
 */
export async function readSelected(select: () => Promise<string>, storage: ContentStorage) {
  let selected = await select();
  for (let attempt = 1; ; attempt++) {
    const plan = unwrap(selected);
    if (!plan) return selected;
    const data = JSON.stringify(renderPlan(plan, await resolveParts(storage, plan)));
    const again = await select();
    if (again === selected) return data;
    if (attempt >= MAX_TRIES) throw new ConvexError({ code: "UNAVAILABLE" });
    selected = again;
  }
}

const restArgs = {
  keyHash: v.string(),
  environment: v.string(),
  company: v.string(),
  path: v.string(),
  search: v.string(),
};
/** REST routes of `documentRest.plannedPath`: detail, `json`, `items`, `events` and `versions`. */
export const restRead = internalAction({
  args: restArgs,
  returns: v.string(),
  handler: async (ctx, args): Promise<string> =>
    readSelected(() => ctx.runQuery(internal.documentRest.dispatch, args), ctx.storage),
});

/** REST GET of imports: the batch summary and a file's history (`importRest.read`). */
export const importRead = internalAction({
  args: { keyHash: v.string(), environment: v.string(), path: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> =>
    readSelected(() => ctx.runQuery(internal.importRest.read, args), ctx.storage),
});

/**
 * The whole content of one version for the workers that need more than a part: from the blob
 * when the version has one, else from the row. Items stay out of the inline copy; no worker
 * here reads them.
 */
export async function versionContent(
  storage: ContentStorage,
  version: Doc<"documentVersions">,
): Promise<Omit<DocumentContent, "items">> {
  const ref = storedRef(version);
  if (ref) {
    const { items: _items, ...content } = await readStoredContent(storage, ref, ref);
    return content;
  }
  if (version.result === undefined)
    throw new ConvexError({ code: "DOCUMENT_CONTENT_CORRUPT", reason: "inline content" });
  return {
    result: version.result,
    ...(version.fiscalEvidence === undefined ? {} : { fiscalEvidence: version.fiscalEvidence }),
  };
}

/**
 * The snapshot of an evidence row. Inline while the row keeps it; once B8 moves it, from the blob
 * of the version that wrote it, checked against `snapshotSha256`.
 */
export async function evidenceSnapshot(
  storage: ContentStorage,
  row: Doc<"documentFiscalEvidence">,
  version: Doc<"documentVersions"> | undefined,
) {
  if (row.snapshot !== undefined) return row.snapshot;
  const snapshot = version ? (await versionContent(storage, version)).snapshot : undefined;
  if (
    snapshot === undefined ||
    !row.snapshotSha256 ||
    createHash("sha256").update(snapshot).digest("hex") !== row.snapshotSha256
  )
    throw new ConvexError({ code: "DOCUMENT_CONTENT_CORRUPT", reason: "snapshot" });
  return snapshot;
}

/**
 * The console's readers (B6): the same selection as the token query of `contentRead.ts`, under
 * the caller's identity, read and rendered here. The console calls them again when the token
 * changes.
 */
export const documentDetailRead = action({
  args: readerArgs.documentDetail,
  returns: documentDetail,
  handler: async (ctx, args): Promise<Infer<typeof documentDetail>> =>
    JSON.parse(
      await readSelected(
        (): Promise<string> => ctx.runQuery(internal.contentRead.documentDetail, args),
        ctx.storage,
      ),
    ) as Infer<typeof documentDetail>,
});
export const documentItemsRead = action({
  args: readerArgs.documentItems,
  returns: itemsPage,
  handler: async (ctx, args): Promise<Infer<typeof itemsPage>> =>
    JSON.parse(
      await readSelected(
        (): Promise<string> => ctx.runQuery(internal.contentRead.documentItemsPage, args),
        ctx.storage,
      ),
    ) as Infer<typeof itemsPage>,
});
export const documentVersionsRead = action({
  args: readerArgs.documentVersions,
  returns: versionsPage,
  handler: async (ctx, args): Promise<Infer<typeof versionsPage>> =>
    JSON.parse(
      await readSelected(
        (): Promise<string> => ctx.runQuery(internal.contentRead.documentVersionsPage, args),
        ctx.storage,
      ),
    ) as Infer<typeof versionsPage>,
});
export const importDetailRead = action({
  args: readerArgs.importDetail,
  returns: importDetailResult,
  handler: async (ctx, args): Promise<Infer<typeof importDetailResult>> =>
    JSON.parse(
      await readSelected(
        (): Promise<string> => ctx.runQuery(internal.contentRead.importDetail, args),
        ctx.storage,
      ),
    ) as Infer<typeof importDetailResult>,
});
export const importHistoryRead = action({
  args: readerArgs.importHistory,
  returns: historyResult,
  handler: async (ctx, args): Promise<Infer<typeof historyResult>> =>
    JSON.parse(
      await readSelected(
        (): Promise<string> => ctx.runQuery(internal.contentRead.importHistory, args),
        ctx.storage,
      ),
    ) as Infer<typeof historyResult>,
});
