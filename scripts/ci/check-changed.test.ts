import { describe, expect, it } from "vite-plus/test";
import {
  affectedProjects,
  affectedWorkspaces,
  classify,
  parseArgs,
  steps,
} from "../lib/check-changed.mjs";

describe("argumentos", () => {
  it("usa origin/main e aceita --base nas duas formas", () => {
    expect(parseArgs([])).toEqual({ base: "origin/main", dryRun: false, help: false });
    expect(parseArgs(["--base", "HEAD~2", "--dry-run"])).toMatchObject({
      base: "HEAD~2",
      dryRun: true,
    });
    expect(parseArgs(["--base=main"]).base).toBe("main");
  });

  it("recusa argumento desconhecido e --base sem ref", () => {
    expect(() => parseArgs(["--fix"])).toThrow("Argumento desconhecido");
    expect(() => parseArgs(["--base"])).toThrow("--base exige");
    expect(() => parseArgs(["--base", "--dry-run"])).toThrow("--base exige");
    expect(() => parseArgs(["--base="])).toThrow("--base exige");
  });
});

describe("classificação da mudança", () => {
  it("sem arquivos não há o que conferir", () => {
    expect(classify({ files: [] }).mode).toBe("empty");
    expect(steps(classify({ files: [] }), { base: "abc" })).toEqual([]);
  });

  it("só documentação roda a formatação e os testes que leem toda a documentação", () => {
    const change = classify({ files: ["docs/plataforma/USAGE.md"] });
    expect(change.mode).toBe("docs");
    expect(steps(change, { base: "abc" }).map((step) => step.name)).toEqual([
      "formatação",
      "testes da documentação",
    ]);
  });

  it("documentação lida por teste, ou apagada, roda o conjunto inteiro", () => {
    expect(classify({ files: ["AGENTS.md"] }).mode).toBe("full");
    expect(classify({ files: [], deleted: ["docs/plataforma/USAGE.md"] }).mode).toBe("full");
  });

  it("formata o que existe e faz lint só de JS e TS", () => {
    const change = classify({
      files: ["platform/convex/keys.ts", "docs/plataforma/USAGE.md", "apps/console/src/a.tsx"],
      deleted: ["platform/convex/old.ts"],
    });
    expect(change.format).toEqual([
      "platform/convex/keys.ts",
      "docs/plataforma/USAGE.md",
      "apps/console/src/a.tsx",
    ]);
    expect(change.lint).toEqual(["platform/convex/keys.ts", "apps/console/src/a.tsx"]);
  });

  it("configuração ou código apagado pede o typecheck de todos os projetos", () => {
    expect(classify({ files: ["platform/convex/keys.ts"] }).everyProject).toBe(false);
    for (const file of ["tsconfig.json", "apps/docs/tsconfig.json", "bun.lock", "package.json"])
      expect(classify({ files: [file] }).everyProject, file).toBe(true);
    expect(classify({ files: [], deleted: ["scripts/lib/x.mjs"] }).everyProject).toBe(true);
  });

  it("confere as fronteiras só quando um pacote ou o que a checagem lê muda", () => {
    expect(classify({ files: ["packages/sdk/src/index.ts"] }).boundaries).toBe(true);
    expect(classify({ files: ["scripts/build/package-boundaries.json"] }).boundaries).toBe(true);
    expect(classify({ files: ["platform/convex/keys.ts"] }).boundaries).toBe(false);
  });
});

describe("projetos e pacotes afetados", () => {
  const programs = {
    "tsconfig.platform.json": ["platform/convex/keys.ts", "scripts/lib/a.mjs"],
    "apps/console/tsconfig.json": ["apps/console/src/a.tsx", "platform/convex/keys.ts"],
    "apps/docs/tsconfig.json": ["apps/docs/app/x.tsx"],
  };

  it("checa o projeto cujo programa contém o arquivo, inclusive por import relativo", () => {
    expect(affectedProjects(["platform/convex/keys.ts"], programs, false)).toEqual([
      "tsconfig.platform.json",
      "apps/console/tsconfig.json",
    ]);
    expect(affectedProjects(["apps/docs/app/x.tsx"], programs, false)).toEqual([
      "apps/docs/tsconfig.json",
    ]);
    expect(affectedProjects(["README.md"], programs, false)).toEqual([]);
    expect(affectedProjects(["README.md"], programs, true)).toEqual(Object.keys(programs));
  });

  it("soma os dependentes de cada pacote alterado, por transitividade", () => {
    const manifests = {
      "packages/fiscal-core": { name: "@freecorps/fiscal-core" },
      "packages/contracts": {
        name: "@freecorps/contracts",
        dependencies: { "@freecorps/fiscal-core": "workspace:*" },
      },
      "packages/sdk": {
        name: "@freecorps/sdk",
        devDependencies: { "@freecorps/contracts": "workspace:*" },
      },
      platform: { name: "platform", dependencies: { "@freecorps/contracts": "workspace:*" } },
    };
    const dirs = Object.keys(manifests);
    expect(affectedWorkspaces(["packages/fiscal-core/src/cnpj.ts"], dirs, manifests)).toEqual({
      changed: ["packages/fiscal-core"],
      dependents: ["packages/contracts", "packages/sdk", "platform"],
    });
    expect(affectedWorkspaces(["packages/sdk/src/index.ts"], dirs, manifests)).toEqual({
      changed: ["packages/sdk"],
      dependents: [],
    });
    expect(affectedWorkspaces(["scripts/lib/a.mjs"], dirs, manifests)).toEqual({
      changed: [],
      dependents: [],
    });
  });
});

describe("etapas", () => {
  it("roda formatação, pacotes, lint, typecheck, fronteiras e testes contra o merge-base", () => {
    const change = classify({ files: ["packages/sdk/src/index.ts"] });
    const plan = steps(change, { base: "abc123", projects: ["tsconfig.platform.json"] });
    expect(plan.map((step) => step.name)).toEqual([
      "formatação",
      "pacotes fiscais",
      "lint",
      "typecheck tsconfig.platform.json",
      "fronteiras dos pacotes",
      "testes alcançados",
    ]);
    expect(plan.at(-1)!.command).toEqual([
      "vp",
      "test",
      "run",
      "--changed",
      "abc123",
      "--passWithNoTests",
    ]);
    expect(plan.find((step) => step.name === "lint")!.command).toContain("--deny-warnings");
  });

  it("sem código para lint nem typecheck não compila os pacotes", () => {
    const change = classify({ files: ["AGENTS.md"] });
    expect(steps(change, { base: "abc" }).map((step) => step.name)).toEqual([
      "formatação",
      "testes alcançados",
    ]);
  });
});
