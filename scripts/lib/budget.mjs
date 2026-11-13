// Orçamento versionado em budget.json (docs/desenvolvimento/ci.md, Orçamento de
// bundle e benchmarks): o gzip dos chunks principais do console, igual ao
// medido, e os tetos dos benchmarks da plataforma. Cada número é um teto:
// maior afrouxa. Uma PR que aumenta ou remove um número precisa da label
// BUDGET_LABEL; um número novo só aperta e passa.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { repoRoot } from "./repo-root.mjs";

export const BUDGET_FILE = "budget.json";
export const BUDGET_LABEL = "budget-increase";

/**
 * O que a primeira visita ao console carrega: os dois scripts do `index.html`
 * (`theme.js`, clássico e bloqueante, e o módulo `index.js`, que importa
 * `main.js`, e este os demais) e o estilo da landing. As rotas são chunks
 * preguiçosos e entram só no total.
 */
export const PRINCIPAL_CHUNKS = [
  "theme.js",
  "assets/index.js",
  "assets/main.js",
  "assets/main.css",
  "assets/app-shell.js",
  "assets/console-shared.js",
  "assets/rolldown-runtime.js",
  "landing.css",
];

/** Nome do asset sem o hash de conteúdo do Rolldown (`main-Dq3xLm8f.js` vira `main.js`). */
export function stableName(file) {
  return file.replace(/-[\w-]{8}(\.\w+)$/, "$1");
}

/**
 * Gzip nível 9 de cada arquivo separadamente, como `measure-console-bundle.mjs`,
 * depois de trocar no texto o nome com hash de cada asset pelo nome estável:
 * `main.js` importa as rotas pelo nome, e o hash novo de uma rota mudaria o
 * gzip dele em alguns bytes, para mais ou para menos, sem que ele mudasse.
 * `total` soma todo JS e CSS de `assets/`, inclusive os chunks preguiçosos,
 * mais `theme.js` e `landing.css`.
 * @param {string} dist
 * @returns {Record<string, number>}
 */
export function measureConsole(dist) {
  const all = readdirSync(join(dist, "assets"));
  const renames = all
    .filter((file) => stableName(file) !== file)
    .map((file) => [file, stableName(file)]);
  const files = [
    ...all.filter((file) => /\.(js|css)$/.test(file)).map((file) => `assets/${file}`),
    "theme.js",
    "landing.css",
  ];
  const sizes = new Map();
  for (const path of files) {
    // latin1 preserva cada byte; só os nomes, em ASCII, mudam.
    let text = readFileSync(join(dist, path), "latin1");
    for (const [hashed, stable] of renames) text = text.replaceAll(hashed, stable);
    sizes.set(path, gzipSync(Buffer.from(text, "latin1"), { level: 9 }).length);
  }
  const measured = {};
  for (const name of PRINCIPAL_CHUNKS) {
    // Só os principais precisam de nome único; os demais entram no total pelo nome real.
    const matches = files.filter((path) => stableName(path) === name);
    if (matches.length !== 1)
      throw new Error(
        `O build do console tem ${matches.length} arquivo(s) ${name}; atualize PRINCIPAL_CHUNKS em scripts/lib/budget.mjs`,
      );
    measured[name] = sizes.get(matches[0]);
  }
  measured.total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  return measured;
}

/**
 * Diferenças entre o gzip registrado e o medido, nome a nome.
 * @param {Record<string, number>} recorded
 * @param {Record<string, number>} measured
 */
export function consoleDrift(recorded, measured) {
  const names = [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(measured)])];
  return names
    .filter((name) => recorded?.[name] !== measured[name])
    .map((name) => ({ name, recorded: recorded?.[name], measured: measured[name] }));
}

/** Folhas numéricas por caminho (`console.gzipBytes.total`). */
function leaves(value, prefix = "", out = new Map()) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${prefix} em ${BUDGET_FILE} não é um número finito e não negativo`);
    // Uma chave com ponto daria o mesmo caminho que um objeto aninhado, e a
    // última esconderia a outra.
    if (out.has(prefix)) throw new Error(`${prefix} aparece duas vezes em ${BUDGET_FILE}`);
    out.set(prefix, value);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      leaves(child, prefix ? `${prefix}.${key}` : key, out);
  } else throw new Error(`${prefix || "A raiz"} de ${BUDGET_FILE} não é número nem objeto`);
  return out;
}

/**
 * O que a PR afrouxa em relação à base: um teto maior ou removido. Um teto novo
 * aperta e não aparece aqui.
 * @returns {{ path: string, base: number, head: number | undefined }[]}
 */
export function budgetIncreases(base, head) {
  const before = leaves(base);
  const after = leaves(head);
  return [...before]
    .filter(([path, value]) => !after.has(path) || after.get(path) > value)
    .map(([path, value]) => ({ path, base: value, head: after.get(path) }));
}

/** Rótulos separados por vírgula ou quebra de linha, como o passo do CI os passa. */
export function parseLabels(text) {
  return (text ?? "")
    .split(/[\n,]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

/**
 * Veredito da PR: aprova sem aumento, ou com aumento e a label.
 * @param {unknown} base budget.json da base, ou `null` quando a base não o tem
 * @param {unknown} head budget.json da PR
 * @param {string[]} labels
 */
export function budgetVerdict(base, head, labels) {
  // Sem base, compara com o vazio: nada aumenta, mas o arquivo novo passa pela
  // mesma validação de tetos numéricos.
  const increases = budgetIncreases(base ?? {}, head);
  const accepted = labels.includes(BUDGET_LABEL);
  return { increases, accepted, ok: increases.length === 0 || accepted };
}

export function readBudget(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, BUDGET_FILE), "utf8"));
}

/**
 * Compara o budget.json do checkout com o da base e lança quando um teto
 * aumentou ou saiu sem a label. Os rótulos só são lidos quando há aumento.
 * @param {{ base: string, readLabels: () => Promise<string[]> | string[], root?: string, log?: (line: string) => void }} options
 */
export async function compareBudget({ base, readLabels, root = repoRoot, log = console.log }) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
    log(`${base} não tem ${BUDGET_FILE}; nada a comparar`);
  }
  // A PR que apaga o arquivo remove todos os tetos: cada um aparece como removido.
  let head = {};
  try {
    head = readBudget(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (budgetVerdict(baseBudget, head, []).ok) {
    log(`${BUDGET_FILE}: nenhum teto aumentou nem saiu em relação a ${base}`);
    return;
  }
  const verdict = budgetVerdict(baseBudget, head, await readLabels());
  for (const { path, base: before, head: after } of verdict.increases)
    log(`${path}: ${before} -> ${after ?? "removido"}`);
  if (!verdict.ok)
    throw new Error(
      `A PR aumenta ou remove tetos de ${BUDGET_FILE}. Se o aumento é de propósito, adicione a label ${BUDGET_LABEL} e reexecute o Validate.`,
    );
  log(`Aumento aceito pela label ${BUDGET_LABEL}`);
}

/**
 * Tetos de um benchmark, com as chaves que o teste usa; uma chave ausente é
 * erro, nunca um teto `undefined` que toda comparação aceitaria.
 * @template {string} K
 * @param {string} name
 * @param {readonly K[]} keys
 * @returns {Record<K, number>}
 */
export function benchmarkLimits(name, keys, budget = readBudget()) {
  const limits = budget.benchmarks?.[name];
  const result = /** @type {Record<K, number>} */ ({});
  for (const key of keys) {
    const value = limits?.[key];
    if (typeof value !== "number")
      throw new Error(`${BUDGET_FILE} não tem benchmarks.${name}.${key}`);
    result[key] = value;
  }
  return result;
}
