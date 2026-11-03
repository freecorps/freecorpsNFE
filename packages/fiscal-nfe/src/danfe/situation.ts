import { processNfe } from "../process.js";
import { deriveFiscalSituation } from "../status.js";
import type { ProcessedNfe } from "../types.js";
import { fail } from "../xml.js";

/**
 * Situação impressa no DANFE. A nota e os eventos passam pelo mesmo `processNfe` da importação
 * (XSD, identidade da chave e do protocolo, digVal e assinatura XML) e a situação vem de
 * `deriveFiscalSituation`, a mesma do documento da plataforma. Três regras são próprias do DANFE,
 * porque a nota não comprovada fica fora da derivação e não ancora chave nem ambiente:
 *
 * - evento de outra chave é recusado (`DANFE_EVIDENCE_INVALID`);
 * - evento que contaria na derivação, mas é de outro ambiente, gera `ENVIRONMENT_MISMATCH`;
 * - entre cancelamentos registrados, vale o de menor sequência, registro e protocolo.
 */

/** Evidências fiscais além do XML da NF-e. */
export interface DanfeEvidence {
  /**
   * `procEventoNFe` preservados para a mesma chave, como recebidos; até `MAX_EVENTS`. Evento de
   * outra chave é recusado; registrado em outro ambiente, impresso como conflito.
   */
  events?: ReadonlyArray<string | Uint8Array>;
  /**
   * De onde vieram os eventos, impresso junto da marca de cancelamento (por exemplo, "evento
   * preservado pela plataforma, sem consulta ao fisco"). Obrigatório com eventos e recusado sem
   * eles; até `MAX_ORIGIN_LENGTH` caracteres, sem quebra de linha.
   */
  origin?: string;
}

export const MAX_ORIGIN_LENGTH = 200;
/** Eventos aceitos por chamada; uma NF-e real raramente passa de poucos. */
export const MAX_EVENTS = 20;

export type DanfeStatus =
  | { kind: "authorized"; protocol: { number: string; receivedAt: string } }
  | { kind: "unauthorized"; reason: string }
  | { kind: "denied"; cStat: string; protocol: { number: string; receivedAt: string } }
  | { kind: "conflict"; conflicts: string[] }
  | {
      kind: "cancelled";
      event: { number: string; registeredAt: string };
      origin: string;
      /** Protocolo da nota quando a autorização foi comprovada; senão, o motivo da falta. */
      authorization: { number: string; receivedAt: string } | { missing: string };
    };

const bytesOf = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

const CHECK_NAMES: Array<[keyof ProcessedNfe["checks"], string]> = [
  ["xsd", "XSD"],
  ["identity", "identidade da chave e do protocolo"],
  ["signature", "assinatura XML"],
  ["fiscalEvidence", "evidência fiscal"],
];

const eventOf = (item: ProcessedNfe) => {
  const doc = item.parsing!.document;
  if (doc.kind !== "event") throw new Error("DANFE_EVENT_EXPECTED");
  return doc;
};

/** Mesmo critério de `deriveFiscalSituation` para um evento contar. */
function counts(item: ProcessedNfe): boolean {
  const receipt = eventOf(item).receipt;
  return (
    (["parsing", "xsd", "identity", "signature", "fiscalEvidence"] as const).every(
      (check) => item.checks[check].status === "passed",
    ) &&
    receipt !== null &&
    ["135", "155"].includes(receipt.status)
  );
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Motivo legível para a nota não contar como autorizada. */
function missingAuthorization(note: ProcessedNfe): string {
  const doc = note.parsing?.document;
  const protocol = doc?.kind === "invoice" ? doc.protocol : null;
  if (!protocol) return "sem protocolo de autorização de uso";
  for (const [check, name] of CHECK_NAMES) {
    const result = note.checks[check];
    if (result.status !== "passed") return `${name} não confere (${result.code})`;
  }
  return `protocolo com cStat ${protocol.status}, que não autoriza o uso`;
}

export function danfeSituation(xml: string | Uint8Array, evidence: DanfeEvidence): DanfeStatus {
  const note = processNfe(bytesOf(xml));
  if (note.checks.parsing.status !== "passed" || note.parsing?.document.kind !== "invoice")
    return fail(
      note.checks.parsing.code === "XML_PARSED" ? "DANFE_XML_INVALID" : note.checks.parsing.code,
    );
  const given = evidence.events ?? [];
  if (given.length > MAX_EVENTS) return fail("DANFE_EVIDENCE_INVALID", "events");
  if (!given.length && evidence.origin !== undefined)
    return fail("DANFE_EVIDENCE_INVALID", "origin");
  const invoice = note.parsing.document;
  const events = given.map((event) => {
    const processed = processNfe(bytesOf(event));
    if (
      processed.checks.parsing.status !== "passed" ||
      processed.parsing?.document.kind !== "event"
    )
      return fail("DANFE_EVIDENCE_INVALID", "procEventoNFe");
    // Chave e ambiente vêm do XML da nota mesmo quando ela não foi comprovada: sem isso, o
    // evento de outra nota contaria sozinho em deriveFiscalSituation.
    if (processed.parsing.document.key !== invoice.key)
      return fail("DANFE_EVIDENCE_INVALID", "chNFe");
    return processed;
  });
  let origin = "";
  if (events.length) {
    origin = (evidence.origin ?? "").replace(/\s+/g, " ").trim();
    if (!origin || origin.length > MAX_ORIGIN_LENGTH)
      return fail("DANFE_EVIDENCE_INVALID", "origin");
  }

  const situation = deriveFiscalSituation([note, ...events]);
  // Só evento que contaria na derivação (verificações aprovadas e retorno 135 ou 155) amarra o
  // ambiente; os demais são ignorados aqui como já são na derivação.
  if (events.some((event) => counts(event) && eventOf(event).environment !== invoice.environment))
    return {
      kind: "conflict",
      conflicts: [...new Set(["ENVIRONMENT_MISMATCH", ...situation.conflicts])].sort(),
    };
  const counted = new Set(situation.evidenceIds);
  const noteCounted = counted.has(note.metadata!.originalSha256);
  const protocol =
    invoice.protocol && noteCounted
      ? { number: invoice.protocol.number ?? "", receivedAt: invoice.protocol.receivedAt ?? "" }
      : null;
  const authorized = protocol !== null && ["100", "150"].includes(invoice.protocol!.status);

  if (situation.reportedStatus === "conflict")
    return { kind: "conflict", conflicts: situation.conflicts };
  if (situation.reportedStatus === "cancelled") {
    // Mais de um cancelamento registrado (sequências diferentes): o primeiro por sequência,
    // registro e protocolo, independente da ordem recebida.
    const receipt =
      events
        .filter((event) => counted.has(event.metadata!.originalSha256))
        .map((event) => event.parsing!.document)
        .flatMap((doc) =>
          doc.kind === "event" && doc.type === "110111" && doc.receipt
            ? [{ sequence: doc.sequence, receipt: doc.receipt }]
            : [],
        )
        .sort(
          (a, b) =>
            Number(a.sequence) - Number(b.sequence) ||
            compare(a.receipt.registeredAt ?? "", b.receipt.registeredAt ?? "") ||
            compare(a.receipt.number ?? "", b.receipt.number ?? ""),
        )[0]?.receipt ?? null;
    return {
      kind: "cancelled",
      event: { number: receipt?.number ?? "", registeredAt: receipt?.registeredAt ?? "" },
      origin,
      authorization: authorized ? protocol : { missing: missingAuthorization(note) },
    };
  }
  if (situation.reportedStatus === "denied" && protocol)
    return { kind: "denied", cStat: invoice.protocol!.status, protocol };
  if (authorized) return { kind: "authorized", protocol };
  return { kind: "unauthorized", reason: missingAuthorization(note) };
}
