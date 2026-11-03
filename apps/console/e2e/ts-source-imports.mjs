// Uma jornada que importa o código-fonte dos pacotes sob Node
// (`node --experimental-strip-types`) para no primeiro import relativo entre
// arquivos .ts: os pacotes seguem a convenção NodeNext (`import "./external.js"`
// dentro de `documents.ts`), e o Node não troca o `.js` pelo `.ts` ao lado,
// como fazem o Bun, o Vite e o TypeScript. Este resolve faz só essa troca, e
// só quando quem importa é um .ts e o .js pedido não existe. Sob Bun,
// `registerHooks` não existe e não é preciso.
import { existsSync } from "node:fs";
import nodeModule from "node:module";

let registered = false;

export function typeScriptSource(specifier, parentURL, exists = existsSync) {
  if (!parentURL?.startsWith("file:") || !new URL(parentURL).pathname.endsWith(".ts")) return null;
  if (!/^\.\.?\//.test(specifier) || !specifier.endsWith(".js")) return null;
  if (exists(new URL(specifier, parentURL))) return null;
  const source = new URL(`${specifier.slice(0, -".js".length)}.ts`, parentURL);
  return exists(source) ? source.href : null;
}

export function allowTypeScriptSourceImports() {
  if (registered || typeof nodeModule.registerHooks !== "function") return;
  registered = true;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(typeScriptSource(specifier, context.parentURL) ?? specifier, context);
    },
  });
}
