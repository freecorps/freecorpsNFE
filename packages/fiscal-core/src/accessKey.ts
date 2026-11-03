import { normalizeCnpj } from "./cnpj.js";
import { validCpf } from "./cpf.js";

/** NT Conjunta DFe 2025.001: ASCII minus 48, modulo 11, weights 2..9 from the right. */
export function accessKeyDigit(base: string): string {
  if (!/^[0-9]{6}[A-Z0-9]{12}[0-9]{25}$/.test(base)) throw new Error("NFE_KEY_INVALID");
  let total = 0;
  for (let i = 42, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
    total += (base.charCodeAt(i) - 48) * weight;
  const remainder = total % 11;
  return String(remainder < 2 ? 0 : 11 - remainder);
}
/**
 * Series (positions 23 to 25) and number (26 to 34) of a model 55 access key, without the zeros
 * the key pads them with. The XSD (TSerie, TNF) forbids those zeros in ide, so the number matches
 * the full XML's nNF. Null when the key is not a valid model 55 key.
 */
export function accessKeyNumber(key: string): { series: string; number: string } | null {
  if (
    !/^[0-9]{6}[A-Z0-9]{12}[0-9]{2}55[0-9]{22}$/.test(key) ||
    key[43] !== accessKeyDigit(key.slice(0, 43)) ||
    key.slice(25, 34) === "000000000"
  )
    return null;
  const unpadded = (digits: string) => digits.replace(/^0+(?=.)/, "");
  return { series: unpadded(key.slice(22, 25)), number: unpadded(key.slice(25, 34)) };
}

/** TCodUfIBGE in the pinned PL 010g: the state code of positions 1 and 2, with its abbreviation. */
export const accessKeyStates: Readonly<Record<string, string>> = {
  "11": "RO",
  "12": "AC",
  "13": "AM",
  "14": "RR",
  "15": "PA",
  "16": "AP",
  "17": "TO",
  "21": "MA",
  "22": "PI",
  "23": "CE",
  "24": "RN",
  "25": "PB",
  "26": "PE",
  "27": "AL",
  "28": "SE",
  "29": "BA",
  "31": "MG",
  "32": "ES",
  "33": "RJ",
  "35": "SP",
  "41": "PR",
  "42": "SC",
  "43": "RS",
  "50": "MS",
  "51": "MT",
  "52": "GO",
  "53": "DF",
};

/**
 * Why a text is not a model 55 access key, in the order the checks run: shape, check digit,
 * model, the fields the key carries, and the issuer's CNPJ or CPF.
 */
export type AccessKeyReason =
  | "length"
  | "characters"
  | "check_digit"
  | "model"
  | "state"
  | "month"
  | "number"
  | "emission"
  | "issuer";
/** The fiscal check code of each reason, as `validateIdentity` of fiscal-nfe reports it. */
const reasonCodes: Record<AccessKeyReason, string> = {
  length: "NFE_KEY_INVALID",
  characters: "NFE_KEY_INVALID",
  check_digit: "NFE_KEY_INVALID",
  model: "NFE_MODEL_MISMATCH",
  state: "NFE_KEY_COMPONENT_INVALID",
  month: "NFE_KEY_COMPONENT_INVALID",
  number: "NFE_KEY_COMPONENT_INVALID",
  emission: "NFE_KEY_COMPONENT_INVALID",
  issuer: "NFE_KEY_CNPJ_INVALID",
};
/**
 * The issuer in positions 7 to 20: a CNPJ (14 positions), a CPF (the last 11, after "000") or,
 * when the 14 positions pass both checks, `CNPJ_OR_CPF` with all 14 as in the key.
 */
export type AccessKeyIssuer =
  | { kind: "CNPJ"; document: string }
  | { kind: "CPF"; document: string }
  | { kind: "CNPJ_OR_CPF"; document: string };
/** The fields of a valid key. Series and number without padding zeros; `issuer` as in the key. */
export interface AccessKeyParts {
  stateCode: string;
  state: string;
  /** Year and month of issue, AAMM. */
  yearMonth: string;
  issuer: AccessKeyIssuer;
  model: "55";
  series: string;
  number: string;
  /** tpEmis: 1 normal, 2 to 7 and 9 contingencies. */
  emission: string;
  code: string;
  digit: string;
}
export type AccessKeyResult =
  | { ok: true; key: string; parts: AccessKeyParts }
  | { ok: false; reason: AccessKeyReason; code: string };

/**
 * The rules an NF-e access key carries by itself (MOC 4.01 and NT 2025.001): 44 positions, the
 * issuer's CNPJ (alphanumeric in its first 12 positions) or CPF, check digit, model 55, state code,
 * month 01 to 12, number other than zero, tpEmis and a valid CNPJ or CPF. A key that passes is
 * well formed; it does not prove the NF-e exists or was authorized. Takes the key as is: strip
 * spaces and separators and uppercase before calling.
 */
export function validateAccessKey(key: string): AccessKeyResult {
  const fail = (reason: AccessKeyReason): AccessKeyResult => ({
    ok: false,
    reason,
    code: reasonCodes[reason],
  });
  if (key.length !== 44) return fail("length");
  if (!/^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/.test(key)) return fail("characters");
  if (key[43] !== accessKeyDigit(key.slice(0, 43))) return fail("check_digit");
  if (key.slice(20, 22) !== "55") return fail("model");
  const state = accessKeyStates[key.slice(0, 2)];
  if (!state) return fail("state");
  if (!/^(0[1-9]|1[0-2])$/.test(key.slice(4, 6))) return fail("month");
  if (key.slice(25, 34) === "000000000") return fail("number");
  if (!/^[1-79]$/.test(key[34]!)) return fail("emission");
  const document = key.slice(6, 20);
  const cnpj = normalizeCnpj(document) !== null;
  const cpf = document.startsWith("000") && validCpf(document.slice(3));
  // The key does not say which one it carries: a CPF starting with 00, after the three zeros, is
  // often also a valid CNPJ. Both valid is reported as such, with the 14 positions as they are.
  const issuer: AccessKeyIssuer | null =
    cnpj && cpf
      ? { kind: "CNPJ_OR_CPF", document }
      : cnpj
        ? { kind: "CNPJ", document }
        : cpf
          ? { kind: "CPF", document: document.slice(3) }
          : null;
  if (!issuer) return fail("issuer");
  const unpadded = (digits: string) => digits.replace(/^0+(?=.)/, "");
  return {
    ok: true,
    key,
    parts: {
      stateCode: key.slice(0, 2),
      state,
      yearMonth: key.slice(2, 6),
      issuer,
      model: "55",
      series: unpadded(key.slice(22, 25)),
      number: unpadded(key.slice(25, 34)),
      emission: key[34]!,
      code: key.slice(35, 43),
      digit: key[43]!,
    },
  };
}
