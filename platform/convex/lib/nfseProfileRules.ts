/**
 * Pure rules of the NFS-e issuing profile, without database access, shared by the server
 * normalization and by the console form (which only uses them as feedback). The issuance
 * request reuses the municipality, e-mail and control-character rules.
 */

// IBGE prefix of each state; the first two digits of a municipality code.
const IBGE_STATES: Record<string, string> = {
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

export function municipalityState(code: string) {
  return IBGE_STATES[code.slice(0, 2)];
}
/** IBGE municipality code: 7 digits under a known state prefix. */
export const validMunicipalityCode = (code: string) =>
  /^\d{7}$/.test(code) && municipalityState(code) !== undefined;
/** Punctuation people copy from registrations and tables; only the digits matter. */
export const stripPunctuation = (value: string) => value.trim().replace(/[\s./-]/g, "");
/**
 * CPF or CNPJ as a person or Stripe writes it, in the form the issuance accepts: no mask and the
 * letters of the alphanumeric CNPJ in upper case. Only normalizes; the issuance validates.
 */
export const takerDocumentOf = (document: string) => stripPunctuation(document).toUpperCase();
/** C0 controls and DEL: XML 1.0 refuses most of them and they have no place in a fiscal text. */
export function hasControl(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
/** Profile and issuance request: printable, at most 80 characters (`prest/email`, `toma/email`). */
export function validEmail(value: string) {
  return (
    value.length <= 80 &&
    !hasControl(value) &&
    /^[^\s@<>&"']+@[^\s@<>&"']+\.[^\s@<>&"']+$/.test(value)
  );
}
/** LC 116 item as `01.05`; `1.05` and `0105` are the same item. `null` outside 01.01 to 40.99. */
export function lc116Item(value: string) {
  const item = /^(\d{1,2})\.?(\d{2})$/.exec(value.trim());
  const group = Number(item?.[1]),
    subitem = Number(item?.[2]);
  if (!item || group < 1 || group > 40 || subitem < 1) return null;
  return `${String(group).padStart(2, "0")}.${item[2]}`;
}
/** The national code is the LC 116 item and subitem followed by the national breakdown. */
export const cTribNacMatchesItem = (cTribNac: string, item: string) =>
  cTribNac.slice(0, 4) === item.replace(".", "");
/** Integration series of the Campinas webservice (L0022). */
export const campinasSeries = (series: string) =>
  /^\d{5}$/.test(series) && series >= "10001" && series <= "49999";
