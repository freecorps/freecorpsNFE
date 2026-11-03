import { ConvexError } from "convex/values";

/**
 * The cold tier of ADR 0010, phase C: a dedicated R2 bucket, reached through its S3 API with a
 * token restricted to that bucket. Runs in both runtimes (`fetch` and `crypto.subtle`), so the
 * readers of phase B, Node or not, read a cold version through the same codec. There is no
 * application cipher: R2 encrypts at rest, and every read is checked by the content hash.
 *
 * Configuration, all four or none:
 * - `FNFE_COLD_R2_ENDPOINT`: `https://<account>.r2.cloudflarestorage.com`;
 * - `FNFE_COLD_R2_BUCKET`;
 * - `FNFE_COLD_R2_ACCESS_KEY_ID` and `FNFE_COLD_R2_SECRET_ACCESS_KEY`.
 */
export type ColdConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const NAMES = {
  endpoint: "FNFE_COLD_R2_ENDPOINT",
  bucket: "FNFE_COLD_R2_BUCKET",
  accessKeyId: "FNFE_COLD_R2_ACCESS_KEY_ID",
  secretAccessKey: "FNFE_COLD_R2_SECRET_ACCESS_KEY",
} as const;

/** The bucket configuration, or `null` when none of it is set. A partial one is an error. */
export function coldConfig(): ColdConfig | null {
  const values = Object.fromEntries(
    Object.entries(NAMES).map(([field, name]) => [field, process.env[name]?.trim() || undefined]),
  ) as Partial<ColdConfig>;
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return null;
  if (present !== 4) throw new Error("COLD_TIER_CONFIG_PARTIAL");
  const endpoint = new URL(values.endpoint!);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1")
    throw new Error("COLD_TIER_CONFIG_INVALID");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket!))
    throw new Error("COLD_TIER_CONFIG_INVALID");
  return { ...(values as ColdConfig), endpoint: endpoint.origin };
}

/** Object keys stay in a closed alphabet, so the canonical path needs no percent-encoding. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,511}$/;
export function assertColdKey(key: string) {
  if (!KEY.test(key) || key.includes("//") || key.includes(".."))
    throw new Error("COLD_KEY_INVALID");
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(data: Uint8Array | string) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}
async function hmac(key: Uint8Array | string, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    (typeof key === "string" ? encoder.encode(key) : key) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

/** SigV4 of an S3 request, region `auto`, path-style, payload hash signed. */
export async function signColdRequest(
  config: ColdConfig,
  method: string,
  key: string,
  payloadHash: string,
  headers: Record<string, string>,
  now: Date,
) {
  assertColdKey(key);
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
  const date = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = date.slice(0, 8);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    url.pathname,
    "",
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonical)].join("\n");
  let signing = await hmac(`AWS4${config.secretAccessKey}`, day);
  for (const part of ["auto", "s3", "aws4_request"]) signing = await hmac(signing, part);
  const signature = hex((await hmac(signing, toSign)).buffer as ArrayBuffer);
  const { host: _host, ...sent } = all;
  return {
    url: url.toString(),
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
  };
}

const unavailable = (reason: string): never => {
  throw new ConvexError({ code: "UNAVAILABLE", reason });
};

/** The bucket client. Every failure that is not a clean answer is `UNAVAILABLE`, never empty. */
export function coldObjects(config: ColdConfig | null = coldConfig()) {
  const send = async (method: string, key: string, body?: Uint8Array, contentType?: string) => {
    if (!config) return unavailable("cold tier not configured");
    const payloadHash = await sha256Hex(body ?? new Uint8Array());
    const signed = await signColdRequest(
      config,
      method,
      key,
      payloadHash,
      contentType ? { "content-type": contentType } : {},
      new Date(),
    );
    try {
      return await fetch(signed.url, {
        method,
        headers: signed.headers,
        ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
      });
    } catch {
      return unavailable("cold tier unreachable");
    }
  };
  return {
    /** Writes the bytes under `key`. R2 checks the signed payload hash before storing. */
    async put(key: string, bytes: Uint8Array, contentType: string) {
      const response = await send("PUT", key, bytes, contentType);
      if (!response.ok) unavailable(`cold tier put ${response.status}`);
    },
    /** The object, or `null` when R2 answers that it does not exist. */
    async get(key: string): Promise<Uint8Array | null> {
      const response = await send("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) return unavailable(`cold tier get ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    /** Deletes `key`; a missing object is already deleted. */
    async delete(key: string) {
      const response = await send("DELETE", key);
      if (!response.ok && response.status !== 404)
        unavailable(`cold tier delete ${response.status}`);
    },
  };
}
export type ColdObjects = ReturnType<typeof coldObjects>;

/**
 * Key of a version's content in the bucket, named by its hash. The prefix carries what the lock
 * rules of the bucket need (`scripts/cold-tier-locks.mjs`): Production notes go under the year
 * their fiscal guard ends, which a Date rule locks until 01/01 of the next year; Sandbox notes
 * have no lock, so the early purge of an organization without Production is never blocked.
 */
export function contentObjectKey(place: {
  environment: "sandbox" | "production";
  guardYear: number | null;
  organizationId: string;
  versionId: string;
  contentSha256: string;
}) {
  return objectKey(place, `${place.versionId}/content-${place.contentSha256}.gz`);
}

/**
 * Key of an XML original in the bucket (ADR 0010, decision 8): the gzip of the raw XML, named by
 * the artifact and the SHA-256 of the raw bytes (`documentArtifacts.sha256`), under the same
 * lock prefix as the note's versions. The backup and the ADR 0009 package read this shape.
 */
export function originalObjectKey(place: {
  environment: "sandbox" | "production";
  guardYear: number | null;
  organizationId: string;
  artifactId: string;
  sha256: string;
}) {
  return objectKey(place, `${place.artifactId}/original-${place.sha256}.gz`);
}

function objectKey(
  place: {
    environment: "sandbox" | "production";
    guardYear: number | null;
    organizationId: string;
  },
  name: string,
) {
  const scope = place.environment === "sandbox" ? "sandbox" : `production/guard-${place.guardYear}`;
  if (place.environment === "production" && !Number.isSafeInteger(place.guardYear))
    throw new Error("COLD_KEY_INVALID");
  const key = `documents/${scope}/${place.organizationId}/${name}`;
  assertColdKey(key);
  return key;
}
