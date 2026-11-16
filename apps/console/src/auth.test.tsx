// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useConvexAuth } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";

/**
 * The Better Auth server of this test: `get-session` answers the session while it is alive and
 * `null` once another tab ended it; the Convex token comes from the session cookie.
 */
const server = vi.hoisted(() => ({
  alive: true,
  sessionsAsked: 0,
  tokensAsked: 0,
}));
const fetchMock = vi.hoisted(() =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/get-session")) {
      server.sessionsAsked += 1;
      const body = server.alive
        ? {
            session: { id: "session-1", userId: "user-1", token: "opaque" },
            user: { id: "user-1", email: "pessoa@development.invalid", name: "Pessoa" },
          }
        : null;
      return Response.json(body);
    }
    if (url.includes("/convex/token")) {
      server.tokensAsked += 1;
      return Response.json(server.alive ? { token: convexToken } : null);
    }
    return Response.json(null, { status: 404 });
  }),
);
const cookieKey = "better-auth_cookie";
/** A Convex JWT as the convex plugin mints it: the payload names the Better Auth session. */
const convexToken = [{ alg: "none" }, { sessionId: "session-1" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .concat("signature")
  .join(".");
const sessionCookie = JSON.stringify({
  "better-auth.session_token": { value: "opaque", expires: null },
});

afterEach(() => {
  cleanup();
  Object.assign(server, { alive: true, sessionsAsked: 0, tokensAsked: 0 });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

/** What the console sees: the Convex transport authenticated, or not. */
function Probe() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  return <p>{isLoading ? "carregando" : isAuthenticated ? "autenticado" : "sem sessão"}</p>;
}

/** Another tab of the same browser writes the cookie storage; this tab only gets the event. */
function otherTabWrites(value: string) {
  localStorage.setItem(cookieKey, value);
  window.dispatchEvent(new StorageEvent("storage", { key: cookieKey, newValue: value }));
}

it("a aba aberta com sessão volta a pedir login quando outra aba sai", async () => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_CONVEX_SITE_URL", "http://convex.development.invalid");
  localStorage.setItem(cookieKey, sessionCookie);
  const { authClient } = await import("./auth");
  // Convex accepts any token it is given and reports it back, as `ConvexReactClient.setAuth` does
  // through the callback `ConvexProviderWithAuth` passes (the provider's declaration omits it).
  const convex = {
    setAuth: vi.fn(
      (
        fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>,
        onChange?: (authenticated: boolean) => void,
      ) => {
        void fetchToken({ forceRefreshToken: false }).then((token) => onChange?.(!!token));
      },
    ),
    clearAuth: vi.fn(),
  };
  // The tab boots as main.tsx boots it with a session in this browser: the session answered
  // (session-boot.ts), then the provider renders with the early token.
  const session = authClient.$store.atoms.session;
  expect(session).toBeDefined();
  await new Promise<void>((resolve) => {
    const stop = session!.subscribe((value: { isPending: boolean }) => {
      if (value.isPending) return;
      resolve();
      queueMicrotask(() => stop());
    });
  });
  expect(server.sessionsAsked).toBe(1);
  render(
    <ConvexBetterAuthProvider client={convex} authClient={authClient} initialToken={convexToken}>
      <Probe />
    </ConvexBetterAuthProvider>,
  );
  await screen.findByText("autenticado");

  // Another tab renewed the cookie: the session is asked again and this tab stays in.
  await act(async () => otherTabWrites(sessionCookie));
  await vi.waitFor(() => expect(server.sessionsAsked).toBe(2));
  expect(screen.getByText("autenticado")).toBeTruthy();
  // The early token names this session: Convex keeps using it, without asking another one.
  expect(server.tokensAsked).toBe(0);

  // Another tab signed out: the cross-domain plugin emptied the cookie, the server ended it.
  server.alive = false;
  await act(async () => otherTabWrites("{}"));
  await screen.findByText("sem sessão");
  expect(server.sessionsAsked).toBe(3);
  // The transport dropped the token after its last authentication, instead of keeping it.
  const lastOrder = (calls: number[]) => Math.max(...calls);
  expect(lastOrder(convex.clearAuth.mock.invocationCallOrder)).toBeGreaterThan(
    lastOrder(convex.setAuth.mock.invocationCallOrder),
  );
});
