import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { repoRoot } from "../lib/repo-root.mjs";

// The proof of the public build (scripts/console/prove-public-site.mjs) reads a dist without
// JavaScript: a console screen is a link it accepts, but only without a query, except the
// task entry (`taskEntryHref`, #510). This builds the smallest dist the script reads and
// runs it against a landing or a docs page with the link under test.
const root = repoRoot;
const script = join(root, "scripts/console/prove-public-site.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const page = (href: string) =>
  `<!doctype html><html><body><h1>Página</h1><main><p>${"texto ".repeat(120)}</p>` +
  `<a href="${href}">entrada</a></main></body></html>`;

function prove(landingLink: string, docsLink = "/docs/", assets: string[] = []) {
  const dist = mkdtempSync(join(tmpdir(), "fnfe-public-site-"));
  dirs.push(dist);
  mkdirSync(join(dist, "docs"), { recursive: true });
  mkdirSync(join(dist, "assets"));
  for (const asset of assets) writeFileSync(join(dist, "assets", asset), "");
  writeFileSync(join(dist, "index.html"), page(landingLink));
  writeFileSync(join(dist, "docs/index.html"), page(docsLink));
  writeFileSync(join(dist, "docs/search.json"), "[]");
  writeFileSync(join(dist, "docs.data"), "");
  const result = spawnSync(process.execPath, [script, dist], { cwd: root, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("prova do site público: links para o console", () => {
  it("aceita a tela sem consulta e a entrada da tarefa no cadastro", () => {
    for (const href of [
      "/console",
      "/login",
      "/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar",
      "/signup?redirect=%2Fconsole%3Ftarefa%3Dintegrar",
    ]) {
      const result = prove(href, href);
      expect([href, result.status, result.stderr]).toEqual([href, 0, ""]);
      expect(JSON.parse(result.stdout)).toMatchObject({ pages: 2, links: 0 });
    }
  });

  it("recusa qualquer outra consulta numa tela do console, na landing ou na documentação", () => {
    for (const href of [
      "/signup?redirect=//evil.example",
      "/signup?redirect=%2F%2Fevil.example",
      "/signup?redirect=%2Fconsole%3Ftarefa%3Dimportar&x=1",
      "/signup?redirect=%2Fconsole%3Ftarefa%3Dexcluir",
      "/login?redirect=%2Fconsole%3Ftarefa%3Dimportar",
      "/console?tarefa=importar",
    ]) {
      const onDocs = prove("/console", href);
      expect([href, onDocs.status]).toEqual([href, 1]);
      expect(onDocs.stderr).toContain(`docs/index.html: ${href}`);
      const onLanding = prove(href);
      expect([href, onLanding.status]).toEqual([href, 1]);
      expect(onLanding.stderr).toContain(`index.html: ${href}`);
    }
  });
});

describe("prova do site público: telas de desenvolvimento", () => {
  it("aceita o bundle sem os chunks das telas de apps/console/src/dev", () => {
    const result = prove("/console", "/docs/", ["index-abc123.js", "routes-abc123.js"]);
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(JSON.parse(result.stdout)).toMatchObject({ devChunks: 0 });
  });

  it("recusa o bundle com o protótipo ou a referência de componentes", () => {
    for (const chunk of ["prototype-abc123.js", "component-reference-abc123.js"]) {
      const result = prove("/console", "/docs/", ["index-abc123.js", chunk]);
      expect([chunk, result.status]).toEqual([chunk, 1]);
      expect(result.stderr).toContain(chunk);
    }
  });
});
