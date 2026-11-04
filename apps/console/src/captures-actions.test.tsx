// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Captures } from "./captures";
import { formatShortDateTime } from "./format";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

// Pause, transfer, deactivation and action failures of the capture panel (#431).

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutate: vi.fn(),
  /** The environment chosen in the shell. */
  environment: "sandbox" as "sandbox" | "production",
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: {
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a
      href={`${Object.entries(props.params).reduce(
        (to, [key, value]) => to.replace(`$${key}`, value),
        props.to,
      )}${props.search ? `?${new URLSearchParams(props.search)}` : ""}`}
    >
      {props.children}
    </a>
  ),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(fn);
    const environment = (args as { environment?: string } | undefined)?.environment;
    return state.queries[environment ? `${name}:${environment}` : name];
  },
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
afterEach(() => {
  cleanup();
  state.queries = {};
  state.mutate.mockReset();
  state.environment = "sandbox";
  vi.restoreAllMocks();
});

const operator = {
  id: "org",
  slug: "equipe",
  name: "Equipe",
  role: "operator",
  capabilities: { operateDocuments: true, manageOrganization: false },
} as unknown as Parameters<typeof Captures>[0]["org"];
const manager = {
  ...operator,
  role: "admin",
  capabilities: { operateDocuments: true, manageOrganization: true },
} as typeof operator;
const viewer = {
  ...operator,
  role: "viewer",
  capabilities: { operateDocuments: false, manageOrganization: false },
} as typeof operator;
const NEXT = Date.now() + 3600_000;
const stream = (overrides: Record<string, unknown> = {}) => ({
  id: "stream",
  organizationId: "org",
  companyId: "company",
  projectId: "console",
  environment: "sandbox",
  state: "active",
  version: 5,
  checkpoint: "000000000000002",
  sourceCursor: null,
  nextAllowedAt: NEXT,
  lastAttemptAt: NEXT - 3600_000,
  lastSuccessAt: NEXT - 3600_000,
  code: null,
  received: 2,
  operationId: "op-123",
  operationState: "succeeded",
  certificateState: "active",
  certificateExpiresAt: NEXT + 30 * 86_400_000,
  origin: { kind: "console", integration: null },
  sourceMaxNsu: null,
  gap: { lost: null, recovering: null, accepted: [] },
  ...overrides,
});
const release = (stateName: string, overrides: Record<string, unknown> = {}) => ({
  available: true,
  state: stateName,
  blocked: false,
  minIntervalHours: 1,
  updatedAt: null,
  canManage: false,
  requirements: { declared: true, certificate: true },
  terms: "captura-fiscal-2026-10-22",
  acceptedTerms: null,
  ...overrides,
});
/** The sandbox capture alone: the fiscal capture is not offered. */
function sandbox(value: unknown, org = operator) {
  state.queries["captures:get:sandbox"] = value;
  state.queries["captureRelease:status"] = release("none", { available: false });
  render(<Captures org={org} companyId={"company" as never} />);
}
/** Past the dialog's settle time, when a click is a decision and not the opening gesture. */
const settle = () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 1000);
};
const summary = (text: string) => screen.getByText(text).closest("details")!;
/**
 * The refusal next to the buttons: it has the focus, which reads it out, and no live region on
 * top of that, which would read it twice.
 */
function focusedFailure() {
  const notice = document.activeElement as HTMLElement;
  expect(notice).not.toBe(document.body);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  return notice;
}

describe("pausar", () => {
  it("pede confirmação antes de pausar e só então chama o servidor", async () => {
    state.mutate.mockResolvedValue({});
    sandbox(stream());
    const pause = screen.getByRole("button", { name: "Pausar captura" });
    pause.focus();
    fireEvent.click(pause);
    settle();
    const dialog = screen.getByRole("alertdialog", { name: "Pausar a captura?" });
    expect(dialog.textContent).toContain("nenhum documento novo chega");
    expect(dialog.textContent).toContain("Os documentos recebidos continuam disponíveis.");
    expect(document.activeElement?.textContent).toBe("Cancelar");
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Pausar captura" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:control", {
      organizationId: "org",
      companyId: "company",
      environment: "sandbox",
      action: "pause",
      expectedVersion: 5,
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(pause);
  });

  it("Esc fecha sem pausar e devolve o foco ao botão", () => {
    sandbox(stream());
    const pause = screen.getByRole("button", { name: "Pausar captura" });
    pause.focus();
    fireEvent.click(pause);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(pause);
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("uma recusa do servidor fica no diálogo", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "OPERATION_CONFLICT" }));
    sandbox(stream());
    fireEvent.click(screen.getByRole("button", { name: "Pausar captura" }));
    settle();
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Pausar captura" }));
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "A captura mudou em outra sessão. Confira os dados atualizados e tente de novo.",
    );
  });

  it("pausada: diz que nada chega e que não há próxima consulta, sem repetir o aviso", () => {
    sandbox(stream({ state: "paused", code: "PAUSED_BY_USER", operationState: "paused" }));
    expect(screen.getByText("Captura pausada")).toBeTruthy();
    expect(
      screen.getByText(
        "Captura pausada: as consultas automáticas estão paradas e nenhum documento novo chega. Os documentos recebidos continuam disponíveis.",
      ),
    ).toBeTruthy();
    const next = screen.getByText("Próxima consulta automática").nextElementSibling!;
    expect(next.textContent).toBe("Nenhuma: consultas automáticas pausadas");
    expect(screen.queryByText(formatShortDateTime(NEXT))).toBeNull();
    // The stream's code says the same: one notice only.
    expect(screen.queryByText(/Pausa solicitada/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retomar captura" })).toBeTruthy();
  });

  it("ativa, mostra a próxima consulta; em atenção, nenhuma, como na pausa", () => {
    sandbox(stream());
    expect(screen.getByText("Próxima consulta automática").nextElementSibling!.textContent).toBe(
      formatShortDateTime(NEXT),
    );
    expect(screen.queryByText(/Captura pausada:/)).toBeNull();
    cleanup();
    sandbox(stream({ state: "attention", code: "ATTEMPTS_EXHAUSTED", operationState: "failed" }));
    expect(screen.getAllByText("Captura precisa de atenção").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Captura pausada:/)).toBeNull();
    expect(screen.getByText(/A consulta falhou em todas as tentativas permitidas/)).toBeTruthy();
    // Stopped until someone acts: no time, though the stream keeps its window (#432).
    expect(screen.getByText("Próxima consulta automática").nextElementSibling!.textContent).toBe(
      "Nenhuma: consultas automáticas paradas até alguém agir",
    );
    expect(screen.queryByText(formatShortDateTime(NEXT))).toBeNull();
  });

  it("o aviso de pausa não é outra região anunciada: o selo já é a situação", () => {
    sandbox(stream({ state: "paused", code: "PAUSED_BY_USER", operationState: "paused" }));
    const notice = screen.getByText(/^Captura pausada: as consultas/).closest(".ui-callout")!;
    expect(notice.getAttribute("role")).toBeNull();
    expect(notice.closest("[role='status'], [role='alert'], [aria-live]")).toBeNull();
  });

  it("recebida de outra organização, diz que falta retomar, sem pedir conferência", () => {
    sandbox(stream({ state: "paused", code: "TRANSFERRED", operationState: null }), manager);
    const notice = screen.getByText(/^Captura recebida de outra organização/);
    expect(notice.closest(".ui-callout")?.className).toContain("ui-callout--info");
    expect(screen.queryByText(/precisa de conferência/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retomar captura" })).toBeTruthy();
  });
});

describe("transferir", () => {
  it("fica recolhida no fim, longe de Sincronizar e Pausar, e só para quem administra", () => {
    sandbox(stream(), manager);
    const actions = screen.getByRole("button", { name: "Sincronizar" }).parentElement!;
    expect(within(actions).queryByRole("button", { name: /transferência/ })).toBeNull();
    const block = summary("Transferir esta captura para outra organização");
    expect(block.open).toBe(false);
    expect(block.textContent).toContain(
      "Pausa a captura aqui e gera um código, válido por 15 minutos, para outra organização continuar do mesmo ponto.",
    );
    // The last block of the capture.
    expect(block.parentElement!.lastElementChild).toBe(block);
    cleanup();
    sandbox(stream(), operator);
    expect(screen.queryByText("Transferir esta captura para outra organização")).toBeNull();
  });

  it("confirma, gera o código e leva o foco a ele; ocultar devolve o foco ao botão", async () => {
    state.mutate.mockResolvedValue({ token: "codigo-de-teste", expiresAt: NEXT });
    sandbox(stream(), manager);
    fireEvent.click(screen.getByText("Transferir esta captura para outra organização"));
    const opener = screen.getByRole("button", { name: "Pausar e autorizar transferência" });
    opener.focus();
    fireEvent.click(opener);
    settle();
    const dialog = screen.getByRole("alertdialog", {
      name: "Transferir esta captura para outra organização?",
    });
    expect(dialog.textContent).toContain("15 minutos");
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Pausar e gerar código" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:release", {
      organizationId: "org",
      companyId: "company",
      environment: "sandbox",
      expectedVersion: 5,
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const code = screen.getByRole("group", { name: "Código de transferência" });
    expect(code.textContent).toContain("codigo-de-teste");
    expect(document.activeElement).toBe(code);
    expect(screen.queryByRole("button", { name: "Pausar e autorizar transferência" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar código" }));
    expect(screen.queryByText("codigo-de-teste")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Pausar e autorizar transferência" }),
    );
  });

  it("já pausada, não promete pausar: autoriza e gera o código", async () => {
    state.mutate.mockResolvedValue({ token: "codigo-de-teste", expiresAt: NEXT });
    sandbox(stream({ state: "paused", code: "PAUSED_BY_USER", operationState: "paused" }), manager);
    const block = summary("Transferir esta captura para outra organização");
    expect(block.textContent).toContain(
      "Gera um código, válido por 15 minutos, para outra organização continuar do mesmo ponto.",
    );
    expect(block.textContent).not.toMatch(/Pausa a captura/);
    expect(within(block).queryByRole("button", { name: /Pausar/ })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Autorizar transferência" }));
    settle();
    const dialog = screen.getByRole("alertdialog", {
      name: "Transferir esta captura para outra organização?",
    });
    expect(dialog.textContent).toContain("A captura continua pausada nesta organização");
    expect(within(dialog).queryByRole("button", { name: /Pausar/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Gerar código" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:release", {
      organizationId: "org",
      companyId: "company",
      environment: "sandbox",
      expectedVersion: 5,
    });
    expect(screen.getByRole("group", { name: "Código de transferência" }).textContent).toContain(
      "codigo-de-teste",
    );
  });

  it("com recuperação pendente, a recusa fica no diálogo e nenhum código aparece", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "RECONCILIATION_REQUIRED" }));
    sandbox(stream(), manager);
    fireEvent.click(screen.getByRole("button", { name: "Pausar e autorizar transferência" }));
    settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar e gerar código" }));
    });
    expect(within(screen.getByRole("alertdialog")).getByRole("alert").textContent).toBe(
      "Uma consulta sem resposta ainda precisa ser conferida. Retome a captura e espere a conferência terminar antes de transferir.",
    );
    expect(screen.queryByRole("group", { name: "Código de transferência" })).toBeNull();
  });
});

describe("sem captura", () => {
  it("receber uma transferência fica recolhido, só para quem administra", () => {
    sandbox(null, manager);
    const block = summary("Recebendo uma captura de outra organização?");
    expect(block.open).toBe(false);
    expect(within(block).getByLabelText("Código de transferência")).toBeTruthy();
    expect(screen.queryByText("Receber uma captura transferida")).toBeNull();
    cleanup();
    sandbox(null, operator);
    expect(screen.queryByText("Recebendo uma captura de outra organização?")).toBeNull();
    expect(screen.getByRole("button", { name: "Ativar captura no sandbox" })).toBeTruthy();
  });

  it("a recusa da transferência aparece junto do botão de receber, com o foco", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "STREAM_CONFLICT" }));
    sandbox(null, manager);
    const block = summary("Recebendo uma captura de outra organização?");
    fireEvent.click(within(block).getByText("Recebendo uma captura de outra organização?"));
    fireEvent.change(within(block).getByLabelText("Código de transferência"), {
      target: { value: "codigo-vencido" },
    });
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Receber transferência" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:activate", {
      organizationId: "org",
      companyId: "company",
      environment: "sandbox",
      transferToken: "codigo-vencido",
    });
    const notice = focusedFailure();
    // In plain words (#432).
    expect(notice.textContent).toBe(
      "Outra organização já captura esta empresa. Peça a ela um código de transferência.",
    );
    expect(block.contains(notice)).toBe(true);
    // Only there: the start button above has no notice of its own.
    expect(screen.getAllByText(/Peça a ela um código de transferência/)).toHaveLength(1);
  });

  it("um código sem captura para receber é recusado, com o que fazer (#461)", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "TRANSFER_NOT_FOUND" }));
    sandbox(null, manager);
    const block = summary("Recebendo uma captura de outra organização?");
    fireEvent.click(within(block).getByText("Recebendo uma captura de outra organização?"));
    fireEvent.change(within(block).getByLabelText("Código de transferência"), {
      target: { value: "codigo-de-outra-empresa" },
    });
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Receber transferência" }));
    });
    const notice = focusedFailure();
    expect(notice.textContent).toBe(
      "Nenhuma outra organização tem uma captura desta empresa para transferir. Confira o código com a organização de origem. Se não houver transferência, use Ativar captura no sandbox.",
    );
    expect(block.contains(notice)).toBe(true);
    // The button it names is still there, and nothing says a capture started.
    expect(screen.getByRole("button", { name: "Ativar captura no sandbox" })).toBeTruthy();
    expect(screen.getByText("A captura ainda não foi ativada para esta empresa.")).toBeTruthy();
  });

  it("um código vazio também vai como transferência, nunca como ativação", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "TRANSFER_NOT_FOUND" }));
    sandbox(null, manager);
    const block = summary("Recebendo uma captura de outra organização?");
    // `required` stops it in the browser; the submit itself still sends the code.
    await act(async () => {
      fireEvent.submit(block.querySelector("form")!);
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:activate", {
      organizationId: "org",
      companyId: "company",
      environment: "sandbox",
      transferToken: "",
    });
  });

  it("depois de desativada a captura fiscal, Produção diz isso numa linha, sem painel vazio", () => {
    state.environment = "production";
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = release("withdrawn");
    render(<Captures org={operator} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    expect(within(production).getByText("Captura fiscal desativada")).toBeTruthy();
    // Nothing to start or to read in production: no empty capture below the line.
    expect(within(production).queryByRole("heading", { level: 3 })).toBeNull();
    // Produção alone: no test capture beside it, and no start.
    expect(screen.queryByText("Captura de teste (Sandbox)")).toBeNull();
    expect(screen.queryByText("A captura ainda não foi ativada para esta empresa.")).toBeNull();
    expect(screen.queryByText(/Quem opera documentos/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar captura fiscal" })).toBeNull();
    expect(
      screen.queryByText("Recebendo uma captura de outra organização?", { exact: true }),
    ).toBeNull();
  });

  it("suspensa pela Freecorps ou fora do ambiente, não manda reativar", () => {
    state.environment = "production";
    state.queries["captures:get:sandbox"] = stream();
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = release("withdrawn", { blocked: true });
    render(<Captures org={manager} companyId={"company" as never} />);
    expect(screen.getByText("Captura fiscal suspensa pela Freecorps")).toBeTruthy();
    expect(screen.queryByText(/reative|Ativar de novo/)).toBeNull();
    cleanup();
    state.queries["captures:get:sandbox"] = stream();
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = release("withdrawn", { available: false });
    render(<Captures org={manager} companyId={"company" as never} />);
    expect(screen.getByText("Captura fiscal indisponível neste ambiente")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /captura fiscal/ })).toBeNull();
  });

  it("quem só lê vê o que falta, sem botão", () => {
    sandbox(null, viewer);
    expect(screen.getByText(/Quem opera documentos .* ativa a captura/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("falhas de ação", () => {
  it("a recusa de Sincronizar aparece junto dos botões e recebe o foco", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "OPERATION_CONFLICT" }));
    sandbox(stream({ nextAllowedAt: 0 }));
    const sync = screen.getByRole("button", { name: "Sincronizar" });
    sync.focus();
    await act(async () => {
      fireEvent.click(sync);
    });
    const notice = focusedFailure();
    expect(notice.textContent).toBe(
      "A captura mudou em outra sessão. Confira os dados atualizados e tente de novo.",
    );
    // Right after the action row, not at the top of the panel.
    const actions = sync.parentElement!;
    expect(actions.nextElementSibling).toBe(notice);
    // A second refusal takes the focus again, even with the same text.
    sync.focus();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sincronizar" }));
    });
    expect(focusedFailure().textContent).toBe(notice.textContent);
  });

  it("a recusa ao iniciar fica junto do botão de iniciar", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "CERTIFICATE_UNAVAILABLE" }));
    sandbox(null, manager);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ativar captura no sandbox" }));
    });
    const notice = focusedFailure();
    expect(notice.textContent).toMatch(/Envie ou ative o certificado A1 da empresa/);
    const block = summary("Recebendo uma captura de outra organização?");
    expect(block.contains(notice)).toBe(false);
  });
});

describe("certificado e detalhes técnicos", () => {
  it("o grupo Certificado leva à aba do certificado", () => {
    sandbox(stream());
    const group = screen.getByRole("group", { name: "Certificado" });
    expect(group.textContent).toMatch(/A1 válido até \d{2}\/\d{2}\/\d{4}/);
    const link = within(group).getByRole("link", { name: "Ver certificado" });
    expect(link.getAttribute("href")).toBe("/app/equipe/companies/company?aba=certificado");
  });

  it("os detalhes técnicos ficam recolhidos para o suporte, com o id da operação copiável", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    sandbox(stream());
    expect(screen.queryByText("Diagnóstico da captura")).toBeNull();
    const block = summary("Detalhes técnicos (para o suporte)");
    expect(block.open).toBe(false);
    expect(within(block).getByText("op-123")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Copiar id da operação" }));
    });
    expect(writeText).toHaveBeenCalledWith("op-123");
    expect(within(block).getByText("Copiado.")).toBeTruthy();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("valor ausente vai em palavras, não em fonte de código", () => {
    sandbox(stream());
    const block = summary("Detalhes técnicos (para o suporte)");
    const code = within(block).getByText("Código").nextElementSibling!;
    expect(code.textContent).toBe("Nenhum");
    expect(code.querySelector(".ui-mono")).toBeNull();
    expect(
      within(block).getByText("não informado", { exact: false }).closest(".ui-mono"),
    ).toBeNull();
    for (const mono of block.querySelectorAll(".ui-mono"))
      expect(mono.textContent).toMatch(/^\d+$/);
    cleanup();
    sandbox(stream({ state: "paused", code: "PAUSED_BY_USER", sourceCursor: "000000000000002" }));
    const paused = summary("Detalhes técnicos (para o suporte)");
    const pausedCode = within(paused).getByText("Código").nextElementSibling!;
    expect(pausedCode.querySelector(".ui-mono")?.textContent).toBe("PAUSED_BY_USER");
  });
});

describe("fim da página", () => {
  it("nenhuma nota solta fora dos cartões: cada aviso fica no cartão a que se refere", () => {
    state.environment = "production";
    state.queries["captures:get:sandbox"] = stream();
    state.queries["captures:get:production"] = stream({ environment: "production" });
    state.queries["captureRelease:status"] = release("released");
    const { container } = render(<Captures org={operator} companyId={"company" as never} />);
    expect(screen.queryByText(/sincronização|passos futuros/i)).toBeNull();
    // Only the live region and the Produção card.
    expect([...container.children].map((child) => child.tagName)).toEqual(["P", "SECTION"]);
    expect(container.firstElementChild!.getAttribute("role")).toBe("status");
  });
});
