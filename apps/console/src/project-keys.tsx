import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAction, useMutation } from "convex/react";
import { usePaginatedQuery } from "./convex-query";
import type { FunctionReturnType } from "convex/server";
import {
  maxKeyCompanies,
  type IntegrationEnvironment,
  type IntegrationScope,
} from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import type { Organization } from "./organizations";
import { Feedback, SectionLink } from "./project-sections";
import { OneTimeSecret, ScopePicker, scopeNames } from "./integration-controls";
import { useAsyncAction, useSecretOnce } from "./async-action";
import { formatDateTime } from "./format";
import { More } from "./load-more";
import { Button } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { Checkbox, FormField, Input, Select, controlProps } from "./ui/form";
import { Card, DisabledReason, EmptyState, StatusBadge, type Tone } from "./ui/layout";
import {
  type Props,
  type Project,
  type Grant,
  errorText,
  Loading,
  text,
  environmentLabel,
} from "./project-common";
import { useProductEnvironment } from "./product-environment";

type Key = FunctionReturnType<typeof api.keys.list>["page"][number];
function datetime(ms: number) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
/** Why "Criar chave" is unavailable. */
export function createKeyBlocker(input: { projectActive: boolean; grants: number }) {
  if (!input.projectActive) return "Reative o projeto em Empresas e acesso para criar chaves.";
  if (!input.grants) return "Conceda uma empresa ao projeto em Empresas e acesso antes.";
  return "";
}
export function Keys({
  org,
  contextKey,
  project,
  grants,
}: Props & { project: Project; grants: Grant[] }) {
  const keys = usePaginatedQuery(
    api.keys.list,
    { organizationId: org.id, projectId: project.id, contextKey },
    { initialNumItems: 20 },
  );
  const [form, setForm] = useState<Key | "new" | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const revoke = useMutation(api.keys.revoke);
  const blocker = createKeyBlocker({
    projectActive: project.state === "active",
    grants: grants.length,
  });
  const [now, setNow] = useState(Date.now);
  // Re-render when the next key expires, so the badge and the rotation reason follow the clock.
  const nextExpiry = Math.min(
    ...keys.results.map((k) => (k.expiresAt > now ? k.expiresAt : Infinity)),
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(nextExpiry - Date.now() + 1, 60_000)),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry, now]);
  async function remove(item: Key) {
    try {
      await revoke({ organizationId: org.id, projectId: project.id, keyId: item.id });
      return "";
    } catch (error) {
      return errorText(error);
    }
  }
  const columns: Array<Column<Key>> = [
    {
      key: "name",
      header: "Chave",
      primary: true,
      cell: (k) => (
        <span className="gestao-cell">
          <span>{k.name}</span>
          <span className="gestao-meta ui-mono">{k.prefix}…</span>
        </span>
      ),
    },
    {
      key: "access",
      header: "Acesso",
      cell: (k) => (
        <span className="gestao-cell">
          <span>{environmentLabel[k.environment]}</span>
          <span className="gestao-meta">
            {scopeNames(k.scopes)} · {k.companyIds.length} empresa(s)
          </span>
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expira em",
      cell: (k) => <span className="gestao-time">{formatDateTime(k.expiresAt)}</span>,
    },
    {
      key: "state",
      header: "Situação",
      cell: (k) => {
        const [tone, label] = keyState(k, k.expiresAt <= now);
        return <StatusBadge tone={tone}>{label}</StatusBadge>;
      },
    },
    {
      key: "actions",
      header: "Ações",
      cell: (k) => {
        if (k.revokedAt !== null)
          return <span className="gestao-meta">Revogada; não aceita chamadas.</span>;
        const reason = rotationBlocker(k, {
          projectActive: project.state === "active",
          expired: k.expiresAt <= now,
        });
        return (
          <div className="ui-stack">
            <div className="ui-actions">
              <Button
                size="sm"
                disabled={Boolean(reason)}
                aria-describedby={reason ? `rotation-${k.id}` : undefined}
                onClick={() => setForm(k)}
              >
                {"Rotacionar "}
                <span className="ui-visually-hidden">{k.name}</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                {"Revogar "}
                <span className="ui-visually-hidden">{k.name}</span>
              </Button>
            </div>
            {reason ? <DisabledReason id={`rotation-${k.id}`}>{reason}</DisabledReason> : null}
          </div>
        );
      },
    },
  ];
  return (
    <>
      {form && (
        <KeyForm
          key={form === "new" ? "new" : form.id}
          org={org}
          project={project}
          grants={grants}
          previous={form === "new" ? undefined : form}
          close={() => setForm(null)}
        />
      )}
      <div ref={listRef} tabIndex={-1}>
        <Card
          title="Chaves de API"
          description="Por padrão, a chave herda as empresas e os escopos concedidos ao projeto; você pode restringir. O segredo aparece uma vez."
          actions={
            <Button
              variant="primary"
              icon="plus"
              disabled={Boolean(blocker)}
              aria-describedby={blocker ? "create-key-blocker" : undefined}
              onClick={() => setForm("new")}
            >
              Criar chave
            </Button>
          }
          flush
        >
          {blocker ? (
            <div className="gestao-body">
              <DisabledReason id="create-key-blocker">
                {blocker}{" "}
                <SectionLink org={org} projectId={project.id} section="projects">
                  Abrir Empresas e acesso
                </SectionLink>
              </DisabledReason>
            </div>
          ) : null}
          {keys.status === "LoadingFirstPage" ? (
            <div className="gestao-body">
              <Loading label="Carregando as chaves…" />
            </div>
          ) : (
            <DataTable
              label="Chaves de API"
              columns={columns}
              rows={keys.results}
              rowKey={(k) => k.id}
              empty={
                <EmptyState
                  icon="code"
                  headingLevel={3}
                  title="Nenhuma chave criada neste projeto."
                  description="Crie a primeira chave para o aplicativo chamar a API."
                />
              }
            />
          )}
          <div className="gestao-footer">
            <More status={keys.status} loadMore={keys.loadMore} />
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revogar ${revoking?.name ?? "a chave"}?`}
        description="Novas chamadas com esta chave são recusadas assim que a revogação for confirmada. A revogação não pode ser desfeita."
        confirmLabel="Confirmar revogação"
        cancelLabel="Manter chave"
        busyLabel="Revogando…"
        onConfirm={() => (revoking ? remove(revoking) : Promise.resolve(""))}
        returnFocusTo={() => listRef.current}
      />
    </>
  );
}
/** The key's situation, in words: the color only repeats it. */
export function keyState(item: Key, expired: boolean): [Tone, string] {
  if (item.revokedAt !== null) return ["neutral", "Revogada"];
  if (item.projectInvalidated) return ["danger", "Invalidada pelo projeto"];
  if (expired) return ["neutral", "Expirada"];
  if (item.concessionsChanged) return ["warning", "Concessões alteradas"];
  if (item.rotatedAt !== null) return ["info", "Em coexistência"];
  return ["success", "Criada"];
}
type KeyCompany = { name: string; missing: readonly IntegrationScope[] };
/** Why "Gerar chave"/"Confirmar rotação" is unavailable. The server applies the same rule. */
export function keyBlocker(input: {
  projectActive: boolean;
  companies: readonly KeyCompany[];
  scopes: number;
}) {
  if (!input.projectActive) return "Reative o projeto para gerar chaves.";
  if (!input.companies.length) return "Selecione pelo menos uma empresa.";
  if (input.companies.length > maxKeyCompanies)
    return `Selecione até ${maxKeyCompanies} empresas por chave.`;
  if (!input.scopes) return "Marque pelo menos um escopo.";
  const lacking = input.companies.find((c) => c.missing.length);
  if (lacking)
    return `${lacking.name} não tem concedido: ${scopeNames(lacking.missing)}. Desmarque esses escopos ou a empresa, ou amplie a concessão em Empresas e acesso.`;
  return "";
}
/** Companies and scopes a key starts with: everything the project grants in that environment. */
export function inheritedKeyAccess(
  grants: readonly Pick<Grant, "companyId" | "scopes">[],
  offered: readonly IntegrationScope[],
) {
  return {
    companyIds: grants.map((g) => g.companyId),
    // A key scope must be granted for every company of the key.
    scopes: grants.length ? offered.filter((s) => grants.every((g) => g.scopes.includes(s))) : [],
  };
}
export function KeyForm({
  org,
  project,
  grants,
  previous,
  close,
}: {
  org: Organization;
  project: Project;
  grants: Grant[];
  previous?: Key;
  close: () => void;
}) {
  const create = useAction(api.keys.create),
    rotate = useAction(api.keys.rotate);
  const { secret, discard, receive } = useSecretOnce();
  // Rotation keeps the same companies at most; a new key lists every granted company.
  const listed = previous
    ? grants.filter((g) => previous.companyIds.includes(g.companyId))
    : grants;
  function companyReason(g: Grant, env: IntegrationEnvironment) {
    if (!g.environments.includes(env))
      return `Sem acesso em ${environmentLabel[env]} neste projeto.`;
    // A new key reaches Produção on the hosted site only while the fiscal capture is released.
    if (!previous && !g.offeredEnvironments.includes(env))
      return `${environmentLabel[env]} indisponível para esta empresa neste ambiente da plataforma.`;
    if (previous && !previous.currentCompanyIds.includes(g.companyId))
      return "A concessão mudou depois da criação da chave; não entra na rotação.";
    return "";
  }
  function offeredFor(env: IntegrationEnvironment) {
    const usable = listed.filter((g) => !companyReason(g, env));
    return {
      usable,
      scopes: project.grantableScopes.filter(
        (s) =>
          usable.some((g) => g.scopes.includes(s)) && (!previous || previous.scopes.includes(s)),
      ),
    };
  }
  // A new key is born in the environment chosen in the shell (ADR 0007, §1); a rotation keeps
  // the previous key's. The other environment is another switch in the shell, never a field.
  const consoleEnvironment = useProductEnvironment().environment;
  const environment: IntegrationEnvironment =
    previous?.environment ??
    (project.deploymentEnvironment === "production" ? "production" : consoleEnvironment);
  const [initial] = useState(() => {
    const { usable, scopes } = offeredFor(environment);
    return inheritedKeyAccess(usable, scopes);
  });
  const [scopes, setScopes] = useState<IntegrationScope[]>(initial.scopes),
    [companyIds, setCompanyIds] = useState<Id<"companies">[]>(initial.companyIds);
  const { busy, error, run } = useAsyncAction(errorText);
  const offered = offeredFor(environment);
  const chosen = listed
    .filter((g) => companyIds.includes(g.companyId))
    .map((g) => ({ ...g, missing: scopes.filter((s) => !g.scopes.includes(s)) }));
  const blocker = keyBlocker({
    projectActive: project.state === "active",
    companies: chosen,
    scopes: scopes.length,
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocker) return;
    const form = new FormData(event.currentTarget);
    const args = {
      organizationId: org.id,
      projectId: project.id,
      name: text(form, "name"),
      scopes,
      companyIds,
      environment,
      expiresAt: new Date(text(form, "expires")).getTime(),
    };
    await run(() =>
      receive(async () => {
        const result = await (previous
          ? rotate({
              ...args,
              keyId: previous.id,
              overlapMs: Number(text(form, "overlap")) * 3600_000,
            })
          : create(args));
        return result.secretOnce;
      }),
    );
  }
  // Produção opens on the hosted site for a granted company whose fiscal capture is released.
  const environmentOpen = (env: IntegrationEnvironment) =>
    env === project.deploymentEnvironment || offeredFor(env).usable.length > 0;
  return (
    <Card
      title={previous ? `Rotacionar ${previous.name}` : "Nova chave"}
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
          id="secret-once"
          label="Segredo da chave"
          value={secret}
          created={previous ? "Chave substituta criada." : "Chave criada."}
          onDone={() => {
            discard();
            close();
          }}
        />
      ) : (
        <form className="ui-form" onSubmit={submit} aria-busy={busy}>
          <div className="gestao-grid gestao-grid--even">
            <FormField id="key-name" label="Nome da chave">
              <Input
                id="key-name"
                name="name"
                required
                maxLength={100}
                defaultValue={previous?.name}
                disabled={busy}
              />
            </FormField>
            <FormField
              id="key-environment"
              label="Ambiente da chave"
              help={
                previous
                  ? "A rotação mantém o ambiente da chave anterior."
                  : project.deploymentEnvironment === "production"
                    ? "A chave vale para um único ambiente."
                    : environment === "production"
                      ? "A chave nasce em Produção, o ambiente escolhido na lateral: só as empresas com a captura fiscal ativada, para documentos capturados, captura e webhooks."
                      : "A chave nasce no Sandbox, o ambiente escolhido na lateral. Para uma chave de Produção, troque o ambiente na lateral."
              }
            >
              <Select
                {...controlProps("key-environment", undefined, true)}
                value={environment}
                disabled
              >
                <option value={environment}>
                  {environmentLabel[environment]}
                  {!environmentOpen(environment) ? " · indisponível neste ambiente" : ""}
                </option>
              </Select>
            </FormField>
          </div>
          <ScopePicker
            legend={previous ? "Escopos da chave substituta" : "Escopos da chave"}
            allowed={offered.scopes}
            selected={scopes}
            onChange={setScopes}
            disabled={busy}
          />
          <fieldset className="gestao-fieldset" disabled={busy}>
            <legend>Empresas da chave</legend>
            {listed.length ? (
              <div className="gestao-choices">
                {listed.map((g) => {
                  const reason = companyReason(g, environment);
                  const selected = chosen.find((c) => c.companyId === g.companyId);
                  const note = reason
                    ? reason
                    : selected?.missing.length
                      ? `Falta concessão: ${scopeNames(selected.missing)}.`
                      : "";
                  return (
                    <div className="gestao-choice" key={g.companyId}>
                      <Checkbox
                        label={g.name}
                        checked={companyIds.includes(g.companyId)}
                        disabled={Boolean(reason)}
                        aria-describedby={note ? `key-company-${g.companyId}` : undefined}
                        onChange={(e) =>
                          setCompanyIds(
                            e.target.checked
                              ? [...companyIds, g.companyId]
                              : companyIds.filter((id) => id !== g.companyId),
                          )
                        }
                      />
                      {note ? (
                        <p id={`key-company-${g.companyId}`} className="ui-help">
                          {note}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="gestao-help">
                Nenhuma empresa desta chave continua concedida ao projeto.
              </p>
            )}
          </fieldset>
          <div className="gestao-grid gestao-grid--even">
            <FormField id="key-expires" label="Expira em">
              <Input
                id="key-expires"
                name="expires"
                type="datetime-local"
                required
                defaultValue={datetime(previous?.expiresAt ?? Date.now() + 30 * 86400_000)}
                max={previous ? datetime(previous.expiresAt) : undefined}
                disabled={busy}
              />
            </FormField>
            {previous && (
              <FormField
                id="key-overlap"
                label="Coexistência da chave anterior"
                help="O prazo respeita a expiração anterior. Atualize a chave no aplicativo consumidor antes do fim da janela."
              >
                <Select
                  {...controlProps("key-overlap", undefined, true)}
                  name="overlap"
                  defaultValue="0"
                  disabled={busy}
                >
                  <option value="0">Substituir imediatamente</option>
                  <option value="1">Até 1 hora</option>
                  <option value="24">Até 24 horas</option>
                </Select>
              </FormField>
            )}
          </div>
          <Feedback error={error} />
          <div className="gestao-submit">
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              loadingLabel="Gerando…"
              disabled={Boolean(blocker)}
              aria-describedby={blocker ? "key-blocker" : undefined}
            >
              {previous ? "Confirmar rotação" : "Gerar chave"}
            </Button>
            <div role="status">
              {blocker ? <DisabledReason id="key-blocker">{blocker}</DisabledReason> : null}
            </div>
          </div>
        </form>
      )}
    </Card>
  );
}
/** Why "Rotacionar" is unavailable for a key that still exists. */
export function rotationBlocker(
  item: Pick<Key, "revokedAt" | "rotatedAt" | "projectInvalidated" | "rotationAvailable">,
  input: { projectActive: boolean; expired: boolean },
) {
  if (item.revokedAt !== null) return "Chave revogada.";
  if (item.projectInvalidated)
    return "A desativação do projeto invalidou esta chave. Crie uma chave nova.";
  if (!input.projectActive) return "Reative o projeto para rotacionar chaves.";
  if (input.expired) return "Chave expirada. Crie uma chave nova.";
  if (item.rotatedAt !== null) return "Esta chave já foi rotacionada; rotacione a substituta.";
  if (!item.rotationAvailable)
    return "As concessões atuais não cobrem mais nenhuma empresa ou escopo desta chave. Crie uma chave nova.";
  return "";
}
