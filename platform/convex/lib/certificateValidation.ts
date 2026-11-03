"use node";
import forge from "node-forge";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { normalizeCnpj } from "@freecorps/contracts";
import { MAX_PFX_BYTES, MAX_PASSWORD_BYTES } from "./certificateValues";

function fail(code: string): never {
  throw new Error(code);
}
// Bound KDF work before node-forge processes attacker-controlled PKCS#12 parameters.
function inspect(node: forge.asn1.Asn1, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 12000 || depth > 32) fail("CERTIFICATE_INVALID");
  if (!Array.isArray(node.value)) return;
  const values = node.value;
  // MacData has DigestInfo, salt and an optional iteration count.
  if (
    values[0]?.type === forge.asn1.Type.SEQUENCE &&
    values[1]?.type === forge.asn1.Type.OCTETSTRING &&
    values[2]?.type === forge.asn1.Type.INTEGER &&
    typeof values[2].value === "string"
  ) {
    const raw = values[2].value;
    const iterations = Array.from(raw).reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
    if (raw.length > 4 || iterations < 1 || iterations > 100_000) fail("CERTIFICATE_INVALID");
  }
  if (
    values[0]?.type === forge.asn1.Type.OCTETSTRING &&
    values[1]?.type === forge.asn1.Type.INTEGER &&
    typeof values[1].value === "string"
  ) {
    const value = values[1].value;
    if (value.length > 4) fail("CERTIFICATE_INVALID");
    const iterations = Array.from(value).reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
    if (iterations < 1 || iterations > 100_000) fail("CERTIFICATE_INVALID");
  }
  for (const child of values) {
    inspect(child, depth + 1, budget);
    // PKCS#12 wraps its authenticated safe in an OCTET STRING.
    if (
      child.type === forge.asn1.Type.OCTETSTRING &&
      typeof child.value === "string" &&
      child.value.charCodeAt(0) === 0x30
    ) {
      let inner: forge.asn1.Asn1;
      try {
        inner = forge.asn1.fromDer(child.value);
      } catch {
        continue;
      }
      inspect(inner, depth + 1, budget);
    }
  }
}
function identity(cert: forge.pki.Certificate): string {
  const extension = cert.getExtension("subjectAltName") as { value?: string } | null;
  if (!extension || typeof extension.value !== "string") return fail("CERTIFICATE_IDENTITY");
  const root = forge.asn1.fromDer(extension.value);
  if (!Array.isArray(root.value)) return fail("CERTIFICATE_IDENTITY");
  const identities: string[] = [];
  for (const other of root.value) {
    if (
      other.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC ||
      other.type !== 0 ||
      !Array.isArray(other.value)
    )
      continue;
    const [oid, wrapper] = other.value;
    if (!oid || typeof oid.value !== "string" || forge.asn1.derToOid(oid.value) !== "2.16.76.1.3.3")
      continue;
    const value = wrapper && Array.isArray(wrapper.value) ? wrapper.value[0] : undefined;
    if (
      !value ||
      typeof value.value !== "string" ||
      // DOC-ICP-04 stores otherName as OCTET STRING or PrintableString; UTF8/IA5 also seen.
      ![
        forge.asn1.Type.OCTETSTRING,
        forge.asn1.Type.UTF8,
        forge.asn1.Type.PRINTABLESTRING,
        forge.asn1.Type.IA5STRING,
      ].includes(value.type)
    )
      return fail("CERTIFICATE_IDENTITY");
    identities.push(value.value);
  }
  if (identities.length !== 1 || normalizeCnpj(identities[0]!) !== identities[0])
    return fail("CERTIFICATE_IDENTITY");
  return identities[0]!;
}
function readCertificate(pfx: Buffer, password: Buffer) {
  if (!pfx.length || pfx.length > MAX_PFX_BYTES || password.length > MAX_PASSWORD_BYTES)
    return fail("CERTIFICATE_SIZE");
  try {
    const asn = forge.asn1.fromDer(pfx.toString("binary"));
    inspect(asn);
    const parsed = forge.pkcs12.pkcs12FromAsn1(asn, true, password.toString("utf8"));
    const keys = [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag].flatMap(
      (bagType) => parsed.getBags({ bagType })[bagType] ?? [],
    );
    if (keys.length !== 1 || !keys[0]?.key) return fail("CERTIFICATE_INVALID");
    const privateKey = createPrivateKey(forge.pki.privateKeyToPem(keys[0].key));
    const certs = (
      parsed.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
    ).flatMap((bag) => (bag.cert ? [bag.cert] : []));
    const matches = certs.filter((cert) =>
      new X509Certificate(forge.pki.certificateToPem(cert)).checkPrivateKey(privateKey),
    );
    if (matches.length !== 1) return fail("CERTIFICATE_INVALID");
    return { privateKey, cert: matches[0]!, certs };
  } catch {
    return fail("CERTIFICATE_INVALID");
  }
}

/** Decode the already authenticated PKCS#12 in memory. This supports legacy PFX
 * ciphers without enabling OpenSSL's legacy provider or weakening TLS. */
export function certificateTlsPem(pfx: Buffer, password: Buffer) {
  const { privateKey, cert, certs } = readCertificate(pfx, password);
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const chain = [cert, ...certs.filter((entry) => entry !== cert)];
  const material = {
    key: Buffer.from(key),
    cert: Buffer.from(chain.map((entry) => forge.pki.certificateToPem(entry)).join("")),
    dispose() {
      this.key.fill(0);
      this.cert.fill(0);
    },
  };
  return material;
}

export function validateCertificate(
  pfx: Buffer,
  password: Buffer,
  companyCnpj: string,
  now = Date.now(),
) {
  try {
    const { privateKey, cert } = readCertificate(pfx, password),
      x509 = new X509Certificate(forge.pki.certificateToPem(cert));
    const notBefore = cert.validity.notBefore.getTime(),
      notAfter = cert.validity.notAfter.getTime();
    if (notBefore > now) return fail("CERTIFICATE_NOT_YET_VALID");
    if (notAfter <= now) return fail("CERTIFICATE_EXPIRED");
    const usage = cert.getExtension("keyUsage") as { digitalSignature?: boolean } | null;
    const extended = cert.getExtension("extKeyUsage") as { clientAuth?: boolean } | null;
    if (
      x509.ca ||
      !usage?.digitalSignature ||
      !extended?.clientAuth ||
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      return fail("CERTIFICATE_PURPOSE");
    const cnpj = identity(cert);
    if (cnpj !== companyCnpj) return fail("CERTIFICATE_IDENTITY");
    return {
      fingerprint: x509.fingerprint256.replaceAll(":", "").toLowerCase(),
      subject: cnpj,
      cnpj,
      notBefore,
      notAfter,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /^CERTIFICATE_(INVALID|SIZE|IDENTITY|PURPOSE|EXPIRED|NOT_YET_VALID)$/.test(error.message)
    )
      throw error;
    return fail("CERTIFICATE_INVALID");
  }
}
