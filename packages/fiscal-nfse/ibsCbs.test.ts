import { describe, expect, it } from "vite-plus/test";
import {
  IBSCBS_RULES,
  NfseError,
  ibsCbsRequirement,
  type IbsCbsInput,
  type TaxRegime,
} from "./src/index";

const required = (input: Partial<IbsCbsInput>) =>
  ibsCbsRequirement({ regime: "nao-optante", subitem: "17.01", date: "2026-10-01", ...input })
    .required;

describe("não optante (Ato Conjunto RFB/CGIBS 4/2026, art. 1º, III)", () => {
  it('alínea "d": subitens fora de "b" e "c" exigem o grupo desde 01/10/2026', () => {
    for (const subitem of ["17.01", "7.02", "14.01", "1.01", "1.04", "16.02", "99.01"]) {
      expect(required({ subitem, date: "2026-09-30" })).toBe(false);
      expect(required({ subitem, date: "2026-10-01" })).toBe(true);
    }
    expect(
      ibsCbsRequirement({ regime: "nao-optante", subitem: "17.01", date: "2026-10-01" }),
    ).toEqual({
      required: true,
      ruleId: "ato4-iii-d",
      since: "2026-10-01",
      source: expect.stringMatching(/Ato Conjunto RFB\/CGIBS 4\/2026, art\. 1º, III, "d"/),
    });
  });

  it('alíneas "b" (1.03, 1.05, 1.09) e "c" (16.01) exigem desde 01/12/2026', () => {
    for (const [subitem, ruleId] of [
      ["1.03", "ato4-iii-b"],
      ["1.05", "ato4-iii-b"],
      ["01.05", "ato4-iii-b"],
      ["1.09", "ato4-iii-b"],
      ["16.01", "ato4-iii-c"],
    ] as const) {
      for (const date of ["2026-10-01", "2026-11-30"])
        expect(ibsCbsRequirement({ regime: "nao-optante", subitem, date })).toMatchObject({
          required: false,
          ruleId,
          since: "2026-12-01",
        });
      expect(required({ subitem, date: "2026-12-01" })).toBe(true);
    }
  });

  it("continua obrigatório em 2027", () => {
    for (const subitem of ["1.05", "17.01"])
      expect(required({ subitem, date: "2027-01-01" })).toBe(true);
  });
});

describe("Simples Nacional, MEI incluído (art. 1º, § 1º)", () => {
  it("qualquer subitem só a partir de 01/01/2027", () => {
    for (const subitem of ["1.05", "16.01", "17.01"]) {
      const at = (date: string) => ibsCbsRequirement({ regime: "simples-nacional", subitem, date });
      for (const date of ["2026-10-01", "2026-11-28", "2026-12-01", "2026-12-31"])
        expect(at(date)).toMatchObject({ required: false, ruleId: "ato4-simples" });
      expect(at("2027-01-01")).toMatchObject({
        required: true,
        ruleId: "ato4-simples",
        since: "2027-01-01",
      });
    }
  });
});

describe("tabela", () => {
  it("toda regra tem fonte no Ato e data válida; cada regime termina sem filtro de subitem", () => {
    for (const rule of IBSCBS_RULES) {
      expect(rule.source).toContain("Ato Conjunto RFB/CGIBS 4/2026");
      expect(rule.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const regime of ["simples-nacional", "nao-optante"] satisfies TaxRegime[])
      expect(IBSCBS_RULES.filter((r) => r.regimes.includes(regime)).at(-1)?.subitens).toBe(
        undefined,
      );
  });

  it("recusa data, regime ou subitem inválidos e tabela injetada sem regra", () => {
    const code = (input: Partial<IbsCbsInput>, rules = IBSCBS_RULES) => {
      try {
        ibsCbsRequirement(
          { regime: "nao-optante", subitem: "1.05", date: "2026-10-01", ...input },
          rules,
        );
        return "OK";
      } catch (error) {
        return error instanceof NfseError ? error.code : "ERROR";
      }
    };
    expect(code({ date: "2026-02-30" })).toBe("IBSCBS_INPUT_INVALID");
    expect(code({ regime: "mei" as TaxRegime })).toBe("IBSCBS_INPUT_INVALID");
    expect(code({ subitem: "1.5" })).toBe("ROUTE_INPUT_INVALID");
    expect(code({}, [])).toBe("IBSCBS_NO_RULE");
  });
});
