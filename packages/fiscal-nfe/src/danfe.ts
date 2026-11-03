/**
 * DANFE A4 retrato da NF-e modelo 55, gerado do XML original e das evidências fiscais
 * informadas. Subpath próprio (`@freecorps/fiscal-nfe/danfe`) para que quem só lê XML não
 * carregue o pdf-lib. Leiaute, marcas e limites estão em docs/plataforma/DANFE.md.
 */
export { DANFE_GENERATOR_VERSION, renderDanfe } from "./danfe/render.js";
export { readNfeForDanfe } from "./danfe/read.js";
export { MAX_EVENTS, MAX_ORIGIN_LENGTH } from "./danfe/situation.js";
export type { DanfeData, DanfeEvidence, DanfeItem, DanfeStatus } from "./danfe/read.js";
export { code128Values } from "./danfe/code128.js";
export { formatDecimal } from "./danfe/format.js";
