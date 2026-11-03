// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { CompanyGrants, type GrantSelection } from "./project-grants";

const state = vi.hoisted(() => ({
  existing: undefined as { version: number; active: boolean } | null | undefined,
  offered: undefined as string[] | undefined,
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({
    results: [{ id: "c1", name: "Empresa sintética" }],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(fn) === "projects:offeredEnvironments" ? state.offered : state.existing,
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
  useAction: () => vi.fn(),
}));
type Props = Parameters<typeof CompanyGrants>[0];
const org = { id: "org", slug: "org" } as unknown as Props["org"];
const project = {
  id: "p1",
  state: "active",
  deploymentEnvironment: "sandbox",
  grantableScopes: ["companies:read", "documents:read", "documents:import", "webhooks:manage"],
} as unknown as Props["project"];
const saved = {
  companyId: "c1",
  name: "Empresa sintética",
  scopes: ["documents:read"],
  environments: ["sandbox"],
  version: 3,
} as unknown as Props["grants"][number];
const selection: GrantSelection = {
  companyId: "",
  select: vi.fn(),
  saved: "",
  setSaved: vi.fn(),
};
afterEach(() => {
  cleanup();
  state.existing = undefined;
  state.offered = undefined;
  state.mutate.mockReset();
});
const save = () => screen.getByRole("button", { name: "Salvar concessão" });
const checked = (name: string | RegExp) =>
  (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;

it("pré-seleciona a única empresa e explica por que ainda não pode salvar", () => {
  render(
    <CompanyGrants org={org} contextKey="k" project={project} grants={[]} selection={selection} />,
  );
  expect((screen.getByLabelText("Empresa") as HTMLSelectElement).value).toBe("c1");
  expect(save()).toHaveProperty("disabled", true);
  expect(save().getAttribute("aria-describedby")).toBe("grant-blocker");
  expect(screen.getByText("Conferindo a concessão atual desta empresa…")).toBeTruthy();
});

it("não salva padrões sobre uma concessão fora da lista e reabre com os valores salvos", () => {
  state.existing = { version: 3, active: true };
  const view = render(
    <CompanyGrants org={org} contextKey="k" project={project} grants={[]} selection={selection} />,
  );
  expect(save()).toHaveProperty("disabled", true);
  expect(screen.getByText(/Carregue mais concessões/)).toBeTruthy();
  fireEvent.submit(save().closest("form")!);
  expect(state.mutate).not.toHaveBeenCalled();
  // "Carregar mais" trouxe a concessão: o formulário passa a refletir o que foi salvo.
  view.rerender(
    <CompanyGrants
      org={org}
      contextKey="k"
      project={project}
      grants={[saved]}
      selection={selection}
    />,
  );
  expect(checked(/^Consultar documentos/)).toBe(true);
  expect(checked(/^Listar empresas concedidas/)).toBe(false);
  expect(checked(/^Importar XML/)).toBe(false);
  expect(save()).toHaveProperty("disabled", false);
  expect(screen.queryByRole("button", { name: "Editar acesso a Empresa sintética" })).toBeTruthy();
});

it("começa uma concessão nova com documentos, webhooks e empresas, agrupados por intenção", () => {
  state.existing = null;
  render(
    <CompanyGrants org={org} contextKey="k" project={project} grants={[]} selection={selection} />,
  );
  expect(checked("Importar e consultar documentos")).toBe(true);
  expect(checked("Webhooks")).toBe(true);
  expect(checked(/^Importar XML documents:import/)).toBe(true);
  // Produção fica indisponível enquanto o deployment atende só sandbox.
  expect((screen.getByRole("checkbox", { name: /^Produção/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
  expect(save()).toHaveProperty("disabled", false);
});

it("confirma a remoção de acesso em diálogo antes de chamar o servidor", () => {
  state.existing = { version: 3, active: true };
  render(
    <CompanyGrants
      org={org}
      contextKey="k"
      project={project}
      grants={[saved]}
      selection={selection}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remover acesso a Empresa sintética" }));
  expect(
    screen.getByRole("alertdialog", { name: "Remover o acesso a Empresa sintética?" }),
  ).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Manter acesso" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remover acesso a Empresa sintética" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar remoção" }));
  expect(state.mutate).toHaveBeenCalledWith(
    "projects:revokeCompany",
    expect.objectContaining({ companyId: "c1" }),
  );
});

it("libera Produção na concessão da empresa com a captura fiscal ativada", () => {
  state.existing = null;
  render(
    <CompanyGrants org={org} contextKey="k" project={project} grants={[]} selection={selection} />,
  );
  expect(screen.getByRole("checkbox", { name: /Produção/ })).toHaveProperty("disabled", true);
  cleanup();
  state.offered = ["sandbox", "production"];
  render(
    <CompanyGrants org={org} contextKey="k" project={project} grants={[]} selection={selection} />,
  );
  const production = screen.getByRole("checkbox", { name: "Produção" });
  expect(production).toHaveProperty("disabled", false);
  expect(screen.getByText(/A empresa ativou a Captura fiscal \(Produção\)/)).toBeTruthy();
});
