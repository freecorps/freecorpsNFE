import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

// Fonte única da classificação dos testes: vite.config.ts monta os projetos do
// Vitest a partir desta lista, e o relatório do CI (scripts/lib/ci.mjs) agrupa
// cada arquivo pela suíte `report` do projeto que o contém. Um caminho novo de
// teste entra aqui, num único projeto; um arquivo sem dono reprova
// tests/ci.testProjects.test.ts.
const tooling = [
  "scripts/**/*.test.ts",
  "apps/console/e2e/**/*.test.ts",
  "lib/worktree*.test.ts",
  "tests/{worktree,validation,consoleTarget,ci.,fixtureCorpus,docsOutput}*.test.ts",
];
const benchmarks = ["tests/**/*.benchmark.test.ts"];
const platform = [
  "tests/{platform,sdk}.*test.ts",
  "tests/{apiKeyCrypto,publicSite,referenceCorpus,webhookTransport}.test.ts",
];
const packages = ["packages/**/*.test.ts", "tests/{documentContracts,webhookContract}.test.ts"];

/**
 * `timeout` é o limite por teste em ms antes dos ajustes de ambiente;
 * `report` é a suíte do relatório do CI (.ci-results/tests.json);
 * `shared` roda a área sem isolamento por arquivo (`vitestProjects`).
 */
export const testProjects = [
  {
    name: "platform",
    include: [...platform, "platform/**/*.test.ts"],
    exclude: benchmarks,
    timeout: 20_000,
    report: "platform",
    shared: true,
  },
  { name: "packages", include: packages, timeout: 20_000, report: "platform" },
  {
    name: "console",
    include: ["apps/*/src/**/*.test.{ts,tsx}"],
    timeout: 20_000,
    report: "platform",
  },
  {
    name: "tooling",
    include: tooling,
    exclude: benchmarks,
    timeout: 60_000,
    report: "infrastructure",
  },
  { name: "benchmark", include: benchmarks, timeout: 120_000, report: "platform" },
];

export const reportSuites = ["platform", "infrastructure"];

const matches = (file, patterns = []) =>
  patterns.some((pattern) => posix.matchesGlob(file, pattern));

/** Projetos que contêm o arquivo, com o caminho relativo à raiz e `/`. */
export function projectsFor(file) {
  return testProjects.filter(
    ({ include, exclude }) => matches(file, include) && !matches(file, exclude),
  );
}

/** Suíte do relatório do único projeto que contém o arquivo. */
export function suiteFor(file) {
  const owners = projectsFor(file);
  if (owners.length !== 1)
    throw new Error(
      owners.length ? "Test file belongs to more than one project" : "Test file has no project",
    );
  return owners[0].report;
}

const root = fileURLToPath(new URL("../../", import.meta.url)).replaceAll("\\", "/");
const mocking = /\bvi\.(mock|doMock)\(/;
// `from "./x"`, `import "./x"` e `import("./x")`, com caminho relativo.
const localImport = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

/** Arquivos de teste de um projeto, relativos à raiz e com `/`. */
function filesOf({ include, exclude }) {
  const files = [];
  for (const dir of new Set(include.map((pattern) => pattern.split("/")[0])))
    for (const entry of readdirSync(root + dir, { recursive: true, withFileTypes: true })) {
      const file = posix.relative(root, `${entry.parentPath.replaceAll("\\", "/")}/${entry.name}`);
      if (entry.isFile() && !/(^|\/)(node_modules|\.[^/]+)\//.test(file))
        if (matches(file, include) && !matches(file, exclude)) files.push(file);
    }
  return files.sort();
}

/**
 * O arquivo, ou um módulo de `tests/` que ele importa (estático, de efeito ou
 * dinâmico; sem extensão, com `.js` ou como diretório com `index`), chama
 * vi.mock ou vi.doMock. Caminhos relativos à raiz, com `/`.
 */
export function mocks(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = readFileSync(root + file, "utf8");
  if (mocking.test(source)) return true;
  return [...source.matchAll(localImport)].some(([, specifier]) => {
    const target = posix.join(posix.dirname(file), specifier).replace(/\.[cm]?js$/, "");
    const module = [
      target,
      ...[".ts", ".tsx", "/index.ts", "/index.tsx"].map((s) => target + s),
    ].find((path) => /\.tsx?$/.test(path) && existsSync(root + path));
    return module?.startsWith("tests/") && mocks(module, seen);
  });
}

/**
 * Os projetos do Vitest. Uma área `shared` vira dois: `<área>`, sem isolamento
 * por arquivo, em que cada worker carrega o grafo do Convex uma vez para todos
 * os seus arquivos (tests/setup/file-isolation.ts desfaz o estado que cada
 * arquivo deixa), e `<área>-isolated`, com worker novo por arquivo, para quem
 * usa vi.mock ou vi.doMock, direto ou por um helper de `tests/`: um mock não
 * substitui um módulo que outro arquivo do worker já carregou. A lista vem da
 * leitura dos arquivos e não fica desatualizada. `area` é o nome da área.
 */
export function vitestProjects() {
  return testProjects.flatMap((project) => {
    const base = { ...project, area: project.name };
    if (!project.shared) return [{ ...base, isolate: true }];
    const isolated = filesOf(project).filter((file) => mocks(file));
    return [
      { ...base, exclude: [...(project.exclude ?? []), ...isolated], isolate: false },
      { ...base, name: `${project.name}-isolated`, include: isolated, isolate: true },
    ];
  });
}

/** `vp test run` com todos os projetos do Vitest de uma área. */
export const areaCommand = (area) =>
  [
    "vp test run",
    ...vitestProjects()
      .filter((project) => project.area === area)
      .map(({ name }) => `--project ${name}`),
  ].join(" ");
