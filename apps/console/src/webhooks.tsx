import { environmentNames, useDeployment, type ProductEnvironment } from "./deployment";
import { useProductEnvironment } from "./product-environment";
import { UsageErrorNotice, isUsageCode } from "./usage-errors";
import { useRef, useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { webhookEventScope, webhookEvents, type WebhookEventType } from "@freecorps/contracts";
import { ConvexError } from "convex/values";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { More } from "./load-more";
import { Feedback, SectionLink } from "./project-sections";
import { OneTimeSecret, scopeLabels } from "./integration-controls";
import { useAsyncAction, useSecretOnce } from "./async-action";
import { Button } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { Checkbox, FormField, Input, Select, controlProps } from "./ui/form";
import {
  Callout,
  Card,
  DescriptionList,
  DisabledReason,
  EmptyState,
  SkeletonBlock,
  StatusBadge,
  type Tone,
} from "./ui/layout";
type Grant = FunctionReturnType<typeof api.projects.companies>["page"][number];
function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
type Endpoint = FunctionReturnType<typeof api.webhooks.list>[number];
type Delivery = FunctionReturnType<typeof api.webhooks.deliveries>["page"][number];
const labels: Record<WebhookEventType, string> = {
  "connection.attention_required": "Captura precisa de aten\u00e7\u00e3o",
  "connection.release_withdrawn": "Captura fiscal retirada",
  "connection.history_limited": "Perda aceita na captura",
  "document.received": "Documento recebido",
  "document.updated": "Documento atualizado",
  "document.event_received": "Evento fiscal recebido",
  "import.completed": "Importação concluída",
  "issuance.authorized": "NFS-e autorizada",
  "issuance.rejected": "NFS-e rejeitada",
  "issuance.cancelled": "NFS-e cancelada",
  "issuance.cancellation_rejected": "Cancelamento de NFS-e rejeitado",
};
const states: Record<Delivery["state"], [Tone, string]> = {
  queued: ["info", "Na fila"],
  running: ["info", "Enviando"],
  retry_wait: ["warning", "Aguardando nova tentativa"],
  delivered: ["success", "Entregue"],
  failed: ["danger", "Falha"],
  paused: ["neutral", "Pausada"],
};
function date(value: number | null) {
  return value === null
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(value);
}
function message(error: unknown) {
  const data: unknown = error instanceof ConvexError ? error.data : null;
  const code = data && typeof data === "object" && "code" in data ? data.code : "";
  // Quota and plan never come from these mutations: they pause the delivery, whose row explains
  // them by role.
  const messages: Record<string, string> = {
    ENDPOINT_CHANGED: "O destino mudou. Confira os dados e tente novamente.",
    ENDPOINT_LIMIT: "Esta empresa atingiu o limite de 20 destinos por ambiente.",
    ROTATION_IN_PROGRESS: "Aguarde o fim da coexistência antes de uma nova rotação.",
    RATE_LIMITED: "Muitas solicitações. Aguarde um minuto.",
    INVALID_REQUEST:
      "Confira o nome, os eventos e a URL HTTPS, sem porta alternativa, parâmetros ou credenciais.",
    OPERATION_CONFLICT: "A entrega mudou ou atingiu o limite de reenvios. Confira o histórico.",
  };
  return typeof code === "string" && messages[code]
    ? messages[code]
    : "Não foi possível concluir. Confira seu acesso e tente novamente.";
}
/** Why a granted company cannot hold webhook destinations; the list filters by the same rule. */
export function webhookCompanyBlocker(
  grant: Pick<Grant, "scopes" | "environments">,
  environment: ProductEnvironment = "sandbox",
) {
  if (!grant.environments.includes(environment))
    return `Esta empresa não tem acesso em ${environmentNames[environment]} neste projeto.`;
  if (!grant.scopes.includes("webhooks:manage"))
    return `Esta empresa não tem o escopo Webhooks (${scopeLabels["webhooks:manage"]}, webhooks:manage) neste projeto.`;
  return "";
}
/** Why no event can be chosen: each event needs its own reading scope besides webhooks:manage. */
export function webhookEventsBlocker(available: readonly WebhookEventType[]) {
  return available.length
    ? ""
    : "Nenhum evento disponível. Além de Webhooks, conceda a esta empresa Importar e consultar documentos, Emitir e cancelar NFS-e ou Captura de NF-e.";
}
export function Webhooks({
  org,
  projectId,
  grants,
}: {
  org: Organization;
  projectId: Id<"projects">;
  grants: Grant[];
}) {
  const search = useSearch({ strict: false }),
    navigate = useNavigate();
  const deployment = useDeployment();
  const chosen = useProductEnvironment().environment;
  const company = search.company;
  // Every granted company is listed; the ones that cannot hold destinations say why.
  const selected = company
    ? grants.find((g) => g.companyId === company)
    : (grants.find((g) => !webhookCompanyBlocker(g, deployment.environment)) ?? grants[0]);
  // The environment chosen in the shell (ADR 0007, §1); Produção exists for a company with the
  // fiscal capture released.
  const offered = selected?.offeredEnvironments ?? [deployment.environment];
  const environment = deployment.environment === "production" ? "production" : chosen;
  const blocker = !selected
    ? ""
    : offered.includes(environment)
      ? webhookCompanyBlocker(selected, environment)
      : `Esta empresa não tem ${environmentNames[environment]}: a captura fiscal nunca foi ativada para ela.`;
  return (
    <>
      <Card
        title="Webhooks"
        description="Receba mudanças no seu aplicativo por eventos assinados, com histórico e reenvio. Uma entrega repetida mantém o mesmo evento."
        actions={
          <StatusBadge tone={environment === "production" ? "info" : "warning"}>
            {environmentNames[environment]}
          </StatusBadge>
        }
      >
        {grants.length ? (
          <div className="ui-stack">
            <FormField id="webhook-company" label="Empresa do destino">
              <Select
                id="webhook-company"
                value={selected?.companyId ?? ""}
                aria-describedby={blocker ? "webhook-company-blocker" : undefined}
                onChange={(e) =>
                  void navigate({
                    to: "/app/$organizationSlug/developer/$developerSection/$projectId",
                    params: { organizationSlug: org.slug, developerSection: "webhooks", projectId },
                    search: { company: e.target.value },
                  })
                }
              >
                {selected ? null : <option value="">Selecione uma empresa</option>}
                {grants.map((g) => (
                  <option key={g.companyId} value={g.companyId}>
                    {g.name}
                    {webhookCompanyBlocker(g, environment) ? " · sem permissão de webhooks" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
            {!selected ? (
              <Callout tone="warning" role="alert">
                Empresa indisponível neste projeto. Escolha uma empresa concedida.
              </Callout>
            ) : blocker ? (
              <div id="webhook-company-blocker">
                <Callout tone="warning">
                  {blocker}{" "}
                  <SectionLink org={org} projectId={projectId} section="projects">
                    Editar o acesso em Empresas e acesso
                  </SectionLink>
                </Callout>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            icon="building"
            headingLevel={3}
            title="O projeto ainda não tem empresas concedidas."
            actions={
              <SectionLink org={org} projectId={projectId} section="projects">
                Conceder acesso em Empresas e acesso
              </SectionLink>
            }
          />
        )}
      </Card>
      {selected && !blocker ? (
        <EndpointList
          key={`${selected.companyId}:${selected.version}:${environment}`}
          org={org}
          projectId={projectId}
          grant={selected}
          environment={environment}
        />
      ) : null}
    </>
  );
}
function EndpointList({
  org,
  projectId,
  grant,
  environment,
}: {
  org: Organization;
  projectId: Id<"projects">;
  grant: Grant;
  environment: ProductEnvironment;
}) {
  const { confirmed, environment: deploymentEnvironment } = useDeployment();
  const scope = {
    organizationId: org.id,
    projectId,
    companyId: grant.companyId,
    environment,
  };
  // No fiscal-scoped query leaves before the deployment confirms its environment.
  const endpoints = useQuery(api.webhooks.list, confirmed ? scope : "skip");
  const search = useSearch({ strict: false }),
    navigate = useNavigate();
  const selected = search.endpoint;
  function setSelected(endpoint?: string) {
    void navigate({
      to: "/app/$organizationSlug/developer/$developerSection/$projectId",
      params: { organizationSlug: org.slug, developerSection: "webhooks", projectId },
      search: {
        company: grant.companyId,
        endpoint,
        env: environment === deploymentEnvironment ? undefined : environment,
      },
    });
  }
  const [creating, setCreating] = useState(false);
  const endpoint = endpoints?.find((e) => e.id === selected);
  // Same rule the server applies when the endpoint is saved and before each delivery.
  const available = webhookEvents.filter((e) => grant.scopes.includes(webhookEventScope(e)));
  const eventsBlocker = webhookEventsBlocker(available);
  if (!endpoints) return <SkeletonBlock label="Carregando destinos…" />;
  const columns: Array<Column<Endpoint>> = [
    {
      key: "name",
      header: "Destino",
      primary: true,
      cell: (e) => (
        <Button
          size="sm"
          variant={selected === e.id ? "secondary" : "ghost"}
          aria-pressed={selected === e.id}
          onClick={() => {
            setCreating(false);
            setSelected(e.id);
          }}
        >
          {e.name}
        </Button>
      ),
    },
    { key: "url", header: "URL", cell: (e) => <span className="ui-mono">{e.url}</span> },
    {
      key: "state",
      header: "Situação",
      cell: (e) => (
        <StatusBadge tone={e.active ? "success" : "neutral"}>
          {e.active ? "Ativo" : "Desativado"}
        </StatusBadge>
      ),
    },
  ];
  return (
    <>
      <Card
        title="Destinos"
        description={`URLs HTTPS que recebem os eventos de ${grant.name}.`}
        actions={
          <Button
            variant="primary"
            icon="plus"
            disabled={creating || Boolean(eventsBlocker)}
            aria-describedby={eventsBlocker ? "webhook-events-blocker" : undefined}
            onClick={() => {
              setSelected();
              setCreating(true);
            }}
          >
            Novo destino
          </Button>
        }
        flush
      >
        {eventsBlocker ? (
          <div className="gestao-body">
            <DisabledReason id="webhook-events-blocker">
              {eventsBlocker}{" "}
              <SectionLink org={org} projectId={projectId} section="projects">
                Editar o acesso em Empresas e acesso
              </SectionLink>
            </DisabledReason>
          </div>
        ) : null}
        <DataTable
          label="Destinos"
          columns={columns}
          rows={endpoints}
          rowKey={(e) => e.id}
          empty={
            <EmptyState
              icon="layers"
              headingLevel={3}
              title="Nenhum destino cadastrado para esta empresa."
              description="Cadastre a URL que recebe os eventos e envie um teste sintético."
            />
          }
        />
      </Card>
      {creating ? (
        <EndpointForm
          key="create"
          scope={scope}
          available={available}
          close={() => setCreating(false)}
        />
      ) : null}
      {selected && !endpoint ? (
        <Callout tone="warning" role="alert">
          Destino indisponível para esta empresa e projeto.
        </Callout>
      ) : null}
      {endpoint ? (
        <EndpointDetail
          key={endpoint.id}
          org={org}
          endpoint={endpoint}
          scope={scope}
          available={available}
        />
      ) : null}
    </>
  );
}
type Scope = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  companyId: Id<"companies">;
  environment: ProductEnvironment;
};
function EndpointForm({
  scope,
  endpoint: currentEndpoint,
  available,
  close,
  nested = false,
}: {
  scope: Scope;
  endpoint?: Endpoint;
  available: readonly WebhookEventType[];
  close: () => void;
  nested?: boolean;
}) {
  // The version must describe the draft being edited, not a later live update.
  const [endpoint] = useState(currentEndpoint);
  const create = useMutation(api.webhooks.create),
    update = useMutation(api.webhooks.update);
  const [events, setEvents] = useState<WebhookEventType[]>(() =>
    endpoint ? endpoint.events.filter((event) => available.includes(event)) : [...available],
  );
  const { secret, discard, receive } = useSecretOnce();
  const { busy, error, run } = useAsyncAction(message);
  const formId = endpoint ? "webhook-edit" : "webhook-create";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      input = { name: formText(form, "name"), url: formText(form, "url"), events };
    if (endpoint)
      await run(
        () =>
          update({
            ...input,
            endpointId: endpoint.id,
            expectedVersion: endpoint.version,
            active: endpoint.active,
          }),
        { done: close },
      );
    else await run(() => receive(async () => (await create({ ...scope, ...input })).secret));
  }
  return (
    <Card
      title={endpoint ? "Editar destino" : "Novo destino"}
      headingLevel={nested ? 3 : 2}
      flat={nested}
      actions={
        <Button
          variant="ghost"
          icon="close"
          onClick={() => {
            discard();
            close();
          }}
        >
          Fechar
        </Button>
      }
    >
      {secret ? (
        <OneTimeSecret
          id="webhook-secret"
          label="Segredo do webhook"
          value={secret}
          created="Destino criado."
          onDone={() => {
            discard();
            close();
          }}
        />
      ) : (
        <form className="ui-form" onSubmit={submit} aria-busy={busy}>
          <div className="gestao-grid gestao-grid--even">
            <FormField id={`${formId}-name`} label="Nome do destino">
              <Input
                id={`${formId}-name`}
                name="name"
                required
                maxLength={100}
                defaultValue={endpoint?.name}
                disabled={busy}
              />
            </FormField>
            <FormField
              id={`${formId}-url`}
              label="URL HTTPS"
              help="Porta 443, sem credenciais ou parâmetros. A conexão valida o endereço público a cada tentativa."
            >
              <Input
                {...controlProps(`${formId}-url`, undefined, true)}
                name="url"
                type="url"
                required
                maxLength={2048}
                placeholder="https://seu-aplicativo.com.br/webhooks"
                defaultValue={endpoint?.url}
                disabled={busy}
              />
            </FormField>
          </div>
          <fieldset className="gestao-fieldset" disabled={busy}>
            <legend>Eventos recebidos</legend>
            <div className="gestao-choices">
              {available.map((e) => (
                <Checkbox
                  key={e}
                  label={labels[e]}
                  checked={events.includes(e)}
                  onChange={(v) =>
                    setEvents(
                      v.target.checked ? [...events, e] : events.filter((item) => item !== e),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
          <Feedback error={error} />
          <div className="gestao-submit">
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              loadingLabel="Salvando…"
              disabled={!events.length}
              aria-describedby={events.length ? undefined : `${formId}-events`}
            >
              {endpoint ? "Salvar destino" : "Criar destino"}
            </Button>
            {events.length ? null : (
              <DisabledReason id={`${formId}-events`}>Marque pelo menos um evento.</DisabledReason>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}
function EndpointDetail({
  org,
  endpoint,
  scope,
  available,
}: {
  org: Organization;
  endpoint: Endpoint;
  scope: Scope;
  available: readonly WebhookEventType[];
}) {
  const test = useMutation(api.webhooks.test),
    update = useMutation(api.webhooks.update);
  const [editing, setEditing] = useState(false),
    [rotating, setRotating] = useState(false),
    [notice, setNotice] = useState(""),
    [confirmOff, setConfirmOff] = useState(false);
  const { busy, error, run, clearError } = useAsyncAction(message);
  const area = useRef<HTMLDivElement>(null);
  function act(kind: "test" | "toggle") {
    setNotice("");
    if (kind === "test")
      return run(() => test({ endpointId: endpoint.id, key: crypto.randomUUID() }), {
        done: (result) =>
          setNotice(
            `Teste sintético enfileirado. Evento ${result.eventId}. Acompanhe o resultado abaixo.`,
          ),
      });
    // The confirmation shows its own failure; the page shows the others.
    return run(
      () =>
        update({
          endpointId: endpoint.id,
          expectedVersion: endpoint.version,
          active: !endpoint.active,
          name: endpoint.name,
          url: endpoint.url,
          events: endpoint.events,
        }),
      { quiet: endpoint.active !== false },
    );
  }
  const testReason = endpoint.active ? "" : "Ative o destino para enviar um teste.";
  return (
    <div ref={area} tabIndex={-1} className="gestao-stack">
      <Card
        title={endpoint.name}
        label="Detalhe do destino"
        actions={
          <StatusBadge tone={endpoint.active ? "success" : "neutral"}>
            {endpoint.active ? "Ativo" : "Desativado"}
          </StatusBadge>
        }
      >
        <div className="ui-stack">
          <DescriptionList
            items={[
              { term: "URL", value: <span className="ui-mono">{endpoint.url}</span> },
              {
                term: "Segredo",
                value: `Versão ${endpoint.secretVersion}${endpoint.previousUntil ? ` · Coexistência até ${date(endpoint.previousUntil)}` : ""}`,
              },
              { term: "Eventos", value: endpoint.events.map((e) => labels[e]).join(" · ") },
            ]}
          />
          <div className="ui-actions">
            <Button
              variant="primary"
              disabled={busy || Boolean(testReason)}
              aria-describedby={testReason ? `test-${endpoint.id}` : undefined}
              onClick={() => void act("test")}
            >
              Enviar teste sintético
            </Button>
            <Button disabled={busy} aria-expanded={editing} onClick={() => setEditing(!editing)}>
              Editar destino
            </Button>
            <Button disabled={busy} aria-expanded={rotating} onClick={() => setRotating(!rotating)}>
              Rotacionar segredo
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                clearError();
                if (endpoint.active) setConfirmOff(true);
                else void act("toggle");
              }}
            >
              {endpoint.active ? "Desativar destino" : "Ativar destino"}
            </Button>
          </div>
          {testReason ? (
            <DisabledReason id={`test-${endpoint.id}`}>{testReason}</DisabledReason>
          ) : null}
          <Feedback error={error} />
          {notice ? (
            <Callout tone="success" role="status">
              {notice}
            </Callout>
          ) : null}
          {editing ? (
            <EndpointForm
              nested
              scope={scope}
              endpoint={endpoint}
              available={available}
              close={() => setEditing(false)}
            />
          ) : null}
          {rotating ? <Rotation endpoint={endpoint} close={() => setRotating(false)} /> : null}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title={`Desativar ${endpoint.name}?`}
        description="As entregas pendentes ficam pausadas e novos eventos não são enviados a este destino até você ativá-lo de novo."
        confirmLabel="Desativar destino"
        cancelLabel="Manter ativo"
        busyLabel="Desativando…"
        onConfirm={() => act("toggle")}
        returnFocusTo={() => area.current}
      />
      <DeliveryHistory org={org} endpointId={endpoint.id} />
    </div>
  );
}
function Rotation({ endpoint, close }: { endpoint: Endpoint; close: () => void }) {
  const rotate = useMutation(api.webhooks.rotate);
  const { secret, discard, receive } = useSecretOnce();
  const { busy, error, run } = useAsyncAction(message);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(() =>
      receive(async () => {
        const result = await rotate({
          endpointId: endpoint.id,
          expectedVersion: endpoint.version,
          overlapMs: Number(form.get("overlap")),
        });
        return result.secret;
      }),
    );
  }
  return (
    <Card title="Trocar segredo" headingLevel={3} flat>
      {secret ? (
        <OneTimeSecret
          id="webhook-secret"
          label="Segredo do webhook"
          value={secret}
          created="Segredo trocado."
          onDone={() => {
            discard();
            close();
          }}
        />
      ) : (
        <form className="ui-form" onSubmit={submit} aria-busy={busy}>
          <FormField
            id="webhook-overlap"
            label="Coexistência com o segredo anterior"
            help="Atualize o receptor antes do fim da janela. Durante a coexistência, as entregas levam as duas assinaturas."
          >
            <Select
              {...controlProps("webhook-overlap", undefined, true)}
              name="overlap"
              defaultValue="3600000"
              disabled={busy}
            >
              <option value="0">Substituir imediatamente</option>
              <option value="3600000">1 hora</option>
              <option value="86400000">24 horas</option>
            </Select>
          </FormField>
          <Feedback error={error} />
          <div className="ui-actions">
            <Button type="submit" variant="primary" loading={busy} loadingLabel="Gerando…">
              Confirmar rotação
            </Button>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
function DeliveryHistory({
  org,
  endpointId,
}: {
  org: Organization;
  endpointId: Id<"webhookEndpoints">;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.webhooks.deliveries,
    { endpointId },
    { initialNumItems: 20 },
  );
  return (
    <Card
      title="Histórico de entregas"
      description="O receptor deve deduplicar pelo eventId e ignorar versões antigas. A ordem de chegada não é garantida."
      flush
    >
      {status === "LoadingFirstPage" ? (
        <div className="gestao-body">
          <SkeletonBlock label="Carregando histórico…" />
        </div>
      ) : results.length ? (
        <ul className="gestao-list">
          {results.map((d) => (
            <DeliveryRow key={d.id} org={org} delivery={d} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon="inbox"
          headingLevel={3}
          title="Nenhuma entrega."
          description="Envie um teste sintético para conferir o destino."
        />
      )}
      <div className="gestao-footer">
        <More status={status} loadMore={loadMore} />
      </div>
    </Card>
  );
}
function DeliveryRow({ org, delivery: d }: { org: Organization; delivery: Delivery }) {
  const retry = useMutation(api.webhooks.retry);
  const [expanded, setExpanded] = useState(false),
    [confirm, setConfirm] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const attempts = useQuery(api.webhooks.attempts, expanded ? { deliveryId: d.id } : "skip");
  async function resend() {
    try {
      await retry({ deliveryId: d.id, expectedGeneration: d.generation, key: crypto.randomUUID() });
      return "";
    } catch (e) {
      return message(e);
    }
  }
  const [tone, state] = states[d.state];
  return (
    <li ref={row} tabIndex={-1}>
      <div className="gestao-row">
        <p className="gestao-row__title">
          <span>
            {d.type === "webhook.test" ? "Teste sintético" : labels[d.type as WebhookEventType]}
          </span>
          <StatusBadge tone={tone}>{state}</StatusBadge>
        </p>
        <div className="ui-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Ocultar tentativas" : "Ver tentativas"}
          </Button>
          {d.canRetry ? (
            <Button size="sm" onClick={() => setConfirm(true)}>
              Reenviar entrega
            </Button>
          ) : null}
        </div>
      </div>
      <p className="gestao-meta">
        {d.attempts} tentativa(s) · {date(d.createdAt)} · Versão {d.resourceVersion} · Próxima
        tentativa: {date(d.nextAttemptAt)}
        {d.durationMs !== null ? ` · Duração ${d.durationMs} ms` : ""}
      </p>
      <p className="gestao-meta">
        Evento <code>{d.eventId}</code> · Referência de suporte <code>{d.id}</code>
      </p>
      {d.code === "DELIVERY_DISABLED" ? (
        <Callout tone="info">
          O envio está desativado neste ambiente. O teste foi registrado e pode ser reenviado quando
          a operação habilitar o transporte.
        </Callout>
      ) : isUsageCode(d.code) ? (
        <UsageErrorNotice tone="warning" code={d.code} org={org} />
      ) : d.code ? (
        <Callout tone="warning">
          {d.code === "ACCESS_REVOKED"
            ? "Destino ou concessão desativados. Confira o acesso antes de reenviar."
            : (d.response ?? d.code)}
        </Callout>
      ) : null}
      {expanded ? (
        attempts ? (
          <ol className="gestao-list" aria-label="Tentativas">
            {attempts.map((a) => (
              <li key={a.number} className="gestao-meta">
                Tentativa {a.number} · {date(a.startedAt)} · {a.code ?? "Em andamento"}
                {a.durationMs !== null ? ` · ${a.durationMs} ms` : ""}
              </li>
            ))}
          </ol>
        ) : (
          <SkeletonBlock label="Carregando tentativas…" lines={2} />
        )
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="primary"
        title="Reenviar a entrega?"
        description="O receptor pode receber o mesmo evento novamente. Confirmar reenvio?"
        confirmLabel="Confirmar reenvio"
        busyLabel="Reenviando…"
        onConfirm={resend}
        returnFocusTo={() => row.current}
      />
    </li>
  );
}
