import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { api } from "../../../platform/convex/_generated/api";
import { PLATFORM_PLANS } from "../../../platform/convex/lib/planCatalog";
import type { Organization } from "./organizations";
import { useQuery } from "./convex-query";
import { useAsyncAction } from "./async-action";
import { ErrorBoundary } from "./route-errors";
import { formatUtcInstant } from "./format";
import {
  annualMessages,
  price,
  refusalOf,
  tierNames,
  utcDate,
  utcDateTime,
  utcMonth,
} from "./plans";
import { Button, buttonClass } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Callout, Card, DescriptionList, StatusBadge } from "./ui/layout";

type PaidTier = "intermediate" | "large";
export type BillingOverview = FunctionReturnType<typeof api.billing.overview>;
const tiers: PaidTier[] = ["intermediate", "large"];
// The catalog the server prices with; the server still charges what it computes.
const monthly: Record<PaidTier, number> = {
  intermediate: PLATFORM_PLANS.intermediate.monthlyCents,
  large: PLATFORM_PLANS.large.monthlyCents,
};
const annual: Record<PaidTier, number> = {
  intermediate: PLATFORM_PLANS.intermediate.annualCents,
  large: PLATFORM_PLANS.large.annualCents,
};
const reviewNames: Record<string, string> = {
  REFUND_FULL: "Reembolso total registrado no Stripe",
  REFUND_PARTIAL: "Reembolso parcial registrado no Stripe",
  DISPUTE_OPENED: "Contestação aberta pelo banco do cartão",
  DISPUTE_WON: "Contestação encerrada a favor da Freecorps",
  DISPUTE_LOST: "Contestação encerrada a favor do titular do cartão",
  DISPUTE_CLOSED: "Contestação encerrada",
  DUPLICATE_PAYMENT: "Pagamento de um mês ou de uma mudança de plano que já estavam pagos",
  LATE_PAYMENT: "Pagamento recebido depois do fim do mês cobrado",
  QUOTA_EXCEEDED: "O plano pago não comporta o uso atual da organização",
  PLAN_UNAVAILABLE: "Pagamento recebido com a contratação indisponível",
  ANNUAL_TERM_ACTIVE: "Pagamento recebido com um plano anual em vigor ou agendado",
  ANNUAL_TERM_REQUIRED: "Mudança de plano anual paga sem o plano anual em vigor",
  ANNUAL_TERM_SCHEDULED: "Mudança de plano anual paga com um plano anual agendado",
  ANNUAL_TERM_RESCINDED: "Cobrança de uma assinatura anual já rescindida",
  RENEWAL_BELOW_UPGRADE: "Renovação cobrada abaixo do plano da mudança paga",
  SUBSCRIPTION_STOP_FAILED: "Cancelamento da assinatura anual rescindida pendente no Stripe",
  SUBSCRIPTION_REQUIRED: "Mudança de plano anual paga sem a assinatura anual do plano",
  AMOUNT_MISMATCH: "Pagamento com valor diferente do cobrado",
  PRICE_UNKNOWN: "Pagamento por um preço que não confere com o catálogo",
  INVOICE_UNEXPECTED: "Pagamento por um período que não confere com a assinatura",
};
/** Why an annual start was refused before its anchor (`source: "checkout"`), nothing charged. */
const annualRefusals: Record<string, string> = {
  PLAN_UNAVAILABLE: "a contratação ficou indisponível",
  PLANS_DISABLED: "a contratação de planos foi suspensa",
  QUOTA_EXCEEDED: "o uso atual não cabe no plano",
  CAPACITY_INVENTORY_REQUIRED: "o inventário de capacidade da organização está pendente",
  ORGANIZATION_ARCHIVING: "o arquivamento ou a reativação da organização está em curso",
  PLAN_CUSTOM: "a organização tem um plano personalizado",
  ORGANIZATION_CLOSED: "a organização foi encerrada",
};
function reviewName(item: { source: string; code: string }) {
  if (item.source !== "checkout") return reviewNames[item.code] ?? "Pagamento em análise";
  if (item.code === "SUBSCRIPTION_STOP_FAILED")
    return "Cancelamento pendente no Stripe da assinatura anual recusada";
  const reason = annualRefusals[item.code];
  return `Plano anual por cartão recusado antes da cobrança${reason ? `: ${reason}` : ""}. A assinatura é cancelada e nada é cobrado`;
}
const ended = ["canceled", "incomplete_expired"];

/**
 * The plan in force and its end, the UTC instant it was bought until: a monthly plan ends on an
 * anniversary of its signing or confirmation (ADR 0012), by card or Pix.
 */
const planUntil = (plan: { tier: string; endsAt: number | null }) =>
  `${tierNames[plan.tier] ?? plan.tier}${plan.endsAt ? `, até ${formatUtcInstant(plan.endsAt)}` : ", sem vencimento"}`;

function failure(error: unknown) {
  // A sale that waits for the plan in force ends with the date it becomes available (ADR 0012).
  const { code, availability } = refusalOf(error);
  const messages: Record<string, string> = {
    ...annualMessages,
    ACCESS_DENIED: "Apenas o proprietário e administradores podem gerenciar a cobrança.",
    UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
    BILLING_DISABLED: "O pagamento por cartão está indisponível no momento.",
    BILLING_UNAVAILABLE:
      "O Stripe não respondeu. Nada foi cobrado por esta tentativa; tente novamente em instantes.",
    PLANS_DISABLED: "A contratação de planos está indisponível no momento.",
    PLAN_UNAVAILABLE: "Esta mudança de plano está indisponível. Confira a situação atual.",
    PLAN_REQUEST_PENDING:
      "Há um pedido por Pix aguardando pagamento. Cancele-o antes de usar o cartão.",
    // One paid plan at a time (ADR 0012): the card waits for the plan paid by Pix to end.
    PAYMENT_METHOD_PIX:
      "Há um plano pago por Pix em vigor ou uma renovação dele já paga. O cartão espera o fim dele.",
    CHECKOUT_PENDING: "Já existe um pagamento por cartão em andamento.",
    // Shared by both cases: the monthly upgrade closes 45 minutes before the renewal, with the
    // date it reopens; the annual, which still starts on the 1st, 45 minutes before the month
    // turns, even without a paid plan.
    PERIOD_CLOSING:
      "Pelo cartão, a mudança de plano fecha 45 minutos antes da renovação, e o anual, 45 minutos antes de 00:00 UTC do dia 1.",
    SUBSCRIPTION_REQUIRED: "Não há assinatura por cartão nesta organização.",
    SUBSCRIPTION_CANCELLING:
      "A renovação está cancelada. Retome a renovação antes de mudar o plano.",
    QUOTA_EXCEEDED: "O uso atual não cabe neste plano. Nada foi alterado.",
    RATE_LIMITED: "Muitas consultas seguidas. Aguarde um minuto.",
    ORGANIZATION_CLOSED: "Esta organização foi encerrada.",
  };
  return code && messages[code]
    ? messages[code] + availability
    : "Não foi possível concluir. Confira a situação da cobrança e tente novamente.";
}

/**
 * Card subscription next to the assisted Pix: method, period, next charge, pending items. Only
 * owners and admins read billing (`billing.overview` refuses the other roles), so the card is
 * not shown to them at all.
 */
export function PlanBilling({ org, contextKey }: { org: Organization; contextKey: string }) {
  if (org.role !== "owner" && org.role !== "admin") return null;
  return (
    <ErrorBoundary
      key={`${org.id}:${contextKey}:${org.role}`}
      fallback={(error, reset) => (
        <Callout
          tone="warning"
          title="Não foi possível carregar a cobrança."
          actions={<Button onClick={reset}>Tentar novamente</Button>}
        >
          {failure(error)}
        </Callout>
      )}
    >
      <BillingQuery org={org} />
    </ErrorBoundary>
  );
}
function BillingQuery({ org }: { org: Organization }) {
  const data = useQuery(api.billing.overview, { organizationId: org.id });
  if (data === undefined)
    return (
      <p className="gestao-help" aria-busy="true">
        Carregando cobrança…
      </p>
    );
  return <Billing org={org} data={data} />;
}

type Pending =
  | { kind: "checkout"; tier: PaidTier; cycle: "monthly" | "annual" }
  | { kind: "renewal"; change: PaidTier | "cancel" | "resume" }
  | { kind: "abandon" };
export function Billing({ org, data }: { org: Organization; data: BillingOverview }) {
  const checkout = useAction(api.billing.checkout);
  const changeRenewal = useAction(api.billing.changeRenewal);
  const portal = useAction(api.billing.portal);
  const refresh = useAction(api.billing.refresh);
  const abandon = useAction(api.billing.abandonCheckout);
  const action = useAsyncAction(failure);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const keys = useRef<Record<string, string>>({});
  // An abandoned or finished Checkout cannot be reopened by its key: the next one is new.
  const hadCheckout = useRef(!!data.checkout);
  useEffect(() => {
    if (hadCheckout.current && !data.checkout) keys.current = {};
    hadCheckout.current = !!data.checkout;
  }, [data.checkout]);
  const canManage = org.role === "owner" || org.role === "admin";
  const returned = useRef(false);
  // The return from Stripe proves nothing: it only asks the server to read Stripe again.
  useEffect(() => {
    const back = new URLSearchParams(window.location.search).get("cobranca");
    // Only the two addresses the server gives Stripe; anything else is not a return.
    if ((back !== "retorno" && back !== "cancelado") || returned.current || !data.card) return;
    returned.current = true;
    if (back === "cancelado") return setMessage("Pagamento não concluído. Nada foi cobrado.");
    setMessage("Pagamento em confirmação. O plano muda quando o Stripe confirmar a fatura paga.");
    if (canManage) void action.run(() => refresh({ organizationId: org.id }), { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Once per visit: `action` and `refresh` change identity on every render.
  }, [data.card, canManage, org.id]);

  const sub = data.account?.subscription ?? null;
  const live = sub && !ended.includes(sub.status) ? sub : null;
  const renewing = !!live && !live.cancelAtPeriodEnd;
  const current = data.plan && data.plan.tier in monthly ? (data.plan.tier as PaidTier) : null;
  const renewal = data.account?.renewalTier ?? live?.tier ?? null;
  const method = live ? "Cartão, pelo Stripe" : current ? "Pix assistido" : "Nenhum";
  const blocked = !canManage || action.busy || !!data.checkout || data.pixPending;
  // An annual subscription bills its first year on the anchor: until then it bought nothing, and
  // the plan in force, if any, does not come from it.
  const unpaidAnnual = !!live?.annual && !data.subscriptionTerm;
  const nextMonth = utcMonth(Date.now(), 1);

  async function confirm() {
    if (!pending) return "";
    if (pending.kind === "abandon")
      return action.run(() => abandon({ organizationId: org.id }), {
        quiet: true,
        done: () => setMessage("Pagamento por cartão abandonado. Nada foi cobrado por ele."),
      });
    if (pending.kind === "renewal") {
      const change = pending.change;
      return action.run(() => changeRenewal({ organizationId: org.id, change }), {
        quiet: true,
        done: () =>
          setMessage(
            change === "cancel"
              ? unpaidAnnual
                ? "Renovação cancelada. A assinatura anual não será cobrada."
                : "Renovação cancelada. O período pago continua até o fim."
              : change === "resume"
                ? "Renovação retomada."
                : `A próxima renovação será como ${tierNames[change]}. O mês pago não muda.`,
          ),
      });
    }
    const { tier, cycle } = pending;
    // Same key after an uncertain answer, so the server returns the same Checkout.
    const key = (keys.current[`${tier}:${cycle}`] ??= crypto.randomUUID());
    if (cycle === "annual" && !data.annualEnabled)
      return failure(new ConvexError({ code: "ANNUAL_DISABLED" }));
    const intention = { organizationId: org.id, tier, key };
    return action.run(() => checkout(cycle === "annual" ? { ...intention, cycle } : intention), {
      quiet: true,
      done: ({ url }) => window.location.assign(url),
    });
  }

  if (!data.card)
    return (
      <Card
        title="Cobrança"
        description={
          data.pixEnabled ? "Pagamento por Pix assistido." : "Contratação indisponível no momento."
        }
      >
        <DescriptionList
          items={[
            { term: "Forma de pagamento", value: current ? "Pix assistido" : "Nenhum" },
            {
              term: "Plano e período",
              value: data.plan ? planUntil(data.plan) : "Sem plano em vigor",
            },
          ]}
        />
        <p className="gestao-help">O pagamento por cartão está indisponível no momento.</p>
      </Card>
    );
  return (
    <Card
      title="Cobrança"
      description={
        data.pixEnabled
          ? "Cartão com renovação automática todo mês, no dia e horário da contratação, em UTC, ou Pix assistido. Uma forma de pagamento por vez."
          : "Cartão com renovação automática todo mês, no dia e horário da contratação, em UTC."
      }
      actions={
        live ? (
          <StatusBadge tone={live.status === "active" ? "success" : "warning"}>
            {live.status === "active"
              ? live.cancelAtPeriodEnd
                ? "Renovação cancelada"
                : "Assinatura ativa"
              : "Pagamento pendente"}
          </StatusBadge>
        ) : null
      }
    >
      {message ? (
        <Callout role="status" tone="info">
          {message}
        </Callout>
      ) : null}
      {action.error ? <Callout tone="warning">{action.error}</Callout> : null}
      <DescriptionList
        items={[
          { term: "Forma de pagamento", value: method },
          {
            term: "Plano e período",
            value: data.plan ? planUntil(data.plan) : "Sem plano em vigor",
          },
          {
            term: "Próxima cobrança",
            value:
              renewing && live?.periodEnd && renewal
                ? live.annual
                  ? `${price(annual[renewal])} em ${utcDate(live.periodEnd)} (${tierNames[renewal]} anual, 12 meses)`
                  : `${price(monthly[renewal])} em ${formatUtcInstant(live.periodEnd)} (${tierNames[renewal]})`
                : live?.cancelAtPeriodEnd && live.periodEnd
                  ? unpaidAnnual
                    ? "Nenhuma. A assinatura anual não será cobrada."
                    : `Nenhuma. O plano termina em ${live.annual ? utcDate(live.periodEnd) : formatUtcInstant(live.periodEnd)}`
                  : "Nenhuma",
          },
          {
            term: "Última conferência com o Stripe",
            value: data.account?.syncedAt
              ? utcDateTime(data.account.syncedAt)
              : "Ainda não conferido",
          },
        ]}
      />
      {data.account?.openInvoice ? (
        <Callout tone="warning" title="Pagamento recusado">
          A cobrança de {price(data.account.openInvoice.amountDueCents)} não foi aprovada. Sem
          carência: o plano vence no fim do mês pago e volta quando o pagamento for aprovado. Os
          documentos continuam guardados.{" "}
          {data.account.openInvoice.url ? (
            <a href={data.account.openInvoice.url} target="_blank" rel="noreferrer">
              Pagar fatura no Stripe
            </a>
          ) : null}
        </Callout>
      ) : null}
      {data.account?.syncError ? (
        <Callout tone="warning">
          Há mais de uma assinatura ativa no Stripe. A equipe da Freecorps foi sinalizada.
        </Callout>
      ) : null}
      {data.reviews.length ? (
        <Callout tone="info" title="Em análise pela equipe">
          <ul>
            {data.reviews.map((item) => (
              <li key={`${item.source}:${item.createdAt}:${item.code}`}>
                {reviewName(item)}
                {item.amountCents !== null ? `, ${price(item.amountCents)}` : ""}
              </li>
            ))}
          </ul>
          O plano não muda por conta própria. Reembolsos são decididos pela equipe.
        </Callout>
      ) : null}
      {data.checkout ? (
        <Callout
          tone="info"
          title="Pagamento por cartão em andamento"
          actions={
            canManage ? (
              <>
                {data.checkout.url ? (
                  <a className={buttonClass({ variant: "primary" })} href={data.checkout.url}>
                    Continuar no Stripe
                  </a>
                ) : null}
                <Button disabled={action.busy} onClick={() => setPending({ kind: "abandon" })}>
                  Desistir
                </Button>
              </>
            ) : null
          }
        >
          {data.checkout.cycle === "annual" && data.checkout.kind === "upgrade"
            ? `${price(data.checkout.grantCents)} agora, pela mudança para o ${tierNames[data.checkout.tier]} anual até o fim do plano anual`
            : data.checkout.cycle === "annual" && data.checkout.periodStartsAt !== null
              ? `${tierNames[data.checkout.tier]} anual: nada agora, ${price(data.checkout.grantCents)} em ${utcDate(data.checkout.periodStartsAt)} por 12 meses`
              : `${tierNames[data.checkout.tier]}: ${price(data.checkout.grantCents)} agora${
                  data.checkout.kind === "start"
                    ? `, depois ${price(monthly[data.checkout.tier])} por mês, no dia e horário do pagamento`
                    : " pela diferença do mês do plano"
                }`}
          . O link vale até {utcDateTime(data.checkout.expiresAt)}.
        </Callout>
      ) : null}
      {data.pixPending ? (
        <p className="gestao-help">Há um pedido por Pix aguardando pagamento.</p>
      ) : null}
      {canManage && data.annualEnabled && renewing && !live.annual ? (
        <p className="gestao-help">
          Para assinar o anual no cartão, use “Cancelar renovação” antes. O mês pago continua até o
          anual começar, no dia 1 seguinte, e é substituído por ele sem desconto dos dias restantes.
          Um anual menor que o plano mensal em vigor espera o fim dele.
        </p>
      ) : null}
      {canManage && data.annualEnabled && !live?.annual && data.annualBlocked ? (
        <p className="gestao-help">
          Há um plano anual em vigor ou agendado. Um novo anual no cartão só pode ser assinado
          depois que ele terminar.
        </p>
      ) : null}
      {!canManage ? null : (
        <div className="ui-actions">
          {tiers.map((tier) => {
            if (!live)
              return (
                <Button
                  key={tier}
                  variant={tier === "intermediate" ? "primary" : "secondary"}
                  disabled={blocked}
                  onClick={() => setPending({ kind: "checkout", tier, cycle: "monthly" })}
                >
                  Assinar {tierNames[tier]} no cartão
                </Button>
              );
            // The annual upgrade is offered on the term itself; its downgrade is not sold yet.
            if (live.annual) return null;
            if (current && monthly[tier] > monthly[current] && renewing)
              return (
                <Button
                  key={tier}
                  disabled={blocked}
                  onClick={() => setPending({ kind: "checkout", tier, cycle: "monthly" })}
                >
                  Mudar para {tierNames[tier]}
                </Button>
              );
            if (renewal && monthly[tier] < monthly[renewal] && renewing)
              return (
                <Button
                  key={tier}
                  disabled={blocked}
                  onClick={() => setPending({ kind: "renewal", change: tier })}
                >
                  Renovar como {tierNames[tier]}
                </Button>
              );
            return null;
          })}
          {data.annualEnabled && !live?.annual
            ? tiers.map((tier) => (
                <Button
                  key={`${tier}-annual`}
                  disabled={blocked || renewing || data.annualBlocked}
                  onClick={() => setPending({ kind: "checkout", tier, cycle: "annual" })}
                >
                  Assinar {tierNames[tier]} anual no cartão
                </Button>
              ))
            : null}
          {live ? (
            <Button
              disabled={action.busy}
              onClick={() =>
                setPending({ kind: "renewal", change: renewing ? "cancel" : "resume" })
              }
            >
              {renewing ? "Cancelar renovação" : "Retomar renovação"}
            </Button>
          ) : null}
          {data.account ? (
            <Button
              disabled={action.busy}
              onClick={() =>
                action.run(() => portal({ organizationId: org.id }), {
                  done: ({ url }) => window.location.assign(url),
                })
              }
            >
              Cartão e faturas
            </Button>
          ) : null}
          {data.account ? (
            <Button
              disabled={action.busy}
              loading={action.busy}
              loadingLabel="Conferindo…"
              onClick={() =>
                action.run(() => refresh({ organizationId: org.id }), {
                  done: () => setMessage("Situação conferida com o Stripe."),
                })
              }
            >
              Conferir pagamento
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.kind === "checkout" && pending.cycle === "annual"
            ? `Assinar ${tierNames[pending.tier]} anual no cartão?`
            : pending?.kind === "checkout"
              ? live
                ? `Mudar para ${tierNames[pending.tier]}?`
                : `Assinar ${tierNames[pending.tier]} no cartão?`
              : pending?.kind === "abandon"
                ? "Desistir do pagamento por cartão?"
                : pending?.kind === "renewal" && pending.change === "cancel"
                  ? "Cancelar a renovação?"
                  : pending?.kind === "renewal" && pending.change === "resume"
                    ? "Retomar a renovação?"
                    : `Renovar como ${pending?.kind === "renewal" ? tierNames[pending.change] : ""}?`
        }
        description={
          pending?.kind === "checkout" && pending.cycle === "annual"
            ? `Nada é cobrado agora. Você será levado ao Stripe, e ${price(annual[pending.tier])} são cobrados em ${utcDate(nextMonth)}, início dos 12 meses. Até lá, o mês corrente segue no plano atual. Depois, a renovação é anual, na mesma data.${data.pixEnabled ? " Para começar agora, peça o anual por Pix em Escolha seu plano." : ""}`
            : pending?.kind === "checkout"
              ? live
                ? `Você será levado ao Stripe para pagar a diferença integral do mês do plano${data.plan?.endsAt ? `, que termina em ${formatUtcInstant(data.plan.endsAt)}` : ""}. O plano muda quando o Stripe confirmar o pagamento, até essa mesma data, e a renovação passa a ser pelo novo plano.`
                : `Você será levado ao Stripe. ${price(monthly[pending.tier])} são cobrados no pagamento, integrais e sem pró-rata, e o mês vai até o mesmo dia e horário do mês seguinte, em UTC. Depois, ${price(monthly[pending.tier])} por mês, cobrados nesse dia e horário.`
              : pending?.kind === "abandon"
                ? "O link de pagamento deixa de valer. Se o pagamento já tiver sido feito, ele continua valendo."
                : pending?.kind === "renewal" && pending.change === "cancel"
                  ? unpaidAnnual
                    ? `Sem multa. A assinatura anual ainda não foi cobrada, e a primeira cobrança${live?.periodEnd ? `, em ${utcDate(live.periodEnd)},` : ""} não acontece. O plano atual não muda. Os documentos continuam guardados.`
                    : live?.annual
                      ? "Sem multa. Os meses pagos do plano anual continuam até o fim, sem reembolso. Para rescindir com reembolso, fale com o suporte. Os documentos continuam guardados."
                      : "Sem multa. O período pago continua até o fim, sem reembolso proporcional. Os documentos continuam guardados."
                  : pending?.kind === "renewal" && pending.change === "resume"
                    ? live?.annual
                      ? "A assinatura volta a renovar pelo anual no fim do período."
                      : "A assinatura volta a renovar todo mês, no dia e horário da contratação."
                    : "Vale a partir da próxima renovação, se o uso atual couber no plano. O mês pago não muda."
        }
        confirmLabel={pending?.kind === "checkout" ? "Ir para o Stripe" : "Confirmar"}
        busyLabel="Aguarde…"
        tone={
          pending?.kind === "abandon" ||
          (pending?.kind === "renewal" && pending.change === "cancel")
            ? "danger"
            : "primary"
        }
        onConfirm={confirm}
        confirmDisabled={!canManage}
      />
    </Card>
  );
}
