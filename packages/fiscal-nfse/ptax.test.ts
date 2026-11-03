import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  convertToBrl,
  fetchPtaxSale,
  parsePtaxBulletins,
  previousDay,
  ptaxDateParam,
  ptaxQuoteUrl,
  ptaxSaleForIssue,
  type NfseTransport,
} from "./src/index";

const cadFixture = readFileSync(
  new URL("./fixtures/ptax-cad-2026-08-28.json", import.meta.url),
  "utf8",
);

/** Transporte falso: data (AAAA-MM-DD) → corpo; dias ausentes = sem boletim. */
function fakeOlinda(days: Record<string, string>) {
  const calls: string[] = [];
  const transport: NfseTransport = async (request) => {
    const m = /dataCotacao='(\d{2})-(\d{2})-(\d{4})'/.exec(request.url);
    const iso = m ? `${m[3]}-${m[1]}-${m[2]}` : "";
    calls.push(iso);
    return { status: 200, body: days[iso] ?? JSON.stringify({ value: [] }) };
  };
  return { transport, calls };
}

/** Fórmula do legado `convertToBrlCents`, reescrita aqui só para comparação. */
const legacyCents = (minor: bigint, micros: bigint) => (minor * micros + 500_000n) / 1_000_000n;
const toCents = (brl: string) => BigInt(brl.replace(".", ""));

describe("conversão PTAX", () => {
  it("produto exato com half-up em 2 casas", () => {
    // USD 49.00 × 5.4321 = 266.1729 → 266.17
    expect(convertToBrl("49.00", "5.4321")).toBe("266.17");
    // 0.01 × 0.5 = 0.005 → 0.01 (half-up)
    expect(convertToBrl("0.01", "0.5")).toBe("0.01");
    expect(convertToBrl("1000.00", "3.987600")).toBe("3987.60");
  });

  it("preserva centavos com produto grande, sem limite de inteiro seguro", () => {
    expect(convertToBrl("9999999999.99", "5.4321")).toBe("54320999999.95");
    expect(convertToBrl("90071992547409.91", "2")).toBe("180143985094819.82");
  });

  it("dá o mesmo resultado do legado em casos de borda", () => {
    const cases: [string, string][] = [
      ["49.00", "5.432100"],
      ["0.01", "0.500000"],
      ["0.01", "0.499999"],
      ["123.45", "6.234500"],
      ["999.99", "4.999995"],
      ["1.00", "0.000001"],
      ["7.77", "5.555555"],
    ];
    for (const [amount, rate] of cases) {
      const expected = legacyCents(toCents(amount), BigInt(rate.replace(".", "")));
      expect(toCents(convertToBrl(amount, rate))).toBe(expected);
    }
  });

  it("recusa escala excedente, zero, negativo e texto inválido", () => {
    expect(() => convertToBrl("49.005", "5")).toThrow(/2 casas/);
    expect(() => convertToBrl("49", "5.1234567")).toThrow(/6 casas/);
    expect(() => convertToBrl("0", "5")).toThrow(/positivos/);
    expect(() => convertToBrl("10", "0.000000")).toThrow(/positivos/);
    expect(() => convertToBrl("-1", "5")).toThrow(/decimal não negativo/);
    expect(() => convertToBrl("1e2", "5")).toThrow(/decimal não negativo/);
  });
});

describe("datas da PTAX", () => {
  it("formata no padrão Olinda (MM-DD-AAAA) e recusa data inexistente", () => {
    expect(ptaxDateParam("2026-08-29")).toBe("08-29-2026");
    expect(() => ptaxDateParam("29/08/2026")).toThrow(/inválida/);
    expect(() => ptaxDateParam("2026-02-29")).toThrow(/inválida/);
    expect(() => previousDay("2026-02-31")).toThrow(/inválida/);
  });

  it("previousDay atravessa mês, ano e fevereiro bissexto", () => {
    expect(previousDay("2026-08-01")).toBe("2026-07-31");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });

  it("URL do dólar e das demais moedas", () => {
    expect(ptaxQuoteUrl("USD", "2026-08-28")).toContain("CotacaoDolarDia");
    expect(ptaxQuoteUrl("CAD", "2026-08-28")).toContain("@moeda='CAD'&@dataCotacao='08-28-2026'");
    expect(() => ptaxQuoteUrl("cad", "2026-08-28")).toThrow(/ISO/);
  });
});

describe("boletins", () => {
  it("prefere o boletim de Fechamento e fixa 6 casas", () => {
    expect(parsePtaxBulletins(cadFixture)).toBe("3.987600");
  });

  it("dia sem boletim devolve null; corpo ilegível é erro", () => {
    expect(parsePtaxBulletins('{"value":[]}')).toBeNull();
    expect(() => parsePtaxBulletins("<html>erro</html>")).toThrow(/JSON/);
    expect(() => parsePtaxBulletins('{"x":1}')).toThrow(/lista/);
    expect(() => parsePtaxBulletins('{"value":[{"cotacaoVenda":"5.1"}]}')).toThrow(/ilegível/);
    expect(() => parsePtaxBulletins('{"value":[{"cotacaoVenda":1e-7}]}')).toThrow(/ilegível/);
  });

  it("fetchPtaxSale recusa HTTP diferente de 200", async () => {
    const transport: NfseTransport = async () => ({ status: 503, body: "" });
    await expect(fetchPtaxSale("USD", "2026-08-28", transport)).rejects.toThrow(/HTTP 503/);
  });

  it("emissão na segunda usa a PTAX da sexta (recua sobre o fim de semana)", async () => {
    const { transport, calls } = fakeOlinda({ "2026-08-28": cadFixture });
    const quote = await ptaxSaleForIssue("CAD", "2026-08-31", transport);
    expect(quote).toEqual({ currency: "CAD", rate: "3.987600", quoteDate: "2026-08-28" });
    expect(calls).toEqual(["2026-08-30", "2026-08-29", "2026-08-28"]);
  });

  it("janela de 10 dias sem boletim falha com erro claro", async () => {
    const { transport, calls } = fakeOlinda({});
    await expect(ptaxSaleForIssue("USD", "2026-08-31", transport)).rejects.toThrow(
      /nenhum boletim/,
    );
    expect(calls).toHaveLength(10);
  });
});
