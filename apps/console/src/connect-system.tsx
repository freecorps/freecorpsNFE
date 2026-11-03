import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  releasedProductionScopes,
  type IntegrationEnvironment,
  type IntegrationScope,
} from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { usePaginatedQuery, useQuery } from "./convex-query";
import { useAsyncAction, useSecretOnce } from "./async-action";
import { OneTimeSecret, ScopePicker, scopeLabels } from "./integration-controls";
import {
  quickstartCompanies,
  quickstartEnvironment,
  quickstartScopes,
} from "./developer-quickstart";
import { keyState } from "./project-keys";
import { SectionLink } from "./project-sections";
import { suggestSlug, type Organization } from "./organizations";
import { UsageErrorNotice } from "./usage-errors";
import { useProductEnvironment } from "./product-environment";
import { More } from "./load-more";
import { Button } from "./ui/button";
import { RadioCard } from "./ui/choice";
import { Checkbox, FormField, Input, Select, controlProps } from "./ui/form";
import { Icon } from "./ui/icons";
import { Callout, Card, DisabledReason, Page, PageHeader, StatusBadge } from "./ui/layout";
import {
  type Grant,
  type Project,
  type Props,
  Loading,
  environmentLabel,
  errorText,
  text,
} from "./project-common";

// "Conectar meu sistema" (#512): project, company grants and a key in one guided path, through the
// same mutations as the separate screens. Only the project id goes in the address; every step is
// derived from what the server already holds, so resuming never creates a second project and a
// saved grant only changes after the person confirms the exact difference.

type Key = FunctionReturnType<typeof api.keys.list>["page"][number];
type Candidate = FunctionReturnType<typeof api.projects.grantCandidates>["page"][number];
type Env = IntegrationEnvironment;
type Scopes = readonly IntegrationScope[];
export type Preset = { id: string; title: string; scopes: Scopes };
const presets: readonly Preset[] = [
  {
    id: "import",
    title: "Importar XML e consultar documentos",
    scopes: ["companies:read", "documents:import", "documents:read"],
  },
  {
    id: "import-webhooks",
    title: "Importar, consultar e receber webhooks",
    scopes: ["companies:read", "documents:import", "documents:read", "webhooks:manage"],
  },
  { id: "read", title: "Só consultar documentos", scopes: ["companies:read", "documents:read"] },
  {
    id: "read-webhooks",
    title: "Consultar documentos e receber webhooks",
    scopes: ["companies:read", "documents:read", "webhooks:manage"],
  },
];
/** Presets whose every scope is in `allowed`; a developer never sees one with import. */
export function presetsFor(allowed: Scopes) {
  return presets.filter((p) => p.scopes.every((s) => allowed.includes(s)));
}
const covers = (held: readonly string[], wanted: readonly string[]) =>
  wanted.every((x) => held.includes(x));
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && covers(a, b);
const companies = (n: number) => (n === 1 ? "1 empresa" : `${n} empresas`);
/** Scopes the role may grant that the environment actually serves in this deployment. */
export function servedScopes(deployment: Env, environment: Env, grantable: Scopes) {
  return environment === deployment
    ? [...grantable]
    : grantable.filter((s) => (releasedProductionScopes as Scopes).includes(s));
}
type Target = { companyId: Id<"companies">; name: string };
type SavedGrant = Pick<Grant, "companyId" | "name" | "scopes" | "environments" | "version">;
export type GrantStep =
  | { kind: "covered"; target: Target }
  | {
      kind: "new" | "change";
      target: Target;
      scopes: IntegrationScope[];
      environments: Env[];
      added: { scopes: IntegrationScope[]; environments: Env[] };
      /** The saved version the mutation must still find; a change is refused with GRANT_CHANGED. */
      expectedVersion: number;
    };
/**
 * What each chosen company needs for a key with `scopes` in `environment`. A saved grant that
 * already covers it stays untouched; otherwise the proposal keeps everything it holds and only
 * adds (`grantCompany` replaces the lists, so sending only the preset would take access away from
 * other keys). `savedVersion` is the version of a removed grant (`projects.grantCandidates`).
 */
export function grantSteps(
  targets: readonly Target[],
  grants: readonly Omit<SavedGrant, "name">[],
  scopes: Scopes,
  environment: Env,
  savedVersion: (companyId: string) => number,
): GrantStep[] {
  return targets.map((target) => {
    const saved = grants.find((g) => g.companyId === target.companyId);
    const missing = scopes.filter((s) => !saved?.scopes.includes(s));
    const envMissing = saved?.environments.includes(environment) ? [] : [environment];
    if (saved && !missing.length && !envMissing.length) return { kind: "covered", target };
    return {
      kind: saved ? "change" : "new",
      target,
      scopes: [...(saved?.scopes ?? []), ...missing],
      environments: [...(saved?.environments ?? []), ...envMissing],
      added: { scopes: missing, environments: envMissing },
      expectedVersion: saved ? saved.version : savedVersion(target.companyId),
    };
  });
}
/** A key the app can use as created: not revoked, expired, invalidated, rotated or narrowed. */
export const keyUsable = (k: Key, now: number) =>
  k.revokedAt === null &&
  !k.projectInvalidated &&
  k.expiresAt > now &&
  k.rotatedAt === null &&
  !k.concessionsChanged;
const newest = (keys: readonly Key[]) => [...keys].sort((a, b) => b.createdAt - a.createdAt)[0];
/** The newest usable key that reaches every chosen company with every chosen scope. */
export function matchingKey(
  keys: readonly Key[],
  choice: { environment: Env; scopes: Scopes; companyIds: readonly string[] },
  now: number,
) {
  return newest(
    keys.filter(
      (k) =>
        keyUsable(k, now) &&
        k.environment === choice.environment &&
        covers(k.scopes, choice.scopes) &&
        covers(k.companyIds, choice.companyIds),
    ),
  );
}
/** The preset that is exactly `scopes`, else "Escolher uma a uma"; nothing chosen: the first. */
function presetChoice(scopes: Scopes, allowed: Scopes) {
  const offered = presetsFor(allowed);
  const preset = scopes.length ? offered.find((p) => sameSet(p.scopes, scopes)) : offered[0];
  return { presetId: preset?.id ?? "custom", scopes: preset ? [...preset.scopes] : [...scopes] };
}
/**
 * Where a resumed setup starts: the environment the project already uses when that is
 * unambiguous, the newest usable key's access (else the saved grants'), never a scope the role
 * cannot grant or the environment does not serve, and a preset only when it is exactly that.
 */
export function resumeChoice(input: {
  grants: readonly SavedGrant[];
  keys: readonly Key[];
  grantable: Scopes;
  deployment: Env;
  now: number;
  /** The console's environment (ADR 0007, §1): the setup happens in it, whatever was used. */
  environment?: Env;
}) {
  const usable = input.keys.filter((k) => keyUsable(k, input.now));
  const used = new Set<Env>([
    ...input.grants.flatMap((g) => g.environments),
    ...usable.map((k) => k.environment),
  ]);
  const keyEnvironments = new Set(usable.map((k) => k.environment));
  const environment: Env =
    input.environment ??
    (used.size === 1
      ? [...used][0]!
      : keyEnvironments.size === 1
        ? [...keyEnvironments][0]!
        : input.deployment);
  const granted = input.grants.filter((g) => g.environments.includes(environment));
  const key = newest(
    usable.filter(
      (k) =>
        k.environment === environment &&
        k.companyIds.some((id) => granted.some((g) => g.companyId === id)),
    ),
  );
  const chosen = key ? granted.filter((g) => key.companyIds.includes(g.companyId)) : granted;
  const held = key
    ? key.scopes
    : chosen.length
      ? chosen[0]!.scopes.filter((s) => chosen.every((g) => g.scopes.includes(s)))
      : [];
  const allowed = servedScopes(input.deployment, environment, input.grantable);
  const scopes = held.filter((s) => allowed.includes(s));
  return {
    environment,
    // Saved companies with nothing in common: the person chooses, nothing is assumed.
    ...(chosen.length && !scopes.length
      ? { presetId: "custom", scopes: [] }
      : presetChoice(scopes, allowed)),
    targets: chosen.map((g) => ({ companyId: g.companyId, name: g.name })),
  };
}
/**
 * Environments the person can pick: the deployment's and, on the hosted Sandbox, Produção while
 * some company offers it (`offers[i]` is undefined while that company is still loading).
 */
export function environmentChoices(
  deployment: Env,
  offers: readonly (readonly Env[] | undefined)[],
  /** More companies wait on another page: absence among the loaded ones proves nothing. */
  morePages = false,
): Array<{ environment: Env; reason: string }> {
  if (deployment === "production") return [{ environment: "production", reason: "" }];
  const production = offers.some((o) => o?.includes("production"))
    ? ""
    : offers.some((o) => o === undefined)
      ? "Conferindo quais empresas têm Produção…"
      : morePages
        ? "Nenhuma empresa carregada tem a Captura fiscal liberada. Carregue mais empresas para conferir as demais."
        : "Indisponível: nenhuma empresa tem a Captura fiscal liberada, a única forma de Produção nesta instalação.";
  return [
    { environment: "sandbox", reason: "" },
    { environment: "production", reason: production },
  ];
}
/** Active companies a project may reach; `projects.grantCompany` refuses the next one. */
export const maxProjectCompanies = 50;
/** The step plan: why "Conceder acesso" and "Gerar chave" wait, and which step is current. */
export function connectPlan(input: {
  projectActive: boolean;
  targets: readonly Target[];
  scopes: Scopes;
  environment: Env;
  /** What the role may grant, and what this environment serves of it (`servedScopes`). */
  grantable: Scopes;
  served: Scopes;
  steps: readonly GrantStep[];
  /** Environments each company offers now; absent while still loading. */
  offers: Readonly<Record<string, readonly Env[] | undefined>>;
  /** Saved grant version of each company; absent while still loading. */
  versions: Readonly<Record<string, number | undefined>>;
  confirmed: boolean;
  key: Key | undefined;
  /** More key pages still to read before saying that no key matches. */
  keysPending: boolean;
  secretShown: boolean;
  /** Companies with an active grant in the project, against the 50-company limit. */
  activeGrants: number;
  /** Every page of grantable companies has been read: a company still unknown has no access. */
  companiesSettled: boolean;
}) {
  const pending = input.steps.filter((s) => s.kind !== "covered");
  const offer = (t: Target) => input.offers[t.companyId];
  // A grant holding a scope beyond the role is refused whole by the server (SCOPE_DENIED).
  const beyondRole = pending.find((s) => !covers(input.grantable, s.scopes));
  const unserved = input.scopes.filter((s) => !input.served.includes(s));
  const withdrawn = input.targets.find(
    (t) => offer(t) !== undefined && !offer(t)!.includes(input.environment),
  );
  // A chosen company the lists no longer show: access lost, grant removed, or a later page.
  const unknown = pending.find((s) => offer(s.target) === undefined);
  const loading = pending.some(
    (s) => s.kind === "new" && input.versions[s.target.companyId] === undefined,
  );
  const added = pending.filter((s) => s.kind === "new").length;
  const unavailable = (t: Target) =>
    `${environmentLabel[input.environment]} não está disponível para ${t.name}: a Captura fiscal dela não está liberada. Desmarque a empresa ou escolha outro ambiente.`;
  const blocker = !input.projectActive
    ? "Reative o projeto em Empresas e acesso para conceder empresas e gerar chaves."
    : !input.targets.length
      ? "Escolha pelo menos uma empresa."
      : !input.scopes.length
        ? "Marque pelo menos uma permissão."
        : unserved.length
          ? `${environmentLabel[input.environment]} não atende ${unserved.join(", ")} nesta instalação.`
          : beyondRole
            ? `${beyondRole.target.name} tem permissões que só um proprietário ou administrador pode alterar. Desmarque a empresa ou peça a um deles.`
            : unknown
              ? input.companiesSettled
                ? `Você não tem mais acesso a ${unknown.target.name}, ou a concessão foi removida. Desmarque a empresa para continuar.`
                : `Carregue mais empresas abaixo para conferir ${unknown.target.name}, ou desmarque a empresa.`
              : withdrawn && pending.some((s) => s.target.companyId === withdrawn.companyId)
                ? unavailable(withdrawn)
                : input.activeGrants + added > maxProjectCompanies
                  ? `Um projeto alcança até ${maxProjectCompanies} empresas. Ele já tem ${input.activeGrants}, e esta concessão somaria ${added}. Desmarque empresas ou use outro projeto.`
                  : loading
                    ? "Conferindo as empresas escolhidas…"
                    : pending.some((s) => s.kind === "change") && !input.confirmed
                      ? "Confirme as alterações nas concessões salvas."
                      : "";
  const accessDone = Boolean(input.targets.length && input.scopes.length && !pending.length);
  // A saved grant may name Produção after the release was withdrawn: no new key there.
  const keyBlocker = !input.projectActive
    ? "Reative o projeto em Empresas e acesso para gerar chaves."
    : withdrawn
      ? unavailable(withdrawn)
      : "";
  const keyDone = accessDone && Boolean(input.key) && !input.secretShown;
  return {
    pending,
    blocker,
    /** A difference the person may confirm: never one the server would refuse. */
    confirmable: !beyondRole && !unserved.length,
    accessDone,
    keyBlocker,
    keyChecking: accessDone && !input.key && input.keysPending,
    keyDone,
    current: !accessDone ? 1 : !keyDone ? 2 : 3,
  };
}
export type FirstCall = { quickstart: true } | { quickstart: false; message: string; href: string };
/**
 * What the key itself can do first: the console's import of the synthetic XML (only for the
 * demonstration company, in Sandbox), or what is missing and which guide to follow.
 */
export function firstCallFor(
  key: Pick<Key, "environment" | "scopes" | "companyIds">,
  grants: readonly Pick<Grant, "companyId" | "kind" | "scopes" | "environments">[],
  deployment: Env,
  grantable: Scopes,
): FirstCall {
  if (key.environment !== deployment)
    return {
      quickstart: false,
      href: "/docs/captura-nfe",
      message: key.scopes.includes("documents:read")
        ? "Em Produção, a chave lê os documentos capturados; a importação fica no Sandbox. Siga o guia da captura."
        : "A chave não tem documents:read e não lê os documentos capturados. Escolha permissões de consulta no passo 2 e gere outra chave.",
    };
  const missing = quickstartScopes.filter((s) => !key.scopes.includes(s));
  if (missing.length)
    return {
      quickstart: false,
      href: deployment === quickstartEnvironment ? "/docs/primeira-chamada" : "/docs/importar-xml",
      message: missing.every((s) => grantable.includes(s))
        ? `A primeira importação precisa de ${missing.join(" e ")}, que esta chave não tem. Escolha permissões com importação no passo 2 e gere outra chave.`
        : `A primeira importação precisa de ${missing.join(" e ")}, que só proprietários e administradores concedem. Peça a um deles; o guia mostra o que esta chave já permite.`,
    };
  if (deployment !== quickstartEnvironment)
    return {
      quickstart: false,
      href: "/docs/importar-xml",
      message:
        "A primeira chamada da aba usa o Sandbox, que esta instalação não atende. Importe um XML da sua empresa seguindo o guia de importação.",
    };
  const reachable = quickstartCompanies(grants.filter((g) => key.companyIds.includes(g.companyId)));
  if (reachable.some((g) => g.kind === "demonstration")) return { quickstart: true };
  return {
    quickstart: false,
    href: "/docs/importar-xml",
    message: reachable.length
      ? "O XML sintético da aba Primeira chamada só vale para a empresa de demonstração, que não está nesta chave. Importe um XML da sua empresa seguindo o guia."
      : "Nenhuma empresa da chave tem documents:import e documents:read em Sandbox. Confira Empresas e acesso.",
  };
}
/** The local clock, refreshed each minute and when the window regains focus. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  return now;
}
/** Projects just created (false) or reopened (true) in this tab, read once after navigating. */
const arrivals = new Map<string, boolean>();

/** Failure of a step: plan and quota refusals get the usage notice, others the console text. */
function useStepAction(org: Organization) {
  const action = useAsyncAction(errorText);
  const [failure, setFailure] = useState<unknown>(null);
  function run(work: (current: () => boolean) => Promise<unknown>) {
    return action.run(async (current) => {
      try {
        return await work(current);
      } catch (error) {
        setFailure(error);
        throw error;
      }
    });
  }
  const notice = action.error ? (
    <UsageErrorNotice error={failure} org={org} fallback={action.error} />
  ) : null;
  return { busy: action.busy, run, notice };
}
type StepAction = ReturnType<typeof useStepAction>;

const stepTitles = ["Projeto", "Empresas e permissões", "Chave de API", "Primeira chamada"];
function Progress({ current, notes }: { current: number; notes: ReactNode[] }) {
  return (
    <Card title="Etapas" description="O progresso vem do que já está salvo no servidor.">
      <ol className="home-steps">
        {stepTitles.map((title, index) => {
          const done = index < current;
          return (
            <li
              key={title}
              className={done ? "is-done" : index > current ? "is-later" : undefined}
              aria-current={index === current ? "step" : undefined}
            >
              <span className="home-step-index" aria-hidden="true">
                {done ? <Icon name="check" /> : index + 1}
              </span>
              <div>
                <p className="home-item__title">
                  {title}
                  <StatusBadge tone={done ? "success" : index === current ? "info" : "neutral"}>
                    {done ? "Concluída" : index === current ? "Agora" : "Depois"}
                  </StatusBadge>
                </p>
                {notes[index] ? <p className="home-item__note">{notes[index]}</p> : null}
              </div>
              <span />
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
/**
 * Follows the current step. After the person's own action (`expectStep`), focus goes to the new
 * step's heading; a change that comes from elsewhere (a key expiring, another tab) is announced
 * only in the polite region, which is always rendered so the text change is heard.
 */
function useStepFocus(current: number, focusOnMount: boolean) {
  const heading = useRef<HTMLHeadingElement>(null),
    previous = useRef(current),
    expected = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  useEffect(() => {
    if (previous.current === current) return;
    previous.current = current;
    if (expected.current) {
      expected.current = false;
      heading.current?.focus();
    } else setAnnouncement(`Etapa ${current + 1} de 4 agora: ${stepTitles[current]}.`);
  }, [current]);
  return {
    heading,
    announcement,
    expectStep: () => {
      expected.current = true;
    },
  };
}
function ScopeList({ label, scopes }: { label: string; scopes: Scopes }) {
  return (
    <ul className="gestao-list" aria-label={label}>
      {scopes.map((s) => (
        <li key={s}>
          {/* One inline element: the list item is a grid and would split the text into rows. */}
          <span>
            {scopeLabels[s]} <code>{s}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConnectSystem({ org, contextKey, projectId }: Props & { projectId?: string }) {
  return (
    <Page>
      <PageHeader
        eyebrow="Integrações"
        title="Conectar meu sistema"
        description="Crie o projeto do aplicativo, conceda as empresas e gere a chave de API, até a primeira chamada. Você pode sair e voltar: o que já foi salvo continua aqui."
      />
      <div className="gestao-stack">
        {projectId ? (
          <ConnectProject org={org} contextKey={contextKey} projectId={projectId} />
        ) : (
          <>
            <Progress current={0} notes={[]} />
            <ProjectStep org={org} />
          </>
        )}
      </div>
    </Page>
  );
}

function ProjectStep({ org }: { org: Organization }) {
  const create = useMutation(api.projects.create),
    navigate = useNavigate();
  const { busy, run, notice } = useStepAction(org);
  const [name, setName] = useState(""),
    [reference, setReference] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async (current) => {
      const result = await create({
        organizationId: org.id,
        name: text(form, "name"),
        externalReference: text(form, "reference"),
      });
      if (!current()) return;
      arrivals.set(result.projectId, result.reused);
      // The id goes in the address so a reload or a later visit resumes this project.
      await navigate({
        to: "/app/$organizationSlug/developer/$developerSection/$projectId",
        params: {
          organizationSlug: org.slug,
          developerSection: "connect",
          projectId: result.projectId,
        },
        replace: true,
      });
    });
  }
  return (
    <Card
      title="1. Projeto"
      description="Um projeto por aplicativo que chama a API. As chaves pertencem a ele."
    >
      <form className="ui-form" onSubmit={submit} aria-busy={busy}>
        <FormField id="connect-name" label="Nome do aplicativo">
          <Input
            id="connect-name"
            name="name"
            required
            maxLength={100}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField
          id="connect-reference"
          label="Referência do aplicativo"
          help="Sugerida pelo nome; ajuste antes de criar. Ela não muda depois. A mesma referência com o mesmo nome reabre o projeto existente, sem criar outro."
        >
          <Input
            {...controlProps("connect-reference", undefined, true)}
            name="reference"
            required
            maxLength={80}
            value={reference ?? suggestSlug(name)}
            disabled={busy}
            onChange={(e) => setReference(e.target.value)}
          />
        </FormField>
        {notice}
        <div>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Criando…">
            Criar projeto e continuar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ConnectProject({ org, contextKey, projectId }: Props & { projectId: string }) {
  const project = useQuery(api.projects.get, { organizationId: org.id, projectId, contextKey });
  const [arrival] = useState(() => {
    const reused = arrivals.get(projectId);
    arrivals.delete(projectId);
    return reused;
  });
  if (project === undefined) return <Loading />;
  if (!project)
    return (
      <Callout
        tone="warning"
        title="Projeto indisponível."
        headingLevel={2}
        actions={
          <Link
            className="ui-link"
            to="/app/$organizationSlug/developer/$developerSection"
            params={{ organizationSlug: org.slug, developerSection: "connect" }}
          >
            Começar com um projeto novo
          </Link>
        }
      >
        O projeto não existe nesta organização ou você não tem acesso a ele. Confira o endereço ou a
        organização selecionada.
      </Callout>
    );
  return (
    <>
      {arrival ? (
        <Callout tone="info">
          Já existia um projeto com este nome e esta referência. Ele foi reaberto, sem criar outro.
        </Callout>
      ) : null}
      <ConnectAccess
        org={org}
        contextKey={contextKey}
        project={project}
        arrived={arrival !== undefined}
      />
    </>
  );
}

type Paged<T> = {
  results: T[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (n: number) => void;
};
/**
 * The list as last loaded, while a fresh first page is on its way. It never crosses projects:
 * `ConnectSystem` is keyed by the project, so another project remounts it with a fresh ref.
 */
function useSettled<T>(list: Paged<T>): Paged<T> {
  const last = useRef(list);
  const reloading =
    list.status === "LoadingFirstPage" && last.current.status !== "LoadingFirstPage";
  // Remembered after commit: a render React discards never becomes the "last loaded" list.
  useEffect(() => {
    if (!reloading) last.current = list;
  });
  return reloading ? { ...last.current, loadMore: list.loadMore } : list;
}
function ConnectAccess({
  org,
  contextKey,
  project,
  arrived,
}: Props & { project: Project; arrived: boolean }) {
  const args = { organizationId: org.id, projectId: project.id, contextKey };
  // At most 50 companies per project: the first page is normally the whole list.
  const grants = usePaginatedQuery(api.projects.companies, args, { initialNumItems: 50 });
  const keys = usePaginatedQuery(api.keys.list, args, { initialNumItems: 20 });
  // One subscription for every company's offer and saved version, never one per company.
  const candidates = usePaginatedQuery(api.projects.grantCandidates, args, {
    initialNumItems: 50,
  });
  const { status: grantStatus, loadMore: moreGrants } = grants;
  useEffect(() => {
    if (grantStatus === "CanLoadMore") moreGrants(50);
  }, [grantStatus, moreGrants]);
  // Only the very first load shows a placeholder. A list that later starts over (a lost
  // connection, a page invalidated) keeps its last results, so the steps, and a secret on screen,
  // never unmount.
  const settled = {
    grants: useSettled(grants),
    keys: useSettled(keys),
    candidates: useSettled(candidates),
  };
  if (Object.values(settled).some((list) => list.status === "LoadingFirstPage"))
    return <Loading label="Conferindo o que já foi configurado…" />;
  return (
    <ConnectSteps
      org={org}
      project={project}
      grants={settled.grants.results}
      keys={settled.keys}
      candidates={settled.candidates}
      arrived={arrived}
    />
  );
}

function ConnectSteps({
  org,
  project,
  grants,
  keys,
  candidates,
  arrived,
}: {
  org: Organization;
  project: Project;
  grants: Grant[];
  keys: Paged<Key>;
  candidates: Paged<Candidate>;
  arrived: boolean;
}) {
  const now = useNow();
  const deployment = project.deploymentEnvironment,
    grantable = project.grantableScopes;
  // The setup happens in the environment chosen in the shell; switching it leaves this page.
  const consoleEnvironment = useProductEnvironment().environment;
  const environment: Env = deployment === "production" ? "production" : consoleEnvironment;
  const [initial] = useState(() =>
    resumeChoice({ grants, keys: keys.results, grantable, deployment, now, environment }),
  );
  const [presetId, setPresetId] = useState(initial.presetId),
    [scopes, setScopes] = useState<IntegrationScope[]>(initial.scopes),
    [targets, setTargets] = useState<Target[]>(initial.targets);
  const [confirmed, setConfirmed] = useState("");
  const secret = useSecretOnce();
  const grant = useMutation(api.projects.grantCompany);
  const apply = useStepAction(org),
    keyAction = useStepAction(org);
  // Offer and saved version come from the server lists: a removed grant never leaves a stale one.
  const offers: Record<string, readonly Env[]> = {},
    versions: Record<string, number> = {};
  for (const c of candidates.results) {
    offers[c.companyId] = c.offeredEnvironments;
    versions[c.companyId] = c.grantVersion;
  }
  for (const g of grants) {
    offers[g.companyId] = g.offeredEnvironments;
    versions[g.companyId] = g.version;
  }
  const served = servedScopes(deployment, environment, grantable);
  const steps = grantSteps(targets, grants, scopes, environment, (id) => versions[id] ?? 0);
  const signature = JSON.stringify(steps);
  const key = matchingKey(
    keys.results,
    { environment, scopes, companyIds: targets.map((t) => t.companyId) },
    now,
  );
  const plan = connectPlan({
    projectActive: project.state === "active",
    targets,
    scopes,
    environment,
    grantable,
    served,
    steps,
    offers,
    versions,
    confirmed: confirmed === signature,
    key,
    keysPending: keys.status !== "Exhausted",
    secretShown: Boolean(secret.secret),
    activeGrants: grants.length,
    companiesSettled: candidates.status === "Exhausted",
  });
  // Further key pages are read only while no matching key has been found.
  const { status: keyStatus, loadMore: moreKeys } = keys;
  const needMoreKeys = !key && keyStatus === "CanLoadMore";
  useEffect(() => {
    if (needMoreKeys) moreKeys(50);
  }, [needMoreKeys, moreKeys]);
  const listed = new Set<string>(candidates.results.map((c) => c.companyId));
  // A chosen company neither list shows stays visible, so it can always be unchecked.
  const missing = targets.filter(
    (t) => !listed.has(t.companyId) && !grants.some((g) => g.companyId === t.companyId),
  );
  // A resumed company beyond the loaded page stays visible, first, with its saved access.
  const rows: Candidate[] = [
    ...targets.flatMap((t) => {
      const g = listed.has(t.companyId)
        ? undefined
        : grants.find((x) => x.companyId === t.companyId);
      return g
        ? [
            {
              companyId: g.companyId,
              name: g.name,
              kind: g.kind,
              offeredEnvironments: g.offeredEnvironments,
              grantVersion: g.version,
            },
          ]
        : [];
    }),
    ...candidates.results,
  ];
  const choices = environmentChoices(
    deployment,
    rows.map((c) => offers[c.companyId]),
    candidates.status !== "Exhausted",
  );
  const changes = plan.pending.filter((s) => s.kind === "change");
  const step = useStepFocus(plan.current, arrived);
  // A secret on screen, or a key being made, belongs to these choices: they wait.
  const locked = apply.busy || keyAction.busy || Boolean(secret.secret);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (plan.blocker || !plan.pending.length) return;
    const failed = await apply.run(async (current) => {
      for (const s of plan.pending) {
        if (!current()) return;
        await grant({
          organizationId: org.id,
          projectId: project.id,
          companyId: s.target.companyId,
          scopes: s.scopes,
          environments: s.environments,
          expectedVersion: s.expectedVersion,
        });
      }
    });
    if (!failed) step.expectStep();
  }
  const first = key ? firstCallFor(key, grants, deployment, grantable) : null;
  const offered = presetsFor(grantable);
  return (
    <>
      <Progress
        current={plan.current}
        notes={[
          <>
            {project.name} · referência <span className="ui-mono">{project.externalReference}</span>
          </>,
          plan.accessDone
            ? `${companies(targets.length)} em ${environmentLabel[environment]}`
            : null,
          plan.keyDone && key ? `Chave ${key.name} ativa` : null,
          "Ainda não confirmada pelo console: rode a primeira chamada com a chave.",
        ]}
      />
      <div role="status" className="ui-visually-hidden">
        {step.announcement}
      </div>
      <Card
        title="2. Empresas e permissões"
        titleRef={plan.current === 1 ? step.heading : undefined}
        description="O que o aplicativo poderá fazer, com quais empresas e em qual ambiente. Uma concessão que já existe só muda depois da sua confirmação."
      >
        <form className="ui-form" onSubmit={save} aria-busy={apply.busy}>
          {secret.secret ? (
            <Callout tone="info">
              Guarde o segredo da chave antes de mudar as empresas ou as permissões.
            </Callout>
          ) : null}
          {choices.length > 1 ? (
            <>
              <p className="gestao-help">
                Ambiente: {environmentLabel[environment]}, o escolhido na lateral.{" "}
                {environment === "sandbox"
                  ? "Importação, consulta, emissão simulada e webhooks."
                  : "Só para empresas com a Captura fiscal liberada: documentos capturados, captura e webhooks."}
              </p>
              {choices.find((c) => c.environment === environment)?.reason ? (
                <Callout tone="warning">
                  {choices.find((c) => c.environment === environment)!.reason}
                </Callout>
              ) : null}
            </>
          ) : (
            <p className="gestao-help">
              Ambiente: {environmentLabel[deployment]}, o único que esta instalação atende.
            </p>
          )}
          <fieldset className="gestao-fieldset" disabled={locked}>
            <legend>Permissões</legend>
            <div className="ui-choice-group">
              {[...offered, { id: "custom", title: "Escolher uma a uma", scopes: [] }].map((p) => {
                const unserved = p.scopes.filter((s) => !served.includes(s));
                return (
                  <RadioCard
                    key={p.id}
                    name="connect-preset"
                    value={p.id}
                    label={p.title}
                    checked={presetId === p.id}
                    disabled={unserved.length > 0}
                    help={
                      unserved.length
                        ? `Indisponível em ${environmentLabel[environment]}: esta instalação não atende ${unserved.join(", ")} ali.`
                        : p.scopes.length
                          ? p.scopes.join(", ")
                          : "Entre as permissões que seu papel pode conceder neste ambiente."
                    }
                    onChange={() => {
                      setPresetId(p.id);
                      if (p.scopes.length) setScopes([...p.scopes]);
                    }}
                  />
                );
              })}
            </div>
            {offered.length < presets.length ? (
              <p className="gestao-help">
                Seu papel concede só leitura e webhooks; importação e emissão ficam com
                proprietários e administradores.
              </p>
            ) : null}
          </fieldset>
          {presetId === "custom" ? (
            <ScopePicker
              legend="Permissões escolhidas"
              allowed={served}
              selected={scopes}
              onChange={setScopes}
              disabled={locked}
            />
          ) : null}
          <div>
            <p className="gestao-help">Permissões que serão concedidas, exatamente:</p>
            <ScopeList label="Permissões que serão concedidas" scopes={scopes} />
          </div>
          <fieldset className="gestao-fieldset" disabled={locked}>
            <legend>Empresas</legend>
            {missing.length ? (
              <div className="gestao-choices">
                {missing.map((t) => (
                  <div className="gestao-choice" key={t.companyId}>
                    <Checkbox
                      label={t.name}
                      checked
                      aria-describedby={`connect-missing-${t.companyId}`}
                      onChange={() =>
                        setTargets(targets.filter((x) => x.companyId !== t.companyId))
                      }
                    />
                    <p id={`connect-missing-${t.companyId}`} className="ui-help">
                      {candidates.status === "Exhausted"
                        ? "Sem acesso a esta empresa, ou a concessão foi removida. Desmarque para continuar."
                        : "Fora das empresas carregadas: carregue mais para conferir, ou desmarque."}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
            {rows.length || missing.length ? (
              <div className="gestao-choices">
                {rows.map((c) => (
                  <CompanyChoice
                    key={c.companyId}
                    company={c}
                    environment={environment}
                    grant={grants.find((g) => g.companyId === c.companyId)}
                    checked={targets.some((t) => t.companyId === c.companyId)}
                    onChange={(on) =>
                      setTargets(
                        on
                          ? [...targets, { companyId: c.companyId, name: c.name }]
                          : targets.filter((t) => t.companyId !== c.companyId),
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <Callout tone="info">
                Nenhuma empresa disponível para você conceder. Cadastre uma empresa ou peça acesso a
                um gestor da organização.
              </Callout>
            )}
            <More status={candidates.status} loadMore={candidates.loadMore} />
          </fieldset>
          {changes.length && plan.confirmable ? (
            <Callout tone="warning" title="Alterações em concessões salvas">
              <ul className="gestao-list">
                {changes.map((s) => (
                  <li key={s.target.companyId}>
                    <span>
                      <strong>{s.target.name}</strong>: {diffText(s)}
                    </span>
                  </li>
                ))}
              </ul>
              <Checkbox
                label="Confirmo estas alterações"
                checked={confirmed === signature}
                disabled={locked}
                onChange={(e) => setConfirmed(e.target.checked ? signature : "")}
              />
            </Callout>
          ) : null}
          {apply.notice}
          {plan.accessDone ? (
            <Callout tone="success">As empresas escolhidas já têm esse acesso.</Callout>
          ) : (
            <div className="gestao-submit">
              <Button
                type="submit"
                variant="primary"
                loading={apply.busy}
                loadingLabel="Concedendo…"
                disabled={Boolean(plan.blocker)}
                aria-describedby={plan.blocker ? "connect-access-blocker" : undefined}
              >
                Conceder acesso
              </Button>
              {plan.blocker ? (
                <DisabledReason id="connect-access-blocker">{plan.blocker}</DisabledReason>
              ) : null}
            </div>
          )}
        </form>
      </Card>
      {plan.accessDone || secret.secret ? (
        <KeyStep
          org={org}
          project={project}
          environment={environment}
          scopes={scopes}
          chosen={targets}
          keys={keys.results.filter((k) => keyUsable(k, now))}
          matched={key}
          checking={plan.keyChecking}
          blocker={plan.keyBlocker}
          now={now}
          secret={secret}
          action={keyAction}
          onSecretSaved={step.expectStep}
          heading={plan.current === 2 ? step.heading : undefined}
        />
      ) : null}
      {plan.keyDone && first ? (
        <Card title="4. Primeira chamada" titleRef={plan.current === 3 ? step.heading : undefined}>
          {first.quickstart ? (
            <Callout
              tone="info"
              actions={
                <SectionLink org={org} projectId={project.id} section="quickstart">
                  Abrir a primeira importação
                </SectionLink>
              }
            >
              A chave existe, mas a integração só está pronta quando a primeira chamada der certo.
              Importe o XML sintético da empresa de demonstração com o exemplo da aba Primeira
              chamada.
            </Callout>
          ) : (
            <Callout
              tone="warning"
              actions={
                <a className="ui-link" href={first.href}>
                  Ler o guia
                </a>
              }
            >
              {first.message}
            </Callout>
          )}
        </Card>
      ) : null}
    </>
  );
}
function diffText(step: Extract<GrantStep, { kind: "change" | "new" }>) {
  const parts = [
    step.added.scopes.length && `adiciona ${step.added.scopes.join(", ")}`,
    step.added.environments.length &&
      `adiciona o ambiente ${step.added.environments.map((e) => environmentLabel[e]).join(", ")}`,
  ].filter(Boolean);
  return `${parts.join("; ")}. Nada é retirado: as demais permissões salvas continuam.`;
}

function CompanyChoice({
  company,
  environment,
  grant,
  checked,
  onChange,
}: {
  company: Candidate;
  environment: Env;
  grant: Grant | undefined;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const keeps = grant?.environments.includes(environment);
  const reason =
    !keeps && !company.offeredEnvironments.includes(environment)
      ? company.kind === "demonstration"
        ? "A empresa de demonstração só funciona em Sandbox."
        : `${environmentLabel[environment]} indisponível: a Captura fiscal desta empresa não está liberada.`
      : "";
  const note = grant
    ? `Já concedida: ${grant.scopes.join(", ")} · ${grant.environments.map((e) => environmentLabel[e]).join(", ")}`
    : "";
  const id = `connect-company-${company.companyId}`;
  return (
    <div className="gestao-choice">
      <Checkbox
        label={company.name}
        checked={checked}
        disabled={Boolean(reason) && !checked}
        aria-describedby={reason || note ? id : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      {reason || note ? (
        <p id={id} className="ui-help">
          {[reason, note].filter(Boolean).join(" ")}
        </p>
      ) : null}
    </div>
  );
}

function KeyStep({
  org,
  project,
  environment,
  scopes,
  chosen,
  keys,
  matched,
  checking,
  blocker,
  now,
  secret,
  action,
  onSecretSaved,
  heading,
}: {
  org: Organization;
  project: Project;
  environment: Env;
  scopes: IntegrationScope[];
  chosen: Target[];
  /** Usable keys only; the others stay in Chaves de API. */
  keys: Key[];
  matched: Key | undefined;
  checking: boolean;
  blocker: string;
  now: number;
  secret: ReturnType<typeof useSecretOnce>;
  action: StepAction;
  onSecretSaved: () => void;
  heading: Ref<HTMLHeadingElement> | undefined;
}) {
  const create = useAction(api.keys.create);
  const { busy, run, notice } = action;
  const [another, setAnother] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The secret is the one thing to act on now: take the focus there.
    if (secret.secret) document.getElementById("connect-secret")?.focus();
  }, [secret.secret]);
  useEffect(() => {
    // "Gerar outra chave" replaces itself with the form: continue at its first field.
    if (another) nameField.current?.focus();
  }, [another]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocker) return;
    const form = new FormData(event.currentTarget);
    const failed = await run(() =>
      secret.receive(async () => {
        const result = await create({
          organizationId: org.id,
          projectId: project.id,
          name: text(form, "name"),
          scopes,
          environment,
          companyIds: chosen.map((c) => c.companyId),
          expiresAt: Date.now() + Number(text(form, "days")) * 86400_000,
        });
        return result.secretOnce;
      }),
    );
    if (!failed) setAnother(false);
  }
  const showForm = !secret.secret && !checking && (!matched || another);
  return (
    <Card
      title="3. Chave de API"
      titleRef={heading}
      description="A chave recebe exatamente o acesso escolhido acima. O segredo aparece uma vez."
    >
      <div className="ui-stack">
        {keys.length ? (
          <ul className="gestao-list" aria-label="Chaves ativas deste projeto">
            {keys.map((k) => {
              const [tone, label] = keyState(k, k.expiresAt <= now);
              return (
                <li key={k.id}>
                  <span>
                    {k.name} <span className="ui-mono">{k.prefix}…</span> ·{" "}
                    {environmentLabel[k.environment]} <StatusBadge tone={tone}>{label}</StatusBadge>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="gestao-help">
          Chaves revogadas, expiradas ou substituídas ficam em{" "}
          <SectionLink org={org} projectId={project.id} section="keys">
            Chaves de API
          </SectionLink>
          .
        </p>
        {secret.secret ? (
          <OneTimeSecret
            id="connect-secret"
            label="Segredo da chave"
            value={secret.secret}
            created="Chave criada."
            onDone={() => {
              onSecretSaved();
              secret.discard();
            }}
          />
        ) : checking ? (
          <Loading label="Conferindo as chaves do projeto…" />
        ) : matched && !another ? (
          <Callout
            tone="info"
            actions={
              <>
                <Button size="sm" onClick={() => setAnother(true)}>
                  Gerar outra chave
                </Button>
                <SectionLink org={org} projectId={project.id} section="keys">
                  Revogar em Chaves de API
                </SectionLink>
              </>
            }
          >
            A chave {matched.name} já tem este acesso. O segredo só aparece na criação; se ele se
            perdeu, gere outra chave e revogue a anterior.
          </Callout>
        ) : null}
        {showForm ? (
          <form className="ui-form" onSubmit={submit} aria-busy={busy}>
            <p className="gestao-help">
              {environmentLabel[environment]} · {chosen.map((c) => c.name).join(", ")}
            </p>
            <ScopeList label="Permissões exatas da chave" scopes={scopes} />
            <div className="gestao-grid gestao-grid--even">
              <FormField id="connect-key-name" label="Nome da chave">
                <Input
                  id="connect-key-name"
                  ref={nameField}
                  name="name"
                  required
                  maxLength={100}
                  // Follows the environment until the person types a name of their own.
                  value={name ?? `${project.name} · ${environmentLabel[environment]}`}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </FormField>
              <FormField id="connect-key-days" label="Validade">
                <Select
                  {...controlProps("connect-key-days")}
                  name="days"
                  defaultValue="90"
                  disabled={busy}
                >
                  <option value="30">30 dias</option>
                  <option value="90">90 dias</option>
                  <option value="365">1 ano</option>
                </Select>
              </FormField>
            </div>
            {notice}
            <div className="ui-actions">
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                loadingLabel="Gerando…"
                disabled={Boolean(blocker)}
                aria-describedby={blocker ? "connect-key-blocker" : undefined}
              >
                Gerar chave
              </Button>
              {blocker ? <DisabledReason id="connect-key-blocker">{blocker}</DisabledReason> : null}
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
