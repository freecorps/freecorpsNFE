import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

/**
 * Cada workspace declara o que o código de execução dele importa, e a raiz só
 * declara tooling (docs/DEPENDENCIAS.md, "Quem declara cada dependência"). O
 * Bun instala as dependências da raiz num node_modules que todo workspace
 * enxerga, e o knip conta a raiz como fonte de qualquer workspace; um import
 * que só a raiz declara resolve no repositório e some quando o workspace é
 * instalado sozinho (#156).
 */
const root = resolve(import.meta.dirname, "../..");

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")) as Manifest;

const builtins = new Set(builtinModules);

/** `@escopo/nome/sub` → `@escopo/nome`; `nome/sub` → `nome`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Pacotes externos que um arquivo importa, inclusive `import()` e reexportações. */
function importedPackages(source: string): string[] {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  return importedFiles
    .map(({ fileName }) => fileName)
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/"))
    .filter((specifier) => !specifier.startsWith("node:") && !builtins.has(specifier))
    .map(packageName);
}

/**
 * Arquivos de código de uma pasta, relativos à raiz e com `/`. A caminhada é
 * manual e pula `node_modules` e pastas com ponto: no Windows o `recursive`
 * do `readdirSync` segue as junctions do Bun até o `dist` dos pacotes, que
 * outra tarefa do `validate` recria ao mesmo tempo (scripts/lib/test-projects.mjs).
 */
function sourceFiles(folder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(path);
      } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(folder);
  return files;
}

/** Código que o Convex publica ou carrega: tudo fora dos testes. */
const platformRuntime = sourceFiles("platform").filter(
  (file) => !/\.test\.[cm]?[jt]sx?$/.test(file) && file !== "platform/test-setup.ts",
);

describe("manifests dos workspaces", () => {
  it("a raiz não declara dependências de execução", () => {
    expect(readManifest(".").dependencies).toBeUndefined();
  });

  it("encontra o código de execução da plataforma", () => {
    expect(platformRuntime).toContain("platform/convex/lib/certificateValidation.ts");
    expect(platformRuntime).not.toContain("platform/test-setup.ts");
    expect(platformRuntime.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  it("a plataforma declara em dependencies todo pacote que o código de execução importa", () => {
    const declared = new Set(Object.keys(readManifest("platform").dependencies ?? {}));
    const missing = platformRuntime.flatMap((file) =>
      importedPackages(readFileSync(join(root, file), "utf8"))
        .filter((name) => !declared.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("reconhece pacote com escopo, subcaminho, import dinâmico e reexportação", () => {
    const source = [
      'import forge from "node-forge";',
      'import { v } from "convex/values";',
      'import type { Foo } from "@convex-dev/workpool/_generated/component.js";',
      'export * from "fflate";',
      'const lazy = await import("better-auth/minimal");',
      'import { readFileSync } from "node:fs";',
      'import { join } from "path";',
      'import local from "./local";',
    ].join("\n");
    expect(importedPackages(source)).toEqual([
      "node-forge",
      "convex",
      "@convex-dev/workpool",
      "fflate",
      "better-auth",
    ]);
  });
});
