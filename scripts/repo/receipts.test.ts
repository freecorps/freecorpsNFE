import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * Provas operacionais que dependem de gente repetir o trabalho (#127): cada
 * uma tem uma entrada em `deploy/receipts.json` com dono, cadência, caminhos
 * de risco e o último recibo. Este teste reprova o que é erro de registro
 * (recibo ausente, SHA-256 divergente, formato desconhecido, `codeSha` fora da
 * história do HEAD, entrada malformada) e só avisa o que é prazo: recibo
 * vencido, ainda inexistente ou anterior a uma mudança nos `riskPaths`. O
 * aviso não reprova: a prova depende de uma pessoa, não da PR.
 *
 * "Agora" é a data do commit testado, não o relógio da máquina: na PR, o
 * commit de merge que o GitHub cria para o run. O procedimento está em
 * docs/operacao/recibos.md.
 */

export const tablePath = "deploy/receipts.json";
const issuanceProductionPath = "deploy/issuance-production.json";

/** Quando a prova é exigida. `issuanceProduction`: só com deployment de produção da emissão. */
const applicability = ["always", "issuanceProduction"] as const;
const DAY = 24 * 60 * 60 * 1000;

const entryKeys = [
  "id",
  "title",
  "issue",
  "owner",
  "everyDays",
  "riskPaths",
  "applicableWhen",
  "last",
];
const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const issue = /^[\w.-]+\/[\w.-]+#\d+$/;
const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const runUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
// ISO 8601 em UTC, com ou sem segundos e milissegundos.
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

type Proof = { provedAt: Date; codeSha: string };
export type ReceiptStatus = { problems: string[]; warnings: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const date = (value: Date) => value.toISOString().slice(0, 10).split("-").reverse().join("/");
const validInstant = (value: unknown): value is string =>
  typeof value === "string" && instant.test(value) && !Number.isNaN(Date.parse(value));

function git(root: string, args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

/**
 * Formato 1 de um recibo em arquivo: JSON com `version`, `receipt` (o `id` da
 * entrada), `provedAt`, `codeSha` e `result: "passed"`. O resto do arquivo é a
 * evidência, livre por prova.
 */
function receiptFile(root: string, entryId: string, last: Record<string, unknown>): Proof | string {
  const { path, sha256: expected } = last;
  const extra = Object.keys(last).filter((key) => !["path", "sha256"].includes(key));
  if (
    extra.length > 0 ||
    typeof path !== "string" ||
    typeof expected !== "string" ||
    !sha256.test(expected)
  )
    return "`last` em arquivo precisa só de `path` e `sha256` com 64 dígitos hexadecimais";
  const file = join(root, path);
  if (!existsSync(file)) return `recibo ausente: ${path}`;
  const bytes = readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) return `SHA-256 de ${path} é ${actual}, a tabela diz ${expected}`;
  let receipt: unknown;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    return `formato desconhecido em ${path}: não é JSON`;
  }
  if (
    !isObject(receipt) ||
    receipt.version !== 1 ||
    receipt.receipt !== entryId ||
    !validInstant(receipt.provedAt) ||
    typeof receipt.codeSha !== "string" ||
    !commit.test(receipt.codeSha) ||
    receipt.result !== "passed"
  )
    return `formato desconhecido em ${path}: esperado version 1, receipt "${entryId}", provedAt em UTC, codeSha com 40 dígitos e result "passed"`;
  return { provedAt: new Date(receipt.provedAt), codeSha: receipt.codeSha };
}

/** Um run de workflow como recibo: a tabela guarda o run, a data e o commit. */
function receiptRun(last: Record<string, unknown>): Proof | string {
  const extra = Object.keys(last).filter((key) => !["run", "provedAt", "codeSha"].includes(key));
  if (
    extra.length > 0 ||
    typeof last.run !== "string" ||
    !runUrl.test(last.run) ||
    !validInstant(last.provedAt) ||
    typeof last.codeSha !== "string" ||
    !commit.test(last.codeSha)
  )
    return "`last` de run precisa só de `run` (URL do run no GitHub), `provedAt` em UTC e `codeSha` com 40 dígitos";
  return { provedAt: new Date(last.provedAt), codeSha: last.codeSha };
}

function issuanceProductionNamed(root: string): boolean | string {
  try {
    const plan: unknown = JSON.parse(readFileSync(join(root, issuanceProductionPath), "utf8"));
    if (!isObject(plan) || !("deployment" in plan)) throw new Error();
    return plan.deployment !== null;
  } catch {
    return `${issuanceProductionPath} ilegível ou sem \`deployment\``;
  }
}

/** Confere a tabela de `root` contra o HEAD de `root`, com `now` como data de referência. */
export function checkReceipts(root: string, now: Date): ReceiptStatus {
  const problems: string[] = [];
  const warnings: string[] = [];
  let table: unknown;
  try {
    table = JSON.parse(readFileSync(join(root, tablePath), "utf8"));
  } catch {
    return { problems: [`${tablePath} ausente ou não é JSON`], warnings };
  }
  if (!isObject(table) || table.version !== 1 || !Array.isArray(table.receipts))
    return { problems: [`${tablePath}: esperado { "version": 1, "receipts": [...] }`], warnings };

  const seen = new Set<string>();
  for (const [index, entry] of table.receipts.entries()) {
    const name = isObject(entry) && typeof entry.id === "string" ? entry.id : `#${index}`;
    const problem = (text: string) => problems.push(`${name}: ${text}`);
    if (!isObject(entry)) {
      problem("entrada não é objeto");
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !entryKeys.includes(key));
    if (unknown.length > 0) problem(`campos desconhecidos: ${unknown.join(", ")}`);
    if (typeof entry.id !== "string" || !id.test(entry.id))
      problem("`id` em minúsculas, com hífens");
    else if (seen.has(entry.id)) problem("`id` repetido");
    else seen.add(entry.id);
    if (typeof entry.title !== "string" || entry.title.trim() === "") problem("sem `title`");
    if (typeof entry.issue !== "string" || !issue.test(entry.issue))
      problem("`issue` no formato dono/repositório#número");
    if (typeof entry.owner !== "string" || !login.test(entry.owner))
      problem("`owner` precisa ser um login do GitHub");
    const everyDays = entry.everyDays;
    if (typeof everyDays !== "number" || !Number.isInteger(everyDays) || everyDays < 1)
      problem("`everyDays` inteiro positivo");
    const riskPaths = entry.riskPaths;
    if (
      !Array.isArray(riskPaths) ||
      riskPaths.length === 0 ||
      !riskPaths.every((path) => typeof path === "string" && path !== "")
    )
      problem("`riskPaths` precisa listar ao menos um caminho");
    else
      for (const path of riskPaths as string[])
        if (!existsSync(join(root, path))) problem(`riskPath inexistente: ${path}`);
    if (!applicability.includes(entry.applicableWhen as (typeof applicability)[number]))
      problem(`\`applicableWhen\` em ${applicability.join(" ou ")}`);

    let proof: Proof | undefined;
    if (entry.last !== null) {
      const result = !isObject(entry.last)
        ? "`last` é null, um recibo em arquivo ou um run"
        : "run" in entry.last
          ? receiptRun(entry.last)
          : receiptFile(root, name, entry.last);
      if (typeof result === "string") problem(result);
      else {
        const ancestry = git(root, ["merge-base", "--is-ancestor", result.codeSha, "HEAD"]);
        if (ancestry.status === 0) proof = result;
        else if (ancestry.status === 1)
          problem(`codeSha ${result.codeSha} fora da história do HEAD`);
        else problem(`codeSha ${result.codeSha} não é um commit deste repositório`);
      }
    }

    let applicable = entry.applicableWhen === "always";
    if (entry.applicableWhen === "issuanceProduction") {
      const named = issuanceProductionNamed(root);
      if (typeof named === "string") problem(named);
      else applicable = named;
    }
    if (!applicable || problems.some((text) => text.startsWith(`${name}: `))) continue;

    const owner = `dono ${entry.owner}, ${entry.issue}`;
    if (entry.last === null) {
      warnings.push(`${name}: sem recibo registrado (${owner})`);
      continue;
    }
    if (!proof) continue;
    const dueAt = new Date(proof.provedAt.getTime() + (everyDays as number) * DAY);
    if (now.getTime() > dueAt.getTime())
      warnings.push(
        `${name}: o recibo de ${date(proof.provedAt)} venceu em ${date(dueAt)}, a cada ${everyDays as number} dias (${owner})`,
      );
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", proof.codeSha, "HEAD", "--", ...(riskPaths as string[])],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    if (changed.length > 0)
      warnings.push(
        `${name}: ${changed.join(", ")} ${changed.length === 1 ? "mudou" : "mudaram"} desde o recibo (${proof.codeSha.slice(0, 7)}); refaça a prova (${owner})`,
      );
  }
  return { problems, warnings };
}

describe("checkReceipts", () => {
  const provedAt = "2026-11-01T12:00:00Z";
  const clean = new Date("2026-11-10T00:00:00Z");

  /** Repositório descartável com um commit da prova e outro que registra o recibo. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "receipts-"));
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    const run = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Teste",
          "-c",
          "user.email=teste@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.autocrlf=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8" },
      ).trim();
    const commitAll = (message: string) => {
      run("add", "-A");
      run("commit", "--quiet", "-m", message);
      return run("rev-parse", "HEAD");
    };
    run("init", "--quiet");
    write(issuanceProductionPath, JSON.stringify({ version: 1, deployment: null }));
    write("src/risk.ts", "export const a = 1;\n");
    write("src/other.ts", "export const b = 1;\n");
    const codeSha = commitAll("prova");
    const receipt = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        version: 1,
        receipt: "proof",
        provedAt,
        codeSha,
        result: "passed",
        ...overrides,
      });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const entry = (overrides: Record<string, unknown> = {}) => ({
      id: "proof",
      title: "Prova",
      issue: "freecorps/freecorpsNFE#1",
      owner: "dono-1",
      everyDays: 30,
      riskPaths: ["src/risk.ts"],
      applicableWhen: "always",
      last: { path: "evidence/proof.json", sha256: hash(receipt()) },
      ...overrides,
    });
    const table = (...entries: unknown[]) =>
      write(tablePath, JSON.stringify({ version: 1, receipts: entries }));
    write("evidence/proof.json", receipt());
    table(entry());
    commitAll("registra o recibo");
    return { root, write, run, commitAll, codeSha, receipt, hash, entry, table };
  }

  function withFixture(test: (repo: ReturnType<typeof fixture>) => void) {
    const repo = fixture();
    try {
      test(repo);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }

  it("accepts a valid receipt without warnings inside its period", () =>
    withFixture(({ root }) => {
      expect(checkReceipts(root, clean)).toEqual({ problems: [], warnings: [] });
    }));

  it("rejects a missing receipt, a wrong SHA-256 and an unknown format", () =>
    withFixture(({ root, write, entry, table, receipt, hash }) => {
      table(entry({ last: { path: "evidence/none.json", sha256: hash("x") } }));
      expect(checkReceipts(root, clean).problems).toEqual([
        "proof: recibo ausente: evidence/none.json",
      ]);

      table(entry({ last: { path: "evidence/proof.json", sha256: hash("outro") } }));
      expect(checkReceipts(root, clean).problems).toEqual([
        expect.stringMatching(/^proof: SHA-256 de evidence\/proof\.json é [0-9a-f]{64}, a tabela/),
      ]);

      for (const text of [
        "não é JSON",
        receipt({ receipt: "outra-prova" }),
        receipt({ codeSha: "abc" }),
        receipt({ provedAt: "01/11/2026" }),
        receipt({ result: "failed" }),
        receipt({ version: 2 }),
      ]) {
        write("evidence/odd.json", text);
        table(entry({ last: { path: "evidence/odd.json", sha256: hash(text) } }));
        expect(checkReceipts(root, clean).problems, text).toEqual([
          expect.stringMatching(/^proof: formato desconhecido em evidence\/odd\.json/),
        ]);
      }
    }));

  it("rejects a codeSha outside the history of HEAD", () =>
    withFixture(({ root, run, write, entry, table, receipt, hash }) => {
      // Um commit que existe no repositório, mas fora da história do HEAD.
      const orphan = run("commit-tree", "HEAD^{tree}", "-m", "fora");
      const outside = receipt({ codeSha: orphan });
      write("evidence/outside.json", outside);
      table(entry({ last: { path: "evidence/outside.json", sha256: hash(outside) } }));
      expect(checkReceipts(root, clean).problems).toEqual([
        `proof: codeSha ${orphan} fora da história do HEAD`,
      ]);

      const unknown = "0".repeat(40);
      table(
        entry({
          last: { run: "https://github.com/o/r/actions/runs/1", provedAt, codeSha: unknown },
        }),
      );
      expect(checkReceipts(root, clean).problems).toEqual([
        `proof: codeSha ${unknown} não é um commit deste repositório`,
      ]);
    }));

  it("accepts a workflow run as the receipt", () =>
    withFixture(({ root, entry, table, codeSha }) => {
      table(entry({ last: { run: "https://github.com/o/r/actions/runs/42", provedAt, codeSha } }));
      expect(checkReceipts(root, clean)).toEqual({ problems: [], warnings: [] });
      table(entry({ last: { run: "https://example.com/runs/42", provedAt, codeSha } }));
      expect(checkReceipts(root, clean).problems).toHaveLength(1);
    }));

  it("warns, with a simulated clock, once the period has passed", () =>
    withFixture(({ root }) => {
      // 30 dias depois de 01/11 às 12:00 UTC.
      expect(checkReceipts(root, new Date("2026-12-01T12:00:00Z")).warnings).toEqual([]);
      expect(checkReceipts(root, new Date("2026-12-01T12:00:01Z"))).toEqual({
        problems: [],
        warnings: [
          "proof: o recibo de 01/11/2026 venceu em 01/12/2026, a cada 30 dias (dono dono-1, freecorps/freecorpsNFE#1)",
        ],
      });
    }));

  it("warns when a risk path changed after the proved commit, and only then", () =>
    withFixture(({ root, write, commitAll, codeSha }) => {
      write("src/other.ts", "export const b = 2;\n");
      commitAll("outro arquivo");
      expect(checkReceipts(root, clean).warnings).toEqual([]);
      write("src/risk.ts", "export const a = 2;\n");
      commitAll("muda o risco");
      expect(checkReceipts(root, clean).warnings).toEqual([
        `proof: src/risk.ts mudou desde o recibo (${codeSha.slice(0, 7)}); refaça a prova (dono dono-1, freecorps/freecorpsNFE#1)`,
      ]);
    }));

  it("asks for a receipt only while the proof applies", () =>
    withFixture(({ root, write, entry, table }) => {
      table(entry({ last: null }));
      expect(checkReceipts(root, clean).warnings).toEqual([
        "proof: sem recibo registrado (dono dono-1, freecorps/freecorpsNFE#1)",
      ]);
      table(entry({ last: null, applicableWhen: "issuanceProduction" }));
      expect(checkReceipts(root, clean)).toEqual({ problems: [], warnings: [] });
      write(issuanceProductionPath, JSON.stringify({ version: 1, deployment: "prod-x" }));
      expect(checkReceipts(root, clean).warnings).toEqual([
        "proof: sem recibo registrado (dono dono-1, freecorps/freecorpsNFE#1)",
      ]);
    }));

  it("rejects a malformed entry", () =>
    withFixture(({ root, entry, table }) => {
      table(
        entry({ everydays: 30 }),
        entry({
          id: "Prova",
          everyDays: 0,
          owner: "",
          issue: "#1",
          applicableWhen: "nunca",
          last: null,
        }),
        entry({ id: "outra", riskPaths: ["src/sumiu.ts"], last: { path: 1 } }),
        entry(),
      );
      expect(checkReceipts(root, clean).problems).toEqual([
        "proof: campos desconhecidos: everydays",
        "Prova: `id` em minúsculas, com hífens",
        "Prova: `issue` no formato dono/repositório#número",
        "Prova: `owner` precisa ser um login do GitHub",
        "Prova: `everyDays` inteiro positivo",
        "Prova: `applicableWhen` em always ou issuanceProduction",
        "outra: riskPath inexistente: src/sumiu.ts",
        "outra: `last` em arquivo precisa só de `path` e `sha256` com 64 dígitos hexadecimais",
        "proof: `id` repetido",
      ]);
    }));
});

it("keeps deploy/receipts.json valid and reports what is due", () => {
  // A data do commit testado, não o relógio da máquina.
  const now = new Date(
    execFileSync("git", ["log", "-1", "--format=%cI", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
  );
  const { problems, warnings } = checkReceipts(repoRoot, now);
  // O GitHub Actions mostra `::warning::` como anotação no run. A quebra
  // inicial tira a primeira linha de depois do cabeçalho do Vitest, que o
  // GitHub não leria como comando.
  if (warnings.length > 0)
    console.warn(
      warnings
        .map((warning) =>
          process.env.GITHUB_ACTIONS === "true"
            ? `
::warning title=Recibo operacional::${warning}`
            : `
Recibo operacional: ${warning}`,
        )
        .join(""),
    );
  expect(problems).toEqual([]);
});
