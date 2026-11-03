// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import {
  decimalText,
  emptyDraft,
  inputOf,
  routeOf,
  validateDraft,
  valuePreview,
  type Draft,
} from "./issuance-draft";
import { IssuanceForm } from "./issuance-form";
import type { IssuanceScope } from "./municipality";
import { formatDateTimeSeconds } from "./format";
import { IssuanceDetail, issuanceAction, issuanceStatus } from "./issuances";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args?: unknown) =>
    args === "skip" ? undefined : state.queries[getFunctionName(fn)],
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ organizationSlug: "equipe" }),
  Link: ({
    children,
    to,
    search,
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string>;
  }) => <a href={`${to}?${new URLSearchParams(search ?? {}).toString()}`}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  state.queries = {};
});

const NOW = Date.UTC(2026, 9, 8, 15); // 08/10/2026 12:00 in Brasília
const scope = {
  organizationId: "org",
  companyId: "company",
  environment: "sandbox",
} as unknown as IssuanceScope;
const activity = {
  code: "licenca",
  label: "Licenciamento sintético",
  cnae: "6202300",
  lc116Item: "01.05",
  cTribNac: "010501",
};
const profile = (opSimpNac: 1 | 2 | 3) => ({ opSimpNac, activities: [activity] });
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
const valid = (overrides: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(NOW),
  activityCode: "licenca",
  issuerEmail: "fiscal@prestador.example",
  description: "Licença de uso",
  value: "1.500,25",
  issRate: "2,5",
  national,
  ...overrides,
});

describe("validação espelhada do servidor", () => {
  it("converte decimais digitados em pt-BR sem ponto flutuante", () => {
    expect(decimalText("1.500,25")).toBe("1500.25");
    expect(decimalText("1500.25")).toBe("1500.25");
    expect(decimalText(" 2,5 ")).toBe("2.5");
  });

  it("aceita um pedido nacional válido e monta o input do servidor", () => {
    const draft = valid();
    expect(validateDraft(draft, profile(1), NOW)).toEqual({});
    expect(inputOf(draft, profile(1))).toEqual({
      activityCode: "licenca",
      competence: "2026-10",
      issueDate: "2026-10-08",
      issuerEmail: "fiscal@prestador.example",
      description: "Licença de uso",
      amount: { currency: "BRL", value: "1500.25" },
      market: "domestic",
      taker: {
        kind: "national",
        document: "11444777000161",
        name: "Tomador Sintético Ltda",
        address: {
          municipalityCode: "3550308",
          postalCode: "01001000",
          street: "Praça da Sé",
          number: "100",
          district: "Sé",
        },
      },
      issRate: "2.5",
      issWithheld: false,
    });
  });

  it("usa o e-mail do perfil quando o campo fica vazio", () => {
    const withEmail = { ...profile(1), issuerEmail: "perfil@prestador.example" };
    expect(validateDraft(valid({ issuerEmail: "" }), withEmail, NOW)).toEqual({});
    expect(inputOf(valid({ issuerEmail: "" }), withEmail)).not.toHaveProperty("issuerEmail");
    expect(validateDraft(valid({ issuerEmail: "" }), profile(1), NOW).issuerEmail).toBeTruthy();
  });

  it("no canal de Campinas, o Simples sem retenção também não informa alíquota", () => {
    const campinas = { ...profile(3), municipalityCode: "3509502" };
    expect(routeOf(valid(), campinas)).toMatchObject({ target: "campinas-adn" });
    expect(validateDraft(valid({ issRate: "" }), campinas, NOW)).toEqual({});
    expect(inputOf(valid(), campinas)).not.toHaveProperty("issRate");
    // Withholding and a non-opting provider state the rate there too.
    expect(validateDraft(valid({ issWithheld: true, issRate: "" }), campinas, NOW).issRate).toMatch(
      /retenção/,
    );
    expect(inputOf(valid({ issWithheld: true }), campinas)).toMatchObject({ issRate: "2.5" });
    const nonOpting = { ...profile(1), municipalityCode: "3509502" };
    expect(validateDraft(valid({ issRate: "" }), nonOpting, NOW).issRate).toMatch(/não é optante/);
  });

  it("aplica as regras de ISS do perfil e da retenção", () => {
    // Non-opting provider must state the rate.
    expect(validateDraft(valid({ issRate: "" }), profile(1), NOW).issRate).toMatch(/não é optante/);
    expect(validateDraft(valid({ issRate: "5,01" }), profile(1), NOW).issRate).toMatch(
      /0,01% a 5%/,
    );
    // The DPS carries 2 places: "2,0100" fits, "2,015" would need rounding.
    expect(validateDraft(valid({ issRate: "2,0100" }), profile(1), NOW)).toEqual({});
    expect(validateDraft(valid({ issRate: "2,015" }), profile(1), NOW).issRate).toMatch(
      /duas casas/,
    );
    // Simples without withholding: the rate is not sent at all.
    expect(validateDraft(valid(), profile(3), NOW)).toEqual({});
    expect(inputOf(valid(), profile(3))).not.toHaveProperty("issRate");
    // Withholding requires CNPJ and a rate.
    const cpf = { ...national, document: "529.982.247-25" };
    expect(
      validateDraft(valid({ issWithheld: true, national: cpf }), profile(3), NOW),
    ).toMatchObject({ issWithheld: expect.stringMatching(/CNPJ/) });
    expect(
      validateDraft(valid({ issWithheld: true, issRate: "" }), profile(3), NOW).issRate,
    ).toMatch(/retenção/);
  });

  it("recusa documento, datas e moeda incoerentes", () => {
    const errors = validateDraft(
      valid({
        national: { ...national, document: "11.444.777/0001-62", postalCode: "123" },
        issueDate: "2026-10-09",
        competence: "2026-11",
        value: "0,00",
        issuerEmail: "sem-arroba",
      }),
      profile(1),
      NOW,
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        "amount.value",
        "competence",
        "issueDate",
        "issuerEmail",
        "taker.address.postalCode",
        "taker.document",
      ].sort(),
    );
    const exportErrors = validateDraft(
      valid({
        market: "export",
        currency: "BRL",
        foreign: { ...emptyDraft(NOW).foreign, name: "LLC", country: "BR", city: "X" },
      }),
      profile(1),
      NOW,
    );
    expect(exportErrors).toMatchObject({
      "amount.currency": expect.any(String),
      "taker.nif": expect.any(String),
      "taker.address.country": expect.any(String),
    });
  });

  const foreignDraft: Draft["foreign"] = {
    ...emptyDraft(NOW).foreign,
    nifChoice: "absent",
    nifAbsence: "2",
    name: "Example LLC",
    country: "us",
    city: "San Francisco",
    postalCode: "94105",
    state: "CA",
    street: " Market  St ",
    number: "548",
    district: "N/A",
  };

  it("monta a exportação sem ISS, com motivo da ausência do NIF e o endereço completo", () => {
    const draft = valid({
      market: "export",
      currency: "USD",
      value: "1000",
      issRate: "2",
      foreign: foreignDraft,
    });
    expect(validateDraft(draft, profile(1), NOW)).toEqual({});
    const input = inputOf(draft, profile(1));
    expect(input).toMatchObject({
      market: "export",
      amount: { currency: "USD", value: "1000" },
      taker: {
        kind: "foreign",
        nifAbsence: 2,
        address: {
          country: "US",
          city: "San Francisco",
          postalCode: "94105",
          state: "CA",
          street: "Market St",
          number: "548",
          district: "N/A",
        },
      },
      issWithheld: false,
    });
    expect(input).not.toHaveProperty("issRate");
  });

  it("exige no exterior código postal, estado, logradouro, número e bairro", () => {
    const fields = {
      postalCode: "taker.address.postalCode",
      state: "taker.address.state",
      street: "taker.address.street",
      number: "taker.address.number",
      district: "taker.address.district",
    } as const;
    for (const [field, path] of Object.entries(fields)) {
      const draft = valid({
        market: "export",
        currency: "USD",
        value: "1000",
        foreign: { ...foreignDraft, [field]: "  " },
      });
      expect(Object.keys(validateDraft(draft, profile(1), NOW))).toEqual([path]);
    }
  });
});

describe("formulário de emissão", () => {
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

  it("deixa claro que o sandbox é simulado e repete a chave na mesma tentativa", async () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    state.mutate.mockRejectedValueOnce(new Error("network"));
    state.mutate.mockResolvedValueOnce({ reused: true, issuanceId: "i1" });
    const onCreated = vi.fn();
    render(
      <IssuanceForm
        scope={scope}
        transport="simulated"
        onCreated={onCreated}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("note").textContent).toMatch(/simulador.*sem\s+validade fiscal/s);
    fill();
    const form = screen.getByRole("button", { name: /Pedir emissão/ }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByText(/a mesma tentativa não emite duas vezes/)).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });
    const [first, second] = state.mutate.mock.calls.map(
      (call) => call[1] as { idempotencyKey: string },
    );
    expect(state.mutate.mock.calls[0]![0]).toBe("issuanceConsole:request");
    expect(first!.idempotencyKey).toMatch(/^console-/);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(onCreated).toHaveBeenCalledWith("i1");
  });

  it("muda a chave quando os dados mudam e mostra o erro do servidor no campo", async () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    state.mutate.mockRejectedValueOnce(
      new ConvexError({ code: "ISSUANCE_FIELD_INVALID", field: "taker.address.municipalityCode" }),
    );
    state.mutate.mockResolvedValueOnce({ reused: false, issuanceId: "i2" });
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    fill();
    const form = screen.getByRole("button", { name: /Pedir emissão/ }).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByLabelText("Código IBGE do município").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Código IBGE do município"));
    expect(document.getElementById("issuance-submit-reason")!.textContent).toMatch(
      /O servidor recusou o campo Código IBGE do município/,
    );
    fireEvent.change(screen.getByLabelText("Código IBGE do município"), {
      target: { value: "3304557" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    const keys = state.mutate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("não envia nada com erro de validação e aponta os campos", async () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pedir emissão/ }));
    });
    expect(state.mutate).not.toHaveBeenCalled();
    const summary = document.getElementById("issuance-submit-reason")!;
    expect(summary.textContent).toMatch(
      /^O pedido não foi enviado\. Confira os \d+ campos: E-mail do prestador, Descrição do serviço/,
    );
    expect(
      screen.getByRole("button", { name: /Pedir emissão/ }).getAttribute("aria-describedby"),
    ).toBe("issuance-submit-reason");
    // Focus goes to the first invalid field, in the order of the form.
    expect(screen.getByLabelText("E-mail do prestador").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("E-mail do prestador"));
  });

  it("lista no topo os campos recusados, cada um levando ao campo", async () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pedir emissão/ }));
    });
    const summary = screen.getByText(/^Confira \d+ campos antes de pedir$/).closest(".ui-callout")!;
    const bairro = within(summary as HTMLElement).getByRole("link", { name: "Bairro" });
    expect(bairro.getAttribute("href")).toBe("#taker-district");
    await act(async () => {
      fireEvent.click(bairro);
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Bairro"));
    // The address has its own group inside the taker's section.
    expect(screen.getByRole("group", { name: "Endereço do tomador" })).toBeTruthy();
  });

  it("mostra o ISS da nota enquanto valor e alíquota são digitados", () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("CPF ou CNPJ do tomador"), {
      target: { value: national.document },
    });
    fireEvent.change(screen.getByLabelText("Valor do serviço"), { target: { value: "1.500,00" } });
    fireEvent.change(screen.getByLabelText("Alíquota do ISS (%)"), { target: { value: "2,5" } });
    const rate = screen.getByLabelText("Alíquota do ISS (%)").closest(".ui-field")!;
    expect(rate.textContent).toMatch(/ISS na nota: R\$\s37,50/);
  });

  it("sem perfil, orienta a configurar a empresa", () => {
    state.queries["nfseProfiles:get"] = null;
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Perfil de emissão ausente/);
  });
});

const view = {
  id: "i1",
  organizationId: "org",
  projectId: "project",
  companyId: "company",
  environment: "sandbox",
  operationId: "op",
  operationState: "reconciling",
  state: "processing",
  transport: "simulated",
  target: "sefin-nacional",
  series: "1",
  number: 7,
  dpsId: "DPS355030821122233300018100001000000000000007",
  issueDate: "2026-10-05",
  competence: "2026-10",
  market: "export",
  amount: { currency: "USD", value: "1000.00" },
  serviceBrl: "5432.10",
  exchange: {
    currency: "USD",
    amount: "1000.00",
    rate: "5.432100",
    quoteDate: "2026-10-02",
    brlAmount: "5432.10",
    source: "simulated",
    frozenAt: NOW,
  },
  accessKey: null,
  nfseNumber: null,
  documentId: null,
  code: "TRANSPORT_UNCERTAIN",
  rejections: [],
  artifacts: [],
  cancellation: null,
  version: 3,
  createdAt: NOW,
  updatedAt: NOW,
};
const snapshot = {
  acceptedAt: NOW,
  dhEmi: "2026-10-05T12:00:00-03:00",
  dCompet: "2026-10-05",
  issuer: {
    cnpj: "11222333000181",
    name: "Prestador Sintético",
    email: "fiscal@prestador.example",
  },
  profileVersion: 1,
  municipalityCode: "3550308",
  activity: { code: "licenca", label: "Licenciamento sintético", cTribNac: "010501", nbs: null },
  taker: {
    kind: "foreign",
    nif: null,
    nifAbsence: 2,
    name: "Example LLC",
    email: null,
    address: {
      country: "US",
      city: "San Francisco",
      postalCode: "94105",
      state: "CA",
      street: "Market St",
      number: "548",
      district: "SoMa",
    },
  },
  description: "Software subscription",
  iss: { rate: null, withheld: false, amount: null },
};

describe("situação e detalhe", () => {
  it("só diz autorizada depois da resposta registrada", () => {
    expect(
      issuanceStatus({ state: "processing", operationState: "reconciling", cancellation: null }),
    ).toMatchObject({ label: "Em reconciliação" });
    expect(
      issuanceStatus({ state: "processing", operationState: "queued", cancellation: null }).label,
    ).toBe("Aceita, na fila");
    expect(
      issuanceStatus({ state: "processing", operationState: "running", cancellation: null }).label,
    ).toBe("Transmitindo");
    expect(
      issuanceStatus({
        state: "authorized",
        operationState: "succeeded",
        cancellation: { state: "processing" } as never,
      }).label,
    ).toBe("Cancelamento em andamento");
  });

  it("mostra reconciliação honesta, PTAX usada e o aviso de simulação", () => {
    state.queries["issuanceConsole:detail"] = {
      issuance: view,
      snapshot,
      events: [
        { kind: "accepted", code: null, at: NOW },
        { kind: "exchange_frozen", code: null, at: NOW },
        { kind: "submitted", code: null, at: NOW },
      ],
      canCancel: false,
    };
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    expect(screen.getAllByText("Em reconciliação").length).toBeGreaterThan(0);
    expect(screen.queryByText("Autorizada")).toBeNull();
    expect(screen.getByText(/não emita de novo/)).toBeTruthy();
    expect(screen.getByText(/5,432100 BRL por USD \(cotação simulada do sandbox\)/)).toBeTruthy();
    expect(screen.getByText("02/10/2026")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/sem validade fiscal/);
    expect(screen.getByText("Não exigência do NIF")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cancelar NFS-e/ })).toBeNull();
  });

  it("mostra o histórico com segundos, na ordem dos eventos do mesmo minuto", () => {
    state.queries["issuanceConsole:detail"] = {
      issuance: view,
      snapshot,
      events: [
        { kind: "accepted", code: null, at: NOW + 3_000 },
        { kind: "exchange_frozen", code: null, at: NOW + 4_000 },
        { kind: "submitted", code: null, at: NOW + 41_000 },
      ],
      canCancel: false,
    };
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    const times = [
      ...document.querySelectorAll("#issuance-history-section .fiscal-timeline li > span"),
    ].map((time) => time.textContent);
    expect(times).toEqual([
      formatDateTimeSeconds(NOW + 3_000),
      formatDateTimeSeconds(NOW + 4_000),
      formatDateTimeSeconds(NOW + 41_000),
    ]);
    expect(times.map((time) => time!.slice(-3))).toEqual([":03", ":04", ":41"]);
  });

  it("nomeia o destino de Campinas", () => {
    state.queries["issuanceConsole:detail"] = {
      issuance: { ...view, target: "campinas-adn" },
      snapshot,
      events: [],
      canCancel: false,
    };
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    expect(screen.getByText("Campinas (IMA, padrão nacional)")).toBeTruthy();
  });

  it("oferece o DANFSe como PDF e os demais artefatos como XML", async () => {
    const artifact = (id: string, kind: string, signed: boolean) => ({
      id,
      kind,
      signed,
      size: 10,
      sha256: "a".repeat(64),
      createdAt: NOW,
    });
    state.queries["issuanceConsole:detail"] = {
      issuance: {
        ...view,
        artifacts: [artifact("a1", "dps", true), artifact("a2", "danfse", false)],
      },
      snapshot,
      events: [],
      canCancel: false,
    };
    state.mutate.mockResolvedValue({ token: "t", expiresAt: NOW });
    const fetchMock = vi.fn(async () => new Response("conteúdo"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = () => "blob:artefato";
        static override revokeObjectURL = () => {};
      },
    );
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    try {
      render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
      const rows = screen.getAllByRole("listitem").filter((row) => row.querySelector("button"));
      const dps = rows.find((row) => row.textContent?.includes("DPS"))!;
      const danfse = rows.find((row) => row.textContent?.includes("DANFSe (PDF)"))!;
      expect(dps.querySelector("button")!.textContent).toBe("Baixar XML");
      expect(danfse.querySelector("button")!.textContent).toBe("Baixar PDF");
      await act(async () => {
        fireEvent.click(danfse.querySelector("button")!);
      });
      expect(state.mutate).toHaveBeenCalledWith(
        "issuanceConsole:artifactTicket",
        expect.objectContaining({ issuanceId: "i1", artifactId: "a2" }),
      );
      expect(names).toEqual(["danfse-1-7.pdf"]);
      expect(danfse.textContent).toMatch(/Download de danfse-1-7\.pdf iniciado/);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
      await act(async () => {
        fireEvent.click(danfse.querySelector("button")!);
      });
      expect(screen.getByRole("alert").textContent).toMatch(
        /^PDF indisponível ou seu acesso mudou\./,
      );
      // A new attempt asks for a new ticket and downloads.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
      });
      expect(names).toEqual(["danfse-1-7.pdf", "danfse-1-7.pdf"]);
      expect(
        state.mutate.mock.calls.filter(([name]) => name === "issuanceConsole:artifactTicket"),
      ).toHaveLength(3);
      await act(async () => {
        fireEvent.click(dps.querySelector("button")!);
      });
      expect(names).toEqual(["danfse-1-7.pdf", "danfse-1-7.pdf", "dps-1-7.xml"]);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("cancela com motivo e a mesma tentativa reaproveita a chave", async () => {
    state.queries["issuanceConsole:detail"] = {
      issuance: {
        ...view,
        state: "authorized",
        operationState: "succeeded",
        market: "domestic",
        amount: { currency: "BRL", value: "1000.00" },
        exchange: null,
        nfseNumber: "7",
        accessKey: "35503082211222333000181000000000000726100000000007",
        code: null,
      },
      snapshot,
      events: [],
      canCancel: true,
    };
    state.mutate.mockRejectedValueOnce(new Error("network"));
    state.mutate.mockResolvedValueOnce({ reused: false, issuanceId: "i1" });
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar NFS-e" }));
    const form = screen.getByRole("button", { name: "Confirmar cancelamento" }).closest("form")!;
    fireEvent.change(screen.getByLabelText("Justificativa"), { target: { value: "curto" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/15 a 255/);
    fireEvent.change(screen.getByLabelText("Justificativa"), {
      target: { value: "Serviço emitido em duplicidade" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    const calls = state.mutate.mock.calls;
    expect(calls[0]![0]).toBe("issuanceConsole:cancel");
    expect(calls[0]![1]).toMatchObject({
      reasonCode: "1",
      reason: "Serviço emitido em duplicidade",
    });
    expect((calls[1]![1] as { idempotencyKey: string }).idempotencyKey).toBe(
      (calls[0]![1] as { idempotencyKey: string }).idempotencyKey,
    );
  });
});

describe("clareza do formulário", () => {
  const campinas = {
    opSimpNac: 3 as const,
    municipalityCode: "3509502",
    activities: [activity],
    version: 1,
  };
  const form = (transport: "simulated" | "producao-restrita" = "simulated") =>
    render(
      <IssuanceForm scope={scope} transport={transport} onCreated={() => {}} onCancel={() => {}} />,
    );

  it("só oferece 'Selecione' na atividade enquanto nenhuma foi escolhida", async () => {
    const options = () =>
      [...(screen.getByLabelText("Atividade do perfil") as HTMLSelectElement).options].map(
        (option) => option.textContent,
      );
    // A single activity comes pre-filled, so the empty placeholder is not offered.
    state.queries["nfseProfiles:get"] = campinas;
    form();
    expect((screen.getByLabelText("Atividade do perfil") as HTMLSelectElement).value).toBe(
      "licenca",
    );
    expect(options()).toEqual(["Licenciamento sintético · licenca"]);
    cleanup();
    // With two activities nothing is chosen yet: the placeholder stays until a choice.
    const other = { ...activity, code: "suporte", label: "Suporte sintético" };
    state.queries["nfseProfiles:get"] = { ...campinas, activities: [activity, other] };
    form();
    expect(options()).toEqual([
      "Selecione",
      "Licenciamento sintético · licenca",
      "Suporte sintético · suporte",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pedir emissão/ }));
    });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Atividade do perfil").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(screen.getByLabelText("Atividade do perfil"), {
      target: { value: "suporte" },
    });
    expect(options()).toEqual(["Licenciamento sintético · licenca", "Suporte sintético · suporte"]);
  });

  it("prevê o canal pela mesma regra do servidor", () => {
    expect(routeOf(valid(), campinas)).toMatchObject({ kind: "nacional", target: "campinas-adn" });
    expect(routeOf(valid({ issueDate: "2026-11-03" }), campinas)).toMatchObject({
      target: "sefin-nacional",
    });
    expect(routeOf(valid({ issueDate: "2026-09-25" }), campinas)).toMatchObject({
      kind: "unsupported",
      code: "ROUTE_ABRASF",
    });
    expect(routeOf(valid({ activityCode: "" }), campinas)).toBeNull();
  });

  it("mostra transporte e canal previsto antes de pedir", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.queries["nfseProfiles:get"] = campinas;
    form("producao-restrita");
    const destination = screen.getByRole("region", { name: "Para onde a nota vai" });
    expect(destination.textContent).toMatch(/Produção restrita do fisco \(homologação\)/);
    expect(destination.textContent).toMatch(
      /Campinas \(IMA, padrão nacional\), pela regra vigente em 08\/10\/2026/,
    );
    expect(screen.getByRole("note").textContent).toMatch(/fisco de verdade/);
  });

  it("esconde a alíquota do Simples sem retenção em Campinas e a pede na retenção", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.queries["nfseProfiles:get"] = campinas;
    form();
    expect(screen.queryByLabelText("Alíquota do ISS (%)")).toBeNull();
    expect(screen.getByText(/sem retenção não informa alíquota na DPS/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CPF ou CNPJ do tomador"), {
      target: { value: national.document },
    });
    fireEvent.click(screen.getByLabelText("ISS retido pelo tomador"));
    expect((screen.getByLabelText("Alíquota do ISS (%)") as HTMLInputElement).required).toBe(true);
  });

  it("pré-visualiza o valor na moeda e explica a PTAX junto ao campo", () => {
    expect(valuePreview(valid({ value: "1000", currency: "USD" }))).toBe(
      "Valor na nota: USD\u00a01.000,00",
    );
    expect(valuePreview(valid({ value: "1,00" }))).toBe("Valor na nota: R$ 1,00");
    expect(valuePreview(valid({ value: "1,001" }))).toMatch(/inválido/);
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    form();
    fireEvent.click(screen.getByLabelText(/Exportação de serviço/));
    fireEvent.change(screen.getByLabelText("Valor do serviço"), { target: { value: "1000" } });
    const described = screen
      .getByLabelText("Valor do serviço")
      .getAttribute("aria-describedby")!
      .split(" ");
    expect(document.getElementById(described[0]!)!.textContent).toBe(
      "Valor na nota: USD\u00a01.000,00",
    );
    expect(document.getElementById(described[1]!)!.textContent).toMatch(
      /PTAX de venda do dia útil anterior/,
    );
  });

  it("torna explícita a escolha entre NIF e motivo da ausência", async () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i3" });
    form();
    fireEvent.click(screen.getByLabelText(/Exportação de serviço/));
    expect(screen.queryByLabelText("NIF do tomador")).toBeNull();
    expect(screen.queryByLabelText("Motivo da ausência do NIF")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Tem NIF" }));
    fireEvent.change(screen.getByLabelText("NIF do tomador"), { target: { value: "12-3456789" } });
    expect(screen.queryByLabelText("Motivo da ausência do NIF")).toBeNull();
    // Switching drops the NIF typed before: the server takes one or the other.
    fireEvent.click(screen.getByRole("radio", { name: "Não tem NIF" }));
    expect(screen.queryByLabelText("NIF do tomador")).toBeNull();
    const element = screen.getByRole("button", { name: /Pedir emissão/ }).closest("form")!;
    await act(async () => {
      fireEvent.submit(element);
    });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("E-mail do prestador"));
    expect(document.getElementById("issuance-submit-reason")!.textContent).toMatch(
      /Motivo da ausência do NIF/,
    );
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set("E-mail do prestador", "fiscal@prestador.example");
    set("Descrição do serviço", "Software subscription");
    set("Motivo da ausência do NIF", "2");
    set("Nome ou razão social", "Example LLC");
    set("País (código ISO)", "US");
    set("Cidade", "San Francisco");
    set("Código postal", "94105");
    set("Estado, província ou região", "CA");
    set("Logradouro", "Market St");
    set("Número", "548");
    set("Bairro", "N/A");
    set("Valor do serviço", "1000");
    await act(async () => {
      fireEvent.submit(element);
    });
    const taker = (state.mutate.mock.calls[0]![1] as { input: { taker: object } }).input.taker;
    expect(taker).toMatchObject({ kind: "foreign", nifAbsence: 2 });
    expect(taker).not.toHaveProperty("nif");
  });

  it("marca a descrição como obrigatória e usa o e-mail do perfil como exemplo", () => {
    state.queries["nfseProfiles:get"] = {
      ...profile(1),
      issuerEmail: "perfil@prestador.example",
      version: 1,
    };
    form();
    const description = screen.getByLabelText("Descrição do serviço") as HTMLTextAreaElement;
    expect(description.required).toBe(true);
    expect(document.getElementById("issuance-description-help")!.textContent).toMatch(
      /^Obrigatória: vai na DPS/,
    );
    expect(screen.getByLabelText("E-mail do prestador").getAttribute("placeholder")).toBe(
      "perfil@prestador.example",
    );
  });
});

describe("marcadores do simulador", () => {
  const authorized = (transport: "simulated" | "producao-restrita") => ({
    issuance: {
      ...view,
      transport,
      state: "authorized",
      operationState: "succeeded",
      market: "domestic",
      amount: { currency: "BRL", value: "1000.00" },
      exchange: null,
      nfseNumber: "7",
      accessKey: "35503082211222333000181000000000000726100000000007",
      code: null,
    },
    snapshot,
    events: [],
    canCancel: true,
  });

  it("aparecem como dica do simulador só no transporte simulado", () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    const help = document.getElementById("issuance-description-help")!;
    expect(help.querySelector(".fiscal-simulator-tip")!.textContent).toMatch(
      /^Dica do simulador: \[simular:rejeicao\] ou \[simular:timeout\]/,
    );
    cleanup();
    render(
      <IssuanceForm
        scope={scope}
        transport="producao-restrita"
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.body.textContent).not.toContain("[simular:");
    expect(screen.queryByText("Dica do simulador:")).toBeNull();
  });

  it("no cancelamento, também somem fora do simulador", () => {
    state.queries["issuanceConsole:detail"] = authorized("producao-restrita");
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar NFS-e" }));
    expect(document.getElementById("cancel-reason-help")!.textContent).not.toContain("[simular:");
    cleanup();
    state.queries["issuanceConsole:detail"] = authorized("simulated");
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar NFS-e" }));
    expect(document.getElementById("cancel-reason-help")!.textContent).toMatch(
      /Dica do simulador: \[simular:rejeicao\] na justificativa/,
    );
  });
});

describe("ação disponível e rejeição", () => {
  it("só oferece cancelar a nota autorizada a quem pode", () => {
    const base = { operationState: "succeeded", cancellation: null } as const;
    expect(issuanceAction({ ...base, state: "authorized" }, true).cancel).toBe(true);
    expect(issuanceAction({ ...base, state: "authorized" }, false).label).toMatch(/Operador/);
    expect(issuanceAction({ ...base, state: "rejected" }, true).cancel).toBe(false);
    expect(issuanceAction({ ...base, state: "cancelled" }, true).cancel).toBe(false);
    expect(
      issuanceAction(
        { state: "processing", operationState: "reconciling", cancellation: null },
        true,
      ).label,
    ).toMatch(/aguarde a resposta do fisco/);
  });

  it("mostra código e mensagem da rejeição na situação, sem sugerir sucesso", () => {
    const message = `Arquivo em desacordo com o XML Schema: ${"TCInfDPS/IBSCBS/gIBSCBS ".repeat(20).trim()}`;
    state.queries["issuanceConsole:detail"] = {
      issuance: {
        ...view,
        state: "rejected",
        operationState: "succeeded",
        target: "campinas-adn",
        transport: "producao-restrita",
        code: "ADN_REJECTED",
        rejections: [{ code: "L9999", message }],
      },
      snapshot,
      events: [],
      canCancel: false,
    };
    render(<IssuanceDetail scope={scope} issuanceId="i1" onBack={() => {}} />);
    const situation = screen.getByRole("region", { name: "Situação" });
    // The card title says "Situação" once; its first row names the state, not the title again.
    const terms = [...situation.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms[0]).toBe("Estado");
    expect(terms).not.toContain("Situação");
    expect(situation.textContent).toMatch(/Rejeitada pelo fisco/);
    expect(situation.textContent).toMatch(/L9999/);
    expect(situation.textContent).toContain(message);
    expect(situation.textContent).toMatch(/corrija os dados e peça de novo/);
    // Without the role to issue, no correction is offered.
    expect(screen.queryByRole("button", { name: "Corrigir e emitir de novo" })).toBeNull();
    expect(situation.textContent).toMatch(/Campinas \(IMA, padrão nacional\)/);
    expect(situation.textContent).toMatch(/Produção restrita do fisco/);
    expect(screen.queryByText("Autorizada")).toBeNull();
    expect(screen.getByText("Não emitida: a DPS foi rejeitada")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Seções da emissão" })).toBeTruthy();
  });
});

describe("fluxo do detalhe e do formulário", () => {
  const rejected = {
    issuance: {
      ...view,
      state: "rejected",
      operationState: "succeeded",
      code: "ADN_REJECTED",
      rejections: [{ code: "E0310", message: "Município do tomador inexistente" }],
    },
    snapshot,
    events: [],
    canCancel: false,
    origin: { kind: "integration", integration: "ERP sintético" },
  };

  it("abre como página: título próprio, origem e referência da operação com link", () => {
    state.queries["issuanceConsole:detail"] = rejected;
    render(<IssuanceDetail scope={scope} issuanceId="i1" companyName="Prestador Sintético" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("DPS 7");
    expect(screen.getByRole("heading", { level: 2, name: "Situação" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByText("Origem: Integração ERP sintético")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Abrir em Operação e suporte" });
    expect(link.getAttribute("href")).toBe("/app/$organizationSlug/operations?ref=op");
    expect(screen.getByRole("button", { name: "Copiar referência" })).toBeTruthy();
  });

  it("resume tomador, datas e valor no topo e põe o DANFSe ao lado", () => {
    state.queries["issuanceConsole:detail"] = {
      issuance: {
        ...view,
        artifacts: [
          {
            id: "a2",
            kind: "danfse",
            signed: false,
            size: 10,
            sha256: "a".repeat(64),
            createdAt: NOW,
          },
        ],
      },
      snapshot,
      events: [],
      canCancel: false,
    };
    render(<IssuanceDetail scope={scope} issuanceId="i1" />);
    const facts = document.querySelector(".fiscal-facts") as HTMLElement;
    expect(within(facts).getByText("Tomador").nextElementSibling?.textContent).toBe("Example LLC");
    expect(within(facts).getByText("Valor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Baixar DANFSe" })).toBeTruthy();
    // The one in Arquivos stays, with the format.
    expect(screen.getByRole("button", { name: "Baixar PDF" })).toBeTruthy();
  });

  it("oferece corrigir uma rejeitada a quem emite, de qualquer origem", () => {
    state.queries["issuanceConsole:detail"] = rejected;
    const onCorrect = vi.fn();
    render(<IssuanceDetail scope={scope} issuanceId="i1" canIssue onCorrect={onCorrect} />);
    fireEvent.click(screen.getByRole("button", { name: "Corrigir e emitir de novo" }));
    expect(onCorrect).toHaveBeenCalledWith("i1", "DPS série 1 nº 7");
  });

  it("preenche o formulário com o pedido rejeitado, com data de hoje e o e-mail do perfil", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.queries["nfseProfiles:get"] = {
      ...profile(1),
      issuerEmail: "fiscal@prestador.example",
      version: 1,
    };
    state.queries["issuanceConsole:resubmission"] = {
      activityCode: "licenca",
      competence: "2026-09",
      issuerEmail: "fiscal@prestador.example",
      market: "domestic",
      taker: {
        kind: "national",
        document: "11444777000161",
        name: "Tomador Sintético Ltda",
        address: {
          municipalityCode: "9999999",
          postalCode: "01001000",
          street: "Praça da Sé",
          number: "100",
          district: "Sé",
        },
      },
      description: "Licença de uso",
      amount: { currency: "BRL", value: "1500.25" },
      issRate: "2.5000",
      issWithheld: false,
    };
    state.mutate.mockResolvedValue({ reused: false, issuanceId: "i9" });
    render(
      <IssuanceForm
        scope={scope}
        transport="simulated"
        onCreated={() => {}}
        onCancel={() => {}}
        correction={{ issuanceId: "i1", label: "DPS série 1 nº 7" }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Corrigir e emitir de novo" })).toBeTruthy();
    expect(screen.getByText(/emissão rejeitada DPS série 1 nº 7/).textContent).toMatch(
      /outro número de DPS/,
    );
    expect((screen.getByLabelText("Valor do serviço") as HTMLInputElement).value).toBe("1500,25");
    expect((screen.getByLabelText("Alíquota do ISS (%)") as HTMLInputElement).value).toBe("2,5");
    expect((screen.getByLabelText("Data da emissão") as HTMLInputElement).value).toBe("2026-10-08");
    expect((screen.getByLabelText("E-mail do prestador") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Código IBGE do município"), {
      target: { value: "3550308" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: /Pedir emissão/ }).closest("form")!);
    });
    const [name, args] = state.mutate.mock.calls[0]!;
    expect(name).toBe("issuanceConsole:request");
    expect(args).toMatchObject({
      input: {
        competence: "2026-09",
        issueDate: "2026-10-08",
        amount: { currency: "BRL", value: "1500.25" },
        issRate: "2.5",
        taker: { address: { municipalityCode: "3550308" } },
      },
    });
    expect((args as { idempotencyKey: string }).idempotencyKey).toMatch(/^console-/);
  });

  it("chama de Descartar o botão que sai do formulário", () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    const onCancel = vi.fn();
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={onCancel} />,
    );
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("sem perfil, aponta a aba fiscal da empresa", () => {
    state.queries["nfseProfiles:get"] = null;
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    expect(
      screen.getByRole("link", { name: "Abrir a aba Fiscal da empresa" }).getAttribute("href"),
    ).toBe("/app/$organizationSlug/companies/$companyId?aba=fiscal");
  });

  it("sugere tomadores de emissões anteriores e preenche o escolhido", () => {
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    state.queries["issuanceConsole:recentTakers"] = [
      {
        lastUsedAt: NOW,
        taker: {
          kind: "foreign",
          nifAbsence: 2,
          name: "Example LLC",
          address: {
            country: "US",
            city: "San Francisco",
            postalCode: "94105",
            state: "CA",
            street: "Market St",
            number: "548",
            district: "SoMa",
          },
        },
      },
    ];
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    const select = screen.getByLabelText("Tomador de emissões anteriores (opcional)");
    expect(select.textContent).toMatch(/Example LLC · sem NIF, US/);
    fireEvent.change(select, { target: { value: "0" } });
    expect((screen.getByLabelText(/Exportação de serviço/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Nome ou razão social") as HTMLInputElement).value).toBe(
      "Example LLC",
    );
    expect((screen.getByLabelText("Motivo da ausência do NIF") as HTMLSelectElement).value).toBe(
      "2",
    );
    expect((screen.getByLabelText("Moeda") as HTMLSelectElement).value).toBe("USD");
  });

  it("busca o município pelo nome e preenche o código IBGE", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    state.queries["nfseProfiles:get"] = { ...profile(1), version: 1 };
    const manifest = {
      dataset: "municipalities",
      version: "synthetic-v1",
      source: "Corpus sintético",
      sourceUrl: "https://example.invalid/references",
      sourceVersion: "synthetic-v1",
      retrievedAt: "2026-09-22T00:00:00Z",
      asOf: "2026-09-22",
      coverage: "intervals",
      sourceSha256: "0".repeat(64),
      contentSha256: "0".repeat(64),
      count: 2,
      termsUrl: "https://example.invalid/terms",
      redistribution: "synthetic",
      terms: "Dados sintéticos.",
    };
    const entry = (code: string, description: string, uf: string) => ({
      code,
      description,
      state: uf,
      validFrom: null,
      validTo: null,
      status: "validity_unknown",
    });
    state.queries["references:search"] = {
      manifest,
      date: "2026-10-08",
      page: [entry("3509502", "Campinas", "SP"), entry("5002704", "Campo Grande", "MS")],
      nextCursor: null,
    };
    render(
      <IssuanceForm scope={scope} transport="simulated" onCreated={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Buscar município pelo nome (opcional)"), {
      target: { value: "Camp" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.change(screen.getByLabelText("UF do município"), { target: { value: "SP" } });
    const results = screen.getByRole("list", { name: "Municípios encontrados" });
    expect(results.textContent).toBe("Campinas/SP · IBGE 3509502");
    fireEvent.click(screen.getByRole("button", { name: "Campinas/SP · IBGE 3509502" }));
    expect((screen.getByLabelText("Código IBGE do município") as HTMLInputElement).value).toBe(
      "3509502",
    );
  });
});
