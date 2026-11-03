import { expect, it } from "vite-plus/test";
import {
  formatBRL,
  formatCep,
  formatCompetence,
  formatDateRange,
  formatDateTime,
  formatDateTimeSeconds,
  formatDecimal,
  formatIsoDate,
  formatMoney,
  groupKey,
  shortKey,
  todayInBrasilia,
} from "./format";

it("formats exact decimal text as BRL without floating rounding", () => {
  expect(formatBRL("1234.5")).toBe("R$ 1.234,50");
  expect(formatBRL("0.1")).toBe("R$ 0,10");
  expect(formatBRL("10000")).toBe("R$ 10.000,00");
  expect(formatBRL("-98.1")).toBe("-R$ 98,10");
  expect(formatBRL(null)).toBe("—");
  expect(formatBRL("indisponível")).toBe("indisponível");
});

it("rounds unit prices with up to ten decimals half up to centavos", () => {
  expect(formatBRL("12.3456789012")).toBe("R$\u00a012,35");
  expect(formatBRL("12.3449999999")).toBe("R$\u00a012,34");
  expect(formatBRL("0.995")).toBe("R$\u00a01,00");
  expect(formatBRL("9.999")).toBe("R$\u00a010,00");
  expect(formatBRL("-0.001")).toBe("R$\u00a00,00");
  expect(formatBRL("12345678901234567.89")).toBe("R$\u00a012.345.678.901.234.567,89");
});

it("formats ISO dates without shifting the time zone", () => {
  expect(formatIsoDate("2026-10-02T23:30:00-03:00")).toBe("02/10/2026");
  expect(formatIsoDate("2026-10-02")).toBe("02/10/2026");
  expect(formatIsoDate(null)).toBe("—");
  expect(formatIsoDate("sem data")).toBe("sem data");
});

it("groups and shortens 44-position access keys only", () => {
  const key = "35260912345678000190550010000123451000123459";
  expect(groupKey(key)).toBe("3526 0912 3456 7800 0190 5500 1000 0123 4510 0012 3459");
  expect(shortKey(key)).toBe("…1234 59");
  expect(shortKey("nfse:3550308:12345678000190:A:1")).toBe("nfse:3550308:12345678000190:A:1");
});

it("formats foreign amounts with the ISO code and exact decimals", () => {
  expect(formatMoney("1000.5", "USD")).toBe("USD 1.000,50");
  expect(formatMoney("1000.5", "BRL")).toBe("R$ 1.000,50");
  expect(formatMoney(null, "EUR")).toBe("—");
  expect(formatDecimal("5.123400")).toBe("5,123400");
  expect(formatDecimal("2")).toBe("2");
  expect(formatCompetence("2026-10")).toBe("10/2026");
});

it("takes the civil date of Brasília, not of the browser", () => {
  // 02:30 UTC on 09/10 is still 08/10 in Brasília (UTC-3).
  expect(todayInBrasilia(Date.UTC(2026, 9, 9, 2, 30))).toBe("2026-10-08");
  expect(todayInBrasilia(Date.UTC(2026, 9, 9, 3, 0))).toBe("2026-10-09");
});

it("groups the 50-digit NFS-e access key", () => {
  const key = "35503082211222333000181000000000000126100000000001";
  expect(groupKey(key)).toBe(key.replace(/(.{4})(?=.)/g, "$1 "));
});

it("says a period of one day as that day, and a longer one with both ends", () => {
  const morning = new Date(2026, 9, 26, 8).getTime();
  const evening = new Date(2026, 9, 26, 22).getTime();
  const later = new Date(2026, 9, 28, 9).getTime();
  expect(formatDateRange(morning, evening)).toBe("em 26/10/2026");
  expect(formatDateRange(morning, evening, true)).toBe("Em 26/10/2026");
  expect(formatDateRange(morning, later)).toBe("de 26/10/2026 a 28/10/2026");
  expect(formatDateRange(morning, later, true)).toBe("De 26/10/2026 a 28/10/2026");
});

it("formats date and time with seconds in the same zone as formatDateTime", () => {
  const at = Date.UTC(2026, 9, 8, 15, 12, 7);
  expect(formatDateTimeSeconds(at)).toBe(`${formatDateTime(at)}:07`);
  expect(formatDateTimeSeconds(at + 1_000)).toMatch(/12:08$/);
});

it("formata o CEP de oito dígitos e deixa outro texto como veio", () => {
  expect(formatCep("13010000")).toBe("13010-000");
  expect(formatCep("13010-000")).toBe("13010-000");
  expect(formatCep("1301000")).toBe("1301000");
  expect(formatCep("")).toBe("");
});
