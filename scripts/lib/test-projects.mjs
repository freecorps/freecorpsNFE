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
  "tooling/**/*.test.ts",
  "apps/console/e2e/**/*.test.ts",
  ".agents/skills/*/scripts/*.test.ts",
  "apps/docs/scripts/**/*.test.ts",
  "tests/{worktree,validation,ci.,fixtureCorpus}*.test.ts",
];
const benchmarks = ["platform/**/*.benchmark.test.ts", "tests/**/*.benchmark.test.ts"];
// Testes que leem a árvore inteira: os identificadores de todo Markdown, a
// classificação de todo arquivo versionado para a cópia pública, o status das
// ADRs e os links relativos em todo Markdown e o guarda da lista de
// documentação, que lê todo código-fonte. Numa área própria, a `tooling` só
// repete a execução quando muda o que ela lê, não a cada arquivo do
// repositório. Os quatro primeiros são também
// os testes do modo de documentação do CI (`documentationTests` em
// scripts/lib/ci-changes.mjs).
const repository = [
  "scripts/public-copy/{public-identifiers,public-tree}.test.ts",
  "scripts/repo/adr-status.test.ts",
  "scripts/repo/doc-links.test.ts",
  "tests/ci.changes.test.ts",
];
// Os testes da plataforma ficam ao lado do módulo (platform/convex/, inclusive lib/ e
// testing/) e dos Workers de apps/console/; em tests/ ficam só os transversais.
const platform = [
  "platform/**/*.test.ts",
  "apps/console/*.test.ts",
  "tests/{publicSite,referenceCorpus}.test.ts",
];
const packages = ["packages/**/*.test.ts"];

/**
 * `timeout` é o limite por teste em ms antes dos ajustes de ambiente;
 * `report` é a suíte do relatório do CI (.ci-results/tests.json);
 * `shared` roda a área sem isolamento por arquivo (`vitestProjects`).
 */
export const testProjects = [
  {
    name: "platform",
    include: platform,
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
    exclude: [...benchmarks, ...repository],
    timeout: 60_000,
    report: "infrastructure",
  },
  { name: "repository", include: repository, timeout: 60_000, report: "infrastructure" },
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

/**
 * Arquivos de teste de um projeto, relativos à raiz e com `/`. A caminhada é
 * manual: pula `node_modules` e pastas com ponto e nunca segue symlink (o
 * `Dirent` de um symlink não é diretório nem arquivo). O `recursive` do
 * `readdirSync` descia pelos links de `node_modules` até o `dist` que outra
 * tarefa do grafo recria ao mesmo tempo e falhava com ENOENT. Uma subpasta que
 * some durante a caminhada não tinha teste a contar.
 */
function filesOf({ include, exclude }) {
  const files = [];
  const walk = (dir, top) => {
    let entries;
    try {
      entries = readdirSync(root + dir, { withFileTypes: true });
    } catch (error) {
      if (!top && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
      throw error;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(path, false);
      } else if (entry.isFile() && matches(path, include) && !matches(path, exclude))
        files.push(path);
    }
  };
  for (const dir of new Set(include.map((pattern) => pattern.split("/")[0]))) walk(dir, true);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

/**
 * Arquivos de teste que a área roda, somados os projetos dela, relativos à
 * raiz e com `/`. O CI confere que o recibo de cada área contou exatamente
 * esses arquivos (`collectTests` em scripts/lib/ci.mjs).
 */
export function areaFiles(area) {
  const project = testProjects.find(({ name }) => name === area);
  if (!project) throw new Error(`Unknown test area: ${area}`);
  return filesOf(project);
}

/** `vp test run` com todos os projetos do Vitest de uma área. */
export const areaCommand = (area) =>
  ["vp test run", ...areaProjects(area).map((name) => `--project ${name}`)].join(" ");

/** Nomes dos projetos do Vitest da área, na ordem de `vitestProjects`. */
export const areaProjects = (area) =>
  vitestProjects()
    .filter((project) => project.area === area)
    .map(({ name }) => name);
