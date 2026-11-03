// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({ capabilities: undefined as unknown }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("./auth", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("convex/react", () => ({
  useConvex: () => ({ clearAuth: vi.fn() }),
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: (fn: Parameters<typeof getFunctionName>[0]) =>
    ({
      "access:session": { name: "Ana Sintética", email: "ana@exemplo.invalid", role: null },
      "account:capabilities": state.capabilities,
    })[getFunctionName(fn)],
}));

import { AccountSettings } from "./account-settings";

afterEach(() => {
  cleanup();
  state.capabilities = undefined;
});

describe("E-mail de acesso segue o e-mail de convites (#538)", () => {
  const rest = " A troca exige um código enviado ao novo endereço e encerra as sessões abertas.";
  const withInvitations = `É o seu login e o endereço que recebe os convites.${rest}`;

  it("com e-mail, o endereço é também o que recebe os convites", () => {
    state.capabilities = {
      registration: true,
      emailRecovery: true,
      invitationEmail: true,
      emailChange: true,
    };
    render(<AccountSettings />);
    expect(screen.getByText(withInvitations)).toBeTruthy();
  });

  it("sem e-mail, o endereço é só o login", () => {
    state.capabilities = {
      registration: false,
      emailRecovery: false,
      invitationEmail: false,
      emailChange: false,
    };
    render(<AccountSettings />);
    expect(screen.getByText("É o seu login.")).toBeTruthy();
    expect(screen.queryByText(/recebe os convites/)).toBeNull();
  });

  it("enquanto o servidor não respondeu, mantém a descrição de antes", () => {
    render(<AccountSettings />);
    expect(screen.getByText(withInvitations)).toBeTruthy();
  });
});

describe("E-mail de acesso só oferece a troca quando o painel envia o código (#628)", () => {
  const on = { registration: true, emailRecovery: true, invitationEmail: true, emailChange: true };
  const off = {
    registration: false,
    emailRecovery: false,
    invitationEmail: false,
    emailChange: false,
  };

  function expectChangeForm() {
    expect(screen.getByLabelText("Novo e-mail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar código" })).toBeTruthy();
    expect(screen.queryByText("Este painel não troca o e-mail de acesso.")).toBeNull();
  }

  it("com e-mail, mostra o formulário que envia o código", () => {
    state.capabilities = on;
    render(<AccountSettings />);
    expectChangeForm();
  });

  it("sem e-mail, mantém o e-mail atual e explica o que fazer, sem prometer código", () => {
    state.capabilities = off;
    render(<AccountSettings />);
    expect(screen.getByText("ana@exemplo.invalid")).toBeTruthy();
    expect(screen.getByText("Este painel não troca o e-mail de acesso.")).toBeTruthy();
    expect(
      screen.getByText(
        "A troca exige um código enviado ao novo endereço, e este painel não envia e-mails de conta. Para usar outro endereço, peça a quem administra o painel que ative o envio de e-mails de conta.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Novo e-mail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviar código" })).toBeNull();
    expect(screen.queryByText(/código enviado ao novo endereço e encerra/)).toBeNull();
  });

  it("enquanto o servidor não respondeu, mantém o formulário", () => {
    render(<AccountSettings />);
    expectChangeForm();
  });
});
