// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { Captures } from "./captures";
import { formatShortDateTime } from "./format";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

/** Queries answer by name and, for the capture, by environment: sandbox and production differ. */
const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  /** Every subscription the screen asked for, by name and environment. */
  requested: new Set<string>(),
  mutate: vi.fn(),
  /** The environment chosen in the shell; Produção unless a test says otherwise. */
  environment: "production" as "sandbox" | "production",
  choose: vi.fn(),
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: state.choose,
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: {
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a
      className={props.className}
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
    const key = environment ? `${name}:${environment}` : name;
    state.requested.add(key);
    return state.queries[key];
  },
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
afterEach(() => {
  cleanup();
  state.queries = {};
  state.requested.clear();
  state.mutate.mockReset();
  state.environment = "production";
  state.choose.mockReset();
});

const org = {
  id: "org",
  slug: "equipe",
  name: "Equipe",
  role: "operator",
  capabilities: { operateDocuments: true, manageOrganization: false },
} as unknown as Parameters<typeof Captures>[0]["org"];
const release = (stateName: string) => ({
  available: true,
  state: stateName,
  blocked: false,
  minIntervalHours: 1,
  updatedAt: null,
  canManage: false,
  requirements: { declared: true, certificate: true },
  terms: "captura-fiscal-2026-10-22",
  acceptedTerms: null,
});

describe("captura em produção", () => {
  it("no Sandbox, nada de Produção se ativa: só o convite para trocar de ambiente", () => {
    state.environment = "sandbox";
    state.queries["captures:get:sandbox"] = null;
    state.queries["captureRelease:status"] = { ...release("none"), available: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.queryByRole("heading", { name: "Captura fiscal (Produção)" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Captura fiscal em Produção" })).toBeNull();
    // Never released: no production stream to ask for, the server does not serve it.
    expect(state.requested.has("captures:get:production")).toBe(false);
    cleanup();
    // Offered and never released: the release lives in Produção; here, only the way there.
    state.queries["captureRelease:status"] = release("none");
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.queryByRole("heading", { name: "Captura fiscal (Produção)" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ativar captura fiscal/ })).toBeNull();
    expect(state.requested.has("captures:get:production")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Trocar para Produção" }));
    expect(state.choose).toHaveBeenCalledWith("production");
    cleanup();
    // In Produção, the card that releases it.
    state.environment = "production";
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByRole("heading", { name: "Captura fiscal (Produção)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Captura de teste (Sandbox)" })).toBeNull();
  });
  it("ativada, o operador inicia a captura em produção: falta um passo", async () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = release("released");
    state.mutate.mockResolvedValue({});
    render(<Captures org={org} companyId={"company" as never} />);
    expect(
      screen.getByRole("heading", { name: "Falta um passo: Iniciar captura fiscal" }),
    ).toBeTruthy();
    // No success before the Receita answers, and no promise of the whole history.
    expect(
      screen.getByText(/O resultado da primeira consulta aparece aqui quando a Receita responder/),
    ).toBeTruthy();
    expect(
      screen.getByText(/A Receita guarda cada nota por 90 dias: as mais antigas podem não chegar/),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar captura fiscal" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:activate", {
      organizationId: "org",
      companyId: "company",
      environment: "production",
    });
  });
  it("durante a parada geral da Freecorps, diz que volta sozinha, sem pedir ação (#424)", () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = {
      id: "stream",
      organizationId: "org",
      companyId: "company",
      projectId: "console",
      environment: "production",
      state: "active",
      version: 3,
      checkpoint: "000000000000002",
      sourceCursor: null,
      nextAllowedAt: Date.now() + 3600_000,
      lastAttemptAt: Date.now() - 60_000,
      lastSuccessAt: Date.now() - 60_000,
      code: "CAPTURE_FISCAL_HALTED",
      received: 2,
      operationId: "op",
      operationState: "retry_wait",
      certificateState: "active",
      certificateExpiresAt: Date.now() + 30 * 86_400_000,
      origin: { kind: "console", integration: null },
      sourceMaxNsu: null,
    };
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText("Parada pela Freecorps")).toBeTruthy();
    expect(screen.queryByText("Captura ativa")).toBeNull();
    expect(screen.getByText(/Ela volta sozinha, sem ação sua/)).toBeTruthy();
    expect(screen.queryByText(/precisa de atenção/)).toBeNull();
  });
  it("em atenção por cota, diz que a captura de produção volta sozinha; no sandbox, não", () => {
    const stream = (environment: string) => ({
      id: `stream-${environment}`,
      organizationId: "org",
      companyId: "company",
      projectId: "console",
      environment,
      state: "attention",
      version: 3,
      checkpoint: "000000000000000",
      sourceCursor: null,
      nextAllowedAt: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      code: "QUOTA_EXCEEDED",
      received: 0,
      operationId: "op",
      operationState: "paused",
      certificateState: "active",
      certificateExpiresAt: null,
      origin: { kind: "console", integration: null },
      sourceMaxNsu: null,
    });
    state.queries["captures:get:sandbox"] = stream("sandbox");
    state.queries["captures:get:production"] = stream("production");
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    expect(within(production).getAllByText("Captura precisa de atenção")).toHaveLength(1);
    expect(
      within(production).getByText(
        /Cotas mensais renovam no próximo período; estoque ocupado exige revisão/,
      ),
    ).toBeTruthy();
    expect(
      within(production).getByText("Próxima consulta automática").nextElementSibling!.textContent,
    ).toBe("Nenhuma: a captura volta sozinha quando a causa for resolvida");
    cleanup();
    state.environment = "sandbox";
    render(<Captures org={org} companyId={"company" as never} />);
    const sandbox = screen.getByRole("region", { name: "Captura de teste (Sandbox)" });
    expect(within(sandbox).getAllByText("Captura precisa de atenção")).toHaveLength(1);
    expect(within(sandbox).queryByText(/volta sozinha/)).toBeNull();
    expect(
      within(sandbox).getByText("Próxima consulta automática").nextElementSibling!.textContent,
    ).toBe("Nenhuma: consultas automáticas paradas até alguém agir");
  });
  // ADR 0010: under the free tier, Production pauses by the notes limit, not by queries.
  it("em atenção pela cota de notas, nomeia o limite de notas; sem ela, o de consultas", () => {
    const stream = (environment: string, notesQuota?: boolean) => ({
      id: `stream-${environment}`,
      organizationId: "org",
      companyId: "company",
      projectId: "console",
      environment,
      state: "attention",
      version: 3,
      checkpoint: "000000000000000",
      sourceCursor: null,
      nextAllowedAt: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      code: "QUOTA_EXCEEDED",
      received: 0,
      operationId: "op",
      operationState: "paused",
      certificateState: "active",
      certificateExpiresAt: null,
      origin: { kind: "console", integration: null },
      sourceMaxNsu: null,
      ...(notesQuota ? { notesQuota, countsNotes: true } : {}),
    });
    state.queries["captures:get:sandbox"] = stream("sandbox");
    state.queries["captures:get:production"] = stream("production", true);
    state.queries["captures:history:production"] = [];
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    expect(production.textContent).toContain(
      "A organização chegou ao limite de notas novas do mês em Produção. Esta operação atingiu o limite do plano.",
    );
    expect(production.textContent).not.toContain("limite de consultas do plano");
    expect(
      within(production).getByText(
        /Cada nota nova recebida em Produção conta no limite de notas do plano/,
      ),
    ).toBeTruthy();
    cleanup();
    // Another limit of a plan that counts notes: the neutral words, never the queries' or notes'.
    state.queries["captures:get:production"] = { ...stream("production"), countsNotes: true };
    render(<Captures org={org} companyId={"company" as never} />);
    const other = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    expect(other.textContent).toContain(
      "A organização chegou a um limite do plano neste período. Esta operação atingiu o limite do plano.",
    );
    expect(other.textContent).not.toContain("notas novas do mês");
    expect(other.textContent).not.toContain("limite de consultas do plano");
    // The sandbox keeps its query quota: nothing there speaks of notes.
    cleanup();
    state.environment = "sandbox";
    render(<Captures org={org} companyId={"company" as never} />);
    const sandbox = screen.getByRole("region", { name: "Captura de teste (Sandbox)" });
    expect(sandbox.textContent).not.toContain("notas novas");
    expect(sandbox.textContent).toContain("Esta operação atingiu o limite do plano.");
  });
  describe("lacuna que a Receita não tem mais (#419)", () => {
    const quietSince = Date.UTC(2026, 6, 10, 15);
    const detectedAt = Date.UTC(2026, 9, 22, 15);
    const gapStream = (gap: Record<string, unknown>) => ({
      id: "stream",
      organizationId: "org",
      companyId: "company",
      projectId: "console",
      environment: "production",
      state: "attention",
      version: 7,
      checkpoint: "000000000000001",
      sourceCursor: "000000000000060",
      nextAllowedAt: 0,
      lastAttemptAt: detectedAt,
      lastSuccessAt: detectedAt,
      code: "RECONCILIATION_UNAVAILABLE",
      received: 1,
      operationId: "op",
      operationState: "succeeded",
      certificateState: "active",
      certificateExpiresAt: null,
      origin: { kind: "console", integration: null },
      sourceMaxNsu: "000000000000060",
      gap: { lost: null, recovering: null, accepted: [], ...gap },
    });
    const lost = {
      from: "000000000000002",
      to: "000000000000040",
      count: 39,
      quietSince,
      detectedAt,
    };
    // Only the owner accepts a loss (#442); an administrator manages everything else.
    const owner = {
      ...org,
      role: "owner",
      capabilities: { operateDocuments: true, manageOrganization: true },
    } as typeof org;
    const admin = { ...owner, role: "admin" } as typeof org;
    const REASON = "Notas do período conferidas no portal da Receita.";
    /** Past the dialog's settle time, when a click is a decision and not the opening gesture. */
    const settle = () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 1000);
    };
    afterEach(() => vi.restoreAllMocks());
    function show(stream: unknown, who = owner) {
      state.queries["captures:get:sandbox"] = null;
      state.queries["captures:get:production"] = stream;
      state.queries["captureRelease:status"] = release("released");
      render(<Captures org={who} companyId={"company" as never} />);
    }
    /** Opens the dialog, past its settle time, and writes the reason. */
    function openWith(reason = REASON) {
      fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda e continuar" }));
      settle();
      fireEvent.change(screen.getByRole("textbox", { name: "Motivo" }), {
        target: { value: reason },
      });
    }

    it("explica o período sem consulta, o que saiu da Receita e a consequência", () => {
      show(gapStream({ lost }));
      expect(screen.getByText("Parte do histórico não está mais na Receita")).toBeTruthy();
      expect(
        screen.getByText(/A captura ficou sem consultar a Receita de 10\/07\/2026 a 22\/10\/2026/),
      ).toBeTruthy();
      // An NSU is a note or an event, and a 137 may be an NSU never generated: "up to".
      expect(
        screen.getByText(/até 39 notas ou eventos da fila da empresa já saíram de lá/),
      ).toBeTruthy();
      expect(screen.queryByText(/documentos da fila/)).toBeNull();
      // No promise that the notes reach Production by another way.
      expect(screen.getByText(/não chegarão pela captura e não entrarão em Produção/)).toBeTruthy();
      expect(screen.queryByText(/importe/i)).toBeNull();
      expect(screen.getByText("NSU 2 a 40")).toBeTruthy();
      // An irreversible loss is not the highlighted path, and asking again changes nothing.
      const accept = screen.getByRole("button", { name: "Aceitar a perda e continuar" });
      expect(accept.className).toContain("ui-button--secondary");
      expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retomar captura" })).toBeNull();
    });

    const integration = { kind: "integration", integration: "ERP Serra" } as const;
    it("captura de integração (#442): o Proprietário decide aqui, e só isso; a captura segue na integração", () => {
      show({ ...gapStream({ lost }), origin: integration });
      expect(screen.getByText("Parte do histórico não está mais na Receita")).toBeTruthy();
      expect(
        screen.getByText(/a captura continua na integração, com a chave dela/).textContent,
      ).toContain("Esta captura é da integração “ERP Serra”");
      const accept = screen.getByRole("button", { name: "Aceitar a perda e continuar" });
      expect(accept.className).toContain("ui-button--secondary");
      // The decision does not hand the capture to the console: no other action, no "gerencie".
      expect(screen.queryByRole("button", { name: "Retomar captura" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Pausar captura" })).toBeNull();
      expect(screen.queryByText(/gerencie pela integração/)).toBeNull();
      // The actions block holds the acceptance alone: no pause, resume or transfer.
      const actions = accept.closest(".ui-actions")!;
      expect([...actions.querySelectorAll("button, a")].map((el) => el.textContent)).toEqual([
        "Aceitar a perda e continuar",
      ]);
      expect(screen.queryByText("Transferir esta captura para outra organização")).toBeNull();
    });

    it("captura de integração: o diálogo diz que ela continua na integração e confirma igual", async () => {
      state.mutate.mockResolvedValue({});
      show({ ...gapStream({ lost }), origin: integration });
      openWith();
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain(
        "A captura volta a ler do primeiro registro que a Receita ainda tem, na integração “ERP Serra”, com a chave dela. Essas notas e eventos não entrarão em Produção; a decisão não pode ser desfeita e fica registrada com o seu nome e o motivo.",
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda" }));
      });
      expect(state.mutate).toHaveBeenCalledWith("captures:acceptGap", {
        organizationId: "org",
        companyId: "company",
        environment: "production",
        expectedVersion: 7,
        from: "000000000000002",
        to: "000000000000040",
        reason: REASON,
      });
    });

    it("captura de integração sem acesso: a recusa fica no diálogo e diz o que fazer", async () => {
      const { ConvexError } = await import("convex/values");
      state.mutate.mockRejectedValue(new ConvexError({ code: "INTEGRATION_ACCESS_REVOKED" }));
      show({ ...gapStream({ lost }), origin: integration });
      openWith();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda" }));
      });
      const alert = screen.getByRole("alert").textContent;
      expect(alert).toContain("perdeu o acesso");
      expect(alert).toContain("Nada foi aceito");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it.each([
      ["Administrador", admin],
      ["Operador", org],
    ])("captura de integração: o %s vê a explicação, sem a ação", (_, who) => {
      show({ ...gapStream({ lost }), origin: integration }, who);
      expect(screen.queryByRole("button", { name: "Aceitar a perda e continuar" })).toBeNull();
      expect(
        screen.getByText("Somente o Proprietário decide aceitar a perda e continuar."),
      ).toBeTruthy();
      expect(screen.getByText(/Aqui, só o Proprietário aceita perdas\./)).toBeTruthy();
      expect(screen.queryByText(/gerencie pela integração/)).toBeNull();
    });

    it("o diálogo mostra o trecho, pede o motivo e confirma com ele e com a versão lida", async () => {
      state.mutate.mockResolvedValue({});
      show(gapStream({ lost }));
      fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda e continuar" }));
      settle();
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Aceitar a perda de até 39 notas ou eventos?");
      expect(dialog.textContent).toContain("não entrarão em Produção");
      expect(dialog.textContent).toContain("De 10/07/2026 a 22/10/2026");
      // Two short sentences: what happens, and what it costs; the notice explains the rest.
      expect(dialog.querySelector(".ui-dialog__description")!.textContent).toBe(
        "A captura volta a ler do primeiro registro que a Receita ainda tem. Essas notas e eventos não entrarão em Produção; a decisão não pode ser desfeita e fica registrada com o seu nome e o motivo.",
      );
      expect(dialog.textContent).toContain("NSU 2 a 40");
      // The reason is required: the field takes the focus, and confirming waits for it.
      const field = screen.getByRole("textbox", { name: "Motivo" }) as HTMLTextAreaElement;
      expect(document.activeElement).toBe(field);
      expect(field.required).toBe(true);
      const confirm = screen.getByRole("button", { name: "Aceitar a perda" }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      expect(screen.getByText(/0 de 500 caracteres/)).toBeTruthy();
      fireEvent.change(field, { target: { value: "   " } });
      expect(confirm.disabled).toBe(true);
      // Too long: an error next to the field, tied to it, and still no confirming.
      fireEvent.change(field, { target: { value: "a".repeat(503) } });
      expect(confirm.disabled).toBe(true);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      const error = screen.getByText("Use até 500 caracteres. Retire 3.");
      expect(field.getAttribute("aria-describedby")).toContain(error.parentElement!.id);
      fireEvent.change(field, { target: { value: `  ${REASON}  ` } });
      expect(confirm.disabled).toBe(false);
      expect(field.getAttribute("aria-invalid")).toBeNull();
      expect(state.mutate).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(confirm);
      });
      expect(state.mutate).toHaveBeenCalledWith("captures:acceptGap", {
        organizationId: "org",
        companyId: "company",
        environment: "production",
        expectedVersion: 7,
        from: "000000000000002",
        to: "000000000000040",
        reason: REASON,
      });
    });

    it("uma recusa do servidor fica no diálogo", async () => {
      const { ConvexError } = await import("convex/values");
      state.mutate.mockRejectedValue(new ConvexError({ code: "GAP_CONFIRMATION_MISMATCH" }));
      show(gapStream({ lost }));
      openWith();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda" }));
      });
      expect(screen.getByRole("alert").textContent).toContain("O trecho perdido mudou");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("se o papel mudou com o diálogo aberto, a recusa diz que só o Proprietário aceita", async () => {
      const { ConvexError } = await import("convex/values");
      state.mutate.mockRejectedValue(new ConvexError({ code: "ACCESS_DENIED" }));
      show(gapStream({ lost }));
      openWith();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Aceitar a perda" }));
      });
      expect(screen.getByRole("alert").textContent).toBe(
        "Somente o Proprietário pode aceitar a perda. Nada foi aceito.",
      );
    });

    it.each([
      ["Administrador", admin],
      ["Operador", org],
    ])("o %s vê a explicação, mas não a ação", (_, who) => {
      show(gapStream({ lost }), who);
      expect(screen.getByText("Parte do histórico não está mais na Receita")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Aceitar a perda e continuar" })).toBeNull();
      expect(
        screen.getByText("Somente o Proprietário decide aceitar a perda e continuar."),
      ).toBeTruthy();
    });

    it("sem o limite localizado, pede para retomar e não oferece aceitar", () => {
      show(gapStream({}));
      expect(screen.queryByRole("button", { name: "Aceitar a perda e continuar" })).toBeNull();
      expect(screen.getByText(/Retome a captura para localizar até onde vai/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retomar captura" })).toBeTruthy();
    });

    it("depois de aceita, a perda continua registrada com quem, quando e por quê", () => {
      show({
        ...gapStream({
          accepted: [
            {
              ...lost,
              acceptedAt: detectedAt + 3_600_000,
              acceptedBy: "Marta Ribeiro",
              reason: REASON,
            },
          ],
        }),
        state: "active",
        code: "HISTORY_LIMITED",
        operationState: "queued",
      });
      const line = screen.getByText(/Marta Ribeiro/).textContent;
      expect(line).toContain("aceitou a perda de até 39 notas ou eventos");
      expect(line).toContain(`Motivo: ${REASON}`);
      expect(screen.queryByText("Parte do histórico não está mais na Receita")).toBeNull();
    });

    it("uma pausa de um dia diz o dia, sem repetir a data", () => {
      const sameDay = { ...lost, quietSince: detectedAt - 3_600_000 };
      show(gapStream({ lost: sameDay }));
      expect(
        screen.getByText(/A captura ficou sem consultar a Receita em 22\/10\/2026\./),
      ).toBeTruthy();
      openWith();
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Em 22/10/2026");
      expect(dialog.textContent).not.toContain("a 22/10/2026");
    });

    it("captura de integração depois de aceita: o aviso diz o que fica com a integração, sem contradizer a perda aceita aqui", () => {
      show({
        ...gapStream({
          accepted: [
            {
              ...lost,
              acceptedAt: detectedAt + 3_600_000,
              acceptedBy: "Marta Ribeiro",
              reason: REASON,
            },
          ],
        }),
        origin: integration,
        state: "active",
        code: "HISTORY_LIMITED",
      });
      expect(
        screen.getByText(
          "Criada pela integração ERP Serra: sincronizar, pausar, retomar e transferir ficam com a integração. Aqui, só o Proprietário aceita perdas.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/O console altera só o que foi criado nele/)).toBeNull();
    });
  });
  /** A production capture stopped when its release was withdrawn, by the company or Freecorps. */
  const withdrawnStream = () => ({
    id: "stream",
    organizationId: "org",
    companyId: "company",
    projectId: "console",
    environment: "production",
    state: "paused",
    version: 4,
    checkpoint: "000000000000002",
    sourceCursor: null,
    nextAllowedAt: Date.now() + 3600_000,
    lastAttemptAt: null,
    lastSuccessAt: null,
    code: "CAPTURE_RELEASE_WITHDRAWN",
    received: 2,
    operationId: "op",
    operationState: "paused",
    certificateState: "active",
    certificateExpiresAt: null,
    origin: { kind: "console", integration: null },
    sourceMaxNsu: null,
  });
  it("desativada, fica só a leitura, sem iniciar", () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = withdrawnStream();
    state.queries["captureRelease:status"] = release("withdrawn");
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText("Captura fiscal desativada")).toBeTruthy();
    // Said once, on the release line: neither the stream's code nor a notice repeats it (#424).
    expect(
      screen.getAllByText("Os documentos já recebidos continuam em Documentos › Produção."),
    ).toHaveLength(1);
    expect(screen.queryByText(/A captura fiscal (está|foi) desativada/)).toBeNull();
    expect(screen.queryByText(/Captura pausada:/)).toBeNull();
    expect(screen.getByText("Nenhuma: consultas automáticas pausadas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar captura fiscal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retomar captura" })).toBeNull();
  });
  it("suspensa pela Freecorps: um aviso só, com o que aconteceu, o que fica e o que fazer", () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = withdrawnStream();
    state.queries["captureRelease:status"] = { ...release("withdrawn"), blocked: true };
    render(<Captures org={org} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    // The release line and the capture below used to say it three times (#424).
    const notices = production.querySelectorAll(".ui-callout");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.classList.contains("ui-callout--warning")).toBe(true);
    expect(notices[0]!.textContent).toContain("Captura fiscal suspensa pela Freecorps");
    expect(notices[0]!.textContent).toContain(
      "Os documentos já recebidos continuam em Documentos › Produção.",
    );
    expect(notices[0]!.textContent).toContain("Para reativar, fale com o suporte.");
    expect(production.textContent!.match(/suspen/g)).toHaveLength(1);
    expect(production.textContent!.match(/continuam/g)).toHaveLength(1);
    expect(production.textContent).not.toContain("capturados");
    // The capture keeps its badge and data, without a way to resume.
    expect(within(production).getByText("Captura pausada")).toBeTruthy();
    expect(within(production).getByText("Nenhuma: consultas automáticas pausadas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retomar captura" })).toBeNull();
  });
});

const live = (overrides: Record<string, unknown> = {}) => ({
  id: "stream",
  organizationId: "org",
  companyId: "company",
  projectId: "console",
  environment: "sandbox",
  state: "active",
  version: 3,
  checkpoint: "000000000000002",
  sourceCursor: null,
  nextAllowedAt: Date.now() + 3600_000,
  lastAttemptAt: Date.now() - 60_000,
  lastSuccessAt: Date.now() - 60_000,
  code: null,
  received: 2,
  operationId: "op",
  operationState: "succeeded",
  certificateState: "active",
  certificateExpiresAt: Date.now() + 30 * 86_400_000,
  origin: { kind: "console", integration: null },
  sourceMaxNsu: "000000000000002",
  gap: { lost: null, recovering: null, accepted: [] },
  ...overrides,
});
describe("organização da tela (#432)", () => {
  const manager = {
    ...org,
    role: "admin",
    capabilities: { operateDocuments: true, manageOrganization: true },
  } as typeof org;
  /**
   * The live regions of the page. A copy button's own "Copiado." (`ui/copy-button.tsx`) only
   * answers its click, so it is not a region of the capture's situation.
   */
  const statuses = () =>
    [...document.querySelectorAll("[role='status'], [aria-live]")].filter(
      (region) => !region.classList.contains("ui-copy__feedback"),
    );

  it("um ambiente por vez: Produção no seu cartão, sem o Sandbox; o Sandbox sem Produção", () => {
    state.queries["captures:get:sandbox"] = live();
    state.queries["captures:get:production"] = live({ environment: "production" });
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    expect(production.className).toContain("ui-card");
    expect(screen.queryByText("Captura de teste (Sandbox)")).toBeNull();
    // One name only.
    expect(document.body.textContent).not.toMatch(
      /captura fiscal real|Captura em Produção|ambiente fiscal|no fim da fila/i,
    );
    cleanup();
    // In the Sandbox, a company that already used Produção sees only its test capture.
    state.environment = "sandbox";
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByRole("region", { name: "Captura de teste (Sandbox)" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Captura fiscal (Produção)" })).toBeNull();
    expect(state.requested.has("captures:get:production")).toBe(true);
    cleanup();
    // Without the fiscal capture, the Sandbox is the only card, open.
    state.queries["captures:get:sandbox"] = live();
    state.queries["captureRelease:status"] = { ...release("none"), available: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByRole("region", { name: "Captura de teste (Sandbox)" })).toBeTruthy();
    expect(document.querySelector("details.capture-sandbox")).toBeNull();
  });

  it("agrupa Situação, Agenda, Volume e Certificado, sem NSU fora dos detalhes", () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = live({ environment: "production", received: 0 });
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    const production = screen.getByRole("region", { name: "Captura fiscal (Produção)" });
    for (const group of ["Situação", "Agenda", "Volume", "Certificado"])
      expect(within(production).getByRole("group", { name: group })).toBeTruthy();
    const agenda = within(production).getByRole("group", { name: "Agenda" });
    // The last query, answered or not, in one value.
    expect(within(agenda).getByText("Última consulta").nextElementSibling!.textContent).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2} \(respondida\)$/,
    );
    expect(within(agenda).queryByText("Última tentativa")).toBeNull();
    expect(within(agenda).getByText("Próxima consulta automática")).toBeTruthy();
    const volume = within(production).getByRole("group", { name: "Volume" });
    const received = within(volume).getByText("Documentos recebidos da fonte").nextElementSibling!;
    // The count reads as text in every environment, not as a code.
    expect(received.textContent).toBe("0");
    expect(received.querySelector(".ui-mono")).toBeNull();
    expect(within(volume).getByText("Fila na fonte").nextElementSibling!.textContent).toBe(
      "Em dia",
    );
    expect(production.textContent).not.toMatch(/Envelopes/);
    // NSU only inside the technical details.
    const details = within(production)
      .getByText("Detalhes técnicos (para o suporte)")
      .closest("details")!;
    const outside = production.textContent!.replace(details.textContent!, "");
    expect(outside).not.toMatch(/\bNSU\b|cursor|stream/i);
  });

  it("em atenção, o motivo e o que fazer ficam logo abaixo do selo, sem jargão", () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = live({
      environment: "production",
      state: "attention",
      code: "SOURCE_CONSUMPTION_BLOCKED",
      operationState: "succeeded",
    });
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    const situation = screen.getByRole("group", { name: "Situação" });
    const badge = within(situation).getByText("Captura precisa de atenção");
    const notice = badge.closest("p")!.nextElementSibling!;
    expect(notice.className).toContain("ui-callout--warning");
    expect(notice.textContent).toMatch(/^A Receita bloqueou por cerca de uma hora/);
    expect(notice.textContent).toContain("O que fazer: Retome a captura depois de uma hora.");
    expect(notice.textContent).not.toMatch(/\bNSU\b|cursor|stream/i);
    // Stopped: no time for the next automatic query (the same rule as the pause).
    expect(screen.getByText("Próxima consulta automática").nextElementSibling!.textContent).toBe(
      "Nenhuma: consultas automáticas paradas até alguém agir",
    );
  });

  it("uma só região de status, que só fala quando a situação muda", () => {
    state.queries["captures:get:sandbox"] = live();
    state.queries["captures:get:production"] = live({ environment: "production" });
    state.queries["captureRelease:status"] = release("released");
    const view = render(<Captures org={org} companyId={"company" as never} />);
    expect(statuses()).toHaveLength(1);
    const region = statuses()[0]!;
    // The first situation is already on the screen.
    expect(region.textContent).toBe("");
    // Updates of the stream that keep the situation say nothing.
    state.queries["captures:get:production"] = live({
      environment: "production",
      version: 4,
      received: 7,
      code: "NO_DOCUMENTS",
      lastSuccessAt: Date.now(),
      nextAllowedAt: Date.now() + 7200_000,
    });
    view.rerender(<Captures org={org} companyId={"company" as never} />);
    expect(statuses()).toHaveLength(1);
    expect(region.textContent).toBe("");
    // A change of situation is said once, with the capture's name and the reason.
    state.queries["captures:get:production"] = live({
      environment: "production",
      version: 5,
      state: "attention",
      code: "ATTEMPTS_EXHAUSTED",
      operationState: "failed",
    });
    view.rerender(<Captures org={org} companyId={"company" as never} />);
    expect(region.textContent).toBe(
      "Captura fiscal (Produção): Captura precisa de atenção. A consulta falhou em todas as tentativas permitidas. Nenhum documento recebido foi perdido.",
    );
    // The same attention with fresh numbers is not said again.
    state.queries["captures:get:production"] = live({
      environment: "production",
      version: 6,
      state: "attention",
      code: "ATTEMPTS_EXHAUSTED",
      operationState: "failed",
      received: 9,
    });
    state.queries["captures:get:sandbox"] = live({ version: 9, received: 3 });
    view.rerender(<Captures org={org} companyId={"company" as never} />);
    expect(region.textContent).toMatch(/^Captura fiscal \(Produção\): Captura precisa de atenção/);
    // The Sandbox is another environment: its pause is not said in Produção.
    state.queries["captures:get:sandbox"] = live({
      version: 10,
      state: "paused",
      code: "PAUSED_BY_USER",
      operationState: "paused",
    });
    view.rerender(<Captures org={org} companyId={"company" as never} />);
    expect(region.textContent).toMatch(/^Captura fiscal \(Produção\): Captura precisa de atenção/);
    expect(statuses()).toHaveLength(1);
    expect(document.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("um passo só: depois de ativar, o foco vai a Iniciar captura fiscal, sem iniciar sozinho", async () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captureRelease:status"] = { ...release("none"), canManage: true };
    state.mutate.mockResolvedValue({ version: 1, revokedKeys: 0 });
    const view = render(<Captures org={manager} companyId={"company" as never} />);
    fireEvent.click(screen.getByLabelText("Li e aceito os termos da captura fiscal"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ativar captura fiscal" }));
    });
    // The server answers through the subscriptions: released, no capture yet.
    state.queries["captureRelease:status"] = { ...release("released"), canManage: true };
    state.queries["captures:get:production"] = null;
    view.rerender(<Captures org={manager} companyId={"company" as never} />);
    const start = screen.getByRole("button", { name: "Iniciar captura fiscal" });
    expect(document.activeElement).toBe(start);
    expect(
      screen.getByRole("heading", { name: "Falta um passo: Iniciar captura fiscal" }),
    ).toBeTruthy();
    // Starting is the person's click: real queries to the Receita.
    expect(state.mutate.mock.calls.map((call) => call[0])).toEqual(["captureRelease:enable"]);
    // Opening the tab later does not take the focus.
    cleanup();
    render(<Captures org={manager} companyId={"company" as never} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("depois de iniciar, o foco vai à próxima ação quando a captura chega", async () => {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = release("released");
    state.mutate.mockResolvedValue({});
    const view = render(<Captures org={org} companyId={"company" as never} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar captura fiscal" }));
    });
    state.queries["captures:get:production"] = live({
      environment: "production",
      version: 1,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAllowedAt: 0,
      operationState: "queued",
      sourceMaxNsu: null,
    });
    view.rerender(<Captures org={org} companyId={"company" as never} />);
    // The first query waits; nothing says it was answered.
    expect(
      screen.getByText(
        /Primeira consulta na fila; o resultado aparece aqui quando a Receita responder/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Última consulta").nextElementSibling!.textContent).toBe(
      "Ainda não ocorreu",
    );
    expect((document.activeElement as HTMLElement).textContent).toBe("Pausar captura");
  });
});

/**
 * The main action follows what solves the cause (#432, `CaptureAction`): "Retomar captura" is the
 * main button only where resuming makes the capture go on; elsewhere it is secondary, or gives
 * way to the screen that solves it.
 */
describe("ação principal de uma captura em atenção, por código", () => {
  const attention = (code: string, overrides: Record<string, unknown> = {}) => ({
    id: "stream",
    organizationId: "org",
    companyId: "company",
    projectId: "console",
    environment: "production",
    state: "attention",
    version: 3,
    checkpoint: "000000000000002",
    sourceCursor: null,
    nextAllowedAt: 0,
    lastAttemptAt: Date.now() - 60_000,
    lastSuccessAt: null,
    code,
    received: 0,
    operationId: "op",
    operationState: "failed",
    certificateState: "active",
    certificateExpiresAt: Date.now() + 30 * 86_400_000,
    origin: { kind: "console", integration: null },
    sourceMaxNsu: null,
    gap: { lost: null, recovering: null, accepted: [] },
    freecorpsCut: false,
    ...overrides,
  });
  function show(stream: Record<string, unknown>) {
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = stream;
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    return screen.getByRole("region", { name: "Captura fiscal (Produção)" });
  }
  /** Every code the server leaves on a capture (`capture-messages.test.ts`), and its button. */
  const expected: Record<string, "main" | "secondary"> = {
    NO_DOCUMENTS: "main",
    HISTORY_LIMITED: "main",
    NSU_GAP: "main",
    RECONCILING_GAP: "main",
    SOURCE_CONSUMPTION_BLOCKED: "main",
    SOURCE_CURSOR_UNKNOWN: "main",
    RECONCILIATION_INCOMPLETE: "main",
    RECONCILIATION_UNAVAILABLE: "main",
    SOURCE_CURSOR_REGRESSION: "secondary",
    REPEATED_NSU: "main",
    NSU_CONTENT_CONFLICT: "secondary",
    ACCESS_REVOKED: "main",
    CAPTURE_INACTIVE: "main",
    SOURCE_COOLDOWN: "main",
    BATCH_UNAVAILABLE: "secondary",
    BATCH_HASH_MISMATCH: "secondary",
    FISCAL_TRANSPORT_DISABLED: "secondary",
    SOURCE_HTTP_ERROR: "main",
    SOURCE_RESULT_UNCERTAIN: "main",
    CAPTURE_CHANGED: "main",
    SOURCE_RESPONSE_INVALID: "secondary",
    OPERATION_CHANGED: "main",
    CERTIFICATE_CHANGED: "main",
    FISCAL_PROOF_DENIED: "secondary",
    FISCAL_PROOF_STEP_COMPLETE: "secondary",
    CAPTURE_FISCAL_DENIED: "main",
    CAPTURE_FISCAL_HALTED: "main",
    SITE_CAPTURE_HOURLY_LIMIT: "main",
    PAUSED_BY_USER: "main",
    CAPTURE_RELEASE_WITHDRAWN: "main",
    ATTEMPTS_EXHAUSTED: "main",
    RECOVERY_BUDGET_EXHAUSTED: "secondary",
    RECONCILIATION_REQUIRED: "main",
    QUOTA_EXCEEDED: "secondary",
    PLAN_INACTIVE: "secondary",
    TASK_FAILED: "main",
    TRANSFERRED: "main",
    // With a usable A1 again; without it, the way to Certificado (below).
    CERTIFICATE_UNAVAILABLE: "main",
    SOURCE_589: "secondary",
    SOURCE_108: "main",
    UNHEARD_OF: "secondary",
  };
  it.each(Object.entries(expected))("%s: Retomar captura %s", (code, button) => {
    const production = show(attention(code));
    const resume = within(production).getByRole("button", { name: "Retomar captura" });
    expect(resume.className).toContain(
      button === "main" ? "ui-button--primary" : "ui-button--secondary",
    );
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    // One main button on the screen at most, and none that resumes in vain.
    expect(production.querySelectorAll(".ui-button--primary")).toHaveLength(
      button === "main" ? 1 : 0,
    );
  });
  it("sem o A1, leva a Certificado no lugar de Retomar, que o servidor recusaria", () => {
    const production = show(attention("CERTIFICATE_UNAVAILABLE", { certificateState: "missing" }));
    expect(within(production).queryByRole("button", { name: "Retomar captura" })).toBeNull();
    const [main, group] = within(production).getAllByRole("link", { name: "Ver certificado" });
    expect(main!.className).toContain("ui-button--primary");
    expect(main!.getAttribute("href")).toBe("/app/equipe/companies/company?aba=certificado");
    // The Certificado group keeps its own link.
    expect(group!.className).toBe("ui-link");
  });
  it("no bloqueio da Receita (656), Retomar espera o horário e diz qual", () => {
    const until = Date.now() + 40 * 60_000;
    const production = show(attention("SOURCE_CONSUMPTION_BLOCKED", { nextAllowedAt: until }));
    const resume = within(production).getByRole("button", { name: "Retomar captura" });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    const reason = document.getElementById(resume.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toContain(
      `A Receita só aceita uma nova consulta deste CNPJ a partir de ${formatShortDateTime(until, Date.now())}.`,
    );
  });
  it("sem transporte, o que fazer pede o suporte e Retomar fica secundário", () => {
    const production = show(attention("FISCAL_TRANSPORT_DISABLED"));
    expect(within(production).getByText(/O que fazer:/).parentElement!.textContent).toContain(
      "Fale com o suporte da Freecorps e retome a captura só depois que o suporte confirmar a correção.",
    );
    expect(within(production).getByRole("button", { name: "Retomar captura" }).className).toContain(
      "ui-button--secondary",
    );
  });
  it.each(["FISCAL_TRANSPORT_DISABLED", "ACCESS_REVOKED"])(
    "%s do corte da Freecorps (#601): diz que ela pausou, e Retomar é a ação principal",
    (code) => {
      const production = show(attention(code, { freecorpsCut: true }));
      expect(
        within(production).getByText(/A Freecorps pausou a captura fiscal de todas as empresas/),
      ).toBeTruthy();
      expect(within(production).getByText(/O que fazer:/).parentElement!.textContent).toContain(
        "Retome a captura: ela continua do ponto em que parou.",
      );
      expect(within(production).queryByText(/Fale com o suporte/)).toBeNull();
      expect(within(production).queryByText(/Mudou o acesso/)).toBeNull();
      const resume = within(production).getByRole("button", { name: "Retomar captura" });
      expect(resume.className).toContain("ui-button--primary");
      // The code stays for support, as the integration sees it.
      expect(production.textContent).toContain(code);
    },
  );
  it("revogação real (sem a marca do corte): o motivo de sempre", () => {
    const production = show(attention("ACCESS_REVOKED", { freecorpsCut: false }));
    expect(within(production).getByText(/Mudou o acesso que mantinha a captura/)).toBeTruthy();
    expect(within(production).queryByText(/A Freecorps pausou/)).toBeNull();
  });
  it.each([
    ["ERP Serra", "A integração “ERP Serra” precisa retomar a captura"],
    [null, "A integração que ativou a captura precisa retomá-la"],
  ])(
    "captura da integração %s parada pelo corte: diz que a integração retoma pela API (#607)",
    (integration, who) => {
      const production = show(
        attention("ACCESS_REVOKED", {
          freecorpsCut: true,
          origin: { kind: "integration", integration },
        }),
      );
      expect(
        within(production).getByText(/A Freecorps pausou a captura fiscal de todas as empresas/),
      ).toBeTruthy();
      expect(within(production).getByText(/O que fazer:/).parentElement!.textContent).toBe(
        `O que fazer: ${who}, com a ação resume em POST /v1/connections/nfe. A captura continua do ponto em que parou.`,
      );
      expect(production.textContent).not.toMatch(/Retome/);
      expect(within(production).queryByRole("button", { name: "Retomar captura" })).toBeNull();
    },
  );
  it("captura de integração sem tentativas: a integração retoma e o suporte fica para depois (#607)", () => {
    const production = show(
      attention("ATTEMPTS_EXHAUSTED", {
        origin: { kind: "integration", integration: "ERP Serra" },
      }),
    );
    expect(within(production).getByText(/O que fazer:/).parentElement!.textContent).toBe(
      "O que fazer: A integração “ERP Serra” precisa retomar a captura, com a ação resume em POST /v1/connections/nfe. Se acontecer de novo, fale com o suporte da Freecorps com os detalhes técnicos abaixo.",
    );
    expect(production.textContent).not.toMatch(/Retome/);
  });
  it("captura de integração parada sem código: a integração retoma (#607)", () => {
    const production = show(
      attention("", { code: null, origin: { kind: "integration", integration: null } }),
    );
    expect(
      within(production).getByText("A captura parou e não consulta a fonte até alguém agir."),
    ).toBeTruthy();
    expect(within(production).getByText(/O que fazer:/).parentElement!.textContent).toBe(
      "O que fazer: A integração que ativou a captura precisa retomá-la, com a ação resume em POST /v1/connections/nfe. Se acontecer de novo, fale com o suporte da Freecorps com os detalhes técnicos abaixo.",
    );
    expect(production.textContent).not.toMatch(/Retome/);
  });
  it("captura de integração pausada: a fila diz que a integração retoma (#607)", () => {
    const production = show(
      attention("PAUSED_BY_USER", {
        state: "paused",
        sourceMaxNsu: "000000000000009",
        origin: { kind: "integration", integration: "ERP Serra" },
      }),
    );
    expect(within(production).getByText("Fila na fonte").nextElementSibling!.textContent).toBe(
      "Ainda há documentos para receber. A integração “ERP Serra” precisa retomar a captura, com a ação resume em POST /v1/connections/nfe.",
    );
    expect(production.textContent).not.toMatch(/Retome/);
  });
  it("no Sandbox sem fonte, Retomar também fica secundário", () => {
    state.environment = "sandbox";
    state.queries["captures:get:sandbox"] = attention("FISCAL_TRANSPORT_DISABLED", {
      environment: "sandbox",
    });
    state.queries["captureRelease:status"] = { ...release("none"), available: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText(/Nada a fazer aqui/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retomar captura" }).className).toContain(
      "ui-button--secondary",
    );
  });
  it("pausada, Retomar é a ação principal", () => {
    const production = show(attention("PAUSED_BY_USER", { state: "paused" }));
    expect(within(production).getByRole("button", { name: "Retomar captura" }).className).toContain(
      "ui-button--primary",
    );
  });
});

describe("um botão principal por tela (#432)", () => {
  it("um botão principal em Produção, e o Sandbox sozinho tem o seu", () => {
    const sandboxStream = {
      id: "sandbox",
      organizationId: "org",
      companyId: "company",
      projectId: "console",
      environment: "sandbox",
      state: "active",
      version: 3,
      checkpoint: "000000000000002",
      sourceCursor: null,
      nextAllowedAt: 0,
      lastAttemptAt: Date.now() - 60_000,
      lastSuccessAt: Date.now() - 60_000,
      code: null,
      received: 2,
      operationId: "op",
      operationState: "succeeded",
      certificateState: "active",
      certificateExpiresAt: null,
      origin: { kind: "console", integration: null },
      sourceMaxNsu: "000000000000002",
      gap: { lost: null, recovering: null, accepted: [] },
    };
    state.queries["captures:get:sandbox"] = sandboxStream;
    state.queries["captures:get:production"] = {
      ...sandboxStream,
      id: "production",
      environment: "production",
      state: "paused",
      code: "PAUSED_BY_USER",
    };
    state.queries["captureRelease:status"] = release("released");
    render(<Captures org={org} companyId={"company" as never} />);
    expect(document.querySelectorAll(".ui-button--primary")).toHaveLength(1);
    cleanup();
    state.environment = "sandbox";
    render(<Captures org={org} companyId={"company" as never} />);
    const sandbox = screen.getByRole("region", { name: "Captura de teste (Sandbox)" });
    expect(within(sandbox).getByRole("button", { name: "Sincronizar" }).className).toContain(
      "ui-button--primary",
    );
    expect(document.querySelectorAll(".ui-button--primary")).toHaveLength(1);
    cleanup();
    state.queries["captureRelease:status"] = { ...release("none"), available: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByRole("button", { name: "Sincronizar" }).className).toContain(
      "ui-button--primary",
    );
  });
  it("com o intervalo aberto, Salvar é o principal e Iniciar fica secundário", () => {
    const manager = {
      ...org,
      role: "admin",
      capabilities: { operateDocuments: true, manageOrganization: true },
    } as typeof org;
    state.queries["captures:get:sandbox"] = null;
    state.queries["captures:get:production"] = null;
    state.queries["captureRelease:status"] = { ...release("released"), canManage: true };
    render(<Captures org={manager} companyId={"company" as never} />);
    const start = () => screen.getByRole("button", { name: "Iniciar captura fiscal" });
    expect(start().className).toContain("ui-button--primary");
    fireEvent.click(screen.getByRole("button", { name: "Alterar intervalo" }));
    expect(screen.getByRole("button", { name: "Salvar intervalo" }).className).toContain(
      "ui-button--primary",
    );
    expect(start().className).toContain("ui-button--secondary");
    expect(document.querySelectorAll(".ui-button--primary")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(start().className).toContain("ui-button--primary");
  });
});

describe("ligações e últimas consultas (#433)", () => {
  const history = [
    {
      at: Date.now() - 60_000,
      kind: "query",
      outcome: "answered",
      status: "138",
      documents: 3,
      code: null,
    },
    {
      at: Date.now() - 3_660_000,
      kind: "recovery",
      outcome: "answered",
      status: "138",
      documents: 1,
      code: null,
    },
    {
      at: Date.now() - 7_260_000,
      kind: "query",
      outcome: "refused",
      status: "656",
      documents: null,
      code: "SOURCE_CONSUMPTION_BLOCKED",
    },
    {
      at: Date.now() - 10_860_000,
      kind: "query",
      outcome: "stopped",
      status: null,
      documents: null,
      code: "FISCAL_TRANSPORT_DISABLED",
    },
  ];
  const production = () => {
    state.queries["captures:get:sandbox"] = live();
    state.queries["captures:get:production"] = live({ environment: "production" });
    state.queries["captureRelease:status"] = release("released");
  };
  const card = () => screen.getByRole("region", { name: "Captura fiscal (Produção)" });

  it("liga a captura aos documentos de Produção e às notas só com resumo, com a contagem", () => {
    production();
    state.queries["documents:summaryCount:production"] = { count: 4, more: false };
    render(<Captures org={org} companyId={"company" as never} />);
    const volume = within(card()).getByRole("group", { name: "Volume" });
    expect(
      within(volume).getByRole("link", { name: "Ver documentos em Produção" }).getAttribute("href"),
    ).toBe("/app/equipe/documents?company=company&env=production");
    expect(
      within(volume)
        .getByRole("link", { name: "Ver notas só com resumo (4)" })
        .getAttribute("href"),
    ).toBe("/app/equipe/documents?company=company&env=production&completeness=summary");
  });
  it("sem notas só com resumo, ou acima do que o servidor conta", () => {
    production();
    state.queries["documents:summaryCount:production"] = { count: 0, more: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.queryByRole("link", { name: /Ver notas só com resumo/ })).toBeNull();
    cleanup();
    production();
    state.queries["documents:summaryCount:production"] = { count: 100, more: true };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByRole("link", { name: "Ver notas só com resumo (100+)" })).toBeTruthy();
  });
  it("o Sandbox leva aos documentos do Sandbox", () => {
    state.environment = "sandbox";
    state.queries["captures:get:sandbox"] = live();
    state.queries["captureRelease:status"] = { ...release("none"), available: false };
    render(<Captures org={org} companyId={"company" as never} />);
    expect(
      screen.getByRole("link", { name: "Ver documentos no Sandbox" }).getAttribute("href"),
    ).toBe("/app/equipe/documents?company=company&env=sandbox");
  });
  it("mostra hora, resultado e documentos de cada consulta, sem jargão", () => {
    production();
    state.queries["captures:history:production"] = history;
    render(<Captures org={org} companyId={"company" as never} />);
    const group = within(card()).getByRole("group", { name: "Últimas consultas" });
    // The newest query shows; the earlier ones open on request.
    expect(within(group).getAllByRole("row").slice(1)).toHaveLength(1);
    const more = within(group).getByRole("button", { name: "Mostrar as 3 consultas anteriores" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe("Mostrar só a última consulta");
    const rows = within(group).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells(rows[0]!)).toEqual([
      formatShortDateTime(history[0]!.at, Date.now()),
      "Respondida",
      "3",
    ]);
    expect(cells(rows[1]!)[1]).toBe("RespondidaBusca de um registro que faltou");
    expect(cells(rows[2]!)[1]).toMatch(/^Bloqueada por uma hora/);
    expect(cells(rows[2]!)[2]).toBe("—");
    expect(cells(rows[3]!)[1]).toBe(
      "Não concluídaA consulta à Receita está desligada neste ambiente da Freecorps.",
    );
    expect(group.textContent).toMatch(/Cada consulta enviada à Receita conta no limite/);
    expect(group.textContent).not.toMatch(/\bNSU\b|cursor|stream|lote|envelope/i);
  });
  it("sem consultas ainda, e carregando sem abrir outra região de status", () => {
    production();
    state.queries["captures:history:production"] = [];
    render(<Captures org={org} companyId={"company" as never} />);
    expect(
      within(within(card()).getByRole("group", { name: "Últimas consultas" })).getByText(
        "Nenhuma consulta ainda.",
      ),
    ).toBeTruthy();
    cleanup();
    production();
    delete state.queries["captures:history:production"];
    render(<Captures org={org} companyId={"company" as never} />);
    const group = within(card()).getByRole("group", { name: "Últimas consultas" });
    expect(group.textContent).toContain("Carregando as últimas consultas…");
    expect(group.querySelector("[role='status'], [aria-live]")).toBeNull();
  });
  it("o consumo leva a Uso e limites só para quem administra", () => {
    production();
    state.queries["captures:history:production"] = history;
    render(
      <Captures
        org={
          {
            ...org,
            role: "admin",
            capabilities: { operateDocuments: true, manageOrganization: true },
          } as typeof org
        }
        companyId={"company" as never}
      />,
    );
    expect(
      within(card()).getByRole("link", { name: "Ver o consumo em Uso e limites" }),
    ).toBeTruthy();
    cleanup();
    production();
    state.queries["captures:history:production"] = history;
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.queryByRole("link", { name: "Ver o consumo em Uso e limites" })).toBeNull();
  });
});
