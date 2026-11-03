/**
 * Obrigatoriedade do grupo IBSCBS na DPS por regime, subitem da LC 116 e data
 * do fato gerador. Função pura sobre uma tabela de regras, no estilo de
 * `ROUTE_RULES`: mudar a obrigação é mudar dados, com vigência e fonte.
 *
 * Fonte: Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026, art. 1º, III (NFS-e) e
 * § 1º (Simples Nacional). O Ato conta a obrigação "em relação aos fatos
 * geradores que vierem a ocorrer a partir" de cada data; a data de referência
 * é, portanto, a do fato gerador, que a DPS declara em `dCompet`, e não a da
 * emissão. A CGNFS-e informou em 07/08/2026 que, até 31/12/2026, a ausência do
 * grupo não gera rejeição no sistema nacional, mas deixa o documento em
 * desconformidade, sujeito a sanção: a obrigação existe mesmo sem rejeição.
 *
 * Isto não decide o canal (`resolveRoute`) nem a classificação (`cIndOp`, CST,
 * `cClassTrib`), que vêm do perfil de quem emite. Um canal pode exigir o grupo
 * antes do Ato, como o validador de Campinas; isso fica com quem monta a DPS.
 */
import { isCalendarDate } from "./dates.js";
import { fail } from "./errors.js";
import { normalizeSubitem, type TaxRegime } from "./route.js";

export interface IbsCbsInput {
  regime: TaxRegime;
  subitem: string; // subitem da lista da LC 116, ex. "1.05" ou "16.01"
  date: string; // AAAA-MM-DD, data do fato gerador (dCompet da DPS)
}

export interface IbsCbsRequirement {
  /** O grupo IBSCBS é obrigatório para o fato gerador desta data. */
  required: boolean;
  ruleId: string;
  /** Início da obrigação (inclusivo, AAAA-MM-DD) para este regime e subitem. */
  since: string;
  source: string;
}

export interface IbsCbsRule {
  id: string;
  regimes: readonly TaxRegime[];
  /** Casa somente estes subitens. */
  subitens?: readonly string[];
  /** Início da obrigação, inclusivo, AAAA-MM-DD. */
  since: string;
  source: string;
}

const ATO = "Ato Conjunto RFB/CGIBS 4/2026";

/**
 * Regras em ordem de precedência: a primeira que casa decide. Todo subitem da
 * LC 116 casa alguma regra, e a última de cada regime não filtra subitem.
 *
 * Escolha conservadora: o Ato também põe em 01/12/2026 as plataformas
 * digitais e os serviços que elas intermedeiam (alínea "a"), e os
 * fornecimentos fora da lista da LC 116 (alíneas "e" a "h"). Nenhum dos dois
 * se reconhece pelo subitem; a NFS-e daqui sempre tem um subitem da lista.
 * Por isso qualquer subitem fora das alíneas "b" e "c" segue a data mais cedo,
 * a da alínea "d" (01/10/2026). Mandar o grupo antes da obrigação não é
 * rejeitado (ocorrência 0-1 no leiaute 1.01); omiti-lo depois dela é
 * desconformidade.
 */
export const IBSCBS_RULES: readonly IbsCbsRule[] = [
  {
    id: "ato4-simples",
    regimes: ["simples-nacional"],
    since: "2027-01-01",
    source: `${ATO}, art. 1º, § 1º; Anexo I da NFS-e v1.01, aba "LEIAUTE DPS_NFS-e", linha 335`,
  },
  {
    id: "ato4-iii-b",
    regimes: ["nao-optante"],
    subitens: ["1.03", "1.05", "1.09"],
    since: "2026-12-01",
    source: `${ATO}, art. 1º, III, "b"`,
  },
  {
    id: "ato4-iii-c",
    regimes: ["nao-optante"],
    subitens: ["16.01"],
    since: "2026-12-01",
    source: `${ATO}, art. 1º, III, "c"`,
  },
  {
    id: "ato4-iii-d",
    regimes: ["nao-optante"],
    since: "2026-10-01",
    source: `${ATO}, art. 1º, III, "d" (data mais cedo, também para plataformas digitais da alínea "a")`,
  },
];

function matches(rule: IbsCbsRule, input: IbsCbsInput, subitem: string): boolean {
  return (
    rule.regimes.includes(input.regime) &&
    (!rule.subitens || rule.subitens.map(normalizeSubitem).includes(subitem))
  );
}

export function ibsCbsRequirement(
  input: IbsCbsInput,
  rules: readonly IbsCbsRule[] = IBSCBS_RULES,
): IbsCbsRequirement {
  if (!isCalendarDate(input.date)) fail("IBSCBS_INPUT_INVALID", "date deve ser AAAA-MM-DD válida.");
  if (input.regime !== "simples-nacional" && input.regime !== "nao-optante")
    fail("IBSCBS_INPUT_INVALID", "regime deve ser simples-nacional ou nao-optante.");
  const subitem = normalizeSubitem(input.subitem);
  const rule = rules.find((candidate) => matches(candidate, input, subitem));
  // A tabela padrão cobre todo regime e subitem; só uma tabela injetada pode deixar lacuna.
  if (!rule)
    return fail("IBSCBS_NO_RULE", `Nenhuma regra de IBS/CBS para ${input.regime} e ${subitem}.`);
  return {
    required: input.date >= rule.since,
    ruleId: rule.id,
    since: rule.since,
    source: rule.source,
  };
}
