import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  rmdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedTests,
  areaReceipt,
  collectTests,
  pendingBudget,
  revision,
  sanitizeReport,
  testEnvironment,
  publicationSha,
  withinPendingBudget,
} from "../lib/ci.mjs";
import { areaFiles, areaProjects, testProjects } from "../lib/test-projects.mjs";
import { acquireValidationLock, VALIDATION_LOCK_TOKEN } from "../lib/validation-lock.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const output = join(root, ".ci-results");
// Um recibo por área de testes, gravado por `test-area` e guardado no cache
// do Vite Task como saída da tarefa ci:test:<área>.
const areaOutput = join(output, "tests");
const requestedCommand = process.argv[2];
const usage =
  "Usage: ci.mjs identity|test|identity-test|test-area <área>|collect-tests [--skip <área,...>]|summary|approve|gate";
let release;
let retainLock = false;

/**
 * Limite por teste no CI: 60 s, ou o do projeto quando ele pede mais, como o
 * `benchmark`. A opção de linha de comando sobrepõe o `testTimeout` de cada
 * projeto, então ela não pode ficar abaixo do maior deles.
 */
const ciTimeout = (projects) => Math.max(60_000, ...projects.map(({ timeout }) => timeout));

/**
 * `vp test run` com relatório JSON numa pasta temporária. Devolve o JSON bruto
 * e o código de saída; o bruto nunca vai para `.ci-results`.
 */
function runVitest(args, timeout) {
  const temporary = mkdtempSync(join(tmpdir(), "fnfe-ci-"));
  const rawFile = join(temporary, "vitest.json");
  try {
    retainLock = true;
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vite-plus/bin/vp"),
        "test",
        "run",
        ...args,
        `--testTimeout=${timeout}`,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${rawFile}`,
      ],
      { cwd: root, env: testEnvironment(process.env), stdio: "inherit" },
    );
    retainLock = Boolean(result.signal || result.error || result.status === null);
    const raw = existsSync(rawFile) ? JSON.parse(readFileSync(rawFile, "utf8")) : {};
    return { raw, status: result.status ?? 1 };
  } finally {
    rmSync(rawFile, { force: true });
    rmdirSync(temporary);
  }
}

try {
  if (
    ![
      "identity",
      "test",
      "identity-test",
      "test-area",
      "collect-tests",
      "summary",
      "approve",
      "gate",
    ].includes(requestedCommand)
  )
    throw new Error(usage);
  if (["identity", "test", "identity-test", "collect-tests", "summary"].includes(requestedCommand))
    release = acquireValidationLock(root, process.env[VALIDATION_LOCK_TOKEN]);
  // As áreas rodam lado a lado no grafo: nenhuma toma a trava para si, e só
  // participam da posse de quem já a tem (ci:local e ci:prove passam o token).
  // ci:tests, que junta os recibos, a toma como a suíte inteira tomava.
  if (requestedCommand === "test-area" && process.env[VALIDATION_LOCK_TOKEN] !== undefined)
    release = acquireValidationLock(root, process.env[VALIDATION_LOCK_TOKEN]);
  mkdirSync(output, { recursive: true });
  // ci:test mantém identidade e testes sob a mesma posse, sem intervalo entre
  // dois processos. A task ci:tests continua entrando diretamente por `test`.
  for (const command of requestedCommand === "identity-test"
    ? ["identity", "test"]
    : [requestedCommand]) {
    if (command === "gate") {
      const sha = publicationSha(process.env, process.env.CI_TESTED_SHA);
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `publication_sha=${sha}\n`);
      console.log(
        sha
          ? `Validated integration revision: ${sha}`
          : "No validation publication revision issued",
      );
    } else if (command === "identity") {
      // Nada de uma validação anterior conta para esta: só o grafo que vem
      // depois grava (ou restaura do cache) os recibos das áreas.
      rmSync(join(output, "tests.json"), { force: true });
      rmSync(areaOutput, { recursive: true, force: true });
      // As provas dos Workers gravam em .browser-results durante o grafo, e o
      // Vite Task registra a listagem da raiz: criada antes, a pasta já está
      // nela em todo checkout novo, e a tarefa que lista a raiz repete o cache.
      mkdirSync(join(root, ".browser-results"), { recursive: true });
      const checked = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const event = process.env.GITHUB_EVENT_PATH
        ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
        : {};
      const data = revision(process.env, event, checked);
      if (process.env.GITHUB_ACTIONS !== "true") {
        data.workingTree = {
          dirty: Boolean(
            execFileSync("git", ["status", "--porcelain"], {
              cwd: root,
              encoding: "utf8",
            }).trim(),
          ),
        };
      }
      writeFileSync(join(output, "revision.json"), `${JSON.stringify(data, null, 2)}\n`);
      console.log(JSON.stringify(data));
    } else if (command === "test") {
      // A suíte inteira num processo (`bun run ci:test`); o grafo usa test-area.
      const metadata = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
      const { raw, status } = runVitest(["--maxWorkers=3"], ciTimeout(testProjects));
      const report = sanitizeReport(raw, root, metadata, status);
      writeFileSync(join(output, "tests.json"), `${JSON.stringify(report, null, 2)}\n`);
      if (report.result !== "passed") process.exitCode = 1;
    } else if (command === "test-area") {
      const area = process.argv[3];
      if (!testProjects.some(({ name }) => name === area)) throw new Error(usage);
      const receipt = join(areaOutput, `${area}.json`);
      // Um recibo antigo nunca sobrevive a uma execução interrompida.
      rmSync(receipt, { force: true });
      const workers = process.env.VITEST_MAX_WORKERS?.trim() || "3";
      const { raw, status } = runVitest(
        [...areaProjects(area).flatMap((name) => ["--project", name]), `--maxWorkers=${workers}`],
        ciTimeout(testProjects.filter(({ name }) => name === area)),
      );
      const report = areaReceipt(raw, root, area, status, process.env);
      mkdirSync(areaOutput, { recursive: true });
      writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`);
      if (report.result !== "passed") process.exitCode = 1;
    } else if (command === "collect-tests") {
      // `--skip a,b`: áreas que o grafo reduzido não executou (vite.config.ts,
      // CI_VALIDATE_SKIP).
      const args = process.argv.slice(3);
      if (args.length && (args.length !== 2 || args[0] !== "--skip" || !args[1]))
        throw new Error(usage);
      const skipped = args.length ? args[1].split(",") : [];
      const metadata = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
      const receipts = {};
      const expected = {};
      for (const { name } of testProjects) {
        const file = join(areaOutput, `${name}.json`);
        if (existsSync(file)) receipts[name] = JSON.parse(readFileSync(file, "utf8"));
        expected[name] = areaFiles(name).length;
      }
      const report = collectTests(metadata, receipts, expected, process.env, skipped);
      writeFileSync(join(output, "tests.json"), `${JSON.stringify(report, null, 2)}\n`);
      for (const [name, area] of Object.entries(report.areas))
        console.log(
          `${name}: ${area.result}` +
            (area.result === "missing" || area.result === "skipped"
              ? ""
              : `, ${area.files} arquivos, ${area.passed} testes, ${area.pending} pendentes`) +
            (area.files !== undefined && !withinPendingBudget(name, area.pending, process.env)
              ? ` (acima do teto de ${pendingBudget[name]?.max ?? 0} pendentes no CI)`
              : "") +
            (area.ranOn?.sha && area.ranOn.sha !== metadata.checkedSha
              ? ` (repetido do run ${area.ranOn.runId}, que testou ${area.ranOn.sha.slice(0, 12)})`
              : ""),
        );
      if (report.result !== "passed") process.exitCode = 1;
    } else if (command === "approve") {
      const data = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
      const report = JSON.parse(readFileSync(join(output, "tests.json"), "utf8"));
      if (!approvedTests(data, report))
        throw new Error("No successful test receipt for this checkout");
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `tested_sha=${data.checkedSha}\n`);
    } else {
      const data = existsSync(join(output, "revision.json"))
        ? JSON.parse(readFileSync(join(output, "revision.json"), "utf8"))
        : null;
      const report = existsSync(join(output, "tests.json"))
        ? JSON.parse(readFileSync(join(output, "tests.json"), "utf8"))
        : null;
      const matrix = JSON.parse(readFileSync(join(root, "tests/coverage-matrix.json"), "utf8"));
      const revisionLabel = data?.workingTree ? "HEAD de referência local" : "Checkout testado";
      const localNote = data?.workingTree
        ? `Alterações locais no início: ${data.workingTree.dirty ? "sim" : "não"}. Este relatório de testes não é uma prova de commit.\n\n`
        : "";
      let summary = `# Validação da revisão\n\n${revisionLabel}: \`${data?.checkedSha ?? "não identificado"}\`\n\n${localNote}Head do PR: \`${data?.headSha ?? "não identificado"}\`\n\nTipo: ${data?.kind ?? "não identificado"}; Draft: ${data?.draft ?? false}\n\nTestes: ${report?.result ?? "não executados"}. Builds e checks: consultar os steps do job.\n\n| Suíte | Arquivos | Passaram | Falharam | Pendentes |\n| --- | --- | --- | --- | --- |\n`;
      for (const [name, counts] of Object.entries(report?.suites ?? {}))
        summary += `| ${name} | ${counts.files} | ${counts.passed} | ${counts.failed} | ${counts.pending} |\n`;
      if (report?.areas) {
        summary += `\n| Área | Resultado | Arquivos | Testes | Pendentes (teto no CI) | Origem |\n| --- | --- | --- | --- | --- | --- |\n`;
        for (const [name, area] of Object.entries(report.areas)) {
          const origin =
            area.result === "skipped"
              ? "pulada: a mudança não alcança a área"
              : area.result === "missing"
                ? "sem recibo"
                : !area.ranOn
                  ? "fora do Actions"
                  : area.ranOn.sha === data?.checkedSha
                    ? "executada neste checkout"
                    : `repetida do cache: run ${area.ranOn.runId}, \`${area.ranOn.sha.slice(0, 12)}\``;
          summary += `| ${name} | ${area.result} | ${area.files ?? 0} | ${area.passed ?? 0} | ${area.pending ?? 0} (${pendingBudget[name]?.max ?? 0}) | ${origin} |\n`;
        }
      }
      if (process.env.CI_CHANGES_MODE === "docs")
        summary += `\nSó documentação mudou: o job conferiu formatação e credenciais e não executou o grafo \`validate\`; nenhum \`tested_sha\` foi emitido.\n`;
      if (process.env.CI_CHANGES_MODE === "affected") {
        const skippedTasks = (process.env.CI_VALIDATE_SKIP ?? "").split(",").filter(Boolean);
        const list = skippedTasks.map((task) => `\`${task}\``).join(", ");
        summary += `\nA mudança não alcança os workspaces que ${list} provam: o grafo \`validate\` rodou sem essas tarefas, e nenhum \`tested_sha\` foi emitido.\n`;
      }
      summary += `\n## Cobertura progressiva da 1.0\n\n${matrix.modules.map((m) => `- ${m.id}: ${m.status}`).join("\n")}\n\nTestes remotos e fiscais reais não fazem parte deste CI.\n`;
      writeFileSync(join(output, "summary.md"), summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      else console.log(summary);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "CI failed");
  process.exitCode = 1;
} finally {
  if (!retainLock) release?.();
}
