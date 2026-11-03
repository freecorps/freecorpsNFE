import { decimal } from "@freecorps/fiscal-core";

export const documentContractVersion = "documents/1" as const;
import type { z } from "zod";
import {
  fiscalStatus,
  documentSummary,
  documentVersion,
  fiscalSituation,
  document,
  documentFile,
  unclassifiedArtifact,
  nfePayload,
  nfsePayload,
  nfeItem,
} from "./external.js";
export const fiscalStatuses = fiscalStatus.options;
export type FiscalStatus = z.infer<typeof fiscalStatus>;
export type PublicFiscalSituation = z.infer<typeof fiscalSituation>;
export type PublicDocumentSummary = z.infer<typeof documentSummary>;
export type PublicDocumentVersion = z.infer<typeof documentVersion>;
export type PublicDocument = z.infer<typeof document>;
export type PublicDocumentFile = z.infer<typeof documentFile>;
export type PublicUnclassifiedArtifact = z.infer<typeof unclassifiedArtifact>;
export interface DocumentPage<T> {
  page: T[];
  nextCursor: string | null;
}
export interface DocumentResponse<T> {
  data: T;
  requestId: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DOCUMENT_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 6000): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error("DOCUMENT_INVALID");
  return value;
}
const nullable = (value: unknown) => (value === null ? null : text(value));
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error("DOCUMENT_INVALID");
  return value as T;
}
function exact(value: unknown): string {
  const input = object(value);
  const parsed = decimal(text(input.declared, 64));
  if (parsed.coefficient !== input.coefficient || parsed.scale !== input.scale)
    throw new Error("DOCUMENT_INVALID");
  return parsed.declared;
}
const optionalExact = (value: unknown) => (value === null ? null : exact(value));
/**
 * NT 2026.008 fields read by nfe-parser/4. A stored version without them was processed earlier:
 * `null` asks for reprocessing. Inside the object, `null` is a field the XML omits.
 */
function nt2026008<K extends string>(value: unknown, keys: readonly K[]) {
  if (value === undefined) return null;
  const input = object(value);
  return Object.fromEntries(keys.map((key) => [key, optionalExact(input[key])])) as Record<
    K,
    string | null
  >;
}
/**
 * `gPgto/tpMeioPgto` codes of the IT DFe 2026.001 v1.01 ("meios de pagamento", published on
 * 2026-08-25, page 3), with its descriptions verbatim, minus the asterisk on 23 and 24 ("Novos
 * códigos que serão atualizados na tabela nacional"). The XSD only checks two digits; the IT
 * provides for the rejection of any other code at authorization, a rule the platform does not
 * evaluate. New codes arrive by updates of the IT, so this table names its version.
 */
export const nfePaymentMeansLabelsSource = "IT DFe 2026.001 v1.01";
export const nfePaymentMeansLabels: Readonly<Record<string, string>> = {
  "15": "Boleto",
  "17": "Pix QRCode",
  "18": "TED",
  "20": "PIX chave ou QRCode estático",
  "23": "Pix automático",
  "24": "TEF / booktransfer",
};
/**
 * NT 2026.006 `gPgtoVinc`, read by nfe-parser/6. As with `nt2026008`, a stored version without
 * it gives `null`; inside, `gPgtoVinc: null` is a group the XML omits. `tpMeioPgtoLabel` is
 * derived here, never stored: a code outside the IT table keeps its value with a `null` label.
 */
function nt2026006(value: unknown) {
  if (value === undefined) return null;
  const links = object(value).gPgtoVinc;
  if (links === null) return { gPgtoVinc: null };
  if (!Array.isArray(links) || links.length > 99) throw new Error("DOCUMENT_INVALID");
  return {
    gPgtoVinc: links.map((entry: unknown) => {
      const input = object(entry);
      const tpMeioPgto = text(input.tpMeioPgto, 2);
      return {
        nPag: text(input.nPag, 3),
        idTransacao: text(input.idTransacao, 35),
        tpMeioPgto,
        tpMeioPgtoLabel: label(nfePaymentMeansLabels, tpMeioPgto),
        CNPJReceb: text(input.CNPJReceb, 14),
        CNPJBasePSP: text(input.CNPJBasePSP, 8),
      };
    }),
  };
}
function party(value: unknown) {
  const input = object(value);
  return {
    kind: choice(input.kind, ["CPF", "CNPJ"]),
    document: text(input.document, 14),
    name: nullable(input.name),
    stateRegistration: nullable(input.stateRegistration),
  };
}
function taxes(value: unknown) {
  if (!Array.isArray(value) || value.length > 400) throw new Error("DOCUMENT_INVALID");
  return value.map((entry: unknown) => {
    const input = object(entry);
    const representation = choice(input.representation, ["decimal", "code", "text"]);
    return {
      path: text(input.path, 160),
      representation,
      value: representation === "decimal" ? exact(input.value) : text(input.value),
      basis: "declared" as const,
    };
  });
}
/** Codes and descriptions of the pinned PL_010g XSD (`TFinNFe`, `TTpNFCredito`, `TTpNFDebito`). */
export const nfePurposeLabels: Readonly<Record<string, string>> = {
  "1": "NF-e normal",
  "2": "NF-e complementar",
  "3": "NF-e de ajuste",
  "4": "Devolução/retorno",
  "5": "Nota de crédito",
  "6": "Nota de débito",
};
export const nfeCreditNoteTypeLabels: Readonly<Record<string, string>> = {
  "01": "Multa e juros",
  "02": "Apropriação de crédito presumido de IBS sobre o saldo devedor na ZFM (art. 450, § 1º, LC 214/25)",
  "03": "Retorno por recusa na entrega ou por não localização do destinatário na tentativa de entrega",
  "04": "Redução de valores",
  "05": "Transferência de crédito na sucessão",
  "06": "Retorno por recusa parcial na entrega",
};
export const nfeDebitNoteTypeLabels: Readonly<Record<string, string>> = {
  "01": "Transferência de créditos para cooperativas",
  "02": "Anulação de crédito por saídas imunes/isentas",
  "03": "Débitos de notas fiscais não processadas na apuração",
  "04": "Multa e juros",
  "05": "Transferência de crédito na sucessão",
  "06": "Pagamento antecipado",
  "07": "Perda em estoque (perecimento, perda, furto, roubo)",
  "08": "Desenquadramento do SN",
};
const label = (labels: Readonly<Record<string, string>>, code: string | null) =>
  code !== null && Object.hasOwn(labels, code) ? labels[code]! : null;
function officialCode(value: unknown, labels: Readonly<Record<string, string>>) {
  const code = value === null ? null : text(value, 2);
  return code === null ? null : { code, label: label(labels, code) };
}
/**
 * Stored invoices without `purpose` were processed before nfe-parser/3: `null` asks for
 * reprocessing, which reads the original XML again. Inconsistencies name the rules of NT 2025.002
 * v1.52, section 7, group B, page 32, that the declared combination breaks; they never change the
 * fiscal situation. The SEFAZ applies them at authorization; the pinned XSD accepts all four.
 *   B25.1-10: "Se informado tipo de nota de débito (tag: tpNFDebito) - Finalidade <> 6-Nota de débito"
 *   B25.1-20: "Se finalidade = 6-Nota de débito (tag:finNFe) - Não informado tipo de nota de débito"
 *   B25.2-10: "Se informado tipo de nota de crédito (tag: tpNFCredito) - Finalidade <> 5-Nota de crédito"
 *   B25.2-20: "Se finalidade = 5-Nota de crédito (tag:finNFe) - Não informado tipo de nota de crédito"
 */
function purpose(value: unknown) {
  if (value === undefined) return null;
  const input = object(value);
  const code = input.code === null ? null : text(input.code, 1);
  const creditNoteType = officialCode(input.creditType, nfeCreditNoteTypeLabels);
  const debitNoteType = officialCode(input.debitType, nfeDebitNoteTypeLabels);
  const inconsistencies: Array<"B25.1-10" | "B25.1-20" | "B25.2-10" | "B25.2-20"> = [];
  if (debitNoteType && code !== "6") inconsistencies.push("B25.1-10");
  if (code === "6" && !debitNoteType) inconsistencies.push("B25.1-20");
  if (creditNoteType && code !== "5") inconsistencies.push("B25.2-10");
  if (code === "5" && !creditNoteType) inconsistencies.push("B25.2-20");
  return {
    code,
    label: label(nfePurposeLabels, code),
    creditNoteType,
    debitNoteType,
    inconsistencies,
  };
}
/** `vNF` is `total`; `vNFTot` is read from the declared totals and never computed. */
function declaredTotals(total: string, totals: ReturnType<typeof taxes>) {
  const found = totals.filter((field) => field.path === "vNFTot");
  if (found.length > 1 || found.some((field) => field.representation !== "decimal"))
    throw new Error("DOCUMENT_INVALID");
  return { vNF: total, vNFTot: found[0]?.value ?? null };
}
export function projectNfeItem(value: unknown) {
  const input = object(value);
  return {
    item: text(input.item, 8),
    code: text(input.code),
    description: text(input.description),
    ncm: text(input.ncm, 8),
    cfop: text(input.cfop, 4),
    cest: nullable(input.cest),
    purchaseOrder: nullable(input.purchaseOrder),
    purchaseOrderItem: nullable(input.purchaseOrderItem),
    unit: text(input.unit),
    quantity: exact(input.quantity),
    unitPrice: exact(input.unitPrice),
    total: exact(input.total),
    tributaryUnit: text(input.tributaryUnit),
    tributaryQuantity: exact(input.tributaryQuantity),
    tributaryUnitPrice: exact(input.tributaryUnitPrice),
    nt2026008: nt2026008(input.nt2026008, ["vUnComLiq", "vProdLiq", "vICMSPrevisto"]),
    taxes: taxes(input.taxes),
  };
}
/** Explicit allowlist: never spread a stored result into a public response. */
export function projectNfePayload(value: unknown) {
  const input = object(value),
    key = text(input.key, 44);
  if (!/^[0-9A-Z]{44}$/.test(key) || key.slice(20, 22) !== "55")
    throw new Error("DOCUMENT_MODEL_INVALID");
  const kind = choice(input.kind, ["invoice", "summary", "event", "event-summary"]);
  if (kind === "invoice") {
    const p = input.protocol === null ? null : object(input.protocol);
    const total = exact(input.total),
      totals = taxes(input.totals);
    return {
      kind,
      key,
      environment: choice(input.environment, ["1", "2"]),
      number: text(input.number),
      series: text(input.series),
      issuedAt: text(input.issuedAt),
      operation: text(input.operation),
      purpose: purpose(input.purpose),
      issuer: party(input.issuer),
      recipient: input.recipient === null ? null : party(input.recipient),
      total,
      declaredTotals: declaredTotals(total, totals),
      totals,
      nt2026008: nt2026008(input.nt2026008, ["vProdLiqTot"]),
      nt2026006: nt2026006(input.nt2026006),
      protocol:
        p === null
          ? null
          : {
              key: text(p.key, 44),
              environment: choice(p.environment, ["1", "2"]),
              status: text(p.status),
              number: nullable(p.number),
              receivedAt: nullable(p.receivedAt),
            },
    };
  }
  if (kind === "summary")
    return {
      kind,
      key,
      issuer: party(input.issuer),
      issuedAt: text(input.issuedAt),
      total: exact(input.total),
      status: text(input.status),
      protocolNumber: text(input.protocolNumber),
      receivedAt: text(input.receivedAt),
    };
  const common = {
    key,
    author: party(input.author),
    type: text(input.type, 6),
    sequence: text(input.sequence, 8),
    occurredAt: text(input.occurredAt),
    description: text(input.description),
  };
  if (kind === "event-summary")
    return {
      kind,
      ...common,
      protocolNumber: text(input.protocolNumber),
      registeredAt: text(input.registeredAt),
    };
  const c = input.cancellation === null ? null : object(input.cancellation);
  const correction = input.correction === null ? null : object(input.correction);
  const manifestation = input.manifestation === null ? null : object(input.manifestation);
  const receipt = input.receipt === null ? null : object(input.receipt);
  return {
    kind,
    ...common,
    environment: choice(input.environment, ["1", "2"]),
    cancellation:
      c === null ? null : { protocolNumber: text(c.protocolNumber), reason: text(c.reason) },
    correction:
      correction === null
        ? null
        : { text: text(correction.text), conditions: text(correction.conditions) },
    manifestation: manifestation === null ? null : { reason: nullable(manifestation.reason) },
    receipt:
      receipt === null
        ? null
        : {
            key: text(receipt.key, 44),
            environment: choice(receipt.environment, ["1", "2"]),
            type: text(receipt.type),
            sequence: text(receipt.sequence),
            status: text(receipt.status),
            number: nullable(receipt.number),
            registeredAt: nullable(receipt.registeredAt),
          },
  };
}
export function projectDocumentPayload(value: unknown) {
  if (object(value).kind === "service-invoice") return nfsePayload.parse(value);
  return projectNfePayload(value);
}
export type PublicNfePayload = z.infer<typeof nfePayload>;
export type PublicNfeItem = z.infer<typeof nfeItem>;
