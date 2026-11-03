import type { RouteResult } from "../../../packages/fiscal-nfse/src/route";
import { countryName, formatCnpj, formatCpf, formatDateTime, formatMoney } from "./format";
import { clean, decimalText, takerDocumentOf, targetLabels, type Draft } from "./issuance-draft";
import { Callout, DescriptionList, StatusBadge } from "./ui/layout";

// What the console says only in the fiscal production deployment (#198): the note of the
// issuance screen, the state of the company's gate and the summary confirmed before a request or
// a cancellation. Elsewhere none of it renders, so the sandbox stays as it was.

export type ProductionGate = { open: boolean; since: number | null };

/**
 * Whether the Freecorps operation released this company to issue in production, for owners and
 * admins. Read only: the release goes through the operation's approved workflow, never the
 * console, and who released it is not shown. "Liberada em" is the time of the last switch-on.
 * Released reads neutral; switched off takes the attention tone, with what still works.
 */
export function ProductionGateState({ gate }: { gate: ProductionGate }) {
  return (
    <p className="fiscal-gate">
      <span>Emissão em produção:</span>
      {gate.open ? (
        <>
          <StatusBadge>Liberada</StatusBadge>
          {gate.since !== null ? <span>desde {formatDateTime(gate.since)}</span> : null}
        </>
      ) : (
        <>
          <StatusBadge tone="warning">Desligada</StatusBadge>
          <span>
            Novos pedidos são recusados; cancelamentos e consultas de notas já pedidas continuam.
          </span>
        </>
      )}
    </p>
  );
}

/**
 * Note of the issuance screen in fiscal production, in the attention tone: notes from here have
 * legal effect. `gate` is given to owners and admins only; other roles read the note without it.
 */
export function ProductionNote({ gate }: { gate: ProductionGate | null }) {
  return (
    <div className="fiscal-stack" role="note">
      <Callout tone="warning">
        <p>
          <strong>Produção fiscal.</strong> As DPS desta empresa vão à Sefin Nacional, assinadas com
          o certificado A1 da empresa, e as notas autorizadas têm validade fiscal. Pedir emissão e
          cancelar uma NFS-e pedem confirmação antes do envio.
        </p>
      </Callout>
      {gate && <ProductionGateState gate={gate} />}
    </div>
  );
}

/** Said next to "Nova emissão" and "Pedir emissão" to owners and admins while the gate is off. */
export const productionClosedNote =
  "A emissão em produção está desligada para esta empresa: novos pedidos serão recusados.";

type TakerOf =
  | { kind: "national"; name: string; document: string }
  | { kind: "foreign"; name: string; nif?: string | null; country: string };
/**
 * The taker in parts: the name, which may wrap; the document ("CNPJ 11.444.777/0001-61",
 * "CPF …" or "NIF …"), which never breaks; and, abroad, the country's name. The same in the
 * request and in the cancellation.
 */
export type TakerParts = { name: string; document: string | null; place: string | null };
export function takerLabel(taker: TakerOf): TakerParts {
  const name = clean(taker.name);
  if (taker.kind === "national") {
    const document = takerDocumentOf(taker.document);
    return {
      name,
      document:
        document.length === 11 ? `CPF ${formatCpf(document)}` : `CNPJ ${formatCnpj(document)}`,
      place: null,
    };
  }
  return {
    name,
    document: taker.nif ? `NIF ${clean(taker.nif)}` : null,
    place: countryName(clean(taker.country)),
  };
}
/** "Nome · CNPJ 11.444.777/0001-61": the line wraps at the separators, never inside the document. */
function TakerText({ name, document, place }: TakerParts) {
  return (
    <>
      {name}
      {document ? (
        <>
          {" · "}
          <span className="fiscal-num">{document}</span>
        </>
      ) : null}
      {place ? ` · ${place}` : null}
    </>
  );
}

export type ProductionSummaryItems = {
  taker: TakerParts;
  value: string;
  target: string;
  /** In the cancellation: "NFS-e nº 7 · DPS série 1 nº 7". */
  document?: string;
  /** In the cancellation: "Erro na emissão: …". */
  reason?: string;
};

/**
 * Who receives the note, how much and where it goes, from the validated draft; the server
 * resolves channel and value again on acceptance.
 */
export function productionSummary(draft: Draft, route: RouteResult | null): ProductionSummaryItems {
  const target = route?.kind === "nacional" ? route.target : "sefin-nacional";
  return {
    taker: takerLabel(
      draft.market === "domestic"
        ? { kind: "national", ...draft.national }
        : {
            kind: "foreign",
            name: draft.foreign.name,
            nif: draft.foreign.nifChoice === "nif" ? draft.foreign.nif : null,
            country: draft.foreign.country,
          },
    ),
    value: formatMoney(decimalText(draft.value), draft.currency),
    target: targetLabels[target] ?? target,
  };
}

/**
 * Summary of a production request or cancellation in its confirmation, terms above values. Shown
 * only in fiscal production, where the note has legal effect.
 */
export function ProductionSummary({
  taker,
  value,
  target,
  document,
  reason,
}: ProductionSummaryItems) {
  return (
    <DescriptionList
      className="fiscal-summary"
      items={[
        ...(document
          ? [
              {
                key: "document",
                term: "Nota",
                // "NFS-e nº 7" and "DPS série 1 nº 7" stay whole; the line wraps between them.
                value: document.split(" · ").map((part, index) => (
                  <span key={part}>
                    {index ? " · " : ""}
                    <span className="fiscal-num">{part}</span>
                  </span>
                )),
              },
            ]
          : []),
        { key: "taker", term: "Tomador", value: <TakerText {...taker} /> },
        { key: "value", term: "Valor", value: <span className="fiscal-num">{value}</span> },
        { key: "target", term: "Destino", value: `${target}, em produção` },
        ...(reason ? [{ key: "reason", term: "Motivo", value: reason }] : []),
      ]}
    />
  );
}
