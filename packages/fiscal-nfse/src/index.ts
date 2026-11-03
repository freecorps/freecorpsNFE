export { NfseError } from "./errors.js";
export { buildDps } from "./build.js";
export {
  NFSE_SCHEMA_PACKAGE,
  validateDpsXml,
  validatePedRegEventoXml,
  type SchemaIssue,
  type SchemaResult,
} from "./schema.js";
export {
  BACEN_CURRENCY,
  COM_EXT_DEFAULTS,
  DPS_LAYOUTS,
  DPS_LAYOUT_DEFAULT,
  DPS_VERSAO,
  NFSE_NS,
  VER_APLIC_MAX,
  buildDpsId,
  competencia,
  dhBrasilia,
  hojeBrasilia,
  isTomaExterior,
  type BuiltXml,
  type ComExt,
  type DpsInput,
  type DpsLayout,
  type DpsToma,
  type TomaExterior,
  type TomaNacional,
} from "./dps.js";
export {
  EVENTO_CANCELAMENTO,
  PED_REG_EVENTO_VERSAO,
  buildCancelEvent,
  type CancelEventInput,
} from "./events.js";
export {
  signDps,
  signEvent,
  verifySignature,
  type SignaturePolicy,
  type SignerKeys,
} from "./signer.js";
export {
  MAX_XML_BYTES,
  gunzipB64,
  gzipB64,
  type NfseHttpRequest,
  type NfseHttpResponse,
  type NfseTransport,
} from "./transport.js";
export {
  PTAX_RATE_SCALE,
  convertToBrl,
  fetchPtaxSale,
  parsePtaxBulletins,
  previousDay,
  ptaxDateParam,
  ptaxQuoteUrl,
  ptaxSaleForIssue,
  type PtaxQuote,
} from "./ptax.js";
export {
  IBSCBS_RULES,
  ibsCbsRequirement,
  type IbsCbsInput,
  type IbsCbsRequirement,
  type IbsCbsRule,
} from "./ibsCbs.js";
export {
  ROUTE_RULES,
  normalizeSubitem,
  resolveRoute,
  subitemFromCTribNac,
  type RouteInput,
  type RouteResult,
  type RouteRule,
  type TaxRegime,
  type UnsupportedEmitter,
} from "./route.js";
export {
  CAMPINAS_HOSTS,
  SEFIN_HOSTS,
  dpsUrl,
  eventsUrl,
  nfseUrl,
  resolveEndpoint,
  submitUrl,
  type NfseEndpoint,
  type NfseEnvironment,
  type NfseTarget,
  type NfseTargetId,
} from "./targets.js";
export {
  extractRejections,
  nacional,
  type CancelInput,
  type CancelOutcome,
  type ConsultOutcome,
  type ConsultUncertainCode,
  type IssueInput,
  type IssueOutcome,
  type NfseConsultOutcome,
  type NfseContext,
  type NfseProvider,
  type NfseQueryContext,
  type Rejection,
  type ResponseDiagnostic,
  type SignedCancelEvent,
  type SignedDps,
  type TransientCode,
  type UncertainCode,
} from "./nacional.js";
