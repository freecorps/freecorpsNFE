import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BUDGET_LABEL,
  PRINCIPAL_CHUNKS,
  benchmarkLimits,
  budgetIncreases,
  budgetVerdict,
  consoleDrift,
  measureConsole,
  parseLabels,
  readBudget,
  stableName,
} from "../lib/budget.mjs";

const base = {
  console: { gzipBytes: { "assets/main.js": 1000, total: 5000 } },
  benchmarks: { home: { bytesRead: 100, documentsRead: 10 } },
};

describe("comparação com a base", () => {
  it("aponta teto maior e teto removido, e ignora redução e teto novo", () => {
    const head = {
      console: { gzipBytes: { "assets/main.js": 1001, total: 4000, "assets/novo.js": 9 } },
      benchmarks: { home: { bytesRead: 100 }, outro: { documentsRead: 1 } },
    };
    expect(budgetIncreases(base, head)).toEqual([
      { path: "console.gzipBytes.assets/main.js", base: 1000, head: 1001 },
      { path: "benchmarks.home.documentsRead", base: 10, head: undefined },
    ]);
    expect(budgetIncreases(base, base)).toEqual([]);
  });

  it("reprova o aumento sem a label e aprova com ela", () => {
    const head = structuredClone(base);
    head.console.gzipBytes.total = 5001;
    expect(budgetVerdict(base, head, [])).toMatchObject({ ok: false, accepted: false });
    expect(budgetVerdict(base, head, ["size/M", "enhancement"]).ok).toBe(false);
    expect(budgetVerdict(base, head, ["size/M", BUDGET_LABEL])).toMatchObject({
      ok: true,
      accepted: true,
      increases: [{ path: "console.gzipBytes.total", base: 5000, head: 5001 }],
    });
  });

  it("aprova a redução sem label e a base que ainda não tem o arquivo", () => {
    const head = structuredClone(base);
    head.console.gzipBytes.total = 4999;
    expect(budgetVerdict(base, head, []).ok).toBe(true);
    expect(budgetVerdict(null, head, []).ok).toBe(true);
  });

  it("valida o arquivo novo mesmo sem base", () => {
    expect(() => budgetVerdict(null, { console: { total: "grande" } }, [])).toThrow(
      "console.total",
    );
  });

  it("trata o arquivo apagado como todos os tetos removidos", () => {
    expect(budgetVerdict(base, {}, []).increases.map(({ path }) => path)).toEqual([
      "console.gzipBytes.assets/main.js",
      "console.gzipBytes.total",
      "benchmarks.home.bytesRead",
      "benchmarks.home.documentsRead",
    ]);
  });

  it("recusa o que não é teto numérico", () => {
    expect(() => budgetIncreases(base, { ...base, nota: "texto" })).toThrow("nota");
    expect(() => budgetIncreases(base, { ...base, lista: [1] })).toThrow("lista");
    expect(() => budgetIncreases({ x: -1 }, { x: 1 })).toThrow("x");
  });

  it("lê os rótulos separados por vírgula ou linha", () => {
    expect(parseLabels(` size/M ,${BUDGET_LABEL}\nenhancement\n`)).toEqual([
      "size/M",
      BUDGET_LABEL,
      "enhancement",
    ]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});

describe("medição do console", () => {
  let dist: string | undefined;
  afterEach(() => {
    if (dist) rmSync(dist, { recursive: true, force: true });
    dist = undefined;
  });

  function build(files: Record<string, string>) {
    dist = mkdtempSync(join(tmpdir(), "fnfe-budget-"));
    mkdirSync(join(dist, "assets"));
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dist, path), content);
    return dist;
  }
  const gz = (text: string) => gzipSync(Buffer.from(text), { level: 9 }).length;
  const principal = Object.fromEntries(
    PRINCIPAL_CHUNKS.map((name) => [
      name.replace(/(\.(?:js|css))$/, name === "landing.css" ? "$1" : "-Ab1_-Xy9$1"),
      `/* ${name} */`.repeat(20),
    ]),
  );

  it("tira o hash do nome e soma os chunks preguiçosos só no total", () => {
    expect(stableName("assets/account-settings-spQkXek-.js")).toBe("assets/account-settings.js");
    expect(stableName("assets/city-hall.client-CJD8chIc.js")).toBe("assets/city-hall.client.js");
    const lazy = "export const rota = 1;".repeat(50);
    const measured = measureConsole(
      build({ ...principal, "assets/rota-Qw3rTy12.js": lazy, "assets/fonte-Qw3rTy12.woff2": "x" }),
    );
    expect(Object.keys(measured)).toEqual([...PRINCIPAL_CHUNKS, "total"]);
    expect(measured["assets/main.js"]).toBe(gz("/* assets/main.js */".repeat(20)));
    const principalSum = PRINCIPAL_CHUNKS.reduce((sum, name) => sum + measured[name]!, 0);
    expect(measured.total).toBe(principalSum + gz(lazy));
  });

  it("recusa chunk principal ausente e dois assets com o mesmo nome estável", () => {
    const { "assets/app-shell-Ab1_-Xy9.js": _, ...withoutShell } = principal;
    expect(() => measureConsole(build(withoutShell))).toThrow("assets/app-shell.js");
    expect(() =>
      measureConsole(build({ ...principal, "assets/main-Zz9_-Yy8.js": "outro" })),
    ).toThrow("assets/main.js");
  });

  it("lista cada diferença entre o registrado e o medido", () => {
    expect(consoleDrift({ a: 1, b: 2, c: 3 }, { a: 1, b: 3, d: 4 })).toEqual([
      { name: "b", recorded: 2, measured: 3 },
      { name: "c", recorded: 3, measured: undefined },
      { name: "d", recorded: undefined, measured: 4 },
    ]);
  });
});

describe("budget.json", () => {
  it("só tem tetos numéricos e registra cada chunk principal do console", () => {
    const budget = readBudget();
    expect(budgetIncreases(budget, budget)).toEqual([]);
    expect(Object.keys(budget.console.gzipBytes)).toEqual([...PRINCIPAL_CHUNKS, "total"]);
  });

  it("entrega aos benchmarks só as chaves que existem", () => {
    expect(benchmarkLimits("x", ["bytesRead"], { benchmarks: { x: { bytesRead: 5 } } })).toEqual({
      bytesRead: 5,
    });
    expect(() => benchmarkLimits("x", ["documentsRead"], { benchmarks: { x: {} } })).toThrow(
      "benchmarks.x.documentsRead",
    );
    expect(() => benchmarkLimits("y", ["bytesRead"], { benchmarks: {} })).toThrow(
      "benchmarks.y.bytesRead",
    );
  });
});
