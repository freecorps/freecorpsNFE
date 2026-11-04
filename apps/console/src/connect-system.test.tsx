// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import {
  connectPlan,
  environmentChoices,
  firstCallFor,
  grantSteps,
  matchingKey,
  presetsFor,
  resumeChoice,
  servedScopes,
} from "./connect-system";
import { Projects } from "./projects";
import { integrationScopes, releasedProductionScopes } from "@freecorps/contracts";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

// "Conectar meu sistema" (#512): project, grants and key in one path, resumable from the server.

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  pages: {} as Record<string, unknown[]>,
  status: {} as Record<string, string>,
  asked: [] as string[],
  loadMore: vi.fn(),
  call: vi.fn(),
  navigate: vi.fn(),
  /** The environment chosen in the shell. */
  environment: "sandbox" as "sandbox" | "production",
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: vi.fn(),
  }),
}));
type Fn = Parameters<typeof getFunctionName>[0];
const lookup = (fn: Fn, args: unknown) => {
  if (args === "skip") return undefined;
  const name = getFunctionName(fn);
  state.asked.push(name);
  return state.queries[name];
};
vi.mock("./convex-query", () => ({
  useQuery: (fn: Fn, args: unknown) => lookup(fn, args),
  usePaginatedQuery: (fn: Fn) => {
    state.asked.push(getFunctionName(fn));
    return {
      results: state.pages[getFunctionName(fn)] ?? [],
      status: state.status[getFunctionName(fn)] ?? "Exhausted",
      loadMore: state.loadMore,
    };
  },
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Fn, args: unknown) => lookup(fn, args),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useMutation: (fn: Fn) => (args: unknown) => state.call(getFunctionName(fn), args),
  useAction: (fn: Fn) => (args: unknown) => state.call(getFunctionName(fn), args),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; params: Record<string, string>; children: ReactNode }) => (
    <a
      href={Object.entries(props.params).reduce(
        (to, [key, value]) => to.replace(`$${key}`, value),
        props.to,
      )}
    >
      {props.children}
    </a>
  ),
  useNavigate: () => state.navigate,
}));
afterEach(() => {
  cleanup();
  state.environment = "sandbox";
  state.queries = {};
  state.pages = {};
  state.status = {};
  state.asked = [];
  state.loadMore.mockReset();
  state.call.mockReset();
  state.navigate.mockReset();
});

type Org = Parameters<typeof Projects>[0]["org"];
const admin = {
  id: "org",
  slug: "equipe",
  role: "admin",
  capabilities: { manageIntegrations: true, manageOrganization: true },
} as unknown as Org;
const allScopes = [
  "companies:read",
  "documents:read",
  "documents:import",
  "documents:issue",
  "webhooks:manage",
];
const developerScopes = ["companies:read", "documents:read", "webhooks:manage"];
const importScopes = ["companies:read", "documents:import", "documents:read"];
const readScopes = ["companies:read", "documents:read"];
const project = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "ERP Loja",
  externalReference: "erp-loja",
  state: "active",
  version: 1,
  grantableScopes: allScopes,
  accessVersion: "1",
  deploymentEnvironment: "sandbox",
  ...overrides,
});
const candidate = (
  companyId: string,
  name: string,
  options: { kind?: string; offered?: string[]; version?: number } = {},
) => ({
  companyId,
  name,
  kind: options.kind ?? "demonstration",
  offeredEnvironments: options.offered ?? ["sandbox"],
  grantVersion: options.version ?? 0,
});
const demo = candidate("c1", "Empresa Demonstração");
const declared = (offered = ["sandbox"]) =>
  candidate("c2", "Empresa Ipê", { kind: "declared", offered });
const grant = (
  companyId: string,
  scopes: string[],
  options: { version?: number; environments?: string[]; offered?: string[]; kind?: string } = {},
) => ({
  companyId,
  name: companyId === "c1" ? "Empresa Demonstração" : `Empresa ${companyId}`,
  kind: options.kind ?? (companyId === "c1" ? "demonstration" : "declared"),
  scopes,
  environments: options.environments ?? ["sandbox"],
  offeredEnvironments: options.offered ?? ["sandbox"],
  version: options.version ?? 2,
});
const key = (overrides: Record<string, unknown> = {}) => ({
  id: "k1",
  name: "ERP Loja · Sandbox",
  prefix: "fnfe_sbx_ab",
  scopes: importScopes,
  environment: "sandbox",
  companyIds: ["c1"],
  expiresAt: Date.now() + 86400_000,
  revokedAt: null,
  rotatedAt: null,
  projectInvalidated: false,
  concessionsChanged: false,
  rotationAvailable: true,
  currentCompanyIds: ["c1"],
  createdAt: 1,
  ...overrides,
});
type KeyArg = Parameters<typeof matchingKey>[0][number];
const keys = (...items: Record<string, unknown>[]) => items.map((k) => key(k) as unknown as KeyArg);
const refusal = (code: string) => new ConvexError({ code });
function open(org = admin, projectId?: string) {
  return render(<Projects org={org} contextKey="k" section="connect" projectId={projectId} />);
}
type Setup = {
  grants?: unknown[];
  keys?: unknown[];
  candidates?: unknown[];
  project?: Record<string, unknown>;
};
function prepare(options: Setup = {}) {
  state.queries["projects:get"] = project(options.project);
  state.pages["projects:grantCandidates"] = options.candidates ?? [demo];
  state.pages["projects:companies"] = options.grants ?? [];
  state.pages["keys:list"] = options.keys ?? [];
}
function resume(options: Setup = {}) {
  prepare(options);
  return open(admin, "p1");
}
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
const target = (companyId: string) => ({ companyId, name: companyId }) as never;
const saved = (scopes: string[], version = 2) =>
  [{ companyId: "c1", scopes, environments: ["sandbox"], version }] as never[];

describe("regras do percurso", () => {
  it("só oferece presets inteiros que o papel concede e o ambiente atende", () => {
    expect(presetsFor(allScopes as never).map((p) => p.id)).toEqual([
      "import",
      "import-webhooks",
      "read",
      "read-webhooks",
    ]);
    expect(presetsFor(developerScopes as never).map((p) => p.id)).toEqual([
      "read",
      "read-webhooks",
    ]);
    // Produção on the hosted Sandbox serves capture reading and webhooks, never import.
    const production = servedScopes("sandbox", "production", allScopes as never[]);
    expect(production).toEqual(["companies:read", "documents:read", "webhooks:manage"]);
    expect(presetsFor(production).map((p) => p.id)).toEqual(["read", "read-webhooks"]);
    expect(servedScopes("production", "production", allScopes as never[])).toEqual(allScopes);
    // The same list the server serves (`releasedProductionScopes`, shared in contracts).
    expect(servedScopes("sandbox", "production", integrationScopes)).toEqual([
      ...releasedProductionScopes,
    ]);
  });

  it("não toca a concessão que já cobre e só acrescenta o que falta às outras", () => {
    const grants = [
      { companyId: "c1", scopes: ["documents:read"], environments: ["sandbox"], version: 4 },
      { companyId: "c2", scopes: ["webhooks:manage"], environments: ["production"], version: 7 },
    ] as never[];
    const [covered, change, fresh] = grantSteps(
      [target("c1"), target("c2"), target("c3")],
      grants,
      ["documents:read"],
      "sandbox",
      () => 3,
    );
    expect(covered!.kind).toBe("covered");
    expect(change).toEqual({
      kind: "change",
      target: target("c2"),
      scopes: ["webhooks:manage", "documents:read"],
      environments: ["production", "sandbox"],
      added: { scopes: ["documents:read"], environments: ["sandbox"] },
      expectedVersion: 7,
    });
    // A removed grant keeps its version on the server; the new save must name it.
    expect(fresh).toMatchObject({ kind: "new", expectedVersion: 3, environments: ["sandbox"] });
  });

  it("só conta a chave utilizável que cobre as empresas e as permissões escolhidas", () => {
    const now = Date.now();
    const choice = {
      environment: "sandbox" as const,
      scopes: importScopes as never[],
      companyIds: ["c1"],
    };
    expect(matchingKey(keys({ scopes: readScopes }), choice, now)).toBeUndefined();
    expect(matchingKey(keys({ companyIds: ["c2"] }), choice, now)).toBeUndefined();
    expect(matchingKey(keys({ environment: "production" }), choice, now)).toBeUndefined();
    for (const unusable of [
      { revokedAt: 1 },
      { concessionsChanged: true },
      { rotatedAt: 1 },
      { projectInvalidated: true },
      { expiresAt: now - 1 },
    ])
      expect(matchingKey(keys(unusable), choice, now)).toBeUndefined();
    const pair = keys({ id: "a", createdAt: 1 }, { id: "b", createdAt: 2 });
    expect(matchingKey(pair, choice, now)?.id).toBe("b");
  });

  it("retoma com as permissões salvas, sem preset inventado nem escopo que o papel não concede", () => {
    const base = { keys: [], deployment: "sandbox" as const, now: Date.now() };
    const custom = resumeChoice({
      ...base,
      grants: [grant("c1", ["documents:read", "documents:issue"])] as never[],
      grantable: allScopes as never[],
    });
    expect(custom).toMatchObject({
      presetId: "custom",
      scopes: ["documents:read", "documents:issue"],
      targets: [{ companyId: "c1" }],
    });
    const developer = resumeChoice({
      ...base,
      grants: [grant("c1", importScopes)] as never[],
      grantable: developerScopes as never[],
    });
    expect(developer).toMatchObject({ presetId: "read", scopes: readScopes });
    // Saved companies with no scope in common: nothing is preselected.
    const disjoint = resumeChoice({
      ...base,
      grants: [grant("c1", ["documents:read"]), grant("c2", ["webhooks:manage"])] as never[],
      grantable: allScopes as never[],
    });
    expect(disjoint).toMatchObject({ presetId: "custom", scopes: [] });
    expect(disjoint.targets).toHaveLength(2);
    expect(resumeChoice({ ...base, grants: [], grantable: developerScopes as never[] })).toEqual({
      environment: "sandbox",
      presetId: "read",
      scopes: readScopes,
      targets: [],
    });
  });

  it("retoma em Produção quando o projeto só usa Produção", () => {
    const resumed = resumeChoice({
      grants: [grant("c2", readScopes, { environments: ["production"] })] as never[],
      keys: keys({ environment: "production", companyIds: ["c2"], scopes: readScopes }),
      grantable: allScopes as never[],
      deployment: "sandbox",
      now: Date.now(),
    });
    expect(resumed).toMatchObject({ environment: "production", presetId: "read" });
  });

  it("oferece só os ambientes que a instalação e as empresas atendem", () => {
    expect(environmentChoices("production", [["production"]])).toEqual([
      { environment: "production", reason: "" },
    ]);
    expect(environmentChoices("sandbox", [["sandbox"]])[1]!.reason).toMatch(/^Indisponível/);
    expect(environmentChoices("sandbox", [["sandbox"], undefined])[1]!.reason).toMatch(
      /Conferindo/,
    );
    expect(environmentChoices("sandbox", [["sandbox", "production"]])[1]!.reason).toBe("");
    // Companies on pages not loaded yet may offer it: say so instead of "Indisponível".
    expect(environmentChoices("sandbox", [["sandbox"]], true)[1]!.reason).toMatch(
      /^Nenhuma empresa carregada .* Carregue mais empresas/,
    );
    expect(environmentChoices("sandbox", [["sandbox", "production"]], true)[1]!.reason).toBe("");
  });

  const plan = (overrides: Partial<Parameters<typeof connectPlan>[0]> = {}) => {
    const scopes = (overrides.scopes ?? ["documents:read"]) as never[];
    const environment = overrides.environment ?? "sandbox";
    return connectPlan({
      projectActive: true,
      targets: [target("c1")],
      scopes,
      environment,
      grantable: allScopes as never[],
      served: allScopes as never[],
      steps: grantSteps([target("c1")], [], scopes, environment, () => 0),
      offers: { c1: ["sandbox"] },
      versions: { c1: 0 },
      confirmed: false,
      key: undefined,
      keysPending: false,
      secretShown: false,
      activeGrants: 0,
      companiesSettled: true,
      ...overrides,
    });
  };
  const steps = (
    grants: never[],
    scopes = ["documents:read"],
    env: "sandbox" | "production" = "sandbox",
  ) => grantSteps([target("c1")], grants, scopes as never[], env, () => 0);

  it("espera a disponibilidade da empresa e a confirmação antes de conceder", () => {
    expect(plan({ offers: {} }).blocker).toMatch(/Você não tem mais acesso a c1/);
    expect(plan({ offers: {}, companiesSettled: false }).blocker).toMatch(
      /Carregue mais empresas abaixo para conferir c1/,
    );
    expect(plan({ versions: {} }).blocker).toMatch(/Conferindo/);
    expect(plan().blocker).toBe("");
    expect(
      plan({ environment: "production", steps: steps([], ["documents:read"], "production") })
        .blocker,
    ).toMatch(/Produção não está disponível para c1/);
    const change = steps(saved(["companies:read"]));
    expect(plan({ steps: change }).blocker).toMatch(/Confirme/);
    expect(plan({ steps: change, confirmed: true }).blocker).toBe("");
    const done = { steps: steps(saved(["documents:read"])) };
    expect(plan(done).current).toBe(2);
    expect(plan({ ...done, key: keys({})[0] }).current).toBe(3);
    expect(plan({ ...done, key: keys({})[0], secretShown: true }).current).toBe(2);
    expect(plan({ ...done, keysPending: true }).keyChecking).toBe(true);
  });

  it("respeita o limite de 50 empresas por projeto antes de conceder", () => {
    expect(plan({ activeGrants: 49 }).blocker).toBe("");
    expect(plan({ activeGrants: 50 }).blocker).toMatch(
      /até 50 empresas\. Ele já tem 50, e esta concessão somaria 1/,
    );
    // Changing a company that already counts adds nothing.
    expect(
      plan({ activeGrants: 50, steps: steps(saved(["companies:read"])), confirmed: true }).blocker,
    ).toBe("");
  });

  it("não propõe ao desenvolvedor uma concessão que o servidor recusaria", () => {
    // An owner granted import; the developer may only read and manage webhooks.
    const change = steps(saved(importScopes), ["webhooks:manage"]);
    const result = plan({
      steps: change,
      scopes: ["webhooks:manage"] as never[],
      grantable: developerScopes as never[],
      served: developerScopes as never[],
      confirmed: true,
    });
    expect(result.blocker).toMatch(/só um proprietário ou administrador pode alterar/);
    expect(result.confirmable).toBe(false);
  });

  it("recusa permissões que o ambiente não atende", () => {
    const result = plan({
      environment: "production",
      scopes: ["documents:import"] as never[],
      served: servedScopes("sandbox", "production", allScopes as never[]),
      offers: { c1: ["sandbox", "production"] },
      steps: steps([], ["documents:import"], "production"),
    });
    expect(result.blocker).toMatch(/Produção não atende documents:import/);
    expect(result.confirmable).toBe(false);
  });

  it("bloqueia a chave quando a Produção salva deixou de ser oferecida", () => {
    const covered = grantSteps(
      [target("c1")],
      [
        { companyId: "c1", scopes: ["documents:read"], environments: ["production"], version: 2 },
      ] as never[],
      ["documents:read"] as never[],
      "production",
      () => 0,
    );
    const result = plan({ environment: "production", steps: covered, offers: { c1: ["sandbox"] } });
    expect(result.accessDone).toBe(true);
    expect(result.keyBlocker).toMatch(/Produção não está disponível para c1/);
  });

  it("decide a primeira chamada pelos escopos da chave, em qualquer instalação", () => {
    const grants = [grant("c1", importScopes)] as never[];
    const owner = allScopes as never[];
    const readOnly = key({ scopes: readScopes }) as never;
    expect(firstCallFor(key() as never, grants, "sandbox", owner)).toEqual({ quickstart: true });
    // A read-only key is never sent to an import guide as if it could import.
    const productionKey = (scopes: string[]) => key({ environment: "production", scopes }) as never;
    const productionRead = firstCallFor(productionKey(readScopes), grants, "production", owner);
    expect(productionRead).toMatchObject({ quickstart: false });
    expect(JSON.stringify(productionRead)).toMatch(/precisa de documents:import/);
    const production = firstCallFor(productionKey(importScopes), grants, "production", owner);
    expect(production).toMatchObject({ quickstart: false, href: "/docs/importar-xml" });
    expect(JSON.stringify(production)).not.toMatch(/gere|chave de Sandbox/);
    expect(
      firstCallFor(key({ environment: "production" }) as never, grants, "sandbox", owner),
    ).toMatchObject({ href: "/docs/captura-nfe" });
    expect(
      JSON.stringify(firstCallFor(readOnly, grants, "sandbox", developerScopes as never[])),
    ).toMatch(/só proprietários e administradores/);
    expect(JSON.stringify(firstCallFor(readOnly, grants, "sandbox", owner))).toMatch(
      /gere outra chave/,
    );
  });

  it("só leva à importação sintética quando a chave alcança a empresa de demonstração", () => {
    const own = [grant("c2", importScopes)] as never[];
    const result = firstCallFor(
      key({ companyIds: ["c2"] }) as never,
      own,
      "sandbox",
      allScopes as never[],
    );
    expect(result).toMatchObject({ quickstart: false, href: "/docs/importar-xml" });
    expect(JSON.stringify(result)).toMatch(/só vale para a empresa de demonstração/);
  });
});

describe("Conectar meu sistema no console", () => {
  it("fica indisponível para quem não integra", () => {
    open({ ...admin, capabilities: { manageIntegrations: false } } as unknown as Org);
    expect(screen.getByText("Página indisponível para seu papel.")).toBeTruthy();
    expect(screen.queryByText("Conectar meu sistema")).toBeNull();
  });

  it("sugere a referência pelo nome, aceita ajuste e põe só o projeto no endereço", async () => {
    state.call.mockResolvedValue({ projectId: "p9", reused: false });
    open();
    fireEvent.change(screen.getByLabelText("Nome do aplicativo"), {
      target: { value: "ERP Álamo" },
    });
    const reference = screen.getByLabelText("Referência do aplicativo") as HTMLInputElement;
    expect(reference.value).toBe("erp-alamo");
    fireEvent.change(reference, { target: { value: "erp-alamo-matriz" } });
    fireEvent.click(button("Criar projeto e continuar"));
    await waitFor(() => expect(state.navigate).toHaveBeenCalled());
    expect(state.call).toHaveBeenCalledWith("projects:create", {
      organizationId: "org",
      name: "ERP Álamo",
      externalReference: "erp-alamo-matriz",
    });
    expect(state.navigate.mock.calls[0]![0]).toMatchObject({
      params: { developerSection: "connect", projectId: "p9" },
      replace: true,
    });
  });

  it("depois de criar, leva o foco ao passo seguinte e avisa uma vez que reabriu o projeto", async () => {
    state.call.mockResolvedValue({ projectId: "p1", reused: true });
    open();
    fireEvent.change(screen.getByLabelText("Nome do aplicativo"), {
      target: { value: "ERP Loja" },
    });
    fireEvent.click(button("Criar projeto e continuar"));
    await waitFor(() => expect(state.navigate).toHaveBeenCalled());
    cleanup();
    resume();
    expect(screen.getByText(/Ele foi reaberto, sem criar outro/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("2. Empresas e permissões"),
    );
    cleanup();
    resume();
    expect(screen.queryByText(/Ele foi reaberto/)).toBeNull();
    // A plain visit does not move the focus.
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    ["PROJECT_CONFLICT", /referência já está em uso/],
    ["RATE_LIMITED", /Muitas tentativas/],
    ["QUOTA_EXCEEDED", /limite do plano/],
  ])("explica a recusa %s da criação", async (code, message) => {
    state.call.mockRejectedValue(refusal(code));
    open();
    fireEvent.change(screen.getByLabelText("Nome do aplicativo"), { target: { value: "ERP" } });
    fireEvent.click(button("Criar projeto e continuar"));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("não mostra projeto de outra organização ou sem acesso", () => {
    state.queries["projects:get"] = null;
    open(admin, "p-de-outra");
    expect(screen.getByText("Projeto indisponível.")).toBeTruthy();
  });

  it("lê as empresas numa só consulta, sem uma assinatura por empresa", () => {
    resume({
      candidates: [demo, declared(), candidate("c3", "Empresa Jatobá", { kind: "declared" })],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa Ipê" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa Jatobá" }));
    expect(state.asked).toContain("projects:grantCandidates");
    expect(state.asked).not.toContain("projects:offeredEnvironments");
    expect(state.asked).not.toContain("projects:companyGrant");
    expect(state.asked).not.toContain("companies:list");
  });

  it("mostra o passo a passo enquanto procura a chave nas páginas seguintes", () => {
    state.status["keys:list"] = "CanLoadMore";
    resume({ grants: [grant("c1", importScopes)], keys: [key({ revokedAt: 1 })] });
    expect(state.loadMore).toHaveBeenCalledWith(50);
    expect(screen.getByText("2. Empresas e permissões")).toBeTruthy();
    expect(screen.getByText("Conferindo as chaves do projeto…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gerar chave" })).toBeNull();
    // The revoked key stays in Chaves de API, not in this list.
    expect(screen.queryByText("Revogada")).toBeNull();
  });

  it("não lê mais páginas de chaves quando a primeira já tem a chave certa", () => {
    state.status["keys:list"] = "CanLoadMore";
    resume({ grants: [grant("c1", importScopes)], keys: [key()] });
    expect(state.loadMore).not.toHaveBeenCalled();
    expect(screen.getByText("Abrir a primeira importação")).toBeTruthy();
  });

  it("limita o desenvolvedor a presets de leitura", () => {
    resume({ project: { grantableScopes: developerScopes } });
    expect(screen.queryByRole("radio", { name: /Importar/ })).toBeNull();
    expect(radio(/Só consultar documentos/).checked).toBe(true);
    expect(screen.getByText(/Seu papel concede só leitura e webhooks/)).toBeTruthy();
  });

  it("não oferece ao desenvolvedor confirmar a alteração de uma concessão com importação", () => {
    resume({
      project: { grantableScopes: developerScopes },
      grants: [grant("c1", importScopes)],
    });
    fireEvent.click(radio(/Consultar documentos e receber webhooks/));
    expect(screen.getByText(/só um proprietário ou administrador pode alterar/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Confirmo estas alterações" })).toBeNull();
    expect(button("Conceder acesso").disabled).toBe(true);
  });

  it("concede uma empresa nova com a versão salva e mostra as permissões exatas", async () => {
    resume({ candidates: [candidate("c1", "Empresa Demonstração", { version: 3 })] });
    expect(button("Conceder acesso").disabled).toBe(true);
    expect(screen.getByText("Escolha pelo menos uma empresa.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa Demonstração" }));
    const exact = screen.getByRole("list", { name: "Permissões que serão concedidas" });
    expect(exact.textContent).toContain("Importar XML documents:import");
    expect(button("Conceder acesso").disabled).toBe(false);
    fireEvent.click(button("Conceder acesso"));
    await waitFor(() =>
      expect(state.call).toHaveBeenCalledWith("projects:grantCompany", {
        organizationId: "org",
        projectId: "p1",
        companyId: "c1",
        scopes: importScopes,
        environments: ["sandbox"],
        expectedVersion: 3,
      }),
    );
  });

  it("o ambiente é o da lateral, sem escolha no formulário", () => {
    resume({ candidates: [demo, declared(["sandbox", "production"])] });
    expect(screen.queryByRole("radio", { name: /^Produção/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Sandbox/ })).toBeNull();
    expect(screen.getByText(/Ambiente: Sandbox, o escolhido na lateral/)).toBeTruthy();
  });

  it("em Produção com só a empresa de demonstração, diz por que não há Produção", () => {
    state.environment = "production";
    resume();
    expect(screen.getByText(/Ambiente: Produção, o escolhido na lateral/)).toBeTruthy();
    expect(screen.getByText(/nenhuma empresa tem a Captura fiscal liberada/)).toBeTruthy();
  });

  it("em Produção no Sandbox, desativa os presets de importação", () => {
    state.environment = "production";
    resume({ candidates: [demo, declared(["sandbox", "production"])] });
    expect(radio(/^Importar XML e consultar/).disabled).toBe(true);
    expect(
      screen.getAllByText(/Indisponível em Produção: esta instalação não atende documents:import/),
    ).toHaveLength(2);
    expect(radio(/Só consultar documentos/).checked).toBe(true);
    expect(
      screen.getByRole("list", { name: "Permissões que serão concedidas" }).textContent,
    ).not.toContain("documents:import");
  });

  it("numa instalação de Produção, não oferece Sandbox nem o texto da captura", () => {
    resume({
      project: { deploymentEnvironment: "production" },
      candidates: [declared(["production"])],
    });
    expect(screen.queryByRole("radio", { name: /Sandbox/ })).toBeNull();
    expect(screen.getByText(/Ambiente: Produção, o único que esta instalação atende/)).toBeTruthy();
    expect(screen.queryByText(/Captura fiscal/)).toBeNull();
  });

  it("retoma uma Produção retirada e bloqueia a chave antes do clique", () => {
    state.environment = "production";
    resume({
      candidates: [declared(["sandbox"])],
      grants: [grant("c2", readScopes, { environments: ["production"], offered: ["sandbox"] })],
    });
    expect(button("Gerar chave").disabled).toBe(true);
    expect(screen.getByText(/Produção não está disponível para Empresa c2/)).toBeTruthy();
  });

  it("mantém visível a empresa retomada que está além da primeira página", () => {
    resume({ candidates: [demo], grants: [grant("c9", importScopes, { kind: "demonstration" })] });
    const box = screen.getByRole("checkbox", { name: "Empresa c9" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText("1 empresa em Sandbox")).toBeTruthy();
  });

  it("ao retomar, mostra a diferença e só amplia a concessão salva com confirmação", async () => {
    state.call.mockRejectedValueOnce(refusal("GRANT_CHANGED"));
    resume({ grants: [grant("c1", ["companies:read"], { version: 5 })] });
    expect(
      (screen.getByRole("checkbox", { name: "Empresa Demonstração" }) as HTMLInputElement).checked,
    ).toBe(true);
    // The saved access matches no preset, so the person sees it as it is.
    expect(radio(/Escolher uma a uma/).checked).toBe(true);
    fireEvent.click(radio(/^Importar XML e consultar/));
    expect(screen.getByText(/adiciona documents:import, documents:read/)).toBeTruthy();
    expect(button("Conceder acesso").disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Confirmo estas alterações" }));
    fireEvent.click(button("Conceder acesso"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/A concessão mudou/);
    expect(state.call).toHaveBeenCalledWith(
      "projects:grantCompany",
      expect.objectContaining({ scopes: importScopes, expectedVersion: 5 }),
    );
  });

  it("trava as escolhas enquanto a chave é gerada", async () => {
    let finish: (value: unknown) => void = () => {};
    state.call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    resume({ grants: [grant("c1", importScopes)] });
    fireEvent.click(button("Gerar chave"));
    await waitFor(() => expect(radio(/Só consultar documentos/).matches(":disabled")).toBe(true));
    await act(async () => finish({ keyId: "k1", secretOnce: "fnfe_sbx_segredo-sintetico" }));
  });

  it("gera a chave uma vez, leva o foco ao segredo e trava as escolhas até guardá-lo", async () => {
    const stored = vi.spyOn(Storage.prototype, "setItem");
    state.call.mockResolvedValue({ keyId: "k1", secretOnce: "fnfe_sbx_segredo-sintetico" });
    const view = resume({ grants: [grant("c1", importScopes)] });
    expect(screen.getByText("As empresas escolhidas já têm esse acesso.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Permissões exatas da chave" })).toBeTruthy();
    fireEvent.click(button("Gerar chave"));
    const secret = (await screen.findByLabelText("Segredo da chave")) as HTMLInputElement;
    expect(secret.value).toBe("fnfe_sbx_segredo-sintetico");
    await waitFor(() => expect(document.activeElement).toBe(secret));
    // The fieldset disables its controls.
    expect(radio(/Só consultar documentos/).matches(":disabled")).toBe(true);
    expect(state.call).toHaveBeenCalledWith(
      "keys:create",
      expect.objectContaining({ scopes: importScopes, environment: "sandbox", companyIds: ["c1"] }),
    );
    expect(stored).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("segredo");
    stored.mockRestore();
    // Once saved, the person's own action leads to the next step's heading.
    state.pages["keys:list"] = [key()];
    view.rerender(<Projects org={admin} contextKey="k" section="connect" projectId="p1" />);
    fireEvent.click(button("Já guardei o segredo"));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("4. Primeira chamada"));
  });

  it("anuncia, sem roubar o foco, um passo que muda por fora", async () => {
    const view = resume({ grants: [grant("c1", importScopes)] });
    const field = screen.getByLabelText("Nome da chave");
    field.focus();
    state.pages["keys:list"] = [key()];
    view.rerender(<Projects org={admin} contextKey="k" section="connect" projectId="p1" />);
    await waitFor(() =>
      expect(screen.getByText("Etapa 4 de 4 agora: Primeira chamada.")).toBeTruthy(),
    );
    expect(document.activeElement?.textContent).not.toBe("4. Primeira chamada");
  });

  it.each([
    ["GRANT_DENIED", /Confira as empresas, os escopos e o ambiente/],
    ["RATE_LIMITED", /Muitas tentativas/],
  ])("explica a recusa %s ao gerar a chave", async (code, message) => {
    state.call.mockRejectedValue(refusal(code));
    resume({ grants: [grant("c1", importScopes)] });
    fireEvent.click(button("Gerar chave"));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(screen.queryByLabelText("Segredo da chave")).toBeNull();
    expect(button("Gerar chave").disabled).toBe(false);
  });

  it("ao retomar com a chave certa, não promete o segredo de novo e aponta a primeira chamada", () => {
    resume({ grants: [grant("c1", importScopes)], keys: [key()] });
    expect(screen.getByText(/O segredo só aparece na criação/)).toBeTruthy();
    expect(screen.getByText("Revogar em Chaves de API")).toBeTruthy();
    expect(screen.getByText("Abrir a primeira importação")).toBeTruthy();
    expect(screen.getByText(/só está pronta quando a primeira chamada der certo/)).toBeTruthy();
    fireEvent.click(button("Gerar outra chave"));
    expect(document.activeElement).toBe(screen.getByLabelText("Nome da chave"));
  });

  it("o nome da chave diz o ambiente da lateral", () => {
    const both = ["sandbox", "production"];
    const setup = () =>
      resume({
        candidates: [declared(both)],
        grants: [grant("c2", readScopes, { environments: both, offered: both })],
      });
    const name = () => (screen.getByLabelText("Nome da chave") as HTMLInputElement).value;
    setup();
    expect(name()).toBe("ERP Loja · Sandbox");
    cleanup();
    state.environment = "production";
    setup();
    expect(name()).toBe("ERP Loja · Produção");
  });

  it("não aproveita uma chave só de leitura para a importação", () => {
    resume({ grants: [grant("c1", importScopes)], keys: [key({ scopes: readScopes })] });
    // Resuming shows the key as it is: read-only, with what the import still needs.
    expect(radio(/Só consultar documentos/).checked).toBe(true);
    expect(screen.getByText(/precisa de documents:import/)).toBeTruthy();
    fireEvent.click(radio(/^Importar XML e consultar/));
    expect(button("Gerar chave")).toBeTruthy();
    expect(screen.queryByText("Abrir a primeira importação")).toBeNull();
  });

  it("trata a chave revogada como ausente e oferece gerar outra", () => {
    resume({ grants: [grant("c1", importScopes)], keys: [key({ revokedAt: 1 })] });
    expect(screen.queryByText("Revogada")).toBeNull();
    expect(screen.getByText("Chaves de API")).toBeTruthy();
    expect(button("Gerar chave")).toBeTruthy();
    expect(screen.queryByText("Abrir a primeira importação")).toBeNull();
  });

  it("escreve o plural de empresas", () => {
    resume({
      candidates: [demo, candidate("c3", "Empresa Jatobá")],
      grants: [grant("c1", importScopes), grant("c3", importScopes, { kind: "demonstration" })],
    });
    expect(screen.getByText("2 empresas em Sandbox")).toBeTruthy();
  });
  it("deixa desmarcar a empresa escolhida que perdeu o acesso", () => {
    const view = resume({ grants: [grant("c1", importScopes)] });
    state.pages["projects:companies"] = [];
    state.pages["projects:grantCandidates"] = [];
    view.rerender(<Projects org={admin} contextKey="k" section="connect" projectId="p1" />);
    expect(screen.getByText(/Sem acesso a esta empresa, ou a concessão foi removida/)).toBeTruthy();
    expect(button("Conceder acesso").disabled).toBe(true);
    expect(screen.getByText(/Você não tem mais acesso a Empresa Demonstração/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa Demonstração" }));
    expect(screen.queryByRole("checkbox", { name: "Empresa Demonstração" })).toBeNull();
    expect(screen.getByText("Escolha pelo menos uma empresa.")).toBeTruthy();
  });

  it("deixa desmarcar a empresa escolhida que ficou fora da página carregada", () => {
    state.status["projects:grantCandidates"] = "CanLoadMore";
    const view = resume({ candidates: [demo], grants: [grant("c9", importScopes)] });
    state.pages["projects:companies"] = [];
    view.rerender(<Projects org={admin} contextKey="k" section="connect" projectId="p1" />);
    expect(screen.getByText(/Fora das empresas carregadas/)).toBeTruthy();
    expect(screen.getByText(/Carregue mais empresas abaixo para conferir Empresa c9/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Empresa c9" }));
    expect(screen.queryByRole("checkbox", { name: "Empresa c9" })).toBeNull();
  });

  it("mantém o segredo na tela se uma lista recomeça a carregar", async () => {
    state.call.mockResolvedValue({ keyId: "k1", secretOnce: "fnfe_sbx_segredo-sintetico" });
    const view = resume({ grants: [grant("c1", importScopes)] });
    fireEvent.click(button("Gerar chave"));
    await screen.findByLabelText("Segredo da chave");
    state.status["keys:list"] = "LoadingFirstPage";
    state.status["projects:companies"] = "LoadingFirstPage";
    state.pages["keys:list"] = [];
    state.pages["projects:companies"] = [];
    view.rerender(<Projects org={admin} contextKey="k" section="connect" projectId="p1" />);
    expect((screen.getByLabelText("Segredo da chave") as HTMLInputElement).value).toBe(
      "fnfe_sbx_segredo-sintetico",
    );
    expect(screen.queryByText("Conferindo o que já foi configurado…")).toBeNull();
  });
});
