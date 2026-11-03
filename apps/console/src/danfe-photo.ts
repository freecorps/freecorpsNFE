/**
 * Reads the barcodes of a DANFE photo in the browser (#296), with the zxing-cpp reader compiled
 * to WebAssembly. Loaded only when the person chooses an image (`import()` in danfe-lookup.tsx).
 * The image never leaves this tab: its header is read for the size, the browser decodes it at
 * most at `MAX_SIDE`, and the pixels go to the WebAssembly reader in memory; nothing here
 * fetches, stores or logs it, creates an address for it, and no reference survives the reading.
 */
import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";
// The console's own copy of the reader, a hashed asset under /assets/: by default the library
// downloads it from a CDN, which the CSP (`connect-src 'self'`) and the privacy promise refuse.
import readerWasm from "zxing-wasm/reader/zxing_reader.wasm?url";
import type { Barcode } from "./danfe-barcode";
import { HEADER_BYTES, MAX_MEGAPIXELS, imageSize, type ImageSize } from "./image-size";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? readerWasm : prefix + path,
  },
});

/**
 * CODE-128, the symbology of the DANFE key, and QR code, only to recognize an NFC-e receipt.
 * `tryRotate` reads the image also at 90, 180 and 270 degrees, `tryHarder` spends more time on a
 * blurred or tilted photo. Only whole reads: `returnErrors` stays off, so a barcode with a failed
 * checksum is not offered as a key.
 */
const options: ReaderOptions = {
  formats: ["Code128", "QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  maxNumberOfSymbols: 8,
};

/** The longest side the photo is decoded at: a 12-megapixel photo would take 48 MB of pixels. */
export const MAX_SIDE = 2560;

/** RGBA pixels, as in `ImageData`; also what the tests build in Node. */
export type Pixels = { data: Uint8ClampedArray; width: number; height: number };

export type PhotoRead =
  | { kind: "read"; codes: Barcode[] }
  /** The browser cannot open the file as an image, or its header is not one we know. */
  | { kind: "unreadable" }
  | { kind: "too_large"; megapixels: number; limit: number };

/** The size the image is decoded at, or its megapixels when it passes `MAX_MEGAPIXELS`. */
export function decodeSize(
  size: ImageSize,
): ({ kind: "fits" } & ImageSize) | { kind: "too_large"; megapixels: number; limit: number } {
  const megapixels = (size.width * size.height) / 1_000_000;
  if (megapixels > MAX_MEGAPIXELS)
    return {
      kind: "too_large",
      // Rounded up: just over the limit never reads as "50; o limite é 50".
      megapixels: Math.ceil(megapixels),
      limit: MAX_MEGAPIXELS,
    };
  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  return {
    kind: "fits",
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** The barcodes read whole from the pixels, in the decoder's order. */
export async function decodePixels(pixels: Pixels): Promise<Barcode[]> {
  const results = await readBarcodes(pixels as ImageData, options);
  return results
    .filter((result) => result.isValid)
    .map((result) => ({
      format: result.format === "QRCode" ? "QRCode" : "Code128",
      text: result.text,
    }));
}

/** Reads the image file's barcodes, refusing it before the decode when it is too large. */
export async function readPhoto(file: Blob): Promise<PhotoRead> {
  const size = imageSize(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  if (!size) return { kind: "unreadable" };
  const target = decodeSize(size);
  if (target.kind === "too_large") return target;
  const pixels = await pixelsOf(file, target);
  return pixels ? { kind: "read", codes: await decodePixels(pixels) } : { kind: "unreadable" };
}

async function pixelsOf(file: Blob, { width, height }: ImageSize): Promise<Pixels | null> {
  let bitmap: ImageBitmap;
  try {
    // The browser decodes straight to the target size; the EXIF orientation is applied, so a
    // phone picture arrives the way it was taken (`imageSize` already swapped the sides).
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    });
  } catch {
    return null;
  }
  try {
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement("canvas"), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const context = canvas.getContext("2d", { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    // Releases the canvas memory now instead of waiting for the garbage collector.
    canvas.width = canvas.height = 0;
    return { data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
