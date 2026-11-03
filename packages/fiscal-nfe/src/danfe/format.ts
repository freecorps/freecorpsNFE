import { decimal } from "@freecorps/fiscal-core";

/**
 * Formatação do DANFE sobre o texto do XML. Valores passam por `decimal` do fiscal-core, que
 * recusa o que não for decimal exato, e mantêm todas as casas declaradas: nada passa por ponto
 * flutuante e nada é arredondado.
 */
export function formatDecimal(value: string | null, minScale = 2): string {
  // Absent in an XML that failed the XSD: the field stays blank, the status already says why.
  if (value === null || value.trim() === "") return "";
  const parsed = decimal(value.trim());
  const [, sign = "", integer = "0", fraction = ""] = /^(-?)(\d+)(?:\.(\d+))?$/.exec(
    parsed.declared,
  )!;
  const grouped = integer.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = fraction.padEnd(minScale, "0");
  return `${sign}${grouped}${decimals ? `,${decimals}` : ""}`;
}

/** Alíquota com as casas do XML, ao menos duas, seguida de "%". */
export const formatPercent = (value: string | null) =>
  value === null ? "" : `${formatDecimal(value)}%`;

/** CNPJ numérico ou alfanumérico (12.ABC.345/01DE-35) e CPF; outro texto volta como veio. */
export function formatDocument(value: string | null): string {
  if (!value) return "";
  if (/^[A-Z0-9]{12}\d{2}$/.test(value))
    return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;
  if (/^\d{11}$/.test(value))
    return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`;
  return value;
}

/** Chave de acesso em 11 grupos de 4 caracteres. */
export const formatKey = (key: string) => key.replace(/(.{4})(?=.)/g, "$1 ");

/** Número da NF-e com 9 dígitos em grupos de 3 ("000.000.069"). */
export const formatNumber = (nNF: string) => nNF.padStart(9, "0").replace(/(\d{3})(?=\d)/g, "$1.");

export const formatSeries = (serie: string) => serie.padStart(3, "0");

export const formatCep = (cep: string | null) =>
  cep && /^\d{8}$/.test(cep) ? `${cep.slice(0, 5)}-${cep.slice(5)}` : (cep ?? "");

export function formatPhone(fone: string | null): string {
  if (!fone) return "";
  const match = /^(\d{2})(\d{4,5})(\d{4})$/.exec(fone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : fone;
}

/**
 * Data e hora como estão no XML, sem conversão de fuso: "2026-09-12T12:00:00-03:00" vira
 * data "12/09/2026" e hora "12:00:00". O fuso declarado não é aplicado.
 */
export function splitDateTime(value: string | null): { date: string; time: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(value ?? "");
  if (!match) return { date: value ?? "", time: "" };
  // Data fora do calendário (30/02, mês 13) não é reformatada: sai o texto do XML.
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!)
    return { date: value!, time: "" };
  return { date: `${match[3]}/${match[2]}/${match[1]}`, time: match[4] ?? "" };
}

export function formatDateTime(value: string | null): string {
  const { date, time } = splitDateTime(value);
  return time ? `${date} ${time}` : date;
}
