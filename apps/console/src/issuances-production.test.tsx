// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { emptyDraft, type Draft } from "./issuance-draft";
import { IssuanceForm } from "./issuance-form";
import type { IssuanceScope } from "./municipality";
import { IssuanceDetail } from "./issuances";
import {
  ProductionGateState,
  ProductionNote,
  productionSummary,
  takerLabel,
} from "./issuance-production";
import { EnvironmentStamp } from "./environment-stamp";
import { formatDateTime } from "./format";

/**
 * The console in the fiscal production deployment (#198): the summary confirmed before a request
 * or a cancellation, the read-only gate and the environment stamp. Queries and mutations are
 * replaced; every company, taker and key is synthetic and nothing reaches a tax authority.
 */
const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    // The activity mark of a fiscal read (#641) is not one of the mutations these tests count.
    getFunctionName(fn) === "archiveNotice:markFiscalRead"
      ? Promise.resolve(null)
      : state.mutate(getFunctionName(fn), args),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ organizationSlug: "equipe" }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const NOW = Date.UTC(2026, 9, 8, 15); // 08/10/2026 12:00 in Brasília
// The clock moves only when a test says so: the confirmation ignores clicks for 350 ms.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  state.queries = {};
});
/** Past the dialog's settling time: the next click is the person's decision. */
const settle = () => vi.setSystemTime(Date.now() + 400);

const scope = {
  organizationId: "org",
  companyId: "company",
  environment: "production",
} as unknown as IssuanceScope;
const activity = {
  code: "licenca",
  label: "Licenciamento sintético",
  cnae: "6202300",
  lc116Item: "01.05",
  cTribNac: "010501",
};
const national: Draft["national"] = {
  document: "11.444.777/0001-61",
  name: "Tomador Sintético Ltda",
  email: "",
  municipalityCode: "3550308",
  postalCode: "01001-000",
  street: "Praça da Sé",
  number: "100",
  district: "Sé",
};

function fill() {
  const set = (label: string | RegExp, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  set("E-mail do prestador", "fiscal@prestador.example");
  set("Descrição do serviço", "Licença de uso");
  set("CPF ou CNPJ do tomador", national.document);
  set("Nome ou razão social", national.name);
  set("Código IBGE do município", national.municipalityCode);
  set("CEP", national.postalCode);
  set("Logradouro", national.street);
  set("Número", national.number);
  set("Bairro", national.district);
  set("Valor do serviço", "1500,00");
  set("Alíquota do ISS (%)", "2");
}
const form = (transport: "simulated" | "producao", onCreated = vi.fn(), closed = false) => {
  state.queries["nfseProfiles:get"] = { opSimpNac: 1, activities: [activity], version: 1 };
  render(
    <IssuanceForm
      scope={scope}
      transport={transport}
      onCreated={onCreated}
      onCancel={() => {}}
      productionClosed={closed}
    />,
  );
  fill();
  const button = transport === "producao" ? "Revisar pedido" : "Pedir emissão";
  return screen.getByRole("button", { name: button }).closest("form")!;
};
const openConfirmation = async (submit: HTMLFormElement) => {
  await act(async () => {
    fireEvent.submit(submit);
  });
  return screen.getByRole("alertdialog");
};

describe("pedido em produção fiscal", () => {
  it("só envia depois de confirmar tomador, valor e destino; Revisar não envia nada", async () => {
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i1" });
    const onCreated = vi.fn();
    const submit = form("producao", onCreated);
    expect(screen.getByRole("region", { name: "Para onde a nota vai" }).textContent).toMatch(
      /TransporteProdução/,
    );
    // The form only reviews; the dialog's "Pedir emissão" is the one that sends.
    expect(screen.queryByRole("button", { name: "Pedir emissão" })).toBeNull();
    expect(screen.getByText(/nada é enviado antes da confirmação/)).toBeTruthy();
    let dialog = await openConfirmation(submit);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(dialog).toBe(screen.getByRole("alertdialog", { name: "Emitir NFS-e em produção?" }));
    expect(dialog.textContent).toMatch(/validade fiscal/);
    expect(dialog.textContent).toMatch(/Tomador Sintético Ltda · CNPJ 11\.444\.777\/0001-61/);
    // The document is one unit that never breaks; the name may wrap.
    expect(within(dialog).getByText("CNPJ 11.444.777/0001-61").className).toBe("fiscal-num");
    expect(dialog.textContent).toMatch(/R\$\s1\.500,00/);
    expect(dialog.textContent).toMatch(/Sefin Nacional \(ADN\), em produção/);
    // Terms above values, also on the desktop.
    expect(dialog.querySelector("dl.fiscal-summary")).toBeTruthy();
    // The safe option has the focus and closes without sending.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Revisar" }));
    settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revisar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
    dialog = await openConfirmation(submit);
    settle();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Pedir emissão" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0]![0]).toBe("issuanceConsole:request");
    expect(onCreated).toHaveBeenCalledWith("i1");
  });

  it("o segundo clique ou toque de quem abriu não confirma nem fecha pelo fundo", async () => {
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i1" });
    const dialog = await openConfirmation(form("producao"));
    const confirm = within(dialog).getByRole("button", { name: "Pedir emissão" });
    const backdrop = dialog.parentElement!;
    // Right after opening: the backdrop (desktop) or the button under the finger (mobile).
    fireEvent.mouseDown(backdrop);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(state.mutate).not.toHaveBeenCalled();
    // A repeated click (`detail` 2) does not count, even later.
    settle();
    fireEvent.mouseDown(backdrop, { detail: 2 });
    await act(async () => {
      fireEvent.click(confirm, { detail: 2 });
    });
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(state.mutate).not.toHaveBeenCalled();
    // A deliberate click after the settling time does.
    await act(async () => {
      fireEvent.click(confirm, { detail: 1 });
    });
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });

  it("depois da espera, o fundo fecha a confirmação sem enviar", async () => {
    const dialog = await openConfirmation(form("producao"));
    settle();
    fireEvent.mouseDown(dialog.parentElement!, { detail: 1 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("a recusa do servidor volta ao formulário, e a mesma tentativa reaproveita a chave", async () => {
    state.mutate.mockRejectedValueOnce(new ConvexError({ code: "ISSUANCE_PRODUCTION_DISABLED" }));
    state.mutate.mockResolvedValueOnce({ reused: true, issuanceId: "i1" });
    const submit = form("producao");
    for (let i = 0; i < 2; i++) {
      const dialog = await openConfirmation(submit);
      settle();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Pedir emissão" }));
      });
    }
    const keys = state.mutate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("com erro de validação, não abre a confirmação", async () => {
    const submit = form("producao");
    fireEvent.change(screen.getByLabelText("Valor do serviço"), { target: { value: "" } });
    await act(async () => {
      fireEvent.submit(submit);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("com o gate desligado, owner e admin leem junto do botão que o pedido será recusado", () => {
    form("producao", vi.fn(), true);
    const button = screen.getByRole("button", { name: "Revisar pedido" });
    const note = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(note.textContent).toMatch(/desligada para esta empresa: novos pedidos serão recusados/);
  });

  it("no sandbox, o pedido sai direto, sem confirmação a mais", async () => {
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i1" });
    const submit = form("simulated");
    expect(screen.queryByRole("button", { name: "Revisar pedido" })).toBeNull();
    expect(
      screen.getByText(/O pedido é aceito pelo servidor e transmitido em seguida/),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.submit(submit);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });

  it("resume a exportação com o nome do país, o NIF e o valor na moeda", () => {
    const draft: Draft = {
      ...emptyDraft(NOW),
      market: "export",
      currency: "USD",
      value: "1.000,50",
      foreign: {
        ...emptyDraft(NOW).foreign,
        name: " Example  LLC ",
        country: "us",
        nifChoice: "nif",
        nif: "12-3456789",
      },
    };
    expect(productionSummary(draft, null)).toEqual({
      taker: { name: "Example LLC", document: "NIF 12-3456789", place: "Estados Unidos" },
      value: expect.stringMatching(/^USD\s1\.000,50$/),
      target: "Sefin Nacional (ADN)",
    });
  });

  it("formata CPF e CNPJ do tomador como no cancelamento", () => {
    const person = { kind: "national" as const, name: "Ana" };
    const cpf = { name: "Ana", document: "CPF 529.982.247-25", place: null };
    expect(takerLabel({ ...person, document: "529.982.247-25" })).toEqual(cpf);
    expect(takerLabel({ ...person, document: "52998224725" })).toEqual(cpf);
    expect(takerLabel({ ...person, document: "11444777000161" })).toEqual({
      name: "Ana",
      document: "CNPJ 11.444.777/0001-61",
      place: null,
    });
  });
});

const authorized = (transport: "producao" | "simulated") => ({
  issuance: {
    id: "i1",
    organizationId: "org",
    projectId: "project",
    companyId: "company",
    environment: transport === "producao" ? "production" : "sandbox",
    operationId: "op",
    operationState: "succeeded",
    state: "authorized",
    transport,
    target: "sefin-nacional",
    series: "1",
    number: 7,
    dpsId: "DPS355030821122233300018100001000000000000007",
    issueDate: "2026-10-05",
    competence: "2026-10",
    market: "domestic",
    amount: { currency: "BRL", value: "1000.00" },
    serviceBrl: "1000.00",
    exchange: null,
    accessKey: "35503082211222333000181000000000000726100000000007",
    nfseNumber: "7",
    documentId: null,
    code: null,
    rejections: [],
    artifacts: [],
    cancellation: null,
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  snapshot: {
    acceptedAt: NOW,
    dhEmi: "2026-10-05T12:00:00-03:00",
    dCompet: "2026-10-05",
    issuer: { cnpj: "11222333000181", name: "Prestador Sintético", email: "f@p.example" },
    profileVersion: 1,
    municipalityCode: "3550308",
    activity: { code: "licenca", label: "Licenciamento", cTribNac: "010501", nbs: null },
    taker: {
      kind: "national",
      documentType: "CNPJ",
      document: "11444777000161",
      name: "Tomador Sintético Ltda",
      email: null,
      address: {
        municipalityCode: "3550308",
        postalCode: "01001000",
        street: "Praça da Sé",
        number: "100",
        district: "Sé",
      },
    },
    description: "Licença de uso",
    iss: { rate: "2.5", withheld: false, amount: "25.00" },
  },
  events: [],
  canCancel: true,
});

async function askCancellation(button = "Revisar cancelamento") {
  fireEvent.click(screen.getByRole("button", { name: "Cancelar NFS-e" }));
  fireEvent.change(screen.getByLabelText("Justificativa"), {
    target: { value: "Serviço emitido em duplicidade" },
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: button }).closest("form")!);
  });
}

describe("cancelamento em produção fiscal", () => {
  it("diz qual nota e o que vai ao fisco, fica aberto na recusa e envia só ao confirmar", async () => {
    state.queries["issuanceConsole:detail"] = authorized("producao");
    state.mutate.mockRejectedValueOnce(new ConvexError({ code: "RATE_LIMITED" }));
    state.mutate.mockResolvedValueOnce({ reused: false, issuanceId: "i1" });
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    expect(screen.queryByText(/Emissão simulada/)).toBeNull();
    await askCancellation();
    expect(state.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Cancelar esta NFS-e em produção?" });
    expect(dialog.textContent).toMatch(/não pode ser desfeito/);
    const rows = Array.from(dialog.querySelectorAll(".ui-dl__row")).map((row) => [
      row.querySelector("dt")!.textContent,
      row.querySelector("dd")!.textContent,
    ]);
    expect(rows).toEqual([
      ["Nota", "NFS-e nº 7 · DPS série 1 nº 7"],
      ["Tomador", "Tomador Sintético Ltda · CNPJ 11.444.777/0001-61"],
      ["Valor", expect.stringMatching(/^R\$\s1\.000,00$/)],
      ["Destino", "Sefin Nacional (ADN), em produção"],
      ["Motivo", "Erro na emissão: Serviço emitido em duplicidade"],
    ]);
    // Document and note numbers are units that never break.
    expect(within(dialog).getByText("CNPJ 11.444.777/0001-61").className).toBe("fiscal-num");
    expect(within(dialog).getByText("DPS série 1 nº 7").className).toBe("fiscal-num");
    // One name per meaning: the dialog reviews ("Revisar") or confirms; no "Voltar" here.
    expect(within(dialog).queryByRole("button", { name: "Voltar" })).toBeNull();
    settle();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar cancelamento" }));
    });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Muitas tentativas/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar cancelamento" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const calls = state.mutate.mock.calls;
    expect(calls.map((call) => call[0])).toEqual([
      "issuanceConsole:cancel",
      "issuanceConsole:cancel",
    ]);
    expect((calls[1]![1] as { idempotencyKey: string }).idempotencyKey).toBe(
      (calls[0]![1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(screen.queryByLabelText("Justificativa")).toBeNull();
  });

  it("o segundo clique logo depois de abrir não confirma; Revisar volta ao formulário", async () => {
    state.queries["issuanceConsole:detail"] = authorized("producao");
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    await askCancellation();
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar cancelamento" }));
    });
    expect(state.mutate).not.toHaveBeenCalled();
    settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revisar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Justificativa")).toBeTruthy();
  });

  it("no sandbox, cancelar continua sem confirmação a mais e com o rótulo de sempre", async () => {
    state.queries["issuanceConsole:detail"] = authorized("simulated");
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i1" });
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    await askCancellation("Confirmar cancelamento");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("gate e indicador de ambiente", () => {
  it("liberada em tom neutro com a hora; desligada em atenção com o que continua; sem login", () => {
    const { container, rerender } = render(
      <ProductionGateState gate={{ open: true, since: NOW }} />,
    );
    // Local time of the browser, like every other time in the console.
    expect(container.textContent).toBe(`Emissão em produção:Liberadadesde ${formatDateTime(NOW)}`);
    expect(container.querySelector(".ui-badge")!.className).toBe("ui-badge ui-badge--neutral");
    rerender(<ProductionGateState gate={{ open: false, since: null }} />);
    expect(container.querySelector(".ui-badge")!.className).toBe("ui-badge ui-badge--warning");
    expect(container.textContent).toMatch(
      /^Emissão em produção:Desligada.*cancelamentos e consultas/,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a nota de produção, em atenção, mostra o gate só a quem o servidor entregou", () => {
    const { rerender } = render(<ProductionNote gate={null} />);
    const note = screen.getByRole("note");
    expect(note.querySelector(".ui-callout--warning")).toBeTruthy();
    expect(note.textContent).toMatch(/^Produção fiscal\. .*validade fiscal/);
    expect(note.textContent).not.toMatch(/Emissão em produção/);
    rerender(<ProductionNote gate={{ open: false, since: null }} />);
    expect(screen.getByRole("note").textContent).toMatch(/Emissão em produção:Desligada/);
  });

  it("carimba cada ambiente em texto e tom próprios; o sandbox fica como era", () => {
    type Stamped = Parameters<typeof EnvironmentStamp>[0]["deployment"];
    const stamp = (deployment: Stamped, label = "Instalação") => {
      cleanup();
      return render(<EnvironmentStamp label={label} deployment={deployment} />).container;
    };
    let view = stamp({ environment: "production", fiscalProduction: true, confirmed: true });
    expect(view.textContent).toBe("Produção fiscalNotas com validade fiscal · Instalação");
    expect(view.querySelector(".ui-badge")!.className).toBe("ui-badge ui-badge--info");
    view = stamp({ environment: "production", fiscalProduction: false, confirmed: true });
    expect(view.textContent).toBe("ProduçãoSem emissão de NFS-e · Instalação");
    expect(view.querySelector(".ui-badge")!.className).toBe("ui-badge ui-badge--neutral");
    // Before the server answers, a production build says only "Produção", neutral.
    view = stamp({ environment: "production", fiscalProduction: false, confirmed: false });
    expect(view.innerHTML).toBe('<span class="ui-badge ui-badge--neutral">Produção</span>');
    // Byte for byte the markup the sandbox had before this change, confirmed or not.
    for (const deployment of [
      undefined,
      { environment: "sandbox", fiscalProduction: false, confirmed: true },
      { environment: "sandbox", fiscalProduction: false, confirmed: false },
    ] as const)
      expect(stamp(deployment, "Local").innerHTML).toBe(
        '<span class="ui-badge ui-badge--warning">Sandbox</span><span>Sem validade fiscal · Local</span>',
      );
  });
});
