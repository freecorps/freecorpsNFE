import { v } from "convex/values";
import { environment } from "./projectValues";
import { originalSource } from "./documentOriginalRead";

/**
 * `DANFE_GENERATOR_VERSION` of `@freecorps/fiscal-nfe/danfe`, which only the Node worker loads
 * (it brings `pdf-lib` and the XML verifier). The mutations that decide on the cache read this
 * copy; a test pins it to the package, so a generator change fails until it is updated here.
 */
export const DANFE_VERSION = "4";
/** Printed with the cancellation mark: the platform kept the event, it did not ask the SEFAZ. */
export const DANFE_ORIGIN =
  "evento de cancelamento preservado na plataforma, sem consulta ao fisco";
/** `MAX_EVENTS` of the generator: cancellation events passed in one rendering. */
export const MAX_DANFE_EVENTS = 20;
/** Event versions of one document read to find its cancellations. */
export const MAX_DANFE_EVENT_VERSIONS = 100;
/** The generator's largest synthetic case (90 items, 7 pages) is far below this. */
export const MAX_DANFE_BYTES = 8 * 1024 * 1024;
/** One organization renders at most this many DANFEs per minute; a cached one is not counted. */
export const DANFE_RENDERS_PER_MINUTE = 20;

/**
 * What one rendering reads, and the cache key it is recorded under. Each XML is hot or, for a cold
 * note (ADR 0010, decision 8), an object of the bucket (`lib/documentOriginalRead.ts`).
 */
const file = originalSource;
export const danfeSources = v.object({
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  environment,
  documentId: v.id("fiscalDocuments"),
  original: file,
  events: v.array(file),
  origin: v.union(v.string(), v.null()),
  evidenceSha256: v.string(),
});
/** What the worker hands to `documentDanfe.record`: the PDF, or the generator's refusal code. */
export const danfeRendering = v.union(
  v.object({
    kind: v.literal("pdf"),
    storageId: v.id("_storage"),
    pdfSha256: v.string(),
    size: v.number(),
  }),
  v.object({ kind: v.literal("refused"), code: v.string() }),
);
const name = v.string();
export const danfeResolution = v.union(
  v.object({ state: v.literal("ready"), storageId: v.id("_storage"), name }),
  v.object({ state: v.literal("render"), sources: danfeSources, name }),
);
