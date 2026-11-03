import { useRef, useState, type FormEvent } from "react";
import { useMutation, type UsePaginatedQueryReturnType } from "convex/react";
import { usePaginatedQuery, useQuery } from "./convex-query";
import {
  integrationEnvironments,
  type IntegrationEnvironment,
  type IntegrationScope,
} from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { Feedback } from "./project-sections";
import { useAsyncAction } from "./async-action";
import { ScopePicker, scopeSummary } from "./integration-controls";
import { More } from "./load-more";
import { Button } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { Checkbox, FormField, Select } from "./ui/form";
import { Callout, Card, DisabledReason, EmptyState } from "./ui/layout";
import {
  type Props,
  type Project,
  type Grant,
  errorText,
  environmentLabel,
} from "./project-common";

/** What a new grant starts with: the common integration (documents, webhooks, companies). */
export function defaultGrantScopes(allowed: readonly IntegrationScope[]) {
  const defaults: IntegrationScope[] = [
    "companies:read",
    "documents:read",
    "documents:import",
    "webhooks:manage",
  ];
  return allowed.filter((s) => defaults.includes(s));
}
/** Why "Salvar concessão" is unavailable, in the order the person can fix it. */
export function grantBlocker(input: {
  projectActive: boolean;
  companyId: string;
  existingLoaded: boolean;
  /** The server has an active grant whose saved values are not in the loaded list. */
  savedValuesMissing?: boolean;
  scopes: number;
  environments: number;
}) {
  if (!input.projectActive) return "Reative o projeto para conceder acesso a empresas.";
  if (!input.companyId) return "Escolha uma empresa para continuar.";
  if (!input.existingLoaded) return "Conferindo a concessão atual desta empresa…";
  // Saving defaults here would silently replace the saved scopes and environments.
  if (input.savedValuesMissing)
    return "Carregue mais concessões abaixo para editar esta empresa com os valores salvos.";
  if (!input.scopes) return "Marque pelo menos um escopo.";
  if (!input.environments) return "Marque pelo menos um ambiente.";
  return "";
}
/** Selection and confirmation live above the access-versioned detail, which remounts on save. */
export type GrantSelection = {
  companyId: string;
  select: (companyId: string) => void;
  saved: string;
  setSaved: (message: string) => void;
};
export function CompanyGrants({
  org,
  contextKey,
  project,
  grants,
  selection,
}: Props & { project: Project; grants: Grant[]; selection: GrantSelection }) {
  const companies = usePaginatedQuery(
    api.companies.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 50 },
  );
  const revoke = useMutation(api.projects.revokeCompany);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const formRef = useRef<HTMLDivElement>(null),
    listRef = useRef<HTMLDivElement>(null);
  // With a single company there is nothing to choose; the person still confirms the save.
  const only =
    companies.status === "Exhausted" && companies.results.length === 1
      ? companies.results[0]!.id
      : "";
  const companyId = selection.companyId || only;
  const current = grants.find((g) => g.companyId === companyId);
  async function remove(g: Grant) {
    selection.setSaved("");
    try {
      await revoke({
        organizationId: org.id,
        projectId: project.id,
        companyId: g.companyId,
        expectedVersion: g.version,
      });
      return "";
    } catch (error) {
      return errorText(error);
    }
  }
  function edit(g: Grant) {
    selection.setSaved("");
    selection.select(g.companyId);
    formRef.current?.scrollIntoView({ block: "start" });
    document.getElementById("grant-company")?.focus({ preventScroll: true });
  }
  const editReason =
    project.state === "active" ? "" : "Reative o projeto para alterar o acesso das empresas.";
  const columns: Array<Column<Grant>> = [
    { key: "name", header: "Empresa", primary: true, cell: (g) => g.name },
    { key: "scopes", header: "O que o aplicativo pode fazer", cell: (g) => scopeSummary(g.scopes) },
    {
      key: "environments",
      header: "Ambientes",
      cell: (g) => g.environments.map((env) => environmentLabel[env]).join(", "),
    },
    {
      key: "actions",
      header: "Ações",
      cell: (g) => (
        <div className="ui-stack">
          <div className="ui-actions">
            <Button
              size="sm"
              disabled={Boolean(editReason)}
              aria-describedby={editReason ? `grant-edit-${g.companyId}` : undefined}
              onClick={() => edit(g)}
            >
              {"Editar acesso "}
              <span className="ui-visually-hidden">a {g.name}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(g)}>
              {"Remover acesso "}
              <span className="ui-visually-hidden">a {g.name}</span>
            </Button>
          </div>
          {editReason ? (
            <DisabledReason id={`grant-edit-${g.companyId}`}>{editReason}</DisabledReason>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <>
      <div ref={listRef} tabIndex={-1}>
        <Card
          title="Empresas concedidas"
          description="As chaves e os webhooks deste projeto só alcançam estas empresas, com estes escopos e ambientes."
          flush
        >
          <DataTable
            label="Empresas concedidas"
            columns={columns}
            rows={grants}
            rowKey={(g) => g.companyId}
            empty={
              <EmptyState
                icon="building"
                headingLevel={3}
                title="O projeto ainda não tem acesso a empresas."
                description="Conceda a primeira empresa no formulário abaixo."
              />
            }
          />
        </Card>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Remover o acesso a ${revoking?.name ?? "esta empresa"}?`}
        description={`As chaves e os webhooks deste projeto deixam de alcançar ${revoking?.name ?? "a empresa"}. Conceder de novo depois não reativa as chaves atuais.`}
        confirmLabel="Confirmar remoção"
        cancelLabel="Manter acesso"
        busyLabel="Removendo…"
        onConfirm={() => (revoking ? remove(revoking) : Promise.resolve(""))}
        returnFocusTo={() => listRef.current}
      />
      <div ref={formRef}>
        <Card
          title="Conceder ou alterar acesso"
          description="Escolha a empresa e o que o aplicativo pode fazer com ela. Se a empresa já estiver concedida, o formulário abre com os escopos e ambientes salvos. As chaves herdam esse acesso."
        >
          <div className="ui-stack">
            {selection.saved && (
              <Callout tone="success" role="status">
                {selection.saved}
              </Callout>
            )}
            <GrantForm
              // The form seeds its checkboxes once. Reseed when the saved grant arrives on a later
              // page ("Carregar mais"), so leftover defaults never replace the saved values.
              key={`${companyId}:${current?.version ?? 0}`}
              org={org}
              contextKey={contextKey}
              project={project}
              current={current}
              companyId={companyId}
              companies={companies}
              selection={selection}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
function GrantForm({
  org,
  contextKey,
  project,
  current,
  companyId,
  companies,
  selection,
}: Props & {
  project: Project;
  current: Grant | undefined;
  companyId: string;
  companies: UsePaginatedQueryReturnType<typeof api.companies.list>;
  selection: GrantSelection;
}) {
  const grant = useMutation(api.projects.grantCompany);
  const [scopes, setScopes] = useState<IntegrationScope[]>(
      current?.scopes ?? defaultGrantScopes(project.grantableScopes),
    ),
    [environments, setEnvironments] = useState<IntegrationEnvironment[]>(
      current?.environments ?? [project.deploymentEnvironment],
    );
  const { busy, error, run } = useAsyncAction(errorText);
  const existing = useQuery(
    api.projects.companyGrant,
    companyId
      ? {
          organizationId: org.id,
          projectId: project.id,
          companyId: companyId as Id<"companies">,
          contextKey,
        }
      : "skip",
  );
  const blocker = grantBlocker({
    projectActive: project.state === "active",
    companyId,
    existingLoaded: existing !== undefined,
    savedValuesMissing: Boolean(existing?.active) && !current,
    scopes: scopes.length,
    environments: environments.length,
  });
  const name = companies.results.find((c) => c.id === companyId)?.name ?? current?.name;
  // Produção is offered on the hosted site while the company's fiscal capture is released.
  const offered = useQuery(
    api.projects.offeredEnvironments,
    companyId
      ? {
          organizationId: org.id,
          projectId: project.id,
          companyId: companyId as Id<"companies">,
        }
      : "skip",
  ) ?? [project.deploymentEnvironment];
  const releasedProduction =
    project.deploymentEnvironment !== "production" && offered.includes("production");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocker) return;
    selection.setSaved("");
    await run(async () => {
      await grant({
        organizationId: org.id,
        projectId: project.id,
        companyId: companyId as Id<"companies">,
        scopes,
        environments,
        expectedVersion: existing?.version ?? 0,
      });
      // The parent survives the remount caused by the new access version.
      selection.select(companyId);
      selection.setSaved(`Concessão salva${name ? ` para ${name}` : ""}.`);
    });
  }
  return (
    <form className="ui-form" onSubmit={save} aria-busy={busy}>
      <FormField id="grant-company" label="Empresa">
        <Select
          id="grant-company"
          value={companyId}
          required
          disabled={busy || project.state !== "active"}
          onChange={(e) => {
            selection.setSaved("");
            selection.select(e.target.value);
          }}
        >
          <option value="">Selecione uma empresa</option>
          {companyId && !companies.results.some((c) => c.id === companyId) && (
            <option value={companyId}>{name ?? "Empresa selecionada"}</option>
          )}
          {companies.results.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.id === current?.companyId ? " · já concedida" : ""}
            </option>
          ))}
        </Select>
      </FormField>
      <div>
        <More status={companies.status} loadMore={companies.loadMore} />
      </div>
      {companies.status === "Exhausted" && !companies.results.length && (
        <Callout tone="info">
          Nenhuma empresa disponível para conceder. Cadastre uma empresa na página Empresas.
        </Callout>
      )}
      <ScopePicker
        legend="O que o aplicativo pode fazer"
        allowed={project.grantableScopes}
        selected={scopes}
        onChange={setScopes}
      />
      <fieldset className="gestao-fieldset">
        <legend>Ambientes</legend>
        <div className="gestao-choices">
          {integrationEnvironments.map((env) => {
            const unavailable = !offered.includes(env);
            return (
              <Checkbox
                key={env}
                label={`${environmentLabel[env]}${unavailable ? " · indisponível neste ambiente da plataforma" : ""}`}
                checked={environments.includes(env)}
                // A saved value stays removable; a new one cannot be added where it would not work.
                disabled={unavailable && !environments.includes(env)}
                onChange={(e) =>
                  setEnvironments(
                    e.target.checked
                      ? [...environments, env]
                      : environments.filter((s) => s !== env),
                  )
                }
              />
            );
          })}
        </div>
        <p className="gestao-help">
          {releasedProduction
            ? "A empresa ativou a Captura fiscal (Produção): ali, o aplicativo lê os documentos capturados, acompanha a captura e recebe webhooks. Importação e emissão continuam só no Sandbox."
            : `Esta instalação atende só ${environmentLabel[project.deploymentEnvironment]}. Chamadas em outro ambiente são recusadas pela API.`}
        </p>
      </fieldset>
      <Feedback error={error} />
      <div className="gestao-submit">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel="Salvando…"
          disabled={Boolean(blocker)}
          aria-describedby={blocker ? "grant-blocker" : undefined}
        >
          Salvar concessão
        </Button>
        <div role="status">
          {blocker ? <DisabledReason id="grant-blocker">{blocker}</DisabledReason> : null}
        </div>
      </div>
    </form>
  );
}
