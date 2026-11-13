import { execFileSync } from "node:child_process";
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
  compareBudget,
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
    // Uma chave com ponto não esconde o teto aninhado de mesmo caminho.
    expect(() => budgetIncreases(base, { ...base, "benchmarks.home": { bytesRead: 1 } })).toThrow(
      "benchmarks.home.bytesRead aparece duas vezes",
    );
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
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function build(files: Record<string, string>) {
    const dist = mkdtempSync(join(tmpdir(), "fnfe-budget-"));
    dirs.push(dist);
    mkdirSync(join(dist, "assets"));
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dist, path), content);
    return dist;
  }
  const gz = (text: string) => gzipSync(Buffer.from(text), { level: 9 }).length;
  // theme.js e landing.css ficam na raiz, sem hash; os demais em assets/, com hash.
  const principal = Object.fromEntries(
    PRINCIPAL_CHUNKS.map((name) => [
      name.startsWith("assets/") ? name.replace(/(\.\w+)$/, "-Ab1_-Xy9$1") : name,
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
    expect(measured["theme.js"]).toBe(gz("/* theme.js */".repeat(20)));
    const principalSum = PRINCIPAL_CHUNKS.reduce((sum, name) => sum + measured[name]!, 0);
    expect(measured.total).toBe(principalSum + gz(lazy));
  });

  it("não muda o gzip de quem importa uma rota quando só o hash dela muda", () => {
    const importer = (hash: string) => ({
      ...principal,
      "assets/main-Ab1_-Xy9.js": `import("./rota-${hash}.js");`.repeat(5),
      [`assets/rota-${hash}.js`]: "export const rota = 1;",
    });
    const before = measureConsole(build(importer("Qw3rTy12")));
    const after = measureConsole(build(importer("Zx9-_Kp4")));
    expect(after["assets/main.js"]).toBe(before["assets/main.js"]);
    expect(after.total).toBe(before.total);
  });

  it("recusa chunk principal ausente ou repetido e aceita rotas com o mesmo nome estável", () => {
    const { "assets/app-shell-Ab1_-Xy9.js": _, ...withoutShell } = principal;
    expect(() => measureConsole(build(withoutShell))).toThrow("assets/app-shell.js");
    expect(() =>
      measureConsole(build({ ...principal, "assets/main-Zz9_-Yy8.js": "outro" })),
    ).toThrow("assets/main.js");
    const twins = measureConsole(
      build({ ...principal, "assets/client-Qw3rTy12.js": "a", "assets/client-Zx9-_Kp4.js": "b" }),
    );
    const principalSum = PRINCIPAL_CHUNKS.reduce((sum, name) => sum + twins[name]!, 0);
    expect(twins.total).toBe(principalSum + gz("a") + gz("b"));
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

describe("compare contra a base no Git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Repositório com a base num commit e o budget.json da PR na árvore. */
  function repository(baseBudget: unknown, headBudget: unknown) {
    const root = mkdtempSync(join(tmpdir(), "fnfe-budget-git-"));
    dirs.push(root);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          cwd: root,
          stdio: "ignore",
        },
      );
    git("init", "-q");
    if (baseBudget === null) writeFileSync(join(root, "outro.txt"), "x");
    else writeFileSync(join(root, "budget.json"), JSON.stringify(baseBudget));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    if (headBudget === null) rmSync(join(root, "budget.json"), { force: true });
    else writeFileSync(join(root, "budget.json"), JSON.stringify(headBudget));
    return root;
  }
  const raised = { ...base, console: { gzipBytes: { "assets/main.js": 1001, total: 5000 } } };
  const run = (root: string, labels: string[], ref = "HEAD") => {
    let read = 0;
    const lines: string[] = [];
    const result = compareBudget({
      root,
      base: ref,
      log: (line) => lines.push(line),
      readLabels: () => {
        read += 1;
        return labels;
      },
    });
    return { result, lines, reads: () => read };
  };

  it("reprova o aumento sem a label e aprova com ela", async () => {
    const root = repository(base, raised);
    const without = run(root, ["size/M"]);
    await expect(without.result).rejects.toThrow(BUDGET_LABEL);
    expect(without.lines).toContain("console.gzipBytes.assets/main.js: 1000 -> 1001");
    const withLabel = run(root, [BUDGET_LABEL]);
    await expect(withLabel.result).resolves.toBeUndefined();
    expect(withLabel.lines.at(-1)).toBe(`Aumento aceito pela label ${BUDGET_LABEL}`);
  });

  it("não lê os rótulos quando nada aumentou", async () => {
    const unchanged = run(repository(base, base), []);
    await expect(unchanged.result).resolves.toBeUndefined();
    expect(unchanged.reads()).toBe(0);
  });

  it("aprova a base sem o arquivo e reprova a PR que o apaga", async () => {
    await expect(run(repository(null, raised), []).result).resolves.toBeUndefined();
    const deleted = run(repository(base, null), []);
    await expect(deleted.result).rejects.toThrow(BUDGET_LABEL);
    expect(deleted.lines).toContain("console.gzipBytes.total: 5000 -> removido");
  });

  it("recusa uma base que não resolve num commit", async () => {
    await expect(run(repository(base, base), [], "nao-existe").result).rejects.toThrow(
      "não é um commit",
    );
  });
});
