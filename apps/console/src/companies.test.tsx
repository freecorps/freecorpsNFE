// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { Companies } from "./companies";
import { companyErrors } from "./company-form";
import { companyTabs } from "./company-tabs";
import { Onboarding, onboardingStatus } from "./onboarding";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  company: null as Record<string, unknown> | null,
  members: [] as Array<Record<string, unknown>>,
  list: [] as Array<Record<string, unknown>>,
  onboarding: null as Record<string, unknown> | null,
  mutate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  Link: ({
    children,
    search,
    hash,
    className,
  }: {
    children: React.ReactNode;
    search?: Record<string, string>;
    hash?: string;
    className?: string;
  }) => (
    <a
      className={className}
      href={`#${hash ?? ""}${search?.aba ? `?aba=${search.aba}` : ""}`}
      data-aba={search?.aba ?? ""}
      data-company={search?.company ?? ""}
    >
      {children}
    </a>
  ),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(fn);
    if (name === "companies:get") return state.company;
    if (name === "onboarding:get") return state.onboarding;
    if (name === "nfseProfiles:get") return null;
    return undefined;
  },
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results:
      getFunctionName(fn) === "companies:members"
        ? state.members
        : getFunctionName(fn) === "companies:list"
          ? state.list
          : [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
vi.mock("./registry", () => ({
  registryLabels: { "not-consulted": "Ainda não consultada" },
  Registry: () => <section>Consulta stub</section>,
}));
vi.mock("./certificates", () => ({ Certificates: () => <section>Certificado stub</section> }));
vi.mock("./captures", () => ({ Captures: () => <section>Captura stub</section> }));
vi.mock("./nfse-profile", () => ({ NfseProfile: () => <section>Fiscal stub</section> }));

type Org = Parameters<typeof Companies>[0]["org"];
const org = (role = "owner") =>
  ({
    id: "org",
    slug: "equipe",
    role,
    capabilities: {
      manageOrganization: role === "owner" || role === "admin",
      operateDocuments: ["owner", "admin", "operator"].includes(role),
    },
  }) as unknown as Org;
const declared = (manage = true) => ({
  id: "c1",
  name: "Oficina Sintética",
  cnpj: "00000000000191",
  kind: "declared",
  version: 3,
  accessVersion: 1,
  registryStatus: "not-consulted",
  fiscalAccess: "not-configured",
  fieldSources: { name: "manual", address: "manual" },
  address: {
    street: "Rua A",
    number: "1",
    complement: "",
    district: "Centro",
    city: "Campinas",
    state: "SP",
    postalCode: "13010000",
  },
  capabilities: { read: true, manage, operateDocuments: manage },
});
const flushFrames = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
const renderCompany = (role = "owner") =>
  render(<Companies org={org(role)} contextKey="k" companyId="c1" />);

beforeEach(() => {
  state.search = {};
  state.company = declared();
  state.members = [];
  state.list = [];
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("abas da empresa", () => {
  it("mostra só as abas do papel", () => {
    const ids = (role: string, manage: boolean, kind = "declared") =>
      companyTabs(
        { kind, capabilities: { manage } } as unknown as Parameters<typeof companyTabs>[0],
        role as Org["role"],
      ).map((tab) => tab.id);
    expect(ids("owner", true)).toEqual([
      "resumo",
      "fiscal",
      "certificado",
      "consulta",
      "captura",
      "acesso",
      "historico",
    ]);
    expect(ids("developer", false)).toEqual(["resumo", "fiscal", "certificado", "consulta"]);
    expect(ids("operator", false)).toEqual([
      "resumo",
      "fiscal",
      "certificado",
      "consulta",
      "captura",
    ]);
    expect(ids("owner", true, "demonstration")).toEqual(["resumo", "acesso", "historico"]);
  });

  it("abre a aba da URL e cai no Resumo quando a aba não existe para o papel", () => {
    state.search = { aba: "fiscal" };
    renderCompany();
    const fiscal = screen.getByRole("tab", { name: "Fiscal" });
    expect(fiscal.getAttribute("aria-selected")).toBe("true");
    expect(fiscal.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Resumo" }).tabIndex).toBe(-1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(fiscal.id);
    // Every aria-controls points at an element that exists.
    const controls = screen
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-controls"))
      .filter(Boolean);
    expect(controls).toEqual([panel.id]);
    expect(panel.textContent).toBe("Fiscal stub");
    cleanup();
    state.search = { aba: "acesso" };
    state.company = declared(false);
    renderCompany("viewer");
    expect(screen.queryByRole("tab", { name: "Acesso" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Resumo" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Situação" })).toBeTruthy();
  });

  it("clique e setas trocam a aba pela URL; Home e End vão às pontas", () => {
    renderCompany();
    fireEvent.click(screen.getByRole("tab", { name: "Certificado" }));
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "/app/$organizationSlug/companies/$companyId",
        params: { organizationSlug: "equipe", companyId: "c1" },
        search: { aba: "certificado" },
        replace: true,
      }),
    );
    const tablist = screen.getByRole("tablist", { name: "Seções da empresa" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { aba: "fiscal" } }),
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Fiscal" }));
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { aba: "historico" } }),
    );
    fireEvent.keyDown(tablist, { key: "End" });
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { aba: "historico" } }),
    );
    fireEvent.keyDown(tablist, { key: "Home" });
    // Resumo leaves the URL without `aba`.
    expect(state.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ search: {} }));
  });

  it("o Resumo traz a situação com atalhos para as abas", () => {
    renderCompany();
    const shortcuts = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("data-aba"))
      .map((link) => [link.textContent, link.getAttribute("data-aba")]);
    // Nothing is ready yet: each shortcut says what to do there, as a button.
    expect(shortcuts).toEqual([
      ["Consultar CNPJ", "consulta"],
      ["Enviar certificado", "certificado"],
      ["Configurar perfil fiscal", "fiscal"],
    ]);
    for (const link of screen.getAllByRole("link").filter((l) => l.getAttribute("data-aba")))
      expect(link.className).toContain("ui-button");
    expect(screen.getByText("0 de 3 itens prontos")).toBeTruthy();
    expect(screen.getByText(/Já importa XML; a emissão NFS-e espera o perfil fiscal/)).toBeTruthy();
  });

  it("um item pronto leva a ver, não a fazer", () => {
    state.company = { ...declared(), registryStatus: "found" };
    renderCompany();
    const registry = screen.getByRole("link", { name: "Ver consulta CNPJ" });
    expect(registry.className).toBe("ui-link");
    expect(screen.getByText("1 de 3 itens prontos")).toBeTruthy();
  });

  it("na demonstração, uma linha diz o que não se aplica", () => {
    state.company = { ...declared(false), kind: "demonstration" };
    renderCompany();
    expect(screen.getByText("Consulta, certificado e perfil")).toBeTruthy();
    expect(screen.queryByText(/itens prontos/)).toBeNull();
    expect(screen.getByText("Demonstração sandbox", { selector: ".ui-badge" })).toBeTruthy();
  });

  it("um atalho de fora da lista de abas leva o foco ao painel", () => {
    const view = renderCompany();
    expect(document.activeElement).toBe(document.body);
    state.search = { aba: "certificado" };
    view.rerender(<Companies org={org()} contextKey="k" companyId="c1" />);
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});

describe("cadastro em modo leitura", () => {
  it("diz em palavras de onde vieram os dados, com o CEP formatado e sem repetir o CNPJ", () => {
    renderCompany();
    expect(screen.getByText("Razão social e endereço preenchidos à mão.")).toBeTruthy();
    expect(screen.getByText("13010-000")).toBeTruthy();
    // The CNPJ is under the title only; the declared company carries no badge for being one.
    expect(screen.getAllByText(/00\.000\.000\/0001-91/)).toHaveLength(1);
    expect(screen.queryByText("Cadastro declarado")).toBeNull();
  });

  it("abre a edição pelo botão, cancela e devolve o foco", async () => {
    renderCompany();
    expect(screen.queryByLabelText("Nome da empresa")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editar cadastro" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Nome da empresa"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await flushFrames();
    expect(screen.queryByLabelText("Nome da empresa")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Editar cadastro" }));
  });

  it("valida em pt-BR junto ao campo, sem balão nativo, e salva com a versão", async () => {
    state.mutate.mockResolvedValue(null);
    renderCompany();
    fireEvent.click(screen.getByRole("button", { name: "Editar cadastro" }));
    const form = screen.getByRole("button", { name: "Salvar alterações" }).closest("form")!;
    expect(form.noValidate).toBe(true);
    fireEvent.change(screen.getByLabelText("CEP"), { target: { value: "130" } });
    fireEvent.change(screen.getByLabelText("UF"), { target: { value: "XX" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(state.mutate).not.toHaveBeenCalled();
    const cep = screen.getByLabelText("CEP");
    expect(cep.getAttribute("aria-invalid")).toBe("true");
    expect(cep.getAttribute("aria-describedby")).toBe("company-postalCode-error");
    expect(document.getElementById("company-postalCode-error")!.textContent).toBe(
      "O CEP tem oito dígitos, como 13010-000.",
    );
    const summary = screen.getByRole("alert");
    expect(document.activeElement).toBe(summary);
    expect(summary.textContent).toContain("UF: Informe a sigla de uma UF brasileira");
    fireEvent.change(screen.getByLabelText("CEP"), { target: { value: "13010-000" } });
    fireEvent.change(screen.getByLabelText("UF"), { target: { value: "sp" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(state.mutate).toHaveBeenCalledWith(
      "companies:update",
      expect.objectContaining({ companyId: "c1", expectedVersion: 3 }),
    );
    expect(screen.getByText("Cadastro salvo.")).toBeTruthy();
    expect(screen.queryByLabelText("CEP")).toBeNull();
  });

  it("quem não administra vê o motivo em vez do botão", () => {
    state.company = declared(false);
    renderCompany("viewer");
    expect(screen.queryByRole("button", { name: "Editar cadastro" })).toBeNull();
    expect(
      screen.getByText("Somente proprietários e administradores alteram o cadastro."),
    ).toBeTruthy();
  });

  it("aponta todos os campos do cadastro novo de uma vez", () => {
    expect(
      Object.keys(
        companyErrors({
          cnpj: "00000000000190",
          name: " ",
          address: {
            street: "",
            number: "",
            complement: "",
            district: "",
            city: "",
            state: "",
            postalCode: "",
          },
        }),
      ),
    ).toEqual([
      "company-cnpj",
      "company-name",
      "company-street",
      "company-number",
      "company-district",
      "company-city",
      "company-state",
      "company-postalCode",
    ]);
  });
});

describe("acesso à empresa", () => {
  const member = {
    membershipId: "m1",
    membershipVersion: 1,
    grantVersion: 2,
    name: "Operadora Sintética",
    email: "op@development.invalid",
    role: "operator",
    inherited: false,
    granted: true,
  };
  it("revogar pede confirmação num diálogo, com o foco no Cancelar, e o devolve ao fechar", async () => {
    state.search = { aba: "acesso" };
    state.members = [member];
    renderCompany();
    const trigger = screen.getByRole("button", { name: "Revogar acesso" });
    // A click focuses the button in the browser; jsdom does not.
    trigger.focus();
    fireEvent.click(trigger);
    expect(state.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", {
      name: "Revogar o acesso de Operadora Sintética a Oficina Sintética?",
    });
    expect(dialog.textContent).toContain("deixa de ver a empresa");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revogar acesso" }));
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revogar acesso" }));
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("confirmar revoga com as versões esperadas e anuncia o resultado", async () => {
    state.search = { aba: "acesso" };
    state.members = [member];
    state.mutate.mockResolvedValue(null);
    renderCompany();
    fireEvent.click(screen.getByRole("button", { name: "Revogar acesso" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    });
    await flushFrames();
    expect(state.mutate).toHaveBeenCalledWith("companies:setGrant", {
      organizationId: "org",
      companyId: "c1",
      membershipId: "m1",
      allowed: false,
      expectedMembershipVersion: 1,
      expectedGrantVersion: 2,
    });
    expect(screen.getByRole("status").textContent).toBe("Acesso revogado.");
  });
});

describe("primeiros passos", () => {
  const base = {
    mode: null,
    company: null,
    guidanceDismissed: false,
    version: 1,
    canManage: true,
    firstDocument: "pending-import",
    certificateRequired: false,
  };
  it("dá um status claro a cada situação, sem 'pendente ou sem acesso'", () => {
    const text = (patch: Record<string, unknown>) =>
      onboardingStatus({ ...base, ...patch } as Parameters<typeof onboardingStatus>[0]);
    expect(text({})).toEqual({
      mode: "Ainda não escolhido",
      company: "Escolha como começar primeiro",
      document: "Prepare uma empresa primeiro",
    });
    expect(text({ mode: "manual" }).company).toBe("Cadastre ou escolha uma empresa");
    expect(text({ canManage: false }).company).toBe("Nenhuma empresa liberada para você");
    expect(text({ company: { id: "c1", name: "X" } }).document).toBe("Aguardando importação");
  });

  it("'Cadastrar minha empresa' salva a escolha e leva ao formulário de cadastro", async () => {
    state.onboarding = base;
    state.mutate.mockResolvedValue({ companyId: null });
    render(<Onboarding org={org()} contextKey="k" />);
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.filter((button) => button.disabled)).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cadastrar minha empresa" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("onboarding:start", {
      organizationId: "org",
      mode: "manual",
      expectedVersion: 1,
    });
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/app/$organizationSlug/companies",
        hash: "cadastrar-empresa",
      }),
    );
  });

  it("com o cadastro manual escolhido, os caminhos continuam disponíveis e diretos", async () => {
    state.onboarding = { ...base, mode: "manual" };
    render(<Onboarding org={org()} contextKey="k" />);
    expect(screen.getByRole("link", { name: "Cadastrar a empresa" }).getAttribute("href")).toBe(
      "#cadastrar-empresa",
    );
    const open = screen.getByRole("button", { name: "Abrir cadastro de empresa" });
    expect((open as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Explorar demonstração" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () => {
      fireEvent.click(open);
    });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "cadastrar-empresa" }),
    );
    expect(document.body.textContent).not.toContain("↗");
  });

  it.each([
    ["owner", "demonstration", "Ir para a importação do exemplo"],
    ["operator", "demonstration", "Ir para a importação do exemplo"],
    ["viewer", "demonstration", "Importar XML e acompanhar resultados"],
    ["owner", "declared", "Importar XML e acompanhar resultados"],
  ])("a etapa do documento, para %s numa empresa %s, diz %j", (role, kind, label) => {
    const company = { id: "demo", cnpj: "12ABC34501DE35", name: "Empresa", kind, version: 1 };
    state.onboarding = { ...base, mode: "demonstration", company };
    render(<Onboarding org={org(role)} contextKey="k" />);
    // The same route and search as any import: the company comes in the URL.
    expect(screen.getByRole("link", { name: label }).getAttribute("data-company")).toBe("demo");
  });
});

describe("selo da captura fiscal (#433)", () => {
  const listed = (id: string, name: string, fiscalCapture: string | null) => ({
    id,
    name,
    cnpj: "00000000000191",
    kind: "declared",
    version: 1,
    fiscalCapture,
  });
  const badge = (text: string) => screen.getByText(text, { selector: ".ui-badge" });

  it("na lista, com as palavras e o tom do painel, e sem coluna quando nenhuma tem", () => {
    state.list = [
      listed("c1", "Ativa", "active"),
      listed("c2", "Pausada", "paused"),
      listed("c3", "Em atenção", "attention"),
      listed("c4", "Parada", "halted"),
      listed("c5", "Liberada", "not-started"),
      listed("c6", "Sem captura", null),
    ];
    render(<Companies org={org()} contextKey="k" />);
    expect(screen.getByRole("columnheader", { name: "Captura fiscal" })).toBeTruthy();
    expect(badge("Captura fiscal ativa").className).toContain("ui-badge--success");
    expect(badge("Captura fiscal pausada").className).toContain("ui-badge--neutral");
    expect(badge("Captura fiscal precisa de atenção").className).toContain("ui-badge--warning");
    expect(badge("Captura fiscal parada pela Freecorps")).toBeTruthy();
    expect(badge("Captura fiscal não iniciada")).toBeTruthy();
    const row = screen.getByRole("link", { name: "Sem captura" }).closest("tr")!;
    expect(row.textContent).toContain("Não ativada");
    cleanup();
    state.list = [listed("c6", "Sem captura", null)];
    render(<Companies org={org()} contextKey="k" />);
    expect(screen.queryByRole("columnheader", { name: "Captura fiscal" })).toBeNull();
  });
  it("na lista, a linha abre a empresa e só a demonstração leva selo", () => {
    state.list = [
      listed("c1", "Oficina", null),
      { ...listed("demo", "Empresa de demonstração", null), kind: "demonstration" },
    ];
    render(<Companies org={org()} contextKey="k" />);
    expect(screen.queryByRole("columnheader", { name: "Tipo" })).toBeNull();
    expect(screen.getByRole("link", { name: "Oficina" }).className).toContain("fiscal-row-link");
    expect(screen.getAllByText("Demonstração", { selector: ".ui-badge" })).toHaveLength(1);
  });
  it("no cabeçalho da empresa, em todas as abas", () => {
    state.company = { ...declared(), fiscalCapture: "attention" };
    renderCompany();
    expect(badge("Captura fiscal precisa de atenção").className).toContain("ui-badge--warning");
    cleanup();
    state.company = { ...declared(), fiscalCapture: null };
    renderCompany();
    expect(screen.queryByText(/^Captura fiscal/, { selector: ".ui-badge" })).toBeNull();
  });
});
