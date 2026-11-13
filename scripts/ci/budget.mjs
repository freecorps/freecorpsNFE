// Orçamento de bundle e benchmarks (budget.json; docs/desenvolvimento/ci.md,
// Orçamento de bundle e benchmarks). Regras em scripts/lib/budget.mjs.
//
//   node scripts/ci/budget.mjs check     o gzip registrado é o medido (ci:budget)
//   node scripts/ci/budget.mjs write     grava o medido (bun run budget:update)
//   node scripts/ci/budget.mjs compare --base <ref> [--labels a,b]
//                                        recusa teto maior ou removido sem a label
//
// check e write compilam o console com o SHA fixo em zeros: o build real carimba
// o commit no bundle (por inteiro e abreviado), e o hash do chunk mudaria o gzip
// a cada commit. Com o SHA fixo, dois builds do mesmo código dão os mesmos bytes.
// A saída fica em node_modules/.vite, fora das entradas do Vite Task.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGET_FILE,
  BUDGET_LABEL,
  budgetVerdict,
  consoleDrift,
  measureConsole,
  parseLabels,
  readBudget,
} from "../lib/budget.mjs";
import { consoleEnvironment } from "../lib/console.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const usage = `Uso: node scripts/ci/budget.mjs check | write | compare --base <ref> [--labels a,b]`;
const out = join(repoRoot, "node_modules/.vite/console-budget");

function buildConsole() {
  rmSync(out, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/vite-plus/bin/vp"),
      "build",
      "--outDir",
      out,
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    {
      cwd: join(repoRoot, "apps/console"),
      env: consoleEnvironment(process.env, "0".repeat(40)),
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) throw new Error("O build do console falhou");
  return measureConsole(out);
}

function check() {
  const measured = buildConsole();
  const drift = consoleDrift(readBudget().console?.gzipBytes, measured);
  if (drift.length) {
    for (const { name, recorded, measured: value } of drift)
      console.error(`${name}: registrado ${recorded ?? "ausente"}, medido ${value ?? "ausente"}`);
    throw new Error(
      `${BUDGET_FILE} difere do bundle medido. Rode bun run budget:update e faça commit; um aumento pede a label ${BUDGET_LABEL} na PR.`,
    );
  }
  console.log(`${BUDGET_FILE}: o gzip do console é o medido (total ${measured.total} bytes)`);
}

function write() {
  const budget = readBudget();
  budget.console = { gzipBytes: buildConsole() };
  writeFileSync(join(repoRoot, BUDGET_FILE), `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`${BUDGET_FILE}: gravado o gzip medido (total ${budget.console.gzipBytes.total})`);
}

/** Rótulos atuais da PR, lidos na hora: uma reexecução vê a label adicionada depois do push. */
async function pullRequestLabels() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/.test(PR_NUMBER ?? ""))
    throw new Error(
      "Sem --labels, compare lê a PR: defina GITHUB_TOKEN, GITHUB_REPOSITORY e PR_NUMBER",
    );
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`A API do GitHub respondeu ${response.status} ao ler a PR`);
  return (await response.json()).labels.map((label) => label.name);
}

async function compare(args) {
  const base = args[args.indexOf("--base") + 1];
  if (!args.includes("--base") || !base || base.startsWith("--")) throw new Error(usage);
  const labelsAt = args.indexOf("--labels");
  const labelsArg = labelsAt === -1 ? null : args[labelsAt + 1];
  if (labelsAt !== -1 && (!labelsArg || labelsArg.startsWith("--"))) throw new Error(usage);
  const git = (...gitArgs) =>
    execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  // Uma ref que não resolve é erro, nunca "base sem arquivo", que aprovaria tudo.
  try {
    git("rev-parse", "--verify", `${base}^{commit}`);
  } catch {
    throw new Error(`A base ${base} não é um commit deste checkout`);
  }
  let baseBudget = null;
  try {
    baseBudget = JSON.parse(git("show", `${base}:${BUDGET_FILE}`));
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    // A base anterior ao orçamento não tem o arquivo: não há teto a afrouxar.
    console.log(`${base} não tem ${BUDGET_FILE}; nada a comparar`);
  }
  // A PR que apaga o arquivo remove todos os tetos: cada um aparece como removido.
  let head = {};
  try {
    head = readBudget();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const preliminary = budgetVerdict(baseBudget, head, []);
  if (preliminary.ok) {
    console.log(`${BUDGET_FILE}: nenhum teto aumentou nem saiu em relação a ${base}`);
    return;
  }
  const labels = labelsArg === null ? await pullRequestLabels() : parseLabels(labelsArg);
  const verdict = budgetVerdict(baseBudget, head, labels);
  for (const { path, base: before, head: after } of verdict.increases)
    console.log(`${path}: ${before} -> ${after ?? "removido"}`);
  if (!verdict.ok)
    throw new Error(
      `A PR aumenta ou remove tetos de ${BUDGET_FILE}. Se o aumento é de propósito, adicione a label ${BUDGET_LABEL} e reexecute o Validate.`,
    );
  console.log(`Aumento aceito pela label ${BUDGET_LABEL}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check" && !args.length) check();
  else if (command === "write" && !args.length) write();
  else if (command === "compare") await compare(args);
  else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
