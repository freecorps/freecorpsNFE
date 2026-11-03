import { canonicalEntries, sha256 } from "../../lib/reference-dataset";
import type {
  ReferenceDataset,
  ReferenceEntry,
  ReferenceManifest,
} from "../../packages/contracts/src/references";

/** Synthetic-only rows: no official payload or implied legal classification. */
export async function referenceCorpus(dataset: ReferenceDataset = "ncm", version = "synthetic-v1") {
  const entries: ReferenceEntry[] = Array.from({ length: 25 }, (_, i) => ({
    code: String((dataset === "ncm" ? 99000000 : 9900000) + i),
    description: `Árvore de teste ${String(i).padStart(2, "0")}`,
    state: dataset === "ncm" ? null : "SP",
    validFrom: "2025-01-01",
    validTo: i === 0 ? "2025-12-31" : null,
  }));
  const hash = await sha256(canonicalEntries(entries));
  const manifest: ReferenceManifest = {
    dataset,
    version,
    source: "Corpus sintético Freecorps",
    sourceUrl: "https://example.invalid/references",
    sourceVersion: version,
    retrievedAt: "2026-09-22T00:00:00Z",
    asOf: "2026-09-22",
    coverage: "intervals",
    sourceSha256: hash,
    contentSha256: hash,
    count: entries.length,
    termsUrl: "https://example.invalid/synthetic-terms",
    redistribution: "synthetic",
    terms:
      "Dados inventados para testes, sem correspondência fiscal. Reprodução permitida para os testes do projeto.",
  };
  return { manifest, entries };
}
