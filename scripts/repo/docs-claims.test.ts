import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * Regra estrutural dos documentos de entrada cita a prova (#138). Uma regra
 * de `documents` termina com uma de três marcas:
 *
 * - `` prova: `<arquivo de teste>` › "<título>" ``: o arquivo existe e tem um
 *   `it`, `test` ou `describe` com esse título exato;
 * - `` prova: `freecorps/<regra>` ``: a regra existe no plugin de lint; uma
 *   regra nativa (`` `import/no-cycle` ``) precisa estar ligada no
 *   `vite.config.ts`;
 * - `convenção, sem verificação`: nada a conferir, e o leitor sabe disso.
 *
 * O caminho pode vir num link (`` [`regra`](lint.md#regra) ``). A tabela de
 * `lint.md` e o plugin listam as mesmas regras, cada uma com a sua seção.
 */
export const documents = ["AGENTS.md", "docs/README.md", "docs/plataforma/arquitetura-backend.md"];
const lintReference = "docs/desenvolvimento/lint.md";
const pluginIndex = "tooling/oxlint-plugin-freecorps/index.mjs";
const lintConfig = "vite.config.ts";

export type Claim = { line: number; target: string; title?: string };

const start = /\bprova:\s+(?=\[?`)/g;
const marker = /\[?`([^`\n]+)`\]?(?:\([^)\s]*\))?(?:\s+›\s+"([^"]+)")?/y;
const testFile = /\.test\.[cm]?[jt]sx?$/;
const ruleName = /^[a-z][a-z-]*\/[a-z][a-z-]*$/;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** As marcas `prova:` de um texto; `target` vazio quando a marca não segue a forma. */
export function claims(text: string): Claim[] {
  const found: Claim[] = [];
  for (const match of text.matchAll(start)) {
    const line = text.slice(0, match.index).split("\n").length;
    marker.lastIndex = match.index + match[0].length;
    const parsed = marker.exec(text);
    if (!parsed) found.push({ line, target: "" });
    else
      found.push({
        line,
        target: parsed[1]!,
        // O título pode quebrar a linha e escapar a pontuação do Markdown (`\*`).
        ...(parsed[2] === undefined
          ? {}
          : { title: parsed[2].replace(/\s+/g, " ").replace(/\\([!-/:-@[-`{-~])/g, "$1") }),
      });
  }
  return found;
}

const read = (root: string, file: string) =>
  existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined;

/** Regras registradas no plugin `freecorps`. */
function pluginRules(root: string) {
  const index = read(root, pluginIndex) ?? "";
  const block = /rules:\s*\{([\s\S]*?)\}/.exec(index)?.[1] ?? "";
  return new Set([...block.matchAll(/^\s*"([a-z-]+)":/gm)].map(([, name]) => name!));
}

/** O que reprova numa marca de prova. */
function claimProblem(root: string, claim: Claim) {
  const { target, title } = claim;
  if (!target) return 'marca fora da forma `caminho` › "título" ou `plugin/regra`';
  if (testFile.test(target)) {
    if (title === undefined) return `${target} sem o título do teste`;
    const source = read(root, target);
    if (source === undefined) return `${target} não existe`;
    if (!new RegExp(String.raw`\(\s*(["'\`])${escape(title)}\1`).test(source))
      return `${target} não tem teste com o título "${title}"`;
    return undefined;
  }
  if (!ruleName.test(target)) return `${target} não é arquivo de teste nem regra de lint`;
  if (title !== undefined) return `regra de lint ${target} não leva título`;
  const [plugin, rule] = target.split("/") as [string, string];
  if (plugin === "freecorps")
    return pluginRules(root).has(rule) ? undefined : `${target} não existe no plugin freecorps`;
  return (read(root, lintConfig) ?? "").includes(`"${target}"`)
    ? undefined
    : `${target} não está ligada em ${lintConfig}`;
}

/** Plugin e `lint.md` listam as mesmas regras, cada uma com a sua seção. */
export function lintReferenceProblems(root: string) {
  const plugin = pluginRules(root);
  const reference = read(root, lintReference) ?? "";
  const table = new Set(
    [...reference.matchAll(/^\| \[`([a-z-]+)`\]\(#/gm)].map(([, name]) => name!),
  );
  const sections = new Set([...reference.matchAll(/^## ([a-z-]+)$/gm)].map(([, name]) => name!));
  const problems: string[] = [];
  for (const rule of plugin) {
    if (!table.has(rule)) problems.push(`${lintReference}: freecorps/${rule} fora da tabela`);
    if (!sections.has(rule)) problems.push(`${lintReference}: freecorps/${rule} sem seção`);
  }
  for (const rule of table)
    if (!plugin.has(rule)) problems.push(`${lintReference}: ${rule} não existe no plugin`);
  return problems;
}

/** Tudo que reprova em `root`: marcas sem prova e a tabela de lint fora do plugin. */
export function claimProblems(root: string) {
  const problems: string[] = [];
  for (const file of documents) {
    const text = read(root, file);
    if (text === undefined) {
      problems.push(`${file}: documento ausente`);
      continue;
    }
    for (const claim of claims(text)) {
      const problem = claimProblem(root, claim);
      if (problem) problems.push(`${file}:${claim.line}: ${problem}`);
    }
  }
  return [...problems, ...lintReferenceProblems(root)];
}

it("reads test, lint and malformed marks, with a title that wraps the line", () => {
  expect(
    claims(
      [
        'Regra (prova: `a/b.test.ts` › "keeps\n  the order"; prova:',
        "[`freecorps/x-y`](lint.md#x-y)). Outra (convenção, sem verificação).",
        "Prova: sem marca. prova: `solto`. prova: [link sem código](x.md).",
      ].join("\n"),
    ),
  ).toEqual([
    { line: 1, target: "a/b.test.ts", title: "keeps the order" },
    { line: 2, target: "freecorps/x-y" },
    { line: 4, target: "solto" },
  ]);
  // Exemplo em código não abre marca: falta a crase depois de `prova:`.
  expect(claims('Escreva `prova: <arquivo> › "<título>"`.')).toEqual([]);
});

it("rejects, in a throwaway copy, a mark without proof and a lint table out of the plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-claims-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write("a/b.test.ts", 'it(\n  "keeps the order",\n  () => {});\ntest.each([1])("x %s", f);\n');
    write(
      "AGENTS.md",
      [
        'Ordem (prova: `a/b.test.ts` › "keeps the order"; prova: `a/b.test.ts` › "x %s").',
        'Sumiu (prova: `a/b.test.ts` › "keeps the old order").',
        'Ausente (prova: `a/c.test.ts` › "keeps").',
        "Sem título (prova: `a/b.test.ts`).",
      ].join("\n"),
    );
    write(
      "docs/README.md",
      "Lint (prova: `freecorps/known`; prova: `freecorps/gone`; prova: `import/no-cycle`).\n",
    );
    write("docs/plataforma/arquitetura-backend.md", "Nada (convenção, sem verificação).\n");
    write(
      pluginIndex,
      'export default definePlugin({\n  rules: {\n    "known": a,\n    "unlisted": b,\n  },\n});\n',
    );
    write(lintConfig, 'rules: { "freecorps/known": "error" }\n');
    write(
      lintReference,
      "| [`known`](#known) | x |\n| [`stale`](#stale) | y |\n\n## known\n\n## unlisted\n",
    );
    expect(claimProblems(root)).toEqual([
      'AGENTS.md:2: a/b.test.ts não tem teste com o título "keeps the old order"',
      "AGENTS.md:3: a/c.test.ts não existe",
      "AGENTS.md:4: a/b.test.ts sem o título do teste",
      "docs/README.md:1: freecorps/gone não existe no plugin freecorps",
      "docs/README.md:1: import/no-cycle não está ligada em vite.config.ts",
      `${lintReference}: freecorps/unlisted fora da tabela`,
      `${lintReference}: stale não existe no plugin`,
    ]);
    rmSync(join(root, "docs/README.md"));
    expect(claimProblems(root)).toContain("docs/README.md: documento ausente");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("cites an existing test or lint rule in every proof mark of the entry documents", () => {
  const tracked = execFileSync("git", ["ls-files", ...documents], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(tracked.split("\n").filter(Boolean).sort()).toEqual([...documents].sort());
  expect(claimProblems(repoRoot)).toEqual([]);
  // A leitura acha as marcas: um documento sem nenhuma indica regex quebrada.
  for (const file of documents)
    expect(claims(readFileSync(join(repoRoot, file), "utf8")).length, file).toBeGreaterThan(0);
});
