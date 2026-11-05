/**
 * Adaptador do contrato ADN (Sefin Nacional e API NFS-e de Campinas), portado de
 * `convex/engine/sefin.ts` com o transporte injetado. Cada chamada devolve um
 * desfecho classificado, alinhado a `platform/convex/lib/operationValues.ts`:
 *
 * - `success`: o fisco devolveu a NFS-e (ou registrou o evento);
 * - `transient`: indisponibilidade (5xx, 429) ou acesso negado pelo gateway
 *   (401/403), sem rejeição de conteúdo; repetir depois, consultando antes;
 * - `definitive`: rejeição estruturada do fisco (ex. E0714) ou erro local
 *   detectado antes do envio (`sent: false`);
 * - `uncertain`: o pedido pode ter produzido efeito e não sabemos qual —
 *   exceção do transporte, resposta ilegível ou "DPS já existe". Reconcilie
 *   com `consultByDps(dpsId)` antes de qualquer reenvio. Com resposta, o
 *   desfecho incerto traz `diagnostic` (status, tipo de mídia e nomes das
 *   chaves de topo do JSON, nunca valores) para descobrir o formato do fisco.
 *
 * Rejeições de negócio chegam como 4xx com JSON { erros: [...] }; o adaptador
 * nunca lança por status HTTP.
 */
import { DOMParser } from "@xmldom/xmldom";
import { NfseError } from "./errors.js";
import { buildDps } from "./build.js";
import { NFSE_NS, type DpsInput } from "./dps.js";
import { EVENTO_CANCELAMENTO, buildCancelEvent, type CancelEventInput } from "./events.js";
import { signDps, signEvent, type SignerKeys } from "./signer.js";
import {
  dpsUrl,
  eventsUrl,
  nfseUrl,
  resolveEndpoint,
  submitUrl,
  type NfseEndpoint,
  type NfseTarget,
} from "./targets.js";
import { gunzipB64, gzipB64, type NfseHttpResponse, type NfseTransport } from "./transport.js";

export interface Rejection {
  code: string | null;
  message: string;
  complement: string | null;
}

export interface NfseQueryContext {
  transport: NfseTransport;
  target: NfseTarget;
}

export interface NfseContext extends NfseQueryContext {
  signer: SignerKeys;
}

export interface IssueInput {
  dps: DpsInput;
}

export interface CancelInput {
  event: CancelEventInput;
}

/** DPS montada (e assinada) pelo chamador, persistida antes do envio. */
export interface SignedDps {
  dpsId: string;
  signedDpsXml: string;
}

/** Pedido de cancelamento montado (e assinado) pelo chamador. */
export interface SignedCancelEvent {
  eventId: string;
  chNFSe: string;
  signedEventXml: string;
}

/**
 * Forma de uma resposta que o adaptador não soube ler, para o chamador
 * persistir junto da tentativa. Só metadados: status, tipo de mídia sem
 * parâmetros, a natureza do corpo e os NOMES das chaves de topo do JSON (até
 * 20). Nunca valores, que podem trazer XML fiscal, chave ou dados do tomador.
 */
export interface ResponseDiagnostic {
  httpStatus: number;
  contentType: string | null;
  body: "empty" | "json-object" | "json-other" | "html" | "xml" | "text";
  keys: string[];
}

/** Campos comuns: o que o chamador persiste para reconciliar. */
interface Sent {
  dpsId: string;
  signedDpsXml: string;
  httpStatus: number | null;
}

export type IssueOutcome =
  | (Sent & { kind: "success"; chaveAcesso: string; nfseXml: string })
  | (Sent & { kind: "transient"; code: TransientCode; rejections: Rejection[] })
  | (Sent & { kind: "definitive"; code: "ADN_REJECTED"; sent: true; rejections: Rejection[] })
  | {
      kind: "definitive";
      code: string;
      sent: false;
      message: string;
      dpsId: string | null;
      signedDpsXml: null;
      httpStatus: null;
      rejections: [];
    }
  | (Sent & {
      kind: "uncertain";
      code: UncertainCode;
      rejections: Rejection[];
      /** Null quando não houve resposta (`TRANSPORT_UNCERTAIN`). */
      diagnostic: ResponseDiagnostic | null;
    });

export type ConsultOutcome =
  | { kind: "found"; dpsId: string; chaveAcesso: string; httpStatus: number }
  | { kind: "not-found"; dpsId: string; httpStatus: 404 }
  | {
      kind: "transient";
      dpsId: string;
      code: TransientCode | "TRANSPORT_FAILED";
      httpStatus: number | null;
    }
  | {
      kind: "uncertain";
      dpsId: string;
      code: ConsultUncertainCode;
      httpStatus: number;
      diagnostic: ResponseDiagnostic;
    };

export type NfseConsultOutcome =
  | { kind: "found"; chaveAcesso: string; nfseXml: string; httpStatus: number }
  | { kind: "not-found"; chaveAcesso: string; httpStatus: 404 }
  | {
      kind: "transient";
      chaveAcesso: string;
      code: TransientCode | "TRANSPORT_FAILED";
      httpStatus: number | null;
    }
  | {
      kind: "uncertain";
      chaveAcesso: string;
      code: ConsultUncertainCode;
      httpStatus: number;
      diagnostic: ResponseDiagnostic;
    };

interface EventSent {
  eventId: string;
  signedEventXml: string;
  httpStatus: number | null;
}

export type CancelOutcome =
  | (EventSent & { kind: "success"; eventXml: string | null; alreadyRegistered: boolean })
  | (EventSent & { kind: "transient"; code: TransientCode; rejections: Rejection[] })
  | (EventSent & { kind: "definitive"; code: "ADN_REJECTED"; sent: true; rejections: Rejection[] })
  | {
      kind: "definitive";
      code: string;
      sent: false;
      message: string;
      eventId: string | null;
      signedEventXml: null;
      httpStatus: null;
      rejections: [];
    }
  | (EventSent & { kind: "uncertain"; code: UncertainCode; rejections: Rejection[] });

export type ConsultUncertainCode =
  | "RESPONSE_UNREADABLE"
  | "HTTP_UNEXPECTED"
  | "CONSULT_INCONCLUSIVE";
export type TransientCode = "ADN_UNAVAILABLE" | "ADN_RATE_LIMITED" | "ADN_ACCESS_DENIED";
export type UncertainCode =
  | "TRANSPORT_UNCERTAIN"
  | "RESPONSE_UNREADABLE"
  | "HTTP_UNEXPECTED"
  | "DPS_ALREADY_EXISTS";

export interface NfseProvider {
  readonly id: "nacional";
  issue(input: IssueInput, ctx: NfseContext): Promise<IssueOutcome>;
  /** Envia uma DPS já montada; não remonta nem reassina. */
  submitDps(input: SignedDps, ctx: NfseQueryContext): Promise<IssueOutcome>;
  consultByDps(dpsId: string, ctx: NfseQueryContext): Promise<ConsultOutcome>;
  consultByAccessKey(chaveAcesso: string, ctx: NfseQueryContext): Promise<NfseConsultOutcome>;
  cancel(input: CancelInput, ctx: NfseContext): Promise<CancelOutcome>;
  /** Envia um pedido de cancelamento já montado; não remonta nem reassina. */
  submitCancelEvent(input: SignedCancelEvent, ctx: NfseQueryContext): Promise<CancelOutcome>;
}

const DPS_ID = /^DPS\d{7}\d[0-9A-Z]{14}\d{20}$/;
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : null;

/**
 * Chave de acesso de 50 dígitos. Aceita também o Id da NFS-e do leiaute
 * nacional (`NFS` + chave, o `infNFSe/@Id`), que a biblioteca
 * `4success/nfse-campinas` admite na resposta da IMA; devolve só os dígitos.
 */
function accessKeyOf(value: unknown): string | null {
  const match = /^(?:NFS)?(\d{50})$/.exec(str(value) ?? "");
  return match ? match[1]! : null;
}

const DIAGNOSTIC_KEYS = 20;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** Metadados de uma resposta ilegível; veja `ResponseDiagnostic`. */
export function diagnose(response: NfseHttpResponse): ResponseDiagnostic {
  const media = (response.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const text = response.body.trim();
  let body: ResponseDiagnostic["body"] = "text";
  let keys: string[] = [];
  if (!text) body = "empty";
  else if (/^[{["]/.test(text)) {
    const parsed = parseJson(text);
    if (parsed) {
      body = "json-object";
      // Nomes fora do padrão de identificador (números, chaves, textos) ficam de fora.
      keys = Object.keys(parsed)
        .filter((key) => KEY_NAME.test(key))
        .slice(0, DIAGNOSTIC_KEYS);
    } else if (isJson(text)) body = "json-other";
  } else if (/^<(!doctype\s+html|html[\s>])/i.test(text)) body = "html";
  else if (text.startsWith("<")) body = "xml";
  return {
    httpStatus: response.status,
    contentType: MEDIA_TYPE.test(media) ? media : null,
    body,
    keys,
  };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Um 404 só prova que a DPS (ou a NFS-e) não existe quando o corpo é o JSON do
 * fisco: o envelope do padrão nacional (`tipoAmbiente`, `versaoAplicativo`,
 * `dataHoraProcessamento`, que a IMA devolve até no 404) ou uma lista de
 * erros/alertas. 404 vazio, HTML ou outro JSON (como o erro de rota do servidor
 * de aplicação, `timestamp`/`status`/`error`/`path`) pode vir de uma rota que
 * não existe ou de um proxy, e não autoriza reenvio: em 09/10/2026 a IMA
 * respondeu 404 a uma rota errada e a DPS foi reenviada (#197).
 */
const ABSENCE_ENVELOPE = ["tipoAmbiente", "versaoAplicativo", "dataHoraProcessamento"];
const ABSENCE_LISTS = ["erros", "Erros", "erro", "Erro", "alertas", "Alertas"];
export function fiscalAbsence(response: NfseHttpResponse): boolean {
  if (response.status !== 404) return false;
  const body = parseJson(response.body);
  if (!body) return false;
  if (ABSENCE_ENVELOPE.some((key) => body[key] !== undefined && body[key] !== null)) return true;
  return ABSENCE_LISTS.some((key) => {
    const value = body[key];
    return Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object";
  });
}

/**
 * Lista estruturada de rejeições. A Sefin varia a caixa dos campos entre
 * endpoints (codigo/Codigo, mensagem/Descricao...). Sem lista, usa a
 * mensagem de topo. Vazio quando nada é legível.
 */
export function extractRejections(body: Record<string, unknown> | null): Rejection[] {
  if (!body) return [];
  const list = body.erros ?? body.errors ?? body.Erros;
  if (Array.isArray(list))
    return list.flatMap((item): Rejection[] => {
      if (!item || typeof item !== "object") return [];
      const e = item as Record<string, unknown>;
      const message = str(
        e.mensagem ?? e.Mensagem ?? e.Descricao ?? e.descricao ?? e.message ?? e.Message,
      );
      const code = str(e.codigo ?? e.Codigo ?? e.code ?? e.Code);
      if (!message && !code) return [];
      return [
        {
          code,
          message: message ?? "",
          complement: str(e.complemento ?? e.Complemento ?? e.complement),
        },
      ];
    });
  const message = str(body.mensagem ?? body.message);
  return message ? [{ code: null, message, complement: null }] : [];
}

type Classified =
  | { kind: "ok"; status: number; body: Record<string, unknown> | null }
  | { kind: "transient"; code: TransientCode; status: number; rejections: Rejection[] }
  | { kind: "rejected"; status: number; rejections: Rejection[] }
  | {
      kind: "uncertain";
      code: "RESPONSE_UNREADABLE" | "HTTP_UNEXPECTED";
      status: number;
      rejections: Rejection[];
    };

/** Classificação comum a todos os endpoints, por status e corpo. */
function classify(response: NfseHttpResponse): Classified {
  const { status } = response;
  const body = parseJson(response.body);
  const rejections = extractRejections(body);
  if (status >= 200 && status < 300) return { kind: "ok", status, body };
  if (status === 429) return { kind: "transient", code: "ADN_RATE_LIMITED", status, rejections };
  if (status >= 500 && status < 600)
    return { kind: "transient", code: "ADN_UNAVAILABLE", status, rejections };
  // 401/403 vêm do gateway/credencial (ex.: produção da NovaNFSe fechada,
  // 401 para todos em ago/2026), nunca do conteúdo da DPS.
  if (status === 401 || status === 403)
    return { kind: "transient", code: "ADN_ACCESS_DENIED", status, rejections };
  if (status >= 400 && status < 500 && status !== 408) {
    // Sem corpo estruturado não há prova de que o pedido foi recusado.
    if (rejections.length) return { kind: "rejected", status, rejections };
    return { kind: "uncertain", code: "RESPONSE_UNREADABLE", status, rejections };
  }
  return { kind: "uncertain", code: "HTTP_UNEXPECTED", status, rejections };
}

const localFailure = (error: unknown) => {
  if (!(error instanceof NfseError)) throw error;
  return { code: error.code, message: error.message };
};

async function send(
  transport: NfseTransport,
  request: Parameters<NfseTransport>[0],
): Promise<NfseHttpResponse | null> {
  try {
    const response = await transport(request);
    if (!response || !Number.isInteger(response.status) || typeof response.body !== "string")
      return null;
    return response;
  } catch {
    // Timeout, conexão encerrada, TLS: o pedido pode ter chegado.
    return null;
  }
}

function checkEnvironment(endpoint: NfseEndpoint, tpAmb: number) {
  if (tpAmb !== endpoint.tpAmb)
    throw new NfseError(
      "ENVIRONMENT_MISMATCH",
      `tpAmb ${tpAmb} não corresponde ao ambiente ${endpoint.environment} do alvo.`,
    );
}

const DUPLICATE_DPS = /j[áa] existe|duplicad/i;
const DUPLICATE_EVENT = /j[áa].{0,20}registrad|duplicad/i;

// O sinal de duplicidade pode vir no código, na mensagem ou no complemento.
const mentions = (rejections: Rejection[], pattern: RegExp) =>
  rejections.some((r) => pattern.test(`${r.code ?? ""} ${r.message} ${r.complement ?? ""}`));
// Rejeição só com código: sem texto, não dá para descartar duplicidade.
const codeOnly = (rejections: Rejection[]) =>
  rejections.every((r) => r.message.trim() === "" && !r.complement);

async function issue(input: IssueInput, ctx: NfseContext): Promise<IssueOutcome> {
  let dpsId: string | null = null,
    signed: string;
  try {
    const endpoint = resolveEndpoint(ctx.target);
    checkEnvironment(endpoint, input.dps.tpAmb);
    const built = buildDps(input.dps);
    dpsId = built.id;
    signed = signDps(built, ctx.signer, endpoint.signature);
  } catch (error) {
    return issueLocalFailure(error, dpsId);
  }
  return submitDps({ dpsId: dpsId!, signedDpsXml: signed }, ctx);
}

function issueLocalFailure(error: unknown, dpsId: string | null): IssueOutcome {
  const { code, message } = localFailure(error);
  return {
    kind: "definitive",
    code,
    sent: false,
    message,
    dpsId,
    signedDpsXml: null,
    httpStatus: null,
    rejections: [],
  };
}

interface SignedTarget {
  root: "DPS" | "pedRegEvento";
  element: "infDPS" | "infPedReg";
  code: "DPS_ID_MISMATCH" | "EVENT_ID_MISMATCH";
  message: string;
}

const DPS_TARGET: SignedTarget = {
  root: "DPS",
  element: "infDPS",
  code: "DPS_ID_MISMATCH",
  message: "O XML da DPS não corresponde ao Id informado.",
};
const EVENT_TARGET: SignedTarget = {
  root: "pedRegEvento",
  element: "infPedReg",
  code: "EVENT_ID_MISMATCH",
  message: "O XML do evento não corresponde à NFS-e informada.",
};

/**
 * Lê o XML já montado e devolve o `tpAmb` do elemento que vai ao fisco
 * (`DPS/infDPS` ou `pedRegEvento/infPedReg`) depois de conferir que o `Id`
 * dele é o esperado. A conferência é sobre o documento parseado, não sobre o
 * texto: comentário, CDATA ou elemento fora do alvo não a satisfazem. Recusa
 * XML malformado, DTD, encoding diferente de UTF-8 e documento com mais de um
 * alvo. Sem um `tpAmb` único e
 * válido no alvo, devolve 0, que nenhum ambiente aceita.
 */
function signedTargetTpAmb(xml: string, target: SignedTarget, expectedId: string): number {
  const refuse = (): never => {
    throw new NfseError(target.code, target.message);
  };
  // Outro parser leria o mesmo texto de outro jeito com encoding diferente de
  // UTF-8 ou com DTD (valores padrão de atributo): ficam de fora. O BOM pode
  // preceder a declaração.
  const encoding = /^﻿?\s*<\?xml[^>]*?\sencoding\s*=\s*["']([^"']*)["']/.exec(xml)?.[1];
  if (encoding !== undefined && encoding.toUpperCase() !== "UTF-8") return refuse();
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    // O xmldom tolera como aviso o que um parser estrito recusa.
    doc = new DOMParser({
      errorHandler: { warning: refuse, error: refuse, fatalError: refuse },
    }).parseFromString(xml, "text/xml");
  } catch {
    return refuse();
  }
  const root = doc.documentElement;
  if (doc.doctype || !root || root.namespaceURI !== NFSE_NS || root.localName !== target.root)
    return refuse();
  const elements = doc.getElementsByTagNameNS("*", target.element);
  const element = elements[0];
  if (
    elements.length !== 1 ||
    !element ||
    element.parentNode !== root ||
    element.namespaceURI !== NFSE_NS ||
    element.getAttribute("Id") !== expectedId
  )
    return refuse();
  const tpAmb = Array.from(element.childNodes)
    .filter((node): node is Element => node.nodeType === 1)
    .filter((child) => child.namespaceURI === NFSE_NS && child.localName === "tpAmb");
  const value = tpAmb.length === 1 ? tpAmb[0]!.textContent : null;
  return value === "1" || value === "2" ? Number(value) : 0;
}

/**
 * Envia uma DPS já montada (e assinada), sem remontar nem reassinar. É o
 * caminho da plataforma: o XML é persistido antes do primeiro envio e o mesmo
 * texto é reenviado depois de uma reconciliação que confirme ausência.
 */
async function submitDps(input: SignedDps, ctx: NfseQueryContext): Promise<IssueOutcome> {
  let endpoint: NfseEndpoint;
  try {
    endpoint = resolveEndpoint(ctx.target);
    if (!DPS_ID.test(input.dpsId))
      throw new NfseError("DPS_ID_INVALID", "Id da DPS fora do formato de 45 caracteres.");
    checkEnvironment(endpoint, signedTargetTpAmb(input.signedDpsXml, DPS_TARGET, input.dpsId));
  } catch (error) {
    return issueLocalFailure(error, input.dpsId);
  }
  const signed = input.signedDpsXml;
  const base = { dpsId: input.dpsId, signedDpsXml: signed };
  const response = await send(ctx.transport, {
    method: "POST",
    url: submitUrl(endpoint),
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ dpsXmlGZipB64: gzipB64(signed) }),
  });
  if (!response)
    return {
      ...base,
      kind: "uncertain",
      code: "TRANSPORT_UNCERTAIN",
      httpStatus: null,
      rejections: [],
      diagnostic: null,
    };
  const result = classify(response);
  if (result.kind === "ok") {
    const chave = accessKeyOf(result.body?.chaveAcesso);
    const gz = str(result.body?.nfseXmlGZipB64);
    let nfseXml: string | null = null;
    try {
      nfseXml = gz ? gunzipB64(gz) : null;
    } catch {
      nfseXml = null;
    }
    if (chave && nfseXml)
      return { ...base, kind: "success", httpStatus: result.status, chaveAcesso: chave, nfseXml };
    // 2xx fora do formato da Sefin: o pedido pode ter virado NFS-e.
    return {
      ...base,
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
      httpStatus: result.status,
      rejections: [],
      diagnostic: diagnose(response),
    };
  }
  if (result.kind === "transient")
    return {
      ...base,
      kind: "transient",
      code: result.code,
      httpStatus: result.status,
      rejections: result.rejections,
    };
  if (result.kind === "uncertain")
    return {
      ...base,
      kind: "uncertain",
      code: result.code,
      httpStatus: result.status,
      rejections: result.rejections,
      diagnostic: diagnose(response),
    };
  // "Já existe NFS-e para a DPS": a autorização anterior pode ter se perdido.
  if (mentions(result.rejections, DUPLICATE_DPS))
    return {
      ...base,
      kind: "uncertain",
      code: "DPS_ALREADY_EXISTS",
      httpStatus: result.status,
      rejections: result.rejections,
      diagnostic: diagnose(response),
    };
  if (codeOnly(result.rejections))
    return {
      ...base,
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
      httpStatus: result.status,
      rejections: result.rejections,
      diagnostic: diagnose(response),
    };
  return {
    ...base,
    kind: "definitive",
    code: "ADN_REJECTED",
    sent: true,
    httpStatus: result.status,
    rejections: result.rejections,
  };
}

/**
 * Consulta-antes-de-reemitir: o Id da DPS é determinístico (emitente, série e
 * número), então dá para perguntar se ela já virou NFS-e. Só um 404 com o
 * JSON do fisco (`fiscalAbsence`) confirma inexistência; qualquer outra
 * resposta sem chave, inclusive 404 vazio ou HTML, é inconclusiva.
 */
async function consultByDps(dpsId: string, ctx: NfseQueryContext): Promise<ConsultOutcome> {
  const endpoint = resolveEndpoint(ctx.target);
  if (!DPS_ID.test(dpsId))
    throw new NfseError("DPS_ID_INVALID", "Id da DPS fora do formato de 45 caracteres.");
  const response = await send(ctx.transport, {
    method: "GET",
    url: dpsUrl(endpoint, dpsId),
    headers: { Accept: "application/json" },
  });
  // GET não tem efeito: falha de transporte só adia a resposta.
  if (!response) return { kind: "transient", dpsId, code: "TRANSPORT_FAILED", httpStatus: null };
  if (fiscalAbsence(response)) return { kind: "not-found", dpsId, httpStatus: 404 };
  if (response.status === 404)
    return {
      kind: "uncertain",
      dpsId,
      code: "CONSULT_INCONCLUSIVE",
      httpStatus: 404,
      diagnostic: diagnose(response),
    };
  const result = classify(response);
  if (result.kind === "transient")
    return { kind: "transient", dpsId, code: result.code, httpStatus: result.status };
  const chave = result.kind === "ok" ? accessKeyOf(result.body?.chaveAcesso) : null;
  if (chave) return { kind: "found", dpsId, chaveAcesso: chave, httpStatus: result.status };
  return {
    kind: "uncertain",
    dpsId,
    code: result.kind === "uncertain" ? result.code : "CONSULT_INCONCLUSIVE",
    httpStatus: result.status,
    diagnostic: diagnose(response),
  };
}

/** Baixa a NFS-e autorizada pela chave (para persistir o XML após reconciliar). */
async function consultByAccessKey(
  chaveAcesso: string,
  ctx: NfseQueryContext,
): Promise<NfseConsultOutcome> {
  const endpoint = resolveEndpoint(ctx.target);
  if (!/^\d{50}$/.test(chaveAcesso))
    throw new NfseError("ACCESS_KEY_INVALID", "Chave de acesso deve ter 50 dígitos.");
  const response = await send(ctx.transport, {
    method: "GET",
    url: nfseUrl(endpoint, chaveAcesso),
    headers: { Accept: "application/json" },
  });
  if (!response)
    return { kind: "transient", chaveAcesso, code: "TRANSPORT_FAILED", httpStatus: null };
  // Mesmo critério da consulta por DPS: 404 sem o JSON do fisco é inconclusivo.
  if (fiscalAbsence(response)) return { kind: "not-found", chaveAcesso, httpStatus: 404 };
  if (response.status === 404)
    return {
      kind: "uncertain",
      chaveAcesso,
      code: "CONSULT_INCONCLUSIVE",
      httpStatus: 404,
      diagnostic: diagnose(response),
    };
  const result = classify(response);
  if (result.kind === "transient")
    return { kind: "transient", chaveAcesso, code: result.code, httpStatus: result.status };
  if (result.kind === "ok") {
    const gz = str(result.body?.nfseXmlGZipB64);
    try {
      if (gz)
        return { kind: "found", chaveAcesso, nfseXml: gunzipB64(gz), httpStatus: result.status };
    } catch {
      /* corpo ilegível abaixo */
    }
  }
  return {
    kind: "uncertain",
    chaveAcesso,
    code: result.kind === "uncertain" ? result.code : "CONSULT_INCONCLUSIVE",
    httpStatus: result.status,
    diagnostic: diagnose(response),
  };
}

/** Registra o cancelamento (e101101) na NFS-e indicada. */
async function cancel(input: CancelInput, ctx: NfseContext): Promise<CancelOutcome> {
  let eventId: string | null = null,
    signed: string;
  try {
    const endpoint = resolveEndpoint(ctx.target);
    checkEnvironment(endpoint, input.event.tpAmb);
    const built = buildCancelEvent(input.event);
    eventId = built.id;
    signed = signEvent(built, ctx.signer, endpoint.signature);
  } catch (error) {
    return cancelLocalFailure(error, eventId);
  }
  return submitCancelEvent(
    { eventId: eventId!, chNFSe: input.event.chNFSe, signedEventXml: signed },
    ctx,
  );
}

function cancelLocalFailure(error: unknown, eventId: string | null): CancelOutcome {
  const { code, message } = localFailure(error);
  return {
    kind: "definitive",
    code,
    sent: false,
    message,
    eventId,
    signedEventXml: null,
    httpStatus: null,
    rejections: [],
  };
}

/** Envia um pedido de cancelamento já montado (e assinado), sem remontar nem reassinar. */
async function submitCancelEvent(
  input: SignedCancelEvent,
  ctx: NfseQueryContext,
): Promise<CancelOutcome> {
  let endpoint: NfseEndpoint;
  try {
    endpoint = resolveEndpoint(ctx.target);
    if (!/^\d{50}$/.test(input.chNFSe))
      throw new NfseError("EVENT_FIELD_INVALID", "chNFSe deve ter 50 dígitos.");
    if (input.eventId !== `PRE${input.chNFSe}${EVENTO_CANCELAMENTO}`)
      throw new NfseError(EVENT_TARGET.code, EVENT_TARGET.message);
    checkEnvironment(
      endpoint,
      signedTargetTpAmb(input.signedEventXml, EVENT_TARGET, input.eventId),
    );
  } catch (error) {
    return cancelLocalFailure(error, input.eventId);
  }
  const signed = input.signedEventXml;
  const base = { eventId: input.eventId, signedEventXml: signed };
  const response = await send(ctx.transport, {
    method: "POST",
    url: eventsUrl(endpoint, input.chNFSe),
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipB64(signed) }),
  });
  if (!response)
    return {
      ...base,
      kind: "uncertain",
      code: "TRANSPORT_UNCERTAIN",
      httpStatus: null,
      rejections: [],
    };
  const result = classify(response);
  if (result.kind === "ok") {
    const gz = str(result.body?.eventoXmlGZipB64);
    let eventXml: string | null = null;
    if (gz)
      try {
        eventXml = gunzipB64(gz);
      } catch {
        return {
          ...base,
          kind: "uncertain",
          code: "RESPONSE_UNREADABLE",
          httpStatus: result.status,
          rejections: [],
        };
      }
    return {
      ...base,
      kind: "success",
      httpStatus: result.status,
      eventXml,
      alreadyRegistered: false,
    };
  }
  if (result.kind === "transient")
    return {
      ...base,
      kind: "transient",
      code: result.code,
      httpStatus: result.status,
      rejections: result.rejections,
    };
  if (result.kind === "uncertain")
    return {
      ...base,
      kind: "uncertain",
      code: result.code,
      httpStatus: result.status,
      rejections: result.rejections,
    };
  // Evento já registrado: o cancelamento anterior foi aceito e a resposta se perdeu.
  if (mentions(result.rejections, DUPLICATE_EVENT))
    return {
      ...base,
      kind: "success",
      httpStatus: result.status,
      eventXml: null,
      alreadyRegistered: true,
    };
  if (codeOnly(result.rejections))
    return {
      ...base,
      kind: "uncertain",
      code: "RESPONSE_UNREADABLE",
      httpStatus: result.status,
      rejections: result.rejections,
    };
  return {
    ...base,
    kind: "definitive",
    code: "ADN_REJECTED",
    sent: true,
    httpStatus: result.status,
    rejections: result.rejections,
  };
}

export const nacional: NfseProvider = {
  id: "nacional",
  issue,
  submitDps,
  consultByDps,
  consultByAccessKey,
  cancel,
  submitCancelEvent,
};
