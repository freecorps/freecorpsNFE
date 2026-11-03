import { decimal, quantize } from "@freecorps/fiscal-core";
import { undeclaredRepresentation } from "./parser.js";
import {
  RULE_VERSION,
  RULE_VERSIONS,
  type DeclaredTaxField,
  type FiscalRuleVersion,
  type NfeModel,
  type ProcessedNfe,
} from "./types.js";

export interface FiscalSituation {
  ruleVersion: FiscalRuleVersion;
  key: string | null;
  reportedStatus: "unknown" | "authorized" | "cancelled" | "denied" | "conflict";
  basis: "preserved-claims";
  assurance: "unverified-origin";
  liveConsultation: false;
  evidenceIds: string[];
  excluded: Array<{ id: string; reason: string }>;
  conflicts: string[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/**
 * Fields the parser learned after evidence was already fingerprinted. They describe the document
 * without changing a fiscal claim, so leaving them out keeps every earlier fingerprint valid:
 * reprocessing an old original must not turn into a processing disagreement.
 */
function claims(document: NfeModel | undefined) {
  if (document?.kind !== "invoice") return document;
  const {
    purpose: _purpose,
    nt2026008: _total,
    nt2026006: _paymentLink,
    products,
    ...rest
  } = document;
  return {
    ...rest,
    products: products.map(({ nt2026008: _item, ...product }) => product),
  };
}
/** Canonical interpretation used to detect disagreements for the same original bytes. */
export function fiscalEvidenceIdentity(item: ProcessedNfe): string {
  return canonical({
    document: claims(item.parsing?.document),
    parsing: item.checks.parsing,
    xsd: item.checks.xsd,
    referenceSha256: item.signature.referenceSha256,
    identity: item.checks.identity,
    signature: item.checks.signature,
    fiscalEvidence: item.checks.fiscalEvidence,
  });
}
/**
 * Schema catalogs this package has pinned, oldest first. Each interpretation records its
 * catalog in `metadata.versions.schema.catalogSha256`; the order comes from this list, never
 * from processing dates. A catalog missing here is neither older nor newer than another.
 * `decimalFieldsAdded` lists the schema-policy paths that this catalog types as decimal and the
 * previous one did not. Incorporating a catalog appends it; a test requires the runtime catalog
 * to be the last entry.
 */
export const SCHEMA_CATALOGS: ReadonlyArray<{
  catalogSha256: string;
  /** NF-e layout package of the catalog; event packages change the hash too. */
  package: string;
  note: string;
  decimalFieldsAdded: readonly string[];
}> = [
  {
    catalogSha256: "1e871ba26cdaa7367b6a8e670f3ad8f2185508cb9ab7eac3e4bc1aa690375cc8",
    package: "nfe-4.00-010f",
    note: "First pinned catalog (12/09/2026), events from PL_Evento 010d_v1.01",
    decimalFieldsAdded: [],
  },
  {
    catalogSha256: "de9e3831b77c933621d28a20b1bea884ce27964efa46b8167027ced69fcd6b18",
    package: "nfe-4.00-010f",
    note: "Events envelope from 010d_v1.03 and RTC events 1.40 (#389); same decimal policy",
    decimalFieldsAdded: [],
  },
  {
    catalogSha256: "0122a63a3b4b670b20574b9ad7d697954f9f1b3ecdf9ef432c0d4ce9c762df4a",
    package: "nfe-4.00-010g",
    note: "PL_010g v1.03, NT 2026.006 and NT 2026.008 (#395)",
    decimalFieldsAdded: [
      "imposto.ICMS.ICMSPrevistoPagtoAntecip.vICMSPrevisto",
      "total.vProdLiqTot",
    ],
  },
  {
    catalogSha256: "4ffaa6a79dc4e99f6e07662f8629ffe9adb8fbb68ca59e920c70ed197765a4d1",
    package: "nfe-4.00-010g",
    note: "PL_010g Evento/: detail of event 110300 and its tiposBasico_v1.03 (#405); same decimal policy",
    decimalFieldsAdded: [],
  },
];
function catalogRank(item: ProcessedNfe): number {
  const sha = item.metadata?.versions.schema?.catalogSha256;
  return SCHEMA_CATALOGS.findIndex((catalog) => catalog.catalogSha256 === sha);
}
/**
 * `item`, accepted by its catalog, as the catalog at `older` would have processed the same bytes
 * if it refused them at the XSD step: XSD and the fiscal evidence check that depends on it fail,
 * and the generic fields typed by later catalogs lose the decimal representation.
 */
function refusedByOlderCatalog(item: ProcessedNfe, older: number): ProcessedNfe {
  const added = new Set(
    SCHEMA_CATALOGS.slice(older + 1, catalogRank(item) + 1).flatMap(
      (catalog) => catalog.decimalFieldsAdded,
    ),
  );
  const retype =
    (group: "imposto" | "total") =>
    (field: DeclaredTaxField): DeclaredTaxField => {
      const path = field.path.replace(/\[\d+\]/g, "");
      return added.has(group + "." + path)
        ? { ...field, representation: undeclaredRepresentation(path.split(".").at(-1)!) }
        : field;
    };
  const document = item.parsing?.document;
  return {
    ...item,
    parsing:
      item.parsing && document?.kind === "invoice"
        ? {
            ...item.parsing,
            document: {
              ...document,
              totals: document.totals.map(retype("total")),
              products: document.products.map((product) => ({
                ...product,
                taxes: product.taxes.map(retype("imposto")),
              })),
            },
          }
        : item.parsing,
    checks: {
      ...item.checks,
      xsd: { status: "failed", code: "XSD_INVALID" },
      fiscalEvidence:
        item.checks.fiscalEvidence.status === "not_checked"
          ? item.checks.fiscalEvidence
          : { status: "failed", code: "FISCAL_EVIDENCE_INCONSISTENT" },
    },
  };
}
/**
 * `nfe-status/2`: fingerprints of `others` that `current` replaces. `current` must be a complete
 * interpretation (items and totals intact) that passed the XSD step; `others` may be compact
 * snapshots, since only their catalog is read and their fingerprint does the comparison. An
 * interpretation is replaced when its catalog is older and its fingerprint is exactly the one
 * `current` would have had if that catalog had refused the bytes at the XSD step. Any other
 * difference (total, items, another technical step, two accepted interpretations, or a newer
 * catalog refusing what an older one accepted) keeps both, and the caller reports a conflict.
 */
export function replacedInterpretations(
  current: ProcessedNfe,
  others: ReadonlyArray<{ fingerprint: string; evidence: ProcessedNfe }>,
  fingerprintOf: (identity: string) => string,
): Set<string> {
  const replaced = new Set<string>();
  const rank = catalogRank(current);
  if (rank < 0 || current.checks.xsd.status !== "passed") return replaced;
  for (const { fingerprint, evidence } of others) {
    const older = catalogRank(evidence);
    if (older < 0 || older >= rank) continue;
    if (
      fingerprintOf(fiscalEvidenceIdentity(refusedByOlderCatalog(current, older))) === fingerprint
    )
      replaced.add(fingerprint);
  }
  return replaced;
}
function assertRule(ruleVersion: string): asserts ruleVersion is FiscalRuleVersion {
  if (!(RULE_VERSIONS as readonly string[]).includes(ruleVersion))
    throw new Error("FISCAL_RULE_UNSUPPORTED");
}
/** Rebuild a reported situation from preserved evidence, never from arrival order or wall clock. */
export function deriveFiscalSituation(
  evidence: readonly ProcessedNfe[],
  ruleVersion: string = RULE_VERSION,
): FiscalSituation {
  assertRule(ruleVersion);
  const result: FiscalSituation = {
    ruleVersion,
    key: null,
    reportedStatus: "unknown",
    basis: "preserved-claims",
    assurance: "unverified-origin",
    liveConsultation: false,
    evidenceIds: [],
    excluded: [],
    conflicts: [],
  };
  const grouped = new Map<string, Map<string, ProcessedNfe>>();
  for (const item of evidence) {
    const id = item.metadata?.originalSha256;
    if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new Error("FISCAL_EVIDENCE_ID_INVALID");
    const versions = grouped.get(id) ?? new Map<string, ProcessedNfe>();
    // Normalization upgrades and certificate evaluation instants do not manufacture new fiscal evidence.
    versions.set(fiscalEvidenceIdentity(item), item);
    grouped.set(id, versions);
  }
  const keys = new Set<string>(),
    environments = new Set<string>(),
    statuses = new Set<string>(),
    protocols = new Set<string>();
  const immutable = new Map<string, Set<string>>();
  const claim = (field: string, value: string) => {
    const values = immutable.get(field) ?? new Set<string>();
    values.add(value);
    immutable.set(field, values);
  };
  const cancellations: string[] = [];
  const eventIdentities = new Map<string, Set<string>>();
  const add = (id: string, status: string) => {
    result.evidenceIds.push(id);
    statuses.add(status);
  };
  for (const [id, versions] of [...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const current = new Map(versions);
    if (ruleVersion !== "nfe-status/1" && versions.size > 1) {
      const all = [...versions].map(([fingerprint, evidence]) => ({ fingerprint, evidence }));
      for (const { evidence } of all)
        for (const fingerprint of replacedInterpretations(evidence, all, (identity) => identity))
          current.delete(fingerprint);
    }
    if (current.size > 1) {
      result.conflicts.push("PROCESSING_DISAGREEMENT:" + id);
      continue;
    }
    const item = current.values().next().value!;
    const doc = item.parsing?.document;
    if (
      !doc ||
      [item.checks.parsing, item.checks.xsd, item.checks.identity].some(
        (c) => c.status !== "passed",
      )
    ) {
      result.excluded.push({ id, reason: "TECHNICAL_VALIDATION_FAILED" });
      continue;
    }
    if (
      (doc.kind === "invoice" || doc.kind === "event") &&
      item.checks.signature.status !== "passed"
    ) {
      result.excluded.push({ id, reason: "SIGNATURE_NOT_VERIFIED" });
      continue;
    }
    if (item.checks.fiscalEvidence.status !== "passed") {
      result.excluded.push({ id, reason: "FISCAL_EVIDENCE_ABSENT_OR_INVALID" });
      continue;
    }
    // Rejected/unlinked event receipts cannot contribute immutable claims.
    if (doc.kind === "event" && (!doc.receipt || !["135", "155"].includes(doc.receipt.status))) {
      result.excluded.push({ id, reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS" });
      continue;
    }
    keys.add(doc.key);
    if ("environment" in doc) environments.add(doc.environment);
    if (doc.kind === "event" || doc.kind === "event-summary") {
      const eventKey = doc.key + ":" + doc.type + ":" + doc.sequence;
      claim("EVENT_AUTHOR:" + eventKey, doc.author.document);
      claim("EVENT_TIME:" + eventKey, String(Date.parse(doc.occurredAt)));
      if (doc.kind === "event-summary") {
        claim("EVENT_PROTOCOL:" + eventKey, doc.protocolNumber);
        claim("EVENT_REGISTERED_AT:" + eventKey, String(Date.parse(doc.registeredAt)));
      } else if (doc.receipt && ["135", "155"].includes(doc.receipt.status)) {
        claim("EVENT_PROTOCOL:" + eventKey, doc.receipt.number!);
        claim("EVENT_REGISTERED_AT:" + eventKey, String(Date.parse(doc.receipt.registeredAt!)));
      }
    }
    if (doc.kind === "invoice" || doc.kind === "summary") {
      claim("ISSUER_DOCUMENT", doc.issuer.document);
      claim("ISSUED_AT", String(Date.parse(doc.issuedAt)));
      claim("TOTAL", quantize(decimal(doc.total), 20, "reject"));
      if (doc.issuer.name) claim("ISSUER_NAME", doc.issuer.name);
      if (doc.kind === "invoice" && item.signature.referenceSha256)
        claim("SIGNED_CONTENT", item.signature.referenceSha256);
      const digest = doc.kind === "invoice" ? doc.protocol?.digest : doc.digest;
      if (digest) claim("DOCUMENT_DIGEST", digest.replace(/\s/g, ""));
    }
    if (doc.kind === "invoice" && doc.protocol) {
      if (["100", "150"].includes(doc.protocol.status)) {
        add(id, "authorized");
        protocols.add(doc.protocol.number!);
      } else if (["110", "301", "302", "303"].includes(doc.protocol.status)) add(id, "denied");
      else result.excluded.push({ id, reason: "PROTOCOL_DOES_NOT_AUTHORIZE" });
    } else if (doc.kind === "summary") {
      add(
        id,
        doc.status === "1"
          ? "authorized"
          : doc.status === "2"
            ? "denied"
            : doc.status === "3"
              ? "cancelled"
              : "unknown",
      );
      if (doc.status === "1") protocols.add(doc.protocolNumber);
    } else if (doc.kind === "event") {
      const eventKey = doc.key + ":" + doc.type + ":" + doc.sequence;
      const contents = eventIdentities.get(eventKey) ?? new Set<string>();
      contents.add(
        item.signature.referenceSha256 ??
          canonical({
            author: doc.author,
            occurredAt: doc.occurredAt,
            cancellation: doc.cancellation,
            correction: doc.correction,
            manifestation: doc.manifestation,
          }),
      );
      eventIdentities.set(eventKey, contents);
      if (doc.type === "110111" && doc.receipt && ["135", "155"].includes(doc.receipt.status)) {
        add(id, "cancelled");
        if (doc.cancellation) cancellations.push(doc.cancellation.protocolNumber);
      } else result.excluded.push({ id, reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS" });
    } else if (doc.kind === "event-summary" && doc.type === "110111") add(id, "cancelled");
    else result.excluded.push({ id, reason: "EVENT_DOES_NOT_CHANGE_FISCAL_STATUS" });
  }
  for (const [field, values] of immutable)
    if (values.size > 1) result.conflicts.push("IMMUTABLE_CLAIM_CONFLICT:" + field);
  if (keys.size > 1) result.conflicts.push("DOCUMENT_KEY_MISMATCH");
  if (environments.size > 1) result.conflicts.push("ENVIRONMENT_MISMATCH");
  if (protocols.size > 1) result.conflicts.push("AUTHORIZATION_PROTOCOL_CONFLICT");
  if (statuses.has("denied") && (statuses.has("authorized") || statuses.has("cancelled")))
    result.conflicts.push("FISCAL_STATUS_CONFLICT");
  if (protocols.size && cancellations.some((p) => !protocols.has(p)))
    result.conflicts.push("CANCELLATION_PROTOCOL_CONFLICT");
  for (const [key, contents] of eventIdentities)
    if (contents.size > 1) result.conflicts.push("EVENT_IDENTITY_CONFLICT:" + key);
  result.key = keys.size === 1 ? [...keys][0]! : null;
  result.reportedStatus = result.conflicts.length
    ? "conflict"
    : statuses.has("cancelled")
      ? "cancelled"
      : statuses.has("authorized")
        ? "authorized"
        : statuses.has("denied")
          ? "denied"
          : "unknown";
  result.conflicts.sort();
  result.evidenceIds.sort();
  result.excluded.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}
