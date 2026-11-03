/**
 * Alvos do contrato ADN: JSON {dpsXmlGZipB64} no envio, consulta por DPS,
 * consulta da NFS-e pela chave e registro de eventos. Os quatro caminhos são
 * explícitos por alvo, porque a base de cada um difere:
 *   - Sefin Nacional: hosts e caminhos de `convex/engine/sefin.ts`, base
 *     `/SefinNacional`: POST /nfse, GET /dps/{id}, GET /nfse/{chave},
 *     POST /nfse/{chave}/eventos.
 *   - Campinas (IMA): guia da Prefeitura de 18/09/2026, produção desde
 *     21/09/2026, registrado no ADR 0004. Substitui o par do legado
 *     (`novanfse.campinas.sp.gov.br` + `/notafiscal-ws/api/adn` + `/dps`),
 *     que ficou desatualizado. Base `/notafiscal-ws/nfse`: POST {base},
 *     GET {base}/dps/{id}, GET {base}/{chave}, POST {base}/{chave}/eventos.
 */
import { fail } from "./errors.js";

/**
 * Política por validador: Sefin Nacional = RSA-SHA256; Campinas (IMA) só
 * aceita RSA-SHA1/SHA1 (E0714 no homolog em 29/08/2026 com SHA-256, herança
 * do validador ABRASF).
 */
export type SignaturePolicy = "rsa-sha256" | "rsa-sha1";

export type NfseTargetId = "sefin-nacional" | "campinas-adn";
export type NfseEnvironment = "producao-restrita" | "producao";

export interface NfseTarget {
  id: NfseTargetId;
  environment: NfseEnvironment;
}

export interface NfseEndpoint extends NfseTarget {
  host: string;
  /** Base comum aos quatro caminhos abaixo, todos relativos a ela. */
  basePath: string;
  /** Envio da DPS: POST {basePath}{submitPath}. */
  submitPath: string;
  /** Consulta por DPS: GET {basePath}{dpsPath}/{id}. */
  dpsPath: string;
  /** NFS-e: GET {basePath}{nfsePath}/{chave}; eventos: POST {basePath}{nfsePath}/{chave}/eventos. */
  nfsePath: string;
  signature: SignaturePolicy;
  /** tpAmb exigido na DPS e nos eventos deste ambiente. */
  tpAmb: 1 | 2;
}

export const SEFIN_HOSTS = {
  producaoRestrita: "sefin.producaorestrita.nfse.gov.br",
  producao: "sefin.nfse.gov.br",
} as const;

export const CAMPINAS_HOSTS = {
  homologacao: "preprod-nfseapi.ima.sp.gov.br",
  producao: "nfseapi.campinas.sp.gov.br",
} as const;

// O guia dá a base `/notafiscal-ws/nfse`: envio por POST na própria base,
// consulta por DPS em {base}/dps/{id}, NFS-e em {base}/{chave} e eventos em
// {base}/{chave}/eventos (a biblioteca `4success/nfse-campinas` usa os
// mesmos). Até 09/10/2026 a base era `/notafiscal-ws` com os caminhos da
// Sefin, e a consulta por DPS caía em `/notafiscal-ws/dps/{id}`, rota que não
// existe: a IMA respondeu 404 e a reconciliação reenviou a DPS (#197).
const CAMPINAS_BASE_PATH = "/notafiscal-ws/nfse";

export function resolveEndpoint(target: NfseTarget): NfseEndpoint {
  const { id, environment } = target;
  if (environment !== "producao" && environment !== "producao-restrita")
    return fail("TARGET_INVALID", "Ambiente deve ser producao ou producao-restrita.");
  const tpAmb = environment === "producao" ? 1 : 2;
  if (id === "sefin-nacional")
    return {
      id,
      environment,
      host: environment === "producao" ? SEFIN_HOSTS.producao : SEFIN_HOSTS.producaoRestrita,
      basePath: "/SefinNacional",
      submitPath: "/nfse",
      dpsPath: "/dps",
      nfsePath: "/nfse",
      signature: "rsa-sha256",
      tpAmb,
    };
  if (id === "campinas-adn")
    return {
      id,
      environment,
      host: environment === "producao" ? CAMPINAS_HOSTS.producao : CAMPINAS_HOSTS.homologacao,
      basePath: CAMPINAS_BASE_PATH,
      submitPath: "",
      dpsPath: "/dps",
      nfsePath: "",
      // O validador da IMA rejeitou SHA-256 com E0714 no homolog antigo
      // (29/08/2026). Na homologação nova (preprod-nfseapi), em 09/10/2026, a
      // DPS assinada em RSA-SHA1 foi autorizada e o pedido de cancelamento
      // registrado (docs/v1.0/evidence/197/README.md). A produção da IMA não
      // foi exercitada pela plataforma.
      signature: "rsa-sha1",
      tpAmb,
    };
  return fail("TARGET_INVALID", "Alvo NFS-e desconhecido.");
}

export const endpointUrl = (endpoint: NfseEndpoint, path: string) =>
  `https://${endpoint.host}${endpoint.basePath}${path}`;

/** URL do envio da DPS. */
export const submitUrl = (endpoint: NfseEndpoint) => endpointUrl(endpoint, endpoint.submitPath);
/** URL da consulta por Id da DPS. */
export const dpsUrl = (endpoint: NfseEndpoint, dpsId: string) =>
  endpointUrl(endpoint, `${endpoint.dpsPath}/${dpsId}`);
/** URL da NFS-e pela chave de acesso. */
export const nfseUrl = (endpoint: NfseEndpoint, chaveAcesso: string) =>
  endpointUrl(endpoint, `${endpoint.nfsePath}/${chaveAcesso}`);
/** URL do registro de eventos da NFS-e. */
export const eventsUrl = (endpoint: NfseEndpoint, chaveAcesso: string) =>
  `${nfseUrl(endpoint, chaveAcesso)}/eventos`;
