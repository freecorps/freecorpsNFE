import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useConvexAuth, useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Link,
  Outlet,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { api } from "../../../platform/convex/_generated/api";
import { authClient } from "./auth";
import { convex } from "./convex-client";
import { browserSessionHint } from "./session-hint";
import { organizationSlugOf, prewarmOrganization } from "./organization-prewarm";
import {
  forgetOrganization,
  hasPendingInvitation,
  leaveConsole,
  safeRedirect,
} from "./session-handoff";
import { ErrorBoundary, ErrorNotice, Notice } from "./route-errors";
import { AppShell } from "./app-shell";
import { useDeployment } from "./deployment";
import { AuthLayout } from "./auth-layout";
import { deploymentLabel, local, version } from "./environment";
import { Button, buttonClass } from "./ui/button";
import { Page, SkeletonBlock } from "./ui/layout";

/** The session is being checked: the authentication transport or the server's answer. */
export function Pending() {
  return (
    <Page>
      <SkeletonBlock label="Verificando sua sessão…" />
    </Page>
  );
}
/**
 * A page's code is still arriving. Inside the console it takes the place of the page only, under
 * the shell; on the account screens, of the card.
 */
export function PagePending() {
  return (
    <Page>
      <SkeletonBlock label="Carregando a página…" />
    </Page>
  );
}

/** Error of a route, in the place of that route: the shell stays around a page that failed. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <ErrorNotice
      error={error}
      onRetry={() => {
        reset();
        // A chunk or a load that failed is fetched again; a page that threw renders again.
        void router.invalidate();
      }}
    />
  );
}

/**
 * Root frame: the skip link and the last error boundary. Each layout draws its own chrome: the
 * account pages (`AuthLayout`) show the environment and the version; the console (`AppShell`)
 * shows them in the sidebar. The boundary forgets a failure when the address or the session
 * changes, without remounting the tree while nothing failed.
 */
export function Frame() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isAuthenticated } = useConvexAuth();
  return (
    <>
      <a className="app-skip-link" href="#main">
        Pular para o conteúdo
      </a>
      <ErrorBoundary resetKey={`${pathname}:${isAuthenticated}`}>
        <Suspense fallback={<PagePending />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

/** Session states outside the shell: ending, failed to end, signed out. */
export function SessionMessage({
  eyebrow,
  title,
  children,
  role,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <AuthLayout>
      <section className="auth-card" role={role} aria-labelledby="session-title">
        {eyebrow && <p className="auth-card__eyebrow">{eyebrow}</p>}
        <h1 id="session-title" className="auth-card__title">
          {title}
        </h1>
        <div className="auth-status">{children}</div>
      </section>
    </AuthLayout>
  );
}

type Profile = FunctionReturnType<typeof api.account.profile>;

export function ProtectedLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  // A session this browser holds (only a hint): the shell's frame instead of a full-screen wait,
  // and the session, the profile and the organization of the address asked all at once.
  const hint = browserSessionHint();
  // While the transport is still authenticating, the subscriptions travel after its token on the
  // connection; their answers count only once the server confirmed it (`isAuthenticated`).
  const asking = isAuthenticated || (isLoading && hint);
  const session = useQuery(api.access.session, asking ? {} : "skip");
  // The environment travels with the session, never before it (the wait asks nothing).
  const deployment = useDeployment(asking);
  // The profile goes together with the session, not after it. It refuses an ended session or an
  // unverified e-mail: `useQueries` hands that refusal back instead of throwing, so it is thrown
  // below only where the profile is needed, as the separate subscription did.
  // (`useQueries` resubscribes whenever this object changes identity: memoized.)
  const profileQuery = useMemo(
    (): RequestForQueries =>
      asking
        ? {
            profile: { query: api.account.profile, args: {} },
          }
        : {},
    [asking],
  );
  const answers: {
    profile?: Profile | Error;
  } = useQueries(profileQuery);
  const current = isAuthenticated ? session : undefined;
  const needsProfile = !!current && (local || !current.role);
  const profileAnswer = needsProfile ? answers.profile : undefined;
  const profile = profileAnswer instanceof Error ? undefined : profileAnswer;
  const pending =
    isLoading || (isAuthenticated && (current === undefined || (needsProfile && !profile)));
  // On `/app/<slug>`, the organization's context goes with the session too (organization-prewarm).
  const organizationSlug =
    typeof window === "undefined" ? undefined : organizationSlugOf(window.location.pathname);
  useEffect(() => {
    if (pending && asking && organizationSlug) prewarmOrganization(convex, organizationSlug);
  }, [pending, asking, organizationSlug]);
  const [signOutError, setSignOutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  if (profileAnswer instanceof Error) throw profileAnswer;
  /**
   * Ends the session, then leaves the console with a full load: the menu's "Sair" goes to the
   * landing (`/`, served outside the SPA), an invalid session to the login with the page it was
   * on. The load closes every subscription at once, so the ended session never shows the
   * "invalid session" screen on the way out, and `replace` keeps Back from reopening the page.
   */
  async function signOut(destination: string) {
    setSigningOut(true);
    setSignOutError(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      forgetOrganization();
      convex.clearAuth();
      // "Encerrando sua sessão…" stays until the next page replaces this one.
      leaveConsole(destination);
    } catch {
      setSignOutError(true);
      setSigningOut(false);
    }
  }
  function loginReturningHere() {
    // The return address keeps the page's query (company, filters, the open record).
    const path = typeof window === "undefined" ? "" : window.location.pathname;
    const search = typeof window === "undefined" ? "" : window.location.search;
    return safeRedirect(path + search) ?? safeRedirect(path);
  }
  if (signingOut)
    return (
      <SessionMessage title="Encerrando sua sessão…" role="status">
        <p className="auth-card__description">Aguardando a confirmação do servidor.</p>
      </SessionMessage>
    );
  if (signOutError)
    return (
      <SessionMessage title="Não foi possível confirmar a saída." role="alert">
        <p className="auth-card__description">
          Verifique sua conexão. Entre novamente e tente encerrar a sessão.
        </p>
        <a className={buttonClass({ variant: "primary", block: true })} href="/login">
          Ir para o login
        </a>
      </SessionMessage>
    );
  const shell = {
    tools: {
      diagnostics: current?.role === "operator",
      prototype: import.meta.env.DEV,
      components: import.meta.env.DEV,
    },
    environment: deploymentLabel,
    deployment,
    version,
    onSignOut: () => void signOut("/"),
    signingOut,
  };
  // With a session in this browser the wait happens inside the shell's frame, without any private
  // data; it is the same AppShell that then receives the account, so nothing remounts.
  if (pending)
    return hint ? (
      <AppShell account={null} {...shell}>
        <Pending />
      </AppShell>
    ) : (
      <Pending />
    );
  // The transport still holds a token the server no longer accepts (an ended session, a removed
  // account). The login would see the token and send the person back here: end it instead.
  if (isAuthenticated && current === null)
    return (
      <SessionMessage eyebrow="Acesso protegido" title="Sua sessão não é mais válida.">
        <p className="auth-card__description">
          O servidor não reconheceu a sessão deste navegador. Saia e entre novamente para continuar.
        </p>
        <Button
          variant="primary"
          block
          onClick={() => {
            const redirect = loginReturningHere();
            void signOut(redirect ? `/login?${new URLSearchParams({ redirect })}` : "/login");
          }}
        >
          Sair e entrar novamente
        </Button>
      </SessionMessage>
    );
  if (!isAuthenticated || !current) {
    // Client-side navigation keeps an invitation opened from the e-mail link in memory.
    const redirect = loginReturningHere();
    const invitation =
      typeof window !== "undefined" && window.location.pathname === "/accept-invitation";
    return (
      <SessionMessage
        eyebrow={invitation ? "Convite" : "Acesso protegido"}
        title="Entre para continuar."
      >
        <p className="auth-card__description">
          {invitation
            ? hasPendingInvitation()
              ? "Entre com o e-mail que recebeu o convite. Em seguida você confere a organização e o papel antes de aceitar."
              : "Entre com o e-mail que recebeu o convite para aceitá-lo."
            : "Sua sessão terminou ou você ainda não entrou neste navegador."}
        </p>
        <Link
          to="/login"
          search={redirect ? { redirect } : {}}
          className={buttonClass({ variant: "primary", block: true })}
        >
          Ir para o login
        </Link>
      </SessionMessage>
    );
  }
  const roleLabel =
    current.role === "operator"
      ? "Operador"
      : current.role === "viewer"
        ? "Leitura"
        : profile
          ? "Conta verificada"
          : "Sem permissão";
  return (
    <AppShell account={{ name: current.name, role: roleLabel }} {...shell}>
      {current.role || profile ? (
        <Outlet />
      ) : (
        <Notice eyebrow="Permissão necessária" title="Acesso não autorizado.">
          Sua conta está autenticada, mas não tem permissão para este painel. Peça acesso a quem
          administra este painel.
        </Notice>
      )}
    </AppShell>
  );
}
