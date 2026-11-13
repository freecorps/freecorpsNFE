import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { expect, it } from "vite-plus/test";

/**
 * Todo link relativo da documentação aponta para um arquivo versionado e, com
 * âncora, para um título ou `id` que existe no destino (#157). O link é
 * resolvido como o GitHub o resolve na página do arquivo: relativo à pasta do
 * documento, ou à raiz do repositório quando começa por `/`. Âncora num
 * arquivo que não é Markdown (`código.ts#L10`) não é conferida.
 *
 * Vale para todo `.md` versionado: `docs/`, a raiz, as skills de `.agents/` e
 * `.claude/`, os READMEs dos pacotes. As páginas `.mdx` de `apps/docs/content/`
 * ficam de fora: os links delas são rotas do site, não caminhos de arquivo.
 */
const checked = (file: string) => file.endsWith(".md");

const markdown = /\.mdx?$/;

const blank = (part: string) => part.replace(/[^\n]/g, " ");

/**
 * Apaga os blocos de código cercados e os comentários HTML. Troca cada
 * caractere por espaço para que as posições, e com elas o número da linha,
 * continuem as do arquivo.
 */
function withoutBlocks(text: string) {
  // O front matter das skills não é título: o `---` que o fecha não vira setext.
  const lines = text.replace(/^---\n[\s\S]*?\n---(?=\n|$)/, blank).split("\n");
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !/\S/.test(line.slice(line.indexOf(marker) + marker.length))
      )
        fence = undefined;
      lines[index] = blank(line);
    } else if (marker) {
      fence = marker;
      lines[index] = blank(line);
    }
  }
  return lines.join("\n").replace(/<!--[\s\S]*?-->/g, blank);
}

/** O texto que pode ter link: sem blocos, comentários e trechos de código em linha. */
export function prose(text: string) {
  // Um trecho de código em linha não atravessa a linha em branco do parágrafo.
  return withoutBlocks(text).replace(/(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\1(?!`)/g, blank);
}

/** O identificador que o GitHub dá a um título, sem o sufixo de repetição. */
export function slug(heading: string) {
  // Trechos de código entram literais; no resto, só o texto de links, HTML e ênfase.
  const text = heading
    .split(/(`+)([^`]*?)\1/)
    .map((part, index) =>
      index % 3 === 2
        ? part
        : index % 3 === 1
          ? ""
          : part
              .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
              .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
              .replace(/<[^>]+>/g, "")
              .replace(/(^|[^\p{L}\p{N}])__(.+?)__(?=[^\p{L}\p{N}]|$)/gu, "$1$2")
              .replace(/(^|[^\p{L}\p{N}])_(.+?)_(?=[^\p{L}\p{N}]|$)/gu, "$1$2"),
    )
    .join("");
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Âncoras de um Markdown: os títulos, com `-1`, `-2` nas repetições, e os `id`/`name` de HTML. */
export function anchors(text: string) {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  const add = (heading: string) => {
    const base = slug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  };
  // O texto de um trecho de código entra no identificador do título.
  const body = withoutBlocks(text);
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    const atx = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
    if (atx) add(atx[1] ?? "");
    else if (
      /^ {0,3}(?:=+|-+)\s*$/.test(line) &&
      index > 0 &&
      /\S/.test(lines[index - 1]!) &&
      !/^ {0,3}(?:#|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[index - 1]!)
    )
      add(lines[index - 1]!.trim());
  }
  for (const [, double, single] of body.matchAll(
    /<[a-z][^>]*\s(?:id|name)=(?:"([^"]+)"|'([^']+)')/gi,
  ))
    found.add((double ?? single)!);
  return found;
}

export type DocumentLink = { line: number; target: string };

/** Links de um Markdown: inline, imagens, definições de referência e `href`/`src` de HTML. */
export function links(text: string): DocumentLink[] {
  const body = prose(text);
  const target = String.raw`(?:<([^>\n]*)>|((?:[^\s()]|\([^\s()]*\))+))`;
  const patterns = [
    new RegExp(String.raw`\]\(\s*${target}(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)`, "g"),
    // `[^1]: texto` é nota de rodapé, não definição de link.
    new RegExp(String.raw`^ {0,3}\[(?!\^)[^\]\n]+\]:\s*${target}`, "gm"),
    /<(?:a|img)\b[^>]*?\s(?:href|src)=(?:"([^"]+)"|'([^']+)')/gi,
  ];
  const found: DocumentLink[] = [];
  for (const pattern of patterns)
    for (const match of body.matchAll(pattern))
      found.push({
        line: body.slice(0, match.index).split("\n").length,
        target: match[1] ?? match[2]!,
      });
  return found.sort((a, b) => a.line - b.line);
}

function decode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Arquivos versionados ou novos ainda fora do `.gitignore`, como o GitHub os verá. */
function repositoryFiles(root: string) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

/** Links relativos quebrados dos `.md` de `root`, como `arquivo:linha: link` e o motivo. */
export function brokenLinks(root: string) {
  // Apagado no working tree e ainda no índice não conta como existente.
  const files = repositoryFiles(root).filter((file) => existsSync(join(root, file)));
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const existing = new Set(files);
  const folders = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  );
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (file: string) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(read(file)));
    return anchorCache.get(file)!;
  };
  const problems: string[] = [];
  for (const file of files.filter(checked)) {
    for (const { line, target } of links(read(file))) {
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) continue;
      const [location, anchor] = target.split("#", 2) as [string, string | undefined];
      const [address, query] = location.split("?", 2) as [string, string | undefined];
      const path = decode(address);
      const resolved = path
        ? posix
            .normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(file), path))
            .replace(/\/$/, "")
        : file;
      const where = `${file}:${line}: ${target}`;
      if (resolved === ".." || resolved.startsWith("../"))
        problems.push(`${where} sai do repositório`);
      else if (!existing.has(resolved) && !folders.has(resolved) && resolved !== ".")
        problems.push(`${where} aponta para ${resolved}, que não existe`);
      // Com query (`?plain=1#L5`), o GitHub mostra o código-fonte e a âncora é de linha.
      else if (
        anchor &&
        query === undefined &&
        markdown.test(resolved) &&
        !anchorsOf(resolved).has(decode(anchor))
      )
        problems.push(`${where} cita a âncora #${decode(anchor)}, que ${resolved} não tem`);
    }
  }
  return problems;
}

it("reads the anchors GitHub generates for headings", () => {
  const text = [
    "---",
    "name: skill",
    "description: Front matter",
    "---",
    "# Frontend do console",
    "## Mudança só de documentação",
    "## `vp check` e o `ci:local`",
    "### Etapa 1 — preparação (opcional)",
    "## Notas",
    "## Notas",
    "## [Link](x.md) e __negrito__ com snake_case",
    "Título setext",
    "-------------",
    "```md",
    "## Dentro do bloco",
    "```",
    '<a id="ancora-manual"></a>',
    "## `<Toaster />` e `__init__`",
    "<h2 id='aspas-simples'>Título</h2>",
  ].join("\n");
  expect([...anchors(text)]).toEqual([
    "frontend-do-console",
    "mudança-só-de-documentação",
    "vp-check-e-o-cilocal",
    "etapa-1--preparação-opcional",
    "notas",
    "notas-1",
    "link-e-negrito-com-snake_case",
    "título-setext",
    "toaster--e-__init__",
    "ancora-manual",
    "aspas-simples",
  ]);
});

it("finds links outside code and keeps their line", () => {
  const text = [
    "Veja [ARQUITETURA](../ARQUITETURA.md#mapa) e ![logo](img/logo.png 'Logo').",
    "`[não](conta.md)` nem <!-- [isto](comentario.md) -->",
    "```",
    "[nem isto](bloco.md)",
    "```",
    "[ref]: <com espaço.md>",
    '<a href="pasta/">pasta</a> e [chamada](foo_(bar).md)',
    "[^1]: Nota de rodapé, não link.",
    "<img src='img/x.png'>",
  ].join("\n");
  expect(links(text)).toEqual([
    { line: 1, target: "../ARQUITETURA.md#mapa" },
    { line: 1, target: "img/logo.png" },
    { line: 6, target: "com espaço.md" },
    { line: 7, target: "foo_(bar).md" },
    { line: 7, target: "pasta/" },
    { line: 9, target: "img/x.png" },
  ]);
});

it("rejects, in a throwaway copy, a missing file, a missing anchor and a link out of the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    write("docs/ARQUITETURA.md", "# Arquitetura\n\n## Mapa do repositório\n");
    write("scripts/lib/ci.mjs", "");
    write(
      "docs/plataforma/backend.md",
      [
        "# Backend",
        "",
        "[mapa](../ARQUITETURA.md#mapa-do-repositório), [script](../../scripts/lib/ci.mjs#L3),",
        "[pasta](/scripts/lib/), [aqui](#backend), [fonte](../ARQUITETURA.md?plain=1#L3) e [site](https://exemplo.com.br/x.md).",
        "O plano está em [planejamento](../planejamento-v1/backend.md).",
        "[mapa velho](../ARQUITETURA.md#mapa) e [fora](../../../fora.md).",
      ].join("\n"),
    );
    write("apps/docs/content/docs/pagina.mdx", "[rota do site](/docs/sdk)\n");
    expect(brokenLinks(root)).toEqual([
      "docs/plataforma/backend.md:5: ../planejamento-v1/backend.md aponta para docs/planejamento-v1/backend.md, que não existe",
      "docs/plataforma/backend.md:6: ../ARQUITETURA.md#mapa cita a âncora #mapa, que docs/ARQUITETURA.md não tem",
      "docs/plataforma/backend.md:6: ../../../fora.md sai do repositório",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps every relative link in the documentation pointing at something that exists", () => {
  expect(brokenLinks(".")).toEqual([]);
});
