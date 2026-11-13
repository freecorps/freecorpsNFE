// Primeiro passo do job Validate: decide se a PR só muda documentação
// (`mode=docs`), roda o grafo sem as tarefas que ela não alcança
// (`mode=affected`, com a lista em `skip`) ou roda o grafo inteiro
// (`mode=graph`), e se o grafo usa o cache do Vite Task (`cache=true|false`).
// Regras em scripts/lib/ci-changes.mjs. Não precisa de `vp install`. Qualquer
// falha ao comparar ou ao ler os workspaces roda o grafo inteiro.
//
//   node scripts/ci/ci-changes.mjs          # no job: lê o evento e o checkout
//   node scripts/ci/ci-changes.mjs --tests  # os testes do modo docs, um por linha
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheAllowed, changeMode, documentationTests, ownWorkflow } from "../lib/ci-changes.mjs";
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

/**
 * Cada workspace de scripts/build/package-boundaries.json com o `kind` e o
 * manifesto. `null` se algum não puder ser lido: o grafo inteiro roda.
 */
function workspaces() {
  try {
    const boundaries = JSON.parse(
      readFileSync(join(root, "scripts/build/package-boundaries.json"), "utf8"),
    );
    return Object.fromEntries(
      Object.entries(boundaries.workspaces).map(([dir, { kind }]) => [
        dir,
        { kind, manifest: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) },
      ]),
    );
  } catch {
    return null;
  }
}

const eventName = process.env.GITHUB_EVENT_NAME;
let decision;
try {
  decision = changeMode({
    eventName,
    ownWorkflow: ownWorkflow(process.env),
    ...(eventName === "pull_request"
      ? { ...changes(), workspaces: workspaces() }
      : { files: null }),
  });
} catch (error) {
  decision = {
    mode: "graph",
    reason: `classificação falhou (${String(error)}): o grafo inteiro roda`,
    skip: [],
  };
}
const cache = decision.mode !== "docs" && cacheAllowed(process.env);
const code = (text) => `\`${text}\``;
const title = {
  docs: "só documentação",
  affected: "grafo validate reduzido",
  graph: "grafo validate inteiro",
}[decision.mode];
const effect =
  decision.mode === "docs"
    ? [
        `Roda ${code("vp fmt --check")}, ${code("ci:secrets")} e ${documentationTests.map(code).join(", ")}; nenhum ${code("tested_sha")} é emitido.`,
      ]
    : [
        ...(decision.mode === "affected"
          ? [
              `Não roda ${decision.skip.map(code).join(", ")}; nenhum ${code("tested_sha")} é emitido, e o push na ${code("main")} roda o grafo inteiro.`,
              "",
            ]
          : []),
        cache
          ? "Cache do Vite Task restaurado: tarefas com as mesmas entradas repetem o resultado aprovado."
          : "Sem cache: toda tarefa executa.",
      ];
const lines = [`### Mudança: ${title}`, "", decision.reason, "", ...effect];
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${decision.mode}\ncache=${cache}\nskip=${decision.skip.join(",")}\n`,
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
