"use node";
import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import { DANFE_GENERATOR_VERSION, renderDanfe } from "@freecorps/fiscal-nfe/danfe";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { DANFE_VERSION, MAX_DANFE_BYTES, danfeSources } from "./lib/danfeValues";
import { readOriginal } from "./lib/documentOriginalRead";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Renders the DANFE of `documentDanfe.resolveDanfe` from the preserved bytes, each one checked
 * against its SHA-256, and records it. The XML is read, never written. A refusal of the
 * generator (XML or evidence it does not accept) is recorded for the key: the caller's next
 * step reads it as `DANFE_UNAVAILABLE`, and a retry answers without rendering. Codes come back
 * as the return value, so they never depend on how a thrown error crosses `runAction`.
 */
export const render = internalAction({
  args: { sources: danfeSources },
  returns: v.union(v.null(), v.literal("ORIGINAL_UNAVAILABLE")),
  handler: async (ctx, { sources }) => {
    // The cache is keyed by the platform's copy; a package that disagrees must not render.
    // Fails loudly; the test pinning the copy (`platform/convex/danfe.test.ts`) catches it first.
    if ((DANFE_GENERATOR_VERSION as string) !== DANFE_VERSION)
      throw new Error("DANFE_VERSION_MISMATCH: lib/danfeValues.ts differs from the package");
    // A cold original (ADR 0010, decision 8) is checked by `readOriginal` and throws when its
    // object is missing or damaged; the request then answers 503 and never renders without it.
    const read = async (file: Infer<typeof danfeSources>["original"]) => {
      const bytes = await readOriginal(ctx.storage, file);
      return bytes && sha256(bytes) === file.sha256 ? bytes : null;
    };
    const xml = await read(sources.original);
    const events: Uint8Array[] = [];
    for (const event of sources.events) {
      const bytes = await read(event);
      if (!bytes) return "ORIGINAL_UNAVAILABLE" as const;
      events.push(bytes);
    }
    if (!xml) return "ORIGINAL_UNAVAILABLE" as const;
    let pdf: Uint8Array | null = null,
      refusal: string | null = null;
    try {
      pdf = await renderDanfe(
        xml,
        events.length ? { events, origin: sources.origin ?? undefined } : {},
      );
      if (pdf.byteLength > MAX_DANFE_BYTES) refusal = "DANFE_SIZE_LIMIT";
    } catch (error) {
      // By name, not `instanceof`: the subpath and the main entry may load separate copies.
      const code = (error as { code?: unknown }).code;
      if (!(error instanceof Error) || error.name !== "NfeError" || typeof code !== "string")
        throw error;
      refusal = code;
    }
    if (refusal !== null || !pdf) {
      console.warn(JSON.stringify({ type: "danfe.refused", code: refusal }));
      await ctx.runMutation(internal.documentDanfe.record, {
        sources,
        generatorVersion: DANFE_VERSION,
        result: { kind: "refused", code: (refusal ?? "DANFE_RENDER_FAILED").slice(0, 80) },
      });
      return null;
    }
    const storageId = await ctx.storage.store(
      new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
    );
    try {
      await ctx.runMutation(internal.documentDanfe.record, {
        sources,
        generatorVersion: DANFE_VERSION,
        result: { kind: "pdf", storageId, pdfSha256: sha256(pdf), size: pdf.byteLength },
      });
    } catch (error) {
      // Nothing holds the file when the record failed: never leave it orphaned.
      await ctx.storage.delete(storageId);
      throw error;
    }
    return null;
  },
});
