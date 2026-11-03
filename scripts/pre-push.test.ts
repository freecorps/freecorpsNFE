import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { blockingLines, pushedCommits, scanArgs } from "./pre-push.mjs";

const zero = "0".repeat(40);
const a = "a".repeat(40);
const b = "b".repeat(40);

// Montado em tempo de execução: este arquivo vai para o repositório público e
// não pode conter um CNPJ que a varredura acuse.
const cnpjWithDv = (base: string) => {
  const dv = (digits: string) => {
    let sum = 0;
    let weight = digits.length - 7;
    for (const c of digits) {
      sum += (c.charCodeAt(0) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return String(rest < 2 ? 0 : 11 - rest);
  };
  const first = base + dv(base);
  return first + dv(first);
};

describe("hook pre-push", () => {
  it("varre cada commit enviado uma vez e ignora remoções", () => {
    const input = [
      `refs/heads/x ${a} refs/heads/x ${zero}`,
      `refs/heads/y ${a} refs/heads/y ${b}`,
      `(delete) ${zero} refs/heads/z ${b}`,
      `refs/tags/t ${b} refs/tags/t ${zero}`,
      "",
    ].join("\r\n");
    expect(pushedCommits(input)).toEqual([a, b]);
    expect(pushedCommits("")).toEqual([]);
  });

  it("pula o Gitleaks só quando ele falta", () => {
    expect(scanArgs(a, "/o", true)).toEqual(["--checkout", "--sha", a, "--out", "/o"]);
    expect(scanArgs(a, "/o", false)).toContain("--sem-gitleaks");
  });

  it("lista só o que bloqueia, sem o valor", () => {
    const report = {
      findings: {
        items: [
          { path: "docs/a.md", line: 3, kind: "cnpj-nao-sintetico" },
          { path: "docs/a.md", line: 4, kind: "repositorio-privado" },
          { path: "a.ts", line: 1, kind: "segredo-gitleaks", rule: "generic-api-key" },
        ],
        staleAllowlist: [{ path: "b.ts", kind: "segredo", rule: "private-key", count: 1 }],
      },
      unclassified: [],
    };
    expect(blockingLines(report)).toEqual([
      "  docs/a.md:3 cnpj-nao-sintetico",
      "  a.ts:1 segredo-gitleaks (generic-api-key)",
      "  exceção obsoleta: b.ts segredo private-key",
    ]);
  });

  // Um commit de HEAD com um arquivo a mais, num banco de objetos temporário
  // que enxerga o do repositório: o .git não ganha objeto.
  const push = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "pre-push-"));
    try {
      const objects = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        { encoding: "utf8" },
      ).trim();
      mkdirSync(join(dir, "objects", "info"), { recursive: true });
      writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
      const env = {
        ...process.env,
        GIT_OBJECT_DIRECTORY: join(dir, "objects"),
        GIT_INDEX_FILE: join(dir, "index"),
        GIT_AUTHOR_NAME: "teste",
        GIT_AUTHOR_EMAIL: "teste@example.com",
        GIT_COMMITTER_NAME: "teste",
        GIT_COMMITTER_EMAIL: "teste@example.com",
        // O Gitleaks fica de fora: o teste prova as regras do próprio projeto.
        GITLEAKS_BIN: join(dir, "sem-gitleaks"),
      };
      const git = (args: string[], input?: string) =>
        execFileSync("git", args, { encoding: "utf8", input, env }).trim();
      git(["read-tree", "HEAD"]);
      for (const [path, text] of Object.entries(files))
        git([
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${git(["hash-object", "-w", "--stdin"], text)},${path}`,
        ]);
      const commit = git(["commit-tree", git(["write-tree"]), "-p", "HEAD", "-m", "teste"]);
      const result = spawnSync(process.execPath, ["scripts/pre-push.mjs"], {
        encoding: "utf8",
        env,
        input: `refs/heads/t ${commit} refs/heads/t ${zero}\n`,
      });
      const report = /relatório em (.+varredura\.json)/.exec(result.stderr)?.[1];
      return { ...result, report: report && readFileSync(report, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("recusa o push de um CNPJ real sem mostrar o número", () => {
    const cnpj = cnpjWithDv("735219480001");
    const result = push({ "docs/teste-vazamento.md": `Cliente ${cnpj}\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/teste-vazamento.md:1 cnpj-nao-sintetico");
    expect(result.stderr).toContain("push recusado");
    expect(`${result.stdout}${result.stderr}${result.report}`).not.toContain(cnpj);
    if (result.report)
      rmSync(join(result.stderr.match(/relatório em (.+)saida/)![1]), {
        recursive: true,
        force: true,
      });
  }, 120_000);

  it("deixa passar um commit sem achados e avisa da falta do Gitleaks", () => {
    const result = push({ "docs/teste-limpo.md": "Sem dado real.\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sem achados que bloqueiam");
    expect(result.stdout).toContain("sem o Gitleaks");
  }, 120_000);
});
