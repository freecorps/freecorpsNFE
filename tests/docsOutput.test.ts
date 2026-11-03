import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  dashPositions,
  flattenPages,
  pageProblems,
  rewriteHtml,
  splitMarkdown,
  staticPage,
  unhashedAssets,
} from "../apps/docs/scripts/output.mjs";

describe("saída da documentação", () => {
  it("achata as páginas sem apagar as aninhadas sob um índice de seção", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-out-"));
    try {
      for (const page of ["index.html", "api/index.html", "api/a/index.html", "guia/index.html"]) {
        mkdirSync(join(root, page, ".."), { recursive: true });
        writeFileSync(join(root, page), page);
      }
      writeFileSync(join(root, "api/a.data"), "dados");
      expect(flattenPages(root).sort()).toEqual(["api.html", "api/a.html", "guia.html"]);
      for (const file of ["index.html", "api.html", "api/a.html", "api/a.data", "guia.html"])
        expect(existsSync(join(root, file)), file).toBe(true);
      expect(existsSync(join(root, "guia"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separa o Markdown de cada guia e retira o mapa da saída", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-out-"));
    try {
      writeFileSync(
        join(root, "markdown.json"),
        JSON.stringify({ "index.md": "# Início", "guia.md": "# Guia" }),
      );
      writeFileSync(join(root, "markdown.json.data"), "dados");
      expect(splitMarkdown(root)).toEqual(["guia.md", "index.md"]);
      expect(readFileSync(join(root, "guia.md"), "utf8")).toBe("# Guia");
      expect(existsSync(join(root, "markdown.json"))).toBe(false);
      expect(existsSync(join(root, "markdown.json.data"))).toBe(false);
      for (const name of ["../fora.md", "guia.html", "/abs.md", "Guia.md"]) {
        writeFileSync(join(root, "markdown.json"), JSON.stringify({ [name]: "x" }));
        expect(() => splitMarkdown(root), name).toThrow(/Markdown inválido/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("move scripts e estilos inline para fora do HTML", () => {
    const rules = new Map<string, string>();
    const scripts = new Map<string, string>();
    const { html, styleBlocks } = rewriteHtml(
      '<head></head><p style="color:&quot;red&quot;">x</p><script>a()</script>' +
        '<script type="module">b()</script><script src="/c.js"></script><script> </script>' +
        "<style>.r{}</style>",
      rules,
      (name: string, body: string) => scripts.set(name, body),
    );
    expect([...scripts.values()]).toEqual(["a()", "b()"]);
    expect(html).toContain('<script type="module" src="/docs/assets/inline/');
    expect(html).toContain('<script src="/c.js"></script>');
    expect([...rules.values()]).toEqual(['color:"red"']);
    expect(html).toMatch(/<p data-fd-style="[0-9a-f]{10}">/);
    expect(styleBlocks).toEqual([".r{}"]);
    expect(pageProblems(html)).toEqual([]);
  });

  it("recusa o que a CSP bloquearia ou o que só aparece com JavaScript", () => {
    expect(pageProblems("<script>x()</script>")).toEqual(["Script inline"]);
    expect(pageProblems('<p style="x">')).toEqual(["Atributo style"]);
    expect(pageProblems('<a onclick="x()">')).toEqual(["Handler inline"]);
    expect(pageProblems('<div hidden id="S:0">')).toEqual(["Fragmento adiado"]);
  });

  it("aponta linha e coluna de cada travessão do texto autoral", () => {
    expect(dashPositions("sem nada\n")).toEqual([]);
    expect(dashPositions("a\nb \u2014 c \u2013 d")).toEqual([
      { line: 2, column: 3 },
      { line: 2, column: 7 },
    ]);
  });

  it("serve a página de não encontrado sem scripts nem botões, com estilos e links", () => {
    const page = staticPage(
      '<head><link rel="modulepreload" href="/docs/assets/a-12345678.js"/><link rel="stylesheet" href="/docs/assets/b-12345678.css"/></head>' +
        '<header><button type="button" aria-label="Abrir busca"><svg></svg></button><a href="/">Início</a></header>' +
        '<main><h1>Página não encontrada</h1><a href="/docs/">Ir</a></main>' +
        '<script src="/docs/assets/inline/0123456789abcdef.js"></script><script type="module" src="/x.js"></script>',
    );
    expect(page).not.toMatch(/<script|modulepreload|<button/);
    expect(page).toContain('<a href="/">Início</a>');
    expect(page).toContain('rel="stylesheet"');
    expect(page).toContain('<a href="/docs/">');
  });

  it("aceita como imutável só nomes com hash do conteúdo", () => {
    expect(
      unhashedAssets([
        "manifest-40e68343.js",
        "docs--c54p2Ww.js",
        "url-BVHvi3_K-CJAms2v1.js",
        "root-BcibQ_O2.css",
        "inline/009f9d808aa1cbcf.js",
        "inline-60b008a63c28e840.css",
      ]),
    ).toEqual([]);
    expect(
      unhashedAssets(["manifest.js", "search.json", "inline/x.js", "inline.css", "app-1234.js"]),
    ).toEqual(["manifest.js", "search.json", "inline/x.js", "inline.css", "app-1234.js"]);
  });
});
