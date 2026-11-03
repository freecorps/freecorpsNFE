import { createHash, X509Certificate } from "node:crypto";
import { SignedXml } from "xml-crypto";
import type { CheckResult } from "@freecorps/fiscal-core";
import { children, dom, DS_NS, NFE_NS, required, serialize } from "./xml.js";
import type { ParsedNfe } from "./types.js";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = DS_NS + "enveloped-signature";
const check = (status: CheckResult["status"], code: string): CheckResult => ({ status, code });
export function verifyNfeSignature(
  xml: string,
  parsed: ParsedNfe,
  evaluatedAt: string | null = null,
) {
  const result = {
    integrity: check("not_checked", "SIGNATURE_NOT_CHECKED"),
    trust: check("not_checked", "CERTIFICATE_CHAIN_NOT_CHECKED"),
    time: check("not_checked", "CERTIFICATE_TIME_NOT_CHECKED"),
    referenceId: null as string | null,
    referenceSha256: null as string | null,
    certificateSha256: null as string | null,
    evaluatedAt,
    authenticatedXml: null as string | null,
  };
  if (parsed.document.kind === "summary" || parsed.document.kind === "event-summary") {
    result.integrity = check("not_applicable", "SUMMARY_HAS_NO_DOCUMENT_SIGNATURE");
    return result;
  }
  try {
    const document = dom(xml),
      root = document.documentElement;
    const containerName = parsed.document.kind === "invoice" ? "NFe" : "evento";
    const container = root.localName === containerName ? root : required(root, containerName);
    const target = required(container, parsed.document.kind === "invoice" ? "infNFe" : "infEvento");
    const id = target.getAttribute("Id");
    result.referenceId = id;
    const signatures = Array.from(root.getElementsByTagNameNS(DS_NS, "Signature"));
    if (!signatures.length) {
      result.integrity = check("failed", "SIGNATURE_MISSING");
      return result;
    }
    if (signatures.length !== 1 || signatures[0]!.parentNode !== container || !id)
      throw new Error();
    const signature = signatures[0]!;
    const signedInfos = children(signature, "SignedInfo", DS_NS);
    if (signedInfos.length !== 1) throw new Error();
    const signedInfo = signedInfos[0]!,
      references = children(signedInfo, "Reference", DS_NS);
    if (references.length !== 1 || references[0]!.getAttribute("URI") !== "#" + id)
      throw new Error();
    const reference = references[0]!;
    const algorithms = (parent: Element, name: string) =>
      children(parent, name, DS_NS).map((n) => n.getAttribute("Algorithm"));
    if (
      algorithms(signedInfo, "CanonicalizationMethod").join() !== C14N ||
      algorithms(signedInfo, "SignatureMethod").join() !== DS_NS + "rsa-sha1"
    )
      throw new Error();
    const transforms = children(reference, "Transforms", DS_NS);
    if (
      transforms.length !== 1 ||
      algorithms(transforms[0]!, "Transform").join() !== [ENVELOPED, C14N].join() ||
      algorithms(reference, "DigestMethod").join() !== DS_NS + "sha1"
    )
      throw new Error();
    if (
      Array.from(signature.getElementsByTagNameNS(DS_NS, "XPath")).length ||
      children(signature, "Object", DS_NS).length
    )
      throw new Error();
    const certs = Array.from(signature.getElementsByTagNameNS(DS_NS, "X509Certificate"));
    if (certs.length !== 1) throw new Error();
    const encoded = (certs[0]!.textContent ?? "").replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 32_000) throw new Error();
    const cert = new X509Certificate(Buffer.from(encoded, "base64"));
    if (
      cert.publicKey.asymmetricKeyType !== "rsa" ||
      (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
    result.certificateSha256 = createHash("sha256").update(cert.raw).digest("hex");
    const verifier = new SignedXml({ publicCert: cert.toString(), getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature);
    if (!verifier.checkSignature(xml)) throw new Error();
    const authenticated = verifier.getSignedReferences();
    if (authenticated.length !== 1) throw new Error();
    const verifiedNode = dom(authenticated[0]!).documentElement;
    if (
      verifiedNode.namespaceURI !== NFE_NS ||
      verifiedNode.localName !== target.localName ||
      verifiedNode.getAttribute("Id") !== id
    )
      throw new Error();
    // Return a model built from the verified reference; protocol/receipt remain explicitly separate evidence.
    container.replaceChild(document.importNode(verifiedNode, true), target);
    result.referenceSha256 = createHash("sha256").update(authenticated[0]!).digest("hex");
    result.authenticatedXml = serialize(document);
    result.integrity = check("passed", "SIGNATURE_INTEGRITY_VALID");
    if (evaluatedAt !== null) {
      const timestamp = Date.parse(evaluatedAt);
      result.time = !Number.isFinite(timestamp)
        ? check("failed", "CERTIFICATE_EVALUATION_TIME_INVALID")
        : timestamp >= Date.parse(cert.validFrom) && timestamp <= Date.parse(cert.validTo)
          ? check("passed", "CERTIFICATE_VALID_AT_EVALUATION")
          : check("failed", "CERTIFICATE_OUTSIDE_VALIDITY");
    }
    return result;
  } catch {
    result.integrity = check("failed", "SIGNATURE_INVALID_OR_UNSUPPORTED");
    result.authenticatedXml = null;
    return result;
  }
}
