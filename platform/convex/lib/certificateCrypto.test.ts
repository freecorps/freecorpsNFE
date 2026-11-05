import { expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import forge from "node-forge";
import {
  certificateKeyring,
  currentCertificateKeyring,
  encryptCertificate,
  decryptCertificate,
  rewrapCertificate,
} from "./certificateCrypto";
import { validateCertificate, certificateTlsPem } from "./certificateValidation";
import {
  syntheticCertificate,
  legacySyntheticCertificate,
  encryptedSafeCertificate,
} from "../../../tests/helpers/certificates";
import { createSecureContext } from "node:tls";
const context = { organizationId: "org-a", companyId: "company-a", id: "cert-a", version: 1 };
const ring = {
  active: "v1",
  keys: { v1: randomBytes(32).toString("hex"), v2: randomBytes(32).toString("hex") },
};
it("authenticates legacy PFX and opens native TLS without enabling legacy OpenSSL", () => {
  const material = legacySyntheticCertificate();
  expect(() =>
    createSecureContext({ pfx: material.pfx, passphrase: material.password.toString() }),
  ).toThrow();
  expect(validateCertificate(material.pfx, material.password, "00000000000191").cnpj).toBe(
    "00000000000191",
  );
  const pem = certificateTlsPem(material.pfx, material.password);
  expect(() =>
    createSecureContext({ key: pem.key, cert: pem.cert, minVersion: "TLSv1.2" }),
  ).not.toThrow();
  pem.dispose();
  expect(pem.key.every((byte) => byte === 0)).toBe(true);
  expect(() => certificateTlsPem(material.pfx, Buffer.from("wrong-password"))).toThrow(
    "CERTIFICATE_INVALID",
  );
});
it("reads rotated keys after a warm Node executor replaces its environment object", () => {
  const initial = process.env;
  try {
    process.env = {
      ...initial,
      FNFE_PLATFORM_CERT_KEYS: JSON.stringify({ ...ring, active: "v1" }),
    };
    const captured = process.env;
    expect(currentCertificateKeyring().active).toBe("v1");
    process.env = {
      ...initial,
      FNFE_PLATFORM_CERT_KEYS: JSON.stringify({ ...ring, active: "v2" }),
    };
    expect(certificateKeyring(captured.FNFE_PLATFORM_CERT_KEYS).active).toBe("v1");
    expect(currentCertificateKeyring().active).toBe("v2");
  } finally {
    process.env = initial;
  }
});
it("encrypts both secrets and authenticates all context fields and every block", () => {
  const pfx = Buffer.from("synthetic-private-key"),
    password = Buffer.from("secret");
  const value = encryptCertificate(ring, context, pfx, password);
  expect(Buffer.from(value.pfx).includes(pfx)).toBe(false);
  expect(Buffer.from(value.password).includes(password)).toBe(false);
  const material = decryptCertificate(ring, context, value);
  expect(material.pfx).toEqual(pfx);
  expect(material.password).toEqual(password);
  material.dispose();
  expect(material.pfx.every((b) => b === 0)).toBe(true);
  for (const field of ["organizationId", "companyId", "id", "version"] as const)
    expect(() =>
      decryptCertificate(ring, { ...context, [field]: field === "version" ? 2 : "other" }, value),
    ).toThrow("CERTIFICATE_ENVELOPE_INVALID");
  for (const field of ["pfx", "password", "wrappedKey"] as const) {
    const tampered = new Uint8Array(value[field].slice(0));
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptCertificate(ring, context, { ...value, [field]: tampered.buffer })).toThrow(
      "CERTIFICATE_ENVELOPE_INVALID",
    );
  }
  expect(() => decryptCertificate(ring, context, { ...value, pfx: value.password })).toThrow();
});
it("rewraps without decrypting PFX and restores old snapshots only with their retained key", () => {
  const value = encryptCertificate(ring, context, Buffer.from("PFX"), Buffer.alloc(0));
  const next = { ...ring, active: "v2" },
    wrapped = rewrapCertificate(next, context, value);
  expect(wrapped.pfx).toEqual(value.pfx);
  expect(wrapped.password).toEqual(value.password);
  expect(wrapped.keyVersion).toBe("v2");
  const currentOnly = { active: "v2", keys: { v2: ring.keys.v2 } };
  expect(() => decryptCertificate(currentOnly, context, value)).toThrow(
    "CERTIFICATE_KEY_UNAVAILABLE",
  );
  expect(decryptCertificate(currentOnly, context, wrapped).pfx.toString()).toBe("PFX");
  expect(decryptCertificate(ring, context, value).pfx.toString()).toBe("PFX");
  expect(() =>
    decryptCertificate({ active: "v1", keys: { v1: ring.keys.v2 } }, context, value),
  ).toThrow();
});
it("rejects malformed or missing key versions without echoing input", () => {
  for (const raw of [undefined, "secret", '{"active":"v1","keys":{"v1":"secret"}}'])
    expect(() => certificateKeyring(raw)).toThrow("CERTIFICATE_KEY_UNAVAILABLE");
  expect(certificateKeyring(JSON.stringify(ring))).toEqual(ring);
});
it("validates synthetic PFX identity and private key without exposing material", () => {
  const material = syntheticCertificate();
  const result = validateCertificate(material.pfx, material.password, "00000000000191");
  expect(result.cnpj).toBe("00000000000191");
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(() => validateCertificate(material.pfx, Buffer.from("wrong"), result.cnpj)).toThrow(
    "CERTIFICATE_INVALID",
  );
  expect(() => validateCertificate(material.pfx, material.password, "11222333000181")).toThrow(
    "CERTIFICATE_IDENTITY",
  );
  expect(() => validateCertificate(Buffer.alloc(262145), material.password, result.cnpj)).toThrow(
    "CERTIFICATE_SIZE",
  );
});
it("reads the CNPJ otherName in the ASN.1 types ICP-Brasil issuers use", () => {
  for (const cnpjType of ["octet", "printable"] as const) {
    const material = syntheticCertificate({ cnpj: "11222333000181", cnpjType });
    expect(validateCertificate(material.pfx, material.password, "11222333000181").cnpj).toBe(
      "11222333000181",
    );
  }
});
it("refuses an attacker-controlled excessive MAC work factor before deriving keys", () => {
  const material = syntheticCertificate();
  const p12 = forge.asn1.fromDer(material.pfx.toString("binary"));
  if (!Array.isArray(p12.value)) throw new Error("fixture");
  const mac = p12.value[2]!;
  if (!Array.isArray(mac.value)) throw new Error("fixture");
  mac.value[2] = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.INTEGER,
    false,
    "\x7f\xff\xff\xff",
  );
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
  expect(() => validateCertificate(pfx, material.password, "00000000000191")).toThrow(
    "CERTIFICATE_INVALID",
  );
});
it("bounds the work factor of bags that only appear after the outer decryption", () => {
  const nested = encryptedSafeCertificate(2048);
  expect(validateCertificate(nested.pfx, nested.password, "00000000000191").cnpj).toBe(
    "00000000000191",
  );
  const heavy = encryptedSafeCertificate(100_001);
  expect(() => validateCertificate(heavy.pfx, heavy.password, "00000000000191")).toThrow(
    "CERTIFICATE_INVALID",
  );
});
it("bounds the iterations of all bag ciphers together", () => {
  const several = encryptedSafeCertificate(2048, [2048, 2048, 2048]);
  expect(validateCertificate(several.pfx, several.password, "00000000000191").cnpj).toBe(
    "00000000000191",
  );
  // Each count is allowed alone; together they pass the budget at the last one.
  const over = encryptedSafeCertificate(2048, [2048, 100_000, 100_000, 100_000]);
  expect(() => validateCertificate(over.pfx, over.password, "00000000000191")).toThrow(
    "CERTIFICATE_INVALID",
  );
});
it.each([
  [{ expired: true }, "CERTIFICATE_EXPIRED"],
  [{ future: true }, "CERTIFICATE_NOT_YET_VALID"],
  [{ clientAuth: false }, "CERTIFICATE_PURPOSE"],
  [{ mismatch: true }, "CERTIFICATE_INVALID"],
] as const)("rejects invalid certificate %j", (options, code) => {
  const material = syntheticCertificate(options);
  expect(() => validateCertificate(material.pfx, material.password, "00000000000191")).toThrow(
    code,
  );
});
