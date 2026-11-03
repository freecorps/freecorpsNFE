// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { StripeConnections } from "./stripe";
import { configOf, descriptionPreview, draftOf } from "./stripe-config";
import { SetupGuide, stripeEventTypes, stripeWebhookUrl } from "./stripe-setup";
import { takerDocumentOf } from "./issuance-draft";
import type { Connection, StripeEvent } from "./stripe-shared";
import { apiOrigin } from "./api-origin";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  events: [] as unknown[],
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
  usePaginatedQuery: () => ({ results: state.events, status: "Exhausted", loadMore: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to?: string;
    params?: { organizationSlug?: string };
  }) => (
    <a href={to?.replace("$organizationSlug", params?.organizationSlug ?? "") ?? "/rota"}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.queries = {};
  state.events = [];
});

type Props = Parameters<typeof StripeConnections>[0];
const org = { id: "org", slug: "equipe", role: "owner" } as unknown as Props["org"];
const grants = [
  {
    companyId: "company",
    name: "Freecorps Sintética",
    scopes: ["documents:issue", "documents:cancel"],
    environments: ["sandbox"],
    version: 1,
  },
] as unknown as Props["grants"];
const connection = {
  id: "conn1",
  projectId: "p1",
  companyId: "company",
  environment: "sandbox",
  name: "Stripe Loja Exemplo",
  active: true,
  config: {
    market: "domestic",
    domesticActivityCode: "licenca",
    description: "{itens} — cobrança {cobranca}",
    invoices: true,
    checkouts: true,
    foreignWithoutNif: "hold",
    refundPolicy: "notify",
  },
  secretSet: false,
  secretSetAt: null,
  lastEventAt: null,
  lastFailureAt: null,
  lastFailureCode: null,
  version: 3,
  createdAt: 1,
} as unknown as Connection;
const profile = {
  issuerEmail: "fiscal@freecorps.example",
  opSimpNac: 3,
  activities: [
    {
      code: "licenca",
      label: "Licenciamento",
      cnae: "6202300",
      lc116Item: "01.05",
      cTribNac: "010501",
    },
    {
      code: "suporte",
      label: "Suporte técnico",
      cnae: "6209100",
      lc116Item: "01.07",
      cTribNac: "010701",
    },
  ],
};
function page(events: unknown[] = [], as: Props["org"] = org) {
  state.queries = {
    "stripe:listConnections": [connection],
    "nfseProfiles:get": profile,
  };
  state.events = events;
  return render(
    <StripeConnections
      org={as}
      projectId={"p1" as Props["projectId"]}
      contextKey="k"
      grants={grants}
    />,
  );
}

describe("passo a passo do Stripe", () => {
  it("mostra a URL com o id da conexão e copia a lista exata de eventos", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SetupGuide connection={connection} manager />);
    expect(screen.getByRole("region", { name: "URL do endpoint" }).textContent).toBe(
      `${apiOrigin()}/v1/stripe/connections/conn1/events`,
    );
    expect(stripeWebhookUrl("conn1", "https://api.nfe.freecorps.com.br")).toBe(
      "https://api.nfe.freecorps.com.br/v1/stripe/connections/conn1/events",
    );
    expect(screen.getByRole("region", { name: "Lista de eventos" }).textContent).toBe(
      stripeEventTypes.join("\n"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar lista de eventos" }));
    });
    expect(writeText).toHaveBeenCalledWith(
      "invoice.paid\ncheckout.session.completed\ncheckout.session.async_payment_succeeded\ncharge.refunded\ncharge.dispute.closed",
    );
    // Sem segredo, o passo 4 e a situação dizem o que falta.
    expect(screen.getAllByText("Falta o segredo de assinatura").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Signing secret")).toBeTruthy();
  });

  it("explica a última assinatura recusada e recolhe o guia depois do primeiro evento", () => {
    const failing = {
      ...connection,
      secretSet: true,
      lastFailureAt: 20,
      lastFailureCode: "SIGNATURE_INVALID",
    };
    const { rerender } = render(<SetupGuide connection={failing} manager />);
    expect(screen.getByText(/o segredo colado não é o deste endpoint/)).toBeTruthy();
    rerender(<SetupGuide connection={{ ...failing, lastEventAt: 30 }} manager />);
    expect(screen.getByText(/^Último em/)).toBeTruthy();
    expect(screen.queryByText(/não é o deste endpoint/)).toBeNull();
    expect(screen.getByText("Rever o passo a passo").closest("details")?.open).toBe(false);
  });
});

describe("configuração da conexão", () => {
  it("envia a configuração com os dois mercados, as atividades e a política de reembolso", async () => {
    state.mutate.mockResolvedValue({});
    page();
    fireEvent.click(screen.getByRole("radio", { name: /^Os dois/ }));
    fireEvent.change(screen.getByLabelText("Atividade das vendas ao exterior"), {
      target: { value: "suporte" },
    });
    fireEvent.change(screen.getByLabelText(/Alíquota do ISS/), { target: { value: "2,5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Checkout avulso pago/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Emitir como “NIF não exigido”/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Cancelar a nota automaticamente/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("stripe:updateConnection", {
      connectionId: "conn1",
      expectedVersion: 3,
      name: "Stripe Loja Exemplo",
      active: true,
      config: {
        market: "both",
        domesticActivityCode: "licenca",
        exportActivityCode: "suporte",
        description: "{itens} — cobrança {cobranca}",
        issRate: "2.5",
        invoices: true,
        checkouts: false,
        foreignWithoutNif: "not_required",
        refundPolicy: "cancel",
      },
    });
    expect(screen.getByText("Configuração salva.")).toBeTruthy();
  });

  it("uma recusa libera o formulário com o motivo e a nova tentativa salva", async () => {
    state.mutate.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    page();
    const save = () => screen.getByRole("button", { name: "Salvar configuração" });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(screen.getByText(/Não foi possível concluir/)).toBeTruthy();
    expect(screen.queryByText("Configuração salva.")).toBeNull();
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save());
    });
    expect(screen.queryByText(/Não foi possível concluir/)).toBeNull();
    expect(screen.getByText("Configuração salva.")).toBeTruthy();
  });

  it("deixa fora os campos do mercado que a conexão não atende e mostra a prévia", () => {
    const draft = {
      ...draftOf(connection),
      market: "export" as const,
      exportActivityCode: "suporte",
      issRate: "2",
    };
    expect(configOf(draft)).toEqual({
      market: "export",
      exportActivityCode: "suporte",
      description: "{itens} — cobrança {cobranca}",
      invoices: true,
      checkouts: true,
      foreignWithoutNif: "hold",
      refundPolicy: "notify",
    });
    expect(descriptionPreview("{itens} — {cobranca}, {periodo}", Date.UTC(2026, 9, 11, 15))).toBe(
      "Plano Pro (mensal) — A1B2C3-0001, 10/2026",
    );
  });

  it("mostra a configuração só para leitura a quem não é gestor", () => {
    state.queries = { "stripe:listConnections": [connection], "nfseProfiles:get": profile };
    render(
      <StripeConnections
        org={{ ...org, role: "developer" } as Props["org"]}
        projectId={"p1" as Props["projectId"]}
        contextKey="k"
        grants={grants}
      />,
    );
    expect(screen.getByText(/Você vê a configuração em modo leitura/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar configuração" })).toBeNull();
    expect(screen.getByRole("button", { name: /Nova conexão/ })).toHaveProperty("disabled", true);
  });
});

describe("eventos recebidos", () => {
  const pending = {
    id: "ev1",
    stripeEventId: "evt_1",
    type: "invoice.paid",
    livemode: false,
    state: "pending_data",
    code: null,
    charge: {
      kind: "invoice",
      id: "in_1",
      reference: "A1B2C3-0001",
      currency: "BRL",
      amount: "149.90",
      paidAt: 1,
      items: ["Plano Pro"],
      customer: {
        name: "Mercado Sintético Ltda",
        email: "financeiro@mercado.example",
        country: "BR",
        state: "SP",
        city: "Campinas",
        postalCode: "13010-000",
        line1: "Rua das Flores, 120",
        line2: "Centro",
        taxIds: [{ type: "br_cnpj", value: "11.444.777/0001-61" }],
      },
    },
    reversal: null,
    missing: ["municipality"],
    taker: null,
    issuance: null,
    refundAction: null,
    receivedAt: 1,
    updatedAt: 1,
  } as unknown as StripeEvent;

  it("pede os dados que faltam e libera a emissão com o tomador completo", async () => {
    state.mutate.mockResolvedValue(null);
    page([pending]);
    const list = screen.getByRole("heading", { name: "Eventos recebidos" }).closest("section")!;
    expect(within(list).getByText("Pendente de dados")).toBeTruthy();
    expect(within(list).getByText(/Faltou do Stripe: município \(cidade e UF\)/)).toBeTruthy();
    expect(within(list).getByText(/R\$\s149,90/)).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Completar dados" }));
    // Preenchido com o que veio do Stripe; só falta o município.
    expect((screen.getByLabelText("CPF ou CNPJ") as HTMLInputElement).value).toBe(
      "11.444.777/0001-61",
    );
    expect((screen.getByLabelText("Logradouro") as HTMLInputElement).value).toBe("Rua das Flores");
    fireEvent.change(screen.getByLabelText("Código IBGE do município"), {
      target: { value: "3509502" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Liberar a emissão" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("stripe:completeEvent", {
      eventId: "ev1",
      taker: {
        kind: "national",
        document: "11444777000161",
        name: "Mercado Sintético Ltda",
        email: "financeiro@mercado.example",
        address: {
          municipalityCode: "3509502",
          postalCode: "13010000",
          street: "Rua das Flores",
          number: "120",
          district: "Centro",
        },
      },
    });
    expect(screen.queryByRole("button", { name: "Liberar a emissão" })).toBeNull();
  });

  // Synthetic documents: the alphanumeric CNPJ example of the Receita, a valid numeric CNPJ and a
  // valid CPF.
  it.each([
    ["CNPJ alfanumérico formatado, em minúsculas", "12.abc.345/01de-35", "12ABC34501DE35"],
    ["CNPJ alfanumérico em maiúsculas", "12ABC34501DE35", "12ABC34501DE35"],
    ["CNPJ numérico", "11.444.777/0001-61", "11444777000161"],
    ["CPF", "529.982.247-25", "52998224725"],
  ])("envia o %s como o servidor espera", async (_, typed, sent) => {
    expect(takerDocumentOf(typed)).toBe(sent);
    state.mutate.mockResolvedValue(null);
    page([pending]);
    fireEvent.click(screen.getByRole("button", { name: "Completar dados" }));
    const document = screen.getByLabelText("CPF ou CNPJ") as HTMLInputElement;
    // Letters are allowed: no numeric keyboard, and the length still fits a formatted CNPJ.
    expect(document.getAttribute("inputmode")).toBeNull();
    expect(document.getAttribute("autocapitalize")).toBe("characters");
    expect(document.maxLength).toBe(18);
    fireEvent.change(document, { target: { value: typed } });
    fireEvent.change(screen.getByLabelText("Código IBGE do município"), {
      target: { value: "3509502" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Liberar a emissão" }));
    });
    expect(state.mutate).toHaveBeenCalledWith(
      "stripe:completeEvent",
      expect.objectContaining({
        taker: expect.objectContaining({ kind: "national", document: sent }),
      }),
    );
  });

  it("envia o NIF do tomador estrangeiro como digitado", async () => {
    state.mutate.mockResolvedValue(null);
    page([pending]);
    fireEvent.click(screen.getByRole("button", { name: "Completar dados" }));
    fireEvent.click(screen.getByLabelText("Tomador no exterior"));
    expect(screen.queryByLabelText("CPF ou CNPJ")).toBeNull();
    fireEvent.change(screen.getByLabelText("NIF (tax ID)"), { target: { value: "ab-12.345/6" } });
    fireEvent.change(screen.getByLabelText("País (ISO, 2 letras)"), { target: { value: "us" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Liberar a emissão" }));
    });
    expect(state.mutate).toHaveBeenCalledWith("stripe:completeEvent", {
      eventId: "ev1",
      taker: {
        kind: "foreign",
        nif: "ab-12.345/6",
        name: "Mercado Sintético Ltda",
        email: "financeiro@mercado.example",
        address: {
          country: "US",
          city: "Campinas",
          postalCode: "13010-000",
          state: "SP",
          street: "Rua das Flores",
          number: "120",
          district: "Centro",
        },
      },
    });
  });

  it("explica o código de um evento ignorado e oferece nova tentativa só para falhas", () => {
    page([
      { ...pending, id: "ev2", state: "ignored", code: "LIVEMODE_MISMATCH", missing: [] },
      { ...pending, id: "ev3", state: "failed", code: "CERTIFICATE_UNAVAILABLE", missing: [] },
    ]);
    expect(screen.getByText(/Evento de teste numa conexão de Produção/)).toBeTruthy();
    expect(
      screen.getByText(/A plataforma recusou o pedido \(CERTIFICATE_UNAVAILABLE\)/),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Tentar de novo" })).toHaveLength(1);
  });

  // The issuance refused by the plan (`PLAN_INACTIVE` from `operations.reserve`) fails the event
  // with the code; the row explains it by role.
  it.each([
    ["gestor", "owner", true],
    ["operador", "operator", false],
  ])("evento recusado pela vigência do plano: aviso pelo papel (%s)", (_, role, manager) => {
    page([{ ...pending, id: "ev6", state: "failed", code: "PLAN_INACTIVE", missing: [] }], {
      ...org,
      role,
      capabilities: { manageOrganization: manager },
    } as unknown as Props["org"]);
    const notice = screen.getByText(/O plano está fora da vigência/).closest(".ui-callout")!;
    expect(notice.querySelector("code")?.textContent).toBe("PLAN_INACTIVE");
    const link = within(notice as HTMLElement).queryByRole("link");
    if (manager) {
      expect(notice.textContent).toMatch(/Gestão e integração › Uso e limites/);
      expect(link?.textContent).toBe("Abrir Uso e limites");
      expect(link?.getAttribute("href")).toBe("/app/equipe/usage");
    } else {
      expect(notice.textContent).toMatch(/Fale com um gestor da organização/);
      expect(link).toBeNull();
    }
  });

  it("mostra um estado que o console ainda não conhece sem derrubar a lista", () => {
    page([
      { ...pending, id: "ev4", state: "archived" as never, missing: [] },
      { ...pending, id: "ev5", state: "refund", refundAction: "reverted" as never, missing: [] },
    ]);
    expect(screen.getByText("archived")).toBeTruthy();
    expect(screen.getByText("reverted")).toBeTruthy();
  });
});
