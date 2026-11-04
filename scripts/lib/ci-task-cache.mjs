/**
 * Qual run de PR tem o cache do Vite Task que um push na `main` pode repetir
 * (docs/desenvolvimento/ci.md, "Cache do grafo"). O GitHub restringe o cache do
 * Actions por ref: a `main` não lê o que uma PR salvou. Por isso o run da PR
 * também envia o diretório do cache como artifact, e o push da `main` procura o
 * da PR que gerou o commit.
 *
 * Repetir continua sendo decisão do Vite Task: cada tarefa só repete quando as
 * entradas registradas são as mesmas. Aqui só se escolhe de onde vem o cache:
 * do run bem-sucedido mais recente do `ci.yml` que testou a ponta final da PR,
 * neste repositório. Um run de fork executa o código do fork e grava o artifact
 * que quiser; o dele nunca é usado.
 */

export const TASK_CACHE_ARTIFACT = "vite-task-cache";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * @param {{
 *   get: (path: string) => Promise<any>,
 *   sha: string,
 *   repository: string,
 * }} options `get(path)` devolve o JSON de `GET /repos/<repository><path>` ou lança.
 * @returns {Promise<{ runId: string | null, reason: string }>}
 */
export async function findPullRequestTaskCache({ get, sha, repository }) {
  const pulls = await get(`/commits/${sha}/pulls`);
  const pull = (Array.isArray(pulls) ? pulls : []).find(
    (candidate) => candidate.merge_commit_sha === sha,
  );
  if (!pull) return { runId: null, reason: `nenhuma PR mesclada gerou ${sha.slice(0, 12)}` };
  const head = pull.head?.sha;
  if (pull.head?.repo?.full_name !== repository)
    return {
      runId: null,
      reason: `#${pull.number} vem de outro repositório; o cache dela não vale`,
    };
  if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head))
    return { runId: null, reason: `#${pull.number} sem SHA de ponta válido` };
  const { workflow_runs: runs = [] } = await get(
    `/actions/runs?event=pull_request&status=success&head_sha=${head}&per_page=100`,
  );
  const run = runs
    .filter(
      (candidate) =>
        candidate.path === CI_WORKFLOW &&
        candidate.event === "pull_request" &&
        candidate.conclusion === "success" &&
        candidate.head_sha === head &&
        candidate.head_repository?.full_name === repository &&
        candidate.repository?.full_name === repository,
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!run)
    return {
      runId: null,
      reason: `#${pull.number}: nenhum CI aprovado da ponta ${head.slice(0, 12)}`,
    };
  const { artifacts = [] } = await get(
    `/actions/runs/${run.id}/artifacts?name=${TASK_CACHE_ARTIFACT}&per_page=100`,
  );
  const artifact = artifacts.find(
    (candidate) => candidate.name === TASK_CACHE_ARTIFACT && !candidate.expired,
  );
  if (!artifact)
    return {
      runId: null,
      reason: `#${pull.number}: o run ${run.id} não tem ${TASK_CACHE_ARTIFACT} válido (só documentação ou expirado)`,
    };
  return {
    runId: String(run.id),
    reason: `#${pull.number}: cache do run ${run.id}, que testou a ponta ${head.slice(0, 12)}`,
  };
}
