import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Outlet,
  useMatches,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useAction,
  useConvexConnectionState,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import {
  canManageRole,
  membershipRoleLabels,
  membershipRoles,
  type MembershipRole,
} from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { useShellOrganization } from "./app-shell";
import {
  OrganizationQueryCache,
  usePaginatedQuery as useCachedPaginatedQuery,
} from "./convex-query";
import { OrganizationStart } from "./organization-home";
import { taskSearch } from "./console-task";
import { formatDateTime } from "./format";
import { More } from "./load-more";
import { Button, buttonClass } from "./ui/button";
import { DataTable, type Column } from "./ui/data-table";
import { ConfirmDialog } from "./ui/dialog";
import { FormField, Input, Select, controlProps } from "./ui/form";
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
import {
  forgetOrganization,
  invitationCodePattern,
  normalizeInvitationCode,
  rememberedOrganization,
  rememberOrganization,
  takePendingInvitation,
} from "./session-handoff";
import {
  OrganizationScopeProvider,
  Unavailable,
  useOrganizationScope,
  useShownOrganizationScope,
  type OrganizationView,
} from "./organization-scope";
import { takeOrganizationKey } from "./organization-prewarm";
import { TermsOfUseAcceptance, TermsOfUseNotice } from "./terms-of-use";
import { ArchiveNotice, SandboxClosureNotice } from "./archive-notice";

export type Organization = NonNullable<FunctionReturnType<typeof api.organizations.context>>;
const labels = membershipRoleLabels;
function textField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
function failure(error: unknown) {
  const messages: Record<string, string> = {
    SLUG_UNAVAILABLE: "Este endereço já está em uso. Escolha outro.",
    INVALID_SLUG: "Use de 3 a 48 letras minúsculas, números ou hífens no endereço.",
    INVALID_NAME: "Informe um nome entre 2 e 80 caracteres.",
    INVALID_EMAIL: "Confira o e-mail informado.",
    LAST_OWNER: "A organização precisa manter pelo menos um proprietário.",
    MEMBERSHIP_CHANGED:
      "Este membro foi alterado. Confira os dados atualizados antes de tentar novamente.",
    INVITATION_PENDING:
      "Já existe um convite pendente para este e-mail. Revogue-o antes de enviar outro.",
    INVITATION_UNAVAILABLE:
      "Convite indisponível. Ele pode ter expirado, ter sido revogado ou pertencer a outro e-mail.",
    SELF_INVITATION: "Você já participa desta organização. Convide outra pessoa.",
    ALREADY_MEMBER:
      "Sua conta já participa desta organização. Um convite não altera seu papel atual.",
    RATE_LIMITED: "Muitas tentativas. Aguarde um minuto e tente novamente.",
    CONFIRMATION_MISMATCH: "Digite o endereço da organização exatamente como aparece acima.",
    ANNUAL_TERM_ACTIVE:
      "A organização tem um plano anual em vigor ou agendado. Para encerrar, fale com o suporte para rescindir o plano anual.",
    ORGANIZATION_CLOSED:
      "Esta organização foi encerrada. Só a exportação dos dados continua disponível.",
    TERMS_OF_USE_OUTDATED:
      "Os termos de uso mudaram enquanto a página estava aberta. Recarregue a página e leia a versão atual.",
    ACCESS_DENIED: "Sua conta não tem permissão para esta ação. Confira seu acesso atual.",
    EMAIL_UNVERIFIED: "Verifique seu e-mail antes de continuar.",
    UNAUTHENTICATED: "Sua sessão terminou. Entre novamente para continuar.",
  };
  const data: unknown = error instanceof ConvexError ? error.data : null;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? (messages[data.code] ?? "Não foi possível concluir. Confira sua conexão e tente novamente.")
    : "Não foi possível concluir. Confira sua conexão e tente novamente.";
}
function Pending({ label = "Confirmando o acesso à organização…" }: { label?: string }) {
  return (
    <Page>
      <SkeletonBlock label={label} lines={4} />
    </Page>
  );
}
function Feedback({ error, message = "" }: { error: string; message?: string }) {
  return (
    <>
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {message && (
        <Callout tone="success" role="status">
          {message}
        </Callout>
      )}
    </>
  );
}
function RoleOptions({ actor }: { actor: MembershipRole }) {
  return membershipRoles
    .filter((role) => canManageRole(actor, role))
    .map((role) => (
      <option key={role} value={role}>
        {labels[role]}
      </option>
    ));
}
/**
 * HTML `pattern` of the organization address, mirroring the server rule. Browsers compile it
 * with the `v` flag, where a literal hyphen inside a class must be escaped.
 */
export const organizationSlugPattern = "[a-z0-9][a-z0-9\\-]{1,46}[a-z0-9]";
/** Address suggested from the name: lowercase, no accents, words joined by hyphens. */
export function suggestSlug(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
export function OrganizationHome() {
  const connection = useConvexConnectionState();
  return connection.isWebSocketConnected ? (
    <OrganizationList key={connection.connectionCount} />
  ) : (
    <Pending />
  );
}
function OrganizationList() {
  const [contextKey] = useState(() => crypto.randomUUID());
  const { results, status, loadMore } = usePaginatedQuery(
    api.organizations.listMine,
    { contextKey },
    { initialNumItems: 20 },
  );
  const create = useMutation(api.organizations.create);
  // The version of the terms of use a new organization accepts; null while none is current.
  const terms = useQuery(api.termsOfUse.current, {});
  // Same rule as the shell (#538): only an explicit `false` hides the invitation, which can only
  // reach a person by e-mail; the route stays reachable for links already sent.
  const invitations = useQuery(api.account.capabilities)?.invitationEmail !== false;
  // The version whose box was checked: a newer version arriving while the page is open is unchecked.
  const [acceptedTerms, setAcceptedTerms] = useState<string | null>(null);
  const termsAccepted = !!terms && acceptedTerms === terms.version;
  const navigate = useNavigate();
  // The task chosen before the account (#510) goes on to the Início of the organization opened.
  const task = taskSearch((useSearch({ strict: false }) as { tarefa?: unknown }).tarefa);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [name, setName] = useState(""),
    // null while the address follows the name; the typed value once the person edits it.
    [typedSlug, setTypedSlug] = useState<string | null>(null);
  const slug = typedSlug ?? suggestSlug(name);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await create({
        name: textField(form, "name"),
        slug: textField(form, "slug"),
        ...(terms ? { termsOfUse: terms.version } : {}),
      });
      await navigate({
        to: "/app/$organizationSlug",
        params: { organizationSlug: result.slug },
        search: task,
      });
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <PageHeader
        title="Organizações"
        description="Cada organização reúne sua equipe e mantém os próprios dados e permissões."
        actions={
          invitations ? (
            <Link className={buttonClass()} to="/accept-invitation">
              Aceitar um convite
            </Link>
          ) : undefined
        }
      />
      <div className="gestao-grid">
        <Card title="Suas organizações" flush>
          {status === "LoadingFirstPage" ? (
            <div className="gestao-body">
              <SkeletonBlock label="Carregando suas organizações…" />
            </div>
          ) : results.length ? (
            <ul className="gestao-links" aria-label="Organizações disponíveis">
              {results.map((org) => (
                <li key={org.id}>
                  <Link
                    to="/app/$organizationSlug"
                    params={{ organizationSlug: org.slug }}
                    search={task}
                  >
                    <span className="gestao-cell">
                      <strong>{org.name}</strong>
                      <span className="gestao-meta">{labels[org.role]}</span>
                    </span>
                    <Icon name="arrowRight" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="users"
              headingLevel={3}
              title="Seu primeiro espaço de trabalho"
              description={
                invitations
                  ? "Use o formulário para criar uma organização ou aceite o convite da sua equipe."
                  : "Use o formulário para criar uma organização."
              }
            />
          )}
          <div className="gestao-footer">
            <More status={status} loadMore={loadMore} />
          </div>
        </Card>
        <Card
          title="Criar organização"
          description={
            invitations
              ? "Você será o primeiro proprietário e poderá convidar outras pessoas."
              : "Você será o primeiro proprietário."
          }
        >
          <form className="ui-form" onSubmit={submit} aria-busy={busy}>
            <FormField id="organization-name" label="Nome da organização">
              <Input
                id="organization-name"
                name="name"
                minLength={2}
                maxLength={80}
                required
                disabled={busy}
                autoComplete="organization"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </FormField>
            <FormField
              id="organization-slug"
              label="Endereço da organização"
              help="Sugerido a partir do nome. Letras minúsculas, números e hífens, como minha-equipe. Este endereço será permanente."
            >
              <Input
                {...controlProps("organization-slug", undefined, true)}
                name="slug"
                className="ui-mono"
                minLength={3}
                maxLength={48}
                pattern={organizationSlugPattern}
                value={slug}
                onChange={(event) => setTypedSlug(event.target.value)}
                required
                disabled={busy}
                autoCapitalize="none"
                autoComplete="off"
              />
            </FormField>
            {terms && (
              <TermsOfUseAcceptance
                version={terms.version}
                accepted={termsAccepted}
                onChange={(accepted) => setAcceptedTerms(accepted ? terms.version : null)}
                disabled={busy}
              />
            )}
            <Feedback error={error} />
            <div>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                loadingLabel="Criando…"
                disabled={terms === undefined || (terms !== null && !termsAccepted)}
              >
                Criar organização
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Page>
  );
}

/**
 * Layout of `/app/$organizationSlug`: authorizes the organization once and keeps it while the
 * person moves between its pages, so the shell, the authorized context and its query key stay
 * mounted. The page below comes from the router (`<Outlet />`), with its own chunk.
 */
export function OrganizationLayout() {
  const view = useMatches({
    select: (matches) => matches[matches.length - 1]?.staticData.organizationView,
  });
  return (
    <OrganizationFrame view={view ?? "overview"}>
      <Outlet />
    </OrganizationFrame>
  );
}
/**
 * One entry of the organization context per address and per connection. Moving between pages of
 * the same organization re-renders, without remounting. A disconnect unmounts every form and
 * private query, and the reconnect enters again with a fresh query key (docs/desenvolvimento/frontend.md, "Entrada de contexto").
 */
export function OrganizationFrame({
  view,
  children,
}: {
  view: OrganizationView;
  children: ReactNode;
}) {
  const { organizationSlug = "", section } = useParams({ strict: false });
  const connection = useConvexConnectionState();
  if (!connection.isWebSocketConnected) return <Pending label="Reconectando ao servidor…" />;
  return (
    <OrganizationContext
      key={`${organizationSlug}:${connection.connectionCount}`}
      slug={organizationSlug}
      section={section}
      view={view}
    >
      {children}
    </OrganizationContext>
  );
}
function OrganizationContext({
  slug,
  section,
  view,
  children,
}: {
  slug: string;
  section?: string;
  view: OrganizationView;
  children: ReactNode;
}) {
  // The cold load may have asked for this entry already, with the session (organization-prewarm).
  const [contextKey] = useState(() => takeOrganizationKey(slug) ?? crypto.randomUUID());
  const [leaving, setLeaving] = useState(false);
  const org = useQuery(api.organizations.context, { slug, contextKey });
  const openedSlug = org?.slug;
  // Login and the brand return here: only the public address, checked again by the server.
  useEffect(() => {
    if (openedSlug) rememberOrganization(openedSlug);
  }, [openedSlug]);
  // An address that no longer opens is not where the brand should take the person next time.
  useEffect(() => {
    if (org === null && rememberedOrganization() === slug) forgetOrganization();
  }, [org, slug]);
  // The shell draws the switcher and the menu by role only for an organization authorized here;
  // leaving or switching clears them together with the content.
  const current = view === "settings" ? `settings:${section ?? ""}` : view;
  const onSwitch = useCallback(() => setLeaving(true), []);
  const shell = useMemo(
    () => (org && !leaving ? { org, contextKey, current, onSwitch } : null),
    [org, leaving, contextKey, current, onSwitch],
  );
  useShellOrganization(shell);
  const key = org ? `${contextKey}:${org.membershipVersion}` : contextKey;
  const scope = useMemo(() => (org ? { org, contextKey: key } : null), [org, key]);
  // The route loaders ask for a page's first queries with this scope while its code arrives.
  useShownOrganizationScope(leaving || org?.closure ? null : scope);
  if (leaving || org === undefined) return <Pending />;
  if (org === null || !scope)
    return (
      <Unavailable
        title="Organização indisponível."
        description="Confira o endereço ou solicite acesso a um administrador."
        action={
          <Link className={buttonClass()} to="/app">
            Voltar às suas organizações
          </Link>
        }
      />
    );
  if (org.closure && view !== "exports")
    return (
      <Page>
        <PageHeader
          title="Organização encerrada."
          description="Só a exportação dos dados continua disponível."
        />
        <ClosureNotice org={org} closure={org.closure} view={view} />
      </Page>
    );
  // The pages' query cache lives and dies with this entry and this membership version: another
  // organization, a disconnect, a lost or changed membership or a logout close all of it.
  return (
    <div className="app-content" key={org.membershipVersion}>
      {org.closure && <ClosureNotice org={org} closure={org.closure} view={view} />}
      {!org.closure && org.termsOfUse && (
        <TermsOfUseNotice organizationId={org.id} role={org.role} pending={org.termsOfUse} />
      )}
      {!org.closure && <ArchiveNotice organizationId={org.id} slug={org.slug} />}
      {!org.closure && <SandboxClosureNotice organizationId={org.id} />}
      <OrganizationQueryCache>
        <OrganizationScopeProvider value={scope}>{children}</OrganizationScopeProvider>
      </OrganizationQueryCache>
    </div>
  );
}
/** `/app/$organizationSlug`: the organization's home. */
export function OrganizationOverviewRoute() {
  const { org, contextKey } = useOrganizationScope();
  return <OrganizationStart org={org} contextKey={contextKey} />;
}
/** `/app/$organizationSlug/settings/$section`: members and the organization's settings. */
export function OrganizationSettingsRoute() {
  const { org, contextKey } = useOrganizationScope();
  const { section } = useParams({ strict: false });
  // An unknown section is a missing page, not a permission matter.
  if (section !== "members" && section !== "organization")
    return (
      <Unavailable
        title="Página não encontrada."
        description="Confira o endereço ou escolha uma página no menu da organização."
        action={
          <Link
            className={buttonClass()}
            to="/app/$organizationSlug"
            params={{ organizationSlug: org.slug }}
          >
            Voltar à organização
          </Link>
        }
      />
    );
  if (section === "members" && org.capabilities.manageMembers)
    return <Members org={org} contextKey={contextKey} />;
  if (section === "organization" && org.capabilities.manageOrganization)
    return <Settings org={org} contextKey={contextKey} />;
  return (
    <Unavailable
      title="Página indisponível para seu papel."
      description="Escolha uma página no menu da organização."
    />
  );
}
/** D01: after closing, only the export stays open until the window ends. */
function ClosureNotice({
  org,
  closure,
  view,
}: {
  org: Organization;
  closure: NonNullable<Organization["closure"]>;
  view: string;
}) {
  const open = closure.state === "closing" && Date.now() < closure.exportUntil;
  return (
    <div className="gestao-closure">
      <Callout
        tone="warning"
        role="alert"
        title={view === "exports" ? "Organização encerrada." : undefined}
        actions={
          open && org.capabilities.manageOrganization && view !== "exports" ? (
            <Link
              className={buttonClass({ variant: "primary" })}
              to="/app/$organizationSlug/exports"
              params={{ organizationSlug: org.slug }}
            >
              Exportar dados
            </Link>
          ) : undefined
        }
      >
        <p>
          O encerramento foi solicitado em {formatDateTime(closure.requestedAt)}. Novas operações,
          chaves de API, webhooks e convites foram desativados.
        </p>
        <p>
          {open
            ? org.capabilities.manageOrganization
              ? `Exporte os dados da organização até ${formatDateTime(closure.exportUntil)}.`
              : `Proprietários e administradores podem exportar os dados até ${formatDateTime(closure.exportUntil)}.`
            : "O prazo de exportação terminou."}{" "}
          Depois desse prazo, cadastro, membros, certificados, chaves e integrações são excluídos em
          até 7 dias. Documentos fiscais, operações e registros de cobrança continuam guardados
          pelos prazos legais.
        </p>
      </Callout>
    </div>
  );
}
type Member = FunctionReturnType<typeof api.organizations.members>["page"][number];
function MemberActions({
  member,
  org,
  onRemove,
}: {
  member: Member;
  org: Organization;
  onRemove: () => void;
}) {
  const changeRole = useMutation(api.organizations.changeRole);
  const [role, setRole] = useState(member.role),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await changeRole({
        organizationId: org.id,
        membershipId: member.id,
        expectedVersion: member.version,
        role,
      });
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ui-stack">
      <div className="ui-actions">
        <label className="ui-visually-hidden" htmlFor={`role-${member.id}`}>
          Papel de {member.name}
        </label>
        <Select
          id={`role-${member.id}`}
          className="gestao-role-select"
          value={role}
          onChange={(e) => setRole(e.target.value as MembershipRole)}
          disabled={busy}
        >
          <RoleOptions actor={org.role} />
        </Select>
        <Button
          size="sm"
          loading={busy}
          loadingLabel="Salvando…"
          disabled={role === member.role}
          onClick={() => void save()}
        >
          Salvar papel
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
          Remover membro
        </Button>
      </div>
      <Feedback error={error} />
    </div>
  );
}
function Members({ org, contextKey }: { org: Organization; contextKey: string }) {
  const { results, status, loadMore } = useCachedPaginatedQuery(
    api.organizations.members,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const removeMember = useMutation(api.organizations.removeMember);
  // The invitation code only reaches the person by e-mail (#538): without account e-mail the
  // panel does not offer to send invitations. `undefined` while the answer has not arrived.
  const invitationEmail = useQuery(api.account.capabilities)?.invitationEmail;
  // The dialog and its focus target live here: on success the member's row disappears.
  const [removing, setRemoving] = useState<Member | null>(null);
  const list = useRef<HTMLDivElement>(null);
  async function remove(member: Member) {
    try {
      await removeMember({
        organizationId: org.id,
        membershipId: member.id,
        expectedVersion: member.version,
      });
      return "";
    } catch (error) {
      return failure(error);
    }
  }
  const columns: Array<Column<Member>> = [
    {
      key: "person",
      header: "Pessoa",
      primary: true,
      cell: (member) => (
        <span className="gestao-cell">
          <span>
            {member.name}
            {member.id === org.membershipId ? " (você)" : ""}
          </span>
          <span className="gestao-meta">{member.email}</span>
        </span>
      ),
    },
    {
      key: "role",
      header: "Papel",
      cell: (member) => (
        <span className="gestao-cell">
          <StatusBadge tone={member.role === "owner" ? "info" : "neutral"}>
            {labels[member.role]}
          </StatusBadge>
          {member.role === "owner" && org.ownerCount === 1 ? (
            <span className="gestao-meta">Último proprietário</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Ações",
      cell: (member) => {
        const lastOwner = member.role === "owner" && org.ownerCount === 1;
        return canManageRole(org.role, member.role) && !lastOwner ? (
          <MemberActions
            key={`${member.id}:${member.version}`}
            member={member}
            org={org}
            onRemove={() => setRemoving(member)}
          />
        ) : (
          <span className="gestao-meta">
            {lastOwner
              ? "A equipe precisa de pelo menos um proprietário."
              : "Só um proprietário altera este papel."}
          </span>
        );
      },
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Membros"
        description="Cada pessoa tem um papel. A equipe precisa manter pelo menos um proprietário."
      />
      <div ref={list} tabIndex={-1}>
        <Card title="Pessoas com acesso" flush>
          {status === "LoadingFirstPage" ? (
            <div className="gestao-body">
              <SkeletonBlock label="Carregando os membros…" />
            </div>
          ) : (
            <DataTable
              label="Membros"
              columns={columns}
              rows={results}
              rowKey={(member) => `${member.id}:${member.version}`}
            />
          )}
          <div className="gestao-footer">
            <More status={status} loadMore={loadMore} />
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remover ${removing?.name ?? "este membro"}?`}
        description="O acesso desta pessoa será encerrado."
        confirmLabel="Confirmar remoção"
        busyLabel="Removendo…"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve(""))}
        returnFocusTo={() => list.current}
      />
      <InvitationForm org={org} invitationEmail={invitationEmail} />
      <Invitations org={org} contextKey={contextKey} invitationEmail={invitationEmail} />
    </Page>
  );
}
function InvitationForm({
  org,
  invitationEmail,
}: {
  org: Organization;
  invitationEmail: boolean | undefined;
}) {
  const send = useAction(api.invitations.send);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget,
      form = new FormData(element);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await send({
        organizationId: org.id,
        email: textField(form, "email"),
        role: textField(form, "role") as MembershipRole,
      });
      if (result.delivered) {
        setMessage(
          "Convite enviado. A pessoa deverá entrar com este e-mail verificado para aceitar.",
        );
        element.reset();
      } else
        setError(
          "O envio não foi confirmado. O convite não concede acesso. Confira o e-mail e tente enviar novamente.",
        );
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  if (invitationEmail === undefined)
    return (
      <Card title="Convidar uma pessoa">
        <SkeletonBlock label="Carregando as opções de convite…" lines={2} />
      </Card>
    );
  if (!invitationEmail)
    return (
      <Card title="Convidar uma pessoa">
        <Callout title="Este painel não envia convites.">
          O código do convite só chega à pessoa por e-mail, e este painel não envia e-mails de
          conta. Para convidar alguém, peça a quem administra o painel que ative o envio de e-mails
          de conta.
        </Callout>
      </Card>
    );
  return (
    <Card
      title="Convidar uma pessoa"
      description="O convite vale por 72 horas. O e-mail só será enviado quando você confirmar abaixo. Ele traz um link que abre o convite no painel e o código, para quem preferir colar."
    >
      <form className="ui-form" onSubmit={submit} aria-busy={busy}>
        <div className="gestao-inline-form">
          <FormField id="invitation-email" label="E-mail da pessoa">
            <Input
              id="invitation-email"
              name="email"
              type="email"
              maxLength={254}
              required
              disabled={busy}
              autoComplete="off"
            />
          </FormField>
          <div className="gestao-narrow">
            <FormField
              id="invitation-role"
              label="Papel no convite"
              help={
                org.role === "admin"
                  ? "Apenas proprietários podem conceder os papéis de administrador e proprietário."
                  : undefined
              }
            >
              <Select
                {...controlProps("invitation-role", undefined, org.role === "admin")}
                name="role"
                defaultValue="viewer"
                disabled={busy}
              >
                <RoleOptions actor={org.role} />
              </Select>
            </FormField>
          </div>
          <div className="ui-actions">
            <Button
              type="submit"
              variant="primary"
              icon="plus"
              loading={busy}
              loadingLabel="Enviando…"
            >
              Enviar convite
            </Button>
          </div>
        </div>
        <Feedback error={error} message={message} />
      </form>
    </Card>
  );
}
const invitationLabels: Record<string, [Tone, string]> = {
  sending: ["info", "Enviando"],
  pending: ["warning", "Pendente"],
  accepted: ["success", "Aceito"],
  revoked: ["neutral", "Revogado"],
  "delivery-failed": ["danger", "Envio não confirmado"],
};
type Invitation = FunctionReturnType<typeof api.invitations.list>["page"][number];
function Invitations({
  org,
  contextKey,
  invitationEmail,
}: {
  org: Organization;
  contextKey: string;
  invitationEmail: boolean | undefined;
}) {
  const { results, status, loadMore } = useCachedPaginatedQuery(
    api.invitations.list,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  const revoke = useMutation(api.invitations.revoke);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const area = useRef<HTMLDivElement>(null);
  async function cancel(invitationId: Id<"invitations">) {
    try {
      await revoke({ organizationId: org.id, invitationId });
      return "";
    } catch (error) {
      return failure(error);
    }
  }
  const columns: Array<Column<Invitation>> = [
    { key: "email", header: "E-mail", primary: true, cell: (i) => i.email || "Conta excluída" },
    { key: "role", header: "Papel", cell: (i) => labels[i.role] },
    {
      key: "status",
      header: "Situação",
      cell: (i) => {
        const [tone, label] = invitationLabels[i.status] ?? ["neutral", i.status];
        return <StatusBadge tone={tone}>{label}</StatusBadge>;
      },
    },
    {
      key: "expires",
      header: "Validade",
      cell: (i) => <span className="gestao-time">{formatDateTime(i.expiresAt)}</span>,
    },
    {
      key: "actions",
      header: "Ações",
      cell: (i) =>
        (i.status === "pending" || i.status === "sending") && canManageRole(org.role, i.role) ? (
          <Button size="sm" variant="ghost" onClick={() => setRevoking(i)}>
            Revogar convite
          </Button>
        ) : (
          <span className="gestao-meta">—</span>
        ),
    },
  ];
  return (
    <div ref={area} tabIndex={-1}>
      <Card title="Convites" flush>
        {status === "LoadingFirstPage" ? (
          <div className="gestao-body">
            <SkeletonBlock label="Carregando os convites…" />
          </div>
        ) : (
          <DataTable
            label="Convites"
            columns={columns}
            rows={results}
            rowKey={(i) => i.id}
            empty={
              invitationEmail === false ? (
                <EmptyState
                  icon="users"
                  headingLevel={3}
                  title="Nenhum convite nesta organização."
                />
              ) : (
                <EmptyState
                  icon="users"
                  headingLevel={3}
                  title="Nenhum convite enviado nesta organização."
                  description="Os convites enviados aparecem aqui até serem aceitos, revogados ou expirarem."
                />
              )
            }
          />
        )}
        <div className="gestao-footer">
          <More status={status} loadMore={loadMore} />
        </div>
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revogar o convite de ${revoking?.email || "esta pessoa"}?`}
        description={
          invitationEmail !== false
            ? "O link e o código deixam de valer na hora. Para convidar de novo, envie outro convite."
            : "O link e o código deixam de valer na hora."
        }
        confirmLabel="Confirmar revogação"
        busyLabel="Revogando…"
        onConfirm={() => (revoking ? cancel(revoking.id) : Promise.resolve(""))}
        returnFocusTo={() => area.current}
      />
    </div>
  );
}
const activityLabels = {
  "organization.created": "Organização criada",
  "organization.updated": "Organização atualizada",
  "organization.closure-requested": "Encerramento solicitado",
  "organization.terms-accepted": "Termos de uso aceitos",
  "organization.kept-active": "Organização mantida ativa",
  "member.role-changed": "Papel alterado",
  "member.removed": "Membro removido",
  "member.joined": "Convite aceito e acesso concedido",
  "invitation.created": "Convite criado",
  "invitation.revoked": "Convite revogado",
  "invitation.sent": "Convite enviado",
  "invitation.delivery-failed": "Envio não confirmado",
};
function Settings({ org, contextKey }: { org: Organization; contextKey: string }) {
  const update = useMutation(api.organizations.update);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const { results, status, loadMore } = useCachedPaginatedQuery(
    api.organizations.activity,
    { organizationId: org.id, contextKey },
    { initialNumItems: 20 },
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await update({ organizationId: org.id, name: textField(form, "name") });
      setMessage("Nome da organização atualizado.");
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <PageHeader
        title="Configurações"
        description="Nome, histórico de acesso e encerramento da organização."
      />
      <Card title="Organização">
        <form className="ui-form" onSubmit={submit} aria-busy={busy}>
          <FormField
            id="settings-name"
            label="Nome da organização"
            help={
              <>
                Endereço permanente: <span className="ui-mono">/app/{org.slug}</span>
              </>
            }
          >
            <Input
              {...controlProps("settings-name", undefined, true)}
              key={org.name}
              name="name"
              defaultValue={org.name}
              minLength={2}
              maxLength={80}
              required
              disabled={busy}
            />
          </FormField>
          <Feedback error={error} message={message} />
          <div>
            <Button type="submit" variant="primary" loading={busy} loadingLabel="Salvando…">
              Salvar configurações
            </Button>
          </div>
        </form>
      </Card>
      <Card
        title="Atividade da organização"
        description="Registro das alterações de acesso e da organização."
        flush
      >
        {status === "LoadingFirstPage" ? (
          <div className="gestao-body">
            <SkeletonBlock label="Carregando a atividade…" />
          </div>
        ) : results.length ? (
          <ol className="gestao-list">
            {results.map((item) => (
              <li key={item.id}>
                <div className="gestao-row">
                  <p className="gestao-row__title">
                    {activityLabels[item.action]}
                    {item.beforeRole || item.afterRole ? (
                      <span className="gestao-meta">
                        {item.beforeRole ? `${labels[item.beforeRole]} → ` : ""}
                        {item.afterRole ? labels[item.afterRole] : ""}
                      </span>
                    ) : null}
                  </p>
                  <time
                    className="gestao-meta gestao-time"
                    dateTime={new Date(item.createdAt).toISOString()}
                  >
                    {formatDateTime(item.createdAt)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState icon="inbox" headingLevel={3} title="Nenhuma atividade registrada." />
        )}
        <div className="gestao-footer">
          <More status={status} loadMore={loadMore} />
        </div>
      </Card>
      {org.role === "owner" && <CloseOrganization org={org} />}
    </Page>
  );
}
function CloseOrganization({ org }: { org: Organization }) {
  const close = useMutation(api.organizationClosure.close);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      // The context subscription shows the closure as soon as it commits.
      await close({ organizationId: org.id, confirmation: textField(form, "confirmation") });
    } catch (error) {
      setError(failure(error));
      setBusy(false);
    }
  }
  return (
    <Card
      title="Encerrar organização"
      className="gestao-danger"
      description="O encerramento desativa na hora as operações, os projetos, as chaves de API, os webhooks e os convites. Durante 30 dias, proprietários e administradores podem exportar os dados. Em seguida, cadastro, membros, certificados, chaves e integrações são excluídos em até 7 dias. Documentos fiscais, operações e registros de cobrança continuam guardados pelos prazos legais."
    >
      <form className="ui-form" onSubmit={submit} aria-busy={busy}>
        <FormField
          id="close-confirmation"
          label={
            <>
              Para confirmar, digite o endereço da organização:{" "}
              <span className="ui-mono">{org.slug}</span>
            </>
          }
        >
          <Input
            id="close-confirmation"
            name="confirmation"
            className="ui-mono"
            autoComplete="off"
            required
            disabled={busy}
          />
        </FormField>
        <Feedback error={error} />
        <div>
          <Button type="submit" variant="danger" loading={busy} loadingLabel="Encerrando…">
            Encerrar organização
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AcceptInvitation() {
  const connection = useConvexConnectionState();
  return connection.isWebSocketConnected ? (
    <InvitationAcceptance key={connection.connectionCount} />
  ) : (
    <Pending />
  );
}
function InvitationAcceptance() {
  const preview = useAction(api.invitations.preview),
    accept = useAction(api.invitations.accept),
    navigate = useNavigate();
  // The code from the e-mail link, handed over once from memory (never storage or the URL).
  const [opened] = useState(takePendingInvitation);
  const [token, setToken] = useState(opened),
    [details, setDetails] = useState<FunctionReturnType<typeof api.invitations.preview> | null>(
      null,
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [fieldError, setFieldError] = useState("");
  async function check(code: string) {
    const normalized = normalizeInvitationCode(code);
    setError("");
    setFieldError("");
    if (!normalized) {
      setFieldError("Cole o código do convite ou abra o link recebido por e-mail.");
      return;
    }
    if (!invitationCodePattern.test(normalized)) {
      setFieldError(
        "O código tem 64 caracteres, com números e letras de a até f. Confira se foi copiado inteiro.",
      );
      return;
    }
    setBusy(true);
    try {
      setToken(normalized);
      setDetails(await preview({ token: normalized }));
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  // Opened from the link: show the organization and the role right away, still asking to confirm.
  useEffect(() => {
    if (opened) void check(opened);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Runs once for the code that opened the page.
  }, []);
  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await check(token);
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await accept({ token });
      setToken("");
      setDetails(null);
      await navigate({ to: "/app/$organizationSlug", params: { organizationSlug: result.slug } });
    } catch (error) {
      setDetails(null);
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <PageHeader
        title="Aceitar convite"
        description="Use o mesmo e-mail que recebeu o convite e confira a organização e o papel antes de aceitar."
      />
      <div className="gestao-narrow-page">
        {details ? (
          <Card title={details.organizationName} description="Confira antes de aceitar.">
            <div className="ui-stack">
              <DescriptionList
                items={[
                  { term: "Papel", value: labels[details.role] },
                  { term: "Válido até", value: formatDateTime(details.expiresAt) },
                ]}
              />
              <Feedback error={error} />
              <div className="ui-actions">
                <Button
                  variant="primary"
                  loading={busy}
                  loadingLabel="Aceitando…"
                  onClick={() => void confirm()}
                >
                  Confirmar participação
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setToken("");
                    setDetails(null);
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </Card>
        ) : busy && opened && !error ? (
          <Card>
            <SkeletonBlock label="Conferindo o convite…" />
          </Card>
        ) : (
          <Card title="Conferir o código" description="Cole o código recebido por e-mail.">
            <form className="ui-form" onSubmit={inspect} aria-busy={busy} noValidate>
              <Feedback error={error} />
              <FormField
                id="invitation-code"
                label="Código do convite"
                error={fieldError}
                help="O link do e-mail já abre o convite. Se preferir, cole aqui o código de 64 caracteres. Ele vale uma vez e não fica salvo no navegador."
              >
                <Input
                  {...controlProps("invitation-code", fieldError, true)}
                  type="text"
                  className="ui-mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  maxLength={80}
                  disabled={busy}
                />
              </FormField>
              <div>
                <Button type="submit" variant="primary" loading={busy} loadingLabel="Conferindo…">
                  Conferir convite
                </Button>
              </div>
            </form>
          </Card>
        )}
      </div>
    </Page>
  );
}
