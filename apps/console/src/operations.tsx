import { environmentNames, useDeployment } from "./deployment";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import { ConvexError } from "convex/values";
import { api } from "../../../platform/convex/_generated/api";
import type { Doc, Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { integrationRecordMessage } from "./company-context";
import { formatDateTime } from "./format";
import { actionLabel, actorLabel, codeLabel } from "./operation-labels";
import { More } from "./load-more";
import {
  AUDIT_PAGE_SIZE,
  auditArgs,
  defaultAuditFilters,
  operationsOverviewArgs,
} from "./page-queries";
import { Button } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { Checkbox, FormField, Input, Select } from "./ui/form";
import { Icon } from "./ui/icons";
import {
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  Page,
  PageHeader,
  SkeletonBlock,
  StatusBadge,
  type Tone,
} from "./ui/layout";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const labels = {
  queue: "Atraso da fila",
  lease: "Leases vencidas",
  cursor: "Idade do cursor",
  source: "Falhas na última hora",
  webhook: "Webhook pendente",
  certificate: "Validade do certificado",
};
const guidance = {
  queue: "Confira a operação e a próxima tentativa. Pause ou retome pelo controle autorizado.",
  lease:
    "Confira a recuperação da execução. Um resultado externo incerto exige reconciliação antes de nova tentativa.",
  cursor:
    "Confira a captura, o certificado e a próxima consulta permitida. Retomar preserva a janela da fonte.",
  source:
    "Confira o código de falha e a origem da operação. Indisponibilidade da fonte deve respeitar o backoff.",
  webhook:
    "Confira o destino e o histórico. Reenvie pela tela de webhooks preservando o evento original.",
  certificate:
    "Envie e valide o certificado substituto pela tela da empresa. Confira o estado ativo antes de retomar.",
};
/** `?ref=` da URL. O parser do roteador pode entregar número para uma referência só de dígitos. */
export function referenceFrom(search: unknown) {
  const ref = search && typeof search === "object" && "ref" in search ? search.ref : undefined;
  const value = typeof ref === "string" ? ref : typeof ref === "number" ? String(ref) : "";
  return value.trim().slice(0, 120);
}
const knownActions = [
  "operation.accepted",
  "operation.succeeded",
  "operation.retry_requested",
  "operation.PAUSED_BY_USER",
  "operation.TRANSPORT_UNCERTAIN",
  "operation.RECONCILIATION_REQUIRED",
  "export.requested",
  "export.revoked",
  "monitor.configured",
  "alert.open",
  "alert.recovered",
  "webhook.attempt",
  "member.joined",
  "key.created",
];
function field(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}
function failure(error: unknown) {
  const code =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data &&
    "code" in error.data
      ? error.data.code
      : "";
  return code === "OPERATION_CONFLICT"
    ? "Os dados mudaram. Reabra a configuração e tente novamente."
    : code === "NOT_FOUND" || code === "ACCESS_DENIED"
      ? "Acesso indisponível. Confira organização, empresa e projeto."
      : "Não foi possível concluir. Confira os dados e a ação permitida para o estado atual.";
}
function Copy({ text }: { text: string }) {
  return (
    <span className="gestao-reference">
      <code>{text}</code>
      <CopyButton value={text} label="Copiar referência" />
    </span>
  );
}
/** Referência que abre a investigação pela URL (`?ref=`), sem copiar e colar. */
function InvestigateLink({ org, reference }: { org: Organization; reference: string }) {
  return (
    <Link
      className="ui-link"
      to="/app/$organizationSlug/operations"
      params={{ organizationSlug: org.slug }}
      search={{ ref: reference }}
    >
      Investigar esta referência
    </Link>
  );
}
type Names = {
  actor: (actor: string) => string;
  company: (id: string) => string | undefined;
  project: (id: string) => string | undefined;
};
/**
 * Nomes legíveis resolvidos pelo servidor, que só responde por referências da organização
 * atual. Enquanto carrega, ou para referências fora dela, a tela usa rótulos genéricos.
 */
function useNames(
  org: Organization,
  contextKey: string,
  refs: { actors?: string[]; companyIds?: string[]; projectIds?: string[] },
): Names {
  const unique = (list: string[] = []) => [...new Set(list)].slice(0, 100).sort();
  const actors = unique(refs.actors),
    companyIds = unique(refs.companyIds),
    projectIds = unique(refs.projectIds);
  const result = useQuery(
    api.observability.names,
    actors.length || companyIds.length || projectIds.length
      ? { organizationId: org.id, contextKey, actors, companyIds, projectIds }
      : "skip",
  );
  const lookup = (list: { ref: string; name: string }[] | undefined) =>
    new Map((list ?? []).map((n) => [n.ref, n.name]));
  const actorNames = lookup(result?.actors),
    companies = lookup(result?.companies),
    projects = lookup(result?.projects);
  return {
    actor: (actor) => actorLabel(actor, actorNames.get(actor)),
    company: (id) => companies.get(id),
    project: (id) => projects.get(id),
  };
}
type AuditRow = Doc<"operationalAudit">;
export type AuditGroup = { first: AuditRow; last: AuditRow; count: number };
/**
 * Junta registros idênticos seguidos da mesma operação ou alvo (mesma ação, ator, código e
 * status), como retentativas que repetem `operation.TRANSPORT_UNCERTAIN`, mesmo quando eventos
 * de outras operações aparecem no meio. Um registro diferente da mesma operação encerra o
 * grupo, para não esconder a sequência dela. O grupo fica na posição do primeiro registro.
 */
export function groupAuditRows(rows: AuditRow[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  const latest = new Map<string, AuditGroup>();
  const same = (a: AuditRow, b: AuditRow) =>
    a.action === b.action && a.actor === b.actor && a.code === b.code && a.status === b.status;
  for (const row of rows) {
    const subject = row.operationId ?? row.target;
    const previous = latest.get(subject);
    if (previous && same(previous.last, row)) {
      previous.last = row;
      previous.count += 1;
    } else {
      const group = { first: row, last: row, count: 1 };
      groups.push(group);
      latest.set(subject, group);
    }
  }
  return groups;
}
/**
 * Why the evaluation turned a monitor off by itself (#422): it no longer stops in silence. A
 * production monitor stops with the withdrawal of the company's fiscal capture; any other loss of
 * access (owner, project, grant) is revoked. Neither comes back by itself.
 */
function MonitorStopped({
  stopped,
}: {
  stopped: NonNullable<Doc<"operationalMonitors">["stopped"]>;
}) {
  const withdrawn = stopped.code === "CAPTURE_RELEASE_WITHDRAWN";
  return (
    <Callout tone="warning">
      <h4 className="gestao-callout-heading">
        {withdrawn ? "Monitor parado: captura fiscal retirada" : "Monitor parado: acesso revogado"}
      </h4>
      <p>
        {withdrawn
          ? `Parou em ${formatDateTime(stopped.at)}, quando a captura fiscal da empresa deixou de estar liberada. Os documentos já capturados continuam disponíveis. Para voltar a monitorar Produção, a captura fiscal precisa estar liberada de novo; depois, salve o monitor.`
          : `Parou em ${formatDateTime(stopped.at)}: o responsável, o projeto ou a concessão da empresa perdeu o acesso. Escolha um responsável com acesso e salve o monitor de novo.`}
      </p>
    </Callout>
  );
}
export function Operations({ org, contextKey }: { org: Organization; contextKey: string }) {
  const { environment } = useDeployment();
  const overview = useQuery(
    api.observability.overview,
    operationsOverviewArgs({ org, contextKey }),
  );
  const audit = useAudit(org, contextKey);
  const remove = useMutation(api.observability.remove);
  const [removeError, setRemoveError] = useState("");
  const reference = referenceFrom(useSearch({ strict: false }));
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Doc<"operationalMonitors"> | "new" | null>(null);
  const monitors = overview?.monitors ?? [];
  const names = useNames(org, contextKey, {
    actors: monitors.map((m) => m.ownerMembershipId),
    companyIds: monitors.map((m) => m.companyId),
    projectIds: monitors.map((m) => m.projectId),
  });
  function investigate(ref: string) {
    void navigate({
      to: "/app/$organizationSlug/operations",
      params: { organizationSlug: org.slug },
      search: ref ? { ref } : {},
    });
  }
  const header = (
    <PageHeader
      eyebrow={`Operação · ${environmentNames[environment]}`}
      title="Operação e suporte"
      description="Investigue uma ocorrência, acompanhe alertas e consulte a trilha de ações."
    />
  );
  if (overview === undefined)
    return (
      <Page>
        {header}
        <SkeletonBlock label="Carregando operação e suporte…" lines={4} />
      </Page>
    );
  const monitorName = (m: Doc<"operationalMonitors">) =>
    names.company(m.companyId) ?? "Empresa sem nome disponível";
  return (
    <Page>
      {header}
      <Card
        title="Investigar uma ocorrência"
        description="Cole a referência de uma solicitação, operação ou evento, ou abra pelo link de outra tela. Compartilhe apenas a referência com o suporte."
      >
        <form
          key={reference}
          className="gestao-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            investigate(field(new FormData(e.currentTarget), "reference").trim());
          }}
        >
          <FormField id="support-reference" label="Referência da solicitação, operação ou evento">
            <Input
              id="support-reference"
              name="reference"
              className="ui-mono"
              maxLength={120}
              required
              defaultValue={reference}
              placeholder="Cole a referência ou abra pelo link de outra tela"
            />
          </FormField>
          <div className="ui-actions">
            <Button type="submit" variant="primary" icon="search">
              Investigar
            </Button>
            {reference ? (
              <Button variant="ghost" onClick={() => investigate("")}>
                Limpar investigação
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
      {reference ? (
        <Investigation key={reference} org={org} contextKey={contextKey} reference={reference} />
      ) : null}
      <Card
        title="Monitoramento e alertas"
        description="Até 20 escopos por organização. Avaliação a cada minuto enquanto o monitor estiver ativo."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
            Configurar monitoramento
          </Button>
        }
      >
        <div className="gestao-stack">
          {removeError ? (
            <Callout tone="danger" role="alert">
              {removeError}
            </Callout>
          ) : null}
          {editing ? (
            <MonitorForm
              key={editing === "new" ? "new" : `${editing._id}:${editing.generation}`}
              org={org}
              contextKey={contextKey}
              existing={editing === "new" ? undefined : editing}
              defaults={overview.defaults}
              onClose={() => setEditing(null)}
            />
          ) : null}
          {!overview.monitors.length ? (
            <EmptyState
              icon="gauge"
              headingLevel={3}
              title="Nenhum monitor configurado."
              description="Escolha a empresa, o projeto e o responsável."
            />
          ) : null}
          {overview.monitors.map((m) => (
            <Card
              key={m._id}
              flat
              headingLevel={3}
              title={monitorName(m)}
              description={
                <>
                  Projeto: {names.project(m.projectId) ?? "projeto sem nome disponível"} ·
                  Responsável: {names.actor(m.ownerMembershipId)} · Última avaliação:{" "}
                  {m.checkedAt ? formatDateTime(m.checkedAt) : "aguardando"}
                </>
              }
              actions={
                <>
                  <StatusBadge tone={m.enabled ? "success" : "neutral"}>
                    {m.enabled ? "Monitor ativo" : "Monitor pausado"}
                  </StatusBadge>
                  <Button size="sm" onClick={() => setEditing(m)}>
                    Editar monitor
                  </Button>
                  {!m.enabled ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        setRemoveError("");
                        try {
                          await remove({
                            organizationId: org.id,
                            monitorId: m._id,
                            expectedGeneration: m.generation,
                          });
                        } catch (e) {
                          setRemoveError(failure(e));
                        }
                      }}
                    >
                      Remover monitor pausado
                    </Button>
                  ) : null}
                </>
              }
            >
              <div className="ui-stack">
                {!m.enabled && m.stopped ? <MonitorStopped stopped={m.stopped} /> : null}
                <dl className="gestao-stats">
                  {m.metrics.map((sample) => (
                    <div key={sample.kind}>
                      <dt>{labels[sample.kind]}</dt>
                      <dd>
                        {sample.value === null
                          ? "Sem medição"
                          : sample.kind === "lease" || sample.kind === "source"
                            ? `${sample.capped ? "≥ " : ""}${sample.value}`
                            : sample.kind === "certificate"
                              ? `${Math.ceil(sample.value / DAY)} dias`
                              : `${Math.floor(sample.value / 60_000)} min`}
                        {sample.sources ? (
                          <small>
                            {sample.sources
                              .map((s) => `${s.source}: ${s.capped ? "≥" : ""}${s.count}`)
                              .join(" · ")}
                          </small>
                        ) : null}
                        {sample.capped ? (
                          <small>Observação limitada; não comprova recuperação.</small>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
                {overview.alerts
                  .filter((a) => a.monitorId === m._id)
                  .map((a) => (
                    <Callout key={a._id} tone="warning">
                      <h4 className="gestao-callout-heading">
                        {labels[a.kind]} · {monitorName(m)}
                      </h4>
                      <p>
                        Aberto em {formatDateTime(a.openedAt)}. {guidance[a.kind]}
                      </p>
                      <div className="ui-actions">
                        <InvestigateLink org={org} reference={a.target} />
                        <Link
                          className="ui-link"
                          to="/app/$organizationSlug/companies/$companyId"
                          params={{ organizationSlug: org.slug, companyId: m.companyId }}
                        >
                          Abrir empresa, certificado e captura
                        </Link>
                        <Link
                          className="ui-link"
                          to="/app/$organizationSlug/developer/$developerSection/$projectId"
                          params={{
                            organizationSlug: org.slug,
                            developerSection: "webhooks",
                            projectId: m.projectId,
                          }}
                        >
                          Abrir projeto e webhooks
                        </Link>
                      </div>
                      <Copy text={a.target} />
                    </Callout>
                  ))}
                <details className="gestao-details gestao-details--plain">
                  <summary>
                    Referências para suporte
                    <Icon name="chevronDown" />
                  </summary>
                  <p className="gestao-meta">
                    Monitor <code>{m._id}</code> · Empresa <code>{m.companyId}</code> · Projeto{" "}
                    <code>{m.projectId}</code> · Responsável <code>{m.ownerMembershipId}</code>
                  </p>
                </details>
              </div>
            </Card>
          ))}
        </div>
      </Card>
      <Card title="Notificações no painel" flush>
        {overview.notifications.length ? (
          <ul className="gestao-list">
            {overview.notifications.map((n) => {
              const monitor = overview.monitors.find((m) => m._id === n.monitorId);
              const alert = overview.alerts.find((a) => a._id === n.alertId);
              return (
                <li key={n._id}>
                  <p className="gestao-row__title">
                    <StatusBadge tone={n.transition === "open" ? "warning" : "success"}>
                      {n.transition === "open" ? "Alerta aberto" : "Alerta recuperado"}
                    </StatusBadge>
                    {alert ? labels[alert.kind] : null}
                  </p>
                  <p className="gestao-meta">
                    <span className="gestao-time">{formatDateTime(n.createdAt)}</span> ·{" "}
                    {monitor ? monitorName(monitor) : "monitor removido"} · alerta{" "}
                    <code>{n.alertId}</code>
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon="inbox"
            headingLevel={3}
            title="Nenhuma notificação."
            description="A abertura e a recuperação dos alertas aparecem aqui."
          />
        )}
      </Card>
      <Audit org={org} contextKey={contextKey} audit={audit} />
    </Page>
  );
}
function Investigation({
  org,
  contextKey,
  reference,
}: {
  org: Organization;
  contextKey: string;
  reference: string;
}) {
  const rows = useQuery(api.observability.investigate, {
    organizationId: org.id,
    reference,
    contextKey,
  });
  const operationId = rows?.find((r) => r.operationId)?.operationId;
  const heading = useRef<HTMLHeadingElement>(null);
  // Aberta por link ou pela busca, a investigação recebe o foco para leitores de tela.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="ui-card" aria-labelledby="support-investigation">
      <div className="ui-card__header">
        <div>
          <h2
            id="support-investigation"
            className="ui-card__title gestao-heading-focus"
            ref={heading}
            tabIndex={-1}
          >
            Investigação da ocorrência
          </h2>
          <p className="ui-card__description">
            Compartilhe apenas esta referência com o suporte. Documentos fiscais não são anexados.
          </p>
        </div>
      </div>
      <div className="gestao-stack">
        <Copy text={reference} />
        {operationId ? (
          <OperationControl operationId={operationId} organizationId={org.id} />
        ) : null}
        {rows === undefined ? (
          <SkeletonBlock label="Buscando ocorrência…" />
        ) : !rows.length ? (
          <Callout tone="info" role="status">
            Nenhuma ocorrência encontrada nesta organização. Confira se a referência foi copiada
            inteira e se pertence à organização atual.
          </Callout>
        ) : (
          <AuditRows org={org} contextKey={contextKey} rows={rows} current={reference} />
        )}
      </div>
    </section>
  );
}
const operationStates: Record<string, [Tone, string]> = {
  queued: ["info", "Na fila"],
  running: ["info", "Em execução"],
  retry_wait: ["warning", "Aguardando nova tentativa"],
  reconciling: ["warning", "Em reconciliação"],
  paused: ["neutral", "Pausada"],
  succeeded: ["success", "Concluída"],
  failed: ["danger", "Falha definitiva"],
};
function OperationControl({
  operationId,
  organizationId,
}: {
  operationId: Id<"operations">;
  organizationId: Id<"organizations">;
}) {
  const op = useQuery(api.observability.operation, { operationId, organizationId });
  const control = useMutation(api.operations.control);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!op) return <SkeletonBlock label="Carregando operação…" lines={2} />;
  const [tone, label] = operationStates[op.state] ?? ["neutral", op.state];
  return (
    <Card
      flat
      headingLevel={3}
      title={`Operação: ${label}`}
      actions={<StatusBadge tone={tone}>{label}</StatusBadge>}
    >
      <div className="ui-stack">
        <DescriptionList
          items={[
            { term: "Tentativas", value: op.attempts },
            {
              term: "Próxima tentativa",
              value:
                op.nextAttemptAt !== null
                  ? formatDateTime(op.nextAttemptAt)
                  : "Sem próxima tentativa agendada.",
            },
            ...(op.code
              ? [
                  {
                    term: "Situação",
                    value: (
                      <>
                        {codeLabel(op.code)}{" "}
                        <span className="gestao-meta">
                          (código <code>{op.code}</code>)
                        </span>
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {op.uncertain ? (
          <Callout tone="warning">
            Resultado externo incerto. Retomar inicia a reconciliação: a operação consulta o fisco
            ou o destino antes de qualquer reenvio e não repete o efeito às cegas.
          </Callout>
        ) : null}
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        {!["succeeded", "failed"].includes(op.state) ? (
          <div>
            <Button
              variant={op.state === "paused" ? "primary" : "secondary"}
              loading={busy}
              loadingLabel="Aguarde…"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await control({
                    operationId,
                    action: op.state === "paused" ? "retry" : "pause",
                    expectedGeneration: op.generation,
                  });
                } catch (e) {
                  // Operations an integration started are paused and resumed through its API.
                  setError(integrationRecordMessage(e) ?? failure(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {op.state === "paused" ? "Retomar operação" : "Pausar operação"}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
function AuditRows({
  org,
  contextKey,
  rows,
  current,
}: {
  org: Organization;
  contextKey: string;
  rows: AuditRow[];
  current?: string;
}) {
  const names = useNames(org, contextKey, {
    actors: rows.map((r) => r.actor),
    companyIds: rows.flatMap((r) => (r.companyId ? [r.companyId] : [])),
    projectIds: rows.flatMap((r) => (r.projectId ? [r.projectId] : [])),
  });
  return (
    <ul className="gestao-list">
      {groupAuditRows(rows).map(({ first, last, count }) => {
        const reference = last.requestId ?? last.operationId ?? last.eventId ?? last.target;
        const company = last.companyId ? names.company(last.companyId) : undefined;
        const project = last.projectId ? names.project(last.projectId) : undefined;
        return (
          <li key={first._id}>
            <div className="gestao-row">
              <strong className="gestao-row__title">{actionLabel(last.action)}</strong>
              <span className="gestao-meta gestao-time">
                {count > 1
                  ? `${count} vezes, de ${formatDateTime(Math.min(first.createdAt, last.createdAt))} a ${formatDateTime(Math.max(first.createdAt, last.createdAt))}`
                  : formatDateTime(last.createdAt)}
              </span>
            </div>
            <p className="gestao-meta">
              Por {names.actor(last.actor)}
              {company ? <> · Empresa: {company}</> : null}
              {project ? <> · Projeto: {project}</> : null}
              {last.environment === "production" ? (
                <> · Ambiente: {environmentNames.production}</>
              ) : null}
              {last.code && last.action !== `operation.${last.code}` ? (
                <> · {codeLabel(last.code)}</>
              ) : null}
              {last.status ? <> · HTTP {last.status}</> : null}
            </p>
            <div className="ui-actions">
              {reference !== current ? <InvestigateLink org={org} reference={reference} /> : null}
            </div>
            <details className="gestao-details gestao-details--plain">
              <summary>
                Detalhes técnicos
                <Icon name="chevronDown" />
              </summary>
              <div className="ui-stack">
                <p className="gestao-meta">
                  Ação <code>{last.action}</code> · Ator <code>{last.actor}</code>
                  {last.code ? (
                    <>
                      {" "}
                      · Código <code>{last.code}</code>
                    </>
                  ) : null}
                  {count > 1 ? <> · {count} registros agrupados</> : null}
                </p>
                <Copy text={reference} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
/**
 * The audit trail and its filters. The page subscribes to it at once, together with the overview,
 * instead of after the overview answered: both answers arrive in the same round trip.
 */
function useAudit(org: Organization, contextKey: string) {
  // The default period moves by the hour, not by the millisecond: coming back to the page within
  // the hour asks the same query, which the organization's query cache still holds.
  const [filters, setFilters] = useState(() => defaultAuditFilters());
  const page = usePaginatedQuery(api.observability.audit, auditArgs({ org, contextKey }, filters), {
    initialNumItems: AUDIT_PAGE_SIZE,
  });
  return { filters, setFilters, page };
}
function Audit({
  org,
  contextKey,
  audit: { filters, setFilters, page },
}: {
  org: Organization;
  contextKey: string;
  audit: ReturnType<typeof useAudit>;
}) {
  const [error, setError] = useState("");
  return (
    <Card
      title="Auditoria"
      description="A trilha unificada começa com a ativação desta versão. Registros anteriores permanecem nas auditorias de cada domínio."
      flush
    >
      <div className="gestao-body">
        <form
          className="gestao-inline-form"
          aria-label="Filtros da auditoria"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const next = {
              actor: field(data, "actor").trim(),
              action: field(data, "action").trim(),
              from: Date.parse(`${field(data, "from")}T00:00:00Z`),
              until: Date.parse(`${field(data, "until")}T23:59:59.999Z`),
            };
            if (
              !Number.isFinite(next.from) ||
              !Number.isFinite(next.until) ||
              next.until < next.from ||
              next.until - next.from > 366 * DAY ||
              [next.actor, next.action].some(
                (value) => value && !/^[A-Za-z0-9_.:/-]{1,120}$/.test(value),
              )
            ) {
              setError("Informe um período de até 366 dias e referências sem espaços nos filtros.");
              return;
            }
            setError("");
            setFilters(next);
          }}
        >
          <FormField id="audit-actor" label="Ator">
            <Input
              id="audit-actor"
              name="actor"
              maxLength={120}
              aria-describedby="audit-filter-help"
            />
          </FormField>
          <FormField id="audit-action" label="Ação">
            <Input
              id="audit-action"
              name="action"
              maxLength={120}
              list="audit-actions"
              aria-describedby="audit-filter-help"
            />
          </FormField>
          <datalist id="audit-actions">
            {knownActions.map((action) => (
              <option key={action} value={action}>
                {actionLabel(action)}
              </option>
            ))}
          </datalist>
          <div className="gestao-narrow">
            <FormField id="audit-from" label="De, em UTC">
              <Input
                id="audit-from"
                name="from"
                type="date"
                required
                defaultValue={new Date(filters.from).toISOString().slice(0, 10)}
              />
            </FormField>
          </div>
          <div className="gestao-narrow">
            <FormField id="audit-until" label="Até, em UTC">
              <Input
                id="audit-until"
                name="until"
                type="date"
                required
                defaultValue={new Date(filters.until).toISOString().slice(0, 10)}
              />
            </FormField>
          </div>
          <div className="ui-actions">
            <Button type="submit" icon="search">
              Filtrar auditoria
            </Button>
          </div>
          <p id="audit-filter-help" className="ui-help">
            Os filtros usam o código técnico exibido em “Detalhes técnicos” de cada registro, como{" "}
            <code>export.requested</code> ou <code>system</code>.
          </p>
        </form>
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
      </div>
      <div className="gestao-divider">
        {page.status === "LoadingFirstPage" ? (
          <div className="gestao-body">
            <SkeletonBlock label="Carregando auditoria…" />
          </div>
        ) : !page.results.length ? (
          <EmptyState
            icon="inbox"
            headingLevel={3}
            title="Nenhum registro neste período e filtro."
            description="Amplie o período ou limpe os filtros de ator e ação."
          />
        ) : (
          <AuditRows org={org} contextKey={contextKey} rows={page.results} />
        )}
      </div>
      <div className="gestao-footer">
        <More {...page} />
      </div>
    </Card>
  );
}
function MonitorForm({
  org,
  contextKey,
  existing,
  defaults,
  onClose,
}: {
  org: Organization;
  contextKey: string;
  existing?: Doc<"operationalMonitors">;
  defaults: Doc<"operationalMonitors">["thresholds"];
  onClose: () => void;
}) {
  const { environment, confirmed } = useDeployment();
  const projects = usePaginatedQuery(
    api.projects.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const members = usePaginatedQuery(
    api.organizations.members,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const [projectId, setProjectId] = useState<Id<"projects"> | "">(existing?.projectId ?? "");
  const [companyId, setCompanyId] = useState<Id<"companies"> | "">(existing?.companyId ?? "");
  const [ownerId, setOwnerId] = useState(existing?.ownerMembershipId ?? org.membershipId);
  const companies = usePaginatedQuery(
    api.projects.companies,
    projectId ? { organizationId: org.id, projectId, contextKey } : "skip",
    { initialNumItems: 20 },
  );
  const configure = useMutation(api.observability.configure);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // The environment of the monitor is the deployment's, never the build's hint.
    if (!projectId || !companyId || !confirmed) return;
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      await configure({
        organizationId: org.id,
        projectId,
        companyId,
        environment,
        ownerMembershipId: ownerId,
        enabled: data.get("enabled") === "on",
        notify: data.get("notify") === "on",
        expectedGeneration: existing?.generation ?? 0,
        thresholds: {
          queue: Number(data.get("queue")) * 60_000,
          lease: Number(data.get("lease")),
          cursor: Number(data.get("cursor")) * 60_000,
          source: Number(data.get("source")),
          webhook: Number(data.get("webhook")) * 60_000,
          certificate: Number(data.get("certificate")) * DAY,
        },
      });
      onClose();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ui-card ui-card--flat">
      <form className="ui-form" aria-labelledby="monitor-config-title" onSubmit={submit}>
        <h3 id="monitor-config-title" className="ui-card__title">
          Configuração do monitor
        </h3>
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        <div className="gestao-grid gestao-grid--thirds">
          <div className="ui-stack">
            <FormField id="monitor-project" label="Projeto">
              <Select
                id="monitor-project"
                required
                value={projectId}
                disabled={!!existing}
                onChange={(e) => {
                  setProjectId(e.target.value as Id<"projects">);
                  setCompanyId("");
                }}
              >
                <option value="">Selecione</option>
                {projectId && !projects.results.some((p) => p.id === projectId) ? (
                  <option value={projectId}>Projeto atual</option>
                ) : null}
                {projects.results.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <div>
              <More {...projects} />
            </div>
          </div>
          <div className="ui-stack">
            <FormField id="monitor-company" label="Empresa">
              <Select
                id="monitor-company"
                required
                value={companyId}
                disabled={!!existing || !projectId}
                onChange={(e) => setCompanyId(e.target.value as Id<"companies">)}
              >
                <option value="">Selecione</option>
                {companyId && !companies.results.some((c) => c.companyId === companyId) ? (
                  <option value={companyId}>Empresa atual</option>
                ) : null}
                {companies.results
                  .filter((c) => c.environments.includes(environment))
                  .map((c) => (
                    <option key={c.companyId} value={c.companyId}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <div>
              <More {...companies} />
            </div>
          </div>
          <div className="ui-stack">
            <FormField id="monitor-owner" label="Responsável">
              <Select
                id="monitor-owner"
                name="owner"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value as Id<"memberships">)}
                required
              >
                {!members.results.some(
                  (m) => m.id === ownerId && ["owner", "admin"].includes(m.role),
                ) ? (
                  <option value={ownerId}>Responsável atual</option>
                ) : null}
                {members.results
                  .filter((m) => ["owner", "admin"].includes(m.role))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <div>
              <More {...members} />
            </div>
          </div>
        </div>
        <fieldset className="gestao-fieldset">
          <legend>Limites de alerta</legend>
          <div className="gestao-grid gestao-grid--thirds">
            {Object.keys(labels).map((key) => {
              const kind = key as keyof typeof labels;
              const unit =
                kind === "lease" || kind === "source" ? 1 : kind === "certificate" ? DAY : 60_000;
              return (
                <FormField
                  key={kind}
                  id={`monitor-${kind}`}
                  label={`${labels[kind]} ${unit === 1 ? "(quantidade)" : unit === DAY ? "(dias)" : "(minutos)"}`}
                >
                  <Input
                    id={`monitor-${kind}`}
                    type="number"
                    name={kind}
                    min={1}
                    max={unit === 1 ? 100 : (365 * DAY) / unit}
                    step={1}
                    required
                    defaultValue={(existing?.thresholds ?? defaults)[kind] / unit}
                  />
                </FormField>
              );
            })}
          </div>
        </fieldset>
        <div className="ui-stack">
          <Checkbox
            name="enabled"
            defaultChecked={existing?.enabled ?? true}
            label="Monitor ativo"
          />
          <Checkbox
            name="notify"
            defaultChecked={existing?.notify ?? true}
            label="Notificar abertura e recuperação no painel"
          />
        </div>
        <div className="ui-actions">
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Salvando…">
            Salvar monitor
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Fechar configuração
          </Button>
        </div>
      </form>
    </div>
  );
}
