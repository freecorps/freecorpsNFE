import { describe, expect, it } from "vite-plus/test";
import { accessKeyDigit, validateAccessKey } from "./src/index";

// Synthetic keys only: the fictitious CNPJ 11.222.333/0001-81, the RFB example 12.ABC.345/01DE-35
// and a check digit computed here.
const withDigit = (base: string) => base + accessKeyDigit(base);
const valid = withDigit("3526091122233300018155001000000069112345678");

describe("validateAccessKey (#296)", () => {
  it("decodes a valid key", () => {
    expect(validateAccessKey(valid)).toEqual({
      ok: true,
      key: valid,
      parts: {
        stateCode: "35",
        state: "SP",
        yearMonth: "2609",
        issuer: { kind: "CNPJ", document: "11222333000181" },
        model: "55",
        series: "1",
        number: "69",
        emission: "1",
        code: "12345678",
        digit: valid[43],
      },
    });
  });
  it("accepts the alphanumeric CNPJ and the issuer's CPF", () => {
    const alphanumeric = validateAccessKey(
      withDigit("53261212ABC34501DE3555002000001234912345678"),
    );
    expect(alphanumeric.ok && alphanumeric.parts).toMatchObject({
      state: "DF",
      issuer: { kind: "CNPJ", document: "12ABC34501DE35" },
      series: "2",
      number: "1234",
      emission: "9",
    });
    // The placeholder CPF 123.456.789-09, after three zeros.
    const cpf = validateAccessKey(withDigit("4326010001234567890955001000000001112345678"));
    expect(cpf.ok && cpf.parts.issuer).toEqual({ kind: "CPF", document: "12345678909" });
  });
  it("says CNPJ or CPF when the 14 positions are both", () => {
    // The placeholder CPF 001.234.567-97 after three zeros is also the valid CNPJ 00.000.123/4567-97.
    const both = validateAccessKey(withDigit("4326010000012345679755001000000001112345678"));
    expect(both.ok && both.parts.issuer).toEqual({
      kind: "CNPJ_OR_CPF",
      document: "00000123456797",
    });
  });
  it.each([
    ["length", valid.slice(0, 43), "NFE_KEY_INVALID"],
    ["length", valid + "1", "NFE_KEY_INVALID"],
    ["length", "", "NFE_KEY_INVALID"],
    ["characters", valid.slice(0, 30) + "A" + valid.slice(31), "NFE_KEY_INVALID"],
    ["characters", valid.slice(0, 10) + " " + valid.slice(11), "NFE_KEY_INVALID"],
    ["characters", valid.slice(0, 10) + "a" + valid.slice(11), "NFE_KEY_INVALID"],
    ["check_digit", valid.slice(0, 43) + String((Number(valid[43]) + 1) % 10), "NFE_KEY_INVALID"],
    ["model", withDigit("3526091122233300018165001000000069112345678"), "NFE_MODEL_MISMATCH"],
    [
      "state",
      withDigit("3426091122233300018155001000000069112345678"),
      "NFE_KEY_COMPONENT_INVALID",
    ],
    [
      "month",
      withDigit("3526131122233300018155001000000069112345678"),
      "NFE_KEY_COMPONENT_INVALID",
    ],
    [
      "month",
      withDigit("3526001122233300018155001000000069112345678"),
      "NFE_KEY_COMPONENT_INVALID",
    ],
    [
      "number",
      withDigit("3526091122233300018155001000000000112345678"),
      "NFE_KEY_COMPONENT_INVALID",
    ],
    [
      "emission",
      withDigit("3526091122233300018155001000000069812345678"),
      "NFE_KEY_COMPONENT_INVALID",
    ],
    ["issuer", withDigit("3526091122233300018255001000000069112345678"), "NFE_KEY_CNPJ_INVALID"],
  ])("refuses with %s", (reason, key, code) =>
    expect(validateAccessKey(key)).toEqual({ ok: false, reason, code }),
  );
});
