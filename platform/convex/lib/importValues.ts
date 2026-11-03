import { v } from "convex/values";
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_FILES = 20;
export const UPLOAD_TTL = 15 * 60_000;
export const RESERVATION_TTL = 24 * 3600_000;
export const IMPORT_MIME = "application/vnd.freecorps.import+xml";
export const PROCESSOR_VERSION = "xml-import/3";
/**
 * `PARSER_VERSION` of `@freecorps/fiscal-nfe`, which only Node actions load. The mutations that
 * pick technical refusals of an older parser (`refusalReprocess.ts`, #499) read this copy; a test
 * pins it to the package, so a parser change fails until it is updated here. The catalog is not
 * copied: a refusal records the parser, never the catalog (`schema: null`).
 */
export const NFE_PARSER_VERSION = "nfe-parser/8";
export function storageHash(value: string) {
  return /^[a-f0-9]{64}$/.test(value)
    ? value
    : Array.from(atob(value), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
export const fileSpec = v.object({ name: v.string(), size: v.number(), sha256: v.string() });
export const importTask = {
  name: "documents.import",
  workload: "import",
  scope: "documents:import",
  executor: "importWorker:execute",
  reconciler: "importWorker:execute",
  checkpoint: "importProcessing:checkpoint",
  onSucceeded: "importProcessing:published",
} as const;
/**
 * Reprocessing of the technical refusals of a company and environment (#499), asked in the
 * console. Its environment purpose is `capture-processing` (`environmentPurpose`): it only reads
 * stored originals and turns what was already received into documents, which a withdrawn capture
 * release still serves (#420). Imports never run in production on the site, so the originals it
 * finds there are captured ones; the child of an imported original keeps `documents:import`.
 */
export const refusalTask = {
  name: "documents.reprocess_refusals",
  workload: "import",
  scope: "documents:import",
  executor: "refusalReprocess:execute",
  reconciler: "refusalReprocess:execute",
} as const;
/** Whether `task` is exactly `refusalTask`, every field. */
export function isRefusalReprocess(task: Partial<Record<keyof typeof refusalTask, unknown>>) {
  return (Object.keys(refusalTask) as (keyof typeof refusalTask)[]).every(
    (field) => task[field] === refusalTask[field],
  );
}
export const reservedImport = v.object({
  importId: v.id("imports"),
  fileIds: v.array(v.id("importFiles")),
  reused: v.boolean(),
});
/** The first ID of a rehydrated batch or file (ADR 0009, §6); absent otherwise. */
const originalIdField = { originalId: v.optional(v.string()) };
export const fileResult = v.object({
  id: v.id("importFiles"),
  ...originalIdField,
  name: v.string(),
  size: v.number(),
  sha256: v.string(),
  state: v.string(),
  operationId: v.union(v.id("operations"), v.null()),
  generation: v.number(),
  code: v.union(v.string(), v.null()),
  documentId: v.union(v.id("fiscalDocuments"), v.null()),
  versionId: v.union(v.id("documentVersions"), v.null()),
  result: v.union(v.string(), v.null()),
  documents: v.optional(
    v.array(
      v.object({
        documentId: v.string(),
        versionId: v.string(),
        number: v.string(),
        code: v.string(),
      }),
    ),
  ),
});
export const importResult = v.object({
  id: v.id("imports"),
  ...originalIdField,
  createdAt: v.number(),
  files: v.array(fileResult),
});
