import { posix } from "node:path";
import { documentationOnly, documentationTests } from "./ci-changes.mjs";

/**
 * Regras de `bun run check:changed` (docs/desenvolvimento/ci.md, "Conferir só o
 * que mudou"): o que a mudança desde a base exige antes do push. Funções puras;
 * scripts/ci/check-changed.mjs lê o Git, as listas de arquivos do TypeScript e
 * executa os comandos.
 */

export const usage = `Uso: bun run check:changed [--base <ref>] [--dry-run]

Confere só o que mudou desde a base (padrão origin/main), inclusive o que não
foi commitado: formatação e lint dos arquivos alterados, typecheck dos
projetos que contêm algum deles, fronteiras dos pacotes quando um pacote muda e
os testes que o grafo de imports alcança. Não substitui bun run ci:local.

  --base <ref>  Compara com o merge-base entre <ref> e HEAD.
  --dry-run     Mostra arquivos, projetos e comandos sem executar.
  --help        Mostra esta ajuda.

Sai com 0 quando tudo passa, 1 quando alguma etapa falha e 2 em uso inválido.`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { base: "origin/main", dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("--base exige uma ref");
      options.base = value;
    } else if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
      if (!options.base) throw new Error("--base exige uma ref");
    } else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

/** Os projetos que o typecheck da árvore cobre, como em platform:check e no console. */
export const typecheckProjects = [
  "tsconfig.platform.json",
  "apps/console/tsconfig.json",
  "apps/console/tsconfig.worker.json",
  "apps/docs/tsconfig.json",
  "deploy/selfhost/tsconfig.json",
];

const matches = (file, patterns) => patterns.some((pattern) => posix.matchesGlob(file, pattern));

/** Configuração que muda o que todo projeto resolve: typecheck de todos. */
const everyProject = ["**/tsconfig*.json", "package.json", "**/package.json", "bun.lock"];
/** O que a checagem de fronteiras lê (scripts/build/check-package-boundaries.mjs). */
const boundaryInputs = [
  "packages/**",
  "package.json",
  "**/package.json",
  "bun.lock",
  "scripts/build/package-boundaries.json",
  "scripts/lib/package-boundaries.mjs",
];
const lintable = /\.(?:[cm]?[jt]sx?)$/;
const typed = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * O que a mudança pede. `files` são os caminhos alterados ou novos, relativos à
 * raiz e com `/`; `deleted`, os apagados (uma renomeação conta dos dois lados).
 * @param {{ files: string[], deleted?: string[] }} change
 */
export function classify({ files, deleted = [] }) {
  const all = [...new Set([...files, ...deleted])].sort();
  if (all.length === 0) return { mode: "empty", files: [] };
  const present = files.filter((file) => !deleted.includes(file));
  // Como no job Validate: só documentação, sem remoção, roda a formatação e os
  // testes que leem toda a documentação.
  if (deleted.length === 0 && all.every((file) => documentationOnly(file)))
    return { mode: "docs", files: all, format: present, tests: documentationTests };
  return {
    mode: "full",
    files: all,
    format: present,
    lint: present.filter((file) => lintable.test(file)),
    // Um arquivo de código apagado quebra quem o importa, que não está na
    // lista; a configuração muda a resolução de todos.
    everyProject:
      all.some((file) => matches(file, everyProject)) || deleted.some((file) => typed.test(file)),
    boundaries: all.some((file) => matches(file, boundaryInputs)),
  };
}

/**
 * Projetos cujo programa contém um arquivo alterado. `programs` mapeia cada
 * projeto para os arquivos do programa (`tsc --listFilesOnly`), relativos à
 * raiz e com `/`.
 * @param {string[]} files
 * @param {Record<string, Iterable<string>>} programs
 * @param {boolean} everyProject
 */
export function affectedProjects(files, programs, everyProject) {
  if (everyProject) return Object.keys(programs);
  const changed = new Set(files);
  return Object.entries(programs)
    .filter(([, program]) => [...program].some((file) => changed.has(file)))
    .map(([project]) => project);
}

/**
 * As etapas, na ordem em que rodam. Cada uma roda mesmo que a anterior falhe,
 * para mostrar todos os problemas de uma vez.
 * @param {ReturnType<typeof classify>} change
 * @param {{ base: string, projects?: string[] }} context
 */
export function steps(change, { base, projects = [] }) {
  if (change.mode === "empty") return [];
  const list = [];
  if (change.format.length)
    list.push({
      name: "formatação",
      command: ["vp", "fmt", "--check", "--no-error-on-unmatched-pattern", ...change.format],
    });
  if (change.mode === "docs") {
    list.push({ name: "testes da documentação", command: ["vp", "test", "run", ...change.tests] });
    return list;
  }
  const typesNeeded = change.lint.length > 0 || projects.length > 0;
  // O lint com tipos e o typecheck resolvem os pacotes fiscais pelo dist; a
  // tarefa repete o build do cache quando nada dele mudou.
  if (typesNeeded) list.push({ name: "pacotes fiscais", command: ["vp", "run", "ci:packages"] });
  // Desde a #100 a árvore não tem aviso: um aviso novo num arquivo alterado
  // reprova aqui, antes de se perder entre outros no vp check.
  if (change.lint.length)
    list.push({
      name: "lint",
      command: ["vp", "lint", "--deny-warnings", "--no-error-on-unmatched-pattern", ...change.lint],
    });
  for (const project of projects)
    list.push({
      name: `typecheck ${project}`,
      command: ["node", "scripts/build/typecheck.mjs", "-p", project],
    });
  if (change.boundaries)
    list.push({
      name: "fronteiras dos pacotes",
      command: ["node", "scripts/build/check-package-boundaries.mjs"],
    });
  list.push({
    name: "testes alcançados",
    command: ["vp", "test", "run", "--changed", base, "--passWithNoTests"],
  });
  return list;
}
