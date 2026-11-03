import { createBundledHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Stand-in for the `shiki` entry in the browser bundle (vite.config.ts aliases
// it here). The API reference highlights its examples in the browser through
// `import("shiki")`, which would otherwise ship every grammar and theme Shiki
// has (about 13 MB of chunks). These are the languages those pages show:
// curl, fetch, JSON responses and TypeScript definitions. MDX guides are
// highlighted at build time and are not affected.
export const createHighlighter = createBundledHighlighter({
  langs: {
    bash: () => import("shiki/langs/bash.mjs"),
    shellscript: () => import("shiki/langs/shellscript.mjs"),
    javascript: () => import("shiki/langs/javascript.mjs"),
    js: () => import("shiki/langs/javascript.mjs"),
    typescript: () => import("shiki/langs/typescript.mjs"),
    ts: () => import("shiki/langs/typescript.mjs"),
    json: () => import("shiki/langs/json.mjs"),
  },
  themes: {},
  engine: () => createJavaScriptRegexEngine(),
});

export { createJavaScriptRegexEngine };

// Only the WASM factory of fumadocs-core asks for this, and nothing here uses it.
export function createOnigurumaEngine(): never {
  throw new Error("Oniguruma fora do bundle da documentação");
}
