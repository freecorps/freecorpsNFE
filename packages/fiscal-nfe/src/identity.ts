import {
  accessKeyDigit,
  normalizeCnpj,
  validateAccessKey,
  validCpf,
  type CheckResult,
} from "@freecorps/fiscal-core";
import { child, dom, required, text } from "./xml.js";
import type { ParsedNfe, Party } from "./types.js";

export { accessKeyDigit };

/**
 * Event types only the NF-e issuer registers: the SEFAZ refuses another author with 574 ("O autor
 * do evento diverge do emissor da NF-e"), comparing the author's full CNPJ/CPF with the one in the
 * access key. Manifestations (2102x0) are the recipient's, which the key does not carry.
 */
const ISSUER_EVENTS = new Set([
  "110111",
  "110110",
  "112110",
  "112120",
  "112130",
  "112140",
  "112150",
  "110300",
]);
/** A registered or unreceipted event; a rejection receipt is the fisco refusing it, kept as is. */
function authorMustBeIssuer(type: string, status: string | null): boolean {
  return ISSUER_EVENTS.has(type) && (status === null || ["135", "136", "155"].includes(status));
}
function validParty(party: Party): boolean {
  return party.kind === "CNPJ"
    ? normalizeCnpj(party.document) === party.document
    : validCpf(party.document);
}
export function validateIdentity(xml: string, parsed: ParsedNfe): CheckResult {
  const invalid = (code: string): CheckResult => ({ status: "failed", code });
  try {
    const doc = parsed.document,
      key = doc.key;
    // The key's own rules live in fiscal-core; the issue date is compared before its CNPJ/CPF.
    const checked = validateAccessKey(key);
    if (!checked.ok && checked.reason !== "issuer") return invalid(checked.code);
    if (
      (doc.kind === "invoice" || doc.kind === "summary") &&
      key.slice(2, 6) !== doc.issuedAt.slice(2, 4) + doc.issuedAt.slice(5, 7)
    )
      return invalid("NFE_KEY_ISSUED_AT_MISMATCH");
    if (!checked.ok) return invalid(checked.code);
    const root = dom(xml).documentElement;
    if (doc.kind === "invoice") {
      if (!validParty(doc.issuer) || (doc.recipient && !validParty(doc.recipient)))
        return invalid("NFE_PARTICIPANT_INVALID");
      const nfe = root.localName === "NFe" ? root : required(root, "NFe");
      const info = required(nfe, "infNFe"),
        ide = required(info, "ide");
      const issuer = doc.issuer.document.padStart(14, "0");
      const base =
        text(ide, "cUF") +
        doc.issuedAt.slice(2, 4) +
        doc.issuedAt.slice(5, 7) +
        issuer +
        "55" +
        doc.series.padStart(3, "0") +
        doc.number.padStart(9, "0") +
        text(ide, "tpEmis") +
        text(ide, "cNF");
      if (base + text(ide, "cDV") !== key) return invalid("NFE_KEY_FIELDS_MISMATCH");
      const protocol = doc.protocol;
      if (protocol && (protocol.key !== key || protocol.environment !== doc.environment))
        return invalid("NFE_PROTOCOL_MISMATCH");
      if (
        protocol &&
        ["100", "150"].includes(protocol.status) &&
        (!protocol.number || !protocol.receivedAt || !protocol.digest)
      )
        return invalid("NFE_PROTOCOL_INCOMPLETE");
      if (protocol?.digest) {
        const digest = Array.from(
          nfe.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "DigestValue"),
        );
        if (
          digest.length !== 1 ||
          (digest[0]!.textContent ?? "").replace(/\s/g, "") !== protocol.digest.replace(/\s/g, "")
        )
          return invalid("NFE_PROTOCOL_DIGEST_MISMATCH");
      }
    } else if (doc.kind === "event") {
      if (!validParty(doc.author)) return invalid("NFE_PARTICIPANT_INVALID");
      if (
        authorMustBeIssuer(doc.type, doc.receipt?.status ?? null) &&
        doc.author.document.padStart(14, "0") !== key.slice(6, 20)
      )
        return invalid("NFE_EVENT_AUTHOR_NOT_ISSUER");
      const event = child(root, "evento", true) ?? root;
      if (
        required(event, "infEvento").getAttribute("Id") !==
        "ID" + doc.type + key + doc.sequence.padStart(2, "0")
      )
        return invalid("NFE_EVENT_ID_MISMATCH");
      const receipt = doc.receipt;
      if (
        receipt &&
        (receipt.key !== key ||
          receipt.environment !== doc.environment ||
          receipt.type !== doc.type ||
          receipt.sequence !== doc.sequence)
      )
        return invalid("NFE_EVENT_RECEIPT_MISMATCH");
      if (
        receipt &&
        ["135", "136", "155"].includes(receipt.status) &&
        (!receipt.number || !receipt.registeredAt)
      )
        return invalid("NFE_EVENT_RECEIPT_INCOMPLETE");
    } else if (doc.kind === "summary") {
      if (!validParty(doc.issuer) || doc.issuer.document.padStart(14, "0") !== key.slice(6, 20))
        return invalid("NFE_PARTICIPANT_INVALID");
    } else {
      if (!validParty(doc.author)) return invalid("NFE_PARTICIPANT_INVALID");
      // A summary is the distribution's copy of a registered event.
      if (
        authorMustBeIssuer(doc.type, null) &&
        doc.author.document.padStart(14, "0") !== key.slice(6, 20)
      )
        return invalid("NFE_EVENT_AUTHOR_NOT_ISSUER");
    }
    return { status: "passed", code: "NFE_IDENTITY_VALID" };
  } catch {
    return invalid("NFE_IDENTITY_INVALID");
  }
}
