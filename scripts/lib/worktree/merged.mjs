/**
 * "Essa branch já acabou?" — a decisão do `prune`, isolada de git e de disco.
 *
 * Duas coisas fecham o ciclo de uma branch, e elas não provam a mesma coisa.
 *
 * A base conter os commits (merge commit e fast-forward deixam a branch
 * ancestral) é PROVA de integração: o trabalho está lá, e apagar a branch não
 * perde nada. Já o upstream ter sumido é só INDÍCIO — é o único rastro que
 * sobra num merge de squash ou rebase, onde os commits foram reescritos e nada
 * é ancestral de nada, mas branch remota também some por PR fechada sem merge e
 * por faxina de servidor. Um prune que só olha o primeiro sinal nunca limpa PR
 * de squash; um que trata o segundo como prova apaga commit que ninguém
 * integrou.
 *
 * Daí a assimetria que `canDeleteBranch` carrega: os dois sinais tiram o
 * worktree — que é ambiente, e se recria a partir da branch —, mas só a prova
 * tira a branch. No caso do indício, o worktree pesado sai (deployment do
 * Convex, node_modules, porta reservada) e os commits ficam de pé esperando um
 * `git branch -d` consciente.
 *
 * O resto é recusa. Vale mais deixar um worktree morto de pé do que apagar
 * trabalho: qualquer dúvida — está rodando, tem alteração solta, está
 * destacado — mantém.
 */

/**
 * Lê a saída de `git for-each-ref` com
 * `%(refname:short)\t%(upstream:short)\t%(upstream:track)`.
 *
 * O TAB é o separador porque nome de branch não pode conter um; `|` pode.
 * `%(upstream:track)` só diz `[gone]` quando a branch TEM upstream configurado
 * e a ref remota sumiu — branch que nunca foi pro remoto vem com os dois
 * campos vazios, e é essa diferença que separa "mergeada e apagada lá" de
 * "nunca saiu daqui".
 */
export function parseBranchTracking(output) {
  const branches = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [name, upstream = "", track = ""] = line.split("\t");
    if (!name) continue;
    branches.set(name, {
      upstream: upstream === "" ? null : upstream,
      gone: track.includes("[gone]"),
    });
  }
  return branches;
}

/**
 * Recebe fatos já colhidos, devolve `{ prune, reason }` — mais
 * `canDeleteBranch` quando `prune` é `true`, que é o único caso em que o campo
 * significa alguma coisa. O motivo é sempre preenchido, inclusive na recusa: o
 * `--dry-run` existe para ser lido, e um "pulei" sem porquê não deixa ninguém
 * decidir nada.
 *
 * A ordem importa. As recusas estruturais (principal, atual, destacado, base)
 * vêm primeiro porque o chamador não colhe os fatos caros — `git status`,
 * `merge-base` — para quem já caiu numa delas.
 */
export function classifyPruneCandidate(facts, options = {}) {
  const base = options.base ?? "origin/main";

  if (facts.isMain) {
    return { prune: false, reason: "é o checkout principal" };
  }
  if (facts.isCurrent) {
    return { prune: false, reason: "é o worktree de onde este comando roda" };
  }
  if (facts.detached || !facts.branch) {
    return { prune: false, reason: "está destacado, sem branch para julgar" };
  }
  if (facts.isBaseBranch) {
    return { prune: false, reason: `está na própria ${facts.branch}` };
  }
  if (facts.running) {
    return { prune: false, reason: "tem dev rodando (pare com worktree:cleanup)" };
  }
  if (facts.dirty) {
    return { prune: false, reason: "tem alteração não commitada" };
  }
  // Branch nunca publicada que a base contém é, quase sempre, uma tarefa que
  // acabou de começar: o editor cria o worktree na ponta da base e o agente
  // ainda não commitou. Só depois de um prazo ela passa por abandonada. Criada
  // de `origin/main`, a branch já nasce rastreando a base, o que não é publicar.
  const published = Boolean(facts.upstream) && facts.upstream !== base;
  if (facts.merged && !published && facts.fresh) {
    return { prune: false, reason: "foi criado há pouco e ainda não tem commits próprios" };
  }
  if (facts.merged) {
    return { prune: true, canDeleteBranch: true, reason: `já está em ${base}` };
  }
  if (facts.gone) {
    const upstream = facts.upstream ? ` ${facts.upstream}` : "";
    return {
      prune: true,
      canDeleteBranch: false,
      reason: `a branch remota${upstream} já não existe, mas o merge não está provado — mantenho a branch`,
    };
  }
  if (!facts.upstream) {
    return { prune: false, reason: "nunca foi para o remoto" };
  }
  return { prune: false, reason: `ainda não está em ${base}` };
}
