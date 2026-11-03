import { describe, expect, it } from "vite-plus/test";
import { emptyDraft, validateDraft, type Draft } from "./issuance-draft";
import { validateProfile } from "./nfse-profile-draft";
import {
  amountCases,
  calendarDateCases,
  competenceCases,
  cpfCases,
  emailCases,
  issRateCases,
  lc116Cases,
  municipalityCases,
  type RuleCase,
} from "../../../tests/helpers/ruleCases";

/**
 * The console forms point the same problems the server refuses (issue #281). The server runs
 * these tables in `tests/platform.sharedRules.test.ts`.
 */
const NOW = Date.UTC(2026, 9, 8, 15); // 08/10/2026 12:00 in Brasília
const activity = {
  code: "licenca",
  label: "Licenciamento sintético",
  cnae: "6202300",
  lc116Item: "01.05",
  cTribNac: "010501",
};
const rateProfile = { opSimpNac: 1 as const, activities: [activity] };
const draft: Draft = {
  ...emptyDraft(NOW),
  activityCode: "licenca",
  issuerEmail: "fiscal@prestador.example",
  description: "Licença de uso",
  value: "1500.25",
  issRate: "2.5",
  national: {
    document: "11.444.777/0001-61",
    name: "Tomador Sintético Ltda",
    email: "",
    municipalityCode: "3550308",
    postalCode: "01001-000",
    street: "Praça da Sé",
    number: "100",
    district: "Sé",
  },
};
const taker = (change: Partial<Draft["national"]>): Draft => ({
  ...draft,
  national: { ...draft.national, ...change },
});

describe("o formulário de emissão aplica as regras compartilhadas", () => {
  const fields: [string, string, readonly RuleCase[], (value: string) => Draft][] = [
    ["CPF", "taker.document", cpfCases, (document) => taker({ document })],
    ["data", "issueDate", calendarDateCases, (issueDate) => ({ ...draft, issueDate })],
    [
      "e-mail do prestador",
      "issuerEmail",
      emailCases,
      (issuerEmail) => ({ ...draft, issuerEmail }),
    ],
    ["e-mail do tomador", "taker.email", emailCases, (email) => taker({ email })],
    [
      "município",
      "taker.address.municipalityCode",
      municipalityCases,
      (municipalityCode) => taker({ municipalityCode }),
    ],
    ["valor", "amount.value", amountCases, (value) => ({ ...draft, value })],
    ["alíquota", "issRate", issRateCases, (issRate) => ({ ...draft, issRate })],
    ["competência", "competence", competenceCases, (competence) => ({ ...draft, competence })],
  ];
  it.each(fields)("%s", (_, field, cases, change) => {
    expect(validateDraft(draft, rateProfile, NOW)).toEqual({});
    for (const [value, valid] of cases)
      expect([value, field in validateDraft(change(value), rateProfile, NOW)]).toEqual([
        value,
        !valid,
      ]);
  });
});

describe("o formulário do perfil NFS-e aplica as regras compartilhadas", () => {
  const profile = {
    municipalRegistration: "",
    issuerEmail: "",
    municipalityCode: "3550308",
    opSimpNac: 2 as const,
    regApTribSN: 1 as const,
    regEspTrib: 0 as const,
    dpsSeries: "1",
    campinasDpsSeries: "",
    activities: [
      {
        ...activity,
        nbs: "",
        cTribMun: "",
        ibsCIndOp: "",
        ibsCst: "",
        ibsCClassTrib: "",
        description: "",
      },
    ],
  };
  const withActivity = (change: Partial<(typeof profile.activities)[number]>) => ({
    ...profile,
    activities: [{ ...profile.activities[0]!, ...change }],
  });
  it("e-mail do prestador", () => {
    expect(validateProfile(profile, "SP")).toEqual({});
    for (const [issuerEmail, valid] of emailCases)
      expect([
        issuerEmail,
        "nfse-email" in validateProfile({ ...profile, issuerEmail }, "SP"),
      ]).toEqual([issuerEmail, !valid]);
  });
  it("item da LC 116, com o código nacional do item", () => {
    for (const [lc116Item, item] of lc116Cases) {
      const cTribNac = `${(item ?? "01.05").replace(".", "")}01`;
      const errors = validateProfile(withActivity({ lc116Item, cTribNac }), "SP");
      expect([lc116Item, "nfse-activity-0-lc116Item" in errors]).toEqual([lc116Item, !item]);
    }
    expect(validateProfile(withActivity({ cTribNac: "010601" }), "SP")).toHaveProperty(
      "nfse-activity-0-cTribNac",
    );
  });
  it("município", () => {
    for (const [municipalityCode, valid] of municipalityCases)
      if (!valid)
        expect(
          validateProfile({ ...profile, municipalityCode }, "SP")["nfse-municipality"],
        ).toMatch(/código IBGE/);
  });
});
