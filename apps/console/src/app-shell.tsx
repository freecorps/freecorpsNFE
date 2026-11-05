import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { membershipRoleLabels } from "@freecorps/contracts";
import { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import {
  OrganizationNavigation,
  organizationDestinations,
  type CurrentView,
} from "./organization-navigation";
import { Icon, type IconName } from "./ui/icons";
import { IconButton } from "./ui/button";
import { EnvironmentStamp } from "./environment-stamp";
import { ProductEnvironmentProvider, useProductEnvironment } from "./product-environment";
import { environmentNames, type Deployment, type ProductEnvironment } from "./deployment";
import { Skeleton } from "./ui/layout";
import { Menu, MenuGroup, MenuHeader, MenuItem, MenuRadioItem, MenuSeparator } from "./ui/menu";
import { CommandPalette, type Command } from "./ui/command-palette";
import { themeLabels, useTheme, type ThemePreference } from "./ui/theme";
import { focusableIn, trapTab } from "./ui/focus";
import { rememberedOrganizationSlug } from "./session-handoff";

/**
 * A organização aberta, informada pelo layout que já a autorizou (`OrganizationContext`). O
 * shell só desenha o seletor, o menu por papel e os atalhos. Navegar entre páginas da mesma
 * organização só atualiza o valor; ao sair da organização (o layout desmonta), volta a `null`
 * e o menu da organização some junto com o conteúdo.
 */
export type ShellOrganization = {
  org: Organization;
  contextKey: string;
  current: CurrentView;
  /** Chamado antes de trocar de organização: a página desmonta formulários e consultas. */
  onSwitch: () => void;
};
const ShellContext = createContext<((value: ShellOrganization | null) => void) | null>(null);
export function useShellOrganization(value: ShellOrganization | null) {
  const set = useContext(ShellContext);
  // A new value replaces the previous one in place; only leaving clears it, so moving between
  // pages never flashes the general menu. Before the paint: an organization whose answer is
  // already here (the cold load asks for it together with the session) never shows the general
  // menu for a frame.
  useLayoutEffect(() => {
    set?.(value);
  }, [set, value]);
  useEffect(() => () => set?.(null), [set]);
}

export type ShellAccount = { name: string; role: string };
export type ShellTools = {
  diagnostics: boolean;
  prototype: boolean;
  components: boolean;
  privacy?: boolean;
  security?: boolean;
  support?: boolean;
  operation?: boolean;
};

const initial = (text: string) => (text.trim()[0] ?? "?").toLocaleUpperCase("pt-BR");
const themeIcon: Record<ThemePreference, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

/**
 * O caminho do início da seção aberta: trocar de ambiente volta para ele, porque o registro, o
 * filtro ou o formulário aberto pertencem ao ambiente anterior. `settings` e `developer` têm a
 * subseção no caminho; o resto, só a seção. Fora de uma organização, nada muda.
 */
export function sectionRoot(pathname: string): string | null {
  const match = /^\/app\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/.exec(pathname);
  if (!match) return null;
  const [, slug, section, sub] = match;
  if (!section) return `/app/${slug}`;
  if ((section === "settings" || section === "developer") && sub)
    return `/app/${slug}/${section}/${sub}`;
  return `/app/${slug}/${section}`;
}

/**
 * O único indicador de ambiente do console, fixo na lateral. Com Produção oferecida (ADR 0007),
 * é também o seletor: um botão por ambiente, e o console inteiro passa a mostrar e operar o
 * escolhido. Trocar volta para o início da seção aberta.
 */
export function EnvironmentBadge({
  label,
  version,
  deployment,
}: {
  label?: string;
  version: string;
  deployment?: Deployment;
}) {
  const { environment, offered, choose } = useProductEnvironment();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const release = `Versão ${version.slice(0, 7)}`;
  const selectable = (deployment?.confirmed ?? true) && !!offered && offered.length > 1;
  function select(next: ProductEnvironment) {
    if (next === environment) return;
    choose(next);
    const root = sectionRoot(pathname);
    if (root) void navigate({ href: root });
  }
  if (!selectable)
    return (
      <p className="app-env" title={label ? `${label} · ${release}` : release}>
        <EnvironmentStamp label={label} deployment={deployment} chosen={environment} />
      </p>
    );
  // The stamp is the switch: the lit half says where the console is, the line below what it
  // means. Arrows move between the two, like any radio group.
  const index = offered.indexOf(environment);
  return (
    <div
      className="app-env-card"
      data-environment={environment}
      title={label ? `${label} · ${release}` : release}
    >
      <div
        className="app-env-toggle"
        role="radiogroup"
        aria-label="Ambiente do console"
        style={{ "--env-index": index } as CSSProperties}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (!step) return;
          event.preventDefault();
          const next = offered[(index + step + offered.length) % offered.length];
          select(next);
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
          buttons[offered.indexOf(next)]?.focus();
        }}
      >
        <span className="app-env-toggle__thumb" aria-hidden="true" />
        {offered.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={environment === option}
            tabIndex={environment === option ? 0 : -1}
            data-environment={option}
            className="app-env-toggle__option"
            onClick={() => select(option)}
          >
            <span className="app-env-toggle__dot" aria-hidden="true" />
            {environmentNames[option]}
          </button>
        ))}
      </div>
      <p className="app-env-card__detail" key={environment} aria-live="polite">
        {environment === "production"
          ? "Notas reais da captura fiscal"
          : "Emissão sem validade fiscal"}
        {label ? <span className="app-env-card__profile">{label}</span> : null}
      </p>
    </div>
  );
}

function AccountMenu({
  account,
  version,
  invitations,
  onSignOut,
  signingOut,
}: {
  account: ShellAccount;
  version: string;
  invitations: boolean;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const navigate = useNavigate();
  const theme = useTheme();
  return (
    <Menu
      placement="top-start"
      matchWidth
      triggerClassName="app-account"
      trigger={
        <>
          <span className="app-avatar" aria-hidden="true">
            {initial(account.name)}
          </span>
          <span className="app-switcher__text">
            <strong title={account.name}>{account.name}</strong> <span>{account.role}</span>
          </span>{" "}
          <span className="ui-visually-hidden">(menu da conta)</span>
          <Icon name="chevronsUpDown" />
        </>
      }
      header={
        <MenuHeader>
          <strong>{account.name}</strong>
          <span>Versão {version.slice(0, 7)}</span>
        </MenuHeader>
      }
    >
      <MenuGroup label="Tema">
        {(["light", "dark", "system"] as const).map((option) => (
          <MenuRadioItem
            key={option}
            icon={themeIcon[option]}
            checked={theme.preference === option}
            onSelect={() => theme.setPreference(option)}
          >
            {themeLabels[option]}
          </MenuRadioItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon="layers" onSelect={() => void navigate({ to: "/app" })}>
        Todas as organizações
      </MenuItem>
      {invitations && (
        <MenuItem icon="users" onSelect={() => void navigate({ to: "/accept-invitation" })}>
          Aceitar convite
        </MenuItem>
      )}
      <MenuItem icon="settings" onSelect={() => void navigate({ to: "/account" })}>
        Minha conta
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="logout" onSelect={onSignOut} disabled={signingOut}>
        {signingOut ? "Saindo…" : "Sair"}
      </MenuItem>
    </Menu>
  );
}

/**
 * A lateral enquanto o servidor confere a sessão: a moldura, sem nenhum dado privado. Só aparece
 * quando este navegador guarda uma sessão (`session-hint.ts`); sem ela, a conferência continua
 * em tela cheia.
 */
function PendingNavigation() {
  return (
    <div className="app-nav" aria-hidden="true">
      <div className="app-nav__group">
        {["70%", "55%", "62%", "48%", "66%", "52%"].map((width, index) => (
          <span key={index} className="app-nav__placeholder">
            <Skeleton width={width} />
          </span>
        ))}
      </div>
    </div>
  );
}
function PendingAccount() {
  return (
    <div className="app-account app-account--pending" aria-hidden="true">
      <span className="app-avatar" />
      <Skeleton width="60%" />
    </div>
  );
}

/** Seletor de organização no topo da lateral ("Equipe Ipê ▾"). */
function OrganizationSwitcher({ value }: { value: ShellOrganization }) {
  const { org, contextKey, onSwitch } = value;
  const navigate = useNavigate();
  const { results, status, loadMore } = usePaginatedQuery(
    api.organizations.listMine,
    { contextKey },
    { initialNumItems: 20 },
  );
  const listed = results.some((item) => item.slug === org.slug);
  return (
    <Menu
      matchWidth
      triggerClassName="app-switcher"
      trigger={
        <>
          <span className="app-mark" aria-hidden="true">
            {initial(org.name)}
          </span>
          <span className="app-switcher__text">
            <span className="ui-visually-hidden">Organização atual:</span>{" "}
            <strong title={org.name}>{org.name}</strong>{" "}
            <span>{membershipRoleLabels[org.role]}</span>
          </span>
          <Icon name="chevronsUpDown" />
        </>
      }
    >
      <MenuGroup label="Organizações">
        {!listed && (
          <MenuRadioItem checked value={org.slug} onSelect={() => undefined}>
            {org.name}
          </MenuRadioItem>
        )}
        {results.map((item) => (
          <MenuRadioItem
            key={item.id}
            checked={item.slug === org.slug}
            value={item.slug}
            meta={membershipRoleLabels[item.role]}
            onSelect={() => {
              if (item.slug === org.slug) return;
              onSwitch();
              void navigate({
                to: "/app/$organizationSlug",
                params: { organizationSlug: item.slug },
              });
            }}
          >
            {item.name}
          </MenuRadioItem>
        ))}
        {(status === "CanLoadMore" || status === "LoadingMore") && (
          <MenuItem keepOpen disabled={status === "LoadingMore"} onSelect={() => loadMore(20)}>
            {status === "LoadingMore" ? "Carregando…" : "Carregar mais"}
          </MenuItem>
        )}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        icon="layers"
        onSelect={() => {
          onSwitch();
          void navigate({ to: "/app" });
        }}
      >
        Todas as organizações
      </MenuItem>
    </Menu>
  );
}

/** O início: a última organização deste navegador, direto, ou `/console`, que a encontra. */
export function HomeLink({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const slug = rememberedOrganizationSlug();
  return slug ? (
    <Link
      to="/app/$organizationSlug"
      params={{ organizationSlug: slug }}
      className={className}
      {...rest}
    >
      {children}
    </Link>
  ) : (
    <Link to="/console" className={className} {...rest}>
      {children}
    </Link>
  );
}

function Brand() {
  return (
    <HomeLink className="app-brand" aria-label="Freecorps Fiscal, início">
      <span className="app-mark" aria-hidden="true">
        f
      </span>
      <span>
        freecorps <span className="app-brand__product">fiscal</span>
      </span>
    </HomeLink>
  );
}

/** Destinos sem organização: a lista, os convites e as ferramentas da plataforma. */
function GeneralNavigation({
  tools,
  invitations,
  onNavigate,
}: {
  tools: ShellTools;
  invitations: boolean;
  onNavigate: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = (path: string) => (pathname === path ? "page" : undefined);
  return (
    <nav className="app-nav" aria-label="Navegação do console">
      <div className="app-nav__group">
        <Link
          to="/app"
          activeOptions={{ exact: true }}
          className="app-nav__item"
          aria-current={current("/app")}
          onClick={onNavigate}
        >
          <Icon name="layers" />
          Organizações
        </Link>
        {invitations && (
          <Link
            to="/accept-invitation"
            className="app-nav__item"
            aria-current={current("/accept-invitation")}
            onClick={onNavigate}
          >
            <Icon name="users" />
            Aceitar convite
          </Link>
        )}
      </div>
      <PlatformTools tools={tools} onNavigate={onNavigate} />
    </nav>
  );
}
function PlatformTools({ tools, onNavigate }: { tools: ShellTools; onNavigate: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (
    !tools.diagnostics &&
    !tools.prototype &&
    !tools.components &&
    !tools.privacy &&
    !tools.security &&
    !tools.support &&
    !tools.operation
  )
    return null;
  return (
    <div className="app-nav__group">
      <p className="app-nav__label">Plataforma</p>
      {tools.privacy && (
        <Link
          to="/console/privacidade"
          className="app-nav__item"
          aria-current={pathname === "/console/privacidade" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="inbox" /> Privacidade
        </Link>
      )}
      {tools.security && (
        <Link
          to="/console/seguranca"
          className="app-nav__item"
          aria-current={pathname === "/console/seguranca" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="shield" /> Segurança
        </Link>
      )}
      {tools.support && (
        <Link
          to="/console/suporte"
          className="app-nav__item"
          aria-current={pathname === "/console/suporte" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="lifebuoy" /> Suporte
        </Link>
      )}
      {tools.operation && (
        <Link
          to="/console/operacao"
          className="app-nav__item"
          aria-current={pathname === "/console/operacao" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="warning" /> Operação
        </Link>
      )}
      {tools.diagnostics && (
        <Link
          to="/console/diagnostico"
          className="app-nav__item"
          aria-current={pathname === "/console/diagnostico" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="gauge" />
          Diagnóstico
        </Link>
      )}
      {tools.prototype && (
        <Link
          to="/console/prototipo/$screen"
          params={{ screen: "onboarding" }}
          search={{ role: "owner" }}
          className="app-nav__item"
          aria-current={pathname.startsWith("/console/prototipo") ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="layers" />
          Protótipo
        </Link>
      )}
      {tools.components && (
        <Link
          to="/console/componentes"
          className="app-nav__item"
          aria-current={pathname === "/console/componentes" ? "page" : undefined}
          onClick={onNavigate}
        >
          <Icon name="code" />
          Componentes
        </Link>
      )}
    </div>
  );
}

/** Comandos da paleta: os mesmos destinos da lateral, as ações rápidas e o tema. */
function useCommands(organization: ShellOrganization | null, invitations: boolean): Command[] {
  const navigate = useNavigate();
  const theme = useTheme();
  return useMemo(() => {
    const commands: Command[] = [];
    if (organization) {
      const { org } = organization;
      if (org.capabilities.operateDocuments)
        commands.push(
          {
            id: "action:issuance",
            label: "Nova emissão NFS-e",
            group: "Ações",
            icon: "plus",
            keywords: "emitir nfse nota serviço",
            run: () =>
              void navigate({
                to: "/app/$organizationSlug/issuances",
                params: { organizationSlug: org.slug },
                search: { view: "new" },
              }),
          },
          {
            id: "action:import",
            label: "Importar XML",
            group: "Ações",
            icon: "upload",
            keywords: "enviar arquivo nfe",
            run: () =>
              void navigate({
                to: "/app/$organizationSlug/imports",
                params: { organizationSlug: org.slug },
              }),
          },
        );
      // Every member: the DANFE lookup reads no fiscal data (#296).
      commands.push({
        id: "action:danfe",
        label: "Consultar NF-e pelo DANFE",
        group: "Ações",
        icon: "search",
        keywords: "chave de acesso danfe portal nf-e consultar",
        run: () =>
          void navigate({
            to: "/app/$organizationSlug/imports/danfe",
            params: { organizationSlug: org.slug },
          }),
      });
      for (const destination of organizationDestinations(org))
        commands.push({
          id: `go:${destination.key}`,
          label: destination.label,
          group: `Ir para · ${org.name}`,
          icon: destination.icon,
          keywords: destination.keywords,
          run: () =>
            void navigate({
              to: destination.to as "/app/$organizationSlug",
              params: destination.params as { organizationSlug: string },
            }),
        });
    }
    commands.push(
      {
        id: "go:organizations",
        label: "Todas as organizações",
        group: "Console",
        icon: "layers",
        keywords: "trocar organização lista",
        run: () => {
          organization?.onSwitch();
          void navigate({ to: "/app" });
        },
      },
      ...(invitations
        ? [
            {
              id: "go:invitation",
              label: "Aceitar convite",
              group: "Console",
              icon: "users",
              keywords: "código entrar organização",
              run: () => void navigate({ to: "/accept-invitation" }),
            } satisfies Command,
          ]
        : []),
      ...(["light", "dark", "system"] as const).map((option): Command => ({
        id: `theme:${option}`,
        label: `Tema: ${themeLabels[option]}`,
        group: "Preferências",
        icon: themeIcon[option],
        keywords: "aparência cor modo claro escuro sistema",
        hint: theme.preference === option ? "Atual" : undefined,
        run: () => theme.setPreference(option),
      })),
    );
    return commands;
  }, [organization, invitations, navigate, theme]);
}

const sandboxDeployment: Deployment = {
  environment: "sandbox",
  fiscalProduction: false,
  confirmed: true,
};

/** A moldura da casca, marcada com o ambiente escolhido: Produção pinta a faixa do modo fiscal. */
function ShellFrame({ drawer, children }: { drawer: boolean; children: ReactNode }) {
  const { environment } = useProductEnvironment();
  return (
    <div
      className="app-shell"
      data-drawer={drawer ? "open" : "closed"}
      data-environment={environment}
    >
      {children}
    </div>
  );
}

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Casca do console autenticado: lateral com seletor de organização, busca (⌘K), navegação por
 * papel, ambiente e conta. Abaixo de 960 px a lateral vira gaveta, com foco preso enquanto
 * aberta; navegar, Esc ou tocar fora fecham. Sem `account`, a sessão ainda está sendo conferida:
 * a lateral mostra só a marca, o ambiente e espaços reservados, e o conteúdo é o aviso de espera.
 * É o mesmo componente da casca pronta, então nada remonta quando o servidor responde.
 */
export function AppShell({
  account,
  tools,
  environment,
  deployment,
  version,
  onSignOut,
  signingOut,
  children,
}: {
  account: ShellAccount | null;
  tools: ShellTools;
  /** Perfil técnico do console (`deploymentLabel`); ausente no perfil `installation`. */
  environment?: string;
  /** Ambiente do deployment, para o selo; sem ele, o sandbox. */
  deployment?: Deployment;
  version: string;
  onSignOut: () => void;
  signingOut: boolean;
  children: ReactNode;
}) {
  const [organization, setOrganization] = useState<ShellOrganization | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Invitations only reach people by e-mail (#538): without account e-mail the panel creates
  // none, so "Aceitar convite" leaves the menus. Only an explicit `false` hides it; the route
  // stays reachable for links already sent. Asked only with the account, never during the wait.
  const capabilities = useQuery(api.account.capabilities, account ? {} : "skip");
  const invitations = capabilities?.invitationEmail !== false;
  const commands = useCommands(organization, invitations);
  // The menu button sits in the topbar, which is `inert` while the drawer is open: give the
  // focus back only after the drawer has closed.
  const returnFocus = useRef(false);
  const closeDrawer = useCallback((focusMenuButton = false) => {
    returnFocus.current = focusMenuButton;
    setDrawer(false);
  }, []);
  useEffect(() => {
    if (drawer || !returnFocus.current) return;
    returnFocus.current = false;
    menuButton.current?.focus();
  }, [drawer]);

  // A gaveta fecha ao navegar e quando a tela volta a ser larga.
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia("(min-width: 961px)");
    const onChange = () => wide.matches && setDrawer(false);
    wide.addEventListener?.("change", onChange);
    return () => wide.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    if (drawer) focusableIn(sidebar.current)[0]?.focus();
  }, [drawer]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !event.isComposing
      ) {
        event.preventDefault();
        setPalette((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shortcut = isMac() ? "⌘K" : "Ctrl K";
  const title = organization?.org.name ?? "Freecorps Fiscal";
  return (
    <ShellContext.Provider value={setOrganization}>
      <ProductEnvironmentProvider
        organizationId={organization?.org.id}
        deployment={deployment ?? sandboxDeployment}
        enabled={!!account}
      >
        <ShellFrame drawer={drawer}>
          <header className="app-topbar" inert={drawer || undefined}>
            <IconButton
              ref={menuButton}
              icon="menu"
              label="Abrir menu"
              aria-expanded={drawer}
              aria-controls="app-sidebar"
              onClick={() => setDrawer(true)}
            />
            <span className="app-topbar__title">{title}</span>
            <IconButton
              icon="search"
              label={`Buscar ou ir para (${shortcut})`}
              onClick={() => setPalette(true)}
            />
          </header>
          <div className="app-scrim" aria-hidden="true" onClick={() => closeDrawer(true)} />
          <aside
            ref={sidebar}
            id="app-sidebar"
            className="app-sidebar"
            aria-label="Menu do console"
            onKeyDown={(event) => {
              if (!drawer) return;
              if (event.key === "Escape") {
                event.stopPropagation();
                closeDrawer(true);
              } else trapTab(event, sidebar.current);
            }}
          >
            {organization ? <OrganizationSwitcher value={organization} /> : <Brand />}
            <button type="button" className="app-search" onClick={() => setPalette(true)}>
              <Icon name="search" />
              <span>Buscar ou ir para…</span>
              <kbd className="ui-kbd" aria-hidden="true">
                {shortcut}
              </kbd>
              <span className="ui-visually-hidden"> ({shortcut})</span>
            </button>
            <div className="app-sidebar__scroll">
              {!account ? (
                <PendingNavigation />
              ) : organization ? (
                <>
                  <OrganizationNavigation
                    org={organization.org}
                    current={organization.current}
                    onNavigate={() => setDrawer(false)}
                  />
                  {(tools.diagnostics ||
                    tools.prototype ||
                    tools.components ||
                    tools.privacy ||
                    tools.security ||
                    tools.support ||
                    tools.operation) && (
                    <nav className="app-nav" aria-label="Ferramentas da plataforma">
                      <PlatformTools tools={tools} onNavigate={() => setDrawer(false)} />
                    </nav>
                  )}
                </>
              ) : (
                <GeneralNavigation
                  tools={tools}
                  invitations={invitations}
                  onNavigate={() => setDrawer(false)}
                />
              )}
            </div>
            <div className="app-sidebar__footer">
              <EnvironmentBadge label={environment} version={version} deployment={deployment} />
              {account ? (
                <AccountMenu
                  account={account}
                  version={version}
                  invitations={invitations}
                  onSignOut={onSignOut}
                  signingOut={signingOut}
                />
              ) : (
                <PendingAccount />
              )}
            </div>
          </aside>
          <main className="app-main" id="main" tabIndex={-1} inert={drawer || undefined}>
            <div className="app-main__inner">{children}</div>
          </main>
        </ShellFrame>
      </ProductEnvironmentProvider>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
    </ShellContext.Provider>
  );
}
