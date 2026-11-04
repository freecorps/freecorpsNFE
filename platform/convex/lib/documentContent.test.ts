import { createHash } from "node:crypto";
import { crc32, gzipSync } from "node:zlib";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vite-plus/test";
import {
  DOCUMENT_CONTENT_FORMAT,
  MAX_DOCUMENT_CONTENT_BYTES,
  decodeDocumentContent,
  encodeDocumentContent,
  type DocumentContent,
  type DocumentContentError,
} from "./documentContent";

// Synthetic only: the stored strings are JSON text, as `documentVersions.result` holds.
const golden: DocumentContent = {
  result: '{"total":"24.69","emitente":"Empresa Fictícia"}',
  items: ['{"nItem":1,"vProd":"24.69"}'],
};

const tricky: DocumentContent = {
  result: JSON.stringify({ vNF: "0.10", qCom: "1.000", vDesc: "-0.00", obs: 'Aspas " e \\ barra' }),
  fiscalEvidence: '{"status":"authorized","valor":"123456789012345678901234567890.123456789"}',
  items: [
    `{"vUnCom":"0.${"1".repeat(400)}","xProd":"Pão de queijo, açúcar — São João"}`,
    '{"xProd":"Linha\\nquebrada\\t\\u0000 e emoji \\ud83d\\ude00"}',
    `texto que não é JSON: 1.10, separador ${String.fromCharCode(0x2028)} e emoji ${String.fromCodePoint(0x1f600)}`,
  ],
  snapshot: '{"cancelada":false,"motivo":"Razão social fictícia Ltda."}',
};

const canonicalOf = (content: DocumentContent) =>
  JSON.stringify({
    format: DOCUMENT_CONTENT_FORMAT,
    result: content.result,
    fiscalEvidence: content.fiscalEvidence,
    items: content.items,
    snapshot: content.snapshot,
  });

/** Arbitrary uncompressed bytes as a blob whose reference matches them. */
function blob(plain: Buffer, bytes: Uint8Array = gzipSync(plain)) {
  const expected = {
    contentSha256: createHash("sha256").update(plain).digest("hex"),
    contentSize: plain.length,
    format: DOCUMENT_CONTENT_FORMAT,
  };
  return [bytes, expected] as const;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConvexError);
  const { code, reason } = (error as ConvexError<DocumentContentError>).data;
  return `${code}: ${reason}`;
}
const corrupt = (reason: string) => `DOCUMENT_CONTENT_CORRUPT: ${reason}`;

describe("document-content/1", () => {
  it("gives the golden identity and the golden gzip bytes", async () => {
    const encoded = await encodeDocumentContent(golden);
    const canonical =
      '{"format":"document-content/1","result":"{\\"total\\":\\"24.69\\",\\"emitente\\":\\"Empresa Fictícia\\"}","items":["{\\"nItem\\":1,\\"vProd\\":\\"24.69\\"}"]}';
    expect(encoded.contentSize).toBe(Buffer.byteLength(canonical));
    expect(encoded.contentSha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(encoded.contentSha256).toBe(
      "313a97f3e1999e6b41608cc0a284c406e655377498cb6715eb8775e35bd05f2c",
    );
    expect(encoded.format).toBe(DOCUMENT_CONTENT_FORMAT);
    const bytes = Buffer.from(encoded.bytes);
    // Header: no flags, mtime 0, XFL 2 (level 9), OS 255. A new fflate that changes these bytes
    // fails here; old blobs stay readable, since only `contentSha256` is identity.
    expect(bytes.subarray(0, 10).toString("hex")).toBe("1f8b08000000000002ff");
    expect(bytes.toString("hex")).toBe(
      "1f8b08000000000002ffab564acb2fca4d2c51b2524ac94f2ecd4dcd2bd14dcecf2b01d2fa864a3a4a45a9c5a53920d9ea18a592fc92c49c1825ab182523133d33cb18259d18a5d4dc4c90da54b0b06b6e01507da2825b6672c9e1b5c99989314ab54033802a728b95aca24166e479023940c58640bd650145f929c8e6d52ac5d60200099b24ff91000000",
    );
    expect(encoded.storedSize).toBe(bytes.length);
    expect(encoded.storedSha256).toBe(
      "c91d465cb9468b27a49cde78e123e22fd27d174791fc9eb25c0cc593a138c769",
    );
    expect(encoded.storedSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("round-trips every stored string byte for byte, with optional fields present or absent", async () => {
    for (const content of [tricky, golden, { result: "", items: [] }]) {
      const encoded = await encodeDocumentContent(content);
      const decoded = await decodeDocumentContent(encoded.bytes, encoded);
      expect(decoded).toStrictEqual(content);
      expect(Object.keys(decoded)).toEqual(Object.keys(content));
    }
  });

  it("reads gzip from another deflater, stored and compressed blocks", async () => {
    const encoded = await encodeDocumentContent(tricky);
    for (const level of [0, 1, 9]) {
      const bytes = gzipSync(canonicalOf(tricky), { level });
      expect(await decodeDocumentContent(bytes, encoded)).toStrictEqual(tricky);
    }
  });

  it("refuses tampered, truncated or mislabelled blobs", async () => {
    const encoded = await encodeDocumentContent(tricky);
    const { bytes } = encoded;
    const flipped = bytes.slice();
    flipped[Math.floor(flipped.length / 2)]! ^= 0x01;
    // BFINAL 1 with the reserved block type 3: fflate fails, the trailer stays intact.
    const badBlock = bytes.slice();
    badBlock[10] = 0x07;
    const longerTrailer = Buffer.from(bytes);
    longerTrailer.writeUInt32LE(encoded.contentSize + 1, longerTrailer.length - 4);
    const cases: Array<[Uint8Array, Partial<typeof encoded>, string]> = [
      [flipped, {}, "sha256"],
      [badBlock, {}, "deflate"],
      [bytes.subarray(0, 17), {}, "gzip header"],
      [bytes.subarray(0, bytes.length - 5), {}, "trailer size"],
      [Buffer.concat([bytes, Buffer.from([0])]), {}, "trailer size"],
      [bytes, { contentSize: encoded.contentSize + 1 }, "trailer size"],
      [bytes, { contentSize: encoded.contentSize - 1 }, "trailer size"],
      [longerTrailer, { contentSize: encoded.contentSize + 1 }, "inflated size"],
      [bytes, { contentSize: -1 }, "declared size"],
      [bytes, { contentSha256: "0".repeat(64) }, "sha256"],
      [bytes, { format: "document-content/2" }, "format"],
    ];
    for (const [input, override, reason] of cases)
      expect(await refusal(decodeDocumentContent(input, { ...encoded, ...override }))).toBe(
        corrupt(reason),
      );
  });

  it("refuses a header with a file name", async () => {
    const [bytes, expected] = blob(Buffer.from(canonicalOf(golden)));
    const named = Buffer.concat([bytes.subarray(0, 10), Buffer.from("x\0"), bytes.subarray(10)]);
    named[3] = 0x08;
    expect(await refusal(decodeDocumentContent(named, expected))).toBe(corrupt("gzip header"));
  });

  it("refuses input longer than any deflater writes for the declared size", async () => {
    const plain = Buffer.from(canonicalOf(golden));
    const empty = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
    const final = Buffer.from([0x01, plain.length & 0xff, plain.length >> 8]);
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc32(plain), 0);
    trailer.writeUInt32LE(plain.length, 4);
    const padded = Buffer.concat([
      Buffer.from("1f8b08000000000000ff", "hex"),
      ...Array<Buffer>(100).fill(empty),
      final,
      Buffer.from([~plain.length & 0xff, (~plain.length >> 8) & 0xff]),
      plain,
      trailer,
    ]);
    const [, expected] = blob(plain);
    expect(await refusal(decodeDocumentContent(padded, expected))).toBe(corrupt("stored size"));
  });

  it("refuses content whose hash matches but whose bytes are not canonical", async () => {
    const tag = `"format":"${DOCUMENT_CONTENT_FORMAT}"`;
    const cases: Array<[Buffer, string]> = [
      [Buffer.from(`{${tag},"result":"ÿ`, "latin1"), "utf-8"],
      [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalOf(golden))]), "json"],
      [Buffer.from(`{${tag},"result":"x","items":[],"extra":"y"}`), "shape"],
      [Buffer.from(`{"format":"outro/1","result":"x","items":[]}`), "shape"],
      [Buffer.from(`{${tag},"result":"a","result":"b","items":[]}`), "not canonical"],
      [Buffer.from(`{${tag}, "result":"x","items":[]}`), "not canonical"],
      [Buffer.from(`{${tag},"items":[],"result":"x"}`), "not canonical"],
      [Buffer.from(`{${tag},"result":"\\u0041","items":[]}`), "not canonical"],
    ];
    for (const [plain, reason] of cases)
      expect(await refusal(decodeDocumentContent(...blob(plain)))).toBe(corrupt(reason));
  });

  it("accepts content exactly at the cap and refuses one byte more", async () => {
    const overhead = Buffer.byteLength(canonicalOf({ result: "", items: [] }));
    const atCap = { result: "0".repeat(MAX_DOCUMENT_CONTENT_BYTES - overhead), items: [] };
    const encoded = await encodeDocumentContent(atCap);
    expect(encoded.contentSize).toBe(MAX_DOCUMENT_CONTENT_BYTES);
    expect(await decodeDocumentContent(encoded.bytes, encoded)).toStrictEqual(atCap);
    expect(await refusal(encodeDocumentContent({ ...atCap, result: atCap.result + "0" }))).toBe(
      "DOCUMENT_CONTENT_TOO_LARGE: content size",
    );
    const [bomb, expected] = blob(Buffer.alloc(MAX_DOCUMENT_CONTENT_BYTES + 1));
    expect(await refusal(decodeDocumentContent(bomb, expected))).toBe(
      "DOCUMENT_CONTENT_TOO_LARGE: declared size",
    );
  });
});
