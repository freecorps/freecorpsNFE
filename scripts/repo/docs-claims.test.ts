import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { expect, it } from "vite-plus/test";
import { repoRoot } from "../lib/repo-root.mjs";

/**
 * Regra estrutural dos documentos de entrada cita a prova (#138). Uma regra
 * de `documents` traz uma de três marcas, no fim da frase ou abrindo o
 * parágrafo que ela cobre:
 *
 * - `` prova: `<arquivo de teste>` › "<título>" ``: o arquivo existe e tem um
 *   `it`, `test` ou `describe` com esse título exato, sem `.skip` nem `.todo`;
 * - `` prova: `<plugin>/<regra>` ``: a regra está ligada no `vite.config.ts`
 *   e, quando é do plugin `freecorps`, registrada nele;
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

const start = /\bprova:\s+/g;
const marker = /\[?`([^`\n]+)`\]?(?:\([^)\s]*\))?(?:\s+›\s+"([^"]+)")?/y;
// Caminho ou regra sem crase depois de `prova:` é marca malformada, não prosa.
const bare = /[\w.@-]+\/\S|\S+\.test\./y;
const testFile = /\.test\.[cm]?[jt]sx?$/;
const ruleName = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** As marcas `prova:` de um texto; `target` vazio quando a marca não segue a forma. */
export function claims(text: string): Claim[] {
  const found: Claim[] = [];
  for (const match of text.matchAll(start)) {
    const line = text.slice(0, match.index).split("\n").length;
    const at = match.index + match[0].length;
    marker.lastIndex = at;
    const parsed = marker.exec(text);
    if (parsed)
      found.push({
        line,
        target: parsed[1]!,
        // O título pode quebrar a linha e escapar a pontuação do Markdown (`\*`).
        ...(parsed[2] === undefined
          ? {}
          : { title: parsed[2].replace(/\s+/g, " ").replace(/\\([!-/:-@[-`{-~])/g, "$1") }),
      });
    else {
      bare.lastIndex = at;
      if (bare.test(text)) found.push({ line, target: "" });
    }
  }
  return found;
}

const read = (root: string, file: string) =>
  existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined;

const testFunctions = new Set(["it", "test", "describe", "suite"]);

/**
 * Títulos dos testes que rodam num arquivo: `it`, `test`, `describe` e
 * `suite`, com `.each`, `.skipIf` e afins, lidos da árvore sintática. Teste em
 * comentário ou com `.skip` ou `.todo` não prova nada e fica de fora.
 */
export function testTitles(file: string, source: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const titles = new Set<string>();
  const callee = (node: ts.Expression): string[] | undefined => {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node)) {
      const base = callee(node.expression);
      return base && [...base, node.name.text];
    }
    // `it.each([...])("título")` e `it.skipIf(c)("título")` chamam o que a primeira chamada devolve.
    if (ts.isCallExpression(node)) return callee(node.expression);
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const names = callee(node.expression);
      const [title] = node.arguments;
      if (
        names &&
        testFunctions.has(names[0]!) &&
        !names.includes("skip") &&
        !names.includes("todo") &&
        title &&
        ts.isStringLiteralLike(title)
      )
        titles.add(title.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return titles;
}

/** Regras registradas no plugin `freecorps`. */
function pluginRules(root: string) {
  const index = read(root, pluginIndex) ?? "";
  const block = /rules:\s*\{([\s\S]*?)\}/.exec(index)?.[1] ?? "";
  return new Set([...block.matchAll(/^\s*"([a-z0-9-]+)":/gm)].map(([, name]) => name!));
}

/** A regra aparece no `vite.config.ts` com algum valor além de `off`. */
function enabled(root: string, rule: string) {
  const config = read(root, lintConfig) ?? "";
  const values = config.matchAll(
    new RegExp(String.raw`["']${escape(rule)}["']\s*:\s*\[?\s*(["']?)(\w+)\1`, "g"),
  );
  return [...values].some(([, , value]) => value !== "off" && value !== "0");
}

/** O que reprova numa marca de prova. */
function claimProblem(root: string, claim: Claim) {
  const { target, title } = claim;
  if (!target) return 'marca fora da forma `caminho` › "título" ou `plugin/regra`';
  if (testFile.test(target)) {
    if (title === undefined) return `${target} sem o título do teste`;
    const source = read(root, target);
    if (source === undefined) return `${target} não existe`;
    if (!testTitles(target, source).has(title))
      return `${target} não tem teste ativo com o título "${title}"`;
    return undefined;
  }
  if (!ruleName.test(target)) return `${target} não é arquivo de teste nem regra de lint`;
  if (title !== undefined) return `regra de lint ${target} não leva título`;
  const [plugin, rule] = target.split("/") as [string, string];
  if (plugin === "freecorps" && !pluginRules(root).has(rule))
    return `${target} não existe no plugin freecorps`;
  return enabled(root, target) ? undefined : `${target} não está ligada em ${lintConfig}`;
}

/** Plugin e `lint.md` listam as mesmas regras, cada uma com a sua seção. */
export function lintReferenceProblems(root: string) {
  const plugin = pluginRules(root);
  const reference = read(root, lintReference) ?? "";
  const table = new Set(
    [...reference.matchAll(/^\| \[`([a-z0-9-]+)`\]\(#/gm)].map(([, name]) => name!),
  );
  // A seção de uma regra tem o nome dela; as outras ("Adicionar uma regra") têm espaço.
  const sections = new Set([...reference.matchAll(/^## ([a-z0-9-]+)$/gm)].map(([, name]) => name!));
  const problems: string[] = [];
  for (const rule of plugin) {
    if (!table.has(rule)) problems.push(`${lintReference}: freecorps/${rule} fora da tabela`);
    if (!sections.has(rule)) problems.push(`${lintReference}: freecorps/${rule} sem seção`);
  }
  for (const rule of table)
    if (!plugin.has(rule)) problems.push(`${lintReference}: ${rule} na tabela, fora do plugin`);
  for (const rule of sections)
    if (!plugin.has(rule)) problems.push(`${lintReference}: seção ${rule} fora do plugin`);
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
        "Sem crase (prova: a/b.test.ts). A prova: o texto segue.",
      ].join("\n"),
    ),
  ).toEqual([
    { line: 1, target: "a/b.test.ts", title: "keeps the order" },
    { line: 2, target: "freecorps/x-y" },
    { line: 4, target: "solto" },
    { line: 5, target: "" },
  ]);
  // Exemplo em código não abre marca: depois de `prova:` vem `<`, não caminho.
  expect(claims('Escreva `prova: <arquivo> › "<título>"`.')).toEqual([]);
});

it("takes titles only from tests that run", () => {
  const source = [
    'describe("grupo", () => {',
    '  it("roda", () => {});',
    '  it.each([1, 2])("roda %s", () => {});',
    "  test.skipIf(process.env.CI)(`condicional`, () => {});",
    '  it.skip("pulado", () => {});',
    '  it.todo("depois");',
    '  // it("comentado", () => {});',
    '  expect(fn("chamada")).toBe(1);',
    "});",
  ].join("\n");
  expect([...testTitles("a.test.ts", source)].sort()).toEqual([
    "condicional",
    "grupo",
    "roda",
    "roda %s",
  ]);
});

it("rejects, in a throwaway copy, a mark without proof and a lint table out of the plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "docs-claims-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write(
      "a/b.test.ts",
      'it(\n  "keeps the order",\n  () => {});\ntest.each([1])("x %s", f);\nit.skip("skipped", f);\n',
    );
    write(
      "AGENTS.md",
      [
        'Ordem (prova: `a/b.test.ts` › "keeps the order"; prova: `a/b.test.ts` › "x %s").',
        'Sumiu (prova: `a/b.test.ts` › "keeps the old order").',
        'Ausente (prova: `a/c.test.ts` › "keeps").',
        "Sem título (prova: `a/b.test.ts`).",
        'Pulado (prova: `a/b.test.ts` › "skipped").',
      ].join("\n"),
    );
    write(
      "docs/README.md",
      "Lint (prova: `freecorps/known`; prova: `freecorps/gone`; prova: `freecorps/off`).\n" +
        "Nativa (prova: `import/no-cycle`; prova: a/b.test.ts).\n",
    );
    write("docs/plataforma/arquitetura-backend.md", "Nada (convenção, sem verificação).\n");
    write(
      pluginIndex,
      'export default definePlugin({\n  rules: {\n    "known": a,\n    "off": b,\n    "unlisted": c,\n  },\n});\n',
    );
    write(
      lintConfig,
      'rules: { "freecorps/known": "error", "freecorps/off": "off", "import/no-cycle": "off" }\n',
    );
    write(
      lintReference,
      [
        "| [`known`](#known) | x |",
        "| [`off`](#off) | x |",
        "| [`stale`](#stale) | y |",
        "",
        "## known",
        "",
        "## off",
        "",
        "## unlisted",
        "",
        "## gone",
        "",
        "## Adicionar uma regra",
      ].join("\n"),
    );
    expect(claimProblems(root)).toEqual([
      'AGENTS.md:2: a/b.test.ts não tem teste ativo com o título "keeps the old order"',
      "AGENTS.md:3: a/c.test.ts não existe",
      "AGENTS.md:4: a/b.test.ts sem o título do teste",
      'AGENTS.md:5: a/b.test.ts não tem teste ativo com o título "skipped"',
      "docs/README.md:1: freecorps/gone não existe no plugin freecorps",
      "docs/README.md:1: freecorps/off não está ligada em vite.config.ts",
      "docs/README.md:2: import/no-cycle não está ligada em vite.config.ts",
      'docs/README.md:2: marca fora da forma `caminho` › "título" ou `plugin/regra`',
      `${lintReference}: freecorps/unlisted fora da tabela`,
      `${lintReference}: stale na tabela, fora do plugin`,
      `${lintReference}: seção gone fora do plugin`,
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
