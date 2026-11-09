/**
 * Sources of `operationalFailures`, the one list that `recordSourceFailure` writes and the
 * `source` metric reads (#111): a failure whose source the monitor does not read would never
 * reach an alert. No imports, so the hosted monitor drill loads it under Node.
 */
export const OPERATION_SOURCES = [
  "nfe-distribution",
  "opencnpj",
  "nfse-issuance",
  "xml-processing",
  "other",
] as const;
export type OperationSource = (typeof OPERATION_SOURCES)[number];
