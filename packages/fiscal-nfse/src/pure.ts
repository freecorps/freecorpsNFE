/**
 * Subconjunto sem dependências de Node (`node:zlib`, `xml-crypto`, `@xmldom`),
 * para quem roda fora do Node, como as mutations do Convex: roteamento,
 * obrigatoriedade do grupo IBSCBS, identificador da DPS, datas de Brasília e
 * a conversão PTAX já cotada. Montagem, assinatura e transporte continuam no
 * ponto de entrada principal.
 */
export { NfseError } from "./errors.js";
export { isCalendarDate } from "./dates.js";
export {
  BACEN_CURRENCY,
  COM_EXT_DEFAULTS,
  VER_APLIC_MAX,
  buildDpsId,
  competencia,
  dhBrasilia,
  hojeBrasilia,
} from "./dps.js";
export { PTAX_RATE_SCALE, convertToBrl, previousDay } from "./ptax.js";
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
export type { NfseEnvironment, NfseTarget, NfseTargetId } from "./targets.js";
