// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { Documents } from "./documents";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  initialize: vi.fn().mockResolvedValue(null),
  search: {} as Record<string, string>,
  loading: false,
  company: true,
  queries: {} as Record<string, unknown>,
  /** The last arguments each query was asked with. */
  args: {} as Record<string, unknown>,
  /** The environment chosen in the shell. */
  environment: "sandbox" as "sandbox" | "production",
  choose: vi.fn(),
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: state.choose,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  useParams: () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("./content", async () => {
  const { useQuery } = await import("convex/react");
  const { getFunctionName, makeFunctionReference } = await import("convex/server");
  // The B6 readers answer, in these tests, under the names of the queries they replaced.
  const names: Record<string, string> = {
    "documentContentNode:documentDetailRead": "documents:detail",
    "documentContentNode:documentItemsRead": "documents:items",
    "documentContentNode:documentVersionsRead": "documents:versions",
    "documentContentNode:importDetailRead": "imports:detail",
    "documentContentNode:importHistoryRead": "importHistory:get",
  };
  return {
    useContent: (_token: unknown, read: Parameters<typeof getFunctionName>[0], args: unknown) =>
      useQuery(makeFunctionReference<"query">(names[getFunctionName(read)]!), args as never),
  };
});
vi.mock("convex/react", () => ({
  useMutation: () => state.initialize,
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results:
      state.loading || !state.company
        ? []
        : getFunctionName(fn) === "companies:list"
          ? [{ id: "company", name: "Empresa de teste", cnpj: "00000000000000" }]
          : [],
    status: state.loading ? "LoadingFirstPage" : "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip" || state.loading) return undefined;
    if (getFunctionName(fn) === "consoleCompany:context")
      return state.company
        ? {
            id: "company",
            name: "Empresa de teste",
            cnpj: "00000000000000",
            kind: "declared",
            canRead: true,
            canWrite: true,
            canManage: true,
          }
        : null;
    const name = getFunctionName(fn);
    state.args[name] = args;
    if (name in state.queries) return state.queries[name];
    return { page: [], indexing: false, nextCursor: null };
  },
}));
const org = {
  id: "organization",
  slug: "equipe",
  role: "owner",
  capabilities: { manageOrganization: true },
} as Parameters<typeof Documents>[0]["org"];
beforeEach(() => {
  // jsdom has no layout: the list position and the router scroll restoration only record it.
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  localStorage.clear();
  state.search = { company: "company" };
  state.loading = false;
  state.company = true;
  // No fiscal capture released: only the default environment.
  state.queries = {
    "captureRelease:status": { state: "none" },
    "deployment:current": { environment: "sandbox", fiscalProduction: false },
  };
  state.environment = "sandbox";
  state.choose.mockClear();
  state.args = {};
  state.navigate.mockClear();
  state.initialize.mockClear();
});
afterEach(cleanup);

describe("o ambiente escolhido na lateral (ADR 0007, §1)", () => {
  it("lists the Sandbox without tabs, and Produção once it is chosen", () => {
    state.queries["captureRelease:status"] = { state: "released" };
    render(<Documents org={org} contextKey="test" />);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText("Documentos / Sandbox")).toBeTruthy();
    expect(state.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
    );
    cleanup();
    state.initialize.mockClear();
    state.environment = "production";
    render(<Documents org={org} contextKey="test" />);
    expect(screen.getByText("Documentos / Produção")).toBeTruthy();
    expect(state.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production" }),
    );
    expect(state.initialize).not.toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
    );
  });
  it("reads a withdrawn capture's documents in Produção, for reading", () => {
    state.environment = "production";
    state.queries["captureRelease:status"] = { state: "withdrawn" };
    render(<Documents org={org} contextKey="test" />);
    expect(state.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company", environment: "production" }),
    );
  });
  it("says a company without Produção has none there, and reads nothing", () => {
    state.environment = "production";
    render(<Documents org={org} contextKey="test" />);
    expect(screen.getByText(/não tem documentos em Produção/)).toBeTruthy();
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("prepares no environment while the release status is loading", () => {
    state.environment = "production";
    state.queries["captureRelease:status"] = undefined;
    render(<Documents org={org} contextKey="test" />);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("an address of the other environment does not move the console: it offers the switch", () => {
    state.queries["captureRelease:status"] = { state: "released" };
    state.search = { company: "company", env: "production", document: "document" };
    render(<Documents org={org} contextKey="test" />);
    expect(state.initialize).not.toHaveBeenCalled();
    expect(state.choose).not.toHaveBeenCalled();
    expect(screen.getByText(/Este endereço abre documentos de Produção/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trocar para Produção" }));
    expect(state.choose).toHaveBeenCalledWith("production");
  });
  it("names the environment in every link inside the list", () => {
    state.environment = "production";
    state.queries["captureRelease:status"] = { state: "released" };
    state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: null };
    render(<Documents org={org} contextKey="test" />);
    fireEvent.click(screen.getByRole("button", { name: "NF-e 7" }));
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ env: "production", document: "document" }),
      }),
    );
  });
});
describe("notes only with the summary (#433)", () => {
  it("filters them by the URL the capture panel links to, and clears the filter", () => {
    state.environment = "production";
    state.queries["captureRelease:status"] = { state: "released" };
    state.search = { company: "company", env: "production", completeness: "summary" };
    render(<Documents org={org} contextKey="test" />);
    expect(state.args["documents:list"]).toEqual(
      expect.objectContaining({ environment: "production", completeness: "summary" }),
    );
    expect((screen.getByLabelText("Conteúdo") as HTMLSelectElement).value).toBe("summary");
    fireEvent.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { company: "company", env: "production" } }),
    );
  });
  it("asks for the filter from the form", () => {
    render(<Documents org={org} contextKey="test" />);
    fireEvent.change(screen.getByLabelText("Conteúdo"), { target: { value: "summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ completeness: "summary" }) }),
    );
  });
});

it("clears document filters while preserving the authorized company", () => {
  state.search = {
    ...state.search,
    status: "cancelled",
    from: "2026-09-01",
    source: "imported-xml",
  };
  render(<Documents org={org} contextKey="test" />);
  expect(screen.getByRole("heading", { name: "Nenhum documento encontrado" })).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/app/$organizationSlug/documents",
    params: { organizationSlug: "equipe" },
    search: { company: "company", env: "sandbox" },
  });
});

it("distinguishes an empty collection from a filtered result", () => {
  render(<Documents org={org} contextKey="test" />);
  expect(
    screen.getByRole("heading", { name: "Ainda não há documentos para consultar" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Limpar filtros" })).toBeNull();
});

it("waits for companies before presenting the setup guidance", () => {
  state.loading = true;
  const view = render(<Documents org={org} contextKey="test" />);
  expect((screen.getByLabelText("Empresa dos documentos") as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(screen.queryByRole("heading", { name: "Comece por uma empresa" })).toBeNull();
  state.loading = false;
  state.company = false;
  state.search = {};
  view.rerender(<Documents org={org} contextKey="test" />);
  expect(screen.getByRole("heading", { name: "Comece por uma empresa" })).toBeTruthy();
});

const captured = {
  id: "document",
  model: "55",
  key: "35261011222333000181550010000000071000000079",
  kind: "invoice",
  importedAt: Date.UTC(2026, 9, 8, 15, 30),
  issuedAt: "2026-10-02T10:00:00-03:00",
  number: "7",
  issuer: "Fornecedor Sintético Ltda",
  total: "150.00",
  completeness: "full-xml",
  source: "distribution-xml",
  fiscalStatus: "unknown",
  projectionState: "ready",
  versionId: "version",
  resourceVersion: 1,
  processing: "complete",
} as const;

it("shows the real origin of a captured document in its data", () => {
  state.search = { ...state.search, document: "document" };
  state.queries["documents:detail"] = {
    model: "55",
    summary: captured,
    payload: {
      kind: "event",
      type: "110111",
      sequence: 1,
      occurredAt: "2026-10-03T09:00:00-03:00",
      author: { document: "11222333000181" },
    },
    version: {
      id: "version",
      source: "distribution-xml",
      sha256: "ab".repeat(32),
      processorVersion: "1",
      parserVersion: "1",
      normalizerVersion: "1",
    },
    previousFiscalSituation: null,
    fiscalSituation: null,
  };
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  const origin = screen.getByText("Origem").nextElementSibling!;
  expect(origin.textContent).toBe("Distribuição NF-e");
  expect(screen.queryByText("XML importado")).toBeNull();
});

const detailFixture = {
  contractVersion: "documents/1",
  model: "55",
  summary: captured,
  payload: {
    kind: "event",
    type: "110111",
    sequence: 1,
    occurredAt: "2026-10-03T09:00:00-03:00",
    author: { document: "11222333000181" },
  },
  version: {
    id: "version",
    source: "distribution-xml",
    sha256: "ab".repeat(32),
    processorVersion: "1",
    parserVersion: "1",
    normalizerVersion: "1",
  },
  previousFiscalSituation: null,
  fiscalSituation: null,
};

it("opens a document as its own page and goes back to the list with the filters", () => {
  state.search = {
    ...state.search,
    status: "cancelled",
    source: "distribution-xml",
    document: "document",
  };
  state.queries["documents:detail"] = detailFixture;
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  // The record has the page: no list title, steps or company picker above it.
  expect(screen.queryByRole("heading", { name: "Documentos fiscais" })).toBeNull();
  expect(screen.queryByLabelText("Empresa dos documentos")).toBeNull();
  expect(screen.queryByRole("list", { name: "Etapas" })).toBeNull();
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings.map((h) => h.textContent)).toEqual(["NF-e 7"]);
  fireEvent.click(screen.getByRole("button", { name: /Voltar à lista de documentos/ }));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/app/$organizationSlug/documents",
    params: { organizationSlug: "equipe" },
    search: {
      company: "company",
      status: "cancelled",
      source: "distribution-xml",
      env: "sandbox",
      document: undefined,
      version: undefined,
    },
    // The list comes back where it was, not at the top.
    resetScroll: false,
  });
});

it("keeps the list, its page and filters mounted while a document is open", () => {
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: "next" };
  state.queries["documents:detail"] = detailFixture;
  state.queries["documents:canProcess"] = false;
  const view = render(<Documents org={org} contextKey="test" />);
  fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
  const table = screen.getByRole("table", { name: "Documentos fiscais" });
  fireEvent.click(screen.getByRole("button", { name: "NF-e 7" }));
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/app/$organizationSlug/documents",
    params: { organizationSlug: "equipe" },
    search: { company: "company", env: "sandbox", document: "document", version: undefined },
  });
  state.search = { company: "company", document: "document" };
  view.rerender(<Documents org={org} contextKey="test" />);
  // The document has the page; the list waits hidden, the same node, on the page it was.
  expect(screen.getByRole("heading", { level: 1, name: "NF-e 7" })).toBeTruthy();
  expect(screen.queryByRole("table", { name: "Documentos fiscais" })).toBeNull();
  expect(table.isConnected).toBe(true);
  state.search = { company: "company" };
  view.rerender(<Documents org={org} contextKey="test" />);
  expect(screen.getByRole("table", { name: "Documentos fiscais" })).toBe(table);
  const [previous] = Array.from(
    screen.getByRole("navigation", { name: "Páginas de documentos" }).querySelectorAll("button"),
  );
  expect((previous as HTMLButtonElement).disabled).toBe(false);
  // Other filters are another list: back to the first page.
  state.search = { company: "company", status: "authorized" };
  view.rerender(<Documents org={org} contextKey="test" />);
  const [first] = Array.from(
    screen.getByRole("navigation", { name: "Páginas de documentos" }).querySelectorAll("button"),
  );
  expect((first as HTMLButtonElement).disabled).toBe(true);
});

it("drops the steps once the only company is in use, without it in the URL", () => {
  state.search = {};
  render(<Documents org={org} contextKey="test" />);
  // The company is chosen: the steps would only repeat the picker.
  expect(screen.queryByRole("list", { name: "Etapas" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Documentos fiscais" })).toBeTruthy();
});

it("shows the public DTO in the JSON tab, with copy and download", () => {
  state.search = { ...state.search, document: "document" };
  state.queries["documents:detail"] = detailFixture;
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  const panel = screen.getByRole("tabpanel");
  expect(JSON.parse(panel.querySelector("pre")!.textContent!)).toEqual(detailFixture);
  expect(panel.textContent).toMatch(/GET \/v1\/documents\/\{id\}\/json/);
  expect(screen.getByRole("button", { name: "Copiar JSON" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Baixar JSON" })).toBeTruthy();
});

it("points to the refused files in the import page only when there are some", () => {
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: null };
  state.queries["documents:unclassifiedCount"] = { count: 0, more: false, latestAt: null };
  const view = render(<Documents org={org} contextKey="test" />);
  expect(screen.queryByText("Ver arquivos recusados")).toBeNull();
  state.queries["documents:unclassifiedCount"] = { count: 20, more: true, latestAt: 1_000 };
  view.rerender(<Documents org={org} contextKey="test" />);
  expect(screen.getByText("Ver arquivos recusados")).toBeTruthy();
  expect(screen.getByText(/20\+ arquivos recebidos não viraram documento/)).toBeTruthy();
  // The files themselves are no longer listed above the documents.
  expect(screen.queryByText("Arquivos recusados")).toBeNull();
});

it("points Produção's refused files to the company's capture, where they are listed", () => {
  state.environment = "production";
  state.queries["captureRelease:status"] = { state: "released" };
  state.search = { company: "company", env: "production" };
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: null };
  state.queries["documents:unclassifiedCount"] = { count: 2, more: false, latestAt: 1_000 };
  render(<Documents org={org} contextKey="test" />);
  expect(screen.getByText(/O original e o motivo ficam na captura da empresa/)).toBeTruthy();
  // Not listed at the end of the documents any more.
  expect(screen.queryByRole("heading", { name: "Arquivos recusados" })).toBeNull();
});

it("closes the refused notice until a newer file is refused", () => {
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: null };
  state.queries["documents:unclassifiedCount"] = { count: 2, more: false, latestAt: 1_000 };
  const view = render(<Documents org={org} contextKey="test" />);
  fireEvent.click(screen.getByRole("button", { name: "Fechar aviso de arquivos recusados" }));
  expect(screen.queryByText("Ver arquivos recusados")).toBeNull();
  // Closed in this browser: a new visit with the same files keeps it closed.
  view.unmount();
  const again = render(<Documents org={org} contextKey="test" />);
  expect(screen.queryByText("Ver arquivos recusados")).toBeNull();
  // A file refused after the close brings it back.
  state.queries["documents:unclassifiedCount"] = { count: 3, more: false, latestAt: 2_000 };
  again.rerender(<Documents org={org} contextKey="test" />);
  expect(screen.getByText("Ver arquivos recusados")).toBeTruthy();
});

it("keeps the page size in the URL and asks the server for it", () => {
  state.search = { company: "company", perPage: "50" };
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: "next" };
  render(<Documents org={org} contextKey="test" />);
  expect(state.args["documents:list"]).toEqual(expect.objectContaining({ limit: 50 }));
  fireEvent.change(screen.getByLabelText("Por página"), { target: { value: "20" } });
  expect(state.navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ search: expect.objectContaining({ perPage: undefined }) }),
  );
});

it("pages the list with one previous/next pattern", () => {
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: "next" };
  render(<Documents org={org} contextKey="test" />);
  const pager = screen.getByRole("navigation", { name: "Páginas de documentos" });
  const previous = within(pager).getByRole("button", { name: "Página anterior" });
  const next = within(pager).getByRole("button", { name: "Próxima página" });
  expect(pager.querySelector("button")).toBe(previous);
  expect((previous as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(next);
  expect(
    (
      screen
        .getByRole("navigation", { name: "Páginas de documentos" })
        .querySelector("button") as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("labels the date filter and shows the date it measures beside the emission", () => {
  state.queries["documents:list"] = { page: [captured], indexing: false, nextCursor: null };
  render(<Documents org={org} contextKey="test" />);
  expect(screen.getByLabelText("Recebido desde")).toBeTruthy();
  expect(screen.getByLabelText("Recebido até")).toBeTruthy();
  expect(screen.queryByText(/Importado desde/)).toBeNull();
  const row = screen.getByRole("button", { name: "NF-e 7" }).closest("tr")!;
  expect(row.textContent).toContain("02/10/2026");
  expect(row.textContent).toMatch(/Recebido em 08\/10\/2026/);
});

it("marks an NF-e that arrived only as the distribution summary, in the list and in its data", () => {
  state.queries["documents:list"] = {
    page: [{ ...captured, kind: "summary", completeness: "summary" }],
    indexing: false,
    nextCursor: null,
  };
  const view = render(<Documents org={org} contextKey="test" />);
  // Information, not an alert (#433).
  const badge = screen
    .getByRole("button", { name: "NF-e 7" })
    .closest("tr")!
    .querySelector(".ui-badge")!;
  expect(badge.textContent).toBe("Só resumo, sem itens");
  expect(badge.className).toContain("ui-badge--info");
  view.unmount();
  state.search = { ...state.search, document: "document" };
  state.queries["documents:detail"] = {
    ...detailFixture,
    summary: { ...captured, kind: "summary", completeness: "summary" },
    payload: {
      kind: "summary",
      issuer: { name: "Fornecedor Sintético Ltda", document: "11222333000181" },
      issuedAt: "2026-10-02T10:00:00-03:00",
      total: "150.00",
    },
  };
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  expect(screen.getByRole("heading", { name: "Só o resumo da nota" })).toBeTruthy();
  const notice = screen.getByText(/Ciência da Operação/);
  // The full XML may come, never promised; a fixed notice, not a live region.
  expect(notice.textContent).toMatch(/pode chegar/);
  expect(notice.textContent).not.toMatch(/completo chega/);
  expect(notice.closest('[role="status"]')).toBeNull();
});

it("names each note that arrived only as the summary apart, never a generic link (#462)", () => {
  const summary = { ...captured, kind: "summary", completeness: "summary" } as const;
  state.queries["documents:list"] = {
    page: [
      // The server reads the number from the key of each summary.
      { ...summary, id: "first", number: "69" },
      { ...summary, id: "second", number: "70" },
      // Without a number, the issuer and the date, or the receipt alone.
      { ...summary, id: "third", number: null },
      { ...summary, id: "fourth", number: null, issuer: null, issuedAt: null },
    ],
    indexing: false,
    nextCursor: null,
  };
  render(<Documents org={org} contextKey="test" />);
  const names = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("button")!.textContent);
  expect(names).toEqual([
    "NF-e 69",
    "NF-e 70",
    "NF-e de Fornecedor Sintético Ltda, emitida em 02/10/2026",
    expect.stringMatching(/^NF-e recebida em 08\/10\/2026/),
  ]);
  expect(screen.queryByRole("button", { name: "Abrir documento" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "NF-e 70" }));
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ search: expect.objectContaining({ document: "second" }) }),
  );
});
it("titles a document without a number by its issuer and date, like its list link", () => {
  state.search = { ...state.search, document: "document" };
  state.queries["documents:detail"] = {
    ...detailFixture,
    summary: { ...captured, kind: "summary", completeness: "summary", number: null },
  };
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "NF-e de Fornecedor Sintético Ltda, emitida em 02/10/2026",
    }),
  ).toBeTruthy();
});

it("exports a production document in its own environment", async () => {
  state.environment = "production";
  state.queries["captureRelease:status"] = { state: "released" };
  state.search = { company: "company", env: "production", document: "document" };
  state.queries["documents:detail"] = detailFixture;
  state.queries["documents:canProcess"] = false;
  render(<Documents org={org} contextKey="test" />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar documento e histórico" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  expect(state.initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      environment: "production",
      selection: { kind: "document", documentId: "document", companyId: "company" },
    }),
  );
});

describe("NF-e purpose and declared totals in the document data", () => {
  const invoice = (payload: Record<string, unknown>) => ({
    ...detailFixture,
    payload: {
      kind: "invoice",
      key: captured.key,
      environment: "2",
      number: "7",
      series: "1",
      issuedAt: "2026-10-02T10:00:00-03:00",
      operation: "VENDA DE MERCADORIA",
      issuer: {
        kind: "CNPJ",
        document: "11222333000181",
        name: "Fornecedor",
        stateRegistration: null,
      },
      recipient: null,
      total: "150.00",
      declaredTotals: { vNF: "150.00", vNFTot: "165.30" },
      totals: [],
      nt2026008: { vProdLiqTot: null },
      nt2026006: { gPgtoVinc: null },
      protocol: null,
      purpose: {
        code: "5",
        label: "Nota de crédito",
        creditNoteType: { code: "04", label: "Redução de valores" },
        debitNoteType: null,
        inconsistencies: [],
      },
      ...payload,
    },
  });
  /** The row whose label is exactly `label`; its XML tag, when it has one, sits apart. */
  const row = (label: string) => {
    const term = Array.from(document.querySelectorAll("dt")).find(
      (dt) => (dt.querySelector(".fiscal-term") ?? dt.firstChild)?.textContent === label,
    );
    if (!term) throw new Error(`No field ${label}`);
    return { tag: term.querySelector(".fiscal-tag")?.textContent ?? null, term };
  };
  const value = (label: string) => row(label).term.nextElementSibling!.textContent;
  beforeEach(() => {
    state.search = { ...state.search, document: "document" };
    state.queries["documents:canProcess"] = false;
  });
  it("labels vNF and vNFTot apart and keeps purpose apart from the operation nature", () => {
    state.queries["documents:detail"] = invoice({});
    render(<Documents org={org} contextKey="test" />);
    expect(value("Valor total da NF-e")).toBe("R$ 150,00");
    expect(value("Valor total da NF-e com IBS/CBS/IS")).toBe("R$ 165,30");
    // Every XML field shows its tag the same way, apart from the label.
    expect(
      [
        "Natureza da operação",
        "Finalidade",
        "Tipo de nota de crédito",
        "Valor total da NF-e",
        "Valor total da NF-e com IBS/CBS/IS",
      ].map((label) => row(label).tag),
    ).toEqual(["natOp", "finNFe", "tpNFCredito", "vNF", "vNFTot"]);
    expect(value("Natureza da operação")).toBe("VENDA DE MERCADORIA");
    expect(value("Finalidade")).toBe("Nota de crédito · 5");
    expect(value("Tipo de nota de crédito")).toBe("Redução de valores · 04");
    expect(screen.queryByText("Tipo de nota de débito")).toBeNull();
    expect(screen.queryByText("Finalidade inconsistente")).toBeNull();
  });
  it("shows NT 2026.008 values only when the XML declares them", () => {
    state.queries["documents:detail"] = invoice({ nt2026008: { vProdLiqTot: "22.45" } });
    const item = {
      item: "1",
      code: "ITEM-69",
      description: "PRODUTO SINTETICO",
      ncm: "21069090",
      cfop: "5102",
      cest: null,
      purchaseOrder: null,
      purchaseOrderItem: null,
      unit: "UN",
      quantity: "2.0000",
      unitPrice: "12.3456789012",
      total: "24.69",
      tributaryUnit: "UN",
      tributaryQuantity: "2.0000",
      tributaryUnitPrice: "12.3456789012",
      nt2026008: { vUnComLiq: "11.2233445566", vProdLiq: "22.45", vICMSPrevisto: "0.00" },
      taxes: [],
    };
    state.queries["documents:items"] = { page: [item], nextCursor: null };
    render(<Documents org={org} contextKey="test" />);
    // Official descriptions of NT 2026.008 v1.00, page 6, with the tag apart from the label.
    expect(value("Valor total líquido dos produtos ou serviços (sem tributos)")).toBe("R$ 22,45");
    expect(row("Valor total líquido dos produtos ou serviços (sem tributos)").tag).toBe(
      "vProdLiqTot",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Itens" }));
    expect(value("Valor líquido (sem tributos)")).toBe("R$ 22,45");
    expect(value("Valor líquido unitário (sem tributos)")).toBe("R$ 11,22");
    // Zero is declared, so it shows; absence hides the row.
    expect(value("Valor do ICMS previsto")).toBe("R$ 0,00");
    expect(
      [
        "Valor líquido unitário (sem tributos)",
        "Valor líquido (sem tributos)",
        "Valor do ICMS previsto",
      ].map((label) => row(label).tag),
    ).toEqual(["vUnComLiq", "vProdLiq", "vICMSPrevisto"]);
    // The declared quantity in pt-BR, every declared digit kept.
    expect(value("Quantidade")).toBe("2,0000 UN");
    cleanup();
    state.queries["documents:detail"] = invoice({ nt2026008: { vProdLiqTot: null } });
    state.queries["documents:items"] = {
      page: [{ ...item, nt2026008: { vUnComLiq: null, vProdLiq: null, vICMSPrevisto: null } }],
      nextCursor: null,
    };
    render(<Documents org={org} contextKey="test" />);
    expect(screen.queryByText(/sem tributos/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Itens" }));
    expect(screen.queryByText(/sem tributos|ICMS previsto/)).toBeNull();
    expect(document.querySelector(".fiscal-tag")).toBeNull();
  });
  it("shows the NT 2026.006 payment links only when the XML declares the group", () => {
    const title = "Vinculação com a transação de pagamento";
    const link = {
      nPag: "1",
      idTransacao: "000123-SINTETICA",
      tpMeioPgto: "17",
      tpMeioPgtoLabel: "Pix QRCode",
      CNPJReceb: "11444777000161",
      CNPJBasePSP: "12345678",
    };
    const unlisted =
      /IT DFe 2026\.001 v1\.01 prevê a rejeição, na autorização, de um meio de pagamento fora da sua tabela; a plataforma não avalia/;
    state.queries["documents:detail"] = invoice({
      nt2026006: {
        gPgtoVinc: [
          link,
          {
            ...link,
            nPag: "2",
            idTransacao: "TX-SINTETICA-02",
            tpMeioPgto: "24",
            tpMeioPgtoLabel: "TEF / booktransfer",
            CNPJBasePSP: "11222333",
          },
        ],
      },
    });
    render(<Documents org={org} contextKey="test" />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    const payments = screen.getAllByRole("heading", { name: /^Pagamento \d$/ });
    expect(payments.map((heading) => heading.textContent)).toEqual(["Pagamento 1", "Pagamento 2"]);
    // Read again on each call: the unlisted case below renders a new tree.
    const field = (label: string, index = 0) => {
      const entry = screen.getAllByRole("heading", { name: /^Pagamento \d$/ })[index]!;
      return Array.from(entry.closest("li")!.querySelectorAll("dt")).find(
        (dt) => dt.querySelector(".fiscal-term")?.textContent === label,
      )!.nextElementSibling!.textContent;
    };
    const first = payments[0]!.closest("li")!;
    expect(field("Identificador da transação financeira")).toBe("000123-SINTETICA");
    // The IT DFe 2026.001 v1.01 description with the declared code, as for the purpose.
    expect(field("Meio de pagamento")).toBe("Pix QRCode · 17");
    expect(field("Meio de pagamento", 1)).toBe("TEF / booktransfer · 24");
    expect(screen.queryByText(unlisted)).toBeNull();
    expect(field("CNPJ do recebedor do pagamento")).toBe("11.444.777/0001-61");
    expect(field("CNPJ base da instituição financeira ou de pagamento")).toBe("12.345.678");
    expect(Array.from(first.querySelectorAll(".fiscal-tag")).map((tag) => tag.textContent)).toEqual(
      ["idTransacao", "tpMeioPgto", "CNPJReceb", "CNPJBasePSP"],
    );
    cleanup();
    // A code outside the IT table keeps its value, never a guessed label, and the card attributes
    // its rejection to the IT, a rule the platform does not evaluate.
    state.queries["documents:detail"] = invoice({
      nt2026006: { gPgtoVinc: [{ ...link, tpMeioPgto: "99", tpMeioPgtoLabel: null }] },
    });
    render(<Documents org={org} contextKey="test" />);
    expect(field("Meio de pagamento")).toBe("Fora da tabela do IT DFe 2026.001 v1.01 · 99");
    expect(screen.getByText(unlisted)).toBeTruthy();
    cleanup();
    // Omitted in the XML: nothing at all.
    state.queries["documents:detail"] = invoice({ nt2026006: { gPgtoVinc: null } });
    render(<Documents org={org} contextKey="test" />);
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByText(/Não extraída nesta versão/)).toBeNull();
    cleanup();
    // Not extracted by a version before nfe-parser/6: say so and point to reprocessing.
    state.queries["documents:detail"] = invoice({ nt2026006: null });
    render(<Documents org={org} contextKey="test" />);
    expect(screen.queryByRole("heading", { name: title })).toBeNull();
    expect(row(title).tag).toBe("gPgtoVinc");
    expect(value(title)).toBe(
      "Não extraída nesta versão. Reprocesse o documento para lê-la do XML original.",
    );
    cleanup();
    state.queries["documents:detail"] = invoice({ nt2026006: { gPgtoVinc: [] } });
    render(<Documents org={org} contextKey="test" />);
    expect(screen.getByText("O XML declara o grupo sem nenhum pagamento.")).toBeTruthy();
  });
  it("says what is missing instead of showing zero or a guessed value", () => {
    state.queries["documents:detail"] = invoice({
      declaredTotals: { vNF: "150.00", vNFTot: null },
      purpose: null,
    });
    render(<Documents org={org} contextKey="test" />);
    expect(value("Valor total da NF-e com IBS/CBS/IS")).toBe("Não informado no XML");
    expect(value("Finalidade")).toMatch(/^Não extraída nesta versão\. Reprocesse/);
    cleanup();
    state.queries["documents:detail"] = invoice({
      purpose: {
        code: "1",
        label: "NF-e normal",
        creditNoteType: { code: "09", label: null },
        debitNoteType: null,
        inconsistencies: ["B25.2-10"],
      },
    });
    render(<Documents org={org} contextKey="test" />);
    expect(value("Tipo de nota de crédito")).toBe("Código não previsto no schema · 09");
    expect(screen.getByText("Finalidade inconsistente")).toBeTruthy();
    expect(
      screen.getByText(
        "O XML informa tipo de nota de crédito, mas a finalidade não é Nota de crédito.",
      ),
    ).toBeTruthy();
    // The rule is a secondary reference; the platform has no balance to speak of.
    expect(screen.getByText(/Referência: regra B25\.2-10 da NT 2025\.002\./)).toBeTruthy();
    expect(screen.queryByText(/saldo/)).toBeNull();
  });
});
