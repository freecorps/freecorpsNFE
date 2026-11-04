// Passo do push na `main`: nomeia o run da PR mesclada cujo cache do Vite Task
// este run pode repetir (scripts/lib/ci-task-cache.mjs). Grava `run-id` (vazio
// quando não há) nos outputs e nunca reprova o job: sem o cache da PR, as
// tarefas simplesmente executam.
import { appendFileSync } from "node:fs";
import { findPullRequestTaskCache } from "../lib/ci-task-cache.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } =
  process.env;
const api = process.env.GITHUB_API_URL || "https://api.github.com";

async function get(path) {
  const response = await fetch(`${api}/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${response.status}`);
  return response.json();
}

let result;
try {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? ""))
    throw new Error("fora de um run do GitHub Actions");
  result = await findPullRequestTaskCache({ get, sha: GITHUB_SHA, repository: GITHUB_REPOSITORY });
} catch (error) {
  result = {
    runId: null,
    reason: `não foi possível procurar o cache da PR (${error instanceof Error ? error.message : "erro"})`,
  };
}
console.log(result.reason);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `run-id=${result.runId ?? ""}\n`);
if (GITHUB_STEP_SUMMARY)
  appendFileSync(GITHUB_STEP_SUMMARY, `Cache do Vite Task da PR: ${result.reason}\n\n`);
