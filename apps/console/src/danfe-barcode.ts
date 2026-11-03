/**
 * What the barcodes read from a DANFE photo mean for the key field (#296). Pure: the decoder
 * (`danfe-photo.ts`) gives the codes, this decides what the person sees. The DANFE prints the
 * access key as a CODE-128 barcode; a text counts as a key only when it has the 44 positions of
 * one, and it is never trimmed, padded or completed. Whether the key is valid (check digit,
 * model 55, state, month) stays with the same validator as a typed key.
 *
 * The NFC-e receipt (model 65) prints no CODE-128: its key is text, and a QR code opens the
 * state's consultation. That QR only says "this is an NFC-e"; nothing is taken from it.
 */
export type Barcode = { format: "Code128" | "QRCode"; text: string };

export type BarcodeReading =
  /** No barcode in the image, or none the decoder could read whole. */
  | { kind: "none" }
  /**
   * CODE-128 read, none a key: the lengths that are not 44, in increasing order, and whether a
   * 44-position code had characters a key does not have.
   */
  | { kind: "not_key"; lengths: number[]; malformed: boolean }
  /** One key: it goes to the field, for the person to compare with the printed one. */
  | { kind: "one"; key: string }
  /** Different keys in the same image: the person picks one, never the console. */
  | { kind: "many"; keys: string[] }
  /** The QR code of an NFC-e receipt, and no DANFE key beside it. */
  | { kind: "nfce" };

/** 44 digits, or letters in the alphanumeric CNPJ; the validator says which positions allow them. */
const KEY = /^[0-9A-Z]{44}$/;

/**
 * The NFC-e QR code (MOC, Anexo I): the state's consultation address with the key in `p=`
 * (version 2, `p=<key>|2|...`) or in `chNFe=` (version 1). Model 65 at positions 21 and 22.
 */
const NFCE_QR = /[?&](?:p|chNFe)=([0-9A-Z]{44})(?![0-9A-Z])/i;
export function isNfceQr(text: string): boolean {
  const key = NFCE_QR.exec(text)?.[1];
  return key !== undefined && key.slice(20, 22) === "65";
}

export function readingFrom(codes: readonly Barcode[]): BarcodeReading {
  const linear = codes.filter((code) => code.format === "Code128").map((code) => code.text);
  const keys = [...new Set(linear.filter((text) => KEY.test(text)))];
  if (keys.length === 1) return { kind: "one", key: keys[0]! };
  if (keys.length > 1) return { kind: "many", keys };
  // Any other QR code (a payment link, a website) says nothing about the key and is ignored.
  if (codes.some((code) => code.format === "QRCode" && isNfceQr(code.text)))
    return { kind: "nfce" };
  // A contingency DANFE (FS-DA) also prints a 36-digit barcode with the note's data: beside a
  // key it is ignored above; alone, it is not a key.
  if (linear.length)
    return {
      kind: "not_key",
      lengths: [...new Set(linear.map((text) => text.length))]
        .filter((length) => length !== 44)
        .sort((a, b) => a - b),
      malformed: linear.some((text) => text.length === 44),
    };
  return { kind: "none" };
}
