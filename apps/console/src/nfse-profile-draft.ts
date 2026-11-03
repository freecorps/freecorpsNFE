import { ConvexError } from "convex/values";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../platform/convex/_generated/api";
import {
  cTribNacMatchesItem,
  campinasSeries,
  stripPunctuation as digits,
  lc116Item,
  municipalityState,
  validEmail,
  validMunicipalityCode,
} from "../../../platform/convex/lib/nfseProfileRules";
// The module `@freecorps/fiscal-nfse/pure` re-exports, by file like `route` in issuance-draft:
// the console does not depend on the package, and `src/pure.ts` would also bundle the DPS builder.
import { IBSCBS_RULES } from "../../../packages/fiscal-nfse/src/ibsCbs";
import type { TaxRegime } from "../../../packages/fiscal-nfse/src/route";
import type { FieldErrors } from "./field";

// Draft of the NFS-e issuance profile: labels, conversion from and to the saved profile, the
// client-side validation and the mapping of server rejections to fields. No React here.

type Profile = NonNullable<FunctionReturnType<typeof api.nfseProfiles.get>>;
type SaveArgs = FunctionArgs<typeof api.nfseProfiles.save>;
export type Activity = {
  code: string;
  label: string;
  cnae: string;
  lc116Item: string;
  cTribNac: string;
  nbs: string;
  cTribMun: string;
  ibsCIndOp: string;
  ibsCst: string;
  ibsCClassTrib: string;
  description: string;
};
export type Draft = {
  municipalRegistration: string;
  issuerEmail: string;
  municipalityCode: string;
  opSimpNac: SaveArgs["opSimpNac"];
  regApTribSN: NonNullable<SaveArgs["regApTribSN"]>;
  regEspTrib: SaveArgs["regEspTrib"];
  dpsSeries: string;
  campinasDpsSeries: string;
  activities: Activity[];
};
export const MAX_ACTIVITIES = 50;

export const simplesLabels: Record<SaveArgs["opSimpNac"], string> = {
  1: "Não optante",
  2: "Optante MEI",
  3: "Optante ME/EPP",
};
export const apuracaoLabels: Record<NonNullable<SaveArgs["regApTribSN"]>, string> = {
  1: "Tributos federais e municipal pelo Simples Nacional",
  2: "Tributos federais pelo Simples Nacional e ISSQN fora dele",
  3: "Tributos federais e municipal fora do Simples Nacional",
};
export const regimeLabels: Record<SaveArgs["regEspTrib"], string> = {
  0: "Nenhum",
  1: "Ato cooperado (cooperativa)",
  2: "Estimativa",
  3: "Microempresa municipal",
  4: "Notário ou registrador",
  5: "Profissional autônomo",
  6: "Sociedade de profissionais",
};
export const profileMessages: Record<string, string> = {
  INVALID_MUNICIPAL_REGISTRATION:
    "A inscrição municipal aceita até 15 letras ou números. Pontos e traços são removidos.",
  INVALID_MUNICIPALITY_CODE: "Informe o código IBGE do município com sete dígitos.",
  MUNICIPALITY_STATE_MISMATCH:
    "O código IBGE precisa ser de um município da UF cadastrada no endereço da empresa.",
  INVALID_SIMPLES:
    "O regime de apuração do Simples Nacional só vale para optantes ME/EPP e é obrigatório para eles.",
  INVALID_DPS_SERIES: "A série da DPS tem de um a cinco dígitos e não pode ser zero.",
  INVALID_ISSUER_EMAIL: "Informe um e-mail válido do prestador, com até 80 caracteres.",
  INVALID_CAMPINAS_DPS_SERIES:
    "A série de Campinas precisa estar entre 10001 e 49999, a faixa de integração da Prefeitura.",
  INVALID_CTRIBMUN: "O código de tributação municipal tem três dígitos, como 001.",
  INVALID_IBSCBS:
    "A classificação IBS/CBS exige os três campos: indicador da operação (6 dígitos), CST (3 dígitos) e classificação tributária (6 dígitos).",
  ACTIVITIES_REQUIRED: "Cadastre ao menos uma atividade.",
  TOO_MANY_ACTIVITIES: `O perfil aceita até ${MAX_ACTIVITIES} atividades.`,
  INVALID_ACTIVITY_CODE:
    "O código interno tem até 40 letras, números, ponto, hífen ou sublinhado, sem espaços.",
  INVALID_ACTIVITY_LABEL: "Informe um rótulo de até 80 caracteres.",
  INVALID_CNAE: "O CNAE tem sete dígitos, como 6202-3/00.",
  INVALID_LC116_ITEM: "Informe o item da LC 116 no formato 01.05.",
  INVALID_CTRIBNAC: "O código de tributação nacional tem seis dígitos, como 01.05.01.",
  ACTIVITY_CODES_MISMATCH:
    "O código de tributação nacional precisa começar pelo item da LC 116 informado.",
  INVALID_NBS: "O código NBS tem nove dígitos, como 1.1103.22.00.",
  INVALID_ACTIVITY_DESCRIPTION: "A descrição padrão aceita até 1000 caracteres.",
  DUPLICATE_ACTIVITY:
    "Atividade repetida: o código interno ou a mesma classificação fiscal já aparece na lista.",
  NFSE_PROFILE_CHANGED:
    "O perfil mudou em outra sessão. Confira os dados atualizados antes de salvar novamente.",
  DEMONSTRATION_READ_ONLY: "Os dados de demonstração não podem ser alterados.",
  ACCESS_DENIED: "Seu acesso mudou ou esta ação não está disponível para seu papel.",
  UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
};
export function profileError(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? String(data.code) : "";
  const index =
    data && typeof data === "object" && "activity" in data && typeof data.activity === "number"
      ? data.activity
      : null;
  const message =
    profileMessages[code] ?? "Não foi possível salvar. Confira sua conexão e tente novamente.";
  return index === null ? message : `Atividade ${index + 1}: ${message}`;
}
export const emptyActivity: Activity = {
  code: "",
  label: "",
  cnae: "",
  lc116Item: "",
  cTribNac: "",
  nbs: "",
  cTribMun: "",
  ibsCIndOp: "",
  ibsCst: "",
  ibsCClassTrib: "",
  description: "",
};
export function draftOf(profile: Profile | null): Draft {
  return {
    municipalRegistration: profile?.municipalRegistration ?? "",
    issuerEmail: profile?.issuerEmail ?? "",
    municipalityCode: profile?.municipalityCode ?? "",
    opSimpNac: profile?.opSimpNac ?? 1,
    regApTribSN: profile?.regApTribSN ?? 1,
    regEspTrib: profile?.regEspTrib ?? 0,
    dpsSeries: profile?.dpsSeries ?? "",
    campinasDpsSeries: profile?.campinasDpsSeries ?? "",
    activities: profile?.activities.map(({ ibsCbs, ...a }) => ({
      ...a,
      nbs: a.nbs ?? "",
      cTribMun: a.cTribMun ?? "",
      ibsCIndOp: ibsCbs?.cIndOp ?? "",
      ibsCst: ibsCbs?.cst ?? "",
      ibsCClassTrib: ibsCbs?.cClassTrib ?? "",
      description: a.description ?? "",
    })) ?? [{ ...emptyActivity }],
  };
}
export function argsOf(draft: Draft) {
  return {
    ...(draft.municipalRegistration.trim()
      ? { municipalRegistration: draft.municipalRegistration }
      : {}),
    ...(draft.issuerEmail.trim() ? { issuerEmail: draft.issuerEmail } : {}),
    municipalityCode: draft.municipalityCode,
    opSimpNac: draft.opSimpNac,
    ...(draft.opSimpNac === 3 ? { regApTribSN: draft.regApTribSN } : {}),
    regEspTrib: draft.regEspTrib,
    dpsSeries: draft.dpsSeries,
    ...(draft.campinasDpsSeries.trim() ? { campinasDpsSeries: draft.campinasDpsSeries } : {}),
    activities: draft.activities.map(
      ({ nbs, cTribMun, ibsCIndOp, ibsCst, ibsCClassTrib, description, ...activity }) => ({
        ...activity,
        ...(nbs.trim() ? { nbs } : {}),
        ...(cTribMun.trim() ? { cTribMun } : {}),
        // Any of the three fields sends the group, so the server names an incomplete one.
        ...(ibsCIndOp.trim() || ibsCst.trim() || ibsCClassTrib.trim()
          ? { ibsCbs: { cIndOp: ibsCIndOp, cst: ibsCst, cClassTrib: ibsCClassTrib } }
          : {}),
        ...(description.trim() ? { description } : {}),
      }),
    ),
  };
}

export const activityFields: Array<{
  key: Exclude<keyof Activity, "description">;
  label: string;
  help?: string;
  max: number;
  numeric?: boolean;
  optional?: boolean;
}> = [
  {
    key: "code",
    label: "Código interno",
    help: "Identifica a atividade nos pedidos de emissão.",
    max: 40,
  },
  { key: "label", label: "Rótulo", max: 80 },
  { key: "cnae", label: "CNAE", help: "Sete dígitos, como 6202-3/00.", max: 10, numeric: true },
  {
    key: "lc116Item",
    label: "Item da LC 116",
    help: "Formato 01.05.",
    max: 5,
    numeric: true,
  },
  {
    key: "cTribNac",
    label: "Código de tributação nacional",
    help: "Seis dígitos, começando pelo item da LC 116.",
    max: 8,
    numeric: true,
  },
  {
    key: "nbs",
    label: "Código NBS (opcional)",
    help: "Nove dígitos. Alguns municípios exigem, como Campinas.",
    max: 12,
    numeric: true,
    optional: true,
  },
  {
    key: "cTribMun",
    label: "Código de tributação municipal (opcional)",
    help: "Três dígitos que o município acrescenta ao código nacional, como 001. Campinas exige.",
    max: 3,
    numeric: true,
    optional: true,
  },
  {
    key: "ibsCIndOp",
    label: "IBS/CBS: indicador da operação (opcional)",
    help: "Seis dígitos (Anexo VII da NT 005/2025), como 100501.",
    max: 6,
    numeric: true,
    optional: true,
  },
  {
    key: "ibsCst",
    label: "IBS/CBS: CST (opcional)",
    help: "Três dígitos, como 000. Confirme com a contabilidade.",
    max: 3,
    numeric: true,
    optional: true,
  },
  {
    key: "ibsCClassTrib",
    label: "IBS/CBS: classificação tributária (opcional)",
    help: "Seis dígitos (Anexo VI da NT 005/2025), como 000001.",
    max: 6,
    numeric: true,
    optional: true,
  },
];

/**
 * "a partir da competência 10/2026". The server decides by `dCompet`, which always falls inside
 * the competence month, so a rule that starts on the 1st reads exactly as a competence; any other
 * start keeps the full date.
 */
function fromDate(since: string) {
  const [year, month, day] = since.split("-");
  return day === "01"
    ? `a partir da competência ${month}/${year}`
    : `a partir de ${day}/${month}/${year}`;
}
const listed = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items.at(-1)}` : (items[0] ?? "");

/**
 * When issuing needs the IBS/CBS classification, for the regime chosen in the form, written from
 * `IBSCBS_RULES`, the table the server applies on acceptance. The profile saves without it. The
 * export line appears only once some export of the regime would be refused
 * (`ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`).
 */
export function ibsCbsNote(opSimpNac: Draft["opSimpNac"], today: string, rules = IBSCBS_RULES) {
  const regime: TaxRegime = opSimpNac === 1 ? "nao-optante" : "simples-nacional";
  const own = rules.filter((rule) => rule.regimes.includes(regime));
  const general = own.find((rule) => !rule.subitens);
  // Subitems with a start of their own, grouped by that start, in the order of the table.
  const exceptions = new Map<string, string[]>();
  for (const rule of own)
    if (rule.subitens && rule.since !== general?.since)
      exceptions.set(rule.since, [...(exceptions.get(rule.since) ?? []), ...rule.subitens]);
  const who = regime === "nao-optante" ? "Para não optante" : "Para optante do Simples Nacional";
  const when = [
    general ? fromDate(general.since) : "",
    ...[...exceptions].map(([since, subitens]) => {
      const scope = `${subitens.length > 1 ? "nos subitens" : "no subitem"} ${listed(subitens)}`;
      return general ? `ou ${fromDate(since)} ${scope}` : `${fromDate(since)} ${scope}`;
    }),
  ]
    .filter(Boolean)
    .join(", ");
  const first = own.map((rule) => rule.since).sort()[0];
  return {
    requirement: `${who}, a emissão exige a classificação IBS/CBS ${when}. No canal de Campinas, ela é sempre exigida.`,
    export:
      first !== undefined && today >= first
        ? "Exportação que já exige a classificação ainda não é emitida."
        : null,
  };
}

export const activityId = (index: number, key: keyof Activity) => `nfse-activity-${index}-${key}`;
const profileFieldLabels: Array<[id: string, label: string]> = [
  ["nfse-municipality", "Código IBGE do município"],
  ["nfse-registration", "Inscrição municipal"],
  ["nfse-simples", "Situação no Simples Nacional"],
  ["nfse-apuracao", "Regime de apuração no Simples Nacional"],
  ["nfse-regime", "Regime especial de tributação"],
  ["nfse-series", "Série da DPS"],
  ["nfse-campinas-series", "Série da DPS em Campinas"],
  ["nfse-email", "E-mail do prestador"],
];
/** Element id → label, in form order, for the error summary. */
export function fieldOrder(draft: Draft): Array<[string, string]> {
  return [
    ...profileFieldLabels,
    ...draft.activities.flatMap((_, index) => [
      ...activityFields.map((field): [string, string] => [
        activityId(index, field.key),
        `Atividade ${index + 1}, ${field.label.replace(" (opcional)", "")}`,
      ]),
      [activityId(index, "description"), `Atividade ${index + 1}, descrição padrão`] as [
        string,
        string,
      ],
    ]),
  ];
}

/**
 * The server rules (`platform/convex/lib/nfseProfile.ts`) applied to every field at once, so
 * the form points all problems before sending. The server still decides.
 */
export function validateProfile(draft: Draft, companyState: string): FieldErrors {
  const errors: FieldErrors = {};
  const registration = digits(draft.municipalRegistration).toUpperCase();
  if (registration && !/^[0-9A-Z]{1,15}$/.test(registration))
    errors["nfse-registration"] = profileMessages.INVALID_MUNICIPAL_REGISTRATION!;
  const municipality = draft.municipalityCode.trim();
  if (!municipality) errors["nfse-municipality"] = "Informe o código IBGE do município.";
  else if (!validMunicipalityCode(municipality))
    errors["nfse-municipality"] = profileMessages.INVALID_MUNICIPALITY_CODE!;
  else if (municipalityState(municipality) !== companyState)
    errors["nfse-municipality"] =
      `O código IBGE precisa ser de um município de ${companyState}, a UF cadastrada no endereço da empresa.`;
  const email = draft.issuerEmail.trim();
  if (email && !validEmail(email)) errors["nfse-email"] = profileMessages.INVALID_ISSUER_EMAIL!;
  const series = draft.dpsSeries.trim();
  if (!series) errors["nfse-series"] = "Informe a série da DPS.";
  else if (!/^\d{1,5}$/.test(series) || !Number(series))
    errors["nfse-series"] = profileMessages.INVALID_DPS_SERIES!;
  const campinas = draft.campinasDpsSeries.trim();
  if (campinas && !campinasSeries(campinas))
    errors["nfse-campinas-series"] = profileMessages.INVALID_CAMPINAS_DPS_SERIES!;
  const codes = new Set<string>();
  draft.activities.forEach((activity, index) => {
    const set = (key: keyof Activity, message: string) => {
      errors[activityId(index, key)] ??= message;
    };
    const code = activity.code.trim();
    if (!code) set("code", "Informe o código interno da atividade.");
    else if (code.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(code))
      set("code", profileMessages.INVALID_ACTIVITY_CODE!);
    else if (codes.has(code.toUpperCase()))
      set("code", "Este código interno já aparece em outra atividade.");
    codes.add(code.toUpperCase());
    if (!activity.label.trim()) set("label", "Informe o rótulo da atividade.");
    else if (activity.label.trim().length > 80)
      set("label", profileMessages.INVALID_ACTIVITY_LABEL!);
    if (!activity.cnae.trim()) set("cnae", "Informe o CNAE da atividade.");
    else if (!/^\d{7}$/.test(digits(activity.cnae))) set("cnae", profileMessages.INVALID_CNAE!);
    const item = lc116Item(activity.lc116Item);
    if (!activity.lc116Item.trim()) set("lc116Item", "Informe o item da LC 116.");
    else if (!item) set("lc116Item", profileMessages.INVALID_LC116_ITEM!);
    const cTribNac = digits(activity.cTribNac);
    if (!cTribNac) set("cTribNac", "Informe o código de tributação nacional.");
    else if (!/^\d{6}$/.test(cTribNac)) set("cTribNac", profileMessages.INVALID_CTRIBNAC!);
    else if (item && !cTribNacMatchesItem(cTribNac, item))
      set("cTribNac", profileMessages.ACTIVITY_CODES_MISMATCH!);
    if (activity.nbs.trim() && !/^\d{9}$/.test(digits(activity.nbs)))
      set("nbs", profileMessages.INVALID_NBS!);
    if (activity.cTribMun.trim() && !/^\d{3}$/.test(digits(activity.cTribMun)))
      set("cTribMun", profileMessages.INVALID_CTRIBMUN!);
    const ibs = [activity.ibsCIndOp, activity.ibsCst, activity.ibsCClassTrib].map(digits);
    if (ibs.some(Boolean)) {
      const missing = "A classificação IBS/CBS exige os três campos.";
      if (!/^\d{6}$/.test(ibs[0]!))
        set("ibsCIndOp", ibs[0] ? "O indicador da operação tem seis dígitos." : missing);
      if (!/^\d{3}$/.test(ibs[1]!)) set("ibsCst", ibs[1] ? "O CST tem três dígitos." : missing);
      if (!/^\d{6}$/.test(ibs[2]!))
        set("ibsCClassTrib", ibs[2] ? "A classificação tributária tem seis dígitos." : missing);
    }
    if (activity.description.trim().length > 1000)
      set("description", profileMessages.INVALID_ACTIVITY_DESCRIPTION!);
  });
  return errors;
}

const profileTargets: Record<string, string> = {
  INVALID_MUNICIPAL_REGISTRATION: "nfse-registration",
  INVALID_MUNICIPALITY_CODE: "nfse-municipality",
  MUNICIPALITY_STATE_MISMATCH: "nfse-municipality",
  INVALID_DPS_SERIES: "nfse-series",
  INVALID_ISSUER_EMAIL: "nfse-email",
  INVALID_CAMPINAS_DPS_SERIES: "nfse-campinas-series",
};
const activityTargets: Record<string, keyof Activity> = {
  INVALID_ACTIVITY_CODE: "code",
  INVALID_ACTIVITY_LABEL: "label",
  INVALID_CNAE: "cnae",
  INVALID_LC116_ITEM: "lc116Item",
  INVALID_CTRIBNAC: "cTribNac",
  ACTIVITY_CODES_MISMATCH: "cTribNac",
  INVALID_NBS: "nbs",
  INVALID_CTRIBMUN: "cTribMun",
  INVALID_IBSCBS: "ibsCIndOp",
  INVALID_ACTIVITY_DESCRIPTION: "description",
  DUPLICATE_ACTIVITY: "code",
};
/** Element the server rejection points to, when it names a field or an activity. */
export function profileErrorField(error: unknown, draft: Draft): string | null {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  const code = String(data.code);
  if (code === "INVALID_SIMPLES") return draft.opSimpNac === 3 ? "nfse-apuracao" : "nfse-simples";
  if (profileTargets[code]) return profileTargets[code];
  const index = "activity" in data && typeof data.activity === "number" ? data.activity : null;
  return index !== null && activityTargets[code] ? activityId(index, activityTargets[code]) : null;
}
