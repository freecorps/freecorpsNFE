// Primeiro passo do job Validate: decide se a PR só muda documentação
// (`mode=docs`) ou roda o grafo (`mode=graph`), e se o grafo usa o cache do
// Vite Task (`cache=true|false`). Regras em scripts/lib/ci-changes.mjs. Não
// precisa de `vp install`. Qualquer falha ao comparar roda o grafo.
//
//   node scripts/ci/ci-changes.mjs          # no job: lê o evento e o checkout
//   node scripts/ci/ci-changes.mjs --tests  # os testes do modo docs, um por linha
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { cacheAllowed, changeMode, documentationTests } from "../lib/ci-changes.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

if (process.argv[2] === "--tests") {
  console.log(documentationTests.join("\n"));
  process.exit(0);
}

const root = repoRoot;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * O que a PR muda: o merge sintético contra o primeiro pai, que é a base. Conta
 * os dois lados de uma renomeação; uma renomeação entra também como remoção.
 * `null` se o checkout não é um merge ou o histórico não está nele.
 */
function changes() {
  try {
    git("rev-parse", "--verify", "--quiet", "HEAD^2");
    const entries = git("diff", "--name-status", "--no-renames", "-z", "HEAD^1", "HEAD")
      .split("\0")
      .filter(Boolean);
    const files = [];
    const deleted = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      files.push(entries[index + 1]);
      if (entries[index] === "D") deleted.push(entries[index + 1]);
    }
    return { files, deleted };
  } catch {
    return { files: null, deleted: [] };
  }
}

const eventName = process.env.GITHUB_EVENT_NAME;
let decision;
try {
  decision = changeMode({
    eventName,
    ...(eventName === "pull_request" ? changes() : { files: null }),
  });
} catch (error) {
  decision = { mode: "graph", reason: `classificação falhou (${String(error)}): o grafo roda` };
}
const cache = decision.mode === "graph" && cacheAllowed(process.env);
const lines = [
  `### Mudança: ${decision.mode === "docs" ? "só documentação" : "grafo validate"}`,
  "",
  decision.reason,
  "",
  decision.mode === "docs"
    ? `Roda \`vp fmt --check\`, \`ci:secrets\` e ${documentationTests.map((file) => `\`${file}\``).join(", ")}; nenhum \`tested_sha\` é emitido.`
    : cache
      ? "Cache do Vite Task restaurado: tarefas com as mesmas entradas repetem o resultado aprovado."
      : "Sem cache: toda tarefa executa.",
];
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${decision.mode}\ncache=${cache}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
