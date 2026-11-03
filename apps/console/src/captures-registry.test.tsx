// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Captures, queueStatus, syncBlock } from "./captures";
import { Registry } from "./registry";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: (props: {
    to: string;
    params: { organizationSlug: string };
    children: React.ReactNode;
  }) => (
    <a href={props.to.replace("$organizationSlug", props.params.organizationSlug)}>
      {props.children}
    </a>
  ),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
const NOW = Date.UTC(2026, 9, 9, 15);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  // A deployment without the fiscal capture: the Sandbox alone, open.
  state.queries["captureRelease:status"] = {
    available: false,
    state: "none",
    blocked: false,
    minIntervalHours: 1,
    updatedAt: null,
    canManage: false,
    requirements: { declared: true, certificate: true },
    terms: "captura-fiscal-2026-10-22",
    acceptedTerms: null,
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.queries = {};
  state.mutate.mockReset();
});
const org = {
  id: "org",
  slug: "equipe",
  name: "Equipe",
  role: "operator",
  capabilities: { operateDocuments: true, manageOrganization: false },
} as unknown as Parameters<typeof Captures>[0]["org"];
// Owner/admin, who reach Uso e limites, and an operator, who does not.
const manager = {
  ...org,
  role: "admin",
  capabilities: { operateDocuments: true, manageOrganization: true },
} as typeof org;
/** The usage notice as each role reads it: the link for the manager, a manager for the others. */
function expectUsageNotice(notice: HTMLElement, asManager: boolean) {
  const link = notice.querySelector("a");
  if (asManager) {
    expect(notice.textContent).toMatch(/Gestão e integração › Uso e limites/);
    expect(link?.textContent).toBe("Abrir Uso e limites");
    expect(link?.getAttribute("href")).toBe("/app/equipe/usage");
  } else {
    expect(notice.textContent).toMatch(/Fale com um gestor da organização/);
    expect(link).toBeNull();
  }
}
const stream = (overrides: Record<string, unknown> = {}) => ({
  id: "stream",
  organizationId: "org",
  companyId: "company",
  projectId: "console",
  environment: "sandbox",
  state: "active",
  version: 3,
  checkpoint: "000000000000002",
  sourceCursor: null,
  nextAllowedAt: NOW + 3600_000,
  lastAttemptAt: NOW - 60_000,
  lastSuccessAt: NOW - 60_000,
  code: null,
  received: 2,
  operationId: "op",
  operationState: "succeeded",
  certificateState: "active",
  certificateExpiresAt: NOW + 30 * 86_400_000,
  origin: { kind: "console", integration: null },
  sourceMaxNsu: null,
  ...overrides,
});

describe("captura", () => {
  it("só libera Sincronizar na próxima consulta permitida e diz o horário", async () => {
    state.queries["captures:get"] = stream();
    render(<Captures org={org} companyId={"company" as never} />);
    const sync = screen.getByRole("button", { name: "Sincronizar" }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    const reason = document.getElementById(sync.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toContain(new Date(NOW + 3600_000).toLocaleString("pt-BR"));
    // Pausing stays available while the source window is closed.
    expect(
      (screen.getByRole("button", { name: "Pausar captura" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(3600_000 + 100);
    });
    expect(
      (screen.getByRole("button", { name: "Sincronizar" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("explica a consulta em andamento", () => {
    expect(syncBlock({ nextAllowedAt: 0, operationState: "running" }, NOW)).toMatch(/em andamento/);
    expect(syncBlock({ nextAllowedAt: 0, operationState: "succeeded" }, NOW)).toBeNull();
  });

  it("consulta enviada e sem resposta: não mostra a reserva de 1 h como próxima consulta", () => {
    state.queries["captures:get"] = stream({
      operationState: "running",
      lastAttemptAt: NOW - 2_000,
      lastSuccessAt: NOW - 20_000,
      nextAllowedAt: NOW - 2_000 + 3600_000,
    });
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText("Consulta em andamento")).toBeTruthy();
    const sync = screen.getByRole("button", { name: "Sincronizar" });
    expect(document.getElementById(sync.getAttribute("aria-describedby")!)!.textContent).toMatch(
      /consulta à fonte está em andamento/,
    );
    expect(screen.queryByText(new Date(NOW - 2_000 + 3600_000).toLocaleString("pt-BR"))).toBeNull();
  });

  it("diz se a fila na fonte está em dia ou ainda tem documentos", () => {
    const at = (checkpoint: string, state = "active") =>
      queueStatus({ checkpoint, sourceMaxNsu: "000000000002551", state } as never);
    expect(at("000000000002551")).toBe("Em dia");
    expect(at("000000000002467")).toBe(
      "Ainda há documentos para receber. A captura continua lendo.",
    );
    expect(at("000000000002467", "paused")).toMatch(/Retome a captura/);
    // The NSU stays in the technical details (#432).
    expect(at("000000000002467")).not.toMatch(/NSU|\d{6}/);
    expect(
      queueStatus({ checkpoint: "0", sourceMaxNsu: null, state: "active" } as never),
    ).toBeNull();
    state.queries["captures:get"] = stream({ sourceMaxNsu: "000000000000009" });
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText("Fila na fonte").nextElementSibling!.textContent).toBe(
      "Ainda há documentos para receber. A captura continua lendo.",
    );
    const details = screen.getByText("Detalhes técnicos (para o suporte)").closest("details")!;
    expect(details.textContent).toContain("Maior NSU disponível na fonte: 000000000000009");
  });

  it("mostra a origem e não oferece controle de uma captura de integração", () => {
    state.queries["captures:get"] = stream({
      projectId: "erp",
      origin: { kind: "integration", integration: "ERP sintético" },
    });
    render(<Captures org={org} companyId={"company" as never} />);
    expect(screen.getByText("Origem: Integração ERP sintético")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sincronizar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pausar captura" })).toBeNull();
    expect(
      screen.getByText(
        "Criada pela integração ERP sintético: sincronizar, pausar, retomar e transferir ficam com a integração. Aqui, só o Proprietário aceita perdas.",
      ),
    ).toBeTruthy();
  });

  it.each([
    ["gestor", true],
    ["operador", false],
  ])("plano fora da vigência ao ativar: aviso pelo papel (%s)", async (_, asManager) => {
    state.queries["captures:get"] = null;
    state.mutate.mockRejectedValue(new ConvexError({ code: "PLAN_INACTIVE" }));
    render(<Captures org={asManager ? manager : org} companyId={"company" as never} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ativar captura no sandbox" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("captures:activate", expect.anything());
    // Next to the button and focused, which reads it out; no live region on top of that.
    const notice = document.activeElement as HTMLElement;
    expect(notice.textContent).toMatch(/O plano está fora da vigência/);
    expect(screen.queryByRole("alert")).toBeNull();
    expectUsageNotice(notice, asManager);
  });

  it.each([
    ["gestor", true],
    ["operador", false],
  ])("captura pausada pela cota: motivo pelo papel (%s)", (_, asManager) => {
    state.queries["captures:get"] = stream({
      state: "attention",
      code: "QUOTA_EXCEEDED",
      operationState: "paused",
    });
    const view = render(
      <Captures org={asManager ? manager : org} companyId={"company" as never} />,
    );
    const notice = view.getByText(/Esta operação atingiu o limite do plano/);
    expectUsageNotice(notice, asManager);
  });

  it("erro que não é de cota continua com a mensagem da captura, sem link", async () => {
    state.queries["captures:get"] = null;
    state.mutate.mockRejectedValue(new ConvexError({ code: "CERTIFICATE_UNAVAILABLE" }));
    render(<Captures org={manager} companyId={"company" as never} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ativar captura no sandbox" }));
    });
    const notice = document.activeElement as HTMLElement;
    expect(notice.textContent).toBe(
      "A empresa não tem um certificado A1 válido e ativo. Envie ou ative o certificado A1 da empresa em Certificado e tente de novo.",
    );
    expect(notice.querySelector("a")).toBeNull();
  });
});

describe("consulta CNPJ", () => {
  const lookup = (refreshAfter: number | null) => ({
    cnpj: "11222333000181",
    provider: "opencnpj",
    sourceUrl: "https://opencnpj.org/",
    status: "found",
    freshness: "fresh",
    data: null,
    sourceUpdatedAt: null,
    consultedAt: NOW - 60_000,
    lastAttemptAt: NOW - 60_000,
    expiresAt: refreshAfter,
    refreshAfter,
    version: 1,
  });
  const company = {
    id: "company",
    kind: "declared",
    cnpj: "11222333000181",
    capabilities: { manage: false },
  } as unknown as Parameters<typeof Registry>[0]["company"];

  it("espera a próxima consulta permitida para atualizar e diz o horário", async () => {
    state.queries["registry:get"] = lookup(NOW + 86_400_000);
    render(<Registry org={org} company={company} contextKey="test" />);
    const button = screen.getByRole("button", { name: "Atualizar consulta" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby")!)!.textContent,
    ).toContain(new Date(NOW + 86_400_000).toLocaleString("pt-BR"));
    await act(async () => {
      vi.advanceTimersByTime(86_400_000 + 100);
    });
    expect(
      (screen.getByRole("button", { name: "Atualizar consulta" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("libera atualizar sem consulta anterior", () => {
    state.queries["registry:get"] = lookup(null);
    render(<Registry org={org} company={company} contextKey="test" />);
    expect(
      (screen.getByRole("button", { name: "Atualizar consulta" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it.each([
    ["gestor", true],
    ["operador", false],
  ])("plano fora da vigência ao atualizar: aviso pelo papel (%s)", async (_, asManager) => {
    state.queries["registry:get"] = lookup(null);
    state.mutate.mockRejectedValue(new ConvexError({ code: "PLAN_INACTIVE" }));
    render(<Registry org={asManager ? manager : org} company={company} contextKey="test" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar consulta" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("registry:refresh", expect.anything());
    expectUsageNotice(screen.getByRole("alert"), asManager);
  });

  it.each([
    ["gestor", true],
    ["operador", false],
  ])("consulta pausada pela cota: motivo pelo papel (%s)", async (_, asManager) => {
    state.queries["registry:get"] = lookup(null);
    state.queries["operations:get"] = { id: "op", state: "paused", code: "QUOTA_EXCEEDED" };
    state.mutate.mockResolvedValue({ operationId: "op" });
    const view = render(
      <Registry org={asManager ? manager : org} company={company} contextKey="test" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar consulta" }));
    });
    expect(screen.getByText(/A consulta não foi concluída/)).toBeTruthy();
    expectUsageNotice(view.getByText(/Esta operação atingiu o limite do plano/), asManager);
  });

  it("limite técnico continua com a mensagem própria, sem orientação de plano", async () => {
    state.queries["registry:get"] = lookup(null);
    state.mutate.mockRejectedValue(new ConvexError({ code: "RATE_LIMITED" }));
    render(<Registry org={manager} company={company} contextKey="test" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar consulta" }));
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Limite atingido. Aguarde um minuto e tente novamente.");
    expect(alert.querySelector("a")).toBeNull();
  });
});
