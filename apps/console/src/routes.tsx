import { lazy, type ReactNode } from "react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import { membershipRoles, type MembershipRole } from "@freecorps/contracts/organizations";
import { convex } from "./convex-client";
import { safeRedirect } from "./session-handoff";
import { parseTask, taskOnTheWay, type ConsoleTask } from "./console-task";
import {
  Unavailable,
  shownOrganizationScope,
  useOrganizationScope,
  type OrganizationScope,
  type OrganizationView,
} from "./organization-scope";
import {
  AUDIT_PAGE_SIZE,
  COMPANIES_PAGE_SIZE,
  auditArgs,
  companiesListArgs,
  companyArgs,
  companyContextArgs,
  usageAsOf,
  defaultAuditFilters,
  firstPageArgs,
  operationsOverviewArgs,
  rememberedCompany,
  soleCompanyArgs,
  usageArgs,
} from "./page-queries";
import { Notice } from "./route-errors";
import { HomeLink } from "./app-shell";
import { Frame, PagePending, ProtectedLayout, RouteError, SessionMessage } from "./session-layout";
import { Login } from "./login";
import { Diagnostics, Overview } from "./console-home";
import { buttonClass } from "./ui/button";
import { SandboxOnly } from "./sandbox-only";

const Prototype = import.meta.env.DEV
  ? lazy(() => import("./dev/prototype").then((m) => ({ default: m.Prototype })))
  : null;
/** Referência interna dos componentes, só no desenvolvimento (fora do build publicado). */
const ComponentReference = import.meta.env.DEV
  ? lazy(() => import("./dev/component-reference").then((m) => ({ default: m.ComponentReference })))
  : null;

/**
 * A page of an organization, in its own chunk. The router downloads it together with the
 * organization layout (and on hover or focus of a link, `defaultPreload: "intent"`), never after
 * the organization's query answered; the page reads the authorized organization from the layout.
 */
function organizationPage<M>(
  load: () => Promise<M>,
  render: (module: M, scope: OrganizationScope, params: PageParams) => ReactNode,
) {
  return lazyRouteComponent(
    () =>
      load().then((module) => ({
        default: function OrganizationPageRoute() {
          const scope = useOrganizationScope();
          const params: PageParams = useParams({ strict: false });
          return <>{render(module, scope, params)}</>;
        },
      })),
    "default",
  );
}
type PageParams = { companyId?: string; projectId?: string; developerSection?: string };

/**
 * Asks for a page's first queries while its code arrives. A route's `loader` runs on the
 * navigation and on hover or focus of a link (`defaultPreload: "intent"`), together with the
 * download of the chunk; the page used to subscribe only after its code ran. Only inside the
 * organization the layout is showing, with the authorized scope and its query key; the page then
 * subscribes to the same queries with the same arguments (`page-queries.ts`) and finds the
 * answers. The client closes an unclaimed subscription after 5 s; nothing is awaited, and the
 * server checks access on every query (docs/desenvolvimento/frontend.md, "Consultas antecipadas").
 */
function organizationLoader<Params extends { organizationSlug: string }>(
  ask: (scope: OrganizationScope, search: Record<string, unknown>, params: Params) => void,
) {
  return ({ params, location }: { params: Params; location: { search: unknown } }) => {
    const scope = shownOrganizationScope(params.organizationSlug);
    if (scope) ask(scope, (location.search ?? {}) as Record<string, unknown>, params);
  };
}
function prewarm<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
) {
  // Asking ahead is only a head start: it never fails the navigation.
  try {
    convex.prewarmQuery({ query, args });
  } catch {
    // The page subscribes on its own, as before.
  }
}
/** The company picker of the fiscal screens (`useCompanyChoice`): the list and the choice. */
function prewarmCompanyChoice(scope: OrganizationScope, search: Record<string, unknown>) {
  prewarm(api.companies.list, firstPageArgs(companiesListArgs(scope), COMPANIES_PAGE_SIZE));
  const selected = typeof search.company === "string" ? search.company : "";
  const candidate = selected || rememberedCompany(scope.org.id);
  if (candidate) prewarm(api.consoleCompany.context, companyContextArgs(scope, candidate));
  else prewarm(api.consoleCompany.sole, soleCompanyArgs(scope));
}
const companyChoiceLoader = organizationLoader(prewarmCompanyChoice);
function managersOnly(
  scope: OrganizationScope,
  title: string,
  description: string,
  page: ReactNode,
) {
  return scope.org.capabilities.manageOrganization ? (
    page
  ) : (
    <Unavailable title={title} description={description} />
  );
}

/**
 * Marks the page of an organization for the shell's menu (`OrganizationLayout`); the
 * `staticData` field is declared beside `OrganizationView` (`organization-scope.tsx`).
 */
const view = (organizationView: OrganizationView) => ({ staticData: { organizationView } });

const rootRoute = createRootRoute({
  component: Frame,
  notFoundComponent: () => (
    <SessionMessage title="Página não encontrada.">
      <p className="auth-card__description">Confira o endereço ou volte ao painel.</p>
      <HomeLink className={buttonClass({ variant: "primary", block: true })}>
        Voltar ao painel
      </HomeLink>
    </SessionMessage>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/console" replace />,
});
/** Search of the login and account screens: where to return and the e-mail to fill. */
const accountSearch = (search: Record<string, unknown>): { redirect?: string; email?: string } => ({
  redirect: safeRedirect(search.redirect),
  email: typeof search.email === "string" ? search.email : undefined,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: accountSearch,
  component: Login,
});
const accountRoutes = (
  ["signup", "verify-email", "forgot-password", "reset-password"] as const
).map((mode) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${mode}` as const,
    validateSearch: accountSearch,
    component: lazyRouteComponent(
      () =>
        import("./account-forms").then((m) => ({
          default: () => <m.AccountForm mode={mode} />,
        })),
      "default",
    ),
  }),
);
/**
 * Every authenticated page lives under one layout: the session check and the shell render once
 * and stay while the person navigates; only the page below them changes.
 */
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: ProtectedLayout,
});
const consoleRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/console",
});
const overviewRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: "/",
  validateSearch: taskOnTheWay,
  component: Overview,
});
const diagnosticsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: "/diagnostico",
  component: Diagnostics,
});
const componentsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: "/componentes",
  component: () =>
    ComponentReference ? (
      <ComponentReference />
    ) : (
      <Notice
        title="Página não encontrada."
        action={<HomeLink className={buttonClass()}>Voltar ao painel</HomeLink>}
      >
        A referência de componentes só existe no desenvolvimento.
      </Notice>
    ),
});
const prototypeRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: "/prototipo/$screen",
  validateSearch: (search: Record<string, unknown>): { role: MembershipRole } => ({
    role: membershipRoles.includes(search.role as MembershipRole)
      ? (search.role as MembershipRole)
      : "owner",
  }),
  component: PrototypeRoute,
});
function PrototypeRoute() {
  const { screen } = prototypeRoute.useParams();
  const { role } = prototypeRoute.useSearch();
  const navigate = useNavigate();
  if (!Prototype)
    return (
      <Notice
        title="Demonstração indisponível"
        action={
          <a className={buttonClass()} href="/docs/">
            Abrir documentação
          </a>
        }
      >
        Use o guia de integração com dados sintéticos.
      </Notice>
    );
  return (
    <Prototype
      key={screen}
      screen={screen}
      role={role}
      onRole={(role) => {
        void navigate({ to: "/console/prototipo/$screen", params: { screen }, search: { role } });
      }}
    />
  );
}
const invitationRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/accept-invitation",
  component: lazyRouteComponent(() => import("./organizations"), "AcceptInvitation"),
});
const accountRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/account",
  component: lazyRouteComponent(() => import("./account-settings"), "AccountSettings"),
});
/**
 * The archived text of a version of the fiscal capture terms (#428), behind the login. `voltar` is
 * the console address the link was opened from, checked like a login return.
 */
const captureTermsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/termos/captura-fiscal/$version",
  validateSearch: (search: Record<string, unknown>): { voltar?: string } => {
    const voltar = safeRedirect(search.voltar);
    return voltar ? { voltar } : {};
  },
  component: lazyRouteComponent(() => import("./capture-terms"), "CaptureTermsPage"),
});
/**
 * The legal texts the organization accepts or that apply to everyone (#428): public, outside the
 * login, so that anyone reads them before signing up. `/termos` and `/privacidade` show the
 * version in effect; the others, by version, stay for whoever accepted them.
 */
const termsOfUseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/termos/uso/$version",
  validateSearch: (search: Record<string, unknown>): { voltar?: string } => {
    const voltar = safeRedirect(search.voltar);
    return voltar ? { voltar } : {};
  },
  component: lazyRouteComponent(() => import("./public-texts"), "TermsOfUsePage"),
});
const currentTermsOfUseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/termos",
  component: lazyRouteComponent(() => import("./public-texts"), "CurrentTermsOfUsePage"),
});
const currentPrivacyPolicyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacidade",
  component: lazyRouteComponent(() => import("./public-texts"), "CurrentPrivacyPolicyPage"),
});
const privacyPolicyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacidade/$version",
  component: lazyRouteComponent(() => import("./public-texts"), "PrivacyPolicyPage"),
});
const appRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/app",
});
const organizationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: taskOnTheWay,
  component: lazyRouteComponent(() => import("./organizations"), "OrganizationHome"),
});
/** The organization: authorized once by its layout, kept across its pages. */
const organizationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "$organizationSlug",
  component: lazyRouteComponent(() => import("./organizations"), "OrganizationLayout"),
});
const organizationHomeRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "/",
  ...view("overview"),
  component: lazyRouteComponent(() => import("./organizations"), "OrganizationOverviewRoute"),
  // The task the Início guides (#510); an unknown value is ignored.
  validateSearch: (search: Record<string, unknown>): { tarefa?: ConsoleTask } => ({
    tarefa: parseTask(search.tarefa),
  }),
});
const organizationSettingsRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "settings/$section",
  ...view("settings"),
  component: lazyRouteComponent(() => import("./organizations"), "OrganizationSettingsRoute"),
});
const companiesPage = organizationPage(
  () => import("./companies"),
  (m, { org, contextKey }, { companyId }) => (
    <m.Companies org={org} companyId={companyId} contextKey={contextKey} />
  ),
);
const companiesRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "companies",
  ...view("companies"),
  component: companiesPage,
  loader: organizationLoader((scope) =>
    prewarm(api.companies.list, firstPageArgs(companiesListArgs(scope), COMPANIES_PAGE_SIZE)),
  ),
});
const companyRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "companies/$companyId",
  ...view("companies"),
  component: companiesPage,
  loader: organizationLoader<{ organizationSlug: string; companyId: string }>(
    (scope, _search, params) => prewarm(api.companies.get, companyArgs(scope, params.companyId)),
  ),
});
const onboardingRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "onboarding",
  ...view("onboarding"),
  component: organizationPage(
    () => import("./onboarding"),
    (m, { org, contextKey }) => <m.Onboarding org={org} contextKey={contextKey} />,
  ),
});
const operationsRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "operations",
  ...view("operations"),
  component: organizationPage(
    () => import("./operations"),
    (m, scope) =>
      managersOnly(
        scope,
        "Operação e suporte",
        "Suporte disponível aos administradores da organização.",
        <m.Operations org={scope.org} contextKey={scope.contextKey} />,
      ),
  ),
  loader: organizationLoader((scope) => {
    if (!scope.org.capabilities.manageOrganization) return;
    prewarm(api.observability.overview, operationsOverviewArgs(scope));
    prewarm(
      api.observability.audit,
      firstPageArgs(auditArgs(scope, defaultAuditFilters()), AUDIT_PAGE_SIZE),
    );
  }),
});
const usageRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "usage",
  ...view("usage"),
  component: organizationPage(
    () => import("./usage"),
    (m, scope) =>
      managersOnly(
        scope,
        "Uso e limites",
        "Consumo disponível aos administradores da organização.",
        <m.Usage org={scope.org} contextKey={scope.contextKey} />,
      ),
  ),
  loader: organizationLoader((scope) => {
    if (scope.org.capabilities.manageOrganization)
      prewarm(api.usage.overview, usageArgs(scope, usageAsOf()));
  }),
});
const exportsRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "exports",
  ...view("exports"),
  component: organizationPage(
    () => import("./exports"),
    // A new context entry (or membership version) drops the downloads of the previous one.
    (m, { org, contextKey }) => <m.Exports key={contextKey} org={org} />,
  ),
});
const referencesRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "references",
  ...view("references"),
  component: organizationPage(
    () => import("./references"),
    (m, { org, contextKey }) => <m.References org={org} contextKey={contextKey} />,
  ),
  loader: companyChoiceLoader,
});
const developerPage = organizationPage(
  () => import("./projects"),
  (m, { org, contextKey }, { projectId, developerSection }) => (
    <m.Projects
      org={org}
      contextKey={contextKey}
      projectId={projectId}
      section={developerSection}
    />
  ),
);
const developerRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "developer/$developerSection",
  ...view("developer"),
  component: developerPage,
});
const projectRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "developer/$developerSection/$projectId",
  ...view("developer"),
  component: developerPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { company?: string; endpoint?: string; env?: "sandbox" | "production" } => ({
    company: typeof search.company === "string" ? search.company : undefined,
    endpoint: typeof search.endpoint === "string" ? search.endpoint : undefined,
    env: search.env === "production" || search.env === "sandbox" ? search.env : undefined,
  }),
});
const importsRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "imports",
  ...view("imports"),
  component: organizationPage(
    () => import("./imports"),
    (m, { org, contextKey }) => (
      <SandboxOnly
        title="Importar XML"
        reason="Em Produção, os documentos chegam pela captura fiscal da empresa. A importação de XML fica no Sandbox."
      >
        <m.Imports org={org} contextKey={contextKey} />
      </SandboxOnly>
    ),
  ),
  loader: companyChoiceLoader,
  validateSearch: (
    search: Record<string, unknown>,
  ): { company?: string; project?: string; batch?: string } => ({
    company: typeof search.company === "string" ? search.company : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    batch: typeof search.batch === "string" ? search.batch : undefined,
  }),
});
/**
 * The DANFE lookup (#296), reached from Importar XML, Documentos and the command palette:
 * client-side only, it reads no fiscal data, so every member may open it. No search parameters: the key never goes into the address.
 */
const danfeLookupRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "imports/danfe",
  ...view("danfe"),
  component: organizationPage(
    () => import("./danfe-lookup"),
    (m, { org }) => <m.DanfeLookup org={org} />,
  ),
});
const documentsRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "documents",
  ...view("documents"),
  component: organizationPage(
    () => import("./documents"),
    (m, { org, contextKey }) => <m.Documents org={org} contextKey={contextKey} />,
  ),
  loader: companyChoiceLoader,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    company?: string;
    project?: string;
    document?: string;
    version?: string;
    status?: string;
    key?: string;
    from?: string;
    to?: string;
    source?: string;
    env?: "sandbox" | "production";
    completeness?: "summary";
  } => ({
    company: typeof search.company === "string" ? search.company : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    document: typeof search.document === "string" ? search.document : undefined,
    env: search.env === "production" || search.env === "sandbox" ? search.env : undefined,
    completeness: search.completeness === "summary" ? "summary" : undefined,
    version: typeof search.version === "string" ? search.version : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    key: typeof search.key === "string" ? search.key : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
  }),
});
const issuancesRoute = createRoute({
  getParentRoute: () => organizationRoute,
  path: "issuances",
  ...view("issuances"),
  component: organizationPage(
    () => import("./issuances"),
    (m, { org, contextKey }) => (
      <SandboxOnly
        title="Emissão NFS-e"
        reason="A emissão com validade fiscal ainda não existe neste ambiente. Emita no Sandbox, com transporte simulado e sem validade fiscal."
      >
        <m.Issuances org={org} contextKey={contextKey} />
      </SandboxOnly>
    ),
  ),
  loader: companyChoiceLoader,
  validateSearch: (
    search: Record<string, unknown>,
  ): { company?: string; project?: string; issuance?: string; view?: string } => ({
    company: typeof search.company === "string" ? search.company : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    issuance: typeof search.issuance === "string" ? search.issuance : undefined,
    view: search.view === "new" ? "new" : undefined,
  }),
});
export const router = createRouter({
  // A failure stays in the place of the route that failed: inside the shell for a page.
  defaultErrorComponent: RouteError,
  // A page whose code is still arriving: the previous page stays for a moment, then a skeleton
  // in its place (never the whole screen), shown long enough not to flash.
  defaultPendingComponent: PagePending,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
  // Hover or focus on a link downloads the page's code; the data stays in Convex subscriptions.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  routeTree: rootRoute.addChildren([
    indexRoute,
    loginRoute,
    ...accountRoutes,
    termsOfUseRoute,
    currentTermsOfUseRoute,
    currentPrivacyPolicyRoute,
    privacyPolicyRoute,
    authenticatedRoute.addChildren([
      consoleRoute.addChildren([overviewRoute, diagnosticsRoute, prototypeRoute, componentsRoute]),
      invitationRoute,
      accountRoute,
      captureTermsRoute,
      appRoute.addChildren([
        organizationsRoute,
        organizationRoute.addChildren([
          organizationHomeRoute,
          organizationSettingsRoute,
          companiesRoute,
          companyRoute,
          onboardingRoute,
          operationsRoute,
          usageRoute,
          exportsRoute,
          referencesRoute,
          developerRoute,
          projectRoute,
          importsRoute,
          danfeLookupRoute,
          documentsRoute,
          issuancesRoute,
        ]),
      ]),
    ]),
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
