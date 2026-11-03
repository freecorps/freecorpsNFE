// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import type { Organization } from "./organizations";
import { PlanBilling, type BillingOverview } from "./plans-billing";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  queryError: null as unknown,
  calls: [] as Array<{ name: string; args: unknown }>,
  results: {} as Record<string, () => Promise<unknown>>,
}));
vi.mock("./convex-query", () => ({
  useQuery: () => {
    if (state.queryError) throw state.queryError;
    return state.data;
  },
}));
vi.mock("convex/react", () => ({
  useAction: (fn: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(fn);
    return (args: unknown) => {
      state.calls.push({ name, args });
      return (state.results[name] ?? (() => Promise.resolve(null)))();
    };
  },
}));
const owner = { id: "org-one", slug: "equipe", name: "Equipe", role: "owner" } as Organization;
const NOV = Date.UTC(2026, 10, 1);
function overview(patch: Partial<BillingOverview> = {}): BillingOverview {
  return {
    card: true,
    account: null,
    checkout: null,
    reviews: [],
    plan: null,
    pixPending: false,
    annualEnabled: false,
    subscriptionTerm: false,
    annualBlocked: false,
    ...patch,
  };
}
const subscribed = (patch: Partial<NonNullable<BillingOverview["account"]>> = {}) =>
  overview({
    plan: { tier: "intermediate", endsAt: NOV },
    account: {
      renewalTier: "intermediate",
      subscription: {
        id: "sub_1",
        status: "active",
        tier: "intermediate",
        cancelAtPeriodEnd: false,
        periodEnd: NOV,
      },
      openInvoice: null,
      syncedAt: Date.UTC(2026, 9, 10, 12),
      syncError: null,
      ...patch,
    },
  });
const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal("location", { search: "", assign });
});
afterEach(() => {
  cleanup();
  state.data = undefined;
  state.queryError = null;
  state.calls = [];
  state.results = {};
  assign.mockReset();
  vi.useRealTimers();
});
const show = (org: Organization = owner) => render(<PlanBilling org={org} contextKey="test" />);

it("mostra carregamento, erro e o Pix quando o cartão está desligado", () => {
  show();
  expect(screen.getByText("Carregando cobrança…")).toBeTruthy();
  cleanup();
  state.queryError = new ConvexError({ code: "ACCESS_DENIED" });
  show();
  expect(screen.getByText("Não foi possível carregar a cobrança.")).toBeTruthy();
  cleanup();
  state.queryError = null;
  state.data = overview({ card: false, plan: { tier: "large", endsAt: NOV } });
  show();
  expect(screen.getByText("Pix assistido")).toBeTruthy();
  expect(screen.getByText("O pagamento por cartão está indisponível no momento.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("leva ao Checkout do servidor e reusa a mesma intenção depois de uma resposta incerta", async () => {
  state.data = overview();
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "BILLING_UNAVAILABLE" }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário no cartão" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(screen.getByText(/O Stripe não respondeu/)).toBeTruthy();
  state.results["billing:checkout"] = () =>
    Promise.resolve({ url: "https://checkout.stripe.com/c/pay/cs_1" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  const keys = state.calls.map((call) => (call.args as { key: string }).key);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_1");
});

it("mostra meio, período, próxima cobrança em UTC e as ações da assinatura", async () => {
  state.data = subscribed();
  show();
  expect(screen.getByText("Cartão, pelo Stripe")).toBeTruthy();
  expect(screen.getByText("Assinatura ativa")).toBeTruthy();
  expect(screen.getByText(/R\$\s149,00 em 01\/11\/2026, 00:00 UTC \(Intermediário\)/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Mudar para Grande" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Assinar/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar renovação" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(state.calls).toEqual([
    { name: "billing:changeRenewal", args: { organizationId: "org-one", change: "cancel" } },
  ]);
  expect(screen.getByText("Renovação cancelada. O período pago continua até o fim.")).toBeTruthy();
});

it("mostra pagamento recusado e pendências; quem não gerencia não vê a cobrança", () => {
  state.data = {
    ...subscribed({
      subscription: {
        id: "sub_1",
        status: "past_due",
        tier: "intermediate",
        cancelAtPeriodEnd: false,
        periodEnd: NOV,
      },
      openInvoice: { id: "in_2", amountDueCents: 14900, url: "https://invoice.stripe.com/i/x" },
    }),
    reviews: [{ source: "event", code: "DISPUTE_OPENED", amountCents: 14900, createdAt: 1 }],
  };
  show();
  const declined = screen.getByText("Pagamento recusado").closest(".ui-callout") as HTMLElement;
  expect(within(declined).getByRole("link", { name: "Pagar fatura no Stripe" })).toBeTruthy();
  expect(screen.getByText(/Contestação aberta pelo banco do cartão/)).toBeTruthy();
  expect(screen.getByText("Pagamento pendente")).toBeTruthy();
  cleanup();
  // The server refuses the overview to these roles; the console does not even ask.
  for (const role of ["admin", "developer", "operator", "viewer"] as const) {
    const { container } = show({ ...owner, role } as Organization);
    expect(container.textContent === "").toBe(role !== "admin");
    cleanup();
  }
});

it("o retorno do Stripe só pede ao servidor para conferir", async () => {
  vi.stubGlobal("location", { search: "?cobranca=retorno", assign });
  state.data = overview();
  await act(async () => {
    show();
  });
  expect(screen.getByText(/O plano muda quando o Stripe confirmar/)).toBeTruthy();
  expect(state.calls).toEqual([{ name: "billing:refresh", args: { organizationId: "org-one" } }]);
});

it("ignora um parâmetro de retorno desconhecido", async () => {
  vi.stubGlobal("location", { search: "?cobranca=qualquer", assign });
  state.data = overview();
  await act(async () => {
    show();
  });
  expect(screen.queryByText(/O plano muda quando o Stripe confirmar/)).toBeNull();
  expect(state.calls).toEqual([]);
});

it("mostra o Checkout aberto pelo ciclo: o mensal cobra agora, o anual só no dia 1", () => {
  const open = {
    kind: "start" as const,
    tier: "intermediate" as const,
    url: "https://checkout.stripe.com/c/pay/cs_1",
    expiresAt: Date.UTC(2026, 9, 11, 12),
  };
  state.data = overview({
    checkout: { ...open, cycle: "monthly", period: "2026-10", grantCents: 14900 },
  });
  show();
  expect(
    screen.getByText(/Intermediário: R\$\s149,00 agora, depois R\$\s149,00 por mês/),
  ).toBeTruthy();
  cleanup();
  state.data = overview({
    checkout: { ...open, tier: "large", cycle: "annual", period: "2026-11", grantCents: 499000 },
  });
  show();
  expect(
    screen.getByText(
      /Grande anual: nada agora, R\$\s4\.990,00 em 01\/11\/2026, 00:00 UTC por 12 meses/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/por mês/)).toBeNull();
  expect(screen.getByRole("link", { name: "Continuar no Stripe" })).toBeTruthy();
});

it("a assinatura anual mostra a cobrança anual do dia 1 e não oferece troca mensal", () => {
  state.data = subscribed({
    subscription: {
      id: "sub_annual",
      status: "active",
      tier: "intermediate",
      cancelAtPeriodEnd: false,
      periodEnd: NOV,
      annual: true,
    },
  });
  show();
  expect(
    screen.getByText(/R\$\s1\.490,00 em 01\/11\/2026, 00:00 UTC \(Intermediário anual, 12 meses\)/),
  ).toBeTruthy();
  expect(screen.queryByText(/R\$\s149,00/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Mudar para|Renovar como/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancelar renovação" })).toBeTruthy();
});

// The annual plan on the card (ADR 0010, decision 9). "Now" is 10 October 2026, UTC.
const NOW = Date.UTC(2026, 9, 10, 12);
const annualSubscription = (cancelAtPeriodEnd = false) =>
  subscribed({
    subscription: {
      id: "sub_annual",
      status: "active",
      tier: "intermediate",
      cancelAtPeriodEnd,
      periodEnd: NOV,
      annual: true,
    },
  });

it("sells the annual card only with the switch on: nothing now, the first year on the 1st", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.data = overview();
  show();
  expect(screen.queryByRole("button", { name: /anual no cartão/ })).toBeNull();
  cleanup();
  state.data = overview({ annualEnabled: true });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Grande anual no cartão" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("Nada é cobrado agora");
  expect(dialog.textContent).toMatch(/R\$\s4\.990,00 são cobrados em 01\/11\/2026, 00:00 UTC/);
  expect(dialog.textContent).toContain("Para começar agora, peça o anual por Pix");
  state.results["billing:checkout"] = () =>
    Promise.resolve({ url: "https://checkout.stripe.com/c/pay/cs_annual" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(state.calls).toEqual([
    {
      name: "billing:checkout",
      args: { organizationId: "org-one", tier: "large", key: expect.any(String), cycle: "annual" },
    },
  ]);
  expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_annual");
});

it("a monthly card that still renews holds the annual until “Cancelar renovação”", async () => {
  state.data = { ...subscribed(), annualEnabled: true };
  show();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Assinar Intermediário anual no cartão" })
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/use “Cancelar renovação” antes/)).toBeTruthy();
  cleanup();
  // With the renewal cancelled the server still has the last word.
  state.data = {
    ...subscribed({
      subscription: {
        id: "sub_1",
        status: "active",
        tier: "intermediate",
        cancelAtPeriodEnd: true,
        periodEnd: NOV,
      },
    }),
    annualEnabled: true,
  };
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "SUBSCRIPTION_RENEWING" }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário anual no cartão" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Use “Cancelar renovação” antes de assinar o anual no cartão",
  );
});

it("an annual subscription not charged yet: cancelling gives up a year never paid", async () => {
  state.data = { ...annualSubscription(), annualEnabled: true, subscriptionTerm: false };
  const view = show();
  expect(screen.queryByRole("button", { name: /anual no cartão/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar renovação" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("A assinatura anual ainda não foi cobrada");
  expect(dialog.textContent).toContain(
    "a primeira cobrança, em 01/11/2026, 00:00 UTC, não acontece",
  );
  expect(dialog.textContent).not.toContain("O período pago continua");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(
    screen.getByText("Renovação cancelada. A assinatura anual não será cobrada."),
  ).toBeTruthy();
  state.data = { ...annualSubscription(true), annualEnabled: true, subscriptionTerm: false };
  view.rerender(<PlanBilling org={owner} contextKey="test" />);
  expect(screen.getByText("Nenhuma. A assinatura anual não será cobrada.")).toBeTruthy();
  expect(screen.queryByText(/O plano termina em/)).toBeNull();
});

it("an annual subscription already charged keeps the paid months and points to support", async () => {
  state.data = { ...annualSubscription(), subscriptionTerm: true };
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar renovação" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("Os meses pagos do plano anual continuam até o fim");
  expect(dialog.textContent).toContain("Para rescindir com reembolso, fale com o suporte");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(screen.getByText("Renovação cancelada. O período pago continua até o fim.")).toBeTruthy();
  state.data = { ...annualSubscription(true), subscriptionTerm: true };
  view.rerender(<PlanBilling org={owner} contextKey="test" />);
  expect(screen.getByText("Nenhuma. O plano termina em 01/11/2026, 00:00 UTC")).toBeTruthy();
  // A rescinded term's subscription is not resumed.
  state.results["billing:changeRenewal"] = () =>
    Promise.reject(new ConvexError({ code: "ANNUAL_TERM_RESCINDED" }));
  fireEvent.click(screen.getByRole("button", { name: "Retomar renovação" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(screen.getByRole("alert").textContent).toContain("foi rescindido pelo suporte");
});

it("names each annual item under review", () => {
  const codes = [
    ["RENEWAL_BELOW_UPGRADE", "Renovação anual cobrada abaixo do plano da mudança paga"],
    ["SUBSCRIPTION_STOP_FAILED", "Cancelamento da assinatura anual rescindida pendente no Stripe"],
    ["ANNUAL_TERM_RESCINDED", "Cobrança de uma assinatura anual já rescindida"],
    ["AMOUNT_MISMATCH", "Pagamento com valor diferente do cobrado"],
    ["PRICE_UNKNOWN", "Pagamento por um preço que não confere com o catálogo"],
    ["DUPLICATE_PAYMENT", "Pagamento de um mês ou de uma mudança de plano que já estavam pagos"],
    ["ANNUAL_TERM_ACTIVE", "Pagamento recebido com um plano anual em vigor ou agendado"],
  ] as const;
  state.data = overview({
    reviews: codes.map(([code], index): BillingOverview["reviews"][number] =>
      code === "SUBSCRIPTION_STOP_FAILED"
        ? { source: "term", code, amountCents: null, createdAt: index }
        : { source: "grant", code, amountCents: 1000, createdAt: index },
    ),
  });
  show();
  for (const [, name] of codes) expect(screen.getByText(new RegExp(name))).toBeTruthy();
  expect(screen.queryByText(/Pagamento em análise/)).toBeNull();
});

it("names an annual start refused before its anchor, and its stop pending in Stripe", () => {
  state.data = overview({
    reviews: [
      { source: "checkout", code: "QUOTA_EXCEEDED", amountCents: null, createdAt: 2 },
      { source: "checkout", code: "SUBSCRIPTION_STOP_FAILED", amountCents: null, createdAt: 1 },
    ],
  });
  show();
  expect(
    screen.getByText(
      "Plano anual por cartão recusado antes da cobrança: o uso atual não cabe no plano. A assinatura é cancelada e nada é cobrado",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("Cancelamento pendente no Stripe da assinatura anual recusada"),
  ).toBeTruthy();
  // Not the labels of a payment already taken.
  expect(
    screen.queryByText(/O plano pago não comporta|Cancelamento da assinatura anual rescindida/),
  ).toBeNull();
});

it("shows an open annual upgrade Checkout as the upgrade it is", () => {
  state.data = overview({
    checkout: {
      kind: "upgrade",
      tier: "large",
      cycle: "annual",
      period: "2027-02",
      grantCents: 233333,
      url: "https://checkout.stripe.com/c/pay/cs_up",
      expiresAt: Date.UTC(2027, 1, 11, 12),
    },
  });
  show();
  expect(
    screen.getByText(
      /R\$\s2\.333,33 agora, pela mudança para o Grande anual até o fim do plano anual/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/nada agora|por 12 meses/)).toBeNull();
});

it("a term in force holds the annual card until its last month", () => {
  state.data = overview({ annualEnabled: true, annualBlocked: true });
  show();
  for (const name of ["Assinar Intermediário anual no cartão", "Assinar Grande anual no cartão"])
    expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
  expect(screen.getByText(/só pode ser assinado no último mês dele/)).toBeTruthy();
});

it("after the Checkout is abandoned, the next one is a new intention", async () => {
  state.data = overview();
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "BILLING_UNAVAILABLE" }));
  const view = show();
  const attempt = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário no cartão" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  };
  await attempt();
  await attempt();
  const keys = () =>
    state.calls
      .filter((call) => call.name === "billing:checkout")
      .map((call) => (call.args as { key: string }).key);
  expect(keys()[0]).toBe(keys()[1]);
  state.data = overview({
    checkout: {
      kind: "start",
      tier: "intermediate",
      cycle: "monthly",
      period: "2026-10",
      grantCents: 14900,
      url: null,
      expiresAt: Date.UTC(2026, 9, 11, 12),
    },
  });
  view.rerender(<PlanBilling org={owner} contextKey="test" />);
  state.data = overview();
  view.rerender(<PlanBilling org={owner} contextKey="test" />);
  await attempt();
  expect(keys()[2]).not.toBe(keys()[0]);
});
