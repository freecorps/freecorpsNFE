import { gzipSync } from "node:zlib";
export const nsu = (value: number) => String(value).padStart(15, "0");
export function distributionXml(
  options: {
    status?: string;
    last?: number;
    max?: number;
    environment?: "1" | "2";
    envelopes?: { nsu: number; xml: Uint8Array | string; schema?: string }[];
  } = {},
) {
  const envelopes = options.envelopes ?? [];
  return Buffer.from(
    `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${options.environment ?? "2"}</tpAmb><verAplic>synthetic-78</verAplic><cStat>${options.status ?? (envelopes.length ? "138" : "137")}</cStat><xMotivo>Resposta sintetica</xMotivo><dhResp>2026-09-23T12:00:00-03:00</dhResp><ultNSU>${nsu(options.last ?? envelopes.at(-1)?.nsu ?? 0)}</ultNSU><maxNSU>${nsu(options.max ?? options.last ?? envelopes.at(-1)?.nsu ?? 0)}</maxNSU>${envelopes.length ? `<loteDistDFeInt>${envelopes.map((e) => `<docZip NSU="${nsu(e.nsu)}" schema="${e.schema ?? "resNFe_v1.01.xsd"}">${gzipSync(e.xml).toString("base64")}</docZip>`).join("")}</loteDistDFeInt>` : ""}</retDistDFeInt>`,
  );
}
