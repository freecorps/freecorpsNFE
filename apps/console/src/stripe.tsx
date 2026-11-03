import { useState } from "react";
import { useMutation } from "convex/react";
import { ErrorBoundary } from "./route-errors";
import { useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { Feedback, SectionLink } from "./project-sections";
import { scopeLabels } from "./integration-controls";
import { Button } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { FormField, Select, controlProps } from "./ui/form";
import { Callout, Card, DisabledReason, EmptyState, SkeletonBlock, StatusBadge } from "./ui/layout";
import {
  connectionStatus,
  environmentLabels,
  marketLabels,
  type Connection,
} from "./stripe-shared";
import { ConfigForm, configOf } from "./stripe-config";
import { DataGuide, SetupGuide } from "./stripe-setup";
import { EventList } from "./stripe-events";

/**
 * Conexão Stripe (ADR 0006): o Stripe chama a plataforma direto e cada cobrança paga vira uma
 * emissão NFS-e da empresa, sob a concessão do projeto. O servidor valida tudo; aqui ficam o
 * passo a passo, a configuração e os eventos recebidos.
 */
// The connection itself (list, creation and detail) lives here; the setup guide, the
// configuration, the events and the taker correction have their own modules.

type Grant = FunctionReturnType<typeof api.projects.companies>["page"][number];
const MANAGERS: readonly string[] = ["owner", "admin"];

// ---------------------------------------------------------------------------------------------

export function StripeConnections({
  org,
  projectId,
  contextKey,
  grants,
}: {
  org: Organization;
  projectId: Id<"projects">;
  contextKey: string;
  grants: Grant[];
}) {
  const connections = useQuery(api.stripe.listConnections, { organizationId: org.id, projectId });
  const [selectedId, setSelectedId] = useState<string>(),
    [creating, setCreating] = useState(false);
  const manager = MANAGERS.includes(org.role);
  const issuing = grants.filter((g) => g.scopes.includes("documents:issue"));
  const createReason = !manager
    ? "Só proprietários e administradores criam conexões Stripe, porque a conexão emite nota sozinha."
    : !issuing.length
      ? `Nenhuma empresa deste projeto tem ${scopeLabels["documents:issue"]} (documents:issue).`
      : "";
  const selected = creating
    ? undefined
    : (connections?.find((c) => c.id === selectedId) ?? connections?.[0]);
  const company = (id: string) =>
    grants.find((g) => g.companyId === id)?.name ?? "Empresa sem concessão";
  const columns: Array<Column<Connection>> = [
    {
      key: "name",
      header: "Conexão",
      primary: true,
      cell: (c) => (
        <Button
          size="sm"
          variant={selected?.id === c.id ? "secondary" : "ghost"}
          aria-pressed={selected?.id === c.id}
          onClick={() => {
            setCreating(false);
            setSelectedId(c.id);
          }}
        >
          {c.name}
        </Button>
      ),
    },
    { key: "company", header: "Empresa", cell: (c) => company(c.companyId) },
    { key: "environment", header: "Ambiente", cell: (c) => environmentLabels[c.environment] },
    { key: "market", header: "Vende para", cell: (c) => marketLabels[c.config.market] },
    {
      key: "state",
      header: "Situação",
      cell: (c) => {
        const status = connectionStatus(c);
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
    },
  ];
  return (
    <>
      <Card
        title="Stripe"
        description="Emita NFS-e a cada cobrança paga no Stripe. O Stripe chama a plataforma direto: o aplicativo não precisa escutar o Stripe nem guardar os dados fiscais do cliente."
        actions={
          <Button
            variant="primary"
            icon="plus"
            disabled={creating || Boolean(createReason)}
            aria-describedby={createReason ? "stripe-create-reason" : undefined}
            onClick={() => setCreating(true)}
          >
            Nova conexão
          </Button>
        }
        flush
      >
        {createReason ? (
          <div className="gestao-body">
            <DisabledReason id="stripe-create-reason">
              {createReason}{" "}
              {manager ? (
                <SectionLink org={org} projectId={projectId} section="projects">
                  Editar o acesso em Empresas e acesso
                </SectionLink>
              ) : null}
            </DisabledReason>
          </div>
        ) : null}
        {connections === undefined ? (
          <div className="gestao-body">
            <SkeletonBlock label="Carregando conexões…" />
          </div>
        ) : (
          <DataTable
            label="Conexões Stripe"
            columns={columns}
            rows={connections}
            rowKey={(c) => c.id}
            empty={
              <EmptyState
                icon="layers"
                headingLevel={3}
                title="Nenhuma conexão Stripe neste projeto."
                description="Crie uma conexão para uma empresa e um ambiente; o passo a passo mostra o que fazer no painel do Stripe."
              />
            }
          />
        )}
      </Card>
      {creating ? (
        <ErrorBoundary
          fallback={<Feedback error="Não foi possível carregar o perfil NFS-e da empresa." />}
        >
          <CreateConnection
            org={org}
            projectId={projectId}
            contextKey={contextKey}
            grants={issuing}
            close={(id) => {
              setCreating(false);
              if (id) setSelectedId(id);
            }}
          />
        </ErrorBoundary>
      ) : null}
      {selected ? (
        <ConnectionDetail
          key={selected.id}
          org={org}
          contextKey={contextKey}
          connection={selected}
          grant={grants.find((g) => g.companyId === selected.companyId)}
          manager={manager}
        />
      ) : null}
    </>
  );
}

function CreateConnection({
  org,
  projectId,
  contextKey,
  grants,
  close,
}: {
  org: Organization;
  projectId: Id<"projects">;
  contextKey: string;
  grants: Grant[];
  close: (id?: string) => void;
}) {
  const create = useMutation(api.stripe.createConnection);
  const [companyId, setCompanyId] = useState<string>(grants[0]?.companyId ?? "");
  const grant = grants.find((g) => g.companyId === companyId);
  const environments = grant?.environments ?? [];
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const chosenEnvironment = environments.includes(environment) ? environment : environments[0];
  return (
    <Card
      title="Nova conexão Stripe"
      description="Uma conexão liga este projeto, uma empresa e um ambiente a um endpoint de webhook do Stripe."
      actions={
        <Button variant="ghost" icon="close" onClick={() => close()}>
          Fechar
        </Button>
      }
    >
      <div className="ui-stack">
        <div className="gestao-grid gestao-grid--even">
          <FormField id="stripe-company" label="Empresa que emite">
            <Select
              id="stripe-company"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              {grants.map((g) => (
                <option key={g.companyId} value={g.companyId}>
                  {g.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            id="stripe-environment"
            label="Ambiente"
            help="Sandbox aceita eventos de teste e reais, com transporte simulado. Produção aceita só eventos reais (live mode)."
          >
            <Select
              {...controlProps("stripe-environment", undefined, true)}
              value={chosenEnvironment ?? ""}
              onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}
            >
              {environments.map((env) => (
                <option key={env} value={env}>
                  {environmentLabels[env]}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        {grant && chosenEnvironment ? (
          <ConfigForm
            key={grant.companyId}
            org={org}
            contextKey={contextKey}
            companyId={grant.companyId}
            grantScopes={grant.scopes}
            editable
            submitLabel="Criar conexão"
            onSubmit={async (d) => {
              const result = await create({
                organizationId: org.id,
                projectId,
                companyId: grant.companyId,
                environment: chosenEnvironment,
                name: d.name,
                config: configOf(d),
              });
              close(result.id);
            }}
          />
        ) : (
          <Callout tone="warning">Escolha uma empresa com ambiente concedido ao projeto.</Callout>
        )}
      </div>
    </Card>
  );
}

function ConnectionDetail({
  org,
  contextKey,
  connection,
  grant,
  manager,
}: {
  org: Organization;
  contextKey: string;
  connection: Connection;
  grant: Grant | undefined;
  manager: boolean;
}) {
  const update = useMutation(api.stripe.updateConnection);
  return (
    <div className="gestao-stack">
      <SetupGuide connection={connection} manager={manager} />
      <DataGuide market={connection.config.market} />
      <Card
        title="Configuração"
        description={`${grant?.name ?? "Empresa sem concessão"} · ${environmentLabels[connection.environment]}`}
        actions={
          <StatusBadge tone={connection.active ? "success" : "neutral"}>
            {connection.active ? "Ativa" : "Desativada"}
          </StatusBadge>
        }
      >
        {grant ? null : (
          <Callout tone="warning">
            A empresa desta conexão não está mais concedida ao projeto. A conexão não emite até a
            concessão voltar e alguém salvar a configuração de novo.
          </Callout>
        )}
        <ErrorBoundary
          resetKey={`${connection.id}:${connection.version}`}
          fallback={<Feedback error="Não foi possível carregar o perfil NFS-e da empresa." />}
        >
          {/* Keyed by version: a save elsewhere (or the secret) reloads the draft with the new version. */}
          <ConfigForm
            key={`${connection.id}:${connection.version}`}
            org={org}
            contextKey={contextKey}
            companyId={connection.companyId}
            connection={connection}
            grantScopes={grant?.scopes ?? []}
            editable={manager}
            submitLabel="Salvar configuração"
            onSubmit={async (d) => {
              await update({
                connectionId: connection.id,
                expectedVersion: connection.version,
                name: d.name,
                config: configOf(d),
                active: d.active,
              });
            }}
          />
        </ErrorBoundary>
      </Card>
      <ErrorBoundary
        resetKey={`${connection.id}:${connection.version}`}
        fallback={
          <Callout tone="warning">
            Seu acesso não permite ler os eventos desta empresa. Quem lê as emissões da empresa lê
            também os eventos do Stripe.
          </Callout>
        }
      >
        <EventList org={org} connection={connection} />
      </ErrorBoundary>
    </div>
  );
}
