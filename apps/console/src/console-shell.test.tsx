// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  navigate: vi.fn(),
  queries: {} as Record<string, unknown>,
  actions: {} as Record<string, (args: unknown) => Promise<unknown>>,
  mutations: {} as Record<string, (args: unknown) => Promise<unknown>>,
  paginated: {} as Record<string, unknown[]>,
  convexAuth: { isAuthenticated: false, isLoading: false },
  auth: {
    signUp: vi.fn(),
    verify: vi.fn(),
    signIn: vi.fn(),
    resend: vi.fn(),
    recover: vi.fn(),
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
    onClick?: () => void;
    "aria-current"?: "page";
    className?: string;
  }) => {
    let href = to;
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter((entry): entry is [string, string] => !!entry[1]),
    ).toString();
    return (
      <a
        href={query ? `${href}?${query}` : href}
        aria-current={rest["aria-current"]}
        className={rest.className}
        onClick={(event) => {
          event.preventDefault();
          onClick?.();
        }}
      >
        {children}
      </a>
    );
  },
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  useParams: () => state.params,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => state.convexAuth,
  useConvexConnectionState: () => ({ isWebSocketConnected: true, connectionCount: 1 }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results: state.paginated[getFunctionName(fn)] ?? [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) =>
    state.mutations[getFunctionName(fn)] ?? vi.fn(),
  useAction: (fn: Parameters<typeof getFunctionName>[0]) =>
    state.actions[getFunctionName(fn)] ?? vi.fn(),
}));
vi.mock("./auth", () => ({
  authClient: {
    signUp: { email: state.auth.signUp },
    signIn: { email: state.auth.signIn },
    emailOtp: {
      verifyEmail: state.auth.verify,
      sendVerificationOtp: state.auth.resend,
      requestPasswordReset: state.auth.recover,
      resetPassword: vi.fn(),
    },
  },
}));

import {
  afterLoginHref,
  captureInvitationLink,
  forgetOrganization,
  hasPendingInvitation,
  homeHref,
  rememberEmail,
  rememberOrganization,
  safeRedirect,
  takePendingInvitation,
} from "./session-handoff";
import { OrganizationNavigation } from "./organization-navigation";
import { OrganizationStart } from "./organization-home";
import { AccountForm } from "./account-forms";
import { taskEntryHref, taskOnTheWay, taskSearch } from "./console-task";
import {
  AcceptInvitation,
  OrganizationFrame,
  OrganizationHome,
  OrganizationSettingsRoute,
  type Organization,
} from "./organizations";

const code = "ab".repeat(32);
function org(role: Organization["role"]): Organization {
  const manager = role === "owner" || role === "admin";
  return {
    id: "org" as Organization["id"],
    name: "Equipe Ipê",
    slug: "equipe",
    role,
    membershipId: "m" as Organization["membershipId"],
    membershipVersion: 1,
    memberCount: 3,
    ownerCount: 1,
    closure: null,
    termsOfUse: null,
    capabilities: {
      manageOrganization: manager,
      manageMembers: manager,
      manageIntegrations: manager || role === "developer",
      operateDocuments: manager || role === "operator",
      readDocuments: role !== "developer",
    },
  };
}
beforeEach(() => {
  state.search = {};
  state.params = {};
  state.queries = {
    "account:capabilities": {
      registration: true,
      emailRecovery: true,
      invitationEmail: true,
      emailChange: true,
    },
  };
  state.actions = {};
  state.mutations = {};
  state.paginated = {};
  state.navigate = vi.fn();
  state.convexAuth = { isAuthenticated: false, isLoading: false };
  for (const fn of Object.values(state.auth)) fn.mockReset();
  rememberEmail("");
  takePendingInvitation();
});
afterEach(() => cleanup());

describe("passagem em memória entre as telas de conta", () => {
  it("lê o convite do fragmento e o tira do endereço", () => {
    window.history.replaceState(
      null,
      "",
      `/accept-invitation?origem=email#code=${code.toUpperCase()}`,
    );
    captureInvitationLink(window.location, window.history);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/accept-invitation?origem=email",
    );
    expect(hasPendingInvitation()).toBe(true);
    expect(takePendingInvitation()).toBe(code);
    expect(takePendingInvitation()).toBe("");
    expect(
      [localStorage, sessionStorage].some((storage) =>
        Object.keys(storage).some((key) => storage.getItem(key)?.includes(code)),
      ),
    ).toBe(false);
  });

  it("aceita o código antigo na query, também removido, e ignora outras páginas", () => {
    window.history.replaceState(null, "", `/accept-invitation?code=${code}`);
    captureInvitationLink(window.location, window.history);
    expect(window.location.search).toBe("");
    expect(takePendingInvitation()).toBe(code);
    window.history.replaceState(null, "", `/login#code=${code}`);
    captureInvitationLink(window.location, window.history);
    expect(hasPendingInvitation()).toBe(false);
  });

  it("volta do login à página do console que pediu, com a consulta, nunca a outro lugar", () => {
    for (const value of [
      "/accept-invitation",
      "/app",
      "/app/",
      "/app/equipe",
      "/app/equipe/documents",
      "/app/equipe/documents?company=k57abc&status=cancelled&from=2026-09-01",
      "/app/equipe/documents?company=k57abc&key=nfse%3A3550308%3A11222333000181%3A1%3A42",
      "/app/equipe/issuances?company=k57abc&issuance=j97xyz",
      "/app/equipe/developer/keys/p1?company=c1",
      "/console",
      "/console/diagnostico",
      "/accept-invitation?origem=email",
      // The task entry of the landing (#510, `taskEntryHref`).
      "/console?tarefa=importar",
      // URL-safe, so it passes; the console home keeps only a known `tarefa` (`taskSearch`).
      "/console?tarefa=x&redirect=%2F%2Fevil.example",
    ])
      expect([value, safeRedirect(value)]).toEqual([value, value]);
    for (const value of [
      "//evil.example",
      "///evil.example",
      "https://evil.example/app",
      "javascript:alert(1)",
      "/\\evil.example",
      "/app\\..\\login",
      "/app/../login",
      "/app/./equipe",
      "/app//evil.example",
      "/app/%2F%2Fevil.example",
      "/app/%5Cevil.example",
      "/app%2F..%2Flogin",
      "/login",
      "/signup",
      "/docs/",
      "/accept-invitation/x",
      "/accept-invitation#code=x",
      "/app?x=1#frag",
      "/app?next=//evil.example\\x",
      "/app?x=%0d%0aSet-Cookie:1",
      "/app?x=%00",
      "/app?x=%5C",
      "/app?x=%E0%A4%A",
      "/app?x=<script>",
      "/app?x=a b",
      "/console?tarefa=x&redirect=//evil.example",
      "/console?tarefa=importar%0d%0aSet-Cookie:1",
      "/console?tarefa=importar%0A",
      "/console?tarefa=javascript:alert(1)",
      "javascript:/console?tarefa=importar",
      "//evil.example/console?tarefa=importar",
      "/app\n",
      " /app",
      "app",
      "",
      `/app/${"a".repeat(600)}`,
      42,
      null,
      undefined,
    ])
      expect([value, safeRedirect(value)]).toEqual([value, undefined]);
  });

  it("abre a última organização deste navegador, só por um endereço válido", () => {
    localStorage.clear();
    expect(homeHref()).toBe("/console");
    expect(afterLoginHref(undefined)).toBe("/console");
    rememberOrganization("equipe-ipe");
    expect(homeHref()).toBe("/app/equipe-ipe");
    expect(afterLoginHref(undefined)).toBe("/app/equipe-ipe");
    expect(afterLoginHref("/app/outra/documents?company=c1")).toBe(
      "/app/outra/documents?company=c1",
    );
    // Storage is not trusted: anything other than an organization address opens the home.
    for (const forged of ["//evil.example", "../login", "EQUIPE", "a", "equipe/../x"]) {
      localStorage.setItem("fnfe:console-organization", forged);
      expect([forged, homeHref()]).toEqual([forged, "/console"]);
    }
    forgetOrganization();
    expect(homeHref()).toBe("/console");
  });
});

describe("menu da organização por papel", () => {
  const items = () => screen.getAllByRole("link").map((link) => link.textContent?.trim() ?? "");
  it("o developer não vê as telas fiscais que o papel não usa", () => {
    render(<OrganizationNavigation org={org("developer")} current="overview" />);
    expect(items()).toEqual(["Início", "Empresas", "Municípios e NCM", "Projetos e chaves"]);
  });
  it("a leitura vê documentos, emissões e exportações, sem importar", () => {
    render(<OrganizationNavigation org={org("viewer")} current="overview" />);
    expect(items()).toEqual([
      "Início",
      "Documentos",
      "Emissão NFS-e",
      "Exportações",
      "Empresas",
      "Municípios e NCM",
    ]);
  });
  it("o operador importa; o proprietário vê também a gestão", () => {
    render(<OrganizationNavigation org={org("owner")} current="onboarding" />);
    expect(items()).toContain("Importar XML");
    expect(items()).toContain("Membros");
    expect(items()).not.toContain("Primeiros passos");
    expect(screen.getByRole("link", { name: "Início" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("Início", () => {
  const summary = {
    environment: "sandbox",
    companies: { count: 1, truncated: false },
    month: {
      issuances: { authorized: 3, processing: 1, rejected: 1, cancelled: 0 },
      received: 7,
      failedImports: 1,
      partial: false,
    },
    pending: [
      {
        kind: "certificate-expiring",
        companyId: "c1",
        companyName: "Ipê Serviços",
        recordId: null,
        at: Date.UTC(2026, 9, 20),
      },
      {
        kind: "issuance-rejected",
        companyId: "c1",
        companyName: "Ipê Serviços",
        recordId: "i1",
        at: Date.UTC(2026, 9, 9),
      },
      {
        kind: "import-failed",
        companyId: "c1",
        companyName: "Ipê Serviços",
        recordId: "b1",
        at: Date.UTC(2026, 9, 8),
      },
    ],
    tasks: homeTasks(),
  };
  it("mostra a tarefa, as pendências com links diretos e as contagens do mês", () => {
    state.queries["consoleHome:summary"] = summary;
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.getByRole("heading", { level: 1, name: "Início" })).toBeTruthy();
    expect(screen.queryByText(/organizado/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Preparar a emissão" })).toBeNull();
    expect(screen.getByRole("heading", { name: /Importar XML/ })).toBeTruthy();
    // Projects and grants belong to integrations, never to the console path (ADR 0005).
    expect(screen.queryByText(/concess/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Abrir empresa/ }).getAttribute("href")).toBe(
      "/app/equipe/companies/c1?aba=certificado",
    );
    expect(screen.getByRole("link", { name: /Ver rejeição/ }).getAttribute("href")).toBe(
      "/app/equipe/issuances?company=c1&issuance=i1",
    );
    expect(screen.getByRole("link", { name: /Ver importação/ }).getAttribute("href")).toBe(
      "/app/equipe/imports?company=c1&batch=b1",
    );
    expect(screen.getByText("Certificado vencendo")).toBeTruthy();
    expect(screen.getByText("Documentos recebidos").nextElementSibling?.textContent).toBe("7");
  });
  it("mostra a captura em Produção parada e conta os documentos de Produção (#422)", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      month: { ...summary.month, production: { received: 3 } },
      pending: [
        {
          kind: "capture-attention",
          companyId: "c1",
          companyName: "Ipê Serviços",
          recordId: "s1",
          at: Date.UTC(2026, 9, 9),
          code: "SOURCE_CONSUMPTION_BLOCKED",
        },
        {
          kind: "capture-quiet",
          companyId: "c2",
          companyName: "Jatobá Comércio",
          recordId: "s2",
          at: Date.UTC(2026, 8, 10, 12),
        },
      ],
    };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(screen.getByText("Captura fiscal (Produção) em atenção")).toBeTruthy();
    // The reason, in the panel's words (#432).
    expect(
      screen.getByText(/Ipê Serviços · A Receita bloqueou por cerca de uma hora as consultas/)
        .textContent,
    ).toMatch(/Confira o que fazer na captura\.$/);
    expect(screen.getByText("Captura fiscal (Produção) sem consulta")).toBeTruthy();
    expect(screen.getByText(/sem consulta respondida desde 10\/09\/2026/)).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: /Abrir captura/ }).map((l) => l.getAttribute("href")),
    ).toEqual(["/app/equipe/companies/c1?aba=captura", "/app/equipe/companies/c2?aba=captura"]);
    expect(
      screen.getByText("Documentos recebidos no sandbox").nextElementSibling?.textContent,
    ).toBe("7");
    expect(
      screen.getByText("Documentos recebidos em Produção").nextElementSibling?.textContent,
    ).toBe("3");
  });
  it("diz que a Freecorps pausou a captura quando o servidor marca o corte (#601)", () => {
    const item = {
      kind: "capture-attention",
      companyName: "Ipê Serviços",
      recordId: "s1",
      at: Date.UTC(2026, 9, 9),
      code: "ACCESS_REVOKED",
    };
    state.queries["consoleHome:summary"] = {
      ...summary,
      pending: [
        { ...item, companyId: "c1", freecorpsCut: true },
        { ...item, companyId: "c2", companyName: "Jatobá Comércio", recordId: "s2" },
      ],
    };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(screen.getByText(/Ipê Serviços · A Freecorps pausou a captura fiscal/)).toBeTruthy();
    // The same code without the mark is a real loss of access, in the words it always had.
    expect(
      screen.getByText(/Jatobá Comércio · Mudou o acesso que mantinha a captura/),
    ).toBeTruthy();
  });
  // ADR 0010: the free tier's Production stops on the notes limit; another quota keeps its words.
  it("diz que a pausa veio do limite de notas quando o servidor marca a cota de notas", () => {
    const item = {
      kind: "capture-attention",
      recordId: "s1",
      at: Date.UTC(2026, 9, 9),
      code: "QUOTA_EXCEEDED",
    };
    state.queries["consoleHome:summary"] = {
      ...summary,
      pending: [
        { ...item, companyId: "c1", companyName: "Ipê Serviços", notesQuota: true },
        { ...item, companyId: "c2", companyName: "Jatobá Comércio", recordId: "s2" },
        // A plan that counts notes, stopped by another of its limits: no quota named.
        {
          ...item,
          companyId: "c3",
          companyName: "Cedro Indústria",
          recordId: "s3",
          countsNotes: true,
        },
      ],
    };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(
      screen.getByText(
        /Ipê Serviços · A organização chegou ao limite de notas novas do mês em Produção\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Cedro Indústria · A organização chegou a um limite do plano neste período\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Jatobá Comércio · A organização chegou ao limite de consultas do plano/),
    ).toBeTruthy();
  });
  it("na captura de uma integração, diz que a integração retoma (#607)", () => {
    const item = {
      kind: "capture-attention",
      recordId: "s1",
      at: Date.UTC(2026, 9, 9),
      code: "ACCESS_REVOKED",
      freecorpsCut: true,
    };
    state.queries["consoleHome:summary"] = {
      ...summary,
      pending: [
        {
          ...item,
          companyId: "c1",
          companyName: "Ipê Serviços",
          origin: { kind: "integration", integration: "ERP Serra" },
        },
        {
          ...item,
          companyId: "c2",
          companyName: "Jatobá Comércio",
          origin: { kind: "integration", integration: null },
        },
        {
          ...item,
          companyId: "c3",
          companyName: "Cedro Indústria",
          origin: { kind: "console", integration: null },
        },
        // Not a resume: what to do stays in the capture.
        {
          ...item,
          companyId: "c4",
          companyName: "Ingá Logística",
          code: "BATCH_UNAVAILABLE",
          freecorpsCut: false,
          origin: { kind: "integration", integration: "ERP Serra" },
        },
        // The Receita's block: wait first, as the panel says (the server refuses a resume now).
        {
          ...item,
          companyId: "c5",
          companyName: "Angico Agro",
          code: "SOURCE_CONSUMPTION_BLOCKED",
          freecorpsCut: false,
          origin: { kind: "integration", integration: "ERP Serra" },
        },
        // Without a code: the panel's resume, by the integration.
        {
          ...item,
          companyId: "c6",
          companyName: "Ipê Roxo",
          code: undefined,
          freecorpsCut: false,
          origin: { kind: "integration", integration: null },
        },
      ],
    };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(screen.getByText(/Ipê Roxo · /).textContent).toBe(
      "Ipê Roxo · a captura parou e não consulta a Receita até alguém agir. A integração que ativou a captura precisa retomá-la, com a ação resume em POST /v1/connections/nfe. Confira o que fazer na captura.",
    );
    expect(screen.getByText(/Ipê Serviços · A Freecorps pausou/).textContent).toMatch(
      /A integração “ERP Serra” precisa retomar a captura, com a ação resume em POST \/v1\/connections\/nfe\. Confira o que fazer na captura\.$/,
    );
    expect(screen.getByText(/Jatobá Comércio · A Freecorps pausou/).textContent).toMatch(
      /A integração que ativou a captura precisa retomá-la, com a ação resume em POST \/v1\/connections\/nfe\. Confira o que fazer na captura\.$/,
    );
    expect(screen.getByText(/Angico Agro · /).textContent).toMatch(
      /Espere uma hora\. .* A integração “ERP Serra” precisa retomar a captura, com a ação resume em POST \/v1\/connections\/nfe\. Confira o que fazer na captura\.$/,
    );
    expect(screen.getByText(/Cedro Indústria · A Freecorps pausou/).textContent).toMatch(
      /Confira o que fazer na captura\.$/,
    );
    expect(screen.getByText(/Ingá Logística · /).textContent).toMatch(
      /Confira o que fazer na captura\.$/,
    );
  });
  it("diz quando não há pendências", () => {
    state.queries["consoleHome:summary"] = { ...summary, pending: [] };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(screen.getByText(/Nenhuma pendência/)).toBeTruthy();
    // A viewer does not import: no header action, and the step says who does.
    expect(screen.queryByRole("link", { name: /Importar XML/ })).toBeNull();
  });
  it("põe as pendências antes da tarefa e diz quantas são", () => {
    state.queries["consoleHome:summary"] = summary;
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    const pending = screen.getByRole("region", { name: "Pendências" });
    const task = screen.getByRole("region", { name: "Sua tarefa" });
    expect(pending.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pending).getByText("3 itens precisam de atenção.")).toBeTruthy();
  });
  it("sem pendências, diz que está tudo em dia e guarda o que conferiu num detalhe", () => {
    state.queries["consoleHome:summary"] = { ...summary, pending: [] };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    const pending = screen.getByRole("region", { name: "Pendências" });
    expect(within(pending).getByRole("heading", { name: "Tudo em dia" })).toBeTruthy();
    const details = within(pending)
      .getByText(/nenhum certificado vencendo/)
      .closest("details")!;
    expect(details.open).toBe(false);
    // The task comes first when nothing is pending.
    const task = screen.getByRole("region", { name: "Sua tarefa" });
    expect(task.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("agrupa o mês por emissões, documentos e importações, cada grupo com sua lista", () => {
    state.queries["consoleHome:summary"] = summary;
    render(<OrganizationStart org={org("operator")} contextKey="k" />);
    const issuances = screen.getByRole("region", { name: "Emissões NFS-e" });
    expect(within(issuances).getByText("Autorizadas").nextElementSibling?.textContent).toBe("3");
    expect(within(issuances).getByText("Rejeitadas").nextElementSibling?.textContent).toBe("1");
    expect(
      within(issuances)
        .getByRole("link", { name: /Ver emissões/ })
        .getAttribute("href"),
    ).toBe("/app/equipe/issuances");
    const imports = screen.getByRole("region", { name: "Importações" });
    expect(within(imports).getByText("Importações com falha").parentElement?.className).toBe(
      "is-danger",
    );
    // The shortcuts repeated the menu; the recent records took their place.
    expect(screen.queryByRole("heading", { name: "Atalhos" })).toBeNull();
  });
  it("dobra a tarefa concluída em uma linha e volta à escolha em Trocar de tarefa", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        import: {
          ...homeTask(true, ["company", "done", "demo"], ["document", "done", "demo"]),
          demonstrationCompanyId: "demo",
        },
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trocar de tarefa" }));
    const chooser = screen.getByRole("radiogroup", { name: "Tarefa" });
    expect(document.activeElement).toBe(
      within(chooser).getByRole("radio", { name: /Importar XML/ }),
    );
    expect(screen.queryByRole("button", { name: "Trocar de tarefa" })).toBeNull();
    // "Fechar" folds it again and gives the focus back to the button that opened it.
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Trocar de tarefa" }));
  });
  it("mostra os documentos e as importações mais recentes da empresa lembrada", () => {
    localStorage.setItem("fnfe:console-company:org", "c1");
    state.queries["consoleHome:summary"] = summary;
    state.queries["consoleCompany:context"] = {
      id: "c1",
      name: "Ipê Serviços",
      cnpj: "12345678000195",
      kind: "declared",
      canRead: true,
      canWrite: true,
      canManage: true,
    };
    state.queries["documents:list"] = {
      page: [
        {
          id: "d1",
          model: "nfe",
          key: "k1",
          kind: "nfe",
          importedAt: Date.UTC(2026, 10, 2, 15),
          issuedAt: "2026-11-02",
          number: "3049",
          issuer: "Elétrica Campinas",
          total: "4514.13",
          fiscalStatus: "authorized",
        },
      ],
      nextCursor: null,
      indexing: false,
    };
    state.queries["imports:recent"] = [
      {
        id: "b1",
        createdAt: Date.UTC(2026, 10, 2, 15),
        origin: { kind: "console" },
        files: [
          { state: "succeeded", code: "IMPORTED" },
          { state: "succeeded", code: "XML_SCHEMA_UNSUPPORTED" },
        ],
      },
    ];
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    const recent = screen.getByRole("region", { name: "Recentes" });
    expect(within(recent).getByText("O que chegou por último em Ipê Serviços.")).toBeTruthy();
    expect(within(recent).getByRole("link", { name: "NF-e 3049" }).getAttribute("href")).toBe(
      "/app/equipe/documents?company=c1&env=sandbox&document=d1",
    );
    expect(within(recent).getByText(/Elétrica Campinas · R\$/)).toBeTruthy();
    expect(within(recent).getByText("Autorizada")).toBeTruthy();
    const batch = within(recent).getByRole("link", { name: /^2 arquivos em/ });
    expect(batch.getAttribute("href")).toBe("/app/equipe/imports?company=c1&batch=b1");
    expect(within(recent).getByText("1 importado · 1 recusado")).toBeTruthy();
  });
  it("não mostra as importações recentes a quem não importa", () => {
    localStorage.setItem("fnfe:console-company:org", "c1");
    state.queries["consoleHome:summary"] = { ...summary, pending: [] };
    state.queries["consoleCompany:context"] = {
      id: "c1",
      name: "Ipê Serviços",
      cnpj: "12345678000195",
      kind: "declared",
      canRead: true,
      canWrite: false,
      canManage: false,
    };
    state.queries["documents:list"] = { page: [], nextCursor: null, indexing: false };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    const recent = screen.getByRole("region", { name: "Recentes" });
    expect(within(recent).getByText("Nenhum documento recebido nesta empresa ainda.")).toBeTruthy();
    expect(within(recent).queryByRole("region", { name: "Últimas importações" })).toBeNull();
  });
  it("leva o developer às integrações, sem dados fiscais", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      month: null,
      pending: [],
      tasks: { import: null, issue: null, capture: null, integrate: homeTasks().integrate },
    };
    render(<OrganizationStart org={org("developer")} contextKey="k" />);
    expect(screen.queryByText("Neste mês")).toBeNull();
    expect(screen.queryByRole("link", { name: /Documentos/ })).toBeNull();
    // Only its task: no chooser, the integration steps and the header's action.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText(/Seu papel trabalha pelas integrações/)).toBeTruthy();
    expect(headerAction()?.textContent).toBe("Abrir integrações");
    expect(screen.getByRole("link", { name: /Criar o projeto/ }).getAttribute("href")).toBe(
      "/app/equipe/developer/projects",
    );
    expect(stepState("Criar o projeto de integração")).toBe("Próxima etapa");
    expect(stepState("Criar uma chave de API")).toBe("Aguardando");
  });
});

type StepRow = [key: string, state: string, companyId?: string | null, reason?: string];
const homeTask = (complete: boolean, ...rows: StepRow[]) => ({
  complete,
  steps: rows.map(([key, state, companyId = null, reason]) => ({
    key,
    state,
    companyId,
    ...(reason ? { reason } : {}),
  })),
});
/** `consoleHome.summary.tasks` of an owner who has a demonstration company and a declared one. */
function homeTasks(overrides: Record<string, unknown> = {}) {
  return {
    import: {
      ...homeTask(
        false,
        ["company", "done", "demo"],
        ["permission", "done"],
        ["document", "todo", "demo"],
      ),
      demonstrationCompanyId: "demo",
    },
    issue: homeTask(
      false,
      ["company", "done", "c1"],
      ["permission", "done"],
      ["certificate", "todo", "c1"],
      ["profile", "todo", "c1"],
    ),
    capture: homeTask(
      false,
      ["company", "done", "c1"],
      ["certificate", "todo", "c1"],
      ["authorize", "blocked", "c1", "previous"],
      ["start", "blocked", "c1", "previous"],
    ),
    integrate: homeTask(false, ["project", "todo"], ["key", "blocked", null, "previous"]),
    ...overrides,
  };
}
/** The badge of a step, found by its title: beside the title, outside its element. */
function stepState(title: string) {
  return screen.getByText(title).parentElement?.querySelector(".ui-badge")?.textContent;
}
function stepItem(title: string) {
  return screen.getByText(title).closest("li")!;
}
const headerAction = () =>
  document.querySelector(".ui-page-header a.ui-button--primary") as HTMLAnchorElement | null;
const storedTask = () => localStorage.getItem("fnfe:console-task:equipe");

describe("Início por tarefa (#510)", () => {
  const summary = {
    environment: "sandbox",
    companies: { count: 2, truncated: false },
    month: {
      issuances: { authorized: 0, processing: 0, rejected: 0, cancelled: 0 },
      received: 0,
      production: null,
      failedImports: 0,
      partial: false,
    },
    pending: [],
    tasks: homeTasks(),
  };
  const checked = () =>
    (screen.getAllByRole("radio") as HTMLInputElement[]).find((radio) => radio.checked)?.value;
  beforeEach(() => {
    localStorage.clear();
    state.queries["consoleHome:summary"] = summary;
  });

  it("na primeira visita, começa por importar e leva ao XML de exemplo", () => {
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.getByRole("radiogroup", { name: "Tarefa" })).toBeTruthy();
    expect(checked()).toBe("importar");
    expect(headerAction()?.textContent).toBe("Importar XML");
    expect(headerAction()?.getAttribute("href")).toBe("/app/equipe/imports?company=demo");
    // No certificate, profile or project on the way to the first import.
    expect(screen.queryByText("Enviar o certificado A1")).toBeNull();
    expect(screen.queryByText("Criar o projeto de integração")).toBeNull();
    expect(stepState("Escolher a empresa")).toBe("Concluída");
    expect(stepState("Importar o primeiro XML")).toBe("Próxima etapa");
    expect(stepItem("Importar o primeiro XML").getAttribute("aria-current")).toBe("step");
    expect(
      screen.getByRole("link", { name: /Importar o XML de exemplo/ }).getAttribute("href"),
    ).toBe("/app/equipe/imports?company=demo");
    // A done permission says nothing.
    expect(screen.queryByText("Permissão para importar")).toBeNull();
    expect(screen.getByRole("radio", { name: /Importar XML/ }).closest("label")?.textContent).toBe(
      "Importar XMLFalta 1 etapa",
    );
  });

  it("começa o developer pelas integrações e o leitor e o operador pela importação", () => {
    localStorage.setItem("fnfe:console-task:equipe", "importar");
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: { import: null, issue: null, capture: null, integrate: summary.tasks.integrate },
    };
    render(<OrganizationStart org={org("developer")} contextKey="k" />);
    // A stored task the role does not work on is ignored.
    expect(headerAction()?.textContent).toBe("Abrir integrações");
    expect(screen.getByRole("heading", { name: /Integrar meu sistema/ })).toBeTruthy();
    cleanup();
    localStorage.clear();
    state.queries["consoleHome:summary"] = summary;
    for (const role of ["viewer", "operator"] as const) {
      render(<OrganizationStart org={org(role)} contextKey="k" />);
      expect(checked()).toBe("importar");
      cleanup();
    }
  });

  it("no retorno, abre a última tarefa escolhida neste navegador", () => {
    localStorage.setItem("fnfe:console-task:equipe", "capturar");
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(checked()).toBe("capturar");
    expect(headerAction()?.textContent).toBe("Abrir captura");
    expect(headerAction()?.getAttribute("href")).toBe("/app/equipe/companies/c1?aba=captura");
    expect(stepState("Enviar o certificado A1")).toBe("Próxima etapa");
    expect(screen.getByRole("link", { name: /Enviar o certificado/ }).getAttribute("href")).toBe(
      "/app/equipe/companies/c1?aba=certificado",
    );
    // Authorizing and starting stay distinct, after the step they wait for, without a link.
    for (const title of ["Autorizar a captura", "Iniciar a captura"]) {
      expect(stepState(title)).toBe("Aguardando");
      expect(stepItem(title).className).toBe("is-later");
      expect(stepItem(title).textContent).toContain("Disponível depois da etapa anterior.");
      expect(stepItem(title).querySelector("a")).toBeNull();
    }
  });

  it("a tarefa da URL vence a lembrada e passa a ser a lembrada", () => {
    localStorage.setItem("fnfe:console-task:equipe", "capturar");
    state.search = { tarefa: "emitir" };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(checked()).toBe("emitir");
    expect(storedTask()).toBe("emitir");
    // Without the profile, an issuance would be refused: the header follows the next step.
    expect(headerAction()?.textContent).toBe("Enviar o certificado");
    expect(headerAction()?.getAttribute("href")).toBe("/app/equipe/companies/c1?aba=certificado");
    expect(screen.queryByText("Nova emissão simulada")).toBeNull();
    expect(screen.getByText(/Sandbox simulado: a emissão não vai ao fisco/)).toBeTruthy();
    // Certificate and profile wait for nobody else: both are links, the first is the next one.
    expect(stepState("Enviar o certificado A1")).toBe("Próxima etapa");
    expect(stepState("Configurar o perfil NFS-e")).toBe("Pendente");
    expect(screen.getByRole("link", { name: /Configurar o perfil/ }).getAttribute("href")).toBe(
      "/app/equipe/companies/c1?aba=fiscal",
    );
  });

  it("ignora tarefa desconhecida na URL e no navegador", () => {
    localStorage.setItem("fnfe:console-task:equipe", "excluir");
    state.search = { tarefa: "<script>" };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(checked()).toBe("importar");
    expect(storedTask()).toBe("excluir");
  });

  it("trocar de tarefa lembra a escolha e muda a ação do cabeçalho", async () => {
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    fireEvent.click(screen.getByRole("radio", { name: /Integrar meu sistema/ }));
    await waitFor(() => expect(checked()).toBe("integrar"));
    expect(storedTask()).toBe("integrar");
    expect(headerAction()?.textContent).toBe("Abrir integrações");
    // Without `?tarefa=`, the address stays as it is.
    expect(state.navigate).not.toHaveBeenCalled();
    cleanup();
    state.search = { tarefa: "importar" };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    fireEvent.click(screen.getByRole("radio", { name: /Capturar NF-e/ }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/app/$organizationSlug",
        params: { organizationSlug: "equipe" },
        search: { tarefa: "capturar" },
        replace: true,
      }),
    );
    expect(storedTask()).toBe("capturar");
  });

  it("diz ao leitor quem pode importar, sem ação no cabeçalho", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        import: {
          ...homeTask(
            false,
            ["company", "done", "c1"],
            ["permission", "blocked", null, "role"],
            ["document", "blocked", "c1", "role"],
          ),
          demonstrationCompanyId: null,
        },
      }),
    };
    render(<OrganizationStart org={org("viewer")} contextKey="k" />);
    expect(headerAction()).toBeNull();
    // Nothing of it is the viewer's to do: no count of steps, in the chooser or the heading.
    expect(screen.getByRole("radio", { name: /Importar XML/ }).closest("label")?.textContent).toBe(
      "Importar XMLDepende de outro papel",
    );
    expect(
      screen.getByRole("heading", { name: "Importar XML" }).nextElementSibling?.textContent,
    ).toBe("Depende de outro papel");
    expect(stepState("Permissão para importar")).toBe("Bloqueada");
    expect(stepItem("Permissão para importar").textContent).toContain(
      "Seu papel é Leitura. Importar XML exige papel de Operador, Administrador ou Proprietário.",
    );
    expect(stepItem("Importar o primeiro XML").textContent).toContain(
      "Operador, Administrador ou Proprietário importa o primeiro XML.",
    );
    expect(screen.queryByRole("link", { name: /Importar/ })).toBeNull();
  });

  it("diz ao operador sem empresa que a empresa vem de quem administra", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      companies: { count: 0, truncated: false },
      tasks: homeTasks({
        import: {
          ...homeTask(
            false,
            ["company", "blocked", null, "no-company"],
            ["permission", "done"],
            ["document", "blocked", null, "previous"],
          ),
          demonstrationCompanyId: null,
        },
      }),
    };
    render(<OrganizationStart org={org("operator")} contextKey="k" />);
    expect(stepState("Escolher a empresa")).toBe("Bloqueada");
    expect(stepItem("Escolher a empresa").textContent).toContain(
      "Nenhuma empresa liberada para você. Proprietário ou Administrador cadastra a empresa",
    );
    expect(stepState("Importar o primeiro XML")).toBe("Aguardando");
    expect(screen.queryByRole("link", { name: /primeiros passos/ })).toBeNull();
    // Without a company there is nothing it could import: no header action.
    expect(headerAction()).toBeNull();
  });

  it("leva o gestor sem empresa aos primeiros passos", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        import: {
          ...homeTask(
            false,
            ["company", "todo"],
            ["permission", "done"],
            ["document", "blocked", null, "previous"],
          ),
          demonstrationCompanyId: null,
        },
      }),
    };
    render(<OrganizationStart org={org("admin")} contextKey="k" />);
    expect(stepItem("Escolher a empresa").querySelector("a")?.getAttribute("href")).toBe(
      "/app/equipe/onboarding",
    );
    // The header leads to the next step, not to an import screen without a company.
    expect([headerAction()?.textContent, headerAction()?.getAttribute("href")]).toEqual([
      "Abrir os primeiros passos",
      "/app/equipe/onboarding",
    ]);
  });

  it("não oferece nova emissão a quem só tem a empresa de demonstração", () => {
    state.search = { tarefa: "emitir" };
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        issue: homeTask(
          false,
          ["company", "todo"],
          ["permission", "done"],
          ["profile", "blocked", null, "previous"],
        ),
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect([headerAction()?.textContent, headerAction()?.getAttribute("href")]).toEqual([
      "Cadastrar a empresa",
      "/app/equipe/companies",
    ]);
    expect(screen.queryByText("Nova emissão simulada")).toBeNull();
    // The simulated sandbox stays said next to the task.
    expect(screen.getByText(/Sandbox simulado: a emissão não vai ao fisco/)).toBeTruthy();
  });

  it("não oferece nova emissão enquanto falta o perfil NFS-e", () => {
    state.search = { tarefa: "emitir" };
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        issue: homeTask(
          false,
          ["company", "done", "c1"],
          ["permission", "done"],
          ["certificate", "done", "c1"],
          ["profile", "todo", "c1"],
        ),
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect([headerAction()?.textContent, headerAction()?.getAttribute("href")]).toEqual([
      "Configurar o perfil",
      "/app/equipe/companies/c1?aba=fiscal",
    ]);
    expect(screen.queryByText("Nova emissão simulada")).toBeNull();
    cleanup();
    // The operator issues but does not configure the profile: nothing it could open now.
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        issue: homeTask(
          false,
          ["company", "done", "c1"],
          ["permission", "done"],
          ["certificate", "done", "c1"],
          ["profile", "blocked", "c1", "role"],
        ),
      }),
    };
    render(<OrganizationStart org={org("operator")} contextKey="k" />);
    expect(headerAction()).toBeNull();
    expect(screen.getByRole("radio", { name: /Emitir NFS-e/ }).closest("label")?.textContent).toBe(
      "Emitir NFS-e (simulada)Depende de outro papel",
    );
  });

  it("mantém a tarefa da URL ao voltar ao Início sem ?tarefa=", () => {
    state.search = { tarefa: "emitir" };
    const view = render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(checked()).toBe("emitir");
    state.search = {};
    view.rerender(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(checked()).toBe("emitir");
  });

  it("avisa quando as etapas consideram só parte das empresas", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      companies: { count: 10, truncated: true },
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.getByText(/Etapas calculadas sobre as 10 primeiras empresas/)).toBeTruthy();
  });

  it("funciona sem armazenamento do navegador", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      render(<OrganizationStart org={org("owner")} contextKey="k" />);
      expect(checked()).toBe("importar");
      fireEvent.click(screen.getByRole("radio", { name: /Capturar NF-e/ }));
      await waitFor(() => expect(checked()).toBe("capturar"));
      expect(set).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("explica a captura bloqueada pela Freecorps, por papel ou indisponível", () => {
    localStorage.setItem("fnfe:console-task:equipe", "capturar");
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        capture: homeTask(
          false,
          ["company", "done", "c1"],
          ["certificate", "done", "c1"],
          ["authorize", "blocked", "c1", "freecorps"],
          ["start", "blocked", "c1", "previous"],
        ),
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(stepItem("Autorizar a captura").textContent).toContain(
      "A Freecorps bloqueou a captura desta empresa. Fale com o suporte",
    );
    cleanup();
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        capture: homeTask(
          false,
          ["company", "done", "c1"],
          ["certificate", "done", "c1"],
          ["authorize", "blocked", "c1", "role"],
          ["start", "blocked", "c1", "previous"],
        ),
      }),
    };
    render(<OrganizationStart org={org("operator")} contextKey="k" />);
    expect(stepItem("Autorizar a captura").textContent).toContain(
      "Seu papel é Operador. Proprietário ou Administrador autoriza a captura.",
    );
    cleanup();
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        capture: homeTask(
          false,
          ...["company", "certificate", "authorize", "start"].map((key): StepRow => [
            key,
            "unavailable",
            null,
            "deployment",
          ]),
        ),
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.getByText("A captura de NF-e não está disponível neste ambiente.")).toBeTruthy();
    expect(document.querySelector(".home-steps")).toBeNull();
    // Nothing to open where the deployment does not offer the task.
    expect(headerAction()).toBeNull();
    expect(screen.getByRole("radio", { name: /Capturar NF-e/ }).closest("label")?.textContent).toBe(
      "Capturar NF-eIndisponível neste ambiente",
    );
  });

  it("mostra a tarefa concluída com o próximo passo útil", () => {
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        import: {
          ...homeTask(
            true,
            ["company", "done", "demo"],
            ["permission", "done"],
            ["document", "done", "demo"],
          ),
          demonstrationCompanyId: "demo",
        },
      }),
    };
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    // The heading is the task's name alone; its badge stands beside it.
    const heading = screen.getByRole("heading", { name: "Importar XML" });
    expect(heading.textContent).toBe("Importar XML");
    expect(heading.nextElementSibling?.textContent).toBe("Concluída");
    expect(screen.getByText(/Tarefa concluída\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ver os documentos/ }).getAttribute("href")).toBe(
      "/app/equipe/documents?company=demo",
    );
    expect(screen.queryByText("Próxima etapa")).toBeNull();
    // The steps stay one click away, collapsed.
    const details = stepItem("Importar o primeiro XML").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Ver as etapas");
  });

  it("muda a ação do cabeçalho com a tarefa e a esconde de quem não age nela", () => {
    const expected = {
      importar: ["Importar XML", "/app/equipe/imports?company=demo"],
      emitir: ["Nova emissão simulada", "/app/equipe/issuances?company=c1&view=new"],
      capturar: ["Abrir captura", "/app/equipe/companies/c1?aba=captura"],
      integrar: ["Abrir integrações", "/app/equipe/developer/projects"],
    };
    // With the profile saved, the issuance is one click away.
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        issue: homeTask(
          false,
          ["company", "done", "c1"],
          ["permission", "done"],
          ["certificate", "todo", "c1"],
          ["profile", "done", "c1"],
        ),
      }),
    };
    for (const [tarefa, [label, href]] of Object.entries(expected)) {
      state.search = { tarefa };
      render(<OrganizationStart org={org("owner")} contextKey="k" />);
      expect([headerAction()?.textContent, headerAction()?.getAttribute("href")]).toEqual([
        label,
        href,
      ]);
      cleanup();
    }
    // The operator neither manages integrations nor sees an action for them.
    state.search = { tarefa: "integrar" };
    state.queries["consoleHome:summary"] = {
      ...summary,
      tasks: homeTasks({
        integrate: homeTask(
          false,
          ["project", "blocked", null, "role"],
          ["key", "blocked", null, "role"],
        ),
      }),
    };
    render(<OrganizationStart org={org("operator")} contextKey="k" />);
    expect(headerAction()).toBeNull();
    expect(stepItem("Criar o projeto de integração").textContent).toContain(
      "Proprietário, Administrador ou Desenvolvedor cria a integração.",
    );
  });

  it("não mostra ação no cabeçalho enquanto o resumo carrega", () => {
    delete state.queries["consoleHome:summary"];
    render(<OrganizationStart org={org("owner")} contextKey="k" />);
    expect(screen.getByText("Carregando o resumo…")).toBeTruthy();
    expect(headerAction()).toBeNull();
  });
});

describe("cadastro e verificação", () => {
  it("valida em português, campo a campo, sem o balão do navegador", async () => {
    render(<AccountForm mode="signup" />);
    const form = screen.getByRole("button", { name: "Criar conta" }).closest("form")!;
    expect(form.noValidate).toBe(true);
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "sem-arroba" } });
    fireEvent.submit(form);
    expect(await screen.findByText("Informe seu nome.")).toBeTruthy();
    expect(screen.getByText("Confira o e-mail. Use o formato nome@empresa.com.br.")).toBeTruthy();
    expect(screen.getByText("Informe sua senha.")).toBeTruthy();
    expect(screen.getByLabelText("Seu nome").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Seu nome"));
    expect(state.auth.signUp).not.toHaveBeenCalled();
  });

  it("continua no mesmo cartão até verificar e entra sozinho, de volta ao convite", async () => {
    state.search = { redirect: "/accept-invitation" };
    state.auth.signUp.mockResolvedValue({ data: {}, error: null });
    state.auth.verify.mockResolvedValue({ data: {}, error: null });
    state.auth.signIn.mockResolvedValue({ data: {}, error: null });
    render(<AccountForm mode="signup" />);
    fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail"), {
      target: { value: "ana@development.invalid" },
    });
    fireEvent.change(screen.getByLabelText("Senha"), {
      target: { value: "frase longa de teste 123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByText(/Se ainda não houver uma conta com este e-mail/)).toBeTruthy();
    expect(screen.queryByText(/sem confirmação/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Código de oito dígitos"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar e-mail" }));
    await waitFor(() =>
      expect(state.auth.signIn).toHaveBeenCalledWith({
        email: "ana@development.invalid",
        password: "frase longa de teste 123",
      }),
    );
    expect(state.auth.verify).toHaveBeenCalledWith({
      email: "ana@development.invalid",
      otp: "12345678",
    });
    expect(state.navigate).toHaveBeenCalledWith({ href: "/accept-invitation", replace: true });
  });

  it("preenche o e-mail na verificação e manda ao login quando não pode entrar", async () => {
    rememberEmail("bia@development.invalid");
    state.auth.verify.mockResolvedValue({ data: {}, error: null });
    render(<AccountForm mode="verify-email" />);
    expect((screen.getByLabelText("E-mail") as HTMLInputElement).value).toBe(
      "bia@development.invalid",
    );
    fireEvent.change(screen.getByLabelText("Código de oito dígitos"), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar e-mail" }));
    expect(await screen.findByText("O código tem oito dígitos, só números.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Código de oito dígitos"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar e-mail" }));
    expect(
      await screen.findByText("E-mail verificado. Entre com sua senha para continuar."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Entrar" })).toBeTruthy();
    expect(state.auth.signIn).not.toHaveBeenCalled();
  });

  it("responde à recuperação do mesmo jeito, exista ou não a conta", async () => {
    state.auth.recover.mockResolvedValue({ data: { requestAccepted: true }, error: null });
    render(<AccountForm mode="forgot-password" />);
    fireEvent.change(screen.getByLabelText("E-mail"), {
      target: { value: "c@development.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Solicitar código" }));
    expect(
      await screen.findByText(/Se houver uma conta com este e-mail, enviamos um código/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Informar código de recuperação" })).toBeTruthy();
  });
});

describe("tarefa pelo cadastro (#510)", () => {
  it("leva adiante só uma tarefa conhecida, nunca o resto da consulta", () => {
    expect(taskSearch("importar")).toEqual({ tarefa: "importar" });
    expect(taskSearch("integrar")).toEqual({ tarefa: "integrar" });
    for (const value of [
      "x",
      "Importar",
      "importar ",
      "//evil.example",
      ["importar"],
      1,
      undefined,
    ])
      expect([value, taskSearch(value)]).toEqual([value, {}]);
    // The `validateSearch` of `/console` and `/app`: the rest of the query never follows.
    expect(taskOnTheWay({ tarefa: "importar", redirect: "//x" })).toEqual({ tarefa: "importar" });
    expect(taskOnTheWay({ tarefa: "x", redirect: "//x", company: "k57" })).toEqual({});
    expect(taskOnTheWay({})).toEqual({});
    expect(taskEntryHref("emitir")).toBe("/signup?redirect=%2Fconsole%3Ftarefa%3Demitir");
  });

  it("com sessão aberta, o cadastro vai direto ao destino, com a tarefa", () => {
    state.convexAuth = { isAuthenticated: true, isLoading: false };
    state.search = { redirect: "/console?tarefa=importar" };
    render(<AccountForm mode="signup" />);
    expect(screen.queryByRole("button", { name: "Criar conta" })).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      href: "/console?tarefa=importar",
      replace: true,
    });
  });

  it("sem sessão, o cadastro abre o formulário e entra no destino depois da verificação", async () => {
    state.search = { redirect: "/console?tarefa=importar" };
    state.auth.signUp.mockResolvedValue({ data: {}, error: null });
    state.auth.verify.mockResolvedValue({ data: {}, error: null });
    // The login after the verification opens the session: the card, already past the form
    // (`done`), must not navigate a second time for the open session.
    state.auth.signIn.mockImplementation(async () => {
      state.convexAuth = { isAuthenticated: true, isLoading: false };
      return { data: {}, error: null };
    });
    const { rerender } = render(<AccountForm mode="signup" />);
    fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail"), {
      target: { value: "ana@development.invalid" },
    });
    fireEvent.change(screen.getByLabelText("Senha"), {
      target: { value: "frase longa de teste 123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    fireEvent.change(await screen.findByLabelText("Código de oito dígitos"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar e-mail" }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        href: "/console?tarefa=importar",
        replace: true,
      }),
    );
    expect(state.convexAuth.isAuthenticated).toBe(true);
    rerender(<AccountForm mode="signup" />);
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it("sem organização, cria a primeira e abre o Início com a tarefa", async () => {
    state.search = { tarefa: "importar" };
    const create = vi.fn().mockResolvedValue({ slug: "padaria" });
    state.mutations["organizations:create"] = create;
    // No version of the terms of use is current (#586): nothing to accept.
    state.queries["termsOfUse:current"] = null;
    render(<OrganizationHome />);
    fireEvent.change(screen.getByLabelText("Nome da organização"), {
      target: { value: "Padaria" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar organização" }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/app/$organizationSlug",
        params: { organizationSlug: "padaria" },
        search: { tarefa: "importar" },
      }),
    );
    expect(create).toHaveBeenCalledWith({ name: "Padaria", slug: "padaria" });
  });

  it("na lista, cada organização abre com a tarefa; uma desconhecida não segue", () => {
    state.paginated["organizations:listMine"] = [
      { id: "o1", name: "Equipe Ipê", slug: "equipe", role: "owner" },
    ];
    state.search = { tarefa: "capturar" };
    render(<OrganizationHome />);
    const list = screen.getByRole("list", { name: "Organizações disponíveis" });
    expect(list.querySelector("a")?.getAttribute("href")).toBe("/app/equipe?tarefa=capturar");
    cleanup();
    state.search = { tarefa: "excluir" };
    render(<OrganizationHome />);
    expect(
      screen
        .getByRole("list", { name: "Organizações disponíveis" })
        .querySelector("a")
        ?.getAttribute("href"),
    ).toBe("/app/equipe");
  });
});

describe("convites", () => {
  it("abre o convite do link sem pedir o código e mostra o campo visível como alternativa", async () => {
    window.history.replaceState(null, "", `/accept-invitation#code=${code}`);
    captureInvitationLink(window.location, window.history);
    const preview = vi.fn().mockResolvedValue({
      organizationName: "Equipe Ipê",
      role: "viewer",
      expiresAt: Date.UTC(2026, 9, 12),
    });
    state.actions["invitations:preview"] = preview;
    render(<AcceptInvitation />);
    expect(await screen.findByRole("heading", { name: "Equipe Ipê" })).toBeTruthy();
    expect(preview).toHaveBeenCalledWith({ token: code });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const field = screen.getByLabelText("Código do convite") as HTMLInputElement;
    expect(field.type).toBe("text");
    fireEvent.change(field, { target: { value: "curto" } });
    fireEvent.click(screen.getByRole("button", { name: /Conferir convite/ }));
    expect(await screen.findByText(/O código tem 64 caracteres/)).toBeTruthy();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("pede confirmação antes de revogar um convite", async () => {
    state.params = { organizationSlug: "equipe", section: "members" };
    state.queries["organizations:context"] = org("owner");
    const revoke = vi.fn().mockResolvedValue(null);
    state.mutations["invitations:revoke"] = revoke;
    state.paginated["invitations:list"] = [
      {
        id: "inv1",
        email: "convidada@development.invalid",
        role: "viewer",
        status: "pending",
        expiresAt: Date.UTC(2026, 9, 12),
      },
    ];
    render(
      <OrganizationFrame view="settings">
        <OrganizationSettingsRoute />
      </OrganizationFrame>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Membros" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revogar convite" }));
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByText(/Revogar o convite de convidada@development.invalid\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Revogar convite" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    });
    expect(revoke).toHaveBeenCalledWith({ organizationId: "org", invitationId: "inv1" });
  });
});
