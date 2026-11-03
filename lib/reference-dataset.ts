import {
  referenceEntry,
  referenceManifest,
  type ReferenceEntry,
  type ReferenceManifest,
} from "../packages/contracts/src/references";

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Stable field order is part of the import contract, independent of source JSON formatting. */
export function canonicalEntries(rows: ReferenceEntry[]) {
  return JSON.stringify(
    rows.map((r) => ({
      code: r.code,
      description: r.description,
      state: r.state,
      validFrom: r.validFrom,
      validTo: r.validTo,
    })),
  );
}
export function validateEntries(manifest: ReferenceManifest, input: unknown): ReferenceEntry[] {
  const rows = referenceEntry.array().max(30000).parse(input);
  if (rows.length !== manifest.count) throw new Error("REFERENCE_COUNT_MISMATCH");
  let previous = "";
  for (const row of rows) {
    if (
      row.code <= previous ||
      row.code.length !== (manifest.dataset === "ncm" ? 8 : 7) ||
      (row.validFrom && row.validTo && row.validTo < row.validFrom) ||
      (manifest.coverage === "intervals" && !row.validFrom) ||
      (manifest.dataset === "municipalities" && !row.state) ||
      (manifest.dataset === "ncm" && row.state !== null)
    )
      throw new Error("INVALID_REFERENCE_ENTRY");
    previous = row.code;
  }
  return rows;
}
export async function parseReferencePayload(payload: string) {
  if (new TextEncoder().encode(payload).byteLength > 8_000_000)
    throw new Error("REFERENCE_TOO_LARGE");
  const raw: unknown = JSON.parse(payload);
  if (!raw || typeof raw !== "object" || !("manifest" in raw) || !("entries" in raw))
    throw new Error("INVALID_REFERENCE_PAYLOAD");
  const manifest = referenceManifest.parse(raw.manifest);
  const entries = validateEntries(manifest, raw.entries);
  if ((await sha256(canonicalEntries(entries))) !== manifest.contentSha256)
    throw new Error("REFERENCE_HASH_MISMATCH");
  return { manifest, entries };
}
