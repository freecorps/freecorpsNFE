// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: "/app/equipe",
  organizations: [] as Array<{ id: string; slug: string; name: string; role: string }>,
  capabilities: undefined as
    | {
        registration: boolean;
        emailRecovery: boolean;
        invitationEmail: boolean;
        emailChange: boolean;
      }
    | undefined,
  /** What `deployment.environments` answers for the open organization. */
  environments: ["sandbox"] as string[],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    onClick,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    onClick?: () => void;
    className?: string;
    "aria-current"?: "page";
    "aria-label"?: string;
  }) => {
    let href = to;
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    return (
      <a
        href={href}
        className={className}
        aria-current={rest["aria-current"]}
        aria-label={rest["aria-label"]}
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
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({
    results: state.organizations,
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: (query: unknown, args: unknown) =>
    args === "skip"
      ? undefined
      : getFunctionName(query as never) === "deployment:environments"
        ? state.environments
        : state.capabilities,
}));

import { AppShell, sectionRoot, useShellOrganization, type ShellOrganization } from "./app-shell";
import type { Organization } from "./organizations";

const org = {
  id: "org",
  name: "Equipe Ipê",
  slug: "equipe",
  role: "operator",
  membershipId: "m",
  membershipVersion: 1,
  memberCount: 3,
  ownerCount: 1,
  closure: null,
  termsOfUse: null,
  capabilities: {
    manageOrganization: false,
    manageMembers: false,
    manageIntegrations: false,
    operateDocuments: true,
    readDocuments: true,
  },
} as unknown as Organization;

function OrganizationPage({ onSwitch }: { onSwitch: () => void }) {
  const value = useMemo<ShellOrganization>(
    () => ({ org, contextKey: "k", current: "documents", onSwitch }),
    [onSwitch],
  );
  useShellOrganization(value);
  return <h1>Documentos</h1>;
}
function renderShell(
  children: React.ReactNode = <h1>Organizações</h1>,
  signOut = vi.fn(),
  environment: string | null = "Desenvolvimento local",
) {
  render(
    <AppShell
      account={{ name: "Ana Sintética", role: "Conta verificada" }}
      tools={{ diagnostics: false, prototype: false, components: false }}
      environment={environment ?? undefined}
      version="abcdef1234"
      onSignOut={signOut}
      signingOut={false}
    >
      {children}
    </AppShell>,
  );
  return signOut;
}

beforeEach(() => {
  state.navigate = vi.fn();
  state.environments = ["sandbox"];
  sessionStorage.clear();
  state.pathname = "/app";
  state.organizations = [
    { id: "org", slug: "equipe", name: "Equipe Ipê", role: "operator" },
    { id: "org2", slug: "jatoba", name: "Jatobá Serviços", role: "owner" },
  ];
  state.capabilities = {
    registration: true,
    emailRecovery: true,
    invitationEmail: true,
    emailChange: true,
  };
  localStorage.clear();
});
afterEach(() => cleanup());

describe("shell do console", () => {
  it("o indicador leva o perfil do build no texto e no título, quando há um", () => {
    renderShell();
    const badge = document.querySelector(".app-env");
    expect(badge?.getAttribute("title")).toBe("Desenvolvimento local · Versão abcdef1");
    expect(badge?.textContent).toBe("SandboxEmissão sem validade fiscal · Desenvolvimento local");
  });

  it("sem perfil (installation, #517), o indicador mostra só o deployment e a versão", () => {
    renderShell(undefined, undefined, null);
    const badge = document.querySelector(".app-env");
    expect(badge?.getAttribute("title")).toBe("Versão abcdef1");
    expect(badge?.textContent).toBe("SandboxEmissão sem validade fiscal");
  });

  it("sem organização: marca, destinos gerais, ambiente e o menu da conta com tema e saída", () => {
    const signOut = renderShell();
    expect(screen.getByRole("link", { name: "Freecorps Fiscal, início" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Navegação do console" });
    expect(
      within(nav).getByRole("link", { name: "Organizações" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText("Sandbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /menu da conta/ }));
    const themes = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(themes).toEqual(["Claro", "Escuro", "Sistema"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("fnfe:console-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /menu da conta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sair" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  describe("Aceitar convite segue o e-mail de convites (#538)", () => {
    function offered() {
      const nav = screen.getByRole("navigation", { name: "Navegação do console" });
      const link = within(nav).queryByRole("link", { name: "Aceitar convite" });
      fireEvent.click(screen.getByRole("button", { name: /menu da conta/ }));
      const item = screen.queryByRole("menuitem", { name: "Aceitar convite" });
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      fireEvent.change(screen.getByRole("combobox", { name: "Buscar telas e ações" }), {
        target: { value: "aceitar convite" },
      });
      const option = screen.queryByRole("option", { name: /Aceitar convite/ });
      return { link: !!link, menu: !!item, palette: !!option };
    }

    it("com e-mail, a lateral, o menu da conta e a paleta oferecem o convite", () => {
      renderShell();
      expect(offered()).toEqual({ link: true, menu: true, palette: true });
    });

    it("sem e-mail, nenhum deles oferece o convite", () => {
      state.capabilities = {
        registration: false,
        emailRecovery: false,
        invitationEmail: false,
        emailChange: false,
      };
      renderShell();
      expect(offered()).toEqual({ link: false, menu: false, palette: false });
    });

    it("enquanto o servidor não respondeu, a entrada continua", () => {
      state.capabilities = undefined;
      renderShell();
      expect(offered()).toEqual({ link: true, menu: true, palette: true });
    });
  });

  it("com organização: seletor no topo, menu pelo papel e troca que desmonta antes de navegar", () => {
    state.pathname = "/app/equipe/documents";
    const onSwitch = vi.fn();
    renderShell(<OrganizationPage onSwitch={onSwitch} />);
    const switcher = screen.getByRole("button", { name: /^Organização atual: Equipe Ipê/ });
    const nav = screen.getByRole("navigation", { name: "Navegação da organização" });
    expect(within(nav).getByRole("link", { name: "Documentos" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Importar XML" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Membros" })).toBeNull();
    fireEvent.click(switcher);
    const current = screen.getByRole("menuitemradio", { name: /Equipe Ipê/ });
    expect(current.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(current);
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.click(switcher);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Jatobá Serviços/ }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/app/$organizationSlug",
      params: { organizationSlug: "jatoba" },
    });
  });

  it("⌘K abre a paleta com as ações do papel; Enter navega", () => {
    state.pathname = "/app/equipe/documents";
    renderShell(<OrganizationPage onSwitch={vi.fn()} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByRole("combobox", { name: "Buscar telas e ações" });
    fireEvent.change(input, { target: { value: "nova emissao" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/app/$organizationSlug/issuances",
      params: { organizationSlug: "equipe" },
      search: { view: "new" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Buscar ou ir para" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "membros" } });
    // Operator does not manage members: the palette follows the same menu by role.
    expect(screen.queryByRole("option", { name: /Membros/ })).toBeNull();
  });

  it("a gaveta prende o conteúdo atrás e fecha com Esc, devolvendo o foco", () => {
    renderShell();
    const open = screen.getByRole("button", { name: "Abrir menu" });
    fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".app-shell")?.getAttribute("data-drawer")).toBe("open");
    expect(document.getElementById("main")?.hasAttribute("inert")).toBe(true);
    const sidebar = screen.getByRole("complementary", { name: "Menu do console" });
    expect(sidebar.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelector(".app-shell")?.getAttribute("data-drawer")).toBe("closed");
    expect(document.activeElement).toBe(open);
  });

  it("sem Produção oferecida, não há seletor: só o selo do Sandbox", () => {
    state.pathname = "/app/equipe/documents";
    renderShell(<OrganizationPage onSwitch={vi.fn()} />);
    expect(screen.queryByRole("radiogroup", { name: "Ambiente do console" })).toBeNull();
    expect(screen.getByText("Sandbox")).toBeTruthy();
    expect(document.querySelector(".app-shell")?.getAttribute("data-environment")).toBe("sandbox");
  });

  it("o seletor troca o console inteiro e volta ao início da seção", () => {
    state.environments = ["sandbox", "production"];
    state.pathname = "/app/equipe/companies/abc";
    renderShell(<OrganizationPage onSwitch={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: "Ambiente do console" });
    const sandbox = within(group).getByRole("radio", { name: "Sandbox" });
    const production = within(group).getByRole("radio", { name: "Produção" });
    // Opens in the Sandbox: nobody lands in Produção without choosing it.
    expect(sandbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Emissão sem validade fiscal")).toBeTruthy();
    fireEvent.click(production);
    expect(production.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Notas reais da captura fiscal")).toBeTruthy();
    expect(document.querySelector(".app-shell")?.getAttribute("data-environment")).toBe(
      "production",
    );
    expect(state.navigate).toHaveBeenCalledWith({ href: "/app/equipe/companies" });
    // The keyboard moves between the two, like any radio group.
    state.navigate.mockClear();
    fireEvent.keyDown(production, { key: "ArrowLeft" });
    expect(sandbox.getAttribute("aria-checked")).toBe("true");
    expect(state.navigate).toHaveBeenCalledTimes(1);
    // Choosing the environment already chosen does nothing.
    state.navigate.mockClear();
    fireEvent.click(sandbox);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("uma Produção que deixa de ser oferecida volta ao Sandbox", () => {
    state.environments = ["sandbox", "production"];
    sessionStorage.setItem("fnfe:console-env:org", "production");
    state.pathname = "/app/equipe/documents";
    renderShell(<OrganizationPage onSwitch={vi.fn()} />);
    expect(document.querySelector(".app-shell")?.getAttribute("data-environment")).toBe(
      "production",
    );
    cleanup();
    state.environments = ["sandbox"];
    renderShell(<OrganizationPage onSwitch={vi.fn()} />);
    expect(document.querySelector(".app-shell")?.getAttribute("data-environment")).toBe("sandbox");
  });
});

describe("início da seção ao trocar de ambiente", () => {
  it("guarda a seção, e a subseção de configurações e de integrações", () => {
    expect(sectionRoot("/app/equipe")).toBe("/app/equipe");
    expect(sectionRoot("/app/equipe/documents")).toBe("/app/equipe/documents");
    expect(sectionRoot("/app/equipe/companies/abc")).toBe("/app/equipe/companies");
    expect(sectionRoot("/app/equipe/imports/danfe")).toBe("/app/equipe/imports");
    expect(sectionRoot("/app/equipe/developer/webhooks/p1")).toBe("/app/equipe/developer/webhooks");
    expect(sectionRoot("/app/equipe/settings/members")).toBe("/app/equipe/settings/members");
    expect(sectionRoot("/app")).toBeNull();
    expect(sectionRoot("/console/diagnostico")).toBeNull();
  });
});
