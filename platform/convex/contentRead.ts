import { v, type ObjectType } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { documentItems, documentVersions, getDocument } from "./documents";
import { historyPlan } from "./importHistory";
import { importDetailPlan } from "./imports";
import { sha256 } from "./lib/documentContent";
import type { ContentPlan } from "./lib/documentContentPlan";
import { readerArgs } from "./contentReadArgs";

/**
 * The console's readers of version content (ADR 0010, B6). Each has two entry points with the
 * same arguments:
 *
 * - a token query, reactive and cheap: the SHA-256 of the selection. It changes whenever access,
 *   the version, its blob or the page changes;
 * - an internal selection, which the public Node action of `documentContentNode.ts` reads,
 *   renders and selects again, under the caller's identity.
 *
 * The console subscribes to the token and calls the action again when it changes, so the screen
 * follows the database as it did with the queries that read inline.
 */
type ReaderArgs<K extends keyof typeof readerArgs> = ObjectType<(typeof readerArgs)[K]>;

const planned = (plan: ContentPlan | null) => JSON.stringify(plan ? { $plan: plan } : null);
const selectors: {
  [K in keyof typeof readerArgs]: (ctx: QueryCtx, args: ReaderArgs<K>) => Promise<string>;
} = {
  documentDetail: async (ctx, args) => planned(await getDocument(ctx, args)),
  documentItems: async (ctx, args) => planned(await documentItems(ctx, args)),
  documentVersions: async (ctx, args) => planned(await documentVersions(ctx, args)),
  importDetail: async (ctx, args) => planned(await importDetailPlan(ctx, args)),
  importHistory: async (ctx, args) => planned(await historyPlan(ctx, args.fileId)),
};
const token = async (selection: string) => sha256(new TextEncoder().encode(selection));

export const documentDetail = internalQuery({
  args: readerArgs.documentDetail,
  returns: v.string(),
  handler: (ctx, args) => selectors.documentDetail(ctx, args),
});
export const documentDetailToken = query({
  args: readerArgs.documentDetail,
  returns: v.string(),
  handler: async (ctx, args) => token(await selectors.documentDetail(ctx, args)),
});
export const documentItemsPage = internalQuery({
  args: readerArgs.documentItems,
  returns: v.string(),
  handler: (ctx, args) => selectors.documentItems(ctx, args),
});
export const documentItemsToken = query({
  args: readerArgs.documentItems,
  returns: v.string(),
  handler: async (ctx, args) => token(await selectors.documentItems(ctx, args)),
});
export const documentVersionsPage = internalQuery({
  args: readerArgs.documentVersions,
  returns: v.string(),
  handler: (ctx, args) => selectors.documentVersions(ctx, args),
});
export const documentVersionsToken = query({
  args: readerArgs.documentVersions,
  returns: v.string(),
  handler: async (ctx, args) => token(await selectors.documentVersions(ctx, args)),
});
export const importDetail = internalQuery({
  args: readerArgs.importDetail,
  returns: v.string(),
  handler: (ctx, args) => selectors.importDetail(ctx, args),
});
export const importDetailToken = query({
  args: readerArgs.importDetail,
  returns: v.string(),
  handler: async (ctx, args) => token(await selectors.importDetail(ctx, args)),
});
export const importHistory = internalQuery({
  args: readerArgs.importHistory,
  returns: v.string(),
  handler: (ctx, args) => selectors.importHistory(ctx, args),
});
export const importHistoryToken = query({
  args: readerArgs.importHistory,
  returns: v.string(),
  handler: async (ctx, args) => token(await selectors.importHistory(ctx, args)),
});
