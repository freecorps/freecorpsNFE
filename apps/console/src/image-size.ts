/**
 * The size of an image from the first bytes of its file, before the browser decodes it (#296):
 * a small JPEG can hold a 30 000 × 30 000 picture, and a full decode would take gigabytes. Reads
 * PNG, JPEG, GIF, WebP, BMP and HEIC/AVIF headers; `null` for anything else or a header past the
 * bytes given. The size is the displayed one: a JPEG EXIF orientation or a HEIC rotation of 90
 * or 270 degrees swaps width and height, as `createImageBitmap` with `imageOrientation:
 * "from-image"` will.
 */
export type ImageSize = { width: number; height: number };

/** Enough for the EXIF block and the SOF marker of a phone JPEG, and for a HEIC `meta` box. */
export const HEADER_BYTES = 1024 * 1024;

/** Past this the file is not a phone photo or a screenshot, and decoding it may exhaust memory. */
export const MAX_MEGAPIXELS = 50;

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const size = png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? bmp(bytes) ?? heif(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  Array.from({ length: text.length }, (_, i) => i).every(
    (i) => bytes[at + i] === text.charCodeAt(i),
  );
const u16be = (b: Uint8Array, at: number) => ((b[at]! << 8) | b[at + 1]!) >>> 0;
const u16le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8)) >>> 0;
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  u32be(Uint8Array.of(b[at + 3]!, b[at + 2]!, b[at + 1]!, b[at]!), 0);
const turned = (size: ImageSize, swap: boolean) =>
  swap ? { width: size.height, height: size.width } : size;

function png(b: Uint8Array) {
  if (b.length < 24 || !ascii(b, 1, "PNG") || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array) {
  if (b.length < 10 || !ascii(b, 0, "GIF8")) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function bmp(b: Uint8Array) {
  if (b.length < 26 || !ascii(b, 0, "BM")) return null;
  return { width: Math.abs(u32le(b, 18) | 0), height: Math.abs(u32le(b, 22) | 0) };
}

function webp(b: Uint8Array) {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (ascii(b, 12, "VP8L"))
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    };
  if (ascii(b, 12, "VP8X")) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

/** Start-of-frame markers: every JPEG coding process except DHT (C4), JPG (C8) and DAC (CC). */
const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let swap = false;
  for (let at = 2; at + 9 < b.length;) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (marker === 0xe1 && ascii(b, at + 4, "Exif\0\0")) swap = exifSwaps(b, at + 10);
    if (sof.has(marker)) return turned({ width: u16be(b, at + 7), height: u16be(b, at + 5) }, swap);
    at += 2 + length;
  }
  return null;
}

/** EXIF orientations 5 to 8 turn the picture by 90 or 270 degrees. */
function exifSwaps(b: Uint8Array, tiff: number) {
  const little = ascii(b, tiff, "II");
  if (!little && !ascii(b, tiff, "MM")) return false;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? u32le(b, at) : u32be(b, at));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > b.length) return false;
  for (let entry = 0, count = u16(ifd); entry < count; entry++) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > b.length) return false;
    if (u16(at) === 0x0112) return u16(at + 8) >= 5 && u16(at + 8) <= 8;
  }
  return false;
}

/**
 * HEIC and AVIF (ISO base media file): `ispe` boxes carry the size of each item. A phone HEIC is
 * a grid of tiles, each with its own `ispe`; the largest is the whole picture. `irot` 1 or 3
 * turns it by 90 or 270 degrees.
 */
function heif(b: Uint8Array) {
  if (b.length < 16 || !ascii(b, 4, "ftyp")) return null;
  let size: ImageSize | null = null;
  let swap = false;
  for (let at = 8; at + 5 <= b.length; at++) {
    if (at + 16 <= b.length && ascii(b, at, "ispe")) {
      const found = { width: u32be(b, at + 8), height: u32be(b, at + 12) };
      if (!size || found.width * found.height > size.width * size.height) size = found;
    } else if (ascii(b, at, "irot")) swap = (b[at + 4]! & 3) % 2 === 1;
  }
  return size && turned(size, swap);
}
