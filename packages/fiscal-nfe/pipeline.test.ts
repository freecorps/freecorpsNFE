import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { corpus, fixture } from "../../tests/helpers/nfe-corpus";
import {
  processNfe,
  parseNfeModel,
  normalizeNfe,
  deriveFiscalSituation,
  NORMALIZER_VERSION,
  PARSER_VERSION,
} from "./src/index";
import { LIMITS } from "./src/xml";
import { accessKeyDigit } from "./src/identity";
import { proveExcludedEvents } from "../../scripts/lib/nfe-situation-proof.mjs";

const process = (id: string) =>
  processNfe(fixture(id), { source: "synthetic", evaluatedAt: corpus.evaluatedAt });
describe("shared NF-e corpus", () => {
  it("handles wide tax groups within input limits and preserves repeated field paths", () => {
    const xml = fixture("invoice-unsigned")
      .toString()
      .replace(
        /<imposto>[\s\S]*?<\/imposto>/,
        "<imposto>" + "<extra>0</extra>".repeat(20_000) + "</imposto>",
      );
    const result = processNfe(Buffer.from(xml));
    expect(result.checks.parsing.status).toBe("passed");
    expect(result.checks.xsd.code).toBe("XSD_INVALID");
    if (result.parsing?.document.kind !== "invoice") throw new Error("fixture kind");
    const taxes = result.parsing.document.products[0]!.taxes;
    expect(taxes).toHaveLength(20_000);
    expect(taxes[0]).toMatchObject({ path: "extra[0]", value: "0" });
    expect(taxes.at(-1)).toMatchObject({ path: "extra[19999]", value: "0" });
    expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
  });
  it.each(["invoice-signed", "summary-authorized", "event-110111", "event-summary"])(
    "checks key components independently of check digit and document kind: %s",
    (id) => {
      const original = fixture(id).toString();
      const key = process(id).parsing!.document.key;
      for (const [start, end, replacement] of [
        [0, 2, "99"],
        [4, 6, "00"],
        [4, 6, "13"],
        [25, 34, "000000000"],
        [34, 35, "8"],
      ] as const) {
        const base = key.slice(0, start) + replacement + key.slice(end, 43);
        const result = processNfe(
          Buffer.from(original.replaceAll(key, base + accessKeyDigit(base))),
        );
        expect(result.checks.parsing.status).toBe("passed");
        expect(result.checks.identity.code).toBe("NFE_KEY_COMPONENT_INVALID");
        expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
      }
    },
  );
  it("keeps the order of the key checks now shared with fiscal-core (#296)", () => {
    const original = fixture("summary-authorized").toString();
    const key = process("summary-authorized").parsing!.document.key;
    const identity = (base: string, xml = original.replaceAll(key, base + accessKeyDigit(base))) =>
      processNfe(Buffer.from(xml)).checks.identity.code;
    // Last check digit of the issuer's CNPJ changed: neither a CNPJ nor a CPF.
    const badIssuer = key.slice(0, 19) + String((Number(key[19]) + 1) % 10) + key.slice(20, 43);
    const issuedBefore = original
      .replaceAll(key, badIssuer + accessKeyDigit(badIssuer))
      .replace("<dhEmi>2026-09", "<dhEmi>2026-08");
    // The issue month differs from dhEmi and the issuer is invalid: the month is reported first.
    expect(identity(badIssuer, issuedBefore)).toBe("NFE_KEY_ISSUED_AT_MISMATCH");
    expect(identity(badIssuer)).toBe("NFE_KEY_CNPJ_INVALID");
    expect(identity(key.slice(0, 20) + "65" + key.slice(22, 43))).toBe("NFE_MODEL_MISMATCH");
  });
  it("matches the key month to the declared issue date, not the event date", () => {
    const summary = fixture("summary-authorized")
      .toString()
      .replace("<dhEmi>2026-09", "<dhEmi>2026-08");
    const result = processNfe(Buffer.from(summary));
    expect(result.checks.xsd.status).toBe("passed");
    expect(result.checks.identity.code).toBe("NFE_KEY_ISSUED_AT_MISMATCH");
    expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
    const event = fixture("event-110111")
      .toString()
      .replace("<dhEvento>2026-09", "<dhEvento>2026-10");
    expect(processNfe(Buffer.from(event)).checks.identity.status).toBe("passed");
  });
  it.each(corpus.cases)("$id matches pinned stages and source bytes", (entry) => {
    const bytes = fixture(entry.id),
      copy = Buffer.from(bytes),
      result = process(entry.id);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    for (const [stage, expected] of Object.entries(entry.expected))
      expect(result.checks[stage as keyof typeof result.checks].status).toBe(expected);
    expect(bytes.equals(copy)).toBe(true);
    for (const [stage, code] of Object.entries(entry.expectedCodes))
      expect(result.checks[stage as keyof typeof result.checks].code).toBe(code);
    if (entry.id !== "bytes-limit") expect(result.metadata?.versions.parser).toBe(corpus.parser);
    expect(result.checks.certificateTrust.status).toBe("not_checked");
    expect(JSON.stringify(result.checks)).not.toContain("<");
  });
  it("parses domain-specific fields and normalizes without mutation", () => {
    const bytes = fixture("invoice-authorized"),
      parsed = parseNfeModel(bytes, "synthetic");
    const original = JSON.stringify(parsed);
    const freeze = (value: unknown) => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(parsed);
    const normalized = normalizeNfe(parsed);
    expect(JSON.stringify(parsed)).toBe(original);
    expect(parsed.metadata.versions.normalizer).toBeNull();
    expect(normalized.metadata.versions.normalizer).toBe(NORMALIZER_VERSION);
    if (parsed.document.kind !== "invoice" || normalized.document.kind !== "invoice")
      throw new Error("fixture kind");
    expect(parsed.document.products[0]).toMatchObject({
      cest: "1709700",
      purchaseOrder: "PEDIDO-69",
      purchaseOrderItem: "000069",
      unitPrice: "12.3456789012",
    });
    expect(parsed.document.products[0]!.taxes).toContainEqual({
      path: "ICMS.ICMSSN102.CSOSN",
      value: "102",
      representation: "code",
    });
    expect(normalized.document.products[0]!.unitPrice).toEqual({
      coefficient: "123456789012",
      scale: 10,
      declared: "12.3456789012",
    });
    expect(normalized.metadata.unsupportedFields).toContain("infNFe.transp");
    expect(process("invoice-authorized").metadata?.versions).toMatchObject({
      parser: PARSER_VERSION,
      normalizer: NORMALIZER_VERSION,
    });
    expect(() =>
      normalizeNfe({
        ...parsed,
        metadata: {
          ...parsed.metadata,
          versions: { ...parsed.metadata.versions, parser: "future" },
        },
      }),
    ).toThrow();
  });
  it("separates signature integrity, chain trust and explicit time", () => {
    const bytes = fixture("invoice-signed");
    expect(processNfe(bytes).checks.certificateTime.status).toBe("not_checked");
    const expired = processNfe(bytes, { evaluatedAt: "2041-01-01T00:00:00Z" });
    expect(expired.checks.signature.status).toBe("passed");
    expect(expired.checks.certificateTime.code).toBe("CERTIFICATE_OUTSIDE_VALIDITY");
    expect(expired.checks.certificateTrust.status).toBe("not_checked");
    expect(deriveFiscalSituation([process("invoice-signed")]).reportedStatus).toBe("unknown");
  });
  it("normalizes ad rem taxation using the pinned field type", () => {
    const result = process("invoice-monophase");
    if (result.normalized?.document.kind !== "invoice") throw new Error("fixture kind");
    expect(result.normalized.document.products[0]!.taxes).toContainEqual({
      path: "ICMS.ICMS02.adRemICMS",
      representation: "decimal",
      value: { declared: "1.2345", coefficient: "12345", scale: 4 },
    });
  });
  it.each([
    ["bytes", () => new Uint8Array(LIMITS.bytes + 1), "XML_TOO_LARGE"],
    ["encoding", () => new Uint8Array([0xc3, 0x28]), "XML_ENCODING_INVALID"],
    [
      "depth",
      () => new TextEncoder().encode("<a>".repeat(65) + "</a>".repeat(65)),
      "XML_LIMIT_EXCEEDED",
    ],
    [
      "nodes",
      () => new TextEncoder().encode("<a>" + "<b/>".repeat(50_000) + "</a>"),
      "XML_LIMIT_EXCEEDED",
    ],
  ] as const)("rejects %s limits before processing", (_label, bytes, code) => {
    const result = processNfe(bytes());
    expect(result.checks.parsing.code).toBe(code);
    expect(result.normalized).toBeNull();
    expect(result.checks.signature.status).toBe("not_checked");
  });
  it("does not fetch schemaLocation from an XML document", () => {
    const summary = fixture("summary-authorized")
      .toString()
      .replace(
        "<resNFe ",
        '<resNFe xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.portalfiscal.inf.br/nfe https://example.invalid/evil.xsd" ',
      );
    expect(processNfe(new TextEncoder().encode(summary)).checks.xsd.status).toBe("passed");
  });
  it("rejects a comma in an event access key despite the unused historical XSD type", () => {
    const original = fixture("event-110111").toString();
    const key = /<chNFe>([0-9]{44})<\/chNFe>/.exec(original)?.[1];
    if (!key) throw new Error("fixture key");
    const xml = original.replaceAll(key, "3," + key.slice(2));
    const result = processNfe(new TextEncoder().encode(xml));
    expect(result.checks.parsing.status).toBe("passed");
    expect(result.checks.xsd).toMatchObject({ status: "failed", code: "XSD_INVALID" });
    expect(result.checks.identity).toMatchObject({ status: "failed", code: "NFE_KEY_INVALID" });
    expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
  });
  it.each(["#other", "https://example.invalid/signed.xml", ""])(
    "refuses a signature reference %s",
    (uri) => {
      const xml = fixture("invoice-signed")
        .toString()
        .replace(/URI="#[^"]+"/, `URI="${uri}"`);
      const result = processNfe(new TextEncoder().encode(xml));
      expect(result.checks.signature.status).toBe("failed");
      expect(deriveFiscalSituation([result]).reportedStatus).toBe("unknown");
    },
  );
  it("pins raw XSD and converted runtime bytes", () => {
    const base = new URL("schemas/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")) as {
      files: Array<{ path: string; sha256: string; runtimeUtf8Sha256: string }>;
    };
    const catalog = JSON.parse(
      readFileSync(new URL("src/schemas.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    const policy = JSON.parse(
      readFileSync(new URL("src/schema-policy.json", import.meta.url), "utf8"),
    ) as { catalogSha256: string };
    expect(
      createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
          ),
        )
        .digest("hex"),
    ).toBe(policy.catalogSha256);
    for (const file of manifest.files) {
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(file.path, base)))
          .digest("hex"),
      ).toBe(file.sha256);
      expect(createHash("sha256").update(catalog[file.path]!).digest("hex")).toBe(
        file.runtimeUtf8Sha256,
      );
    }
  });
});

describe("deterministic preserved fiscal situation", () => {
  it("excludes conflicting rejected XML and preserves accepted conflicts across orders", () => {
    proveExcludedEvents(
      corpus.cases.map(({ id }) => ({ id, result: process(id) })),
      deriveFiscalSituation,
    );
  });
  it("cancellation prevails independently of arrival order and duplicates", () => {
    const authorized = process("invoice-authorized"),
      cancel = process("event-110111"),
      correction = process("event-110110");
    const expected = deriveFiscalSituation([authorized, cancel, correction]);
    expect(expected).toMatchObject({
      reportedStatus: "cancelled",
      basis: "preserved-claims",
      liveConsultation: false,
    });
    for (const order of [
      [cancel, correction, authorized],
      [correction, authorized, cancel],
      [cancel, authorized, cancel, correction],
    ])
      expect(deriveFiscalSituation(order)).toEqual(expected);
  });
  it("keeps absent, rejected and conflicting evidence explicit", () => {
    expect(deriveFiscalSituation([]).reportedStatus).toBe("unknown");
    expect(
      deriveFiscalSituation([process("invoice-authorized"), process("cancellation-rejected")])
        .reportedStatus,
    ).toBe("authorized");
    expect(
      deriveFiscalSituation([process("summary-authorized"), process("summary-denied")]).conflicts,
    ).toContain("FISCAL_STATUS_CONFLICT");
    const first = process("summary-authorized"),
      disagree = structuredClone(first);
    disagree.checks.xsd.status = "failed";
    expect(deriveFiscalSituation([first, disagree]).reportedStatus).toBe("conflict");
    expect(() => deriveFiscalSituation([], "future")).toThrow("FISCAL_RULE_UNSUPPORTED");
    expect(
      deriveFiscalSituation([process("event-summary"), process("event-summary-conflict")])
        .reportedStatus,
    ).toBe("conflict");
    expect(
      deriveFiscalSituation([process("event-summary"), process("event-110111")]).reportedStatus,
    ).toBe("cancelled");
    expect(
      deriveFiscalSituation([process("event-110111"), process("cancellation-rejected")])
        .reportedStatus,
    ).toBe("cancelled");
    expect(
      deriveFiscalSituation([process("summary-authorized"), process("summary-conflicting-total")])
        .conflicts,
    ).toContain("IMMUTABLE_CLAIM_CONFLICT:TOTAL");
  });
  it("excluded rejected events cannot introduce author, time or identity conflicts", () => {
    const rejected = process("cancellation-rejected");
    if (rejected.parsing?.document.kind !== "event" || !rejected.metadata)
      throw new Error("fixture kind");
    rejected.parsing.document.author.document = "00000000000191";
    rejected.parsing.document.occurredAt = "2026-09-01T12:00:00-03:00";
    rejected.signature.referenceSha256 = "e".repeat(64);
    const accepted = process("event-110111"),
      authorized = process("invoice-authorized");
    for (const order of [
      [authorized, rejected, accepted],
      [accepted, rejected, authorized],
    ]) {
      const result = deriveFiscalSituation(order);
      expect(result.reportedStatus).toBe("cancelled");
      expect(result.ruleVersion).toBe("nfe-status/2");
      // The earlier rule stays reproducible and agrees wherever no catalog replacement applies.
      expect({
        ...deriveFiscalSituation(order, "nfe-status/1"),
        ruleVersion: "nfe-status/2",
      }).toEqual(result);
      expect(result.conflicts).toEqual([]);
      expect(result.excluded).toContainEqual({
        id: rejected.metadata.originalSha256,
        reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS",
      });
    }
  });
  it("does not hide unsigned fiscal origin or let deduplication depend on order", () => {
    const original = process("invoice-authorized"),
      changed = structuredClone(original);
    changed.signature.referenceSha256 = "f".repeat(64);
    const a = deriveFiscalSituation([original, changed]),
      b = deriveFiscalSituation([changed, original]);
    expect(a).toEqual(b);
    expect(a.reportedStatus).toBe("conflict");
    expect(a.assurance).toBe("unverified-origin");
    expect(original.checks.originTrust.status).toBe("not_checked");
    const forged = fixture("cancellation-rejected")
      .toString()
      .replace("<cStat>573</cStat>", "<cStat>135</cStat>");
    const result = processNfe(new TextEncoder().encode(forged));
    expect(result.checks.signature.status).toBe("passed");
    expect(result.checks.originTrust.status).toBe("not_checked");
    expect(deriveFiscalSituation([result])).toMatchObject({
      reportedStatus: "cancelled",
      assurance: "unverified-origin",
      liveConsultation: false,
    });
  });
});
