// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { groupAuditRows, Operations, referenceFrom } from "./operations";
import { actionLabel, actorLabel, codeLabel } from "./operation-labels";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  queries: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  mutate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  Link: ({ children, search }: { children: React.ReactNode; search?: { ref?: string } }) => (
    <a href={search?.ref ? `?ref=${search.ref}` : "#"}>{children}</a>
  ),
}));
vi.mock("convex/react", () => ({
  useMutation: () => state.mutate,
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(fn);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.queries[name];
  },
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results: getFunctionName(fn) === "observability:audit" ? auditRows : [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));
const org = { id: "org", slug: "equipe", name: "Equipe" } as unknown as Parameters<
  typeof Operations
>[0]["org"];
const base = {
  organizationId: "org",
  target: "op1",
  operationId: "op1",
  expiresAt: 0,
  _creationTime: 0,
};
const auditRows = [
  {
    ...base,
    _id: "a1",
    actor: "membership:m1",
    action: "operation.accepted",
    companyId: "c1",
    createdAt: Date.UTC(2026, 9, 9, 12),
  },
  ...[1, 2, 3].map((i) => ({
    ...base,
    _id: `t${i}`,
    actor: "system",
    action: "operation.TRANSPORT_UNCERTAIN",
    code: "TRANSPORT_UNCERTAIN",
    companyId: "c1",
    createdAt: Date.UTC(2026, 9, 9, 12, i),
  })),
  {
    ...base,
    _id: "x1",
    actor: "user:u9",
    action: "custom.unknown_action",
    target: "alvo",
    operationId: undefined,
    createdAt: Date.UTC(2026, 9, 9, 13),
  },
];
beforeEach(() => {
  state.search = {};
  state.calls = [];
  state.queries = {
    "observability:overview": {
      monitors: [
        {
          _id: "mon1",
          companyId: "c1",
          projectId: "p1",
          ownerMembershipId: "m1",
          enabled: true,
          generation: 1,
          metrics: [],
          thresholds: {},
        },
      ],
      alerts: [],
      notifications: [],
      defaults: {},
    },
    "observability:names": {
      actors: [
        { ref: "membership:m1", name: "Maria Gestora" },
        { ref: "m1", name: "Maria Gestora" },
      ],
      companies: [{ ref: "c1", name: "Padaria Sintética" }],
      projects: [{ ref: "p1", name: "ERP Sintético" }],
    },
    "observability:investigate": auditRows,
    "observability:operation": undefined,
  };
});
afterEach(() => {
  cleanup();
  state.navigate.mockReset();
});

it("traduz ações e códigos com fallback para o código bruto", () => {
  expect(actionLabel("operation.TRANSPORT_UNCERTAIN")).toBe(
    "Resultado do envio incerto; será reconciliado",
  );
  expect(actionLabel("operation.accepted")).toBe("Operação aceita");
  expect(actionLabel("export.requested")).toBe("Exportação solicitada");
  // The fiscal capture's interval changes without turning it off (#432).
  expect(actionLabel("capture.fiscal_interval_changed")).toBe(
    "Intervalo mínimo da captura fiscal alterado",
  );
  expect(actionLabel("capture.interval_postponed")).toBe(
    "Próxima consulta adiada pelo novo intervalo",
  );
  expect(actionLabel("operation.ALGO_NOVO")).toBe("operation.ALGO_NOVO");
  expect(actionLabel("custom.unknown_action")).toBe("custom.unknown_action");
  expect(codeLabel("CODIGO_DESCONHECIDO")).toBe("CODIGO_DESCONHECIDO");
  expect(actorLabel("key:k1", "ERP")).toBe("Chave de API “ERP”");
  expect(actorLabel("key:k1", undefined)).toBe("Chave de API");
  expect(actorLabel("membership:m1", undefined)).toBe("Membro da organização");
  expect(actorLabel("system", undefined)).toBe("Sistema (automático)");
  expect(actorLabel("k17ce357pckst4k1tt6bbppcfs8fzn1r", undefined)).toBe("Membro da organização");
  expect(actorLabel("controlled-proof", undefined)).toBe("controlled-proof");
});

it("agrupa repetições da mesma operação, mesmo intercaladas com outras", () => {
  const groups = groupAuditRows(auditRows as never);
  expect(groups.map((g) => [g.first._id, g.count])).toEqual([
    ["a1", 1],
    ["t1", 3],
    ["x1", 1],
  ]);
  const row = (id: string, action: string, operationId: string) => ({
    ...base,
    _id: id,
    actor: "system",
    action,
    operationId,
    target: operationId,
    createdAt: 0,
  });
  const interleaved = groupAuditRows([
    row("u1", "operation.TRANSPORT_UNCERTAIN", "op1"),
    row("e1", "export.requested", "exp"),
    row("u2", "operation.TRANSPORT_UNCERTAIN", "op1"),
    row("r1", "operation.retry_requested", "op1"),
    row("u3", "operation.TRANSPORT_UNCERTAIN", "op1"),
  ] as never);
  // Outra operação no meio não separa; uma etapa diferente da mesma operação separa.
  expect(interleaved.map((g) => [g.first._id, g.count])).toEqual([
    ["u1", 2],
    ["e1", 1],
    ["r1", 1],
    ["u3", 1],
  ]);
});

it("lê ?ref= da URL e abre a investigação sem copiar e colar", () => {
  expect(referenceFrom({ ref: "  op1 " })).toBe("op1");
  expect(referenceFrom({ ref: 12345 })).toBe("12345");
  expect(referenceFrom({})).toBe("");
  state.search = { ref: "op1" };
  render(<Operations org={org} contextKey="ctx" />);
  expect(screen.getByRole("heading", { name: "Investigação da ocorrência" })).toBe(
    document.activeElement,
  );
  expect(state.calls.find((c) => c.name === "observability:investigate")?.args).toMatchObject({
    reference: "op1",
    organizationId: "org",
  });
  expect(screen.getByLabelText("Referência da solicitação, operação ou evento")).toHaveProperty(
    "value",
    "op1",
  );
});

it("busca e limpeza atualizam o parâmetro ref da rota", () => {
  render(<Operations org={org} contextKey="ctx" />);
  fireEvent.change(screen.getByLabelText("Referência da solicitação, operação ou evento"), {
    target: { value: " req-123 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Investigar" }));
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/app/$organizationSlug/operations",
    params: { organizationSlug: "equipe" },
    search: { ref: "req-123" },
  });
  cleanup();
  state.search = { ref: "req-123" };
  render(<Operations org={org} contextKey="ctx" />);
  fireEvent.click(screen.getByRole("button", { name: "Limpar investigação" }));
  expect(state.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ search: {} }));
});

it("mostra nomes, ações legíveis, eventos agrupados e referência clicável", () => {
  render(<Operations org={org} contextKey="ctx" />);
  expect(screen.getByRole("heading", { name: "Padaria Sintética" })).toBeTruthy();
  expect(screen.getByText("Monitor ativo")).toBeTruthy();
  expect(screen.getByText(/Projeto: ERP Sintético/)).toBeTruthy();
  expect(screen.getByText(/Responsável: Maria Gestora/)).toBeTruthy();
  const audit = screen.getByRole("region", { name: "Auditoria" });
  expect(within(audit).getByText("Operação aceita", { selector: "strong" })).toBeTruthy();
  expect(within(audit).getByText(/Por Maria Gestora · Empresa: Padaria Sintética/)).toBeTruthy();
  expect(
    within(audit).getAllByText("Resultado do envio incerto; será reconciliado", {
      selector: "strong",
    }),
  ).toHaveLength(1);
  expect(within(audit).getByText(/^3 vezes, de /)).toBeTruthy();
  // Ação desconhecida aparece pelo código; ator fora da resolução usa rótulo genérico.
  expect(within(audit).getByText("custom.unknown_action", { selector: "strong" })).toBeTruthy();
  expect(within(audit).getByText(/Por Membro da organização/)).toBeTruthy();
  const links = within(audit).getAllByRole("link", { name: "Investigar esta referência" });
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["?ref=op1", "?ref=op1", "?ref=alvo"]);
  // Código bruto continua disponível para o suporte.
  expect(
    within(audit).getAllByText("operation.TRANSPORT_UNCERTAIN", { selector: "code" }).length,
  ).toBeGreaterThan(0);
  const names = state.calls.find((c) => c.name === "observability:names" && c.args !== "skip");
  expect(names?.args).toMatchObject({ organizationId: "org" });
});

it("diz no painel por que um monitor parou sozinho (#422)", () => {
  const monitor = (state.queries["observability:overview"] as { monitors: object[] }).monitors[0];
  state.queries["observability:overview"] = {
    ...(state.queries["observability:overview"] as object),
    monitors: [
      {
        ...monitor,
        enabled: false,
        stopped: { code: "CAPTURE_RELEASE_WITHDRAWN", at: Date.UTC(2026, 9, 20, 12) },
      },
      { ...monitor, _id: "mon2", enabled: false },
      {
        ...monitor,
        _id: "mon3",
        enabled: false,
        stopped: { code: "ACCESS_REVOKED", at: Date.UTC(2026, 9, 20, 12) },
      },
    ],
  };
  render(<Operations org={org} contextKey="ctx" />);
  expect(screen.getByText("Monitor parado: captura fiscal retirada")).toBeTruthy();
  expect(screen.getByText(/Os documentos já capturados continuam disponíveis/)).toBeTruthy();
  expect(screen.getByText("Monitor parado: acesso revogado")).toBeTruthy();
  // A monitor a manager paused has no notice: only the stops the server made say why.
  expect(screen.getAllByText(/^Monitor parado:/)).toHaveLength(2);
});

it("explica que a operação de uma integração é controlada pela API dela", async () => {
  state.search = { ref: "op1" };
  state.queries["observability:operation"] = {
    state: "queued",
    attempts: 0,
    nextAttemptAt: null,
    generation: 1,
    uncertain: false,
  };
  state.mutate.mockRejectedValueOnce(
    new ConvexError({ code: "INTEGRATION_RECORD", integration: "ERP Sintético" }),
  );
  render(<Operations org={org} contextKey="ctx" />);
  expect(screen.getByRole("heading", { name: "Operação: Na fila" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Pausar operação" }));
  });
  expect(screen.getByRole("alert").textContent).toMatch(/Criado pela integração ERP Sintético/);
  state.queries["observability:operation"] = undefined;
});
