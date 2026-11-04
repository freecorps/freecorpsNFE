// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { FiscalCapture, SupportReferences } from "./fiscal-capture";
import { formatDateTime } from "./format";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: {
    to: string;
    params?: { version: string };
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a
      href={
        props.to.replace("$version", props.params?.version ?? "") +
        (props.search && Object.keys(props.search).length
          ? `?${new URLSearchParams(props.search)}`
          : "")
      }
    >
      {props.children}
    </a>
  ),
}));
afterEach(() => {
  cleanup();
  state.mutate.mockReset();
  vi.restoreAllMocks();
});
/** Past the dialog's settle time, when a click is a decision and not the opening gesture. */
const settle = () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 1000);
};

const ids = { organizationId: "org", companyId: "company" } as never;
const status = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  state: "none",
  blocked: false,
  minIntervalHours: 1,
  updatedAt: null,
  canManage: true,
  requirements: { declared: true, certificate: true },
  terms: "captura-fiscal-2026-10-22",
  acceptedTerms: null,
  termsUpdate: null,
  ...overrides,
});
type Props = Parameters<typeof FiscalCapture>[0];
function show(overrides: Record<string, unknown> = {}, extra: Partial<Props> = {}) {
  const title = { current: document.createElement("h2") };
  const onEnabled = vi.fn();
  const props = {
    ...(ids as object),
    status: status(overrides),
    onEnabled,
    title,
    ...extra,
  } as Props;
  const view = render(<FiscalCapture {...props} />);
  return { ...view, title, onEnabled, props };
}

describe("Captura fiscal (Produção): a liberação", () => {
  it("fora do deployment, diz que não está disponível, sem botões", () => {
    show({ available: false, state: "withdrawn" });
    expect(screen.getByText("Captura fiscal indisponível neste ambiente")).toBeTruthy();
    expect(
      screen.getByText("Os documentos já recebidos continuam em Documentos › Produção."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    // The line says what stays also with a capture below, which no longer has its own notice.
    show({ available: false, state: "withdrawn" }, { hasStream: true });
    expect(
      screen.getByText("Os documentos já recebidos continuam em Documentos › Produção."),
    ).toBeTruthy();
  });
  it("ativa só depois do aceite dos termos, com o intervalo escolhido, e só ativa", async () => {
    state.mutate.mockResolvedValue({ version: 1, revokedKeys: 0 });
    const { onEnabled } = show();
    const button = screen.getByRole("button", { name: "Ativar captura fiscal" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Intervalo mínimo entre consultas"), {
      target: { value: "4" },
    });
    expect(
      screen.getByText(
        /Consulta automática no máximo a cada 4 h quando não há documentos pendentes/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Li e aceito os termos da captura fiscal"));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(state.mutate).toHaveBeenCalledWith("captureRelease:enable", {
      organizationId: "org",
      companyId: "company",
      minIntervalHours: 4,
      terms: "captura-fiscal-2026-10-22",
    });
    // Turning it on does not start the capture: that is the panel's last step (#432).
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(onEnabled).toHaveBeenCalledTimes(1);
  });
  it("mostra a recusa do servidor em português, sem passar ao passo seguinte", async () => {
    state.mutate.mockRejectedValue(
      new ConvexError({ code: "CAPTURE_RELEASE_CERTIFICATE_REQUIRED" }),
    );
    const { onEnabled } = show();
    fireEvent.click(screen.getByLabelText("Li e aceito os termos da captura fiscal"));
    fireEvent.click(screen.getByRole("button", { name: "Ativar captura fiscal" }));
    expect((await screen.findByText(/certificado A1 da própria empresa/)).textContent).toBeTruthy();
    expect(onEnabled).not.toHaveBeenCalled();
  });
  it("ativa, vira uma linha de resumo com o intervalo e Desativar; sem A1, explica o que falta", async () => {
    state.mutate.mockResolvedValue({ version: 2 });
    show({ state: "released", minIntervalHours: 6 });
    expect(screen.getByText("Captura fiscal ativa")).toBeTruthy();
    expect(screen.getByText("intervalo mínimo 6 h")).toBeTruthy();
    expect(
      screen.getByText(
        "Consulta automática no máximo a cada 6 h quando não há documentos pendentes.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no fim da fila/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // "Desativar" on the line, named in full for whoever does not see the line.
    const open = screen.getByRole("button", { name: "Desativar captura fiscal" });
    expect(open.textContent).toBe("Desativar");
    fireEvent.click(open);
    settle();
    const dialog = screen.getByRole("alertdialog", { name: "Desativar a captura fiscal?" });
    expect(dialog.textContent).toContain(
      "As consultas à Receita param. Os documentos já recebidos continuam em Documentos › Produção.",
    );
    // Nothing goes to the server before the confirmation, and the safe option has the focus.
    expect(state.mutate).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancelar");
    const confirm = within(dialog).getByRole("button", { name: "Desativar captura fiscal" });
    expect(confirm.className).toContain("ui-button--danger");
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(state.mutate).toHaveBeenCalledWith("captureRelease:disable", {
      organizationId: "org",
      companyId: "company",
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    cleanup();
    show({ requirements: { declared: true, certificate: false } });
    expect(screen.queryByRole("button", { name: "Ativar captura fiscal" })).toBeNull();
    expect(screen.getByText(/Envie e ative o certificado A1/)).toBeTruthy();
  });
  it("ligada, diz de quando são os termos, quem aceitou e quando, e leva ao texto", () => {
    const acceptedAt = Date.UTC(2026, 9, 22, 17, 3);
    window.history.replaceState(null, "", "/app/org/companies/company?aba=captura");
    show({
      state: "released",
      acceptedTerms: { version: "captura-fiscal-2026-10-22", acceptedAt, acceptedBy: "Ana Souza" },
    });
    const line = screen.getByText(/Termos de 22\/10\/2026 aceitos por Ana Souza em/);
    expect(line.textContent).toContain(formatDateTime(acceptedAt));
    // The version's slug is for the terms page, not for this line.
    expect(line.textContent).not.toContain("captura-fiscal-2026-10-22");
    const link = screen.getByRole("link", { name: "Ler os termos" }) as HTMLAnchorElement;
    expect(link.pathname).toBe("/termos/captura-fiscal/captura-fiscal-2026-10-22");
    // The page brings the person back to the capture tab.
    expect(new URLSearchParams(link.search).get("voltar")).toBe(
      "/app/org/companies/company?aba=captura",
    );
    cleanup();
    // Roles that do not see the members get when, not who.
    show({
      state: "released",
      acceptedTerms: { version: "captura-fiscal-2026-10-22", acceptedAt, acceptedBy: null },
    });
    expect(screen.getByText(/Termos de 22\/10\/2026 aceitos em/)).toBeTruthy();
    expect(screen.queryByText(/aceitos por/)).toBeNull();
    cleanup();
    // Without an acceptance from the server, the line says nothing about terms.
    show({ state: "released" });
    expect(screen.queryByText(/aceitos/)).toBeNull();
  });
  it("sem o texto da versão que o servidor pede, não deixa aceitar", () => {
    show({ terms: "captura-fiscal-2099-01-01" });
    expect(screen.getByText(/Recarregue a página para ler os termos antes de ativar/)).toBeTruthy();
    const accept = screen.getByLabelText("Li e aceito os termos da captura fiscal");
    expect((accept as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(accept);
    expect(
      (screen.getByRole("button", { name: "Ativar captura fiscal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("Esc e Cancelar fecham sem desativar; uma recusa fica no diálogo", async () => {
    show({ state: "released" });
    const open = screen.getByRole("button", { name: "Desativar captura fiscal" });
    open.focus();
    fireEvent.click(open);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(state.mutate).not.toHaveBeenCalled();
    state.mutate.mockRejectedValue(new ConvexError({ code: "RATE_LIMITED" }));
    fireEvent.click(open);
    settle();
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Desativar captura fiscal",
        }),
      );
    });
    expect(within(screen.getByRole("alertdialog")).getByRole("alert").textContent).toBe(
      "Muitas tentativas seguidas. Aguarde um minuto.",
    );
  });
  it("avisa em destaque que ativar revoga as chaves de produção", () => {
    show();
    const warning = screen.getByText(/chaves de API de produção desta empresa criadas antes/);
    expect(warning.closest(".ui-callout")?.className).toContain("ui-callout--warning");
  });
  it("a recusa ao ativar aparece junto do botão e recebe o foco, a cada tentativa", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "CAPTURE_RELEASE_TERMS_REQUIRED" }));
    show();
    fireEvent.click(screen.getByLabelText("Li e aceito os termos da captura fiscal"));
    const button = screen.getByRole("button", { name: "Ativar captura fiscal" });
    await act(async () => {
      fireEvent.click(button);
    });
    // Focused, which reads it out; no live region on top of that, which would read it twice.
    const notice = document.activeElement as HTMLElement;
    expect(notice.textContent).toBe("Leia e aceite os termos atuais antes de ativar.");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    // Next to the button, after it in the form.
    expect(button.closest("form")?.contains(notice)).toBe(true);
    expect(button.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The same refusal again takes the focus again.
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect((document.activeElement as HTMLElement).textContent).toBe(notice.textContent);
  });
  it("suspensa pela Freecorps ou sem papel de gestão, não há botão de ativar, desativar ou mudar", () => {
    const anyButton = () => screen.queryByRole("button", { name: /captura fiscal|intervalo/ });
    const { container } = show({ blocked: true, state: "withdrawn" });
    // One notice in one tone: what happened, what stays and what to do (#424).
    const notices = container.querySelectorAll(".ui-callout");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.classList.contains("ui-callout--warning")).toBe(true);
    expect(notices[0]!.textContent).toBe(
      "Captura fiscal suspensa pela FreecorpsNenhuma consulta nova é feita à Receita. Os documentos já recebidos continuam em Documentos › Produção. Para reativar, fale com o suporte.",
    );
    expect(anyButton()).toBeNull();
    cleanup();
    show({ canManage: false });
    expect(anyButton()).toBeNull();
    expect(screen.getByText(/Somente Proprietário ou Administrador ativa/)).toBeTruthy();
    cleanup();
    show({ canManage: false, state: "released", minIntervalHours: 2 });
    expect(screen.getByText("Captura fiscal ativa")).toBeTruthy();
    expect(anyButton()).toBeNull();
    expect(screen.queryByRole("button", { name: "Alterar intervalo" })).toBeNull();
    expect(
      screen.getByText(
        "Somente Proprietário ou Administrador muda o intervalo ou desativa a captura fiscal.",
      ),
    ).toBeTruthy();
  });
  it("desativada com captura para ler, ativar de novo fica recolhido", () => {
    show({ state: "withdrawn" }, { hasStream: true });
    expect(screen.getByText("Captura fiscal desativada")).toBeTruthy();
    const block = screen.getByText("Ativar de novo a captura fiscal").closest("details")!;
    expect(block.open).toBe(false);
    expect(within(block).getByRole("button", { name: "Ativar captura fiscal" })).toBeTruthy();
    cleanup();
    // Without a capture below, the form is the content.
    show({ state: "withdrawn" });
    expect(screen.queryByText("Ativar de novo a captura fiscal")).toBeNull();
    expect(screen.getByRole("button", { name: "Ativar captura fiscal" })).toBeTruthy();
  });
});

describe("intervalo sem desativar (#432)", () => {
  it("abre no lugar da linha com o foco no seletor e salva o novo intervalo", async () => {
    state.mutate.mockResolvedValue({ minIntervalHours: 4, changed: true, nextAllowedAt: null });
    const view = show({ state: "released", minIntervalHours: 1 });
    const open = screen.getByRole("button", { name: "Alterar intervalo" });
    open.focus();
    fireEvent.click(open);
    const select = screen.getByLabelText("Intervalo mínimo entre consultas") as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe("1");
    expect(screen.getByText(/a que já está marcada não é antecipada/)).toBeTruthy();
    // The editor is a focused task: saving is its main action.
    expect(screen.getByRole("button", { name: "Salvar intervalo" }).className).toContain(
      "ui-button--primary",
    );
    fireEvent.change(select, { target: { value: "4" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar intervalo" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captureRelease:updateInterval", {
      organizationId: "org",
      companyId: "company",
      minIntervalHours: 4,
    });
    // The server's answer comes back through the status; the line has the focus and reads it.
    view.rerender(
      <FiscalCapture
        {...view.props}
        status={status({ state: "released", minIntervalHours: 4 }) as Props["status"]}
      />,
    );
    expect(screen.queryByLabelText("Intervalo mínimo entre consultas")).toBeNull();
    const line = document.activeElement as HTMLElement;
    expect(line.textContent).toContain("Captura fiscal ativa");
    expect(line.textContent).toContain("intervalo mínimo 4 h");
    // Never a deactivation on the way.
    expect(state.mutate).not.toHaveBeenCalledWith("captureRelease:disable", expect.anything());
  });
  it("Esc e Cancelar devolvem o foco a Alterar intervalo; o mesmo valor não vai ao servidor", () => {
    show({ state: "released", minIntervalHours: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.keyDown(screen.getByLabelText("Intervalo mínimo entre consultas"), {
      key: "Escape",
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.click(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.click(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar intervalo" }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alterar intervalo" }));
  });
  it("uma recusa fica junto dos botões, com o foco, e o seletor continua aberto", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "CAPTURE_RELEASE_BLOCKED" }));
    show({ state: "released", minIntervalHours: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Alterar intervalo" }));
    fireEvent.change(screen.getByLabelText("Intervalo mínimo entre consultas"), {
      target: { value: "12" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar intervalo" }));
    });
    expect((document.activeElement as HTMLElement).textContent).toBe(
      "A Freecorps suspendeu a captura fiscal desta empresa. Fale com o suporte para reativar.",
    );
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getByLabelText("Intervalo mínimo entre consultas")).toBeTruthy();
  });
});

describe("novos termos para quem já liberou (#428)", () => {
  // 21/11/2026 00:00 in Brasília: the last day to accept is 20/11.
  const deadline = Date.UTC(2026, 10, 21, 3);
  const update = (expired: boolean) => ({
    state: "released",
    termsUpdate: { version: "captura-fiscal-2026-10-22", deadline, expired },
  });
  it("antes do prazo, avisa até quando aceitar; o gestor lê o texto e aceita", async () => {
    state.mutate.mockResolvedValue({ terms: "captura-fiscal-2026-10-22" });
    show(update(false));
    expect(screen.getByText("Novos termos da captura fiscal")).toBeTruthy();
    expect(screen.getByText(/até 20\/11\/2026; depois disso, as consultas/)).toBeTruthy();
    fireEvent.click(screen.getByText("Ler e aceitar os novos termos"));
    const button = screen.getByRole("button", {
      name: "Aceitar os novos termos",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Li e aceito os novos termos da captura fiscal"));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(state.mutate).toHaveBeenCalledWith("captureRelease:acceptTerms", {
      ...(ids as object),
      terms: "captura-fiscal-2026-10-22",
    });
  });
  it("depois do prazo, diz que as consultas esperam o aceite e o que continua", () => {
    show(update(true));
    expect(
      screen.getByText("Consultas à Receita pausadas até o aceite dos novos termos"),
    ).toBeTruthy();
    expect(screen.getByText(/terminou em 20\/11\/2026/)).toBeTruthy();
    // The release stays on: the line and its actions are still there.
    expect(screen.getByText("Captura fiscal ativa")).toBeTruthy();
  });
  it("sem papel de gestão, só o aviso", () => {
    show({ ...update(false), canManage: false });
    expect(
      screen.getByText("Somente Proprietário ou Administrador aceita os novos termos."),
    ).toBeTruthy();
    expect(screen.queryByText("Ler e aceitar os novos termos")).toBeNull();
  });
});

describe("referências para o suporte", () => {
  it("ficam num trecho recolhido, com cópia", () => {
    render(<SupportReferences {...(ids as object as Parameters<typeof SupportReferences>[0])} />);
    const summary = screen.getByText("Referências para o suporte");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getByText(/informe o CNPJ da empresa/)).toBeTruthy();
    expect(screen.getByText("Referência da organização")).toBeTruthy();
    expect(screen.getByText("org")).toBeTruthy();
    expect(screen.getByText("Referência da empresa")).toBeTruthy();
    expect(screen.getByText("company")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar referência da organização" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar referência da empresa" })).toBeTruthy();
  });
});
