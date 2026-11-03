const MiB = 1024 * 1024;
/** Cap of `lib/documentContent.ts`; the proof passes when the Node reader holds 3× it. */
export const CAP = 8 * MiB;
export const REQUIRED_FACTOR = 3;
export const SIZES = [8, 16, 24, 32, 48, 64].map((size) => size * MiB);
export const CONCURRENT = 4;
const RUNTIMES = {
  node: "testing/documentHeadroomNode:read",
  v8: "testing/documentHeadroomProof:read",
};

/**
 * Raises the content size, per shape, until each runtime's reader fails (or 64 MiB passes),
 * then reads the cap `CONCURRENT` times at once. Every blob is removed after its size. Records
 * only sizes, counts, durations and controlled codes. `call(kind, path, args)` throws
 * `Error(code)`.
 */
export async function headroomProof({ call, report }) {
  report.cap = CAP;
  report.requiredFactor = REQUIRED_FACTOR;
  report.headroom = [];
  for (const shape of ["wide", "many"]) {
    const failed = new Set();
    for (const size of SIZES) {
      if (failed.size === Object.keys(RUNTIMES).length) break;
      let ref;
      try {
        ref = await call("action", "testing/documentHeadroomNode:store", { size, shape });
      } catch (error) {
        report.headroom.push({ shape, size, store: "failed", code: error.message });
        break;
      }
      try {
        for (const [runtime, path] of Object.entries(RUNTIMES)) {
          if (failed.has(runtime)) continue;
          const row = { shape, size, runtime, contentSize: ref.contentSize, items: ref.items };
          row.storedSize = ref.storedSize;
          try {
            const value = JSON.parse(await call("action", path, { ref }));
            Object.assign(row, { outcome: "passed", ms: value.ms, runtime: runtime });
            if (value.runtime?.node) row.node = value.runtime.node;
            if (value.runtime?.heapLimit) row.heapLimit = value.runtime.heapLimit;
          } catch (error) {
            Object.assign(row, { outcome: "failed", code: error.message });
            failed.add(runtime);
          }
          report.headroom.push(row);
        }
        if (size === CAP)
          for (const [runtime, path] of Object.entries(RUNTIMES)) {
            const outcomes = await Promise.allSettled(
              Array.from({ length: CONCURRENT }, () => call("action", path, { ref })),
            );
            report.headroom.push({
              shape,
              size,
              runtime,
              concurrent: CONCURRENT,
              passed: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
              codes: outcomes.flatMap((outcome) =>
                outcome.status === "rejected" ? [outcome.reason.message] : [],
              ),
            });
          }
      } finally {
        await call("mutation", "testing/documentHeadroomProof:remove", {
          storageId: ref.storageId,
        });
      }
    }
  }
  report.verdict = headroomVerdict(report.headroom);
  return report.verdict;
}

/** Largest size each runtime read, per shape, and whether Node holds `REQUIRED_FACTOR` × cap. */
export function headroomVerdict(rows) {
  const largest = {};
  for (const row of rows)
    if (row.outcome === "passed") {
      const key = `${row.runtime}/${row.shape}`;
      largest[key] = Math.max(largest[key] ?? 0, row.size);
    }
  const concurrentAtCap = rows
    .filter((row) => row.concurrent)
    .every((row) => row.runtime !== "node" || row.passed === row.concurrent);
  const nodeFactor = Math.min(largest["node/wide"] ?? 0, largest["node/many"] ?? 0) / CAP;
  return {
    largest,
    nodeFactor,
    concurrentAtCap,
    passed: nodeFactor >= REQUIRED_FACTOR && concurrentAtCap,
  };
}

/** Controlled codes from a Convex error message; nothing else from the message is kept. */
export function headroomCode(message) {
  const text = String(message);
  if (/out of memory|memory limit|heap/i.test(text)) return "OUT_OF_MEMORY";
  if (/timed? ?out|timeout/i.test(text)) return "TIMEOUT";
  for (const code of ["BLOB_MISSING", "DOCUMENT_CONTENT_CORRUPT", "DOCUMENT_CONTENT_TOO_LARGE"])
    if (text.includes(code)) return code;
  return "PROOF_CALL_FAILED";
}
