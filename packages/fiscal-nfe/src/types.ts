import type { CheckResult, ExactDecimal, ProcessingVersions } from "@freecorps/fiscal-core";
export const PARSER_VERSION = "nfe-parser/8";
export const NORMALIZER_VERSION = "nfe-normalizer/1";
/**
 * Current rule. `nfe-status/1` stays supported so earlier receipts remain reproducible; `/2` lets
 * an interpretation from a newer schema catalog replace one refused only at the XSD step (#395).
 */
export const RULE_VERSION = "nfe-status/2";
export const RULE_VERSIONS = ["nfe-status/1", "nfe-status/2"] as const;
export type FiscalRuleVersion = (typeof RULE_VERSIONS)[number];
export type Source = "imported-xml" | "distribution-xml" | "synthetic";
export interface Metadata {
  model: "55" | null;
  source: Source;
  originalSha256: string;
  versions: ProcessingVersions;
  unsupportedFields: string[];
}
export interface Party {
  kind: "CNPJ" | "CPF";
  document: string;
  name: string | null;
  stateRegistration: string | null;
}
/** Paths are the declared NF-e tax group/field names, relative to imposto or ICMSTot. */
export interface DeclaredTaxField {
  path: string;
  value: string;
  representation: "decimal" | "code" | "text";
}
/**
 * Fields of the NT 2026.008 layout, introduced in PL_010g. Values are declared decimals;
 * `null` means the XML omits the field.
 */
export interface ProductNetValues {
  vUnComLiq: string | null;
  vProdLiq: string | null;
  vICMSPrevisto: string | null;
}
export interface NfeProduct {
  item: string;
  code: string;
  description: string;
  ncm: string;
  cfop: string;
  cest: string | null;
  purchaseOrder: string | null;
  purchaseOrderItem: string | null;
  unit: string;
  quantity: string;
  unitPrice: string;
  total: string;
  tributaryUnit: string;
  tributaryQuantity: string;
  tributaryUnitPrice: string;
  nt2026008: ProductNetValues;
  taxes: DeclaredTaxField[];
}
/**
 * NF-e purpose (`ide/finNFe`) and credit/debit note types (`ide/tpNFCredito`, `ide/tpNFDebito`),
 * kept as the official codes. `null` means the XML omits the field; it is never a code.
 */
export interface Purpose {
  code: string | null;
  creditType: string | null;
  debitType: string | null;
}
/**
 * One `gPgtoVinc/gPgto` of NT 2026.006 v1.00, the link between the NF-e and a payment transaction.
 * Every value is the declared text: codes and CNPJs keep their leading zeros.
 */
export interface PaymentLink {
  nPag: string;
  idTransacao: string;
  tpMeioPgto: string;
  CNPJReceb: string;
  CNPJBasePSP: string;
}
export interface Protocol {
  key: string;
  environment: "1" | "2";
  status: string;
  number: string | null;
  receivedAt: string | null;
  digest: string | null;
}
export interface EventReceipt {
  key: string;
  environment: "1" | "2";
  type: string;
  sequence: string;
  status: string;
  number: string | null;
  registeredAt: string | null;
}
export interface Invoice {
  kind: "invoice";
  key: string;
  environment: "1" | "2";
  number: string;
  series: string;
  issuedAt: string;
  operation: string;
  purpose: Purpose;
  issuer: Party;
  recipient: Party | null;
  /** `ICMSTot/vNF` as declared. `vNFTot`, when present, stays in `totals`. */
  total: string;
  totals: DeclaredTaxField[];
  /** NT 2026.008 `total/vProdLiqTot`, also kept in `totals` as the pinned schema represents it. */
  nt2026008: { vProdLiqTot: string | null };
  /**
   * NT 2026.006 `infNFe/gPgtoVinc`: `null` when the XML omits the group; `[]` only for a group
   * declared without `gPgto`, which the XSD refuses.
   */
  nt2026006: { gPgtoVinc: PaymentLink[] | null };
  products: NfeProduct[];
  protocol: Protocol | null;
}
export interface Summary {
  kind: "summary";
  key: string;
  issuer: Party;
  issuedAt: string;
  total: string;
  status: string;
  protocolNumber: string;
  receivedAt: string;
  digest: string | null;
}
export interface NfeEvent {
  kind: "event";
  key: string;
  environment: "1" | "2";
  author: Party;
  type: string;
  sequence: string;
  occurredAt: string;
  description: string;
  cancellation: { protocolNumber: string; reason: string } | null;
  correction: { text: string; conditions: string } | null;
  manifestation: { reason: string | null } | null;
  receipt: EventReceipt | null;
}
export interface EventSummary {
  kind: "event-summary";
  key: string;
  author: Party;
  type: string;
  sequence: string;
  occurredAt: string;
  description: string;
  protocolNumber: string;
  registeredAt: string;
}
export type NfeModel = Invoice | Summary | NfeEvent | EventSummary;
export interface ParsedNfe {
  metadata: Metadata;
  document: NfeModel;
}
export interface NormalizedTaxField extends Omit<DeclaredTaxField, "value"> {
  value: string | ExactDecimal;
}
type Exact<T> = { [K in keyof T]: ExactDecimal | null };
export type NormalizedProduct = Omit<
  NfeProduct,
  | "quantity"
  | "unitPrice"
  | "total"
  | "tributaryQuantity"
  | "tributaryUnitPrice"
  | "taxes"
  | "nt2026008"
> & {
  quantity: ExactDecimal;
  unitPrice: ExactDecimal;
  total: ExactDecimal;
  tributaryQuantity: ExactDecimal;
  tributaryUnitPrice: ExactDecimal;
  nt2026008: Exact<ProductNetValues>;
  taxes: NormalizedTaxField[];
};
export type NormalizedModel =
  | (Omit<Invoice, "total" | "products" | "totals" | "nt2026008"> & {
      total: ExactDecimal;
      nt2026008: { vProdLiqTot: ExactDecimal | null };
      products: NormalizedProduct[];
      totals: NormalizedTaxField[];
    })
  | (Omit<Summary, "total"> & { total: ExactDecimal })
  | NfeEvent
  | EventSummary;
export interface NormalizedNfe {
  metadata: Metadata;
  document: NormalizedModel;
}
export interface Validation {
  parsing: CheckResult;
  xsd: CheckResult;
  identity: CheckResult;
  normalization: CheckResult;
  signature: CheckResult;
  certificateTrust: CheckResult;
  certificateTime: CheckResult;
  fiscalEvidence: CheckResult;
  originTrust: CheckResult;
}
export interface ProcessedNfe {
  metadata: Metadata | null;
  parsing: ParsedNfe | null;
  normalized: NormalizedNfe | null;
  checks: Validation;
  signature: {
    referenceId: string | null;
    referenceSha256: string | null;
    certificateSha256: string | null;
    evaluatedAt: string | null;
  };
}
