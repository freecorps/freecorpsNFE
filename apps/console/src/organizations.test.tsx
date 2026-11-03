// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import {
  OrganizationHome,
  OrganizationFrame,
  OrganizationSettingsRoute,
  organizationSlugPattern,
  suggestSlug,
} from "./organizations";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  context: undefined as unknown,
  capabilities: undefined as unknown,
  invitations: [] as unknown[],
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => state.params,
  useSearch: () => ({}),
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
// The organization's pages read their lists through the query cache, without a Convex client
// here; one invitation for the revocation dialog, nothing else.
vi.mock("./convex-query", async (original) => ({
  ...(await original<typeof import("./convex-query")>()),
  OrganizationQueryCache: ({ children }: { children: React.ReactNode }) => children,
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results: getFunctionName(fn) === "invitations:list" ? state.invitations : [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));
vi.mock("convex/react", () => ({
  useConvexConnectionState: () => ({ isWebSocketConnected: true, connectionCount: 1 }),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
    ({
      "organizations:context": state.context,
      "account:capabilities": state.capabilities,
    })[getFunctionName(fn)],
}));
afterEach(() => {
  cleanup();
  state.params = {};
  state.context = undefined;
  state.capabilities = undefined;
  state.invitations = [];
});

describe("endereço da organização", () => {
  // Same rule as organizations.create on the server.
  const server = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
  it("usa um pattern que o navegador compila com a flag v", () => {
    const browser = new RegExp(`^(?:${organizationSlugPattern})$`, "v");
    for (const value of ["abc", "minha-equipe", "a1-b2", "x".repeat(48)])
      expect([value, browser.test(value)]).toEqual([value, true]);
    for (const value of ["ab", "-abc", "abc-", "Abc", "a b c", "ação", "x".repeat(49)])
      expect([value, browser.test(value)]).toEqual([value, server.test(value)]);
  });

  it("sugere o endereço sem acento, em minúsculas e com hífens", () => {
    expect(suggestSlug("Faturamento Jatobá")).toBe("faturamento-jatoba");
    expect(suggestSlug("  Ação & Cia. Ltda.  ")).toBe("acao-cia-ltda");
    expect(suggestSlug("Équipe São João")).toBe("equipe-sao-joao");
    expect(suggestSlug(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });

  it("acompanha o nome até a pessoa editar o endereço à mão", () => {
    render(<OrganizationHome />);
    const name = screen.getByLabelText("Nome da organização");
    const slug = screen.getByLabelText("Endereço da organização") as HTMLInputElement;
    expect(slug.getAttribute("pattern")).toBe(organizationSlugPattern);
    fireEvent.change(name, { target: { value: "Padaria Pão Quente" } });
    expect(slug.value).toBe("padaria-pao-quente");
    fireEvent.change(slug, { target: { value: "padaria" } });
    fireEvent.change(name, { target: { value: "Padaria Pão Quente Ltda" } });
    expect(slug.value).toBe("padaria");
  });
});

describe("seções de configurações", () => {
  const context = (manage: boolean) => ({
    id: "org",
    slug: "equipe",
    name: "Equipe",
    role: manage ? "owner" : "viewer",
    membershipVersion: 1,
    closure: null,
    termsOfUse: null,
    capabilities: {
      manageMembers: manage,
      manageOrganization: manage,
      manageIntegrations: manage,
      importDocuments: manage,
    },
  });

  it("responde página não encontrada para uma seção inexistente", () => {
    state.params = { organizationSlug: "equipe", section: "inexistente" };
    state.context = context(true);
    render(
      <OrganizationFrame view="settings">
        <OrganizationSettingsRoute />
      </OrganizationFrame>,
    );
    expect(screen.getByRole("heading", { name: "Página não encontrada." })).toBeTruthy();
    expect(screen.queryByText(/indisponível para seu papel/)).toBeNull();
  });

  it("mantém a falta de permissão distinta para uma seção existente", () => {
    state.params = { organizationSlug: "equipe", section: "members" };
    state.context = context(false);
    render(
      <OrganizationFrame view="settings">
        <OrganizationSettingsRoute />
      </OrganizationFrame>,
    );
    expect(
      screen.getByRole("heading", { name: "Página indisponível para seu papel." }),
    ).toBeTruthy();
    expect(screen.queryByText("Página não encontrada.")).toBeNull();
  });
});

describe("convidar uma pessoa segue o e-mail de convites (#538)", () => {
  const promise = /O e-mail só será enviado quando você confirmar abaixo/;
  const explanation = "Este painel não envia convites.";
  function revocationText() {
    fireEvent.click(screen.getByRole("button", { name: "Revogar convite" }));
    const dialog = screen.getByRole("alertdialog");
    return within(dialog).getByText(/O link e o código deixam de valer na hora\./).textContent;
  }
  function renderMembers(invitationEmail: boolean | undefined, withInvitation = true) {
    state.params = { organizationSlug: "equipe", section: "members" };
    state.context = {
      id: "org",
      slug: "equipe",
      name: "Equipe",
      role: "owner",
      membershipId: "m",
      membershipVersion: 1,
      memberCount: 1,
      ownerCount: 1,
      closure: null,
      termsOfUse: null,
      capabilities: {
        manageMembers: true,
        manageOrganization: true,
        manageIntegrations: true,
        operateDocuments: true,
        readDocuments: true,
      },
    };
    state.invitations = withInvitation
      ? [
          {
            id: "inv",
            email: "convidada@exemplo.invalid",
            role: "viewer",
            status: "pending",
            expiresAt: Date.UTC(2026, 10, 1),
          },
        ]
      : [];
    state.capabilities =
      invitationEmail === undefined
        ? undefined
        : {
            registration: invitationEmail,
            emailRecovery: invitationEmail,
            invitationEmail,
            emailChange: invitationEmail,
          };
    render(
      <OrganizationFrame view="settings">
        <OrganizationSettingsRoute />
      </OrganizationFrame>,
    );
  }

  it("com e-mail (Cloudflare ou perfil local), promete o envio e oferece o formulário", () => {
    renderMembers(true);
    expect(screen.getByRole("heading", { name: "Convidar uma pessoa" })).toBeTruthy();
    expect(screen.getByText(promise)).toBeTruthy();
    expect(screen.getByLabelText("E-mail da pessoa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar convite" })).toBeTruthy();
    expect(screen.queryByText(explanation)).toBeNull();
    expect(revocationText()).toBe(
      "O link e o código deixam de valer na hora. Para convidar de novo, envie outro convite.",
    );
  });

  it("sem e-mail, explica que o painel não envia convites e não oferece o envio", () => {
    renderMembers(false);
    expect(screen.getByRole("heading", { name: "Convidar uma pessoa" })).toBeTruthy();
    expect(screen.getByText(explanation)).toBeTruthy();
    expect(
      screen.getByText(
        "O código do convite só chega à pessoa por e-mail, e este painel não envia e-mails de conta. Para convidar alguém, peça a quem administra o painel que ative o envio de e-mails de conta.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(promise)).toBeNull();
    expect(screen.queryByLabelText("E-mail da pessoa")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviar convite" })).toBeNull();
    // The list of invitations already created stays.
    expect(screen.getByRole("heading", { name: "Convites" })).toBeTruthy();
    expect(revocationText()).toBe("O link e o código deixam de valer na hora.");
  });

  it("a lista vazia só fala de convites enviados quando o painel envia", () => {
    renderMembers(true, false);
    expect(
      screen.getByRole("heading", { name: "Nenhum convite enviado nesta organização." }),
    ).toBeTruthy();
    expect(screen.getByText(/Os convites enviados aparecem aqui/)).toBeTruthy();
    cleanup();
    renderMembers(false, false);
    expect(screen.getByRole("heading", { name: "Nenhum convite nesta organização." })).toBeTruthy();
    expect(screen.queryByText(/enviado/)).toBeNull();
  });

  it("enquanto o servidor não respondeu, não afirma nem o envio nem a falta dele", () => {
    renderMembers(undefined);
    expect(screen.getByRole("heading", { name: "Convidar uma pessoa" })).toBeTruthy();
    expect(screen.getByText("Carregando as opções de convite…")).toBeTruthy();
    expect(screen.queryByText(promise)).toBeNull();
    expect(screen.queryByText(explanation)).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviar convite" })).toBeNull();
    // Only an explicit `false` drops the hint to send another invitation.
    expect(revocationText()).toBe(
      "O link e o código deixam de valer na hora. Para convidar de novo, envie outro convite.",
    );
  });
});

describe("lista de organizações segue o e-mail de convites (#538)", () => {
  it("com e-mail, oferece aceitar um convite", () => {
    state.capabilities = {
      registration: true,
      emailRecovery: true,
      invitationEmail: true,
      emailChange: true,
    };
    render(<OrganizationHome />);
    expect(screen.getByText("Aceitar um convite").getAttribute("href")).toBe("/accept-invitation");
    expect(
      screen.getByText(
        "Use o formulário para criar uma organização ou aceite o convite da sua equipe.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Você será o primeiro proprietário e poderá convidar outras pessoas."),
    ).toBeTruthy();
  });

  it("sem e-mail, não oferece convite nem o promete", () => {
    state.capabilities = {
      registration: false,
      emailRecovery: false,
      invitationEmail: false,
      emailChange: false,
    };
    render(<OrganizationHome />);
    expect(screen.queryByText("Aceitar um convite")).toBeNull();
    expect(screen.getByText("Use o formulário para criar uma organização.")).toBeTruthy();
    expect(screen.getByText("Você será o primeiro proprietário.")).toBeTruthy();
    expect(screen.queryByText(/convite/)).toBeNull();
  });
});
