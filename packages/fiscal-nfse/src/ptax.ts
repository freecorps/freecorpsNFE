/**
 * Câmbio oficial: PTAX de VENDA do dia útil anterior ao fato gerador, na API
 * pública BCB/Olinda. Portado de `convex/engine/ptax.ts`, sem rede própria:
 * a consulta usa o transporte injetado.
 *
 * Taxa e valores são texto decimal. A taxa é fixada em 6 casas com half-up,
 * como os micros do legado (`Math.round(cotacao * 1e6)`); a conversão para
 * BRL é o produto exato arredondado em 2 casas com half-up, o mesmo resultado
 * de `convertToBrlCents` ((menor × micros + 500000) / 1e6) para valores
 * positivos.
 *
 * Fins de semana e feriados não têm boletim (`value: []`). A busca anda para
 * trás dia a dia, por no máximo 10 dias.
 */
import { decimal, quantize } from "@freecorps/fiscal-core";
import { fail } from "./errors.js";
import { multiplyRounded } from "./decimal.js";
import type { NfseTransport } from "./http.js";

const OLINDA = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata";
export const PTAX_RATE_SCALE = 6;
const LOOKBACK_DAYS = 10;
const ZERO = /^0+(?:\.0+)?$/;

export interface PtaxQuote {
  currency: string; // ISO 4217, ex. "CAD"
  rate: string; // cotação de venda, 6 casas
  quoteDate: string; // AAAA-MM-DD do boletim usado
}

function calendarDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const date = match ? new Date(`${iso}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    return fail("PTAX_DATE_INVALID", `Data inválida para PTAX: ${iso}`);
  return date;
}

/** AAAA-MM-DD → MM-DD-AAAA (formato da API Olinda). */
export function ptaxDateParam(isoDate: string): string {
  calendarDate(isoDate);
  return `${isoDate.slice(5, 7)}-${isoDate.slice(8, 10)}-${isoDate.slice(0, 4)}`;
}

/** Dia anterior no calendário. */
export function previousDay(isoDate: string): string {
  const date = calendarDate(isoDate);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function ptaxQuoteUrl(currency: string, isoDate: string): string {
  if (!/^[A-Z]{3}$/.test(currency))
    fail("PTAX_CURRENCY_INVALID", "Moeda da PTAX deve ser código ISO de 3 letras.");
  const data = ptaxDateParam(isoDate);
  if (currency === "USD")
    return `${OLINDA}/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${data}'&$format=json`;
  return `${OLINDA}/CotacaoMoedaDia(moeda=@moeda,dataCotacao=@dataCotacao)?@moeda='${currency}'&@dataCotacao='${data}'&$format=json`;
}

/**
 * Lê a resposta Olinda de um dia. Devolve a cotação de venda (6 casas) ou
 * null quando o dia não tem boletim. Moedas não-dólar têm vários boletins no
 * dia; o oficial é o de Fechamento.
 */
export function parsePtaxBulletins(body: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return fail("PTAX_RESPONSE_INVALID", "Resposta da PTAX não é JSON.");
  }
  const value = (data as { value?: unknown } | null)?.value;
  if (!Array.isArray(value))
    return fail("PTAX_RESPONSE_INVALID", "Resposta da PTAX sem a lista de boletins.");
  const bulletins = value as { cotacaoVenda?: unknown; tipoBoletim?: unknown }[];
  const chosen =
    bulletins.find((b) => b?.tipoBoletim === "Fechamento") ?? bulletins[bulletins.length - 1];
  if (chosen?.cotacaoVenda === undefined || chosen.cotacaoVenda === null) return null;
  // O JSON traz número; a forma mais curta que o representa é o texto
  // publicado (4 casas no boletim). Notação exponencial ou sinal é recusado.
  const text = typeof chosen.cotacaoVenda === "number" ? String(chosen.cotacaoVenda) : "";
  if (!/^\d+(?:\.\d+)?$/.test(text) || ZERO.test(text))
    return fail("PTAX_RESPONSE_INVALID", "Cotação de venda da PTAX ilegível.");
  return quantize(decimal(text), PTAX_RATE_SCALE, "half-up");
}

/** Boletim de um dia; null quando o dia não tem cotação. */
export async function fetchPtaxSale(
  currency: string,
  isoDate: string,
  transport: NfseTransport,
): Promise<PtaxQuote | null> {
  const response = await transport({
    method: "GET",
    url: ptaxQuoteUrl(currency, isoDate),
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200)
    fail("PTAX_HTTP_ERROR", `PTAX: HTTP ${response.status} para ${currency} em ${isoDate}.`);
  const rate = parsePtaxBulletins(response.body);
  return rate === null ? null : { currency, rate, quoteDate: isoDate };
}

/**
 * Taxa para emissão: começa no DIA ANTERIOR à data do fato gerador
 * (`issueDate`, informada pelo chamador) e recua até achar boletim.
 */
export async function ptaxSaleForIssue(
  currency: string,
  issueDate: string,
  transport: NfseTransport,
): Promise<PtaxQuote> {
  let day = previousDay(issueDate);
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const quote = await fetchPtaxSale(currency, day, transport);
    if (quote) return quote;
    day = previousDay(day);
  }
  return fail(
    "PTAX_NOT_FOUND",
    `PTAX: nenhum boletim de ${currency} nos ${LOOKBACK_DAYS} dias anteriores a ${issueDate}.`,
  );
}

/**
 * Converte um valor na moeda original para BRL: produto exato, 2 casas,
 * half-up. `amount` aceita até 2 casas e `rate` até 6, como o legado.
 */
export function convertToBrl(amount: string, rate: string): string {
  const scale = (value: string) => value.split(".")[1]?.length ?? 0;
  if (scale(amount) > 2) fail("PTAX_AMOUNT_INVALID", "Valor na moeda original aceita até 2 casas.");
  if (scale(rate) > PTAX_RATE_SCALE)
    fail("PTAX_RATE_INVALID", `Taxa PTAX aceita até ${PTAX_RATE_SCALE} casas.`);
  const brl = multiplyRounded(amount, rate, 2, "half-up", ["Valor na moeda original", "Taxa PTAX"]);
  if (ZERO.test(amount) || ZERO.test(rate))
    fail("PTAX_AMOUNT_INVALID", "Valor e taxa da conversão devem ser positivos.");
  return brl;
}
