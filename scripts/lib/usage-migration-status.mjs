import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { subprocessEnvironment } from "./subprocess-environment.mjs";

/**
 * Recibo da migração de ambiente do consumo (#429): lê, só lendo, as queries
 * `usageMigration:eventStatus` e `usageMigration:totalStatus` de um deployment
 * escolhido por nome e soma as páginas. O recibo traz só contagens e unidades
 * por métrica, ambiente e estado; nenhum id, organização, chave ou período.
 * Tudo o que entra (resposta da CLI ou recibo de `--compare`) passa por lista
 * fechada de métricas, ambientes e estados e por inteiros seguros; o que não
 * cabe falha sem repetir o valor recebido.
 */

/** As páginas são transações separadas; o recibo diz isso em vez de concluir. */
export const limitations = [
  "As páginas são lidas em transações separadas, não num snapshot: tráfego, encerramento de organização ou o próprio backfill entre duas páginas podem mover unidades de uma página já lida para outra ainda à frente.",
  "Igualdade entre eventos e totais, ou entre dois recibos, é observação desta janela de leitura, não prova de conservação: confirme que não houve tráfego, encerramento nem backfill durante as leituras antes de concluir.",
  "localCheckout.commit é o commit do checkout que executou a leitura; não é o SHA publicado no deployment, que sai do /health do alvo.",
];

/** As de `platform/convex/lib/usageValues.ts`; o teste confere que são as mesmas. */
export const metrics = [
  "imports",
  "documents",
  "captures",
  "registry",
  "bytes",
  "deliveries",
  "attempts",
  "issuances",
];
export const environments = ["sandbox", "production", "unattributed"];
export const states = ["reserved", "committed", "released"];

/**
 * @typedef {{ metric: string; environment: string; state: string; events: number; units: number }} EventGroup
 * @typedef {{ metric: string; environment: string; rows: number; committed: number; reserved: number }} TotalGroup
 * @typedef {{ scanned: number; continueCursor: string; isDone: boolean; groups: unknown[] }} RawPage
 * @typedef {"eventStatus" | "totalStatus"} StatusFunction
 * @typedef {(fn: StatusFunction, paginationOpts: { numItems: number; cursor: string | null }) => Promise<unknown>} PageReader
 * @typedef {{ pages: number; scanned: number; groups: EventGroup[] }} EventStatus
 * @typedef {{ pages: number; scanned: number; groups: TotalGroup[] }} TotalStatus
 * @typedef {{ events: EventStatus; totals: TotalStatus }} Status
 * @typedef {{ metric: string; events: number; released: number; eventCommitted: number; eventReserved: number; totalCommitted: number; totalReserved: number }} MetricSums
 */

/** Inteiro seguro e não negativo; o valor recebido nunca entra na mensagem. */
export function count(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}: valor fora do contrato.`);
  return value;
}
/** Soma que falha acima de `Number.MAX_SAFE_INTEGER` em vez de arredondar. */
export function sum(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result))
    throw new Error("Soma acima de Number.MAX_SAFE_INTEGER: o recibo não seria exato.");
  return result;
}
const total = (rows, field) => rows.reduce((n, row) => sum(n, row[field]), 0);
function oneOf(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new Error(`${label}: valor fora do contrato.`);
  return value;
}
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function exactKeys(value, keys, label) {
  const names = isObject(value) ? Object.keys(value) : null;
  if (!names || names.length !== keys.length || !keys.every((key) => names.includes(key)))
    throw new Error(`${label}: formato fora do contrato.`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} raw @param {StatusFunction} fn @returns {{ scanned: number; continueCursor: string; isDone: boolean; groups: (EventGroup | TotalGroup)[] }} */
export function readPage(fn, raw) {
  const page = exactKeys(raw, ["scanned", "continueCursor", "isDone", "groups"], fn);
  if (typeof page.isDone !== "boolean" || typeof page.continueCursor !== "string")
    throw new Error(`${fn}: formato fora do contrato.`);
  if (!Array.isArray(page.groups)) throw new Error(`${fn}: formato fora do contrato.`);
  const groups = page.groups.map((value) => {
    if (fn === "eventStatus") {
      const g = exactKeys(value, ["metric", "environment", "state", "events", "units"], fn);
      return {
        metric: oneOf(g.metric, metrics, fn),
        environment: oneOf(g.environment, environments, fn),
        state: oneOf(g.state, states, fn),
        events: count(g.events, fn),
        units: count(g.units, fn),
      };
    }
    const g = exactKeys(value, ["metric", "environment", "rows", "committed", "reserved"], fn);
    return {
      metric: oneOf(g.metric, metrics, fn),
      environment: oneOf(g.environment, environments, fn),
      rows: count(g.rows, fn),
      committed: count(g.committed, fn),
      reserved: count(g.reserved, fn),
    };
  });
  return {
    scanned: count(page.scanned, fn),
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    groups,
  };
}

const deploymentName = /^(?:(?:prod|dev):)?([a-z]+-[a-z]+-\d+)$/;

/**
 * O nome do deployment, explícito: `<adjetivo>-<animal>-<n>`, com ou sem o
 * prefixo `prod:`/`dev:` de `CONVEX_DEPLOYMENT`. `prod`, `dev`, `local` e
 * referências como `dev/<pessoa>` dependem do projeto configurado no checkout,
 * então são recusados: o alvo nunca sai de um padrão implícito.
 * @param {unknown} value
 */
export function parseDeployment(value) {
  const match = typeof value === "string" ? deploymentName.exec(value) : null;
  if (!match)
    throw new Error(
      "Informe --deployment com o nome do deployment, por exemplo elated-possum-295; prod, dev, local e referências não são aceitos.",
    );
  return match[1];
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ deployment: string; out?: string; compare?: string; pageSize: number }} */
  const options = { deployment: "", pageSize: 500 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      !["--deployment", "--out", "--compare", "--page-size"].includes(flag) ||
      value === undefined
    )
      throw new Error(
        "Uso: --deployment <nome> [--out <arquivo>] [--compare <recibo>] [--page-size 1..1000].",
      );
    if (flag === "--deployment") options.deployment = parseDeployment(value);
    else if (flag === "--out") options.out = value;
    else if (flag === "--compare") options.compare = value;
    else {
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size < 1 || size > 1000)
        throw new Error("--page-size vai de 1 a 1000.");
      options.pageSize = size;
    }
  }
  if (!options.deployment) parseDeployment(undefined);
  return options;
}

/**
 * Percorre as duas queries até `isDone`, somando os grupos de cada página.
 * @param {PageReader} page
 * @returns {Promise<Status>}
 */
export async function collectStatus(page, { pageSize = 500, maxPages = 100_000 } = {}) {
  /** @param {StatusFunction} fn @param {string[]} keys @param {string[]} values */
  async function walk(fn, keys, values) {
    /** @type {Map<string, Record<string, string | number>>} */
    const groups = new Map();
    /** @type {string | null} */
    let cursor = null;
    let pages = 0;
    let scanned = 0;
    for (;;) {
      if (++pages > maxPages) throw new Error(`${fn}: mais de ${maxPages} páginas.`);
      const result = readPage(fn, await page(fn, { numItems: pageSize, cursor }));
      scanned = sum(scanned, result.scanned);
      for (const group of result.groups) {
        const key = keys.map((k) => group[k]).join(":");
        const into = groups.get(key) ?? Object.fromEntries(keys.map((k) => [k, group[k]]));
        for (const field of values) into[field] = sum(Number(into[field] ?? 0), group[field]);
        groups.set(key, into);
      }
      if (result.isDone) break;
      if (result.continueCursor === cursor) throw new Error(`${fn}: o cursor não avançou.`);
      cursor = result.continueCursor;
    }
    const sorted = [...groups.values()].sort((a, b) =>
      keys
        .map((k) => String(a[k]).localeCompare(String(b[k])))
        .reduce((order, next) => order || next, 0),
    );
    return { pages, scanned, groups: sorted };
  }
  return {
    events: /** @type {EventStatus} */ (
      await walk("eventStatus", ["metric", "environment", "state"], ["events", "units"])
    ),
    totals: /** @type {TotalStatus} */ (
      await walk("totalStatus", ["metric", "environment"], ["rows", "committed", "reserved"])
    ),
  };
}

/**
 * O que o recibo mostra de cada coleta: o legado restante e, por métrica e
 * ambiente, as unidades dos eventos ao lado das dos totais. `observedEqual` é
 * a igualdade vista nesta janela, não uma conclusão (ver `limitations`).
 * @param {Status} status
 */
export function summarize(status) {
  const legacyEvents = status.events.groups.filter((g) => g.environment === "unattributed");
  const legacyTotals = status.totals.groups.filter((g) => g.environment === "unattributed");
  const legacy = {
    events: total(legacyEvents, "events"),
    eventUnits: total(legacyEvents, "units"),
    totals: total(legacyTotals, "rows"),
    totalCommitted: total(legacyTotals, "committed"),
    totalReserved: total(legacyTotals, "reserved"),
  };
  const seen = new Set([...status.events.groups, ...status.totals.groups].map((g) => g.metric));
  const balance = [];
  /** @type {MetricSums[]} */
  const byMetric = [];
  for (const metric of metrics.filter((m) => seen.has(m))) {
    const sums = {
      metric,
      events: 0,
      released: 0,
      eventCommitted: 0,
      eventReserved: 0,
      totalCommitted: 0,
      totalReserved: 0,
    };
    for (const environment of environments) {
      const events = status.events.groups.filter(
        (g) => g.metric === metric && g.environment === environment,
      );
      const rows = status.totals.groups.filter(
        (g) => g.metric === metric && g.environment === environment,
      );
      if (!events.length && !rows.length) continue;
      const inState = (state) => events.filter((g) => g.state === state);
      const row = {
        metric,
        environment,
        eventCommitted: total(inState("committed"), "units"),
        eventReserved: total(inState("reserved"), "units"),
        totalCommitted: total(rows, "committed"),
        totalReserved: total(rows, "reserved"),
      };
      balance.push({
        ...row,
        observedEqual:
          row.eventCommitted === row.totalCommitted && row.eventReserved === row.totalReserved,
      });
      sums.events = sum(sums.events, total(events, "events"));
      sums.released = sum(sums.released, total(inState("released"), "events"));
      for (const field of ["eventCommitted", "eventReserved", "totalCommitted", "totalReserved"])
        sums[field] = sum(sums[field], row[field]);
    }
    byMetric.push(sums);
  }
  return {
    legacy,
    observedZeroLegacy: Object.values(legacy).every((n) => n === 0),
    balance,
    byMetric,
  };
}

const metricFields = [
  "events",
  "released",
  "eventCommitted",
  "eventReserved",
  "totalCommitted",
  "totalReserved",
];
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Um recibo anterior, de `--compare`, reduzido ao que a comparação usa e
 * validado como a resposta da CLI. Nem o erro de parse nem um valor fora do
 * contrato aparecem na mensagem: o arquivo pode não ser o que se espera.
 * @param {string} text
 * @returns {{ deployment: string; finishedAt: string | null; byMetric: MetricSums[] }}
 */
export function readReceipt(text) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("--compare: o arquivo não é um recibo JSON deste script.");
  }
  const fail = () => {
    throw new Error("--compare: o arquivo não é um recibo deste script.");
  };
  if (!isObject(value) || value.type !== "usage_migration_status" || value.version !== 1) fail();
  const receipt = /** @type {Record<string, unknown>} */ (value);
  if (typeof receipt.deployment !== "string" || !deploymentName.test(receipt.deployment)) fail();
  if (!Array.isArray(receipt.byMetric)) fail();
  const byMetric = /** @type {unknown[]} */ (receipt.byMetric).map((raw) => {
    const row = exactKeys(raw, ["metric", ...metricFields], "--compare");
    return /** @type {MetricSums} */ ({
      metric: oneOf(row.metric, metrics, "--compare"),
      ...Object.fromEntries(metricFields.map((f) => [f, count(row[f], "--compare")])),
    });
  });
  if (new Set(byMetric.map((row) => row.metric)).size !== byMetric.length) fail();
  return {
    deployment: parseDeployment(receipt.deployment),
    finishedAt:
      typeof receipt.finishedAt === "string" && isoInstant.test(receipt.finishedAt)
        ? receipt.finishedAt
        : null,
    byMetric,
  };
}

/**
 * Diferenças por métrica entre dois recibos, somando os ambientes: a
 * atribuição move unidades entre ambientes, mas não deveria mudar a contagem
 * de eventos nem as unidades da métrica. Sem tráfego entre os recibos, toda
 * diferença pede investigação; com tráfego, ela é esperada.
 * @param {{ deployment?: string; finishedAt?: string | null; byMetric: MetricSums[] }} before
 * @param {{ byMetric: MetricSums[] }} after
 */
export function compareReceipts(before, after) {
  const index = (/** @type {MetricSums[]} */ rows) => new Map(rows.map((row) => [row.metric, row]));
  const a = index(before.byMetric);
  const b = index(after.byMetric);
  const differences = [];
  for (const metric of metrics.filter((m) => a.has(m) || b.has(m)))
    for (const field of metricFields) {
      const from = a.get(metric)?.[field] ?? 0;
      const to = b.get(metric)?.[field] ?? 0;
      if (from !== to) differences.push({ metric, field, before: from, after: to });
    }
  return {
    before: { deployment: before.deployment ?? null, finishedAt: before.finishedAt ?? null },
    differences,
    observedEqual: differences.length === 0,
  };
}

/**
 * Recibo completo de uma coleta.
 * @param {{ deployment: string; localCheckout: { commit: string | null; dirty: boolean | null }; startedAt: string; finishedAt: string; status: Status }} input
 */
export function receipt({ deployment, localCheckout, startedAt, finishedAt, status }) {
  return {
    type: "usage_migration_status",
    version: 1,
    deployment,
    localCheckout,
    startedAt,
    finishedAt,
    pages: { events: status.events.pages, totals: status.totals.pages },
    scanned: { events: status.events.scanned, totals: status.totals.scanned },
    events: status.events.groups,
    totals: status.totals.groups,
    ...summarize(status),
    limitations,
  };
}

/** O commit e se há alteração no checkout local, rotulados como tais. */
export function localCheckout(root, run = spawnSync) {
  const git = (args) =>
    run("git", args, { cwd: root, encoding: "utf8", env: subprocessEnvironment(process.env) });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const commit = head.status === 0 ? String(head.stdout).trim() : "";
  return {
    commit: /^[a-f0-9]{40}$/.test(commit) ? commit : null,
    dirty: status.status === 0 ? String(status.stdout).trim().length > 0 : null,
  };
}

/**
 * Uma página pela CLI oficial do Convex (`convex run --deployment <nome>`,
 * conferido no `--help` da 1.48), em `platform/`. O ambiente do processo leva
 * só caminhos de runtime: nenhuma `CONVEX_DEPLOY_KEY` nem `CONVEX_DEPLOYMENT`
 * herdada escolhe outro alvo, e a CLI usa o login da pessoa.
 * `--codegen disable` e `--typecheck disable` impedem que a leitura regrave
 * `_generated/`; sem `--push`, nada é publicado. A saída da CLI não é
 * repetida: o JSON vai a `readPage`, e o erro vira uma mensagem fixa.
 * @returns {PageReader}
 */
export function convexPage(root, deployment, run = spawnSync) {
  const name = parseDeployment(deployment);
  return async (fn, paginationOpts) => {
    const result = run(
      process.execPath,
      [
        join(root, "node_modules", "convex", "bin", "main.js"),
        "run",
        `usageMigration:${fn}`,
        JSON.stringify({ paginationOpts }),
        "--deployment",
        name,
        "--codegen",
        "disable",
        "--typecheck",
        "disable",
      ],
      {
        cwd: join(root, "platform"),
        encoding: "utf8",
        env: subprocessEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `convex run usageMigration:${fn} falhou. Confira o login com \`bunx convex login\` e o nome do deployment; a saída da CLI não é repetida aqui.`,
      );
    try {
      return JSON.parse(String(result.stdout));
    } catch {
      throw new Error(`convex run usageMigration:${fn} não devolveu JSON.`);
    }
  };
}
