// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import {
  CompanyContext,
  RoleNotice,
  integrationRecordMessage,
  rememberedCompany,
} from "./company-context";

type Company = { id: string; name: string; cnpj: string };
const state = vi.hoisted(() => ({
  companies: [] as Company[],
  loading: false,
  /** consoleCompany.context answers by id; absent ids are inaccessible (`null`). */
  access: {} as Record<
    string,
    { canRead: boolean; canWrite: boolean; canManage: boolean } | undefined
  >,
  asked: [] as string[],
  /** consoleCompany.sole still on its way (the list has its own `loading`). */
  solePending: false,
  askedSole: 0,
  /** deployment.current; `undefined` while the server has not answered. */
  deployment: undefined as { environment: string; fiscalProduction: boolean } | undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({
    results: state.loading ? [] : state.companies,
    status: state.loading ? "LoadingFirstPage" : "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (getFunctionName(fn) === "deployment:current") return state.deployment;
    if (args !== "skip" && getFunctionName(fn) === "consoleCompany:sole") {
      state.askedSole++;
      if (state.solePending) return undefined;
      // The server's answer: the only company the member can open, else nothing.
      const open = state.companies.filter((row) => state.access[row.id]);
      return open.length === 1
        ? { ...open[0]!, kind: "declared", ...state.access[open[0]!.id] }
        : null;
    }
    if (args === "skip" || getFunctionName(fn) !== "consoleCompany:context") return undefined;
    const id = (args as { company: string }).company;
    state.asked.push(id);
    const company = state.companies.find((row) => row.id === id);
    const access = state.access[id];
    return company && access ? { ...company, kind: "declared", ...access } : null;
  },
}));

const manager = {
  id: "org",
  slug: "equipe",
  role: "owner",
  capabilities: { manageOrganization: true },
} as unknown as Parameters<typeof CompanyContext>[0]["org"];
const role = (value: string, manage = false) =>
  ({ ...manager, role: value, capabilities: { manageOrganization: manage } }) as typeof manager;
const full = { canRead: true, canWrite: true, canManage: true };
const a = { id: "a", name: "Empresa A", cnpj: "11222333000181" };
const b = { id: "b", name: "Empresa B", cnpj: "11444777000161" };

function view(org = manager, selected = "", onSelect = vi.fn()) {
  render(
    <CompanyContext
      org={org}
      contextKey="k"
      selected={selected}
      onSelect={onSelect}
      id="empresa"
      label="Empresa"
    >
      {(company, scope) => (
        <p>
          Trabalhando em {company.name} ({scope.companyId}, {scope.environment})
        </p>
      )}
    </CompanyContext>,
  );
  return onSelect;
}
beforeEach(() => {
  localStorage.clear();
  state.companies = [a, b];
  state.loading = false;
  state.access = { a: full, b: full };
  state.asked = [];
  state.solePending = false;
  state.askedSole = 0;
  state.deployment = { environment: "sandbox", fiscalProduction: false };
});
afterEach(cleanup);

it("seleciona sozinha a única empresa e a lembra por organização", () => {
  state.companies = [a];
  view();
  expect(screen.getByText("Trabalhando em Empresa A (a, sandbox)")).toBeTruthy();
  expect(rememberedCompany("org")).toBe("a");
  expect(rememberedCompany("outra")).toBe("");
});

it("pergunta a única empresa ao servidor junto com a lista, sem esperar por ela", () => {
  state.companies = [a];
  state.loading = true;
  view();
  expect(screen.getByText("Trabalhando em Empresa A (a, sandbox)")).toBeTruthy();
  expect(rememberedCompany("org")).toBe("a");
  // The confirmation of the same company is asked at once, with the arguments the remembered
  // choice uses next: the subscription carries on.
  expect(state.asked).toContain("a");
});

it("com empresa lembrada ou escolhida, ou com a lista já carregada, não pergunta pela única", () => {
  state.loading = true;
  localStorage.setItem("fnfe:console-company:org", "b");
  view();
  expect(state.askedSole).toBe(0);
  cleanup();
  localStorage.clear();
  view(manager, "a");
  expect(state.askedSole).toBe(0);
  cleanup();
  // The list already in the cache says by itself whether there is a single company.
  localStorage.clear();
  state.loading = false;
  view();
  expect(state.askedSole).toBe(0);
  expect(screen.getByText("Escolha a empresa acima.")).toBeTruthy();
});

it("a resposta da única empresa não segura a tela depois da lista", () => {
  state.loading = true;
  state.solePending = true;
  view();
  expect(state.askedSole).toBeGreaterThan(0);
  expect((screen.getByLabelText("Empresa") as HTMLSelectElement).disabled).toBe(true);
  cleanup();
  // The list answered with two companies: the person chooses, without waiting for `sole`.
  state.loading = false;
  view();
  expect(screen.getByText("Escolha a empresa acima.")).toBeTruthy();
});

it("solta a consulta da única empresa quando a lista responde", () => {
  state.companies = [a];
  state.access = { a: full };
  state.loading = true;
  state.solePending = true;
  const screenFor = () => (
    <CompanyContext
      org={manager}
      contextKey="k"
      selected=""
      onSelect={vi.fn()}
      id="empresa"
      label="Empresa"
    >
      {(company) => <p>Trabalhando em {company.name}</p>}
    </CompanyContext>
  );
  const { rerender } = render(screenFor());
  expect(state.askedSole).toBeGreaterThan(0);
  const asked = state.askedSole;
  // The list answered on the same screen: it says by itself that there is a single company.
  state.loading = false;
  state.solePending = false;
  rerender(screenFor());
  expect(state.askedSole).toBe(asked);
  expect(screen.getByText(`Trabalhando em ${a.name}`)).toBeTruthy();
});

it("abre na empresa lembrada e troca pela escolha da pessoa", () => {
  localStorage.setItem("fnfe:console-company:org", "b");
  const onSelect = view();
  expect(screen.getByText("Trabalhando em Empresa B (b, sandbox)")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Empresa"), { target: { value: "a" } });
  expect(onSelect).toHaveBeenCalledWith("a");
});

it("a URL prevalece sobre a empresa lembrada", () => {
  localStorage.setItem("fnfe:console-company:org", "b");
  view(manager, "a");
  expect(screen.getByText("Trabalhando em Empresa A (a, sandbox)")).toBeTruthy();
});

it("explica a empresa da URL sem acesso e não a lembra", () => {
  state.access = { a: full };
  view(role("operator"), "b");
  expect(screen.getByRole("heading", { name: "Empresa indisponível" })).toBeTruthy();
  expect(screen.getByText(/Peça a um proprietário ou administrador/)).toBeTruthy();
  expect(screen.queryByText(/Trabalhando em/)).toBeNull();
  expect(rememberedCompany("org")).toBe("");
});

it("esquece a empresa lembrada que deixou de ser acessível", () => {
  localStorage.setItem("fnfe:console-company:org", "b");
  state.access = { a: full };
  view(role("operator"));
  expect(rememberedCompany("org")).toBe("");
  expect(screen.queryByRole("heading", { name: "Empresa indisponível" })).toBeNull();
});

it("sem empresas: gestor vê os primeiros passos; os demais, a quem pedir acesso", () => {
  state.companies = [];
  view();
  expect(screen.getByRole("heading", { name: "Comece por uma empresa" })).toBeTruthy();
  cleanup();
  view(role("viewer"));
  expect(screen.getByRole("heading", { name: "Nenhuma empresa liberada para você" })).toBeTruthy();
  expect(screen.getByText(/O acesso às empresas é dado por pessoa/)).toBeTruthy();
});

it("gestor recebe o atalho para gerenciar o acesso à empresa", () => {
  view(manager, "a");
  expect(screen.getByRole("link", { name: "Gerenciar quem acessa esta empresa" })).toBeTruthy();
  cleanup();
  view(role("operator"), "a");
  expect(screen.queryByRole("link", { name: "Gerenciar quem acessa esta empresa" })).toBeNull();
});

it("developer não lê o trabalho fiscal pelo console e sabe o papel necessário", () => {
  state.access = { a: { canRead: false, canWrite: false, canManage: false } };
  view(role("developer"), "a");
  expect(screen.queryByText(/Trabalhando em/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toMatch(/Leitura, Operador, Administrador/);
});

it("leitura diz qual papel a escrita exige", () => {
  render(
    <RoleNotice
      org={role("viewer")}
      company={
        { ...a, kind: "declared", canRead: true, canWrite: false, canManage: false } as never
      }
      action="enviar XML"
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(
    /Leitura: você pode consultar, mas enviar XML exige papel de Operador/,
  );
  cleanup();
  const { container } = render(
    <RoleNotice
      org={manager}
      company={{ ...a, kind: "declared", ...full } as never}
      action="enviar XML"
    />,
  );
  expect(container.textContent).toBe("");
});

it("aguarda as empresas antes de orientar", () => {
  state.loading = true;
  view();
  expect((screen.getByLabelText("Empresa") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toMatch(/Carregando empresas/);
});

it("explica que o registro de integração é gerido pela integração", () => {
  expect(
    integrationRecordMessage(
      new ConvexError({ code: "INTEGRATION_RECORD", integration: "ERP Jatobá" }),
    ),
  ).toMatch(/^Criado pela integração ERP Jatobá; gerencie pela integração\./);
  expect(
    integrationRecordMessage(new ConvexError({ code: "INTEGRATION_RECORD", integration: null })),
  ).toMatch(/^Criado por uma integração/);
  expect(integrationRecordMessage(new ConvexError({ code: "NOT_FOUND" }))).toBeUndefined();
  expect(integrationRecordMessage(new Error("x"))).toBeUndefined();
});

it("o escopo das telas fiscais vem do ambiente do deployment", () => {
  state.companies = [a];
  state.deployment = { environment: "production", fiscalProduction: true };
  view();
  expect(screen.getByText("Trabalhando em Empresa A (a, production)")).toBeTruthy();
  cleanup();
  // Validation target with production data and no issuance: still the production scope.
  state.deployment = { environment: "production", fiscalProduction: false };
  view();
  expect(screen.getByText("Trabalhando em Empresa A (a, production)")).toBeTruthy();
});

it("sem a resposta do deployment, espera: nenhuma tela parte com o ambiente da dica do build", () => {
  state.companies = [a];
  state.deployment = undefined;
  view();
  expect(screen.queryByText(/Trabalhando em/)).toBeNull();
  expect(screen.getByText("Carregando empresas disponíveis…")).toBeTruthy();
  cleanup();
  state.deployment = { environment: "sandbox", fiscalProduction: false };
  view();
  expect(screen.getByText("Trabalhando em Empresa A (a, sandbox)")).toBeTruthy();
});
