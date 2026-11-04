// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FREECORPS TECNOLOGIA DA INFORMACAO LTDA
/** Canonical public REST contract. No Convex validators or stored documents belong here. */
import { z } from "zod";
import { webhookEvents } from "./webhooks.js";
import { referenceDate, referencePage, referenceLookup, referenceVersion } from "./references.js";
import { registryLookup } from "./registry.js";

export const apiVersion = "8.0.0";
export const toJsonSchema = z.toJSONSchema;
export const id = z.string().min(1).max(128);
const text = z.string();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const nullableText = text.nullable();
const object = z.strictObject;
const environment = z.enum(["sandbox", "production"]);
export const exactDecimal = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .describe("Decimal exato, preservado como string; nunca converter para ponto flutuante.");
export const fiscalStatus = z.enum(["unknown", "authorized", "cancelled", "denied", "conflict"]);
const party = object({
  kind: z.enum(["CPF", "CNPJ"]),
  document: text,
  name: nullableText,
  stateRegistration: nullableText,
});
const tax = z.discriminatedUnion("representation", [
  object({
    path: text,
    representation: z.literal("decimal"),
    value: exactDecimal,
    basis: z.literal("declared"),
  }),
  object({
    path: text,
    representation: z.literal("code"),
    value: text,
    basis: z.literal("declared"),
  }),
  object({
    path: text,
    representation: z.literal("text"),
    value: text,
    basis: z.literal("declared"),
  }),
]);
// Letters belong only to the first twelve CNPJ positions; preserve the alphanumeric corpus.
const key = z.string().regex(/^[0-9]{6}[A-Z0-9]{12}[0-9]{2}55[0-9]{22}$/);
const fiscalEnvironment = z.enum(["1", "2"]);
const protocol = object({
  key,
  environment: fiscalEnvironment,
  status: text,
  number: nullableText,
  receivedAt: nullableText,
});
const eventFields = {
  key,
  author: party,
  type: text,
  sequence: text,
  occurredAt: text,
  description: text,
};
const officialCode = object({
  code: text.describe("Código oficial como declarado no XML."),
  label: nullableText.describe(
    "Descrição em português do código no schema fixado; null para código que ele não admite.",
  ),
});
export const nfePurposeInconsistency = z.enum(["B25.1-10", "B25.1-20", "B25.2-10", "B25.2-20"]);
const nfePurpose = object({
  code: nullableText.describe("finNFe como declarado; null quando o XML não o informa."),
  label: nullableText.describe(
    "Descrição da finalidade; null sem código ou com código não admitido.",
  ),
  creditNoteType: officialCode.nullable().describe("tpNFCredito; null quando o XML não o informa."),
  debitNoteType: officialCode.nullable().describe("tpNFDebito; null quando o XML não o informa."),
  inconsistencies: z
    .array(nfePurposeInconsistency)
    .describe(
      "Regras B25.1-10, B25.1-20, B25.2-10 e B25.2-20 da NT 2025.002 v1.52 que o XML declarado descumpre. Só informa; não altera a situação fiscal.",
    ),
});
export const nfePayload = z.discriminatedUnion("kind", [
  object({
    kind: z.literal("invoice"),
    key,
    environment: fiscalEnvironment,
    number: text,
    series: text,
    issuedAt: text,
    operation: text.describe("Natureza da operação (natOp), como declarada."),
    purpose: nfePurpose
      .nullable()
      .describe(
        "Finalidade da NF-e. null: versão processada antes do parser nfe-parser/3; reprocessar o documento a extrai do XML original.",
      ),
    issuer: party,
    recipient: party.nullable(),
    total: exactDecimal.describe("Valor total da NF-e em ICMSTot/vNF, como declarado."),
    declaredTotals: object({
      vNF: exactDecimal.describe('ICMSTot/vNF, "Valor Total da NF-e" no PL_010g; igual a total.'),
      vNFTot: exactDecimal
        .nullable()
        .describe(
          'total/vNFTot, "Valor total da NF-e com IBS / CBS / IS" (NT 2025.002 v1.52, campo W60); null quando o XML não o informa. Nunca é calculado.',
        ),
    }),
    totals: z.array(tax),
    nt2026008: object({
      vProdLiqTot: exactDecimal
        .nullable()
        .describe(
          'total/vProdLiqTot, "Valor Total Líquido dos Produtos ou Serviços (sem tributos)" (NT 2026.008 v1.00, campo W01a); null quando o XML não o informa.',
        ),
    })
      .nullable()
      .describe(
        "Campos da NT 2026.008, validados pelo PL_010g. null: versão processada antes do parser nfe-parser/4; reprocessar o documento os extrai do XML original.",
      ),
    nt2026006: object({
      gPgtoVinc: z
        .array(
          object({
            nPag: text
              .regex(/^(?:[1-9]\d?|[1-8]\d{2}|9[0-8]\d|990)$/)
              .describe('gPgto/@nPag, "Número sequencial do pagamento", como declarado.'),
            idTransacao: text
              .regex(/^[\u0021-\u00FF][\u0020-\u00FF]{0,33}[\u0021-\u00FF]$/)
              .describe(
                'gPgto/@idTransacao, "Identificador da transação financeira, de acordo com a transação de pagamento", como declarado.',
              ),
            tpMeioPgto: text
              .regex(/^\d{2}$/)
              .describe(
                'gPgto/tpMeioPgto, "Código do meio de pagamento (ver IT DFe 2026.001)", com os dois dígitos declarados. O XSD só confere o formato; um código fora da tabela do IT DFe 2026.001 v1.01 continua aqui como declarado.',
              ),
            tpMeioPgtoLabel: nullableText.describe(
              "Descrição de tpMeioPgto na tabela do IT DFe 2026.001 v1.01 (15 Boleto, 17 Pix QRCode, 18 TED, 20 PIX chave ou QRCode estático, 23 Pix automático, 24 TEF / booktransfer); null para código fora dela, cuja rejeição na autorização o IT prevê; a plataforma não avalia essa regra. Derivada do código, não declarada no XML.",
            ),
            CNPJReceb: text
              .regex(/^[A-Z0-9]{12}\d{2}$/)
              .describe('gPgto/CNPJReceb, "CNPJ do recebedor do pagamento", como declarado.'),
            CNPJBasePSP: text
              .regex(/^[A-Z0-9]{8}$/)
              .describe(
                'gPgto/CNPJBasePSP, "CNPJ base da instituição financeira ou de pagamento", como declarado.',
              ),
          }),
        )
        .max(99)
        .nullable()
        .describe(
          'infNFe/gPgtoVinc, "Informações da Vinculação com a Transação de Pagamento" (NT 2026.006 v1.00), um item por gPgto, na ordem do XML; null quando o XML não informa o grupo.',
        ),
    })
      .nullable()
      .describe(
        "Campos da NT 2026.006, validados pelo PL_010g. null: versão processada antes do parser nfe-parser/6; reprocessar o documento os extrai do XML original.",
      ),
    protocol: protocol.nullable(),
  }),
  object({
    kind: z.literal("summary"),
    key,
    issuer: party,
    issuedAt: text,
    total: exactDecimal.describe("vNF do resumo (resNFe), como declarado."),
    status: text,
    protocolNumber: text,
    receivedAt: text,
  }),
  object({
    kind: z.literal("event-summary"),
    ...eventFields,
    protocolNumber: text,
    registeredAt: text,
  }),
  object({
    kind: z.literal("event"),
    ...eventFields,
    environment: fiscalEnvironment,
    cancellation: object({ protocolNumber: text, reason: text }).nullable(),
    correction: object({ text, conditions: text }).nullable(),
    manifestation: object({ reason: nullableText }).nullable(),
    receipt: object({
      key,
      environment: fiscalEnvironment,
      type: text,
      sequence: text,
      status: text,
      number: nullableText,
      registeredAt: nullableText,
    }).nullable(),
  }),
]);
export const nfeItem = object({
  item: text,
  code: text,
  description: text,
  ncm: text,
  cfop: text,
  cest: nullableText,
  purchaseOrder: nullableText,
  purchaseOrderItem: nullableText,
  unit: text,
  quantity: exactDecimal,
  unitPrice: exactDecimal,
  total: exactDecimal,
  tributaryUnit: text,
  tributaryQuantity: exactDecimal,
  tributaryUnitPrice: exactDecimal,
  nt2026008: object({
    vUnComLiq: exactDecimal
      .nullable()
      .describe(
        'prod/vUnComLiq, "Valor Líquido Unitário do Produto ou Serviço (sem tributos)" (NT 2026.008, I11b).',
      ),
    vProdLiq: exactDecimal
      .nullable()
      .describe(
        'prod/vProdLiq, "Valor Líquido do Produto ou Serviço (sem tributos)" (NT 2026.008, I11c).',
      ),
    vICMSPrevisto: exactDecimal
      .nullable()
      .describe(
        'ICMS/ICMSPrevistoPagtoAntecip/vICMSPrevisto, "Valor do ICMS Previsto" no grupo do ICMS previsto no pagamento antecipado (NT 2026.008, NB02).',
      ),
  })
    .nullable()
    .describe(
      "Campos da NT 2026.008, null em cada um quando o XML não o informa. null no objeto: versão anterior ao parser nfe-parser/4.",
    ),
  taxes: z.array(tax),
});
export const nfseKey = z
  .string()
  .regex(/^nfse:[0-9]{7}:[0-9]{14}:[A-Za-z0-9.%_-]*:[0-9]{1,15}$/)
  .max(128);
export const nfsePayload = object({
  kind: z.literal("service-invoice"),
  key: nfseKey,
  number: text,
  municipality: text,
  municipalRegistration: nullableText,
  verificationCode: text,
  issuedAt: text,
  competence: text,
  issuer: party,
  recipient: party.nullable(),
  total: exactDecimal,
  serviceCode: text,
  description: text,
  values: z.array(object({ name: text, value: exactDecimal })),
});
export const documentPayload = z.union([nfePayload, nfsePayload]);
export const documentKey = z.union([key, nfseKey]);
export const documentModel = z.enum(["55", "nfse"]);
/**
 * The first ID of a resource that came back from the cold archive under a new ID (ADR 0009, §6).
 * Absent on a resource never archived. Every route that takes an ID also accepts it, or any ID of
 * a later cycle, and answers the current resource under its new `id`.
 */
const originalId = id
  .optional()
  .describe(
    "Primeiro ID do recurso, presente só depois de ele voltar do arquivo frio com ID novo; ausente num recurso nunca arquivado. As rotas aceitam esse ID e respondem o recurso atual, com o id novo.",
  );
export const documentSummary = object({
  id,
  originalId,
  model: documentModel,
  key: documentKey,
  kind: text,
  importedAt: integer,
  issuedAt: nullableText,
  number: nullableText,
  issuer: nullableText,
  total: exactDecimal
    .nullable()
    .describe("O mesmo total do payload; na NF-e 55 é vNF, nunca vNFTot. null em eventos."),
  completeness: z.enum(["full-xml", "summary", "event-only"]),
  source: z.enum(["imported-xml", "distribution-xml"]),
  fiscalStatus,
  projectionState: z.enum(["pending", "ready", "unavailable", "limit-exceeded"]),
  versionId: id,
  resourceVersion: integer,
  processing: z.literal("complete"),
});
export const documentVersion = object({
  id,
  originalId,
  operationId: id,
  artifactId: id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["imported-xml", "distribution-xml"]),
  importedAt: integer,
  publishedAt: integer,
  parserVersion: text,
  normalizerVersion: nullableText,
  processorVersion: text,
  schema: nullableText,
  code: text,
  kind: text,
  itemCount: integer,
  originalAvailable: z.boolean(),
});
export const fiscalSituation = object({
  ruleVersion: z
    .enum(["nfe-status/1", "nfe-status/2"])
    .describe(
      "Regra que produziu a situação. nfe-status/2 deixa a interpretação de um catálogo de schemas mais novo substituir a recusa apenas na etapa XSD por um catálogo mais antigo; uma situação gravada antes continua com nfe-status/1 até a próxima reconstrução.",
    ),
  key: key.nullable(),
  reportedStatus: fiscalStatus,
  basis: z.literal("preserved-claims"),
  assurance: z.literal("unverified-origin"),
  liveConsultation: z.literal(false),
  evidenceIds: z.array(id),
  excluded: z.array(object({ id, reason: text })),
  conflicts: z.array(text),
});
export const document = object({
  contractVersion: z.literal("documents/1"),
  model: documentModel,
  summary: documentSummary,
  payload: documentPayload,
  version: documentVersion,
  fiscalSituation: fiscalSituation.nullable(),
  previousFiscalSituation: fiscalSituation.nullable(),
});
export const documentFile = object({
  id,
  originalId,
  name: text,
  sha256: text,
  size: integer,
  source: z.enum(["imported-xml", "distribution-xml"]),
  importedAt: integer,
  originalAvailable: z.boolean(),
});
export const unclassifiedArtifact = object({
  id,
  originalId,
  name: text,
  sha256: text,
  importedAt: integer,
  size: integer,
  code: text,
  originalAvailable: z.boolean(),
});
export const operation = object({
  id,
  originalId,
  state: z.enum([
    "queued",
    "running",
    "retry_wait",
    "reconciling",
    "paused",
    "succeeded",
    "failed",
  ]),
  generation: integer,
  attempts: integer,
  nextAttemptAt: integer.nullable(),
  code: nullableText,
  result: nullableText,
  uncertain: z.boolean(),
});
export const importDocument = object({ documentId: id, versionId: id, number: text, code: text });
export const importFile = object({
  id,
  originalId,
  name: text,
  size: integer,
  sha256: text,
  state: z.union([z.enum(["reserved", "uploaded", "accepted", "expired"]), operation.shape.state]),
  operationId: id.nullable(),
  generation: integer,
  code: nullableText,
  documentId: id.nullable(),
  versionId: id.nullable(),
  documents: z.array(importDocument).optional(),
  result: nullableText,
});
export const importBatch = object({
  id,
  originalId,
  createdAt: integer,
  files: z.array(importFile),
});
const accepted = object({ operationId: id, reused: z.boolean() });
const endpointFields = { name: text, url: text, events: z.array(z.enum(webhookEvents)) };
export const endpoint = object({
  id,
  ...endpointFields,
  active: z.boolean(),
  version: positive,
  secretVersion: positive,
  previousUntil: integer.nullable(),
  createdAt: integer,
});
export const delivery = object({
  id,
  eventId: id,
  type: z.enum([...webhookEvents, "webhook.test"]),
  resourceVersion: positive,
  state: z.enum(["queued", "running", "retry_wait", "delivered", "failed", "paused"]),
  attempts: integer,
  resends: integer,
  generation: integer,
  nextAttemptAt: integer.nullable(),
  code: nullableText,
  httpStatus: integer.nullable(),
  durationMs: integer.nullable(),
  response: nullableText,
  createdAt: integer,
  canRetry: z.boolean(),
});
const company = object({
  id,
  name: text,
  cnpj: text,
  kind: z.enum(["declared", "demonstration"]),
  registryStatus: z.literal("not-consulted"),
  fiscalAccess: z.literal("not-configured"),
});

export const publicErrorStatus = {
  STREAM_CONFLICT: 409,
  CAPTURE_PAUSED: 409,
  // The source (656) holds the capture until `nextAllowedAt`: a conflict with the stream's state,
  // like CAPTURE_PAUSED, not our rate limit (429); retryable at that instant, not in a loop.
  SOURCE_COOLDOWN: 409,
  CERTIFICATE_UNAVAILABLE: 409,
  CAPTURE_DEMONSTRATION_DENIED: 400,
  INVALID_API_KEY: 401,
  NOT_FOUND: 404,
  SCOPE_DENIED: 403,
  ENVIRONMENT_DENIED: 403,
  INVALID_REQUEST: 400,
  INVALID_QUERY: 400,
  INVALID_CURSOR: 400,
  INVALID_PAGINATION: 400,
  ORIGINAL_UNAVAILABLE: 404,
  // #402: the document has no DANFE (not a complete NF-e 55) or the generator refused its XML.
  DANFE_UNAVAILABLE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OPERATION_CONFLICT: 409,
  RECONCILIATION_REQUIRED: 409,
  ATTEMPTS_EXHAUSTED: 409,
  RECOVERY_BUDGET_EXHAUSTED: 409,
  ACCESS_REVOKED: 409,
  INVALID_FILE: 400,
  FILE_TOO_LARGE: 413,
  UPLOAD_EXPIRED: 409,
  ALREADY_ACCEPTED: 409,
  RATE_LIMITED: 429,
  ENDPOINT_LIMIT: 409,
  ENDPOINT_CHANGED: 409,
  ROTATION_IN_PROGRESS: 409,
  // The organization is in cold custody (ADR 0009, §3): its fiscal data and admissions wait for
  // the reactivation. A conflict with the organization's state, never a missing permission.
  ORGANIZATION_ARCHIVED: 409,
  // NFS-e issuance (docs/plataforma/ISSUANCE.md). Request fields: 400; company/profile state: 409.
  ISSUANCE_PRODUCTION_DISABLED: 403,
  ISSUANCE_DEMONSTRATION_DENIED: 400,
  NFSE_PROFILE_REQUIRED: 409,
  NFSE_ACTIVITY_NOT_FOUND: 400,
  NFSE_ROUTE_UNSUPPORTED: 409,
  NFSE_ROUTE_PROFILE_INCOMPLETE: 409,
  ISSUANCE_FIELD_INVALID: 400,
  ISSUANCE_TAKER_DOCUMENT_INVALID: 400,
  ISSUANCE_TAKER_NIF_INVALID: 400,
  ISSUANCE_TAKER_INVALID: 400,
  ISSUANCE_EXPORT_TAKER_REQUIRED: 400,
  ISSUANCE_EXPORT_CURRENCY_REQUIRED: 400,
  ISSUANCE_CURRENCY_INVALID: 400,
  ISSUANCE_CURRENCY_UNSUPPORTED: 400,
  ISSUANCE_AMOUNT_INVALID: 400,
  ISSUANCE_ISS_RATE_INVALID: 400,
  ISSUANCE_ISS_RATE_REQUIRED: 400,
  ISSUANCE_ISS_RATE_NOT_ALLOWED: 400,
  ISSUANCE_ISS_NOT_LEVIED: 400,
  ISSUANCE_WITHHOLDING_INVALID: 400,
  ISSUANCE_COMPETENCE_INVALID: 400,
  ISSUANCE_COMPETENCE_FUTURE: 400,
  ISSUANCE_DATE_INVALID: 400,
  ISSUANCE_DATE_FUTURE: 400,
  ISSUANCE_ISSUER_EMAIL_REQUIRED: 400,
  DPS_NUMBER_EXHAUSTED: 409,
  CANCEL_REASON_INVALID: 400,
  ISSUANCE_NOT_CANCELLABLE: 409,
  ISSUANCE_TRANSPORT_CHANGED: 409,
  UNAVAILABLE: 503,
} as const;
export const errorResponse = object({
  error: object({
    code: z.enum(
      Object.keys(publicErrorStatus) as [
        keyof typeof publicErrorStatus,
        ...(keyof typeof publicErrorStatus)[],
      ],
    ),
    message: text,
    retryable: z.boolean(),
    /** Request field that failed validation, as a dotted path (`taker.document`). */
    field: z
      .string()
      .regex(/^[A-Za-z][A-Za-z.]{0,79}$/)
      .optional(),
    /** Profile fields the issuance still needs (`NFSE_ROUTE_PROFILE_INCOMPLETE`). */
    missing: z
      .array(z.string().regex(/^[A-Za-z]{1,40}$/))
      .max(10)
      .optional(),
    /** Instant, in epoch ms, from which the capture may be resumed (`SOURCE_COOLDOWN`). */
    nextAllowedAt: integer
      .describe("Instante, em epoch ms, a partir do qual a captura pode ser retomada.")
      .optional(),
  }),
  requestId: id,
});
export const dataResponse = <T extends z.ZodType>(data: T) => object({ data, requestId: id });
const page = <T extends z.ZodType>(item: T) =>
  object({ page: z.array(item), nextCursor: nullableText });
const pagination = {
  cursor: text.max(8192).optional(),
  limit: z.number().int().min(1).max(50).optional(),
};
const companyPagination = { ...pagination, cursor: text.max(1024).optional() };
const companyQuery = { companyId: id };
const companyPage = { ...companyQuery, ...pagination };
const smallPage = { ...companyPage, limit: z.number().int().min(1).max(20).optional() };
const empty = object({});
const request = <P extends z.ZodRawShape, Q extends z.ZodRawShape, B extends z.ZodType>(
  path: P,
  query: Q,
  body: B,
) => object({ path: object(path), query: object(query), body });
const get = <P extends z.ZodRawShape, Q extends z.ZodRawShape>(path: P, query: Q) =>
  request(path, query, empty);
const post = <P extends z.ZodRawShape, B extends z.ZodType>(path: P, body: B) =>
  request(path, {}, body);
const importPath = { importId: id };
const filePath = { ...importPath, fileId: id };
const documentPath = { documentId: id };
const endpointPath = { endpointId: id };
export type RetryPolicy = "read" | "idempotent" | "never";
function route<I extends z.ZodType, O extends z.ZodType>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  input: I,
  output: O,
  scope: string,
  retry: RetryPolicy = "never",
  status = 200,
) {
  return {
    method,
    path,
    input,
    output,
    scope,
    retry,
    status,
    idempotencyPattern: path.includes("webhook")
      ? "^[A-Za-z0-9_-]{8,128}$"
      : "^[\\x21-\\x7e]{1,128}$",
  };
}
const r = <I extends z.ZodType, O extends z.ZodType>(
  path: string,
  input: I,
  data: O,
  scope = "documents:read",
) => route("GET", path, input, dataResponse(data), scope, "read");
const w = <I extends z.ZodType, O extends z.ZodType>(
  path: string,
  input: I,
  data: O,
  scope: string,
  retry: RetryPolicy = "never",
) => route("POST", path, input, dataResponse(data), scope, retry);
export const captureConnection = object({
  id,
  organizationId: id,
  companyId: id,
  projectId: id,
  environment,
  state: z.enum(["active", "paused", "attention"]),
  version: positive,
  checkpoint: text,
  sourceCursor: nullableText,
  /** Last NSU the source reported (`maxNSU`); null until a query is answered. */
  sourceMaxNsu: nullableText.describe(
    "Último NSU informado pela Receita (maxNSU); null até a primeira consulta respondida.",
  ),
  nextAllowedAt: integer,
  lastAttemptAt: integer.nullable(),
  lastSuccessAt: integer.nullable(),
  code: nullableText,
  received: integer,
  operationId: id.nullable(),
  operationState: nullableText,
  certificateState: text,
  certificateExpiresAt: integer.nullable(),
});
export const documentExport = object({
  id,
  // API keys export only documents; organization export belongs to the console's manager flow.
  selection: object({ kind: z.literal("document"), documentId: id, companyId: id, projectId: id }),
  environment,
  state: z.enum(["running", "succeeded", "failed", "revoked", "expired"]),
  createdAt: integer,
  expiresAt: integer,
  parts: integer,
  bytes: integer,
  code: nullableText,
});
export const exportPart = object({
  id,
  sequence: integer,
  sha256: text.regex(/^[a-f0-9]{64}$/),
  size: integer,
});
// NFS-e issuance (ADR 0004). Field semantics, limits and codes are validated by the domain, so the
// wire schema only fixes types and generous sizes: a precise code beats a generic 400.
const serviceValue = z
  .string()
  .regex(/^\d{1,13}(?:\.\d{1,2})?$/)
  .describe(
    "Valor do serviço em texto decimal, até 2 casas; nunca converter para ponto flutuante.",
  );
const issRate = z
  .string()
  .regex(/^\d{1,2}(?:\.\d{1,4})?$/)
  .describe(
    "Alíquota de ISS em %, texto decimal com até 4 casas; a DPS leva 2, então a 3ª e a 4ª só podem ser zero.",
  );
const field = (max: number) => text.max(max);
const nationalTaker = object({
  kind: z.literal("national"),
  document: field(32).describe("CPF ou CNPJ; pontuação é removida."),
  name: field(600),
  email: field(160).optional(),
  address: object({
    municipalityCode: field(16).describe("Código IBGE do município, 7 dígitos."),
    postalCode: field(16),
    street: field(512),
    number: field(128),
    district: field(128),
  }),
});
const foreignTaker = object({
  kind: z.literal("foreign"),
  nif: field(80).optional(),
  nifAbsence: z
    .number()
    .int()
    .min(1)
    .max(2)
    .optional()
    .describe("Sem NIF: 1 dispensado, 2 não exigido."),
  name: field(600),
  email: field(160).optional(),
  // The DPS XSD requires the whole address abroad (TCEnderExt and TCEndereco). Empty or too long
  // values reach the domain, which answers ISSUANCE_FIELD_INVALID with the field.
  address: object({
    country: field(8).describe("ISO 3166-1 alfa-2, diferente de BR."),
    city: field(128).describe("Cidade, até 60 caracteres."),
    postalCode: field(32).describe("Código postal, até 11 caracteres."),
    state: field(128).describe("Estado, província ou região, até 60 caracteres."),
    street: field(512).describe("Logradouro, até 255 caracteres."),
    number: field(128).describe("Número, até 60 caracteres."),
    district: field(128).describe(
      "Bairro, até 60 caracteres; sem bairro no endereço, informe a região, o distrito ou N/A.",
    ),
  }),
});
export const issuanceRequest = object({
  companyId: id,
  activityCode: field(80),
  competence: field(16).describe("Mês de competência, AAAA-MM."),
  issueDate: field(16).optional().describe("Data civil da emissão em Brasília, AAAA-MM-DD."),
  issuerEmail: field(160)
    .optional()
    .describe("E-mail do prestador na DPS; opcional quando o perfil NFS-e tem um."),
  market: z.enum(["domestic", "export"]),
  taker: z.discriminatedUnion("kind", [nationalTaker, foreignTaker]),
  description: field(4000),
  amount: object({ currency: field(8), value: serviceValue }),
  issRate: issRate.optional(),
  issWithheld: z.boolean(),
});
export const issuanceState = z.enum(["processing", "authorized", "rejected", "cancelled"]);
const rejection = object({ code: nullableText, message: text });
export const issuanceArtifact = object({
  id,
  originalId,
  kind: z.enum(["dps", "nfse", "danfse", "cancel-request", "cancel-event"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: integer,
  signed: z.boolean(),
  createdAt: integer,
});
export const issuanceCancellation = object({
  id,
  operationId: id,
  state: z.enum(["processing", "registered", "rejected"]),
  sequence: positive,
  reasonCode: z.enum(["1", "2", "9"]),
  reason: text,
  code: nullableText,
  rejections: z.array(rejection),
  alreadyRegistered: z.boolean(),
  createdAt: integer,
  updatedAt: integer,
});
export const issuance = object({
  id,
  originalId,
  companyId: id,
  projectId: id,
  environment,
  operationId: id,
  operationState: operation.shape.state,
  state: issuanceState,
  transport: z.enum(["simulated", "producao-restrita", "producao"]),
  target: text,
  series: text,
  number: positive,
  dpsId: text,
  issueDate: text,
  competence: text,
  market: z.enum(["domestic", "export"]),
  amount: object({ currency: text, value: exactDecimal }),
  serviceBrl: exactDecimal.nullable(),
  exchange: object({
    currency: text,
    amount: exactDecimal,
    rate: exactDecimal,
    quoteDate: text,
    brlAmount: exactDecimal,
    source: z.enum(["ptax-bcb", "simulated"]),
    frozenAt: integer,
  }).nullable(),
  accessKey: z
    .string()
    .regex(/^\d{50}$/)
    .nullable(),
  nfseNumber: nullableText,
  code: nullableText,
  rejections: z.array(rejection),
  artifacts: z.array(issuanceArtifact),
  cancellation: issuanceCancellation.nullable(),
  version: positive,
  createdAt: integer,
  updatedAt: integer,
});
const issuanceAccepted = object({ reused: z.boolean(), issuance });
const issuanceRead = "documents:issue ou documents:cancel";
export const routes = {
  createExport: w(
    "/v1/exports",
    post({}, object({ companyId: id, documentId: id })),
    documentExport,
    "documents:read",
    "idempotent",
  ),
  getExport: r("/v1/exports/{exportId}", get({ exportId: id }, {}), documentExport),
  exportParts: r(
    "/v1/exports/{exportId}/parts",
    get(
      { exportId: id },
      { cursor: text.max(8192).optional(), limit: positive.max(50).optional() },
    ),
    page(exportPart),
  ),
  revokeExport: w(
    "/v1/exports/{exportId}/revoke",
    post({ exportId: id }, empty),
    documentExport,
    "documents:read",
  ),
  exportTicket: w(
    "/v1/export-parts/{partId}/ticket",
    post({ partId: id }, empty),
    object({ token: text, expiresAt: integer }),
    "documents:read",
  ),
  controlCapture: w(
    "/v1/connections/nfe",
    post(
      {},
      object({
        companyId: id,
        action: z.enum(["activate", "sync", "pause", "resume"]),
        expectedVersion: positive.optional(),
      }),
    ),
    captureConnection,
    "connections:write",
  ),
  getCapture: r(
    "/v1/connections/nfe",
    get({}, companyQuery),
    captureConnection.nullable(),
    "connections:read",
  ),
  getRegistry: r(
    "/v1/registry/cnpj/{cnpj}",
    get({ cnpj: z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/) }, companyQuery),
    registryLookup,
    "registry:read",
  ),
  refreshRegistry: w(
    "/v1/registry/cnpj/{cnpj}/refresh",
    post({ cnpj: z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/) }, object(companyQuery)),
    accepted,
    "registry:read",
    "idempotent",
  ),
  listMunicipalities: r(
    "/v1/references/municipalities",
    get(
      {},
      {
        ...companyPage,
        q: text.max(100).optional(),
        date: referenceDate.optional(),
        version: referenceVersion.optional(),
      },
    ),
    referencePage,
    "references:read",
  ),
  getMunicipality: r(
    "/v1/references/municipalities/{code}",
    get(
      { code: text.regex(/^\d{7}$/) },
      { ...companyQuery, date: referenceDate.optional(), version: referenceVersion.optional() },
    ),
    referenceLookup,
    "references:read",
  ),
  listNcm: r(
    "/v1/references/ncm",
    get(
      {},
      {
        ...companyPage,
        q: text.max(100).optional(),
        date: referenceDate.optional(),
        version: referenceVersion.optional(),
      },
    ),
    referencePage,
    "references:read",
  ),
  getNcm: r(
    "/v1/references/ncm/{code}",
    get(
      { code: text.regex(/^\d{8}$/) },
      { ...companyQuery, date: referenceDate.optional(), version: referenceVersion.optional() },
    ),
    referenceLookup,
    "references:read",
  ),
  listCompanies: route(
    "GET",
    "/v1/companies",
    get({}, companyPagination),
    object({ data: z.array(company), nextCursor: nullableText, requestId: id }),
    "companies:read",
    "read",
  ),
  getCompany: r(
    "/v1/companies/{companyId}",
    get({ companyId: id }, companyPagination),
    company,
    "companies:read",
  ),
  reserveImport: w(
    "/v1/imports",
    post(
      {},
      object({
        companyId: id,
        files: z
          .array(
            object({
              // eslint-disable-next-line no-control-regex -- Filenames must exclude control bytes as well as path separators.
              name: text.regex(/^[^/\\\x00-\x1f\x7f]{1,180}\.[xX][mM][lL]$/),
              size: positive.max(2097152),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .min(1)
          .max(20),
      }),
    ),
    object({ importId: id, fileIds: z.array(id), reused: z.boolean() }),
    "documents:import",
    "idempotent",
  ),
  getImport: r("/v1/imports/{importId}", get(importPath, {}), importBatch, "documents:import"),
  createUpload: w(
    "/v1/imports/{importId}/files/{fileId}/upload",
    post(filePath, empty),
    object({ url: text, token: text, expiresAt: integer }),
    "documents:import",
  ),
  confirmImport: w(
    "/v1/imports/{importId}/files/{fileId}/confirm",
    post(filePath, empty),
    accepted,
    "documents:import",
  ),
  reprocessImport: w(
    "/v1/imports/{importId}/files/{fileId}/reprocess",
    post(filePath, empty),
    accepted,
    "documents:import",
    "idempotent",
  ),
  importHistory: r(
    "/v1/imports/{importId}/files/{fileId}/history",
    get(filePath, {}),
    z.array(object({ id, processorVersion: text, completedAt: integer, code: text, result: text })),
    "documents:import",
  ),
  getOperation: r(
    "/v1/operations/{operationId}",
    get({ operationId: id }, {}),
    operation,
    "escopo da operação",
  ),
  pauseOperation: w(
    "/v1/operations/{operationId}/pause",
    post({ operationId: id }, object({ expectedGeneration: integer })),
    operation,
    "escopo da operação",
  ),
  retryOperation: w(
    "/v1/operations/{operationId}/retry",
    post({ operationId: id }, object({ expectedGeneration: integer })),
    operation,
    "escopo da operação",
  ),
  listDocuments: r(
    "/v1/documents",
    get(
      {},
      {
        ...companyPage,
        status: fiscalStatus.optional(),
        source: z.enum(["imported-xml", "distribution-xml"]).optional(),
        from: integer.optional(),
        to: integer.optional(),
        key: documentKey.optional(),
      },
    ),
    page(documentSummary).extend({ indexing: z.boolean() }),
  ),
  getDocument: r(
    "/v1/documents/{documentId}",
    get(documentPath, { ...companyQuery, versionId: id.optional() }),
    document,
  ),
  documentJson: r(
    "/v1/documents/{documentId}/json",
    get(documentPath, { ...companyQuery, versionId: id.optional() }),
    document,
  ),
  documentItems: r(
    "/v1/documents/{documentId}/items",
    get(documentPath, {
      ...companyPage,
      limit: z.number().int().min(1).max(25).optional(),
      versionId: id,
    }),
    page(nfeItem).extend({ versionId: id }),
  ),
  documentEvents: r(
    "/v1/documents/{documentId}/events",
    get(documentPath, { ...smallPage, kind: z.enum(["event", "event-summary"]).optional() }),
    page(object({ version: documentVersion, payload: nfePayload })),
  ),
  documentVersions: r(
    "/v1/documents/{documentId}/versions",
    get(documentPath, smallPage),
    page(object({ version: documentVersion, payload: documentPayload })),
  ),
  documentFiles: r(
    "/v1/documents/{documentId}/files",
    get(documentPath, smallPage),
    page(documentFile),
  ),
  listArtifacts: r("/v1/document-artifacts", get({}, smallPage), page(unclassifiedArtifact)),
  reprocessDocument: route(
    "POST",
    "/v1/documents/{documentId}/reprocess",
    request(documentPath, companyQuery, empty),
    dataResponse(accepted),
    "documents:import",
    "idempotent",
    202,
  ),
  createIssuance: {
    ...route(
      "POST",
      "/v1/issuances",
      post({}, issuanceRequest),
      dataResponse(issuanceAccepted),
      "documents:issue",
      "idempotent",
      202,
    ),
    /** Response header pointing to the accepted resource. */
    location: "/v1/issuances/{issuanceId}",
  },
  listIssuances: r(
    "/v1/issuances",
    get({}, { ...companyPage, state: issuanceState.optional() }),
    page(issuance),
    issuanceRead,
  ),
  getIssuance: r(
    "/v1/issuances/{issuanceId}",
    get({ issuanceId: id }, companyQuery),
    issuance,
    issuanceRead,
  ),
  cancelIssuance: route(
    "POST",
    "/v1/issuances/{issuanceId}/cancellation",
    post(
      { issuanceId: id },
      object({ companyId: id, reasonCode: z.enum(["1", "2", "9"]), reason: field(1024) }),
    ),
    dataResponse(issuanceAccepted),
    "documents:cancel",
    "idempotent",
    202,
  ),
  listWebhookEndpoints: r(
    "/v1/webhook-endpoints",
    get({}, companyQuery),
    z.array(endpoint),
    "webhooks:manage",
  ),
  getWebhookEndpoint: r(
    "/v1/webhook-endpoints/{endpointId}",
    get(endpointPath, {}),
    endpoint,
    "webhooks:manage",
  ),
  createWebhookEndpoint: w(
    "/v1/webhook-endpoints",
    post({}, object({ companyId: id, ...endpointFields })),
    object({ endpoint, secret: text }),
    "webhooks:manage",
  ),
  editWebhookEndpoint: route(
    "PATCH",
    "/v1/webhook-endpoints/{endpointId}",
    post(
      endpointPath,
      object({ ...endpointFields, active: z.boolean(), expectedVersion: positive }),
    ),
    dataResponse(endpoint),
    "webhooks:manage",
  ),
  rotateWebhookSecret: w(
    "/v1/webhook-endpoints/{endpointId}/rotate-secret",
    post(endpointPath, object({ expectedVersion: positive, overlapMs: integer.max(86400000) })),
    object({ endpoint, secret: text }),
    "webhooks:manage",
  ),
  testWebhookEndpoint: w(
    "/v1/webhook-endpoints/{endpointId}/test",
    post(endpointPath, empty),
    object({ eventId: id }),
    "webhooks:manage",
    "idempotent",
  ),
  listWebhookDeliveries: r(
    "/v1/webhook-deliveries",
    get({}, { endpointId: id, ...pagination }),
    object({ items: z.array(delivery), nextCursor: nullableText }),
    "webhooks:manage",
  ),
  retryWebhookDelivery: w(
    "/v1/webhook-deliveries/{deliveryId}/retry",
    post({ deliveryId: id }, object({ expectedGeneration: integer })),
    delivery,
    "webhooks:manage",
    "idempotent",
  ),
  getCapabilities: r(
    "/v1/capabilities",
    get({}, {}),
    object({
      apiVersion: z.literal(apiVersion),
      environment,
      models: z.array(documentModel),
      capabilities: z.array(text),
      webhookEvents: z.array(z.enum(webhookEvents)),
      limits: object({ importFiles: integer, importBytes: integer, pageSize: integer }),
    }),
    "chave válida",
  ),
} as const;
export type RouteName = keyof typeof routes;
export const uploadResponse = dataResponse(object({ uploaded: z.literal(true) }));
/** JSON Schema of `id`, for transfer parameters written by hand. */
const idSchema = { type: "string", minLength: 1, maxLength: 128 } as const;
/** Transport definitions share this source; SDK upload sends bytes instead of JSON. */
export const transferPaths = {
  "/v1/export-download": {
    get: {
      operationId: "downloadExportPart",
      "x-scope": "ticket privado com acesso revalidado",
      "x-retry-policy": "never",
      security: [],
      parameters: [
        {
          name: "X-Download-Token",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 72, maxLength: 72 },
        },
      ],
      responses: {
        200: {
          description:
            "Parte gzip JSONL; ticket válido por até 60 segundos; Cache-Control: no-store",
          content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
        },
        default: {
          description: "Ticket expirado ou acesso revogado",
          headers: {
            "X-Request-Id": { schema: { type: "string" } },
            "Cache-Control": { schema: { type: "string", const: "no-store" } },
          },
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  "/v1/import-upload": {
    post: {
      operationId: "uploadImport",
      "x-scope": "ticket de upload",
      "x-retry-policy": "never",
      security: [{ uploadTicket: [] }],
      parameters: [
        {
          name: "X-Upload-Token",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 72, maxLength: 72 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/xml": {
            schema: { type: "string", format: "binary", "x-max-bytes": 2097152 },
          },
        },
      },
      responses: {
        200: {
          description: "Bytes conferidos; confirmação ainda necessária",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/UploadResponse" } },
          },
        },
        default: {
          description: "Ticket ou bytes inválidos",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  "/v1/document-artifacts/{artifactId}/original": {
    get: {
      operationId: "downloadOriginal",
      "x-scope": "documents:read",
      "x-retry-policy": "never",
      parameters: [
        { name: "artifactId", in: "path", required: true, schema: { type: "string" } },
        { name: "companyId", in: "query", required: true, schema: { type: "string" } },
        {
          name: "X-Environment",
          in: "header",
          required: true,
          schema: { type: "string", enum: ["sandbox", "production"] },
        },
      ],
      responses: {
        200: {
          description: "Bytes originais; autorização revalidada no acesso",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        default: {
          description: "Acesso negado ou original indisponível",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  "/v1/documents/{documentId}/danfe": {
    get: {
      operationId: "downloadDanfe",
      "x-scope": "documents:read",
      "x-retry-policy": "never",
      parameters: [
        { name: "documentId", in: "path", required: true, schema: idSchema },
        { name: "companyId", in: "query", required: true, schema: idSchema },
        {
          name: "X-Environment",
          in: "header",
          required: true,
          schema: { type: "string", enum: ["sandbox", "production"] },
        },
      ],
      responses: {
        200: {
          description:
            "PDF do DANFE, representação auxiliar gerada do XML preservado da NF-e modelo 55 e dos eventos de cancelamento preservados; o XML original não muda. A primeira chamada pode gerar o arquivo; autorização revalidada no acesso",
          content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
        },
        default: {
          description:
            "Acesso negado, documento sem DANFE (DANFE_UNAVAILABLE: não é NF-e 55 com XML completo, ou o gerador recusou o XML) ou geração limitada",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  "/v1/issuances/{issuanceId}/artifacts/{artifactId}": {
    get: {
      operationId: "downloadIssuanceArtifact",
      "x-scope": issuanceRead,
      "x-retry-policy": "never",
      parameters: [
        { name: "issuanceId", in: "path", required: true, schema: idSchema },
        { name: "artifactId", in: "path", required: true, schema: idSchema },
        { name: "companyId", in: "query", required: true, schema: idSchema },
        {
          name: "X-Environment",
          in: "header",
          required: true,
          schema: { type: "string", enum: ["sandbox", "production"] },
        },
      ],
      responses: {
        200: {
          description:
            "Artefato preservado da emissão: XML (DPS, NFS-e, pedido ou retorno do evento) ou PDF do DANFSe; autorização revalidada no acesso",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        default: {
          description: "Acesso negado ou artefato indisponível",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
} as const;
export type RequestOf<K extends RouteName> = z.infer<(typeof routes)[K]["input"]>;
export type ResponseOf<K extends RouteName> = z.infer<(typeof routes)[K]["output"]>;

/** Query coercion is transport-only. Schemas and SDK still use typed numbers. */
export function matchRoute(method: string, pathname: string) {
  for (const [name, entry] of Object.entries(routes)) {
    if (entry.method !== method) continue;
    const names = [...entry.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const match = new RegExp(`^${entry.path.replace(/\{\w+\}/g, "([^/]+)")}$`).exec(pathname);
    if (match)
      return {
        name: name as RouteName,
        entry,
        path: Object.fromEntries(names.map((key, i) => [key, decodeURIComponent(match[i + 1]!)])),
      };
  }
  return null;
}
export function parseRequest(method: string, url: URL, body: unknown) {
  const match = matchRoute(method, url.pathname);
  if (!match) return null;
  const query: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(query, name)) throw new Error("INVALID_REQUEST");
    query[name] = ["limit", "from", "to"].includes(name)
      ? value.trim()
        ? Number(value)
        : NaN
      : value;
  }
  return { ...match, value: match.entry.input.parse({ path: match.path, query, body }) };
}
