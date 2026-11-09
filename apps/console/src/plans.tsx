import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { useMinute, useSettled } from "./product-components";
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

type Cycle = "monthly" | "annual";
const plansApi = api.plans;
export type PlansOverview = FunctionReturnType<typeof plansApi.overview>;
type Offer = PlansOverview["offers"][number];
type Term = PlansOverview["terms"][number];
const integer = new Intl.NumberFormat("pt-BR");
export const tierNames: Record<string, string> = {
  free: "Gratuito",
  intermediate: "Intermediário",
  large: "Grande",
  custom: "Personalizado",
};
/** Convert integer cents without calculating currency with floating point. */
export function price(cents: number) {
  const digits = String(cents).padStart(3, "0");
  return formatBRL(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
}
/** An instant in UTC, never in the browser's time zone. */
export const utcDateTime = (ms: number) =>
  `${new Date(ms).toLocaleString("pt-BR", { timeZone: "UTC" })} UTC`;
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
    "Esta organização tem um plano anual em vigor ou agendado que coincide com esta contratação.",
  ANNUAL_TERM_REQUIRED:
    "Não há plano anual em vigor agora para mudar de plano. Confira a situação atual.",
  ANNUAL_TERM_SCHEDULED:
    "Há um plano anual agendado, ainda não começado ou já pago como renovação. A mudança para o Grande abre depois que ele começar.",
  ANNUAL_TERM_RESCINDED:
    "O plano anual desta assinatura foi rescindido pelo suporte. A renovação não pode ser retomada.",
  SUBSCRIPTION_RENEWING:
    "O cartão ainda renova a assinatura atual. Use “Cancelar renovação” antes de assinar o anual no cartão; ele é cobrado e começa no pagamento, e substitui o período já pago sem desconto.",
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
  PLAN_REQUEST_UNAVAILABLE:
    "Esta contratação mudou ou não está mais disponível. Confira a situação atual.",
  ORGANIZATION_CLOSED: "Esta organização foi encerrada. Não é possível contratar um plano.",
  ORGANIZATION_ARCHIVED:
    "Organização em arquivo econômico. Consulte a Freecorps sobre a recuperação dos dados.",
  CAPACITY_INVENTORY_REQUIRED:
    "O inventário de capacidade está pendente. Solicite a conferência à Freecorps.",
  QUOTA_EXCEEDED: "O uso atual não cabe neste plano. Nada foi alterado.",
  // The upgrade of an annual term opens a Stripe Checkout from here.
  BILLING_DISABLED: "O pagamento por cartão está indisponível no momento.",
  BILLING_UNAVAILABLE:
    "O Stripe não respondeu. Nada foi cobrado por esta tentativa; tente novamente em instantes.",
  CHECKOUT_PENDING: "Já existe um pagamento por cartão em andamento.",
  SUBSCRIPTION_REQUIRED:
    "A assinatura anual por cartão deste plano não está mais ativa. Confira a cobrança.",
  PERIOD_CLOSING:
    "Pelo cartão, a mudança fecha 45 minutos antes do fim de cada mês do plano anual e nas últimas 72 horas do plano anual.",
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
  // The server's query never reads the clock (#45): the page passes the minute.
  const asOf = useMinute();
  const data = useSettled(
    useQuery(plansApi.overview, { organizationId: org.id, contextKey, asOf }),
    org.id,
  );
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
  const checkout = useAction(api.billing.checkout);
  const action = useAsyncAction(failure);
  const [selection, setSelection] = useState<"free" | "upgrade" | null>(null);
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [message, setMessage] = useState("");
  // Keep the same intention after an uncertain response, including closing and reopening.
  const keys = useRef<Record<string, string>>({});
  // An abandoned or finished card Checkout cannot be reopened by its key: the next upgrade is a
  // new intention.
  const hadCheckout = useRef(data.checkout);
  useEffect(() => {
    if (hadCheckout.current && !data.checkout) keys.current = {};
    hadCheckout.current = data.checkout;
  }, [data.checkout]);
  const canManage = org.role === "owner" || org.role === "admin";
  const activeTier = data.subscription?.tier;
  const archived = data.archive && !["notice", "hot"].includes(data.archive.state);
  const blocked = !canManage || action.busy || !!archived;
  // The annual is shown only while the server sells it; switched off, the monthly comes back.
  const annualView = data.annualEnabled && cycle === "annual";
  const upgradable = data.terms.find((term) => term.upgrade);
  const upgradeClosed = !!upgradable?.upgrade && Date.now() >= upgradable.upgrade.closesAt;
  async function confirm() {
    if (!canManage) return failure(new ConvexError({ code: "ACCESS_DENIED" }));
    setMessage("");
    if (selection === "free" && data.availability.canClaimFree) {
      return action.run(() => claimFree({ organizationId: org.id }), {
        quiet: true,
        done: () => setMessage("Plano gratuito ativado. Consulte os limites no plano atual."),
      });
    }
    if (selection === "upgrade" && upgradable?.upgrade) {
      const month = new Date().toISOString().slice(0, 7);
      const tier = upgradable.upgrade.tier;
      const key = (keys.current[`upgrade:${upgradable.id}:${tier}:${month}`] ??=
        crypto.randomUUID());
      return action.run(
        () => checkout({ organizationId: org.id, tier, key, cycle: "annual", start: "upgrade" }),
        { quiet: true, done: ({ url }) => window.location.assign(url) },
      );
    }
    return "A disponibilidade mudou. Feche esta confirmação e confira os planos atualizados.";
  }
  const annualPrice = (item: Offer) => (annualView ? item.annualCents : undefined);
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
      {data.terms.map((term) => (
        <AnnualTerm
          key={term.id}
          term={term}
          actions={
            canManage && term.upgrade ? (
              <>
                <Button
                  disabled={blocked || upgradeClosed}
                  onClick={() => {
                    setMessage("");
                    setSelection("upgrade");
                  }}
                >
                  Mudar para {tierNames[term.upgrade.tier]} anual
                </Button>
                <p className="gestao-help">
                  {upgradeClosed
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
                Apenas o proprietário e administradores podem contratar planos. Você pode consultar
                os planos e limites.
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
                // The paid tiers are sold by card, in Cobrança. Only managers see Cobrança; the
                // others already read who can contract above.
                if (item.tier !== "free")
                  return canManage ? (
                    <p className="gestao-help">Assine pelo cartão em Cobrança.</p>
                  ) : null;
                return (
                  <>
                    <Button
                      variant="primary"
                      disabled={blocked || !data.availability.canClaimFree}
                      onClick={() => {
                        setMessage("");
                        setSelection("free");
                      }}
                    >
                      Ativar gratuito
                    </Button>
                    {!data.availability.canClaimFree ? (
                      <p className="gestao-help">
                        {activeTier === "free"
                          ? "O plano gratuito já está ativo."
                          : "Gratuito indisponível para esta organização. Consulte o plano atual ou o atendimento."}
                      </p>
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
          selection === "free"
            ? "Ativar plano gratuito?"
            : `Mudar para ${tierNames[upgradable?.upgrade?.tier ?? "large"]} anual?`
        }
        description={
          selection === "free"
            ? "R$ 0,00, sem vencimento, para 1 empresa. As cotas de uso renovam mensalmente, em UTC."
            : upgradable?.upgrade
              ? `${price(upgradable.upgrade.amountCents)} ${monthsLeft(upgradable.upgrade.months)} do plano anual, de ${formatUtcInstant(upgradable.upgrade.from)} a ${formatUtcInstant(upgradable.endsAt)}, com o mês corrente inteiro. ${
                  upgradable.renews
                    ? `A data de renovação continua ${formatUtcInstant(upgradable.endsAt)}, e a renovação passa a ser do ${tierNames[upgradable.upgrade.tier]} anual.`
                    : `O plano anual continua terminando em ${formatUtcInstant(upgradable.endsAt)}, sem renovação.`
                }`
              : "Esta mudança não está mais disponível. Confira o plano anual atualizado."
        }
        confirmLabel={selection === "free" ? "Confirmar ativação" : "Ir para o Stripe"}
        busyLabel={selection === "free" ? "Ativando…" : "Aguarde…"}
        tone="primary"
        onConfirm={confirm}
        confirmDisabled={
          !canManage ||
          (selection === "free" && !data.availability.canClaimFree) ||
          (selection === "upgrade" && (!upgradable?.upgrade || upgradeClosed))
        }
      >
        {selection === "upgrade" ? (
          <p>Você será levado ao Stripe. O plano muda quando o Stripe confirmar o pagamento.</p>
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
 * One annual term (ADR 0010, decision 9), bought by card: tier and upgrades, payment method, start,
 * end and renewal. Ending it with a refund ("Rescindir") goes through support; there is no button.
 */
function AnnualTerm({ term, actions }: { term: Term; actions: ReactNode }) {
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
          { term: "Forma de pagamento", value: "Cartão, pelo Stripe" },
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
              : "No cartão, este plano anual não renova: termina nessa data, e os meses pagos continuam até lá."}
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
