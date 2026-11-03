// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { CreateCompany } from "./company-create";
import { Companies } from "./companies";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutate: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => ({}),
  Link: (props: { params: { companyId?: string }; children: React.ReactNode }) => (
    <a href={`/empresa/${props.params.companyId ?? ""}`}>{props.children}</a>
  ),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    if (args === "skip") return undefined;
    const entry = state.queries[getFunctionName(fn)];
    const value = typeof entry === "function" ? (entry as (a: unknown) => unknown)(args) : entry;
    if (value instanceof Error) throw value;
    return value;
  },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));

type Org = Parameters<typeof CreateCompany>[0]["org"];
const org = (role = "owner") =>
  ({
    id: "org",
    slug: "equipe",
    role,
    capabilities: {
      manageOrganization: role === "owner" || role === "admin",
      operateDocuments: true,
    },
  }) as unknown as Org;
const consulted = {
  name: "Oficina Sintética de Testes Ltda",
  status: "Ativa",
  address: {
    street: "Rua das Amostras",
    number: "100",
    complement: "",
    district: "Centro",
    city: "Campinas",
    state: "SP",
    postalCode: "13010000",
  },
};
const preview = (state: string, patch: Record<string, unknown> = {}) => ({
  lookupId: "l1",
  cnpj: "00000000000191",
  state,
  provider: "opencnpj",
  sourceUrl: "https://opencnpj.org/",
  data: state === "found" ? consulted : null,
  consultedAt: state === "found" ? Date.UTC(2026, 9, 30, 15) : null,
  sourceUpdatedAt: null,
  expiresAt: null,
  cacheVersion: state === "found" ? 4 : null,
  ...patch,
});
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const box = (label: string) =>
  screen.getByRole("checkbox", { name: new RegExp(label) }) as HTMLInputElement;
const calls = (name: string) =>
  state.mutate.mock.calls.filter(([fn]) => fn === name).map(([, args]) => args);
function mutations(answers: Record<string, () => unknown>) {
  state.mutate.mockImplementation(async (name: string) => answers[name]?.());
}
const flushFrames = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
function renderCreate() {
  return render(<CreateCompany org={org()} headingRef={createRef()} onCancel={vi.fn()} />);
}
async function consult(cnpj = "00.000.000/0001-91") {
  fireEvent.change(field("CNPJ"), { target: { value: cnpj } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
}
async function save() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar empresa" })));
}

beforeEach(() => {
  mutations({
    "registry:lookup": () => ({ kind: "lookup", lookupId: "l1", reused: false }),
    "companies:create": () => ({ companyId: "c9", reused: false }),
  });
});
afterEach(() => {
  cleanup();
  state.queries = {};
  vi.resetAllMocks();
});

describe("cadastro com consulta do CNPJ", () => {
  it("mostra a consulta em andamento e, encontrada, preenche os campos para revisão e salva com a origem", async () => {
    state.queries["registry:lookupStatus"] = preview("pending");
    const view = renderCreate();
    await consult();
    expect(screen.getByRole("status").textContent).toBe("Consultando o CNPJ na fonte…");
    expect(screen.queryByRole("button", { name: "Salvar empresa" })).toBeNull();

    state.queries["registry:lookupStatus"] = preview("found");
    view.rerender(<CreateCompany org={org()} headingRef={createRef()} onCancel={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Cadastro encontrado");
    expect(screen.getByText(/Fonte:/).textContent).toMatch(/OpenCNPJ, consultado em 30\/10\/2026/);
    expect(field("Nome da empresa").value).toBe(consulted.name);
    expect(field("Logradouro").value).toBe("Rua das Amostras");
    expect(box("Usar nome").checked).toBe(true);
    expect(box("Usar endereço").checked).toBe(true);

    await save();
    expect(calls("companies:create")).toEqual([
      {
        organizationId: "org",
        cnpj: "00.000.000/0001-91",
        name: consulted.name,
        address: consulted.address,
        registry: { lookupId: "l1", expectedCacheVersion: 4, fields: ["name", "address"] },
      },
    ]);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { organizationSlug: "equipe", companyId: "c9" } }),
    );
  });

  it("um campo consultado alterado passa a ser digitado e sai sem a origem da consulta", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    fireEvent.change(field("Nome da empresa"), { target: { value: "Oficina Sintética" } });
    expect(box("Usar nome").checked).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Nome alterado");
    await save();
    expect(calls("companies:create")[0]).toMatchObject({
      name: "Oficina Sintética",
      registry: { fields: ["address"] },
    });
  });

  it("não troca um valor já digitado sem a pessoa marcar o campo", async () => {
    state.queries["registry:lookupStatus"] = preview("pending");
    const view = renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    fireEvent.change(field("Nome da empresa"), { target: { value: "Nome digitado" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    state.queries["registry:lookupStatus"] = preview("found");
    view.rerender(<CreateCompany org={org()} headingRef={createRef()} onCancel={vi.fn()} />);
    expect(field("Nome da empresa").value).toBe("Nome digitado");
    expect(box("Usar nome").checked).toBe(false);
    fireEvent.click(box("Usar nome"));
    expect(field("Nome da empresa").value).toBe(consulted.name);
  });

  it.each(["not_found", "unavailable", "unsupported_format", "quota", "expired"])(
    "%s explica a situação e oferece o preenchimento manual",
    async (status) => {
      state.queries["registry:lookupStatus"] = preview(status);
      renderCreate();
      await consult();
      // One "Preencher manualmente", in the notice.
      fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
      await flushFrames();
      expect(document.activeElement).toBe(field("Nome da empresa"));
      expect(screen.getByRole("button", { name: "Salvar empresa" })).toBeTruthy();
    },
  );

  it("a consulta apagada depois de 24 horas aparece como indisponível, com nova consulta", async () => {
    state.queries["registry:lookupStatus"] = new ConvexError({ code: "ACCESS_DENIED" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderCreate();
    await consult();
    expect(screen.getByRole("status").textContent).toBe("Esta consulta não está mais disponível.");
    expect(screen.getByRole("button", { name: "Consultar novamente" })).toBeTruthy();
  });

  it("o limite de consultas orienta a esperar ou preencher manualmente", async () => {
    mutations({
      "registry:lookup": () => Promise.reject(new ConvexError({ code: "RATE_LIMITED" })),
    });
    renderCreate();
    await consult();
    expect(screen.getByRole("alert").textContent).toMatch(/Aguarde um minuto/);
    expect(screen.getAllByRole("button", { name: "Preencher manualmente" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Consultar novamente" })).toBeNull();
  });

  it("CNPJ já cadastrado leva à empresa existente, sem formulário para duplicá-la", async () => {
    mutations({ "registry:lookup": () => ({ kind: "existing", companyId: "c1" }) });
    renderCreate();
    await consult();
    expect(screen.getByRole("link", { name: "Ver empresa cadastrada" }).getAttribute("href")).toBe(
      "/empresa/c1",
    );
    expect(screen.queryByRole("button", { name: "Salvar empresa" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Empresa já cadastrada nesta organização. Os dados existentes foram preservados.",
    );
  });

  it("editar só o complemento do endereço consultado não leva a outra empresa o resto do endereço", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    fireEvent.change(field("Complemento (opcional)"), { target: { value: "Sala 2" } });
    expect(box("Usar endereço").checked).toBe(false);
    expect(field("Logradouro").value).toBe("Rua das Amostras");
    fireEvent.change(field("CNPJ"), { target: { value: "11222333000181" } });
    expect(screen.getByRole("alert").textContent).toMatch(/O CNPJ mudou/);
    expect(field("Complemento (opcional)").value).toBe("Sala 2");
    for (const label of ["Nome da empresa", "Logradouro", "Número", "Bairro", "Município", "UF"])
      expect(field(label).value).toBe("");
    await save();
    expect(calls("companies:create")).toHaveLength(0);
  });

  it("editar de novo depois de remarcar o endereço não guarda o endereço consultado como digitado", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    fireEvent.change(field("Logradouro"), { target: { value: "Rua digitada" } });
    fireEvent.click(box("Usar endereço"));
    expect(box("Usar endereço").checked).toBe(true);
    fireEvent.change(field("Número"), { target: { value: "99" } });
    fireEvent.change(field("CNPJ"), { target: { value: "11222333000181" } });
    expect(field("Logradouro").value).toBe("Rua digitada");
    expect(field("Número").value).toBe("99");
    for (const label of ["Bairro", "Município", "UF", "CEP"]) expect(field(label).value).toBe("");
  });

  it("pontuação no CNPJ consultado não desfaz a consulta", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult("00000000000191");
    fireEvent.change(field("CNPJ"), { target: { value: "00.000.000/0001-91" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(box("Usar nome").checked).toBe(true);
    expect(field("Nome da empresa").value).toBe(consulted.name);
  });

  it("Consultar CNPJ leva o foco ao campo do CNPJ antes de o botão ficar indisponível", async () => {
    state.queries["registry:lookupStatus"] = preview("pending");
    renderCreate();
    const button = screen.getByRole("button", { name: "Consultar CNPJ" });
    button.focus();
    await consult();
    expect(document.activeElement).toBe(field("CNPJ"));
  });

  it("a consulta descartada que volta a ser encontrada não é anunciada de novo", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    mutations({
      "registry:lookup": () => ({ kind: "lookup", lookupId: "l1", reused: false }),
      "companies:create": () => Promise.reject(new ConvexError({ code: "REGISTRY_CHANGED" })),
    });
    const view = renderCreate();
    await consult();
    await save();
    const again = () =>
      view.rerender(<CreateCompany org={org()} headingRef={createRef()} onCancel={vi.fn()} />);
    state.queries["registry:lookupStatus"] = preview("pending");
    again();
    state.queries["registry:lookupStatus"] = preview("found", { cacheVersion: 6 });
    again();
    expect(screen.getByRole("status").textContent).not.toMatch(/Cadastro encontrado/);
    expect(screen.queryByRole("checkbox", { name: /Usar nome/ })).toBeNull();
  });

  it("com o foco num campo da revisão, a consulta que deixa de valer leva o foco ao CNPJ", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The same heading ref: a new one would take the focus back to the form's title.
    const props = { org: org(), headingRef: createRef<HTMLHeadingElement>(), onCancel: vi.fn() };
    const view = render(<CreateCompany {...props} />);
    await consult();
    box("Usar nome").focus();
    state.queries["registry:lookupStatus"] = new ConvexError({ code: "ACCESS_DENIED" });
    view.rerender(<CreateCompany {...props} />);
    expect(screen.queryByRole("checkbox", { name: /Usar nome/ })).toBeNull();
    expect(document.activeElement).toBe(field("CNPJ"));
  });

  it("REGISTRY_CHANGED explica, volta ao digitado e salva com a nova consulta revisada", async () => {
    state.queries["registry:lookupStatus"] = ({ lookupId }: { lookupId: string }) =>
      preview("found", { lookupId, cacheVersion: lookupId === "l2" ? 5 : 4 });
    renderCreate();
    await consult();
    let changed = true;
    mutations({
      "registry:lookup": () => ({ kind: "lookup", lookupId: "l2", reused: false }),
      "companies:create": () =>
        changed
          ? Promise.reject(new ConvexError({ code: "REGISTRY_CHANGED" }))
          : { companyId: "c9", reused: false },
    });
    await save();
    expect(screen.getByRole("alert").textContent).toMatch(/mudaram ou venceram/);
    // Nothing consulted stays as typed: the fields go back to what the person typed (nothing).
    expect(field("Nome da empresa").value).toBe("");
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Consultar novamente" })),
    );
    expect(document.activeElement).toBe(field("CNPJ"));
    expect(calls("registry:lookup")).toHaveLength(2);
    changed = false;
    await save();
    expect(calls("companies:create")[1]).toMatchObject({
      registry: { lookupId: "l2", expectedCacheVersion: 5, fields: ["name", "address"] },
    });
  });

  it("uma nova consulta limitada depois de REGISTRY_CHANGED volta ao digitado, à vista", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    mutations({
      "registry:lookup": () => Promise.reject(new ConvexError({ code: "RATE_LIMITED" })),
      "companies:create": () => Promise.reject(new ConvexError({ code: "REGISTRY_CHANGED" })),
    });
    await save();
    const alert = screen.getAllByRole("alert").find((el) => /Nada foi salvo/.test(el.textContent!));
    expect(alert?.textContent).toMatch(/os campos voltaram ao que você digitou/i);
    expect(field("Nome da empresa").value).toBe("");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Consultar novamente" })),
    );
    expect(
      screen
        .getAllByRole("alert")
        .map((el) => el.textContent)
        .join(" "),
    ).toMatch(/Aguarde um minuto/);
    expect(field("Nome da empresa").value).toBe("");
    expect(screen.queryByRole("checkbox", { name: /Usar nome/ })).toBeNull();
  });

  it("a consulta apagada volta os campos ao digitado, à vista, e o cadastro sai sem a origem", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    fireEvent.change(field("Nome da empresa"), { target: { value: "Nome digitado" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    fireEvent.click(box("Usar nome"));
    expect(field("Nome da empresa").value).toBe(consulted.name);
    state.queries["registry:lookupStatus"] = new ConvexError({ code: "ACCESS_DENIED" });
    view.rerender(<CreateCompany org={org()} headingRef={createRef()} onCancel={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /deixaram de valer.*Os campos voltaram ao que você digitou/,
    );
    expect(screen.getByText("Esta consulta não está mais disponível.")).toBeTruthy();
    expect(field("Nome da empresa").value).toBe("Nome digitado");
    expect(field("Logradouro").value).toBe("");
    expect(screen.queryByRole("checkbox", { name: /Usar nome/ })).toBeNull();
  });

  it("desmarcar sem nada digitado deixa o campo vazio; trocar o CNPJ não leva o consultado", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    fireEvent.click(box("Usar nome"));
    expect(field("Nome da empresa").value).toBe("");
    fireEvent.change(field("Nome da empresa"), { target: { value: "Nome próprio" } });
    fireEvent.change(field("CNPJ"), { target: { value: "11222333000181" } });
    expect(screen.getByRole("alert").textContent).toMatch(/O CNPJ mudou/);
    expect(field("Logradouro").value).toBe("");
    fireEvent.change(field("Logradouro"), { target: { value: "Rua B" } });
    for (const [label, value] of [
      ["Número", "2"],
      ["Bairro", "Centro"],
      ["Município", "Campinas"],
      ["UF", "SP"],
      ["CEP", "13010000"],
    ])
      fireEvent.change(field(label!), { target: { value } });
    await save();
    expect(calls("companies:create")[0]).toEqual({
      organizationId: "org",
      cnpj: "11222333000181",
      name: "Nome próprio",
      address: { ...consulted.address, street: "Rua B", number: "2" },
    });
  });

  it("endereço consultado incompleto não vem marcado e pede o preenchimento manual", async () => {
    state.queries["registry:lookupStatus"] = preview("found", {
      data: { ...consulted, address: { ...consulted.address, number: "" } },
    });
    renderCreate();
    await consult();
    expect(screen.getByRole("status").textContent).toMatch(/endereço incompleto/);
    expect(box("Usar endereço").checked).toBe(false);
    expect(box("Usar endereço").disabled).toBe(true);
    expect(box("Usar nome").checked).toBe(true);
    expect(field("Logradouro").value).toBe("");
  });

  it("CNPJ já cadastrado ao salvar leva o foco à empresa existente", async () => {
    mutations({ "companies:create": () => ({ companyId: "c1", reused: true }) });
    renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    fireEvent.change(field("Nome da empresa"), { target: { value: "Oficina" } });
    for (const [label, value] of Object.entries({
      Logradouro: "Rua A",
      Número: "1",
      Bairro: "Centro",
      Município: "Campinas",
      UF: "SP",
      CEP: "13010000",
    }))
      fireEvent.change(field(label), { target: { value } });
    await save();
    await flushFrames();
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Ver empresa cadastrada" }),
    );
    expect(screen.queryByRole("button", { name: "Salvar empresa" })).toBeNull();
  });

  it("resposta perdida oferece repetir a mesma solicitação", async () => {
    mutations({ "registry:lookup": () => Promise.reject(new Error("conexão perdida")) });
    renderCreate();
    await consult();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Consultar novamente" })),
    );
    expect(document.activeElement).toBe(field("CNPJ"));
    const keys = calls("registry:lookup").map((args) => (args as { key: string }).key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("ACCESS_DENIED ao salvar com a consulta pede nova consulta, não fala de permissão", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    mutations({
      "registry:lookup": () => ({ kind: "lookup", lookupId: "l1", reused: false }),
      "companies:create": () => Promise.reject(new ConvexError({ code: "ACCESS_DENIED" })),
    });
    renderCreate();
    await consult();
    await save();
    expect(screen.getByRole("alert").textContent).toMatch(/mudaram ou venceram/);
  });

  it("outra falha da consulta oferece nova consulta sem dizer que venceu", async () => {
    state.queries["registry:lookupStatus"] = new Error("falha de rede");
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderCreate();
    await consult();
    expect(screen.getByRole("status").textContent).toBe(
      "Não foi possível acompanhar esta consulta.",
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Consultar novamente" })),
    );
    expect(document.activeElement).toBe(field("CNPJ"));
    expect(calls("registry:lookup")).toHaveLength(2);
  });

  it("trocar o CNPJ tira os dados consultados e mantém o que a pessoa digitou", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    fireEvent.change(field("Logradouro"), { target: { value: "Rua digitada" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    expect(field("Nome da empresa").value).toBe(consulted.name);
    fireEvent.click(box("Usar endereço"));
    expect(field("Logradouro").value).toBe("Rua das Amostras");
    fireEvent.change(field("CNPJ"), { target: { value: "11222333000181" } });
    expect(field("Nome da empresa").value).toBe("");
    expect(field("Logradouro").value).toBe("Rua digitada");
    expect(screen.queryByRole("checkbox", { name: /Usar nome/ })).toBeNull();
  });

  it("desmarcar um campo devolve o valor digitado antes", async () => {
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    fireEvent.change(field("Nome da empresa"), { target: { value: "Nome digitado" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    fireEvent.click(box("Usar nome"));
    expect(field("Nome da empresa").value).toBe(consulted.name);
    fireEvent.click(box("Usar nome"));
    expect(field("Nome da empresa").value).toBe("Nome digitado");
  });

  it("ignora a resposta que chega depois de o CNPJ ser trocado", async () => {
    let answer: (value: unknown) => void = () => {};
    state.mutate.mockImplementation(
      (name: string) => name === "registry:lookup" && new Promise((resolve) => (answer = resolve)),
    );
    state.queries["registry:lookupStatus"] = preview("found");
    renderCreate();
    await consult();
    fireEvent.change(field("CNPJ"), { target: { value: "11222333000181" } });
    await act(async () => answer({ kind: "lookup", lookupId: "l1", reused: false }));
    expect(screen.queryByText("Dados consultados")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Nome da empresa" })).toBeNull();
  });

  it("Enter no CNPJ consulta, mesmo com os campos abertos", async () => {
    state.queries["registry:lookupStatus"] = preview("pending");
    renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    await act(async () => fireEvent.keyDown(field("CNPJ"), { key: "Enter" }));
    expect(calls("registry:lookup")).toHaveLength(1);
    expect(calls("companies:create")).toHaveLength(0);
  });

  it("CNPJ já cadastrado depois do preenchimento manual não oferece salvar", async () => {
    mutations({ "registry:lookup": () => ({ kind: "existing", companyId: "c1" }) });
    renderCreate();
    fireEvent.change(field("CNPJ"), { target: { value: "00000000000191" } });
    fireEvent.click(screen.getByRole("button", { name: "Preencher manualmente" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    expect(screen.getByRole("link", { name: "Ver empresa cadastrada" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar empresa" })).toBeNull();
  });

  it("repetir uma consulta sem resposta usa a mesma chave; uma nova consulta, outra", async () => {
    let lost = true;
    mutations({
      "registry:lookup": () =>
        lost
          ? Promise.reject(new Error("conexão perdida"))
          : { kind: "lookup", lookupId: "l1", reused: true },
    });
    state.queries["registry:lookupStatus"] = preview("not_found");
    renderCreate();
    await consult();
    expect(screen.getByRole("alert").textContent).toMatch(/mesma solicitação/);
    lost = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Consultar CNPJ" })));
    const keys = calls("registry:lookup").map((args) => (args as { key: string }).key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).toMatch(/^[\w-]{8,100}$/);
  });
});

describe("papéis", () => {
  it("só proprietário e administrador veem o cadastro de empresa", () => {
    render(<Companies org={org("operator")} contextKey="k" />);
    expect(screen.queryByRole("button", { name: "Cadastrar empresa" })).toBeNull();
    cleanup();
    render(<Companies org={org("admin")} contextKey="k" />);
    expect(screen.getByRole("button", { name: "Cadastrar empresa" })).toBeTruthy();
  });
});
