import type { FiscalStatus } from "@freecorps/contracts";
import { formatDateTime, formatIsoDate } from "./format";
import { StatusBadge, type Tone } from "./ui/layout";

/** The words of a note's fiscal situation, shared by the documents list and the Início. */
export const statusLabels: Record<FiscalStatus, string> = {
  unknown: "Desconhecida",
  authorized: "Autorizada",
  cancelled: "Cancelada",
  denied: "Denegada",
  conflict: "Conflito",
};
const statusTones: Record<FiscalStatus, Tone> = {
  unknown: "neutral",
  authorized: "success",
  cancelled: "danger",
  denied: "danger",
  conflict: "warning",
};
export function FiscalStatusLabel({ status }: { status: FiscalStatus }) {
  return <StatusBadge tone={statusTones[status]}>{statusLabels[status]}</StatusBadge>;
}
/**
 * Name of the note in the list link and in the detail title. The server reads the number of a
 * summary or event from the access key (#462); without one, issuer and date tell the rows apart,
 * so no link stays generic.
 */
export function documentName(doc: {
  number: string | null;
  model: string;
  issuer: string | null;
  issuedAt: string | null;
  importedAt: number;
}) {
  const model = doc.model === "nfse" ? "NFS-e" : "NF-e";
  if (doc.number) return `${model} ${doc.number}`;
  const when = doc.issuedAt
    ? `emitida em ${formatIsoDate(doc.issuedAt)}`
    : `recebida em ${formatDateTime(doc.importedAt)}`;
  return doc.issuer ? `${model} de ${doc.issuer}, ${when}` : `${model} ${when}`;
}
