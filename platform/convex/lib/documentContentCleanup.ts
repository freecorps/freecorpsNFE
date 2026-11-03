import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteFiscal, patchFiscal } from "./capacityCore";
import { sha256 } from "./documentContent";
import { storedRef } from "./documentContentPlan";
import { inlineContentRef, writtenEvidence } from "./documentContentWriter";

export type CleanupOutcome =
  | "cleared"
  | "already"
  | "noBlob"
  | "unverified"
  | "cardPending"
  | "corrupt"
  | "changed";

const hashOf = (text: string) => sha256(new TextEncoder().encode(text));

/**
 * ADR 0010, B8: removes the inline copy of a version whose blob was read back and found equal to
 * it (`contentVerifiedAt`). Goes: `result`, `fiscalEvidence` (its hash stays in
 * `fiscalEvidenceSha256` for `PROCESSING_CHANGED`), the version's `documentItems` rows and the
 * snapshot of the evidence row it wrote, when `snapshotSha256` matches it. Nothing else is
 * touched: metadata, the card, the artifact and the XML original stay. A version without a
 * verified blob, or whose card still lacks a field a query reads, keeps everything.
 */
export async function clearInlineContent(
  ctx: MutationCtx,
  version: Doc<"documentVersions">,
): Promise<CleanupOutcome> {
  if (version.result === undefined) return "already";
  let ref: ReturnType<typeof storedRef>;
  try {
    ref = storedRef(version);
  } catch {
    // A partial reference: the inline copy is the only sure content, so it stays.
    return "corrupt";
  }
  if (!ref) return "noBlob";
  if (version.contentVerifiedAt === undefined) return "unverified";
  // The verification is of the content at that moment: a late `fiscalEvidence` (a repeated
  // stage) may have reached the row after it. The inline copy goes only while it is still
  // exactly what the blob holds.
  const inline = await inlineContentRef(ctx, version);
  if (
    !inline ||
    inline.contentSha256 !== ref.contentSha256 ||
    inline.contentSize !== ref.contentSize
  )
    return "changed";
  // The listing and the DANFE read the card, never the content (B5).
  if (
    version.documentId &&
    (!version.card || (version.kind === "event" && version.card.cancellation === undefined))
  )
    return "cardPending";
  const evidence = await writtenEvidence(ctx, version);
  if (
    evidence?.snapshot !== undefined &&
    evidence.snapshotSha256 !== undefined &&
    (await hashOf(evidence.snapshot)) === evidence.snapshotSha256
  )
    await patchFiscal(ctx, "documentFiscalEvidence", evidence._id, { snapshot: undefined }, false);
  for (const item of await ctx.db
    .query("documentItems")
    .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
    .collect())
    await deleteFiscal(ctx, "documentItems", item._id);
  await patchFiscal(
    ctx,
    "documentVersions",
    version._id,
    {
      result: undefined,
      fiscalEvidence: undefined,
      ...(version.fiscalEvidence === undefined
        ? {}
        : { fiscalEvidenceSha256: await hashOf(version.fiscalEvidence) }),
    },
    false,
  );
  return "cleared";
}

/** Marks a version verified, if its blob is still the one that was read back. */
export async function markVerified(
  ctx: MutationCtx,
  versionId: Id<"documentVersions">,
  contentSha256: string,
) {
  const version = await ctx.db.get("documentVersions", versionId);
  if (!version || version.contentSha256 !== contentSha256) return false;
  if (version.contentVerifiedAt === undefined)
    await patchFiscal(
      ctx,
      "documentVersions",
      version._id,
      { contentVerifiedAt: Date.now() },
      false,
    );
  return true;
}

/** What a repeated `importProcessing.stage` brings, compared with the version already staged. */
export type StagedOutput = {
  outputHash: string;
  result: string;
  fiscalEvidence?: string;
  fiscalFingerprint?: string;
  schema: string | null;
  parserVersion: string;
  normalizerVersion: string | null;
  itemCount: number;
};
/**
 * `PROCESSING_CHANGED` (ADR 0010, B8): whether a repeated stage of the same operation produced
 * other output than the version it already wrote. Never compares an absent field with the new
 * text: once the inline copy went, `outputHash` (over `result` and the items) and
 * `fiscalEvidenceSha256` stand for it. A version without `outputHash` cannot be compared, so it
 * always counts as changed, as before.
 */
export async function stagedVersionChanged(existing: Doc<"documentVersions">, args: StagedOutput) {
  const cleared = existing.result === undefined;
  const evidenceChanged = cleared
    ? (existing.fiscalEvidenceSha256 ?? null) !==
      (args.fiscalEvidence ? await hashOf(args.fiscalEvidence) : null)
    : existing.fiscalEvidence !== undefined && existing.fiscalEvidence !== args.fiscalEvidence;
  return (
    existing.outputHash !== args.outputHash ||
    evidenceChanged ||
    (existing.fiscalFingerprint !== undefined &&
      existing.fiscalFingerprint !== args.fiscalFingerprint) ||
    (!cleared && existing.result !== args.result) ||
    existing.schema !== args.schema ||
    existing.parserVersion !== args.parserVersion ||
    existing.normalizerVersion !== args.normalizerVersion ||
    existing.itemCount !== args.itemCount
  );
}
