import forge from "node-forge";
import { constants, createCipheriv, pbkdf2Sync, privateEncrypt, randomBytes } from "node:crypto";

/**
 * Signs with node:crypto what node-forge would sign in JavaScript: the same
 * RSASSA-PKCS1-v1_5 bytes (DigestInfo, PKCS#1 padding), about 20 times faster.
 * Certificate signing was the most expensive step of the test suite.
 */
function nativeSigner(privateKey: forge.pki.rsa.PrivateKey) {
  const pem = forge.pki.privateKeyToPem(privateKey);
  const a = forge.asn1;
  return {
    sign(md: forge.md.MessageDigest) {
      const digestInfo = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
          a.create(
            a.Class.UNIVERSAL,
            a.Type.OID,
            false,
            a.oidToDer(forge.pki.oids[md.algorithm]!).getBytes(),
          ),
          a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ""),
        ]),
        a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, md.digest().getBytes()),
      ]);
      return privateEncrypt(
        { key: pem, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(a.toDer(digestInfo).getBytes(), "binary"),
      ).toString("binary");
    },
  } as unknown as forge.pki.rsa.PrivateKey;
}

let signer: forge.pki.rsa.PrivateKey | undefined;
let keys: forge.pki.rsa.KeyPair | undefined;
/** Synthetic key material only. Created in memory; never copied from a deployment. */
export function syntheticCertificate(
  options: {
    cnpj?: string;
    now?: number;
    expired?: boolean;
    future?: boolean;
    clientAuth?: boolean;
    mismatch?: boolean;
    password?: string;
    /** ASN.1 type of the CNPJ otherName; ICP-Brasil issuers use OCTET STRING or PrintableString. */
    cnpjType?: "utf8" | "octet" | "printable";
  } = {},
) {
  keys ??= forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate(),
    now = options.now ?? Date.now();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + randomBytes(12).toString("hex");
  cert.validity.notBefore = new Date(now + (options.future ? 60_000 : -86400_000));
  cert.validity.notAfter = new Date(now + (options.expired ? -1000 : 86400_000));
  cert.setSubject([{ name: "commonName", value: "Synthetic certificate, no fiscal validity" }]);
  cert.setIssuer(cert.subject.attributes);
  const a = forge.asn1;
  const san = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
      a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer("2.16.76.1.3.3").getBytes()),
      a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
        a.create(
          a.Class.UNIVERSAL,
          { utf8: a.Type.UTF8, octet: a.Type.OCTETSTRING, printable: a.Type.PRINTABLESTRING }[
            options.cnpjType ?? "utf8"
          ],
          false,
          options.cnpj ?? "00000000000191",
        ),
      ]),
    ]),
  ]);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true },
    { name: "extKeyUsage", clientAuth: options.clientAuth ?? true },
    { id: "2.5.29.17", value: a.toDer(san).getBytes() },
  ]);
  signer ??= nativeSigner(keys.privateKey);
  cert.sign(signer, forge.md.sha256.create());
  const password = options.password ?? "Synthetic-PFX-77!";
  const privateKey = options.mismatch
    ? forge.pki.rsa.generateKeyPair(2048).privateKey
    : keys.privateKey;
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
    algorithm: "aes256",
    count: 2048,
  });
  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    password: Buffer.from(password),
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function syntheticServer(host = "controlled.test") {
  const pair = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = pair.publicKey;
  cert.serialNumber = "01" + randomBytes(12).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3600_000);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
  ]);
  cert.sign(nativeSigner(pair.privateKey), forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(pair.privateKey),
  };
}

const a = forge.asn1;
const children = (node: forge.asn1.Asn1): forge.asn1.Asn1[] => {
  if (!Array.isArray(node.value)) throw new Error("Expected ASN.1 children");
  return node.value;
};
const bytes = (node: forge.asn1.Asn1): string => {
  if (typeof node.value !== "string") throw new Error("Expected ASN.1 bytes");
  return node.value;
};
const seq = (nodes: forge.asn1.Asn1[]) => a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, nodes);
const octet = (value: string) => a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, value);
const integer = (value: number) =>
  a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, a.integerToDer(value).getBytes());
const oid = (value: string) =>
  a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(value).getBytes());
const privateKeyInfo = (material: ReturnType<typeof syntheticCertificate>) =>
  forge.pki.wrapRsaPrivateKey(
    forge.pki.privateKeyToAsn1(forge.pki.privateKeyFromPem(material.key)),
  );

/** Opens the synthetic PKCS#12 AuthenticatedSafe for editing; `seal` writes it
 * back with a valid MAC. */
function editAuthenticatedSafe(material: ReturnType<typeof syntheticCertificate>) {
  const password = material.password.toString("utf8");
  const p12 = a.fromDer(material.pfx.toString("binary"));
  const authenticated = children(children(children(p12)[1]!)[1]!)[0]!;
  const safe = a.fromDer(bytes(authenticated));
  // forge puts the certificates first and the key SafeContents second.
  const keyContent = children(children(children(safe)[1]!)[1]!)[0]!;
  const keyBags = a.fromDer(bytes(keyContent));
  return {
    password,
    safe,
    keyBags,
    setKeyBag: (value: forge.asn1.Asn1) => {
      children(children(children(keyBags)[0]!)[1]!)[0] = value;
      keyContent.value = a.toDer(keyBags).getBytes();
    },
    seal: () => {
      authenticated.value = a.toDer(safe).getBytes();
      // syntheticCertificate's MAC: SHA-1 with the iteration count it wrote.
      const macData = children(children(p12)[2]!);
      const macKey = forge.pkcs12.generateKey(
        password,
        forge.util.createBuffer(bytes(macData[1]!)),
        3,
        parseInt(forge.util.bytesToHex(bytes(macData[2]!)), 16),
        20,
      );
      const mac = forge.hmac.create();
      mac.start("sha1", macKey);
      mac.update(bytes(authenticated));
      children(macData[0]!)[1]!.value = mac.digest().getBytes();
      material.pfx.fill(0);
      material.pfx = Buffer.from(a.toDer(p12).getBytes(), "binary");
      return material;
    },
  };
}

/** Synthetic RC2-40 PKCS#12, with a valid MAC, to reproduce OpenSSL 3's
 * refusal of legacy PFX encryption. The RSA key and certificate are unchanged. */
export function legacySyntheticCertificate() {
  const material = syntheticCertificate();
  const { password, setKeyBag, seal } = editAuthenticatedSafe(material);
  const salt = forge.random.getBytesSync(16),
    count = 2048;
  const derive = (id: number, length: number) =>
    forge.pkcs12.generateKey(password, forge.util.createBuffer(salt), id, count, length);
  const cipher = forge.rc2.createEncryptionCipher(derive(1, 5), 40);
  cipher.start(derive(2, 8));
  cipher.update(a.toDer(privateKeyInfo(material)));
  if (!cipher.finish()) throw new Error("Synthetic encryption failed");
  setKeyBag(
    seq([
      seq([oid("1.2.840.113549.1.12.1.6"), seq([octet(salt), integer(count)])]),
      octet(cipher.output.getBytes()),
    ]),
  );
  return seal();
}

/** Synthetic PKCS#12 whose shrouded key bag sits inside encrypted SafeContents
 * (PKCS#7 EncryptedData), so the key's iteration count only shows after the
 * outer layer is decrypted. Each extra count in `containers` appends one more
 * encrypted, empty SafeContents. */
export function encryptedSafeCertificate(keyIterations: number, containers = [2048]) {
  const material = syntheticCertificate();
  const { password, safe, keyBags, setKeyBag, seal } = editAuthenticatedSafe(material);
  // PBES2 with PBKDF2-HMAC-SHA1 and AES-256-CBC, as forge writes it, derived
  // natively so high iteration counts keep the fixture cheap.
  const pbes2 = (content: forge.asn1.Asn1, count: number) => {
    const salt = randomBytes(8),
      iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", pbkdf2Sync(password, salt, count, 32, "sha1"), iv);
    const plain = Buffer.from(a.toDer(content).getBytes(), "binary");
    return {
      algorithm: seq([
        oid(forge.pki.oids.pkcs5PBES2!),
        seq([
          seq([
            oid(forge.pki.oids.pkcs5PBKDF2!),
            seq([octet(salt.toString("binary")), integer(count)]),
          ]),
          seq([oid(forge.pki.oids["aes256-CBC"]!), octet(iv.toString("binary"))]),
        ]),
      ]),
      ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]).toString("binary"),
    };
  };
  const key = pbes2(privateKeyInfo(material), keyIterations);
  setKeyBag(seq([key.algorithm, octet(key.ciphertext)]));
  const encryptedData = (content: forge.asn1.Asn1, count: number) => {
    const { algorithm, ciphertext } = pbes2(content, count);
    return seq([
      oid(forge.pki.oids.encryptedData!),
      a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
        seq([
          integer(0),
          seq([
            oid(forge.pki.oids.data!),
            algorithm,
            a.create(a.Class.CONTEXT_SPECIFIC, 0, false, ciphertext),
          ]),
        ]),
      ]),
    ]);
  };
  const [first = 2048, ...extra] = containers;
  children(safe)[1] = encryptedData(keyBags, first);
  for (const count of extra) children(safe).push(encryptedData(seq([]), count));
  return seal();
}
