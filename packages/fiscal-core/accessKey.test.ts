import { describe, expect, it } from "vite-plus/test";
import { accessKeyDigit, accessKeyNumber } from "./src/index";

// Synthetic keys: the corpus summary (series 1, number 69) and variations with a valid digit.
const corpus = "35260911222333000181550010000000691123456787";
const withDigit = (base: string) => base + accessKeyDigit(base);
describe("access key number (#462)", () => {
  it("reads series and number, without the padding zeros", () => {
    expect(accessKeyNumber(corpus)).toEqual({
      series: "1",
      number: "69",
    });
    expect(accessKeyNumber(withDigit("3526091122233300018155000123456789112345678"))).toEqual({
      series: "0",
      number: "123456789",
    });
    expect(accessKeyNumber(withDigit("3526091122233300018155999100000000112345678"))).toEqual({
      series: "999",
      number: "100000000",
    });
    // CNPJ alfanumérico (NT 2025.001) in positions 7 to 20.
    expect(accessKeyNumber(withDigit("35260912ABC34501DE3555002000001234112345678"))).toEqual({
      series: "2",
      number: "1234",
    });
  });
  it.each([
    ["wrong check digit", corpus.slice(0, 43) + "0"],
    ["another model", withDigit("3526091122233300018165001000000069112345678")],
    ["zero number", withDigit("3526091122233300018155001000000000112345678")],
    ["43 positions", "3526091122233300018155001000000069112345678"],
    ["letters out of the CNPJ", corpus.slice(0, 30) + "A" + corpus.slice(31)],
    ["NFS-e identity", "nfse:3550308:11222333000181::69"],
    ["empty", ""],
  ])("refuses %s", (_, key) => expect(accessKeyNumber(key)).toBeNull());
});
