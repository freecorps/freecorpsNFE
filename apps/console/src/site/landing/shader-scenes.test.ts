import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { reviewedVersion, trimShaderRegistry } from "../../../shaders-plugin.ts";
import { sceneEffects, scenes } from "./shader-scenes.ts";

// The package's own registry file, the one the build rewrites.
const core = dirname(fileURLToPath(import.meta.resolve("shaders/core")));
const registry = readFileSync(
  join(
    core,
    readdirSync(core).find((file) => /^shaderRegistry-[\w-]+\.js$/.test(file))!,
  ),
  "utf8",
);
const imports = (code: string) =>
  [...code.matchAll(/^import .* from "\.\/(\w+)-[\w-]+\.js";$/gm)].map(([, file]) => file);
const entries = (code: string) =>
  [...code.matchAll(/^\t\t(\w+): componentDefinition/gm)].map(([, name]) => name);

describe("efeitos dos shaders da landing", () => {
  it("lista cada tipo das cenas, inclusive os filhos", () => {
    expect(sceneEffects()).toEqual([
      "Dither",
      "DotGrid",
      "FlowField",
      "FractalNoise",
      "Godrays",
      "IsometricCubes",
      "SimplexNoise",
      "SolidColor",
      "WaveDistortion",
    ]);
    expect(Object.keys(scenes).sort()).toEqual(["chaos", "closing", "coverage", "hero"]);
  });

  it("deixa no registro do pacote só os efeitos das cenas", () => {
    expect(entries(registry).length).toBeGreaterThan(150);
    const trimmed = trimShaderRegistry(registry, sceneEffects());
    expect(entries(trimmed).sort()).toEqual(sceneEffects());
    expect(imports(trimmed).sort()).toEqual(sceneEffects());
    // The registry code itself (getAllShaders, getShaderByName…) stays.
    expect(trimmed).toContain("function getAllShaders()");
    expect(trimmed.split("export {")[1]).toBe(registry.split("export {")[1]);
  });

  it("foi revisado para a versão fixada no package.json", () => {
    const manifest = JSON.parse(readFileSync(join(core, "../../package.json"), "utf8"));
    const declared = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
    ).dependencies.shaders;
    expect([manifest.version, declared]).toEqual([reviewedVersion, reviewedVersion]);
  });

  it("falha no build quando uma cena usa um efeito que o pacote não tem", () => {
    expect(() => trimShaderRegistry(registry, ["Dither", "Inexistente"])).toThrow(
      "efeitos fora do registro do pacote: Inexistente",
    );
  });

  it("falha no build quando o registro do pacote muda de formato", () => {
    expect(() => trimShaderRegistry("export const shaderRegistry = {};", ["Dither"])).toThrow(
      "o registro do pacote mudou de formato",
    );
  });
});
