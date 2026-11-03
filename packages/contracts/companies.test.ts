import { expect, it } from "vite-plus/test";
import { companyCapabilities, formatCnpj, normalizeCnpj } from "./src/companies";
import fixtures from "./fixtures/cnpj.json";

it("matches the Receita Federal DV example and preserves letters and zeros", () => {
  for (const fixture of [...fixtures.references, ...fixtures.synthetic])
    expect(normalizeCnpj(fixture.input)).toBe(fixture.normalized);
  // RFB/Serpro Manual de Cálculo do DV, pages 3–4; see fixtures/cnpj.json.
  expect(normalizeCnpj("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
  expect(normalizeCnpj(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35");
  expect(normalizeCnpj("00.000.000/0001-91")).toBe("00000000000191");
  expect(formatCnpj("12ABC34501DE35")).toBe("12.ABC.345/01DE-35");
});
it.each([
  "",
  "00000000000000",
  "11111111111111",
  "12ABC34501DE34",
  "12ABC34501DE3A",
  "12ABC34501DE350",
  "12 ABC34501DE35",
  "12..ABC.345/01DE-35",
  "12ÁBC34501DE35",
  "１２ABC34501DE35",
  "12ABC34501DE35<script>",
])("rejects malformed or invalid identity %s without stripping arbitrary input", (input) => {
  expect(normalizeCnpj(input)).toBeNull();
});
it("keeps operational permissions beneath the member role", () => {
  expect(companyCapabilities("viewer")).toEqual({
    read: true,
    manage: false,
    operateDocuments: false,
  });
  expect(companyCapabilities("developer").operateDocuments).toBe(false);
  expect(companyCapabilities("operator")).toEqual({
    read: true,
    manage: false,
    operateDocuments: true,
  });
  expect(companyCapabilities("admin").manage).toBe(true);
});
