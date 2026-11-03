// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  authenticated: true,
  loading: false,
  session: null as null | undefined | { name: string; role: null | "operator" },
  profile: undefined as undefined | Error | { name: string },
  asked: [] as string[],
  signOut: vi.fn(async (): Promise<{ error: unknown }> => ({ error: null })),
  clearAuth: vi.fn(),
  leave: vi.fn(),
}));
vi.mock("./auth", () => ({ authClient: { signOut: state.signOut } }));
vi.mock("./session-handoff", async (original) => ({
  ...(await original<typeof import("./session-handoff")>()),
  leaveConsole: state.leave,
}));
// `useQueries` answers each entry as the `useQuery` mock does.
const withQueries = vi.hoisted(
  () =>
    <M extends { useQuery: (query: never, args: unknown) => unknown }>(mocked: M) => ({
      ...mocked,
      useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
        Object.fromEntries(
          Object.entries(queries).map(([key, { query, args }]) => [
            key,
            mocked.useQuery(query, args),
          ]),
        ),
    }),
);
vi.mock("convex/react", async (original) =>
  withQueries({
    ...(await original<typeof import("convex/react")>()),
    ConvexReactClient: class {
      connectionState() {}
      prewarmQuery() {}
      clearAuth() {
        state.clearAuth();
      }
    },
    useConvexAuth: () => ({ isAuthenticated: state.authenticated, isLoading: state.loading }),
    useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      state.asked.push(name);
      if (name === "access:session") return state.session;
      if (name === "account:profile") return state.profile;
      return undefined;
    },
  }),
);
// The shell needs a router; here it only shows whether it waits (no account) or is ready, and
// its account menu's "Sair".
vi.mock("./app-shell", () => ({
  AppShell: ({
    account,
    children,
    onSignOut,
  }: {
    account: { name: string } | null;
    children: unknown;
    onSignOut: () => void;
  }) =>
    createElement(
      "div",
      { "data-shell": account ? `pronto:${account.name}` : "aguardando" },
      createElement("button", { onClick: onSignOut }, "Sair"),
      children as never,
    ),
  HomeLink: ({ children }: { children: unknown }) => createElement("a", null, children as never),
}));
// The login link navigates inside the console, so an invitation opened from the e-mail stays in
// memory; outside a router it renders as a plain anchor with the return path.
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Outlet: () => createElement("span", null, "página"),
  Link: ({ children, to, search }: { children: unknown; to: string; search?: object }) =>
    createElement(
      "a",
      { href: `${to}?${new URLSearchParams(search as Record<string, string>)}` },
      children as never,
    ),
}));
import { ProtectedLayout } from "./session-layout";

beforeEach(() => {
  state.authenticated = true;
  state.loading = false;
  state.session = null;
  state.profile = undefined;
  state.asked = [];
  state.signOut.mockReset().mockResolvedValue({ error: null });
  state.clearAuth.mockReset();
  state.leave.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(cleanup);

/** What the Better Auth cross-domain plugin keeps after a login in this browser. */
function storeSession() {
  window.localStorage.setItem(
    "better-auth_cookie",
    JSON.stringify({
      "better-auth.session_token": {
        value: "sintetico",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      },
    }),
  );
}

it("waits inside the shell's frame, without any account, when this browser holds a session", () => {
  storeSession();
  state.loading = true;
  state.authenticated = false;
  state.session = undefined;
  const html = renderToString(createElement(ProtectedLayout));
  expect(html).toContain('data-shell="aguardando"');
  expect(html).toContain("Verificando sua sessão");
  // The session and the profile are asked together, before the transport finished.
  expect(state.asked).toEqual(expect.arrayContaining(["access:session", "account:profile"]));
});

it("never uses an answer before the server confirmed the token", () => {
  storeSession();
  state.loading = true;
  state.authenticated = false;
  // Whatever arrived meanwhile stays unused until `isAuthenticated`.
  state.session = { name: "Ana Sintética", role: null };
  state.profile = { name: "Ana Sintética" };
  const html = renderToString(createElement(ProtectedLayout));
  expect(html).toContain('data-shell="aguardando"');
  expect(html).not.toContain("Ana Sintética");
});

it("keeps the full-screen wait without a session in this browser", () => {
  state.loading = true;
  state.authenticated = false;
  state.session = undefined;
  const html = renderToString(createElement(ProtectedLayout));
  expect(html).not.toContain("data-shell");
  expect(html).toContain("Verificando sua sessão");
  // Nothing is asked for someone who probably is not signed in.
  expect(state.asked).toEqual([]);
});

it("hands the account to the same shell once session and profile answered", () => {
  storeSession();
  state.session = { name: "Ana Sintética", role: null };
  state.profile = { name: "Ana Sintética" };
  expect(renderToString(createElement(ProtectedLayout))).toContain(
    'data-shell="pronto:Ana Sintética"',
  );
});

it("ignores the profile's refusal when the session is gone, and throws it when it matters", () => {
  state.profile = new Error("UNAUTHENTICATED");
  // An ended session: the session message, not the error page.
  expect(renderToString(createElement(ProtectedLayout))).toContain("Sua sessão não é mais válida.");
  // A product account whose profile is refused (e-mail not verified): the error, as before.
  state.session = { name: "Ana Sintética", role: null };
  expect(() => renderToString(createElement(ProtectedLayout))).toThrow("UNAUTHENTICATED");
});

it("shows the login prompt, not the shell, when the stored session no longer exists", () => {
  storeSession();
  state.authenticated = false;
  state.session = undefined;
  window.history.replaceState(null, "", "/app/equipe");
  const html = renderToString(createElement(ProtectedLayout));
  expect(html).toContain("Entre para continuar.");
  expect(html).not.toContain("data-shell");
});

it("ends a token the server no longer accepts instead of sending it to the login", () => {
  // The login would see the authenticated transport and send the person back: no loop.
  const html = renderToString(createElement(ProtectedLayout));
  expect(html).toContain("Sua sessão não é mais válida.");
  expect(html).toContain("Sair e entrar novamente");
  expect(html).not.toContain("Ir para o login");
  expect(html).not.toContain("Verificando sua sessão");
});

it("waits while the access session query is unresolved", () => {
  state.session = undefined;
  expect(renderToString(createElement(ProtectedLayout))).toContain("Verificando sua sessão");
});

it("waits for the enabled profile query of a product account", () => {
  state.session = { name: "Ana Sintética", role: null };
  expect(renderToString(createElement(ProtectedLayout))).toContain("Verificando sua sessão");
});

it("offers login after the authenticated transport ends", () => {
  state.authenticated = false;
  state.session = undefined;
  expect(renderToString(createElement(ProtectedLayout))).toContain("Entre para continuar.");
});

it("returns to the invitation or organization after the login, never to another place", () => {
  state.authenticated = false;
  state.session = undefined;
  window.history.replaceState(null, "", "/accept-invitation");
  const invitation = renderToString(createElement(ProtectedLayout));
  expect(invitation).toContain("/login?redirect=%2Faccept-invitation");
  expect(invitation).toContain("Entre com o e-mail que recebeu o convite");
  window.history.replaceState(null, "", "/app/equipe/documents");
  expect(renderToString(createElement(ProtectedLayout))).toContain(
    "/login?redirect=%2Fapp%2Fequipe%2Fdocuments",
  );
  // The deep link keeps its query: company, filters and the open record.
  window.history.replaceState(null, "", "/app/equipe/documents?company=c1&document=d1");
  expect(renderToString(createElement(ProtectedLayout))).toContain(
    "/login?redirect=%2Fapp%2Fequipe%2Fdocuments%3Fcompany%3Dc1%26document%3Dd1",
  );
  window.history.replaceState(null, "", "/console/diagnostico");
  expect(renderToString(createElement(ProtectedLayout))).toContain(
    "/login?redirect=%2Fconsole%2Fdiagnostico",
  );
  // A query the console does not build keeps the page, without the query.
  window.history.replaceState(null, "", "/app/equipe?x=%00");
  expect(renderToString(createElement(ProtectedLayout))).toContain(
    'href="/login?redirect=%2Fapp%2Fequipe"',
  );
});

it("sends the menu's logout to the landing, ending the session first", async () => {
  storeSession();
  window.localStorage.setItem("fnfe:console-organization", "equipe");
  state.session = { name: "Ana Sintética", role: "operator" };
  window.history.replaceState(null, "", "/app/equipe/documents");
  render(createElement(ProtectedLayout));
  fireEvent.click(screen.getByRole("button", { name: "Sair" }));
  // Until the next page replaces this one, the wait, never the invalid session screen.
  expect(await screen.findByText("Encerrando sua sessão…")).toBeTruthy();
  await vi.waitFor(() => expect(state.leave).toHaveBeenCalledWith("/"));
  expect(state.signOut).toHaveBeenCalledTimes(1);
  expect(state.clearAuth).toHaveBeenCalledTimes(1);
  expect(window.localStorage.getItem("fnfe:console-organization")).toBeNull();
  expect(screen.queryByText("Sua sessão não é mais válida.")).toBeNull();
});

it("sends an invalid session to the login, returning to the page it was on", async () => {
  window.history.replaceState(null, "", "/app/equipe/documents?company=c1");
  render(createElement(ProtectedLayout));
  fireEvent.click(screen.getByRole("button", { name: "Sair e entrar novamente" }));
  await vi.waitFor(() =>
    expect(state.leave).toHaveBeenCalledWith(
      "/login?redirect=%2Fapp%2Fequipe%2Fdocuments%3Fcompany%3Dc1",
    ),
  );
});

it("stays on the page and says so when the server does not confirm the logout", async () => {
  state.session = { name: "Ana Sintética", role: "operator" };
  // In local development the shell also waits for the profile (`local`): answer it too, so the
  // test does not depend on the worktree's VITE_APP_ENV.
  state.profile = { name: "Ana Sintética" };
  state.signOut.mockResolvedValue({ error: { status: 503 } });
  render(createElement(ProtectedLayout));
  fireEvent.click(screen.getByRole("button", { name: "Sair" }));
  expect(await screen.findByText("Não foi possível confirmar a saída.")).toBeTruthy();
  expect(state.leave).not.toHaveBeenCalled();
  expect(state.clearAuth).not.toHaveBeenCalled();
});
