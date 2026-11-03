// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { ImportFlow } from "./imports";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutate: vi.fn(),
  query: vi.fn(),
  subscriptions: vi.fn(),
  detail: undefined as { versionId: string; result: string } | null | undefined,
  batch: "old-batch" as string | undefined,
  selected: "ready" as "ready" | "loading" | "missing",
  history: [] as Array<Record<string, unknown>>,
  recent: [] as Array<Record<string, unknown>>,
  result: {
    id: "old-batch",
    createdAt: 1,
    files: [] as Array<Record<string, unknown>>,
    origin: { kind: "console", integration: null } as {
      kind: "console" | "integration";
      integration: string | null;
    },
    currentProcessor: "xml-import/3",
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ batch: state.batch }),
  useNavigate: () => state.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
  useConvex: () => ({ query: state.query }),
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.subscriptions(getFunctionName(fn), args);
    return args === "skip"
      ? undefined
      : getFunctionName(fn) === "imports:selected"
        ? state.selected === "loading"
          ? undefined
          : state.selected === "missing"
            ? null
            : state.result
        : getFunctionName(fn) === "imports:detail"
          ? state.detail
          : getFunctionName(fn) === "importHistory:get"
            ? state.history
            : getFunctionName(fn) === "imports:recent"
              ? state.recent
              : [];
  },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));
const scope = {
  organizationId: "org",
  companyId: "company",
  environment: "sandbox",
} as unknown as Parameters<typeof ImportFlow>[0]["scope"];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  state.batch = "old-batch";
  state.selected = "ready";
  state.result.files = [];
  state.result.origin = { kind: "console", integration: null };
  state.history = [];
  state.recent = [];
  state.detail = undefined;
});

it("blocks submission and file selection until new-import navigation commits", async () => {
  // Uploaded: resumable without choosing XMLs, so only the navigation holds the button.
  state.result.files = [{ id: "file", name: "nota.xml", state: "uploaded" }];
  let finish!: () => void;
  state.navigate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  fireEvent.click(screen.getByRole("button", { name: "Nova importação" }));
  expect(
    (screen.getByRole("button", { name: "Retomar esta importação" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen
      .getByLabelText("Arraste os XMLs aqui ou escolha os arquivos")
      .getAttribute("aria-disabled"),
  ).toBe("true");
  // The area says why too, without a second reading of the reason under the buttons (#526).
  const area = screen
    .getByLabelText("Arraste os XMLs aqui ou escolha os arquivos")
    .closest(".fiscal-dropzone")!;
  expect(area.lastElementChild!.textContent).toBe("Aguarde a troca de importação.");
  expect(area.lastElementChild!.getAttribute("aria-hidden")).toBe("true");
  expect(state.mutate).not.toHaveBeenCalled();
  await act(async () => finish());
});

it.each(["{broken", "", '<script>alert("resultado")</script>'])(
  "keeps malformed persisted result %j visible as text",
  (result) => {
    state.result.files = [
      { id: "file", name: "nota.xml", state: "succeeded", versionId: "version", result: null },
    ];
    state.detail = { versionId: "version", result };
    render(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
    expect(screen.getByText("nota.xml")).toBeTruthy();
    expect(screen.queryByText(/JSON inválido/)).toBeNull();
    toggleResult("nota.xml", true);
    expect(screen.getByText(/JSON inválido/)).toBeTruthy();
    expect(screen.getByText("Importações recentes")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  },
);
it("restores the controls and explains a failed navigation", async () => {
  state.navigate.mockRejectedValue(new Error("navigation failed"));
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Nova importação" })));
  expect(screen.getByText("Não foi possível trocar a importação. Tente novamente.")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Nova importação" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it("keeps malformed historical results visible without crashing the route", () => {
  state.result.files = [{ id: "file", name: "nota.xml", state: "succeeded", operationId: "op" }];
  state.history = [
    { id: "version", result: "{broken", processorVersion: "1", completedAt: 1, code: "IMPORTED" },
  ];
  render(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  const history = screen
    .getByText(summaryText("Histórico de processamento de nota.xml"))
    .closest("details") as HTMLDetailsElement;
  history.open = true;
  fireEvent(history, new Event("toggle"));
  expect(screen.queryByText(/JSON inválido/)).toBeNull();
  const version = history.querySelector("details")!;
  version.open = true;
  fireEvent(version, new Event("toggle"));
  expect(screen.getByText(/JSON inválido/)).toBeTruthy();
  expect(screen.getByText(summaryText("Histórico de processamento de nota.xml"))).toBeTruthy();
});

it.each(["loading", "missing"] as const)(
  "does not turn a %s batch into a new import",
  (selected) => {
    state.selected = selected;
    render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
    expect(
      screen
        .getByLabelText("Arraste os XMLs aqui ou escolha os arquivos")
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Importar arquivos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        selected === "loading"
          ? "Carregando importação…"
          : "Importação indisponível neste contexto. Selecione outro lote ou inicie uma nova importação.",
      ),
    ).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  },
);

it.each(["succeeded", "paused"])(
  "blocks %s processing actions during a batch change",
  async (status) => {
    state.result.files = [
      {
        id: "file",
        name: "nota.xml",
        state: status,
        code: "IMPORTED",
        operationId: "op",
        generation: 1,
      },
    ];
    let finish!: () => void;
    state.navigate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
    fireEvent.click(screen.getByRole("button", { name: "Nova importação" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: status === "succeeded" ? "Reprocessar nota.xml" : "Retomar processamento de nota.xml",
      }),
    );
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => finish());
  },
);

it("does not start an upload when its ticket arrives after leaving the page", async () => {
  const file = new File(["<xml/>"], "nota.xml", { type: "application/xml" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("<xml/>").buffer,
  });
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  state.result.files = [
    { id: "file", name: "nota.xml", state: "reserved", sha256: "00".repeat(32) },
  ];
  state.query.mockResolvedValue({ files: state.result.files });
  let finish!: (value: unknown) => void;
  state.mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
  const view = render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
      target: { files: [file] },
    }),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retomar esta importação" })),
  );
  expect(state.mutate).toHaveBeenCalledWith("imports:upload", { fileId: "file" });
  view.unmount();
  await act(async () => finish({ url: "http://localhost/upload", token: "synthetic" }));
  expect(send).not.toHaveBeenCalled();
  send.mockRestore();
});

it("preserves selected originals when switching to a new import fails", async () => {
  state.navigate.mockRejectedValue(new Error("navigation failed"));
  const file = new File(["<xml/>"], "original.xml");
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
      target: { files: [file] },
    }),
  );
  const selected = () => screen.getByText("original.xml").closest("li")!.textContent;
  expect(selected()).toMatch(/original\.xml.*1 KiB/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Nova importação" })));
  expect(selected()).toMatch(/original\.xml.*1 KiB/);
});

it("resumes an uploaded original after refresh without reserving or uploading again", async () => {
  state.result.files = [{ id: "file", name: "nota.xml", state: "uploaded" }];
  state.query.mockResolvedValue({ files: state.result.files });
  state.mutate.mockResolvedValue({ operationId: "op", reused: false });
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retomar esta importação" })),
  );
  expect(state.query).toHaveBeenCalledWith(expect.anything(), {
    importId: "old-batch",
    expectedScope: scope,
    includeResults: false,
  });
  expect(state.mutate.mock.calls).toEqual([["imports:confirm", { fileId: "file" }]]);
  expect(state.navigate).not.toHaveBeenCalled();
});

/** The file name in a disclosure summary is visually hidden text, in its own element. */
function summaryText(text: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === "SUMMARY" && element.textContent === text;
}
function toggleResult(name: string, open: boolean) {
  const details = screen
    .getByText(summaryText(`Resultado do processamento de ${name}`))
    .closest("details") as HTMLDetailsElement;
  details.open = open;
  fireEvent(details, new Event("toggle"));
}

it("subscribes and formats only the expanded file in a 20-file batch", () => {
  const result = JSON.stringify({ diagnostic: "synthetic-large-".repeat(8000) });
  state.result.files = Array.from({ length: 20 }, (_, i) => ({
    id: `file-${i}`,
    name: `nota-${i}.xml`,
    state: "succeeded",
    versionId: `version-${i}`,
    result: null,
  }));
  const parse = vi.spyOn(JSON, "parse");
  const view = render(
    <ImportFlow scope={scope} writable={false} organizationSlug="organization" />,
  );
  expect(
    state.subscriptions.mock.calls.filter(
      ([name, args]) => name === "imports:detail" && args !== "skip",
    ),
  ).toHaveLength(0);
  expect(parse.mock.calls.filter(([value]) => value === result)).toHaveLength(0);
  expect(document.querySelectorAll("pre")).toHaveLength(0);
  expect(state.subscriptions).toHaveBeenCalledWith("imports:selected", {
    ...scope,
    batch: "old-batch",
    includeResults: false,
  });
  toggleResult("nota-3.xml", true);
  expect(screen.getByText("Carregando resultado…")).toBeTruthy();
  expect(state.subscriptions).toHaveBeenCalledWith("imports:detail", {
    fileId: "file-3",
    versionId: "version-3",
    expectedScope: scope,
  });
  state.detail = { versionId: "version-3", result };
  view.rerender(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(document.querySelectorAll("pre")).toHaveLength(1);
  expect(parse.mock.calls.filter(([value]) => value === result)).toHaveLength(1);
  view.rerender(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(parse.mock.calls.filter(([value]) => value === result)).toHaveLength(1);
  toggleResult("nota-3.xml", false);
  expect(document.querySelectorAll("pre")).toHaveLength(0);
  state.subscriptions.mockClear();
  view.rerender(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(
    state.subscriptions.mock.calls.filter(
      ([name, args]) => name === "imports:detail" && args !== "skip",
    ),
  ).toHaveLength(0);
});

it("removes an expanded result while reprocessing and requires opening the new version", () => {
  state.result.files = [
    { id: "file", name: "nota.xml", state: "succeeded", versionId: "v1", result: null },
  ];
  state.detail = { versionId: "v1", result: '{"first":true}' };
  const view = render(
    <ImportFlow scope={scope} writable={false} organizationSlug="organization" />,
  );
  toggleResult("nota.xml", true);
  expect(document.querySelector("pre")?.textContent).toContain("first");
  state.result.files = [
    { id: "file", name: "nota.xml", state: "running", versionId: null, result: null },
  ];
  view.rerender(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(document.querySelector("pre")).toBeNull();
  state.result.files = [
    { id: "file", name: "nota.xml", state: "succeeded", versionId: "v2", result: null },
  ];
  state.detail = null;
  view.rerender(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(document.querySelector("pre")).toBeNull();
  toggleResult("nota.xml", true);
  expect(screen.getByText(/Resultado indisponível/)).toBeTruthy();
});
it("shows a malformed XML as a refusal in words, with the code as detail and no reprocessing", () => {
  state.result.files = [
    {
      id: "file",
      name: "quebrado.xml",
      state: "succeeded",
      code: "XML_MALFORMED",
      versionId: "v1",
      processorVersion: "xml-import/3",
      operationId: "op",
    },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const item = screen.getByText("quebrado.xml").closest("li")!;
  expect(item.dataset.tone).toBe("danger");
  expect(item.textContent).toContain("XML recusado");
  expect(item.textContent).toMatch(/não é um XML bem formado/);
  expect(item.textContent).toMatch(/Código para suporte: XML_MALFORMED/);
  expect(item.textContent).not.toMatch(/Processamento concluído/);
  expect(screen.queryByRole("button", { name: "Reprocessar quebrado.xml" })).toBeNull();
  expect(item.textContent).toMatch(/repetiria o mesmo resultado/);
  expect(screen.getByText("Falhou")).toBeTruthy();
});

it("lists the files that need the person first and folds the imported ones past five", () => {
  state.result.files = [
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `ok-${index}`,
      name: `nota-${index}.xml`,
      state: "succeeded",
      code: "IMPORTED",
    })),
    { id: "bad", name: "quebrado.xml", state: "succeeded", code: "XML_MALFORMED" },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const names = () =>
    Array.from(document.querySelectorAll(".fiscal-import-file__name")).map((el) => el.textContent);
  // The refusal, last in the batch, comes first; the imported keep their order.
  expect(names()).toEqual([
    "quebrado.xml",
    "nota-0.xml",
    "nota-1.xml",
    "nota-2.xml",
    "nota-3.xml",
    "nota-4.xml",
  ]);
  // A success says itself in the badge: no support code for it.
  expect(
    Array.from(document.querySelectorAll(".fiscal-import-file")).find(
      (li) => li.querySelector(".fiscal-import-file__name")?.textContent === "nota-0.xml",
    )!.textContent,
  ).not.toMatch(/Código para suporte/);
  fireEvent.click(screen.getByRole("button", { name: "Mostrar os outros 2 importados" }));
  expect(names()).toHaveLength(8);
  expect(screen.queryByRole("button", { name: /Mostrar os outros/ })).toBeNull();
});

it("points a refusal by the reader to the reprocessing of technical refusals (#499)", () => {
  state.result.files = [
    {
      id: "file",
      name: "evento.xml",
      state: "succeeded",
      code: "XML_EVENT_UNSUPPORTED",
      versionId: "v1",
      processorVersion: "xml-import/3",
      operationId: "op",
    },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const item = screen.getByText("evento.xml").closest("li")!;
  expect(screen.queryByRole("button", { name: "Reprocessar evento.xml" })).toBeNull();
  expect(item.textContent).toMatch(/“Reprocessar recusas técnicas” em “Arquivos recusados”/);
});

it("offers reprocessing a refusal of an older processor and an imported file", () => {
  state.result.files = [
    {
      id: "old",
      name: "antigo.xml",
      state: "succeeded",
      code: "XML_NAMESPACE_UNSUPPORTED",
      processorVersion: "xml-import/2",
    },
    { id: "ok", name: "nota.xml", state: "succeeded", code: "IMPORTED" },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  expect(screen.getByRole("button", { name: "Reprocessar antigo.xml" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reprocessar nota.xml" })).toBeTruthy();
  // One imported, one refused: the batch is partial.
  expect(screen.getByText("Parcial")).toBeTruthy();
});

it("reads an integration's batch without offering the writes the server refuses", () => {
  state.result.origin = { kind: "integration", integration: "ERP sintético" };
  state.result.files = [
    { id: "a", name: "pausado.xml", state: "paused", operationId: "op", generation: 1 },
    { id: "b", name: "nota.xml", state: "succeeded", code: "IMPORTED" },
    { id: "c", name: "pendente.xml", state: "reserved" },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  expect(screen.queryByRole("button", { name: /Retomar processamento/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Reprocessar/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancelar uploads pendentes" })).toBeNull();
  const resume = screen.getByRole("button", { name: "Retomar esta importação" });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById(resume.getAttribute("aria-describedby")!)!.textContent).toMatch(
    /Criado pela integração ERP sintético; gerencie pela integração/,
  );
  expect(screen.getAllByText(/Integração ERP sintético/).length).toBeGreaterThan(0);
});

it("says why resuming is unavailable and mentions cancel only when the button exists", () => {
  state.result.files = [{ id: "a", name: "nota.xml", state: "succeeded", code: "IMPORTED" }];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const resume = screen.getByRole("button", { name: "Retomar esta importação" });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById(resume.getAttribute("aria-describedby")!)!.textContent).toMatch(
    /Nenhum arquivo desta importação aguarda envio/,
  );
  expect(screen.queryByText(/Cancelar uploads pendentes/)).toBeNull();
});

it("shows the five newest imports, plus the open one and any still running", () => {
  const done = { state: "succeeded", code: "IMPORTED" };
  state.recent = Array.from({ length: 10 }, (_, index) => ({
    // The open batch of these tests is "old-batch": here, the oldest.
    id: index === 9 ? "old-batch" : `batch-${index}`,
    createdAt: Date.UTC(2026, 9, 20 - index, 13),
    origin: { kind: "console", integration: null },
    files: index === 7 ? [{ state: "running", code: null }] : [done],
  }));
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const region = screen.getByRole("region", { name: "Importações recentes" });
  const rows = () => region.querySelectorAll(".fiscal-recent-imports > li");
  // Five newest, the running one (8th) and the open one (10th).
  expect(rows()).toHaveLength(7);
  fireEvent.click(screen.getByRole("button", { name: "Mostrar as 10 últimas" }));
  expect(rows()).toHaveLength(10);
  expect(screen.queryByRole("button", { name: "Mostrar as 10 últimas" })).toBeNull();
});

it("lists recent imports with date, files, result and origin", () => {
  state.recent = [
    {
      id: "old-batch",
      createdAt: Date.UTC(2026, 9, 9, 13),
      origin: { kind: "console", integration: null },
      files: [{ state: "succeeded", code: "IMPORTED" }],
    },
    {
      id: "other",
      createdAt: Date.UTC(2026, 9, 8, 13),
      origin: { kind: "integration", integration: "ERP sintético" },
      files: [
        { state: "succeeded", code: "IMPORTED" },
        { state: "succeeded", code: "XML_MALFORMED" },
      ],
    },
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const rows = screen.getByRole("region", { name: "Importações recentes" }).querySelectorAll("li");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  expect(rows[0]!.textContent).toMatch(/1 arquivo · 1 importado/);
  expect(rows[0]!.textContent).toMatch(/Concluída/);
  expect(rows[1]!.textContent).toMatch(/2 arquivos · 1 importado · 1 recusado/);
  expect(rows[1]!.textContent).toMatch(/Parcial/);
  expect(rows[1]!.textContent).toMatch(/Integração ERP sintético/);
});

it("never reads a paused, refused or unsent batch as concluded (#507)", () => {
  const batch = (id: string, files: Array<{ state: string; code: string | null }>) => ({
    id,
    createdAt: Date.UTC(2026, 9, 9, 13),
    origin: { kind: "console", integration: null },
    files,
  });
  state.recent = [
    batch("refused", [{ state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" }]),
    batch("paused", [{ state: "paused", code: "ACCESS_REVOKED" }]),
    batch("paused-mixed", [
      { state: "paused", code: null },
      { state: "succeeded", code: "DUPLICATE" },
    ]),
    batch("unsent", [{ state: "expired", code: null }]),
    batch("failed", [
      { state: "failed", code: "ORIGINAL_UNAVAILABLE" },
      { state: "succeeded", code: "COMPANY_MISMATCH" },
      { state: "succeeded", code: "XML_MALFORMED" },
    ]),
    batch("refused-running", [
      { state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" },
      { state: "running", code: null },
    ]),
  ];
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const rows = [
    ...screen.getByRole("region", { name: "Importações recentes" }).querySelectorAll("li"),
  ].map((row) => row.textContent);
  expect(rows[0]).toMatch(/1 arquivo · 1 recusado.*Falhou/);
  expect(rows[1]).toMatch(/1 arquivo · 1 pausado.*Pausada/);
  expect(rows[2]).toMatch(/2 arquivos · 1 importado · 1 pausado.*Parcial/);
  expect(rows[3]).toMatch(/1 arquivo · 1 não enviado.*Envio não concluído/);
  // The Início lists this batch now; the screen agrees instead of saying only "Em andamento".
  // Refused and failed counted apart, each matching its file badge.
  expect(rows[4]).toMatch(/3 arquivos · 2 recusados · 1 com falha.*Falhou/);
  expect(rows[5]).toMatch(/2 arquivos · 1 recusado · 1 em andamento.*Requer atenção/);
  expect(rows.join(" ")).not.toMatch(/Concluída/);
});

it("renders every NFS-e result and its fiscal assurance", () => {
  state.result.files = [
    {
      id: "file",
      name: "lote.xml",
      state: "succeeded",
      code: "NFSE_BATCH_IMPORTED",
      documents: Array.from({ length: 7 }, (_, i) => ({
        documentId: `doc-${i}`,
        versionId: `version-${i}`,
        number: String(i + 1),
        code: "IMPORTED",
      })),
    },
  ];
  render(<ImportFlow scope={scope} writable={false} organizationSlug="organization" />);
  expect(screen.getByText("Lote de NFS-e importado")).toBeTruthy();
  for (let i = 1; i <= 7; i++) expect(screen.getByText(`NFS-e ${i}`)).toBeTruthy();
  expect(screen.getByText(/7 NFS-e registradas/)).toBeTruthy();
  expect(screen.queryByText("Formato XML não reconhecido")).toBeNull();
});

/** Network double: each request records the file it sends and finishes only when the test says. */
class FakeUpload {
  static sent: FakeUpload[] = [];
  upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  status = 0;
  responseText = "";
  aborted = false;
  body: File | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send(body: File) {
    this.body = body;
    FakeUpload.sent.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  finish() {
    this.status = 200;
    this.onload?.();
  }
  /** The server's refusal, in the shape of the upload route's error body. */
  refuse(status: number, code: string) {
    this.status = status;
    this.responseText = JSON.stringify({ error: { code, message: "", retryable: false } });
    this.onload?.();
  }
  /** Every byte handed to the network: from now on only the server's answer is awaited. */
  handOver() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 6 } as ProgressEvent);
    this.upload.onload?.();
  }
}
type Held = {
  settled?: boolean;
  name: string;
  fileId: string;
  resolve: (v?: unknown) => void;
  reject: (e: unknown) => void;
};
/** Two reserved files of the same batch, selected again, with every server call held by the test. */
async function twoFileBatch() {
  FakeUpload.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  const local = ["a.xml", "b.xml"].map((name) => {
    const file = new File(["<xml/>"], name, { type: "application/xml" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
    return file;
  });
  const remote = (name: string, fileState: string) => ({
    id: name,
    name,
    state: fileState,
    sha256: "00".repeat(32),
  });
  state.result.files = [remote("a.xml", "reserved"), remote("b.xml", "reserved")];
  state.query.mockImplementation(async () => ({ files: state.result.files }));
  const held: Held[] = [];
  state.mutate.mockImplementation(
    (name: string, args: { fileId: string }) =>
      new Promise((resolve, reject) => held.push({ name, fileId: args.fileId, resolve, reject })),
  );
  const view = render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
      target: { files: local },
    }),
  );
  const call = (name: string, fileId: string) => {
    // The oldest answer still pending: a file may be requested again by a later run.
    const found = held.find(
      (item) => item.name === name && item.fileId === fileId && !item.settled,
    );
    if (!found) throw new Error(`${name} ${fileId} was not requested`);
    found.settled = true;
    return found;
  };
  return {
    view,
    local,
    remote,
    call,
    calls: () => held.map(({ name, fileId }) => `${name} ${fileId}`),
    settle: (name: string, fileId: string, value?: unknown) =>
      act(async () => call(name, fileId).resolve(value)),
    refuse: (name: string, fileId: string, error: unknown) =>
      act(async () => call(name, fileId).reject(error)),
    sentFiles: () => FakeUpload.sent.map((request) => request.body?.name),
    click: (name: string) => act(async () => fireEvent.click(screen.getByRole("button", { name }))),
  };
}
const ticket = { url: "http://localhost/upload", token: "synthetic", expiresAt: 1 };
const accepted = () => new ConvexError({ code: "ALREADY_ACCEPTED" });

it("never starts the second file after cancelling during the first, even with a slow cancel", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  expect(batch.sentFiles()).toEqual(["a.xml"]);
  await batch.click("Cancelar uploads pendentes");
  // A's cancellation is still on its way to the server: nothing else may start meanwhile.
  expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:cancel a.xml"]);
  // The run is over: nothing says it is still sending, and nothing new can start.
  expect(screen.queryByRole("button", { name: "Enviando…" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancelando…" })).toBeTruthy();
  // No row describes a resume that is not available while the cancel is pending.
  expect(screen.queryByText(/XML original selecionado/)).toBeNull();
  const resume = screen.getByRole("button", { name: "Retomar esta importação" });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById(resume.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Aguarde a resposta do cancelamento.",
  );
  expect(
    screen
      .getByLabelText("Arraste os XMLs aqui ou escolha os arquivos")
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await batch.settle("imports:cancel", "a.xml");
  await batch.settle("imports:cancel", "b.xml");
  expect(batch.sentFiles()).toEqual(["a.xml"]);
  expect(batch.calls()).toEqual([
    "imports:upload a.xml",
    "imports:cancel a.xml",
    "imports:cancel b.xml",
  ]);
  expect(
    screen.getByText("2 envios cancelados; esses arquivos não serão processados."),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Nova importação" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  // The cancel button may leave with the pending uploads; focus lands on the server's answer.
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.textContent).toBe(
    "2 envios cancelados; esses arquivos não serão processados.",
  );
  // The focus reads it out; a live region on top would read it twice.
  expect(document.activeElement?.querySelector("[role]")).toBeNull();
});

const limits = "Até 20 arquivos · 2 MiB por XML";
const dropInput = () =>
  screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos") as HTMLInputElement;
/** What the drop area shows under its label, and what the input is described by. */
function dropArea() {
  const line = dropInput().closest(".fiscal-dropzone")!.lastElementChild!;
  return {
    disabled: dropInput().getAttribute("aria-disabled") === "true",
    line: line.textContent,
    lineHidden: line.getAttribute("aria-hidden") === "true",
    description: dropInput()
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent),
  };
}

it("says inside the drop area why it is unavailable, read once, in every block (#526)", async () => {
  const batch = await twoFileBatch();
  expect(dropArea()).toEqual({
    disabled: false,
    line: limits,
    lineHidden: false,
    description: [limits],
  });
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  // Sending: the buttons only say "Enviando…", so the area's line is the reason it is read by.
  expect(dropArea()).toEqual({
    disabled: true,
    line: "Aguarde o fim do envio.",
    lineHidden: false,
    description: ["Aguarde o fim do envio."],
  });
  // Cancelling: the area shows the reason written under the buttons, and points to that one,
  // so it is read once.
  await batch.click("Cancelar uploads pendentes");
  const cancel = "Aguarde a resposta do cancelamento.";
  expect(dropArea()).toEqual({
    disabled: true,
    line: cancel,
    lineHidden: true,
    description: [cancel],
  });
  expect(screen.getAllByText(cancel)).toHaveLength(2);
  expect(dropInput().getAttribute("aria-describedby")).toBe("import-submit-reason");
  await batch.settle("imports:cancel", "a.xml");
  await batch.settle("imports:cancel", "b.xml");
  expect(dropArea()).toEqual({
    disabled: false,
    line: limits,
    lineHidden: false,
    description: [limits],
  });
});

it("says the chosen files are being read, not sent, while they are hashed (#526)", async () => {
  let digested!: () => void;
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: {
      digest: () =>
        new Promise<ArrayBuffer>((resolve) => {
          digested = () => resolve(new Uint8Array(32).buffer);
        }),
    },
  });
  state.batch = undefined;
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const file = new File(["<xml/>"], "a.xml", { type: "application/xml" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
  await act(async () => fireEvent.change(dropInput(), { target: { files: [file] } }));
  expect(dropArea()).toEqual({
    disabled: true,
    line: "Aguarde a leitura dos arquivos.",
    lineHidden: false,
    description: ["Aguarde a leitura dos arquivos."],
  });
  expect(screen.queryByText("Aguarde o fim do envio.")).toBeNull();
  // The button tells the same story: reading, not sending.
  const reading = screen.getByRole("button", { name: "Lendo arquivos…" }) as HTMLButtonElement;
  expect(reading.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Enviando…" })).toBeNull();
  expect(state.mutate).not.toHaveBeenCalled();
  await act(async () => digested());
  expect(screen.queryByRole("button", { name: "Lendo arquivos…" })).toBeNull();
  expect(screen.getByRole("button", { name: "Importar arquivos" })).toBeTruthy();
  expect(dropArea()).toEqual({
    disabled: false,
    line: limits,
    lineHidden: false,
    description: [limits],
  });
});

it("keeps the focus on the file input before, during and after the reading (#535)", async () => {
  let digested!: () => void;
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: {
      digest: () =>
        new Promise<ArrayBuffer>((resolve) => {
          digested = () => resolve(new Uint8Array(32).buffer);
        }),
    },
  });
  state.batch = undefined;
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const file = new File(["<xml/>"], "a.xml", { type: "application/xml" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
  dropInput().focus();
  expect(document.activeElement).toBe(dropInput());
  await act(async () => fireEvent.change(dropInput(), { target: { files: [file] } }));
  // Blocked without leaving the tab order: a disabled input would drop the focus to the body.
  expect(dropInput().disabled).toBe(false);
  expect(dropInput().getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(dropInput());
  // Activating it meanwhile opens no picker.
  expect(fireEvent.click(dropInput())).toBe(false);
  await act(async () => digested());
  expect(dropInput().getAttribute("aria-disabled")).toBeNull();
  expect(document.activeElement).toBe(dropInput());
  expect(fireEvent.click(dropInput())).toBe(true);
  expect(screen.getByRole("list", { name: "Arquivos escolhidos" }).textContent).toContain("a.xml");
});

it("leaves the focus where the person took it during a slow cancel and announces the answer", async () => {
  const batch = await twoFileBatch();
  // The live region is on the page, empty, before there is anything to announce.
  const live = document.getElementById("import-cancel-status")!;
  expect(live.getAttribute("role")).toBe("status");
  expect(live.textContent).toBe("");
  await batch.click("Cancelar uploads pendentes");
  const elsewhere = document.body.appendChild(document.createElement("button"));
  elsewhere.focus();
  await batch.settle("imports:cancel", "a.xml");
  await batch.settle("imports:cancel", "b.xml");
  expect(document.activeElement).toBe(elsewhere);
  // The same region changes its text, which is what screen readers announce.
  expect(live.isConnected).toBe(true);
  expect(live.textContent).toBe("2 envios cancelados; esses arquivos não serão processados.");
  // The visible copy stays out of the reading order, so browsing does not read it twice.
  expect(
    screen
      .getByText("2 envios cancelados; esses arquivos não serão processados.", {
        ignore: "#import-cancel-status",
      })
      .closest("[aria-hidden='true']"),
  ).toBeTruthy();
  elsewhere.remove();
});

it("drops the progress of an upload stopped by the cancel, even when its cancel fails", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  await act(async () =>
    FakeUpload.sent[0]!.upload.onprogress?.({
      lengthComputable: true,
      loaded: 50,
      total: 100,
    } as ProgressEvent),
  );
  expect(screen.getByRole("progressbar", { name: "Envio de a.xml" })).toBeTruthy();
  await batch.click("Cancelar uploads pendentes");
  await batch.refuse("imports:cancel", "a.xml", new Error("Server Error"));
  await batch.settle("imports:cancel", "b.xml");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/Não foi possível cancelar todos/)).toBeTruthy();
});

it.each([
  ["the ticket", "imports:upload"],
  ["the confirmation", "imports:confirm"],
])("ignores %s answered after cancelling", async (_, late) => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  if (late === "imports:confirm") {
    await batch.settle("imports:upload", "a.xml", ticket);
    await act(async () => FakeUpload.sent[0]!.finish());
  }
  await batch.click("Cancelar uploads pendentes");
  if (late === "imports:upload") {
    await batch.settle("imports:cancel", "a.xml");
    await batch.settle(late, "a.xml", ticket);
  } else {
    // The server ran A's confirmation before its cancel: A was accepted and keeps that state.
    await batch.settle(late, "a.xml", { operationId: "op", reused: false });
    await batch.refuse("imports:cancel", "a.xml", accepted());
  }
  await batch.settle("imports:cancel", "b.xml");
  expect(batch.sentFiles()).toEqual(late === "imports:upload" ? [] : ["a.xml"]);
  expect(batch.calls()).not.toContain("imports:upload b.xml");
  expect(
    screen.getByText(
      late === "imports:upload"
        ? "2 envios cancelados; esses arquivos não serão processados."
        : "1 envio cancelado; esse arquivo não será processado. 1 arquivo já tinha sido aceito para processamento e segue normalmente.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a file the server already accepted and cancels only the rest", async () => {
  const batch = await twoFileBatch();
  await batch.click("Cancelar uploads pendentes");
  await batch.refuse("imports:cancel", "a.xml", accepted());
  await batch.settle("imports:cancel", "b.xml");
  expect(
    screen.getByText(
      "1 envio cancelado; esse arquivo não será processado. 1 arquivo já tinha sido aceito para processamento e segue normalmente.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not announce a cancellation when every pending file was already accepted", async () => {
  const batch = await twoFileBatch();
  await batch.click("Cancelar uploads pendentes");
  await batch.refuse("imports:cancel", "a.xml", accepted());
  await batch.refuse("imports:cancel", "b.xml", accepted());
  expect(
    screen.getByText(
      "Nada foi cancelado: 2 arquivos já tinham sido aceitos para processamento e seguem normalmente.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/cancelados?;/)).toBeNull();
});

it("resumes in a new run after a partial cancel without reviving the cancelled one", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  // A's ticket is still on its way; the server refuses B's cancellation.
  await batch.click("Cancelar uploads pendentes");
  await batch.settle("imports:cancel", "a.xml");
  await batch.refuse("imports:cancel", "b.xml", new Error("Server Error"));
  expect(screen.getByText(/Não foi possível cancelar todos/)).toBeTruthy();
  expect(screen.getByText("1 envio cancelado; esse arquivo não será processado.")).toBeTruthy();
  state.result.files = [batch.remote("a.xml", "expired"), batch.remote("b.xml", "reserved")];
  batch.view.rerender(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "b.xml", ticket);
  // The cancelled run's ticket arrives now: it neither sends A nor ends the new run.
  await batch.settle("imports:upload", "a.xml", ticket);
  expect(screen.getByRole("button", { name: "Enviando…" })).toBeTruthy();
  expect(batch.sentFiles()).toEqual(["b.xml"]);
  await act(async () => FakeUpload.sent[0]!.finish());
  await batch.settle("imports:confirm", "b.xml", { operationId: "op", reused: false });
  expect(batch.calls().filter((call) => /upload b|confirm/.test(call))).toEqual([
    "imports:upload b.xml",
    "imports:confirm b.xml",
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Retomar esta importação" })).toBeTruthy();
});

it("keeps the controls blocked while the chosen files are still being read", async () => {
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  let digested!: () => void;
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: {
      digest: () =>
        new Promise<ArrayBuffer>((resolve) => {
          digested = () => resolve(new Uint8Array(32).buffer);
        }),
    },
  });
  state.result.files = [{ id: "a.xml", name: "a.xml", state: "reserved" }];
  state.mutate.mockResolvedValue(null);
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const file = new File(["<xml/>"], "a.xml", { type: "application/xml" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
  const input = () =>
    screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos") as HTMLInputElement;
  await act(async () => fireEvent.change(input(), { target: { files: [file] } }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Cancelar uploads pendentes" })),
  );
  expect(state.mutate.mock.calls).toEqual([["imports:cancel", { fileId: "a.xml" }]]);
  // No run was stopped: the reading of the files still holds the controls.
  expect(input().getAttribute("aria-disabled")).toBe("true");
  await act(async () => digested());
  expect(input().getAttribute("aria-disabled")).toBeNull();
});

/** An XML whose fake SHA-256 depends on its content: 32 bytes, each equal to its length. */
function xmlFile(name: string, content: string) {
  const file = new File([content], name, { type: "application/xml" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}
const contentHash = (content: string) =>
  new TextEncoder().encode(content).length.toString(16).padStart(2, "0").repeat(32);

it("asks again for the reserved XML after a reload and sends only the original, checked by name and hash", async () => {
  FakeUpload.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  vi.stubGlobal("crypto", {
    randomUUID: () => "intent",
    subtle: {
      digest: async (_: string, data: ArrayBuffer) =>
        new Uint8Array(32).fill(data.byteLength).buffer,
    },
  });
  const reserved = {
    id: "file",
    name: "nota.xml",
    state: "reserved",
    sha256: contentHash("<nfe/>"),
  };
  state.result.files = [reserved];
  state.query.mockResolvedValue({ files: [reserved] });
  state.mutate.mockResolvedValue(ticket);
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const item = () => screen.getByText("nota.xml", { selector: "strong" }).closest("li")!;
  const resume = () =>
    screen.getByRole("button", { name: "Retomar esta importação" }) as HTMLButtonElement;
  const reason = () => document.getElementById(resume().getAttribute("aria-describedby")!);
  const choose = (file: File) =>
    act(async () =>
      fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
        target: { files: [file] },
      }),
    );
  // Nothing local after the reload: the row and the button say which file to choose.
  expect(item().textContent).toMatch(/Selecione de novo o XML original nota\.xml/);
  expect(resume().disabled).toBe(true);
  expect(reason()!.textContent).toBe("Para retomar, selecione de novo o XML original de nota.xml.");
  // Same name, other content: not the reserved file, so still nothing to send.
  await choose(xmlFile("nota.xml", "<outra-nfe/>"));
  expect(item().textContent).toMatch(/nota\.xml escolhido tem conteúdo diferente do reservado/);
  expect(resume().disabled).toBe(true);
  // Same content, other name: not it either.
  await choose(xmlFile("outra.xml", "<nfe/>"));
  expect(resume().disabled).toBe(true);
  await act(async () => fireEvent.click(resume()));
  expect(state.mutate).not.toHaveBeenCalled();
  const original = xmlFile("nota.xml", "<nfe/>");
  await choose(original);
  expect(item().textContent).toMatch(/XML original selecionado/);
  expect(resume().disabled).toBe(false);
  expect(reason()).toBeNull();
  await act(async () => fireEvent.click(resume()));
  expect(state.mutate.mock.calls).toEqual([["imports:upload", { fileId: "file" }]]);
  expect(FakeUpload.sent.map((request) => request.body)).toEqual([original]);
});

it("confirms an uploaded file without uploading it again and names the file still missing", async () => {
  FakeUpload.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  state.result.files = [
    { id: "a", name: "a.xml", state: "uploaded", sha256: "00".repeat(32) },
    { id: "b", name: "b.xml", state: "reserved", sha256: "00".repeat(32) },
  ];
  state.query.mockImplementation(async () => ({ files: state.result.files }));
  state.mutate.mockResolvedValue({ operationId: "op", reused: false });
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  expect(screen.getByText("a.xml", { selector: "strong" }).closest("li")!.textContent).toMatch(
    /já recebeu este arquivo. “Retomar esta importação” confirma sem enviar de novo/,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retomar esta importação" })),
  );
  expect(state.mutate.mock.calls).toEqual([["imports:confirm", { fileId: "a" }]]);
  expect(FakeUpload.sent).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toBe(
    "Falta o XML original de b.xml: selecione-o de novo para enviá-lo.",
  );
});

it("gives up on an upload silent for 30 seconds, asks the server and confirms what already arrived", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const batch = await twoFileBatch();
    await batch.click("Retomar esta importação");
    await batch.settle("imports:upload", "a.xml", ticket);
    const request = FakeUpload.sent[0]!;
    await act(async () => vi.advanceTimersByTime(20_000));
    await act(async () =>
      request.upload.onprogress?.({
        lengthComputable: true,
        loaded: 50,
        total: 100,
      } as ProgressEvent),
    );
    // Slow but moving: the wait counts from the last progress, not from the start.
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(request.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Enviando…" })).toBeTruthy();
    expect(state.query).toHaveBeenCalledTimes(1);
    // The server stored A; only its answer is missing.
    state.result.files = [batch.remote("a.xml", "uploaded"), batch.remote("b.xml", "reserved")];
    await act(async () => vi.advanceTimersByTime(1));
    expect(request.aborted).toBe(true);
    expect(state.query).toHaveBeenCalledTimes(2);
    expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:confirm a.xml"]);
    await batch.settle("imports:confirm", "a.xml", { operationId: "op-a", reused: false });
    await batch.settle("imports:upload", "b.xml", ticket);
    await act(async () => FakeUpload.sent[1]!.finish());
    await batch.settle("imports:confirm", "b.xml", { operationId: "op-b", reused: false });
    // A was sent once and confirmed; the sequence went on to B.
    expect(batch.sentFiles()).toEqual(["a.xml", "b.xml"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviando…" })).toBeNull();
    // B finished: no timer is left to abort it later.
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    expect(FakeUpload.sent[1]!.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("sends a file with no answer again only when the person resumes, after asking the server", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const batch = await twoFileBatch();
    await batch.click("Retomar esta importação");
    await batch.settle("imports:upload", "a.xml", ticket);
    await act(async () => vi.advanceTimersByTime(30_000));
    // A is still only reserved: this run neither confirms nor resends it and moves on to B.
    expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:upload b.xml"]);
    await batch.settle("imports:upload", "b.xml", ticket);
    await act(async () => FakeUpload.sent[1]!.finish());
    await batch.settle("imports:confirm", "b.xml", { operationId: "op-b", reused: false });
    expect(screen.getByRole("alert").textContent).toMatch(
      /O envio de a\.xml parou sem resposta .* confere o estado de novo e só envia o que não chegou/,
    );
    state.result.files = [batch.remote("a.xml", "reserved"), batch.remote("b.xml", "queued")];
    state.query.mockClear();
    await batch.click("Retomar esta importação");
    // The new run reads the persisted state before asking for another upload of A only.
    expect(state.query).toHaveBeenCalledTimes(1);
    await batch.settle("imports:upload", "a.xml", ticket);
    expect(batch.sentFiles()).toEqual(["a.xml", "b.xml", "a.xml"]);
    expect(batch.calls().filter((call) => call.includes("b.xml"))).toEqual([
      "imports:upload b.xml",
      "imports:confirm b.xml",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the answer longer than the idle limit once every byte was handed over", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const batch = await twoFileBatch();
    await batch.click("Retomar esta importação");
    await batch.settle("imports:upload", "a.xml", ticket);
    const request = FakeUpload.sent[0]!;
    // 100% handed to the socket; a slow link may still be draining it.
    await act(async () => request.handOver());
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(request.aborted).toBe(false);
    // A 6-byte XML: one minute for the server plus one second per 8 KiB started.
    await act(async () => vi.advanceTimersByTime(999));
    expect(request.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTime(1));
    expect(request.aborted).toBe(true);
    expect(state.query).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

/** A, refused or failed, stays reserved; B is sent and confirmed; the batch shows that. */
async function afterFailingA(batch: Awaited<ReturnType<typeof twoFileBatch>>) {
  expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:upload b.xml"]);
  await batch.settle("imports:upload", "b.xml", ticket);
  await act(async () => FakeUpload.sent.at(-1)!.finish());
  await batch.settle("imports:confirm", "b.xml", { operationId: "op-b", reused: false });
  state.result.files = [batch.remote("a.xml", "reserved"), batch.remote("b.xml", "queued")];
  batch.view.rerender(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  const alert = screen.getByRole("alert").textContent!;
  expect(alert).not.toMatch(/Um ou mais arquivos não foram confirmados/);
  const resume = screen.getByRole("button", {
    name: "Retomar esta importação",
  }) as HTMLButtonElement;
  return {
    alert,
    row: screen.getByText("a.xml", { selector: "strong" }).closest("li")!.textContent!,
    resume,
    reason: document.getElementById(resume.getAttribute("aria-describedby") ?? "")?.textContent,
  };
}

it.each([
  [
    "ACCESS_REVOKED",
    409,
    /O envio de a\.xml foi recusado porque o acesso .* confere de novo; se a retomada for recusada, peça/,
  ],
  ["UPLOAD_EXPIRED", 409, /prazo do envio de a\.xml terminou .* pede um prazo novo/],
  ["UNAVAILABLE", 500, /O servidor não aceitou o envio de a\.xml agora/],
])(
  "says what to do when the upload is refused with %s, keeping the file ready",
  async (code, status, says) => {
    const batch = await twoFileBatch();
    await batch.click("Retomar esta importação");
    await batch.settle("imports:upload", "a.xml", ticket);
    await act(async () => FakeUpload.sent[0]!.refuse(status, code));
    const after = await afterFailingA(batch);
    expect(after.alert).toMatch(says);
    expect(after.row).toMatch(/XML original selecionado/);
    expect(after.resume.disabled).toBe(false);
  },
);

it.each([
  ["refused with INVALID_FILE", (request: FakeUpload) => request.refuse(400, "INVALID_FILE")],
  ["refused with FILE_TOO_LARGE", (request: FakeUpload) => request.refuse(413, "FILE_TOO_LARGE")],
  ["lost with the file no longer readable", (request: FakeUpload) => request.onerror?.()],
])("asks for the file again when its upload is %s", async (_, fail) => {
  const batch = await twoFileBatch();
  // Chrome fails to read a file changed on disk after it was chosen.
  Object.defineProperty(batch.local[0]!, "slice", {
    value: () => ({
      arrayBuffer: () => Promise.reject(new DOMException("changed", "NotReadableError")),
    }),
  });
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  await act(async () => fail(FakeUpload.sent[0]!));
  const after = await afterFailingA(batch);
  expect(after.alert).toMatch(/O conteúdo de a\.xml não confere mais .* Escolha-o de novo/);
  // The same bytes would be refused again: the chosen copy is dropped, so nothing resends them.
  expect(after.row).toMatch(/Selecione de novo o XML original a\.xml/);
  expect(after.resume.disabled).toBe(true);
  expect(after.reason).toBe("Para retomar, selecione de novo o XML original de a.xml.");
});

it("keeps a readable file ready after a lost connection and says the upload had no answer", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  await act(async () => FakeUpload.sent[0]!.onerror?.());
  const after = await afterFailingA(batch);
  expect(after.alert).toMatch(/O envio de a\.xml parou sem resposta no prazo ou perdeu a conexão/);
  expect(after.row).toMatch(/XML original selecionado/);
  expect(after.resume.disabled).toBe(false);
});

it.each([
  [
    "UPLOAD_EXPIRED",
    /As reservas de a\.xml e b\.xml venceram\. Inicie uma “Nova importação” e escolha os arquivos de novo/,
  ],
  [
    "SCOPE_DENIED",
    /Os envios de a\.xml e b\.xml foram recusados porque o acesso a esta empresa mudou\. .* se a retomada for recusada, peça/,
  ],
])(
  "says once, for both files, what to do when the ticket is refused with %s",
  async (code, says) => {
    const batch = await twoFileBatch();
    await batch.click("Retomar esta importação");
    await batch.refuse("imports:upload", "a.xml", new ConvexError({ code }));
    await batch.refuse("imports:upload", "b.xml", new ConvexError({ code }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(says);
    expect(alert.querySelectorAll("p")).toHaveLength(0);
    expect(batch.sentFiles()).toEqual([]);
    // A lapsed reservation is final: the rows stop offering an upload that would fail again.
    const rows = ["a.xml", "b.xml"].map(
      (name) => screen.getByText(name, { selector: "strong" }).closest("li")!.textContent,
    );
    const resume = screen.getByRole("button", {
      name: "Retomar esta importação",
    }) as HTMLButtonElement;
    if (code === "UPLOAD_EXPIRED") {
      for (const row of rows) {
        expect(row).toMatch(/não aceita mais o envio nem a confirmação/);
        expect(row).not.toMatch(/XML original selecionado/);
      }
      expect(resume.disabled).toBe(true);
    } else {
      for (const row of rows) expect(row).toMatch(/XML original selecionado/);
      expect(resume.disabled).toBe(false);
    }
  },
);

it("says in the plural that the upload tickets of both files lapsed", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  await act(async () => FakeUpload.sent[0]!.refuse(409, "UPLOAD_EXPIRED"));
  await batch.settle("imports:upload", "b.xml", ticket);
  await act(async () => FakeUpload.sent[1]!.refuse(409, "UPLOAD_EXPIRED"));
  expect(screen.getByRole("alert").textContent).toBe(
    "Os prazos dos envios de a.xml e b.xml terminaram antes de os arquivos chegarem. “Retomar esta importação” pede prazos novos e envia de novo.",
  );
});

it("confirms instead when an expired ticket hides an upload that already landed", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  // An earlier attempt's late upload landed after this run read the batch.
  state.result.files = [batch.remote("a.xml", "uploaded"), batch.remote("b.xml", "reserved")];
  await batch.refuse("imports:upload", "a.xml", new ConvexError({ code: "UPLOAD_EXPIRED" }));
  expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:confirm a.xml"]);
  expect(batch.sentFiles()).toEqual([]);
});

it("keeps going when the state cannot be read after a failed upload, and confirms nothing", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  state.query.mockRejectedValueOnce(new Error("Server Error"));
  await act(async () => FakeUpload.sent[0]!.onerror?.());
  expect(batch.calls()).toEqual(["imports:upload a.xml", "imports:upload b.xml"]);
  await batch.settle("imports:upload", "b.xml", ticket);
  await act(async () => FakeUpload.sent[1]!.finish());
  await batch.settle("imports:confirm", "b.xml", { operationId: "op-b", reused: false });
  expect(batch.calls()).not.toContain("imports:confirm a.xml");
  expect(screen.getByRole("alert").textContent).toMatch(
    /Um ou mais arquivos não foram confirmados/,
  );
  expect(
    (screen.getByRole("button", { name: "Retomar esta importação" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("does not confirm or go on when the cancel arrives during the re-read", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  let reread!: (value: unknown) => void;
  state.query.mockImplementationOnce(() => new Promise((resolve) => (reread = resolve)));
  await act(async () => FakeUpload.sent[0]!.onerror?.());
  await batch.click("Cancelar uploads pendentes");
  await batch.settle("imports:cancel", "a.xml");
  await batch.settle("imports:cancel", "b.xml");
  // The re-read answers late, even saying A arrived: the cancelled run does nothing with it.
  await act(async () =>
    reread({ files: [batch.remote("a.xml", "uploaded"), batch.remote("b.xml", "reserved")] }),
  );
  expect(batch.calls()).toEqual([
    "imports:upload a.xml",
    "imports:cancel a.xml",
    "imports:cancel b.xml",
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("hides the per-file “Retomar … envia” step while the run is sending", async () => {
  const batch = await twoFileBatch();
  const item = () => screen.getByText("b.xml", { selector: "strong" }).closest("li")!;
  expect(item().textContent).toMatch(/XML original selecionado/);
  await batch.click("Retomar esta importação");
  expect(item().textContent).not.toMatch(/XML original selecionado/);
});

it.each([
  [
    "UPLOAD_EXPIRED",
    /^A reserva de a\.xml venceu\. Inicie uma “Nova importação” e escolha o arquivo de novo\.$/,
    false,
  ],
  [
    "INVALID_FILE",
    /^O original guardado de a\.xml não confere com a reserva e não pode ser confirmado\./,
    false,
  ],
  ["SCOPE_DENIED", /^O envio de a\.xml foi recusado porque o acesso a esta empresa mudou\./, true],
])("says what to do when the confirmation is refused with %s", async (code, says, again) => {
  FakeUpload.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  state.result.files = [{ id: "a", name: "a.xml", state: "uploaded", sha256: "00".repeat(32) }];
  state.query.mockImplementation(async () => ({ files: state.result.files }));
  state.mutate.mockRejectedValue(new ConvexError({ code }));
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retomar esta importação" })),
  );
  expect(state.mutate.mock.calls).toEqual([["imports:confirm", { fileId: "a" }]]);
  expect(screen.getByRole("alert").textContent).toMatch(says);
  const row = screen.getByText("a.xml", { selector: "strong" }).closest("li")!.textContent;
  const resume = screen.getByRole("button", {
    name: "Retomar esta importação",
  }) as HTMLButtonElement;
  // Only a refusal that may change (access) keeps offering the confirmation.
  expect(row).toMatch(
    again ? /confirma sem enviar de novo/ : /não aceita mais o envio nem a confirmação/,
  );
  expect(resume.disabled).toBe(!again);
  if (!again)
    expect(document.getElementById(resume.getAttribute("aria-describedby")!)!.textContent).toBe(
      "O servidor não aceita mais o envio nem a confirmação dos arquivos pendentes. Use “Nova importação” para enviá-los de novo.",
    );
  expect(FakeUpload.sent).toHaveLength(0);
});

it("leaves a confirmation refused for another reason to the usual message", async () => {
  state.result.files = [{ id: "a", name: "a.xml", state: "uploaded", sha256: "00".repeat(32) }];
  state.query.mockImplementation(async () => ({ files: state.result.files }));
  // Never sent by `getFile` at the confirmation: not read as a change of access.
  state.mutate.mockRejectedValue(new ConvexError({ code: "ACCESS_REVOKED" }));
  render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retomar esta importação" })),
  );
  expect(screen.getByRole("alert").textContent).toMatch(
    /Um ou mais arquivos não foram confirmados/,
  );
});

it("names the file whose reservation no longer takes an upload after the re-read", async () => {
  const batch = await twoFileBatch();
  await batch.click("Retomar esta importação");
  await batch.settle("imports:upload", "a.xml", ticket);
  // Cancelled or expired elsewhere while A was on its way.
  state.result.files = [batch.remote("a.xml", "expired"), batch.remote("b.xml", "reserved")];
  await act(async () => FakeUpload.sent[0]!.onerror?.());
  await batch.settle("imports:upload", "b.xml", ticket);
  await act(async () => FakeUpload.sent[1]!.finish());
  await batch.settle("imports:confirm", "b.xml", { operationId: "op-b", reused: false });
  expect(screen.getByRole("alert").textContent).toBe(
    "A reserva de a.xml já não aceita envio; o estado atual está na linha do arquivo.",
  );
  expect(batch.calls()).not.toContain("imports:confirm a.xml");
});

describe("importar o XML de exemplo (#510)", () => {
  // The public file itself, from the root or from `apps/console` (its `test` script): the
  // reservation must declare exactly its bytes.
  const file = "public/examples/nfe-demonstracao.xml";
  const example = readFileSync(existsSync(file) ? file : join("apps/console", file));
  const exampleHash = createHash("sha256").update(example).digest("hex");
  const button = () =>
    screen.queryByRole("button", { name: "Importar o XML de exemplo" }) as HTMLButtonElement | null;
  /** An answer to the example request: the real file unless a body is given. */
  const answer = (
    body: BlobPart = example,
    { ok = true, status = 200, headers = {} as Record<string, string> } = {},
  ) => ({ ok, status, headers: new Headers(headers), blob: async () => new Blob([body]) });
  const served = () => vi.fn(async () => answer());
  const reserves = () => state.mutate.mock.calls.filter(([name]) => name === "imports:reserve");
  const blocked = (action: HTMLButtonElement) => action.getAttribute("aria-disabled") === "true";
  const reason = (action: HTMLButtonElement) =>
    document.getElementById(action.getAttribute("aria-describedby")!)!.textContent;
  beforeEach(() => {
    // A fresh import: no batch open in the URL.
    state.batch = undefined;
    state.navigate.mockResolvedValue(undefined);
    state.query.mockResolvedValue({ files: [] });
    state.mutate.mockImplementation(async (name: string) =>
      name === "imports:reserve" ? { importId: "new-batch", fileIds: [], reused: false } : null,
    );
  });

  it.each([
    ["a demonstração, para quem envia XML", true, true, true],
    ["uma empresa declarada", false, true, false],
    ["quem só acompanha (Leitura, Desenvolvedor)", true, false, false],
  ] as const)("oferece a ação só para %s", (_, demonstration, writable, offered) => {
    render(
      <ImportFlow
        scope={scope}
        writable={writable}
        demonstration={demonstration}
        organizationSlug="organization"
      />,
    );
    expect(!!button()).toBe(offered);
    // The download stays as the secondary way wherever files can be sent.
    expect(!!screen.queryByRole("link", { name: /XML sintético/ })).toBe(writable);
  });

  it("não oferece a ação num lote de integração", () => {
    state.batch = "old-batch";
    state.result.origin = { kind: "integration", integration: "ERP" };
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    expect(button()).toBeNull();
    expect(screen.getByRole("link", { name: /XML sintético/ })).toBeTruthy();
  });

  it.each([
    [
      "ready",
      "Uma importação está aberta. Para importar o exemplo de novo, use “Nova importação”.",
    ],
    ["missing", "Esta importação não está disponível; escolha outra ou inicie uma nova."],
  ] as const)("com um lote %s na URL, a ação espera e diz por quê", (selected, says) => {
    state.batch = "old-batch";
    state.selected = selected;
    const fetch = served();
    vi.stubGlobal("fetch", fetch);
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    const action = button()!;
    expect(blocked(action)).toBe(true);
    expect(reason(action)).toBe(says);
    fireEvent.click(action);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserva uma vez o arquivo público, com o SHA-256 dos seus bytes, mesmo com clique duplo", async () => {
    const fetch = served(),
      timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetch);
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    await act(async () => {
      fireEvent.click(button()!);
      fireEvent.click(button()!);
    });
    await waitFor(() => expect(state.query).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
    // With a 15 s deadline: a hung request ends in the failure path, never as a spinner forever.
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetch).toHaveBeenCalledWith("/examples/nfe-demonstracao.xml", {
      signal: timeout.mock.results[0]!.value,
    });
    expect(reserves()).toEqual([
      [
        "imports:reserve",
        {
          ...scope,
          key: expect.any(String),
          files: [{ name: "nfe-demonstracao.xml", size: example.length, sha256: exampleHash }],
        },
      ],
    ]);
    // The same path as a chosen file: the batch opens and its outcome comes from the server.
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { company: "company", batch: "new-batch" } }),
    );
    expect(state.query).toHaveBeenCalledWith(expect.anything(), {
      importId: "new-batch",
      expectedScope: scope,
      includeResults: false,
    });
    expect(screen.getByText("nfe-demonstracao.xml")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("anuncia cada falha ao carregar o exemplo, sem reservar e sem tirar o foco da ação", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      // A valid file behind an error status: the status alone refuses it.
      .mockResolvedValueOnce(answer(example, { ok: false, status: 503 }))
      // A 200 that is not the file (an HTML page), one past 2 MiB, one declaring more than 2 MiB.
      .mockResolvedValueOnce(answer("<!doctype html><html></html>"))
      .mockResolvedValueOnce(answer(`<?xml version="1.0"?>${" ".repeat(2 * 1024 * 1024)}`))
      .mockResolvedValueOnce(answer(example, { headers: { "Content-Length": "3000000" } }))
      .mockImplementation(served());
    vi.stubGlobal("fetch", fetch);
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    const action = button()!;
    action.focus();
    let alert: HTMLElement | null = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await act(async () => fireEvent.click(action));
      // Reading the body ends outside the microtask queue (Blob, digest): wait for the attempt to
      // end, never for a fixed number of turns, or a loaded machine clicks while it still runs.
      await waitFor(() => expect(action.getAttribute("aria-busy")).toBeNull());
      // Each failure is a new alert node, so assistive technology announces it again.
      const again = screen.getByRole("alert");
      // No answer (network, timeout, error status) asks to check the connection; an answer
      // that is not the file points to the download instead.
      expect(again.textContent).toBe(
        attempt <= 3
          ? "Não foi possível carregar o XML de exemplo. Nada foi enviado; confira a conexão e use “Importar o XML de exemplo” de novo."
          : "O arquivo de exemplo não veio como esperado. Nada foi enviado; baixe o XML sintético pelo link acima.",
      );
      expect(again).not.toBe(alert);
      alert = again;
      // The same button, still focused: no second "Tentar de novo" appears and vanishes.
      expect(button()).toBe(action);
      expect(document.activeElement).toBe(action);
    }
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    expect(reserves()).toEqual([]);
    await act(async () => fireEvent.click(action));
    await waitFor(() => expect(reserves()).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(action);
  });

  it("perdida a resposta da reserva, cada conjunto de arquivos volta à sua intenção (A, B, A)", async () => {
    const keys = ["first", "second"],
      subtle = globalThis.crypto.subtle;
    vi.stubGlobal("crypto", { randomUUID: () => keys.shift() ?? "later", subtle });
    // The server may have stored the reservation; the answer never arrives.
    state.mutate.mockRejectedValue(new Error("Connection lost"));
    render(<ImportFlow scope={scope} writable organizationSlug="organization" />);
    const send = async (file: File, count: number) => {
      await act(async () =>
        fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
          target: { files: [file] },
        }),
      );
      const submit = () =>
        screen.getByRole("button", { name: "Importar arquivos" }) as HTMLButtonElement;
      await waitFor(() => expect(submit().disabled).toBe(false));
      await act(async () => fireEvent.click(submit()));
      await waitFor(() => expect(reserves()).toHaveLength(count));
    };
    await send(xmlFile("a.xml", "<NFe>a</NFe>"), 1);
    await send(xmlFile("b.xml", "<NFe>bb</NFe>"), 2);
    await send(xmlFile("b.xml", "<NFe>bb</NFe>"), 3);
    await send(xmlFile("a.xml", "<NFe>a</NFe>"), 4);
    expect(reserves().map(([, args]) => (args as { key: string }).key)).toEqual([
      "first",
      "second",
      "second",
      "first",
    ]);
  });

  it("depois de uma falha da própria reserva, a ação aponta para “Importar arquivos”", async () => {
    state.mutate.mockRejectedValue(new Error("Connection lost"));
    vi.stubGlobal("fetch", served());
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    await act(async () => fireEvent.click(button()!));
    await waitFor(() => expect(reserves()).toHaveLength(1));
    // The example is the chosen file now, not something the person picked.
    await waitFor(() =>
      expect(reason(button()!)).toBe(
        "O exemplo já está escolhido. Use “Importar arquivos” para tentar o exemplo de novo.",
      ),
    );
  });

  it.each([
    ["um lote aberto na URL", "ready"],
    ["um lote ainda carregando na URL", "loading"],
  ] as const)("busca em andamento e %s: o exemplo não reserva nada", async (_, selected) => {
    let deliver!: (value: ReturnType<typeof answer>) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (deliver = resolve))),
    );
    const view = render(
      <ImportFlow scope={scope} writable demonstration organizationSlug="organization" />,
    );
    await act(async () => fireEvent.click(button()!));
    // While the file is on its way, the button says it is busy and only it shows the wait.
    expect(button()!.getAttribute("aria-busy")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Lendo arquivos…" }).getAttribute("aria-busy"),
    ).toBeNull();
    // Another batch opens (browser history, another tab's link) before the file arrives.
    state.batch = "old-batch";
    state.selected = selected;
    view.rerender(
      <ImportFlow scope={scope} writable demonstration organizationSlug="organization" />,
    );
    await act(async () => deliver(answer()));
    // The attempt ends only after the body is read and hashed, outside the microtask queue: wait
    // for its end. Without the recheck it would reserve before ending, so this proves the refusal.
    await waitFor(() => expect(button()!.getAttribute("aria-busy")).toBeNull());
    expect(reserves()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("um IDEMPOTENCY_CONFLICT pede uma nova importação, também na ação do exemplo", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "IDEMPOTENCY_CONFLICT" }));
    vi.stubGlobal("fetch", served());
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    await act(async () => fireEvent.click(button()!));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Esta tentativa já foi registrada com outros arquivos. Use “Nova importação” e escolha os arquivos de novo.",
      ),
    );
    // Sending the same files again would be refused again: the example points there too.
    expect(reason(button()!)).toBe(
      "Esta tentativa já foi registrada com outros arquivos. Use “Nova importação” para importar o exemplo.",
    );
  });

  it("não substitui arquivos escolhidos: a ação espera, com o motivo", async () => {
    const fetch = served();
    vi.stubGlobal("fetch", fetch);
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
        target: { files: [xmlFile("minha.xml", "<NFe/>")] },
      }),
    );
    await waitFor(() => expect(screen.getByText("minha.xml")).toBeTruthy());
    const action = button()!;
    expect(blocked(action)).toBe(true);
    expect(reason(action)).toBe(
      "Há arquivos escolhidos. Importe-os ou use “Nova importação” para importar o exemplo.",
    );
    fireEvent.click(action);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("minha.xml")).toBeTruthy();
  });

  it("depois de “Nova importação”, o exemplo vai sob uma intenção nova", async () => {
    vi.stubGlobal("fetch", served());
    const keys = ["first", "second"],
      subtle = globalThis.crypto.subtle;
    vi.stubGlobal("crypto", { randomUUID: () => keys.shift() ?? "later", subtle });
    render(<ImportFlow scope={scope} writable demonstration organizationSlug="organization" />);
    await act(async () => fireEvent.click(button()!));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Nova importação" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(reserves()).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Nova importação" })));
    await act(async () => fireEvent.click(button()!));
    await waitFor(() => expect(reserves()).toHaveLength(2));
    expect(reserves().map(([, args]) => (args as { key: string }).key)).toEqual([
      "first",
      "second",
    ]);
  });
});
