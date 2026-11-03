import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commands, helpText, renamed, renamedMessage, resolveDev } from "./lib/commands.mjs";
import { isLinkedWorktree } from "./lib/worktree/registry.mjs";

const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
const mailDocs = ["privacidade", "seguranca", "suporte", "operacao"].map(
  (inbox) => `docs/operacao/${inbox}-email.md`,
);

describe("catálogo de comandos", () => {
  it("descreve cada script da raiz e só os que existem", () => {
    const active = Object.keys(scripts).filter((name) => !(name in renamed));
    expect(active.sort()).toEqual(Object.keys(commands).sort());
    for (const [app, environment, description] of Object.values(commands))
      expect([app, environment, description].every(Boolean)).toBe(true);
  });

  it("mantém os nomes antigos só como aviso do novo nome", () => {
    for (const [old, next] of Object.entries(renamed)) {
      expect(scripts[old]).toBe(`node scripts/commands.mjs renamed ${old}`);
      expect(commands).toHaveProperty(next);
      expect(renamedMessage(old)).toContain(`bun run ${next}`);
    }
    expect(helpText()).toContain("packages:build");
  });

  it("não deixa a documentação citar script inexistente ou renomeado", () => {
    for (const file of [
      "README.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/worktrees.md",
      "docs/operacao/deploy-producao.md",
      ...mailDocs,
    ]) {
      const cited = [...read(file).matchAll(/(?:bun|vp) run ([a-z][\w:.-]*[\w])/g)].map(
        ([, name]) => name,
      );
      for (const name of cited)
        expect(
          name in commands || /^(test(:|$)|validate$|ci:)/.test(name),
          `${file}: ${name}`,
        ).toBe(true);
    }
  });
});

describe("publicação do Worker de e-mail", () => {
  it("publica o Worker freecorpsnfe-privacy-mail pela configuração dele", () => {
    const command = scripts["deploy:mail"] ?? "";
    const config = command.match(/(?:--config|-c)[ =](\S+)/)?.[1];
    expect(command).toMatch(/\bwrangler\S*\s+deploy\b/);
    expect(config).toBeDefined();
    expect(read(config!)).toMatch(/"name":\s*"freecorpsnfe-privacy-mail"/);
  });

  it("os roteiros das caixas publicam só pelo script", () => {
    // As seções datadas são registros do que foi rodado na época e ficam como estão.
    const dated = /^[^\n]* \d{2}\/\d{2}\/\d{4}/;
    for (const file of mailDocs) {
      const current = read(file)
        .split(/^## /m)
        .filter((section) => !dated.test(section))
        .join("");
      expect(current).not.toMatch(/wrangler\S*\s+deploy/);
    }
  });
});

describe("resolução de dev", () => {
  it("no worktree, dev inicia a sessão da plataforma", () => {
    expect(resolveDev("dev", { linked: true, app: "platform" })).toEqual({
      args: ["run", "worktree:dev"],
      target: "plataforma local do worktree",
    });
  });

  it("recusa worktree sem aplicativo conhecido ou preparado para o legado", () => {
    expect(() => resolveDev("dev", { linked: true })).toThrow(/desconhecido/);
    expect(() => resolveDev("dev", { linked: true, app: "outro" })).toThrow(/desconhecido/);
    expect(() => resolveDev("dev", { linked: true, app: "legacy" })).toThrow(/aposentado/);
  });

  it("no checkout principal, dev recusa e aponta o worktree", () => {
    expect(() => resolveDev("dev", { linked: false })).toThrow(/worktree:create/);
  });

  it("não há outro comando de dev", () => {
    for (const command of ["legacy:dev", "legacy:convex"])
      expect(() => resolveDev(command, { linked: false })).toThrow(/desconhecido/);
  });

  it("distingue checkout principal de worktree pelo git", () => {
    const base = mkdtempSync(join(tmpdir(), "fnfe-commands-"));
    try {
      const main = join(base, "main");
      const linked = join(base, "linked");
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "ignore" });
      execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
      git(
        main,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      );
      git(main, "worktree", "add", "-q", linked);
      expect(isLinkedWorktree(main)).toBe(false);
      expect(isLinkedWorktree(linked)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
