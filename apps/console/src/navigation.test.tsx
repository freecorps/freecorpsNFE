// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { RouterProvider } from "@tanstack/react-router";
import { homeDestination } from "../e2e/m0-headings.mjs";

/**
 * The real route tree of the console (`routes.tsx`), with the Convex hooks answering as an
 * authenticated owner of one organization. Navigating inside it must keep the shell and the
 * authorized organization mounted: only the page below them changes.
 */
const state = vi.hoisted(() => ({
  contexts: 0,
  asked: [] as string[],
  /** Queries the route loaders asked ahead (`convex.prewarmQuery`), with their arguments. */
  prewarmed: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));
vi.mock("./auth", () => ({ authClient: { signOut: vi.fn() } }));
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
      prewarmQuery({
        query,
        args,
      }: {
        query: Parameters<typeof getFunctionName>[0];
        args: object;
      }) {
        state.prewarmed.push({
          name: getFunctionName(query),
          args: args as Record<string, unknown>,
        });
      }
    },
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    useConvexConnectionState: () => ({ isWebSocketConnected: true, connectionCount: 1 }),
    useMutation: () => vi.fn().mockResolvedValue(null),
    useAction: () => vi.fn().mockResolvedValue(null),
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      state.asked.push(name);
      if (name === "access:session")
        return { name: "Ana Sintética", email: "a@x.invalid", role: null };
      if (name === "account:profile") return { name: "Ana Sintética" };
      if (name === "organizations:context") {
        const key = (args as { contextKey: string }).contextKey;
        if (!seen.has(key)) {
          seen.add(key);
          state.contexts++;
        }
        return organization;
      }
      return undefined;
    },
  }),
);
const seen = new Set<string>();
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

const { router } = await import("./routes");

beforeEach(() => {
  // jsdom has no layout: the list position and the router scroll restoration only record it.
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  localStorage.clear();
  seen.clear();
  state.contexts = 0;
  state.asked = [];
  state.prewarmed = [];
});
afterEach(cleanup);

async function go(to: string) {
  await act(async () => {
    await router.navigate({ href: to });
  });
}

it("navegar entre páginas da organização mantém o shell, o seletor e o contexto autorizado", async () => {
  window.history.replaceState(null, "", "/app/equipe/documents");
  render(<RouterProvider router={router} />);
  // The first render compiles the route chunks on demand: under the full suite, more than 1 s.
  await screen.findByRole("heading", { level: 1, name: "Documentos fiscais" }, { timeout: 5000 });
  const sidebar = screen.getByRole("complementary", { name: "Menu do console" });
  const switcher = within(sidebar).getByRole("button", { name: /Organização atual: Equipe Ipê/ });
  const nav = within(sidebar).getByRole("navigation", { name: "Navegação da organização" });
  expect(within(nav).getByRole("link", { name: "Documentos" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(state.contexts).toBe(1);

  for (const [path, heading, item] of [
    ["/app/equipe/issuances", "Emissão de NFS-e", "Emissão NFS-e"],
    ["/app/equipe/imports?company=c1", "Importar XML", "Importar XML"],
    ["/app/equipe/documents?company=c1&status=cancelled", "Documentos fiscais", "Documentos"],
    ["/app/equipe/settings/members", "Membros", "Membros"],
  ] as const) {
    await go(path);
    await screen.findByRole("heading", { level: 1, name: heading });
    // The same nodes: the shell and the switcher were not remounted, and the menu follows.
    expect(screen.getByRole("complementary", { name: "Menu do console" })).toBe(sidebar);
    expect(within(sidebar).getByRole("button", { name: /Organização atual: Equipe Ipê/ })).toBe(
      switcher,
    );
    await waitFor(() =>
      expect(within(sidebar).getByRole("link", { name: item }).getAttribute("aria-current")).toBe(
        "page",
      ),
    );
    expect(within(sidebar).queryByRole("navigation", { name: "Navegação do console" })).toBeNull();
  }
  // One entry of the organization context for the whole visit: no new query key per page.
  expect(state.contexts).toBe(1);
  // The fiscal pages' loaders asked for the company picker ahead, inside the shown organization
  // and with its query key: the company in the URL when there is one, else the only company.
  // (`organizations:context` is the cold load's own head start, organization-prewarm.ts.)
  const pages = state.prewarmed.filter((entry) => entry.name !== "organizations:context");
  const key = (pages[0]?.args.contextKey as string) ?? "";
  expect(key).toMatch(/:1$/);
  expect(state.prewarmed).toContainEqual({
    name: "consoleCompany:sole",
    args: { organizationId: "org", contextKey: key },
  });
  expect(state.prewarmed).toContainEqual({
    name: "consoleCompany:context",
    args: { organizationId: "org", company: "c1", contextKey: key },
  });
  expect(state.prewarmed).toContainEqual({
    name: "companies:list",
    args: {
      organizationId: "org",
      contextKey: key,
      paginationOpts: { numItems: 20, cursor: null, id: 0 },
    },
  });
  expect(pages.every((entry) => entry.args.contextKey === key)).toBe(true);

  // Leaving the organization clears its menu; the shell itself stays.
  await go("/app");
  // Outside the organization, a loader of its pages has no scope to ask with.
  state.prewarmed = [];
  await act(async () => {
    await router.preloadRoute({
      to: "/app/$organizationSlug/usage",
      params: { organizationSlug: "equipe" },
    });
  });
  expect(state.prewarmed.filter((entry) => entry.name !== "organizations:context")).toEqual([]);
  // The heading the M0 journey waits for when `/console` sends an account without a role here.
  await screen.findByRole("heading", { level: 1, name: homeDestination("none").heading });
  expect(screen.getByRole("complementary", { name: "Menu do console" })).toBe(sidebar);
  expect(within(sidebar).getByRole("navigation", { name: "Navegação do console" })).toBeTruthy();
  // The brand opens the organization remembered by this visit, straight.
  expect(
    within(sidebar).getByRole("link", { name: "Freecorps Fiscal, início" }).getAttribute("href"),
  ).toBe("/app/equipe");
});
