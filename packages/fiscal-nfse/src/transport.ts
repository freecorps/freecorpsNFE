import { gunzipSync, gzipSync } from "node:zlib";
import { fail } from "./errors.js";

export type { NfseHttpRequest, NfseHttpResponse, NfseTransport } from "./http.js";

/** O XML fiscal viaja como gzip+base64 num campo JSON. */
export const gzipB64 = (xml: string): string =>
  gzipSync(Buffer.from(xml, "utf8")).toString("base64");

/** Teto do XML descompactado vindo do fisco: corta bomba de descompressão. */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

/** Erros de base64, gzip corrompido ou teto excedido viram `XML_DECOMPRESS_INVALID`. */
export const gunzipB64 = (b64: string): string => {
  try {
    return gunzipSync(Buffer.from(b64, "base64"), { maxOutputLength: MAX_XML_BYTES }).toString(
      "utf8",
    );
  } catch {
    return fail("XML_DECOMPRESS_INVALID", "Não foi possível descompactar o XML recebido.");
  }
};
