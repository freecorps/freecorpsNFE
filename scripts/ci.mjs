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
import { fileURLToPath } from "node:url";
import { revision, sanitizeReport, testEnvironment, publicationSha } from "./lib/ci.mjs";
import { acquireValidationLock, VALIDATION_LOCK_TOKEN } from "./lib/validation-lock.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, ".ci-results");
const requestedCommand = process.argv[2];
let release;
let retainLock = false;
try {
  if (
    !["identity", "test", "identity-test", "summary", "approve", "gate"].includes(requestedCommand)
  )
    throw new Error("Usage: ci.mjs identity|test|identity-test|summary|approve|gate");
  if (["identity", "test", "identity-test", "summary"].includes(requestedCommand))
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
      rmSync(join(output, "tests.json"), { force: true });
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
      const metadata = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
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
            "--maxWorkers=3",
            "--testTimeout=60000",
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${rawFile}`,
          ],
          { cwd: root, env: testEnvironment(process.env), stdio: "inherit" },
        );
        retainLock = Boolean(result.signal || result.error || result.status === null);
        const raw = existsSync(rawFile) ? JSON.parse(readFileSync(rawFile, "utf8")) : {};
        const report = sanitizeReport(raw, root, metadata, result.status ?? 1);
        writeFileSync(join(output, "tests.json"), `${JSON.stringify(report, null, 2)}\n`);
        if (report.result !== "passed") process.exitCode = 1;
      } finally {
        rmSync(rawFile, { force: true });
        rmdirSync(temporary);
      }
    } else if (command === "approve") {
      const data = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
      const report = JSON.parse(readFileSync(join(output, "tests.json"), "utf8"));
      if (report.result !== "passed" || data.checkedSha !== report.revision.checkedSha)
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
