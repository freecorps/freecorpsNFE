"use node";
import { createHash } from "node:crypto";
import { v } from "convex/values";
import {
  deriveFiscalSituation,
  fiscalEvidenceIdentity,
  processNfe,
  replacedInterpretations,
  type ProcessedNfe,
} from "@freecorps/fiscal-nfe";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { evidenceSnapshot, versionContent } from "./documentContentNode";
import { originalSourceOf, readOriginal } from "./lib/documentOriginalRead";

/** Counts distinct interpretations, never reimport/reprocess history rows. */
export const MAX_FISCAL_VERSIONS = 256;
function compact(value: ProcessedNfe): ProcessedNfe {
  return {
    ...value,
    normalized: null,
    parsing: value.parsing
      ? {
          ...value.parsing,
          document:
            value.parsing.document.kind === "invoice"
              ? { ...value.parsing.document, products: [], totals: [] }
              : value.parsing.document,
        }
      : null,
  };
}
async function original(
  ctx: ActionCtx,
  artifact: Doc<"documentArtifacts"> | undefined,
  version: Doc<"documentVersions">,
) {
  // Hot or cold (ADR 0010, decision 8): a cold object is checked by `readOriginal`.
  const source = artifact ? originalSourceOf(artifact) : null;
  const bytes = source ? await readOriginal(ctx.storage, source) : null;
  if (!artifact || !bytes) throw new Error("ORIGINAL_UNAVAILABLE");
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error("ORIGINAL_HASH_MISMATCH");
  const preserved = JSON.parse((await versionContent(ctx.storage, version)).result) as {
    signature: { evaluatedAt: string };
  };
  const processed = processNfe(bytes, {
    source: artifact.source,
    evaluatedAt: preserved.signature.evaluatedAt,
  });
  return {
    processed,
    snapshot: JSON.stringify(compact(processed)),
    fingerprint: sha256(fiscalEvidenceIdentity(processed)),
  };
}
const sha256 = (identity: string) => createHash("sha256").update(identity).digest("hex");
const identity = { documentId: v.id("fiscalDocuments"), generation: v.number() };
export const rebuild = internalAction({
  args: { ...identity, originals: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = { documentId: args.documentId, generation: args.generation };
    const variants = new Map<string, Map<string, ProcessedNfe>>();
    // One stored version per original, to reread its bytes when interpretations differ.
    const sources = new Map<
      string,
      { version: Doc<"documentVersions">; artifact: Doc<"documentArtifacts"> | undefined }
    >();
    let count = 0,
      cursor: string | null = null;
    const add = (snapshot: string, fingerprint: string) => {
      const evidence = JSON.parse(snapshot) as ProcessedNfe;
      const id = evidence.metadata!.originalSha256;
      const group = variants.get(id) ?? new Map<string, ProcessedNfe>();
      if (!group.has(fingerprint)) count++;
      group.set(fingerprint, evidence);
      variants.set(id, group);
    };
    try {
      while (true) {
        const batch: {
          rows: Doc<"documentFiscalEvidence">[];
          verifyOriginals: boolean;
          versions: Doc<"documentVersions">[];
          artifacts: Doc<"documentArtifacts">[];
          cursor: string;
          done: boolean;
        } | null = await ctx.runQuery(internal.documentProjection.evidencePage, {
          ...target,
          paginationOpts: {
            cursor,
            numItems: Math.min(10, MAX_FISCAL_VERSIONS + 1 - count),
            maximumRowsRead: 10,
            maximumBytesRead: 1_500_000,
          },
        });
        if (!batch) return null;
        for (const row of batch.rows) {
          const version = batch.versions.find((v) => v._id === row.versionId);
          add(await evidenceSnapshot(ctx.storage, row, version), row.fingerprint);
          if (version && !sources.has(row.originalSha256))
            sources.set(row.originalSha256, {
              version,
              artifact: batch.artifacts.find((a) => a._id === version.artifactId),
            });
          if ((args.originals || batch.verifyOriginals) && count <= MAX_FISCAL_VERSIONS) {
            const current = await original(
              ctx,
              batch.artifacts.find((a) => a._id === version!.artifactId),
              version!,
            );
            add(current.snapshot, current.fingerprint);
          }
          if (count > MAX_FISCAL_VERSIONS) {
            await ctx.runMutation(internal.documentProjection.finish, {
              ...target,
              state: "limit-exceeded",
              situation: null,
            });
            return null;
          }
        }
        if (batch.done) break;
        cursor = batch.cursor;
      }
      // nfe-status/2 (#395): the interpretation of the current code, from the preserved bytes,
      // replaces a variant that an older schema catalog refused only at the XSD step. Compact
      // snapshots lack items and totals, so the full current interpretation does the comparison;
      // both rows stay in documentFiscalEvidence and in the version history.
      for (const [id, group] of variants) {
        const source = group.size > 1 ? sources.get(id) : undefined;
        if (!source) continue;
        const current = await original(ctx, source.artifact, source.version).catch(() => null);
        if (!current || !group.has(current.fingerprint)) continue;
        const others = [...group].map(([fingerprint, evidence]) => ({ fingerprint, evidence }));
        for (const fingerprint of replacedInterpretations(current.processed, others, sha256))
          group.delete(fingerprint);
      }
      // Full fingerprints retain disagreements in fields omitted from compact snapshots.
      const disagreements = [...variants]
        .filter(([, group]) => group.size > 1)
        .map(([id]) => `PROCESSING_DISAGREEMENT:${id}`);
      const situation = deriveFiscalSituation(
        [...variants.values()]
          .filter((group) => group.size === 1)
          .map((group) => group.values().next().value!),
      );
      situation.conflicts = [...new Set([...situation.conflicts, ...disagreements])].sort();
      if (situation.conflicts.length) situation.reportedStatus = "conflict";
      await ctx.runMutation(internal.documentProjection.finish, {
        ...target,
        state: "ready",
        situation,
      });
    } catch {
      await ctx.runMutation(internal.documentProjection.finish, {
        ...target,
        state: "unavailable",
        situation: null,
      });
    }
    return null;
  },
});
/** One bounded history page per job; upgrades never rewrite original processing output. */
export const backfill = internalAction({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = { documentId: args.documentId, generation: args.generation };
    try {
      const batch = await ctx.runQuery(internal.documentProjection.page, {
        ...target,
        paginationOpts: {
          cursor: args.cursor,
          numItems: 10,
          maximumRowsRead: 10,
          maximumBytesRead: 1_500_000,
        },
      });
      if (!batch) return null;
      for (const version of batch.versions) {
        const { fiscalEvidence } = await versionContent(ctx.storage, version);
        const evidence =
          fiscalEvidence && version.fiscalFingerprint
            ? { snapshot: fiscalEvidence, fingerprint: version.fiscalFingerprint }
            : await original(
                ctx,
                batch.artifacts.find((a) => a._id === version.artifactId),
                version,
              );
        await ctx.runMutation(internal.documentProjection.record, {
          versionId: version._id,
          snapshot: evidence.snapshot,
          fingerprint: evidence.fingerprint,
        });
      }
      if (batch.done) await ctx.runMutation(internal.documentProjection.backfilled, target);
      else
        await ctx.scheduler.runAfter(0, internal.documentProjectionWorker.backfill, {
          ...target,
          cursor: batch.cursor,
        });
    } catch {
      await ctx.runMutation(internal.documentProjection.finish, {
        ...target,
        state: "unavailable",
        situation: null,
      });
    }
    return null;
  },
});
