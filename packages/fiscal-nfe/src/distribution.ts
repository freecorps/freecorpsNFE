import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { normalizeCnpj } from "@freecorps/fiscal-core";
import { child, children, decodeXml, dom, fail, NFE_NS, serialize, text, value } from "./xml.js";
import { validateDistributionSchema } from "./schema.js";

export const DISTRIBUTION_VERSION = "nfe-distribution/1";
export const DISTRIBUTION_LIMITS = {
  response: 2 * 1024 * 1024,
  envelope: 2 * 1024 * 1024,
  expanded: 16 * 1024 * 1024,
  ratio: 200,
  envelopes: 50,
} as const;
export const DISTRIBUTION_ENDPOINTS = {
  sandbox: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  production: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
} as const;
export type DistributionRequest = {
  cnpj: string;
  environment: "sandbox" | "production";
  nsu: string;
  mode?: "distNSU" | "consNSU";
};
export type DistributionEnvelope = { nsu: string; schema: string; xml: Uint8Array; sha256: string };
export type DistributionResponse = {
  status: string;
  lastNsu: string | null;
  maxNsu: string | null;
  envelopes: DistributionEnvelope[];
};
export function normalizeNsu(input: string): string {
  if (!/^\d{1,15}$/.test(input)) return fail("DISTRIBUTION_NSU_INVALID");
  return input.padStart(15, "0");
}
export function distributionRequest(input: DistributionRequest) {
  const cnpj = normalizeCnpj(input.cnpj);
  if (!cnpj || cnpj !== input.cnpj) return fail("DISTRIBUTION_CNPJ_INVALID");
  const nsu = normalizeNsu(input.nsu);
  const mode = input.mode ?? "distNSU";
  if (
    !["distNSU", "consNSU"].includes(mode) ||
    !Object.hasOwn(DISTRIBUTION_ENDPOINTS, input.environment)
  )
    return fail("DISTRIBUTION_REQUEST_INVALID");
  const data = `<distDFeInt xmlns="${NFE_NS}" versao="1.01"><tpAmb>${input.environment === "production" ? "1" : "2"}</tpAmb><CNPJ>${cnpj}</CNPJ><${mode}><${mode === "distNSU" ? "ultNSU" : "NSU"}>${nsu}</${mode === "distNSU" ? "ultNSU" : "NSU"}></${mode}></distDFeInt>`;
  validateDistributionSchema(data, "distDFeInt");
  const service = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe";
  return {
    url: DISTRIBUTION_ENDPOINTS[input.environment],
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${service}/nfeDistDFeInteresse"`,
    },
    body: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><nfeDistDFeInteresse xmlns="${service}"><nfeDadosMsg>${data}</nfeDadosMsg></nfeDistDFeInteresse></soap:Body></soap:Envelope>`,
  };
}
/** Interpretation has no cursor, clock, retry policy or implicit network access. */
export function parseDistribution(
  bytes: Uint8Array,
  environment: DistributionRequest["environment"],
): DistributionResponse {
  if (bytes.byteLength > DISTRIBUTION_LIMITS.response) return fail("DISTRIBUTION_RESPONSE_LIMIT");
  const document = dom(decodeXml(bytes));
  const nodes = document.getElementsByTagNameNS(NFE_NS, "retDistDFeInt");
  if (nodes.length !== 1) return fail("DISTRIBUTION_RESPONSE_INVALID");
  const root = nodes[0]!;
  validateDistributionSchema(serialize(root), "retDistDFeInt");
  if (text(root, "tpAmb") !== (environment === "production" ? "1" : "2"))
    return fail("DISTRIBUTION_ENVIRONMENT_MISMATCH");
  const last = value(root, "ultNSU", true),
    max = value(root, "maxNSU", true);
  const status = text(root, "cStat");
  const batch = child(root, "loteDistDFeInt", true);
  const docs = batch ? children(batch, "docZip") : [];
  if (docs.length > DISTRIBUTION_LIMITS.envelopes || (status !== "138" && docs.length))
    return fail("DISTRIBUTION_RESPONSE_INVALID");
  if (
    (status === "137" || status === "138") &&
    (!last || !max || (status === "138" && !docs.length))
  )
    return fail("DISTRIBUTION_RESPONSE_INVALID");
  const lastNsu = last ? normalizeNsu(last) : null,
    maxNsu = max ? normalizeNsu(max) : null;
  if (lastNsu && maxNsu && lastNsu > maxNsu) return fail("DISTRIBUTION_RESPONSE_INVALID");
  let expanded = 0;
  const seen = new Set<string>();
  const envelopes = docs.map((node): DistributionEnvelope => {
    const schema = node.getAttribute("schema");
    if (!schema?.trim()) return fail("DISTRIBUTION_RESPONSE_INVALID");
    const nsu = normalizeNsu(node.getAttribute("NSU") ?? "");
    if (seen.has(nsu)) return fail("DISTRIBUTION_DUPLICATE_NSU");
    seen.add(nsu);
    const encoded = (node.textContent ?? "").replace(/\s/g, "");
    if (
      !encoded ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      return fail("DISTRIBUTION_BASE64_INVALID");
    const compressed = Buffer.from(encoded, "base64");
    let xml: Buffer;
    try {
      xml = gunzipSync(compressed, {
        maxOutputLength: Math.min(
          DISTRIBUTION_LIMITS.envelope,
          compressed.length * DISTRIBUTION_LIMITS.ratio,
          DISTRIBUTION_LIMITS.expanded - expanded,
        ),
      });
    } catch {
      return fail("DISTRIBUTION_EXPANSION_LIMIT_OR_INVALID_GZIP");
    }
    expanded += xml.length;
    decodeXml(xml);
    return {
      nsu,
      schema,
      xml,
      sha256: createHash("sha256").update(xml).digest("hex"),
    };
  });
  if (
    envelopes.some(
      (e, i) => (i > 0 && e.nsu <= envelopes[i - 1]!.nsu) || (lastNsu !== null && e.nsu > lastNsu),
    )
  )
    return fail("DISTRIBUTION_SEQUENCE_INVALID");
  return { status, lastNsu, maxNsu, envelopes };
}
/** Credentials are opaque to the connector and live only in the caller's transport. */
export async function distribute<Credential>(
  input: DistributionRequest & {
    credential: Credential;
    transport: (
      request: ReturnType<typeof distributionRequest>,
      credential: Credential,
    ) => Promise<Uint8Array>;
  },
) {
  const raw = await input.transport(distributionRequest(input), input.credential);
  return { raw, ...parseDistribution(raw, input.environment) };
}
