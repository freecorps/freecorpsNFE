import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import * as reader from "zxing-wasm/reader";
import * as writer from "zxing-wasm/writer";
import { accessKeyDigit } from "../../../packages/fiscal-core/src/accessKey";
import { readingFrom } from "./danfe-barcode";
import { reviewedVersion, withoutCdnDefault } from "../zxing-plugin";
import { decodePixels, decodeSize, type Pixels } from "./danfe-photo";
import { imageSize } from "./image-size";

/**
 * The real zxing-cpp reader, in Node, on synthetic DANFE pictures: CODE-128 barcodes of
 * fictitious keys (CNPJ 11.222.333/0001-81, check digit computed here) drawn on a white page
 * with @napi-rs/canvas, the way a photo or a screenshot arrives after the browser decodes it.
 * In the browser the WebAssembly comes from the console's own /assets/; here, from the package.
 */
const require = createRequire(import.meta.url);
// Installed before any module of this file loads, the reader's included: every request the
// decoding could make, also when the WebAssembly is instantiated on the first read.
const requests = vi.hoisted(() => {
  const calls: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    calls.push(args[0]);
    return real(...args);
  }) as typeof fetch;
  return calls;
});
afterAll(() => expect(requests, "nenhuma requisição de rede").toEqual([]));
beforeAll(() => {
  const wasm = (name: string) =>
    readFileSync(require.resolve(`zxing-wasm/${name}/zxing_${name}.wasm`));
  reader.prepareZXingModule({ overrides: { wasmBinary: wasm("reader") } });
  writer.prepareZXingModule({ overrides: { wasmBinary: wasm("writer") } });
});

const withDigit = (base: string) => base + accessKeyDigit(base);
const key = withDigit("3526091122233300018155001000000069112345678");
const other = withDigit("3526091122233300018155001000000070112345678");
const nfce = withDigit("3526091122233300018165001000000069112345678");

type Bars = { text: string; x: number; y: number; format?: "Code128" | "QRCode" };
/**
 * A white "page" with the barcodes at 3 px per module and 110 px tall (an eighth of the width), turned by `degrees`
 * around the centre, and optionally covered by noise.
 */
async function page(
  bars: Bars[],
  { degrees = 0, noise = 0, width = 1000, height = 600 } = {},
): Promise<Pixels> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.translate(-width / 2, -height / 2);
  context.fillStyle = "#000";
  for (const { text, x, y, format = "Code128" } of bars) {
    const { symbol, error } = await writer.writeBarcode(text, { format });
    expect(error).toBe("");
    // One byte per module: 0 is a bar (CODE-128, one row) or a dark cell (QR, 6 px each).
    if (format === "Code128") {
      for (let module = 0; module < symbol!.width; module++)
        if (symbol!.data[module] === 0) context.fillRect(x + module * 3, y, 3, 110);
    } else
      for (let row = 0; row < symbol!.height; row++)
        for (let column = 0; column < symbol!.width; column++)
          if (symbol!.data[row * symbol!.width + column] === 0)
            context.fillRect(x + column * 6, y + row * 6, 6, 6);
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  // Deterministic speckle: a pseudo-random grey per pixel, mixed in by `noise`.
  let seed = 7;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const grey = seed % 256;
    for (let c = 0; c < 3; c++)
      image.data[i + c] = Math.round(image.data[i + c]! * (1 - noise) + grey * noise);
  }
  return { data: image.data, width, height };
}
const read = async (pixels: Pixels) => readingFrom(await decodePixels(pixels));

describe("leitura do código de barras do DANFE", () => {
  it("lê a chave de uma imagem limpa, sem completar nem trocar caractere", async () => {
    expect(await read(await page([{ text: key, x: 80, y: 270 }]))).toEqual({ kind: "one", key });
  });

  it.each([90, 180, 270, 5, 355])("lê a chave com a foto girada %i graus", async (degrees) => {
    const pixels = await page([{ text: key, x: 80, y: 270 }], {
      degrees,
      width: 1000,
      height: 1000,
    });
    expect(await read(pixels)).toEqual({ kind: "one", key });
  });

  it("devolve as duas chaves de uma imagem com dois DANFEs, sem escolher", async () => {
    const reading = await read(
      await page([
        { text: key, x: 80, y: 100 },
        { text: other, x: 80, y: 400 },
      ]),
    );
    expect(reading.kind).toBe("many");
    expect(reading.kind === "many" && [...reading.keys].sort()).toEqual([key, other].sort());
  });

  it("entrega a chave de NFC-e como lida: quem recusa o modelo 65 é o validador", async () => {
    expect(await read(await page([{ text: nfce, x: 80, y: 270 }]))).toEqual({
      kind: "one",
      key: nfce,
    });
  });

  it("não toma por chave um código de barras com outro tamanho", async () => {
    expect(await read(await page([{ text: "0123456789", x: 300, y: 270 }]))).toEqual({
      kind: "not_key",
      lengths: [10],
      malformed: false,
    });
  });

  it("reconhece o QR code de um cupom NFC-e sem tirar a chave dele", async () => {
    // A version 2 NFC-e QR: consultation address, key in p=, then version, environment, CSC id
    // and a fictitious hash.
    const qr = `https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${nfce}|2|2|1|0123456789ABCDEF0123456789ABCDEF01234567`;
    expect(await read(await page([{ text: qr, x: 300, y: 100, format: "QRCode" }]))).toEqual({
      kind: "nfce",
    });
    // Another QR code (a website, a payment) says nothing about the key.
    const site = await page([
      { text: "https://exemplo.invalid/pagar", x: 300, y: 100, format: "QRCode" },
    ]);
    expect(await read(site)).toEqual({ kind: "none" });
  });

  it("não acha nada numa imagem em branco nem numa ilegível", async () => {
    expect(await read(await page([]))).toEqual({ kind: "none" });
    expect(await read(await page([], { noise: 1 }))).toEqual({ kind: "none" });
    // Bars drowned in noise: no partial read is offered.
    expect(await read(await page([{ text: key, x: 80, y: 270 }], { noise: 0.9 }))).toEqual({
      kind: "none",
    });
  });
});

/** A JPEG with an EXIF block whose orientation is `orientation`, inserted after the SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number) {
  const exif = Uint8Array.of(
    0xff,
    0xe1,
    0,
    34,
    ...Buffer.from("Exif\0\0"),
    ...Buffer.from("MM"),
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  return Uint8Array.of(...jpeg.subarray(0, 2), ...exif, ...jpeg.subarray(2));
}

describe("tamanho da imagem antes de decodificar", () => {
  it("lê largura e altura do cabeçalho de PNG, JPEG e WebP", async () => {
    const canvas = createCanvas(640, 480);
    for (const format of ["png", "jpeg", "webp"] as const)
      expect(imageSize(await canvas.encode(format as "png")), format).toEqual({
        width: 640,
        height: 480,
      });
  });

  it("troca os lados de um JPEG girado pela orientação EXIF", async () => {
    const jpeg = await createCanvas(640, 480).encode("jpeg");
    expect(imageSize(withOrientation(jpeg, 6))).toEqual({ width: 480, height: 640 });
    expect(imageSize(withOrientation(jpeg, 3))).toEqual({ width: 640, height: 480 });
  });

  it("lê GIF, BMP e HEIC; recusa o que não reconhece", () => {
    const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    expect(imageSize(Uint8Array.of(...Buffer.from("GIF89a"), 0x80, 2, 0xe0, 1))).toEqual({
      width: 640,
      height: 480,
    });
    const bmp = new Uint8Array(26);
    bmp.set(Buffer.from("BM"));
    new DataView(bmp.buffer).setInt32(18, 640, true);
    new DataView(bmp.buffer).setInt32(22, -480, true);
    expect(imageSize(bmp)).toEqual({ width: 640, height: 480 });
    // A phone HEIC: tiles of 512 and the whole grid, turned 90 degrees.
    const heic = Uint8Array.of(
      ...u32(16),
      ...Buffer.from("ftypheic"),
      0,
      0,
      0,
      0,
      ...u32(20),
      ...Buffer.from("ispe"),
      0,
      0,
      0,
      0,
      ...u32(512),
      ...u32(512),
      ...u32(20),
      ...Buffer.from("ispe"),
      0,
      0,
      0,
      0,
      ...u32(4032),
      ...u32(3024),
      ...u32(9),
      ...Buffer.from("irot"),
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    );
    expect(imageSize(heic)).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(Buffer.from("não é imagem"))).toBeNull();
    expect(imageSize(Uint8Array.of(0xff, 0xd8, 0xff))).toBeNull();
  });

  it("recusa acima de 50 megapixels e reduz o resto a 2560 px no lado maior", () => {
    expect(decodeSize({ width: 8000, height: 7000 })).toEqual({
      kind: "too_large",
      megapixels: 56,
      limit: 50,
    });
    expect(decodeSize({ width: 8192, height: 6144 })).toMatchObject({ megapixels: 51 });
    expect(decodeSize({ width: 30000, height: 30000 })).toEqual({
      kind: "too_large",
      megapixels: 900,
      limit: 50,
    });
    expect(decodeSize({ width: 4000, height: 3000 })).toEqual({
      kind: "fits",
      width: 2560,
      height: 1920,
    });
    expect(decodeSize({ width: 1000, height: 600 })).toEqual({
      kind: "fits",
      width: 1000,
      height: 600,
    });
  });
});

describe("o .wasm do leitor vem do próprio console", () => {
  it("o build troca o endereço de CDN padrão da biblioteca por um erro", () => {
    const share = readFileSync(
      require.resolve("zxing-wasm/reader").replace(/cjs[\\/]reader[\\/]index\.js$/, "es/share.js"),
      "utf8",
    );
    expect(share).toContain("fastly.jsdelivr.net");
    const rewritten = withoutCdnDefault(share);
    expect(rewritten).not.toMatch(/jsdelivr|https:\/\//);
    expect(rewritten).toContain("o .wasm vem do próprio console");
    expect(() => withoutCdnDefault("export {}")).toThrow(/mudou de formato/);
    expect(() =>
      withoutCdnDefault(share.replace(`zxing-wasm@${reviewedVersion}`, "zxing-wasm@9.9.9")),
    ).toThrow(/revisado para/);
  });
});
