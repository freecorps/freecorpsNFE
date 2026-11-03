// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { RouterProvider } from "@tanstack/react-router";

/**
 * The real organization query cache (`convex-query.tsx`, from convex-helpers) over the real route
 * tree, with a fake Convex client that counts the subscriptions it holds open. Like the real
 * client, a query nobody watches loses its answer: what a revisited page shows at once can only
 * come from a subscription the cache kept.
 */
vi.unmock("./convex-query");

const connection = vi.hoisted(() => {
  let value = { isWebSocketConnected: true, connectionCount: 1 };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: typeof value) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
/** The session and each organization's membership as the server sees them; tests change them. */
const access = vi.hoisted(() => {
  const initial = () => ({
    authenticated: true,
    revoked: new Set<string>(),
    membershipVersion: 1,
  });
  let value = initial();
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(change: Partial<ReturnType<typeof initial>>) {
      value = { ...value, ...change };
      for (const listener of listeners) listener();
    },
    reset: () => void (value = initial()),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("./auth", () => ({ authClient: { signOut: vi.fn() } }));
// `useQueries` answers each entry as the `useQuery` mock does, watching the server state once
// whatever the number of entries (the hooks' order cannot change between renders).
const withQueries = vi.hoisted(
  () =>
    <
      M extends {
        answer: (query: never, args: unknown) => unknown;
        useServer: () => unknown;
      },
    >(
      mocked: M,
    ) => ({
      ...mocked,
      useQuery: (query: never, args: unknown) => {
        mocked.useServer();
        return mocked.answer(query, args);
      },
      useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
        mocked.useServer();
        return Object.fromEntries(
          Object.entries(queries).map(([key, { query, args }]) => [
            key,
            mocked.answer(query, args),
          ]),
        );
      },
    }),
);
vi.mock("convex/react", async (original) =>
  withQueries({
    ...(await original<typeof import("convex/react")>()),
    ConvexReactClient: class {
      connectionState() {}
      prewarmQuery() {}
    },
    useConvexAuth: () => ({
      isAuthenticated: useSyncExternalStore(
        (listener) => access.subscribe(listener),
        () => access.get().authenticated,
      ),
      isLoading: false,
    }),
    useConvexConnectionState: () =>
      useSyncExternalStore(
        (listener) => connection.subscribe(listener),
        () => connection.get(),
      ),
    useMutation: () => vi.fn().mockResolvedValue(null),
    useAction: () => vi.fn().mockResolvedValue(null),
    // The shell's own queries stay on `convex/react`, outside the organization's cache.
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useServer: () =>
      useSyncExternalStore(
        (listener) => access.subscribe(listener),
        () => access.get(),
      ),
    answer: (reference: FunctionReference<"query">, args: unknown) => {
      const server = access.get();
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "access:session")
        return { name: "Ana Sintética", email: "a@x.invalid", role: null };
      if (name === "account:profile") return { name: "Ana Sintética" };
      if (name === "organizations:context") {
        const slug = (args as { slug: string }).slug;
        if (server.revoked.has(slug)) return null;
        return {
          ...organization,
          id: slug === "equipe" ? "org" : "org2",
          slug,
          membershipVersion: server.membershipVersion,
        };
      }
      return undefined;
    },
  }),
);

const organization = {
  id: "org",
  name: "Equipe Ipê",
  slug: "equipe",
  role: "owner",
  membershipId: "m",
  membershipVersion: 1,
  memberCount: 1,
  ownerCount: 1,
  closure: null,
  termsOfUse: null,
  capabilities: {
    manageOrganization: true,
    manageMembers: true,
    manageIntegrations: true,
    operateDocuments: true,
    readDocuments: true,
  },
};

/** What the server answers, by function: the member list carries one person per organization. */
function answer(name: string, args: { organizationId?: string }) {
  if (name === "organizations:members")
    return {
      page: [
        {
          id: `m-${args.organizationId}`,
          name: args.organizationId === "org" ? "Bia Sintética" : "Caio Sintético",
          email: "b@x.invalid",
          role: "operator",
          version: 1,
          createdAt: 0,
        },
      ],
      isDone: true,
      continueCursor: "fim",
    };
  return { page: [], isDone: true, continueCursor: "fim" };
}

/** A Convex client that answers only on `respond()` and forgets what nobody watches. */
class FakeClient {
  watchers = new Map<string, Set<() => void>>();
  results = new Map<string, unknown>();
  /** Every time a query went from no watcher to one: a subscription sent to the server. */
  opened: string[] = [];
  pending = new Set<string>();
  watchQuery(query: FunctionReference<"query">, args: Record<string, unknown> = {}) {
    const name = getFunctionName(query);
    const key = JSON.stringify([name, args]);
    return {
      onUpdate: (callback: () => void) => {
        let set = this.watchers.get(key);
        if (!set) {
          set = new Set();
          this.watchers.set(key, set);
          this.opened.push(key);
          this.pending.add(key);
        }
        set.add(callback);
        return () => {
          set.delete(callback);
          if (set.size === 0) {
            this.watchers.delete(key);
            this.results.delete(key);
            this.pending.delete(key);
          }
        };
      },
      localQueryResult: () => this.results.get(key),
      journal: () => undefined,
      // Kept for the server's answer.
      name,
      args,
    };
  }
  respond() {
    for (const key of this.pending) {
      const [name, args] = JSON.parse(key) as [string, { organizationId?: string }];
      this.results.set(key, answer(name, args));
      for (const callback of this.watchers.get(key) ?? []) callback();
    }
    this.pending.clear();
  }
  open(name: string, organizationId: string) {
    return [...this.watchers.keys()].filter((key) => {
      const [query, args] = JSON.parse(key) as [string, { organizationId?: string }];
      return query === name && args.organizationId === organizationId;
    });
  }
  openedFor(name: string, organizationId: string) {
    return this.opened.filter((key) => {
      const [query, args] = JSON.parse(key) as [string, { organizationId?: string }];
      return query === name && args.organizationId === organizationId;
    });
  }
  organizationSubscriptions(organizationId: string) {
    return [...this.watchers.keys()].filter(
      (key) =>
        (JSON.parse(key) as [string, { organizationId?: string }])[1].organizationId ===
        organizationId,
    );
  }
}

const { router } = await import("./routes");
const { OrganizationQueryCache, QUERY_CACHE_EXPIRATION_MS, useQuery } =
  await import("./convex-query");
const { api } = await import("../../../platform/convex/_generated/api");
let client: FakeClient;

beforeEach(() => {
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  localStorage.clear();
  connection.set({ isWebSocketConnected: true, connectionCount: 1 });
  access.reset();
  client = new FakeClient();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function go(to: string) {
  await act(async () => {
    await router.navigate({ href: to });
  });
}
async function respond() {
  await act(async () => client.respond());
}

it("voltar a uma página da organização na janela do cache mostra a resposta sem carregar nem assinar de novo", async () => {
  window.history.replaceState(null, "", "/app/equipe/settings/members");
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <RouterProvider router={router} />
    </ConvexProvider>,
  );
  // The first render compiles the route chunks on demand: under the full suite, more than 1 s.
  await screen.findByRole("heading", { level: 1, name: "Membros" }, { timeout: 5000 });
  expect(screen.getByText("Carregando os membros…")).toBeTruthy();
  await respond();
  expect(screen.getByText("Bia Sintética")).toBeTruthy();
  expect(client.openedFor("organizations:members", "org")).toHaveLength(1);

  // Another page of the same organization: the member list is not rendered, the cache keeps it.
  await go("/app/equipe/settings/organization");
  await screen.findByRole("heading", { level: 1, name: "Configurações" });
  await respond();
  expect(screen.queryByText("Bia Sintética")).toBeNull();
  expect(client.open("organizations:members", "org")).toHaveLength(1);

  // Back: the answer is there on the first render, with no new subscription and no skeleton.
  await go("/app/equipe/settings/members");
  expect(screen.getByRole("heading", { level: 1, name: "Membros" })).toBeTruthy();
  expect(screen.getByText("Bia Sintética")).toBeTruthy();
  expect(screen.queryByText("Carregando os membros…")).toBeNull();
  expect(client.openedFor("organizations:members", "org")).toHaveLength(1);
  expect(client.pending.size).toBe(0);

  // Reconnecting enters the organization again: every subscription of the previous entry closes
  // at once, without waiting for the expiration, and the page asks again with a new key.
  const before = client.organizationSubscriptions("org");
  expect(before.length).toBeGreaterThanOrEqual(3);
  await act(async () => connection.set({ isWebSocketConnected: true, connectionCount: 2 }));
  await screen.findByRole("heading", { level: 1, name: "Membros" });
  expect(screen.getByText("Carregando os membros…")).toBeTruthy();
  expect(screen.queryByText("Bia Sintética")).toBeNull();
  for (const key of before) expect(client.watchers.has(key)).toBe(false);
  expect(client.openedFor("organizations:members", "org")).toHaveLength(2);
  await respond();
  expect(screen.getByText("Bia Sintética")).toBeTruthy();

  // Another organization: nothing of the previous one stays open, and nothing of it is shown.
  await go("/app/outra/settings/members");
  await screen.findByRole("heading", { level: 1, name: "Membros" });
  expect(client.organizationSubscriptions("org")).toEqual([]);
  expect(screen.queryByText("Bia Sintética")).toBeNull();
  expect(screen.getByText("Carregando os membros…")).toBeTruthy();
  await respond();
  expect(screen.getByText("Caio Sintético")).toBeTruthy();
});

it("uma assinatura que nenhuma página mostra fecha depois da expiração", async () => {
  vi.useFakeTimers();
  function Probe() {
    const value = useQuery(api.organizations.members, {
      organizationId: "org" as never,
      contextKey: "k",
      paginationOpts: { numItems: 1, cursor: null },
    });
    return <p>{value ? "pronto" : "carregando"}</p>;
  }
  let toggle: (show: boolean) => void = () => {};
  function Screen() {
    const [show, setShow] = useState(true);
    toggle = setShow;
    return <OrganizationQueryCache>{show ? <Probe /> : null}</OrganizationQueryCache>;
  }
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <Screen />
    </ConvexProvider>,
  );
  await respond();
  expect(screen.getByText("pronto")).toBeTruthy();
  act(() => toggle(false));
  act(() => void vi.advanceTimersByTime(QUERY_CACHE_EXPIRATION_MS - 1));
  expect(client.watchers.size).toBe(1);
  act(() => toggle(true));
  expect(screen.getByText("pronto")).toBeTruthy();
  act(() => toggle(false));
  act(() => void vi.advanceTimersByTime(QUERY_CACHE_EXPIRATION_MS));
  expect(client.watchers.size).toBe(0);
  expect(client.opened).toHaveLength(1);
});

/**
 * `DropOnUnmount` reads the internal registry of convex-helpers (`queries`, `subs`, `idle`,
 * `evictTimer`, `unsub`). This proves what the console depends on from it: an update that
 * changes those internals breaks here, not in production (patches/README.md, "Cache do console").
 */
it("desmontar o cache fecha na hora as assinaturas ociosas e as mostradas, sem timer pendente", async () => {
  vi.useFakeTimers();
  function Probe({ cursor }: { cursor: string | null }) {
    const value = useQuery(api.organizations.members, {
      organizationId: "org" as never,
      contextKey: "k",
      paginationOpts: { numItems: 1, cursor },
    });
    return <p>{value ? `pronto ${cursor ?? "início"}` : "carregando"}</p>;
  }
  let setCache: (show: boolean) => void = () => {};
  let setIdle: (show: boolean) => void = () => {};
  function Screen() {
    const [cache, showCache] = useState(true);
    const [idle, showIdle] = useState(true);
    setCache = showCache;
    setIdle = showIdle;
    if (!cache) return <p>fora</p>;
    return (
      <OrganizationQueryCache>
        {idle ? <Probe cursor={null} /> : null}
        <Probe cursor="b" />
      </OrganizationQueryCache>
    );
  }
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <Screen />
    </ConvexProvider>,
  );
  await respond();
  expect(screen.getByText("pronto início")).toBeTruthy();
  // One page left: its subscription waits for the expiration on a timer.
  act(() => setIdle(false));
  expect(client.watchers.size).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
  // The cache goes (organization switch, revocation, logout): the idle one and the one still shown
  // close at once, and the expiration timer goes with them.
  act(() => setCache(false));
  expect(screen.getByText("fora")).toBeTruthy();
  expect(client.watchers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  // Nothing late reopens or closes twice.
  act(() => void vi.advanceTimersByTime(QUERY_CACHE_EXPIRATION_MS));
  expect(client.watchers.size).toBe(0);
  expect(client.opened).toHaveLength(2);
});

it("mudança de membership, revogação e saída fecham na hora as assinaturas da organização", async () => {
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <RouterProvider router={router} />
    </ConvexProvider>,
  );
  await go("/app/equipe/settings/members");
  await screen.findByRole("heading", { level: 1, name: "Membros" }, { timeout: 5000 });
  await respond();
  expect(screen.getByText("Bia Sintética")).toBeTruthy();
  // The member list stays idle in the cache while another page is open.
  await go("/app/equipe/settings/organization");
  await screen.findByRole("heading", { level: 1, name: "Configurações" });
  await respond();
  expect(client.open("organizations:members", "org")).toHaveLength(1);

  // A changed membership (another role) enters again: nothing of the previous version stays open.
  const before = client.organizationSubscriptions("org");
  await act(async () => access.set({ membershipVersion: 2 }));
  await screen.findByRole("heading", { level: 1, name: "Configurações" });
  for (const key of before) expect(client.watchers.has(key)).toBe(false);
  expect(client.open("organizations:members", "org")).toEqual([]);

  // Revoked membership: the server no longer opens the organization, and its subscriptions close.
  await go("/app/equipe/settings/members");
  await respond();
  expect(screen.getByText("Bia Sintética")).toBeTruthy();
  await act(async () => access.set({ revoked: new Set(["equipe"]) }));
  expect(screen.getByText("Organização indisponível.")).toBeTruthy();
  expect(client.organizationSubscriptions("org")).toEqual([]);
  expect(screen.queryByText("Bia Sintética")).toBeNull();

  // Logout: the session ends, and the other organization's subscriptions close with it.
  await go("/app/outra/settings/members");
  await screen.findByRole("heading", { level: 1, name: "Membros" });
  await respond();
  expect(screen.getByText("Caio Sintético")).toBeTruthy();
  expect(client.organizationSubscriptions("org2").length).toBeGreaterThan(0);
  await act(async () => access.set({ authenticated: false }));
  expect(screen.getByText("Entre para continuar.")).toBeTruthy();
  expect(client.organizationSubscriptions("org2")).toEqual([]);
  expect(client.watchers.size).toBe(0);
});

it("as páginas assinam as primeiras consultas com os mesmos argumentos que os loaders pedem antes", async () => {
  const pages = await import("./page-queries");
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <RouterProvider router={router} />
    </ConvexProvider>,
  );
  await go("/app/equipe/companies");
  await screen.findByRole("heading", { level: 1, name: "Empresas" }, { timeout: 5000 });
  await go("/app/equipe/companies/c1");
  await go("/app/equipe/usage");
  await screen.findByRole("heading", { level: 1, name: "Uso e limites" });
  await go("/app/equipe/operations");
  await screen.findByRole("heading", { level: 1, name: "Operação e suporte" });
  // What each page sent to the client, exactly as serialized: the Convex client tells
  // subscriptions apart by the serialized arguments, key order included.
  const sent = (name: string) =>
    client.opened
      .map((key) => JSON.parse(key) as [string, Record<string, unknown>])
      .filter(([query]) => query === name)
      .map(([, args]) => JSON.stringify(args));
  // The organization's query key comes from its entry (a random id plus the membership version).
  const contextKey = (
    JSON.parse(client.openedFor("usage:overview", "org")[0]!) as [string, { contextKey: string }]
  )[1].contextKey;
  expect(contextKey).toMatch(/:1$/);
  const scope = { org: { id: "org" as never }, contextKey };
  expect(sent("companies:list")).toContain(
    JSON.stringify(pages.firstPageArgs(pages.companiesListArgs(scope), pages.COMPANIES_PAGE_SIZE)),
  );
  expect(sent("companies:get")).toEqual([JSON.stringify(pages.companyArgs(scope, "c1"))]);
  expect(sent("usage:overview")).toEqual([
    JSON.stringify(pages.usageArgs(scope, pages.currentUsagePeriod())),
  ]);
  expect(sent("observability:overview")).toEqual([
    JSON.stringify(pages.operationsOverviewArgs(scope)),
  ]);
  expect(sent("observability:audit")).toEqual([
    JSON.stringify(
      pages.firstPageArgs(
        pages.auditArgs(scope, pages.defaultAuditFilters()),
        pages.AUDIT_PAGE_SIZE,
      ),
    ),
  ]);
});

it("operação e suporte assina a auditoria junto com o panorama, sem esperar a resposta dele", async () => {
  render(
    <ConvexProvider client={client as unknown as ConvexReactClient}>
      <RouterProvider router={router} />
    </ConvexProvider>,
  );
  await go("/app/equipe/operations");
  await screen.findByRole("heading", { level: 1, name: "Operação e suporte" }, { timeout: 5000 });
  // No answer yet: both are already open.
  const names = [...client.pending].map((key) => (JSON.parse(key) as [string])[0]);
  expect(names).toContain("observability:overview");
  expect(names).toContain("observability:audit");
});
