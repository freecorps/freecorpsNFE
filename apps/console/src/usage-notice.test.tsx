// @vitest-environment jsdom
// The quota and plan notice in the real screens: owners and admins get the path and the link to
// Uso e limites; the other roles, the text asking a manager, without a link. The refusals carry the
// server's codes (`QUOTA_EXCEEDED`, `PLAN_INACTIVE`, platform/convex/lib/usageCore.ts).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Reprocess } from "./document-reprocess";
import { ImportFlow } from "./imports";
import { IssuanceForm } from "./issuance-form";
import type { IssuanceScope } from "./municipality";
import type { Organization } from "./organizations";
import { Webhooks } from "./webhooks";

const state = vi.hoisted(() => ({
  // The sandbox deployment, confirmed: the fiscal screens wait for it before any query.
  queries: { "deployment:current": { environment: "sandbox", fiscalProduction: false } } as Record<
    string,
    unknown
  >,
  pages: {} as Record<string, unknown[]>,
  search: {} as Record<string, unknown>,
  mutate: vi.fn(),
  query: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: state.query }),
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
  usePaginatedQuery: (fn: Parameters<typeof getFunctionName>[0]) => ({
    results: state.pages[getFunctionName(fn)] ?? [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ organizationSlug: "equipe" }),
  useSearch: () => state.search,
  useNavigate: () => vi.fn(async () => {}),
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}>
      {children}
    </a>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  state.queries = { "deployment:current": { environment: "sandbox", fiscalProduction: false } };
  state.pages = {};
  state.search = {};
});

const orgAs = (manager: boolean) =>
  ({
    id: "org",
    slug: "equipe",
    name: "Equipe Sintética",
    role: manager ? "owner" : "operator",
    capabilities: { manageOrganization: manager, operateDocuments: true },
  }) as unknown as Organization;
const roles = [
  ["gestor", true],
  ["operador", false],
] as const;
function expectNotice(notice: Element, manager: boolean) {
  const link = notice.querySelector("a");
  if (manager) {
    expect(notice.textContent).toMatch(/Gestão e integração › Uso e limites/);
    expect(link?.textContent).toBe("Abrir Uso e limites");
    expect(link?.getAttribute("href")).toBe("/app/equipe/usage");
  } else {
    expect(notice.textContent).toMatch(/Fale com um gestor da organização/);
    expect(notice.textContent).not.toMatch(/Gestão e integração › Uso e limites/);
    expect(link).toBeNull();
  }
}

describe("importação", () => {
  const scope = {
    organizationId: "org",
    companyId: "company",
    environment: "sandbox",
  } as unknown as Parameters<typeof ImportFlow>[0]["scope"];
  async function importOne() {
    const file = new File(["<xml/>"], "nota.xml", { type: "application/xml" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(6) });
    vi.stubGlobal("crypto", {
      randomUUID: () => "intent",
      subtle: { digest: async () => new Uint8Array(32).buffer },
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Arraste os XMLs aqui ou escolha os arquivos"), {
        target: { files: [file] },
      }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Importar arquivos" })),
    );
  }

  it.each(roles)("cota esgotada ao reservar: aviso pelo papel (%s)", async (_, manager) => {
    state.queries["imports:recent"] = [];
    state.mutate.mockRejectedValue(new ConvexError({ code: "QUOTA_EXCEEDED", metric: "imports" }));
    render(<ImportFlow scope={scope} writable organizationSlug="equipe" org={orgAs(manager)} />);
    await importOne();
    expect(state.mutate).toHaveBeenCalledWith("imports:reserve", expect.anything());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Esta operação atingiu o limite do plano/);
    expectNotice(alert, manager);
  });

  // ADR 0010: the free tier's Production refuses a new import by its notes, not its files.
  it.each([
    [100, "A organização chegou ao limite de 100 notas novas do mês em Produção."],
    [undefined, "A organização chegou ao limite de notas novas do mês em Produção."],
  ])(
    "recusa pela cota de notas (limite %s) diz que é o limite de notas novas",
    async (limit, text) => {
      state.queries["imports:recent"] = [];
      state.mutate.mockRejectedValue(
        new ConvexError({
          code: "QUOTA_EXCEEDED",
          metric: "documents",
          environment: "production",
          period: "2026-10",
          ...(limit === undefined ? {} : { limit }),
        }),
      );
      render(<ImportFlow scope={scope} writable organizationSlug="equipe" org={orgAs(true)} />);
      await importOne();
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(`${text} Esta operação atingiu o limite do plano.`);
      expectNotice(alert, true);
    },
  );

  it("falha que não é de cota mantém a mensagem da importação", async () => {
    state.queries["imports:recent"] = [];
    state.mutate.mockRejectedValue(new ConvexError({ code: "RATE_LIMITED" }));
    render(<ImportFlow scope={scope} writable organizationSlug="equipe" org={orgAs(true)} />);
    await importOne();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "Não foi possível confirmar a solicitação. Tente novamente para recuperar a mesma importação.",
    );
    expect(alert.querySelector("a")).toBeNull();
  });
});

describe("reprocessamento do documento", () => {
  const scope = {
    organizationId: "org",
    companyId: "company",
    environment: "sandbox",
  } as unknown as Parameters<typeof Reprocess>[0]["scope"];
  async function reprocess(manager: boolean) {
    render(<Reprocess org={orgAs(manager)} scope={scope} documentId="doc1" />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Reprocessar XML atual" })),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      "documents:reprocess",
      expect.objectContaining({ documentId: "doc1" }),
    );
    return screen.getByRole("alert");
  }

  // `documents.reprocess` reserves an operation, which requires an active plan.
  it.each(roles)("plano fora da vigência: aviso pelo papel (%s)", async (_, manager) => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "PLAN_INACTIVE" }));
    const alert = await reprocess(manager);
    expect(alert.textContent).toMatch(/O plano está fora da vigência/);
    expectNotice(alert, manager);
  });

  it("falha que não é de limite mantém a mensagem do reprocessamento", async () => {
    state.mutate.mockRejectedValue(new ConvexError({ code: "RATE_LIMITED" }));
    const alert = await reprocess(true);
    expect(alert.textContent).toBe(
      "Não foi possível iniciar. Tente novamente para recuperar a mesma solicitação.",
    );
    expect(alert.querySelector("a")).toBeNull();
  });
});

describe("emissão NFS-e", () => {
  const scope = {
    organizationId: "org",
    companyId: "company",
    environment: "sandbox",
  } as unknown as IssuanceScope;
  const profile = {
    version: 1,
    opSimpNac: 1,
    activities: [
      {
        code: "licenca",
        label: "Licenciamento sintético",
        cnae: "6202300",
        lc116Item: "01.05",
        cTribNac: "010501",
      },
    ],
  };
  async function submit() {
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set("E-mail do prestador", "fiscal@prestador.example");
    set("Descrição do serviço", "Licença de uso");
    set("CPF ou CNPJ do tomador", "11.444.777/0001-61");
    set("Nome ou razão social", "Tomador Sintético Ltda");
    set("Código IBGE do município", "3550308");
    set("CEP", "01001-000");
    set("Logradouro", "Praça da Sé");
    set("Número", "100");
    set("Bairro", "Sé");
    set("Valor do serviço", "1500,00");
    set("Alíquota do ISS (%)", "2");
    const form = screen.getByRole("button", { name: /Pedir emissão/ }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });
  }

  it.each(roles)("plano fora da vigência ao pedir: aviso pelo papel (%s)", async (_, manager) => {
    state.queries["nfseProfiles:get"] = profile;
    state.mutate.mockRejectedValue(new ConvexError({ code: "PLAN_INACTIVE" }));
    render(
      <IssuanceForm
        scope={scope}
        transport="simulated"
        org={orgAs(manager)}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    await submit();
    expect(state.mutate).toHaveBeenCalledWith("issuanceConsole:request", expect.anything());
    const reason = document.getElementById("issuance-submit-reason")!;
    expect(reason.textContent).toMatch(
      /^O servidor recusou o pedido\. O plano está fora da vigência/,
    );
    expectNotice(reason, manager);
  });

  it("sem a organização, o texto neutro do console, sem link", async () => {
    state.queries["nfseProfiles:get"] = profile;
    state.mutate.mockRejectedValue(new ConvexError({ code: "QUOTA_EXCEEDED" }));
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    await submit();
    const reason = document.getElementById("issuance-submit-reason")!;
    expect(reason.textContent).toMatch(/Proprietários e administradores acompanham o consumo/);
    expect(reason.querySelector("a")).toBeNull();
  });
});

describe("webhooks", () => {
  const grant = {
    companyId: "company",
    name: "Empresa Sintética",
    scopes: ["webhooks:manage", "documents:read"],
    environments: ["sandbox"],
    version: 1,
  };
  const endpoint = {
    id: "e1",
    name: "ERP sintético",
    url: "https://erp.example/webhooks",
    active: true,
    events: ["document.received"],
    secretVersion: 1,
    previousUntil: null,
    version: 1,
  };
  const delivery = (code: string) => ({
    id: "d1",
    eventId: "evt1",
    type: "document.received",
    state: "paused",
    code,
    response: null,
    attempts: 0,
    generation: 1,
    resourceVersion: 1,
    createdAt: 1,
    nextAttemptAt: null,
    durationMs: null,
    canRetry: true,
  });
  function page(manager: boolean, code: string) {
    state.search = { company: "company", endpoint: "e1" };
    state.queries["webhooks:list"] = [endpoint];
    state.pages["webhooks:deliveries"] = [delivery(code)];
    return render(
      <Webhooks
        org={orgAs(manager)}
        projectId={"p1" as never}
        grants={[grant] as unknown as Parameters<typeof Webhooks>[0]["grants"]}
      />,
    );
  }

  // The delivery is paused by the dispatcher (`webhookDelivery.ts`) with the usage code.
  it.each(roles)("entrega pausada pela cota: motivo pelo papel (%s)", (_, manager) => {
    page(manager, "QUOTA_EXCEEDED");
    const notice = screen.getByText(/Esta operação atingiu o limite do plano/);
    expect(screen.queryByText("QUOTA_EXCEEDED")).toBeNull();
    expectNotice(notice, manager);
  });

  it("outro motivo da entrega continua como antes", () => {
    page(true, "ACCESS_REVOKED");
    expect(
      screen.getByText("Destino ou concessão desativados. Confira o acesso antes de reenviar."),
    ).toBeTruthy();
  });
});
