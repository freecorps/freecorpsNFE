// Reaproveitamento, no push da `main`, da validação que a PR já fez da mesma árvore. O
// `Validate` do PR roda no merge sintético da PR com a `main` daquele momento; quando a PR entra
// atualizada, o commit da `main` tem exatamente essa árvore, e repetir a validação não testa nada
// novo. O `deploy.yml` chama `scripts/validation-reuse.mjs` e só pula o `validate` quando este
// módulo devolve o SHA; qualquer dúvida devolve vazio e a validação roda como antes
// (docs/desenvolvimento/ci.md, Validação reaproveitada).
import { isProjectRepository } from "./repository.mjs";

const SHA = /^[a-f0-9]{40}$/;
const CI_WORKFLOW = ".github/workflows/ci.yml";
/** Quantos runs verdes do head da PR conferir antes de desistir. */
const MAX_RUNS = 5;

/**
 * @typedef {{ number: number, merged_at: string | null, merge_commit_sha: string | null,
 *   base: { ref: string }, head: { sha: string } }} PullRequest
 * @typedef {{ id: number, run_attempt: number, event: string, path: string, conclusion: string | null,
 *   head_sha: string, repository: { full_name: string } }} WorkflowRun
 * @typedef {{ checkedSha?: unknown, headSha?: unknown, baseSha?: unknown, kind?: unknown }} Revision
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   event: { before?: unknown },
 *   github: (path: string) => Promise<any>,
 *   revisionOf: (run: WorkflowRun) => Promise<Revision | null>,
 *   git: { fetch: (sha: string) => boolean, tree: (sha: string) => string | null,
 *     parents: (sha: string) => string[] | null },
 * }} ReuseOptions
 */

/**
 * Procura um `Validate` de PR aprovado para a árvore do commit da `main` em `GITHUB_SHA`, contra
 * a mesma `main` anterior (`before` do push). Só devolve o SHA quando tudo bate:
 * - o push é da `main` do repositório do projeto, com `before` conhecido;
 * - o commit é o `merge_commit_sha` de uma PR mesclada na `main`;
 * - um run de `ci.yml` por `pull_request`, no head final da PR, terminou com sucesso;
 * - o `revision.json` desse run registra o merge sintético da PR, com base igual a `before`;
 * - esse merge, buscado por SHA, tem pais `[before, head]` e a mesma árvore do commit da `main`.
 * Como a árvore é a mesma, o `ci.yml` e os scripts que o run executou são os do commit publicado.
 * @param {ReuseOptions} options
 * @returns {Promise<{ testedSha: string, reason: string }>}
 */
export async function reusableValidation({ env, event, github, revisionOf, git }) {
  const sha = env.GITHUB_SHA ?? "";
  const before = typeof event.before === "string" ? event.before : "";
  const none = (reason) => ({ testedSha: "", reason });
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !isProjectRepository(env.GITHUB_REPOSITORY)
  )
    return none("only a push to main of the project repository reuses a PR validation");
  if (!SHA.test(sha) || !SHA.test(before) || /^0+$/.test(before))
    return none("push without a known previous main");
  const pulls = /** @type {PullRequest[]} */ (await github(`commits/${sha}/pulls`));
  const pull = pulls.find(
    (candidate) =>
      candidate.merged_at && candidate.merge_commit_sha === sha && candidate.base?.ref === "main",
  );
  if (!pull) return none("commit is not the merge of a pull request into main");
  const head = pull.head?.sha ?? "";
  if (!SHA.test(head)) return none(`PR #${pull.number} has no head SHA`);
  const listing = await github(
    `actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=${head}&per_page=${MAX_RUNS}`,
  );
  const runs = /** @type {WorkflowRun[]} */ (listing.workflow_runs ?? []).filter(
    (run) =>
      run.event === "pull_request" &&
      run.path === CI_WORKFLOW &&
      run.conclusion === "success" &&
      run.head_sha === head &&
      run.repository?.full_name === env.GITHUB_REPOSITORY,
  );
  if (!runs.length) return none(`PR #${pull.number} has no successful CI run on its final head`);
  const tree = git.tree(sha);
  if (!tree) return none("cannot read the tree of the main commit");
  const reasons = [];
  for (const run of runs.slice(0, MAX_RUNS)) {
    const revision = await revisionOf(run);
    const checked = typeof revision?.checkedSha === "string" ? revision.checkedSha : "";
    if (
      !revision ||
      revision.kind !== "pr-merge" ||
      revision.headSha !== head ||
      !SHA.test(checked)
    ) {
      reasons.push(`run ${run.id}: no PR merge revision`);
      continue;
    }
    if (revision.baseSha !== before) {
      reasons.push(
        `run ${run.id}: validated against ${String(revision.baseSha)}, main was ${before}`,
      );
      continue;
    }
    if (!git.fetch(checked)) {
      reasons.push(`run ${run.id}: merge ${checked} is no longer available`);
      continue;
    }
    const parents = git.parents(checked);
    if (parents?.length !== 2 || parents[0] !== before || parents[1] !== head) {
      reasons.push(`run ${run.id}: ${checked} is not the merge of ${head} into ${before}`);
      continue;
    }
    if (git.tree(checked) !== tree) {
      reasons.push(`run ${run.id}: ${checked} has another tree`);
      continue;
    }
    return {
      testedSha: sha,
      reason: `PR #${pull.number}, CI run ${run.id} attempt ${run.run_attempt}, validated ${checked} with the same tree against the same main`,
    };
  }
  return none(reasons.join("; "));
}
