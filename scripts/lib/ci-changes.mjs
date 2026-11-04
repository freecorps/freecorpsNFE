import { posix } from "node:path";

/**
 * Classificação da mudança no início do job Validate
 * (docs/desenvolvimento/ci.md, "Mudança só de documentação").
 *
 * Uma PR que só muda documentação roda a formatação (`vp fmt --check`), a
 * varredura de credenciais (`ci:secrets`) e os testes que leem toda a
 * documentação (`documentationTests`), em vez do grafo `validate`. Entram aqui
 * os Markdown que nenhuma outra tarefa nem teste lê; o que um teste ou build
 * consome fica em `consumedDocumentation` e leva ao grafo inteiro. A lista saiu
 * das entradas que o Vite Task registrou para cada tarefa do grafo, e
 * `tests/ci.changes.test.ts` recusa um caminho de documentação citado no
 * código-fonte fora das menções conhecidas. Na dúvida, o arquivo não é
 * documentação: o grafo roda. O push na `main` roda o grafo depois do merge, e
 * um teste que passasse a ler um desses arquivos falharia ali.
 */
export const documentationPaths = ["*.md", "docs/**/*.md", ".agents/**/*.md", ".claude/**/*.md"];

/** Markdown que algum teste, build ou prova lê; muda-los roda o grafo. */
export const consumedDocumentation = [
  // scripts/repo/commands.test.ts confere os comandos citados.
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/worktrees.md",
  "docs/operacao/deploy-producao.md",
  "docs/operacao/*-email.md",
  // Frase de aceite lida por scripts/contribution-terms.mjs e o teste dele.
  "CONTRIBUICOES.md",
  // Licenças: distribuição, inventário e cópia nos pacotes.
  "LICENSING.md",
  "docs/licenses/**",
  // Contrato REST gerado, evidências e matriz de aceite.
  "docs/v1.0/**",
  // Termos arquivados, lidos pelos testes do console por hash.
  "docs/termos/**",
  // Skills: os atalhos de .claude/skills copiam o frontmatter delas, e
  // scripts/sync-claude-skills.mjs lê cada entrada de .agents/skills.
  ".agents/skills/*/SKILL.md",
  ".agents/skills/*.md",
  ".claude/skills/**",
];

const matches = (file, patterns) => patterns.some((pattern) => posix.matchesGlob(file, pattern));

/** O arquivo é documentação que só a formatação e a varredura leem. */
export const documentationOnly = (file) =>
  matches(file, documentationPaths) && !matches(file, consumedDocumentation);

/**
 * Testes que leem toda a documentação versionada e rodam também no modo `docs`:
 * os identificadores fiscais de cada Markdown e a classificação de todo
 * arquivo versionado para a cópia pública.
 */
export const documentationTests = [
  "scripts/public-copy/public-identifiers.test.ts",
  "scripts/public-copy/public-tree.test.ts",
];

/**
 * O que o job executa: `docs` (formatação, credenciais e `documentationTests`)
 * ou `graph` (o grafo `validate` inteiro, com o cache decidindo o que repete).
 * Apagar ou renomear um Markdown roda o grafo: há testes que conferem a
 * existência de arquivos citados (tests/coverage-matrix.json) e links entre
 * documentos. Falha aberta: sem a lista de arquivos, ou fora de PR, roda o grafo.
 * @param {{ eventName?: string, files: string[] | null, deleted?: string[] }} change
 */
export function changeMode({ eventName, files, deleted = [] }) {
  if (eventName !== "pull_request") return { mode: "graph", reason: "não é PR: o grafo roda" };
  if (files === null)
    return { mode: "graph", reason: "não foi possível comparar com a base: o grafo roda" };
  if (files.length === 0) return { mode: "graph", reason: "diff vazio: o grafo roda" };
  if (deleted.length)
    return {
      mode: "graph",
      reason: `${deleted.length} arquivos apagados ou renomeados: o grafo roda`,
    };
  const other = files.filter((file) => !documentationOnly(file));
  if (other.length === 0)
    return { mode: "docs", reason: `só documentação (${files.length} arquivos)` };
  const shown = other.slice(0, 5).join(", ") + (other.length > 5 ? ", ..." : "");
  return { mode: "graph", reason: `${other.length} arquivos além de documentação: ${shown}` };
}

/**
 * O cache do Vite Task vale só para o próprio CI em PR e push na `main`.
 * Disparo manual e chamadas por `workflow_call` (publicação de validação e da
 * produção fiscal, cujo `GITHUB_WORKFLOW_REF` é o do chamador) rodam o grafo sem
 * cache, como antes.
 * @param {Record<string, string | undefined>} env
 */
export function cacheAllowed(env) {
  return (
    ["pull_request", "push"].includes(env.GITHUB_EVENT_NAME ?? "") &&
    typeof env.GITHUB_REPOSITORY === "string" &&
    (env.GITHUB_WORKFLOW_REF ?? "").startsWith(`${env.GITHUB_REPOSITORY}/.github/workflows/ci.yml@`)
  );
}
