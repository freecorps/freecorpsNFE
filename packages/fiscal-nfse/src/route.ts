/**
 * Roteamento de emissão: decide, por município, regime, subitem da LC 116 e
 * data, se a NFS-e vai pelo adaptador nacional (e para qual alvo) ou se cai
 * num emissor ainda não suportado. Função pura sobre uma tabela de regras:
 * mudar a regra é mudar dados, com vigência e fonte.
 *
 * A rota não verifica adesão do município ao convênio nacional nem
 * credenciamento do prestador; isso é estado externo, conferido fora daqui.
 */
import { isCalendarDate } from "./dates.js";
import { fail } from "./errors.js";
import type { NfseTargetId } from "./targets.js";

/** MEI é optante do Simples Nacional (SIMEI) e segue as regras do Simples. */
export type TaxRegime = "simples-nacional" | "nao-optante";

/** Emissores que a plataforma não opera. */
export type UnsupportedEmitter = "abrasf";

export interface RouteInput {
  municipioIbge: string; // IBGE 7 dígitos do município do prestador
  regime: TaxRegime;
  subitem: string; // subitem da lista da LC 116, ex. "1.05" ou "16.01"
  date: string; // AAAA-MM-DD, data civil da emissão em Brasília
}

export type RouteResult =
  | {
      kind: "nacional";
      provider: "nacional";
      target: NfseTargetId;
      /** Emissores também aceitos no período, à escolha do prestador. */
      alternatives: readonly UnsupportedEmitter[];
      ruleId: string;
      source: string;
    }
  | {
      kind: "unsupported";
      code: "ROUTE_ABRASF" | "ROUTE_NO_RULE";
      emitter: UnsupportedEmitter | null;
      message: string;
      ruleId: string | null;
      source: string | null;
    };

export interface RouteRule {
  id: string;
  /** IBGE de 7 dígitos ou "*" para qualquer município. */
  municipioIbge: string;
  regimes?: readonly TaxRegime[];
  /** Casa somente estes subitens. */
  subitens?: readonly string[];
  /** Casa todos os subitens, exceto estes. */
  exceptSubitens?: readonly string[];
  /** Vigência inclusiva, AAAA-MM-DD; null = sem limite. */
  validFrom: string | null;
  validUntil: string | null;
  source: string;
  result:
    | { kind: "nacional"; target: NfseTargetId; alternatives?: readonly UnsupportedEmitter[] }
    | { kind: "unsupported"; emitter: UnsupportedEmitter; reason: string };
}

const CAMPINAS = "3509502";
const CAMPINAS_SUBITENS = ["1.03", "1.05", "1.09", "16.01"] as const;
const GUIA = "guia da Prefeitura de Campinas de 18/09/2026";

/**
 * Regras em ordem de precedência: a primeira que casa decide. Campinas segue
 * a ADR 0004 (docs/adr/0004-motor-de-emissao-nfse.md). Onde a ADR deixa
 * o emissor à escolha (C3, C5), o padrão é campinas-adn e a alternativa
 * ABRASF fica registrada em `alternatives`.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  {
    id: "campinas-c1-abrasf",
    municipioIbge: CAMPINAS,
    validFrom: null,
    validUntil: "2026-09-20",
    source: `ADR 0004, regra C1; ${GUIA}`,
    result: {
      kind: "unsupported",
      emitter: "abrasf",
      reason:
        "Em Campinas, emissões até 20/09/2026 usam o emissor municipal ABRASF, que esta plataforma não suporta.",
    },
  },
  // O ADR não abre o ADN de Campinas ao Simples antes de 01/10 (C5); neste
  // intervalo o único emissor do Simples é o municipal.
  {
    id: "campinas-simples-setembro",
    municipioIbge: CAMPINAS,
    regimes: ["simples-nacional"],
    validFrom: "2026-09-21",
    validUntil: "2026-09-30",
    source: `ADR 0004, intervalo anterior à regra C5; ${GUIA}`,
    result: {
      kind: "unsupported",
      emitter: "abrasf",
      reason:
        "Em Campinas, prestadores do Simples Nacional emitem pelo emissor municipal ABRASF até 30/09/2026, que esta plataforma não suporta.",
    },
  },
  {
    id: "campinas-c5-simples",
    municipioIbge: CAMPINAS,
    regimes: ["simples-nacional"],
    validFrom: "2026-10-01",
    validUntil: "2026-10-31",
    source: `ADR 0004, regra C5 (ABRASF ou ADN de Campinas, à escolha); ${GUIA}`,
    result: { kind: "nacional", target: "campinas-adn", alternatives: ["abrasf"] },
  },
  {
    id: "campinas-c6-simples",
    municipioIbge: CAMPINAS,
    regimes: ["simples-nacional"],
    validFrom: "2026-11-01",
    validUntil: null,
    source: "ADR 0004, regra C6; Resolução CGSN 191/2026",
    result: { kind: "nacional", target: "sefin-nacional" },
  },
  // O ADR registra o ADN de Campinas também disponível ao não optante entre
  // 21/09 e 30/09, para qualquer subitem.
  {
    id: "campinas-nao-optante-setembro",
    municipioIbge: CAMPINAS,
    regimes: ["nao-optante"],
    validFrom: "2026-09-21",
    validUntil: "2026-09-30",
    source: `ADR 0004, produção do ADN de Campinas desde 21/09/2026; ${GUIA}`,
    result: { kind: "nacional", target: "campinas-adn", alternatives: ["abrasf"] },
  },
  {
    id: "campinas-c2-nao-optante",
    municipioIbge: CAMPINAS,
    regimes: ["nao-optante"],
    exceptSubitens: CAMPINAS_SUBITENS,
    validFrom: "2026-10-01",
    validUntil: null,
    source: `ADR 0004, regra C2; ${GUIA}`,
    result: { kind: "nacional", target: "campinas-adn" },
  },
  {
    id: "campinas-c3-subitens",
    municipioIbge: CAMPINAS,
    regimes: ["nao-optante"],
    subitens: CAMPINAS_SUBITENS,
    validFrom: "2026-10-01",
    validUntil: "2026-11-30",
    source: `ADR 0004, regra C3 (ABRASF ou ADN de Campinas, à escolha); ${GUIA}`,
    result: { kind: "nacional", target: "campinas-adn", alternatives: ["abrasf"] },
  },
  {
    id: "campinas-c4-subitens",
    municipioIbge: CAMPINAS,
    regimes: ["nao-optante"],
    subitens: CAMPINAS_SUBITENS,
    validFrom: "2026-12-01",
    validUntil: null,
    source: `ADR 0004, regra C4; ${GUIA}`,
    result: { kind: "nacional", target: "campinas-adn" },
  },
  {
    id: "nacional-padrao",
    municipioIbge: "*",
    validFrom: null,
    validUntil: null,
    source: "Padrão nacional da NFS-e (Sefin Nacional); ADR 0004",
    result: { kind: "nacional", target: "sefin-nacional" },
  },
];

/** Normaliza "01.05" para "1.05"; recusa formatos fora da lista da LC 116. */
export function normalizeSubitem(subitem: string): string {
  const match = /^(\d{1,2})\.(\d{2})$/.exec(subitem.trim());
  if (!match || Number(match[1]) < 1)
    return fail("ROUTE_INPUT_INVALID", `Subitem da LC 116 inválido: ${subitem}`);
  return `${Number(match[1])}.${match[2]}`;
}

/** Subitem a partir do código de tributação nacional: "010501" → "1.05". */
export function subitemFromCTribNac(cTribNac: string): string {
  if (!/^\d{6}$/.test(cTribNac)) return fail("ROUTE_INPUT_INVALID", "cTribNac deve ter 6 dígitos.");
  return normalizeSubitem(`${cTribNac.slice(0, 2)}.${cTribNac.slice(2, 4)}`);
}

function matches(rule: RouteRule, input: RouteInput, subitem: string): boolean {
  return (
    (rule.municipioIbge === "*" || rule.municipioIbge === input.municipioIbge) &&
    (!rule.regimes || rule.regimes.includes(input.regime)) &&
    (!rule.subitens || rule.subitens.map(normalizeSubitem).includes(subitem)) &&
    (!rule.exceptSubitens || !rule.exceptSubitens.map(normalizeSubitem).includes(subitem)) &&
    (rule.validFrom === null || input.date >= rule.validFrom) &&
    (rule.validUntil === null || input.date <= rule.validUntil)
  );
}

export function resolveRoute(
  input: RouteInput,
  rules: readonly RouteRule[] = ROUTE_RULES,
): RouteResult {
  if (!/^\d{7}$/.test(input.municipioIbge))
    fail("ROUTE_INPUT_INVALID", "municipioIbge deve ter 7 dígitos.");
  if (!isCalendarDate(input.date)) fail("ROUTE_INPUT_INVALID", "date deve ser AAAA-MM-DD válida.");
  if (input.regime !== "simples-nacional" && input.regime !== "nao-optante")
    fail("ROUTE_INPUT_INVALID", "regime deve ser simples-nacional ou nao-optante.");
  const subitem = normalizeSubitem(input.subitem);
  const rule = rules.find((candidate) => matches(candidate, input, subitem));
  if (!rule)
    return {
      kind: "unsupported",
      code: "ROUTE_NO_RULE",
      emitter: null,
      message: `Nenhuma regra de emissão vigente para o município ${input.municipioIbge} em ${input.date}.`,
      ruleId: null,
      source: null,
    };
  if (rule.result.kind === "unsupported")
    return {
      kind: "unsupported",
      code: "ROUTE_ABRASF",
      emitter: rule.result.emitter,
      message: rule.result.reason,
      ruleId: rule.id,
      source: rule.source,
    };
  return {
    kind: "nacional",
    provider: "nacional",
    target: rule.result.target,
    alternatives: rule.result.alternatives ?? [],
    ruleId: rule.id,
    source: rule.source,
  };
}
