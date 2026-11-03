import { createHash } from "node:crypto";
import type { CheckResult } from "@freecorps/fiscal-core";
import { decodeXml, NfeError } from "./xml.js";
import { parseNfeModel } from "./parser.js";
import { normalizeNfe } from "./normalize.js";
import { validateIdentity } from "./identity.js";
import { validateSchema } from "./schema.js";
import { verifyNfeSignature } from "./signature.js";
import { PARSER_VERSION, type ProcessedNfe, type Source } from "./types.js";

const pending = (): CheckResult => ({ status: "not_checked", code: "NOT_CHECKED" });
/** Technical checks are independent. No result here represents a live fiscal query. */
export function processNfe(
  bytes: Uint8Array,
  options: { source?: Source; evaluatedAt?: string } = {},
): ProcessedNfe {
  const result: ProcessedNfe = {
    metadata: null,
    parsing: null,
    normalized: null,
    checks: {
      parsing: pending(),
      normalization: pending(),
      xsd: pending(),
      identity: pending(),
      signature: pending(),
      certificateTrust: pending(),
      certificateTime: pending(),
      fiscalEvidence: pending(),
      originTrust: { status: "not_checked", code: "FISCAL_ORIGIN_NOT_AUTHENTICATED" },
    },
    signature: {
      referenceId: null,
      referenceSha256: null,
      certificateSha256: null,
      evaluatedAt: options.evaluatedAt ?? null,
    },
  };
  try {
    const parsed = parseNfeModel(bytes, options.source),
      xml = decodeXml(bytes);
    result.parsing = parsed;
    result.metadata = parsed.metadata;
    result.checks.parsing = { status: "passed", code: "XML_PARSED" };
    result.checks.xsd = validateSchema(xml, parsed);
    result.checks.identity = validateIdentity(xml, parsed);
    const signature = verifyNfeSignature(xml, parsed, options.evaluatedAt ?? null);
    result.checks.signature = signature.integrity;
    result.checks.certificateTrust = signature.trust;
    result.checks.certificateTime = signature.time;
    result.signature = {
      referenceId: signature.referenceId,
      referenceSha256: signature.referenceSha256,
      certificateSha256: signature.certificateSha256,
      evaluatedAt: signature.evaluatedAt,
    };
    if (signature.authenticatedXml) {
      const authenticated = parseNfeModel(
        new TextEncoder().encode(signature.authenticatedXml),
        options.source,
      );
      // Derived from the signed reference, while source provenance still identifies the original bytes.
      authenticated.metadata.originalSha256 = parsed.metadata.originalSha256;
      result.parsing = authenticated;
    }
    try {
      result.normalized = normalizeNfe(result.parsing!);
    } catch {
      result.checks.normalization = { status: "failed", code: "NORMALIZATION_INVALID" };
    }
    if (result.normalized) {
      result.checks.normalization = { status: "passed", code: "NORMALIZATION_VALID" };
      result.metadata = result.normalized.metadata;
    }
    const doc = parsed.document;
    const hasEvidence =
      doc.kind === "invoice"
        ? doc.protocol !== null
        : doc.kind === "event"
          ? doc.receipt !== null
          : true;
    result.checks.fiscalEvidence = !hasEvidence
      ? { status: "not_checked", code: "FISCAL_EVIDENCE_ABSENT" }
      : result.checks.identity.status !== "passed" || result.checks.xsd.status !== "passed"
        ? { status: "failed", code: "FISCAL_EVIDENCE_INCONSISTENT" }
        : { status: "passed", code: "PRESERVED_FISCAL_CLAIM_CONSISTENT" };
    return result;
  } catch (error) {
    const code = error instanceof NfeError ? error.code : "XML_PROCESSING_FAILED";
    result.checks.parsing = {
      status: code.includes("UNSUPPORTED") ? "unsupported" : "failed",
      code,
    };
    // Retain parser/source versions even for rejected XML; no XML or exception text escapes.
    if (bytes instanceof Uint8Array && bytes.byteLength <= 2 * 1024 * 1024)
      result.metadata = {
        model: null,
        source: options.source ?? "imported-xml",
        originalSha256: createHash("sha256").update(bytes).digest("hex"),
        versions: { parser: PARSER_VERSION, normalizer: null, schema: null },
        unsupportedFields: [],
      };
    return result;
  }
}
