import { ConvexError } from "convex/values";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { normalizeCnpj } from "@freecorps/contracts";
import type { api } from "../../../platform/convex/_generated/api";
// The same pure rules the server applies on acceptance; here they are only feedback.
import { decimal, multiply, quantize } from "../../../packages/fiscal-core/src/index";
import { validCpf } from "../../../packages/fiscal-core/src/cpf";
import { isCalendarDate } from "../../../packages/fiscal-nfse/src/dates";
import {
  resolveRoute,
  subitemFromCTribNac,
  type RouteResult,
} from "../../../packages/fiscal-nfse/src/route";
import { isAmount, isCompetence, isIssRate } from "../../../platform/convex/lib/issuanceRules";
import {
  hasControl,
  stripPunctuation,
  takerDocumentOf,
  validEmail,
  validMunicipalityCode,
} from "../../../platform/convex/lib/nfseProfileRules";
import { formatMoney, todayInBrasilia } from "./format";
import { usageErrorMessage } from "./usage-messages";

// Draft of the issuance form, without React: the empty and resubmitted drafts, the validation
// that mirrors the server, the request sent and the reading of the server's refusals.

type Profile = NonNullable<FunctionReturnType<typeof api.nfseProfiles.get>>;
type Input = FunctionArgs<typeof api.issuanceConsole.request>["input"];
export type Transport = FunctionReturnType<typeof api.issuanceConsole.context>["transport"];
export const transportLabels: Record<Transport, string> = {
  simulated: "Simulador do sandbox, sem validade fiscal",
  "producao-restrita": "Produção restrita do fisco (homologação)",
  producao: "Produção",
};
/** What each transport does with the DPS, said before the request. */
export const transportNotes: Record<Transport, string> = {
  simulated:
    "Sandbox: o simulador responde no lugar do fisco. A NFS-e sai com chave sintética, sem validade fiscal, e nada é enviado à Receita ou à prefeitura.",
  "producao-restrita":
    "A DPS vai ao fisco de verdade, no ambiente de produção restrita (homologação), assinada com o certificado A1 da empresa. A nota não tem validade fiscal, mas o número da DPS e a resposta ficam registrados no fisco.",
  producao: "A DPS vai ao fisco em produção, assinada com o certificado A1 da empresa.",
};

export const targetLabels: Record<string, string> = {
  "sefin-nacional": "Sefin Nacional (ADN)",
  "campinas-adn": "Campinas (IMA, padrão nacional)",
};
export const foreignCurrencies = ["USD", "CAD", "EUR", "GBP"] as const;
export type Currency = "BRL" | (typeof foreignCurrencies)[number];

export type Draft = {
  activityCode: string;
  competence: string;
  issueDate: string;
  issuerEmail: string;
  market: "domestic" | "export";
  description: string;
  currency: Currency;
  value: string;
  issRate: string;
  issWithheld: boolean;
  national: {
    document: string;
    name: string;
    email: string;
    municipalityCode: string;
    postalCode: string;
    street: string;
    number: string;
    district: string;
  };
  foreign: {
    /** Explicit choice: the server takes `nif` or `nifAbsence`, never both. */
    nifChoice: "" | "nif" | "absent";
    nif: string;
    nifAbsence: "" | "1" | "2";
    name: string;
    email: string;
    country: string;
    city: string;
    postalCode: string;
    state: string;
    street: string;
    number: string;
    district: string;
  };
};
/** Field path of the request, as `ISSUANCE_FIELD_INVALID` reports it. */
export type FieldErrors = Partial<Record<string, string>>;

export function emptyDraft(now = Date.now()): Draft {
  const today = todayInBrasilia(now);
  return {
    activityCode: "",
    competence: today.slice(0, 7),
    issueDate: today,
    issuerEmail: "",
    market: "domestic",
    description: "",
    currency: "BRL",
    value: "",
    issRate: "",
    issWithheld: false,
    national: {
      document: "",
      name: "",
      email: "",
      municipalityCode: "",
      postalCode: "",
      street: "",
      number: "",
      district: "",
    },
    foreign: {
      nifChoice: "",
      nif: "",
      nifAbsence: "",
      name: "",
      email: "",
      country: "",
      city: "",
      postalCode: "",
      state: "",
      street: "",
      number: "",
      district: "",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Feedback that mirrors `normalizeIssuanceInput` and `buildSnapshot` on the server. The server
// still decides: every rule here is checked again there, with the profile in force.

export const clean = (value: string) => value.trim().replace(/\s+/g, " ");
/**
 * Decimal as typed in pt-BR ("1.500,25") or with a point ("1500.25") → "1500.25". Text only:
 * the value never passes through a float.
 */
export function decimalText(value: string) {
  const text = value.trim().replace(/\s/g, "");
  return text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
}
/**
 * CPF or CNPJ of the national taker as the server expects it: without punctuation and in
 * uppercase, keeping the letters of the alphanumeric CNPJ ("12.abc.345/01de-35" →
 * "12ABC34501DE35").
 */
export { takerDocumentOf };
export const takerDocumentType = (document: string) =>
  takerDocumentOf(document).length === 11 ? "CPF" : "CNPJ";
type RateProfile = Pick<Profile, "opSimpNac"> &
  Partial<Pick<Profile, "municipalityCode" | "activities">>;
/**
 * Channel the server would resolve for this draft: municipality and regime of the profile,
 * subitem of the chosen activity and issue date. Only a preview; the server resolves it again
 * on acceptance and freezes it in the snapshot. `null` while the draft cannot say.
 */
export function routeOf(draft: Draft, profile: RateProfile): RouteResult | null {
  const activity = profile.activities?.find(
    (a) => a.code.toUpperCase() === draft.activityCode.toUpperCase(),
  );
  if (!activity || !profile.municipalityCode || !isCalendarDate(draft.issueDate)) return null;
  try {
    return resolveRoute({
      municipioIbge: profile.municipalityCode,
      regime: profile.opSimpNac === 1 ? "nao-optante" : "simples-nacional",
      subitem: subitemFromCTribNac(activity.cTribNac),
      date: draft.issueDate,
    });
  } catch {
    return null;
  }
}
/**
 * Mirror of the server rule: the rate goes for a non-opting provider and any withholding, and is
 * forbidden for the Simples without withholding (E0625), on every channel, Campinas included.
 */
export const rateRequired = (draft: Draft, profile: RateProfile) =>
  draft.market === "domestic" && (profile.opSimpNac === 1 || draft.issWithheld);
export const rateAllowed = (draft: Draft, profile: RateProfile) => rateRequired(draft, profile);

export function validateDraft(
  draft: Draft,
  profile: RateProfile & Pick<Profile, "activities"> & Partial<Pick<Profile, "issuerEmail">>,
  now = Date.now(),
): FieldErrors {
  const errors: FieldErrors = {};
  const text = (field: string, value: string, max: number, required = true) => {
    const result = clean(value);
    if (required && !result) errors[field] = "Campo obrigatório.";
    else if (result.length > max) errors[field] = `Use até ${max} caracteres.`;
    else if (hasControl(result)) errors[field] = "Remova caracteres de controle.";
  };
  const email = (field: string, value: string, required: boolean) => {
    const result = value.trim();
    if (!result) {
      if (required) errors[field] = "Informe o e-mail.";
    } else if (!validEmail(result)) errors[field] = "Confira o e-mail, como nome@empresa.com.br.";
  };
  if (!profile.activities.some((a) => a.code.toUpperCase() === draft.activityCode.toUpperCase()))
    errors.activityCode = "Escolha uma atividade do perfil de emissão.";
  const today = todayInBrasilia(now);
  if (!isCalendarDate(draft.issueDate)) errors.issueDate = "Informe a data da emissão.";
  else if (draft.issueDate > today)
    errors.issueDate = "A data da emissão não pode ser futura (horário de Brasília).";
  if (!isCompetence(draft.competence))
    errors.competence = "Informe a competência no formato mês/ano.";
  else if (draft.competence > (errors.issueDate ? today : draft.issueDate).slice(0, 7))
    errors.competence = "A competência não pode ser posterior ao mês da emissão.";
  // Without an e-mail in the profile, the request must bring one.
  email("issuerEmail", draft.issuerEmail, !profile.issuerEmail);
  text("description", draft.description, 2000);
  const value = decimalText(draft.value);
  if (!isAmount(value))
    errors["amount.value"] =
      "Informe um valor maior que zero, com até duas casas decimais, como 1500,00.";
  if (draft.market === "domestic") {
    if (draft.currency !== "BRL") errors["amount.currency"] = "O mercado interno usa reais (BRL).";
    const t = draft.national;
    const document = takerDocumentOf(t.document);
    if (document.length === 11 ? !validCpf(document) : normalizeCnpj(document) !== document)
      errors["taker.document"] = "Confira o CPF ou CNPJ do tomador: os dígitos não conferem.";
    text("taker.name", t.name, 300);
    email("taker.email", t.email, false);
    if (!validMunicipalityCode(t.municipalityCode.trim()))
      errors["taker.address.municipalityCode"] = "Use o código IBGE do município, com 7 dígitos.";
    if (!/^\d{8}$/.test(stripPunctuation(t.postalCode)))
      errors["taker.address.postalCode"] = "Informe o CEP com 8 dígitos.";
    text("taker.address.street", t.street, 255);
    text("taker.address.number", t.number, 60);
    text("taker.address.district", t.district, 60);
    if (draft.issWithheld && takerDocumentType(t.document) !== "CNPJ")
      errors.issWithheld = "A retenção do ISS exige tomador com CNPJ.";
    const rate = decimalText(draft.issRate);
    if (rateRequired(draft, profile)) {
      if (!rate)
        errors.issRate =
          profile.opSimpNac === 1
            ? "Informe a alíquota do ISS: o prestador não é optante do Simples Nacional."
            : "Informe a alíquota do ISS: a retenção exige a alíquota.";
      else if (!isIssRate(rate))
        errors.issRate = "A alíquota vai de 0,01% a 5%, com até duas casas decimais.";
    }
  } else {
    if (draft.currency === "BRL")
      errors["amount.currency"] = "A exportação é faturada em moeda estrangeira.";
    const t = draft.foreign;
    if (t.nifChoice === "") errors["taker.nif"] = "Diga se o tomador tem NIF.";
    else if (t.nifChoice === "nif") text("taker.nif", t.nif, 40);
    else if (t.nifAbsence === "")
      errors["taker.nifAbsence"] = "Escolha o motivo da ausência do NIF.";
    text("taker.name", t.name, 300);
    email("taker.email", t.email, false);
    const country = t.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || country === "BR")
      errors["taker.address.country"] =
        "Use o código ISO do país com duas letras, diferente de BR, como US.";
    // The DPS XSD requires the whole address abroad (TCEnderExt and TCEndereco).
    text("taker.address.city", t.city, 60);
    text("taker.address.postalCode", t.postalCode, 11);
    text("taker.address.state", t.state, 60);
    text("taker.address.street", t.street, 255);
    text("taker.address.number", t.number, 60);
    text("taker.address.district", t.district, 60);
  }
  return errors;
}

/** Request sent to the server; fields that do not apply to the market are left out. */
export function inputOf(draft: Draft, profile: RateProfile): Input {
  const rate = decimalText(draft.issRate);
  const common = {
    activityCode: draft.activityCode,
    competence: draft.competence,
    issueDate: draft.issueDate,
    // Empty: the server uses the profile's e-mail.
    ...(draft.issuerEmail.trim() ? { issuerEmail: draft.issuerEmail.trim() } : {}),
    description: clean(draft.description),
    amount: { currency: draft.currency, value: decimalText(draft.value) },
  };
  if (draft.market === "domestic") {
    const t = draft.national;
    return {
      ...common,
      market: "domestic",
      taker: {
        kind: "national",
        document: takerDocumentOf(t.document),
        name: clean(t.name),
        ...(t.email.trim() ? { email: t.email.trim() } : {}),
        address: {
          municipalityCode: t.municipalityCode.trim(),
          postalCode: stripPunctuation(t.postalCode),
          street: clean(t.street),
          number: clean(t.number),
          district: clean(t.district),
        },
      },
      ...(rateAllowed(draft, profile) && rate ? { issRate: rate } : {}),
      issWithheld: draft.issWithheld,
    };
  }
  const t = draft.foreign;
  const address = {
    country: t.country.trim().toUpperCase(),
    city: clean(t.city),
    postalCode: clean(t.postalCode),
    state: clean(t.state),
    street: clean(t.street),
    number: clean(t.number),
    district: clean(t.district),
  };
  return {
    ...common,
    market: "export",
    taker: {
      kind: "foreign",
      ...(t.nifChoice === "nif"
        ? { nif: clean(t.nif) }
        : { nifAbsence: Number(t.nifAbsence) as 1 | 2 }),
      name: clean(t.name),
      ...(t.email.trim() ? { email: t.email.trim() } : {}),
      address,
    },
    issWithheld: false,
  };
}

export const serverMessages: Record<string, string> = {
  SCOPE_DENIED:
    "Seu papel não permite emitir. Emitir exige papel de Operador, Administrador ou Proprietário.",
  NOT_FOUND:
    "Empresa indisponível ou seu acesso a ela mudou. Peça a um proprietário ou administrador para conferir.",
  ISSUANCE_PRODUCTION_DISABLED: "A emissão em produção está desligada para esta empresa.",
  ISSUANCE_DEMONSTRATION_DENIED: "A empresa de demonstração não emite NFS-e.",
  NFSE_PROFILE_REQUIRED: "Configure o perfil de emissão NFS-e da empresa antes de emitir.",
  NFSE_ACTIVITY_NOT_FOUND: "A atividade escolhida não está mais no perfil de emissão vigente.",
  NFSE_ROUTE_UNSUPPORTED: "O município do prestador ainda não tem canal de emissão suportado.",
  NFSE_ROUTE_PROFILE_INCOMPLETE:
    "Complete o perfil de emissão NFS-e da empresa com o que esta nota exige.",
  ISSUANCE_ISSUER_EMAIL_REQUIRED:
    "Informe o e-mail do prestador ou cadastre um no perfil de emissão.",
  ISSUANCE_FIELD_INVALID: "Confira o campo indicado.",
  ISSUANCE_TAKER_DOCUMENT_INVALID: "Confira o CPF ou CNPJ do tomador: os dígitos não conferem.",
  ISSUANCE_TAKER_NIF_INVALID: "Informe o NIF do tomador ou o motivo da ausência, nunca os dois.",
  ISSUANCE_TAKER_INVALID: "O mercado interno exige tomador nacional.",
  ISSUANCE_EXPORT_TAKER_REQUIRED: "A exportação exige tomador no exterior.",
  ISSUANCE_EXPORT_CURRENCY_REQUIRED: "A exportação é faturada em moeda estrangeira.",
  ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED: "A plataforma ainda não emite esta exportação.",
  ISSUANCE_CURRENCY_INVALID: "O mercado interno usa reais (BRL).",
  ISSUANCE_CURRENCY_UNSUPPORTED: "Moeda não suportada. Use BRL, USD, CAD, EUR ou GBP.",
  ISSUANCE_AMOUNT_INVALID: "Informe um valor maior que zero, com até duas casas decimais.",
  ISSUANCE_ISS_RATE_INVALID: "A alíquota vai de 0,01% a 5%, com até duas casas decimais.",
  ISSUANCE_ISS_RATE_REQUIRED:
    "Informe a alíquota do ISS: o prestador não optante e a retenção exigem a alíquota.",
  ISSUANCE_ISS_RATE_NOT_ALLOWED:
    "Optante do Simples Nacional sem retenção não informa a alíquota do ISS.",
  ISSUANCE_ISS_NOT_LEVIED: "Na exportação de serviços não incide ISS: deixe a alíquota em branco.",
  ISSUANCE_WITHHOLDING_INVALID:
    "A retenção do ISS exige tomador com CNPJ e não se aplica à exportação.",
  ISSUANCE_COMPETENCE_INVALID: "Informe a competência no formato mês/ano.",
  ISSUANCE_COMPETENCE_FUTURE: "A competência não pode ser posterior ao mês da emissão.",
  ISSUANCE_DATE_INVALID: "Informe uma data de emissão válida.",
  ISSUANCE_DATE_FUTURE: "A data da emissão não pode ser futura (horário de Brasília).",
  CERTIFICATE_UNAVAILABLE: "A empresa não tem certificado A1 ativo e válido para este envio.",
  IDEMPOTENCY_CONFLICT:
    "Esta tentativa já foi usada para outro pedido. Revise os dados e envie novamente.",
  DPS_NUMBER_EXHAUSTED: "A série da DPS chegou ao último número possível.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um minuto e tente novamente.",
  UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
  ACCESS_DENIED: "Seu acesso mudou ou esta ação não está disponível para seu papel.",
};
/** Server rejection → message and, when the server points one, the field. */
export function issuanceError(error: unknown): { message: string; field?: string } {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  if (!data || typeof data !== "object" || !("code" in data))
    return {
      message:
        "Não foi possível confirmar o pedido. Confira sua conexão e envie de novo: a mesma tentativa não emite duas vezes.",
    };
  const code = String(data.code);
  const field = "field" in data && typeof data.field === "string" ? data.field : undefined;
  const detail = "message" in data && typeof data.message === "string" ? data.message : "";
  // Quota and plan: the console's shared text, without the role here; the form shows it by role.
  const message =
    usageErrorMessage(error) ??
    serverMessages[code] ??
    `O servidor recusou o pedido (${code}). Revise os dados e tente de novo.`;
  return { message: detail ? `${message} ${detail}` : message, ...(field ? { field } : {}) };
}

/**
 * Field path → element and label, in the order of the form. Focus goes to the first invalid one;
 * the summary next to the button names them.
 */
export function fieldTargets(draft: Draft): Array<[field: string, id: string, label: string]> {
  const common: Array<[string, string, string]> = [
    ["activityCode", "issuance-activity", "Atividade do perfil"],
    ["issueDate", "issuance-date", "Data da emissão"],
    ["competence", "issuance-competence", "Competência"],
    ["issuerEmail", "issuance-issuer-email", "E-mail do prestador"],
    ["description", "issuance-description", "Descrição do serviço"],
    ["taker", `issuance-market-${draft.market}`, "Mercado"],
  ];
  const nifId =
    draft.foreign.nifChoice === "nif"
      ? "taker-nif"
      : draft.foreign.nifChoice === "absent"
        ? "taker-nif-absence"
        : "taker-nif-yes";
  const taker: Array<[string, string, string]> =
    draft.market === "domestic"
      ? [
          ["taker.document", "taker-document", "CPF ou CNPJ do tomador"],
          ["taker.name", "taker-name", "Nome ou razão social"],
          ["taker.email", "taker-email", "E-mail do tomador"],
          ["taker.address.municipalityCode", "taker-municipality", "Código IBGE do município"],
          ["taker.address.postalCode", "taker-postal", "CEP"],
          ["taker.address.street", "taker-street", "Logradouro"],
          ["taker.address.number", "taker-number", "Número"],
          ["taker.address.district", "taker-district", "Bairro"],
        ]
      : [
          ["taker.nif", nifId, "NIF do tomador"],
          ["taker.nifAbsence", "taker-nif-absence", "Motivo da ausência do NIF"],
          ["taker.name", "taker-name", "Nome ou razão social"],
          ["taker.email", "taker-email", "E-mail do tomador"],
          ["taker.address.country", "taker-country", "País"],
          ["taker.address.city", "taker-city", "Cidade"],
          ["taker.address.postalCode", "taker-postal", "Código postal"],
          ["taker.address.state", "taker-state", "Estado, província ou região"],
          ["taker.address.street", "taker-street", "Logradouro"],
          ["taker.address.number", "taker-number", "Número"],
          ["taker.address.district", "taker-district", "Bairro"],
        ];
  return [
    ...common,
    ...taker,
    ["amount.currency", "issuance-currency", "Moeda"],
    ["amount.value", "issuance-value", "Valor do serviço"],
    ["issRate", "issuance-rate", "Alíquota do ISS"],
    ["issWithheld", "issuance-withheld", "ISS retido pelo tomador"],
  ];
}

/** "Valor na nota: USD 1.000,00", so 1000 is never read as 1,00. */
export function valuePreview(draft: Draft) {
  const value = decimalText(draft.value);
  if (!draft.value.trim()) return "Digite o valor para conferir como ele vai na nota.";
  if (!isAmount(value)) return "Valor ainda inválido: use até duas casas decimais, como 1500,00.";
  return `Valor na nota: ${formatMoney(value, draft.currency)}`;
}

/**
 * The ISS the note will carry, as the server computes it (value × rate, half-up to the cent),
 * while the person types; `null` until value and rate are both valid, or outside reais.
 */
export function issPreview(draft: Draft) {
  if (draft.market !== "domestic" || draft.currency !== "BRL") return null;
  const value = decimalText(draft.value),
    rate = decimalText(draft.issRate);
  if (!isAmount(value) || !isIssRate(rate)) return null;
  const amount = quantize(
    multiply(multiply(decimal(value), decimal(rate)), decimal("0.01")),
    2,
    "half-up",
  );
  return `ISS na nota: ${formatMoney(amount, "BRL")}${draft.issWithheld ? ", retido pelo tomador" : ""}`;
}

/** Request of a rejected issuance (`issuanceConsole.resubmission`), to correct and ask again. */
export type Resubmission = FunctionReturnType<typeof api.issuanceConsole.resubmission>;
/** "1500.00" → "1500,00", as a person types it; the value stays exact text. */
const typedDecimal = (value: string) => value.replace(".", ",");
/** "2.5000" → "2,5": trailing zeros of the frozen rate go away. */
const typedRate = (value: string) =>
  typedDecimal(value.includes(".") ? value.replace(/\.?0+$/, "") : value);
export type Taker = Resubmission["taker"];
export function takerDraft(taker: Taker): Pick<Draft, "national" | "foreign"> {
  const empty = emptyDraft();
  if (taker.kind === "national")
    return {
      foreign: empty.foreign,
      national: {
        document: taker.document,
        name: taker.name,
        email: taker.email ?? "",
        municipalityCode: taker.address.municipalityCode,
        postalCode: taker.address.postalCode,
        street: taker.address.street,
        number: taker.address.number,
        district: taker.address.district,
      },
    };
  return {
    national: empty.national,
    foreign: {
      nifChoice: taker.nif ? "nif" : taker.nifAbsence ? "absent" : "",
      nif: taker.nif ?? "",
      nifAbsence: taker.nifAbsence ? (String(taker.nifAbsence) as "1" | "2") : "",
      name: taker.name,
      email: taker.email ?? "",
      country: taker.address.country,
      city: taker.address.city,
      postalCode: taker.address.postalCode ?? "",
      state: taker.address.state ?? "",
      street: taker.address.street ?? "",
      number: taker.address.number ?? "",
      district: taker.address.district ?? "",
    },
  };
}
/**
 * The form filled with a previous request, to correct it. The issue date is today's: it is a new
 * request, with a new idempotency key and a new DPS number. The provider e-mail stays empty when
 * it is the profile's, as the person would have left it.
 */
export function draftFromRequest(
  input: Resubmission,
  profile: Partial<Pick<Profile, "issuerEmail">>,
  now = Date.now(),
): Draft {
  const currency = (
    input.amount.currency === "BRL" || foreignCurrencies.includes(input.amount.currency as never)
      ? input.amount.currency
      : "BRL"
  ) as Currency;
  return {
    ...emptyDraft(now),
    activityCode: input.activityCode,
    competence: input.competence,
    issuerEmail:
      input.issuerEmail && input.issuerEmail !== profile.issuerEmail ? input.issuerEmail : "",
    market: input.market,
    description: input.description,
    currency,
    value: typedDecimal(input.amount.value),
    issRate: input.issRate ? typedRate(input.issRate) : "",
    issWithheld: input.issWithheld,
    ...takerDraft(input.taker),
  };
}
