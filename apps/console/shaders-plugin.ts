import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { sceneEffects } from "./src/site/landing/shader-scenes.ts";

// Why this exists: the renderer of `shaders` imports one registry module that
// references all of its ~200 effects, so tree shaking keeps them all. The
// landing draws nine. Keeping only those took the lazy chunk from 2.57 MB
// (707 KB gzip) to 1.30 MB (302 KB gzip); docs/v1.0/evidence/456 has the
// measurements. The rewrite touches only the registry's list; the renderer,
// the effects and their GPU code stay the package's own.
//
// The registry is an internal, hashed file. This was checked against one
// version; any other fails the build until someone repeats the review (the
// format checks below and the screenshots in docs/v1.0/evidence/456).
export const reviewedVersion = "4.0.5";

const registryFile = /[\\/]shaders[\\/]dist[\\/]core[\\/]shaderRegistry-[\w-]+\.js$/;
const importLine = /^import \{ \w+ as (componentDefinition(?:\$\d+)?) \} from "[^"]+";\n/gm;
const entryLine = /^\t\t(\w+): (componentDefinition(?:\$\d+)?),?\n/gm;

export function trimShaderRegistry(code: string, keep: readonly string[]) {
  const wanted = new Set(keep);
  const entries = [...code.matchAll(entryLine)];
  const imports = [...code.matchAll(importLine)];
  if (entries.length < 50 || imports.length !== entries.length)
    throw new Error("shaders: o registro do pacote mudou de formato; revise shaders-plugin.ts");
  const kept = entries.filter(([, name]) => wanted.has(name!));
  const missing = keep.filter((name) => !kept.some(([, found]) => found === name));
  if (missing.length)
    throw new Error(`shaders: efeitos fora do registro do pacote: ${missing.join(", ")}`);
  const bindings = new Set(kept.map(([, , binding]) => binding));
  return code
    .replace(entryLine, (line, name: string) => (wanted.has(name) ? line : ""))
    .replace(importLine, (line, binding: string) => (bindings.has(binding) ? line : ""));
}

function installedVersion() {
  // `shaders` does not export its package.json; read it next to `shaders/core`.
  const manifest = new URL("../../package.json", import.meta.resolve("shaders/core"));
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

export function shadersPlugin(): Plugin {
  const effects = sceneEffects();
  let trimmed = false;
  return {
    name: "freecorps:shaders-registry",
    config: () => ({
      // Served as plain modules in dev too, so the dev server trims the
      // registry like the build instead of pre-bundling all of it. The package
      // has no dependencies to pre-bundle (typegpu is inlined in its dist).
      optimizeDeps: { exclude: ["shaders"] },
    }),
    buildStart() {
      const version = installedVersion();
      if (version !== reviewedVersion)
        this.error(
          `shaders ${version} instalado; shaders-plugin.ts foi revisado para ${reviewedVersion}. ` +
            "Confira o registro e a evidência em docs/v1.0/evidence/456 e atualize reviewedVersion.",
        );
    },
    transform(code, id) {
      // The dev server adds `?v=…` to dependency ids.
      if (!registryFile.test(id.split("?")[0]!)) return null;
      trimmed = true;
      return { code: trimShaderRegistry(code, effects), map: null };
    },
    buildEnd(error) {
      if (this.meta.watchMode) return;
      const engine = [...this.getModuleIds()].some((id) => /[\\/]shaders[\\/]dist[\\/]/.test(id));
      if (!error && engine && !trimmed)
        this.error("shaders: o registro do pacote não passou pelo build; revise shaders-plugin.ts");
    },
  };
}
