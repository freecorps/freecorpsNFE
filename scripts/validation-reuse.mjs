// Passo do `deploy.yml`, no push da `main`: grava `tested_sha` quando a PR mesclada já validou a
// mesma árvore contra a mesma `main` anterior (scripts/lib/validation-reuse.mjs). Sem esse SHA, o
// `validate` roda como antes. Só lê: a API do GitHub com o `GH_TOKEN` de leitura, o artefato `ci-*`
// do run da PR e o histórico do checkout. Nunca reprova o deploy: um erro aqui só significa validar
// de novo.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRepository } from "./lib/repository.mjs";
import { reusableValidation } from "./lib/validation-reuse.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const git = (args) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const github = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${projectRepository()}/${path}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status}`);
  return response.json();
};
const revisionOf = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), "fnfe-reuse-"));
  try {
    execFileSync(
      "gh",
      [
        "run",
        "download",
        String(run.id),
        "--repo",
        projectRepository(),
        "--name",
        `ci-${run.id}-${run.run_attempt}`,
        "--dir",
        directory,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 },
    );
    const file = join(directory, ".ci-results", "revision.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

let result;
try {
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  result = await reusableValidation({
    env,
    event,
    github,
    revisionOf,
    git: {
      fetch: (sha) => git(["fetch", "--no-tags", "--quiet", "origin", sha]).status === 0,
      tree: (sha) => {
        const out = git(["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
        return out.status === 0 ? out.stdout.trim() : null;
      },
      parents: (sha) => {
        const out = git(["rev-list", "--parents", "-n", "1", sha]);
        return out.status === 0 ? out.stdout.trim().split(" ").slice(1) : null;
      },
    },
  });
} catch (error) {
  result = { testedSha: "", reason: error instanceof Error ? error.message : String(error) };
}
if (result.testedSha) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tested_sha=${result.testedSha}\n`);
  console.log(`validation reused: ${result.reason}`);
} else console.log(`validation not reused, validating again: ${result.reason}`);
