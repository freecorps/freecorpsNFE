import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * Os scripts ficam em scripts/<domínio>/, com o teste ao lado; os helpers
 * compartilhados, em scripts/lib/. Seis arquivos ficam na raiz de scripts/
 * porque outro checkout ou um texto público os chama pelo caminho.
 */
const rootFiles: Record<string, string> = {
  "worktree.mjs":
    "lib/worktree/lifecycle.mjs roda o worktree.mjs do checkout criado, que pode vir de uma ref anterior",
  "selfhost.mjs":
    "a instalação própria publicada (apps/docs) manda o operador rodá-lo pelo caminho",
  "contribution-terms.mjs":
    "o workflow pull_request_target faz checkout da base da PR e roda o script pelo caminho",
  "contribution-terms.test.ts": "par de contribution-terms.mjs",
  "sync-claude-skills.mjs":
    "o caminho está gravado nos atalhos gerados de .claude/skills e marca quais são dele",
  "sync-claude-skills.test.ts": "par de sync-claude-skills.mjs",
};

/**
 * Exceções às regras de raiz, com o motivo. A chave é o arquivo; o valor, o
 * número exato de ocorrências, para que uma ocorrência nova não passe calada.
 */
const rootAllowlist: Record<string, { count: number; reason: string }> = {
  "scripts/ci/proof-runner.test.ts": {
    count: 3,
    reason: "código do processo filho que o teste grava no checkout descartável e roda lá",
  },
  "scripts/public-copy/public-tree.mjs": {
    count: 2,
    reason: "trecho de tests/fixtureCorpus.test.ts (antes e depois) que a cópia pública reescreve",
  },
};

const tracked = execFileSync("git", ["ls-files", "-z", "scripts"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((file) => existsSync(join(repoRoot, file)));

/**
 * Formas de achar a raiz subindo pastas a partir do próprio arquivo, ou de
 * tomá-la da pasta de execução. Num script de scripts/<domínio>/, um `..` a
 * mais ou a menos não falha: lê e grava no lugar errado; e quem roda o script
 * de outra pasta grava recibos fora da raiz. A raiz vem de
 * scripts/lib/repo-root.mjs.
 */
function rootEscapes(file: string, text: string) {
  const found: string[] = [];
  const dir = posix.dirname(file);
  for (const match of text.matchAll(
    /new URL\(\s*(["'`])(\.\.[^"'`]*?)(?:\$\{[^]*?)?\1\s*,\s*import\.meta\.url/g,
  )) {
    // `..` sozinho ou com sufixo dinâmico, a partir de scripts/<domínio>/, é scripts/.
    const resolved = posix.normalize(posix.join(dir, match[2])).replace(/\/$/, "");
    if (!/^scripts\/[^/]+/.test(resolved)) found.push(match[0]);
  }
  for (const pattern of [
    /dirname\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url/g,
    /dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*["'`]\.\./g,
    /import\.meta\.dirname\s*,\s*["'`]\.\./g,
    /parents\[[01]\]/g,
    /process\.cwd\(\)/g,
  ])
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  return found;
}

describe("organização de scripts/", () => {
  it("só os arquivos combinados ficam na raiz de scripts/", () => {
    const loose = tracked
      .filter((file) => posix.dirname(file) === "scripts")
      .map((file) => posix.basename(file))
      .filter((name) => !(name in rootFiles));
    expect(loose, "script novo vai para scripts/<domínio>/, com o teste ao lado").toEqual([]);
    for (const name of Object.keys(rootFiles))
      expect(existsSync(join(repoRoot, "scripts", name)), name).toBe(true);
  });

  it("os scripts dos domínios acham a raiz por scripts/lib/repo-root.mjs", () => {
    const found: Record<string, string[]> = {};
    for (const file of tracked) {
      if (posix.dirname(file) === "scripts" || file.startsWith("scripts/lib/")) continue;
      if (!/\.(mjs|ts|py)$/.test(file)) continue;
      const escapes = rootEscapes(file, readFileSync(join(repoRoot, file), "utf8"));
      if (escapes.length && rootAllowlist[file]?.count !== escapes.length) found[file] = escapes;
    }
    expect(found, "use repoRoot ou repoUrl de scripts/lib/repo-root.mjs").toEqual({});
    for (const [file, { count }] of Object.entries(rootAllowlist))
      expect(rootEscapes(file, readFileSync(join(repoRoot, file), "utf8")), file).toHaveLength(
        count,
      );
  });

  it("todo caminho de scripts/ citado por comando, workflow ou dono existe", () => {
    const sources = [
      "package.json",
      "apps/console/package.json",
      "packages/contracts/package.json",
      "platform/package.json",
      "vite.config.ts",
      "knip.jsonc",
      ".github/CODEOWNERS",
      ...execFileSync("git", ["ls-files", ".github/workflows", ".vite-hooks"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean),
    ];
    const missing: string[] = [];
    for (const source of sources)
      for (const [, path] of readFileSync(join(repoRoot, source), "utf8").matchAll(
        /(?:^|[^\w./-])\/?(scripts\/[\w./-]+\.(?:mjs|ts|py|json))/gm,
      ))
        if (!existsSync(join(repoRoot, path))) missing.push(`${source}: ${path}`);
    expect(missing).toEqual([]);
  });
});
