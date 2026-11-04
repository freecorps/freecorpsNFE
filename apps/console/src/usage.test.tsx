// @vitest-environment jsdom
// Uso e limites (#429, review of #471): the balance of the environment chosen in the shell, a
// reached limit of the other one said above it, bytes in binary units with the exact number in "Critério técnico", plurals in
// pt-BR, the number and the bar counting the same units, and an empty bar at zero.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import type { Organization } from "./organizations";
import { Usage } from "./usage";

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  /** The arguments of each overview subscription, in order. */
  args: [] as unknown[],
  /** The environment chosen in the shell. */
  environment: "sandbox" as "sandbox" | "production",
}));
vi.mock("./product-environment", () => ({
  useProductEnvironment: () => ({
    environment: state.environment,
    offered: ["sandbox", "production"],
    choose: () => undefined,
  }),
}));
vi.mock("./convex-query", () => ({
  useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (getFunctionName(fn) === "usage:overview") state.args.push(args);
    return state.queries[getFunctionName(fn)];
  },
}));
afterEach(() => {
  cleanup();
  state.queries = {};
  state.args = [];
  state.environment = "sandbox";
});
/** The same overview, seen from the other environment of the shell. */
function inEnvironment(environment: "sandbox" | "production") {
  cleanup();
  state.environment = environment;
  render(<Usage org={org} contextKey="test" />);
}

const org = { id: "org", slug: "equipe", name: "Equipe", role: "owner" } as unknown as Organization;
const metrics = [
  "imports",
  "documents",
  "captures",
  "registry",
  "bytes",
  "deliveries",
  "attempts",
  "issuances",
] as const;
type Totals = Partial<Record<(typeof metrics)[number], [number, number]>>;
const rows = (totals: Totals) =>
  metrics.map((metric) => {
    const [committed, reserved] = totals[metric] ?? [0, 0];
    const used = committed + reserved > 0;
    return {
      metric,
      committed,
      reserved,
      updatedAt: used ? Date.UTC(2026, 9, 25, 18) : null,
      startedAt: used ? Date.UTC(2026, 9, 1) : null,
    };
  });
const plan = {
  name: "Plano assistido de teste",
  startsAt: Date.UTC(2026, 0, 1),
  endsAt: Date.UTC(2027, 0, 1) as number | null,
  limits: { imports: 5, captures: 1, registry: 1, bytes: 1048576, deliveries: 1 } as Record<
    "imports" | "captures" | "registry" | "bytes" | "deliveries",
    number | null
  > & { notes?: number },
  concurrency: 2,
  version: 1,
};
const october = { key: "2026-10", startsAt: Date.UTC(2026, 9, 1), endsAt: Date.UTC(2026, 10, 1) };
const september = { key: "2026-09", startsAt: Date.UTC(2026, 8, 1), endsAt: Date.UTC(2026, 9, 1) };
type Period = { key: string; startsAt: number; endsAt: number | null };
function overview(
  sandbox: Totals,
  production: Totals,
  options: {
    plan?: (typeof plan & { periodAnchor?: number }) | null;
    unattributed?: boolean;
    period?: Period;
    current?: Period | null;
    recent?: Period[];
  } = {},
) {
  state.queries["usage:overview"] = {
    plan: options.plan === undefined ? plan : options.plan,
    period: options.period ?? october,
    current: options.current === undefined ? (options.period ?? october) : options.current,
    recent: options.recent ?? [october, september],
    environments: { sandbox: rows(sandbox), production: rows(production) },
    unattributed: options.unattributed ?? false,
    rows: rows(sandbox),
  };
  render(<Usage org={org} contextKey="test" />);
}
const card = (name: string) => screen.getByRole("article", { name });

it("the number, the bar and the split count confirmed plus reserved", () => {
  overview({ imports: [4, 1] }, {});
  const imports = card("Arquivos importados");
  expect(imports.querySelector(".gestao-metric__value")?.textContent).toBe("5de 5");
  expect(within(imports).getByText("100% usado")).toBeTruthy();
  expect(within(imports).getByText("4 confirmados e 1 reservado")).toBeTruthy();
  expect(within(imports).getByText(/Limite atingido em Sandbox/)).toBeTruthy();
});

it("plurals agree and nothing reads (s)", () => {
  overview({ imports: [1, 0], captures: [0, 1], registry: [0, 0] }, {});
  expect(document.body.textContent).not.toContain("(s)");
  expect(within(card("Arquivos importados")).getByText("Nada reservado")).toBeTruthy();
  expect(within(card("Capturas admitidas")).getByText("0 confirmados e 1 reservado")).toBeTruthy();
});

it("bytes read in binary units, with the exact number in Critério técnico", () => {
  overview({ bytes: [9805, 3945] }, {});
  const volume = card("Volume recebido");
  expect(volume.querySelector(".gestao-metric__value")?.textContent).toBe("13,4 KiBde 1 MiB");
  expect(within(volume).getByText("9,6 KiB confirmados e 3,9 KiB reservados")).toBeTruthy();
  expect(within(volume).getByText("1% usado")).toBeTruthy();
  expect(volume.querySelector("details")?.textContent).toContain(
    "Valor exato: 9.805 bytes confirmados e 3.945 reservados, de um limite de 1.048.576 bytes.",
  );
});

it("a bar at zero is empty, and a partial one fills its share", () => {
  overview({ imports: [4, 0] }, {});
  const captures = card("Capturas admitidas");
  expect(within(captures).getByText("0% usado")).toBeTruthy();
  expect(captures.querySelector(".gestao-meter__fill")).toBeNull();
  const fill = card("Arquivos importados").querySelector<HTMLElement>(".gestao-meter__fill");
  expect(fill?.style.width).toBe("80%");
});

it("each environment says whose balance it is, and a limit reached in the other one is said", () => {
  state.environment = "production";
  overview({ imports: [5, 0] }, { captures: [1, 0] });
  expect(
    screen.getByText(
      "Saldo próprio de Produção, com os mesmos limites do plano. O consumo do Sandbox não entra nesta conta.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/Limite atingido em Sandbox\. Troque o ambiente na lateral/),
  ).toBeTruthy();
  inEnvironment("sandbox");
  expect(
    screen.getByText(
      "Saldo próprio do Sandbox, com os mesmos limites do plano. O consumo de Produção não entra nesta conta.",
    ),
  ).toBeTruthy();
  expect(within(card("Arquivos importados")).getByText(/Limite atingido em Sandbox/)).toBeTruthy();
});

it("the plan card keeps label and value; the totals note belongs to the last aggregation", () => {
  overview({ imports: [1, 0] }, {});
  const aggregation = screen.getByText("Última agregação").closest(".ui-dl__row")!;
  expect(aggregation.querySelector("dd")?.textContent).toContain(
    "Totais atualizados pelas operações confirmadas no servidor.",
  );
  const planCard = screen.getByText("Plano assistido de teste").closest("section, .ui-card, div")!;
  expect(planCard.textContent).not.toContain("Cada ambiente tem o próprio saldo");
});

it("without a plan, each environment is measured without a quota", () => {
  overview({}, {}, { plan: null });
  expect(
    screen.getByText("Medição do Sandbox, sem cota. O consumo de Produção é medido à parte."),
  ).toBeTruthy();
  expect(within(card("Arquivos importados")).getByText("sem cota")).toBeTruthy();
  expect(screen.queryByText(/% usado/)).toBeNull();
  // #429: without a plan, "sem cota" never reads as a production capture without limit.
  expect(screen.getByText(/Esta organização está em medição/).textContent).toContain(
    "Novas consultas de captura de NF-e em Produção exigem um plano atribuído com cotas de consultas e de bytes.",
  );
  expect(screen.queryByText(/captura de NF-e em Produção ficam paradas/)).toBeNull();
  inEnvironment("production");
  expect(screen.getByText(/^Medição de Produção\./).textContent).not.toContain("sem cota");
  for (const name of ["Capturas admitidas", "Volume recebido"])
    expect(
      within(card(name)).getByText(
        "Sem esta cota no plano, novas consultas de captura de NF-e em Produção ficam paradas.",
      ),
    ).toBeTruthy();
  expect(within(card("Arquivos importados")).queryByText(/captura de NF-e/)).toBeNull();
});

it("a plan without the capture or byte quota says production capture stays stopped", () => {
  state.environment = "production";
  overview(
    {},
    { imports: [1, 0] },
    { plan: { ...plan, limits: { ...plan.limits, captures: null } } },
  );
  expect(
    within(card("Capturas admitidas")).getByText(
      "Sem esta cota no plano, novas consultas de captura de NF-e em Produção ficam paradas.",
    ),
  ).toBeTruthy();
  expect(within(card("Volume recebido")).queryByText(/ficam paradas/)).toBeNull();
  expect(within(card("Volume recebido")).getByText("de 1 MiB")).toBeTruthy();
});

// ADR 0010: the free tier limits Production by new notes; the sandbox keeps files and queries.
it("a plan with a notes quota shows notes in Production and files and queries in Sandbox", () => {
  const free = {
    ...plan,
    limits: {
      imports: 100,
      captures: 100,
      registry: 10,
      bytes: 1048576,
      deliveries: 300,
      notes: 100,
    },
  };
  state.environment = "production";
  overview(
    { imports: [3, 0], documents: [2, 0] },
    { documents: [100, 0], imports: [150, 0] },
    {
      plan: free,
    },
  );
  expect(screen.getByText(/contam pelas notas novas do mês/)).toBeTruthy();
  const notes = card("Notas novas");
  expect(notes.querySelector(".gestao-metric__value")?.textContent).toBe("100de 100");
  expect(within(notes).getByText("100% usado")).toBeTruthy();
  expect(notes.querySelector("details")?.textContent).toContain(
    "a NF-e pela chave de acesso, a NFS-e pelo número",
  );
  expect(notes.querySelector("details")?.textContent).toContain(
    "Os reservados são arquivos de importação aguardando processamento",
  );
  const imports = card("Arquivos importados");
  expect(imports.querySelector(".gestao-metric__value")?.textContent).toBe("150na cota de notas");
  expect(within(imports).queryByText(/% usado/)).toBeNull();
  expect(within(card("Capturas admitidas")).getByText("na cota de notas")).toBeTruthy();
  expect(screen.queryByText(/ficam paradas/)).toBeNull();
  inEnvironment("sandbox");
  // Produção reached its notes limit: the Sandbox says so above its own balance.
  expect(screen.getByText(/Limite atingido em Produção/)).toBeTruthy();
  expect(card("Arquivos importados").querySelector(".gestao-metric__value")?.textContent).toBe(
    "3de 100",
  );
  expect(within(card("Documentos únicos")).getByText("sem cota")).toBeTruthy();
  expect(screen.queryByRole("article", { name: "Notas novas" })).toBeNull();
});

it("usage still unattributed is announced", () => {
  overview({}, {}, { unattributed: true });
  const notice = screen.getByRole("status", { name: "" });
  expect(notice.textContent).toContain("Consumo anterior em atribuição.");
  expect(notice.textContent).toContain("aparece e conta nos dois ambientes");
});

it("a plan without an end reads Sem vencimento and stays in force", () => {
  overview({}, {}, { plan: { ...plan, endsAt: null } });
  expect(
    screen.getByText(
      `Sem vencimento, a partir de ${new Date(plan.startsAt).toLocaleString("pt-BR")}. As cotas renovam a cada mês, em UTC.`,
    ),
  ).toBeTruthy();
  expect(screen.getByText("Plano vigente")).toBeTruthy();
  expect(screen.queryByText("Plano fora da vigência.")).toBeNull();
});

describe("período de consumo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 20, 9, 40));
  });
  afterEach(() => vi.useRealTimers());
  const anchored = {
    key: "2026-11-15T14:30:00.000Z",
    startsAt: Date.UTC(2026, 10, 15, 14, 30),
    endsAt: Date.UTC(2026, 11, 15, 14, 30),
  };
  const november = {
    key: "2026-11",
    startsAt: Date.UTC(2026, 10, 1),
    endsAt: Date.UTC(2026, 11, 1),
  };

  it("lists the periods the server named, with the end as the renewal, and asks a past one by its key", () => {
    const replaced = {
      key: "2026-08-20T09:00:29.000Z",
      startsAt: Date.UTC(2026, 7, 20, 9, 0, 29),
      endsAt: null,
    };
    overview({}, {}, { period: anchored, recent: [anchored, october, replaced] });
    const select = screen.getByLabelText<HTMLSelectElement>("Período de consumo, em UTC");
    expect(select.value).toBe(anchored.key);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Desde 15/11/2026 às 14:30 UTC, renova em 15/12/2026 às 14:30 UTC",
      "Desde 01/10/2026 às 00:00 UTC, renova em 01/11/2026 às 00:00 UTC",
      "Desde 20/08/2026 às 09:00:29 UTC",
    ]);
    // The page opened on the period holding `asOf`, the hour, without a key of its own.
    expect(state.args).toEqual([
      { organizationId: "org", asOf: Date.UTC(2026, 10, 20, 9), contextKey: "test" },
    ]);
    fireEvent.change(select, { target: { value: "2026-10" } });
    expect(state.args.at(-1)).toMatchObject({ period: "2026-10" });
  });

  it("choosing the current period by its key follows the clock again, wherever it is listed", () => {
    // The current period is not the first one listed: a newer key exists.
    overview({}, {}, { period: october, current: anchored, recent: [november, anchored, october] });
    const select = screen.getByLabelText<HTMLSelectElement>("Período de consumo, em UTC");
    fireEvent.change(select, { target: { value: november.key } });
    expect(state.args.at(-1)).toMatchObject({ period: november.key });
    fireEvent.change(select, { target: { value: anchored.key } });
    expect((state.args.at(-1) as { period?: string }).period).toBeUndefined();
  });

  it("moves to the next period when the current one ends, asking at its end", () => {
    // Asked at 14:00; the anchored period renewed at 14:30 and the clock reads 14:40.
    vi.setSystemTime(Date.UTC(2026, 11, 15, 14, 40));
    overview({}, {}, { period: anchored });
    expect(state.args[0]).toMatchObject({ asOf: Date.UTC(2026, 11, 15, 14) });
    expect(state.args.at(-1)).toMatchObject({ asOf: anchored.endsAt });
  });

  it("follows a plan anchored after the hour it asked, instead of the civil month", () => {
    // A Personalizado assigned at 09:17:23 to a Free organization; the page asked at 09:00.
    const anchor = Date.UTC(2026, 10, 20, 9, 17, 23);
    overview(
      {},
      {},
      {
        period: november,
        plan: { ...plan, startsAt: anchor, periodAnchor: anchor },
      },
    );
    expect(state.args.at(-1)).toMatchObject({ asOf: anchor });
  });
});
