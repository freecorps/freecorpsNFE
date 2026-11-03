// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { deploymentLabelFor, isLocalProfile, isValidationProfile } from "./environment";

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  queries: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => state.search,
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<typeof import("convex/react")>()),
  ConvexReactClient: class {
    connectionState() {}
    prewarmQuery() {}
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
}));
vi.mock("./auth", () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: async () => ({ data: {}, error: null }) },
  },
}));

const sandbox = { environment: "sandbox", fiscalProduction: false };
const fiscalProduction = { environment: "production", fiscalProduction: true };

/**
 * O login como cada build o compila: `VITE_APP_ENV` entra no bundle, então cada perfil carrega
 * os módulos de novo com a variável do seu build (`scripts/lib/worktree/env-file.mjs`,
 * `scripts/lib/selfhost.mjs`, `scripts/lib/console.mjs`).
 */
async function renderLogin(appEnv: string) {
  vi.resetModules();
  vi.stubEnv("VITE_APP_ENV", appEnv);
  const { Login } = await import("./login");
  return render(createElement(Login)).container;
}

beforeEach(() => {
  state.search = {};
  state.queries = {
    "account:capabilities": {
      registration: true,
      emailRecovery: true,
      invitationEmail: true,
      emailChange: true,
    },
    "deployment:current": sandbox,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("rótulo do perfil do build", () => {
  it("separa os perfis locais e a validação, sem rotular o perfil installation", () => {
    expect(deploymentLabelFor("development")).toBe("Desenvolvimento local");
    expect(deploymentLabelFor("selfhost-local")).toBe("Instalação própria local");
    // `build-hosted` compila com `installation` o serviço da Freecorps e a instalação de um
    // operador: o build não sabe qual dos dois é, e nenhum dos dois ganha rótulo.
    expect(deploymentLabelFor("installation")).toBeUndefined();
    // O console de validação compila sem `VITE_APP_ENV`.
    expect(deploymentLabelFor(undefined)).toBe("Ambiente de validação");
    expect(deploymentLabelFor("")).toBe("Ambiente de validação");
    // Um perfil desconhecido não vira "validação": fica sem rótulo, como `validationProfile`.
    expect(deploymentLabelFor("outro")).toBeUndefined();
    expect(
      [undefined, "", "installation", "development", "outro"].map(isValidationProfile),
    ).toEqual([true, true, false, false, false]);
    expect(
      [undefined, "development", "selfhost-local", "installation"].map(isLocalProfile),
    ).toEqual([false, true, true, false]);
  });
});

describe("login em cada perfil (#517)", () => {
  const profiles = [
    { name: "desenvolvimento local", appEnv: "development", label: "Desenvolvimento local" },
    {
      name: "instalação própria local",
      appEnv: "selfhost-local",
      label: "Instalação própria local",
    },
    // O serviço hospedado da Freecorps e a instalação hospedada de um operador saem do mesmo
    // `selfhost.mjs build-hosted`, com `installation`: o build não distingue os dois, e o mesmo
    // caso cobre ambos.
    { name: "serviço hospedado e instalação própria hospedada", appEnv: "installation" },
  ];
  for (const profile of profiles)
    it(`orienta a entrar no painel, sem aviso fiscal: ${profile.name}`, async () => {
      const page = await renderLogin(profile.appEnv);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Entre no painel.");
      expect(screen.getByRole("button", { name: "Entrar no painel" })).toBeTruthy();
      const text = page.textContent ?? "";
      for (const internal of [
        "validar",
        "Cadastro local",
        "Integrações fiscais",
        "validade fiscal",
        "Sandbox",
        "nenhuma nota sai daqui",
        "conta de teste",
        "mantenedor",
      ])
        expect(text).not.toContain(internal);
      expect(page.querySelector(".app-env")?.textContent).toBe(profile.label);
      if (!profile.label) expect(text).not.toContain("Instalação própria");
      expect(page.textContent).toContain("Versão local");
    });

  it("regressão: o selo do deployment não volta ao login, nem na produção fiscal", async () => {
    state.queries["deployment:current"] = fiscalProduction;
    const page = await renderLogin("installation");
    expect(page.textContent).not.toContain("validade fiscal");
    expect(page.textContent).not.toContain("Produção");
  });
});

describe("cadastro segundo account.capabilities", () => {
  it("com cadastro, oferece criar conta e recuperar a senha", async () => {
    await renderLogin("installation");
    // O cadastro hospedado só atende e-mails da allowlist (`ACCOUNT_EMAIL_RECIPIENTS`).
    expect(
      screen.getByText(
        "Use o e-mail e a senha da sua conta. Crie uma conta se o seu e-mail estiver autorizado neste painel.",
      ),
    ).toBeTruthy();
    for (const link of ["Criar conta", "Verificar e-mail", "Esqueci minha senha"])
      expect(screen.getByRole("link", { name: link })).toBeTruthy();
    expect(screen.queryByText(/não aceita novas contas/)).toBeNull();
  });

  it("sem cadastro, pede uma conta existente sem prometer convite nem troca de senha", async () => {
    state.queries["account:capabilities"] = {
      registration: false,
      emailRecovery: false,
      invitationEmail: false,
      emailChange: false,
    };
    const page = await renderLogin("installation");
    expect(
      screen.getByText(
        "Este painel não aceita novas contas nem recupera a senha por e-mail. Entre com uma conta existente.",
      ),
    ).toBeTruthy();
    // Sem `registration`, o servidor não envia e-mails de conta: um convite não chegaria.
    expect(page.textContent).not.toContain("convite");
    expect(page.textContent).not.toContain("administra");
    expect(screen.queryByRole("link", { name: "Criar conta" })).toBeNull();
  });

  it("enquanto o servidor não responde, não afirma cadastro nem a falta dele", async () => {
    delete state.queries["account:capabilities"];
    const page = await renderLogin("installation");
    expect(screen.getByText("Use o e-mail e a senha da sua conta.")).toBeTruthy();
    expect(page.textContent).not.toContain("novas contas");
    expect(screen.queryByRole("link", { name: "Criar conta" })).toBeNull();
  });

  it("vindo de um convite, pede o e-mail convidado", async () => {
    state.search = { redirect: "/accept-invitation" };
    await renderLogin("installation");
    expect(screen.getByText(/Entre com o e-mail que recebeu o convite\./)).toBeTruthy();
  });
});

describe("validação", () => {
  it("o console de validação, compilado sem perfil, leva o rótulo de validação", async () => {
    const page = await renderLogin("");
    expect(page.querySelector(".app-env")?.textContent).toBe("Ambiente de validação");
    expect(page.textContent).not.toContain("validade fiscal");
  });
});

describe("cadastro com e sem allowlist (#517)", () => {
  // Os perfis locais aceitam qualquer e-mail; os outros, só os de `ACCOUNT_EMAIL_RECIPIENTS`.
  const cases = [
    { appEnv: "development", authorized: false },
    { appEnv: "selfhost-local", authorized: false },
    { appEnv: "installation", authorized: true },
  ];
  for (const { appEnv, authorized } of cases) {
    it(`${appEnv}: o login ${authorized ? "condiciona" : "não condiciona"} o cadastro ao e-mail autorizado`, async () => {
      const page = await renderLogin(appEnv);
      expect(page.textContent?.includes("autorizado") ?? false).toBe(authorized);
      expect(screen.getByRole("link", { name: "Criar conta" })).toBeTruthy();
      if (!authorized)
        expect(screen.getByText(/Se ainda não tem uma, crie a sua abaixo\./)).toBeTruthy();
    });

    it(`${appEnv}: o cadastro ${authorized ? "condiciona" : "não condiciona"} o envio ao e-mail autorizado`, async () => {
      vi.resetModules();
      vi.stubEnv("VITE_APP_ENV", appEnv);
      const { AccountForm } = await import("./account-forms");
      const page = render(createElement(AccountForm, { mode: "signup" })).container;
      expect(page.textContent?.includes("autorizado") ?? false).toBe(authorized);
      fireEvent.change(screen.getByLabelText("Seu nome"), { target: { value: "Ana" } });
      fireEvent.change(screen.getByLabelText("E-mail"), {
        target: { value: "ana@example.invalid" },
      });
      fireEvent.change(screen.getByLabelText("Senha"), {
        target: { value: "frase longa de teste 123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));
      const sent = await screen.findByText(/Se ainda não houver uma conta com este e-mail/);
      expect(sent.textContent?.includes("estiver autorizado neste painel")).toBe(authorized);
    });
  }
});

describe("cartão das telas de conta sem cadastro", () => {
  for (const mode of ["signup", "verify-email", "forgot-password", "reset-password"] as const)
    it(`${mode}: diz o que o painel não faz e volta ao login`, async () => {
      state.queries["account:capabilities"] = {
        registration: false,
        emailRecovery: false,
        invitationEmail: false,
        emailChange: false,
      };
      vi.resetModules();
      vi.stubEnv("VITE_APP_ENV", "installation");
      const { AccountForm } = await import("./account-forms");
      const page = render(createElement(AccountForm, { mode })).container;
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        {
          signup: "Cadastro indisponível.",
          "verify-email": "Verificação indisponível.",
          "forgot-password": "Recuperação indisponível.",
          "reset-password": "Recuperação indisponível.",
        }[mode],
      );
      expect(page.textContent).toContain(
        "Este painel não aceita novas contas nem recupera a senha por e-mail. Entre com uma conta existente.",
      );
      expect(page.textContent).not.toContain("convite");
      expect(page.textContent).not.toContain("mantenedor");
      expect(page.textContent).not.toContain("validade fiscal");
      expect(screen.getByRole("link", { name: "Voltar ao login" })).toBeTruthy();
    });
});
