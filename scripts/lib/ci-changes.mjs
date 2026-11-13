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
  "docs/operacao/email.md",
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
 * os identificadores fiscais de cada Markdown, a classificação de todo
 * arquivo versionado para a cópia pública, o status das ADRs, que só o
 * cabeçalho delas declara, os links relativos entre documentos e as provas
 * que os documentos de entrada citam.
 */
export const documentationTests = [
  "scripts/public-copy/public-identifiers.test.ts",
  "scripts/public-copy/public-tree.test.ts",
  "scripts/repo/adr-status.test.ts",
  "scripts/repo/doc-links.test.ts",
  "scripts/repo/docs-claims.test.ts",
];

/**
 * Tarefas do grafo `validate` que uma PR pula quando não alcança nenhum
 * workspace que elas provam (docs/desenvolvimento/ci.md, "Grafo reduzido").
 * `covers` recebe a pasta do workspace e o `kind` dele em
 * scripts/build/package-boundaries.json. As provas de distribuição não usam
 * cache e instalam do registro npm a cada run; a área `packages` testa só
 * `packages/**` (scripts/lib/test-projects.mjs). Um grupo pula inteiro: quem
 * depende de uma tarefa dele está no mesmo grupo ou é `validate` e `ci:tests`
 * (`tests/ci.changes.test.ts`). As demais tarefas rodam sempre, e o cache do
 * Vite Task repete as que a mudança não alcança.
 */
export const optionalTasks = [
  {
    // Os pacotes independentes (`pure` e `node`): os cinco que
    // scripts/distribution/prove-distribution.mjs empacota.
    tasks: ["ci:sdk", "ci:xml-prove", "ci:distribution"],
    covers: (/** @type {{ dir: string, kind: string }} */ { kind }) => kind !== "platform",
  },
  {
    tasks: ["ci:test:packages"],
    covers: (/** @type {{ dir: string, kind: string }} */ { dir }) => dir.startsWith("packages/"),
  },
];

const optionalNames = optionalTasks.flatMap(({ tasks }) => tasks);

/**
 * Lê `CI_VALIDATE_SKIP` (nomes separados por vírgula), que o job passa ao grafo
 * no modo `affected`. Vazio, o grafo é o inteiro; um nome fora de
 * `optionalTasks` reprova, para que um erro de digitação nunca pule outra tarefa.
 * @param {string | undefined} value
 */
export function validateSkip(value) {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !optionalNames.includes(name));
  if (unknown.length)
    throw new Error(`CI_VALIDATE_SKIP: tarefa não opcional: ${unknown.join(", ")}`);
  return [...new Set(names)];
}

/**
 * Pacotes do workspace que contêm um arquivo alterado e, por transitividade,
 * os que dependem deles (`@freecorps/*` nos manifests). `workspaces` são as
 * pastas de scripts/build/package-boundaries.json; `manifests`, o package.json
 * de cada uma.
 * @param {string[]} files
 * @param {string[]} workspaces
 * @param {Record<string, { name: string, dependencies?: object, devDependencies?: object, peerDependencies?: object }>} manifests
 */
export function affectedWorkspaces(files, workspaces, manifests) {
  const byName = Object.fromEntries(workspaces.map((dir) => [manifests[dir].name, dir]));
  const dependents = Object.fromEntries(workspaces.map((dir) => [dir, []]));
  for (const dir of workspaces) {
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = manifests[dir];
    for (const name of Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies }))
      if (byName[name] && byName[name] !== dir) dependents[byName[name]].push(dir);
  }
  const direct = new Set(
    files.map((file) => workspaceOf(file, workspaces)).filter((dir) => dir !== undefined),
  );
  const reached = new Set(direct);
  const queue = [...direct];
  while (queue.length)
    for (const next of dependents[queue.shift()]) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  return {
    changed: [...direct].sort(byPath),
    dependents: [...reached].filter((dir) => !direct.has(dir)).sort(byPath),
  };
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A pasta de workspace mais longa que contém o arquivo, ou `undefined`. */
const workspaceOf = (file, workspaces) =>
  [...workspaces].sort((a, b) => b.length - a.length).find((dir) => file.startsWith(`${dir}/`));

const shown = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? ", ..." : "");

/**
 * O que o job executa: `docs` (formatação, credenciais e `documentationTests`),
 * `affected` (o grafo `validate` sem as tarefas de `skip`) ou `graph` (o grafo
 * inteiro). O cache do Vite Task decide, nos dois últimos, o que repete.
 *
 * `docs` exige que nada seja apagado nem renomeado: há testes que conferem a
 * existência de arquivos citados (tests/coverage-matrix.json) e links entre
 * documentos, e eles rodam no grafo. `affected` exige que todo arquivo além de
 * documentação esteja dentro de um workspace e não seja um `package.json`: o
 * que fica fora (scripts, testes transversais, `.github/`, `patches/`,
 * `bun.lock`, `vite.config.ts`, a documentação que algum teste lê) pode
 * alimentar qualquer tarefa, e um manifesto muda dependências. Os workspaces
 * alcançados são os alterados e os que dependem deles; um grupo de
 * `optionalTasks` pula quando nenhum deles é coberto pelo grupo.
 *
 * Falha aberta: fora de PR, chamado por outro workflow, sem a lista de arquivos
 * ou de workspaces, o grafo inteiro roda.
 * @param {{
 *   eventName?: string,
 *   ownWorkflow?: boolean,
 *   files: string[] | null,
 *   deleted?: string[],
 *   workspaces?: Record<string, { kind: string, manifest: { name: string } }> | null,
 * }} change
 * @returns {{ mode: "docs" | "affected" | "graph", reason: string, skip: string[] }}
 */
export function changeMode({ eventName, ownWorkflow, files, deleted = [], workspaces = null }) {
  const graph = (reason) => ({
    mode: "graph",
    reason: `${reason}: o grafo inteiro roda`,
    skip: [],
  });
  if (eventName !== "pull_request") return graph("não é PR");
  if (!ownWorkflow) return graph("chamado por outro workflow");
  if (files === null) return graph("não foi possível comparar com a base");
  if (files.length === 0) return graph("diff vazio");
  const other = files.filter((file) => !documentationOnly(file));
  if (other.length === 0 && deleted.length === 0)
    return { mode: "docs", reason: `só documentação (${files.length} arquivos)`, skip: [] };
  if (!workspaces) return graph("workspaces não lidos");
  const dirs = Object.keys(workspaces);
  const outside = other.filter(
    (file) => workspaceOf(file, dirs) === undefined || posix.basename(file) === "package.json",
  );
  if (outside.length)
    return graph(`${outside.length} arquivos fora dos workspaces ou manifestos: ${shown(outside)}`);
  const manifests = Object.fromEntries(dirs.map((dir) => [dir, workspaces[dir].manifest]));
  const { changed, dependents } = affectedWorkspaces(other, dirs, manifests);
  const reached = [...changed, ...dependents];
  const skip = optionalTasks
    .filter(({ covers }) => !reached.some((dir) => covers({ dir, kind: workspaces[dir].kind })))
    .flatMap(({ tasks }) => tasks);
  const scope = reached.length
    ? `alcança ${reached.join(", ")}`
    : `só documentação, com ${deleted.length} arquivos apagados ou renomeados`;
  if (skip.length === 0) return graph(`${scope}, e toda tarefa opcional prova algum deles`);
  return { mode: "affected", reason: `${scope}; pula ${skip.join(", ")}`, skip };
}

/**
 * O run é do próprio `ci.yml` deste repositório. Numa chamada por
 * `workflow_call` (publicação de validação e da produção fiscal),
 * `GITHUB_WORKFLOW_REF` é o do chamador.
 * @param {Record<string, string | undefined>} env
 */
export const ownWorkflow = (env) =>
  typeof env.GITHUB_REPOSITORY === "string" &&
  (env.GITHUB_WORKFLOW_REF ?? "").startsWith(`${env.GITHUB_REPOSITORY}/.github/workflows/ci.yml@`);

/**
 * O cache do Vite Task vale só para o próprio CI em PR e push na `main`.
 * Disparo manual e chamadas por `workflow_call` rodam o grafo sem cache, como
 * antes.
 * @param {Record<string, string | undefined>} env
 */
export function cacheAllowed(env) {
  return ["pull_request", "push"].includes(env.GITHUB_EVENT_NAME ?? "") && ownWorkflow(env);
}
