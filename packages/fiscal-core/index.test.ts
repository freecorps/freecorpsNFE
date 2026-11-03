import { describe, expect, it } from "vite-plus/test";
import { add, decimal, multiply, quantize, normalizeCnpj } from "./src/index";

describe("exact decimal public contract", () => {
  it("preserves declared scale and leading zeros across JSON", () => {
    const value = decimal("000012.3456789012");
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      coefficient: "123456789012",
      scale: 10,
      declared: "000012.3456789012",
    });
    expect(quantize(value, 10, "reject")).toBe("12.3456789012");
    expect(add(decimal("0.1"), decimal("0.2"))).toEqual(decimal("0.3"));
    expect(add(decimal("999999999999999999.99"), decimal("0.01"))).toEqual(
      decimal("1000000000000000000.00"),
    );
  });
  it.each([
    ["1.225", "half-even", "1.22"],
    ["1.235", "half-even", "1.24"],
    ["-1.225", "half-up", "-1.23"],
    ["-1.225", "truncate", "-1.22"],
    ["1.2300", "reject", "1.23"],
  ] as const)("rounds %s with %s explicitly", (input, rounding, result) =>
    expect(quantize(decimal(input), 2, rounding)).toBe(result),
  );
  it("multiplies exactly, summing scales, and rounds only through quantize", () => {
    expect(multiply(decimal("0.1"), decimal("0.2"))).toEqual(decimal("0.02"));
    expect(multiply(decimal("49.00"), decimal("5.4321"))).toEqual(decimal("266.172900"));
    expect(quantize(multiply(decimal("49.00"), decimal("5.4321")), 2, "half-up")).toBe("266.17");
    expect(multiply(decimal("-1.5"), decimal("2"))).toEqual(decimal("-3.0"));
    expect(multiply(decimal("0.01"), decimal("-0.5"))).toEqual(decimal("-0.005"));
    expect(multiply(decimal("9007199254740993"), decimal("3"))).toEqual(
      decimal("27021597764222979"),
    );
    // 0.1 × 3 em float dá 0.30000000000000004.
    expect(multiply(decimal("0.1"), decimal("3"))).toEqual(decimal("0.3"));
    expect(() => multiply(decimal("1." + "1".repeat(11)), decimal("1." + "1".repeat(10)))).toThrow(
      "DECIMAL_SCALE",
    );
    expect(() => multiply(decimal("9".repeat(21)), decimal("9".repeat(21)))).toThrow(
      "DECIMAL_INVALID",
    );
    expect(() => multiply({ ...decimal("1"), coefficient: "2" }, decimal("1"))).toThrow(
      "DECIMAL_INVALID",
    );
  });
  it("refuses precision loss, forged decimals and unbounded exponents", () => {
    expect(() => quantize(decimal("1.231"), 2, "reject")).toThrow("DECIMAL_PRECISION_LOSS");
    expect(() => quantize({ ...decimal("1"), coefficient: "2" }, 2, "reject")).toThrow(
      "DECIMAL_INVALID",
    );
    for (const value of ["1e3", "NaN", "Infinity", "1,23", "9".repeat(41), "1." + "1".repeat(21)])
      expect(() => decimal(value)).toThrow();
    expect(normalizeCnpj("12ABC34501DE35")).toBe("12ABC34501DE35");
    expect(normalizeCnpj("12ABC34501DE00")).toBeNull();
  });
});
