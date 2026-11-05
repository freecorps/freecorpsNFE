// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Exports } from "./exports";
import { UsageErrorNotice, usageErrorMessage } from "./usage-errors";

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  mutate: vi.fn(),
  environments: undefined as string[] | undefined,
  /** The environment chosen in the shell. */
  environment: "sandbox" as "sandbox" | "production",
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ organizationSlug: "equipe" }),
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params: { organizationSlug: string };
  }) => <a href={to.replace("$organizationSlug", params.organizationSlug)}>{children}</a>,
}));
vi.mock("convex/react", () => ({
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
  usePaginatedQuery: () => ({ results: state.results, status: "Exhausted", loadMore: vi.fn() }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args !== "skip" && getFunctionName(fn) === "exports:environments"
      ? state.environments
      : undefined,
}));
const NOW = Date.UTC(2026, 9, 9, 15);
const org = (manageOrganization: boolean) =>
  ({
    id: "org",
    slug: "equipe",
    name: "Equipe Sintética",
    capabilities: { manageOrganization },
  }) as unknown as Parameters<typeof Exports>[0]["org"];
const job = (overrides: Record<string, unknown> = {}) => ({
  id: "exp1",
  selection: { kind: "organization" },
  environment: "sandbox",
  state: "running",
  createdAt: NOW - 1000,
  expiresAt: NOW + 86_400_000,
  parts: 0,
  bytes: 0,
  code: null,
  description: null,
  ...overrides,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.results = [];
  state.environments = undefined;
  state.environment = "sandbox";
  state.mutate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("exportar a organização pede confirmação e mostra o estado do pedido", async () => {
  state.mutate.mockResolvedValue(job());
  const view = render(<Exports org={org(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  expect(state.mutate).not.toHaveBeenCalled();
  const dialog = screen.getByRole("alertdialog", {
    name: "Exportar todos os documentos da organização?",
  });
  // O foco abre na opção segura.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar" }));
  // Esc volta sem exportar.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("alertdialog", { name: /Exportar todos/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  // The package is of the environment chosen in the shell; the server checks it again.
  expect(state.mutate).toHaveBeenCalledWith("exports:create", {
    organizationId: "org",
    key: expect.any(String),
    selection: { kind: "organization" },
    environment: "sandbox",
  });
  expect(screen.getByText(/Exportação solicitada e na fila/)).toBeTruthy();
  state.results = [job({ parts: 2, bytes: 10 })];
  view.rerender(<Exports org={org(true)} />);
  expect(screen.getByText("Processando: 2 partes pronta(s) até agora.")).toBeTruthy();
  state.results = [job({ state: "succeeded", parts: 2, bytes: 10 })];
  view.rerender(<Exports org={org(true)} />);
  expect(screen.getByText("Exportação pronta: 2 partes para baixar.")).toBeTruthy();
  expect(screen.getByText(/Equipe Sintética: documentos publicados até/)).toBeTruthy();
});

it("falha ao exportar mostra erro com estilo e preserva a chave para retentativa", async () => {
  state.mutate.mockRejectedValueOnce(new Error("rede")).mockResolvedValueOnce(job());
  render(<Exports org={org(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  // A recusa fica no diálogo, que continua aberto para a retentativa.
  expect(screen.getByRole("alert").className).toContain("error");
  expect(screen.getByRole("alertdialog", { name: /Exportar todos/ })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  const [first, second] = state.mutate.mock.calls.map(([, args]) => args.key);
  expect(second).toBe(first);
});

it("revogar exige confirmação e descreve o documento exportado", async () => {
  state.mutate.mockResolvedValue(null);
  state.results = [
    job({
      state: "succeeded",
      parts: 1,
      selection: { kind: "document", documentId: "doc1", companyId: "c1", projectId: "p1" },
      description: { companyName: "Padaria Sintética", model: "55", fiscalKey: "3526" },
    }),
  ];
  render(<Exports org={org(false)} />);
  expect(screen.getByRole("heading", { name: "NF-e e histórico" })).toBeTruthy();
  expect(screen.getByText("Padaria Sintética, chave 3526.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revogar exportação" }));
  expect(state.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog", { name: "Revogar esta exportação?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Revogar exportação" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
  });
  expect(state.mutate).toHaveBeenCalledWith("exports:revoke", { exportId: "exp1" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("quem não pode exportar a organização vê a explicação de quem pode", () => {
  render(<Exports org={org(false)} />);
  expect(screen.queryByRole("button", { name: "Exportar organização" })).toBeNull();
  expect(
    screen.getByText(/Exportar a organização inteira é restrito a proprietários e administradores/),
  ).toBeTruthy();
});

it("mensagem de cota muda pelo papel: gestor recebe o link, os demais falam com um gestor", () => {
  const quota = new ConvexError({ code: "QUOTA_EXCEEDED" });
  // The manager is sent to the page; the member never is, since the page is not theirs.
  expect(usageErrorMessage(quota, "manager")).toMatch(/Gestão e integração › Uso e limites/);
  expect(usageErrorMessage(quota, "member")).toMatch(/Fale com um gestor da organização/);
  expect(usageErrorMessage(quota, "member")).not.toMatch(/Uso e limites/);
  expect(usageErrorMessage(new ConvexError({ code: "OUTRO" }), "manager")).toBeUndefined();
  const { rerender } = render(<UsageErrorNotice error={quota} org={org(true)} />);
  expect(screen.getByRole("link", { name: "Abrir Uso e limites" }).getAttribute("href")).toBe(
    "/app/equipe/usage",
  );
  rerender(<UsageErrorNotice error={quota} org={org(false)} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("alert").textContent).toMatch(/Fale com um gestor/);
  // Other errors are not the notice's: nothing without a fallback.
  rerender(<UsageErrorNotice error={new ConvexError({ code: "OUTRO" })} org={org(true)} />);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("em Produção na lateral, a exportação da organização é de Produção", async () => {
  state.environments = ["sandbox", "production"];
  state.environment = "production";
  state.mutate.mockResolvedValue(job({ environment: "production" }));
  const view = render(<Exports org={org(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  // The dialog says which environment, with what it holds; no choice inside it.
  expect(screen.queryByLabelText("Ambiente")).toBeNull();
  expect(
    screen.getByText(
      /Ambiente: Produção\. Documentos reais das empresas com captura fiscal, inclusive as já desativadas\./,
    ),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  expect(state.mutate).toHaveBeenCalledWith("exports:create", {
    organizationId: "org",
    key: expect.any(String),
    selection: { kind: "organization" },
    environment: "production",
  });
  state.results = [job({ environment: "production" })];
  view.rerender(<Exports org={org(true)} />);
  expect(screen.getByText("Ambiente").nextElementSibling!.textContent).toBe("Produção");
});

it("no Sandbox na lateral, com a Produção oferecida, a exportação é do Sandbox", async () => {
  state.environments = ["sandbox", "production"];
  state.mutate.mockResolvedValue(job());
  render(<Exports org={org(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  expect(
    screen.getByText(/Ambiente: Sandbox\. Documentos importados no Sandbox e NFS-e do simulador\./),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportação" }));
  });
  expect(state.mutate).toHaveBeenCalledWith(
    "exports:create",
    expect.objectContaining({ environment: "sandbox" }),
  );
});

it("sem a captura fiscal, o diálogo não fala de ambiente", () => {
  state.environments = ["sandbox"];
  render(<Exports org={org(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Exportar organização" }));
  expect(screen.queryByLabelText("Ambiente")).toBeNull();
  expect(screen.queryByText(/Ambiente: /)).toBeNull();
});
