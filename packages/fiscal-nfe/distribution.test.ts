import { expect, it } from "vite-plus/test";
import {
  distributionRequest,
  parseDistribution,
  distribute,
  normalizeNsu,
} from "./src/distribution";
import { distributionXml, nsu } from "../../tests/helpers/distribution";
import { fixture } from "../../tests/helpers/nfe-corpus";
it("executes independently with injected transport and no hidden cursor", async () => {
  const requests: string[] = [];
  const credential = { synthetic: true };
  const input = {
    cnpj: "00000000000191",
    environment: "sandbox" as const,
    nsu: "0",
    credential,
    transport: async (r: ReturnType<typeof distributionRequest>, c: typeof credential) => {
      expect(c).toBe(credential);
      requests.push(r.body);
      return distributionXml({ envelopes: [{ nsu: 1, xml: fixture("summary-authorized") }] });
    },
  };
  const a = await distribute(input),
    b = await distribute(input);
  expect(a.lastNsu).toBe(nsu(1));
  expect(b.envelopes[0]!.sha256).toBe(a.envelopes[0]!.sha256);
  expect(requests[0]).toBe(requests[1]);
  expect(input.nsu).toBe("0");
});
it("uses alphanumeric CNPJ, explicit environments and point reconciliation", () => {
  expect(
    distributionRequest({
      cnpj: "12ABC34501DE35",
      environment: "sandbox",
      nsu: "123",
      mode: "consNSU",
    }).body,
  ).toContain(`<consNSU><NSU>${nsu(123)}</NSU></consNSU>`);
  expect(() =>
    distributionRequest({ cnpj: "invalid", environment: "sandbox", nsu: "0" }),
  ).toThrow();
  expect(() => normalizeNsu("9007199254740991")).toThrow();
  expect(normalizeNsu("999999999999999")).toBe("999999999999999");
});
it.each(["137", "656", "108", "109", "593"])("preserves source response %s", (status) => {
  expect(parseDistribution(distributionXml({ status }), "sandbox")).toMatchObject({
    status,
    envelopes: [],
  });
});
it.each(["summary-authorized", "invoice-authorized", "event-110111", "event-summary"])(
  "preserves exact corpus bytes for %s",
  (id) => {
    const xml = fixture(id);
    const result = parseDistribution(distributionXml({ envelopes: [{ nsu: 1, xml }] }), "sandbox");
    expect(Buffer.from(result.envelopes[0]!.xml).equals(xml)).toBe(true);
  },
);
it("rejects unsafe XML, wrong environment, repeated and unordered NSU, excess envelopes", () => {
  expect(() =>
    parseDistribution(
      Buffer.from('<!DOCTYPE root [<!ENTITY x SYSTEM "file:///secret">]><root/>'),
      "sandbox",
    ),
  ).toThrow();
  expect(() => parseDistribution(distributionXml({ environment: "1" }), "sandbox")).toThrow(
    "ENVIRONMENT",
  );
  for (const values of [[1, 1], [2, 1], Array.from({ length: 51 }, (_, i) => i + 1)])
    expect(() =>
      parseDistribution(
        distributionXml({ envelopes: values.map((n) => ({ nsu: n, xml: "<ok/>" })) }),
        "sandbox",
      ),
    ).toThrow();
});
it("bounds gzip expansion and refuses entities within docZip", () => {
  expect(() =>
    parseDistribution(
      distributionXml({ envelopes: [{ nsu: 1, xml: `<x>${"a".repeat(100_000)}</x>` }] }),
      "sandbox",
    ),
  ).toThrow("EXPANSION");
  expect(() =>
    parseDistribution(
      distributionXml({ envelopes: [{ nsu: 1, xml: fixture("doctype") }] }),
      "sandbox",
    ),
  ).toThrow("XML_UNSAFE");
});
it("rejects missing or blank docZip schema before returning envelopes", () => {
  const response = distributionXml({ envelopes: [{ nsu: 1, xml: "<ok/>" }] }).toString();
  expect(() =>
    parseDistribution(Buffer.from(response.replace(/ schema="[^"]*"/, "")), "sandbox"),
  ).toThrow("DISTRIBUTION_SCHEMA_INVALID");
  for (const schema of ["", "   "])
    expect(() =>
      parseDistribution(
        distributionXml({ envelopes: [{ nsu: 1, xml: "<ok/>", schema }] }),
        "sandbox",
      ),
    ).toThrow("DISTRIBUTION_RESPONSE_INVALID");
});
