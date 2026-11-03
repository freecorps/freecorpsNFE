import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import {
  decodeDocumentContent,
  sha256,
  type DocumentContent,
  type DocumentContentRef,
} from "../lib/documentContent";
import { requireReadProof } from "./operationProof";

async function synthetic(ctx: QueryCtx, versionId: Id<"documentVersions">) {
  requireReadProof();
  const version = await ctx.db.get("documentVersions", versionId);
  const op = version && (await ctx.db.get("operations", version.operationId));
  const org = op && (await ctx.db.get("organizations", op.organizationId));
  if (
    !version ||
    version.processorVersion !== "synthetic/1" ||
    !org?.slug.startsWith("content642-")
  )
    throw new Error("SYNTHETIC_SCOPE");
  return version;
}

// Configure only unpublished B4 fixtures; bounded batches keep setup below transaction limits.
export const configure = internalMutation({
  args: {
    versionId: v.id("documentVersions"),
    result: v.optional(v.string()),
    fiscalEvidence: v.optional(v.string()),
    batch: v.optional(v.boolean()),
    items: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const version = await synthetic(ctx, args.versionId);
    if (
      version.publishedAt !== undefined ||
      args.items.length > 64 ||
      version.itemCount + args.items.length > 1024 ||
      new TextEncoder().encode(JSON.stringify(args)).length > 600_000
    )
      throw new Error("SYNTHETIC_FIXTURE_LIMIT");
    for (const [offset, data] of args.items.entries()) {
      JSON.parse(data);
      await ctx.db.insert("documentItems", {
        versionId: version._id,
        position: version.itemCount + offset,
        data,
      });
    }
    await ctx.db.patch("documentVersions", version._id, {
      ...(args.batch ? { kind: "service-invoice-batch", documentId: undefined } : {}),
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.fiscalEvidence === undefined
        ? {}
        : {
            fiscalEvidence: args.fiscalEvidence,
            fiscalFingerprint: await sha256(new TextEncoder().encode(args.fiscalEvidence)),
          }),
      itemCount: version.itemCount + args.items.length,
      writtenItems: version.itemCount + args.items.length,
    });
    return null;
  },
});

export const resolve = internalQuery({
  args: { versionId: v.id("documentVersions"), inline: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const version = await synthetic(ctx, args.versionId);
    if (!args.inline && version.contentStorageId)
      return JSON.stringify({
        storageId: version.contentStorageId,
        ref: {
          format: version.contentFormat,
          contentSize: version.contentSize,
          contentSha256: version.contentSha256,
        },
        metrics: await ctx.meta.getTransactionMetrics(),
      });
    const items = await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
      .take(1025);
    if (items.length !== version.itemCount || items.some((item, i) => item.position !== i))
      throw new Error("ITEM_POSITIONS");
    const evidenceSource = version.fiscalEvidence
      ? (JSON.parse(version.fiscalEvidence) as { metadata?: { originalSha256?: string } })
      : null;
    const originalSha256 = evidenceSource?.metadata?.originalSha256;
    const evidence =
      version.documentId && originalSha256 && version.fiscalFingerprint
        ? await ctx.db
            .query("documentFiscalEvidence")
            .withIndex("by_variant", (q) =>
              q
                .eq("documentId", version.documentId!)
                .eq("ruleVersion", "nfe-status/1")
                .eq("originalSha256", originalSha256)
                .eq("fingerprint", version.fiscalFingerprint!),
            )
            .unique()
        : null;
    const snapshot = evidence?.versionId === version._id ? evidence.snapshot : undefined;
    const content: DocumentContent = {
      result: version.result!,
      items: items.map((item) => item.data),
      ...(version.fiscalEvidence === undefined ? {} : { fiscalEvidence: version.fiscalEvidence }),
      ...(snapshot === undefined ? {} : { snapshot }),
    };
    return JSON.stringify({ content, metrics: await ctx.meta.getTransactionMetrics() });
  },
});

export const read = internalAction({
  args: { versionId: v.id("documentVersions"), inline: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    requireReadProof();
    const resolved: {
      storageId?: Id<"_storage">;
      ref: DocumentContentRef;
      content: DocumentContent;
      metrics: Awaited<ReturnType<QueryCtx["meta"]["getTransactionMetrics"]>>;
    } = JSON.parse(await ctx.runQuery(internal.testing.documentReadProof.resolve, args));
    let content: DocumentContent = resolved.content;
    let storedSize = 0;
    if (resolved.storageId) {
      const blob = await ctx.storage.get(resolved.storageId);
      if (!blob) throw new Error("BLOB_MISSING");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      storedSize = bytes.length;
      content = await decodeDocumentContent(bytes, resolved.ref);
    }
    // Full projection crosses the action boundary and is parsed/compared by the caller.
    return JSON.stringify({
      source: resolved.storageId ? "blob" : "inline",
      storedSize,
      metrics: resolved.metrics,
      projection: {
        result: JSON.parse(content.result),
        items: content.items.map((item) => JSON.parse(item)),
        ...(content.fiscalEvidence === undefined
          ? {}
          : { fiscalEvidence: JSON.parse(content.fiscalEvidence) }),
        ...(content.snapshot === undefined ? {} : { snapshot: JSON.parse(content.snapshot) }),
      },
    });
  },
});

export const damage = internalMutation({
  args: { versionId: v.id("documentVersions"), missing: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const version = await synthetic(ctx, args.versionId);
    if (!version.contentStorageId) throw new Error("BLOB_MISSING");
    if (args.missing) await ctx.storage.delete(version.contentStorageId);
    else await ctx.db.patch("documentVersions", version._id, { contentSha256: "0".repeat(64) });
    return null;
  },
});
