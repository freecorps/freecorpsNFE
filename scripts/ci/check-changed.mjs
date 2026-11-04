// Confere só o que mudou desde a base antes do push: formatação, lint,
// typecheck dos projetos afetados, fronteiras dos pacotes e testes alcançados.
// Regras em scripts/lib/check-changed.mjs; docs/desenvolvimento/ci.md,
// "Conferir só o que mudou". Não substitui bun run ci:local.
//
//   bun run check:changed [--base <ref>] [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  affectedProjects,
  affectedWorkspaces,
  classify,
  parseArgs,
  steps,
  typecheckProjects,
  usage,
} from "../lib/check-changed.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n\n${usage}`);
  process.exit(2);
}
if (options.help) {
  console.log(usage);
  process.exit(0);
}

const root = repoRoot;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const toPosix = (path) => path.replaceAll("\\", "/");

let mergeBase;
try {
  mergeBase = git("merge-base", options.base, "HEAD").trim();
} catch {
  console.error(
    `Sem merge-base entre ${options.base} e HEAD. Atualize a ref (git fetch origin) ou passe --base <ref>.`,
  );
  process.exit(2);
}

// Do merge-base até a árvore de trabalho, com o que está no índice e fora dele,
// mais os arquivos novos que o Git não ignora. Uma renomeação conta dos dois lados.
const files = new Set();
const deleted = new Set();
const entries = git("diff", "--name-status", "--no-renames", "-z", mergeBase)
  .split("\0")
  .filter(Boolean);
for (let index = 0; index + 1 < entries.length; index += 2) {
  const path = entries[index + 1];
  if (entries[index] === "D") deleted.add(path);
  else files.add(path);
}
for (const path of git("ls-files", "-o", "--exclude-standard", "-z").split("\0").filter(Boolean))
  files.add(path);

const change = classify({ files: [...files], deleted: [...deleted] });
if (change.mode === "empty") {
  console.log(`check:changed: nada mudou desde ${options.base} (${mergeBase.slice(0, 7)})`);
  process.exit(0);
}

/** Arquivos do programa de cada projeto, relativos à raiz, fora de node_modules. */
function program(project) {
  const tsc = join(root, "node_modules/typescript-7/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", project, "--listFilesOnly"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // A lista sai mesmo com erro de tipo; sem ela, o projeto entra por precaução.
  if (result.error || !result.stdout.trim()) return null;
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line && !line.includes("/node_modules/"))
    .map((line) => toPosix(relative(root, line)));
}

let projects = [];
let workspaces = { changed: [], dependents: [] };
if (change.mode === "full") {
  const programs = {};
  let unknown = false;
  for (const project of typecheckProjects) {
    const list = program(project);
    if (list === null) unknown = true;
    programs[project] = list ?? [];
  }
  projects = affectedProjects(change.files, programs, change.everyProject || unknown);
  const boundaries = JSON.parse(
    readFileSync(join(root, "scripts/build/package-boundaries.json"), "utf8"),
  );
  const dirs = Object.keys(boundaries.workspaces);
  const manifests = Object.fromEntries(
    dirs.map((dir) => [dir, JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))]),
  );
  workspaces = affectedWorkspaces(change.files, dirs, manifests);
}

const plan = steps(change, { base: mergeBase, projects });
const list = (items) => (items.length ? items.join(", ") : "nenhum");
console.log(
  [
    `check:changed: ${change.files.length} arquivos desde ${options.base} (${mergeBase.slice(0, 7)}), modo ${change.mode}`,
    ...(change.mode === "full"
      ? [
          `  pacotes alterados: ${list(workspaces.changed)}; dependentes: ${list(workspaces.dependents)}`,
          `  typecheck: ${list(projects)}`,
        ]
      : []),
  ].join("\n"),
);

if (options.dryRun) {
  for (const file of change.files) console.log(`  arquivo ${file}`);
  for (const step of plan) console.log(`  ${step.name}: ${step.command.join(" ")}`);
  process.exit(0);
}

const results = [];
for (const step of plan) {
  console.log(`\n▶ ${step.name}`);
  const started = Date.now();
  const [command, ...args] = step.command;
  // `vp` é o binário do projeto: `bun x` o acha sem shell, como no proof-runner,
  // e os caminhos dos arquivos chegam intactos.
  const result =
    command === "vp"
      ? spawnSync("bun", ["x", "vp", ...args], { cwd: root, stdio: "inherit" })
      : spawnSync(command === "node" ? process.execPath : command, args, {
          cwd: root,
          stdio: "inherit",
        });
  const passed = !result.error && result.status === 0;
  results.push({ name: step.name, passed, seconds: (Date.now() - started) / 1000 });
}

console.log("\ncheck:changed:");
for (const { name, passed, seconds } of results)
  console.log(`  ${passed ? "ok    " : "FALHOU"} ${name} (${seconds.toFixed(1)} s)`);
const failed = results.filter((result) => !result.passed);
if (failed.length) {
  console.log(`${failed.length} de ${results.length} etapas falharam.`);
  process.exitCode = 1;
} else console.log(`Todas as ${results.length} etapas passaram.`);
