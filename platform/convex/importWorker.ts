"use node";
import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import {
  processNfe,
  deriveFiscalSituation,
  fiscalEvidenceIdentity,
  PARSER_VERSION,
  RULE_VERSION,
} from "@freecorps/fiscal-nfe";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { claimFields, outcome } from "./lib/operationValues";
import { originalSourceOf, readOriginal } from "./lib/documentOriginalRead";
import { declaredOf, scannedTpAmb } from "./lib/documentValues";

export const execute = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: async (ctx, args): Promise<Infer<typeof outcome>> => {
    const claim = { operationId: args.operationId, generation: args.generation, fence: args.fence };
    const input = await ctx.runMutation(internal.importProcessing.load, claim);
    if (!input) return { kind: "definitive" as const, code: "ACCESS_REVOKED" };
    // The original of a cold note (ADR 0010, decision 8) is read from the bucket; a missing or
    // damaged object is `UNAVAILABLE`, retried as transient and never ended as a lost original.
    const source = originalSourceOf(input.artifact);
    let bytes: Uint8Array | null;
    try {
      bytes = source ? await readOriginal(ctx.storage, source) : null;
    } catch {
      return { kind: "transient" as const, code: "UNAVAILABLE" };
    }
    if (!bytes) return { kind: "definitive" as const, code: "ORIGINAL_UNAVAILABLE" };
    if (createHash("sha256").update(bytes).digest("hex") !== input.artifact.sha256)
      return { kind: "definitive" as const, code: "ORIGINAL_HASH_MISMATCH" };
    if (!["xml-import/1", "xml-import/2", "xml-import/3"].includes(input.processorVersion))
      return { kind: "definitive" as const, code: "PROCESSOR_UNSUPPORTED" };
    const processed = processNfe(bytes, {
      source: input.artifact.source,
      evaluatedAt: input.evaluatedAt,
    });
    // ABRASF NFS-e batches left the import on 2026-11-02: one now ends like any other unknown
    // namespace (`XML_NAMESPACE_UNSUPPORTED`). The NFS-e imported before stay read-only.
    const doc = processed.normalized?.document;
    const parties = !doc
      ? []
      : doc.kind === "invoice"
        ? [doc.issuer.document, doc.recipient?.document]
        : doc.kind === "summary"
          ? [doc.issuer.document]
          : [doc.author.document, doc.key.slice(6, 20)];
    // A distribution envelope was obtained through the authenticated actor's stream.
    // Summaries omit the recipient; carrier/autXML may also be absent from the public projection.
    const matches =
      input.artifact.source === "distribution-xml" || parties.includes(input.company.cnpj);
    let code = !doc
      ? processed.checks.parsing.code
      : !matches
        ? "COMPANY_MISMATCH"
        : processed.checks.identity.status !== "passed"
          ? "IDENTITY_INVALID"
          : "IMPORTED";
    const accepted = code === "IMPORTED";
    const products = accepted && doc?.kind === "invoice" ? doc.products : [];
    const itemData = products.map((product) => JSON.stringify(product));
    const headerDoc =
      !accepted || !doc ? null : doc.kind === "invoice" ? { ...doc, products: undefined } : doc;
    const result = JSON.stringify({
      metadata: processed.metadata,
      document: headerDoc,
      checks: processed.checks,
      signature: processed.signature,
      ...(input.processorVersion !== "xml-import/1"
        ? { fiscalSituation: accepted ? deriveFiscalSituation([processed], RULE_VERSION) : null }
        : {}),
    });
    if (
      Buffer.byteLength(result) > 128_000 ||
      itemData.some((item) => Buffer.byteLength(item) > 200_000)
    ) {
      code = "RESULT_TOO_LARGE";
      return { kind: "definitive" as const, code };
    }
    const staged = await ctx.runMutation(internal.importProcessing.stage, {
      ...claim,
      artifactId: input.artifact._id,
      fiscalKey: accepted ? doc!.key : null,
      // A refused file has no document to carry its mark: the original keeps it (#108).
      ...(!accepted ? { tpAmb: (doc ? declaredOf(doc) : scannedTpAmb(bytes)) ?? undefined } : {}),
      code,
      kind: doc?.kind ?? "unknown",
      completeness: !accepted ? -1 : doc?.kind === "invoice" ? 2 : doc?.kind === "summary" ? 1 : 0,
      schema: processed.metadata?.versions.schema
        ? JSON.stringify(processed.metadata.versions.schema)
        : null,
      parserVersion: processed.metadata?.versions.parser ?? PARSER_VERSION,
      normalizerVersion: processed.metadata?.versions.normalizer ?? null,
      processorVersion: input.processorVersion,
      result,
      ...(accepted
        ? {
            fiscalFingerprint: createHash("sha256")
              .update(fiscalEvidenceIdentity(processed))
              .digest("hex"),
            fiscalEvidence: JSON.stringify({
              ...processed,
              normalized: null,
              parsing: processed.parsing
                ? {
                    ...processed.parsing,
                    document:
                      processed.parsing.document.kind === "invoice"
                        ? { ...processed.parsing.document, products: [], totals: [] }
                        : processed.parsing.document,
                  }
                : null,
            }),
          }
        : {}),
      outputHash: createHash("sha256")
        .update(JSON.stringify({ result, items: itemData }))
        .digest("hex"),
      itemCount: itemData.length,
    });
    if (!staged) return { kind: "definitive" as const, code: "ACCESS_REVOKED" };
    if ("code" in staged && staged.code) return { kind: "definitive" as const, code: staged.code };
    let offset = staged.writtenItems;
    while (offset < itemData.length) {
      const batch: string[] = [];
      let size = 0;
      while (offset + batch.length < itemData.length && batch.length < 25) {
        const next = itemData[offset + batch.length]!;
        if (batch.length && size + Buffer.byteLength(next) > 250_000) break;
        batch.push(next);
        size += Buffer.byteLength(next);
      }
      if (
        !(await ctx.runMutation(internal.importProcessing.items, {
          ...claim,
          versionId: staged.versionId,
          offset,
          items: batch,
        }))
      )
        return { kind: "definitive" as const, code: "ACCESS_REVOKED" };
      offset += batch.length;
    }
    return {
      kind: "success" as const,
      response: JSON.stringify({ versionId: staged.versionId, code, itemCount: itemData.length }),
    };
  },
});
