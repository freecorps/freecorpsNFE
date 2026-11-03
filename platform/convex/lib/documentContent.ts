import { ConvexError } from "convex/values";
import { gunzipSync, gzipSync } from "fflate";
import { DOCUMENT_CONTENT_FORMAT } from "./documentValues";

/**
 * The blob that holds the heavy content of one document version (ADR 0010, phase B): the
 * version's `result` and `fiscalEvidence`, the `data` of its items in position order and the
 * `snapshot` of the evidence row it wrote. Each field is the exact string the database stores,
 * never parsed: fiscal values stay the decimal text they were (AGENTS.md, rule 3).
 *
 * Identity is `contentSha256`, the SHA-256 of the uncompressed canonical JSON. `storedSha256`
 * covers the gzip bytes and only matches an upload to its intent.
 *
 * Runtimes, checked on 30/10/2026 in the open-source runtime
 * (get-convex/convex-backend, npm-packages/udf-runtime/src, `setup.ts` and `06_streams.ts`):
 * the default Convex runtime installs `crypto.subtle` and the web streams, but neither
 * `CompressionStream` nor `DecompressionStream`, and https://docs.convex.dev/functions/runtimes
 * does not list them. `crypto.subtle.digest("SHA-256")` already runs there in this repo
 * (`importUpload.ts`, `lib/apiKeyCrypto.ts`). So gzip comes from `fflate`, plain JavaScript
 * without dependencies, and both directions run in the default runtime and in `"use node"`
 * actions. The local backend smoke is reproducible with `content:prove-local`; its receipt in
 * docs/v1.0/evidence/642 covers V8 encode/decode near the cap, without memory measurements.
 *
 * `items` is positional: index i is the item at position i. The writer (B4) must assert that the
 * version's `documentItems` positions run 0, 1, 2… without gaps before encoding.
 *
 * The format label lives in `documentValues.ts`, so the schema does not import this codec.
 */
export { DOCUMENT_CONTENT_FORMAT };
/**
 * Uncompressed cap. B1 measured about 43 KB for a 20-item NF-e (about 1.4 KB per item), so real
 * content extrapolated to 990 similar items is around 2 MiB. At the cap, decoding retains the
 * gzip input, output, decoded text, parsed strings and re-encoded canonical text. The local
 * smoke succeeds near 8 MiB with repetitive synthetic items; it supplies no heap metric and
 * does not establish a memory budget for arbitrary content or for production.
 */
export const MAX_DOCUMENT_CONTENT_BYTES = 8 * 1024 * 1024;
/** Level 9, as B1 measured. With `fflate` pinned, the same content gives the same gzip bytes. */
const GZIP_LEVEL = 9;

export type DocumentContent = {
  result: string;
  fiscalEvidence?: string;
  items: string[];
  snapshot?: string;
};
export type DocumentContentRef = { contentSha256: string; contentSize: number; format: string };
export type EncodedDocumentContent = DocumentContentRef & {
  bytes: Uint8Array;
  storedSha256: string;
  storedSize: number;
};
export type DocumentContentError = {
  code: "DOCUMENT_CONTENT_CORRUPT" | "DOCUMENT_CONTENT_TOO_LARGE";
  reason: string;
};

const fail = (code: DocumentContentError["code"], reason: string): never => {
  throw new ConvexError<DocumentContentError>({ code, reason });
};
const corrupt = (reason: string) => fail("DOCUMENT_CONTENT_CORRUPT", reason);

/** Lowercase hex SHA-256 of `bytes`, as the codec writes `contentSha256`. */
export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fixed key order; optional fields absent, never `null`. `JSON.stringify` escapes are exact. */
function canonical(content: DocumentContent) {
  return JSON.stringify({
    format: DOCUMENT_CONTENT_FORMAT,
    result: content.result,
    ...(content.fiscalEvidence === undefined ? {} : { fiscalEvidence: content.fiscalEvidence }),
    items: content.items,
    ...(content.snapshot === undefined ? {} : { snapshot: content.snapshot }),
  });
}

/**
 * The identity of `content` without compressing it: what the writer (B4) re-derives from the
 * inline fields before attaching a blob encoded earlier. Same cap as the encoder.
 */
export async function documentContentRef(content: DocumentContent): Promise<DocumentContentRef> {
  const plain = new TextEncoder().encode(canonical(content));
  if (plain.length > MAX_DOCUMENT_CONTENT_BYTES) fail("DOCUMENT_CONTENT_TOO_LARGE", "content size");
  return {
    contentSha256: await sha256(plain),
    contentSize: plain.length,
    format: DOCUMENT_CONTENT_FORMAT,
  };
}

/**
 * Deterministic gzip: level 9, mtime 0, no name or comment, and OS 255 (unknown) in place of the
 * 3 (Unix) that `fflate` writes; the CRC does not cover the header.
 */
export async function encodeDocumentContent(
  content: DocumentContent,
  limit = MAX_DOCUMENT_CONTENT_BYTES,
): Promise<EncodedDocumentContent> {
  const plain = new TextEncoder().encode(canonical(content));
  if (plain.length > limit) fail("DOCUMENT_CONTENT_TOO_LARGE", "content size");
  const bytes = gzipSync(plain, { level: GZIP_LEVEL, mtime: 0 });
  bytes[9] = 0xff;
  return {
    bytes,
    contentSha256: await sha256(plain),
    contentSize: plain.length,
    storedSha256: await sha256(bytes),
    storedSize: bytes.length,
    format: DOCUMENT_CONTENT_FORMAT,
  };
}

const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/**
 * The largest gzip a deflater emits for `size` bytes: deflate falls back to stored blocks of at
 * most 65,535 bytes with 5 bytes of framing each, plus the 10-byte header and 8-byte trailer.
 */
const storedBound = (size: number) => size + 5 * Math.max(1, Math.ceil(size / 65_535)) + 18;

/**
 * Gunzips, then checks size, hash, format, shape and canonical form; any mismatch throws,
 * nothing partial. Before inflating:
 * - memory: the declared size is checked against the cap and the gzip trailer, and `fflate`
 *   writes into a buffer of exactly that size;
 * - CPU: input above the stored-block bound of the declared size is refused, so the inflate work
 *   is proportional to the declared size. A hand-made stream within the bound can still run the
 *   inflate loop up to about 1,000 times its length before failing; it only fits in storage if
 *   someone writes arbitrary bytes there.
 * `fflate` does not check the CRC, ignores trailing data and extra members, and drops output past
 * the buffer. `limit` exists only for the headroom proof (`testing/documentHeadroomProof.ts`),
 * which decodes past the cap to measure the margin; every reader keeps the default.
 * The guarantee is the SHA-256 over exactly `contentSize` bytes, then the canonical
 * check: the bytes must be the ones the encoder writes for the decoded value (no BOM, whitespace,
 * duplicate keys or other escapes).
 */
export async function decodeDocumentContent(
  bytes: Uint8Array,
  expected: DocumentContentRef,
  limit = MAX_DOCUMENT_CONTENT_BYTES,
): Promise<DocumentContent> {
  if (expected.format !== DOCUMENT_CONTENT_FORMAT) corrupt("format");
  if (!Number.isSafeInteger(expected.contentSize) || expected.contentSize < 0)
    corrupt("declared size");
  if (expected.contentSize > limit) fail("DOCUMENT_CONTENT_TOO_LARGE", "declared size");
  // Only the header without flags that the encoder writes: no name, comment or extra field.
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3])
    corrupt("gzip header");
  if (bytes.length > storedBound(expected.contentSize)) corrupt("stored size");
  if (u32(bytes, bytes.length - 4) !== expected.contentSize) corrupt("trailer size");
  let plain: Uint8Array;
  try {
    plain = gunzipSync(bytes, { out: new Uint8Array(expected.contentSize) });
  } catch {
    return corrupt("deflate");
  }
  if (plain.length !== expected.contentSize) corrupt("inflated size");
  if ((await sha256(plain)) !== expected.contentSha256) corrupt("sha256");
  let text: string;
  try {
    // `ignoreBOM` keeps a BOM in the text, where JSON.parse refuses it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
  } catch {
    return corrupt("utf-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return corrupt("json");
  }
  const { format, result, fiscalEvidence, items, snapshot, ...rest } = (value ?? {}) as Record<
    string,
    unknown
  >;
  const optional = (field: unknown) => field === undefined || typeof field === "string";
  if (
    format !== DOCUMENT_CONTENT_FORMAT ||
    typeof result !== "string" ||
    !optional(fiscalEvidence) ||
    !optional(snapshot) ||
    !Array.isArray(items) ||
    !items.every((item) => typeof item === "string") ||
    Object.keys(rest).length
  )
    corrupt("shape");
  const content: DocumentContent = {
    result: result as string,
    ...(fiscalEvidence === undefined ? {} : { fiscalEvidence: fiscalEvidence as string }),
    items: items as string[],
    ...(snapshot === undefined ? {} : { snapshot: snapshot as string }),
  };
  if (canonical(content) !== text) corrupt("not canonical");
  return content;
}
