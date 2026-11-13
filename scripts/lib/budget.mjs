// Orçamento versionado em budget.json (docs/desenvolvimento/ci.md, Orçamento de
// bundle e benchmarks): o gzip dos chunks principais do console, igual ao
// medido, e os tetos dos benchmarks da plataforma. Cada número é um teto:
// maior afrouxa. Uma PR que aumenta ou remove um número precisa da label
// BUDGET_LABEL; um número novo só aperta e passa.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { repoRoot } from "./repo-root.mjs";

export const BUDGET_FILE = "budget.json";
export const BUDGET_LABEL = "budget-increase";

/**
 * O que a primeira visita ao console carrega: `index.js`, o único script do
 * `index.html`, importa `main.js`, que importa estes, mais o estilo da landing.
 * As rotas são chunks preguiçosos e entram só no total.
 */
export const PRINCIPAL_CHUNKS = [
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
  return file.replace(/-[\w-]{8}(\.(?:js|css))$/, "$1");
}

/**
 * Gzip nível 9 de cada arquivo separadamente, como `measure-console-bundle.mjs`.
 * `total` soma todo JS e CSS de `assets/` e `landing.css`, inclusive os chunks
 * preguiçosos.
 * @param {string} dist
 * @returns {Record<string, number>}
 */
export function measureConsole(dist) {
  const assets = readdirSync(join(dist, "assets"))
    .filter((file) => /\.(js|css)$/.test(file))
    .map((file) => `assets/${file}`);
  const sizes = new Map();
  for (const path of [...assets, "landing.css"]) {
    const name = stableName(path);
    if (sizes.has(name)) throw new Error(`Dois assets do console chamados ${name}`);
    sizes.set(name, gzipSync(readFileSync(join(dist, path)), { level: 9 }).length);
  }
  const measured = {};
  for (const name of PRINCIPAL_CHUNKS) {
    if (!sizes.has(name))
      throw new Error(
        `O build do console não tem ${name}; atualize PRINCIPAL_CHUNKS em scripts/lib/budget.mjs`,
      );
    measured[name] = sizes.get(name);
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
