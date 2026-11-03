// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA
import { z } from "zod";

export const referenceDataset = z.enum(["municipalities", "ncm"]);
export const referenceVersion = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9._-]{1,100}$/);
export const referenceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const referenceManifest = z.strictObject({
  dataset: referenceDataset,
  version: referenceVersion,
  source: z.string().min(1).max(200),
  sourceUrl: z.url().refine((s) => s.startsWith("https://")),
  sourceVersion: z.string().min(1).max(200),
  retrievedAt: z.iso.datetime(),
  asOf: referenceDate,
  coverage: z.enum(["snapshot", "intervals"]),
  sourceSha256: hash,
  contentSha256: hash,
  count: z.number().int().min(1).max(30000),
  termsUrl: z.url().refine((s) => s.startsWith("https://")),
  redistribution: z.enum(["synthetic", "review-required", "permitted-with-attribution"]),
  terms: z.string().min(1).max(2000),
});
export const referenceEntry = z.strictObject({
  code: z.string().regex(/^\d{7,8}$/),
  description: z.string().trim().min(1).max(2000),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  validFrom: referenceDate.nullable(),
  validTo: referenceDate.nullable(),
});
export const referenceStatus = z.enum(["valid", "out_of_validity", "validity_unknown"]);
export const referenceItem = referenceEntry.extend({ status: referenceStatus });
export const referencePage = z.strictObject({
  manifest: referenceManifest,
  date: referenceDate,
  page: z.array(referenceItem),
  nextCursor: z.string().nullable(),
});
export const referenceLookup = z.strictObject({
  manifest: referenceManifest,
  date: referenceDate,
  status: z.enum(["valid", "out_of_validity", "validity_unknown", "not_found"]),
  entry: referenceEntry.nullable(),
});
export type ReferenceManifest = z.infer<typeof referenceManifest>;
export type ReferenceEntry = z.infer<typeof referenceEntry>;
export type ReferenceDataset = z.infer<typeof referenceDataset>;
export const referenceCursor = z.strictObject({
  version: referenceVersion,
  dataset: referenceDataset,
  date: referenceDate,
  q: z.string().max(100),
  after: z.string().max(2100),
});
export type ReferenceCursor = z.infer<typeof referenceCursor>;
export const municipalitySource = z.array(
  z.object({
    id: z.number().int(),
    nome: z.string(),
    microrregiao: z
      .object({ mesorregiao: z.object({ UF: z.object({ sigla: z.string() }) }) })
      .nullable(),
    "regiao-imediata": z.object({
      "regiao-intermediaria": z.object({ UF: z.object({ sigla: z.string() }) }),
    }),
  }),
);
export const ncmSource = z.object({
  Data_Ultima_Atualizacao_NCM: z.string(),
  Nomenclaturas: z.array(
    z.object({
      Codigo: z.string(),
      Descricao: z.string(),
      Data_Inicio: z.string(),
      Data_Fim: z.string(),
    }),
  ),
});

/** Unknown dates stay unknown. A snapshot only establishes presence on its reference date. */
export function referenceValidity(
  entry: ReferenceEntry,
  manifest: ReferenceManifest,
  date: string,
) {
  if ((entry.validFrom && date < entry.validFrom) || (entry.validTo && date > entry.validTo))
    return "out_of_validity" as const;
  if (manifest.coverage === "snapshot")
    return date === manifest.asOf ? ("valid" as const) : ("validity_unknown" as const);
  return entry.validFrom ? ("valid" as const) : ("validity_unknown" as const);
}
export function referenceSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
