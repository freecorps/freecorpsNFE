/**
 * What happened to the document of each imported file, without database access, shared by the
 * Início (`consoleHome.summary`) and the console's import screen (#507). The input is the current
 * state and result code of the file (`importStates`): the state of the file's current operation
 * and, once it succeeded, the code of the version it published. A processing that finished is
 * not a document imported: `succeeded` with `XML_SCHEMA_UNSUPPORTED` is a refused XML.
 */
export type ImportFileOutcome =
  /** `IMPORTED`, `NFSE_BATCH_IMPORTED`: the document (or every NFS-e of the batch) is registered. */
  | "imported"
  /** `DUPLICATE`: the same note was imported before; nothing was duplicated. */
  | "duplicate"
  /** `ARTIFACT_CONFLICT`: preserved for review, the published version did not change. */
  | "caveat"
  /** Processing finished without a document: any other code, or none. */
  | "refused"
  /** The operation failed. */
  | "failed"
  /** The operation was paused and waits for an administrator. */
  | "paused"
  /** The reservation expired or was cancelled before the upload (`expired`). */
  | "not-sent"
  /** Still waiting for the upload or being processed. */
  | "running";

const importedCodes = new Set(["IMPORTED", "NFSE_BATCH_IMPORTED"]);

export function importFileOutcome(file: { state: string; code: string | null }): ImportFileOutcome {
  if (file.state === "expired") return "not-sent";
  if (file.state === "paused") return "paused";
  if (file.state === "failed") return "failed";
  if (file.state !== "succeeded") return "running";
  if (file.code && importedCodes.has(file.code)) return "imported";
  if (file.code === "DUPLICATE") return "duplicate";
  if (file.code === "ARTIFACT_CONFLICT") return "caveat";
  return "refused";
}

/**
 * The file needs a person: its document was not imported and nothing will do it alone. A file not
 * sent was cancelled or abandoned by whoever imported it, so it is not a pending item.
 */
export const needsAttention = (outcome: ImportFileOutcome) =>
  outcome === "refused" || outcome === "failed" || outcome === "paused";

/**
 * Outcomes of a batch, one per file: a batch with several refused files is still one batch.
 * `attention` wins over files still running: a refused XML needs a person now, whatever the
 * others end with, so the Início lists the batch and the screen says so (#507). An NFS-e ABRASF
 * file is one outcome: its notes' `DUPLICATE` or `ARTIFACT_CONFLICT` (in `documents[]`) do not
 * change the file's `NFSE_BATCH_IMPORTED`, so such a batch reads as imported.
 */
export function importBatchOutcome(files: Array<{ state: string; code: string | null }>) {
  const counts: Record<ImportFileOutcome, number> = {
    imported: 0,
    duplicate: 0,
    caveat: 0,
    refused: 0,
    failed: 0,
    paused: 0,
    "not-sent": 0,
    running: 0,
  };
  for (const file of files) counts[importFileOutcome(file)]++;
  const attention = counts.refused + counts.failed + counts.paused > 0;
  return {
    counts,
    attention,
    /** What the batch asks of the person: act now, wait, or nothing more to happen. */
    state: attention ? "attention" : counts.running ? "running" : "settled",
  } as const;
}
