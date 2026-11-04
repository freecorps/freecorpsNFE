import { useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "./convex-query";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { usageArgs, usageAsOf } from "./page-queries";
import { formatUtcInstant } from "./format";
import { environmentNames, type ProductEnvironment } from "./deployment";
import { useProductEnvironment } from "./product-environment";
import { FormField, Select } from "./ui/form";
import { Icon } from "./ui/icons";
import { counted, formatBytes, usedPercent } from "./usage-format";
import { planEnded, planLimit } from "../../../platform/convex/lib/usageValues";
import { Plans } from "./plans";
import { PlanBilling } from "./plans-billing";
import {
  Callout,
  Card,
  DescriptionList,
  Page,
  PageHeader,
  SkeletonBlock,
  StatusBadge,
} from "./ui/layout";

/** Título, explicação em linguagem de usuário e o critério técnico de contagem, em detalhe. */
const descriptions: Record<string, [string, string, string]> = {
  imports: [
    "Arquivos importados",
    "Cada arquivo XML ou lote enviado e aceito conta uma vez.",
    "Um arquivo confirmado. Retry da mesma intenção não conta novamente.",
  ],
  documents: [
    "Documentos únicos",
    "Notas diferentes que entraram na plataforma. Reenviar a mesma nota não soma.",
    "Identidades documentais publicadas pela primeira vez na medição. Duplicatas não somam.",
  ],
  captures: [
    "Capturas admitidas",
    "Cada busca automática de notas no fisco conta uma vez, mesmo se precisar ser conferida de novo.",
    "Uma consulta lógica de distribuição. Reconciliação da mesma intenção não cria outra unidade.",
  ],
  registry: [
    "Consultas de CNPJ",
    "Cada consulta de CNPJ feita a uma fonte externa conta, inclusive quando a resposta não chegou com certeza. Consultas já guardadas não somam.",
    "Despachos à fonte, incluindo resultado incerto. Respostas de cache não somam.",
  ],
  bytes: [
    "Volume recebido",
    "Tamanho dos arquivos enviados neste período, não o total guardado desde o início.",
    "Bytes dos originais e lotes brutos aceitos no período. Não representa todo o estoque histórico.",
  ],
  deliveries: [
    "Avisos por webhook",
    "Cada aviso enviado ao seu sistema conta uma vez por destino. Novas tentativas do mesmo aviso não somam.",
    "Um evento por destino. Retentativas e reenvios da mesma entrega não somam.",
  ],
  attempts: [
    "Tentativas técnicas",
    "Quantas vezes a plataforma executou ou repetiu trabalho em segundo plano. Serve para acompanhar a operação e não tem cota.",
    "Execuções, retomadas e tentativas de webhook. Medição operacional, sem cota comercial.",
  ],
  issuances: [
    "NFS-e emitidas",
    "Cada NFS-e autorizada conta uma vez, inclusive no simulador do sandbox. Recusas, novas tentativas e cancelamentos não somam. Sem cota.",
    "Uma unidade por NFS-e autorizada. Rejeições, retentativas e cancelamentos não somam. Medição sem cota.",
  ],
};
/**
 * Em Produção, um plano com cota de notas (o Gratuito, ADR 0010) conta os documentos únicos como
 * notas novas e limita por elas as importações e as consultas de captura.
 */
const notesDescription: [string, string, string] = [
  "Notas novas",
  "Cada nota que entrou em Produção neste mês, por importação ou captura, conta uma vez por empresa. Resumo, XML completo e eventos da mesma nota contam uma vez só. Ao chegar ao limite, novas importações e consultas de captura são recusadas; o que já foi aceito entra inteiro.",
  "Uma nota nova por empresa, publicada pela primeira vez na medição: a NF-e pela chave de acesso, a NFS-e pelo número. Reprocessamento, resumo, XML completo e eventos da mesma nota não somam; a mesma nota em outra empresa soma. Os reservados são arquivos de importação aguardando processamento: cada um ocupa uma nota até ser processado ou expirar.",
];
const integer = new Intl.NumberFormat("pt-BR");
const date = (time: number) => new Date(time).toLocaleString("pt-BR");
type Overview = FunctionReturnType<typeof api.usage.overview>;
type Row = Overview["rows"][number];
type Period = Overview["period"];
/**
 * A quota period as the server named it (ADR 0012): civil month or the plan's anniversaries. The
 * end is the instant the next period starts, so it reads as the renewal, never as a last day.
 */
const periodLabel = (period: Period) =>
  period.endsAt === null
    ? `Desde ${formatUtcInstant(period.startsAt)}`
    : `Desde ${formatUtcInstant(period.startsAt)}, renova em ${formatUtcInstant(period.endsAt)}`;
/**
 * Where `asOf` moves so the current period follows the plan: the latest instant between `asOf`
 * and `now` that changes it, the current period's end or the plan's anchor or start (a plan
 * assigned after `asOf`). Null when none passed.
 */
function followAsOf(data: Overview, asOf: number, now: number) {
  const marks = [data.current?.endsAt, data.plan?.periodAnchor, data.plan?.startsAt].filter(
    (mark): mark is number => typeof mark === "number" && mark > asOf && mark <= now,
  );
  return marks.length ? Math.max(...marks) : null;
}
/** Whether the plan limits Production by new notes instead of imports and captures. */
const byNotes = (plan: Overview["plan"], environment: ProductEnvironment) =>
  environment === "production" && plan?.limits.notes !== undefined;
/** The plan's limit of the metric in the environment's balance; null without a quota. */
const limitOf = (plan: Overview["plan"], metric: Row["metric"], environment: ProductEnvironment) =>
  metric === "documents"
    ? byNotes(plan, environment)
      ? plan!.limits.notes!
      : null
    : planLimit(plan, metric, environment);
const reached = (plan: Overview["plan"], environment: ProductEnvironment, rows: Row[]) =>
  rows.some((row) => {
    const limit = limitOf(plan, row.metric, environment);
    return limit !== null && row.committed + row.reserved >= limit;
  });
const environments: ProductEnvironment[] = ["sandbox", "production"];
export function Usage({ org, contextKey }: { org: Organization; contextKey: string }) {
  const [clock, setClock] = useState(Date.now);
  const [asOf, setAsOf] = useState(() => usageAsOf());
  /** A past period chosen in the list, by its key; null follows the current one. */
  const [chosen, setChosen] = useState<string | null>(null);
  const { environment } = useProductEnvironment();
  // Only advances presentation of calendar/vigency. Usage itself comes from a subscription.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const data = useQuery(
    api.usage.overview,
    usageArgs({ org, contextKey }, asOf, chosen ?? undefined),
  );
  // The current period ended, or a plan started or was anchored after `asOf`: ask at that instant.
  const follow = data ? followAsOf(data, asOf, Math.max(clock, Date.now())) : null;
  useEffect(() => {
    if (follow !== null) setAsOf(follow);
  }, [follow]);
  const header = (
    <PageHeader
      eyebrow="Consumo da organização"
      title="Uso e limites"
      description="Acompanhe o que foi aceito e o que está reservado para operações em andamento, em cada ambiente."
      actions={
        <div className="gestao-period">
          <FormField id="usage-period" label="Período de consumo, em UTC">
            <Select
              id="usage-period"
              disabled={!data}
              value={data?.period.key ?? ""}
              onChange={(event) => {
                const key = event.target.value;
                // The period holding `asOf` follows the clock; any other stays as chosen.
                setChosen(key === data?.current?.key ? null : key);
              }}
            >
              {(data?.recent ?? []).map((period) => (
                <option key={period.key} value={period.key}>
                  {periodLabel(period)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      }
    />
  );
  if (!data)
    return (
      <Page>
        {header}
        <SkeletonBlock label="Carregando consumo e limites…" lines={4} />
      </Page>
    );
  const plan = data.plan;
  // A subscription update can activate a plan between the periodic clock ticks.
  const currentTime = Math.max(clock, Date.now());
  const inactive = plan && (currentTime < plan.startsAt || planEnded(plan, currentTime));
  const updated = Math.max(0, ...data.rows.map((row) => row.updatedAt ?? 0));
  const aggregation = {
    term: "Última agregação",
    value: updated ? (
      <>
        {date(updated)}
        <span className="gestao-dl-note">
          Totais atualizados pelas operações confirmadas no servidor.
        </span>
      </>
    ) : (
      "Ainda não há consumo registrado neste período."
    ),
  };
  // The environment chosen in the shell; a limit reached in the other one is still said here.
  const other = environments.find((value) => value !== environment)!;
  return (
    <Page>
      {header}
      {inactive ? (
        <Callout tone="danger" role="alert" title="Plano fora da vigência.">
          Novas operações estão bloqueadas. Documentos e exportações autorizadas continuam
          disponíveis.
        </Callout>
      ) : null}
      <Card
        title={plan?.name ?? "Medição sem plano definido"}
        description="Confira a vigência e os limites do plano atual da organização."
        actions={
          <StatusBadge tone={!plan ? "neutral" : inactive ? "danger" : "success"}>
            {!plan ? "Em medição" : inactive ? "Fora da vigência" : "Plano vigente"}
          </StatusBadge>
        }
      >
        <DescriptionList
          items={
            plan
              ? [
                  {
                    term: "Vigência",
                    value:
                      plan.endsAt === null
                        ? `Sem vencimento, a partir de ${date(plan.startsAt)}. As cotas renovam a cada mês, em UTC.`
                        : `${date(plan.startsAt)} até ${date(plan.endsAt)}`,
                  },
                  { term: "Concorrência", value: integer.format(plan.concurrency) },
                  aggregation,
                ]
              : [
                  {
                    term: "Cotas",
                    value: `Esta organização está em medição, sem cotas comerciais configuradas. ${captureNeedsPlan}`,
                  },
                  aggregation,
                ]
          }
        />
      </Card>
      <Plans org={org} contextKey={contextKey} />
      <PlanBilling org={org} contextKey={contextKey} />
      {data.unattributed ? (
        <Callout tone="info" role="status" title="Consumo anterior em atribuição.">
          Parte do consumo deste período foi registrada antes da separação por ambiente. Até a
          atribuição terminar, essa parte aparece e conta nos dois ambientes.
        </Callout>
      ) : null}
      <section className="ui-section" aria-labelledby="usage-units">
        <div className="ui-section__header">
          <h2 id="usage-units" className="ui-section__title">
            Unidades medidas
          </h2>
          <p className="ui-section__description">Consumo confirmado e reservado no período.</p>
        </div>
        {reached(plan, other, data.environments[other]) ? (
          <Callout tone="warning" role="status">
            Limite atingido em {environmentNames[other]}. Troque o ambiente na lateral para ver o
            consumo de lá.
          </Callout>
        ) : null}
        <Metrics environment={environment} plan={plan} rows={data.environments[environment]} />
      </section>
      <Callout tone="info">
        Os valores são unidades de uso, não uma fatura. A medição começa com esta funcionalidade e
        não reconstitui operações anteriores. Reservas pertencem ao período em que foram aceitas,
        mesmo quando a conclusão ocorre no mês seguinte.
      </Callout>
    </Page>
  );
}
/** The usage of the environment chosen in the shell. */
function Metrics({
  environment,
  plan,
  rows,
}: {
  environment: ProductEnvironment;
  plan: Overview["plan"];
  rows: Row[];
}) {
  return (
    <>
      <p className="gestao-panel-lead">
        {byNotes(plan, environment) ? notesLead : lead[environment][plan ? "plan" : "metering"]}
      </p>
      <div className="gestao-metrics">
        {rows.map((row) => (
          <Metric key={row.metric} environment={environment} plan={plan} row={row} />
        ))}
      </div>
    </>
  );
}
/**
 * A production capture queries the Receita only under a plan with finite `captures` and `bytes`
 * quotas, the free tier included (#429): "sem cota" there never means a capture without limit.
 */
const captureNeedsPlan =
  "Novas consultas de captura de NF-e em Produção exigem um plano atribuído com cotas de consultas e de bytes.";
const captureQuota = (environment: ProductEnvironment, metric: Row["metric"]) =>
  environment === "production" && (metric === "captures" || metric === "bytes");
const notesLead =
  "Saldo próprio de Produção. Neste plano, importações e consultas de captura em Produção contam pelas notas novas do mês, não por arquivos ou consultas. O consumo do Sandbox não entra nesta conta.";
/** Whose balance the panel shows, before the numbers (#429). */
const lead: Record<ProductEnvironment, { plan: string; metering: string }> = {
  sandbox: {
    plan: "Saldo próprio do Sandbox, com os mesmos limites do plano. O consumo de Produção não entra nesta conta.",
    metering: "Medição do Sandbox, sem cota. O consumo de Produção é medido à parte.",
  },
  production: {
    plan: "Saldo próprio de Produção, com os mesmos limites do plano. O consumo do Sandbox não entra nesta conta.",
    metering: `Medição de Produção. ${captureNeedsPlan} O consumo do Sandbox é medido à parte.`,
  },
};
function Metric({
  environment,
  plan,
  row,
}: {
  environment: ProductEnvironment;
  plan: Overview["plan"];
  row: Row;
}) {
  const limit = limitOf(plan, row.metric, environment);
  // Imports and captures of a plan limited by notes count toward the notes, not a quota of their own.
  const inNotes =
    byNotes(plan, environment) && (row.metric === "imports" || row.metric === "captures");
  // The number, the bar and the quota count the same thing: confirmed plus reserved.
  const used = row.committed + row.reserved;
  const full = limit !== null && used >= limit;
  const share = limit === null ? 0 : usedPercent(used, limit);
  const bytes = row.metric === "bytes";
  const amount = (value: number) => (bytes ? formatBytes(value) : integer.format(value));
  const [title, plain, technical] =
    row.metric === "documents" && byNotes(plan, environment)
      ? notesDescription
      : descriptions[row.metric]!;
  const id = `usage-${environment}-${row.metric}`;
  const split = bytes
    ? `${formatBytes(row.committed)} confirmados e ${formatBytes(row.reserved)} reservados`
    : `${counted(row.committed, "confirmado", "confirmados")} e ${counted(row.reserved, "reservado", "reservados")}`;
  return (
    <article className="gestao-metric" aria-labelledby={id}>
      <h3 id={id} className="gestao-metric__label">
        {title}
      </h3>
      <p className="gestao-metric__value">
        {amount(used)}
        <span>
          {limit !== null ? `de ${amount(limit)}` : inNotes ? "na cota de notas" : "sem cota"}
        </span>
      </p>
      {limit !== null ? (
        <div
          className="gestao-meter"
          data-state={full ? "full" : share >= 80 ? "warning" : undefined}
        >
          <span className="gestao-meter__track" aria-hidden="true">
            {share > 0 ? (
              <span className="gestao-meter__fill" style={{ width: `${share}%` }} />
            ) : null}
          </span>
          <span>{share}% usado</span>
        </div>
      ) : null}
      <p className="gestao-meta">{row.reserved ? split : "Nada reservado"}</p>
      {inNotes ? (
        <p className="gestao-meta">
          Em Produção, este plano limita as notas novas, não{" "}
          {row.metric === "imports" ? "os arquivos importados" : "as consultas"}.
        </p>
      ) : null}
      {limit === null && !inNotes && captureQuota(environment, row.metric) ? (
        <p className="gestao-meta">
          Sem esta cota no plano, novas consultas de captura de NF-e em Produção ficam paradas.
        </p>
      ) : null}
      {full ? (
        <Callout tone="warning" role="status">
          Limite atingido em {environmentNames[environment]}. Novas operações deste ambiente que
          consomem esta unidade aguardam disponibilidade ou revisão do plano. O outro ambiente segue
          com o próprio saldo.
        </Callout>
      ) : null}
      <p className="gestao-help">{plain}</p>
      <details className="gestao-details gestao-details--plain">
        <summary>
          Critério técnico
          <Icon name="chevronDown" />
        </summary>
        <p className="gestao-help">
          {technical} Unidade <code>{row.metric}</code>.
          {bytes ? ` ${exactBytes(row, limit)}` : null}
        </p>
      </details>
    </article>
  );
}
/** The bytes as stored, for whoever needs the number behind "9,6 KiB". */
function exactBytes(row: Row, limit: number | null) {
  const committed = counted(row.committed, "byte confirmado", "bytes confirmados");
  const reserved = counted(row.reserved, "reservado", "reservados");
  const of = limit === null ? "" : `, de um limite de ${counted(limit, "byte", "bytes")}`;
  return `Valor exato: ${committed} e ${reserved}${of}.`;
}
