import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { usePaginatedQuery } from "./convex-query";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { Feedback } from "./project-sections";
import { useAsyncAction } from "./async-action";
import { formatDateTime, formatMoney } from "./format";
import { More } from "./load-more";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { FormField, Select } from "./ui/form";
import { Callout, Card, EmptyState, SkeletonBlock, StatusBadge, type Tone } from "./ui/layout";
import {
  errorMessages,
  stripeError,
  type Connection,
  type EventState,
  type StripeEvent,
} from "./stripe-shared";
import { TakerForm } from "./stripe-taker";
import { UsageGuidance, isUsageCode } from "./usage-errors";

// Events received by a connection, with the retry of a failed or rejected issuance.

const eventTypeLabels: Record<string, string> = {
  "invoice.paid": "Fatura paga",
  "checkout.session.completed": "Checkout concluído",
  "checkout.session.async_payment_succeeded": "Pagamento do checkout confirmado",
  "charge.refunded": "Cobrança reembolsada",
  "charge.dispute.closed": "Disputa encerrada",
};
const eventStates: Record<EventState, [Tone, string]> = {
  queued: ["info", "Na fila"],
  issued: ["success", "Emitido"],
  pending_data: ["warning", "Pendente de dados"],
  ignored: ["neutral", "Ignorado"],
  failed: ["danger", "Falha"],
  refund: ["info", "Reembolso"],
};
const stateFilters: Array<[EventState | "", string]> = [
  ["", "Todos"],
  ["issued", "Emitidos"],
  ["pending_data", "Pendentes de dados"],
  ["failed", "Falhas"],
  ["ignored", "Ignorados"],
  ["refund", "Reembolsos"],
];
const issuanceStates: Record<NonNullable<StripeEvent["issuance"]>["state"], [Tone, string]> = {
  processing: ["info", "Em processamento"],
  authorized: ["success", "Autorizada"],
  rejected: ["danger", "Rejeitada"],
  cancelled: ["neutral", "Cancelada"],
};
const refundActions: Record<NonNullable<StripeEvent["refundAction"]>, [Tone, string]> = {
  suggested: ["warning", "Cancelamento sugerido"],
  requested: ["info", "Cancelamento pedido"],
  failed: ["danger", "Cancelamento falhou"],
};
/** A value from a newer platform shows as itself instead of breaking the list. */
function badgeOf<K extends string>(map: Record<K, [Tone, string]>, value: string): [Tone, string] {
  return (map as Record<string, [Tone, string]>)[value] ?? ["neutral", value];
}
const eventCodes: Record<string, string> = {
  ZERO_AMOUNT: "Cobrança de valor zero: não há nota.",
  NOT_PAID: "A sessão de checkout ainda não estava paga. A nota sai com o pagamento confirmado.",
  CHECKOUT_NOT_PAYMENT:
    "Checkout de assinatura ou configuração: a nota sai do invoice.paid da fatura.",
  OUT_OF_MARKET: "O país do cliente está fora do mercado configurado na conexão.",
  LIVEMODE_MISMATCH: "Evento de teste numa conexão de Produção: só eventos reais emitem.",
  TRIGGER_DISABLED: "Este tipo de cobrança está desligado em “Quando emitir”.",
  DUPLICATE_CHARGE: "Esta cobrança já chegou em outro evento; a nota é a do primeiro.",
  CONNECTION_DISABLED: "A conexão estava desativada quando o evento chegou.",
  EVENT_MALFORMED: "O evento veio sem os campos esperados e não pôde ser lido.",
  STRIPE_ACTIVITY_MISSING: "A conexão não tem atividade para o mercado deste cliente.",
  STRIPE_CURRENCY_UNSUPPORTED:
    "Moeda não suportada para o mercado: nacional em BRL; exterior em USD, CAD, EUR ou GBP.",
  PARTIAL_REFUND: "Reembolso parcial: fica registrado, a nota não é cancelada.",
  DISPUTE_NOT_LOST: "Disputa encerrada sem perda: a nota segue válida.",
  NO_ISSUANCE: "Nenhuma nota desta conexão corresponde a esta cobrança.",
  CANCEL_SUGGESTED: "Reembolso total ou disputa perdida: o cancelamento da nota foi sugerido.",
  CANCEL_QUEUED: "O cancelamento da nota está sendo pedido.",
  CANCEL_REQUESTED: "O cancelamento da nota foi pedido ao fisco.",
};
const missingLabels: Record<string, string> = {
  name: "nome",
  document: "CPF ou CNPJ",
  municipality: "município (cidade e UF)",
  street: "endereço (linha 1)",
  postalCode: "CEP ou postal code",
  country: "país",
  city: "cidade",
  nif: "NIF (tax ID)",
};
export function eventCodeText(code: string) {
  return eventCodes[code] ?? errorMessages[code] ?? `A plataforma recusou o pedido (${code}).`;
}

export function EventList({ org, connection }: { org: Organization; connection: Connection }) {
  const [state, setState] = useState<EventState | "">("");
  const [open, setOpen] = useState<string>();
  const { results, status, loadMore } = usePaginatedQuery(
    api.stripe.listEvents,
    { connectionId: connection.id, ...(state ? { state } : {}) },
    { initialNumItems: 20 },
  );
  return (
    <Card
      title="Eventos recebidos"
      description="Cada evento do Stripe aparece uma vez; reenviar pelo Stripe não gera outra nota."
      flush
    >
      <div className="gestao-body">
        <FormField id={`stripe-events-${connection.id}`} label="Situação">
          <Select
            id={`stripe-events-${connection.id}`}
            value={state}
            onChange={(e) => setState(e.target.value as EventState | "")}
          >
            {stateFilters.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {status === "LoadingFirstPage" ? (
        <div className="gestao-body">
          <SkeletonBlock label="Carregando eventos…" />
        </div>
      ) : results.length ? (
        <ul className="gestao-list">
          {results.map((e) => (
            <EventRow
              key={e.id}
              org={org}
              connection={connection}
              event={e}
              completing={open === e.id}
              setCompleting={(on) => setOpen(on ? e.id : undefined)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon="inbox"
          headingLevel={3}
          title="Nenhum evento."
          description="Envie um evento de teste pelo painel do Stripe para conferir a conexão."
        />
      )}
      <div className="gestao-footer">
        <More status={status} loadMore={loadMore} />
      </div>
    </Card>
  );
}

function EventRow({
  org,
  connection,
  event: e,
  completing,
  setCompleting,
}: {
  org: Organization;
  connection: Connection;
  event: StripeEvent;
  completing: boolean;
  setCompleting: (on: boolean) => void;
}) {
  const retry = useMutation(api.stripe.retryEvent);
  const { busy, error, run } = useAsyncAction(stripeError);
  const [confirm, setConfirm] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const [tone, label] = badgeOf(eventStates, e.state);
  const customer = e.charge?.customer;
  const rejected = e.state === "issued" && e.issuance?.state === "rejected";
  const canComplete = Boolean(e.charge) && (e.state === "pending_data" || e.state === "failed");
  const canRetry = Boolean(e.charge) && (e.state === "failed" || rejected);
  function runRetry() {
    return run(() => retry({ eventId: e.id }));
  }
  return (
    <li ref={row} tabIndex={-1}>
      <div className="gestao-row">
        <p className="gestao-row__title">
          <span>{eventTypeLabels[e.type] ?? e.type}</span>
          <StatusBadge tone={tone}>{label}</StatusBadge>
          {e.refundAction ? (
            <StatusBadge tone={badgeOf(refundActions, e.refundAction)[0]}>
              {badgeOf(refundActions, e.refundAction)[1]}
            </StatusBadge>
          ) : null}
          {e.livemode ? null : <StatusBadge tone="neutral">Modo de teste</StatusBadge>}
        </p>
        <div className="ui-actions">
          {canComplete ? (
            <Button size="sm" aria-expanded={completing} onClick={() => setCompleting(!completing)}>
              Completar dados
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => (rejected ? setConfirm(true) : void runRetry())}
            >
              Tentar de novo
            </Button>
          ) : null}
        </div>
      </div>
      <p className="gestao-meta">
        {formatDateTime(e.receivedAt)}
        {e.charge ? ` · ${formatMoney(e.charge.amount, e.charge.currency)}` : ""}
        {customer?.name ? ` · ${customer.name}` : ""}
        {customer?.country ? ` (${customer.country})` : ""}
        {e.charge ? ` · ${e.charge.reference ?? e.charge.id}` : ""}
        {e.reversal ? ` · ${e.reversal.id}` : ""}
      </p>
      {e.issuance ? (
        <p className="gestao-meta">
          <Link
            className="ui-link"
            to="/app/$organizationSlug/issuances"
            params={{ organizationSlug: org.slug }}
            search={{ company: connection.companyId, issuance: e.issuance.id }}
          >
            DPS {e.issuance.series}-{e.issuance.number}
            {e.issuance.nfseNumber ? ` · NFS-e ${e.issuance.nfseNumber}` : ""}
          </Link>{" "}
          <StatusBadge tone={badgeOf(issuanceStates, e.issuance.state)[0]}>
            {badgeOf(issuanceStates, e.issuance.state)[1]}
          </StatusBadge>
          {e.issuance.code ? <> · {eventCodeText(e.issuance.code)}</> : null}
        </p>
      ) : null}
      {e.state === "pending_data" && e.missing.length ? (
        <Callout tone="warning">
          Faltou do Stripe: {e.missing.map((m) => missingLabels[m] ?? m).join(", ")}. Nenhum número
          de DPS foi gasto.
        </Callout>
      ) : null}
      {e.code ? (
        <Callout tone={e.state === "failed" ? "danger" : "info"}>
          {isUsageCode(e.code) ? <UsageGuidance code={e.code} org={org} /> : eventCodeText(e.code)}{" "}
          <code>{e.code}</code>
        </Callout>
      ) : null}
      {rejected ? (
        <Callout tone="danger">
          O fisco rejeitou a nota. Corrija o motivo e use “Tentar de novo”: sai um novo pedido, com
          outro número de DPS.
        </Callout>
      ) : null}
      <Feedback error={error} />
      {completing && e.charge ? (
        <TakerForm org={org} connection={connection} event={e} close={() => setCompleting(false)} />
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="primary"
        title="Emitir de novo esta cobrança?"
        description="A nota anterior foi rejeitada e o número dela fica consumido. O novo pedido usa outro número de DPS."
        confirmLabel="Emitir de novo"
        busyLabel="Enviando…"
        onConfirm={runRetry}
        returnFocusTo={() => row.current}
      />
    </li>
  );
}
