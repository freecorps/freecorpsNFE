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
/** The anniversary of a monthly card signed on 10/10/2026 at 12:00 UTC (ADR 0012, slice 2a). */
const NOV_10 = Date.UTC(2026, 10, 10, 12);
/** The anniversary of an annual card signed on 10/10/2026 at 12:00 UTC (ADR 0012, slice 2b). */
const YEAR = Date.UTC(2027, 9, 10, 12);
function overview(patch: Partial<BillingOverview> = {}): BillingOverview {
  return {
    card: true,
    account: null,
    checkout: null,
    reviews: [],
    plan: null,
    pixPending: false,
    annualEnabled: false,
    pixEnabled: true,
    subscriptionTerm: false,
    annualBlocked: false,
    ...patch,
  };
}
const subscribed = (patch: Partial<NonNullable<BillingOverview["account"]>> = {}) =>
  overview({
    plan: { tier: "intermediate", endsAt: NOV_10 },
    account: {
      renewalTier: "intermediate",
      subscription: {
        id: "sub_1",
        status: "active",
        tier: "intermediate",
        cancelAtPeriodEnd: false,
        periodEnd: NOV_10,
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
  // Charged at the signing, renewed on its anniversary (ADR 0012, slice 2a).
  const dialog = screen.getByRole("alertdialog").textContent;
  expect(dialog).toMatch(/R\$\s149,00 são cobrados no pagamento, integrais e sem pró-rata/);
  expect(dialog).toContain("até o mesmo dia e horário do mês seguinte, em UTC");
  expect(dialog).not.toContain("dia 1");
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
  // The card renews on the anniversary of the signing, an instant in UTC, never "day 1".
  expect(
    screen.getByText(/R\$\s149,00 em 10\/11\/2026 às 12:00 UTC \(Intermediário\)/),
  ).toBeTruthy();
  expect(screen.getByText("Intermediário, até 10/11/2026 às 12:00 UTC")).toBeTruthy();
  expect(screen.queryByText(/dia 1/)).toBeNull();
  expect(screen.getByRole("button", { name: "Mudar para Grande" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Assinar/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Mudar para Grande" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "a diferença integral do mês do plano, que termina em 10/11/2026 às 12:00 UTC",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancelar renovação" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(state.calls).toEqual([
    { name: "billing:changeRenewal", args: { organizationId: "org-one", change: "cancel" } },
  ]);
  expect(screen.getByText("Renovação cancelada. O período pago continua até o fim.")).toBeTruthy();
});

it("uma recusa que espera o plano em vigor termina com a data em UTC", async () => {
  state.data = subscribed();
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "PERIOD_CLOSING", availableAt: NOV_10 }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Mudar para Grande" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(
    screen.getByText(
      /a mudança de plano fecha 45 minutos antes da renovação.*Disponível a partir de 10\/11\/2026 às 12:00 UTC\./,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/dia 1/)).toBeNull();
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

it("mostra o Checkout aberto pelo ciclo: o mensal e o anual cobram no pagamento", () => {
  const open = {
    kind: "start" as const,
    tier: "intermediate" as const,
    url: "https://checkout.stripe.com/c/pay/cs_1",
    expiresAt: Date.UTC(2026, 9, 11, 12),
  };
  // A monthly start has no period until it is paid (ADR 0012, slice 2a).
  state.data = overview({
    checkout: { ...open, cycle: "monthly", periodStartsAt: null, grantCents: 14900 },
  });
  show();
  expect(
    screen.getByText(
      /Intermediário: R\$\s149,00 agora, depois R\$\s149,00 por mês, no dia e horário do pagamento/,
    ),
  ).toBeTruthy();
  cleanup();
  // The annual start is charged at the signing too, without a period (ADR 0012, slice 2b).
  state.data = overview({
    checkout: { ...open, tier: "large", cycle: "annual", periodStartsAt: null, grantCents: 499000 },
  });
  show();
  expect(
    screen.getByText(
      /Grande anual: R\$\s4\.990,00 agora, por 12 meses a partir do pagamento, com renovação anual no mesmo dia e horário/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/por mês|nada agora|dia 1/)).toBeNull();
  expect(screen.getByRole("link", { name: "Continuar no Stripe" })).toBeTruthy();
});

it("a assinatura anual mostra a cobrança no aniversário da contratação e não oferece troca mensal", () => {
  state.data = {
    ...subscribed({
      subscription: {
        id: "sub_annual",
        status: "active",
        tier: "intermediate",
        cancelAtPeriodEnd: false,
        periodEnd: YEAR,
        annual: true,
      },
    }),
    // The subscription's first charge became a term.
    subscriptionTerm: true,
  };
  show();
  expect(
    screen.getByText(
      /R\$\s1\.490,00 em 10\/10\/2027 às 12:00 UTC \(Intermediário anual, 12 meses\)/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/R\$\s149,00/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Mudar para|Renovar como/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancelar renovação" })).toBeTruthy();
});

// The annual plan on the card (ADR 0010, decision 9, and ADR 0012, slice 2b). "Now" is 10 October
// 2026 at 12:00 UTC.
const NOW = Date.UTC(2026, 9, 10, 12);
const annualSubscription = (cancelAtPeriodEnd = false) =>
  subscribed({
    subscription: {
      id: "sub_annual",
      status: "active",
      tier: "intermediate",
      cancelAtPeriodEnd,
      periodEnd: YEAR,
      annual: true,
    },
  });

it("sells the annual card only with the switch on: charged at the payment, renewed on its anniversary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.data = overview();
  show();
  expect(screen.queryByRole("button", { name: /anual no cartão/ })).toBeNull();
  cleanup();
  state.data = overview({ annualEnabled: true });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Grande anual no cartão" }));
  const dialog = screen.getByRole("alertdialog").textContent;
  expect(dialog).toMatch(/R\$\s4\.990,00 são cobrados no pagamento/);
  expect(dialog).toContain("até o mesmo dia e horário do ano seguinte, em UTC");
  expect(dialog).not.toMatch(/Nada é cobrado agora|dia 1|Pix/);
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

it("a monthly card that still renews holds the annual until “Cancelar renovação”; then it replaces the month, or a smaller one waits with the date", async () => {
  state.data = { ...subscribed(), annualEnabled: true };
  show();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Assinar Intermediário anual no cartão" })
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/use “Cancelar renovação” antes/)).toBeTruthy();
  expect(screen.getByText(/substitui o mês pago sem desconto/)).toBeTruthy();
  cleanup();
  // With the renewal cancelled the server still has the last word.
  state.data = {
    ...subscribed({
      subscription: {
        id: "sub_1",
        status: "active",
        tier: "intermediate",
        cancelAtPeriodEnd: true,
        periodEnd: NOV_10,
      },
    }),
    annualEnabled: true,
  };
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "SUBSCRIPTION_RENEWING" }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário anual no cartão" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "O Intermediário mensal em vigor é substituído na hora, sem desconto dos dias restantes.",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Use “Cancelar renovação” antes de assinar o anual no cartão; ele é cobrado e começa no pagamento",
  );
  state.results["billing:checkout"] = () =>
    Promise.reject(new ConvexError({ code: "PLAN_UNAVAILABLE", availableAt: NOV_10 }));
  fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário anual no cartão" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Disponível a partir de 10/11/2026 às 12:00 UTC.",
  );
});

it("promises the replacement of the monthly only when the server sells it", () => {
  const dialogOf = (patch: Partial<BillingOverview>, name: string) => {
    state.data = overview({ annualEnabled: true, ...patch });
    show();
    fireEvent.click(screen.getByRole("button", { name }));
    const text = screen.getByRole("alertdialog").textContent;
    cleanup();
    return text;
  };
  const replaced = /mensal em vigor é substituído na hora/;
  // A larger monthly holds a smaller annual; the server refuses it with the date.
  expect(
    dialogOf({ plan: { tier: "large", endsAt: NOV_10 } }, "Assinar Intermediário anual no cartão"),
  ).not.toMatch(replaced);
  expect(
    dialogOf({ plan: { tier: "intermediate", endsAt: NOV_10 } }, "Assinar Grande anual no cartão"),
  ).toMatch(replaced);
  // The month a rescinded term left is no monthly to replace.
  expect(
    dialogOf(
      { plan: { tier: "intermediate", endsAt: NOV_10, annual: true } },
      "Assinar Grande anual no cartão",
    ),
  ).not.toMatch(replaced);
  expect(dialogOf({}, "Assinar Grande anual no cartão")).not.toMatch(replaced);
});

it("an annual subscription whose charge bought no term says so instead of a renewal", async () => {
  state.data = { ...annualSubscription(), subscriptionTerm: false };
  const view = show();
  expect(
    screen.getByText(
      "Nenhuma enquanto a cobrança anual está em confirmação ou em análise pela equipe: ela não concedeu um plano anual.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/12 meses/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar renovação" }));
  const dialog = screen.getByRole("alertdialog").textContent;
  expect(dialog).toContain("Esta assinatura anual não concedeu um plano anual");
  expect(dialog).not.toContain("Os meses pagos");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  });
  expect(
    screen.getByText("Renovação cancelada. A assinatura anual não cobra de novo."),
  ).toBeTruthy();
  // Once Stripe stops it, the grant shows the stop until it is done.
  state.data = overview({
    reviews: [
      { source: "grant", code: "PLAN_UNAVAILABLE", amountCents: 149000, createdAt: 2 },
      { source: "grant", code: "SUBSCRIPTION_STOP_FAILED", amountCents: null, createdAt: 1 },
    ],
  });
  view.rerender(<PlanBilling org={owner} contextKey="test" />);
  expect(
    screen.getByText(
      "Cancelamento pendente no Stripe da assinatura anual cuja cobrança não virou plano",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/assinatura anual rescindida/)).toBeNull();
});

it("an annual subscription keeps the paid months when its renewal is cancelled and points to support", async () => {
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
  expect(screen.getByText("Nenhuma. O plano termina em 10/10/2027 às 12:00 UTC")).toBeTruthy();
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
    ["RENEWAL_BELOW_UPGRADE", "Renovação cobrada abaixo do plano da mudança paga"],
    ["SUBSCRIPTION_STOP_FAILED", "Cancelamento da assinatura anual rescindida pendente no Stripe"],
    ["ANNUAL_TERM_RESCINDED", "Cobrança de uma assinatura anual já rescindida"],
    ["AMOUNT_MISMATCH", "Pagamento com valor diferente do cobrado"],
    ["PRICE_UNKNOWN", "Pagamento por um preço que não confere com o catálogo"],
    ["DUPLICATE_PAYMENT", "Pagamento de um mês ou de uma mudança de plano que já estavam pagos"],
    ["ANNUAL_TERM_ACTIVE", "Pagamento recebido com um plano anual em vigor ou agendado"],
    ["INVOICE_UNEXPECTED", "Pagamento por um período que não confere com a assinatura"],
    ["LATE_PAYMENT", "Pagamento recebido depois do fim do mês cobrado"],
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

it("shows an open annual upgrade Checkout as the upgrade it is", () => {
  state.data = overview({
    checkout: {
      kind: "upgrade",
      tier: "large",
      cycle: "annual",
      period: "2027-02-10T12:00:00.000Z",
      periodStartsAt: Date.UTC(2027, 1, 10, 12),
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

it("a term in force holds the annual card until it ends", () => {
  state.data = overview({ annualEnabled: true, annualBlocked: true });
  show();
  for (const name of ["Assinar Intermediário anual no cartão", "Assinar Grande anual no cartão"])
    expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
  expect(screen.getByText(/só pode ser assinado depois que ele terminar/)).toBeTruthy();
});

it("a sale that waits for the plan in force says when it becomes available", async () => {
  state.data = overview();
  state.results["billing:checkout"] = () =>
    Promise.reject(
      new ConvexError({ code: "PLAN_UNAVAILABLE", availableAt: Date.UTC(2027, 1, 10, 12) }),
    );
  show();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Intermediário no cartão" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Stripe" }));
  });
  expect(
    screen.getByText(
      "Esta mudança de plano está indisponível. Confira a situação atual. Disponível a partir de 10/02/2027 às 12:00 UTC.",
    ),
  ).toBeTruthy();
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
      periodStartsAt: Date.UTC(2026, 9, 1),
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

it("com o Pix desligado, a cobrança fala só do cartão", () => {
  state.data = overview({ annualEnabled: true, pixEnabled: false });
  show();
  expect(
    screen.getByText(
      "Cartão com renovação automática todo mês, no dia e horário da contratação, em UTC.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Assinar Grande anual no cartão" }));
  expect(screen.getByRole("alertdialog").textContent).not.toContain("Pix");
  cleanup();
  state.data = overview({ card: false, pixEnabled: false });
  show();
  expect(screen.getByText("Contratação indisponível no momento.")).toBeTruthy();
});
