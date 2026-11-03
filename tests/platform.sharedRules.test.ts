import { ConvexError } from "convex/values";
import { describe, expect, it } from "vite-plus/test";
import { validCpf } from "../packages/fiscal-core/src/index";
import { isCalendarDate } from "../packages/fiscal-nfse/src/pure";
import { normalizeIssuanceInput } from "../platform/convex/lib/issuanceCore";
import { isAmount, isCompetence, isIssRate } from "../platform/convex/lib/issuanceRules";
import type { IssuanceInput } from "../platform/convex/lib/issuanceValues";
import { normalizeNfseProfile } from "../platform/convex/lib/nfseProfile";
import {
  cTribNacMatchesItem,
  lc116Item,
  validEmail,
  validMunicipalityCode,
} from "../platform/convex/lib/nfseProfileRules";
import {
  importBatchOutcome,
  importFileOutcome,
  needsAttention,
} from "../platform/convex/lib/importOutcome";
import { splitStreet } from "../platform/convex/lib/stripeAddress";
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
} from "./helpers/ruleCases";

/**
 * Pure rules shared by the console and the server (issue #281). The console runs the same tables
 * in `apps/console/src/sharedRules.test.tsx`.
 */
describe("regras puras compartilhadas", () => {
  it.each([
    ["CPF", validCpf, cpfCases],
    ["data civil", isCalendarDate, calendarDateCases],
    ["e-mail", validEmail, emailCases],
    ["município IBGE", validMunicipalityCode, municipalityCases],
    ["valor", isAmount, amountCases],
    ["alíquota do ISS", isIssRate, issRateCases],
    ["competência", isCompetence, competenceCases],
  ] as const)("%s", (_, rule, cases: readonly RuleCase[]) => {
    for (const [value, valid] of cases) expect([value, rule(value)]).toEqual([value, valid]);
  });

  it("normaliza o item da LC 116 e confere o código nacional", () => {
    for (const [value, item] of lc116Cases)
      expect([value, lc116Item(value)]).toEqual([value, item]);
    expect(cTribNacMatchesItem("010501", "01.05")).toBe(true);
    expect(cTribNacMatchesItem("010601", "01.05")).toBe(false);
  });

  it("separa rua e número com o default de cada fluxo", () => {
    expect(splitStreet("548 Market St", "S/N")).toEqual({ street: "Market St", number: "548" });
    expect(splitStreet("Rua das Flores, 120 apto 3", "")).toEqual({
      street: "Rua das Flores apto 3",
      number: "120",
    });
    expect(splitStreet("Avenida Paulista", "S/N")).toEqual({
      street: "Avenida Paulista",
      number: "S/N",
    });
    expect(splitStreet("Avenida Paulista", "")).toEqual({ street: "Avenida Paulista", number: "" });
  });
});

const input: IssuanceInput = {
  activityCode: "licenca",
  competence: "2026-01",
  issueDate: "2026-10-08",
  issuerEmail: "fiscal@prestador.example",
  market: "domestic",
  taker: {
    kind: "national",
    document: "11.444.777/0001-61",
    name: "Tomador Sintético Ltda",
    address: {
      municipalityCode: "3550308",
      postalCode: "01001-000",
      street: "Praça da Sé",
      number: "100",
      district: "Sé",
    },
  },
  description: "Licença de uso",
  amount: { currency: "BRL", value: "1500.25" },
  issRate: "2.5",
  issWithheld: false,
};
const national = input.taker as Extract<IssuanceInput["taker"], { kind: "national" }>;
function refusedField(request: IssuanceInput) {
  try {
    normalizeIssuanceInput(request);
    return null;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    return (error.data as { field?: string }).field ?? null;
  }
}

describe("o servidor reexecuta as regras compartilhadas no pedido de emissão", () => {
  const fields: [string, string, readonly RuleCase[], (value: string) => IssuanceInput][] = [
    [
      "CPF",
      "taker.document",
      cpfCases,
      (document) => ({ ...input, taker: { ...national, document } }),
    ],
    ["data", "issueDate", calendarDateCases, (issueDate) => ({ ...input, issueDate })],
    [
      "e-mail do prestador",
      "issuerEmail",
      emailCases,
      (issuerEmail) => ({ ...input, issuerEmail }),
    ],
    [
      "e-mail do tomador",
      "taker.email",
      emailCases,
      (email) => ({ ...input, taker: { ...national, email } }),
    ],
    [
      "município",
      "taker.address.municipalityCode",
      municipalityCases,
      (municipalityCode) => ({
        ...input,
        taker: { ...national, address: { ...national.address, municipalityCode } },
      }),
    ],
    [
      "valor",
      "amount.value",
      amountCases,
      (value) => ({ ...input, amount: { currency: "BRL", value } }),
    ],
    ["alíquota", "issRate", issRateCases, (issRate) => ({ ...input, issRate })],
    ["competência", "competence", competenceCases, (competence) => ({ ...input, competence })],
  ];
  it.each(fields)("%s", (_, field, cases, request) => {
    expect(refusedField(input)).toBeNull();
    for (const [value, valid] of cases)
      expect([value, refusedField(request(value))]).toEqual([value, valid ? null : field]);
  });
});

describe("o servidor reexecuta as regras compartilhadas no perfil NFS-e", () => {
  const activity = {
    code: "licenca",
    label: "Licenciamento de software",
    cnae: "6202300",
    lc116Item: "01.05",
    cTribNac: "010501",
  };
  const profile = {
    municipalityCode: "3550308",
    opSimpNac: 2 as const,
    regEspTrib: 0 as const,
    dpsSeries: "1",
    activities: [activity],
  };
  const refused = (value: Parameters<typeof normalizeNfseProfile>[0]) => {
    try {
      normalizeNfseProfile(value, "SP");
      return null;
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      return (error.data as { code: string }).code;
    }
  };
  it("e-mail do prestador", () => {
    for (const [issuerEmail, valid] of emailCases)
      expect([issuerEmail, refused({ ...profile, issuerEmail })]).toEqual([
        issuerEmail,
        valid ? null : "INVALID_ISSUER_EMAIL",
      ]);
  });
  it("item da LC 116, com o código nacional do item", () => {
    for (const [lc116Item, item] of lc116Cases) {
      const cTribNac = `${(item ?? "01.05").replace(".", "")}01`;
      expect([
        lc116Item,
        refused({ ...profile, activities: [{ ...activity, lc116Item, cTribNac }] }),
      ]).toEqual([lc116Item, item ? null : "INVALID_LC116_ITEM"]);
    }
    expect(refused({ ...profile, activities: [{ ...activity, cTribNac: "010601" }] })).toBe(
      "ACTIVITY_CODES_MISMATCH",
    );
  });
  it("município", () => {
    for (const [municipalityCode, valid] of municipalityCases)
      if (!valid)
        expect(refused({ ...profile, municipalityCode })).toBe("INVALID_MUNICIPALITY_CODE");
  });
});

/** What the Início and the import screen read from each file's current result (#507). */
describe("desfecho de um arquivo importado", () => {
  it.each([
    ["succeeded", "IMPORTED", "imported", false],
    ["succeeded", "NFSE_BATCH_IMPORTED", "imported", false],
    ["succeeded", "DUPLICATE", "duplicate", false],
    ["succeeded", "ARTIFACT_CONFLICT", "caveat", false],
    ["succeeded", "XML_SCHEMA_UNSUPPORTED", "refused", true],
    ["succeeded", "XML_EVENT_UNSUPPORTED", "refused", true],
    ["succeeded", "COMPANY_MISMATCH", "refused", true],
    ["succeeded", null, "refused", true],
    ["failed", "ORIGINAL_UNAVAILABLE", "failed", true],
    ["paused", "ACCESS_REVOKED", "paused", true],
    ["expired", null, "not-sent", false],
    ["reserved", null, "running", false],
    ["queued", null, "running", false],
    ["reconciling", null, "running", false],
  ] as const)("%s com %s é %s", (state, code, outcome, attention) => {
    expect(importFileOutcome({ state, code })).toBe(outcome);
    expect(needsAttention(importFileOutcome({ state, code }))).toBe(attention);
  });
  it("conta o lote uma vez, com os desfechos de cada arquivo", () => {
    const batch = importBatchOutcome([
      { state: "succeeded", code: "IMPORTED" },
      { state: "succeeded", code: "NFSE_BATCH_IMPORTED" },
      { state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" },
      { state: "succeeded", code: "COMPANY_MISMATCH" },
    ]);
    expect(batch).toMatchObject({
      attention: true,
      state: "attention",
      counts: { imported: 2, refused: 2 },
    });
    // A refused XML needs a person now, even while another file of the batch still runs.
    expect(
      importBatchOutcome([
        { state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" },
        { state: "running", code: null },
      ]).state,
    ).toBe("attention");
    expect(
      importBatchOutcome([
        { state: "succeeded", code: "DUPLICATE" },
        { state: "expired", code: null },
        { state: "running", code: null },
      ]),
    ).toMatchObject({ attention: false, state: "running" });
  });
});
