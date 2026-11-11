import { execFileSync } from "node:child_process";
import { posix } from "node:path";

/**
 * Caminhos que nenhum build da publicação lê: testes, CI, agentes, a
 * documentação interna e os Markdown de colaboração da raiz. Fica de fora
 * `docs/v1.0/`, de onde a documentação pública lê o OpenAPI e o build do
 * console copia OpenAPI e SDK.md para `/developer/`, e os arquivos de licença,
 * que ela cita. `examples/` também vai para `/developer/`. Na dúvida, o caminho não entra aqui e a publicação
 * acontece.
 */
export const undeployedPaths = [
  "tests/**",
  "**/*.test.{ts,tsx,mjs}",
  "apps/console/e2e/**",
  ".github/**",
  ".agents/**",
  ".claude/**",
  "docs/{adr,desenvolvimento,historico,licenses,operacao,plataforma}/**",
  "docs/*.md",
  "{AGENTS,CLAUDE,CONTRIBUTING,CONTRIBUICOES,CHANGELOG,DESIGN,README,SECURITY}.md",
  "skills-lock.json",
  "t3.json",
];

/** Acima disso, a comparação não vale o risco de errar: publica. */
export const maxChangedFiles = 300;

const fullSha = /^[a-f0-9]{40}$/;

/** O arquivo não vai para produção. */
export const undeployed = (file) =>
  undeployedPaths.some((pattern) => posix.matchesGlob(file, pattern));

/**
 * A revisão que backend, frontend e API dizem servir, ou `null` quando um
 * deles não responde, responde algo inválido ou diverge dos outros (uma
 * publicação parcial).
 * @param {{ site: string; frontend: string; api?: string }} target
 * @param {(url: string, init: RequestInit) => Promise<Response>} [request]
 */
export async function publishedRevision(target, request = fetch) {
  const urls = [`${target.site}/health`, `${target.frontend}/build.json`];
  if (target.api) urls.push(`${target.api}/health`);
  const shas = [];
  for (const url of urls) {
    try {
      const response = await request(url, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const sha = (await response.json())?.sha;
      if (typeof sha !== "string" || !fullSha.test(sha)) return null;
      shas.push(sha);
    } catch {
      return null;
    }
  }
  return shas.every((sha) => sha === shas[0]) ? shas[0] : null;
}

const git = (cwd) => (args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" });

/**
 * Arquivos que mudaram de `from` até `to`, contando os dois lados de uma
 * renomeação, ou `null` quando `from` não é ancestral de `to` ou o histórico
 * não está no checkout.
 */
export function changedFiles(from, to, run) {
  try {
    run(["merge-base", "--is-ancestor", from, to]);
    return run(["diff", "--name-only", "--no-renames", from, to]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Decide se a publicação de `sha` pode ser pulada: só quando a produção serve
 * inteira uma revisão anterior e tudo o que mudou desde ela é de
 * `undeployedPaths`. Qualquer dúvida publica, como antes.
 * @param {string} sha
 * @param {{ site: string; frontend: string; api?: string }} target
 * @param {{
 *   request?: (url: string, init: RequestInit) => Promise<Response>;
 *   run?: (args: string[]) => string;
 * }} [options]
 */
export async function unchangedPublication(
  sha,
  target,
  { request = fetch, run = git(process.cwd()) } = {},
) {
  const published = await publishedRevision(target, request);
  if (!published) return { skip: false, reason: "published revision unknown" };
  if (published === sha) return { skip: false, published, reason: "already published" };
  const files = changedFiles(published, sha, run);
  if (!files)
    return { skip: false, published, reason: "not a descendant of the published revision" };
  if (files.length > maxChangedFiles)
    return { skip: false, published, reason: `${files.length} changed files` };
  const deployed = files.filter((file) => !undeployed(file));
  if (deployed.length)
    return { skip: false, published, reason: `${deployed.length} deployed files changed` };
  return { skip: true, published, files: files.length };
}
