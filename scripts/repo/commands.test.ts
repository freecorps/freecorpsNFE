import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commands, helpText, resolveDev } from "../lib/commands.mjs";
import { isLinkedWorktree } from "../lib/worktree/registry.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

const root = repoRoot;
const read = (file: string) => readFileSync(join(root, file), "utf8");
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
describe("catálogo de comandos", () => {
  it("descreve cada script da raiz e só os que existem", () => {
    expect(Object.keys(scripts).sort()).toEqual(Object.keys(commands).sort());
    for (const [app, environment, description] of Object.values(commands))
      expect([app, environment, description].every(Boolean)).toBe(true);
    expect(helpText()).toContain("packages:build");
  });

  it("não deixa documentação, skills ou t3.json citar script inexistente", () => {
    // Skills de terceiros (skills-lock.json) citam scripts de outros projetos.
    const external = Object.keys(JSON.parse(read("skills-lock.json")).skills).map(
      (name) => `.agents/skills/${name}/`,
    );
    const files = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "ls-files", "-z", "--", "*.md", "t3.json"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter((file) => file && !external.some((prefix) => file.startsWith(prefix)));
    expect(files).toContain("docs/worktrees.md");
    expect(files).toContain(".agents/skills/verify-console/SKILL.md");
    for (const file of files) {
      const text = read(file);
      // Página aposentada guarda o registro do que foi feito, com os comandos da época.
      if (/^> \*\*Aposentado\.\*\*/m.test(text)) continue;
      const cited = [...text.matchAll(/(?:bun|vp) run ([a-z][\w:.-]*[\w])/g)].map(
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
