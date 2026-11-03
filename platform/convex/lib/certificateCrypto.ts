"use node";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Infer } from "convex/values";
import type { envelope } from "./certificateValues";

export type Envelope = Infer<typeof envelope>;
export type CertificateContext = {
  organizationId: string;
  companyId: string;
  id: string;
  version: number;
};
export type Keyring = { active: string; keys: Record<string, string> };
/** The local Node executor replaces process.env between invocations. The generated
 * `env = process.env` captures the previous object, so rotated keys must be read now. */
export function currentCertificateKeyring(): Keyring {
  return certificateKeyring(process.env.FNFE_PLATFORM_CERT_KEYS);
}
export function certificateKeyring(raw: string | undefined): Keyring {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (
      !value ||
      typeof value !== "object" ||
      !("active" in value) ||
      !("keys" in value) ||
      typeof value.active !== "string" ||
      !value.keys ||
      typeof value.keys !== "object"
    )
      throw 0;
    const keys: Record<string, string> = {};
    for (const [version, key] of Object.entries(value.keys)) {
      if (
        !/^[a-zA-Z0-9_-]{1,40}$/.test(version) ||
        typeof key !== "string" ||
        !/^[a-f0-9]{64}$/.test(key)
      )
        throw 0;
      keys[version] = key;
    }
    if (!Object.hasOwn(keys, value.active)) throw 0;
    return { active: value.active, keys };
  } catch {
    throw new Error("CERTIFICATE_KEY_UNAVAILABLE");
  }
}
function aad(context: CertificateContext, purpose: string) {
  return Buffer.from(
    JSON.stringify([
      "fnfe-certificate",
      1,
      context.organizationId,
      context.companyId,
      context.id,
      context.version,
      purpose,
    ]),
  );
}
function bytes(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}
function seal(key: Buffer, data: Buffer, context: Buffer): ArrayBuffer {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(context);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return bytes(Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
}
function open(key: Buffer, data: ArrayBuffer, context: Buffer): Buffer {
  const buffer = Buffer.from(data);
  if (buffer.length < 28) throw new Error("CERTIFICATE_ENVELOPE_INVALID");
  const cipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
  cipher.setAAD(context);
  cipher.setAuthTag(buffer.subarray(12, 28));
  let partial: Buffer | undefined;
  try {
    partial = cipher.update(buffer.subarray(28));
    return Buffer.concat([partial, cipher.final()]);
  } catch {
    throw new Error("CERTIFICATE_ENVELOPE_INVALID");
  } finally {
    partial?.fill(0);
  }
}
function master(ring: Keyring, version: string) {
  if (!Object.hasOwn(ring.keys, version)) throw new Error("CERTIFICATE_KEY_UNAVAILABLE");
  return Buffer.from(ring.keys[version]!, "hex");
}
export function encryptCertificate(
  ring: Keyring,
  context: CertificateContext,
  pfx: Buffer,
  password: Buffer,
): Envelope {
  const key = randomBytes(32),
    root = master(ring, ring.active);
  try {
    return {
      format: 1,
      keyVersion: ring.active,
      wrappedKey: seal(root, key, aad(context, `key:${ring.active}`)),
      pfx: seal(key, pfx, aad(context, "pfx")),
      password: seal(key, password, aad(context, "password")),
    };
  } finally {
    key.fill(0);
    root.fill(0);
  }
}
export function decryptCertificate(ring: Keyring, context: CertificateContext, value: Envelope) {
  if (value.format !== 1) throw new Error("CERTIFICATE_ENVELOPE_INVALID");
  const root = master(ring, value.keyVersion);
  let key: Buffer | undefined, pfx: Buffer | undefined;
  try {
    key = open(root, value.wrappedKey, aad(context, `key:${value.keyVersion}`));
    pfx = open(key, value.pfx, aad(context, "pfx"));
    const password = open(key, value.password, aad(context, "password"));
    return {
      pfx,
      password,
      dispose() {
        pfx!.fill(0);
        password.fill(0);
      },
    };
  } catch (error) {
    pfx?.fill(0);
    throw error;
  } finally {
    key?.fill(0);
    root.fill(0);
  }
}
export function rewrapCertificate(
  ring: Keyring,
  context: CertificateContext,
  value: Envelope,
): Envelope {
  if (value.format !== 1) throw new Error("CERTIFICATE_ENVELOPE_INVALID");
  const oldRoot = master(ring, value.keyVersion),
    newRoot = master(ring, ring.active);
  let key: Buffer | undefined;
  try {
    key = open(oldRoot, value.wrappedKey, aad(context, `key:${value.keyVersion}`));
    return {
      ...value,
      keyVersion: ring.active,
      wrappedKey: seal(newRoot, key, aad(context, `key:${ring.active}`)),
    };
  } finally {
    oldRoot.fill(0);
    newRoot.fill(0);
    key?.fill(0);
  }
}
