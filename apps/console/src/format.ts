/** Formatação pt-BR compartilhada pelo console. Valores chegam como texto decimal exato. */
export { formatCnpj } from "@freecorps/contracts";

const integerFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateTimeSeconds = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "medium",
});
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

/**
 * "1234.5" → "R$ 1.234,50". Casas além dos centavos (preço unitário tem até dez) são
 * arredondadas meio para cima em inteiros, sem passar por ponto flutuante. Texto que não
 * é decimal volta como veio, sem presumir moeda.
 */
export function formatBRL(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith("-");
  const [integer = "0", fraction = ""] = value.replace("-", "").split(".");
  const padded = (fraction + "000").slice(0, 3);
  let cents = BigInt(integer) * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1n;
  const whole = integerFormat.format(cents / 100n);
  const rest = String(cents % 100n).padStart(2, "0");
  return `${negative && cents > 0n ? "-" : ""}R$\u00a0${whole},${rest}`;
}

/**
 * Valor exato em qualquer moeda: BRL como `formatBRL`; as demais com o código ISO na frente,
 * "1000.5" + "USD" → "USD 1.000,50". O código evita confundir símbolos como "$".
 */
export function formatMoney(value: string | null | undefined, currency: string): string {
  if (currency === "BRL") return formatBRL(value);
  const brl = formatBRL(value);
  return brl.startsWith("R$") || brl.startsWith("-R$") ? brl.replace("R$ ", `${currency} `) : brl;
}

/** Decimal exato com vírgula, sem arredondar: "5.123400" → "5,123400". */
export function formatDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return /^-?\d+(\.\d+)?$/.test(value) ? value.replace(".", ",") : value;
}

/** Competência fiscal "2026-10" → "10/2026". */
export function formatCompetence(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[2]}/${match[1]}` : value;
}

const months = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
/** Competência fiscal "2026-10" → "outubro de 2026", sem passar por `Date` nem fuso. */
export function formatCompetenceLong(value: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? `${months[Number(match[2]) - 1]} de ${match[1]}` : value;
}

const brasilia = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** Data civil de Brasília, "AAAA-MM-DD", qualquer que seja o fuso do navegador. */
export function todayInBrasilia(now: number = Date.now()): string {
  return brasilia.format(now);
}

/** "52998224725" → "529.982.247-25"; outro texto volta como veio. */
export function formatCpf(value: string): string {
  return value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

const regions = new Intl.DisplayNames(["pt-BR"], { type: "region" });
/** "US" → "Estados Unidos"; um código que o navegador não conhece volta como veio. */
export function countryName(code: string): string {
  try {
    return regions.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** CEP de oito dígitos "13010000" → "13010-000"; outro texto volta como veio. */
export const formatCep = (cep: string) => cep.replace(/^(\d{5})(\d{3})$/, "$1-$2");

/** Epoch em milissegundos → "02/10/2026 14:03". */
export function formatDateTime(ms: number): string {
  return dateTime.format(ms);
}

/**
 * Epoch em milissegundos → "02/10/2026 14:03:27", no mesmo fuso de `formatDateTime`. Para
 * históricos em que a ordem de eventos do mesmo minuto precisa ficar legível.
 */
export function formatDateTimeSeconds(ms: number): string {
  return dateTimeSeconds.format(ms);
}

const shortParts = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
/**
 * Epoch em milissegundos → "22/10 14:03", com o ano só quando não é o de `now`
 * ("22/10/2025 14:03"). Para horários recentes, como os da captura.
 */
export function formatShortDateTime(ms: number, now: number = Date.now()): string {
  const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const parts = shortParts.formatToParts(ms);
  const year = part(parts, "year");
  const day = `${part(parts, "day")}/${part(parts, "month")}`;
  const sameYear = year === part(shortParts.formatToParts(now), "year");
  return `${sameYear ? day : `${day}/${year}`} ${part(parts, "hour")}:${part(parts, "minute")}`;
}

/** Epoch em milissegundos → "02/10/2026". */
export function formatDate(ms: number): string {
  return date.format(ms);
}

/**
 * Período entre dois instantes, para o meio da frase: "de 10/07/2026 a 22/10/2026", ou
 * "em 26/10/2026" quando os dois caem no mesmo dia. `start` põe a primeira letra em maiúscula.
 */
export function formatDateRange(from: number, to: number, start = false): string {
  const [first, last] = [formatDate(from), formatDate(to)];
  const range = first === last ? `em ${first}` : `de ${first} a ${last}`;
  return start ? range[0]!.toUpperCase() + range.slice(1) : range;
}

const utcParts = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
/**
 * Epoch em milissegundos → "01/12/2026 às 00:00 UTC", com os segundos só quando não são zero
 * ("27/11/2026 às 11:59:29 UTC"). Para inícios e fins de período: o fim é o instante em que o
 * período seguinte começa, e a frase diz isso ("renova em", "termina em"), sem "até".
 */
export function formatUtcInstant(ms: number): string {
  const parts = utcParts.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const seconds = part("second") === "00" ? "" : `:${part("second")}`;
  return `${part("day")}/${part("month")}/${part("year")} às ${part("hour")}:${part("minute")}${seconds} UTC`;
}

/** "2026-10-02T14:03:00-03:00" ou "2026-10-02" → "02/10/2026", sem converter fuso. */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/** Chave de 44 posições (NF-e) ou 50 dígitos (NFS-e) em grupos de quatro; outras voltam como vieram. */
export function groupKey(key: string): string {
  return /^(?:[0-9A-Z]{44}|\d{50})$/.test(key) ? key.replace(/(.{4})(?=.)/g, "$1 ") : key;
}

/** Final da chave para listas: "…1234 59". */
export function shortKey(key: string): string {
  return /^[0-9A-Z]{44}$/.test(key) ? `…${key.slice(-6, -2)} ${key.slice(-2)}` : key;
}
