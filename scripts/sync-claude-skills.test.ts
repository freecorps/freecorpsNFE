import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { frontmatter, inspect, problems, stub, sync } from "./sync-claude-skills.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

describe("atalhos das skills para o Claude Code", () => {
  it("o repositório tem um atalho atual em .claude/skills para cada skill", () => {
    const result = inspect(repository);
    expect(problems(result), "rode `node scripts/sync-claude-skills.mjs`").toEqual([]);
    expect(result.expected.has("manager")).toBe(true);
  });

  it("o atalho copia o frontmatter literalmente e aponta para a skill real", () => {
    const text = '---\nname: demo\ndescription: "Faz: algo"\nlicense: MIT\n---\n\n# Demo\n';
    const content = stub("demo", text);
    expect(
      content.startsWith('---\nname: demo\ndescription: "Faz: algo"\nlicense: MIT\n---\n'),
    ).toBe(true);
    expect(content).toContain("`.agents/skills/demo/SKILL.md`");
    expect(content).not.toContain("# Demo");
    expect(content).not.toContain("\r");
    expect(stub("demo", text.replaceAll("\n", "\r\n"))).toBe(content);
    expect(() => frontmatter("# sem frontmatter\n")).toThrow();
    // BOM, delimiter with trailing spaces and a file with only the frontmatter.
    expect(frontmatter(`﻿${text}`)).toBe(frontmatter(text));
    expect(frontmatter("---\nname: x\n--- \n\nCorpo\n\n---\nnão é frontmatter\n")).toBe(
      "---\nname: x\n--- \n",
    );
    expect(frontmatter("---\nname: x\n---")).toBe("---\nname: x\n---\n");
  });

  describe("num diretório temporário", () => {
    let root: string;
    const skill = (name: string) => {
      mkdirSync(join(root, ".agents/skills", name), { recursive: true });
      writeFileSync(
        join(root, ".agents/skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`,
      );
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "sync-claude-skills-"));
      skill("alfa");
      skill("beta");
      writeFileSync(join(root, ".agents/skills/EXTERNAS.md"), "# notas\n");
      writeFileSync(join(root, ".agents/skills/check-refs.py"), "print()\n");
      mkdirSync(join(root, ".agents/skills/licencas"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("ignora o que não é diretório com SKILL.md e acusa o atalho ausente", () => {
      expect(problems(inspect(root))).toEqual([
        "missing .claude/skills/alfa",
        "missing .claude/skills/beta",
      ]);
    });

    it("acusa atalho desatualizado, symlink em texto, arquivo a mais e entrada sem skill", () => {
      sync(root);
      const stubs = join(root, ".claude/skills");
      writeFileSync(join(stubs, "alfa/SKILL.md"), "---\nname: alfa\n---\n");
      writeFileSync(join(stubs, "beta/notas.md"), "extra\n");
      // A symlink checked out with core.symlinks=false: a file holding the target.
      writeFileSync(join(stubs, "gama"), "../../.agents/skills/gama");
      mkdirSync(join(stubs, "delta"));
      expect(problems(inspect(root))).toEqual([
        "stale .claude/skills/alfa",
        "stale .claude/skills/beta",
        "extra .claude/skills/delta",
        "extra .claude/skills/gama",
      ]);
    });

    it("sync corrige tudo e é idempotente", () => {
      const stubs = join(root, ".claude/skills");
      mkdirSync(stubs, { recursive: true });
      writeFileSync(join(stubs, "alfa"), "../../.agents/skills/alfa");
      writeFileSync(join(stubs, "gama"), "../../.agents/skills/gama");
      sync(root);
      expect(problems(inspect(root))).toEqual([]);
      expect(readdirSync(stubs).sort()).toEqual(["alfa", "beta"]);
      expect(readFileSync(join(stubs, "alfa/SKILL.md"), "utf8")).toMatch(
        /^---\nname: alfa\ndescription: alfa\n---\n/,
      );
      expect(problems(sync(root))).toEqual([]);
    });

    it("sync não apaga uma skill mantida só em .claude/skills e a acusa como sobra", () => {
      const own = join(root, ".claude/skills/pessoal");
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, "SKILL.md"), "---\nname: pessoal\ndescription: minha\n---\n");
      writeFileSync(join(root, ".claude/skills/README.md"), "# Notas\n");
      expect(problems(sync(root))).toEqual(
        expect.arrayContaining(["extra .claude/skills/pessoal", "extra .claude/skills/README.md"]),
      );
      expect(readFileSync(join(own, "SKILL.md"), "utf8")).toContain("minha");
      expect(readFileSync(join(root, ".claude/skills/README.md"), "utf8")).toBe("# Notas\n");
      // A stub generated for a skill that was removed is ours, and goes.
      rmSync(join(root, ".agents/skills/beta"), { recursive: true });
      sync(root);
      expect(readdirSync(join(root, ".claude/skills")).sort()).toEqual([
        "README.md",
        "alfa",
        "pessoal",
      ]);
    });

    it("o erro de frontmatter nomeia a skill", () => {
      writeFileSync(join(root, ".agents/skills/beta/SKILL.md"), "# sem frontmatter\n");
      expect(() => inspect(root)).toThrow(".agents/skills/beta/SKILL.md");
    });
  });
});
