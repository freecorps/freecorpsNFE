import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import { ConvexError } from "convex/values";
import type { Organization } from "./organizations";
import { useQuery } from "./convex-query";
import { useAsyncAction } from "./async-action";
import { ErrorBoundary } from "./route-errors";
import { formatBRL, formatUtcInstant } from "./format";
import { formatBytes } from "./usage-format";
import { Button } from "./ui/button";
import { RadioCard } from "./ui/choice";
import { DataTable } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { Icon } from "./ui/icons";
import { Callout, Card, DescriptionList, StatusBadge } from "./ui/layout";

type PaidTier = "intermediate" | "large";
type Tier = "free" | PaidTier;
type Cycle = "monthly" | "annual";
const plansApi = api.plans;
export type PlansOverview = FunctionReturnType<typeof plansApi.overview>;
type RequestId = NonNullable<PlansOverview["request"]>["id"];
type Offer = PlansOverview["offers"][number];
type Term = PlansOverview["terms"][number];
const integer = new Intl.NumberFormat("pt-BR");
export const tierNames: Record<string, string> = {
  free: "Gratuito",
  intermediate: "Intermediário",
  large: "Grande",
  custom: "Personalizado",
};
const pendingMessage =
  "Pedido registrado. Aguarde as instruções de pagamento pelo canal de atendimento.";
/** Convert integer cents without calculating currency with floating point. */
export function price(cents: number) {
  const digits = String(cents).padStart(3, "0");
  return formatBRL(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
}
/** Billing periods are UTC months: the date shown is the UTC day, never the browser's. */
export const utcDate = (ms: number) =>
  `${new Date(ms).toLocaleDateString("pt-BR", { timeZone: "UTC" })}, 00:00 UTC`;
export const utcDateTime = (ms: number) =>
  `${new Date(ms).toLocaleString("pt-BR", { timeZone: "UTC" })} UTC`;
/** The 1st, 00:00 UTC, of the month `offset` months from the one of `at`. */
export function utcMonth(at: number, offset = 0) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
}
/** The tier a term has in its last month, the one it renews at. */
const lastTier = (term: Term) => term.segments.at(-1)?.tier ?? term.tier;
const monthsLeft = (months: number) =>
  months === 1 ? "pelo último mês" : `pelos ${months} meses restantes`;
/**
 * Annual codes (ADR 0010, decision 9), shared with the billing card. `SUBSCRIPTION_RENEWING`
 * names the console's button for "Não renovar".
 */
export const annualMessages: Record<string, string> = {
  ANNUAL_DISABLED: "O plano anual não está à venda no momento. Nada foi registrado.",
  ANNUAL_TERM_ACTIVE:
    "Esta organização tem um plano anual em vigor ou agendado que coincide com este pedido.",
  ANNUAL_TERM_REQUIRED:
    "Não há plano anual em vigor agora para mudar de plano. Confira a situação atual.",
  ANNUAL_TERM_SCHEDULED:
    "Há um plano anual agendado, ainda não começado ou já pago como renovação. A mudança para o Grande abre depois que ele começar.",
  ANNUAL_TERM_RESCINDED:
    "O plano anual desta assinatura foi rescindido pelo suporte. A renovação não pode ser retomada.",
  PAYMENT_METHOD_PIX:
    "Este plano anual foi pago por Pix, e a mudança de plano também é pelo Pix. Confira a situação atual.",
  SUBSCRIPTION_RENEWING:
    "O cartão ainda renova a assinatura atual. Use “Cancelar renovação” antes de assinar o anual no cartão; o período já pago continua.",
};
/** Why a new annual by Pix waits (`annualStart.code`), before anything is asked. */
const annualWaits: Record<string, string> = {
  ANNUAL_TERM_ACTIVE:
    "Há um plano anual em vigor ou agendado. Pelo Pix, a renovação é pedida no último mês dele.",
  PAYMENT_METHOD_CARD:
    "Esta organização paga por cartão. O anual por Pix espera o fim do período pago pelo cartão.",
  PLAN_UNAVAILABLE: "Há um plano pago em vigor. O anual por Pix espera o fim dele.",
};
/** Why a new monthly by Pix waits (`monthlyStart[tier].code`), before anything is asked. */
const monthlyWaits: Record<string, string> = {
  ANNUAL_TERM_ACTIVE:
    "Há um plano anual em vigor ou agendado. Pelo Pix, o mensal é a renovação dele, pedida no último mês.",
  PAYMENT_METHOD_CARD:
    "Esta organização paga por cartão. O mensal por Pix espera o fim do período pago pelo cartão.",
  PLAN_UNAVAILABLE:
    "Há um plano em vigor ou uma renovação já paga. O mensal por Pix espera por ele.",
};
/**
 * A refused sale waits for the plan in force (ADR 0012, one paid plan at a time): the server
 * sends the instant it becomes available, which the message ends with.
 */
const availableFrom = (availableAt: unknown) =>
  typeof availableAt === "number"
    ? ` Disponível a partir de ${formatUtcInstant(availableAt)}.`
    : "";
/** The code of a refusal and the date it ends with, shared with the billing card. */
export function refusalOf(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? data.code : null;
  const availableAt =
    data && typeof data === "object" && "availableAt" in data ? data.availableAt : null;
  return { code: typeof code === "string" ? code : null, availability: availableFrom(availableAt) };
}
function failure(error: unknown) {
  const { code, availability } = refusalOf(error);
  return code && planMessages[code]
    ? planMessages[code] + availability
    : "Não foi possível concluir. Confira a situação do plano e tente novamente.";
}
const planMessages: Record<string, string> = {
  ...annualMessages,
  ACCESS_DENIED:
    "Seu acesso mudou. Apenas o proprietário e administradores podem contratar planos.",
  UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
  PLANS_DISABLED: "A contratação de planos está indisponível no momento.",
  PLAN_UNAVAILABLE: "Este plano está indisponível. Confira as opções atualizadas.",
  FREE_PLAN_UNAVAILABLE:
    "O plano gratuito não está disponível para esta organização. Confira o plano atual.",
  PLAN_REQUEST_PENDING:
    "Já existe um pedido aguardando pagamento. Confira o pedido antes de continuar.",
  PLAN_REQUEST_UNAVAILABLE:
    "Este pedido mudou ou não está mais disponível. Confira a situação atual.",
  ORGANIZATION_CLOSED: "Esta organização foi encerrada. Não é possível contratar um plano.",
  ORGANIZATION_ARCHIVED:
    "Organização em arquivo econômico. Consulte a Freecorps sobre a recuperação dos dados.",
  CAPACITY_INVENTORY_REQUIRED:
    "O inventário de capacidade está pendente. Solicite a conferência à Freecorps.",
  QUOTA_EXCEEDED: "O uso atual não cabe neste plano. Nada foi alterado.",
  PIX_DISABLED:
    "O pagamento por Pix não está disponível no momento. Assine pelo cartão em Cobrança. Nada foi registrado.",
  PAYMENT_METHOD_CARD:
    "Esta organização paga por cartão. O Pix fica disponível quando o período pago pelo cartão termina, com a renovação cancelada e sem pagamento em andamento.",
  // The card upgrade of an annual term opens a Stripe Checkout from here.
  BILLING_DISABLED: "O pagamento por cartão está indisponível no momento.",
  BILLING_UNAVAILABLE:
    "O Stripe não respondeu. Nada foi cobrado por esta tentativa; tente novamente em instantes.",
  CHECKOUT_PENDING: "Já existe um pagamento por cartão em andamento.",
  SUBSCRIPTION_REQUIRED:
    "A assinatura anual por cartão deste plano não está mais ativa. Confira a cobrança.",
  PERIOD_CLOSING:
    "Pelo cartão, a mudança fecha na virada do mês e nas últimas 72 horas do plano anual. Tente de novo a partir de 00:00 UTC do dia 1.",
};

export function Plans({ org, contextKey }: { org: Organization; contextKey: string }) {
  const scope = `${org.id}:${contextKey}:${org.role}`;
  return (
    <ErrorBoundary
      key={scope}
      fallback={(error, reset) => (
        <Callout
          tone="warning"
          title="Não foi possível carregar os planos."
          actions={<Button onClick={reset}>Tentar novamente</Button>}
        >
          {failure(error)}
        </Callout>
      )}
    >
      <PlansQuery org={org} contextKey={contextKey} />
    </ErrorBoundary>
  );
}
function PlansQuery({ org, contextKey }: { org: Organization; contextKey: string }) {
  const data = useQuery(plansApi.overview, { organizationId: org.id, contextKey });
  if (data === undefined)
    return (
      <p className="gestao-help" aria-busy="true">
        Carregando planos…
      </p>
    );
  if (!data.enabled)
    return <Callout>A contratação de planos está indisponível no momento.</Callout>;
  return <PlanCatalog org={org} data={data} />;
}
function PlanCatalog({ org, data }: { org: Organization; data: PlansOverview }) {
  const claimFree = useMutation(plansApi.claimFree);
  const requestPaid = useMutation(plansApi.requestPaid);
  const cancelRequest = useMutation(plansApi.cancelRequest);
  const checkout = useAction(api.billing.checkout);
  const action = useAsyncAction(failure);
  const [selection, setSelection] = useState<Tier | "cancel" | "upgrade" | null>(null);
  const [cycle, setCycle] = useState<Cycle>("monthly");
  // The cycle of the open confirmation, fixed when it opened.
  const [chosenCycle, setChosenCycle] = useState<Cycle>("monthly");
  const [cancellingId, setCancellingId] = useState<RequestId | null>(null);
  const [message, setMessage] = useState("");
  // Keep the same intention after an uncertain response, including closing and reopening.
  const keys = useRef<Record<string, string>>({});
  // An abandoned or finished card Checkout cannot be reopened by its key: the next upgrade is a
  // new intention.
  const hadCheckout = useRef(data.checkout);
  useEffect(() => {
    if (hadCheckout.current && !data.checkout)
      for (const key of Object.keys(keys.current))
        if (key.startsWith("upgrade:")) delete keys.current[key];
    hadCheckout.current = data.checkout;
  }, [data.checkout]);
  const canManage = org.role === "owner" || org.role === "admin";
  // A request past its deadline no longer holds the organization; the next one replaces it.
  const pending = data.request?.state === "awaiting_payment" && !data.request.expired;
  const offer = data.offers.find((item) => item.tier === selection);
  const activeTier = data.subscription?.tier;
  const archived = data.archive && !["notice", "hot"].includes(data.archive.state);
  const blocked = !canManage || action.busy || pending || !!archived;
  // The annual is shown only while the server sells it; switched off, the monthly comes back.
  const annualView = data.annualEnabled && cycle === "annual";
  const annualChosen = chosenCycle === "annual";
  const upgradable = data.terms.find((term) => term.upgrade);
  const now = Date.now();
  // How a new annual by Pix starts, as the server sells it: never a client choice (ADR 0012).
  const annualStart = data.annualStart;
  const cardUpgradeClosed =
    typeof upgradable?.upgrade?.cardUntil === "number" && now >= upgradable.upgrade.cardUntil;
  // How a new monthly by Pix starts, as the server sells it by tier: never a client choice.
  const chosenMonthly = offer && offer.tier !== "free" ? data.monthlyStart[offer.tier] : null;
  const selectedPrice =
    offer && offer.tier !== "free" ? (chosenMonthly?.amountCents ?? offer.monthlyCents) : 0;
  const monthlyHint = (tier: PaidTier) => {
    const start = data.monthlyStart[tier];
    return start.start === null
      ? `${(start.code && monthlyWaits[start.code]) || "O mensal por Pix não está disponível agora."}${availableFrom(start.availableAt)}`
      : start.start === "renewal" && start.startsAt !== null
        ? `Renovação do plano em vigor: começa em ${formatUtcInstant(start.startsAt)}, quando ele termina.`
        : start.start === "upgrade" && start.endsAt !== null
          ? `Mudança na confirmação, pela diferença, até ${formatUtcInstant(start.endsAt)}, o fim do plano em vigor.`
          : "";
  };
  async function confirm() {
    if (!canManage) return failure(new ConvexError({ code: "ACCESS_DENIED" }));
    setMessage("");
    if (
      selection === "cancel" &&
      data.request?.state === "awaiting_payment" &&
      data.request.id === cancellingId
    ) {
      const requestId = data.request.id;
      return action.run(() => cancelRequest({ organizationId: org.id, requestId }), {
        quiet: true,
        done: () => {
          keys.current = {};
          setMessage("Pedido cancelado. O plano atual foi mantido.");
        },
      });
    }
    if (selection === "free" && data.availability.canClaimFree && !pending) {
      return action.run(() => claimFree({ organizationId: org.id }), {
        quiet: true,
        done: () => setMessage("Plano gratuito ativado. Consulte os limites no plano atual."),
      });
    }
    const month = new Date().toISOString().slice(0, 7);
    if (selection === "upgrade" && upgradable?.upgrade && !pending) {
      const tier = upgradable.upgrade.tier;
      const key = (keys.current[`upgrade:${upgradable.id}:${tier}:${month}`] ??=
        crypto.randomUUID());
      const intention = { organizationId: org.id, tier, key, cycle: "annual" as const };
      // The upgrade is paid as the term was: Pix by a request, the card by a Stripe Checkout.
      return upgradable.source === "stripe"
        ? action.run(() => checkout({ ...intention, start: "upgrade" }), {
            quiet: true,
            done: ({ url }) => window.location.assign(url),
          })
        : action.run(() => requestPaid({ ...intention, start: "upgrade" }), { quiet: true });
    }
    if ((selection === "intermediate" || selection === "large") && offer && !pending) {
      const tier = selection;
      if (annualChosen) {
        if (!data.annualEnabled || !annualStart.start)
          return "A disponibilidade mudou. Feche esta confirmação e confira os planos atualizados.";
        const chosenStart = annualStart.start;
        const key = (keys.current[
          `${tier}:annual:${chosenStart}:${data.request?.id ?? "first"}:${month}`
        ] ??= crypto.randomUUID());
        return action.run(
          () =>
            requestPaid({
              organizationId: org.id,
              tier,
              key,
              cycle: "annual",
              start: chosenStart,
            }),
          { quiet: true },
        );
      }
      const intention = `${tier}:${data.request?.id ?? "first"}:${month}`;
      const key = (keys.current[intention] ??= crypto.randomUUID());
      return action.run(() => requestPaid({ organizationId: org.id, tier, key }), {
        quiet: true,
      });
    }
    return "A disponibilidade mudou. Feche esta confirmação e confira os planos atualizados.";
  }
  const request = data.request;
  const requestStart = request?.start ?? null;
  const scheduledRenewal = data.scheduledRenewal;
  const annualPrice = (item: Offer) => (annualView ? item.annualCents : undefined);
  // One paid plan at a time: while one is in force, the annual by Pix is only its renewal, asked
  // in its last month. A card term that renews bills its own next year beside it.
  const cardRenews = data.terms.some((term) => term.renews);
  const annualClosed = cardRenews || annualStart.start === null;
  const annualHint = cardRenews
    ? "Há um plano anual em vigor, que renova pelo cartão."
    : annualStart.start === null
      ? `${(annualStart.code && annualWaits[annualStart.code]) || "O anual por Pix não está disponível agora."}${availableFrom(annualStart.availableAt)}`
      : annualStart.start === "renewal" && annualStart.startsAt !== null
        ? `Renovação do plano em vigor: começa em ${formatUtcInstant(annualStart.startsAt)}, quando ele termina.`
        : "";
  const startAllowed = !cardRenews && annualStart.start !== null;
  return (
    <>
      {data.archive && data.archive.state !== "hot" ? (
        <Callout
          tone="warning"
          title={archived ? "Organização em arquivo econômico" : "Arquivamento programado"}
        >
          {archived
            ? "O acesso operacional está bloqueado. Consulte a Freecorps sobre a recuperação dos dados."
            : `Arquivamento previsto a partir de ${new Date(data.archive.eligibleAt).toLocaleDateString("pt-BR")}. Procure o atendimento para manter a operação ativa.`}
        </Callout>
      ) : null}
      {data.stock ? (
        <Card
          title="Estoque e transferências"
          description="O estoque soma Sandbox e Produção. Os limites mensais de transferência renovam em UTC."
        >
          {!data.stock.ready ? (
            <p>Inventário pendente. Novas entradas aguardam conferência.</p>
          ) : null}
          <DescriptionList
            items={[
              {
                term: "Arquivos guardados",
                value: formatBytes(
                  (data.stock.totals.filesBytes?.committed ?? 0) +
                    (data.stock.totals.filesBytes?.reserved ?? 0),
                ),
              },
              {
                term: "Dados dos documentos",
                value: formatBytes(
                  (data.stock.totals.databaseBytes?.committed ?? 0) +
                    (data.stock.totals.databaseBytes?.reserved ?? 0),
                ),
              },
              {
                term: "Downloads no mês",
                value: formatBytes(data.stock.totals.downloadsBytes?.committed ?? 0),
              },
              {
                term: "Volume exportado no mês",
                value: formatBytes(data.stock.totals.exportsBytes?.committed ?? 0),
              },
            ]}
          />
          <p className="gestao-help">
            Os dados dos documentos medem registros fiscais. Não incluem índices e demais dados
            internos da plataforma. Reservas de operações em andamento estão incluídas no estoque.
          </p>
        </Card>
      ) : null}
      {message ? (
        <Callout role="status" tone="info">
          {message}
        </Callout>
      ) : null}
      {request ? (
        <Card
          title="Pedido de plano"
          actions={
            <StatusBadge
              tone={pending ? "warning" : request.state === "activated" ? "success" : "neutral"}
            >
              {pending
                ? "Aguardando pagamento"
                : request.state === "activated"
                  ? "Pagamento confirmado"
                  : request.expired
                    ? "Prazo encerrado"
                    : "Pedido cancelado"}
            </StatusBadge>
          }
        >
          <DescriptionList
            items={
              request.cycle === "annual" && requestStart === "upgrade"
                ? [
                    {
                      term: "Mudança solicitada",
                      value: `Para ${tierNames[request.tier]} anual, até o fim do plano anual`,
                    },
                    {
                      term: "Valor da mudança",
                      value: `${price(request.amountCents)}, pela diferença dos meses restantes`,
                    },
                    {
                      term: "A partir de",
                      value:
                        request.periodStartsAt === null
                          ? "—"
                          : formatUtcInstant(request.periodStartsAt),
                    },
                  ]
                : request.cycle === "annual"
                  ? [
                      { term: "Plano solicitado", value: `${tierNames[request.tier]} anual` },
                      {
                        term: "Valor integral",
                        value: `${price(request.amountCents)} por 12 meses`,
                      },
                      {
                        term: "Início",
                        value:
                          request.periodStartsAt === null
                            ? "Na confirmação do pagamento pela equipe"
                            : requestStart === "renewal"
                              ? `${formatUtcInstant(request.periodStartsAt)}, no fim do plano em vigor`
                              : // A request made before ADR 0012: its term starts on that 1st.
                                formatUtcInstant(request.periodStartsAt),
                      },
                    ]
                  : requestStart === "upgrade"
                    ? [
                        { term: "Mudança solicitada", value: `Para ${tierNames[request.tier]}` },
                        {
                          term: "Valor da mudança",
                          value: `${price(request.amountCents)}, pela diferença integral`,
                        },
                        {
                          term: "Período",
                          value:
                            request.periodEndsAt === null
                              ? "Da confirmação do pagamento pela equipe ao fim do plano em vigor"
                              : `Da confirmação do pagamento pela equipe a ${formatUtcInstant(request.periodEndsAt)}, o fim do plano em vigor`,
                        },
                      ]
                    : [
                        { term: "Plano solicitado", value: tierNames[request.tier] },
                        { term: "Valor integral", value: price(request.amountCents) },
                        {
                          term: "Período",
                          value:
                            requestStart === "now"
                              ? "Um mês, da confirmação do pagamento pela equipe ao mesmo dia e horário do mês seguinte"
                              : request.periodStartsAt === null
                                ? "—"
                                : request.periodEndsAt === null
                                  ? `Desde ${formatUtcInstant(request.periodStartsAt)}`
                                  : requestStart === "renewal"
                                    ? `De ${formatUtcInstant(request.periodStartsAt)}, no fim do plano em vigor, a ${formatUtcInstant(request.periodEndsAt)}`
                                    : // A monthly request made before ADR 0012: the civil month.
                                      `Desde ${formatUtcInstant(request.periodStartsAt)}, termina em ${formatUtcInstant(request.periodEndsAt)}`,
                        },
                      ]
            }
          />
          {pending ? (
            <>
              <p>{pendingMessage}</p>
              <p>
                {request.cycle === "annual" && requestStart === "upgrade"
                  ? `O plano anual continua durante a espera. A mudança só vale após a confirmação do pagamento pela equipe, até ${formatUtcInstant(request.payBy)}.`
                  : request.cycle === "annual"
                    ? `O plano atual continua durante a espera. O plano anual só começa após a confirmação do pagamento pela equipe, até ${formatUtcInstant(request.payBy)}.`
                    : requestStart === null
                      ? "O plano atual continua durante a espera. O novo plano só será ativado após a confirmação do pagamento pela equipe."
                      : `O plano atual continua durante a espera. O novo plano só vale após a confirmação do pagamento pela equipe, até ${formatUtcInstant(request.payBy)}.`}
              </p>
              {canManage ? (
                <Button
                  disabled={action.busy}
                  onClick={() => {
                    setCancellingId(request.id);
                    setSelection("cancel");
                  }}
                >
                  Cancelar pedido
                </Button>
              ) : null}
            </>
          ) : request.expired ? (
            <p>
              O prazo de pagamento terminou em {formatUtcInstant(request.payBy)}, e o pedido não
              será mais confirmado. Um novo pedido o substitui.
            </p>
          ) : null}
        </Card>
      ) : null}
      {scheduledRenewal ? (
        <Card
          title="Renovação mensal paga"
          actions={
            <StatusBadge tone={scheduledRenewal.blocked ? "warning" : "info"}>
              {scheduledRenewal.blocked ? "Início pendente" : "Agendada"}
            </StatusBadge>
          }
        >
          <DescriptionList
            items={[
              { term: "Plano", value: tierNames[scheduledRenewal.tier] },
              { term: "Forma de pagamento", value: "Pix assistido" },
              {
                term: "Período",
                value: `De ${formatUtcInstant(scheduledRenewal.startsAt)} a ${formatUtcInstant(scheduledRenewal.endsAt)}`,
              },
            ]}
          />
          {scheduledRenewal.blocked ? (
            <Callout tone="warning">
              O pagamento foi recebido, e o início da renovação aguarda a equipe da Freecorps. Nada
              é cobrado de novo.
            </Callout>
          ) : (
            <p>O plano atual continua até o início da renovação.</p>
          )}
        </Card>
      ) : null}
      {data.terms.map((term) => (
        <AnnualTerm
          annualEnabled={data.annualEnabled}
          pixEnabled={data.pixEnabled}
          key={term.id}
          term={term}
          actions={
            // A Pix term is upgraded by Pix: with Pix off, only a card term offers it.
            canManage && term.upgrade && (term.source === "stripe" || data.pixEnabled) ? (
              <>
                <Button
                  disabled={blocked || (term.source === "stripe" && cardUpgradeClosed)}
                  onClick={() => {
                    setMessage("");
                    setSelection("upgrade");
                  }}
                >
                  Mudar para {tierNames[term.upgrade.tier]} anual
                </Button>
                <p className="gestao-help">
                  {term.source === "stripe" && cardUpgradeClosed
                    ? "Pelo cartão, a mudança fecha nas últimas 72 horas do plano anual."
                    : `${price(term.upgrade.amountCents)} ${monthsLeft(term.upgrade.months)}, com o mês corrente inteiro. O fim do plano anual não muda.`}
                </p>
              </>
            ) : null
          }
        />
      ))}
      <Card
        title="Escolha seu plano"
        description="Comece sem taxa de configuração. As cotas de uso renovam a cada mês do plano, em UTC."
        flush
      >
        {!canManage || data.annualEnabled ? (
          <div className="gestao-body">
            {!canManage ? (
              <Callout>
                Apenas o proprietário e administradores podem contratar ou cancelar pedidos. Você
                pode consultar os planos e limites.
              </Callout>
            ) : null}
            {data.annualEnabled ? (
              <div role="radiogroup" aria-label="Ciclo de pagamento" className="ui-choice-group">
                <RadioCard
                  name="plan-cycle"
                  label="Mensal"
                  help="Pago a cada mês, sem fidelidade."
                  checked={cycle === "monthly"}
                  onChange={() => setCycle("monthly")}
                />
                <RadioCard
                  name="plan-cycle"
                  label="Anual"
                  help="12 meses pelo preço de 10, pagos de uma vez."
                  checked={cycle === "annual"}
                  onChange={() => setCycle("annual")}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <DataTable<Offer>
          label="Planos e limites"
          rows={data.offers}
          rowKey={(item) => item.tier}
          empty={
            <Callout>
              Nenhum plano disponível para contratação no momento. Consulte o canal de atendimento.
            </Callout>
          }
          columns={[
            {
              key: "name",
              header: "Plano",
              primary: true,
              cell: (item) => (
                <>
                  {item.name}
                  {activeTier === item.tier ? <StatusBadge>Plano atual</StatusBadge> : null}
                </>
              ),
            },
            {
              key: "price",
              header: annualView ? "Preço" : "Mensalidade",
              cell: (item) => {
                const yearly = annualPrice(item);
                if (yearly !== undefined)
                  return (
                    <>
                      {price(yearly)}
                      <p>por 12 meses</p>
                      <p className="gestao-help">
                        Economia de {price(12 * item.monthlyCents - yearly)} sobre 12 mensalidades
                      </p>
                    </>
                  );
                return (
                  <>
                    {price(item.monthlyCents)}
                    {item.tier === "free" ? <p>Sem vencimento</p> : <p>por mês</p>}
                  </>
                );
              },
            },
            {
              key: "companies",
              header: "Empresas",
              cell: (item) => integer.format(item.capacity.companies),
            },
            { key: "limits", header: "O que inclui", cell: (item) => <OfferLimits offer={item} /> },
            {
              key: "action",
              header: "Contratação",
              cell: (item) => {
                const free = item.tier === "free";
                // The paid tiers here are Pix requests; with Pix off, the card sells them below.
                // Only managers see Cobrança; the others already read who can contract above.
                if (!free && !data.pixEnabled)
                  return canManage ? (
                    <p className="gestao-help">Assine pelo cartão em Cobrança.</p>
                  ) : null;
                const yearly = !free && annualView;
                const unavailable =
                  blocked ||
                  (free && !data.availability.canClaimFree) ||
                  (yearly
                    ? item.annualCents === undefined || annualClosed
                    : !free && data.monthlyStart[item.tier as PaidTier].start === null);
                const hint = free || yearly ? "" : monthlyHint(item.tier as PaidTier);
                return (
                  <>
                    <Button
                      variant={free ? "primary" : "secondary"}
                      disabled={unavailable}
                      onClick={() => {
                        setMessage("");
                        setChosenCycle(yearly ? "annual" : "monthly");
                        setSelection(item.tier);
                      }}
                    >
                      {free
                        ? "Ativar gratuito"
                        : yearly
                          ? `Solicitar ${item.name} anual`
                          : `Solicitar ${item.name}`}
                    </Button>
                    {free && !data.availability.canClaimFree ? (
                      <p className="gestao-help">
                        {activeTier === "free"
                          ? "O plano gratuito já está ativo."
                          : "Gratuito indisponível para esta organização. Consulte o plano atual ou o atendimento."}
                      </p>
                    ) : pending ? (
                      <p className="gestao-help">Aguarde ou cancele o pedido pendente.</p>
                    ) : yearly && annualHint ? (
                      <p className="gestao-help">{annualHint}</p>
                    ) : hint && canManage ? (
                      <p className="gestao-help">{hint}</p>
                    ) : null}
                  </>
                );
              },
            },
          ]}
        />
      </Card>
      <Card
        title="Personalizado"
        description="Precisa de outras cotas ou de mais empresas? Solicite um orçamento pelo canal de atendimento."
      >
        <p>
          Informe a quantidade de empresas e o volume mensal esperado para receber uma proposta.
        </p>
        <p>
          Consultoria opcional por {formatBRL("180")}/hora, contratada à parte. Você pode configurar
          a organização por conta própria.
        </p>
      </Card>
      <ConfirmDialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        title={
          selection === "cancel"
            ? "Cancelar pedido de plano?"
            : selection === "free"
              ? "Ativar plano gratuito?"
              : selection === "upgrade"
                ? `Mudar para ${tierNames[upgradable?.upgrade?.tier ?? "large"]} anual?`
                : annualChosen
                  ? `Solicitar ${offer?.name ?? "plano"} anual?`
                  : `Solicitar ${offer?.name ?? "plano"}?`
        }
        description={
          selection === "cancel"
            ? "O pedido será cancelado. O plano atual será mantido."
            : selection === "free"
              ? "R$ 0,00, sem vencimento, para 1 empresa. As cotas de uso renovam mensalmente, em UTC."
              : selection === "upgrade"
                ? upgradable?.upgrade
                  ? `${price(upgradable.upgrade.amountCents)} ${monthsLeft(upgradable.upgrade.months)} do plano anual, de ${formatUtcInstant(upgradable.upgrade.from)} a ${formatUtcInstant(upgradable.endsAt)}, com o mês corrente inteiro. ${
                      upgradable.renews
                        ? `A data de renovação continua ${formatUtcInstant(upgradable.endsAt)}, e a renovação passa a ser do ${tierNames[upgradable.upgrade.tier]} anual.`
                        : upgradable.source === "stripe"
                          ? `O plano anual continua terminando em ${formatUtcInstant(upgradable.endsAt)}, sem renovação.`
                          : `O plano anual continua terminando em ${formatUtcInstant(upgradable.endsAt)}.`
                    }`
                  : "Esta mudança não está mais disponível. Confira o plano anual atualizado."
                : annualChosen
                  ? offer?.annualCents !== undefined
                    ? `${price(offer.annualCents)} por 12 meses, pagos de uma vez. Economia de ${price(12 * offer.monthlyCents - offer.annualCents)} sobre 12 mensalidades.`
                    : "O plano anual não está mais à venda. Confira os planos atualizados."
                  : chosenMonthly?.start === "renewal" &&
                      chosenMonthly.startsAt !== null &&
                      chosenMonthly.endsAt !== null
                    ? `${price(selectedPrice)} pela renovação do plano em vigor: começa em ${formatUtcInstant(chosenMonthly.startsAt)}, quando ele termina, e vai até ${formatUtcInstant(chosenMonthly.endsAt)}. O plano atual continua até lá.`
                    : chosenMonthly?.start === "upgrade" && chosenMonthly.endsAt !== null
                      ? `${price(selectedPrice)}, a diferença integral para o novo plano, sem desconto proporcional. Ele vale da confirmação do pagamento até ${formatUtcInstant(chosenMonthly.endsAt)}, o fim do plano em vigor, que não muda.`
                      : chosenMonthly?.start === "now"
                        ? `${price(selectedPrice)} por um mês, da confirmação do pagamento pela equipe ao mesmo dia e horário do mês seguinte, em UTC. O pedido vale por 7 dias.`
                        : offer && offer.tier !== "free"
                          ? monthlyHint(offer.tier)
                          : ""
        }
        confirmLabel={
          selection === "cancel"
            ? "Confirmar cancelamento"
            : selection === "free"
              ? "Confirmar ativação"
              : selection === "upgrade" && upgradable?.source === "stripe"
                ? "Ir para o Stripe"
                : "Registrar pedido"
        }
        busyLabel={
          selection === "cancel"
            ? "Cancelando…"
            : selection === "free"
              ? "Ativando…"
              : selection === "upgrade" && upgradable?.source === "stripe"
                ? "Aguarde…"
                : "Registrando…"
        }
        tone={selection === "cancel" ? "danger" : "primary"}
        onConfirm={confirm}
        confirmDisabled={
          !canManage ||
          (selection === "cancel" && (!pending || data.request?.id !== cancellingId)) ||
          (selection === "upgrade" &&
            (pending ||
              !upgradable?.upgrade ||
              (upgradable.source === "stripe" && cardUpgradeClosed))) ||
          (selection !== "cancel" &&
            selection !== "upgrade" &&
            (pending ||
              !offer ||
              (selection === "free" && !data.availability.canClaimFree) ||
              (annualChosen && (offer.annualCents === undefined || !startAllowed)) ||
              (!annualChosen && selection !== "free" && chosenMonthly?.start === null)))
        }
      >
        {selection === "upgrade" ? (
          <p>
            {upgradable?.source === "stripe"
              ? "Você será levado ao Stripe. O plano muda quando o Stripe confirmar o pagamento."
              : `O pagamento por Pix é assistido. Aguarde as instruções pelo canal de atendimento. O plano muda quando a equipe confirmar o pagamento, até ${upgradable?.upgrade ? formatUtcInstant(upgradable.upgrade.until) : "o fim do mês corrente do plano anual"}.`}
          </p>
        ) : selection !== "cancel" && selection !== "free" && annualChosen ? (
          <>
            <p>
              {annualStart.start === "renewal" &&
              annualStart.startsAt !== null &&
              annualStart.endsAt !== null
                ? `Renovação do plano em vigor: começa em ${formatUtcInstant(annualStart.startsAt)}, quando ele termina, e vai até ${formatUtcInstant(annualStart.endsAt)}. O plano atual continua até lá.`
                : annualStart.start === "now"
                  ? "Começa na confirmação do pagamento pela equipe e termina 12 meses depois, no mesmo dia e horário, em UTC. O pedido vale por 7 dias."
                  : annualHint}
            </p>
            <p>
              O pagamento por Pix é assistido. Aguarde as instruções pelo canal de atendimento. O
              plano anual só começa após a confirmação do pagamento. No cartão, o anual começa
              sempre no dia 1 do mês seguinte e é contratado em Cobrança.
            </p>
          </>
        ) : selection !== "cancel" && selection !== "free" ? (
          <p>
            O pagamento por Pix é assistido. Aguarde as instruções pelo canal de atendimento. O
            plano atual continua até a confirmação do pagamento. Pelo Pix, o plano renova por um
            novo pedido, feito antes do fim dele.
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
const termTitles: Record<Term["state"], string> = {
  active: "Plano anual em vigor",
  scheduled: "Plano anual agendado",
  rescinded: "Plano anual rescindido",
};
/**
 * One annual term (ADR 0010, decision 9): tier and upgrades, payment method, start, end and
 * renewal. Ending it with a refund ("Rescindir") goes through support; there is no button.
 */
function AnnualTerm({
  term,
  actions,
  annualEnabled,
  pixEnabled,
}: {
  term: Term;
  actions: ReactNode;
  annualEnabled: boolean;
  /** A Pix term renews by a new Pix request, offered only while Pix is on sale. */
  pixEnabled: boolean;
}) {
  const rescinded = term.state === "rescinded";
  return (
    <Card
      title={termTitles[term.state]}
      actions={
        term.state === "active" ? (
          <StatusBadge tone="success">Em vigor</StatusBadge>
        ) : term.state === "scheduled" ? (
          <StatusBadge tone={term.blocked ? "warning" : "info"}>
            {term.blocked ? "Início pendente" : "Agendado"}
          </StatusBadge>
        ) : (
          <StatusBadge>Rescindido</StatusBadge>
        )
      }
    >
      <DescriptionList
        items={[
          { term: "Plano", value: `${tierNames[term.tier]} anual` },
          ...(term.segments.length
            ? [
                {
                  term: "Mudança de plano",
                  value: term.segments
                    .map(
                      (segment) =>
                        `${tierNames[segment.tier]} anual a partir de ${formatUtcInstant(segment.fromPeriod)}`,
                    )
                    .join("; "),
                },
              ]
            : []),
          {
            term: "Forma de pagamento",
            value: term.source === "pix" ? "Pix assistido" : "Cartão, pelo Stripe",
          },
          { term: "Início", value: formatUtcInstant(term.firstPeriod) },
          rescinded
            ? {
                term: "Acesso até",
                value: formatUtcInstant(term.accessEndsAt ?? term.endsAt),
              }
            : {
                term: term.renews ? "Fim e renovação" : "Fim",
                value: formatUtcInstant(term.endsAt),
              },
        ]}
      />
      {term.state === "scheduled" ? (
        term.blocked ? (
          <Callout tone="warning">
            O pagamento foi recebido, e o início do plano aguarda a equipe da Freecorps. Nada é
            cobrado de novo.
          </Callout>
        ) : (
          <p>O plano atual continua até o início do plano anual.</p>
        )
      ) : null}
      {rescinded ? (
        <p>
          Rescindido pelo suporte. Se houver reembolso, a equipe o devolve pela mesma forma de
          pagamento.
        </p>
      ) : (
        <>
          <p>
            {term.renews
              ? `No cartão, os próximos 12 meses, pelo ${tierNames[lastTier(term)]} anual, são cobrados nessa data. “Cancelar renovação”, em Cobrança, mantém os meses pagos, sem reembolso.`
              : term.source === "stripe"
                ? "No cartão, este plano anual não renova: termina nessa data, e os meses pagos continuam até lá."
                : annualEnabled && pixEnabled
                  ? `No Pix, a renovação é um novo pedido anual, feito no último mês, a partir de ${formatUtcInstant(term.renewalFrom)}, e começa no fim deste plano. Sem ele, o plano termina nessa data, e os meses pagos continuam até lá.`
                  : "No Pix, o plano termina nessa data, sem renovação automática, e os meses pagos continuam até lá."}
          </p>
          <p className="gestao-help">
            Rescindir, com reembolso, é pelo suporte da Freecorps: até 7 dias da cobrança, o
            reembolso é integral; depois, é o total pago menos os meses usados, pelo preço mensal
            cheio.
          </p>
        </>
      )}
      {actions ? <div>{actions}</div> : null}
    </Card>
  );
}
function OfferLimits({ offer }: { offer: Offer }) {
  const { limits, capacity } = offer;
  return (
    <details className="gestao-details gestao-details--plain">
      <summary>
        Ver cotas e capacidade <Icon name="chevronDown" />
      </summary>
      <DescriptionList
        items={[
          // The free tier limits Production by new notes; imports and captures are its sandbox quota.
          ...(limits.notes !== undefined
            ? [
                {
                  term: "Notas novas em Produção por mês",
                  value: `${integer.format(limits.notes)}, somando importação e captura`,
                },
                { term: "Importações por mês no Sandbox", value: integer.format(limits.imports) },
                {
                  term: "Consultas de captura por mês no Sandbox",
                  value: integer.format(limits.captures),
                },
              ]
            : [
                { term: "Importações por mês", value: integer.format(limits.imports) },
                { term: "Consultas de captura por mês", value: integer.format(limits.captures) },
              ]),
          { term: "Consultas de CNPJ por mês", value: integer.format(limits.registry) },
          { term: "Volume recebido por mês", value: formatBytes(limits.bytes) },
          { term: "Avisos por webhook por mês", value: integer.format(limits.deliveries) },
          { term: "Operações simultâneas", value: integer.format(offer.concurrency) },
          { term: "Arquivos armazenados", value: formatBytes(capacity.filesBytes) },
          { term: "Dados dos documentos armazenados", value: formatBytes(capacity.databaseBytes) },
          { term: "Membros", value: integer.format(capacity.members) },
          { term: "Projetos", value: integer.format(capacity.projects) },
          { term: "Downloads por mês", value: formatBytes(capacity.downloadsBytes) },
          { term: "Exportações por mês", value: integer.format(capacity.exportsCount) },
          { term: "Volume exportado por mês", value: formatBytes(capacity.exportsBytes) },
          { term: "Leituras pela API por mês", value: integer.format(capacity.restReads) },
        ]}
      />
    </details>
  );
}
