// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import type { Organization } from "./organizations";
import { Plans, type PlansOverview } from "./plans";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  queryError: null as unknown,
  queries: [] as Array<{ name: string; args: unknown }>,
  claim: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock("./convex-query", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.queries.push({ name: getFunctionName(fn), args });
    if (state.queryError) throw state.queryError;
    return state.data;
  },
}));
vi.mock("convex/react", () => ({
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(fn);
    if (name === "plans:claimFree") return state.claim;
    if (name === "plans:requestPaid") return state.request;
    if (name === "plans:cancelRequest") return state.cancel;
    throw new Error(`Unexpected mutation: ${name}`);
  },
  useAction: (fn: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(fn);
    if (name === "billing:checkout") return state.checkout;
    throw new Error(`Unexpected action: ${name}`);
  },
}));
const org = { id: "org-one", slug: "equipe", name: "Equipe", role: "owner" } as Organization;
const requestId = "request-one" as GenericId<"platformPlanRequests">;
function overview(): PlansOverview {
  return {
    enabled: true,
    offers: (["free", "intermediate", "large"] as const).map((tier, index) => ({
      tier,
      name: ["Gratuito", "Intermediário", "Grande"][index]!,
      monthlyCents: [0, 14900, 49900][index]!,
      limits: {
        imports: 100,
        captures: 50,
        registry: 10,
        bytes: 1048576,
        deliveries: 100,
        ...(tier === "free" ? { notes: 100 } : {}),
      },
      concurrency: 2,
      capacity: {
        companies: [1, 5, 10][index]!,
        members: 2,
        projects: 1,
        filesBytes: 1048576,
        databaseBytes: 1048576,
        downloadsBytes: 1048576,
        exportsBytes: 1048576,
        exportsCount: 2,
        restReads: 100,
      },
    })),
    subscription: null,
    request: null,
    availability: { canClaimFree: true, reason: null },
    annualEnabled: false,
    pixEnabled: true,
    annualStarts: { now: true, next: true },
    checkout: false,
    terms: [],
  };
}
function pending(): NonNullable<PlansOverview["request"]> {
  return {
    id: requestId,
    tier: "intermediate",
    amountCents: 14900,
    state: "awaiting_payment",
    period: "2026-10",
    cycle: "monthly",
    start: null,
    firstPeriod: null,
  };
}
beforeEach(() => {
  state.data = overview();
  state.queryError = null;
  state.queries = [];
  state.claim.mockReset().mockResolvedValue(null);
  state.request
    .mockReset()
    .mockResolvedValue({ id: requestId, amountCents: 14900, period: "2026-10" });
  state.cancel.mockReset().mockResolvedValue(null);
  state.checkout.mockReset().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_up" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function show(role: Organization["role"] = "owner") {
  return render(<Plans org={{ ...org, role }} contextKey="entry-one" />);
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

it("loads without publishing an offer and hides contracting while disabled", () => {
  state.data = undefined;
  const view = show();
  expect(screen.getByText("Carregando planos…")).toBeTruthy();
  expect(screen.queryByText("Escolha seu plano")).toBeNull();
  state.data = { ...overview(), enabled: false };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("A contratação de planos está indisponível no momento.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button", { name: "Ativar gratuito" })).toBeNull();
});

it("shows no available offers instead of manufacturing an offer", () => {
  state.data = { ...overview(), offers: [] };
  show();
  expect(screen.getByText(/Nenhum plano disponível/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ativar gratuito" })).toBeNull();
});

it("compares real prices, companies and quotas without requiring consulting", () => {
  show();
  const rows = within(screen.getByRole("table", { name: "Planos e limites" })).getAllByRole("row");
  for (const [index, name, value, companies] of [
    [1, "Gratuito", "R$ 0,00", "1"],
    [2, "Intermediário", "R$ 149,00", "5"],
    [3, "Grande", "R$ 499,00", "10"],
  ] as const) {
    expect(within(rows[index]!).getByText(name)).toBeTruthy();
    expect(within(rows[index]!).getByText(value)).toBeTruthy();
    expect(
      within(rows[index]!).getByText(companies, { selector: ".ui-table__value" }),
    ).toBeTruthy();
  }
  expect(screen.getByText("Sem vencimento")).toBeTruthy();
  expect(screen.getByText(/Consultoria opcional por R\$\s180,00\/hora/)).toBeTruthy();
  expect(screen.getByText(/Solicite um orçamento pelo canal de atendimento/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Convex|custódia|checkout|emissão real/);
});

it("the free tier lists new notes in Production and its sandbox quotas; paid tiers keep files and queries", () => {
  show();
  const rows = within(screen.getByRole("table", { name: "Planos e limites" })).getAllByRole("row");
  const free = rows[1]!.textContent!;
  expect(free).toContain("Notas novas em Produção por mês100, somando importação e captura");
  expect(free).toContain("Importações por mês no Sandbox100");
  expect(free).toContain("Consultas de captura por mês no Sandbox50");
  const paid = rows[2]!.textContent!;
  expect(paid).not.toContain("Notas novas");
  expect(paid).toContain("Importações por mês100");
  expect(paid).toContain("Consultas de captura por mês50");
});

it.each(["developer", "operator", "viewer"] as const)("%s can read but cannot contract", (role) => {
  show(role);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByText(/Apenas o proprietário e administradores/)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ativar gratuito" }).disabled).toBe(
    true,
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Solicitar Intermediário" }).disabled,
  ).toBe(true);
});

it("owner activates free only after confirmation and reflects the subscription", async () => {
  const view = show();
  await click("Ativar gratuito");
  expect(state.claim).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog").textContent).toContain("sem vencimento, para 1 empresa");
  await click("Confirmar ativação");
  expect(state.claim).toHaveBeenCalledWith({ organizationId: "org-one" });
  expect(screen.getByRole("status").textContent).toContain("Plano gratuito ativado");
  state.data = {
    ...overview(),
    subscription: { tier: "free", endsAt: null, version: 1 },
    availability: { canClaimFree: false, reason: "ALREADY_ACTIVE" },
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("Plano atual")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ativar gratuito" }).disabled).toBe(
    true,
  );
});

it("refusal leaves the dialog open and makes retry possible without claiming success", async () => {
  state.claim.mockRejectedValueOnce(new ConvexError({ code: "ACCESS_DENIED" }));
  show();
  await click("Ativar gratuito");
  await click("Confirmar ativação");
  expect(screen.getByRole("alert").textContent).toContain("Seu acesso mudou");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Confirmar ativação" }).disabled,
  ).toBe(false);
  expect(screen.queryByText(/Plano gratuito ativado/)).toBeNull();
  await click("Confirmar ativação");
  expect(state.claim).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("registers a paid request, discloses the integral UTC month and never claims activation", async () => {
  const view = show();
  await click("Solicitar Intermediário");
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toMatch(/R\$\s149,00 pelo mês corrente em UTC/);
  expect(dialog.textContent).toContain("inclusive no último dia do mês");
  expect(dialog.textContent).toContain("no início do próximo mês");
  await click("Registrar pedido");
  expect(state.request).toHaveBeenCalledWith({
    organizationId: "org-one",
    tier: "intermediate",
    key: expect.any(String),
  });
  expect(screen.queryByText(/Pedido registrado/)).toBeNull();
  expect(screen.queryByText(/Pagamento confirmado|Plano gratuito ativado/)).toBeNull();
  state.data = {
    ...overview(),
    subscription: { tier: "free", endsAt: null, version: 1 },
    request: pending(),
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("Aguardando pagamento")).toBeTruthy();
  expect(screen.getByText(/Pedido registrado/)).toBeTruthy();
  expect(screen.getByText("2026-10")).toBeTruthy();
  expect(screen.getByText(/O plano atual continua durante a espera/)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Solicitar Grande" }).disabled).toBe(
    true,
  );
  state.data = {
    ...overview(),
    subscription: { tier: "intermediate", endsAt: Date.UTC(2026, 10, 1), version: 2 },
    request: { ...pending(), state: "activated" },
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("Pagamento confirmado")).toBeTruthy();
  expect(screen.queryByText(/Pedido registrado/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
  state.data = { ...overview(), subscription: { tier: "intermediate", endsAt: null, version: 2 } };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.queryByText(/Pedido registrado/)).toBeNull();
});

it("keeps the idempotency key after an uncertain response and reopening", async () => {
  state.request.mockRejectedValueOnce(new Error("Network"));
  show();
  await click("Solicitar Grande");
  await click("Registrar pedido");
  expect(screen.getByRole("alert").textContent).toContain("Não foi possível concluir");
  const first = state.request.mock.calls[0]![0] as { key: string };
  await click("Cancelar");
  await click("Solicitar Grande");
  await click("Registrar pedido");
  expect(state.request.mock.calls[1]![0]).toEqual({
    organizationId: "org-one",
    tier: "large",
    key: first.key,
  });
});

it("confirms cancellation, waits for the server, and keeps the current plan", async () => {
  state.data = { ...overview(), request: pending() };
  const view = show();
  await click("Cancelar pedido");
  await click("Cancelar");
  expect(state.cancel).not.toHaveBeenCalled();
  await click("Cancelar pedido");
  await click("Confirmar cancelamento");
  expect(state.cancel).toHaveBeenCalledWith({ organizationId: "org-one", requestId });
  expect(screen.getByRole("status").textContent).toContain(
    "Pedido cancelado. O plano atual foi mantido.",
  );
  state.data = { ...overview(), request: { ...pending(), state: "cancelled" } };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("Pedido cancelado")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
});

it("handles unavailable free tier without exposing an internal reason", () => {
  state.data = {
    ...overview(),
    availability: { canClaimFree: false, reason: "private-internal-reason" },
  };
  show();
  expect(screen.getByText(/Gratuito indisponível para esta organização/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private-internal-reason");
});

it("a cancellation refusal preserves the pending request and allows another attempt", async () => {
  state.data = { ...overview(), request: pending() };
  state.cancel.mockRejectedValueOnce(new ConvexError({ code: "PLAN_REQUEST_UNAVAILABLE" }));
  show();
  await click("Cancelar pedido");
  await click("Confirmar cancelamento");
  expect(screen.getByRole("alert").textContent).toContain("Este pedido mudou");
  expect(screen.queryByText("Pedido cancelado. O plano atual foi mantido.")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Confirmar cancelamento" }).disabled,
  ).toBe(false);
});

it("does not cancel a different request that arrives while its confirmation is open", async () => {
  state.data = { ...overview(), request: pending() };
  const view = show();
  await click("Cancelar pedido");
  state.data = { ...overview(), request: { ...pending(), id: "request-two" } };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Confirmar cancelamento" }).disabled,
  ).toBe(true);
  expect(state.cancel).not.toHaveBeenCalled();
});

it("only offers cancellation to managers and replaces a revoked offer with availability", async () => {
  state.data = { ...overview(), request: pending() };
  const view = show("developer");
  expect(screen.getByText("Aguardando pagamento")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancelar pedido" })).toBeNull();
  state.data = overview();
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  await click("Solicitar Grande");
  state.data = { ...overview(), enabled: false };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(state.request).not.toHaveBeenCalled();
});

it("isolates query arguments, dialogs and late mutation results when the organization changes", async () => {
  let finish: (() => void) | undefined;
  state.claim.mockImplementation(
    () =>
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
  );
  const view = show();
  await click("Ativar gratuito");
  await click("Confirmar ativação");
  expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("true");
  view.rerender(
    <Plans org={{ ...org, id: "org-two" as Organization["id"] }} contextKey="entry-two" />,
  );
  await act(async () => {
    finish?.();
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText(/Plano gratuito ativado/)).toBeNull();
  expect(state.queries.at(-1)).toEqual({
    name: "plans:overview",
    args: { organizationId: "org-two", contextKey: "entry-two" },
  });
});

it("a failed catalog read can retry without rendering stale offers", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.queryError = new Error("Offline");
  show();
  expect(screen.getByText("Não foi possível carregar os planos.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  state.queryError = null;
  await click("Tentar novamente");
  expect(screen.getByRole("table")).toBeTruthy();
});

// The annual plan (ADR 0010, decision 9). Dates are UTC; "now" is 10 October 2026.
type Term = PlansOverview["terms"][number];
const NOW = Date.UTC(2026, 9, 10, 12);
const OCT_1 = Date.UTC(2026, 9, 1);
const END = Date.UTC(2027, 9, 1);
function annualOn(): PlansOverview {
  const base = overview();
  return {
    ...base,
    annualEnabled: true,
    offers: base.offers.map((offer) =>
      offer.tier === "free"
        ? offer
        : { ...offer, annualCents: offer.tier === "intermediate" ? 149000 : 499000 },
    ),
  };
}
function term(patch: Partial<Term> = {}): Term {
  return {
    id: "term-one" as GenericId<"platformPlanTerms">,
    tier: "intermediate",
    segments: [],
    firstPeriod: OCT_1,
    endsAt: END,
    source: "pix",
    state: "active",
    blocked: false,
    accessEndsAt: null,
    renews: false,
    upgrade: null,
    ...patch,
  };
}
const upgrade = (patch: Partial<NonNullable<Term["upgrade"]>> = {}) => ({
  tier: "large" as const,
  amountCents: 349999,
  months: 12,
  cardUntil: null,
  ...patch,
});
function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}
async function chooseAnnual() {
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: /Anual/ }));
  });
}

it("with the annual switch off, nothing annual is shown", () => {
  show();
  expect(screen.queryByRole("radiogroup", { name: "Ciclo de pagamento" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/anual|Economia/);
});

it("the annual selector shows the catalog price and the savings over 12 months", async () => {
  state.data = annualOn();
  show();
  const table = () => screen.getByRole("table", { name: "Planos e limites" });
  expect(within(table()).getByText("R$ 149,00")).toBeTruthy();
  await chooseAnnual();
  const rows = within(table()).getAllByRole("row");
  expect(rows[2]!.textContent).toMatch(/R\$\s1\.490,00por 12 meses/);
  expect(rows[2]!.textContent).toMatch(/Economia de R\$\s298,00 sobre 12 mensalidades/);
  expect(rows[3]!.textContent).toMatch(/R\$\s4\.990,00por 12 meses/);
  expect(rows[3]!.textContent).toMatch(/Economia de R\$\s998,00/);
  // The free tier has no annual.
  expect(rows[1]!.textContent).toContain("Sem vencimento");
  expect(screen.getByRole("button", { name: "Solicitar Grande anual" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: /Mensal/ }));
  });
  expect(screen.getByRole("button", { name: "Solicitar Grande" })).toBeTruthy();
});

it("the annual Pix request asks when to start and sends the server only the intention", async () => {
  clock();
  state.data = annualOn();
  const view = show();
  await chooseAnnual();
  await click("Solicitar Intermediário anual");
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toMatch(/R\$\s1\.490,00 por 12 meses, pagos de uma vez/);
  expect(dialog.textContent).toContain("Começa em 01/10/2026, 00:00 UTC");
  expect(dialog.textContent).toContain("Começa em 01/11/2026, 00:00 UTC");
  expect(dialog.textContent).toContain("Termina em 01/11/2027, 00:00 UTC");
  expect(dialog.textContent).toContain("No cartão, o anual começa sempre no dia 1 do mês seguinte");
  // The start is the client's choice: nothing is sent before it.
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Registrar pedido" }).disabled).toBe(
    true,
  );
  fireEvent.click(within(dialog).getByRole("radio", { name: /No dia 1 do mês seguinte/ }));
  await click("Registrar pedido");
  expect(state.request).toHaveBeenCalledWith({
    organizationId: "org-one",
    tier: "intermediate",
    key: expect.any(String),
    cycle: "annual",
    start: "next",
  });
  // Switched off while a confirmation is open: the annual is not sent.
  state.request.mockClear();
  await click("Solicitar Grande anual");
  fireEvent.click(screen.getByRole("radio", { name: /Agora/ }));
  state.data = overview();
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Registrar pedido" }).disabled).toBe(
    true,
  );
  expect(state.request).not.toHaveBeenCalled();
});

it("shows a pending annual request and a Pix upgrade as what they are, not a full-price plan", () => {
  state.data = {
    ...annualOn(),
    request: {
      ...pending(),
      amountCents: 149000,
      cycle: "annual",
      start: "next",
      firstPeriod: Date.UTC(2026, 10, 1),
    },
  };
  const view = show();
  expect(screen.getByText("Intermediário anual")).toBeTruthy();
  expect(screen.getByText(/R\$\s1\.490,00 por 12 meses/)).toBeTruthy();
  expect(screen.getByText("01/11/2026, 00:00 UTC")).toBeTruthy();
  state.data = {
    ...annualOn(),
    request: {
      ...pending(),
      tier: "large",
      amountCents: 233333,
      cycle: "annual",
      start: "upgrade",
      firstPeriod: Date.UTC(2027, 1, 1),
      period: "2027-02",
    },
    terms: [term()],
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.queryByText("Plano solicitado")).toBeNull();
  expect(screen.queryByText("Valor integral")).toBeNull();
  expect(screen.getByText("Mudança solicitada")).toBeTruthy();
  expect(screen.getByText("Para Grande anual, até o fim do plano anual")).toBeTruthy();
  expect(screen.getByText(/R\$\s2\.333,33, pela diferença dos meses restantes/)).toBeTruthy();
  expect(screen.getByText(/O plano anual continua durante a espera/)).toBeTruthy();
});

it("shows the term in force with its payment method, start, end and the support rule to rescind", () => {
  state.data = { ...annualOn(), terms: [term()] };
  show();
  const card = screen.getByRole("region", { name: "Plano anual em vigor" });
  expect(within(card).getByText("Em vigor")).toBeTruthy();
  expect(within(card).getByText("Intermediário anual")).toBeTruthy();
  expect(within(card).getByText("Pix assistido")).toBeTruthy();
  expect(within(card).getByText("01/10/2026, 00:00 UTC")).toBeTruthy();
  expect(within(card).getByText("01/10/2027, 00:00 UTC")).toBeTruthy();
  // A Pix term never renews by itself.
  expect(within(card).getByText("Fim")).toBeTruthy();
  expect(within(card).queryByText("Fim e renovação")).toBeNull();
  expect(card.textContent).toContain("No Pix, a renovação é um novo pedido anual");
  expect(card.textContent).toContain("Rescindir, com reembolso, é pelo suporte da Freecorps");
  expect(card.textContent).toContain("até 7 dias da cobrança, o reembolso é integral");
  expect(card.textContent).toContain("menos os meses usados, pelo preço mensal cheio");
  // Rescission is the operator's: no button for it, nor for an upgrade not on sale.
  expect(within(card).queryByRole("button")).toBeNull();
});

it("shows upgrades, scheduled, blocked and rescinded terms", () => {
  state.data = {
    ...annualOn(),
    terms: [
      term({
        source: "stripe",
        renews: true,
        segments: [{ tier: "large", fromPeriod: Date.UTC(2027, 1, 1) }],
      }),
      term({
        id: "term-two" as Term["id"],
        state: "scheduled",
        firstPeriod: END,
        endsAt: Date.UTC(2028, 9, 1),
      }),
    ],
  };
  const view = show();
  const active = screen.getByRole("region", { name: "Plano anual em vigor" });
  expect(within(active).getByText("Grande anual a partir de 01/02/2027, 00:00 UTC")).toBeTruthy();
  expect(within(active).getByText("Cartão, pelo Stripe")).toBeTruthy();
  expect(active.textContent).toContain("pelo Grande anual, são cobrados nessa data");
  const scheduled = screen.getByRole("region", { name: "Plano anual agendado" });
  expect(within(scheduled).getByText("Agendado")).toBeTruthy();
  expect(scheduled.textContent).toContain("O plano atual continua até o início do plano anual");
  state.data = { ...annualOn(), terms: [term({ state: "scheduled", blocked: true })] };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getByText("Início pendente")).toBeTruthy();
  expect(screen.getByText(/o início do plano aguarda a equipe da Freecorps/)).toBeTruthy();
  state.data = {
    ...overview(),
    terms: [term({ state: "rescinded", accessEndsAt: Date.UTC(2027, 1, 1) })],
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  const rescinded = screen.getByRole("region", { name: "Plano anual rescindido" });
  expect(within(rescinded).getByText("Rescindido")).toBeTruthy();
  expect(within(rescinded).getByText("Acesso até")).toBeTruthy();
  expect(rescinded.textContent).toContain("01/02/2027, 00:00:00 UTC");
  expect(rescinded.textContent).not.toContain("Rescindir, com reembolso");
});

it("upgrades a Pix term by a request priced by the server, keeping the renewal date", async () => {
  clock();
  state.data = {
    ...annualOn(),
    terms: [term({ upgrade: upgrade({ amountCents: 233333, months: 8 }) })],
  };
  show();
  expect(
    screen.getByText(/R\$\s2\.333,33 pelos 8 meses restantes, com o mês corrente inteiro/),
  ).toBeTruthy();
  await click("Mudar para Grande anual");
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("O plano anual continua terminando em 01/10/2027");
  expect(dialog.textContent).not.toContain("a renovação passa a ser");
  expect(dialog.textContent).toContain("O pagamento por Pix é assistido");
  await click("Registrar pedido");
  expect(state.request).toHaveBeenCalledWith({
    organizationId: "org-one",
    tier: "large",
    key: expect.any(String),
    cycle: "annual",
    start: "upgrade",
  });
  expect(state.checkout).not.toHaveBeenCalled();
});

it("upgrades a card term in the Stripe Checkout, and closes it in the last 72 hours", async () => {
  clock();
  const assign = vi.fn();
  vi.stubGlobal("location", { search: "", assign });
  state.data = {
    ...annualOn(),
    terms: [
      term({
        source: "stripe",
        renews: true,
        upgrade: upgrade({ months: 1, amountCents: 29166, cardUntil: NOW + 1 }),
      }),
    ],
  };
  const view = show();
  expect(screen.getByText(/R\$\s291,66 pelo último mês/)).toBeTruthy();
  await click("Mudar para Grande anual");
  expect(screen.getByRole("alertdialog").textContent).toContain("Você será levado ao Stripe");
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "A data de renovação continua 01/10/2027, 00:00 UTC, e a renovação passa a ser do Grande anual",
  );
  state.checkout.mockRejectedValueOnce(new ConvexError({ code: "PERIOD_CLOSING" }));
  await click("Ir para o Stripe");
  expect(screen.getByRole("alert").textContent).toContain("nas últimas 72 horas do plano anual");
  await click("Ir para o Stripe");
  const calls = state.checkout.mock.calls.map((call) => call[0] as Record<string, unknown>);
  expect(calls[1]).toEqual({
    organizationId: "org-one",
    tier: "large",
    key: calls[0]!.key,
    cycle: "annual",
    start: "upgrade",
  });
  expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_up");
  expect(state.request).not.toHaveBeenCalled();
  vi.setSystemTime(NOW + 1);
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Mudar para Grande anual" }).disabled,
  ).toBe(true);
  expect(screen.getByText(/Pelo cartão, a mudança fecha nas últimas 72 horas/)).toBeTruthy();
  vi.unstubAllGlobals();
});

it("only managers see the upgrade", () => {
  state.data = { ...annualOn(), terms: [term({ upgrade: upgrade() })] };
  show("viewer");
  expect(screen.queryByRole("button", { name: /Mudar para/ })).toBeNull();
});

it.each([
  ["ANNUAL_DISABLED", "O plano anual não está à venda no momento"],
  ["ANNUAL_TERM_ACTIVE", "tem um plano anual em vigor ou agendado"],
  ["ANNUAL_TERM_REQUIRED", "Não há plano anual em vigor neste mês"],
  ["ANNUAL_TERM_SCHEDULED", "Há um plano anual agendado"],
  ["PAYMENT_METHOD_PIX", "foi pago por Pix"],
  ["PAYMENT_METHOD_CARD", "Esta organização paga por cartão"],
  // The screen still showed Pix when the switch went off.
  ["PIX_DISABLED", "Assine pelo cartão em Cobrança"],
  ["SUBSCRIPTION_RENEWING", "Use “Cancelar renovação” antes de assinar o anual no cartão"],
  ["PERIOD_CLOSING", "a mudança fecha na virada do mês"],
])("explains %s in Portuguese", async (refusal, text) => {
  state.data = annualOn();
  state.request.mockRejectedValueOnce(new ConvexError({ code: refusal }));
  show();
  await chooseAnnual();
  await click("Solicitar Intermediário anual");
  fireEvent.click(screen.getByRole("radio", { name: /Agora/ }));
  await click("Registrar pedido");
  expect(screen.getByRole("alert").textContent).toContain(text);
  expect(screen.getByRole("alert").textContent).not.toContain(refusal);
});

it("a card term that no longer renews says so, and its upgrade does not promise a renewal", async () => {
  clock();
  state.data = {
    ...annualOn(),
    terms: [term({ source: "stripe", renews: false, upgrade: upgrade() })],
  };
  show();
  const card = screen.getByRole("region", { name: "Plano anual em vigor" });
  expect(within(card).getByText("Fim")).toBeTruthy();
  expect(card.textContent).toContain("No cartão, este plano anual não renova");
  expect(card.textContent).not.toContain("são cobrados nessa data");
  await click("Mudar para Grande anual");
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain(
    "continua terminando em 01/10/2027, 00:00 UTC, sem renovação",
  );
  expect(dialog.textContent).not.toContain("a renovação passa a ser");
});

it("rescinded and Pix terms word the refund and the renewal without promises", () => {
  state.data = {
    ...overview(),
    terms: [
      term({ state: "rescinded", accessEndsAt: Date.UTC(2027, 1, 1) }),
      term({ id: "term-two" as Term["id"], firstPeriod: END, endsAt: Date.UTC(2028, 9, 1) }),
    ],
  };
  show();
  expect(screen.getByText(/Se houver reembolso, a equipe o devolve/)).toBeTruthy();
  // With the annual switch off, no renewal is offered for the Pix term.
  const active = screen.getByRole("region", { name: "Plano anual em vigor" });
  expect(active.textContent).toContain("sem renovação automática");
  expect(active.textContent).not.toContain("último mês");
});

it("a term in force holds the annual purchase until its last month, which only starts next", async () => {
  clock();
  state.data = {
    ...annualOn(),
    annualStarts: { now: false, next: false },
    terms: [term()],
  };
  const view = show();
  await chooseAnnual();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Solicitar Intermediário anual" })
      .disabled,
  ).toBe(true);
  expect(screen.getAllByText(/Um novo anual pode ser pedido no último mês dele/)).toHaveLength(2);
  // A card term renews by itself: the hint says so instead.
  state.data = {
    ...annualOn(),
    annualStarts: { now: false, next: false },
    terms: [term({ source: "stripe", renews: true })],
  };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  expect(screen.getAllByText("Há um plano anual em vigor, que renova pelo cartão.")).toHaveLength(
    2,
  );
  // The last month: the renewal starts next month, never now.
  state.data = { ...annualOn(), annualStarts: { now: false, next: true }, terms: [term()] };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  await click("Solicitar Intermediário anual");
  const now = screen.getByRole<HTMLInputElement>("radio", { name: /Agora/ });
  expect(now.disabled).toBe(true);
  expect(screen.getByText(/o plano anual em vigor ainda cobre este mês/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /No dia 1 do mês seguinte/ }));
  await click("Registrar pedido");
  expect(state.request).toHaveBeenCalledWith(
    expect.objectContaining({ cycle: "annual", start: "next" }),
  );
});

it("starting now never goes below the plan in force", async () => {
  clock();
  state.data = {
    ...annualOn(),
    subscription: { tier: "large", endsAt: Date.UTC(2026, 10, 1), version: 3 },
  };
  show();
  await chooseAnnual();
  await click("Solicitar Intermediário anual");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Agora/ }).disabled).toBe(true);
  expect(screen.getByText(/começar agora não desce do plano em vigor/)).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /No dia 1/ }).disabled).toBe(false);
  cleanup();
  show();
  await chooseAnnual();
  await click("Solicitar Grande anual");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: /Agora/ }).disabled).toBe(false);
});

it("after the card Checkout goes away, the upgrade is a new intention", async () => {
  clock();
  state.data = {
    ...annualOn(),
    terms: [term({ source: "stripe", renews: true, upgrade: upgrade({ cardUntil: END }) })],
  };
  state.checkout.mockRejectedValue(new ConvexError({ code: "BILLING_UNAVAILABLE" }));
  const view = show();
  await click("Mudar para Grande anual");
  await click("Ir para o Stripe");
  await click("Ir para o Stripe");
  const keys = () => state.checkout.mock.calls.map((call) => (call[0] as { key: string }).key);
  expect(keys()[0]).toBe(keys()[1]);
  // The Checkout opened and was abandoned in Cobrança.
  state.data = { ...(state.data as PlansOverview), checkout: true };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  state.data = { ...(state.data as PlansOverview), checkout: false };
  view.rerender(<Plans org={org} contextKey="entry-one" />);
  await click("Ir para o Stripe");
  expect(keys()[2]).not.toBe(keys()[0]);
});

it("with Pix off, paid tiers point to the card and a Pix term offers no upgrade", () => {
  clock();
  state.data = {
    ...annualOn(),
    pixEnabled: false,
    terms: [term({ upgrade: upgrade() })],
  };
  show();
  expect(screen.queryByRole("button", { name: /^Solicitar/ })).toBeNull();
  expect(screen.getAllByText("Assine pelo cartão em Cobrança.")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Ativar gratuito" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Mudar para Grande anual" })).toBeNull();
  cleanup();
  state.data = {
    ...annualOn(),
    pixEnabled: false,
    terms: [term({ source: "stripe", upgrade: upgrade() })],
  };
  show();
  expect(screen.getByRole("button", { name: "Mudar para Grande anual" })).toBeTruthy();
});
