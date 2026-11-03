import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatcherOf, ownerReview } from "./owner-review.mjs";
import { publishedRevision } from "./platform-unchanged.mjs";
import { projectRepository } from "./repository.mjs";

/**
 * O gate de revisão do dono (#424): todo commit desde a revisão publicada que toque um caminho do
 * `CODEOWNERS` precisa da aprovação de um dono, por PR mesclada aprovada por um dono que não é o
 * autor ou pelo dispatch do próprio dono, antes de qualquer build ou escrita
 * (`scripts/lib/owner-review.mjs`). Só lê: a revisão publicada pelos endereços públicos, o
 * histórico do checkout e a API do GitHub com `GH_TOKEN`. O publicador o chama no preflight; o
 * job `Owner review and validation reuse` do `deploy.yml` o chama antes, sem credenciais, para
 * reprovar em segundos.
 * @param {{ root: string, sha: string, target: object, env: NodeJS.ProcessEnv }} options
 */
export async function reviewGate({ root, sha, target, env }) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  let published = await publishedRevision(target);
  // Production may serve a revision of the archived repository, outside this history (the
  // cutover of 03/11/2026): the range cannot be checked, so it counts as unknown and only an
  // owner dispatch publishes, as ownerReview requires for an unknown revision.
  if (
    published &&
    spawnSync("git", ["cat-file", "-e", `${published}^{commit}`], { cwd: root }).status !== 0
  ) {
    console.log(
      `owner review: production serves ${published}, outside this history; only an owner dispatch publishes`,
    );
    published = null;
  }
  // Unreadable at a known published revision stays null, and ownerReview refuses the range.
  let previous = null;
  try {
    if (published) previous = git(["show", `${published}:.github/CODEOWNERS`]);
  } catch {
    previous = null;
  }
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${projectRepository()}/${path}`, {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `GitHub API ${path}: ${response.status}`);
    return response.json();
  };
  let result;
  try {
    result = await ownerReview({
      from: published,
      to: sha,
      run: git,
      github,
      codeowners: { from: previous, to: readFileSync(join(root, ".github/CODEOWNERS"), "utf8") },
      dispatcher: dispatcherOf(env),
    });
  } catch (error) {
    // The publisher reports only the failed phase; the cause belongs in the log of the run.
    console.error(`owner review failed: ${error.message}`);
    throw error;
  }
  for (const proof of result.checked)
    console.log(
      `owner review: ${proof.sha.slice(0, 7)} ${proof.via === "pull" ? `PR #${proof.pull}` : "dispatch"}, approved by ${proof.approvers.join(", ")}`,
    );
  if (result.note) console.log(`owner review: ${result.note}`);
  for (const problem of result.problems) console.error(`owner review blocked: ${problem}`);
  assert.deepEqual(result.problems, [], "Owner review missing; nothing was published");
}
