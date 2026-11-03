import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import { Webhooks } from "./webhooks";
import { StripeConnections } from "./stripe";
import { DeveloperQuickstart } from "./developer-quickstart";
import { ConnectSystem } from "./connect-system";
import { Feedback, projectSections } from "./project-sections";
import { More } from "./load-more";
import { Button, buttonClass } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { FormField, Input, controlProps } from "./ui/form";
import { Card, EmptyState, Page, PageHeader, StatusBadge } from "./ui/layout";
import { TabNav, tabLinkClass } from "./ui/tabs";
import { CompanyGrants, type GrantSelection } from "./project-grants";
import { Keys } from "./project-keys";
import { useAsyncAction } from "./async-action";
import { type Props, type Project, errorText, Loading, text } from "./project-common";

type ProjectRow = FunctionReturnType<typeof api.projects.list>["page"][number];
export function Projects({
  org,
  contextKey,
  projectId,
  section = "projects",
}: Props & { projectId?: string; section?: string }) {
  if (
    !org.capabilities.manageIntegrations ||
    !(section === "connect" || projectSections.some(([target]) => target === section))
  )
    return (
      <Page>
        <PageHeader
          title="Página indisponível para seu papel."
          description="Escolha uma das páginas disponíveis no menu da organização."
        />
      </Page>
    );
  if (section === "connect")
    return (
      <ConnectSystem
        key={projectId ?? "new"}
        org={org}
        contextKey={contextKey}
        projectId={projectId}
      />
    );
  return projectId ? (
    <ProjectContext
      key={projectId}
      org={org}
      contextKey={contextKey}
      projectId={projectId}
      section={section}
    />
  ) : (
    <ProjectList org={org} contextKey={contextKey} section={section} />
  );
}
function ProjectList({ org, contextKey, section }: Props & { section: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const create = useMutation(api.projects.create),
    navigate = useNavigate();
  const { busy, error, run } = useAsyncAction(errorText);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const result = await create({
        organizationId: org.id,
        name: text(form, "name"),
        externalReference: text(form, "reference"),
      });
      await navigate({
        to: "/app/$organizationSlug/developer/$developerSection/$projectId",
        params: {
          organizationSlug: org.slug,
          developerSection: "projects",
          projectId: result.projectId,
        },
      });
    });
  }
  const columns: Array<Column<ProjectRow>> = [
    {
      key: "name",
      header: "Projeto",
      primary: true,
      cell: (p) => (
        <Link
          className="ui-link"
          to="/app/$organizationSlug/developer/$developerSection/$projectId"
          params={{ organizationSlug: org.slug, developerSection: section, projectId: p.id }}
        >
          {p.name}
        </Link>
      ),
    },
    {
      key: "reference",
      header: "Referência",
      cell: (p) => <span className="ui-mono">{p.externalReference}</span>,
    },
    {
      key: "state",
      header: "Situação",
      cell: (p) => (
        <StatusBadge tone={p.state === "active" ? "success" : "neutral"}>
          {p.state === "active" ? "Ativo" : "Desativado"}
        </StatusBadge>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        eyebrow={`Integrações · ${projectSections.find(([target]) => target === section)?.[1] ?? "Projetos"}`}
        title={section === "projects" ? "Projetos e integrações" : "Escolha um projeto"}
        description="Um projeto representa um aplicativo integrador. As chaves de API e os webhooks dele só alcançam as empresas, os escopos e os ambientes concedidos ao projeto."
        actions={<ConnectLink org={org} />}
      />
      <div className="gestao-grid">
        <Card
          title="Projetos"
          description="Abra um projeto para conceder empresas, criar chaves e cadastrar webhooks."
          flush
        >
          {status === "LoadingFirstPage" ? (
            <div className="gestao-body">
              <Loading label="Carregando os projetos…" />
            </div>
          ) : (
            <DataTable
              label="Projetos"
              columns={columns}
              rows={results}
              rowKey={(p) => p.id}
              empty={
                <EmptyState
                  icon="code"
                  headingLevel={3}
                  title="Nenhum projeto disponível"
                  description="O percurso guiado cria o projeto, concede as empresas e gera a chave até a primeira chamada. Ou crie só o projeto no formulário ao lado."
                  actions={<ConnectLink org={org} />}
                />
              }
            />
          )}
          <div className="gestao-footer">
            <More status={status} loadMore={loadMore} />
          </div>
        </Card>
        <Card title="Criar projeto" description="Um projeto por aplicativo que chama a API.">
          <form className="ui-form" onSubmit={submit} aria-busy={busy}>
            <FormField id="project-name" label="Nome do projeto">
              <Input id="project-name" name="name" required maxLength={100} disabled={busy} />
            </FormField>
            {/* The server takes free text (trimmed, up to 80 characters, no control characters). */}
            <FormField
              id="project-reference"
              label="Referência do aplicativo"
              help="Texto livre de até 80 caracteres, único nesta organização, como erp-loja ou Portal de compras. Não muda depois de criada; criar de novo com a mesma referência e o mesmo nome reaproveita o projeto."
            >
              <Input
                {...controlProps("project-reference", undefined, true)}
                name="reference"
                required
                maxLength={80}
                disabled={busy}
              />
            </FormField>
            <Feedback error={error} />
            <div>
              <Button type="submit" variant="primary" loading={busy} loadingLabel="Criando…">
                Criar projeto
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Page>
  );
}
/** Entry to the guided setup; with a project, it resumes that project's setup. */
function ConnectLink({ org, projectId }: { org: Organization; projectId?: string }) {
  const className = buttonClass({ variant: projectId ? "secondary" : "primary" });
  return projectId ? (
    <Link
      className={className}
      to="/app/$organizationSlug/developer/$developerSection/$projectId"
      params={{ organizationSlug: org.slug, developerSection: "connect", projectId }}
    >
      Continuar configuração guiada
    </Link>
  ) : (
    <Link
      className={className}
      to="/app/$organizationSlug/developer/$developerSection"
      params={{ organizationSlug: org.slug, developerSection: "connect" }}
    >
      Conectar meu sistema
    </Link>
  );
}
function ProjectContext({
  org,
  contextKey,
  projectId,
  section,
}: Props & { projectId: string; section: string }) {
  const project = useQuery(api.projects.get, { organizationId: org.id, projectId, contextKey });
  const [companyId, select] = useState(""),
    [saved, setSaved] = useState("");
  if (project === undefined)
    return (
      <Page>
        <Loading />
      </Page>
    );
  if (!project)
    return (
      <Page>
        <PageHeader
          title="Projeto indisponível."
          description="Confira o endereço ou solicite acesso à organização."
          actions={
            <Link
              className="ui-button ui-button--secondary"
              to="/app/$organizationSlug/developer/$developerSection"
              params={{ organizationSlug: org.slug, developerSection: "projects" }}
            >
              Ver os projetos
            </Link>
          }
        />
      </Page>
    );
  return (
    <ProjectDetail
      key={`${project.id}:${project.accessVersion}`}
      org={org}
      contextKey={`${contextKey}:${project.accessVersion}`}
      project={project}
      section={section}
      selection={{ companyId, select, saved, setSaved }}
    />
  );
}
/** Sections of one project, as route tabs; the current one is marked for assistive technology. */
export function ProjectTabs({
  org,
  projectId,
  section,
}: {
  org: Organization;
  projectId: string;
  section: string;
}) {
  return (
    <TabNav label="Seções do projeto">
      {projectSections.map(([target, label]) => (
        <li key={target}>
          <Link
            className={tabLinkClass}
            to="/app/$organizationSlug/developer/$developerSection/$projectId"
            params={{ organizationSlug: org.slug, developerSection: target, projectId }}
            aria-current={target === section ? "page" : undefined}
          >
            {label}
          </Link>
        </li>
      ))}
    </TabNav>
  );
}
function ProjectDetail({
  org,
  contextKey,
  project,
  section,
  selection,
}: Props & { project: Project; section: string; selection: GrantSelection }) {
  const grants = usePaginatedQuery(
    api.projects.companies,
    { organizationId: org.id, projectId: project.id, contextKey },
    { initialNumItems: 50 },
  );
  const active = project.state === "active";
  return (
    <Page>
      <PageHeader
        eyebrow={
          <>
            Integração · Referência <span className="ui-mono">{project.externalReference}</span>
          </>
        }
        title={project.name}
        description={
          active
            ? "Projeto ativo"
            : "Projeto desativado. As chaves anteriores não serão reativadas."
        }
        actions={
          <>
            <StatusBadge tone={active ? "success" : "neutral"}>
              {active ? "Ativo" : "Desativado"}
            </StatusBadge>
            {active ? <ConnectLink org={org} projectId={project.id} /> : null}
          </>
        }
      />
      <div className="gestao-stack">
        <ProjectTabs org={org} projectId={project.id} section={section} />
        {grants.status === "LoadingFirstPage" ? (
          <Loading />
        ) : section === "projects" ? (
          <>
            <CompanyGrants
              org={org}
              contextKey={contextKey}
              project={project}
              grants={grants.results}
              selection={selection}
            />
            <ProjectSettings org={org} project={project} />
          </>
        ) : section === "keys" ? (
          <Keys org={org} contextKey={contextKey} project={project} grants={grants.results} />
        ) : section === "webhooks" ? (
          <Webhooks org={org} projectId={project.id} grants={grants.results} />
        ) : section === "stripe" ? (
          <StripeConnections
            org={org}
            projectId={project.id}
            contextKey={contextKey}
            grants={grants.results}
          />
        ) : (
          <DeveloperQuickstart
            key={project.id}
            org={org}
            project={project}
            grants={grants.results}
            complete={grants.status === "Exhausted"}
          />
        )}
        <More status={grants.status} loadMore={grants.loadMore} />
      </div>
    </Page>
  );
}
function ProjectSettings({ org, project }: { org: Organization; project: Project }) {
  const update = useMutation(api.projects.update);
  const { busy, error, run } = useAsyncAction(errorText),
    change = useAsyncAction(errorText);
  const [confirming, setConfirming] = useState(false);
  const stateArea = useRef<HTMLDivElement>(null);
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(() =>
      update({
        organizationId: org.id,
        projectId: project.id,
        name: text(form, "name"),
        state: project.state,
        expectedVersion: project.version,
      }),
    );
  }
  function setState(state: Project["state"]) {
    // The deactivation confirmation shows its own failure; reactivation shows it here.
    return change.run(
      () =>
        update({
          organizationId: org.id,
          projectId: project.id,
          name: project.name,
          state,
          expectedVersion: project.version,
        }),
      { quiet: state !== "active" },
    );
  }
  const active = project.state === "active";
  return (
    <div className="gestao-grid gestao-grid--even">
      <Card title="Configuração do projeto">
        <form className="ui-form" onSubmit={rename} aria-busy={busy}>
          <FormField
            id="edit-project-name"
            label="Nome do projeto"
            help={
              <>
                Referência <code>{project.externalReference}</code>, fixa desde a criação.
              </>
            }
          >
            <Input
              {...controlProps("edit-project-name", undefined, true)}
              name="name"
              defaultValue={project.name}
              required
              maxLength={100}
              disabled={busy}
            />
          </FormField>
          <Feedback error={error} />
          <div>
            <Button type="submit" loading={busy} loadingLabel="Salvando…">
              Salvar nome
            </Button>
          </div>
        </form>
      </Card>
      <div ref={stateArea} tabIndex={-1}>
        <Card
          title={active ? "Desativar projeto" : "Reativar projeto"}
          className={active ? "gestao-danger" : undefined}
          description={
            active
              ? "Desativar invalida na hora todas as chaves atuais deste projeto. Reativar depois não devolve essas chaves: será preciso criar outras."
              : "Reativar permite conceder empresas e criar chaves novas. As chaves invalidadas continuam recusadas."
          }
        >
          {active ? (
            <Button variant="danger" disabled={change.busy} onClick={() => setConfirming(true)}>
              Desativar projeto
            </Button>
          ) : (
            <div className="ui-stack">
              <Feedback error={change.error} />
              <div>
                <Button
                  loading={change.busy}
                  loadingLabel="Reativando…"
                  onClick={() => void setState("active")}
                >
                  Reativar projeto
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Desativar ${project.name}?`}
        description="Todas as chaves de API deste projeto deixam de funcionar imediatamente. Reativar o projeto não as recupera; os aplicativos precisarão de chaves novas."
        confirmLabel="Desativar projeto"
        cancelLabel="Manter ativo"
        busyLabel="Desativando…"
        onConfirm={() => setState("disabled")}
        returnFocusTo={() => stateArea.current}
      />
    </div>
  );
}
