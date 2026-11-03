import { describe, expect, it } from "vite-plus/test";
import {
  ROUTE_RULES,
  normalizeSubitem,
  resolveRoute,
  subitemFromCTribNac,
  type RouteInput,
} from "./src/index";

const CAMPINAS = "3509502";
const SAO_PAULO = "3550308";
const route = (input: Partial<RouteInput>) =>
  resolveRoute({
    municipioIbge: CAMPINAS,
    regime: "nao-optante",
    subitem: "17.01",
    date: "2026-12-15",
    ...input,
  });
const LISTED = ["1.03", "1.05", "1.09", "16.01", "01.05"];

describe("fora de Campinas", () => {
  it("padrão nacional vai para a Sefin Nacional, em qualquer data", () => {
    for (const date of ["2026-01-01", "2026-09-20", "2026-12-01"])
      expect(
        route({ municipioIbge: SAO_PAULO, regime: "simples-nacional", subitem: "1.05", date }),
      ).toEqual({
        kind: "nacional",
        provider: "nacional",
        target: "sefin-nacional",
        alternatives: [],
        ruleId: "nacional-padrao",
        source: "Padrão nacional da NFS-e (Sefin Nacional); ADR 0004",
      });
  });
});

describe("Campinas (ADR 0004)", () => {
  it("C1: qualquer regime e subitem até 20/09/2026 é ABRASF, sem suporte", () => {
    for (const regime of ["simples-nacional", "nao-optante"] as const)
      for (const subitem of ["1.05", "17.01"]) {
        const result = route({ regime, subitem, date: "2026-09-20" });
        expect(result).toMatchObject({
          kind: "unsupported",
          code: "ROUTE_ABRASF",
          emitter: "abrasf",
          ruleId: "campinas-c1-abrasf",
        });
        expect(result.kind === "unsupported" && result.message).toMatch(
          /Campinas.*20\/09\/2026.*ABRASF.*não suporta/,
        );
      }
  });

  it("não optante de 21/09 a 30/09: ADN de Campinas, com ABRASF como alternativa", () => {
    for (const date of ["2026-09-21", "2026-09-30"])
      for (const subitem of ["1.05", "17.01"])
        expect(route({ subitem, date })).toMatchObject({
          kind: "nacional",
          target: "campinas-adn",
          alternatives: ["abrasf"],
          ruleId: "campinas-nao-optante-setembro",
        });
  });

  it("Simples de 21/09 a 30/09 ainda é ABRASF", () => {
    for (const date of ["2026-09-21", "2026-09-30"])
      expect(route({ regime: "simples-nacional", date })).toMatchObject({
        kind: "unsupported",
        ruleId: "campinas-simples-setembro",
      });
  });

  it("C2: não optante fora dos subitens listados, desde 01/10/2026, vai ao ADN de Campinas", () => {
    for (const date of ["2026-10-01", "2026-11-30", "2027-06-01"])
      expect(route({ subitem: "1.04", date })).toEqual(
        expect.objectContaining({
          kind: "nacional",
          target: "campinas-adn",
          alternatives: [],
          ruleId: "campinas-c2-nao-optante",
        }),
      );
  });

  it("C3/C4: subitens listados escolhem até 30/11/2026 e são só ADN desde 01/12/2026", () => {
    for (const subitem of LISTED) {
      for (const date of ["2026-10-01", "2026-11-30"])
        expect(route({ subitem, date })).toMatchObject({
          kind: "nacional",
          target: "campinas-adn",
          alternatives: ["abrasf"],
          ruleId: "campinas-c3-subitens",
        });
      expect(route({ subitem, date: "2026-12-01" })).toMatchObject({
        kind: "nacional",
        target: "campinas-adn",
        alternatives: [],
        ruleId: "campinas-c4-subitens",
      });
    }
  });

  it("C5/C6: Simples escolhe em outubro e vai à Sefin Nacional desde 01/11/2026", () => {
    for (const date of ["2026-10-01", "2026-10-31"])
      expect(route({ regime: "simples-nacional", subitem: "1.05", date })).toMatchObject({
        kind: "nacional",
        target: "campinas-adn",
        alternatives: ["abrasf"],
        ruleId: "campinas-c5-simples",
      });
    for (const subitem of ["1.05", "17.01"])
      expect(route({ regime: "simples-nacional", subitem, date: "2026-11-01" })).toMatchObject({
        kind: "nacional",
        target: "sefin-nacional",
        alternatives: [],
        ruleId: "campinas-c6-simples",
      });
  });

  it("toda data de Campinas tem regra própria; nenhuma cai no padrão nacional", () => {
    for (
      let day = new Date("2026-09-15T12:00:00Z");
      day < new Date("2026-12-10");
      day.setUTCDate(day.getUTCDate() + 1)
    )
      for (const regime of ["simples-nacional", "nao-optante"] as const)
        for (const subitem of ["1.05", "17.01"]) {
          const result = route({ regime, subitem, date: day.toISOString().slice(0, 10) });
          expect(result.ruleId).toMatch(/^campinas-/);
        }
  });
});

describe("tabela e entrada", () => {
  it("sem regra vigente devolve unsupported explícito", () => {
    expect(
      resolveRoute(
        { municipioIbge: SAO_PAULO, regime: "nao-optante", subitem: "1.01", date: "2026-01-01" },
        [],
      ),
    ).toMatchObject({ kind: "unsupported", code: "ROUTE_NO_RULE", emitter: null });
  });

  it("recusa entrada inválida", () => {
    expect(() => route({ municipioIbge: "350950" })).toThrow(/7 dígitos/);
    expect(() => route({ date: "2026-02-30" })).toThrow(/AAAA-MM-DD/);
    expect(() => route({ subitem: "105" })).toThrow(/Subitem/);
    expect(() => route({ regime: "lucro" as "nao-optante" })).toThrow(/regime/);
  });

  it("toda regra tem fonte e vigência coerente; as de Campinas citam o ADR 0004", () => {
    for (const rule of ROUTE_RULES) {
      expect(rule.source.length).toBeGreaterThan(0);
      if (rule.validFrom && rule.validUntil) expect(rule.validFrom <= rule.validUntil).toBe(true);
      if (rule.municipioIbge === CAMPINAS) expect(rule.source).toMatch(/ADR 0004/);
    }
  });

  it("normaliza subitens e os extrai do cTribNac", () => {
    expect(normalizeSubitem("01.05")).toBe("1.05");
    expect(normalizeSubitem("16.01")).toBe("16.01");
    expect(subitemFromCTribNac("010501")).toBe("1.05");
    expect(subitemFromCTribNac("160101")).toBe("16.01");
    expect(() => subitemFromCTribNac("1050")).toThrow(/6 dígitos/);
    expect(() => normalizeSubitem("0.05")).toThrow(/Subitem/);
  });
});
