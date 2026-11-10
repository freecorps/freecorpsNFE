import { v, type Infer } from "convex/values";
export const textOrNull = v.union(v.string(), v.null());
const xmlEnvironment = v.union(v.literal("1"), v.literal("2"));
const party = v.object({
  kind: v.union(v.literal("CPF"), v.literal("CNPJ")),
  document: v.string(),
  name: textOrNull,
  stateRegistration: textOrNull,
});
const tax = v.object({
  path: v.string(),
  value: v.string(),
  representation: v.union(v.literal("decimal"), v.literal("code"), v.literal("text")),
  basis: v.literal("declared"),
});
const officialCode = v.object({ code: v.string(), label: textOrNull });
const purpose = v.object({
  code: textOrNull,
  label: textOrNull,
  creditNoteType: v.union(officialCode, v.null()),
  debitNoteType: v.union(officialCode, v.null()),
  inconsistencies: v.array(
    v.union(
      v.literal("B25.1-10"),
      v.literal("B25.1-20"),
      v.literal("B25.2-10"),
      v.literal("B25.2-20"),
    ),
  ),
});
/** NT 2026.006 `gPgto`, at most 99 per NF-e (PL_010g). */
const paymentLink = v.object({
  nPag: v.string(),
  idTransacao: v.string(),
  tpMeioPgto: v.string(),
  /** Derived from the IT DFe 2026.001 v1.01 table; null outside it. */
  tpMeioPgtoLabel: textOrNull,
  CNPJReceb: v.string(),
  CNPJBasePSP: v.string(),
});
const eventFields = {
  key: v.string(),
  author: party,
  type: v.string(),
  sequence: v.string(),
  occurredAt: v.string(),
  description: v.string(),
};
export const nfePayload = v.union(
  v.object({
    kind: v.literal("invoice"),
    key: v.string(),
    environment: xmlEnvironment,
    number: v.string(),
    series: v.string(),
    issuedAt: v.string(),
    operation: v.string(),
    purpose: v.union(purpose, v.null()),
    issuer: party,
    recipient: v.union(party, v.null()),
    total: v.string(),
    declaredTotals: v.object({ vNF: v.string(), vNFTot: textOrNull }),
    totals: v.array(tax),
    nt2026008: v.union(v.object({ vProdLiqTot: textOrNull }), v.null()),
    nt2026006: v.union(v.object({ gPgtoVinc: v.union(v.array(paymentLink), v.null()) }), v.null()),
    protocol: v.union(
      v.null(),
      v.object({
        key: v.string(),
        environment: xmlEnvironment,
        status: v.string(),
        number: textOrNull,
        receivedAt: textOrNull,
      }),
    ),
  }),
  v.object({
    kind: v.literal("summary"),
    key: v.string(),
    issuer: party,
    issuedAt: v.string(),
    total: v.string(),
    status: v.string(),
    protocolNumber: v.string(),
    receivedAt: v.string(),
  }),
  v.object({
    kind: v.literal("event-summary"),
    ...eventFields,
    protocolNumber: v.string(),
    registeredAt: v.string(),
  }),
  v.object({
    kind: v.literal("event"),
    ...eventFields,
    environment: xmlEnvironment,
    cancellation: v.union(v.null(), v.object({ protocolNumber: v.string(), reason: v.string() })),
    correction: v.union(v.null(), v.object({ text: v.string(), conditions: v.string() })),
    manifestation: v.union(v.null(), v.object({ reason: textOrNull })),
    receipt: v.union(
      v.null(),
      v.object({
        key: v.string(),
        environment: xmlEnvironment,
        type: v.string(),
        sequence: v.string(),
        status: v.string(),
        number: textOrNull,
        registeredAt: textOrNull,
      }),
    ),
  }),
);
export const nfsePayload = v.object({
  kind: v.literal("service-invoice"),
  key: v.string(),
  number: v.string(),
  municipality: v.string(),
  municipalRegistration: textOrNull,
  verificationCode: v.string(),
  issuedAt: v.string(),
  competence: v.string(),
  issuer: party,
  recipient: v.union(party, v.null()),
  total: v.string(),
  serviceCode: v.string(),
  description: v.string(),
  values: v.array(v.object({ name: v.string(), value: v.string() })),
});
export const documentPayload = v.union(nfePayload, nfsePayload);
export const documentModel = v.union(v.literal("55"), v.literal("nfse"));
export const nfeItem = v.object({
  item: v.string(),
  code: v.string(),
  description: v.string(),
  ncm: v.string(),
  cfop: v.string(),
  cest: textOrNull,
  purchaseOrder: textOrNull,
  purchaseOrderItem: textOrNull,
  unit: v.string(),
  quantity: v.string(),
  unitPrice: v.string(),
  total: v.string(),
  tributaryUnit: v.string(),
  tributaryQuantity: v.string(),
  tributaryUnitPrice: v.string(),
  nt2026008: v.union(
    v.object({ vUnComLiq: textOrNull, vProdLiq: textOrNull, vICMSPrevisto: textOrNull }),
    v.null(),
  ),
  taxes: v.array(tax),
});
export const fiscalStatus = v.union(
  v.literal("unknown"),
  v.literal("authorized"),
  v.literal("cancelled"),
  v.literal("denied"),
  v.literal("conflict"),
);
export const projectionState = v.union(
  v.literal("pending"),
  v.literal("ready"),
  v.literal("unavailable"),
  v.literal("limit-exceeded"),
);
export const fiscalView = v.object({
  reportedStatus: fiscalStatus,
  // Stored situations keep the rule that produced them; nfe-status/2 since #395.
  ruleVersion: v.union(v.literal("nfe-status/1"), v.literal("nfe-status/2")),
  basis: v.literal("preserved-claims"),
  assurance: v.literal("unverified-origin"),
  liveConsultation: v.literal(false),
  evidenceIds: v.array(v.string()),
  excluded: v.array(v.object({ id: v.string(), reason: v.string() })),
  conflicts: v.array(v.string()),
  key: textOrNull,
});
/** The first ID of a rehydrated resource (ADR 0009, §6); absent on one never archived. */
export const originalIdField = { originalId: v.optional(v.string()) };
export const documentSummary = v.object({
  id: v.string(),
  ...originalIdField,
  model: documentModel,
  key: v.string(),
  kind: v.string(),
  importedAt: v.number(),
  issuedAt: textOrNull,
  number: textOrNull,
  issuer: textOrNull,
  total: textOrNull,
  completeness: v.union(v.literal("full-xml"), v.literal("summary"), v.literal("event-only")),
  source: v.union(v.literal("imported-xml"), v.literal("distribution-xml")),
  fiscalStatus,
  projectionState,
  versionId: v.string(),
  resourceVersion: v.number(),
  processing: v.literal("complete"),
});
/**
 * The small card a version keeps in the database once its content moves to a blob (ADR 0010,
 * owner decision 2), for listing and deduplication: these fields exactly as `summary()` returns
 * them, which is what the writer (B4) stores. `number` may come from the access key rather than
 * `result`; `total` stays decimal text.
 */
export const documentCard = documentSummary
  .pick("kind", "issuedAt", "number", "issuer", "total", "source")
  // B5: an NF-e event with a cancellation and the SEFAZ reply, the ones the DANFE shows
  // (`documentDanfe.ts`), so the DANFE never needs the content of each event.
  .extend({ cancellation: v.optional(v.boolean()) });
/** Format label of the version's content blob (`lib/documentContent.ts`). */
export const DOCUMENT_CONTENT_FORMAT = "document-content/1";
/**
 * MIME of that blob in file storage. The storage sweep of `importUpload.ts` deletes one that no
 * version and no rehydration intent holds, once it is older than the upload window.
 */
export const DOCUMENT_CONTENT_MIME = "application/vnd.freecorps.document-content+gzip";
export const versionInfo = v.object({
  id: v.string(),
  ...originalIdField,
  operationId: v.string(),
  artifactId: v.string(),
  sha256: v.string(),
  source: v.union(v.literal("imported-xml"), v.literal("distribution-xml")),
  importedAt: v.number(),
  publishedAt: v.number(),
  parserVersion: v.string(),
  normalizerVersion: textOrNull,
  processorVersion: v.string(),
  schema: textOrNull,
  code: v.string(),
  kind: v.string(),
  itemCount: v.number(),
  originalAvailable: v.boolean(),
});
export const documentDetail = v.object({
  contractVersion: v.literal("documents/1"),
  model: documentModel,
  summary: documentSummary,
  payload: documentPayload,
  version: versionInfo,
  fiscalSituation: v.union(fiscalView, v.null()),
  previousFiscalSituation: v.union(fiscalView, v.null()),
});
export const filters = {
  status: v.optional(fiscalStatus),
  source: v.optional(v.union(v.literal("imported-xml"), v.literal("distribution-xml"))),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  key: v.optional(v.string()),
};

/** Console readers of version content (ADR 0010, B6): the answers of `documentContentNode`. */
export const itemsPage = v.object({
  page: v.array(nfeItem),
  versionId: v.string(),
  nextCursor: v.union(v.string(), v.null()),
});
export const versionsPage = v.object({
  page: v.array(v.object({ version: versionInfo, payload: documentPayload })),
  nextCursor: v.union(v.string(), v.null()),
});
export const importDetailResult = v.union(
  v.object({ versionId: v.id("documentVersions"), result: v.string() }),
  v.null(),
);
export const historyResult = v.array(
  v.object({
    id: v.id("documentVersions"),
    processorVersion: v.string(),
    completedAt: v.number(),
    code: v.string(),
    result: v.string(),
  }),
);

/**
 * #108: the `tpAmb` a version's stored `result` declares, from the note, its authorization
 * protocol, the event or its receipt: "1" when any of them says Produção, "2" when one says
 * homologação and none Produção, null without either (a summary, an NFS-e, an unreadable result).
 */
export function declaredTpAmb(result: string): "1" | "2" | null {
  let document: unknown;
  try {
    document = (JSON.parse(result) as { document?: unknown }).document;
  } catch {
    return null;
  }
  return declaredOf(document);
}

/**
 * The same answer from the bytes of a file the parser refused before a normalized document (an
 * NFC-e, an NF-e 3.10, an unsupported event, another encoding): every `tpAmb` element, read as
 * text, since the tag is ASCII in any encoding an NF-e uses. "1" wins, as above.
 */
export function scannedTpAmb(bytes: Uint8Array): "1" | "2" | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const found = new Set(
    Array.from(text.matchAll(/<(?:[\w.-]+:)?tpAmb\s*>\s*([12])\s*<\//g), (match) => match[1]),
  );
  return found.has("1") ? "1" : found.has("2") ? "2" : null;
}

/** The same answer read from a normalized document, before it is stored. */
export function declaredOf(document: unknown): "1" | "2" | null {
  const at = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const declared = [document, at(document, "protocol"), at(document, "receipt")].map((part) =>
    at(part, "environment"),
  );
  if (declared.includes("1")) return "1";
  return declared.includes("2") ? "2" : null;
}

/**
 * The XML original of a document (`documentArtifacts`), wherever it lives (ADR 0010, decision 8):
 * the raw bytes in Convex file storage (hot, `storageId`), or, once its note went cold, the gzip
 * of those bytes in the cold tier's bucket (`objectKey`). `sha256` and `size` always describe the
 * raw XML; `objectSha256` and `objectSize` describe the object, so the backup and the ADR 0009
 * package check the bucket without decompressing. The bytes are read by
 * `lib/documentOriginalRead.ts`; the validators stay here so that `lib/danfeValues.ts` describes
 * the DANFE sources without importing a module that reads the database.
 */
export const coldOriginalSource = v.object({
  objectKey: v.string(),
  objectSha256: v.string(),
  objectSize: v.number(),
  sha256: v.string(),
  size: v.number(),
});
export const originalSource = v.union(
  v.object({ storageId: v.id("_storage"), sha256: v.string(), size: v.number() }),
  coldOriginalSource,
);
export type OriginalSource = Infer<typeof originalSource>;
export type ColdOriginalSource = Infer<typeof coldOriginalSource>;
