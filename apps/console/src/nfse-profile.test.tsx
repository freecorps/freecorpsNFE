// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { NfseProfile } from "./nfse-profile";
import { ibsCbsNote, validateProfile } from "./nfse-profile-draft";
import type { IbsCbsRule } from "../../../packages/fiscal-nfse/src/ibsCbs";

const state = vi.hoisted(() => ({
  profile: undefined as Record<string, unknown> | null | undefined,
  sequences: [] as Array<Record<string, unknown>> | undefined,
  references: vi.fn((_args: Record<string, unknown>): unknown => undefined),
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
    const name = getFunctionName(fn);
    if (name === "nfseProfiles:sequences") return state.sequences;
    if (name === "references:search") return state.references(args);
    return state.profile;
  },
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    state.mutate(getFunctionName(fn), args),
}));
type Props = Parameters<typeof NfseProfile>[0];
const org = { id: "org", slug: "org" } as unknown as Props["org"];
const company = (manage: boolean) =>
  ({
    id: "company",
    kind: "declared",
    address: { state: "SP" },
    capabilities: { read: true, manage, operateDocuments: manage },
  }) as unknown as Props["company"];
const saved = {
  municipalityCode: "3550308",
  opSimpNac: 3,
  regApTribSN: 1,
  regEspTrib: 0,
  dpsSeries: "1",
  activities: [
    {
      code: "licenca",
      label: "Licenciamento sintético",
      cnae: "6202300",
      lc116Item: "01.05",
      cTribNac: "010501",
    },
  ],
  version: 2,
  updatedAt: 1,
};
const manifest = {
  dataset: "municipalities",
  version: "sintetico-1",
  source: "Corpus sintético",
  sourceUrl: "https://example.invalid/municipios",
  sourceVersion: "sintetico-1",
  retrievedAt: "2026-10-09T00:00:00Z",
  asOf: "2026-10-09",
  coverage: "intervals",
  sourceSha256: "0".repeat(64),
  contentSha256: "0".repeat(64),
  count: 2,
  termsUrl: "https://example.invalid/termos",
  redistribution: "synthetic",
  terms: "Dados de teste.",
};
const entry = (code: string, description: string, state: string) => ({
  code,
  description,
  state,
  validFrom: "2000-01-01",
  validTo: null,
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  state.profile = undefined;
  state.sequences = [];
});
const submit = (name: RegExp | string) =>
  act(async () => {
    fireEvent.submit(screen.getByRole("button", { name }).closest("form")!);
  });
async function openForm(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}
const flushFrames = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

it("mostra carregamento e deixa claro que salvar não emite e onde fica a emissão em sandbox", () => {
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  expect(screen.getByRole("status").textContent).toContain("Carregando perfil de emissão");
  const note = screen.getByRole("note").textContent;
  expect(note).toContain("salvar não emite");
  expect(note).toContain("sem validade fiscal");
  expect(note).toContain("Produção fica desligada");
});

it("sem perfil, quem só lê vê o estado vazio, nenhum formulário e o passo seguinte explicado", () => {
  state.profile = null;
  render(<NfseProfile org={org} company={company(false)} contextKey="k" />);
  expect(screen.getByText(/Um proprietário ou administrador pode criá-lo/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /perfil/ })).toBeNull();
  expect(screen.getByText(/Somente leitura/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "2. Numeração da DPS" })).toBeTruthy();
  expect(screen.getByText(/Disponível depois de salvar o perfil/).textContent).toContain(
    "trava na primeira emissão",
  );
});

it("quem só lê vê o resumo do perfil salvo, sem campos editáveis", () => {
  state.profile = saved;
  render(<NfseProfile org={org} company={company(false)} contextKey="k" />);
  expect(screen.getByText("Licenciamento sintético")).toBeTruthy();
  expect(screen.getByText(/Optante ME\/EPP/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Editar perfil" })).toBeNull();
  // Each series says which channel uses it.
  expect(screen.getByText("Sefin Nacional, o canal padrão.")).toBeTruthy();
  expect(screen.getByText(/^Só no canal de Campinas \(IMA\)/).textContent).toContain(
    "entre 10001 e 49999",
  );
});

it("no formulário, cada série diz em qual canal é usada", async () => {
  state.profile = saved;
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Editar perfil");
  const help = (label: string | RegExp) =>
    document.getElementById(screen.getByLabelText(label).getAttribute("aria-describedby")!)!
      .textContent;
  expect(help("Série da DPS")).toMatch(/^Usada nas emissões pela Sefin Nacional, o canal padrão\./);
  expect(help(/^Série da DPS em Campinas/)).toMatch(
    /^Usada só quando a emissão vai ao canal de Campinas \(IMA\)/,
  );
});

it("o gestor abre o formulário pelo resumo; sem dados, cada campo diz o que falta e nada sai", async () => {
  state.profile = null;
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  expect(screen.queryByLabelText("Código IBGE do município")).toBeNull();
  await openForm("Criar perfil de emissão");
  const municipality = screen.getByLabelText("Código IBGE do município");
  expect(document.activeElement).toBe(municipality);
  await submit(/^Criar perfil$/);
  expect(state.mutate).not.toHaveBeenCalled();
  // Field error next to the field, linked by aria-describedby.
  expect(municipality.getAttribute("aria-invalid")).toBe("true");
  const describedBy = municipality.getAttribute("aria-describedby")!.split(" ");
  expect(describedBy).toContain("nfse-municipality-error");
  expect(document.getElementById("nfse-municipality-error")!.textContent).toBe(
    "Informe o código IBGE do município.",
  );
  // Summary on top, focused, with a link per field.
  const summary = screen.getByRole("alert");
  expect(document.activeElement).toBe(summary);
  expect(summary.textContent).toContain("O perfil não foi criado.");
  const link = screen.getByRole("link", { name: /Atividade 1, CNAE: Informe o CNAE/ });
  fireEvent.click(link);
  expect(document.activeElement).toBe(screen.getByLabelText("CNAE"));
});

it("o erro do servidor aponta o campo da atividade, não só o índice", async () => {
  state.profile = null;
  state.mutate.mockRejectedValueOnce(new ConvexError({ code: "DUPLICATE_ACTIVITY", activity: 0 }));
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Criar perfil de emissão");
  const fill = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fill("Código IBGE do município", "3550308");
  fill("Série da DPS", "1");
  fill("Código interno", "licenca");
  fill("Rótulo", "Licenciamento");
  fill("CNAE", "6202-3/00");
  fill("Item da LC 116", "01.05");
  fill("Código de tributação nacional", "010501");
  // The regime of the Simples only appears for ME/EPP.
  expect(screen.queryByLabelText("Regime de apuração no Simples Nacional")).toBeNull();
  await submit(/^Criar perfil$/);
  expect(state.mutate).toHaveBeenCalledWith(
    "nfseProfiles:save",
    expect.objectContaining({
      organizationId: "org",
      companyId: "company",
      expectedVersion: 0,
      municipalityCode: "3550308",
      opSimpNac: 1,
      dpsSeries: "1",
    }),
  );
  const args = state.mutate.mock.calls[0]![1] as Record<string, unknown>;
  expect(args).not.toHaveProperty("regApTribSN");
  expect(args).not.toHaveProperty("municipalRegistration");
  const code = screen.getByLabelText("Código interno");
  expect(code.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById("nfse-activity-0-code-error")!.textContent).toContain(
    "Atividade repetida",
  );
  expect(screen.getByRole("alert").textContent).toContain("Atividade 1, Código interno");
  expect(
    (screen.getByRole("button", { name: /^Criar perfil$/ }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("valida as regras do servidor em todos os campos de uma vez", () => {
  const errors = validateProfile(
    {
      municipalRegistration: "",
      issuerEmail: "sem-arroba",
      municipalityCode: "3304557",
      opSimpNac: 1,
      regApTribSN: 1,
      regEspTrib: 0,
      dpsSeries: "0",
      campinasDpsSeries: "5",
      activities: [
        {
          code: "a",
          label: "A",
          cnae: "6202300",
          lc116Item: "01.05",
          cTribNac: "010601",
          nbs: "",
          cTribMun: "",
          ibsCIndOp: "100501",
          ibsCst: "",
          ibsCClassTrib: "000001",
          description: "",
        },
      ],
    },
    "SP",
  );
  expect(errors).toEqual({
    "nfse-municipality": expect.stringContaining("município de SP"),
    "nfse-email": expect.stringContaining("e-mail"),
    "nfse-series": expect.stringContaining("não pode ser zero"),
    "nfse-campinas-series": expect.stringContaining("10001"),
    "nfse-activity-0-cTribNac": expect.stringContaining("começar pelo item"),
    "nfse-activity-0-ibsCst": "A classificação IBS/CBS exige os três campos.",
  });
});

it("o gestor edita o perfil existente com a versão esperada e volta ao resumo", async () => {
  state.profile = saved;
  state.mutate.mockResolvedValueOnce({ version: 2, changed: false });
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  expect(screen.queryByLabelText("Regime de apuração no Simples Nacional")).toBeNull();
  await openForm("Editar perfil");
  expect(screen.getByLabelText("Regime de apuração no Simples Nacional")).toBeTruthy();
  await submit(/Salvar perfil/);
  expect(state.mutate).toHaveBeenCalledWith(
    "nfseProfiles:save",
    expect.objectContaining({ expectedVersion: 2, regApTribSN: 1 }),
  );
  expect(screen.getByText("Nenhuma alteração para salvar.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Salvar perfil/ })).toBeNull();
  await flushFrames();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Editar perfil" }));
});

it("cancelar a edição descarta o rascunho e devolve o foco ao botão", async () => {
  state.profile = saved;
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Editar perfil");
  fireEvent.change(screen.getByLabelText("Série da DPS"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  await flushFrames();
  expect(screen.queryByLabelText("Série da DPS")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Editar perfil" }));
  expect(state.mutate).not.toHaveBeenCalled();
});

it("envia e-mail, série de Campinas, cTribMun e IBS/CBS só quando preenchidos", async () => {
  state.profile = {
    ...saved,
    issuerEmail: "fiscal@prestador.example",
    campinasDpsSeries: "10001",
    activities: [
      {
        ...saved.activities[0],
        cTribMun: "001",
        ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
      },
    ],
  };
  state.mutate.mockResolvedValueOnce({ version: 3, changed: true });
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Editar perfil");
  // An incomplete IBS/CBS group stays in the form and names the missing field.
  fireEvent.change(screen.getByLabelText("IBS/CBS: CST (opcional)"), { target: { value: "" } });
  await submit(/Salvar perfil/);
  expect(state.mutate).not.toHaveBeenCalled();
  expect(document.getElementById("nfse-activity-0-ibsCst-error")!.textContent).toContain(
    "três campos",
  );
  fireEvent.change(screen.getByLabelText("IBS/CBS: CST (opcional)"), { target: { value: "000" } });
  await submit(/Salvar perfil/);
  const args = state.mutate.mock.calls[0]![1] as {
    issuerEmail?: string;
    campinasDpsSeries?: string;
    activities: Array<Record<string, unknown>>;
  };
  expect(args.issuerEmail).toBe("fiscal@prestador.example");
  expect(args.campinasDpsSeries).toBe("10001");
  expect(args.activities[0]).toMatchObject({
    cTribMun: "001",
    ibsCbs: { cIndOp: "100501", cst: "000", cClassTrib: "000001" },
  });
  expect(screen.getByText(/Próximo passo: confira a numeração da DPS/)).toBeTruthy();
});

it("a nota do IBS/CBS sai da tabela do servidor, por regime e data", () => {
  expect(ibsCbsNote(1, "2026-10-23")).toEqual({
    requirement:
      "Para não optante, a emissão exige a classificação IBS/CBS a partir da competência 10/2026, ou a partir da competência 12/2026 nos subitens 1.03, 1.05, 1.09 e 16.01. No canal de Campinas, ela é sempre exigida.",
    export: "Exportação que já exige a classificação ainda não é emitida.",
  });
  // MEI and ME/EPP are the Simples: 2027, and no export refused before it.
  for (const opSimpNac of [2, 3] as const) {
    expect(ibsCbsNote(opSimpNac, "2026-12-31")).toEqual({
      requirement:
        "Para optante do Simples Nacional, a emissão exige a classificação IBS/CBS a partir da competência 01/2027. No canal de Campinas, ela é sempre exigida.",
      export: null,
    });
    expect(ibsCbsNote(opSimpNac, "2027-01-01").export).not.toBeNull();
  }
  expect(ibsCbsNote(1, "2026-09-30").export).toBeNull();
  // Another table, another text: dates and subitems come from the rules, not from the console.
  const rules: IbsCbsRule[] = [
    { id: "x", regimes: ["nao-optante"], subitens: ["7.02"], since: "2027-03-15", source: "s" },
    { id: "y", regimes: ["nao-optante"], since: "2027-02-01", source: "s" },
  ];
  expect(ibsCbsNote(1, "2026-10-23", rules)).toEqual({
    requirement:
      "Para não optante, a emissão exige a classificação IBS/CBS a partir da competência 02/2027, ou a partir de 15/03/2027 no subitem 7.02. No canal de Campinas, ela é sempre exigida.",
    export: null,
  });
});

it("o formulário mostra a nota do regime escolhido e o aviso da exportação só quando vale", async () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 23, 15), toFake: ["Date"] });
  state.profile = saved;
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Editar perfil");
  // The saved profile is ME/EPP: nothing refused in 2026.
  expect(screen.getByText(/optante do Simples Nacional.*competência 01\/2027/)).toBeTruthy();
  expect(screen.queryByText(/Exportação que já exige/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Situação no Simples Nacional"), {
    target: { value: "1" },
  });
  expect(screen.getByText(/Para não optante.*competência 10\/2026/)).toBeTruthy();
  expect(
    screen.getByText("Exportação que já exige a classificação ainda não é emitida."),
  ).toBeTruthy();
  // The form only informs: the classification stays optional in the profile.
  expect(screen.getByLabelText("IBS/CBS: indicador da operação (opcional)")).toBeTruthy();
});

it("remover uma atividade pede confirmação e devolve o foco", async () => {
  state.profile = {
    ...saved,
    activities: [saved.activities[0], { ...saved.activities[0], code: "outra", cnae: "6201501" }],
  };
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Editar perfil");
  expect(screen.getAllByRole("group", { name: /Atividade/ })).toHaveLength(2);
  // A click focuses the button in the browser; jsdom does not.
  screen.getByRole("button", { name: "Remover atividade 2" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Remover atividade 2" }));
  await flushFrames();
  const dialog = screen.getByRole("alertdialog", { name: "Remover a atividade 2 do formulário?" });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancelar" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await flushFrames();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remover atividade 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Remover atividade 2" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirmar remoção" }));
  });
  await flushFrames();
  expect(screen.queryByText("Atividade 2")).toBeNull();
  expect(document.activeElement?.textContent).toBe("Atividade 1");
});

it("busca o município pelo nome, só da UF da empresa, e mostra o nome do código", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  state.profile = null;
  state.references.mockImplementation((args) =>
    args.code
      ? {
          manifest,
          date: "2026-10-09",
          status: "valid",
          entry: entry("3509502", "Campinas", "SP"),
        }
      : {
          manifest,
          date: "2026-10-09",
          page: [
            { ...entry("3509502", "Campinas", "SP"), status: "valid" },
            { ...entry("2502805", "Campina Grande", "PB"), status: "valid" },
          ],
          nextCursor: null,
        },
  );
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Criar perfil de emissão");
  fireEvent.change(screen.getByLabelText("Buscar município pelo nome"), {
    target: { value: "Campi" },
  });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(state.references).toHaveBeenCalledWith(
    expect.objectContaining({ dataset: "municipalities", q: "Campi", companyId: "company" }),
  );
  expect(screen.queryByRole("button", { name: /Campina Grande/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Campinas/SP · 3509502" }));
  expect((screen.getByLabelText("Código IBGE do município") as HTMLInputElement).value).toBe(
    "3509502",
  );
  expect(screen.getByText(/Município: Campinas\/SP/)).toBeTruthy();
});

it("sem a tabela de municípios, o código continua editável e o motivo aparece", async () => {
  state.profile = null;
  state.references.mockImplementation(() => {
    throw new ConvexError({ code: "REFERENCE_UNAVAILABLE" });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  await openForm("Criar perfil de emissão");
  fireEvent.change(screen.getByLabelText("Código IBGE do município"), {
    target: { value: "3550308" },
  });
  expect(screen.getByText(/Tabela de municípios indisponível agora/)).toBeTruthy();
  expect(screen.getByLabelText("Código IBGE do município")).toBeTruthy();
});

it("mostra a numeração, explica a trava e define o número inicial só nas séries livres", async () => {
  state.profile = saved;
  state.sequences = [
    { environment: "sandbox", series: "1", start: 1, next: 4, locked: true, startSetAt: null },
    { environment: "production", series: "1", start: 1, next: 1, locked: false, startSetAt: null },
  ];
  state.mutate.mockRejectedValueOnce(new ConvexError({ code: "DPS_START_LOCKED" }));
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  // The description does not promise number 1 when a row may start elsewhere.
  const card = screen.getByRole("region", { name: "2. Numeração da DPS" });
  expect(card.textContent).toContain("Ela começa no número 1 ou no que você definir");
  expect(card.textContent).not.toContain("salvo se você definir outro");
  expect(screen.getByText("Começa em 1 · próximo número 4")).toBeTruthy();
  expect(screen.getByText("Numeração em uso")).toBeTruthy();
  expect(screen.getByText(/Travado: a plataforma já reservou/)).toBeTruthy();
  expect(screen.getByText(/Pode mudar até a primeira emissão/)).toBeTruthy();
  const select = screen.getByLabelText("Série e ambiente") as HTMLSelectElement;
  expect([...select.options].map((option) => option.textContent)).toEqual(["Série 1 · Produção"]);
  // The locked series is missing from the select, and the select says why.
  expect(select.getAttribute("aria-describedby")).toBe("nfse-start-series-help");
  expect(document.getElementById("nfse-start-series-help")!.textContent).toBe(
    "Séries com numeração em uso não aparecem aqui: o número inicial delas já travou.",
  );
  const input = screen.getByLabelText("Número inicial");
  fireEvent.change(input, { target: { value: "0" } });
  await submit("Definir número inicial");
  expect(state.mutate).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById("nfse-start-number-error")!.textContent).toContain(
    "número inteiro",
  );
  fireEvent.change(input, { target: { value: "120" } });
  await submit("Definir número inicial");
  expect(state.mutate).toHaveBeenCalledWith("nfseProfiles:setDpsStart", {
    organizationId: "org",
    companyId: "company",
    environment: "production",
    series: "1",
    start: 120,
  });
  expect(screen.getByRole("alert").textContent).toContain("não muda mais");
});

it("com todas as séries travadas, o gestor vê o motivo em vez de um formulário", () => {
  state.profile = saved;
  state.sequences = [
    { environment: "sandbox", series: "1", start: 1, next: 4, locked: true, startSetAt: null },
  ];
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  expect(screen.queryByLabelText("Número inicial")).toBeNull();
  expect(screen.getByText(/o número inicial não muda mais/)).toBeTruthy();
});

it("quem só lê vê a numeração sem o formulário de número inicial", () => {
  state.profile = saved;
  state.sequences = [
    { environment: "sandbox", series: "1", start: 1, next: 1, locked: false, startSetAt: null },
  ];
  render(<NfseProfile org={org} company={company(false)} contextKey="k" />);
  expect(screen.getByText(/Começa em 1 · próximo número 1/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Definir número inicial" })).toBeNull();
  expect(screen.getByText(/Somente proprietários e administradores definem/)).toBeTruthy();
});

it("o gestor vê formulário e numeração sem chaves repetidas no React", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  state.profile = saved;
  state.sequences = [
    { environment: "sandbox", series: "1", start: 1, next: 1, locked: false, startSetAt: null },
  ];
  render(<NfseProfile org={org} company={company(true)} contextKey="k" />);
  expect(screen.getByText(/Numeração da DPS/)).toBeTruthy();
  // With no locked series, nothing is missing from the select and no help is shown.
  expect(screen.getByLabelText("Série e ambiente").getAttribute("aria-describedby")).toBeNull();
  const logged = error.mock.calls.flat().join(" ");
  error.mockRestore();
  expect(logged).not.toMatch(/same key/);
});
