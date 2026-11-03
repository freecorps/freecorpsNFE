/**
 * Gate de revisão na publicação (ADR 0007, nota de 23/10/2026, opção 2; #424;
 * decisão do dono do projeto de 26/10/2026: só o dono do projeto aprova).
 *
 * O ruleset da `main` (03/11/2026) exige PR e checks, mas nenhuma aprovação,
 * então o `CODEOWNERS` não obriga revisão. Antes de publicar, este gate lista
 * os commits entre a revisão que a produção serve e a nova e, para cada um que
 * toque um caminho do `CODEOWNERS` (na versão publicada ou na nova), exige uma
 * destas aprovações:
 *
 * - **Dispatch de um dono.** Num `workflow_dispatch` do `Deploy production`,
 *   disparado e não só repetido pela pessoa (`dispatcherOf`), quem dispara
 *   aprova o SHA inteiro (`approved_sha`), inclusive os commits de que é
 *   autor: o dispatch explícito é o passo humano de aprovação. Um push não
 *   aprova nada sozinho.
 * - **PR aprovada.** O commit pertence a uma PR mesclada na `main`, com revisão
 *   `APPROVED` de um dono do caminho, feita no último commit da PR e por
 *   alguém que não é o autor da PR nem do commit. Com um dono só, que também
 *   é o autor dos commits, este caminho não passa; fica para quando houver
 *   outro dono.
 *
 * Um caminho protegido na versão publicada ou na nova do `CODEOWNERS`
 * continua protegido, mas só aprova, nos dois caminhos, quem é dono dele em
 * cada versão que o protege: quem se põe como dono no próprio commit não se
 * aprova, e quem a faixa tira do arquivo já não aprova. Com a revisão
 * publicada desconhecida não há versão anterior: vale só o `CODEOWNERS` novo,
 * e o dispatch de um dono dele publica sem conferir commit a commit. Com a
 * revisão conhecida e o `CODEOWNERS` dela ilegível, recusa. Trocar o dono de
 * um caminho numa publicação só bloqueia os commits da faixa que o tocam:
 * ninguém é dono nas duas versões. A troca se faz em duas publicações,
 * primeiro somando o novo dono.
 *
 * Na dúvida, recusa. O limite é conhecido: o gate roda na versão do workflow
 * que chegou à `main`, então um commit sem revisão que altere o próprio gate o
 * desliga na publicação seguinte. Ele reduz o risco, não o elimina.
 */

/**
 * Quem aprova por dispatch, a partir do ambiente do GitHub Actions: o `actor`
 * de um `workflow_dispatch`, desde que seja também quem disparou esta
 * tentativa (`GITHUB_TRIGGERING_ACTOR`). Quem repete o run de outra pessoa
 * não herda a aprovação dela. Fora de um dispatch, ou sem um dos dois, `null`.
 * @param {Record<string, string | undefined>} env
 */
export function dispatcherOf(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !env.GITHUB_ACTOR) return null;
  return env.GITHUB_TRIGGERING_ACTOR === env.GITHUB_ACTOR ? env.GITHUB_ACTOR : null;
}

/** Acima disso o gate não confere commit a commit: recusa. */
export const maxCheckedCommits = 200;

/**
 * Regras do `CODEOWNERS`, só na forma que o arquivo usa: caminho a partir da
 * raiz (`/x/` diretório, `/x` arquivo ou diretório) e donos `@login`. Qualquer
 * outra forma lança erro, para o gate nunca ler errado o que protege.
 * @param {string} text
 * @returns {{ path: string; directory: boolean; owners: string[] }[]}
 */
export function parseCodeowners(text) {
  const rules = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!/^\/[A-Za-z0-9._\-/]+$/.test(pattern) || pattern.includes("//"))
      throw new Error(`CODEOWNERS linha ${index + 1}: padrão não suportado pelo gate: ${pattern}`);
    if (!owners.length || owners.some((owner) => !/^@[A-Za-z0-9-]+$/.test(owner)))
      throw new Error(`CODEOWNERS linha ${index + 1}: donos inválidos`);
    rules.push({
      path: pattern.slice(1).replace(/\/$/, ""),
      directory: pattern.endsWith("/"),
      owners: owners.map((owner) => owner.slice(1).toLowerCase()),
    });
  }
  return rules;
}

/** Donos do arquivo pela última regra que casa, como no GitHub; `[]` se nenhuma. */
export function ownersOf(file, rules) {
  let owners = [];
  for (const rule of rules) {
    const match = rule.directory
      ? file.startsWith(rule.path + "/")
      : file === rule.path || file.startsWith(rule.path + "/");
    if (match) owners = rule.owners;
  }
  return owners;
}

/**
 * Commits de `from` (exclusive) até `to`, com os arquivos de cada um contra o
 * primeiro pai, ou `null` quando `from` não é ancestral de `to`.
 * @param {(args: string[]) => string} run
 */
export function commitsBetween(from, to, run) {
  try {
    run(["merge-base", "--is-ancestor", from, to]);
  } catch {
    return null;
  }
  return run(["rev-list", "--parents", `${from}..${to}`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, parent] = line.split(" ");
      const files = run(
        parent
          ? ["diff", "--name-only", "--no-renames", parent, sha]
          : ["show", "--name-only", "--format=", sha],
      )
        .split("\n")
        .filter(Boolean);
      return { sha, files };
    });
}

/**
 * Confere os commits de `from` até `to`. `github(path)` devolve o JSON da API
 * REST do GitHub para `/repos/<repo>/<path>`. Devolve `problems` vazio quando
 * a publicação pode seguir e `checked` com a prova de cada commit protegido.
 * @param {{
 *   from: string | null;
 *   to: string;
 *   run: (args: string[]) => string;
 *   github: (path: string) => Promise<any>;
 *   codeowners: { from: string | null; to: string };
 *   dispatcher?: string | null;
 * }} input
 */
export async function ownerReview({ from, to, run, github, codeowners, dispatcher = null }) {
  const rules = [codeowners.to, codeowners.from].filter(Boolean).map(parseCodeowners);
  // Um caminho protegido em qualquer das duas versões continua protegido.
  const owners = (file) => [...new Set(rules.flatMap((list) => ownersOf(file, list)))];
  // Só aprova quem é dono do arquivo em cada versão que o protege: não basta se incluir no
  // CODEOWNERS do próprio commit, e quem a faixa tira do arquivo deixa de aprovar.
  const ownsEverywhere = (file, login) =>
    owners(file).includes(login) &&
    rules.every((list) => {
      const listed = ownersOf(file, list);
      return !listed.length || listed.includes(login);
    });
  const allOwners = new Set(rules.flat().flatMap((rule) => rule.owners));
  const actor = dispatcher?.toLowerCase() ?? null;
  const dispatchApproval = actor && allOwners.has(actor) ? actor : null;
  if (!from)
    return dispatchApproval
      ? {
          problems: [],
          checked: [],
          note: `revisão publicada desconhecida; publicação aprovada por dispatch de ${actor}`,
        }
      : {
          problems: [
            "revisão publicada desconhecida: só um dono do CODEOWNERS publica, por dispatch",
          ],
          checked: [],
        };
  // Sem o CODEOWNERS publicado, o novo sozinho decidiria quem aprova a faixa: recusa.
  if (codeowners.from === null)
    return {
      problems: [`CODEOWNERS ilegível na revisão publicada ${from}; o gate não confere a faixa`],
      checked: [],
    };
  if (from === to) return { problems: [], checked: [] };
  const commits = commitsBetween(from, to, run);
  if (!commits) return { problems: [`${from} não é ancestral de ${to}`], checked: [] };
  const protectedCommits = commits
    .map((commit) => ({ ...commit, files: commit.files.filter((file) => owners(file).length) }))
    .filter((commit) => commit.files.length);
  if (protectedCommits.length > maxCheckedCommits)
    return {
      problems: [
        `${protectedCommits.length} commits protegidos; o gate confere até ${maxCheckedCommits}`,
      ],
      checked: [],
    };
  const reviews = new Map();
  const reviewsOf = async (number) => {
    if (!reviews.has(number))
      reviews.set(number, await github(`pulls/${number}/reviews?per_page=100`));
    return reviews.get(number);
  };
  const problems = [];
  const checked = [];
  for (const commit of protectedCommits) {
    const author = (await github(`commits/${commit.sha}`))?.author?.login?.toLowerCase() ?? null;
    const approvers = (file, candidates) =>
      candidates.filter((login) => ownsEverywhere(file, login));
    const proof = {
      sha: commit.sha,
      files: commit.files,
      author,
      via: null,
      pull: null,
      approvers: [],
    };
    const pulls = (await github(`commits/${commit.sha}/pulls?per_page=100`)) ?? [];
    for (const pull of pulls.filter((pull) => pull.merged_at && pull.base?.ref === "main")) {
      const prAuthor = pull.user?.login?.toLowerCase();
      const latest = new Map();
      for (const review of await reviewsOf(pull.number)) {
        const login = review.user?.login?.toLowerCase();
        if (login && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
          latest.set(login, review);
      }
      const approved = [...latest]
        .filter(([, review]) => review.state === "APPROVED" && review.commit_id === pull.head?.sha)
        .map(([login]) => login)
        .filter((login) => login !== prAuthor && login !== author);
      if (author && commit.files.every((file) => approvers(file, approved).length)) {
        Object.assign(proof, { via: "pull", pull: pull.number, approvers: approved });
        break;
      }
    }
    if (
      !proof.via &&
      dispatchApproval &&
      commit.files.every((file) => ownsEverywhere(file, dispatchApproval))
    )
      Object.assign(proof, { via: "dispatch", approvers: [dispatchApproval] });
    if (proof.via) checked.push(proof);
    else
      problems.push(
        `${commit.sha.slice(0, 7)} toca ${commit.files.join(", ")} sem aprovação de um dono` +
          (author ? ` (autor ${author})` : " (autor sem conta do GitHub)"),
      );
  }
  return { problems, checked };
}
