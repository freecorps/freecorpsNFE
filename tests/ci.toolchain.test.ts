import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import rootManifest from "../package.json";

/**
 * O Vite+ resolve os binários do Oxc (`oxfmt`, `oxlint`, `oxlint-tsgolint`) com
 * `require.resolve(nome, { paths: [process.cwd(), <vite-plus>] })`. O Node sobe
 * pelos diretórios pais a partir do cwd, e o linker isolado do Bun só põe no
 * `node_modules` da raiz as dependências declaradas no manifest. Num worktree
 * criado dentro de outro checkout, a busca saía do projeto e achava o oxfmt do
 * checkout de fora, de outra versão, e `vp fmt --check` dava outro resultado
 * para o mesmo commit (#570). Declarar as três ferramentas na raiz, na versão
 * exata que o vite-plus instalado exige, faz a busca parar no próprio checkout.
 */
const root = realpathSync(resolve(import.meta.dirname, ".."));
const projectRequire = createRequire(join(root, "package.json"));
const vitePlus = projectRequire("vite-plus/package.json") as {
  version: string;
  dependencies: Record<string, string>;
};
const tools = ["oxfmt", "oxlint", "oxlint-tsgolint"] as const;

describe("ferramentas do Oxc na raiz", () => {
  for (const tool of tools) {
    it(`${tool} fixa na raiz a versão exata exigida pelo vite-plus ${vitePlus.version}`, () => {
      const expected = vitePlus.dependencies[tool]?.replace(/^=/, "");
      expect(expected, `vite-plus deixou de depender de ${tool}`).toMatch(/^\d/);
      expect(rootManifest.devDependencies[tool]).toBe(expected);
    });

    it(`${tool} resolve de dentro deste checkout a partir da raiz do projeto`, () => {
      // Mesma busca que o vite-plus faz a partir do cwd, antes de recorrer à própria cópia.
      const manifestPath = realpathSync(
        projectRequire.resolve(`${tool}/package.json`, { paths: [root] }),
      );
      expect(manifestPath.startsWith(root + sep)).toBe(true);
      const installed = projectRequire(manifestPath) as { version: string };
      expect(installed.version).toBe(vitePlus.dependencies[tool]?.replace(/^=/, ""));
      expect(dirname(manifestPath).endsWith(join("node_modules", tool))).toBe(true);
    });
  }
});
